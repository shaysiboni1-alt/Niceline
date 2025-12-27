// server.js
// NiceLine / מרכז מל"מ – Voice AI – Render
// FIXES:
// - No more reading style-instructions aloud (only speak the actual line).
// - Opening moved to Render (recorded + same voice).
// - Strong "NO NIKKUD" rule.
// - Small name cleanup (remove trailing punctuation).
// - recording_url fallback from recordingSid (protected), plus public URL.

const express = require("express");
const WebSocket = require("ws");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 10000;

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
  PENAI_REALTIME_MODEL: process.env.PENAI_REALTIME_MODEL || "gpt-realtime-2025-08-28",

  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || "",

  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || "",
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || "",
  TIME_ZONE: process.env.TIME_ZONE || "Asia/Jerusalem",
};

function logInfo(...args) { console.log("[INFO]", ...args); }
function logError(...args) { console.log("[ERROR]", ...args); }
function dbg(...args) { if (ENV.MB_DEBUG) console.log("[DEBUG]", ...args); }
function nowIso() { return new Date().toISOString(); }

function safeStr(s) { return (s || "").toString().trim(); }
function digitsOnly(s) { return (s || "").toString().replace(/[^\d]/g, ""); }

function stripNikud(s) {
  // Hebrew diacritics range
  return (s || "").toString().replace(/[\u0591-\u05C7]/g, "");
}

function normalizeText(s) {
  return (s || "")
    .toString()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function detectYesNo(s) {
  const t = normalizeText(s);
  if (!t) return null;
  const yes = ["כן", "בטח", "בסדר", "אוקיי", "אוקי", "ok", "okay", "yes", "נכון"];
  const no = ["לא", "ממש לא", "לא רוצה", "no", "nope", "לא נכון"];
  if (yes.some((w) => t === w || t.startsWith(w) || t.includes(` ${w} `))) return "yes";
  if (no.some((w) => t === w || t.startsWith(w) || t.includes(` ${w} `))) return "no";
  return null;
}

function isRefusal(text) {
  const t = normalizeText(text);
  return t.includes("לא רוצה") || t.includes("עזוב") || t === "ביי" || t.includes("לא מעוניין");
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
function isValidILPhoneDigits(d) {
  const x = digitsOnly(d);
  return x.length === 9 || x.length === 10;
}

const HEB_DIGIT_WORDS = new Map([
  ["אפס", "0"], ["0", "0"],
  ["אחד", "1"], ["אחת", "1"], ["1", "1"],
  ["שתיים", "2"], ["שניים", "2"], ["שתים", "2"], ["2", "2"],
  ["שלוש", "3"], ["שלושה", "3"], ["3", "3"],
  ["ארבע", "4"], ["ארבעה", "4"], ["4", "4"],
  ["חמש", "5"], ["חמישה", "5"], ["5", "5"],
  ["שש", "6"], ["שישה", "6"], ["6", "6"],
  ["שבע", "7"], ["שבעה", "7"], ["7", "7"],
  ["שמונה", "8"], ["8", "8"],
  ["תשע", "9"], ["תשעה", "9"], ["9", "9"],
]);

function extractPhoneFromTranscript(text) {
  const direct = digitsOnly(text);
  if (direct.length >= 9 && direct.length <= 10) return direct;

  const tokens = normalizeText(text).split(" ").filter(Boolean);
  const digits = [];
  for (const tok of tokens) {
    if (HEB_DIGIT_WORDS.has(tok)) digits.push(HEB_DIGIT_WORDS.get(tok));
    else {
      const parts = tok.split(/[-_]/g).filter(Boolean);
      for (const p of parts) {
        if (HEB_DIGIT_WORDS.has(p)) digits.push(HEB_DIGIT_WORDS.get(p));
      }
    }
  }
  const joined = digits.join("");
  if (joined.length >= 9 && joined.length <= 10) return joined;

  if (joined.length > 10) {
    for (let i = 0; i <= joined.length - 10; i++) {
      const sub = joined.slice(i, i + 10);
      if (sub.startsWith("0")) return sub;
    }
    for (let i = 0; i <= joined.length - 9; i++) {
      const sub = joined.slice(i, i + 9);
      if (sub.startsWith("0")) return sub;
    }
  }
  return "";
}

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

function getPublicOrigin() {
  try {
    if (!ENV.PUBLIC_BASE_URL) return "";
    const u = new URL(ENV.PUBLIC_BASE_URL);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

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
      meta: { consent: "" },
      finalSent: false,
      finalTimer: null,
    });
  }
  return calls.get(callSid);
}

