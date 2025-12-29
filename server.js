// server.js
//
// NiceLine / מרכז מל"מ – Voice AI (FINAL – FIXED)
// =================================================
// ✔ ממשיך מיד אחרי קליטת שם
// ✔ אין וידוא שם
// ✔ מעבר אוטומטי לטלפון
// ✔ נייד = סגירה מיידית
// ✔ נייח = בקשת טלפון לחזרה (ניסיון אחד)
// ✔ פתיח וסגיר רק מהקלטות Twilio
// ✔ אין לופים / אין עצירות
// ✔ webhook / CRM / recording – לא נוגעים
// =================================================

const express = require("express");
const WebSocket = require("ws");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ================= ENV =================
const ENV = {
  MAKE_WEBHOOK_URL: process.env.MAKE_WEBHOOK_URL || "",
  MB_IDLE_HANGUP_MS: Number(process.env.MB_IDLE_HANGUP_MS || 55000),
  MB_MAX_CALL_MS: Number(process.env.MB_MAX_CALL_MS || 240000),

  MB_VAD_THRESHOLD: Number(process.env.MB_VAD_THRESHOLD || 0.35),
  MB_VAD_PREFIX_MS: Number(process.env.MB_VAD_PREFIX_MS || 180),
  MB_VAD_SILENCE_MS: Number(process.env.MB_VAD_SILENCE_MS || 650),
  MB_VAD_SUFFIX_MS: Number(process.env.MB_VAD_SUFFIX_MS || 250),

  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,

  ELEVEN_API_KEY: process.env.ELEVEN_API_KEY,
  ELEVEN_VOICE_ID: process.env.ELEVEN_VOICE_ID,
  ELEVEN_TTS_MODEL: process.env.ELEVEN_TTS_MODEL || "eleven_v3",
};

const OPENING_MP3 = "https://toolbox-hummingbird-8667.twil.io/assets/Opening.mp3";
const CLOSING_MP3 = "https://toolbox-hummingbird-8667.twil.io/assets/Closing.mp3";

// ================= UTILS =================
const log = (...a) => console.log("[INFO]", ...a);
const digits = (s) => (s || "").replace(/\D/g, "");
const isMobile = (c) => c.startsWith("+9725");
const isLandline = (c) => /^\+972[234789]/.test(c);
const validIL = (n) => {
  const d = digits(n);
  return d.length === 9 || d.length === 10;
};

// ================= CALL STORE =================
const calls = new Map();
function call(callSid) {
  if (!calls.has(callSid)) {
    calls.set(callSid, {
      callSid,
      streamSid: "",
      caller: "",
      called: "",
      callerPhoneLocal: "",
      lead: { first_name: "", last_name: "", phone_number: "" },
      recordingSid: "",
      finalSent: false,
    });
  }
  return calls.get(callSid);
}

// ================= TWILIO =================
function auth() {
  return (
    "Basic " +
    Buffer.from(
      `${ENV.TWILIO_ACCOUNT_SID}:${ENV.TWILIO_AUTH_TOKEN}`
    ).toString("base64")
  );
}

