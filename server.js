// server.js
//
// NiceLine / מרכז מל"מ – Voice AI (Render-first, Scripted Flow)
// Twilio Media Streams <-> Render (this server)
//
// GOAL (per user):
// - Full scripted conversation is controlled ONLY from Render (including opening).
// - ElevenLabs is used for ALL bot speech (fast, deterministic).
// - OpenAI Realtime is used ONLY for STT (transcription) and as a SHORT fallback when caller goes off-script.
// - Webhook/CRM payload and recording behavior remain unchanged.
//
// Flow (strict):
//   OPENING (MB_OPENING_TEXT) -> ASK_NAME -> (AUTO PHONE LOGIC) -> ASK_PHONE -> CONFIRM_PHONE -> CLOSING -> hangup
//
// Notes:
// - We DO NOT ask for consent at all.
// - We keep the existing ENV names and CRM payload structure.

const express = require("express");
const WebSocket = require("ws");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 10000;

// -------------------- ENV (keep existing names; add Eleven-only without touching existing) --------------------
const ENV = {
  MAKE_WEBHOOK_URL: process.env.MAKE_WEBHOOK_URL || "",

  MB_ALLOW_BARGE_IN: String(process.env.MB_ALLOW_BARGE_IN || "false").toLowerCase() === "true",
  MB_CLOSING_TEXT: process.env.MB_CLOSING_TEXT || "",
  MB_OPENING_TEXT: process.env.MB_OPENING_TEXT || "",
  MB_CONVERSATION_PROMPT: process.env.MB_CONVERSATION_PROMPT || "",

  MB_DEBUG: String(process.env.MB_DEBUG || "false").toLowerCase() === "true",
  MB_ENABLE_RECORDING: String(process.env.MB_ENABLE_RECORDING || "false").toLowerCase() === "true",

  MB_HANGUP_GRACE_MS: Number(process.env.MB_HANGUP_GRACE_MS || "4500"),
  MB_IDLE_HANGUP_MS: Number(process.env.MB_IDLE_HANGUP_MS || "55000"),
  MB_IDLE_WARNING_MS: Number(process.env.MB_IDLE_WARNING_MS || "25000"),

  MB_LOG_BOT: String(process.env.MB_LOG_BOT || "true").toLowerCase() === "true",
  MB_LOG_CRM: String(process.env.MB_LOG_CRM || "true").toLowerCase() === "true",
  MB_LOG_TRANSCRIPTS: String(process.env.MB_LOG_TRANSCRIPTS || "true").toLowerCase() === "true",

  MB_MAX_CALL_MS: Number(process.env.MB_MAX_CALL_MS || "240000"),
  MB_MAX_WARN_BEFORE_MS: Number(process.env.MB_MAX_WARN_BEFORE_MS || "30000"),
  MB_NO_BARGE_TAIL_MS: Number(process.env.MB_NO_BARGE_TAIL_MS || "1600"),

  MB_SPEECH_SPEED: Number(process.env.MB_SPEECH_SPEED || "0.95"),
  MB_STT_LANGUAGE: process.env.MB_STT_LANGUAGE || "he",

  MB_VAD_PREFIX_MS: Number(process.env.MB_VAD_PREFIX_MS || "200"),
  MB_VAD_SILENCE_MS: Number(process.env.MB_VAD_SILENCE_MS || "900"),
  MB_VAD_SUFFIX_MS: Number(process.env.MB_VAD_SUFFIX_MS || "200"),
  MB_VAD_THRESHOLD: Number(process.env.MB_VAD_THRESHOLD || "0.65"),

  OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
  OPENAI_VOICE: process.env.OPENAI_VOICE || "cedar",
  // In your project this is spelled PENAI_REALTIME_MODEL (do not rename)
  PENAI_REALTIME_MODEL: process.env.PENAI_REALTIME_MODEL || "gpt-realtime-2025-08-28",

  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || "",

  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || "",
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || "",
  TIME_ZONE: process.env.TIME_ZONE || "Asia/Jerusalem",

  // ElevenLabs (already added in Render)
  ELEVEN_API_KEY: process.env.ELEVEN_API_KEY || "",
  ELEVEN_ENABLE_STREAM_ENDPOINT: String(process.env.ELEVEN_ENABLE_STREAM_ENDPOINT || "true").toLowerCase() === "true",
  ELEVEN_OUTPUT_FORMAT: process.env.ELEVEN_OUTPUT_FORMAT || "ulaw_8000",
  ELEVEN_TTS_MODEL: process.env.ELEVEN_TTS_MODEL || (process.env.ELEVENLABS_MODEL_ID || "eleven_v3"),
  ELEVEN_VOICE_ID: process.env.ELEVEN_VOICE_ID || "",
  ELEVENLABS_LANGUAGE: process.env.ELEVENLABS_LANGUAGE || "he",
  ELEVENLABS_STABILITY: Number(process.env.ELEVENLABS_STABILITY || "0.5"),
  ELEVENLABS_STYLE: Number(process.env.ELEVENLABS_STYLE || "0.15"),
};
// Twilio Assets (recorded audio) for instant start/end (no TTS latency)
const TWILIO_OPENING_MP3_URL = "https://toolbox-hummingbird-8667.twil.io/assets/opening.mp3";
const TWILIO_CLOSING_MP3_URL = "https://toolbox-hummingbird-8667.twil.io/assets/closing.mp3";

