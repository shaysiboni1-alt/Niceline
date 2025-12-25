// server.js
// Nice Line – Voice AI (Inbound)
// Twilio Media Streams <-> OpenAI Realtime API
//
// KEY IDEA:
// - Single ENV for ALL conversation scripting: MB_CONVERSATION_PROMPT (JSON)
// - Code is only an engine: state machine + validation + logs + CRM
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
const OPENAI_VOICE = envStr("OPENAI_VOICE", "alloy"); // alloy / ash / ballad / coral / echo / sage / shimmer / verse / marin / cedar

// Single conversation env
const MB_CONVERSATION_PROMPT_RAW = envStr("MB_CONVERSATION_PROMPT", "");

// Logs
const MB_DEBUG = envBool("MB_DEBUG", true);
const MB_REDACT_LOGS = envBool("MB_REDACT_LOGS", false);

// VAD + background noise (kept as stable defaults; not script-related)
const MB_VAD_THRESHOLD = envNum("MB_VAD_THRESHOLD", 0.65);
const MB_VAD_SILENCE_MS = envNum("MB_VAD_SILENCE_MS", 900);
const MB_VAD_PREFIX_MS = envNum("MB_VAD_PREFIX_MS", 200);
const MB_VAD_SUFFIX_MS = envNum("MB_VAD_SUFFIX_MS", 200);

// Barge-in (kept simple and stable)
const MB_ALLOW_BARGE_IN = envBool("MB_ALLOW_BARGE_IN", false);
const MB_NO_BARGE_TAIL_MS = envNum("MB_NO_BARGE_TAIL_MS", 1600);

// Timers
const MB_IDLE_WARNING_MS = envNum("MB_IDLE_WARNING_MS", 25000);
const MB_IDLE_HANGUP_MS = envNum("MB_IDLE_HANGUP_MS", 55000);
const MB_MAX_CALL_MS = envNum("MB_MAX_CALL_MS", 4 * 60 * 1000);
const MB_MAX_WARN_BEFORE_MS = envNum("MB_MAX_WARN_BEFORE_MS", 30000);
const MB_HANGUP_GRACE_MS = envNum("MB_HANGUP_GRACE_MS", 4500);

// CRM (Frontask preferred)
const MB_FRONTASK_WEBTOLEAD_BASE = envStr("MB_FRONTASK_WEBTOLEAD_BASE", "").trim();
const MB_FRONTASK_SYSTEM_ID = envStr("MB_FRONTASK_SYSTEM_ID", "").trim();
const MB_FRONTASK_PROCESS_STEP_ID = envStr("MB_FRONTASK_PROCESS_STEP_ID", "").trim();
const MB_FRONTASK_MAILINGLIST = envStr("MB_FRONTASK_MAILINGLIST", "0").trim();
const MB_FRONTASK_UPDATE_EXISTING = envStr("MB_FRONTASK_UPDATE_EXISTING", "1").trim();

// Optional fallback webhook
const MB_WEBHOOK_URL = envStr("MB_WEBHOOK_URL", "").trim();

// safety
if (!OPENAI_API_KEY) console.error("[FATAL] Missing OPENAI_API_KEY");
if (!MB_CONVERSATION_PROMPT_RAW) console.error("[FATAL] Missing MB_CONVERSATION_PROMPT");
if (!MB_FRONTASK_WEBTOLEAD_BASE && !MB_WEBHOOK_URL) {
  console.error("[WARN] No CRM target set. Configure Frontask (recommended) or MB_WEBHOOK_URL.");
}

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
  if (d.startsWith("972") && (d.length === 11 || d.length === 12)) d = "0" + d.slice(3);
  if (!/^\d{9,10}$/.test(d)) return null;
  return d;
}
function isValidEmailLike(s) {
  const t = String(s || "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(t);
}
function normalizeStudyTrack(raw) {
  const t = String(raw || "").trim().toLowerCase();
  if (!t) return null;

  // allow common variations / STT confusions
  if (t.includes("טוען")) return "טוען רבני";
  if (t.includes("דיינ") || t.includes("דיין") || t.includes("דיינות")) return "דיינות";
  if (t.includes("רבנ") || t.includes("רבנות") || t === "רב") return "רבנות";

  return null;
}

function redactPhone(p) {
  const s = String(p || "");
  if (s.length < 4) return "***";
  return s.slice(0, 2) + "****" + s.slice(-2);
}
function redactEmail(e) {
  const s = String(e || "");
  const at = s.indexOf("@");
  if (at <= 1) return "***@***";
  return s[0] + "***" + s.slice(at);
}
function safePayload(p) {
  if (!MB_REDACT_LOGS) return p;
  return { ...p, phone_number: redactPhone(p.phone_number), email: redactEmail(p.email) };
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
 * MB_CONVERSATION_PROMPT MUST be JSON with keys:
 * {
 *   "system": "...",
 *   "opening": "...",
 *   "closing": "...",
 *   "offscript": "...",
 *   "thanks": "...",
 *   "idle_warning": "...",
 *   "max_call_warning": "...",
 *   "questions": {
 *     "track": "...",
 *     "track_clarify": "...",
 *     "first": "...",
 *     "last": "...",
 *     "phone": "...",
 *     "phone_retry": "...",
 *     "email": "...",
 *     "email_retry": "..."
 *   }
 * }
 */
function parseConversationJson(raw) {
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") throw new Error("not object");
    return obj;
  } catch (e) {
    throw new Error("MB_CONVERSATION_PROMPT must be valid JSON");
  }
}

let CONV;
try {
  CONV = parseConversationJson(MB_CONVERSATION_PROMPT_RAW);
} catch (e) {
  elog(e.message);
  // hard fail: you asked for full control from one ENV; without it we should not run.
  process.exit(1);
}

// getters with safety defaults
function getStr(path, def = "") {
  const parts = path.split(".");
  let cur = CONV;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in cur) cur = cur[p];
    else return def;
  }
  return typeof cur === "string" ? cur : def;
}

