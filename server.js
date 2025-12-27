// server.js
// Nice Line – Voice AI (Inbound)
// Twilio Media Streams <-> OpenAI Realtime API
//
// ONE SCRIPT CONTROL ENV:
// - MB_CONVERSATION_PROMPT (JSON) controls system/opening/closing/questions.
// Engine is strict: track -> first -> last -> phone(confirm caller id).
// No email step.
//
// npm i express ws dotenv
// node server.js

require("dotenv").config();
const http = require("http");
const express = require("express");
const WebSocket = require("ws");

/* ------------------------- helpers ------------------------- */
function envStr(name, def = "") {
  const v = process.env[name];
  return v == null || v === "" ? def : String(v);
}
function envNum(name, def) {
  const v = process.env[name];
  if (!v) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function envBool(name, def = false) {
  const v = (process.env[name] || "").toLowerCase();
  if (!v) return def;
  return ["1", "true", "yes", "on"].includes(v);
}

const PORT = envNum("PORT", 10000);

// OpenAI
const OPENAI_API_KEY = envStr("OPENAI_API_KEY", "");
const OPENAI_VOICE = envStr("OPENAI_VOICE", "cedar"); // supported: alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar

// Single conversation env (JSON)
const MB_CONVERSATION_PROMPT_RAW = envStr("MB_CONVERSATION_PROMPT", "");

// Logs
const MB_DEBUG = envBool("MB_DEBUG", true);
const MB_REDACT_LOGS = envBool("MB_REDACT_LOGS", false);

// VAD + background noise tuning (stable)
const MB_VAD_THRESHOLD = envNum("MB_VAD_THRESHOLD", 0.65);
const MB_VAD_SILENCE_MS = envNum("MB_VAD_SILENCE_MS", 900);
const MB_VAD_PREFIX_MS = envNum("MB_VAD_PREFIX_MS", 200);
const MB_VAD_SUFFIX_MS = envNum("MB_VAD_SUFFIX_MS", 200);

// Barge-in
const MB_ALLOW_BARGE_IN = envBool("MB_ALLOW_BARGE_IN", false);
const MB_NO_BARGE_TAIL_MS = envNum("MB_NO_BARGE_TAIL_MS", 1600);

// Timers
const MB_IDLE_WARNING_MS = envNum("MB_IDLE_WARNING_MS", 25000);
const MB_IDLE_HANGUP_MS = envNum("MB_IDLE_HANGUP_MS", 55000);
const MB_MAX_CALL_MS = envNum("MB_MAX_CALL_MS", 4 * 60 * 1000);
const MB_MAX_WARN_BEFORE_MS = envNum("MB_MAX_WARN_BEFORE_MS", 30000);
const MB_HANGUP_GRACE_MS = envNum("MB_HANGUP_GRACE_MS", 4500);

// CRM -> Make webhook ONLY
const MB_WEBHOOK_URL = envStr("MB_WEBHOOK_URL", "").trim();

// safety
if (!OPENAI_API_KEY) console.error("[FATAL] Missing OPENAI_API_KEY");
if (!MB_CONVERSATION_PROMPT_RAW) console.error("[FATAL] Missing MB_CONVERSATION_PROMPT");
if (!MB_WEBHOOK_URL) console.error("[WARN] Missing MB_WEBHOOK_URL (Make webhook) – CRM send will fail.");

/* ------------------------- logging ------------------------- */
function dlog(...a) {
  if (MB_DEBUG) console.log("[DEBUG]", ...a);
}
function ilog(...a) {
  console.log("[INFO]", ...a);
}
function elog(...a) {
  console.error("[ERROR]", ...a);
}

function nowIso() {
  return new Date().toISOString();
}

function digitsOnly(v) {
  return String(v || "").replace(/\D/g, "");
}

function normalizeIsraeliPhone(raw, fallbackCaller) {
  let d = digitsOnly(raw || "");
  if (!d && fallbackCaller) d = digitsOnly(fallbackCaller);
  if (!d) return null;

  // if E.164 like +9725...
  if (d.startsWith("972")) {
    d = "0" + d.slice(3);
  }

  if (!/^\d{9,10}$/.test(d)) return null;
  return d;
}

function normalizeStudyTrack(raw) {
  const t = String(raw || "").trim().toLowerCase();
  if (!t) return null;

  // common variations / STT confusions
  if (t.includes("טוען")) return "טוען רבני";
  if (t.includes("דיינ") || t.includes("דיין") || t.includes("דיינות")) return "דיינות";
  if (t.includes("רבנ") || t.includes("רבנות") || t === "רב") return "רבנות";
  return null;
}

function isYes(text) {
  const t = String(text || "").trim().toLowerCase();
  return ["כן", "בטח", "בוודאי", "נכון", "כן כן", "יאפ", "כן.", "כן!"].some((w) => t === w || t.includes(w));
}
function isNo(text) {
  const t = String(text || "").trim().toLowerCase();
  return ["לא", "ממש לא", "לא תודה", "שלילי", "לא.", "לא!"].some((w) => t === w || t.includes(w));
}

function redactPhone(p) {
  const s = String(p || "");
  if (s.length < 4) return "***";
  return s.slice(0, 2) + "****" + s.slice(-2);
}
function safePayload(p) {
  if (!MB_REDACT_LOGS) return p;
  return { ...p, phone_number: redactPhone(p.phone_number) };
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 4500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(t);
    return res;
  } finally {
    clearTimeout(t);
  }
}