function logInfo(...args) {
  console.log("[INFO]", ...args);
}
function logError(...args) {
  console.log("[ERROR]", ...args);
}
function nowIso() {
  return new Date().toISOString();
}
function safeStr(s) {
  return (s || "").toString().trim();
}
function digitsOnly(s) {
  return (s || "").toString().replace(/[^\d]/g, "");
}
function normalizeText(s) {
  return (s || "")
    .toString()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
function isValidILPhoneDigits(d) {
  const x = digitsOnly(d);
  return x.length === 9 || x.length === 10;
}
function digitsSpaced(d) {
  const x = digitsOnly(d);
  return x.split("").join(" ");
}
function phoneForSpeech(d) {
  // ✅ change ONLY for readback quality: speak in groups (prevents missing digits in TTS)
  const x = digitsOnly(d);
  if (x.length === 10) return `${x.slice(0, 3)} ${x.slice(3, 6)} ${x.slice(6)}`; // 050 322 2237
  if (x.length === 9) return `${x.slice(0, 2)} ${x.slice(2, 5)} ${x.slice(5)}`;  // 03 123 4567
  return x;
}
function last4Digits(d) {
  const x = digitsOnly(d);
  if (x.length < 4) return "";
  return x.slice(-4);
}

// Yes/No detection (flexible)
function detectYesNo(s) {
  const raw = safeStr(s);
  if (!raw) return null;
  const t = normalizeText(raw);
  if (!t) return null;
  const tokens = t.split(" ").filter(Boolean);

  const YES_SET = new Set(["כן","בטח","בסדר","אוקיי","אוקי","ok","okay","yes","נכון","מאשר","מאשרת","סבבה","יאללה"]);
  const hasYes = tokens.some((w) => YES_SET.has(w));
  const hasNo = tokens.some((w) => w === "לא" || w === "no");

  const hasStrongNo = t.includes("לא רוצה") || t.includes("לא מעוניין") || t.includes("לא מעוניינת") || t.includes("ממש לא") || t === "עזוב" || t === "עזבי";
  const short = tokens.length <= 6;

  if (hasStrongNo) return "no";
  if (hasNo && short) return "no";
  if (hasYes) return "yes";
  return null;
}

function isRefusal(text) {
  const t = normalizeText(text);
  return t.includes("לא רוצה") || t === "ביי" || t.includes("לא מעוניין") || t.includes("לא מעוניינת") || t === "לא" || t === "עזוב" || t === "עזבי";
}

// -------------------- OpenAI prompt extraction --------------------
function getSystemPromptFromMBConversationPrompt() {
  const raw = ENV.MB_CONVERSATION_PROMPT || "";
  if (!raw.trim()) return "";
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj.system === "string" && obj.system.trim()) return obj.system.trim();
  } catch {}
  return raw.toString();
}

function openaiWsUrl() {
  const model = ENV.PENAI_REALTIME_MODEL || "gpt-realtime-2025-08-28";
  return `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
}

// -------------------- HTTP helpers --------------------
async function postJson(url, payload) {
  if (!url) return { ok: false, reason: "webhook_not_configured" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, body: text, reason: res.ok ? "make_ok" : "make_http_error" };
  } catch (e) {
    return { ok: false, reason: "make_fetch_error", error: String(e?.message || e) };
  }
}

// -------------------- Twilio REST helpers --------------------
function twilioAuthHeader() {
  if (!ENV.TWILIO_ACCOUNT_SID || !ENV.TWILIO_AUTH_TOKEN) return "";
  const b64 = Buffer.from(`${ENV.TWILIO_ACCOUNT_SID}:${ENV.TWILIO_AUTH_TOKEN}`).toString("base64");
  return `Basic ${b64}`;
}

async function startRecordingIfEnabled(callSid) {
  if (!ENV.MB_ENABLE_RECORDING) return { ok: false, reason: "recording_disabled" };
  if (!ENV.TWILIO_ACCOUNT_SID || !ENV.TWILIO_AUTH_TOKEN || !ENV.PUBLIC_BASE_URL) {
    return { ok: false, reason: "recording_env_missing" };
  }

  const cbUrl = ENV.PUBLIC_BASE_URL;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${ENV.TWILIO_ACCOUNT_SID}/Calls/${callSid}/Recordings.json`;
  const body = new URLSearchParams({
    RecordingStatusCallback: cbUrl,
    RecordingStatusCallbackMethod: "POST",
    RecordingChannels: "dual",
  });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: twilioAuthHeader(), "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: "recording_start_failed", status: res.status, body: json };
    return { ok: true, reason: "recording_started", sid: json.sid || "" };
  } catch (e) {
    return { ok: false, reason: "recording_start_error", error: String(e?.message || e) };
  }
}

