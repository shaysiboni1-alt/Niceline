// server.js
//
// NiceLine / מרכז מל"מ – Voice AI "מוטי" (תסריט חדש)
// Twilio Media Streams <-> OpenAI Realtime API (WS) on Render
//
// תסריט חדש (בלי ניקוד):
// 1) פתיח כולל שאלת אישור ("זה בסדר מבחינתכם?") – מנוגן ע"י Twilio (/voice) לפני ה-Stream
// 2) הבוט מחכה לתשובת המשתמש: כן/לא
// 3) אם כן: "איך קוראים לכם?"
// 4) אימות מספר: אם יש caller_id -> "המספר מסתיים ב-XXXX זה נכון?"
//    אם לא/אין: בקשת מספר מלא + אימות "המספר הוא ... נכון?"
// 5) סגירה ב-MB_CLOSING_TEXT
// 6) שולחים ל-Make רק בסוף (lead_final) + recording_update אם צריך
//
// FIX קריטי:
// - Speech Queue: לא שולחים response.create חדש בזמן שתגובה קודמת פעילה
//
// Dependencies: express, ws
// Node: 18+ (fetch גלובלי)

const express = require("express");
const WebSocket = require("ws");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 10000;

// -------------------- ENV helpers (ONLY existing keys) --------------------
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

  // אצלכם זה PENAI_REALTIME_MODEL (ככה כתוב) — משתמשים בזה בדיוק
  PENAI_REALTIME_MODEL: process.env.PENAI_REALTIME_MODEL || "gpt-realtime-2025-08-28",

  // אצלכם PUBLIC_BASE_URL כבר כולל /twilio-recording-callback
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || "",

  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || "",
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || "",
  TIME_ZONE: process.env.TIME_ZONE || "Asia/Jerusalem",
};

function logInfo(...args) {
  console.log("[INFO]", ...args);
}
function logError(...args) {
  console.log("[ERROR]", ...args);
}
function dbg(...args) {
  if (ENV.MB_DEBUG) console.log("[DEBUG]", ...args);
}

function nowIso() {
  return new Date().toISOString();
}

function digitsOnly(s) {
  return (s || "").toString().replace(/[^\d]/g, "");
}

function isValidILPhone(s) {
  const d = digitsOnly(s);
  return d.length === 9 || d.length === 10;
}

function safeStr(s) {
  return (s || "").toString().trim();
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
  const yes = ["כן", "בטח", "בסדר", "אוקיי", "ok", "okay", "yes", "בטוחה", "בטוח"];
  const no = ["לא", "ממש לא", "לא רוצה", "no", "nope"];
  if (yes.some((w) => t === w || t.startsWith(w) || t.includes(` ${w} `))) return "yes";
  if (no.some((w) => t === w || t.startsWith(w) || t.includes(` ${w} `))) return "no";
  return null;
}

function looksLikePhone(s) {
  const d = digitsOnly(s);
  return d.length >= 7; // כדי לזהות "050..." גם אם אמרו עם מקפים/רווחים
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

// -------------------- Call store (for final + recording_update) --------------------
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
      lead: {
        first_name: "",
        last_name: "",
        phone_number: "",
        // נשאר קיים למבנה הישן, אבל בתסריט החדש לא משתמשים:
        study_track: "",
      },
      meta: {
        consent: "", // yes/no
      },
      finalSent: false,
      finalTimer: null,
    });
  }
  return calls.get(callSid);
}

function computeStatus(lead, consent) {
  const ok =
    consent === "yes" &&
    !!safeStr(lead.first_name) &&
    !!safeStr(lead.phone_number) &&
    isValidILPhone(lead.phone_number);

  return ok ? { code: "completed", label: "שיחה מלאה" } : { code: "partial", label: "שיחה חלקית" };
}

// -------------------- Twilio REST helpers (Recording + Hangup) --------------------
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

  const cbUrl = ENV.PUBLIC_BASE_URL; // אצלכם זה כבר .../twilio-recording-callback

  const url = `https://api.twilio.com/2010-04-01/Accounts/${ENV.TWILIO_ACCOUNT_SID}/Calls/${callSid}/Recordings.json`;
  const body = new URLSearchParams({
    RecordingStatusCallback: cbUrl,
    RecordingStatusCallbackMethod: "POST",
    RecordingChannels: "dual",
  });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: twilioAuthHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
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
      headers: {
        Authorization: twilioAuthHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    const text = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, body: text, reason: res.ok ? "hangup_ok" : "hangup_http_error" };
  } catch (e) {
    return { ok: false, reason: "hangup_error", error: String(e?.message || e) };
  }
}

