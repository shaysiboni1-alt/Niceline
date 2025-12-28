/**
 * server.js — NiceLine / מרכז מל״מ
 * Twilio Media Streams <-> OpenAI Realtime (GA style)
 *
 * Fixes:
 * - No auto-responses (turn_detection.create_response=false)
 * - Opening & consent from Render (MB_OPENING_TEXT) for consistent tone + recorded
 * - Single webhook only (lead_final) — no recording_update webhook
 * - Better Hebrew transcription
 */

const express = require("express");
const WebSocket = require("ws");

const app = express();
app.use(express.json());

// ===== ENV (do not rename) =====
const {
  OPENAI_API_KEY,
  OPENAI_REALTIME_MODEL = "gpt-realtime",
  OPENAI_VOICE = "cedar",
  MAKE_WEBHOOK_URL,

  MB_CONVERSATION_PROMPT = "",
  MB_OPENING_TEXT = 'שלום, הגעתם למערכת הרישום של מרכז מל״מ. כדי שיועץ לימודים יחזור אליכם לבדיקת התאמה, אשאל כמה שאלות קצרות.',
  MB_CLOSING_TEXT = "תודה רבה, הפרטים נרשמו. נציג המרכז יחזור אליכם בהקדם. יום טוב.",

  PUBLIC_BASE_URL = "https://niceline.onrender.com",

  // Recording
  MB_ENABLE_RECORDING = "true",
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,

  // Speech tuning
  MB_SPEECH_SPEED = "1.12",         // slightly faster
  MB_STT_LANGUAGE = "he",           // transcription hint
  MB_DEBUG = "true",
} = process.env;

const DEBUG = String(MB_DEBUG).toLowerCase() === "true";
const ENABLE_RECORDING = String(MB_ENABLE_RECORDING).toLowerCase() === "true";

// ===== helpers =====
function logInfo(...args) { console.log("[INFO]", ...args); }
function logErr(...args) { console.error("[ERROR]", ...args); }

function nowIso() { return new Date().toISOString(); }

function normalizeLocalIL(msisdn) {
  // expects +9725XXXXXXXX or 05XXXXXXXX etc
  if (!msisdn) return "";
  const s = String(msisdn).trim();
  if (s.startsWith("+972")) {
    const rest = s.slice(4);
    if (rest.startsWith("0")) return rest; // uncommon
    return "0" + rest;
  }
  return s.replace(/[^\d]/g, "");
}

function digitsOnly(s) {
  return String(s || "").replace(/[^\d]/g, "");
}

function isValidILPhoneLocal(s) {
  const d = digitsOnly(s);
  return d.length >= 9 && d.length <= 10;
}

function last4Spaced(localPhone) {
  const d = digitsOnly(localPhone);
  const last4 = d.slice(-4);
  return last4.split("").join(" ");
}

function cleanNameToken(s) {
  return String(s || "")
    .replace(/[.,"׳״]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitName(full) {
  const s = cleanNameToken(full);
  if (!s) return { first: "", last: "" };
  const parts = s.split(" ").filter(Boolean);
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

async function postToMake(payload) {
  if (!MAKE_WEBHOOK_URL) return { ok: false, reason: "no_make_url" };
  try {
    const res = await fetch(MAKE_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body, reason: "make_ok" };
  } catch (e) {
    return { ok: false, reason: "make_fetch_error", error: String(e) };
  }
}

// ===== Twilio Recording via REST API (start) =====
async function startTwilioRecording(callSid) {
  if (!ENABLE_RECORDING) return { ok: false, reason: "recording_disabled" };
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return { ok: false, reason: "twilio_auth_missing" };
  try {
    // Twilio API: POST /Calls/{CallSid}/Recordings.json
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}/Recordings.json`;
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        RecordingStatusCallback: `${PUBLIC_BASE_URL}/recording-callback`,
        RecordingStatusCallbackMethod: "POST",
        RecordingStatusCallbackEvent: "completed",
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: "twilio_recording_start_failed", status: res.status, data };
    return { ok: true, reason: "recording_started", sid: data.sid || "" };
  } catch (e) {
    return { ok: false, reason: "twilio_recording_start_error", error: String(e) };
  }
}

// ===== public recording proxy (so it won't ask for user/pass) =====
app.get("/recording/:sid.mp3", async (req, res) => {
  const sid = req.params.sid;
  if (!sid || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    return res.status(404).send("Not found");
  }
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Recordings/${sid}.mp3`;
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
    const r = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!r.ok) return res.status(502).send("Upstream error");
    res.setHeader("Content-Type", "audio/mpeg");
    const buf = Buffer.from(await r.arrayBuffer());
    res.send(buf);
  } catch (e) {
    res.status(500).send("Error");
  }
});

