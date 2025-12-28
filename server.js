// server.js
// NiceLine / מרכז מל"מ – Voice AI (Twilio Media Streams <-> OpenAI Realtime)
// דרישות: Node 18+, express, ws
// ENV קיימים אצלך: MAKE_WEBHOOK_URL, MB_OPENING_TEXT, MB_CLOSING_TEXT, MB_CONVERSATION_PROMPT,
// MB_ENABLE_RECORDING, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, PUBLIC_BASE_URL,
// OPENAI_API_KEY, OPENAI_VOICE, PENAI_REALTIME_MODEL, MB_STT_LANGUAGE,
// MB_VAD_PREFIX_MS, MB_VAD_SILENCE_MS, MB_VAD_SUFFIX_MS, MB_VAD_THRESHOLD,
// MB_LOG_BOT, MB_LOG_TRANSCRIPTS, MB_LOG_CRM, MB_DEBUG, ועוד.

const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 10000;

function envBool(v, def = false) {
  if (v === undefined || v === null || v === "") return def;
  return String(v).toLowerCase() === "true" || String(v) === "1";
}
function envInt(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}
function envFloat(v, def) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : def;
}

const MB_DEBUG = envBool(process.env.MB_DEBUG, false);
const MB_LOG_BOT = envBool(process.env.MB_LOG_BOT, true);
const MB_LOG_TRANSCRIPTS = envBool(process.env.MB_LOG_TRANSCRIPTS, true);
const MB_LOG_CRM = envBool(process.env.MB_LOG_CRM, true);

const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || "";
const MB_OPENING_TEXT =
  process.env.MB_OPENING_TEXT ||
  'שלום, הגעתם למערכת הרישום של מרכז מל"מ. כדי שיועץ לימודים יחזור אליכם לבדיקת התאמה, נשאל כמה שאלות קצרות. האם זה בסדר מבחינתכם?';
const MB_CLOSING_TEXT =
  process.env.MB_CLOSING_TEXT ||
  "תודה רבה, הפרטים נרשמו. נציג המרכז יחזור אליכם בהקדם. יום טוב.";

const MB_CONVERSATION_PROMPT = process.env.MB_CONVERSATION_PROMPT || ""; // JSON {"system":"..."} או טקסט

const MB_ENABLE_RECORDING = envBool(process.env.MB_ENABLE_RECORDING, false);
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || ""; // לדוגמה: https://niceline.onrender.com

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_VOICE = process.env.OPENAI_VOICE || "cedar";
const OPENAI_REALTIME_MODEL = process.env.PENAI_REALTIME_MODEL || process.env.OPENAI_REALTIME_MODEL || "";

// VAD
const MB_VAD_PREFIX_MS = envInt(process.env.MB_VAD_PREFIX_MS, 200);
const MB_VAD_SILENCE_MS = envInt(process.env.MB_VAD_SILENCE_MS, 900);
const MB_VAD_SUFFIX_MS = envInt(process.env.MB_VAD_SUFFIX_MS, 200);
const MB_VAD_THRESHOLD = envFloat(process.env.MB_VAD_THRESHOLD, 0.65);

const MB_STT_LANGUAGE = process.env.MB_STT_LANGUAGE || process.env.MB_STT_LANGUAGE === "" ? process.env.MB_STT_LANGUAGE : (process.env.MB_STT_LANGUAGE || "");
// אצלך ראיתי MB_STT_LANGUAGE=he

function logInfo(...args) {
  console.log("[INFO]", ...args);
}
function logError(...args) {
  console.error("[ERROR]", ...args);
}

function safeLast4(localPhone) {
  const d = (localPhone || "").replace(/\D/g, "");
  if (d.length < 4) return "";
  return d.slice(-4).split("").join(" ");
}

function normalizeIsraeliPhone(input) {
  const digits = String(input || "").replace(/\D/g, "");
  if (!digits) return "";
  // אם אמרו 972... נהפוך ל-0...
  if (digits.startsWith("972") && digits.length >= 11) {
    const rest = digits.slice(3);
    return "0" + rest;
  }
  return digits;
}

function isValidIsraeliPhoneDigits(digits) {
  const d = String(digits || "").replace(/\D/g, "");
  return d.length === 9 || d.length === 10;
}

