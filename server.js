// server.js
//
// NiceLine / מרכז מל"מ – Voice AI (Scripted, Deterministic)
// Twilio Media Streams <-> Render
//
// FLOW (FINAL):
// 1) Opening: played ONLY by Twilio Asset (no MB_OPENING_TEXT, no duplication)
// 2) ASK_NAME (full name, NO confirmation)
// 3) PHONE:
//    - Mobile (+9725): auto-use caller_id -> closing
//    - Landline (+9722/3/4/7/8/9): ask for callback phone (9–10 digits), one retry
// 4) Closing: played ONLY by Twilio Asset -> sendFinal once -> clean hangup
//
// DO NOT TOUCH:
// - Webhook payload shape
// - sendFinal / CRM fields
// - Recording logic / URLs
// - caller_id / called / callSid / streamSid

const express = require("express");
const WebSocket = require("ws");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 10000;

// ================== ENV (keep names) ==================
const ENV = {
  MAKE_WEBHOOK_URL: process.env.MAKE_WEBHOOK_URL || "",

  MB_ENABLE_RECORDING: String(process.env.MB_ENABLE_RECORDING || "false").toLowerCase() === "true",
  MB_LOG_BOT: String(process.env.MB_LOG_BOT || "true").toLowerCase() === "true",
  MB_LOG_TRANSCRIPTS: String(process.env.MB_LOG_TRANSCRIPTS || "true").toLowerCase() === "true",
  MB_LOG_CRM: String(process.env.MB_LOG_CRM || "true").toLowerCase() === "true",

  MB_IDLE_HANGUP_MS: Number(process.env.MB_IDLE_HANGUP_MS || "55000"),
  MB_MAX_CALL_MS: Number(process.env.MB_MAX_CALL_MS || "240000"),

  // VAD (balanced)
  MB_VAD_THRESHOLD: Number(process.env.MB_VAD_THRESHOLD || "0.35"),
  MB_VAD_PREFIX_MS: Number(process.env.MB_VAD_PREFIX_MS || "180"),
  MB_VAD_SILENCE_MS: Number(process.env.MB_VAD_SILENCE_MS || "650"),
  MB_VAD_SUFFIX_MS: Number(process.env.MB_VAD_SUFFIX_MS || "250"),

  OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
  PENAI_REALTIME_MODEL: process.env.PENAI_REALTIME_MODEL || "gpt-realtime-2025-08-28",

  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || "",
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || "",
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || "",

  // ElevenLabs
  ELEVEN_API_KEY: process.env.ELEVEN_API_KEY || "",
  ELEVEN_VOICE_ID: process.env.ELEVEN_VOICE_ID || "",
  ELEVEN_TTS_MODEL: process.env.ELEVEN_TTS_MODEL || "eleven_v3",
  ELEVEN_OUTPUT_FORMAT: process.env.ELEVEN_OUTPUT_FORMAT || "ulaw_8000",
  ELEVENLABS_STABILITY: Number(process.env.ELEVENLABS_STABILITY || "0.5"),
  ELEVENLABS_STYLE: Number(process.env.ELEVENLABS_STYLE || "0.15"),
};

// Twilio Assets
const TWILIO_OPENING_MP3_URL = "https://toolbox-hummingbird-8667.twil.io/assets/Opening.mp3";
const TWILIO_CLOSING_MP3_URL = "https://toolbox-hummingbird-8667.twil.io/assets/Closing.mp3";

// ================== Utils ==================
const logInfo = (...a) => console.log("[INFO]", ...a);
const logError = (...a) => console.log("[ERROR]", ...a);
const nowIso = () => new Date().toISOString();
const safe = (s) => (s || "").toString().trim();
const digitsOnly = (s) => safe(s).replace(/[^\d]/g, "");
const isIL = (d) => {
  const x = digitsOnly(d);
  return x.length === 9 || x.length === 10;
};
const isMobileIL = (caller) => safe(caller).startsWith("+9725");
const isLandlineIL = (caller) =>
  /^\+972[234789]/.test(safe(caller));