const SYS_PROMPT =
  (getStr("system") || "") +
  "\n\nהנחיית שפה ותמלול: השיחה בעברית. מונחים נפוצים: רבנות, דיינות, טוען רבני, מל\"מ. ";

/* ------------------------- CRM senders ------------------------- */
async function sendLeadFrontask(payload) {
  if (!MB_FRONTASK_WEBTOLEAD_BASE) return { ok: false, reason: "frontask_not_configured" };

  const params = new URLSearchParams();
  params.set("type", "get");

  params.set("FirstName", payload.first_name || "");
  params.set("LastName", payload.last_name || "");
  params.set("Phone", payload.phone_number || "");
  params.set("MobilePhone", payload.phone_number || "");
  params.set("Email", payload.email || "");

  // optional fields
  params.set("NamePrefix", "");
  params.set("Title", "");
  params.set("Address", "");
  params.set("City", "");
  params.set("AccountName", "");
  params.set("Remarks", payload.remarks || "");

  params.set("MailingList", MB_FRONTASK_MAILINGLIST);
  if (MB_FRONTASK_SYSTEM_ID) params.set("SystemID", MB_FRONTASK_SYSTEM_ID);
  if (MB_FRONTASK_PROCESS_STEP_ID) params.set("ProcessDefinitionStepID", MB_FRONTASK_PROCESS_STEP_ID);

  params.set("RedirectTo", "");
  params.set("UpdateExistingDetails", MB_FRONTASK_UPDATE_EXISTING);

  const url = `${MB_FRONTASK_WEBTOLEAD_BASE}?${params.toString()}`;

  try {
    const res = await fetchWithTimeout(url, { method: "GET" }, 4500);
    if (!res.ok) return { ok: false, reason: `frontask_http_${res.status}` };
    return { ok: true, reason: "frontask_ok" };
  } catch (e) {
    return { ok: false, reason: `frontask_error_${e?.name || "err"}` };
  }
}

async function sendLeadWebhook(payload) {
  if (!MB_WEBHOOK_URL) return { ok: false, reason: "webhook_not_configured" };
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
    if (!res.ok) return { ok: false, reason: `webhook_http_${res.status}` };
    return { ok: true, reason: "webhook_ok" };
  } catch (e) {
    return { ok: false, reason: `webhook_error_${e?.name || "err"}` };
  }
}

async function deliverLead(payload) {
  if (MB_FRONTASK_WEBTOLEAD_BASE) {
    const r = await sendLeadFrontask(payload);
    if (r.ok) return r;
    if (MB_WEBHOOK_URL) return await sendLeadWebhook(payload);
    return r;
  }
  return await sendLeadWebhook(payload);
}

/* ------------------------- Strict flow engine ------------------------- */
const STATES = {
  ASK_TRACK: "ASK_TRACK",
  ASK_FIRST: "ASK_FIRST",
  ASK_LAST: "ASK_LAST",
  ASK_PHONE: "ASK_PHONE",
  ASK_EMAIL: "ASK_EMAIL",
};