// Twilio Recording callback (we store it, but we DO NOT send a second webhook)
const recordingByCallSid = new Map(); // callSid -> { recordingSid, recordingUrl, recordingPublicUrl }
app.post("/recording-callback", (req, res) => {
  const callSid = req.body.CallSid || req.body.callSid || "";
  const recordingSid = req.body.RecordingSid || req.body.recordingSid || "";
  const recordingUrl = req.body.RecordingUrl || req.body.recordingUrl || ""; // without .mp3 usually

  logInfo("RECORDING callback", { callSid, recordingUrl, recordingSid });

  if (callSid) {
    const publicUrl = recordingSid ? `${PUBLIC_BASE_URL}/recording/${recordingSid}.mp3` : "";
    recordingByCallSid.set(callSid, {
      recordingSid,
      recordingUrl: recordingSid ? `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Recordings/${recordingSid}.mp3` : "",
      recordingPublicUrl: publicUrl,
    });
  }

  res.status(200).send("OK");
});

// ===== WS server for Twilio Media Stream =====
const server = app.listen(process.env.PORT || 10000, () => {
  logInfo("Listening on port", process.env.PORT || 10000);
});

const wss = new WebSocket.Server({ server, path: "/twilio-media-stream" });

// ===== OpenAI Realtime WS =====
function openaiWsUrl() {
  // GA docs show wss://api.openai.com/v1/realtime?model=...
  return `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`;
}

function makeSystemPrompt() {
  // IMPORTANT: MB_CONVERSATION_PROMPT is used as-is. (No renaming)
  // Also: keep it short and flow-safe; the state machine decides what to ask.
  const base = String(MB_CONVERSATION_PROMPT || "").trim();
  return base || "אתם עוזר רישום טלפוני קצר, בעברית, בטון אנושי וחם. עונים קצר וברור.";
}

