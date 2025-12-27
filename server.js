// server.js
// NiceLine – Malam Voice AI (Inbound) – STRICT FLOW + ALL-CALL RECORDING + MAKE RECORDING UPDATE (FIXED)
// Twilio Media Streams <-> OpenAI Realtime API
//
// Fixes included:
// - response.create modalities MUST be ["audio","text"] (not ["audio"]) to avoid OpenAI errors/no-audio.
// - temperature enforced >= 0.6.
// - Strict per-call reset (no carry-over).
// - Send to Make ONLY after call ends (twilio stop / timeouts / user exit).
// - Start Twilio "ALL CALL" recording via REST on call start.
// - Receive RecordingUrl via /twilio-recording-callback and update Make by callSid.
// - Optional wait at end to include recording_url in final lead if callback arrives quickly.
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
  return ["כן", "כן כן", "בטח", "בוודאי", "נכון", "מאשר", "בסדר", "אוקיי", "אוקי", "sure", "yes"].some(
    (w) => t === w || t.includes(w)
  );
}
function isNo(text) {
  const t = String(text || "").trim().toLowerCase();
  return ["לא", "לא תודה", "שלילי", "ממש לא", "לא רוצה", "עזוב", "עזבי", "no"].some(
    (w) => t === w || t.includes(w)
  );
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

// Prompts/texts
const MB_CONVERSATION_PROMPT_RAW = envStr("MB_CONVERSATION_PROMPT", "");
const MB_OPENING_TEXT = envStr("MB_OPENING_TEXT", "");
const MB_CLOSING_TEXT = envStr("MB_CLOSING_TEXT", "");

// Make webhook
const MB_WEBHOOK_URL = envStr("MB_WEBHOOK_URL", "").trim();

// Debug
const MB_DEBUG = envBool("MB_DEBUG", true);

// Recording (All call)
const MB_ENABLE_RECORDING = envBool("MB_ENABLE_RECORDING", false);
const MB_RECORDING_STATUS_CALLBACK_URL = envStr("MB_RECORDING_STATUS_CALLBACK_URL", "").trim();
const TWILIO_ACCOUNT_SID = envStr("TWILIO_ACCOUNT_SID", "");
const TWILIO_AUTH_TOKEN = envStr("TWILIO_AUTH_TOKEN", "");

// Optional: wait a bit on call end to include recording_url in final payload (ms)
const MB_RECORDING_WAIT_MS = envNum("MB_RECORDING_WAIT_MS", 8000);

// Noise / VAD
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
const MB_MAX_CALL_MS = envNum("MB_MAX_CALL_MS", 240000);
const MB_MAX_WARN_BEFORE_MS = envNum("MB_MAX_WARN_BEFORE_MS", 30000);

// Response safety
const MB_RESPONSE_FAILSAFE_MS = envNum("MB_RESPONSE_FAILSAFE_MS", 12000);

// Temperature: enforce >= 0.6
const OPENAI_TEMPERATURE = Math.max(0.6, envNum("MB_TEMPERATURE", 0.6));

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

/* ------------------------- Track parsing ------------------------- */
function parseTrack(raw) {
  const s = String(raw || "").trim().toLowerCase();

  // Hebrew direct
  if (/טוען\s*רבני/.test(s) || /טוען-רבני/.test(s)) return "טוען רבני";
  if (/דיינות/.test(s) || /דיינ/.test(s)) return "דיינות";
  if (/רבנות/.test(s) || /רבנ/.test(s)) return "רבנות";

  // English-ish (SAFE regex – no broken ranges)
  if (/toen|toen\s*rabani|toen\s*rabboni|tollen|tolen|rabani|rabboni/.test(s)) return "טוען רבני";
  if (/dayanut|dayan(?:u)?t|dayanoot|dayanut/.test(s)) return "דיינות";
  if (/rabbanut|rabba(?:\s|-)?nut|rabb(?:\s|-)?anut|rab(?:\s|-)?anut|rabban(?:\s|-)?ut/.test(s)) return "רבנות";

  return "";
}

function looksLikeUserTryingToExit(raw) {
  const t = String(raw || "").trim().toLowerCase();
  return /לא רוצה|לא מעוניין|עזוב|עזבי|ביי|bye|stop|leave|לא משאיר/.test(t);
}

function looksLikeMetaQuestion(raw) {
  const t = String(raw || "").trim();
  if (!t) return false;
  return /מי אתה|מי את|מה זה|מה אתם|למה אתם|מה אתם רוצים|\?$/.test(t);
}

/* ------------------------- Make webhook ------------------------- */
async function sendToMake(payload) {
  if (!MB_WEBHOOK_URL) return { ok: false, reason: "make_webhook_not_configured" };
  try {
    const res = await fetchWithTimeout(
      MB_WEBHOOK_URL,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
      7000
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
    RecordingStatusCallbackMethod: "POST",
  });

  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${base64BasicAuth(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      },
      9000
    );

    if (!res.ok) return { ok: false, reason: `twilio_rec_http_${res.status}` };
    const json = await res.json();
    return { ok: true, reason: "recording_started", sid: json.sid || "" };
  } catch (e) {
    return { ok: false, reason: `twilio_rec_error_${e?.name || "err"}` };
  }
}

