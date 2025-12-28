// server.js
// NiceLine Voice AI – Render Web Service
// Twilio Media Streams <-> OpenAI Realtime API
//
// IMPORTANT:
// - Uses ONLY existing ENV names from your Render screenshot.
// - Fixes OpenAI Realtime param schema (no more unknown_parameter errors).
// - Sends ONLY ONE final webhook (lead_final) — no second webhook.
// - Optional: opening can be played from Render (recorded + same voice).
//
// deps: express, ws (already in package.json)

const express = require("express");
const WebSocket = require("ws");

const app = express();
app.use(express.json({ limit: "5mb" }));

// -------------------- ENV (DO NOT RENAME) --------------------
const {
  MAKE_WEBHOOK_URL,

  MB_OPENING_TEXT,
  MB_CLOSING_TEXT,
  MB_CONVERSATION_PROMPT,

  MB_DEBUG,
  MB_LOG_BOT,
  MB_LOG_CRM,
  MB_LOG_TRANSCRIPTS,

  MB_SPEECH_SPEED,
  MB_STT_LANGUAGE,

  MB_VAD_PREFIX_MS,
  MB_VAD_SILENCE_MS,
  MB_VAD_SUFFIX_MS,
  MB_VAD_THRESHOLD,

  MB_IDLE_WARNING_MS,
  MB_IDLE_HANGUP_MS,
  MB_HANGUP_GRACE_MS,
  MB_MAX_CALL_MS,

  OPENAI_API_KEY,
  OPENAI_VOICE,

  // NOTE: you have a typo in Render screenshot: PENAI_REALTIME_MODEL
  // We support BOTH so you don't need to change anything.
  OPENAI_REALTIME_MODEL,
  PENAI_REALTIME_MODEL,

  PUBLIC_BASE_URL,

  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,

  TIME_ZONE,
} = process.env;

const DEBUG = String(MB_DEBUG || "").toLowerCase() === "true";
const LOG_BOT = String(MB_LOG_BOT || "true").toLowerCase() === "true";
const LOG_CRM = String(MB_LOG_CRM || "true").toLowerCase() === "true";
const LOG_TRANSCRIPTS = String(MB_LOG_TRANSCRIPTS || "true").toLowerCase() === "true";

function logInfo(...args) {
  console.log("[INFO]", ...args);
}
function logError(...args) {
  console.error("[ERROR]", ...args);
}
function logBot(text) {
  if (LOG_BOT) logInfo("BOT>", text);
}
function logUser(text) {
  if (LOG_TRANSCRIPTS) logInfo("USER>", text);
}

// -------------------- Helpers --------------------
function nowIso() {
  return new Date().toISOString();
}

function normalizeHeName(raw) {
  const s = String(raw || "").trim();
  // very light cleanup
  return s.replace(/\s+/g, " ").replace(/[.،,]+$/g, "");
}

function normalizeIsraeliPhoneDigits(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  // Israeli phone should be 9-10 digits typically (05xxxxxxxx, 0xxxxxxxxx)
  if (digits.length === 9 || digits.length === 10) return digits;
  // If got +972XXXXXXXXX -> convert
  if (digits.startsWith("972") && (digits.length === 11 || digits.length === 12)) {
    const local = "0" + digits.slice(3);
    if (local.length === 9 || local.length === 10) return local;
    return local;
  }
  return digits; // keep whatever we got for logging
}

function last4Spaced(localDigits) {
  const d = normalizeIsraeliPhoneDigits(localDigits);
  const last4 = d.slice(-4);
  return last4.split("").join(" ");
}

async function postToMake(payload) {
  if (!MAKE_WEBHOOK_URL) return { ok: false, reason: "no_make_webhook" };
  try {
    const res = await fetch(MAKE_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, body: text, reason: res.ok ? "make_ok" : "make_bad" };
  } catch (e) {
    return { ok: false, reason: "make_fetch_error", error: String(e) };
  }
}