/* ------------------------- Conversation prompt (single ENV) ------------------------- */
/**
 * MB_CONVERSATION_PROMPT JSON keys expected:
 * {
 *  "system": "...",
 *  "opening": "...",
 *  "closing": "...",
 *  "offscript": "...",
 *  "thanks": "...",
 *  "idle_warning": "...",
 *  "max_call_warning": "...",
 *  "questions": {
 *     "track": "...",
 *     "track_clarify": "...",
 *     "first": "...",
 *     "last": "...",
 *     "phone": "...",
 *     "phone_retry": "..."
 *  }
 * }
 */
function parseConversationJson(raw) {
  const obj = JSON.parse(raw);
  if (!obj || typeof obj !== "object") throw new Error("not object");
  return obj;
}

let CONV;
try {
  CONV = parseConversationJson(MB_CONVERSATION_PROMPT_RAW);
} catch (e) {
  elog("MB_CONVERSATION_PROMPT must be valid JSON.");
  process.exit(1);
}

function getStr(path, def = "") {
  const parts = path.split(".");
  let cur = CONV;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in cur) cur = cur[p];
    else return def;
  }
  return typeof cur === "string" ? cur : def;
}

function renderTemplate(text, vars = {}) {
  let out = String(text || "");
  for (const [k, v] of Object.entries(vars)) {
    const re = new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, "g");
    out = out.replace(re, String(v ?? ""));
  }
  return out;
}

/* Strong Hebrew + diacritics guidance (user requirement) */
const SYS_PROMPT =
  (getStr("system", "") || "") +
  "\n\nכללי דיבור חובה: אתם גבר. שמכם מוטי. אתם מדברים בלשון רבים בלבד. " +
  "הקפידו על עברית תקינה וברורה, ועדיפות לניקוד מלא בטקסטים שאתם מקריאים. " +
  "חיזוק תמלול/מונחים: מל\"מ, רבנות, דיינות, טוען רבני.";

/* ------------------------- CRM: Make webhook only ------------------------- */
async function sendToMake(payload) {
  if (!MB_WEBHOOK_URL) return { ok: false, reason: "make_webhook_not_configured" };
  try {
    const res = await fetchWithTimeout(
      MB_WEBHOOK_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      4500
    );
    if (!res.ok) return { ok: false, reason: `make_http_${res.status}` };
    return { ok: true, reason: "make_ok" };
  } catch (e) {
    return { ok: false, reason: `make_error_${e?.name || "err"}` };
  }
}

/* ------------------------- Strict flow engine ------------------------- */
const STATES = {
  ASK_TRACK: "ASK_TRACK",
  ASK_FIRST: "ASK_FIRST",
  ASK_LAST: "ASK_LAST",
  ASK_PHONE_CONFIRM: "ASK_PHONE_CONFIRM",
  ASK_PHONE_MANUAL: "ASK_PHONE_MANUAL",
};

function isOffScriptQuestion(text) {
  const t = (text || "").trim();
  if (!t) return false;

  // detect question-ish patterns
  const patterns = [/\?/, /תסביר/, /פרטים/, /הלכה/, /שיטה/, /כמה עולה/, /תנאים/, /מסלול/];
  return patterns.some((re) => re.test(t));
}

function graceMs() {
  return Math.max(2500, Math.min(MB_HANGUP_GRACE_MS, 9000));
}

/* ------------------------- server ------------------------- */
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/twilio-media-stream" });

app.get("/health", (_req, res) => res.json({ ok: true, time: nowIso() }));

