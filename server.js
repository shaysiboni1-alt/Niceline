// server.js
// Nice Line – Voice AI (Inbound) – STRICT FLOW ENGINE
// Twilio Media Streams <-> OpenAI Realtime API
//
// Key behavior:
// - Deterministic prompts: opening/questions/closing are spoken EXACTLY as provided in MB_CONVERSATION_PROMPT.
// - Strict flow: track -> first -> last -> phone_confirm -> (manual phone if needed).
// - No email.
// - Always send to Make on end/partial with caller_id + status.
// - Fixes "conversation_already_has_active_response" by response-lock + queue.
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
  if (d.startsWith("972")) d = "0" + d.slice(3);
  if (!/^\d{9,10}$/.test(d)) return null;
  return d;
}
function redactPhone(p) {
  const s = String(p || "");
  if (s.length < 4) return "***";
  return s.slice(0, 2) + "****" + s.slice(-2);
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
function renderTemplate(text, vars = {}) {
  let out = String(text || "");
  for (const [k, v] of Object.entries(vars)) {
    const re = new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, "g");
    out = out.replace(re, String(v ?? ""));
  }
  return out;
}
function isYes(text) {
  const t = String(text || "").trim().toLowerCase();
  return ["כן", "כן כן", "בטח", "בוודאי", "נכון", "יאפ", "כן."].some((w) => t === w || t.includes(w));
}
function isNo(text) {
  const t = String(text || "").trim().toLowerCase();
  return ["לא", "לא תודה", "ממש לא", "שלילי", "לא."].some((w) => t === w || t.includes(w));
}

/* ------------------------- config ------------------------- */
const PORT = envNum("PORT", 10000);

const OPENAI_API_KEY = envStr("OPENAI_API_KEY", "");
const OPENAI_VOICE = envStr("OPENAI_VOICE", "cedar");

const MB_CONVERSATION_PROMPT_RAW = envStr("MB_CONVERSATION_PROMPT", "");
const MB_WEBHOOK_URL = envStr("MB_WEBHOOK_URL", "").trim();

const MB_DEBUG = envBool("MB_DEBUG", true);
const MB_REDACT_LOGS = envBool("MB_REDACT_LOGS", false);

// Noise / VAD
const MB_VAD_THRESHOLD = envNum("MB_VAD_THRESHOLD", 0.65);
const MB_VAD_SILENCE_MS = envNum("MB_VAD_SILENCE_MS", 900);
const MB_VAD_PREFIX_MS = envNum("MB_VAD_PREFIX_MS", 200);
const MB_VAD_SUFFIX_MS = envNum("MB_VAD_SUFFIX_MS", 200);

const MB_ALLOW_BARGE_IN = envBool("MB_ALLOW_BARGE_IN", false);
const MB_NO_BARGE_TAIL_MS = envNum("MB_NO_BARGE_TAIL_MS", 1400); // a bit faster feel

// timers
const MB_IDLE_WARNING_MS = envNum("MB_IDLE_WARNING_MS", 25000);
const MB_IDLE_HANGUP_MS = envNum("MB_IDLE_HANGUP_MS", 55000);
const MB_MAX_CALL_MS = envNum("MB_MAX_CALL_MS", 4 * 60 * 1000);
const MB_MAX_WARN_BEFORE_MS = envNum("MB_MAX_WARN_BEFORE_MS", 30000);
const MB_HANGUP_GRACE_MS = envNum("MB_HANGUP_GRACE_MS", 4500);

// Response safety
const MB_RESPONSE_FAILSAFE_MS = envNum("MB_RESPONSE_FAILSAFE_MS", 10000);

if (!OPENAI_API_KEY) console.error("[FATAL] Missing OPENAI_API_KEY");
if (!MB_CONVERSATION_PROMPT_RAW) console.error("[FATAL] Missing MB_CONVERSATION_PROMPT");
if (!MB_WEBHOOK_URL) console.error("[WARN] Missing MB_WEBHOOK_URL (Make webhook)");

function dlog(...a) {
  if (MB_DEBUG) console.log("[DEBUG]", ...a);
}
function ilog(...a) {
  console.log("[INFO]", ...a);
}
function elog(...a) {
  console.error("[ERROR]", ...a);
}

/* ------------------------- conversation prompt json ------------------------- */
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

