// server.js
//
// NiceLine / מרכז מל״מ – Voice AI “מוטי”
// Twilio Media Streams <-> OpenAI Realtime API (WS) on Render
//
// חוקים:
// - משתמשים *רק* בשמות ה-ENV הקיימים אצלכם (MB_* וכו’) — בלי להמציא שמות חדשים.
// - Flow קשיח (State machine בקוד).
// - שליחה ל-Make רק בסיום שיחה (lead_final) + recording_update אם צריך.
// - תיקון קריטי: אין שימוש ב-response.output_modalities (גורם ל-unknown_parameter).
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
  // אצלכם זה כתוב PENAI_REALTIME_MODEL (עם P בהתחלה) — משתמשים בזה בדיוק
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

function normalizeHebrewNikudLess(s) {
  return (s || "")
    .toString()
    .replace(/[\u0591-\u05C7]/g, "") // remove nikud
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function detectYesNo(s) {
  const t = normalizeHebrewNikudLess(s);
  if (!t) return null;
  const yes = ["כן", "בטח", "בסדר", "אוקיי", "ok", "okay", "yes"];
  const no = ["לא", "ממש לא", "no"];
  if (yes.some((w) => t === w || t.startsWith(w) || t.includes(` ${w} `))) return "yes";
  if (no.some((w) => t === w || t.startsWith(w) || t.includes(` ${w} `))) return "no";
  return null;
}

function detectStudyTrack(s) {
  const t = normalizeHebrewNikudLess(s);
  if (t.includes("רבנות")) return "רבנות";
  if (t.includes("דיינות")) return "דיינות";
  if (t.includes("טוען") && t.includes("רבני")) return "טוען רבני";
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
  // MB_CONVERSATION_PROMPT אצלכם הוא JSON עם { "system": "..." }
  // אם לא JSON / אין system — נחזיר את כל הטקסט כפרומפט.
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
      lead: { first_name: "", last_name: "", phone_number: "", study_track: "" },
      finalSent: false,
      finalTimer: null,
    });
  }
  return calls.get(callSid);
}