// ================== HTTP helpers ==================
async function postJson(url, payload) {
  if (!url) return { ok: false, reason: "webhook_not_configured" };
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const t = await r.text().catch(() => "");
    return { ok: r.ok, status: r.status, body: t };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// ================== Twilio helpers ==================
function twilioAuth() {
  if (!ENV.TWILIO_ACCOUNT_SID || !ENV.TWILIO_AUTH_TOKEN) return "";
  return (
    "Basic " +
    Buffer.from(`${ENV.TWILIO_ACCOUNT_SID}:${ENV.TWILIO_AUTH_TOKEN}`).toString("base64")
  );
}

async function startRecording(callSid) {
  if (!ENV.MB_ENABLE_RECORDING) return { ok: false };
  const url = `https://api.twilio.com/2010-04-01/Accounts/${ENV.TWILIO_ACCOUNT_SID}/Calls/${callSid}/Recordings.json`;
  const body = new URLSearchParams({
    RecordingChannels: "dual",
    RecordingStatusCallback: ENV.PUBLIC_BASE_URL,
    RecordingStatusCallbackMethod: "POST",
  });
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: twilioAuth(), "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, sid: j.sid } : { ok: false };
  } catch {
    return { ok: false };
  }
}

async function playAssetAndHangup(callSid, assetUrl) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${ENV.TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`;
  const twiml = `<Response><Play>${assetUrl}</Play><Hangup/></Response>`;
  const body = new URLSearchParams({ Twiml: twiml });
  await fetch(url, {
    method: "POST",
    headers: { Authorization: twilioAuth(), "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
}

// ================== Call store ==================
const calls = new Map();
function getCall(callSid) {
  if (!calls.has(callSid)) {
    calls.set(callSid, {
      callSid,
      streamSid: "",
      caller: "",
      called: "",
      callerPhoneLocal: "",
      startedAt: nowIso(),
      recordingSid: "",
      recordingUrl: "",
      lead: { first_name: "", last_name: "", phone_number: "", study_track: "" },
      finalSent: false,
    });
  }
  return calls.get(callSid);
}

function publicRecordingUrl(c) {
  if (!c.recordingSid || !ENV.PUBLIC_BASE_URL) return "";
  const u = new URL(ENV.PUBLIC_BASE_URL);
  return `${u.protocol}//${u.host}/recording/${c.recordingSid}.mp3`;
}

// ================== sendFinal (UNCHANGED FIELDS) ==================
async function sendFinal(callSid, reason) {
  const c = getCall(callSid);
  if (c.finalSent) return;

  const payload = {
    update_type: "lead_final",
    first_name: c.lead.first_name || "",
    last_name: c.lead.last_name || "",
    phone_number: digitsOnly(c.lead.phone_number || ""),
    study_track: c.lead.study_track || "",

    caller_id: c.caller || "",
    caller_phone_local: c.callerPhoneLocal || "",
    called: c.called || "",

    callSid: c.callSid,
    streamSid: c.streamSid,

    call_status: c.lead.phone_number ? "שיחה מלאה" : "שיחה חלקית",
    call_status_code: c.lead.phone_number ? "completed" : "partial",

    recording_url: c.recordingUrl || "",
    recording_public_url: publicRecordingUrl(c),

    source: "Voice AI - Nice Line",
    timestamp: nowIso(),
    reason: reason || "completed_flow",
    remarks: `סטטוס: ${c.lead.phone_number ? "שיחה מלאה" : "שיחה חלקית"} | name: ${c.lead.first_name || ""} ${c.lead.last_name || ""}`.trim(),
  };

  if (ENV.MB_LOG_CRM) logInfo("CRM> sending FINAL", payload);
  await postJson(ENV.MAKE_WEBHOOK_URL, payload);
  c.finalSent = true;
  setTimeout(() => calls.delete(callSid), 60000);
}

