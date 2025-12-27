// server.js
// NiceLine – Malam Voice AI (Inbound) – STRICT FLOW + ALL-CALL RECORDING
// Twilio Media Streams <-> OpenAI Realtime API
//
// Features:
// - Opening / Closing are ENV controlled (MB_OPENING_TEXT / MB_CLOSING_TEXT)
// - Strict per-call reset
// - Fix OpenAI Realtime: temperature must be >= 0.6 (set to 0.6)
// - Start Twilio call recording "ALL CALL" via REST on call start
// - Receive RecordingUrl via /twilio-recording-callback and send to Make
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
function last4(phoneLocal) {
  const d = digitsOnly(phoneLocal || "");
  return d.length >= 4 ? d.slice(-4) : "";
}
function isYes(text) {
  const t = String(text || "").trim().toLowerCase();
  return ["כן", "כן כן", "בטח", "בוודאי", "נכון", "מאשר", "בסדר", "אוקיי"].some((w) => t === w || t.includes(w));
}
function isNo(text) {
  const t = String(text || "").trim().toLowerCase();
  return ["לא", "לא תודה", "שלילי", "ממש לא", "לא רוצה", "עזוב", "עזבי"].some((w) => t === w || t.includes(w));
}
function looksLikeQuestionAboutInfo(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  const patterns = [
    /מחיר|כמה עולה|תשלום|עלויות/,
    /תוכן|מה לומדים|סילבוס|שיעורים|רב|מרצה/,
    /מועדים|תאריך|פתיחה|מתחיל|הרשמה|קורס/,
    /התאמה|מתאים לי|רמה|דרישות|תנאים/,
    /\?/,
  ];
  return patterns.some((re) => re.test(t));
}
function safeJsonParse(raw, fallback = null) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
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
    out = out.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, "g"), String(v ?? ""));
  }
  return out;
}
function base64BasicAuth(user, pass) {
  return Buffer.from(`${user}:${pass}`, "utf8").toString("base64");
}

/* ------------------------- config ------------------------- */
const PORT = envNum("PORT", 10000);

const OPENAI_API_KEY = envStr("OPENAI_API_KEY", "");
const OPENAI_VOICE = envStr("OPENAI_VOICE", "cedar");

const MB_CONVERSATION_PROMPT_RAW = envStr("MB_CONVERSATION_PROMPT", "");
const MB_OPENING_TEXT = envStr("MB_OPENING_TEXT", "");
const MB_CLOSING_TEXT = envStr("MB_CLOSING_TEXT", "");

const MB_WEBHOOK_URL = envStr("MB_WEBHOOK_URL", "").trim();

const MB_DEBUG = envBool("MB_DEBUG", true);

// Recording (All call)
const MB_ENABLE_RECORDING = envBool("MB_ENABLE_RECORDING", false);
const MB_RECORDING_STATUS_CALLBACK_URL = envStr("MB_RECORDING_STATUS_CALLBACK_URL", "").trim();
const TWILIO_ACCOUNT_SID = envStr("TWILIO_ACCOUNT_SID", "");
const TWILIO_AUTH_TOKEN = envStr("TWILIO_AUTH_TOKEN", "");

// Noise / VAD
const MB_VAD_THRESHOLD = envNum("MB_VAD_THRESHOLD", 0.65);
const MB_VAD_SILENCE_MS = envNum("MB_VAD_SILENCE_MS", 900);
const MB_VAD_PREFIX_MS = envNum("MB_VAD_PREFIX_MS", 200);
const MB_VAD_SUFFIX_MS = envNum("MB_VAD_SUFFIX_MS", 200);

// Barge-in
const MB_ALLOW_BARGE_IN = envBool("MB_ALLOW_BARGE_IN", false);
const MB_NO_BARGE_TAIL_MS = envNum("MB_NO_BARGE_TAIL_MS", 900);

// Timers
const MB_IDLE_WARNING_MS = envNum("MB_IDLE_WARNING_MS", 25000);
const MB_IDLE_HANGUP_MS = envNum("MB_IDLE_HANGUP_MS", 55000);
const MB_MAX_CALL_MS = envNum("MB_MAX_CALL_MS", 3 * 60 * 1000);
const MB_MAX_WARN_BEFORE_MS = envNum("MB_MAX_WARN_BEFORE_MS", 25000);