function computeStatus(lead) {
  const ok =
    !!safeStr(lead.study_track) &&
    !!safeStr(lead.first_name) &&
    !!safeStr(lead.last_name) &&
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

  // אצלכם PUBLIC_BASE_URL הוא כבר callback URL מלא (כולל /twilio-recording-callback)
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
  // ניתוק יזום אחרי grace (כדי שלא תישאר שיחה על Pause)
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

    // אם כבר נשלח FINAL בלי recording_url — שולחים עדכון נוסף
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

  const status = computeStatus(c.lead);

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
    remarks: `מסלול: ${c.lead.study_track || ""} | סטטוס: ${status.label} | caller: ${c.caller || ""} | callSid: ${c.callSid}`,
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
  // per-connection (per-call) vars
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

  // Flow states
  const STATES = {
    ASK_TRACK: "ASK_TRACK",
    ASK_FIRST: "ASK_FIRST",
    ASK_LAST: "ASK_LAST",
    ASK_PHONE_CHOICE: "ASK_PHONE_CHOICE",
    ASK_PHONE: "ASK_PHONE",
    DONE: "DONE",
  };
  let state = STATES.ASK_TRACK;

  const retries = { track: 0, phone: 0 };

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
        // אזהרה עדינה
        sayExact("רַק לְוַדֵּא שֶׁאַתֶּם עִמָּנוּ. אֶשְׂמַח שֶׁתַּעֲנוּ לַשְּׁאֵלָה.");
        askCurrentQuestion();
      }, ENV.MB_IDLE_WARNING_MS);
    }
    if (ENV.MB_IDLE_HANGUP_MS > 0) {
      if (idleHangTimer) clearTimeout(idleHangTimer);
      idleHangTimer = setTimeout(async () => {
        // סגירה + ניתוק + FINAL
        await finishCall("idle_timeout");
      }, ENV.MB_IDLE_HANGUP_MS);
    }
  }

  function armMaxCallTimers() {
    if (ENV.MB_MAX_CALL_MS > 0 && ENV.MB_MAX_WARN_BEFORE_MS > 0) {
      const warnAt = Math.max(0, ENV.MB_MAX_CALL_MS - ENV.MB_MAX_WARN_BEFORE_MS);
      maxCallWarnTimer = setTimeout(() => {
        sayExact("לְפָנֵי שֶׁנְּסַיֵּם, אֶשְׂמַח לְקַבֵּל אֶת הַפְּרָטִים הַחֲסֵרִים.");
        askCurrentQuestion();
      }, warnAt);
    }
    if (ENV.MB_MAX_CALL_MS > 0) {
      maxCallTimer = setTimeout(async () => {
        await finishCall("max_call_timeout");
      }, ENV.MB_MAX_CALL_MS);
    }
  }

  // OpenAI WS
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

  function sayExact(text) {
    // ✅ תיקון קריטי: אין response.output_modalities בכלל (זה מה שהפיל אתכם)
    botLog(text);
    sendOpenAI({
      type: "response.create",
      response: {
        instructions:
          `תֹּאמְרוּ בְּדִיּוּק אֶת הַטֶּקְסְט הַבָּא, ` +
          `בְּעִבְרִית תַּקִּינָה וּבִלְשׁוֹן רַבִּים, ` +
          `וּבְקֶצֶב מְהִיר מְעַט (מַהִירוּת ~${ENV.MB_SPEECH_SPEED}).\n` +
          text,
      },
    });
  }

  function askCurrentQuestion() {
    if (state === STATES.ASK_TRACK) {
      sayExact("בְּאֵיזֶה מַסְלוּל אַתֶּם מִתְעַנְיְנִים? רַבָּנוּת, דַּיָּנוּת, אוֹ טוֹעֵן רַבָּנִי?");
      return;
    }
    if (state === STATES.ASK_FIRST) {
      sayExact("מָה הַשֵּׁם הַפְּרָטִי שֶׁלָּכֶם?");
      return;
    }
    if (state === STATES.ASK_LAST) {
      sayExact("וּמָה שֵׁם הַמִּשְׁפָּחָה?");
      return;
    }
    if (state === STATES.ASK_PHONE_CHOICE) {
      if (callerPhoneLocal) {
        sayExact(
          `לְאֵיזֶה מִסְפָּר נוֹחַ שֶׁנַּחֲזֹר אֲלֵיכֶם? ` +
            `אֶפְשָׁר לְהָגִיד "כֵּן" וְנַחֲזֹר לַמִּסְפָּר הַמְּזֻהֶּה (${callerPhoneLocal}), ` +
            `אוֹ לְהַגִּיד מִסְפָּר אַחֵר.`
        );
      } else {
        state = STATES.ASK_PHONE;
        askCurrentQuestion();
      }
      return;
    }
    if (state === STATES.ASK_PHONE) {
      sayExact("לְאֵיזֶה מִסְפָּר טֶלֶפוֹן נוֹחַ שֶׁנַּחֲזֹר אֲלֵיכֶם? אֲנָא אִמְרוּ רַק סְפָרוֹת.");
      return;
    }
  }

  function handleMetaOrRefusal(userText) {
    const t = normalizeHebrewNikudLess(userText);

    // סירוב
    if (t.includes("לא רוצה") || t.includes("לא מעוניין") || t.includes("עזוב") || t.includes("ביי")) {
      sayExact("בְּסֵדֶר גָּמוּר. יוֹם טוֹב.");
      state = STATES.DONE;
      return true;
    }

    // שאלות/התחכמויות
    if (
      t.includes("מי אתה") ||
      t.includes("מי אתם") ||
      t.includes("מה זה") ||
      t.includes("תסביר") ||
      t.includes("הלכה") ||
      t.includes("מסלול")
    ) {
      sayExact("אֲנִי מַעֲרֶכֶת רִישּׁוּם בִּלְבַד. נָצִיג יַחֲזֹר אֲלֵיכֶם עִם כָּל הַהֶסְבֵּרִים.");
      askCurrentQuestion();
      return true;
    }

    return false;
  }

  async function finishCall(reason) {
    if (!callSid) return;

    // אם עדיין לא אמרנו סגיר — אומרים פעם אחת
    if (state !== STATES.DONE) {
      state = STATES.DONE;
      const closing = ENV.MB_CLOSING_TEXT || "תּוֹדָה רַבָּה, הַפְּרָטִים נִשְׁמְרוּ. נְצִיג הַמֶּרְכָּז יַחֲזֹר אֲלֵיכֶם בְּהֶקְדֵּם. יוֹם טוֹב.";
      sayExact(closing);
    }

    // שליחה ל-Make אחרי grace
    const c = getCall(callSid);
    if (c.finalTimer) clearTimeout(c.finalTimer);

    c.finalTimer = setTimeout(async () => {
      await sendFinal(callSid, reason);
      // ניתוק בפועל ב-Twilio כדי לא להישאר על Pause
      const h = await hangupCall(callSid);
      dbg("Hangup result", h);
    }, ENV.MB_HANGUP_GRACE_MS);

    // גם סוגרים WSים
    try {
      openaiWs.close();
    } catch {}
    try {
      twilioWs.close();
    } catch {}
  }

  function advanceAfter(userText) {
    const c = getCall(callSid);

    if (ENV.MB_LOG_TRANSCRIPTS) logInfo("USER>", userText);

    // reset idle timers on any user input
    armIdleTimers();

    if (handleMetaOrRefusal(userText)) return;

    if (state === STATES.ASK_TRACK) {
      const track = detectStudyTrack(userText);
      if (!track) {
        if (retries.track >= 1) {
          state = STATES.ASK_FIRST;
          logInfo("[STATE] ASK_TRACK -> ASK_FIRST", { track: "" });
          askCurrentQuestion();
          return;
        }
        retries.track += 1;
        sayExact("אֶפְשָׁר לִבְחוֹר אֶחָד מִשְּׁלֹשֶׁת הַמַּסְלוּלִים: רַבָּנוּת, דַּיָּנוּת, אוֹ טוֹעֵן רַבָּנִי.");
        askCurrentQuestion();
        return;
      }
      c.lead.study_track = track;
      state = STATES.ASK_FIRST;
      logInfo("[STATE] ASK_TRACK -> ASK_FIRST", { track });
      askCurrentQuestion();
      return;
    }

    if (state === STATES.ASK_FIRST) {
      const name = safeStr(userText);
      if (!name) {
        askCurrentQuestion();
        return;
      }
      c.lead.first_name = name;
      state = STATES.ASK_LAST;
      logInfo("[STATE] ASK_FIRST -> ASK_LAST", { first_name: name });
      askCurrentQuestion();
      return;
    }

    if (state === STATES.ASK_LAST) {
      const last = safeStr(userText);
      if (!last) {
        askCurrentQuestion();
        return;
      }
      c.lead.last_name = last;
      state = STATES.ASK_PHONE_CHOICE;
      logInfo("[STATE] ASK_LAST -> ASK_PHONE_CHOICE", { last_name: last });
      askCurrentQuestion();
      return;
    }

    if (state === STATES.ASK_PHONE_CHOICE) {
      const yn = detectYesNo(userText);
      if (yn === "yes" && callerPhoneLocal) {
        c.lead.phone_number = callerPhoneLocal;
        logInfo("[STATE] ASK_PHONE_CHOICE -> DONE", { phone_number: callerPhoneLocal });
        finishCall("completed_flow").catch(() => {});
        return;
      }

      // אם אמר מספר במקום כן/לא
      const d = digitsOnly(userText);
      if (d.length >= 9) {
        state = STATES.ASK_PHONE;
        advanceAfter(d);
        return;
      }

      state = STATES.ASK_PHONE;
      askCurrentQuestion();
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
        sayExact("לַצּוֹרֶךְ חֲזָרָה אֲנִי צָרִיךְ מִסְפָּר תַּקִּין בֵּין תֵּשַׁע לְעֶשֶׂר סְפָרוֹת. אֲנָא אִמְרוּ רַק סְפָרוֹת.");
        return;
      }

      c.lead.phone_number = d;
      logInfo("[STATE] ASK_PHONE -> DONE", { phone_number: d });
      finishCall("completed_flow").catch(() => {});
      return;
    }
  }

  // -------------------- OpenAI WS events --------------------
  openaiWs.on("open", () => {
    openaiReady = true;
    logInfo("OpenAI WS open");
    flushOpenAI();

    const systemPrompt = getSystemPromptFromMBConversationPrompt();

    // session.update — רק פרמטרים תקינים
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

    // אם Twilio כבר ניגן פתיח (opening_played=1) — לא מנגנים שוב
    setTimeout(() => {
      logInfo("[STATE] ASK_TRACK | start");
      state = STATES.ASK_TRACK;
      askCurrentQuestion();
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

    // User transcription
    if (msg.type === "conversation.item.input_audio_transcription.completed") {
      const transcript = (msg.transcript || "").trim();
      if (!transcript) return;
      advanceAfter(transcript);
      return;
    }

    if (msg.type === "error") {
      logError("OpenAI error", msg);
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

      // local phone from E.164
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

      // אם משום מה Twilio לא ניגן פתיח — ננגן פתיח מה-ENV ואז נשאל מסלול
      // (אבל אצלכם ב-/voice opening_played=1, אז ברוב המקרים זה לא יקרה)
      if (!openingPlayedByTwilio && ENV.MB_OPENING_TEXT) {
        sayExact(ENV.MB_OPENING_TEXT);
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

      // אם לא נשלח final עדיין — שולחים אחרי grace קצר (כמו שאתם רוצים)
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