async function playAndHangup(callSid, url) {
  const body = new URLSearchParams({
    Twiml: `<Response><Play>${url}</Play><Hangup/></Response>`,
  });
  await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${ENV.TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`,
    {
      method: "POST",
      headers: {
        Authorization: auth(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    }
  );
}

// ================= CRM =================
async function sendFinal(callSid, reason) {
  const c = call(callSid);
  if (c.finalSent) return;

  const payload = {
    update_type: "lead_final",
    first_name: c.lead.first_name || "",
    last_name: c.lead.last_name || "",
    phone_number: digits(c.lead.phone_number || ""),
    study_track: "",

    caller_id: c.caller,
    caller_phone_local: c.callerPhoneLocal,
    called: c.called,
    callSid: c.callSid,
    streamSid: c.streamSid,

    call_status: c.lead.phone_number ? "שיחה מלאה" : "שיחה חלקית",
    call_status_code: c.lead.phone_number ? "completed" : "partial",

    recording_url: "",
    recording_public_url: c.recordingSid
      ? `${ENV.PUBLIC_BASE_URL}/recording/${c.recordingSid}.mp3`
      : "",

    source: "Voice AI - Nice Line",
    timestamp: new Date().toISOString(),
    reason,
    remarks: `סטטוס: ${
      c.lead.phone_number ? "שיחה מלאה" : "שיחה חלקית"
    } | name: ${c.lead.first_name} ${c.lead.last_name}`,
  };

  await fetch(ENV.MAKE_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  c.finalSent = true;
  setTimeout(() => calls.delete(callSid), 60000);
}

// ================= ELEVEN =================
async function speak(ws, text) {
  log("BOT>", text);

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ENV.ELEVEN_VOICE_ID}/stream`,
    {
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
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.2,
          use_speaker_boost: true,
        },
      }),
    }
  );

  if (!res.ok) return;

  const reader = res.body.getReader();
  let buf = Buffer.alloc(0);
  const FRAME = 160;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf = Buffer.concat([buf, Buffer.from(value)]);
    while (buf.length >= FRAME) {
      ws.send(
        JSON.stringify({
          event: "media",
          streamSid: current.streamSid,
          media: { payload: buf.subarray(0, FRAME).toString("base64") },
        })
      );
      buf = buf.subarray(FRAME);
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

// ================= SERVER =================
const server = app.listen(PORT, () =>
  log(`✅ Service running on port ${PORT}`)
);
const wss = new WebSocket.Server({ server, path: "/twilio-media-stream" });

let current = { streamSid: "" };

wss.on("connection", (ws) => {
  let state = "ASK_NAME";
  let callSid = "";
  let retryPhone = false;

  ws.on("message", async (raw) => {
    const data = JSON.parse(raw.toString());

    if (data.event === "start") {
      callSid = data.start.callSid;
      current.streamSid = data.start.streamSid;

      const c = call(callSid);
      c.streamSid = current.streamSid;
      c.caller = data.start.customParameters.caller || "";
      c.called = data.start.customParameters.called || "";
      c.callerPhoneLocal = c.caller.startsWith("+972")
        ? "0" + c.caller.slice(4)
        : digits(c.caller);

      log("CALL start", {
        callSid,
        caller: c.caller,
        called: c.called,
        callerPhoneLocal: c.callerPhoneLocal,
      });

      await speak(ws, "איך קוראים לכם? אפשר שם מלא.");
      return;
    }

    if (data.event !== "text") return;
    const text = data.text.trim();
    const c = call(callSid);

    // ===== NAME =====
    if (state === "ASK_NAME") {
      const parts = text.split(/\s+/);
      c.lead.first_name = parts[0] || "";
      c.lead.last_name = parts.slice(1).join(" ");
      state = "PHONE";

      if (isMobile(c.caller)) {
        c.lead.phone_number = c.callerPhoneLocal;
        await playAndHangup(callSid, CLOSING_MP3);
        setTimeout(() => sendFinal(callSid, "completed_flow"), 4000);
        ws.close();
        return;
      }

      await speak(
        ws,
        "המספר שממנו התקשרתם הוא קווי. אפשר מספר טלפון לחזרה?"
      );
      return;
    }

    // ===== PHONE =====
    if (state === "PHONE") {
      if (validIL(text)) {
        c.lead.phone_number = digits(text);
        await playAndHangup(callSid, CLOSING_MP3);
        setTimeout(() => sendFinal(callSid, "completed_flow"), 4000);
        ws.close();
        return;
      }

      if (!retryPhone) {
        retryPhone = true;
        await speak(ws, "לא הצלחתי לקלוט. אפשר מספר טלפון לחזרה?");
        return;
      }

      await playAndHangup(callSid, CLOSING_MP3);
      setTimeout(() => sendFinal(callSid, "completed_flow"), 4000);
      ws.close();
    }
  });

  ws.on("close", async () => {
    if (callSid) await sendFinal(callSid, "twilio_stop");
  });
});

// ================= HEALTH =================
app.get("/", (_, res) => res.send("OK"));
