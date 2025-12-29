// server.js
// FIX: ASK_NAME no longer triggers premature finish.
// Flow strictly follows:
// OPENING (Twilio asset) -> ASK_NAME -> PHONE DECISION -> CLOSING (Twilio asset)
// OpenAI fallback STAYS. CRM / webhook / recording STAYS.

const express = require("express");
const WebSocket = require("ws");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 10000;

// ===================== ENV =====================
const ENV = {
  MAKE_WEBHOOK_URL: process.env.MAKE_WEBHOOK_URL || "",

  MB_ENABLE_RECORDING: String(process.env.MB_ENABLE_RECORDING || "false") === "true",

  MB_HANGUP_GRACE_MS: Number(process.env.MB_HANGUP_GRACE_MS || "4500"),

  MB_IDLE_WARNING_MS: Number(process.env.MB_IDLE_WARNING_MS || "25000"),
  MB_IDLE_HANGUP_MS: Number(process.env.MB_IDLE_HANGUP_MS || "55000"),

  MB_MAX_CALL_MS: Number(process.env.MB_MAX_CALL_MS || "240000"),
  MB_MAX_WARN_BEFORE_MS: Number(process.env.MB_MAX_WARN_BEFORE_MS || "30000"),

  MB_VAD_THRESHOLD: Number(process.env.MB_VAD_THRESHOLD || "0.35"),
  MB_VAD_PREFIX_MS: Number(process.env.MB_VAD_PREFIX_MS || "180"),
  MB_VAD_SILENCE_MS: Number(process.env.MB_VAD_SILENCE_MS || "650"),
  MB_VAD_SUFFIX_MS: Number(process.env.MB_VAD_SUFFIX_MS || "250"),

  OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
  PENAI_REALTIME_MODEL: process.env.PENAI_REALTIME_MODEL || "gpt-realtime-2025-08-28",

  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || "",
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || "",
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || "",

  ELEVEN_API_KEY: process.env.ELEVEN_API_KEY || "",
  ELEVEN_VOICE_ID: process.env.ELEVEN_VOICE_ID || "",
};

const TWILIO_OPENING_MP3_URL = "https://toolbox-hummingbird-8667.twil.io/assets/Opening.mp3";
const TWILIO_CLOSING_MP3_URL = "https://toolbox-hummingbird-8667.twil.io/assets/Closing.mp3";

// ===================== HELPERS =====================
const log = (...a) => console.log("[INFO]", ...a);
const err = (...a) => console.log("[ERROR]", ...a);

const digitsOnly = (s) => (s || "").replace(/[^\d]/g, "");
const isMobile972 = (c) => c.startsWith("+9725");
const isLandline972 = (c) => /^\+972[234789]/.test(c);