/* ------------------------- study track normalization (strong) ------------------------- */
function normalizeStudyTrackStrong(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return null;

  // Hebrew
  if (s.includes("טוען")) return "טוען רבני";
  if (s.includes("דיינ") || s.includes("דיין") || s.includes("דיינות")) return "דיינות";
  if (s.includes("רבנ") || s.includes("רבנות")) return "רבנות";

  // common transliteration / English-ish STT
  // "tollen rabboni" / "toen rabbani" / "toen rabani"
  if (/(tolen|tollen|toen|toen|toan|toen)\s*(rab|rabb|rabbi|rabbani|rabboni)/.test(s)) return "טוען רבני";
  if (/(toen|tolen|tollen).*(rabani|rabbani|rabboni|rabbi)/.test(s)) return "טוען רבני";
  if (/(rabbanut|rabb[a- ]?nut|rabba[- ]?nut|rab[a- ]?nut)/.test(s)) return "רבנות";
  if (/(dayanut|dayanut|daya[- ]?nut|daya[- ]?noot|dajan|dayan)/.test(s)) return "דיינות";

  // Single keywords
  if (s.includes("rabbanut") || s.includes("rabba") || s.includes("nut")) return "רבנות";
  if (s.includes("dayan") || s.includes("dayanut") || s.includes("dajan")) return "דיינות";
  if (s.includes("toen") || s.includes("tolen") || s.includes("tollen")) return "טוען רבני";

  return null;
}

