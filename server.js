// server.js
//
// NiceLine / מרכז מל"מ – Voice AI
// Twilio Media Streams <-> OpenAI Realtime API (WS) on Render
//
// ✅ MODE: "HARD SCRIPT" (אנטי-קטיעות/רעשים)
// - אין שאלת הסכמה אחרי הפתיח.
// - תסריט קשיח: ASK_NAME -> CONFIRM_NAME -> CONFIRM_CALLER_LAST4 (או ASK_PHONE) -> DONE
// - בסטייטים של אישור: רק כן/לא. כל דבר אחר = חזרה קצרה על השאלה.
// - אם STT מזייף/רעש/קטיעה: לא עונים על "מחיר/מסלולים" וכו' — חוזרים לתסריט.
//
// ⚠️ ENV names unchanged. Webhook payload unchanged.

const express = require("express");
const WebSocket = require("ws");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 10000;

// -------------------- ENV (ONLY existing keys) --------------------
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

  // אצלכם זה PENAI_REALTIME_MODEL (ככה כתוב)
  PENAI_REALTIME_MODEL: process.env.PENAI_REALTIME_MODEL || "gpt-realtime-2025-08-28",

  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || "",

  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || "",
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || "",
  TIME_ZONE: process.env.TIME_ZONE || "Asia/Jerusalem",
};

const EFFECTIVE_SPEECH_SPEED = Math.max(
  1.08,
  Number.isFinite(ENV.MB_SPEECH_SPEED) ? ENV.MB_SPEECH_SPEED : 1.08
);

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

function isValidILPhoneDigits(d) {
  const x = digitsOnly(d);
  return x.length === 9 || x.length === 10;
}