function computeStatus(lead, consent) {
  const ok = consent === "yes" && !!safeStr(lead.first_name) && isValidILPhoneDigits(lead.phone_number);
  return ok ? { code: "completed", label: "שיחה מלאה" } : { code: "partial", label: "שיחה חלקית" };
}

app.post("/twilio-recording-callback", async (req, res) => {
  const callSid = req.body?.CallSid || "";
  const recordingUrl = req.body?.RecordingUrl || "";
  const recordingSid = req.body?.RecordingSid || "";
  logInfo("RECORDING callback", { callSid, recordingUrl, recordingSid });

  if (callSid) {
    const c = getCall(callSid);
    if (recordingSid) c.recordingSid = recordingSid;
    if (recordingUrl) c.recordingUrl = recordingUrl;

    if (c.finalSent && (recordingUrl || recordingSid)) {
      const origin = getPublicOrigin();
      const publicRecording = recordingSid && origin ? `${origin}/recording/${recordingSid}.mp3` : "";

      const payload = {
        update_type: "recording_update",
        callSid: c.callSid,
        streamSid: c.streamSid,
        caller_id: c.caller || "",
        called: c.called || "",
        recording_url: recordingUrl || "",
        recording_public_url: publicRecording || "",
        timestamp: nowIso(),
      };
      const r = await postJson(ENV.MAKE_WEBHOOK_URL, payload);
      if (ENV.MB_LOG_CRM) logInfo("CRM> recording update result", r);
    }
  }

  res.status(200).send("OK");
});

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

  const status = computeStatus(c.lead, c.meta.consent);
  const origin = getPublicOrigin();
  const publicRecording = c.recordingSid && origin ? `${origin}/recording/${c.recordingSid}.mp3` : "";

  // fallback internal protected mp3 url if Twilio callback hasn't arrived yet
  const protectedMp3 =
    c.recordingSid && ENV.TWILIO_ACCOUNT_SID
      ? `https://api.twilio.com/2010-04-01/Accounts/${ENV.TWILIO_ACCOUNT_SID}/Recordings/${c.recordingSid}.mp3`
      : "";

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

    recording_url: c.recordingUrl || protectedMp3 || "",
    recording_public_url: publicRecording || "",

    source: "Voice AI - Nice Line",
    timestamp: nowIso(),
    reason: reason || "call_end",
    remarks: `סטטוס: ${status.label} | consent: ${c.meta.consent || ""} | name: ${c.lead.first_name || ""} ${c.lead.last_name || ""}`.trim(),
  };

  if (ENV.MB_LOG_CRM) logInfo("CRM> sending FINAL", payload);
  const r = await postJson(ENV.MAKE_WEBHOOK_URL, payload);
  if (ENV.MB_LOG_CRM) logInfo("CRM> final result", r);

  c.finalSent = true;
  setTimeout(() => calls.delete(callSid), 60_000);
}

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

  const STATES = {
    ASK_CONSENT: "ASK_CONSENT",
    ASK_NAME: "ASK_NAME",
    CONFIRM_NAME: "CONFIRM_NAME",
    ASK_NAME_CORRECT: "ASK_NAME_CORRECT",
    CONFIRM_CALLER_LAST4: "CONFIRM_CALLER_LAST4",
    ASK_PHONE: "ASK_PHONE",
    CONFIRM_PHONE: "CONFIRM_PHONE",
    DONE: "DONE",
  };
  let state = STATES.ASK_CONSENT;

  const retries = { consent: 0, name: 0, nameConfirm: 0, phone: 0, confirmPhone: 0 };
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
        sayQueue("רק לוודא שאתם איתנו. אשמח שתענו בבקשה.");
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
        sayQueue("לפני שנסיים, אשמח רק להשלים את הפרטים כדי שיועץ יחזור אליכם.");
        askCurrentQuestionQueued();
      }, warnAt);
    }
    if (ENV.MB_MAX_CALL_MS > 0) {
      maxCallTimer = setTimeout(async () => {
        await finishCall("max_call_timeout");
      }, ENV.MB_MAX_CALL_MS);
    }
  }

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
    if (!openaiReady) { openaiQueue.push(msg); return; }
    openaiWs.send(msg);
  }
  function flushOpenAI() { while (openaiQueue.length) openaiWs.send(openaiQueue.shift()); }

  function botLog(text) { if (ENV.MB_LOG_BOT) logInfo("BOT>", text); }

  // ---- speech queue ----
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
    const t = safeStr(stripNikud(text));
    if (!t) return;
    botLog(t);
    speechQueue.push(t);
    tryDequeueSpeech();
  }

  // ✅ IMPORTANT FIX: response.create gets ONLY the line to speak
  function createResponse(text) {
    sendOpenAI({
      type: "response.create",
      response: {
        instructions: text,
      },
    });
  }

  function askCurrentQuestionQueued() {
    if (state === STATES.ASK_CONSENT) {
      sayQueue("זה בסדר מבחינתכם?");
      return;
    }
    if (state === STATES.ASK_NAME) {
      sayQueue("מצוין. איך קוראים לכם? אפשר שם פרטי ושם משפחה.");
      return;
    }
    if (state === STATES.CONFIRM_NAME) {
      const full = [pendingName.first, pendingName.last].filter(Boolean).join(" ");
      sayQueue(`רשמתי את השם: ${full}. זה נכון?`);
      return;
    }
    if (state === STATES.ASK_NAME_CORRECT) {
      sayQueue("מעולה, איך נכון לרשום את השם? אפשר לומר שוב שם פרטי ושם משפחה.");
      return;
    }
    if (state === STATES.CONFIRM_CALLER_LAST4) {
      const last4 = last4Digits(callerPhoneLocal);
      if (last4) {
        sayQueue(`אני רואה שהשיחה הגיעה ממספר שמסתיים ב-${digitsSpaced(last4)}. זה המספר הנכון לחזור אליכם?`);
      } else {
        state = STATES.ASK_PHONE;
        askCurrentQuestionQueued();
      }
      return;
    }
    if (state === STATES.ASK_PHONE) {
      sayQueue("אשמח אם תגידו לי את מספר הטלפון המלא לחזרה. אנא אמרו ספרה-ספרה, רק מספרים.");
      return;
    }
    if (state === STATES.CONFIRM_PHONE) {
      sayQueue(`רק לוודא — המספר הוא ${digitsSpaced(pendingPhone)}. נכון?`);
      return;
    }
  }

  // ---- name parsing ----
  const NAME_TRASH = new Set(["הלו","שלום","היי","כן","לא","אוקיי","אוקי","בסדר","מי זה","מה זה"]);
  function isTrashName(name) {
    const t = normalizeText(name);
    if (!t) return true;
    if (NAME_TRASH.has(t)) return true;
    if (t.length < 2) return true;
    return false;
  }

  function cleanWord(w) {
    return (w || "").replace(/[.,!?;:"'׳״]+$/g, "").trim();
  }

  function parseName(text) {
    const raw = safeStr(text).replace(/[0-9]/g, "").replace(/\s+/g, " ").trim();
    if (!raw) return null;
    if (isTrashName(raw)) return null;

    const parts = raw.split(" ").map(cleanWord).filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length === 1) return { first: parts[0], last: "" };
    return { first: parts[0], last: parts.slice(1).join(" ") };
  }

  function saveNameToLead(nameObj) {
    const c = getCall(callSid);
    c.lead.first_name = nameObj.first || "";
    c.lead.last_name = nameObj.last || "";
  }

  async function finishCall(reason) {
    if (!callSid) return;

    if (state !== STATES.DONE) {
      state = STATES.DONE;
      const closing =
        ENV.MB_CLOSING_TEXT ||
        "תודה רבה, הפרטים נשמרו. נציג המרכז יחזור אליכם בהקדם. יום טוב.";
      sayQueue(closing);
    }

    endRequested = true;
    endReason = reason || "completed_flow";

    const minGrace = 7000;
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
      try { openaiWs.close(); } catch {}
      try { twilioWs.close(); } catch {}
    }, endAfterMs);
  }

  function advanceAfter(userText) {
    const c = getCall(callSid);
    if (ENV.MB_LOG_TRANSCRIPTS) logInfo("USER>", userText);

    armIdleTimers();

    if (isRefusal(userText)) {
      c.meta.consent = "no";
      sayQueue("בסדר גמור, תודה רבה ויום נעים.");
      finishCall("user_refused").catch(() => {});
      return;
    }

    if (state === STATES.ASK_CONSENT) {
      const yn = detectYesNo(userText);
      if (yn === "yes") {
        c.meta.consent = "yes";
        state = STATES.ASK_NAME;
        logInfo("[STATE] ASK_CONSENT -> ASK_NAME");
        askCurrentQuestionQueued();
        return;
      }
      if (yn === "no") {
        c.meta.consent = "no";
        sayQueue("בסדר גמור, תודה רבה ויום נעים.");
        finishCall("consent_no").catch(() => {});
        return;
      }
      if (retries.consent >= 1) {
        sayQueue("בסדר גמור, תודה רבה ויום נעים.");
        finishCall("consent_unclear").catch(() => {});
        return;
      }
      retries.consent += 1;
      askCurrentQuestionQueued();
      return;
    }

    if (state === STATES.ASK_NAME) {
      const nameObj = parseName(userText);
      if (!nameObj) {
        if (retries.name >= 1) {
          state = callerPhoneLocal ? STATES.CONFIRM_CALLER_LAST4 : STATES.ASK_PHONE;
          logInfo("[STATE] ASK_NAME -> (no name) ->", state);
          askCurrentQuestionQueued();
          return;
        }
        retries.name += 1;
        sayQueue("סליחה, חשוב לי לרשום את השם נכון. תוכלו לומר שם פרטי ושם משפחה?");
        return;
      }
      pendingName = nameObj;
      state = STATES.CONFIRM_NAME;
      logInfo("[STATE] ASK_NAME -> CONFIRM_NAME", pendingName);
      askCurrentQuestionQueued();
      return;
    }

    if (state === STATES.CONFIRM_NAME) {
      const yn = detectYesNo(userText);
      if (yn === "yes") {
        saveNameToLead(pendingName);
        state = callerPhoneLocal ? STATES.CONFIRM_CALLER_LAST4 : STATES.ASK_PHONE;
        logInfo("[STATE] CONFIRM_NAME ->", state);
        askCurrentQuestionQueued();
        return;
      }
      if (yn === "no") {
        if (retries.nameConfirm >= 1) {
          state = callerPhoneLocal ? STATES.CONFIRM_CALLER_LAST4 : STATES.ASK_PHONE;
          logInfo("[STATE] CONFIRM_NAME -> (unclear) ->", state);
          askCurrentQuestionQueued();
          return;
        }
        retries.nameConfirm += 1;
        state = STATES.ASK_NAME_CORRECT;
        logInfo("[STATE] CONFIRM_NAME -> ASK_NAME_CORRECT");
        askCurrentQuestionQueued();
        return;
      }
      const nameObj = parseName(userText);
      if (nameObj) {
        pendingName = nameObj;
        askCurrentQuestionQueued();
        return;
      }
      sayQueue("רק כן או לא בבקשה. זה השם הנכון?");
      return;
    }

    if (state === STATES.ASK_NAME_CORRECT) {
      const nameObj = parseName(userText);
      if (!nameObj) {
        sayQueue("סליחה, לא הצלחתי להבין. תוכלו לומר שוב שם פרטי ושם משפחה?");
        return;
      }
      pendingName = nameObj;
      state = STATES.CONFIRM_NAME;
      logInfo("[STATE] ASK_NAME_CORRECT -> CONFIRM_NAME", pendingName);
      askCurrentQuestionQueued();
      return;
    }

    if (state === STATES.CONFIRM_CALLER_LAST4) {
      const yn = detectYesNo(userText);
      if (yn === "yes") {
        c.lead.phone_number = callerPhoneLocal;
        logInfo("[STATE] CONFIRM_CALLER_LAST4 -> DONE (use caller)", { phone_number: callerPhoneLocal });
        finishCall("completed_flow").catch(() => {});
        return;
      }
      if (yn === "no") {
        state = STATES.ASK_PHONE;
        logInfo("[STATE] CONFIRM_CALLER_LAST4 -> ASK_PHONE");
        askCurrentQuestionQueued();
        return;
      }
      const p = extractPhoneFromTranscript(userText);
      if (p) {
        pendingPhone = p;
        state = STATES.CONFIRM_PHONE;
        logInfo("[STATE] CONFIRM_CALLER_LAST4 -> CONFIRM_PHONE", { pendingPhone });
        askCurrentQuestionQueued();
        return;
      }
      askCurrentQuestionQueued();
      return;
    }

    if (state === STATES.ASK_PHONE) {
      const p = extractPhoneFromTranscript(userText);
      if (!p || !isValidILPhoneDigits(p)) {
        if (retries.phone >= 1) {
          finishCall("invalid_phone").catch(() => {});
          return;
        }
        retries.phone += 1;
        sayQueue("לצורך חזרה אני צריך מספר תקין בין תשע לעשר ספרות. אנא אמרו ספרה-ספרה, רק מספרים.");
        return;
      }
      pendingPhone = p;
      state = STATES.CONFIRM_PHONE;
      logInfo("[STATE] ASK_PHONE -> CONFIRM_PHONE", { pendingPhone });
      askCurrentQuestionQueued();
      return;
    }

    if (state === STATES.CONFIRM_PHONE) {
      const yn = detectYesNo(userText);
      if (yn === "yes") {
        c.lead.phone_number = pendingPhone;
        logInfo("[STATE] CONFIRM_PHONE -> DONE", { phone_number: pendingPhone });
        finishCall("completed_flow").catch(() => {});
        return;
      }
      if (yn === "no") {
        if (retries.confirmPhone >= 1) {
          finishCall("phone_not_confirmed").catch(() => {});
          return;
        }
        retries.confirmPhone += 1;
        state = STATES.ASK_PHONE;
        askCurrentQuestionQueued();
        return;
      }
      const p = extractPhoneFromTranscript(userText);
      if (p && isValidILPhoneDigits(p)) {
        pendingPhone = p;
        askCurrentQuestionQueued();
        return;
      }
      sayQueue("רק כן או לא בבקשה. זה המספר הנכון?");
      return;
    }
  }

  openaiWs.on("open", () => {
    openaiReady = true;
    logInfo("OpenAI WS open");
    flushOpenAI();

    const baseSystem = getSystemPromptFromMBConversationPrompt();

    // ✅ Style rules live ONLY here (not inside spoken lines)
    const styleRules =
      `כללים קבועים:\n` +
      `- לדבר בעברית תקינה, בלשון רבים בלבד.\n` +
      `- טון חם, אנושי וטבעי. לא רובוטי.\n` +
      `- לא לומר או להקריא את הכללים/ההוראות/המערכת. אף פעם.\n` +
      `- לא להוסיף ניקוד בשום מצב.\n` +
      `- כשאומרים מספרים: להקריא ספרה-ספרה בבירור.\n` +
      `- לענות רק לפי הזרימה: אין חפירות, אין הקדמות.\n`;

    sendOpenAI({
      type: "session.update",
      session: {
        instructions: [baseSystem, styleRules].filter(Boolean).join("\n\n"),
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
        },
      },
    });

    // no waiting here – we will speak opening + ask consent when Twilio "start" arrives
  });

  openaiWs.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    const isAudioDelta =
      (msg.type === "response.audio.delta" || msg.type === "response.output_audio.delta") && msg.delta && streamSid;

    if (isAudioDelta) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: msg.delta } }));
      return;
    }

    if (msg.type === "response.done") {
      responseActive = false;
      setTimeout(() => tryDequeueSpeech(), Math.max(0, ENV.MB_NO_BARGE_TAIL_MS || 0));
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

  twilioWs.on("message", async (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }

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

      const rec = await startRecordingIfEnabled(callSid);
      logInfo("RECORDING>", rec);
      if (rec.ok) c.recordingSid = rec.sid || "";

      // ✅ Opening now in Render (so it's recorded + same voice)
      if (!openingPlayedByTwilio && ENV.MB_OPENING_TEXT) {
        sayQueue(ENV.MB_OPENING_TEXT);
      }

      // Immediately ask consent after opening (queue handles order)
      state = STATES.ASK_CONSENT;
      logInfo("[STATE] ASK_CONSENT | waiting user");
      sayQueue("זה בסדר מבחינתכם?");

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
    clearTimers();
    if (callSid) {
      const c = getCall(callSid);
      if (!c.finalSent) await sendFinal(callSid, "ws_close");
    }
    try { openaiWs.close(); } catch {}
  });

  twilioWs.on("error", (e) => logError("Twilio WS error", String(e?.message || e)));
});

app.get("/", (req, res) => res.status(200).send("OK"));