async function hangupCall(callSid) {
  if (!ENV.TWILIO_ACCOUNT_SID || !ENV.TWILIO_AUTH_TOKEN) return { ok: false, reason: "twilio_auth_missing" };

  const url = `https://api.twilio.com/2010-04-01/Accounts/${ENV.TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`;
  const body = new URLSearchParams({ Status: "completed" });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: twilioAuthHeader(), "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const text = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, body: text, reason: res.ok ? "hangup_ok" : "hangup_http_error" };
  } catch (e) {
    return { ok: false, reason: "hangup_error", error: String(e?.message || e) };
  }
}

async function playTwilioAsset(callSid, assetUrl) {
  if (!ENV.TWILIO_ACCOUNT_SID || !ENV.TWILIO_AUTH_TOKEN) return { ok: false, reason: "twilio_auth_missing" };
  if (!callSid || !assetUrl) return { ok: false, reason: "missing_params" };

  const url = `https://api.twilio.com/2010-04-01/Accounts/${ENV.TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`;
  const twiml = `<Response><Play>${assetUrl}</Play><Hangup/></Response>`;
  const body = new URLSearchParams({ Twiml: twiml });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: twilioAuthHeader(), "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const text = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, body: text, reason: res.ok ? "twiml_redirect_ok" : "twiml_redirect_http_error" };
  } catch (e) {
    return { ok: false, reason: "twiml_redirect_error", error: String(e?.message || e) };
  }
}

// -------------------- Recording callback --------------------
app.post("/twilio-recording-callback", async (req, res) => {
  const callSid = req.body?.CallSid || "";
  const recordingUrl = req.body?.RecordingUrl || "";
  const recordingSid = req.body?.RecordingSid || "";

  logInfo("RECORDING callback", { callSid, recordingUrl, recordingSid });

  if (callSid) {
    const c = getCall(callSid);
    if (recordingSid) c.recordingSid = recordingSid;
    if (recordingUrl) c.recordingUrl = recordingUrl;
  }

  res.status(200).send("OK");
});

// -------------------- Public recording proxy --------------------
app.get("/recording/:sid.mp3", async (req, res) => {
  try {
    const sid = (req.params?.sid || "").trim();
    if (!sid) return res.status(400).send("missing sid");
    if (!ENV.TWILIO_ACCOUNT_SID || !ENV.TWILIO_AUTH_TOKEN) return res.status(500).send("twilio auth missing");

    const url = `https://api.twilio.com/2010-04-01/Accounts/${ENV.TWILIO_ACCOUNT_SID}/Recordings/${sid}.mp3`;
    const r = await fetch(url, { headers: { Authorization: twilioAuthHeader() } });

    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return res.status(r.status).send(t || "failed to fetch");
    }

    res.setHeader("Content-Type", "audio/mpeg");
    const buf = Buffer.from(await r.arrayBuffer());
    res.status(200).send(buf);
  } catch (e) {
    res.status(500).send(String(e?.message || e));
  }
});

// -------------------- Call store --------------------
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
      endedAt: "",
      recordingSid: "",
      recordingUrl: "",
      lead: { first_name: "", last_name: "", phone_number: "", study_track: "" },
      meta: { consent: "skipped" },
      memory: { transcripts: [] },
      finalSent: false,
      finalTimer: null,
    });
  }
  return calls.get(callSid);
}

function addTranscriptMemory(callSid, text) {
  const c = getCall(callSid);
  const now = Date.now();
  c.memory.transcripts.push({ ts: now, text: safeStr(text) });
  const cutoff = now - 50_000;
  c.memory.transcripts = c.memory.transcripts.filter((x) => x.ts >= cutoff && x.text);
}

function computeStatus(lead) {
  const ok = !!safeStr(lead.first_name) && !!safeStr(lead.phone_number) && isValidILPhoneDigits(lead.phone_number);
  return ok ? { code: "completed", label: "שיחה מלאה" } : { code: "partial", label: "שיחה חלקית" };
}