/* ------------------------- In-memory stores ------------------------- */
const recordingByCallSid = new Map();      // callSid -> recordingUrl
const lastPayloadByCallSid = new Map();    // callSid -> last payload sent to Make

function setRecordingUrl(callSid, url) {
  if (!callSid || !url) return;
  recordingByCallSid.set(callSid, url);
  setTimeout(() => recordingByCallSid.delete(callSid), 2 * 60 * 60 * 1000).unref?.();
}
function getRecordingUrl(callSid) {
  return recordingByCallSid.get(callSid) || "";
}
function setLastPayload(callSid, payload) {
  if (!callSid) return;
  lastPayloadByCallSid.set(callSid, payload);
  setTimeout(() => lastPayloadByCallSid.delete(callSid), 2 * 60 * 60 * 1000).unref?.();
}
function getLastPayload(callSid) {
  return lastPayloadByCallSid.get(callSid) || null;
}

/* ------------------------- Express ------------------------- */
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Twilio form callbacks

app.get("/health", (_req, res) => res.json({ ok: true, time: nowIso() }));

// Twilio will POST RecordingUrl here when completed
app.post("/twilio-recording-callback", async (req, res) => {
  const callSid = req.body.CallSid || req.body.callSid || "";
  const recordingUrl = req.body.RecordingUrl || req.body.recordingUrl || "";

  ilog("RECORDING callback", { callSid, recordingUrl });

  if (callSid && recordingUrl) {
    setRecordingUrl(callSid, recordingUrl);

    // Send update so Make can update the same row (use callSid as key)
    const prev = getLastPayload(callSid);
    const updatePayload = {
      update_type: "recording_update",
      callSid,
      recording_url: recordingUrl,
      timestamp: nowIso(),

      caller_id: prev?.caller_id || "",
      called: prev?.called || "",
      streamSid: prev?.streamSid || "",
      call_status: prev?.call_status || "",
      call_status_code: prev?.call_status_code || "",
      source: prev?.source || "Voice AI - Nice Line",

      first_name: prev?.first_name || "",
      last_name: prev?.last_name || "",
      phone_number: prev?.phone_number || "",
      study_track: prev?.study_track || "",
    };

    if (MB_WEBHOOK_URL) {
      ilog("CRM> sending recording update", updatePayload);
      const r = await sendToMake(updatePayload);
      ilog("CRM> recording update result", r);
      if (!r.ok) elog("CRM> recording update FAILED", r);
    }
  }

  res.status(200).send("ok");
});

/* ------------------------- WS: Media Stream ------------------------- */
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/twilio-media-stream" });