function parsePromptSystem(mbConversationPrompt) {
  if (!mbConversationPrompt) return "";
  try {
    const obj = JSON.parse(mbConversationPrompt);
    if (obj && typeof obj.system === "string") return obj.system;
  } catch (_) {}
  // אם זה לא JSON – נחזיר כמו שהוא
  return String(mbConversationPrompt);
}

function buildSystemInstructions() {
  const base = parsePromptSystem(MB_CONVERSATION_PROMPT).trim();
  // “בלי ניקוד” + טון פחות רובוטי + מהיר יותר (בהנחיה בלבד)
  const hard =
    "אתם בוט רישום של מרכז מל\"מ. אתם מדברים בעברית תקינה, בלשון רבים בלבד. " +
    "המטרה: רישום מתעניינים בלבד. לא מסבירים מסלולים ולא נותנים תוכן הלכתי. " +
    "תשובות קצרות, חמות ואנושיות, לא רובוטיות, ודיבור מעט מהיר מהרגיל. " +
    "לא לשאול אימייל. אם שואלים שאלות לא רלוונטיות: 'אנחנו מערכת רישום בלבד. נציג יחזור אליכם עם כל ההסברים.' ואז חוזרים לשאלה הנוכחית.";
  return (base ? base + "\n\n" : "") + hard;
}

// ===== Twilio Recording Proxy (Public MP3 without credentials) =====
async function fetchTwilioRecordingMp3(recordingSid) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Recordings/${recordingSid}.mp3`;
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` },
  });
  return res;
}

app.get("/recording/:sid.mp3", async (req, res) => {
  try {
    const sid = req.params.sid;
    if (!sid || !sid.startsWith("RE")) return res.status(400).send("Bad recording sid");
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return res.status(500).send("Missing Twilio creds");

    const r = await fetchTwilioRecordingMp3(sid);
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return res.status(r.status).send(txt || "Twilio fetch failed");
    }
    res.setHeader("Content-Type", "audio/mpeg");
    const buf = Buffer.from(await r.arrayBuffer());
    return res.status(200).send(buf);
  } catch (e) {
    logError("recording proxy error", e);
    return res.status(500).send("error");
  }
});

// Twilio recording callback (we keep it, but we DO NOT send a second webhook anymore)
const recordingStoreByCallSid = new Map(); // callSid -> { recordingSid, recordingUrlMp3 }
app.post("/twilio-recording-callback", (req, res) => {
  try {
    const callSid = req.body.CallSid || req.body.callSid;
    const recordingSid = req.body.RecordingSid || req.body.recordingSid;
    const recordingUrl = req.body.RecordingUrl || req.body.recordingUrl; // no .mp3 sometimes

    logInfo("RECORDING callback", { callSid, recordingUrl, recordingSid });

    if (callSid && recordingSid) {
      const mp3 = String(recordingUrl || "").endsWith(".mp3")
        ? String(recordingUrl)
        : String(recordingUrl || "") + ".mp3";

      const publicMp3 =
        PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL.replace(/\/$/, "")}/recording/${recordingSid}.mp3` : "";

      recordingStoreByCallSid.set(callSid, {
        recordingSid,
        recording_url: mp3,
        recording_public_url: publicMp3,
      });
    }
  } catch (e) {
    logError("recording callback error", e);
  }
  // Twilio expects 2xx quickly
  return res.status(200).send("ok");
});

app.get("/health", (req, res) => res.status(200).send("ok"));

// ====== WebSocket server for Twilio Media Streams ======
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/twilio-media-stream" });

// helper: OpenAI Realtime WS connect
function openAiWsConnect() {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
  if (!OPENAI_REALTIME_MODEL) throw new Error("Missing PENAI_REALTIME_MODEL / OPENAI_REALTIME_MODEL");

  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`;
  const ws = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });
  return ws;
}

function sendJson(ws, obj) {
  ws.send(JSON.stringify(obj));
}

function nowIso() {
  return new Date().toISOString();
}