wss.on("connection", (twilioWs) => {
  let streamSid = null;
  let callSid = null;
  let caller = "";
  let called = "";

  let callerPhoneLocal = ""; // normalized 05xxxxxxxx
  let state = STATES.ASK_TRACK;

  let openAiReady = false;
  let callEnded = false;
  let leadSent = false;

  // idle
  let lastMediaTs = Date.now();
  let idleWarned = false;

  // barge-in
  let botSpeaking = false;
  let noListenUntilTs = 0;

  // buffer audio until streamSid exists (prevents opening cut)
  const outAudioBuffer = [];
  const MAX_AUDIO_BUFFER = 500;

  // response queue to avoid overlapping responses
  let responseInFlight = false;
  const responseQueue = [];

  const lead = {
    first_name: "",
    last_name: "",
    phone_number: "",
    study_track: "",
    source: "Voice AI - Nice Line",
    timestamp: "",
    caller_id: "",
    called: "",
  };

  function ilogBot(text) {
    ilog("BOT>", text);
  }
  function ilogUser(text) {
    ilog("USER>", text);
  }
  function logState(note) {
    ilog(`[STATE] ${state}${note ? " | " + note : ""}`);
  }

  function enqueueTextPrompt(text, why = "") {
    responseQueue.push({ text, why });
    pumpQueue();
  }

  function pumpQueue() {
    if (callEnded) return;
    if (!openAiReady) return;
    if (responseInFlight) return;
    if (responseQueue.length === 0) return;

    const { text, why } = responseQueue.shift();
    responseInFlight = true;
    dlog("QUEUE SEND", why, text);

    openAiWs.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
      })
    );
    openAiWs.send(JSON.stringify({ type: "response.create" }));
  }

  function speakOneSentenceExact(heText, why) {
    const line = String(heText || "").trim();
    if (!line) return;
    // instruct the model to read EXACTLY, with niqqud preference, plural-only
    enqueueTextPrompt(
      `הקריאו בדיוק את המשפט הבא בעברית, בלשון רבים בלבד, כגבר (מוטי), ועדיפות לניקוד מלא. בלי להוסיף שום דבר: "${line}"`,
      why
    );
    ilogBot(line);
  }

  function answerQuestionThenResume(userText) {
    const off = getStr("offscript", "אני מערכת רישום בלבד. נציג יחזור אליכם עם כל ההסברים.");
    // Try to answer if answer exists in system/knowledge; else fallback to generic offscript
    enqueueTextPrompt(
      `השואל אמר: "${userText}". אם יש תשובה ברורה מתוך ההנחיות/הידע שקיים אצלכם – ענו בקצרה במשפט אחד. אם אין תשובה ודאית – ענו בדיוק: "${off}". לאחר מכן אל תשאלו שאלות חדשות, וחזרו לתסריט.`,
      "qa_or_fallback"
    );
    // then repeat current scripted question
    askCurrent();
  }

  async function deliver(callStatusHe, callStatusCode, reason) {
    if (leadSent) return;
    leadSent = true;

    lead.timestamp = lead.timestamp || nowIso();

    const payload = {
      first_name: lead.first_name || "",
      last_name: lead.last_name || "",
      phone_number: lead.phone_number || "", // chosen/confirmed phone
      study_track: lead.study_track || "",
      source: lead.source || "Voice AI - Nice Line",
      timestamp: lead.timestamp,

      // always include caller id
      caller_id: lead.caller_id || caller || "",
      called: lead.called || called || "",
      callSid: callSid || "",
      streamSid: streamSid || "",

      // statuses
      call_status: callStatusHe, // "שיחה מלאה" / "שיחה חלקית"
      call_status_code: callStatusCode, // "completed" / "partial"
      reason: reason || "",

      // debug-friendly remarks
      remarks: `מסלול: ${lead.study_track || ""} | סטטוס: ${callStatusHe} | caller: ${lead.caller_id || caller || ""} | callSid: ${callSid || ""}`,
    };

    ilog("CRM> sending", safePayload(payload));
    const r = await sendToMake(payload);
    ilog("CRM> result", r);
    if (!r.ok) elog("CRM> FAILED", r);
  }

  async function finish(callStatusHe, callStatusCode, reason) {
    if (callEnded) return;
    callEnded = true;

    await deliver(callStatusHe, callStatusCode, reason);

    const closing = getStr("closing", "");
    if (closing) {
      speakOneSentenceExact(closing, "closing");
    }

    setTimeout(() => {
      try {
        openAiWs?.close();
      } catch {}
      try {
        twilioWs?.close();
      } catch {}
    }, graceMs());
  }

  function sayThanks() {
    const thanks = getStr("thanks", "תודה.");
    if (thanks) speakOneSentenceExact(thanks, "thanks");
  }

  function askCurrent() {
    const qs = CONV.questions || {};
    let q = "";

    if (state === STATES.ASK_TRACK) q = qs.track || "";
    if (state === STATES.ASK_FIRST) q = qs.first || "";
    if (state === STATES.ASK_LAST) q = qs.last || "";

    if (state === STATES.ASK_PHONE_CONFIRM) {
      const templ = qs.phone || "";
      q = renderTemplate(templ, { caller_phone: callerPhoneLocal || "" });
    }

    if (state === STATES.ASK_PHONE_MANUAL) {
      q = "אנא אמרו את מספר הטלפון בספרות בלבד, לאט וברור.";
    }

    if (!q) return;
    speakOneSentenceExact(q, `ask_${state}`);
  }

  /* ------------------------- OpenAI Realtime WS ------------------------- */
  const openAiWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17", {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  openAiWs.on("open", () => {
    openAiReady = true;

    openAiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          model: "gpt-4o-realtime-preview-2024-12-17",
          modalities: ["audio", "text"],
          voice: OPENAI_VOICE,
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          input_audio_transcription: { model: "whisper-1" },
          turn_detection: {
            type: "server_vad",
            threshold: MB_VAD_THRESHOLD,
            silence_duration_ms: MB_VAD_SILENCE_MS + MB_VAD_SUFFIX_MS,
            prefix_padding_ms: MB_VAD_PREFIX_MS,
          },
          max_response_output_tokens: 240,
          instructions: SYS_PROMPT,
        },
      })
    );

    const opening = getStr("opening", "");
    if (opening) speakOneSentenceExact(opening, "opening");

    askCurrent();
    logState("start");
  });

  openAiWs.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // audio out
    if (msg.type === "response.audio.delta") {
      botSpeaking = true;
      noListenUntilTs = Date.now() + MB_NO_BARGE_TAIL_MS;

      if (!streamSid) {
        outAudioBuffer.push(msg.delta);
        if (outAudioBuffer.length > MAX_AUDIO_BUFFER) outAudioBuffer.shift();
        return;
      }
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: msg.delta } }));
      return;
    }
    if (msg.type === "response.audio.done") {
      botSpeaking = false;
      return;
    }

    // response lifecycle
    if (msg.type === "response.completed") {
      responseInFlight = false;
      pumpQueue();
      return;
    }

    // transcription
    if (msg.type === "conversation.item.input_audio_transcription.completed") {
      const userText = (msg.transcript || "").trim();
      if (!userText || callEnded) return;

      ilogUser(userText);

      // Q/A handling (answer if possible, else generic) then resume script
      if (isOffScriptQuestion(userText)) {
        answerQuestionThenResume(userText);
        return;
      }

      // FLOW
      if (state === STATES.ASK_TRACK) {
        const tr = normalizeStudyTrack(userText);
        if (!tr) {
          const clarify = getStr("questions.track_clarify", "");
          if (clarify) speakOneSentenceExact(clarify, "track_clarify");
          askCurrent();
          return;
        }
        lead.study_track = tr;
        sayThanks();
        state = STATES.ASK_FIRST;
        logState("next");
        askCurrent();
        return;
      }

      if (state === STATES.ASK_FIRST) {
        lead.first_name = userText;
        sayThanks();
        state = STATES.ASK_LAST;
        logState("next");
        askCurrent();
        return;
      }

      if (state === STATES.ASK_LAST) {
        lead.last_name = userText;
        sayThanks();
        state = STATES.ASK_PHONE_CONFIRM;
        logState("next");
        askCurrent();
        return;
      }

      if (state === STATES.ASK_PHONE_CONFIRM) {
        // If caller id exists, accept "yes" to use it. Or accept digits for new phone.
        const proposed = callerPhoneLocal || normalizeIsraeliPhone("", caller) || "";

        // user says yes
        if (proposed && isYes(userText)) {
          lead.phone_number = proposed;
          await finish("שיחה מלאה", "completed", "done_confirmed_caller");
          return;
        }

        // user provides digits
        const phone = normalizeIsraeliPhone(userText, "");
        if (phone) {
          lead.phone_number = phone;
          await finish("שיחה מלאה", "completed", "done_manual_phone");
          return;
        }

        // user says no / doesn't want caller id -> ask manual once
        if (isNo(userText)) {
          state = STATES.ASK_PHONE_MANUAL;
          logState("to_manual");
          askCurrent();
          return;
        }

        // unclear: retry once with phone_retry, then move to manual
        if (!lead.__phone_retry) {
          lead.__phone_retry = true;
          const retry = getStr("questions.phone_retry", "");
          if (retry) speakOneSentenceExact(retry, "phone_retry");
          askCurrent();
          return;
        }

        state = STATES.ASK_PHONE_MANUAL;
        logState("fallback_manual");
        askCurrent();
        return;
      }

      if (state === STATES.ASK_PHONE_MANUAL) {
        const phone = normalizeIsraeliPhone(userText, "");
        if (phone) {
          lead.phone_number = phone;
          await finish("שיחה מלאה", "completed", "done_manual_after_prompt");
          return;
        }

        if (!lead.__manual_phone_retry) {
          lead.__manual_phone_retry = true;
          const retry = getStr("questions.phone_retry", "");
          if (retry) speakOneSentenceExact(retry, "phone_retry_manual");
          askCurrent();
          return;
        }

        // partial end
        await finish("שיחה חלקית", "partial", "invalid_phone_twice");
        return;
      }
    }

    if (msg.type === "error") {
      elog("OpenAI error", msg);
      responseInFlight = false;
      pumpQueue();
    }
  });

  openAiWs.on("close", async () => {
    if (!callEnded) {
      elog("OpenAI WS closed");
      await finish("שיחה חלקית", "partial", "openai_closed");
    }
  });

  openAiWs.on("error", async (e) => {
    if (!callEnded) {
      elog("OpenAI WS error", e?.message || e);
      await finish("שיחה חלקית", "partial", "openai_ws_error");
    }
  });

  /* ------------------------- idle + max timers ------------------------- */
  const idleInterval = setInterval(async () => {
    if (callEnded) return;
    const since = Date.now() - lastMediaTs;

    if (!idleWarned && since >= MB_IDLE_WARNING_MS) {
      idleWarned = true;
      const warn = getStr("idle_warning", "");
      if (warn) speakOneSentenceExact(warn, "idle_warning");
    }

    if (since >= MB_IDLE_HANGUP_MS) {
      await finish("שיחה חלקית", "partial", "idle_timeout");
      clearInterval(idleInterval);
    }
  }, 1000);

  let maxWarnT = null;
  let maxEndT = null;

  if (MB_MAX_CALL_MS > 0) {
    if (MB_MAX_WARN_BEFORE_MS > 0 && MB_MAX_CALL_MS > MB_MAX_WARN_BEFORE_MS) {
      maxWarnT = setTimeout(() => {
        if (!callEnded) {
          const warn = getStr("max_call_warning", "");
          if (warn) speakOneSentenceExact(warn, "max_call_warning");
        }
      }, MB_MAX_CALL_MS - MB_MAX_WARN_BEFORE_MS);
    }
    maxEndT = setTimeout(async () => {
      if (!callEnded) await finish("שיחה חלקית", "partial", "max_call_duration");
    }, MB_MAX_CALL_MS);
  }

  /* ------------------------- Twilio WS ------------------------- */
  twilioWs.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || null;
      callSid = msg.start?.callSid || null;

      const p = msg.start?.customParameters || {};
      caller = p.caller || "";
      called = p.called || "";

      lead.caller_id = caller || "";
      lead.called = called || "";

      callerPhoneLocal = normalizeIsraeliPhone("", caller) || "";

      ilog("CALL start", { streamSid, callSid, caller, called, callerPhoneLocal });

      // flush buffered audio once streamSid exists
      if (streamSid && outAudioBuffer.length) {
        for (const b64 of outAudioBuffer.splice(0, outAudioBuffer.length)) {
          twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: b64 } }));
        }
      }
      return;
    }

    if (msg.event === "media") {
      lastMediaTs = Date.now();
      if (!openAiReady) return;

      const now = Date.now();
      if (!MB_ALLOW_BARGE_IN) {
        if (botSpeaking || now < noListenUntilTs) return;
      }

      const payload = msg.media?.payload;
      if (!payload) return;

      openAiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: payload }));
      return;
    }

    if (msg.event === "stop") {
      if (!callEnded) {
        const full = !!(lead.study_track && lead.first_name && lead.last_name && (lead.phone_number || callerPhoneLocal));
        finish(full ? "שיחה מלאה" : "שיחה חלקית", full ? "completed" : "partial", "twilio_stop");
      }
    }
  });

  twilioWs.on("close", () => {
    clearInterval(idleInterval);
    if (maxWarnT) clearTimeout(maxWarnT);
    if (maxEndT) clearTimeout(maxEndT);
    dlog("Twilio WS closed");
  });

  twilioWs.on("error", (e) => {
    clearInterval(idleInterval);
    if (maxWarnT) clearTimeout(maxWarnT);
    if (maxEndT) clearTimeout(maxEndT);
    elog("Twilio WS error", e?.message || e);
  });
});

server.listen(PORT, () => {
  ilog(`✅ server listening on :${PORT}`);
});