// -------------------- Recording proxy (public URL without Twilio auth prompt) --------------------
// GET /recording/<RecordingSid>.mp3  -> fetch from Twilio with basic auth, stream back
app.get("/recording/:sid.mp3", async (req, res) => {
  try {
    const sid = req.params.sid;
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return res.status(500).send("Missing Twilio creds");
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Recordings/${sid}.mp3`;
    const tw = await fetch(url, {
      headers: {
        Authorization: "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64"),
      },
    });
    if (!tw.ok) return res.status(tw.status).send("Unable to fetch recording");
    res.setHeader("Content-Type", "audio/mpeg");
    tw.body.pipe(res);
  } catch (e) {
    res.status(500).send("Error");
  }
});

// -------------------- One webhook only: FINAL buffer --------------------
const pendingFinalByCallSid = new Map();
// structure: { finalPayload, sent:boolean, recordingSid?, recordingPublicUrl?, timer? }

async function sendFinalOnce(callSid) {
  const entry = pendingFinalByCallSid.get(callSid);
  if (!entry || entry.sent) return;

  const payload = { ...entry.finalPayload };

  // If we have recordingSid -> add public URL
  if (entry.recordingSid && PUBLIC_BASE_URL) {
    payload.recording_public_url = `${PUBLIC_BASE_URL.replace(/\/$/, "")}/recording/${entry.recordingSid}.mp3`;
  } else {
    payload.recording_public_url = payload.recording_public_url || "";
  }

  entry.sent = true;
  pendingFinalByCallSid.set(callSid, entry);

  if (LOG_CRM) logInfo("CRM> sending FINAL", payload);
  const result = await postToMake(payload);
  if (LOG_CRM) logInfo("CRM> final result", result);
}

// Twilio recording status callback (your PUBLIC_BASE_URL already points to /twilio-recording-callback in screenshot)
app.post("/twilio-recording-callback", async (req, res) => {
  try {
    const callSid = req.body.CallSid || req.body.callSid;
    const recordingSid = req.body.RecordingSid || req.body.recordingSid;

    logInfo("RECORDING callback", {
      callSid,
      recordingSid,
      recordingUrl: req.body.RecordingUrl || req.body.recordingUrl,
    });

    if (callSid && recordingSid) {
      const entry = pendingFinalByCallSid.get(callSid);
      if (entry && !entry.sent) {
        entry.recordingSid = recordingSid;
        pendingFinalByCallSid.set(callSid, entry);
        // send final now (only once)
        await sendFinalOnce(callSid);
      }
      // IMPORTANT: do NOT send a second webhook here.
    }

    return res.status(200).send("OK");
  } catch (e) {
    return res.status(200).send("OK");
  }
});

// -------------------- Media Stream WS (Twilio connects here) --------------------
const server = app.listen(process.env.PORT || 10000, () => {
  logInfo("HTTP listening on", process.env.PORT || 10000);
});

const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  // Twilio Media Streams will connect to /twilio-media-stream
  if (req.url.startsWith("/twilio-media-stream")) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

// -------------------- OpenAI Realtime WS connect --------------------
function openaiWsUrl(model) {
  // Realtime WS endpoint
  return `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
}

function getRealtimeModel() {
  return OPENAI_REALTIME_MODEL || PENAI_REALTIME_MODEL || "gpt-realtime";
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// -------------------- Conversation State Machine --------------------
const STATES = {
  ASK_CONSENT: "ASK_CONSENT",
  ASK_NAME: "ASK_NAME",
  CONFIRM_NAME: "CONFIRM_NAME",
  CONFIRM_CALLER_LAST4: "CONFIRM_CALLER_LAST4",
  ASK_TRACK: "ASK_TRACK",
  DONE: "DONE",
};

function buildSystemInstructions() {
  // The MB_CONVERSATION_PROMPT in your ENV is JSON-like in screenshot,
  // but we will accept both plain string or JSON and extract "system" if exists.
  const raw = MB_CONVERSATION_PROMPT || "";
  const parsed = safeJsonParse(raw);
  if (parsed && typeof parsed === "object") {
    if (typeof parsed.system === "string" && parsed.system.trim()) return parsed.system.trim();
  }
  return String(raw || "").trim();
}

function scriptTexts() {
  const opening =
    (MB_OPENING_TEXT && String(MB_OPENING_TEXT).trim()) ||
    'שלום, הגעתם למערכת הרישום של מרכז מל״מ. כדי שיועץ לימודים יחזור אליכם לבדיקת התאמה, נשאל כמה שאלות קצרות. האם זה בסדר מבחינתכם?';

  const closing =
    (MB_CLOSING_TEXT && String(MB_CLOSING_TEXT).trim()) ||
    "תודה רבה, הפרטים נרשמו. נציג המרכז יחזור אליכם בהקדם. יום טוב.";

  return { opening, closing };
}

// We use OpenAI only for: (1) STT transcription, (2) TTS audio playback of our scripted lines.
// We do NOT ask it to “invent” conversation text, so it won’t go off-script.
function buildSessionUpdate() {
  const model = getRealtimeModel();
  const voice = OPENAI_VOICE || "cedar";

  const vadPrefix = Number(MB_VAD_PREFIX_MS || 200);
  const vadSilence = Number(MB_VAD_SILENCE_MS || 900);
  const vadSuffix = Number(MB_VAD_SUFFIX_MS || 200);
  const vadThreshold = Number(MB_VAD_THRESHOLD || 0.65);

  const sttLang = MB_STT_LANGUAGE || "he";

  const system = buildSystemInstructions();

  // IMPORTANT: new schema uses output_modalities + audio.{input/output}
  // We configure audio for Twilio: audio/pcmu (G.711 mu-law).
  return {
    type: "session.update",
    session: {
      type: "realtime",
      model,
      instructions: system,
      output_modalities: ["audio"],
      audio: {
        input: {
          format: { type: "audio/pcmu" },
          transcription: {
            model: "gpt-4o-transcribe",
            language: sttLang,
          },
          turn_detection: {
            type: "semantic_vad",
            // Keep it responsive; Twilio already chunks audio.
            // Use threshold-ish knobs only if supported by backend; keep minimal.
          },
        },
        output: {
          format: { type: "audio/pcmu" },
          voice,
        },
      },
    },
  };
}

// Ask OpenAI to speak EXACT text (scripted) as audio
function responseSpeakEvent(text) {
  const speed = Number(MB_SPEECH_SPEED || 1.0);

  // We keep response minimal; no output_modalities here.
  // The session already defines audio output.
  return {
    type: "response.create",
    response: {
      // “input” is a conversation item style; keep it simple with instructions-only response:
      instructions: `Say this exactly, in Hebrew, without adding anything else:\n${text}\n\nSpeak naturally. Speech speed: ${speed}.`,
      // guardrail: keep short
      max_output_tokens: 250,
    },
  };
}

// -------------------- WS Session per call --------------------
wss.on("connection", (twilioWs) => {
  const call = {
    streamSid: null,
    callSid: null,
    caller: "",
    called: "",
    callerPhoneLocal: "",
    source: "Voice AI - Nice Line",
    openingPlayed: false,

    state: STATES.ASK_CONSENT,
    consent: "",
    firstName: "",
    lastName: "",
    phoneNumber: "",
    studyTrack: "",

    startedAt: Date.now(),
    lastUserAt: Date.now(),
    finalReason: "",
  };

  const { opening, closing } = scriptTexts();

  // OpenAI WS
  const openaiWs = new WebSocket(openaiWsUrl(getRealtimeModel()), {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      // Keep beta header because Realtime is still under that in docs; matches new schema.
      "OpenAI-Beta": "realtime=v1",
    },
  });

  let openaiReady = false;
  let responseInProgress = false;

  function markUserActivity() {
    call.lastUserAt = Date.now();
  }

  function cleanupAndClose() {
    try {
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
    } catch {}
    try {
      if (twilioWs && twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
    } catch {}
  }

  function setState(next) {
    call.state = next;
    logInfo("[STATE]", next, next === STATES.ASK_CONSENT ? "| waiting user" : "");
  }

  function speak(text) {
    if (!openaiReady) return;
    if (responseInProgress) return; // avoid "conversation_already_has_active_response"
    responseInProgress = true;
    logBot(text);
    openaiWs.send(JSON.stringify(responseSpeakEvent(text)));
  }

  function finishCall(reason) {
    call.finalReason = reason || call.finalReason || "completed_flow";
    // prepare final payload but DO NOT send twice
    const finalPayload = {
      update_type: "lead_final",
      first_name: call.firstName || "",
      last_name: call.lastName || "",
      phone_number: call.phoneNumber || "",
      study_track: call.studyTrack || "",
      caller_id: call.caller || "",
      caller_phone_local: call.callerPhoneLocal || "",
      called: call.called || "",
      callSid: call.callSid || "",
      streamSid: call.streamSid || "",
      call_status: call.phoneNumber || call.firstName ? "שיחה מלאה" : "שיחה חלקית",
      call_status_code: call.phoneNumber || call.firstName ? "completed" : "partial",
      recording_url: "", // we keep empty; we provide recording_public_url
      recording_public_url: "",
      source: call.source,
      timestamp: nowIso(),
      reason: call.finalReason || "completed_flow",
      remarks: `סטטוס: ${call.phoneNumber || call.firstName ? "שיחה מלאה" : "שיחה חלקית"} | consent: ${call.consent || ""} | name: ${[call.firstName, call.lastName].filter(Boolean).join(" ")}`,
    };

    if (call.callSid) {
      // Create pending entry and wait briefly for recording callback to attach URL
      pendingFinalByCallSid.set(call.callSid, { finalPayload, sent: false, recordingSid: null });

      // If recording callback doesn't arrive fast, send anyway (single webhook)
      setTimeout(() => {
        sendFinalOnce(call.callSid);
      }, 3500);
    }

    // close twilio stream
    cleanupAndClose();
  }

  // --- OpenAI events ---
  openaiWs.on("open", () => {
    logInfo("OpenAI WS open");
    // Configure session with correct schema
    openaiWs.send(JSON.stringify(buildSessionUpdate()));
    openaiReady = true;

    // If Twilio did NOT play opening, speak from Render (recorded + same voice)
    // Twilio passes opening_played=1 if it already said the opening.
    if (!call.openingPlayed) {
      // We want the opening to include the consent question.
      speak(opening);
      setState(STATES.ASK_CONSENT);
    }
  });

  openaiWs.on("message", (buf) => {
    const msg = safeJsonParse(buf.toString("utf8"));
    if (!msg) return;

    // Response finished -> allow next speak
    if (msg.type === "response.completed" || msg.type === "response.done") {
      responseInProgress = false;
      return;
    }

    // This is where input audio transcription arrives in new schema:
    // conversation.item.input_audio_transcription.completed / delta
    if (msg.type === "conversation.item.input_audio_transcription.completed") {
      const text = (msg.transcript || msg.text || "").trim();
      if (text) {
        markUserActivity();
        logUser(text);
        handleUserText(text);
      }
      return;
    }

    // Some backends emit: conversation.item.input_audio_transcription.delta
    if (msg.type === "conversation.item.input_audio_transcription.delta") {
      // ignore deltas; we want completed
      return;
    }

    if (msg.type === "error") {
      logError("OpenAI error", msg);
      // if session failed, we must stop or we will be silent
      finishCall("openai_error");
      return;
    }
  });

  openaiWs.on("close", () => {
    logInfo("OpenAI WS closed");
  });

  // --- Twilio events ---
  twilioWs.on("message", (data) => {
    const msg = safeJsonParse(data.toString("utf8"));
    if (!msg) return;

    if (msg.event === "start") {
      call.streamSid = msg.start?.streamSid || call.streamSid;
      call.callSid = msg.start?.callSid || call.callSid;
      call.caller = msg.start?.customParameters?.caller || msg.start?.caller || "";
      call.called = msg.start?.customParameters?.called || msg.start?.called || "";
      call.source = msg.start?.customParameters?.source || call.source || "Voice AI - Nice Line";

      const openingPlayed = msg.start?.customParameters?.opening_played;
      call.openingPlayed = String(openingPlayed || "") === "1";

      // local caller phone
      const callerDigits = normalizeIsraeliPhoneDigits(call.caller);
      call.callerPhoneLocal = callerDigits.startsWith("0") ? callerDigits : (callerDigits ? ("0" + callerDigits.replace(/^972/, "")) : "");

      logInfo("CALL start", {
        streamSid: call.streamSid,
        callSid: call.callSid,
        caller: call.caller,
        called: call.called,
        callerPhoneLocal: call.callerPhoneLocal,
      });

      // If Twilio played opening already, we still need to ask consent question ONCE
      // but only if your MB_OPENING_TEXT in Twilio doesn't include it.
      // To avoid duplicates: if opening_played=1, we ask a short consent question only.
      if (call.openingPlayed && openaiReady) {
        setState(STATES.ASK_CONSENT);
        speak("רק לוודא — זה בסדר מבחינתכם?");
      } else {
        setState(STATES.ASK_CONSENT);
      }

      return;
    }

    if (msg.event === "media") {
      // Forward Twilio audio payload to OpenAI as input audio buffer
      // New schema: input_audio_buffer.append
      if (openaiReady) {
        openaiWs.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: msg.media.payload, // base64
          })
        );
      }
      return;
    }

    if (msg.event === "stop") {
      logInfo("Twilio stop", { streamSid: call.streamSid, callSid: call.callSid });
      finishCall("twilio_stop");
      return;
    }
  });

  twilioWs.on("close", () => {
    // Twilio hung up
    finishCall("ws_close");
  });

  // -------------------- Core logic: handle user text --------------------
  function isYes(t) {
    return /^(כן|כן\.|יאפ|בטח|ברור|אוקיי|בסדר)$/i.test(t.trim());
  }
  function isNo(t) {
    return /^(לא|לא\.|ממש לא|לא תודה)$/i.test(t.trim());
  }

  function handleUserText(text) {
    const t = text.trim();

    // idle timers optional (simple)
    const maxCallMs = Number(MB_MAX_CALL_MS || 240000);
    if (Date.now() - call.startedAt > maxCallMs) {
      speak("תודה רבה. נסיים כאן כדי לשמור על זמן השיחה. יום טוב.");
      return finishCall("max_call");
    }

    if (call.state === STATES.ASK_CONSENT) {
      if (isYes(t)) {
        call.consent = "yes";
        setState(STATES.ASK_NAME);
        speak("מצוין. איך קוראים לכם? אפשר שם פרטי ושם משפחה.");
        return;
      }
      if (isNo(t)) {
        call.consent = "no";
        speak("בסדר גמור, תודה רבה ויום נעים.");
        return finishCall("consent_no");
      }
      // unclear
      speak("רק לוודא — האם זה בסדר מבחינתכם שנשאל כמה שאלות קצרות כדי שנוכל לחזור אליכם?");
      return;
    }

    if (call.state === STATES.ASK_NAME) {
      const name = normalizeHeName(t);
      // naive split
      const parts = name.split(" ").filter(Boolean);
      call.firstName = parts[0] || "";
      call.lastName = parts.slice(1).join(" ") || "";
      setState(STATES.CONFIRM_NAME);
      speak(`רשמתי את השם: ${[call.firstName, call.lastName].filter(Boolean).join(" ")}. זה נכון?`);
      return;
    }

    if (call.state === STATES.CONFIRM_NAME) {
      if (isYes(t)) {
        setState(STATES.CONFIRM_CALLER_LAST4);
        // confirm caller last4
        const last4 = last4Spaced(call.callerPhoneLocal || call.caller);
        speak(`אני רואה שהשיחה הגיעה ממספר שמסתיים ב-${last4}. זה המספר הנכון לחזור אליכם?`);
        return;
      }
      // treat as corrected name
      const name = normalizeHeName(t);
      const parts = name.split(" ").filter(Boolean);
      call.firstName = parts[0] || "";
      call.lastName = parts.slice(1).join(" ") || "";
      speak(`רשמתי את השם: ${[call.firstName, call.lastName].filter(Boolean).join(" ")}. זה נכון?`);
      return;
    }

    if (call.state === STATES.CONFIRM_CALLER_LAST4) {
      if (isYes(t)) {
        call.phoneNumber = normalizeIsraeliPhoneDigits(call.caller);
        // DONE -> closing
        setState(STATES.DONE);
        speak(closing);
        return finishCall("completed_flow");
      }
      if (isNo(t)) {
        speak("אוקיי. אנא אמרו את מספר הטלפון לחזרה, ספרה ספרה.");
        // simple: next user utterance will be the phone, reuse ASK_TRACK slot or keep in same state by overriding:
        call.state = "ASK_PHONE_MANUAL";
        return;
      }
      // unclear
      speak("רק לוודא — זה המספר הנכון לחזור אליכם? כן או לא.");
      return;
    }

    if (call.state === "ASK_PHONE_MANUAL") {
      const digits = normalizeIsraeliPhoneDigits(t);
      if (digits.length < 9) {
        speak("לא הצלחתי לקלוט מספר מלא. אנא אמרו שוב את המספר לחזרה, לאט.");
        return;
      }
      call.phoneNumber = digits;
      setState(STATES.DONE);
      speak(closing);
      return finishCall("completed_flow");
    }
  }
});

// Health
app.get("/health", (req, res) => res.status(200).send("ok"));