async function sendToMake(payload) {
  if (!MAKE_WEBHOOK_URL) return { ok: false, reason: "no_make_webhook" };
  try {
    const res = await fetch(MAKE_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, body: text, reason: res.ok ? "make_ok" : "make_fail" };
  } catch (e) {
    return { ok: false, reason: "make_error", error: String(e) };
  }
}

// Start recording early, returns recordingSid if started
async function startTwilioRecording(callSid) {
  if (!MB_ENABLE_RECORDING) return { ok: false, reason: "recording_disabled" };
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !callSid) return { ok: false, reason: "missing_twilio_creds_or_callsid" };
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}/Recordings.json`;
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");

    const callbackUrl = PUBLIC_BASE_URL
      ? `${PUBLIC_BASE_URL.replace(/\/$/, "")}/twilio-recording-callback`
      : "";

    const form = new URLSearchParams();
    // dual is helpful, but not mandatory
    form.set("RecordingChannels", "dual");
    if (callbackUrl) {
      form.set("RecordingStatusCallback", callbackUrl);
      form.set("RecordingStatusCallbackEvent", "completed");
    }

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { ok: false, reason: "twilio_recording_start_failed", status: res.status, body: t };
    }
    const json = await res.json();
    const sid = json.sid; // RecordingSid
    return { ok: true, reason: "recording_started", sid };
  } catch (e) {
    return { ok: false, reason: "recording_start_error", error: String(e) };
  }
}

function stateLog(msg) {
  logInfo(msg);
}

wss.on("connection", (twilioWs, req) => {
  let callSid = "";
  let streamSid = "";
  let caller = "";
  let called = "";
  let source = "Voice AI - Nice Line";
  let callerPhoneLocal = "";

  // Lead data
  const lead = {
    first_name: "",
    last_name: "",
    phone_number: "",
    study_track: "",
    consent: "",
  };

  // recording info
  let recordingSid = "";
  let recording_url = "";
  let recording_public_url = "";

  // flow control
  let STATE = "ASK_CONSENT";
  let askedClarifyOnce = { consent: false, phone: false, name: false };
  let finalSent = false;

  // OpenAI WS
  let oaWs = null;
  let oaReady = false;
  let responseInFlight = false;
  let pendingSpeakQueue = [];

  function setState(next) {
    if (MB_DEBUG) logInfo(`[STATE] ${STATE} -> ${next}`);
    STATE = next;
  }

  function twilioSendAudioChunk(base64Pcmu) {
    // Send audio to Twilio Media Stream
    const msg = {
      event: "media",
      streamSid,
      media: { payload: base64Pcmu },
    };
    twilioWs.send(JSON.stringify(msg));
  }

  function speak(text) {
    if (!text) return;
    if (!oaWs || oaWs.readyState !== WebSocket.OPEN) return;

    // queue if a response is already in flight
    pendingSpeakQueue.push(text);
    drainSpeakQueue();
  }

  function drainSpeakQueue() {
    if (!oaReady) return;
    if (responseInFlight) return;
    if (!pendingSpeakQueue.length) return;

    const text = pendingSpeakQueue.shift();
    responseInFlight = true;

    if (MB_LOG_BOT) logInfo("BOT>", text);

    // IMPORTANT:
    // לא משתמשים ב-response.output_modalities (זה שבר אותך)
    // משתמשים ב-response.modalities
    sendJson(oaWs, {
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions: text,
      },
    });
  }

  function normalizeYesNo(heText) {
    const t = String(heText || "").trim();
    if (!t) return "";
    // כן/לא + וריאציות
    if (/(^|[\s,.!?])כן([\s,.!?]|$)/.test(t)) return "yes";
    if (/(^|[\s,.!?])לא([\s,.!?]|$)/.test(t)) return "no";
    return "";
  }

  function extractName(text) {
    const t = String(text || "").trim().replace(/\s+/g, " ");
    if (!t) return { first: "", last: "" };
    const parts = t.split(" ").filter(Boolean);
    if (parts.length === 1) return { first: parts[0], last: "" };
    return { first: parts[0], last: parts.slice(1).join(" ") };
  }

  function handleUserText(userText) {
    if (MB_LOG_TRANSCRIPTS) logInfo("USER>", userText);

    // global intent: if asked who are you / why etc - short answer then return to question
    const t = String(userText || "");
    if (/(מי אתה|מי את|מה זה|תסביר|הלכ|מסלול|למה)/.test(t) && STATE !== "ASK_CONSENT") {
      speak("אנחנו מערכת רישום בלבד. נציג יחזור אליכם עם כל ההסברים. נמשיך בבקשה.");
      // keep same state and re-ask shortly
      reAskCurrent();
      return;
    }

    if (STATE === "ASK_CONSENT") {
      const yn = normalizeYesNo(userText);
      if (yn === "yes") {
        lead.consent = "yes";
        setState("ASK_NAME");
        speak("מצוין. איך קוראים לכם? אפשר שם פרטי ושם משפחה.");
        return;
      }
      if (yn === "no") {
        lead.consent = "no";
        // closing then end
        speak("בסדר גמור. תודה רבה ויום נעים.");
        endCall("consent_no");
        return;
      }

      if (!askedClarifyOnce.consent) {
        askedClarifyOnce.consent = true;
        speak("רק לוודא — זה בסדר מבחינתכם?");
        return;
      }

      endCall("consent_unclear");
      return;
    }

    if (STATE === "ASK_NAME") {
      const { first, last } = extractName(userText);
      lead.first_name = first;
      lead.last_name = last;

      setState("CONFIRM_NAME");
      const nameSpoken = [lead.first_name, lead.last_name].filter(Boolean).join(" ");
      speak(`רשמתי את השם: ${nameSpoken}. זה נכון?`);
      return;
    }

    if (STATE === "CONFIRM_NAME") {
      const yn = normalizeYesNo(userText);
      if (yn === "yes") {
        // proceed to phone confirm
        setState("CONFIRM_CALLER_LAST4");
        const last4 = safeLast4(callerPhoneLocal);
        if (last4) {
          speak(`אני רואה שהשיחה הגיעה ממספר שמסתיים ב-${last4}. זה המספר הנכון לחזור אליכם?`);
        } else {
          setState("ASK_PHONE");
          speak("לאיזה מספר נוח שנחזור אליכם? אנא אמרו מספר טלפון.");
        }
        return;
      }

      // user corrected name - take the new name
      const { first, last } = extractName(userText);
      if (first) lead.first_name = first;
      lead.last_name = last;

      const nameSpoken = [lead.first_name, lead.last_name].filter(Boolean).join(" ");
      speak(`רשמתי את השם: ${nameSpoken}. זה נכון?`);
      return;
    }

    if (STATE === "CONFIRM_CALLER_LAST4") {
      const yn = normalizeYesNo(userText);
      if (yn === "yes" && callerPhoneLocal) {
        lead.phone_number = callerPhoneLocal;
        setState("DONE");
        speak(MB_CLOSING_TEXT); // חייב סגיר
        endCall("completed_flow");
        return;
      }
      if (yn === "no") {
        setState("ASK_PHONE");
        speak("אין בעיה. אנא אמרו את מספר הטלפון לחזרה, ספרות בלבד.");
        return;
      }

      if (!askedClarifyOnce.phone) {
        askedClarifyOnce.phone = true;
        speak("אפשר להגיד כן אם זה המספר הנכון, או להגיד מספר אחר.");
        return;
      }

      setState("ASK_PHONE");
      speak("אנא אמרו מספר טלפון לחזרה, ספרות בלבד.");
      return;
    }

    if (STATE === "ASK_PHONE") {
      const d = normalizeIsraeliPhone(userText);
      if (isValidIsraeliPhoneDigits(d)) {
        lead.phone_number = d;
        setState("DONE");
        speak(MB_CLOSING_TEXT);
        endCall("completed_flow");
        return;
      }

      if (!askedClarifyOnce.phone) {
        askedClarifyOnce.phone = true;
        speak("לצורך חזרה אני צריך מספר תקין בין תשע לעשר ספרות. אנא אמרו רק ספרות.");
        return;
      }

      endCall("invalid_phone");
      return;
    }
  }

  function reAskCurrent() {
    if (STATE === "ASK_CONSENT") speak("זה בסדר מבחינתכם?");
    else if (STATE === "ASK_NAME") speak("איך קוראים לכם? אפשר שם פרטי ושם משפחה.");
    else if (STATE === "CONFIRM_NAME") {
      const nameSpoken = [lead.first_name, lead.last_name].filter(Boolean).join(" ");
      speak(`רשמתי את השם: ${nameSpoken}. זה נכון?`);
    } else if (STATE === "CONFIRM_CALLER_LAST4") {
      const last4 = safeLast4(callerPhoneLocal);
      speak(`זה המספר שמסתיים ב-${last4}. זה המספר הנכון לחזור אליכם?`);
    } else if (STATE === "ASK_PHONE") {
      speak("אנא אמרו מספר טלפון לחזרה.");
    }
  }

  async function sendFinal(reason) {
    if (finalSent) return;
    finalSent = true;

    // decide status
    const completed = !!(lead.first_name && lead.phone_number && isValidIsraeliPhoneDigits(lead.phone_number));
    const call_status_code = completed ? "completed" : "partial";
    const call_status = completed ? "שיחה מלאה" : "שיחה חלקית";

    // recording info: if callback already arrived, use it. If not, but we have recordingSid, still provide public url.
    const stored = callSid ? recordingStoreByCallSid.get(callSid) : null;
    if (stored) {
      recordingSid = stored.recordingSid || recordingSid;
      recording_url = stored.recording_url || recording_url;
      recording_public_url = stored.recording_public_url || recording_public_url;
    }

    if (!recording_public_url && recordingSid && PUBLIC_BASE_URL) {
      recording_public_url = `${PUBLIC_BASE_URL.replace(/\/$/, "")}/recording/${recordingSid}.mp3`;
    }

    const payload = {
      update_type: "lead_final",
      first_name: lead.first_name || "",
      last_name: lead.last_name || "",
      phone_number: lead.phone_number || "",
      study_track: lead.study_track || "",

      caller_id: caller || "",
      caller_phone_local: callerPhoneLocal || "",
      called: called || "",

      callSid: callSid || "",
      streamSid: streamSid || "",

      call_status,
      call_status_code,

      recording_url: recording_url || "",
      recording_public_url: recording_public_url || "",

      source,
      timestamp: nowIso(),
      reason: reason || "ws_close",
      remarks: `סטטוס: ${call_status} | consent: ${lead.consent || ""} | name: ${(lead.first_name || "")} ${(lead.last_name || "")}`.trim(),
    };

    if (MB_LOG_CRM) logInfo("CRM> sending FINAL", payload);
    const res = await sendToMake(payload);
    if (MB_LOG_CRM) logInfo("CRM> final result", res);
  }

  function endCall(reason) {
    // We can't force hangup from Media Stream easily without TwiML, but we can close sockets.
    // Send final, then close.
    sendFinal(reason).finally(() => {
      try { if (oaWs && oaWs.readyState === WebSocket.OPEN) oaWs.close(); } catch (_) {}
      try { if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(); } catch (_) {}
    });
  }

  // ===== OpenAI WS Init =====
  function initOpenAi() {
    try {
      oaWs = openAiWsConnect();

      oaWs.on("open", () => {
        oaReady = true;
        logInfo("OpenAI WS open");

        // IMPORTANT:
        // לא שולחים session.type / input_audio_format / output_modalities וכו' כדי לא לשבור.
        // שולחים מינימום יציב.
        sendJson(oaWs, {
          type: "session.update",
          session: {
            voice: OPENAI_VOICE,
            instructions: buildSystemInstructions(),
            turn_detection: {
              type: "server_vad",
              threshold: MB_VAD_THRESHOLD,
              prefix_padding_ms: MB_VAD_PREFIX_MS,
              silence_duration_ms: MB_VAD_SILENCE_MS,
              create_response: false, // קריטי כדי שלא ינהל לך את ה-flow לבד
            },
          },
        });

        // פתיח — רק מרנדר
        if (MB_LOG_BOT) logInfo("BOT>", MB_OPENING_TEXT);
        pendingSpeakQueue.push(MB_OPENING_TEXT);
        drainSpeakQueue();
      });

      oaWs.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        // Debug optional
        if (MB_DEBUG && msg && msg.type) {
          // comment this if too noisy
          // logInfo("OA>", msg.type);
        }

        if (msg.type === "error") {
          logError("OpenAI error", msg);
          // This is the key: if OpenAI rejects params, you get no audio. End gracefully.
          endCall("openai_error");
          return;
        }

        // audio out chunks
        if (msg.type === "response.audio.delta" && msg.delta) {
          // delta is base64 (usually PCM16). Twilio expects audio/x-mulaw (PCMU) base64.
          // NOTE: Most stable setup is to let OpenAI output g711_ulaw directly, but that requires output_audio_format param.
          // Since your API has been rejecting audio format params, we avoid them and instead rely on default that matches Twilio in your current build.
          // If you still get silence, we'll switch to a safe transcoder in next step.
          twilioSendAudioChunk(msg.delta);
          return;
        }

        if (msg.type === "response.completed") {
          responseInFlight = false;
          drainSpeakQueue();
          return;
        }

        // transcription from user
        if (msg.type === "input_audio_buffer.speech_started") {
          // ignore
          return;
        }
        if (msg.type === "conversation.item.input_audio_transcription.completed") {
          const text = msg.transcript || "";
          if (text) handleUserText(text);
          return;
        }
      });

      oaWs.on("close", () => {
        logInfo("OpenAI WS closed");
        oaReady = false;
      });

      oaWs.on("error", (e) => {
        logError("OpenAI WS socket error", e);
        endCall("openai_ws_error");
      });
    } catch (e) {
      logError("OpenAI init error", e);
      endCall("openai_init_error");
    }
  }

  // ===== Twilio WS handlers =====
  twilioWs.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      callSid = msg.start.callSid;

      const params = msg.start.customParameters || {};
      caller = params.caller || "";
      called = params.called || "";
      source = params.source || source;

      // local phone
      callerPhoneLocal = "";
      if (caller && caller.startsWith("+972")) {
        const digits = caller.replace(/\D/g, "");
        // +9725XXXXXXXX -> 0 + rest
        if (digits.startsWith("972")) callerPhoneLocal = "0" + digits.slice(3);
      } else {
        callerPhoneLocal = normalizeIsraeliPhone(caller);
      }

      logInfo("CALL start", { streamSid, callSid, caller, called, callerPhoneLocal });

      // start recording early
      const rec = await startTwilioRecording(callSid);
      if (rec.ok && rec.sid) {
        recordingSid = rec.sid;
        recording_public_url = PUBLIC_BASE_URL
          ? `${PUBLIC_BASE_URL.replace(/\/$/, "")}/recording/${recordingSid}.mp3`
          : "";
        logInfo("RECORDING>", { ok: true, reason: rec.reason, sid: rec.sid });
      } else {
        logInfo("RECORDING>", { ok: false, reason: rec.reason, status: rec.status });
      }

      // init OpenAI
      initOpenAi();
      stateLog(`[STATE] ${STATE} | waiting user`);
      return;
    }

    if (msg.event === "media") {
      // audio from Twilio
      // We forward base64 payload to OpenAI input_audio_buffer.append
      if (!oaWs || oaWs.readyState !== WebSocket.OPEN) return;

      // Twilio payload is base64 g711 ulaw by default
      // We avoid specifying input_audio_format to OpenAI (since it broke you),
      // and assume server accepts the incoming audio as provided by your existing setup.
      sendJson(oaWs, {
        type: "input_audio_buffer.append",
        audio: msg.media.payload,
      });
      return;
    }

    if (msg.event === "stop") {
      logInfo("Twilio stop", { streamSid, callSid });
      await sendFinal("twilio_stop");
      try { if (oaWs && oaWs.readyState === WebSocket.OPEN) oaWs.close(); } catch (_) {}
      try { if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(); } catch (_) {}
      return;
    }
  });

  twilioWs.on("close", async () => {
    if (!finalSent) await sendFinal("ws_close");
    try { if (oaWs && oaWs.readyState === WebSocket.OPEN) oaWs.close(); } catch (_) {}
  });

  twilioWs.on("error", (e) => {
    logError("Twilio WS error", e);
    endCall("twilio_ws_error");
  });
});

server.listen(PORT, () => {
  logInfo(`==> Detected service running on port ${PORT}`);
});