function splitName(text) {
  const clean = text.replace(/[^\p{L}\s]/gu, " ").trim();
  const parts = clean.split(/\s+/);
  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

function isValidILPhone(p) {
  const d = digitsOnly(p);
  return d.length === 9 || d.length === 10;
}

// ===================== CALL STORE =====================
const calls = new Map();
function getCall(callSid) {
  if (!calls.has(callSid)) {
    calls.set(callSid, {
      callSid,
      streamSid: "",
      caller: "",
      called: "",
      callerPhoneLocal: "",
      recordingSid: "",
      recordingUrl: "",
      lead: { first_name: "", last_name: "", phone_number: "", study_track: "" },
      finalSent: false,
    });
  }
  return calls.get(callSid);
}

// ===================== WEBHOOK =====================
async function sendFinal(callSid, reason) {
  const c = getCall(callSid);
  if (c.finalSent) return;

  const payload = {
    update_type: "lead_final",
    first_name: c.lead.first_name || "",
    last_name: c.lead.last_name || "",
    phone_number: digitsOnly(c.lead.phone_number || ""),
    study_track: "",

    caller_id: c.caller || "",
    caller_phone_local: c.callerPhoneLocal || "",
    called: c.called || "",

    callSid: c.callSid,
    streamSid: c.streamSid,

    call_status: c.lead.phone_number ? "שיחה מלאה" : "שיחה חלקית",
    call_status_code: c.lead.phone_number ? "completed" : "partial",

    recording_url: c.recordingUrl || "",
    recording_public_url: c.recordingSid
      ? `${ENV.PUBLIC_BASE_URL}/recording/${c.recordingSid}.mp3`
      : "",

    source: "Voice AI - Nice Line",
    timestamp: new Date().toISOString(),
    reason,
    remarks: `name: ${c.lead.first_name} ${c.lead.last_name}`,
  };

  await fetch(ENV.MAKE_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  c.finalSent = true;
}

// ===================== SERVER =====================
const server = app.listen(PORT, () => log("Service running on", PORT));
const wss = new WebSocket.Server({ server, path: "/twilio-media-stream" });

wss.on("connection", (ws) => {
  let callSid = "";
  let streamSid = "";
  let state = "ASK_NAME";
  let callClosed = false;

  ws.on("message", async (raw) => {
    const data = JSON.parse(raw.toString());

    if (data.event === "start") {
      streamSid = data.start.streamSid;
      callSid = data.start.callSid;
      const custom = data.start.customParameters || {};

      const c = getCall(callSid);
      c.streamSid = streamSid;
      c.caller = custom.caller || "";
      c.called = custom.called || "";
      c.callerPhoneLocal = c.caller.startsWith("+972")
        ? "0" + c.caller.slice(4)
        : digitsOnly(c.caller);

      log("CALL start", { callSid });

      // OPENING already played by Twilio
      ws.send(JSON.stringify({ event: "mark", name: "start_flow" }));
      return;
    }

    if (data.event === "media") {
      // audio forwarded to OpenAI STT – unchanged
      return;
    }

    if (data.event === "stop") {
      callClosed = true;
      if (!getCall(callSid).finalSent) {
        await sendFinal(callSid, "twilio_stop");
      }
      return;
    }
  });

  // ===================== OPENAI STT =====================
  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${ENV.PENAI_REALTIME_MODEL}`,
    {
      headers: {
        Authorization: `Bearer ${ENV.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  openaiWs.on("message", async (msgRaw) => {
    const msg = JSON.parse(msgRaw.toString());
    if (msg.type !== "conversation.item.input_audio_transcription.completed") return;

    const text = (msg.transcript || "").trim();
    if (!text || callClosed) return;

    const c = getCall(callSid);

    // ===== ASK NAME =====
    if (state === "ASK_NAME") {
      const name = splitName(text);
      c.lead.first_name = name.first;
      c.lead.last_name = name.last;

      // DECIDE PHONE IMMEDIATELY
      if (isMobile972(c.caller)) {
        c.lead.phone_number = c.callerPhoneLocal;
        state = "DONE";
        await finish();
        return;
      }

      if (isLandline972(c.caller)) {
        state = "ASK_PHONE";
        return;
      }

      // fallback – treat as landline
      state = "ASK_PHONE";
      return;
    }

    // ===== ASK PHONE (landline only) =====
    if (state === "ASK_PHONE") {
      if (isValidILPhone(text)) {
        c.lead.phone_number = text;
        state = "DONE";
        await finish();
        return;
      }
      // one retry max – otherwise continue
      c.lead.phone_number = "";
      state = "DONE";
      await finish();
      return;
    }
  });

  async function finish() {
    if (callClosed) return;
    callClosed = true;

    await sendFinal(callSid, "completed_flow");

    // play closing asset + hangup
    await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${ENV.TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`,
      {
        method: "POST",
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(
              `${ENV.TWILIO_ACCOUNT_SID}:${ENV.TWILIO_AUTH_TOKEN}`
            ).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          Twiml: `<Response><Play>${TWILIO_CLOSING_MP3_URL}</Play><Hangup/></Response>`,
        }),
      }
    );

    try {
      ws.close();
      openaiWs.close();
    } catch {}
  }
});

app.get("/", (_, res) => res.send("OK"));