function getPublicOrigin() {
  try {
    if (!ENV.PUBLIC_BASE_URL) return "";
    const u = new URL(ENV.PUBLIC_BASE_URL);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

// -------------------- Final send --------------------
async function waitForRecording(callSid, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const c = getCall(callSid);
    if (c.recordingUrl || c.recordingSid) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function sendFinal(callSid, reason) {
  const c = getCall(callSid);
  if (c.finalSent) return;

  if (ENV.MB_ENABLE_RECORDING) {
    await waitForRecording(callSid, 8000);
  }

  const status = computeStatus(c.lead);
  const origin = getPublicOrigin();
  const publicRecording = c.recordingSid && origin ? `${origin}/recording/${c.recordingSid}.mp3` : "";

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

    call_status: status.label,
    call_status_code: status.code,

    recording_url: c.recordingUrl || "",
    recording_public_url: publicRecording || "",

    source: "Voice AI - Nice Line",
    timestamp: nowIso(),
    reason: reason || "call_end",
    remarks: `סטטוס: ${status.label} | consent: ${c.meta.consent || "skipped"} | name: ${c.lead.first_name || ""} ${c.lead.last_name || ""}`.trim(),
  };

  if (ENV.MB_LOG_CRM) logInfo("CRM> sending FINAL", payload);
  const r = await postJson(ENV.MAKE_WEBHOOK_URL, payload);
  if (ENV.MB_LOG_CRM) logInfo("CRM> final result", r);

  c.finalSent = true;
  setTimeout(() => calls.delete(callSid), 60_000);
}

// -------------------- ElevenLabs TTS --------------------
function assertElevenConfigured() {
  return !!ENV.ELEVEN_API_KEY && !!ENV.ELEVEN_VOICE_ID;
}

function toBase64(buf) {
  return Buffer.from(buf).toString("base64");
}

async function elevenStreamUlaw(text, onAudioChunk) {
  const voiceId = ENV.ELEVEN_VOICE_ID;
  const outputFormat = ENV.ELEVEN_OUTPUT_FORMAT || "ulaw_8000";
  const modelId = ENV.ELEVEN_TTS_MODEL || "eleven_v3";

  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream` +
    `?output_format=${encodeURIComponent(outputFormat)}`;

  const payload = {
    text,
    model_id: modelId,
    voice_settings: {
      stability: Number.isFinite(ENV.ELEVENLABS_STABILITY) ? ENV.ELEVENLABS_STABILITY : 0.5,
      similarity_boost: 0.75,
      style: Number.isFinite(ENV.ELEVENLABS_STYLE) ? ENV.ELEVENLABS_STYLE : 0.15,
      use_speaker_boost: true,
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ENV.ELEVEN_API_KEY,
      "content-type": "application/json",
      accept: "audio/ulaw",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Eleven stream failed (${res.status}): ${t || "no body"}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("Eleven stream missing body reader");

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value && value.byteLength) {
      await onAudioChunk(value);
    }
  }
}

// -------------------- OpenAI fallback --------------------
async function openaiFallbackReply({ userText, state, question }) {
  if (!ENV.OPENAI_API_KEY) {
    return question || "אפשר לחזור רגע—מה השם המלא שלכם?";
  }

  const sys =
    "אתם עוזרים טלפוניים קצרים בעברית. " +
    "מותר לכם להגיד משפט אחד בלבד. " +
    "אסור לדבר על מסלולי לימוד/קורסים. " +
    "אסור לשאול שאלות חדשות. " +
    "המטרה היחידה: להחזיר את המשתמש לשאלה הנוכחית בצורה מנומסת וקצרה.";

  const user =
    `המשתמש אמר: "${safeStr(userText)}"\n` +
    `הסטייט הנוכחי: ${state}\n` +
    `השאלה שצריך לחזור אליה עכשיו: "${question}"\n` +
    "תנו משפט אחד בלבד שמחזיר לשאלה.";

  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ENV.OPENAI_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
        max_output_tokens: 80,
      }),
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error?.message || "fallback_http_error");

    const out = (json.output_text || "").toString().trim();
    if (out) return out.slice(0, 240);

    const alt = JSON.stringify(json);
    return alt ? question : question;
  } catch (e) {
    return question || "אפשר לענות רגע על השאלה?";
  }
}

// -------------------- Server + WS --------------------
const server = app.listen(PORT, () => {
  logInfo(`✅ Service running on port ${PORT}`);
});

const wss = new WebSocket.Server({ server, path: "/twilio-media-stream" });

wss.on("connection", (twilioWs) => {
  logInfo("Twilio WS client connected");

  let streamSid = "";
  let callSid = "";
  let caller = "";
  let called = "";
  let callerPhoneLocal = "";
  let openingPlayedByTwilio = false;

  const STATES = {
    OPENING: "OPENING",
    ASK_NAME: "ASK_NAME",
    ASK_PHONE: "ASK_PHONE",
    CONFIRM_PHONE: "CONFIRM_PHONE",
    DONE: "DONE",
  };

  let state = STATES.OPENING;
  let callClosed = false;
  let retries = { name: 0, phone: 0, confirmPhone: 0, offscript: 0 };

  let pendingName = { first: "", last: "" };
  let pendingPhone = "";

  let idleWarnTimer = null;
  let idleHangTimer = null;
  let maxCallTimer = null;
  let maxCallWarnTimer = null;

  function clearTimers() {
    if (idleWarnTimer) clearTimeout(idleWarnTimer);
    if (idleHangTimer) clearTimeout(idleHangTimer);
    if (maxCallTimer) clearTimeout(maxCallTimer);
    if (maxCallWarnTimer) clearTimeout(maxCallWarnTimer);
    idleWarnTimer = idleHangTimer = maxCallTimer = maxCallWarnTimer = null;
  }

  function armIdleTimers() {
    if (ENV.MB_IDLE_WARNING_MS > 0) {
      if (idleWarnTimer) clearTimeout(idleWarnTimer);
      idleWarnTimer = setTimeout(() => {
        sayQueue("אפשר לענות רגע?");
        askCurrentQuestionQueued();
      }, ENV.MB_IDLE_WARNING_MS);
    }
    if (ENV.MB_IDLE_HANGUP_MS > 0) {
      if (idleHangTimer) clearTimeout(idleHangTimer);
      idleHangTimer = setTimeout(async () => {
        await finishCall("idle_timeout");
      }, ENV.MB_IDLE_HANGUP_MS);
    }
  }

  function armMaxCallTimers() {
    if (ENV.MB_MAX_CALL_MS > 0 && ENV.MB_MAX_WARN_BEFORE_MS > 0) {
      const warnAt = Math.max(0, ENV.MB_MAX_CALL_MS - ENV.MB_MAX_WARN_BEFORE_MS);
      maxCallWarnTimer = setTimeout(() => {
        if (callClosed) return;
        sayQueue("עוד רגע מסיימים.");
        askCurrentQuestionQueued();
      }, warnAt);
    }
    if (ENV.MB_MAX_CALL_MS > 0) {
      maxCallTimer = setTimeout(async () => {
        if (callClosed) return;
        await finishCall("max_call_timeout");
      }, ENV.MB_MAX_CALL_MS);
    }
  }

  // -------------------- BOT Speech Queue --------------------
  let ttsActive = false;
  const speechQueue = [];

  let endRequested = false;
  let endReason = "";
  let endAfterMs = 0;

  function botLog(text) {
    if (ENV.MB_LOG_BOT) logInfo("BOT>", text);
  }

  function sendTwilioUlawFrame(frameBytes) {
    if (!streamSid) return;
    const payload = toBase64(frameBytes);
    twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload } }));
  }

  const ULaw_FRAME_BYTES = 160;
  let ulawOutQueue = [];
  let ulawOutBuffer = Buffer.alloc(0);
  let ulawOutTimer = null;

  function startUlawPump() {
    if (ulawOutTimer) return;
    ulawOutTimer = setInterval(() => {
      try {
        if (!streamSid) return;
        if (ulawOutQueue.length === 0) {
          clearInterval(ulawOutTimer);
          ulawOutTimer = null;
          return;
        }
        const frame = ulawOutQueue.shift();
        sendTwilioUlawFrame(frame);
      } catch (e) {
        logError("uLaw pump error", String(e?.message || e));
      }
    }, 20);
  }

  function enqueueUlawBytes(chunkBytes) {
    ulawOutBuffer = Buffer.concat([ulawOutBuffer, Buffer.from(chunkBytes)]);
    while (ulawOutBuffer.length >= ULaw_FRAME_BYTES) {
      const frame = ulawOutBuffer.subarray(0, ULaw_FRAME_BYTES);
      ulawOutQueue.push(Uint8Array.from(frame));
      ulawOutBuffer = ulawOutBuffer.subarray(ULaw_FRAME_BYTES);
    }
    startUlawPump();
  }

  async function speakWithEleven(text) {
    if (!assertElevenConfigured()) {
      logError("Eleven not configured (missing ELEVEN_API_KEY/ELEVEN_VOICE_ID)");
      return;
    }
    await elevenStreamUlaw(text, async (chunk) => {
      enqueueUlawBytes(chunk);
    });
  }

  async function tryDequeueSpeech() {
    if (ttsActive) return;

    if (speechQueue.length === 0) {
      if (endRequested) {
        finalizeAndHangup(endReason).catch(() => {});
      }
      return;
    }

    ttsActive = true;
    const nextText = speechQueue.shift();

    try {
      await speakWithEleven(nextText);
    } catch (e) {
      logError("Eleven speak error", String(e?.message || e));
    } finally {
      ttsActive = false;
      setTimeout(() => {
        tryDequeueSpeech().catch(() => {});
      }, Math.max(0, ENV.MB_NO_BARGE_TAIL_MS || 0));
    }
  }

  function sayQueue(text) {
    if (callClosed) return;
    const t = safeStr(text);
    if (!t) return;
    botLog(t);
    speechQueue.push(t);
    tryDequeueSpeech().catch(() => {});
  }

  // -------------------- FLOW Questions --------------------
  function askCurrentQuestionQueued() {
    if (callClosed) return;
    if (state === STATES.ASK_NAME) {
      sayQueue("מה השם המלא שלכם?");
      return;
    }
    if (state === STATES.ASK_PHONE) {
      sayQueue("מה מספר הטלפון לחזרה?");
      return;
    }
    if (state === STATES.CONFIRM_PHONE) {
      // ✅ change ONLY: read phone in grouped format (not digit-by-digit)
      sayQueue(`המספר הוא ${phoneForSpeech(pendingPhone)}. נכון?`);
      return;
    }
  }

  function startFlowProactively() {
    logInfo("[FLOW] opening -> ASK_NAME (proactive)");
    state = STATES.ASK_NAME;
    askCurrentQuestionQueued();
    armIdleTimers();
    armMaxCallTimers();
  }

  // -------------------- Name + phone parsing --------------------
  function cleanHebrewName(raw) {
    return (raw || "")
      .toString()
      .replace(/[0-9]/g, " ")
      .replace(/[^\p{L}\p{M}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  const NAME_TRASH = new Set(["הלו","שלום","היי","כן","לא","אוקיי","אוקי","בסדר","נו","דבר","תמשיך","קדימה","יאללה"]);

  function parseName(text) {
    const raw = cleanHebrewName(text);
    if (!raw) return null;
    const t = normalizeText(raw);
    if (!t) return null;
    if (NAME_TRASH.has(t)) return null;

    const parts = raw.split(" ").filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length > 6) return null;

    if (parts.length === 1) return { first: parts[0], last: "" };
    return { first: parts[0], last: parts.slice(1).join(" ") };
  }

  const HEB_DIGIT_WORDS = new Map([
    ["אפס","0"],["0","0"],
    ["אחד","1"],["אחת","1"],["1","1"],
    ["שתיים","2"],["שניים","2"],["שתים","2"],["2","2"],
    ["שלוש","3"],["שלושה","3"],["3","3"],
    ["ארבע","4"],["ארבעה","4"],["4","4"],
    ["חמש","5"],["חמישה","5"],["5","5"],
    ["שש","6"],["שישה","6"],["6","6"],
    ["שבע","7"],["שבעה","7"],["7","7"],
    ["שמונה","8"],["8","8"],
    ["תשע","9"],["תשעה","9"],["9","9"],
  ]);

  function extractPhoneFromTranscript(text) {
    const direct = digitsOnly(text);
    if (direct.length >= 9 && direct.length <= 10) return direct;

    const tokens = normalizeText(text).split(" ").filter(Boolean);
    const digits = [];
    for (const tok of tokens) {
      if (HEB_DIGIT_WORDS.has(tok)) digits.push(HEB_DIGIT_WORDS.get(tok));
    }
    const joined = digits.join("");
    if (joined.length >= 9 && joined.length <= 10) return joined;
    return "";
  }

  // -------------------- Caller type logic --------------------
  function isMobileCallerE164(e164) {
    const s = safeStr(e164);
    return s.startsWith("+9725");
  }
  function isLandlineCallerE164(e164) {
    const s = safeStr(e164);
    return (
      s.startsWith("+9722") ||
      s.startsWith("+9723") ||
      s.startsWith("+9724") ||
      s.startsWith("+9727") ||
      s.startsWith("+9728") ||
      s.startsWith("+9729")
    );
  }

  // -------------------- Fallback trigger --------------------
  function looksOffScript(userText) {
    const t = normalizeText(userText);
    if (!t) return false;
    return (
      t.includes("מסלולי") ||
      t.includes("לימוד") ||
      t.includes("קורס") ||
      t.includes("למה") ||
      t.includes("מה זה") ||
      t.includes("תסביר") ||
      t.includes("מי אתם") ||
      t.includes("מה אתם") ||
      t.length > 22
    );
  }

  async function handleOffScript(userText) {
    retries.offscript += 1;
    const questionTextForState = (() => {
      if (state === STATES.ASK_NAME) return "מה השם המלא שלכם?";
      if (state === STATES.ASK_PHONE) return "מה מספר הטלפון לחזרה?";
      if (state === STATES.CONFIRM_PHONE) return `המספר הוא ${phoneForSpeech(pendingPhone)}. נכון?`; // ✅ grouped
      return "אפשר לענות רגע?";
    })();

    const fb = await openaiFallbackReply({ userText, state, question: questionTextForState });
    sayQueue(fb);
    setTimeout(() => askCurrentQuestionQueued(), 250);
  }

  // -------------------- End / Closing --------------------
  async function finishCall(reason, opts = {}) {
    if (!callSid) return;
    callClosed = true;
    clearTimers();
    const skipClosing = !!opts.skipClosing;

    if (!skipClosing) {
      state = STATES.DONE;

      const r = await playTwilioAsset(callSid, TWILIO_CLOSING_MP3_URL);
      if (!r.ok) {
        const closing =
          ENV.MB_CLOSING_TEXT ||
          "תודה רבה, הפרטים נרשמו. נציג המרכז יחזור אליכם בהקדם. יום טוב.";
        sayQueue(closing);

        endRequested = true;
        endReason = reason || "completed_flow";
        const minGrace = 6500;
        endAfterMs = Math.max(minGrace, ENV.MB_HANGUP_GRACE_MS || 0);
        tryDequeueSpeech().catch(() => {});
        return;
      }

      setTimeout(async () => {
        try {
          await sendFinal(callSid, reason || "completed_flow");
        } catch {}
        try { twilioWs.close(); } catch {}
      }, 4500);

      return;
    }

    if (state !== STATES.DONE) state = STATES.DONE;

    endRequested = true;
    endReason = reason || "completed_flow";
    const minGrace = 6500;
    endAfterMs = Math.max(minGrace, ENV.MB_HANGUP_GRACE_MS || 0);

    tryDequeueSpeech().catch(() => {});
  }

  async function finalizeAndHangup(reason) {
    if (!callSid) return;
    const c = getCall(callSid);
    if (c.finalTimer) return;

    c.finalTimer = setTimeout(async () => {
      await sendFinal(callSid, reason || "call_end");
      await hangupCall(callSid);
      try { openaiWs.close(); } catch {}
      try { twilioWs.close(); } catch {}
    }, endAfterMs);
  }

  // -------------------- OpenAI Realtime (STT-only) --------------------
  const openaiWs = new WebSocket(openaiWsUrl(), {
    headers: {
      Authorization: `Bearer ${ENV.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  let openaiReady = false;
  const openaiQueue = [];

  function sendOpenAI(obj) {
    const msg = JSON.stringify(obj);
    if (!openaiReady) {
      openaiQueue.push(msg);
      return;
    }
    openaiWs.send(msg);
  }

  function flushOpenAI() {
    while (openaiQueue.length) openaiWs.send(openaiQueue.shift());
  }

  openaiWs.on("open", () => {
    openaiReady = true;
    logInfo("OpenAI WS open");
    flushOpenAI();

    const systemPrompt = getSystemPromptFromMBConversationPrompt();

    sendOpenAI({
      type: "session.update",
      session: {
        instructions: systemPrompt || "",
        modalities: ["text"],
        input_audio_format: "g711_ulaw",
        turn_detection: {
          type: "server_vad",
          create_response: false,
          threshold: ENV.MB_VAD_THRESHOLD,
          prefix_padding_ms: ENV.MB_VAD_PREFIX_MS,
          silence_duration_ms: ENV.MB_VAD_SILENCE_MS,
        },
        input_audio_transcription: {
          model: "gpt-4o-mini-transcribe",
          language: ENV.MB_STT_LANGUAGE,
          prompt: "תמללו בעברית תקינה. שמות בעברית. מספרי טלפון בישראל מתחילים ב-0.",
        },
      },
    });
  });

  openaiWs.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === "conversation.item.input_audio_transcription.completed") {
      const transcript = (msg.transcript || "").trim();
      if (!transcript) return;

      addTranscriptMemory(callSid, transcript);
      if (ENV.MB_LOG_TRANSCRIPTS) logInfo("USER>", transcript);

      armIdleTimers();

      if (isRefusal(transcript)) {
        sayQueue("בסדר. תודה ויום נעים.");
        await finishCall("user_refused", { skipClosing: true });
        return;
      }

      if (state === STATES.OPENING) {
        return;
      }

      if (looksOffScript(transcript)) {
        await handleOffScript(transcript);
        return;
      }

      if (state === STATES.ASK_NAME) {
        const yn = detectYesNo(transcript);
        if (yn === "yes") {
          askCurrentQuestionQueued();
          return;
        }

        const nameObj = parseName(transcript);
        if (!nameObj) {
          retries.name += 1;
          if (retries.name >= 3) {
            sayQueue("לא הצלחתי לקלוט שם. תודה ויום נעים.");
            await finishCall("name_missing", { skipClosing: true });
            return;
          }
          sayQueue("לא שמעתי טוב. מה השם המלא שלכם?");
          return;
        }

        pendingName = nameObj;
        const c = getCall(callSid);
        c.lead.first_name = pendingName.first || "";
        c.lead.last_name = pendingName.last || "";

        if (caller && isMobileCallerE164(caller) && callerPhoneLocal) {
          c.lead.phone_number = callerPhoneLocal;
          logInfo("[STATE] ASK_NAME -> DONE (mobile caller, use caller)", { phone_number: callerPhoneLocal, name: pendingName });
          await finishCall("completed_flow");
          return;
        }

        state = STATES.ASK_PHONE;
        logInfo("[STATE] ASK_NAME -> ASK_PHONE", { caller });
        askCurrentQuestionQueued();
        return;
      }

      if (state === STATES.ASK_PHONE) {
        const p = extractPhoneFromTranscript(transcript);
        if (!p || !isValidILPhoneDigits(p)) {
          retries.phone += 1;
          if (retries.phone >= 3) {
            sayQueue("לא הצלחתי לקלוט מספר תקין. תודה ויום נעים.");
            await finishCall("invalid_phone", { skipClosing: true });
            return;
          }
          sayQueue("לא קלטתי. אפשר לחזור על מספר הטלפון לחזרה?");
          return;
        }

        pendingPhone = p;
        state = STATES.CONFIRM_PHONE;
        logInfo("[STATE] ASK_PHONE -> CONFIRM_PHONE", { pendingPhone });
        askCurrentQuestionQueued();
        return;
      }

      if (state === STATES.CONFIRM_PHONE) {
        const yn = detectYesNo(transcript);
        if (yn === "yes") {
          const c = getCall(callSid);
          c.lead.phone_number = pendingPhone;
          logInfo("[STATE] CONFIRM_PHONE -> DONE", { phone_number: pendingPhone });
          await finishCall("completed_flow");
          return;
        }
        if (yn === "no") {
          state = STATES.ASK_PHONE;
          logInfo("[STATE] CONFIRM_PHONE -> ASK_PHONE (retry)");
          sayQueue("אוקיי. תגידו שוב את המספר.");
          return;
        }

        const p = extractPhoneFromTranscript(transcript);
        if (p && isValidILPhoneDigits(p)) {
          pendingPhone = p;
          askCurrentQuestionQueued();
          return;
        }

        sayQueue("כן או לא?");
        return;
      }
    }

    if (msg.type === "error") {
      logError("OpenAI error", msg);
      return;
    }
  });

  openaiWs.on("close", () => logInfo("OpenAI WS closed"));
  openaiWs.on("error", (e) => logError("OpenAI WS error", String(e?.message || e)));

  // -------------------- Twilio stream events --------------------
  twilioWs.on("message", async (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (data.event === "start") {
      streamSid = data.start?.streamSid || "";
      callSid = data.start?.callSid || "";
      const custom = data.start?.customParameters || {};

      caller = custom.caller || "";
      called = custom.called || "";
      openingPlayedByTwilio = String(custom.opening_played || "") === "1";

      callerPhoneLocal = (caller || "").startsWith("+972") ? "0" + caller.slice(4) : digitsOnly(caller);

      logInfo("CALL start", { streamSid, callSid, caller, called, callerPhoneLocal });

      const c = getCall(callSid);
      c.streamSid = streamSid;
      c.caller = caller;
      c.called = called;
      c.callerPhoneLocal = callerPhoneLocal;
      c.meta.consent = "skipped";

      const rec = await startRecordingIfEnabled(callSid);
      logInfo("RECORDING>", rec);
      if (rec.ok) c.recordingSid = rec.sid || "";

      if (openingPlayedByTwilio) {
        state = STATES.ASK_NAME;
        callClosed = false;
        logInfo("[FLOW] start -> ASK_NAME (opening already played by Twilio)");
        setTimeout(() => startFlowProactively(), 0);
      } else {
        state = STATES.OPENING;
        if (ENV.MB_OPENING_TEXT) {
          sayQueue(ENV.MB_OPENING_TEXT);
        } else {
          sayQueue("שלום. אני נטע ממערכת הרישום של מרכז מל\"מ.");
        }
        setTimeout(() => startFlowProactively(), 0);
      }

      armIdleTimers();
      armMaxCallTimers();
      return;
    }

    if (data.event === "media") {
      const payload = data.media?.payload;
      if (!payload) return;
      sendOpenAI({ type: "input_audio_buffer.append", audio: payload });
      return;
    }

    if (data.event === "stop") {
      callClosed = true;
      logInfo("Twilio stop", { streamSid, callSid });
      const c = getCall(callSid);
      c.endedAt = nowIso();
      clearTimers();

      if (!c.finalSent) {
        await sendFinal(callSid, "twilio_stop");
      }

      try { openaiWs.close(); } catch {}
      return;
    }
  });

  twilioWs.on("close", async () => {
    callClosed = true;
    clearTimers();
    if (callSid) {
      const c = getCall(callSid);
      if (!c.finalSent) {
        await sendFinal(callSid, "ws_close");
      }
    }
    try { openaiWs.close(); } catch {}
  });

  twilioWs.on("error", (e) => logError("Twilio WS error", String(e?.message || e)));
});

// -------------------- Health --------------------
app.get("/", (req, res) => res.status(200).send("OK"));