wss.on("connection", async (twilioWs, req) => {
  // Twilio passes params in query? actually Stream <Parameter> arrives in start event; we parse from 'start' message.
  let call = {
    streamSid: "",
    callSid: "",
    caller: "",
    called: "",
    callerPhoneLocal: "",
    source: "Voice AI - Nice Line",
  };

  // lead data
  let lead = {
    consent: "",
    first_name: "",
    last_name: "",
    phone_number: "",
    study_track: "",
  };

  // recording data
  let recording = { recordingSid: "", recording_url: "", recording_public_url: "" };

  // state machine
  const STATE = {
    ASK_CONSENT: "ASK_CONSENT",
    ASK_NAME: "ASK_NAME",
    CONFIRM_NAME: "CONFIRM_NAME",
    CONFIRM_CALLER_LAST4: "CONFIRM_CALLER_LAST4",
    DONE: "DONE",
  };
  let state = STATE.ASK_CONSENT;

  // OpenAI WS
  const oai = new WebSocket(openaiWsUrl(), {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
  });

  let openaiReady = false;
  let responseActive = false;
  let currentResponseId = null;
  let speechQueue = [];
  let transcriptBuffer = "";

  function enqueueSpeech(text) {
    const t = String(text || "").trim();
    if (!t) return;
    speechQueue.push(t);
    if (DEBUG) logInfo("BOT>", t);
    tryDequeueSpeech();
  }

  function tryDequeueSpeech() {
    if (!openaiReady) return;
    if (responseActive) return;
    const next = speechQueue.shift();
    if (!next) return;

    responseActive = true;
    currentResponseId = null;

    // Create a response (audio output expected)
    // NOTE: We do NOT request auto-modalities here; session is configured for audio output.
    oai.send(JSON.stringify({
      type: "response.create",
      response: {
        instructions: next,
      }
    }));
  }

  function cancelActiveResponse() {
    if (!responseActive) return;
    try {
      oai.send(JSON.stringify({ type: "response.cancel" }));
    } catch (_) {}
    responseActive = false;
    currentResponseId = null;
  }

  function setState(next) {
    if (DEBUG) logInfo("[STATE]", state, "->", next);
    state = next;
  }

  function finalize(reason) {
    // decide completed/partial
    const completed =
      lead.consent === "yes" &&
      !!lead.first_name &&
      !!lead.last_name &&
      isValidILPhoneLocal(lead.phone_number);

    const call_status_code = completed ? "completed" : "partial";
    const call_status = completed ? "שיחה מלאה" : "שיחה חלקית";

    // try attach recording if exists now
    const rec = recordingByCallSid.get(call.callSid);
    if (rec) {
      recording.recordingSid = rec.recordingSid || "";
      recording.recording_url = rec.recordingUrl || "";
      recording.recording_public_url = rec.recordingPublicUrl || "";
    }

    const payload = {
      update_type: "lead_final",
      first_name: lead.first_name,
      last_name: lead.last_name,
      phone_number: lead.phone_number,
      study_track: lead.study_track,

      caller_id: call.caller,
      caller_phone_local: call.callerPhoneLocal,
      called: call.called,

      callSid: call.callSid,
      streamSid: call.streamSid,

      call_status,
      call_status_code,

      recording_url: recording.recording_url || "",
      recording_public_url: recording.recording_public_url || "",

      source: call.source,
      timestamp: nowIso(),
      reason,
      remarks: `סטטוס: ${call_status} | consent: ${lead.consent} | name: ${lead.first_name} ${lead.last_name}`.trim(),
    };

    logInfo("CRM> sending FINAL", payload);
    postToMake(payload).then((r) => logInfo("CRM> final result", r)).catch(() => {});
  }

  // ===== OpenAI events =====
  oai.on("open", () => {
    logInfo("OpenAI WS open");

    // Configure session (GA style)
    // Key point: create_response=false to prevent the model from responding on its own.
    oai.send(JSON.stringify({
      type: "session.update",
      session: {
        type: "realtime",
        model: OPENAI_REALTIME_MODEL,
        instructions: makeSystemPrompt(),
        audio: {
          output: { voice: OPENAI_VOICE },
        },
        // Twilio Media Streams are g711_ulaw by default
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",

        // ✅ Prevent "bot talking to itself"
        turn_detection: { type: "server_vad", create_response: false },

        // transcription
        input_audio_transcription: {
          model: "gpt-4o-mini-transcribe",
          language: MB_STT_LANGUAGE || "he",
        }
      }
    }));

    openaiReady = true;

    // If Twilio did NOT play opening, we do it here (consistent voice & recorded)
    enqueueSpeech(`${MB_OPENING_TEXT} האם זה בסדר מבחינתכם?`);
  });

  oai.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    const t = msg.type;

    if (t === "error") {
      logErr("OpenAI error", msg);
      // if model errors mid-call, end politely
      enqueueSpeech("מצטערים, הייתה תקלה טכנית. אפשר לנסות שוב בעוד רגע. יום טוב.");
      setTimeout(() => {
        try { twilioWs.close(); } catch (_) {}
      }, 400);
      return;
    }

    // Audio output from model -> send to Twilio
    if (t === "response.output_audio.delta") {
      const audioB64 = msg.delta;
      if (audioB64) {
        twilioWs.send(JSON.stringify({
          event: "media",
          streamSid: call.streamSid,
          media: { payload: audioB64 }
        }));
      }
      return;
    }

    if (t === "response.done") {
      responseActive = false;
      currentResponseId = null;
      tryDequeueSpeech();
      return;
    }

    // Transcription completed event (GA emits conversation.item...; some accounts also emit conversation.input_audio_transcription.completed)
    if (t === "conversation.item.audio_transcription.completed" || t === "conversation.input_audio_transcription.completed") {
      const text = (msg.transcript || msg.text || "").trim();
      if (text) {
        logInfo("USER>", text);
        handleUserText(text);
      }
      return;
    }

    // Some deployments send these deltas:
    if (t === "conversation.input_audio_transcription.delta") {
      transcriptBuffer += (msg.delta || "");
      return;
    }
    if (t === "conversation.input_audio_transcription.completed") {
      const text = (msg.transcript || transcriptBuffer || "").trim();
      transcriptBuffer = "";
      if (text) {
        logInfo("USER>", text);
        handleUserText(text);
      }
      return;
    }
  });

  oai.on("close", () => logInfo("OpenAI WS closed"));

  // ===== Twilio events =====
  twilioWs.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      call.streamSid = msg.start?.streamSid || "";
      call.callSid = msg.start?.callSid || "";
      const params = msg.start?.customParameters || {};
      call.caller = params.caller || "";
      call.called = params.called || "";
      call.source = params.source || call.source;
      call.callerPhoneLocal = normalizeLocalIL(call.caller);

      logInfo("CALL start", {
        streamSid: call.streamSid,
        callSid: call.callSid,
        caller: call.caller,
        called: call.called,
        callerPhoneLocal: call.callerPhoneLocal
      });

      const rec = await startTwilioRecording(call.callSid);
      logInfo("RECORDING>", rec);
      return;
    }

    if (msg.event === "media") {
      // send audio to OpenAI input buffer
      if (!openaiReady) return;
      const payload = msg.media?.payload;
      if (!payload) return;

      // if user speaks while bot speaks -> cancel to reduce "stuck"
      // (optional) for now we cancel on any media while responseActive
      // but Twilio streams bot audio too? no, Twilio sends only inbound caller audio.
      // so it's safe.
      if (responseActive) {
        cancelActiveResponse();
      }

      oai.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: payload
      }));
      return;
    }

    if (msg.event === "stop") {
      logInfo("Twilio stop", { streamSid: msg.streamSid, callSid: call.callSid });
      finalize("twilio_stop");
      try { oai.close(); } catch (_) {}
      return;
    }
  });

  twilioWs.on("close", () => {
    // If Twilio closes without stop, still finalize once.
    finalize("ws_close");
    try { oai.close(); } catch (_) {}
  });

  // ===== User text handler (state machine) =====
  function handleUserText(textRaw) {
    const text = String(textRaw || "").trim();
    if (!text) return;

    const low = text.toLowerCase();

    // global refusal
    if (/(לא רוצה|עזוב|ביי|להתראות)/.test(low)) {
      lead.consent = "no";
      enqueueSpeech("בסדר גמור, תודה רבה ויום נעים.");
      enqueueSpeech(MB_CLOSING_TEXT);
      finalize("consent_no");
      try { twilioWs.close(); } catch (_) {}
      return;
    }

    if (state === STATE.ASK_CONSENT) {
      if (/(כן|בסדר|מאשר|אוקיי|אוקי)/.test(low)) {
        lead.consent = "yes";
        setState(STATE.ASK_NAME);
        enqueueSpeech("מצוין. איך קוראים לכם? אפשר שם פרטי ושם משפחה.");
        return;
      }
      if (/(לא)/.test(low)) {
        lead.consent = "no";
        enqueueSpeech("בסדר גמור, תודה רבה ויום נעים.");
        enqueueSpeech(MB_CLOSING_TEXT);
        finalize("consent_no");
        try { twilioWs.close(); } catch (_) {}
        return;
      }

      // unclear
      enqueueSpeech("רק לוודא — זה בסדר מבחינתכם?");
      return;
    }

    if (state === STATE.ASK_NAME) {
      const { first, last } = splitName(text);
      lead.first_name = first;
      lead.last_name = last;
      setState(STATE.CONFIRM_NAME);
      enqueueSpeech(`רשמתי את השם: ${lead.first_name}${lead.last_name ? " " + lead.last_name : ""}. זה נכון?`);
      return;
    }

    if (state === STATE.CONFIRM_NAME) {
      if (/(כן|נכון|מאשר|אוקיי|אוקי)/.test(low)) {
        setState(STATE.CONFIRM_CALLER_LAST4);
        const last4 = last4Spaced(call.callerPhoneLocal);
        enqueueSpeech(`אני רואה שהשיחה הגיעה ממספר שמסתיים ב-${last4}. זה המספר הנכון לחזור אליכם?`);
        return;
      }
      // treat as correction
      const { first, last } = splitName(text);
      if (first) lead.first_name = first;
      if (last) lead.last_name = last;
      enqueueSpeech(`רשמתי את השם: ${lead.first_name}${lead.last_name ? " " + lead.last_name : ""}. זה נכון?`);
      return;
    }

    if (state === STATE.CONFIRM_CALLER_LAST4) {
      if (/(כן|נכון|מאשר|אוקיי|אוקי)/.test(low)) {
        lead.phone_number = call.callerPhoneLocal;
        setState(STATE.DONE);
        enqueueSpeech(MB_CLOSING_TEXT);
        finalize("completed_flow");
        try { twilioWs.close(); } catch (_) {}
        return;
      }

      // user provided phone
      const phone = digitsOnly(text);
      if (isValidILPhoneLocal(phone)) {
        lead.phone_number = phone;
        setState(STATE.DONE);
        enqueueSpeech(MB_CLOSING_TEXT);
        finalize("completed_flow");
        try { twilioWs.close(); } catch (_) {}
        return;
      }

      // invalid
      enqueueSpeech("לצורך חזרה אני צריך מספר תקין בין תשע לעשר ספרות. אנא אמרו רק ספרות.");
      return;
    }
  }
});