function normalizeText(s) {
  return (s || "")
    .toString()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// זיהוי "כן/לא" גמיש
function detectYesNo(s) {
  const raw = safeStr(s);
  if (!raw) return null;

  const t = normalizeText(raw);
  if (!t) return null;

  const tokens = t.split(" ").filter(Boolean);

  const YES_SET = new Set([
    "כן",
    "בטח",
    "בסדר",
    "אוקיי",
    "אוקי",
    "ok",
    "okay",
    "yes",
    "נכון",
    "מאשר",
    "מאשרת",
    "סבבה",
    "יאללה",
  ]);

  const hasYes = tokens.some((w) => YES_SET.has(w));
  const hasNo = tokens.some((w) => w === "לא" || w === "no");

  const hasStrongNo =
    t.includes("לא רוצה") ||
    t.includes("לא מעוניין") ||
    t.includes("לא מעוניינת") ||
    t.includes("ממש לא") ||
    t === "עזוב" ||
    t === "עזבי";

  if ((hasYes && hasNo) || (hasYes && hasStrongNo)) return null;

  const short = tokens.length <= 4;

  if (hasStrongNo) return "no";
  if (hasNo && short) return "no";
  if (hasYes) return "yes";

  return null;
}

function isRefusal(text) {
  const t = normalizeText(text);
  return (
    t.includes("לא רוצה") ||
    t.includes("עזוב") ||
    t === "ביי" ||
    t.includes("תעזבו") ||
    t.includes("לא מעוניין") ||
    t.includes("לא מעוניינת") ||
    t === "לא"
  );
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

function digitsSpaced(d) {
  const x = digitsOnly(d);
  return x.split("").join(" ");
}

function last4Digits(d) {
  const x = digitsOnly(d);
  if (x.length < 4) return "";
  return x.slice(-4);
}

// ---------- Hebrew number-words -> digits parser ----------
const HEB_DIGIT_WORDS = new Map([
  ["אפס", "0"],
  ["אפסים", "0"],
  ["0", "0"],
  ["אחד", "1"],
  ["אחת", "1"],
  ["1", "1"],
  ["שתיים", "2"],
  ["שניים", "2"],
  ["שתים", "2"],
  ["2", "2"],
  ["שלוש", "3"],
  ["שלושה", "3"],
  ["3", "3"],
  ["ארבע", "4"],
  ["ארבעה", "4"],
  ["4", "4"],
  ["חמש", "5"],
  ["חמישה", "5"],
  ["5", "5"],
  ["שש", "6"],
  ["שישה", "6"],
  ["6", "6"],
  ["שבע", "7"],
  ["שבעה", "7"],
  ["7", "7"],
  ["שמונה", "8"],
  ["8", "8"],
  ["תשע", "9"],
  ["תשעה", "9"],
  ["9", "9"],
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

// -------------------- HARD-SCRIPT guards --------------------
const STT_GARBAGE_PHRASES = [
  "תמללו בעברית תקינה",
  "מספרי טלפון בישראל",
  "input_audio_transcription",
  "language",
  "prompt",
];

function isGarbageTranscript(text) {
  const t = (text || "").toString().trim();
  if (!t) return true;
  for (const p of STT_GARBAGE_PHRASES) {
    if (t.includes(p)) return true;
  }
  return false;
}

function isUnreliableYesNo(text) {
  // כשמצפים "כן/לא" — אם הגיע משפט ארוך/מורכב זה כמעט תמיד STT מזויף/קטיעה
  const t = normalizeText(text);
  if (!t) return true;
  const tokens = t.split(" ").filter(Boolean);
  if (tokens.length > 6) return true;
  if (t.length > 40) return true;
  return false;
}

function looksLikeQuestionOrDetails(text) {
  const t = normalizeText(text);
  if (!t) return false;
  return (
    t.includes("כמה") ||
    t.includes("מחיר") ||
    t.includes("עולה") ||
    t.includes("מסלול") ||
    t.includes("קורס") ||
    t.includes("מועד") ||
    t.includes("תוכן") ||
    t.includes("פרטים") ||
    t.includes("איפה") ||
    t.includes("מתי") ||
    t.includes("איך זה עובד")
  );
}

// ----- Name parsing -----
const NAME_TRASH = new Set([
  "הלו",
  "שלום",
  "היי",
  "כן",
  "לא",
  "אוקיי",
  "אוקי",
  "בסדר",
  "מי",
  "מה",
  "מה זה",
  "מי זה",
  "נו",
  "דבר",
  "לדבר",
  "תמשיך",
  "תמשיכו",
  "קדימה",
  "יאללה",
]);

function isTrashName(name) {
  const t = normalizeText(name);
  if (!t) return true;
  if (NAME_TRASH.has(t)) return true;
  if (t.length < 2) return true;
  if (t.split(" ").length > 5) return true;
  return false;
}

function cleanHebrewName(raw) {
  return (raw || "")
    .toString()
    .replace(/[0-9]/g, " ")
    .replace(/[^\p{L}\p{M}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseName(text) {
  const raw = cleanHebrewName(text);
  if (!raw) return null;
  if (isTrashName(raw)) return null;

  const parts = raw.split(" ").filter(Boolean);
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
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

// -------------------- Server + WS --------------------
const server = app.listen(PORT, () => {
  logInfo(`✅ Service running on port ${PORT}`);
});

const wss = new WebSocket.Server({ server, path: "/twilio-media-stream" });

wss.on("connection", (twilioWs) => {
  let streamSid = "";
  let callSid = "";
  let caller = "";
  let called = "";
  let callerPhoneLocal = "";
  let openingPlayedByTwilio = false;

  let idleWarnTimer = null;
  let idleHangTimer = null;
  let maxCallTimer = null;
  let maxCallWarnTimer = null;

  const STATES = {
    ASK_NAME: "ASK_NAME",
    CONFIRM_NAME: "CONFIRM_NAME",
    ASK_NAME_CORRECT: "ASK_NAME_CORRECT",
    CONFIRM_CALLER_LAST4: "CONFIRM_CALLER_LAST4",
    ASK_PHONE: "ASK_PHONE",
    CONFIRM_PHONE: "CONFIRM_PHONE",
    DONE: "DONE",
  };

  let state = STATES.ASK_NAME;

  const retries = {
    name: 0,
    nameConfirm: 0,
    phone: 0,
    confirmPhone: 0,
  };

  let pendingName = { first: "", last: "" };
  let pendingPhone = "";

  let gotTwilioStart = false;
  let gotOpenAI = false;
  let flowStarted = false;

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
        sayQueue("אתם איתנו? אפשר לענות רגע?");
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
        sayQueue("עוד רגע מסיימים—רק נשלים את הפרטים.");
        askCurrentQuestionQueued();
      }, warnAt);
    }
    if (ENV.MB_MAX_CALL_MS > 0) {
      maxCallTimer = setTimeout(async () => {
        await finishCall("max_call_timeout");
      }, ENV.MB_MAX_CALL_MS);
    }
  }

  // -------------------- OpenAI WS --------------------
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

  function botLog(text) {
    if (ENV.MB_LOG_BOT) logInfo("BOT>", text);
  }

  // ---------- Speech queue ----------
  let responseActive = false;
  const speechQueue = [];

  let endRequested = false;
  let endReason = "";
  let endAfterMs = 0;

  function tryDequeueSpeech() {
    if (!openaiReady) return;
    if (responseActive) return;

    if (speechQueue.length === 0) {
      if (endRequested) finalizeAndHangup(endReason).catch(() => {});
      return;
    }

    const nextText = speechQueue.shift();
    responseActive = true;
    createResponse(nextText);
  }

  function sayQueue(text) {
    const t = safeStr(text);
    if (!t) return;
    botLog(t);
    speechQueue.push(t);
    tryDequeueSpeech();
  }

  function createResponse(text) {
    sendOpenAI({
      type: "response.create",
      response: {
        instructions:
          `דברו בעברית תקינה, בלשון רבים בלבד.\n` +
          `טון אנושי, חברי וחם (לא רשמי מדי), קצר וברור.\n` +
          `קצב דיבור מהיר יחסית אבל ברור (סביב ${EFFECTIVE_SPEECH_SPEED}).\n` +
          `אם מקריאים מספרים/ספרות – להקריא ספרה-ספרה.\n\n` +
          `הטקסט להקראה (להגיד בדיוק):\n${text}`,
      },
    });
  }

  function askCurrentQuestionQueued() {
    if (state === STATES.ASK_NAME) {
      sayQueue("מה השם שלכם? שם פרטי ושם משפחה.");
      return;
    }
    if (state === STATES.CONFIRM_NAME) {
      const full = [pendingName.first, pendingName.last].filter(Boolean).join(" ");
      sayQueue(`רשמתי ${full}. נכון?`);
      return;
    }
    if (state === STATES.ASK_NAME_CORRECT) {
      sayQueue("איך נכון לרשום את השם? שם פרטי ושם משפחה.");
      return;
    }
    if (state === STATES.CONFIRM_CALLER_LAST4) {
      const last4 = last4Digits(callerPhoneLocal);
      if (last4) {
        sayQueue(`המספר לחזרה מסתיים ב-${digitsSpaced(last4)}. נכון?`);
      } else {
        state = STATES.ASK_PHONE;
        askCurrentQuestionQueued();
      }
      return;
    }
    if (state === STATES.ASK_PHONE) {
      sayQueue("מה מספר הטלפון לחזרה? תגידו ספרה-ספרה.");
      return;
    }
    if (state === STATES.CONFIRM_PHONE) {
      sayQueue(`המספר הוא ${digitsSpaced(pendingPhone)}. נכון?`);
      return;
    }
  }

  function maybeStartFlow() {
    if (flowStarted) return;
    if (!gotTwilioStart || !gotOpenAI) return;

    flowStarted = true;
    setTimeout(() => {
      logInfo("[FLOW] start -> ASK_NAME (proactive)");
      askCurrentQuestionQueued();
      armIdleTimers();
      armMaxCallTimers();
    }, 180);
  }

  function saveNameToLead(nameObj) {
    const c = getCall(callSid);
    c.lead.first_name = nameObj.first || "";
    c.lead.last_name = nameObj.last || "";
  }

  async function finishCall(reason, opts = {}) {
    if (!callSid) return;

    const skipClosing = !!opts.skipClosing;

    if (state !== STATES.DONE) {
      state = STATES.DONE;
      if (!skipClosing) {
        const closing =
          ENV.MB_CLOSING_TEXT ||
          "תודה רבה, הפרטים נרשמו. נציג המרכז יחזור אליכם בהקדם. יום טוב.";
        sayQueue(closing);
      }
    }

    endRequested = true;
    endReason = reason || "completed_flow";

    const minGrace = 6500;
    endAfterMs = Math.max(minGrace, ENV.MB_HANGUP_GRACE_MS || 0);

    tryDequeueSpeech();
  }

  async function finalizeAndHangup(reason) {
    if (!callSid) return;
    const c = getCall(callSid);
    if (c.finalTimer) return;

    c.finalTimer = setTimeout(async () => {
      await sendFinal(callSid, reason || "call_end");
      await hangupCall(callSid);
      try {
        openaiWs.close();
      } catch {}
      try {
        twilioWs.close();
      } catch {}
    }, endAfterMs);
  }

  function hardYesNoGate(userText) {
    // בסטייטים של אישור: אם לא כן/לא ברור — לא עושים שום דבר אחר.
    if (state === STATES.CONFIRM_NAME || state === STATES.CONFIRM_CALLER_LAST4 || state === STATES.CONFIRM_PHONE) {
      const yn = detectYesNo(userText);
      if (yn) return { ok: true, yn };
      // אם זה ארוך/מוזר => מבקשים שוב קצר
      if (isUnreliableYesNo(userText)) {
        sayQueue("לא שמעתי טוב. כן או לא?");
      } else {
        sayQueue("כן או לא?");
      }
      // חוזרים על אותה שאלה
      askCurrentQuestionQueued();
      return { ok: false, yn: null };
    }
    return { ok: true, yn: null };
  }

  function advanceAfter(userText) {
    const c = getCall(callSid);

    if (isGarbageTranscript(userText)) {
      if (ENV.MB_LOG_TRANSCRIPTS) logInfo("USER> (ignored garbage transcript)", userText);
      return;
    }

    addTranscriptMemory(callSid, userText);
    if (ENV.MB_LOG_TRANSCRIPTS) logInfo("USER>", userText);

    armIdleTimers();

    // סירוב ברור בכל שלב -> סוגרים יפה (זה כן חלק מהתסריט)
    if (isRefusal(userText)) {
      sayQueue("בסדר. תודה רבה ויום נעים.");
      finishCall("user_refused", { skipClosing: true }).catch(() => {});
      return;
    }

    // HARD gate לסטייטים של אישור
    const gate = hardYesNoGate(userText);
    if (!gate.ok) return;

    // אם המשתמש שואל פרטים/מחיר וכו' — לא עונים, רק חוזרים לתסריט (קצר)
    if (looksLikeQuestionOrDetails(userText)) {
      if (state === STATES.ASK_NAME || state === STATES.ASK_NAME_CORRECT) {
        sayQueue("רק לרישום קצר.");
        askCurrentQuestionQueued();
        return;
      }
      // אם הוא שאל בזמן אישור — ה-gate כבר טיפל בזה
    }

    // -------- FLOW --------
    if (state === STATES.ASK_NAME) {
      // אם אמר "כן/בסדר" אחרי פתיח — זה לא שם. חוזרים לשאלה.
      const yn = detectYesNo(userText);
      if (yn === "yes") {
        askCurrentQuestionQueued();
        return;
      }

      const t = normalizeText(userText);
      const tokens = t.split(" ").filter(Boolean);
      // משפט ארוך מדי = חשוד (קטיעה/רעש)
      if (tokens.length > 6 || t.length > 45) {
        sayQueue("לא שמעתי טוב.");
        askCurrentQuestionQueued();
        return;
      }

      const nameObj = parseName(userText);
      if (!nameObj || !nameObj.first) {
        retries.name += 1;
        if (retries.name >= 3) {
          sayQueue("לא הצלחתי לקלוט שם. יום נעים.");
          finishCall("name_missing", { skipClosing: true }).catch(() => {});
          return;
        }
        sayQueue("לא שמעתי טוב.");
        askCurrentQuestionQueued();
        return;
      }

      // חייבים וידוא שם תמיד
      pendingName = nameObj;
      state = STATES.CONFIRM_NAME;
      logInfo("[STATE] ASK_NAME -> CONFIRM_NAME", pendingName);
      askCurrentQuestionQueued();
      return;
    }

    if (state === STATES.CONFIRM_NAME) {
      const yn = gate.yn || detectYesNo(userText);

      if (yn === "yes") {
        saveNameToLead(pendingName);
        state = callerPhoneLocal ? STATES.CONFIRM_CALLER_LAST4 : STATES.ASK_PHONE;
        logInfo("[STATE] CONFIRM_NAME ->", state);
        askCurrentQuestionQueued();
        return;
      }

      if (yn === "no") {
        state = STATES.ASK_NAME_CORRECT;
        logInfo("[STATE] CONFIRM_NAME -> ASK_NAME_CORRECT");
        askCurrentQuestionQueued();
        return;
      }

      // לא אמור להגיע לכאן בגלל gate
      askCurrentQuestionQueued();
      return;
    }

    if (state === STATES.ASK_NAME_CORRECT) {
      const t = normalizeText(userText);
      const tokens = t.split(" ").filter(Boolean);
      if (tokens.length > 6 || t.length > 45) {
        sayQueue("לא שמעתי טוב.");
        askCurrentQuestionQueued();
        return;
      }

      const nameObj = parseName(userText);
      if (!nameObj || !nameObj.first) {
        retries.name += 1;
        if (retries.name >= 3) {
          sayQueue("לא הצלחתי לקלוט שם. יום נעים.");
          finishCall("name_missing", { skipClosing: true }).catch(() => {});
          return;
        }
        sayQueue("לא שמעתי טוב.");
        askCurrentQuestionQueued();
        return;
      }

      pendingName = nameObj;
      state = STATES.CONFIRM_NAME;
      logInfo("[STATE] ASK_NAME_CORRECT -> CONFIRM_NAME", pendingName);
      askCurrentQuestionQueued();
      return;
    }

    if (state === STATES.CONFIRM_CALLER_LAST4) {
      const yn = gate.yn || detectYesNo(userText);

      if (yn === "yes") {
        c.lead.phone_number = callerPhoneLocal;
        logInfo("[STATE] CONFIRM_CALLER_LAST4 -> DONE (use caller)", { phone_number: callerPhoneLocal });

        // אישור קצר כדי שהלקוח ישמע שזה נקלט
        sayQueue("רשמתי.");

        finishCall("completed_flow").catch(() => {});
        return;
      }

      if (yn === "no") {
        state = STATES.ASK_PHONE;
        logInfo("[STATE] CONFIRM_CALLER_LAST4 -> ASK_PHONE");
        askCurrentQuestionQueued();
        return;
      }

      // לא אמור להגיע לכאן בגלל gate
      askCurrentQuestionQueued();
      return;
    }

    if (state === STATES.ASK_PHONE) {
      const p = extractPhoneFromTranscript(userText);

      if (!p || !isValidILPhoneDigits(p)) {
        retries.phone += 1;
        if (retries.phone >= 3) {
          sayQueue("לא הצלחתי לקלוט מספר תקין. יום נעים.");
          finishCall("invalid_phone", { skipClosing: true }).catch(() => {});
          return;
        }
        sayQueue("לא שמעתי טוב.");
        askCurrentQuestionQueued();
        return;
      }

      pendingPhone = p;
      state = STATES.CONFIRM_PHONE;
      logInfo("[STATE] ASK_PHONE -> CONFIRM_PHONE", { pendingPhone });
      askCurrentQuestionQueued();
      return;
    }

    if (state === STATES.CONFIRM_PHONE) {
      const yn = gate.yn || detectYesNo(userText);

      if (yn === "yes") {
        c.lead.phone_number = pendingPhone;
        logInfo("[STATE] CONFIRM_PHONE -> DONE", { phone_number: pendingPhone });

        sayQueue("רשמתי.");

        finishCall("completed_flow").catch(() => {});
        return;
      }

      if (yn === "no") {
        state = STATES.ASK_PHONE;
        logInfo("[STATE] CONFIRM_PHONE -> ASK_PHONE");
        askCurrentQuestionQueued();
        return;
      }

      // לא אמור להגיע לכאן בגלל gate
      askCurrentQuestionQueued();
      return;
    }
  }

  // -------------------- OpenAI WS events --------------------
  openaiWs.on("open", () => {
    openaiReady = true;
    gotOpenAI = true;
    logInfo("OpenAI WS open");
    flushOpenAI();

    const systemPrompt = getSystemPromptFromMBConversationPrompt();

    sendOpenAI({
      type: "session.update",
      session: {
        instructions: systemPrompt || "",
        voice: ENV.OPENAI_VOICE,
        modalities: ["audio", "text"],
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
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
          prompt: "תמללו בעברית תקינה. מספרי טלפון בישראל מתחילים לרוב ב-0 (אפס).",
        },
      },
    });

    setTimeout(() => {
      state = STATES.ASK_NAME;
      logInfo("[STATE] ASK_NAME | proactive");
      maybeStartFlow();
    }, 80);
  });

  openaiWs.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    const isAudioDelta =
      (msg.type === "response.audio.delta" || msg.type === "response.output_audio.delta") && msg.delta && streamSid;

    if (isAudioDelta) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: msg.delta } }));
      return;
    }

    if (msg.type === "response.done") {
      responseActive = false;
      setTimeout(() => {
        tryDequeueSpeech();
      }, Math.max(0, ENV.MB_NO_BARGE_TAIL_MS || 0));
      return;
    }

    if (msg.type === "conversation.item.input_audio_transcription.completed") {
      const transcript = (msg.transcript || "").trim();
      if (!transcript) return;
      advanceAfter(transcript);
      return;
    }

    if (msg.type === "error") {
      logError("OpenAI error", msg);
      const code = msg?.error?.code || "";
      if (code === "conversation_already_has_active_response") {
        responseActive = false;
        setTimeout(() => tryDequeueSpeech(), 50);
      }
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

      gotTwilioStart = true;

      const c = getCall(callSid);
      c.streamSid = streamSid;
      c.caller = caller;
      c.called = called;
      c.callerPhoneLocal = callerPhoneLocal;
      c.meta.consent = "skipped";

      const rec = await startRecordingIfEnabled(callSid);
      logInfo("RECORDING>", rec);
      if (rec.ok) c.recordingSid = rec.sid || "";

      // אם אין MP3 — אפשר לפתוח ב-MB_OPENING_TEXT. אם יש MP3 בטוויליו — מתחילים מיד.
      if (!openingPlayedByTwilio && ENV.MB_OPENING_TEXT) {
        sayQueue(ENV.MB_OPENING_TEXT);
        setTimeout(() => {
          maybeStartFlow();
        }, 1200);
      } else {
        maybeStartFlow();
      }

      return;
    }

    if (data.event === "media") {
      const payload = data.media?.payload;
      if (!payload) return;
      sendOpenAI({ type: "input_audio_buffer.append", audio: payload });
      return;
    }

    if (data.event === "stop") {
      logInfo("Twilio stop", { streamSid, callSid });
      const c = getCall(callSid);
      c.endedAt = nowIso();
      clearTimers();

      if (!c.finalSent) {
        await sendFinal(callSid, "twilio_stop");
      }

      try {
        openaiWs.close();
      } catch {}
      return;
    }
  });

  twilioWs.on("close", async () => {
    clearTimers();
    if (callSid) {
      const c = getCall(callSid);
      if (!c.finalSent) {
        await sendFinal(callSid, "ws_close");
      }
    }
    try {
      openaiWs.close();
    } catch {}
  });

  twilioWs.on("error", (e) => logError("Twilio WS error", String(e?.message || e)));
});

// -------------------- Health --------------------
app.get("/", (req, res) => res.status(200).send("OK"));