wss.on("connection", (twilioWs) => {
  // --- Per-call variables (STRICT RESET) ---
  let streamSid = "";
  let callSid = "";
  let caller = ""; // this is the identified number (customer)
  let called = ""; // this is the bot number
  let callerPhoneLocal = "";

  const STATES = {
    CONSENT: "CONSENT",
    ASK_TRACK: "ASK_TRACK",
    ASK_FIRST: "ASK_FIRST",
    ASK_LAST: "ASK_LAST",
    CONFIRM_CALLER_PHONE: "CONFIRM_CALLER_PHONE",
    ASK_PHONE_MANUAL: "ASK_PHONE_MANUAL",
    CONFIRM_PHONE_MANUAL: "CONFIRM_PHONE_MANUAL",
    DONE: "DONE",
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

  // Hard speech queue + lock (prevents active_response)
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
    called: "",
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

  function openAiSafeSend(obj) {
    if (!openAiReady) return false;
    if (!openAiWs || openAiWs.readyState !== WebSocket.OPEN) return false;
    openAiWs.send(JSON.stringify(obj));
    return true;
  }

  // IMPORTANT: We force VERBATIM reading (no paraphrase).
  function buildVerbatimInstruction(text) {
    const clean = String(text || "").trim();
    return `קרא/י עכשיו בדיוק מילה במילה את הטקסט הבא, בלי לשנות, בלי להוסיף, ובלי להחסיר אף תו:\n"""${clean}"""`;
  }

  function pumpSpeakQueue() {
    if (callEnded) return;
    if (!openAiReady) return;
    if (responseInFlight) return;
    if (speakQueue.length === 0) return;
    if (openAiWs.readyState !== WebSocket.OPEN) return;

    const { text, why } = speakQueue.shift();
    const line = String(text || "").trim();
    if (!line) return;

    responseInFlight = true;
    startInFlightFailsafe();
    dlog("SPEAK>", why, line);

    // cancel any previous output safely (if none active, OpenAI may return an error -> harmless)
    openAiSafeSend({ type: "response.cancel" });

    // ✅ FIX: modalities must be ["audio","text"] (not ["audio"])
    openAiSafeSend({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions: buildVerbatimInstruction(line),
        max_output_tokens: 180,
      },
    });

    logBot(line);
  }

  function speakExact(text, why = "speak") {
    const line = String(text || "").trim();
    if (!line) return;
    speakQueue.push({ text: line, why });
    pumpSpeakQueue();
  }

  function askCurrent() {
    const qs = CONV.questions || {};
    if (state === STATES.CONSENT) return speakExact(MB_OPENING_TEXT, "opening");
    if (state === STATES.ASK_TRACK) return speakExact(qs.ask_track || "באיזה מסלול אתם מתעניינים? רבנות, דיינות, או טוען רבני?", "ask_track");
    if (state === STATES.ASK_FIRST) return speakExact(qs.ask_first_name || "מה השם הפרטי שלכם?", "ask_first");
    if (state === STATES.ASK_LAST) return speakExact(qs.ask_last_name || "ומה שם המשפחה?", "ask_last");
    if (state === STATES.CONFIRM_CALLER_PHONE) {
      const tmpl = qs.confirm_caller_phone || "זה המספר שממנו אתם מתקשרים שמסתיים ב־{{last4}}. לחזור אליו?";
      return speakExact(renderTemplate(tmpl, { last4: last4(callerPhoneLocal) }), "confirm_caller_phone");
    }
    if (state === STATES.ASK_PHONE_MANUAL) return speakExact(qs.ask_phone_manual || "איזה מספר תרצו להשאיר לחזרה? נא לומר ספרות בלבד.", "ask_phone_manual");
    if (state === STATES.CONFIRM_PHONE_MANUAL) {
      const tmpl = qs.confirm_phone_manual || "רק לוודא: המספר הוא {{phone}}. נכון?";
      return speakExact(renderTemplate(tmpl, { phone: digitsOnly(lead.phone_number) }), "confirm_phone_manual");
    }
  }

  async function waitForRecordingUrl(callSidToWait, waitMs) {
    if (!callSidToWait || waitMs <= 0) return "";
    const start = Date.now();
    while (Date.now() - start < waitMs) {
      const url = getRecordingUrl(callSidToWait);
      if (url) return url;
      await new Promise((r) => setTimeout(r, 250));
    }
    return getRecordingUrl(callSidToWait) || "";
  }

  async function deliver(statusHe, statusCode, reason) {
    if (leadSent) return;
    leadSent = true;

    // Try to include recording_url already at final lead (best effort)
    const recording_url = await waitForRecordingUrl(callSid, MB_RECORDING_WAIT_MS);

    const payload = {
      update_type: "lead",
      first_name: lead.first_name || "",
      last_name: lead.last_name || "",
      phone_number: lead.phone_number || "",
      study_track: lead.study_track || "",
      source: lead.source || "Voice AI - Nice Line",
      timestamp: lead.timestamp || nowIso(),

      // HARD RULE: always send caller_id (identified number of customer)
      caller_id: lead.caller_id || caller || "",
      called: lead.called || called || "",
      callSid: callSid || "",
      streamSid: streamSid || "",

      call_status: statusHe,
      call_status_code: statusCode,
      reason: reason || "",

      recording_url,

      remarks:
        `מסלול: ${lead.study_track || ""} | סטטוס: ${statusHe} | caller: ${lead.caller_id || caller || ""} | callSid: ${callSid || ""}`,
    };

    // save for later recording update
    setLastPayload(callSid, payload);

    ilog("CRM> sending", payload);
    const r = await sendToMake(payload);
    ilog("CRM> result", r);
    if (!r.ok) elog("CRM> FAILED", r);
  }

  async function finish(statusHe, statusCode, reason, opts = { speakClosing: true }) {
    if (callEnded) return;
    callEnded = true;
    state = STATES.DONE;

    await deliver(statusHe, statusCode, reason);

    // Close sockets after optional closing
    if (opts.speakClosing && MB_CLOSING_TEXT) {
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

  function guardrailAnswer() {
    return getStr("guardrail", "אנחנו מערכת רישום בלבד. יועץ לימודים יחזור אליכם עם כל ההסברים. אפשר להמשיך להשאיר פרטים?");
  }

  /* ------------------------- OpenAI Realtime WS ------------------------- */
  const openAiWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17", {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" },
  });

  openAiWs.on("open", () => {
    openAiReady = true;

    openAiSafeSend({
      type: "session.update",
      session: {
        model: "gpt-4o-realtime-preview-2024-12-17",
        // ✅ FIX: session modalities must include BOTH audio+text to support audio output reliably
        modalities: ["audio", "text"],
        voice: OPENAI_VOICE,
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        input_audio_transcription: { model: "whisper-1" },

        temperature: OPENAI_TEMPERATURE,

        turn_detection: {
          type: "server_vad",
          threshold: MB_VAD_THRESHOLD,
          silence_duration_ms: MB_VAD_SILENCE_MS + MB_VAD_SUFFIX_MS,
          prefix_padding_ms: MB_VAD_PREFIX_MS,
        },

        max_response_output_tokens: 120,

        instructions:
          (getStr("system", "") || "") +
          "\n\nכללים קשיחים (חובה): עברית תקינה בלבד, לשון רבים בלבד. אין לאסוף אימייל. אין לשנות ניסוחים של שאלות/פתיח/סגיר. לא לענות תשובות חופשיות – רק הקראה של הטקסט שניתן לך.",
      },
    });

    // Flush buffered audio
    while (inAudioBuffer.length) {
      const b64 = inAudioBuffer.shift();
      openAiSafeSend({ type: "input_audio_buffer.append", audio: b64 });
    }

    // Start fresh
    state = STATES.CONSENT;
    logState("start");
    askCurrent();
  });

  openAiWs.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // Audio streaming back to Twilio
    if (msg.type === "response.audio.delta") {
      botSpeaking = true;
      noListenUntilTs = Date.now() + MB_NO_BARGE_TAIL_MS;

      if (!streamSid) {
        outAudioBuffer.push(msg.delta);
        if (outAudioBuffer.length > MAX_OUT_AUDIO_BUFFER) outAudioBuffer.shift();
        return;
      }
      try {
        twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: msg.delta } }));
      } catch {}
      return;
    }

    // Any completion event -> release lock
    if (
      msg.type === "response.audio.done" ||
      msg.type === "response.done" ||
      msg.type === "response.completed" ||
      msg.type === "response.output_item.done"
    ) {
      botSpeaking = false;
      clearInFlight();
      pumpSpeakQueue();
      return;
    }

    // STT transcript from user
    if (msg.type === "conversation.item.input_audio_transcription.completed") {
      const userText = (msg.transcript || "").trim();
      if (!userText || callEnded) return;

      logUser(userText);

      if (looksLikeUserTryingToExit(userText)) {
        await finish("שיחה חלקית", "partial", "user_exit", { speakClosing: false });
        return;
      }

      if (looksLikeMetaQuestion(userText)) {
        speakExact(guardrailAnswer(), "guardrail_meta");
        return;
      }

      // FLOW
      if (state === STATES.CONSENT) {
        if (isYes(userText)) {
          state = STATES.ASK_TRACK;
          logState("yes");
          askCurrent();
          return;
        }
        if (isNo(userText)) {
          await finish("שיחה חלקית", "not_interested", "consent_no", { speakClosing: false });
          return;
        }
        speakExact(getStr("consent_retry", "רק לוודא: זה בסדר מבחינתכם? אפשר לענות רק כן או לא."), "consent_retry");
        return;
      }

      if (state === STATES.ASK_TRACK) {
        const tr = parseTrack(userText);
        if (!tr) {
          speakExact(getStr("track_retry", "אפשר לבחור אחד משלושת המסלולים: רבנות, דיינות, או טוען רבני. באיזה מסלול אתם מתעניינים?"), "track_retry");
          return;
        }
        lead.study_track = tr;
        state = STATES.ASK_FIRST;
        logState("got_track");
        askCurrent();
        return;
      }

      if (state === STATES.ASK_FIRST) {
        const maybePhone = normalizeIsraeliPhone(userText, "");
        if (maybePhone) {
          speakExact(getStr("first_name_retry", "רק השם הפרטי בבקשה (לא מספר). איך קוראים לכם?"), "first_name_retry");
          return;
        }
        lead.first_name = userText;
        state = STATES.ASK_LAST;
        logState("got_first");
        askCurrent();
        return;
      }

      if (state === STATES.ASK_LAST) {
        const maybePhone = normalizeIsraeliPhone(userText, "");
        if (maybePhone) {
          speakExact(getStr("last_name_retry", "רק שם משפחה בבקשה (לא מספר). מה שם המשפחה?"), "last_name_retry");
          return;
        }
        lead.last_name = userText;

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
        speakExact(getStr("confirm_yesno_retry", "אפשר לענות רק כן או לא. לחזור למספר הזה?"), "confirm_yesno_retry");
        return;
      }

      if (state === STATES.ASK_PHONE_MANUAL) {
        const p = normalizeIsraeliPhone(userText, "");
        if (!p) {
          speakExact(getStr("phone_retry", "סליחה, צריך מספר ישראלי תקין בספרות בלבד. ננסה שוב."), "phone_retry");
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
        speakExact(getStr("confirm_yesno_retry", "אפשר לענות רק כן או לא. המספר נכון?"), "confirm_yesno_retry");
        return;
      }
    }

    if (msg.type === "error") {
      const code = msg?.error?.code;
      elog("OpenAI error", msg);

      // release lock and continue queue
      if (code === "conversation_already_has_active_response") {
        clearInFlight();
        pumpSpeakQueue();
        return;
      }

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
        if (!callEnded) speakExact(getStr("max_call_warning", "עוֹד מְעַט נְסַיֵּם כְּדֵי לְשְׁמֹר עַל זְמַן הַשִּׂיחָה."), "max_call_warning");
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

      // IMPORTANT: caller_id = customer, called = bot number
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
          try { twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: b64 } })); } catch {}
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

      openAiSafeSend({ type: "input_audio_buffer.append", audio: payload });
      return;
    }

    if (msg.event === "stop") {
      const full = !!(lead.first_name && lead.last_name && lead.study_track && (lead.phone_number || callerPhoneLocal));
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