function isOffScriptQuestion(text) {
  const t = (text || "").trim();
  if (!t) return false;
  // strict: any question / ask for details => offscript
  return [/\?/, /תסביר/, /פרטים/, /הלכה/, /כמה עולה/, /מסלול/, /שיטה/, /תנאים/].some((re) => re.test(t));
}

function graceMs() {
  return Math.max(2000, Math.min(MB_HANGUP_GRACE_MS, 8000));
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
  let source = "Voice AI - Nice Line";

  let state = STATES.ASK_TRACK;
  let openAiReady = false;
  let callEnded = false;
  let leadSent = false;

  // for idle
  let lastMediaTs = Date.now();
  let idleWarned = false;

  // barge-in handling
  let botSpeaking = false;
  let noListenUntilTs = 0;

  // outgoing audio buffer until streamSid exists (prevents cut opening)
  const outAudioBuffer = [];
  const MAX_AUDIO_BUFFER = 400;

  // response queue (prevents overlap)
  let responseInFlight = false;
  const responseQueue = [];

  const lead = {
    first_name: "",
    last_name: "",
    phone_number: "",
    email: "",
    study_track: "",
    source: "Voice AI - Nice Line",
    timestamp: "",
  };

  function logState(note) {
    ilog(`[STATE] ${state}${note ? " | " + note : ""}`);
  }
  function logBot(text) {
    ilog("BOT>", text);
  }
  function logUser(text) {
    ilog("USER>", text);
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

  async function deliver(call_status, reason) {
    if (leadSent) return;
    leadSent = true;

    const payload = {
      first_name: lead.first_name || "",
      last_name: lead.last_name || "",
      phone_number: lead.phone_number || normalizeIsraeliPhone("", caller) || "",
      email: lead.email || "",
      study_track: lead.study_track || "",
      call_status,
      source,
      timestamp: lead.timestamp || nowIso(),
      caller_id: caller || "",
      called: called || "",
      callSid: callSid || "",
      streamSid: streamSid || "",
      reason: reason || "",
      remarks: `מסלול: ${lead.study_track || ""} | סטטוס: ${call_status} | caller: ${caller || ""} | callSid: ${
        callSid || ""
      }`,
    };

    ilog("CRM> sending", safePayload(payload));
    const r = await deliverLead(payload);
    ilog("CRM> result", r);
    if (!r.ok) elog("CRM> FAILED", r);
  }

  async function finish(status, reason) {
    if (callEnded) return;
    callEnded = true;

    lead.timestamp = lead.timestamp || nowIso();
    await deliver(status, reason);

    const closing = getStr("closing", "");
    if (closing) {
      enqueueTextPrompt(`אמרו במשפט אחד בלבד: "${closing}"`, "closing");
      logBot(closing);
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

  function sayThanksThen(nextState) {
    const thanks = getStr("thanks", "תודה.");
    if (thanks) {
      enqueueTextPrompt(`אמרו בקצרה: "${thanks}"`, "thanks");
      logBot(thanks);
    }
    state = nextState;
    logState("next");
    askCurrent();
  }

  function askCurrent() {
    const qs = CONV.questions || {};
    let q = "";
    if (state === STATES.ASK_TRACK) q = qs.track || "";
    if (state === STATES.ASK_FIRST) q = qs.first || "";
    if (state === STATES.ASK_LAST) q = qs.last || "";
    if (state === STATES.ASK_PHONE) q = qs.phone || "";
    if (state === STATES.ASK_EMAIL) q = qs.email || "";

    if (!q) return;
    enqueueTextPrompt(`שאלו במשפט אחד בלבד: "${q}"`, `ask_${state}`);
    logBot(q);
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
          max_response_output_tokens: 280,
          instructions: SYS_PROMPT,
        },
      })
    );

    const opening = getStr("opening", "");
    if (opening) {
      enqueueTextPrompt(`אמרו את הפתיחה הבאה בלבד (בלי להוסיף שום דבר): "${opening}"`, "opening");
      logBot(opening);
    }

    // then first question
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

    if (msg.type === "response.audio.done") {
      botSpeaking = false;
      return;
    }

    if (msg.type === "response.completed") {
      responseInFlight = false;
      pumpQueue();
      return;
    }

    if (msg.type === "conversation.item.input_audio_transcription.completed") {
      const userText = (msg.transcript || "").trim();
      if (!userText || callEnded) return;

      logUser(userText);

      // Offscript
      if (isOffScriptQuestion(userText)) {
        const off = getStr("offscript", "");
        if (off) {
          enqueueTextPrompt(`ענו במשפט אחד בלבד: "${off}"`, "offscript");
          logBot(off);
        }
        askCurrent();
        return;
      }

      // Flow
      if (state === STATES.ASK_TRACK) {
        const tr = normalizeStudyTrack(userText);
        if (!tr) {
          const clarify = (CONV.questions && CONV.questions.track_clarify) || getStr("questions.track_clarify", "");
          if (clarify) {
            enqueueTextPrompt(`אמרו במשפט אחד בלבד: "${clarify}"`, "track_clarify");
            logBot(clarify);
          }
          askCurrent();
          return;
        }
        lead.study_track = tr;
        sayThanksThen(STATES.ASK_FIRST);
        return;
      }

      if (state === STATES.ASK_FIRST) {
        lead.first_name = userText;
        sayThanksThen(STATES.ASK_LAST);
        return;
      }

      if (state === STATES.ASK_LAST) {
        lead.last_name = userText;
        sayThanksThen(STATES.ASK_PHONE);
        return;
      }

      if (state === STATES.ASK_PHONE) {
        const phone = normalizeIsraeliPhone(userText, caller);
        if (!phone) {
          if (!lead.__phone_retry) {
            lead.__phone_retry = true;
            const retry = (CONV.questions && CONV.questions.phone_retry) || "";
            if (retry) {
              enqueueTextPrompt(`אמרו במשפט אחד בלבד: "${retry}"`, "phone_retry");
              logBot(retry);
            }
            askCurrent();
            return;
          }
          await finish("partial", "invalid_phone_twice");
          return;
        }
        lead.phone_number = phone;
        sayThanksThen(STATES.ASK_EMAIL);
        return;
      }

      if (state === STATES.ASK_EMAIL) {
        const t = userText.toLowerCase();
        const saysNo = t.includes("אין") || t.includes("לא") || t.includes("בלי");

        if (saysNo) {
          lead.email = "";
          await finish("completed", "done_no_email");
          return;
        }

        if (isValidEmailLike(userText)) {
          lead.email = userText.trim();
          await finish("completed", "done_with_email");
          return;
        }

        if (!lead.__email_retry) {
          lead.__email_retry = true;
          const retry = (CONV.questions && CONV.questions.email_retry) || "";
          if (retry) {
            enqueueTextPrompt(`אמרו במשפט אחד בלבד: "${retry}"`, "email_retry");
            logBot(retry);
          }
          askCurrent();
          return;
        }

        lead.email = "";
        await finish("completed", "done_email_skipped");
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
      await finish("partial", "openai_closed");
    }
  });
  openAiWs.on("error", async (e) => {
    if (!callEnded) {
      elog("OpenAI WS error", e?.message || e);
      await finish("partial", "openai_ws_error");
    }
  });

  /* ------------------------- idle + max timers ------------------------- */
  const idleInterval = setInterval(async () => {
    if (callEnded) return;
    const since = Date.now() - lastMediaTs;

    if (!idleWarned && since >= MB_IDLE_WARNING_MS) {
      idleWarned = true;
      const warn = getStr("idle_warning", "");
      if (warn) {
        enqueueTextPrompt(`אמרו במשפט אחד בלבד: "${warn}"`, "idle_warning");
        logBot(warn);
      }
    }
    if (since >= MB_IDLE_HANGUP_MS) {
      await finish("partial", "idle_timeout");
      clearInterval(idleInterval);
    }
  }, 1000);

  let maxWarnT = null,
    maxEndT = null;
  if (MB_MAX_CALL_MS > 0) {
    if (MB_MAX_WARN_BEFORE_MS > 0 && MB_MAX_CALL_MS > MB_MAX_WARN_BEFORE_MS) {
      maxWarnT = setTimeout(() => {
        if (!callEnded) {
          const warn = getStr("max_call_warning", "");
          if (warn) {
            enqueueTextPrompt(`אמרו במשפט אחד בלבד: "${warn}"`, "max_call_warning");
            logBot(warn);
          }
        }
      }, MB_MAX_CALL_MS - MB_MAX_WARN_BEFORE_MS);
    }
    maxEndT = setTimeout(async () => {
      if (!callEnded) await finish("partial", "max_call_duration");
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
      source = p.source || source;

      ilog("CALL start", { streamSid, callSid, caller, called });

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
        const enough =
          lead.study_track &&
          lead.first_name &&
          lead.last_name &&
          (lead.phone_number || normalizeIsraeliPhone("", caller));
        finish(enough ? "completed" : "partial", "twilio_stop");
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