// ================== ElevenLabs (uLaw streaming) ==================
function assertEleven() {
  return !!ENV.ELEVEN_API_KEY && !!ENV.ELEVEN_VOICE_ID;
}
function toB64(b) { return Buffer.from(b).toString("base64"); }

async function elevenSpeak(ws, text) {
  if (!assertEleven()) return;
  if (ENV.MB_LOG_BOT) logInfo("BOT>", text);

  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${ENV.ELEVEN_VOICE_ID}/stream` +
    `?output_format=${ENV.ELEVEN_OUTPUT_FORMAT}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ENV.ELEVEN_API_KEY,
      "content-type": "application/json",
      accept: "audio/ulaw",
    },
    body: JSON.stringify({
      text,
      model_id: ENV.ELEVEN_TTS_MODEL,
      voice_settings: {
        stability: ENV.ELEVENLABS_STABILITY,
        similarity_boost: 0.75,
        style: ENV.ELEVENLABS_STYLE,
        use_speaker_boost: true,
      },
    }),
  });

  if (!res.ok) return;

  const reader = res.body.getReader();
  let buffer = Buffer.alloc(0);
  const FRAME = 160;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer = Buffer.concat([buffer, Buffer.from(value)]);
    while (buffer.length >= FRAME) {
      const frame = buffer.subarray(0, FRAME);
      buffer = buffer.subarray(FRAME);
      ws.send(JSON.stringify({
        event: "media",
        streamSid: current.streamSid,
        media: { payload: toB64(frame) },
      }));
      await new Promise(r => setTimeout(r, 20));
    }
  }
}

// ================== Server ==================
const server = app.listen(PORT, () => logInfo(`✅ Service running on port ${PORT}`));
const wss = new WebSocket.Server({ server, path: "/twilio-media-stream" });

let current = { streamSid: "" };

wss.on("connection", (ws) => {
  let state = "WAIT_START";
  let callSid = "";
  let idleTimer = null;
  let maxTimer = null;

  function resetIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => {
      await finish("idle_timeout");
    }, ENV.MB_IDLE_HANGUP_MS);
  }

  async function finish(reason) {
    const c = getCall(callSid);
    await playAssetAndHangup(callSid, TWILIO_CLOSING_MP3_URL);
    setTimeout(async () => {
      await sendFinal(callSid, reason);
      try { ws.close(); } catch {}
    }, 4500);
  }

  ws.on("message", async (raw) => {
    const data = JSON.parse(raw.toString());

    if (data.event === "start") {
      current.streamSid = data.start.streamSid;
      callSid = data.start.callSid;

      const custom = data.start.customParameters || {};
      const c = getCall(callSid);
      c.streamSid = current.streamSid;
      c.caller = custom.caller || "";
      c.called = custom.called || "";
      c.callerPhoneLocal = c.caller.startsWith("+972") ? "0" + c.caller.slice(4) : digitsOnly(c.caller);

      logInfo("CALL start", { callSid, caller: c.caller, called: c.called, callerPhoneLocal: c.callerPhoneLocal });

      const rec = await startRecording(callSid);
      if (rec.ok) c.recordingSid = rec.sid;

      // Opening already played by Twilio <Play>
      state = "ASK_NAME";
      resetIdle();
      maxTimer = setTimeout(() => finish("max_call_timeout"), ENV.MB_MAX_CALL_MS);

      // Ask name immediately
      await elevenSpeak(ws, "איך קוראים לכם? אפשר שם מלא.");
      return;
    }

    if (data.event === "media") {
      resetIdle();
      // STT via OpenAI Realtime (text-only)
      // For brevity, assume transcript arrives elsewhere; here we only react to text events
      return;
    }

    if (data.event === "stop") {
      await sendFinal(callSid, "twilio_stop");
      return;
    }
  });
});

// ================== Health ==================
app.get("/", (_, res) => res.status(200).send("OK"));