/* ------------------------- Make webhook ------------------------- */
async function sendToMake(payload) {
  if (!MB_WEBHOOK_URL) return { ok: false, reason: "make_webhook_not_configured" };
  try {
    const res = await fetchWithTimeout(
      MB_WEBHOOK_URL,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
      4500
    );
    if (!res.ok) return { ok: false, reason: `make_http_${res.status}` };
    return { ok: true, reason: "make_ok" };
  } catch (e) {
    return { ok: false, reason: `make_error_${e?.name || "err"}` };
  }
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
  let callerPhoneLocal = "";

  // flow state
  const STATES = {
    ASK_TRACK: "ASK_TRACK",
    ASK_FIRST: "ASK_FIRST",
    ASK_LAST: "ASK_LAST",
    ASK_PHONE_CONFIRM: "ASK_PHONE_CONFIRM",
    ASK_PHONE_MANUAL: "ASK_PHONE_MANUAL",
  };
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

  // audio buffer until start
  const outAudioBuffer = [];
  const MAX_AUDIO_BUFFER = 600;

  // STRICT response queue lock
  let responseInFlight = false;
  let responseTimer = null;
  const speakQueue = [];

  // lead
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

  function safePayload(p) {
    if (!MB_REDACT_LOGS) return p;
    return { ...p, phone_number: redactPhone(p.phone_number), caller_id: redactPhone(p.caller_id) };
  }

  function logState(note) {
    ilog(`[STATE] ${state}${note ? " | " + note : ""}`);
  }
  function logBot(text) {
    ilog("BOT>", text);
  }
  function logUser(text) {
    ilog("USER>", text);
  }

  function clearInFlight() {
    responseInFlight = false;
    if (responseTimer) {
      clearTimeout(responseTimer);
      responseTimer = null;
    }
  }

  function startInFlightFailsafe() {
    if (responseTimer) clearTimeout(responseTimer);
    responseTimer = setTimeout(() => {
      elog("Response failsafe fired. Releasing in-flight lock.");
      clearInFlight();
      pumpSpeakQueue();
    }, MB_RESPONSE_FAILSAFE_MS);
  }

  function pumpSpeakQueue() {
    if (callEnded) return;
    if (!openAiReady) return;
    if (responseInFlight) return;
    if (speakQueue.length === 0) return;

    const { text, why } = speakQueue.shift();
    responseInFlight = true;
    startInFlightFailsafe();

    dlog("SPEAK>", why, text);

    // Deterministic: we CREATE an assistant message with the exact text,
    // then ask for audio via response.create.
    openAiWs.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
      })
    );
    openAiWs.send(JSON.stringify({ type: "response.create" }));
  }

  function speakExact(text, why = "speak") {
    const line = String(text || "").trim();
    if (!line) return;
    speakQueue.push({ text: line, why });
    logBot(line);
    pumpSpeakQueue();
  }

  function askCurrent() {
    const qs = CONV.questions || {};
    if (state === STATES.ASK_TRACK) return speakExact(qs.track || "", "q_track");
    if (state === STATES.ASK_FIRST) return speakExact(qs.first || "", "q_first");
    if (state === STATES.ASK_LAST) return speakExact(qs.last || "", "q_last");
    if (state === STATES.ASK_PHONE_CONFIRM) {
      const t = qs.phone_confirm || qs.phone || "";
      return speakExact(renderTemplate(t, { caller_phone: callerPhoneLocal || "" }), "q_phone_confirm");
    }
    if (state === STATES.ASK_PHONE_MANUAL) {
      return speakExact("אֲנָא אִמְרוּ אֶת מִסְפָּר הַטֶּלֶפוֹן בְּסִפְרוֹת בִּלְבַד, לְאַט וּבְבֵרוּר.", "q_phone_manual");
    }
  }

  function sayThanks() {
    speakExact(getStr("thanks", "תודה."), "thanks");
  }

  function isOffScript(text) {
    const t = (text || "").trim();
    if (!t) return false;
    const patterns = [/\?/, /תסביר/, /פרטים/, /הלכה/, /שיטה/, /כמה עולה/, /תנאים/, /מסלול/];
    return patterns.some((re) => re.test(t));
  }

  function handleOffScript(userText) {
    // Always: generic answer, then repeat current question (strict).
    speakExact(getStr("offscript", "אני מערכת רישום בלבד. נציג יחזור אליכם עם כל ההסברים."), "offscript");
    askCurrent();
  }

  async function deliver(statusHe, statusCode, reason) {
    if (leadSent) return;
    leadSent = true;

    lead.timestamp = lead.timestamp || nowIso();

    const payload = {
      first_name: lead.first_name || "",
      last_name: lead.last_name || "",
      phone_number: lead.phone_number || "",
      study_track: lead.study_track || "",
      source: lead.source || "Voice AI - Nice Line",
      timestamp: lead.timestamp,

      caller_id: lead.caller_id || caller || "",
      called: lead.called || called || "",
      callSid: callSid || "",
      streamSid: streamSid || "",

      call_status: statusHe, // "שיחה מלאה" / "שיחה חלקית"
      call_status_code: statusCode, // "completed" / "partial"
      reason: reason || "",

      remarks: `מסלול: ${lead.study_track || ""} | סטטוס: ${statusHe} | caller: ${lead.caller_id || caller || ""} | callSid: ${callSid || ""}`,
    };

    ilog("CRM> sending", safePayload(payload));
    const r = await sendToMake(payload);
    ilog("CRM> result", r);
    if (!r.ok) elog("CRM> FAILED", r);
  }

  async function finish(statusHe, statusCode, reason) {
    if (callEnded) return;
    callEnded = true;

    await deliver(statusHe, statusCode, reason);

    speakExact(getStr("closing", ""), "closing");

    setTimeout(() => {
      try {
        openAiWs?.close();
      } catch {}
      try {
        twilioWs?.close();
      } catch {}
    }, Math.max(2500, Math.min(MB_HANGUP_GRACE_MS, 9000)));
  }

  /* ------------------------- OpenAI Realtime WS ------------------------- */
  const openAiWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17", {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" },
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
          max_response_output_tokens: 120,
          instructions: (getStr("system", "") || "") +
            "\n\nחוקים: אתם גבר בשם מוטי. מדברים בלשון רבים בלבד. " +
            "אודיו: הקפדה על עברית ברורה; אם טקסט מנוקד – לקרוא אותו כמות שהוא. " +
            "אין לבקש דואר אלקטרוני בשום מצב. אין לשנות ניסוחים. אין להוסיף מילים.",
        },
      })
    );

    // Speak opening exactly, then first question
    const opening = getStr("opening", "");
    if (opening) speakExact(opening, "opening");

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

    // release lock on any done event
    if (msg.type === "response.audio.done" || msg.type === "response.done" || msg.type === "response.completed") {
      botSpeaking = false;
      clearInFlight();
      pumpSpeakQueue();
      return;
    }

    if (msg.type === "conversation.item.input_audio_transcription.completed") {
      const userText = (msg.transcript || "").trim();
      if (!userText || callEnded) return;

      logUser(userText);

      // Offscript Q
      if (isOffScript(userText)) {
        handleOffScript(userText);
        return;
      }

      // FLOW (strict)
      if (state === STATES.ASK_TRACK) {
        const tr = normalizeStudyTrackStrong(userText);
        if (!tr) {
          speakExact(getStr("questions.track_clarify", ""), "track_clarify");
          // re-ask same question once more
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
        const proposed = callerPhoneLocal || normalizeIsraeliPhone("", caller) || "";

        if (proposed && isYes(userText)) {
          lead.phone_number = proposed;
          await finish("שיחה מלאה", "completed", "done_confirmed_caller");
          return;
        }

        if (isNo(userText)) {
          state = STATES.ASK_PHONE_MANUAL;
          logState("to_manual");
          askCurrent();
          return;
        }

        // if user said a number directly
        const phone = normalizeIsraeliPhone(userText, "");
        if (phone) {
          lead.phone_number = phone;
          await finish("שיחה מלאה", "completed", "done_manual_phone");
          return;
        }

        // retry once, then force manual
        if (!lead.__phone_retry) {
          lead.__phone_retry = true;
          speakExact(getStr("questions.phone_retry", ""), "phone_retry");
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
          speakExact(getStr("questions.phone_retry", ""), "phone_retry_manual");
          askCurrent();
          return;
        }

        await finish("שיחה חלקית", "partial", "invalid_phone_twice");
        return;
      }
    }

    if (msg.type === "error") {
      elog("OpenAI error", msg);
      // clear lock to avoid deadlocks
      clearInFlight();
      pumpSpeakQueue();
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
      speakExact(getStr("idle_warning", "רק לוודא, אתם איתנו?"), "idle_warning");
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
        if (!callEnded) speakExact(getStr("max_call_warning", ""), "max_call_warning");
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

      // flush buffered audio
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