// Response safety
const MB_RESPONSE_FAILSAFE_MS = envNum("MB_RESPONSE_FAILSAFE_MS", 12000);

function ilog(...a) { console.log("[INFO]", ...a); }
function elog(...a) { console.error("[ERROR]", ...a); }
function dlog(...a) { if (MB_DEBUG) console.log("[DEBUG]", ...a); }

if (!OPENAI_API_KEY) elog("[FATAL] Missing OPENAI_API_KEY");
if (!MB_CONVERSATION_PROMPT_RAW) elog("[FATAL] Missing MB_CONVERSATION_PROMPT");
if (!MB_OPENING_TEXT) ilog("[WARN] Missing MB_OPENING_TEXT");
if (!MB_CLOSING_TEXT) ilog("[WARN] Missing MB_CLOSING_TEXT");
if (!MB_WEBHOOK_URL) ilog("[WARN] Missing MB_WEBHOOK_URL (Make) – will not push leads.");

if (MB_ENABLE_RECORDING) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) elog("[FATAL] Recording enabled but missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN");
  if (!MB_RECORDING_STATUS_CALLBACK_URL) elog("[FATAL] Recording enabled but missing MB_RECORDING_STATUS_CALLBACK_URL");
}

/* ------------------------- prompt JSON ------------------------- */
const CONV = safeJsonParse(MB_CONVERSATION_PROMPT_RAW, null);
if (!CONV) {
  elog("[FATAL] MB_CONVERSATION_PROMPT must be valid JSON");
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

/* ------------------------- Twilio Recording (REST) ------------------------- */
async function startTwilioRecording(callSid) {
  if (!MB_ENABLE_RECORDING) return { ok: false, reason: "recording_disabled" };
  if (!callSid) return { ok: false, reason: "missing_callSid" };

  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}/Recordings.json`;

  const body = new URLSearchParams({
    RecordingStatusCallback: MB_RECORDING_STATUS_CALLBACK_URL,
    RecordingStatusCallbackEvent: "completed",
    RecordingStatusCallbackMethod: "POST"
  });

  try {
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${base64BasicAuth(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    }, 6000);

    if (!res.ok) return { ok: false, reason: `twilio_rec_http_${res.status}` };
    const json = await res.json();
    return { ok: true, reason: "recording_started", sid: json.sid || "" };
  } catch (e) {
    return { ok: false, reason: `twilio_rec_error_${e?.name || "err"}` };
  }
}

/* ------------------------- Recording URL store ------------------------- */
// Store for a short time (calls finish fast). Key = CallSid
const recordingByCallSid = new Map();
function setRecordingUrl(callSid, url) {
  if (!callSid || !url) return;
  recordingByCallSid.set(callSid, url);
  // auto cleanup after 2 hours
  setTimeout(() => recordingByCallSid.delete(callSid), 2 * 60 * 60 * 1000).unref?.();
}
function getRecordingUrl(callSid) {
  return recordingByCallSid.get(callSid) || "";
}

/* ------------------------- Express ------------------------- */
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // for Twilio form callbacks

app.get("/health", (_req, res) => res.json({ ok: true, time: nowIso() }));

// Twilio Voice webhook: point your Twilio number to POST https://niceline.onrender.com/twilio-voice
app.post("/twilio-voice", (req, res) => {
  // Important: stream uses WSS + your domain
  const wsUrl = "wss://niceline.onrender.com/twilio-media-stream";

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="caller" value="${req.body.From || ""}"/>
      <Parameter name="called" value="${req.body.To || ""}"/>
    </Stream>
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// Twilio will POST RecordingUrl here when completed
app.post("/twilio-recording-callback", (req, res) => {
  const callSid = req.body.CallSid || req.body.callSid || "";
  const recordingUrl = req.body.RecordingUrl || req.body.recordingUrl || "";

  ilog("RECORDING callback", { callSid, recordingUrl });

  if (callSid && recordingUrl) {
    setRecordingUrl(callSid, recordingUrl);
  }
  res.status(200).send("ok");
});

/* ------------------------- WS: Media Stream ------------------------- */
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/twilio-media-stream" });

wss.on("connection", (twilioWs) => {
  let streamSid = "";
  let callSid = "";
  let caller = "";
  let called = "";
  let callerPhoneLocal = "";

  const STATES = {
    CONSENT: "CONSENT",
    ASK_NAME: "ASK_NAME",
    CONFIRM_CALLER_PHONE: "CONFIRM_CALLER_PHONE",
    ASK_PHONE_MANUAL: "ASK_PHONE_MANUAL",
    CONFIRM_PHONE_MANUAL: "CONFIRM_PHONE_MANUAL",
  };
  let state = STATES.CONSENT;

  let openAiReady = false;
  let callEnded = false;
  let leadSent = false;

  let lastMediaTs = Date.now();
  let idleWarned = false;

  let botSpeaking = false;
  let noListenUntilTs = 0;

  const inAudioBuffer = [];
  const MAX_IN_AUDIO_BUFFER = 300;

  const outAudioBuffer = [];
  const MAX_OUT_AUDIO_BUFFER = 600;

  let responseInFlight = false;
  let responseTimer = null;
  const speakQueue = [];

  const lead = {
    first_name: "",
    last_name: "",
    phone_number: "",
    study_track: "",
    source: "Voice AI - Nice Line",
    timestamp: "",
    caller_id: "",
    called: ""
  };

  function logState(note) { ilog(`[STATE] ${state}${note ? " | " + note : ""}`); }
  function logBot(text) { ilog("BOT>", text); }
  function logUser(text) { ilog("USER>", text); }

  function clearInFlight() {
    responseInFlight = false;
    if (responseTimer) { clearTimeout(responseTimer); responseTimer = null; }
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
    if (openAiWs.readyState !== WebSocket.OPEN) return;

    const { text, why } = speakQueue.shift();
    responseInFlight = true;
    startInFlightFailsafe();
    dlog("SPEAK>", why, text);

    openAiWs.send(JSON.stringify({
      type: "conversation.item.create",
      item: { type: "message", role: "assistant", content: [{ type: "text", text }] }
    }));
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
    if (state === STATES.CONSENT) return speakExact(MB_OPENING_TEXT, "opening");
    if (state === STATES.ASK_NAME) return speakExact(qs.ask_name || "", "ask_name");
    if (state === STATES.CONFIRM_CALLER_PHONE) {
      return speakExact(renderTemplate(qs.confirm_caller_phone || "", { last4: last4(callerPhoneLocal) }), "confirm_caller_phone");
    }
    if (state === STATES.ASK_PHONE_MANUAL) return speakExact(qs.ask_phone_manual || "", "ask_phone_manual");
    if (state === STATES.CONFIRM_PHONE_MANUAL) {
      return speakExact(renderTemplate(qs.confirm_phone_manual || "", { phone: digitsOnly(lead.phone_number) }), "confirm_phone_manual");
    }
  }

  async function deliver(statusHe, statusCode, reason) {
    if (leadSent) return;
    leadSent = true;

    const recording_url = getRecordingUrl(callSid) || "";

    const payload = {
      first_name: lead.first_name || "",
      last_name: lead.last_name || "",
      phone_number: lead.phone_number || "",
      study_track: lead.study_track || "",
      source: lead.source || "Voice AI - Nice Line",
      timestamp: lead.timestamp || nowIso(),

      caller_id: lead.caller_id || caller || "",
      called: lead.called || called || "",
      callSid: callSid || "",
      streamSid: streamSid || "",

      call_status: statusHe,
      call_status_code: statusCode,
      reason: reason || "",

      recording_url,

      remarks: `סטטוס: ${statusHe} | caller: ${lead.caller_id || caller || ""} | callSid: ${callSid || ""}`
    };

    ilog("CRM> sending", payload);
    const r = await sendToMake(payload);
    ilog("CRM> result", r);
    if (!r.ok) elog("CRM> FAILED", r);
  }

  async function finish(statusHe, statusCode, reason, opts = { speakClosing: true }) {
    if (callEnded) return;
    callEnded = true;

    await deliver(statusHe, statusCode, reason);

    if (opts.speakClosing) {
      speakExact(MB_CLOSING_TEXT, "closing");
      setTimeout(() => {
        try { openAiWs?.close(); } catch {}
        try { twilioWs?.close(); } catch {}
      }, 3500);
    } else {
      try { openAiWs?.close(); } catch {}
      try { twilioWs?.close(); } catch {}
    }
  }

  function guardrailAndClose() {
    speakExact(getStr("guardrail", "אנחנו מערכת רישום בלבד. נציג יחזור אליכם עם כל ההסברים. יום טוב."), "guardrail");
    finish("שיחה חלקית", "partial", "guardrail_question", { speakClosing: false });
  }

  /* ------------------------- OpenAI Realtime WS ------------------------- */
  const openAiWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17", {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" }
  });

  openAiWs.on("open", () => {
    openAiReady = true;

    openAiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        model: "gpt-4o-realtime-preview-2024-12-17",
        modalities: ["audio", "text"],
        voice: OPENAI_VOICE,
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        input_audio_transcription: { model: "whisper-1" },

        // IMPORTANT: your model requires temperature >= 0.6
        temperature: 0.6,

        turn_detection: {
          type: "server_vad",
          threshold: MB_VAD_THRESHOLD,
          silence_duration_ms: MB_VAD_SILENCE_MS + MB_VAD_SUFFIX_MS,
          prefix_padding_ms: MB_VAD_PREFIX_MS
        },

        max_response_output_tokens: 140,
        instructions:
          (getStr("system", "") || "") +
          "\n\nחוקים קשיחים: אתם גבר בשם מוטי. עברית תקינה, לשון רבים בלבד. אין לאסוף אימייל. אין לשנות ניסוחים."
      }
    }));

    while (inAudioBuffer.length) {
      const b64 = inAudioBuffer.shift();
      openAiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
    }

    state = STATES.CONSENT;
    logState("start");
    askCurrent();
  });

  openAiWs.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "response.audio.delta") {
      botSpeaking = true;
      noListenUntilTs = Date.now() + MB_NO_BARGE_TAIL_MS;

      if (!streamSid) {
        outAudioBuffer.push(msg.delta);
        if (outAudioBuffer.length > MAX_OUT_AUDIO_BUFFER) outAudioBuffer.shift();
        return;
      }
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: msg.delta } }));
      return;
    }

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

      if (looksLikeQuestionAboutInfo(userText)) {
        guardrailAndClose();
        return;
      }

      if (state === STATES.CONSENT) {
        if (isYes(userText)) {
          state = STATES.ASK_NAME;
          logState("yes");
          askCurrent();
          return;
        }
        if (isNo(userText)) {
          await finish("שיחה חלקית", "not_interested", "consent_no", { speakClosing: false });
          return;
        }
        speakExact(getStr("consent_retry", "רק לוודא: זה בסדר מבחינתכם? אפשר לענות כן או לא."), "consent_retry");
        return;
      }

      if (state === STATES.ASK_NAME) {
        lead.first_name = userText;

        callerPhoneLocal = normalizeIsraeliPhone("", caller) || "";
        if (callerPhoneLocal) {
          state = STATES.CONFIRM_CALLER_PHONE;
          logState("have_caller_phone");
          askCurrent();
        } else {
          state = STATES.ASK_PHONE_MANUAL;
          logState("no_caller_phone");
          askCurrent();
        }
        return;
      }

      if (state === STATES.CONFIRM_CALLER_PHONE) {
        if (isYes(userText)) {
          lead.phone_number = callerPhoneLocal;
          await finish("שיחה מלאה", "completed", "caller_phone_confirmed", { speakClosing: true });
          return;
        }
        if (isNo(userText)) {
          state = STATES.ASK_PHONE_MANUAL;
          logState("caller_phone_no");
          askCurrent();
          return;
        }
        speakExact(getStr("questions.confirm_caller_phone_retry", "אפשר לענות רק כן או לא. זה המספר הנכון?"), "confirm_retry");
        return;
      }

      if (state === STATES.ASK_PHONE_MANUAL) {
        const p = normalizeIsraeliPhone(userText, "");
        if (!p) {
          speakExact(getStr("questions.phone_retry", "סליחה, צריך מספר תקין בספרות בלבד. ננסה שוב."), "phone_retry");
          return;
        }
        lead.phone_number = p;
        state = STATES.CONFIRM_PHONE_MANUAL;
        logState("got_manual_phone");
        askCurrent();
        return;
      }

      if (state === STATES.CONFIRM_PHONE_MANUAL) {
        if (isYes(userText)) {
          await finish("שיחה מלאה", "completed", "manual_phone_confirmed", { speakClosing: true });
          return;
        }
        if (isNo(userText)) {
          state = STATES.ASK_PHONE_MANUAL;
          logState("manual_phone_no");
          askCurrent();
          return;
        }
        speakExact(getStr("questions.confirm_phone_manual_retry", "אפשר לענות רק כן או לא. המספר נכון?"), "confirm_manual_retry");
        return;
      }
    }

    if (msg.type === "error") {
      const code = msg?.error?.code;
      elog("OpenAI error", msg);
      if (code === "conversation_already_has_active_response") return;
      clearInFlight();
      pumpSpeakQueue();
    }
  });

  openAiWs.on("close", async () => {
    if (!callEnded) await finish("שיחה חלקית", "partial", "openai_closed", { speakClosing: false });
  });

  openAiWs.on("error", async (e) => {
    if (!callEnded) {
      elog("OpenAI WS error", e?.message || e);
      await finish("שיחה חלקית", "partial", "openai_ws_error", { speakClosing: false });
    }
  });

  /* ------------------------- idle + max timers ------------------------- */
  const idleInterval = setInterval(async () => {
    if (callEnded) return;
    const since = Date.now() - lastMediaTs;

    if (!idleWarned && since >= MB_IDLE_WARNING_MS) {
      idleWarned = true;
      speakExact(getStr("idle_warning", "רק לוודא שאתם איתנו."), "idle_warning");
    }
    if (since >= MB_IDLE_HANGUP_MS) {
      await finish("שיחה חלקית", "partial", "idle_timeout", { speakClosing: false });
      clearInterval(idleInterval);
    }
  }, 1000);

  let maxWarnT = null;
  let maxEndT = null;
  if (MB_MAX_CALL_MS > 0) {
    if (MB_MAX_WARN_BEFORE_MS > 0 && MB_MAX_CALL_MS > MB_MAX_WARN_BEFORE_MS) {
      maxWarnT = setTimeout(() => {
        if (!callEnded) speakExact("עוֹד מְעַט נְסַיֵּם כְּדֵי לְשְׁמֹר עַל זְמַן הַשִּׂיחָה.", "max_call_warning");
      }, MB_MAX_CALL_MS - MB_MAX_WARN_BEFORE_MS);
    }
    maxEndT = setTimeout(async () => {
      if (!callEnded) await finish("שיחה חלקית", "partial", "max_call_duration", { speakClosing: false });
    }, MB_MAX_CALL_MS);
  }

  /* ------------------------- Twilio WS ------------------------- */
  twilioWs.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || "";
      callSid = msg.start?.callSid || "";

      const p = msg.start?.customParameters || {};
      caller = p.caller || "";
      called = p.called || "";

      lead.caller_id = caller || "";
      lead.called = called || "";
      lead.timestamp = nowIso();

      callerPhoneLocal = normalizeIsraeliPhone("", caller) || "";

      ilog("CALL start", { streamSid, callSid, caller, called, callerPhoneLocal });

      // Start ALL-CALL recording
      if (MB_ENABLE_RECORDING) {
        const rr = await startTwilioRecording(callSid);
        ilog("RECORDING>", rr);
        if (!rr.ok) elog("RECORDING FAILED>", rr);
      }

      // flush buffered OpenAI->Twilio audio
      if (streamSid && outAudioBuffer.length) {
        for (const b64 of outAudioBuffer.splice(0, outAudioBuffer.length)) {
          twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: b64 } }));
        }
      }
      return;
    }

    if (msg.event === "media") {
      lastMediaTs = Date.now();

      const now = Date.now();
      if (!MB_ALLOW_BARGE_IN) {
        if (botSpeaking || now < noListenUntilTs) return;
      }

      const payload = msg.media?.payload;
      if (!payload) return;

      if (!openAiReady || openAiWs.readyState !== WebSocket.OPEN) {
        inAudioBuffer.push(payload);
        if (inAudioBuffer.length > MAX_IN_AUDIO_BUFFER) inAudioBuffer.shift();
        return;
      }

      openAiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: payload }));
      return;
    }

    if (msg.event === "stop") {
      const full = !!(lead.first_name && (lead.phone_number || callerPhoneLocal));
      await finish(full ? "שיחה מלאה" : "שיחה חלקית", full ? "completed" : "partial", "twilio_stop", { speakClosing: false });
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
  ilog(`✅ Server running on port ${PORT}`);
});