// -------------------- Recording callback endpoint --------------------
app.post("/twilio-recording-callback", async (req, res) => {
  const callSid = req.body?.CallSid || "";
  const recordingUrl = req.body?.RecordingUrl || "";
  const recordingSid = req.body?.RecordingSid || "";

  logInfo("RECORDING callback", { callSid, recordingUrl, recordingSid });

  if (callSid) {
    const c = getCall(callSid);
    if (recordingSid) c.recordingSid = recordingSid;
    if (recordingUrl) c.recordingUrl = recordingUrl;

    if (c.finalSent && recordingUrl) {
      const payload = {
        update_type: "recording_update",
        callSid: c.callSid,
        streamSid: c.streamSid,
        caller_id: c.caller || "",
        called: c.called || "",
        recording_url: recordingUrl,
        timestamp: nowIso(),
      };
      const r = await postJson(ENV.MAKE_WEBHOOK_URL, payload);
      if (ENV.MB_LOG_CRM) logInfo("CRM> recording update result", r);
    }
  }

  res.status(200).send("OK");
});

// -------------------- Final send to Make (ONLY at end) --------------------
async function sendFinal(callSid, reason) {
  const c = getCall(callSid);
  if (c.finalSent) return;

  const status = computeStatus(c.lead, c.meta.consent);

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

    source: "Voice AI - Nice Line",
    timestamp: nowIso(),
    reason: reason || "call_end",
    remarks: `סטטוס: ${status.label} | consent: ${c.meta.consent || ""} | name: ${c.lead.first_name || ""} ${c.lead.last_name || ""} | caller: ${c.caller || ""} | callSid: ${c.callSid}`,
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

  // timers
  let idleWarnTimer = null;
  let idleHangTimer = null;
  let maxCallTimer = null;
  let maxCallWarnTimer = null;

  // Flow states (תסריט חדש)
  const STATES = {
    ASK_CONSENT: "ASK_CONSENT",
    ASK_NAME: "ASK_NAME",
    CONFIRM_CALLER_LAST4: "CONFIRM_CALLER_LAST4",
    ASK_PHONE: "ASK_PHONE",
    CONFIRM_PHONE: "CONFIRM_PHONE",
    DONE: "DONE",
  };

  let state = STATES.ASK_CONSENT;

  // retries
  const retries = {
    name: 0,
    phone: 0,
    confirmPhone: 0,
    consent: 0,
  };

  // temp
  let pendingPhone = "";

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
        // לא שואלים שאלה חדשה סתם – מחזירים את השאלה של ה-state
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

  // ---------- Speech queue (prevents active response collisions) ----------
  let responseActive = false;
  const speechQueue = [];

  function tryDequeueSpeech() {
    if (!openaiReady) return;
    if (responseActive) return;
    if (speechQueue.length === 0) return;

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
    // IMPORTANT: no response.output_modalities
    sendOpenAI({
      type: "response.create",
      response: {
        instructions:
          `תגידו בדיוק את הטקסט הבא בעברית תקינה, בלשון רבים בלבד, בקצב מעט מהיר (מהירות ~${ENV.MB_SPEECH_SPEED}).\n` +
          text,
      },
    });
  }

  function last4Local(phoneLocal) {
    const d = digitsOnly(phoneLocal);
    if (d.length < 4) return "";
    return d.slice(-4);
  }

  function askCurrentQuestionQueued() {
    if (state === STATES.ASK_CONSENT) {
      // הפתיח + השאלה כבר הושמעו ע"י Twilio ב-MB_OPENING_TEXT
      // אבל אם צריך לשאול שוב (שתיקה/לא ברור) — נשאל קצר:
      sayQueue("זה בסדר מבחינתכם?");
      return;
    }

    if (state === STATES.ASK_NAME) {
      sayQueue("מצוין. איך קוראים לכם?");
      return;
    }

    if (state === STATES.CONFIRM_CALLER_LAST4) {
      const last4 = last4Local(callerPhoneLocal);
      if (last4) {
        sayQueue(`אני רואה שהשיחה הגיעה ממספר שמסתיים ב-${last4}. זה המספר הנכון לחזור אליכם?`);
      } else {
        state = STATES.ASK_PHONE;
        askCurrentQuestionQueued();
      }
      return;
    }

    if (state === STATES.ASK_PHONE) {
      sayQueue("אשמח אם תגידו לי את מספר הטלפון המלא לחזרה. אנא אמרו רק ספרות.");
      return;
    }

    if (state === STATES.CONFIRM_PHONE) {
      const d = digitsOnly(pendingPhone);
      if (d) sayQueue(`רק לוודא — המספר הוא ${d}. נכון?`);
      else sayQueue("רק לוודא — זה המספר הנכון לחזרה?"); // fallback
      return;
    }
  }

  function isRefusal(text) {
    const t = normalizeText(text);
    return t.includes("לא רוצה") || t.includes("עזוב") || t === "ביי" || t.includes("תעזבו") || t.includes("לא מעוניין");
  }

  function isQuestionAboutDetails(text) {
    const t = normalizeText(text);
    return (
      t.includes("מחיר") ||
      t.includes("כמה עולה") ||
      t.includes("תוכן") ||
      t.includes("מסלולים") ||
      t.includes("מועדים") ||
      t.includes("התאמה") ||
      t.includes("מי אתם") ||
      t.includes("מה זה")
    );
  }

  async function finishCall(reason) {
    if (!callSid) return;

    if (state !== STATES.DONE) {
      state = STATES.DONE;
      const closing =
        ENV.MB_CLOSING_TEXT ||
        "מצוין, רשמתי הכל. הפניה שלכם הועברה ליועץ לימודים והוא יחזור אליכם בהקדם האפשרי. תודה שפניתם אלינו ויום נעים.";
      sayQueue(closing);
    }

    const c = getCall(callSid);
    if (c.finalTimer) clearTimeout(c.finalTimer);

    c.finalTimer = setTimeout(async () => {
      await sendFinal(callSid, reason);
      const h = await hangupCall(callSid);
      dbg("Hangup result", h);
    }, ENV.MB_HANGUP_GRACE_MS);

    try {
      openaiWs.close();
    } catch {}
    try {
      twilioWs.close();
    } catch {}
  }

  function saveNameToLead(nameText) {
    const c = getCall(callSid);
    const raw = safeStr(nameText);
    if (!raw) return false;

    // ניקוי בסיסי
    const cleaned = raw.replace(/[0-9]/g, "").replace(/\s+/g, " ").trim();
    if (!cleaned) return false;

    const parts = cleaned.split(" ").filter(Boolean);
    if (parts.length === 1) {
      c.lead.first_name = parts[0];
      c.lead.last_name = "";
      return true;
    }
    c.lead.first_name = parts[0];
    c.lead.last_name = parts.slice(1).join(" ");
    return true;
  }

  function advanceAfter(userText) {
    const c = getCall(callSid);

    if (ENV.MB_LOG_TRANSCRIPTS) logInfo("USER>", userText);

    armIdleTimers();

    // אם שואלים שאלות על פרטים/תוכן/מחיר -> משפט אחיד + סיום
    if (isQuestionAboutDetails(userText)) {
      sayQueue(
        "זו שאלה חשובה, ויועץ לימודים ישמח להסביר לכם את כל הפרטים בצורה מדויקת ומותאמת אישית. אני כאן רק כדי להעביר את הפניה, והוא יחזור אליכם בהקדם."
      );
      finishCall("asked_details").catch(() => {});
      return;
    }

    // סירוב בכל שלב
    if (isRefusal(userText)) {
      c.meta.consent = "no";
      sayQueue("בסדר גמור, תודה רבה ויום נעים.");
      finishCall("user_refused").catch(() => {});
      return;
    }

    // -------- state machine --------
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

      // לא ברור -> פעם אחת לשאול שוב קצר
      if (retries.consent >= 1) {
        // אם לא מצליחים לקבל כן/לא — נסיים חלקית
        sayQueue("בסדר גמור, תודה רבה ויום נעים.");
        finishCall("consent_unclear").catch(() => {});
        return;
      }
      retries.consent += 1;
      sayQueue("רק לוודא — זה בסדר מבחינתכם?");
      return;
    }

    if (state === STATES.ASK_NAME) {
      const ok = saveNameToLead(userText);
      if (!ok) {
        if (retries.name >= 1) {
          // אין שם -> ממשיכים לטלפון בכל זאת
          state = callerPhoneLocal ? STATES.CONFIRM_CALLER_LAST4 : STATES.ASK_PHONE;
          logInfo("[STATE] ASK_NAME -> (no name) ->", state);
          askCurrentQuestionQueued();
          return;
        }
        retries.name += 1;
        sayQueue("סליחה, חשוב לי לרשום את השם נכון. תוכלו לחזור עליו עוד פעם בבקשה?");
        return;
      }

      // שם נקלט
      state = callerPhoneLocal ? STATES.CONFIRM_CALLER_LAST4 : STATES.ASK_PHONE;
      logInfo("[STATE] ASK_NAME ->", state);
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

      // אם אמר מספר במקום כן/לא:
      if (looksLikePhone(userText)) {
        state = STATES.ASK_PHONE;
        advanceAfter(userText);
        return;
      }

      // לא ברור -> פעם אחת לשאול שוב
      if (retries.consent >= 2) {
        state = STATES.ASK_PHONE;
        askCurrentQuestionQueued();
        return;
      }
      retries.consent += 1;
      askCurrentQuestionQueued();
      return;
    }

    if (state === STATES.ASK_PHONE) {
      const d = digitsOnly(userText);

      if (!isValidILPhone(d)) {
        if (retries.phone >= 1) {
          logInfo("[STATE] ASK_PHONE -> DONE (invalid phone, partial)");
          finishCall("invalid_phone").catch(() => {});
          return;
        }
        retries.phone += 1;
        sayQueue("לצורך חזרה אני צריך מספר תקין בין תשע לעשר ספרות. אנא אמרו רק ספרות.");
        return;
      }

      pendingPhone = d;
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
          // לא הצליח לאשר מספר -> מסיימים חלקית
          logInfo("[STATE] CONFIRM_PHONE -> DONE (not confirmed, partial)");
          finishCall("phone_not_confirmed").catch(() => {});
          return;
        }
        retries.confirmPhone += 1;
        state = STATES.ASK_PHONE;
        askCurrentQuestionQueued();
        return;
      }

      // לא ברור -> לשאול שוב פעם אחת
      if (retries.confirmPhone >= 1) {
        finishCall("confirm_phone_unclear").catch(() => {});
        return;
      }
      retries.confirmPhone += 1;
      sayQueue("רק כן או לא בבקשה. זה המספר הנכון?");
      return;
    }
  }

  // -------------------- OpenAI WS events --------------------
  openaiWs.on("open", () => {
    openaiReady = true;
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
        },
      },
    });

    setTimeout(() => {
      // בתסריט החדש: הפתיח + שאלת האישור כבר הושמעו ב-Twilio לפני stream
      // לכן אנחנו רק מחכים לתשובה.
      state = STATES.ASK_CONSENT;
      logInfo("[STATE] ASK_CONSENT | waiting user");
      armIdleTimers();
      armMaxCallTimers();
    }, 200);
  });

  openaiWs.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    // Audio out -> Twilio
    if (msg.type === "response.output_audio.delta" && msg.delta && streamSid) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: msg.delta } }));
      return;
    }

    // response finished -> release lock + next in queue
    if (msg.type === "response.done") {
      responseActive = false;
      setTimeout(() => {
        tryDequeueSpeech();
      }, Math.max(0, ENV.MB_NO_BARGE_TAIL_MS || 0));
      return;
    }

    // User transcription
    if (msg.type === "conversation.item.input_audio_transcription.completed") {
      const transcript = (msg.transcript || "").trim();
      if (!transcript) return;
      advanceAfter(transcript);
      return;
    }

    if (msg.type === "error") {
      logError("OpenAI error", msg);

      // אם זו שגיאת active_response — פשוט משחררים וממשיכים
      const code = msg?.error?.code || "";
      if (code === "conversation_already_has_active_response") {
        responseActive = false;
        setTimeout(() => tryDequeueSpeech(), 50);
      }
      return;
    }
  });

  openaiWs.on("close", () => {
    logInfo("OpenAI WS closed");
  });

  openaiWs.on("error", (e) => {
    logError("OpenAI WS error", String(e?.message || e));
  });

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

      const rec = await startRecordingIfEnabled(callSid);
      logInfo("RECORDING>", rec);
      if (rec.ok) c.recordingSid = rec.sid || "";

      // אם Twilio לא ניגן פתיח (opening_played=0) — ננגן פתיח מה-ENV
      // (במצב הרגיל אצלכם opening_played=1 ולכן לא ננגן שוב)
      if (!openingPlayedByTwilio && ENV.MB_OPENING_TEXT) {
        sayQueue(ENV.MB_OPENING_TEXT);
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

      if (c.finalTimer) clearTimeout(c.finalTimer);
      c.finalTimer = setTimeout(() => {
        sendFinal(callSid, "twilio_stop").catch(() => {});
      }, Math.max(1000, ENV.MB_HANGUP_GRACE_MS));

      try {
        openaiWs.close();
      } catch {}
      return;
    }
  });

  twilioWs.on("close", () => {
    clearTimers();
    if (callSid) {
      const c = getCall(callSid);
      if (!c.finalSent) {
        if (c.finalTimer) clearTimeout(c.finalTimer);
        c.finalTimer = setTimeout(() => {
          sendFinal(callSid, "ws_close").catch(() => {});
        }, 1500);
      }
    }
    try {
      openaiWs.close();
    } catch {}
  });

  twilioWs.on("error", (e) => {
    logError("Twilio WS error", String(e?.message || e));
  });
});

// -------------------- Health --------------------
app.get("/", (req, res) => res.status(200).send("OK"));
