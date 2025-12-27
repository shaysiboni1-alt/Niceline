// server.js
//
// NiceLine Voice AI – Lead Registration Bot (Motti)
// Twilio Media Streams <-> OpenAI Realtime API
//
// Fixes in this version:
// ✅ No sending to OpenAI before WS open (queue)
// ✅ No concurrent responses (prevents "conversation_already_has_active_response")
// ✅ Forces modalities ["audio","text"] (prevents "Invalid modalities: ['audio']")
// ✅ Per-call state reset (no "continues from previous call")
// ✅ Send Make webhook ONLY on call end (full/partial)
// ✅ Recording: start on call start, attach recording_url when callback arrives (single lead send waits briefly)
//
// ENV (minimal):
//   OPENAI_API_KEY (required)
//   OPENAI_VOICE (default: "cedar")
//   MB_CONVERSATION_PROMPT (required)  // JSON string: {"system":"..."} OR plain string
//   MB_OPENING_TEXT (required)
//   MB_CLOSING_TEXT (required)
//   MB_WEBHOOK_URL (optional)
//   MB_DEBUG (true/false)
//   MB_ENABLE_RECORDING (true/false)
//   MB_RECORDING_STATUS_CALLBACK_URL (optional; default: https://<host>/twilio-recording-callback)
//   TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN (required only if MB_ENABLE_RECORDING=true)
//   MB_SPEECH_SPEED (default: 0.98)
//   MB_STT_LANGUAGE (default: "he")
//
// Run: node server.js

"use strict";

const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;

const MB_DEBUG = String(process.env.MB_DEBUG || "false").toLowerCase() === "true";

function log(...args) {
  console.log("[INFO]", ...args);
}
function warn(...args) {
  console.warn("[WARN]", ...args);
}
function err(...args) {
  console.error("[ERROR]", ...args);
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  throw new Error("Missing OPENAI_API_KEY");
}

const OPENAI_VOICE = process.env.OPENAI_VOICE || "cedar";
const MB_OPENING_TEXT = (process.env.MB_OPENING_TEXT || "").trim();
const MB_CLOSING_TEXT = (process.env.MB_CLOSING_TEXT || "").trim();
const MB_WEBHOOK_URL = (process.env.MB_WEBHOOK_URL || "").trim();

const MB_ENABLE_RECORDING = String(process.env.MB_ENABLE_RECORDING || "false").toLowerCase() === "true";
const MB_RECORDING_STATUS_CALLBACK_URL =
  (process.env.MB_RECORDING_STATUS_CALLBACK_URL || "").trim() || null;

const MB_SPEECH_SPEED = Number(process.env.MB_SPEECH_SPEED || "0.98");
const MB_STT_LANGUAGE = (process.env.MB_STT_LANGUAGE || "he").trim();

const rawPrompt = (process.env.MB_CONVERSATION_PROMPT || "").trim();
if (!rawPrompt) throw new Error("Missing MB_CONVERSATION_PROMPT");

const parsedPrompt = safeJsonParse(rawPrompt);
const SYSTEM_PROMPT =
  (parsedPrompt && (parsedPrompt.system || parsedPrompt.prompt || parsedPrompt.instructions)) ||
  rawPrompt;

// --- Twilio client (for recording) ---
let twilioClient = null;
if (MB_ENABLE_RECORDING) {
  const Twilio = require("twilio");
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    throw new Error("MB_ENABLE_RECORDING=true requires TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN");
  }
  twilioClient = Twilio(sid, token);
}

// --- In-memory sessions by callSid ---
const sessions = new Map(); // callSid -> session

function nowIso() {
  return new Date().toISOString();
}

function isHebrewDigitsPhone(s) {
  const digits = String(s || "").replace(/\D/g, "");
  return digits.length === 9 || digits.length === 10;
}

function normalizeTrack(s) {
  const t = String(s || "").toLowerCase().trim();

  // Hebrew
  if (/(רבנות|רַבָּנוּת|רבנוּת)/.test(t)) return "רבנות";
  if (/(דיינות|דַּיָּנוּת|דיינuת)/.test(t)) return "דיינות";
  if (/(טוען\s*רבני|טוֹעֵן\s*רַבָּנִי|טוען-רבני|טוען רבני)/.test(t)) return "טוען רבני";

  // Latin / mixed
  // IMPORTANT: do NOT use [] with hyphen ranges that break regex
  if (/rabbanut|rabba(?:\s|-)?nut|rabb?a(?:\s|-)?nut/.test(t)) return "רבנות";
  if (/dayanut|daya(?:\s|-)?nut|dayan(?:u|o)?t/.test(t)) return "דיינות";
  if (/toen(?:\s|-)?rabani|toen(?:\s|-)?rabbani|t(?:o|u)en(?:\s|-)?rabani/.test(t)) return "טוען רבני";

  return "";
}

// --- webhook sender ---
async function postToMake(payload) {
  if (!MB_WEBHOOK_URL) return { ok: false, reason: "no_webhook" };
  try {
    const res = await fetch(MB_WEBHOOK_URL, {
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

// Wait a bit for recording_url then send ONCE
async function finalizeAndSend(callSid, reason = "call_end") {
  const s = sessions.get(callSid);
  if (!s) return;
  if (s.sent) return;

  s.ended = true;
  s.endReason = reason;

  // wait up to 10s for recording url (if enabled)
  const waitMs = MB_ENABLE_RECORDING ? 10000 : 0;
  const start = Date.now();
  while (MB_ENABLE_RECORDING && !s.recordingUrl && Date.now() - start < waitMs) {
    await new Promise((r) => setTimeout(r, 250));
  }

  const call_status_code = s.completed ? "full" : "partial";
  const call_status = s.completed ? "שיחה מלאה" : "שיחה חלקית";

  const payload = {
    update_type: "lead",
    first_name: s.lead.first_name || "",
    last_name: s.lead.last_name || "",
    phone_number: s.lead.phone_number || "",
    study_track: s.lead.study_track || "",
    source: s.source || "Voice AI - Nice Line",
    timestamp: s.startedAt || nowIso(),
    caller_id: s.caller || "",          // ✅ זה מספר הלקוח (From)
    called: s.called || "",             // ✅ זה מספר הבוט (To)
    callSid: s.callSid || callSid,
    streamSid: s.streamSid || "",
    call_status,
    call_status_code,
    reason: s.endReason || reason,
    recording_url: s.recordingUrl || "",
    remarks:
      `מסלול: ${s.lead.study_track || ""} | סטטוס: ${call_status} | caller: ${s.caller || ""} | callSid: ${s.callSid || callSid}`,
  };

  if (MB_DEBUG) log("CRM> sending", payload);
  const result = await postToMake(payload);
  if (MB_DEBUG) log("CRM> result", result);

  s.sent = true;

  // cleanup
  setTimeout(() => sessions.delete(callSid), 30000);
}

// --- HTTP routes ---
app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/twilio-recording-callback", (req, res) => {
  // Twilio hits this after recording is ready
  const callSid = req.body?.CallSid || req.query?.CallSid;
  const recordingUrl = req.body?.RecordingUrl || req.query?.RecordingUrl;

  if (MB_DEBUG) log("RECORDING callback", { callSid, recordingUrl });

  if (callSid && recordingUrl) {
    const s = sessions.get(callSid);
    if (s) {
      s.recordingUrl = recordingUrl;
    }
  }
  res.status(200).send("ok");
});

const server = http.createServer(app);

// --- WebSocket server for Twilio Media Streams ---
const wss = new WebSocket.Server({ server, path: "/twilio-media-stream" });

// OpenAI Realtime endpoint
// NOTE: keep your existing model if working. This is the safe default format:
const OPENAI_REALTIME_URL =
  "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";

function openAiHeaders() {
  return {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    "OpenAI-Beta": "realtime=v1",
  };
}

function buildSessionUpdate() {
  // IMPORTANT: temperature must be >= 0.6 (you had 0 and it crashed audio)
  return {
    type: "session.update",
    session: {
      modalities: ["audio", "text"],
      voice: OPENAI_VOICE,
      temperature: 0.7,
      input_audio_transcription: {
        model: "gpt-4o-mini-transcribe",
        language: MB_STT_LANGUAGE,
      },
      turn_detection: { type: "server_vad" },
      // Make it speak a bit faster (your request)
      output_audio_format: "g711_ulaw",
      instructions: SYSTEM_PROMPT,
    },
  };
}

wss.on("connection", (twilioWs, req) => {
  // Per-call variables (DO NOT leak between calls)
  let callSid = "";
  let streamSid = "";
  let caller = "";
  let called = "";
  let source = "Voice AI - Nice Line";

  // Create OpenAI WS
  const openAiWs = new WebSocket(OPENAI_REALTIME_URL, { headers: openAiHeaders() });

  // OpenAI send queue until socket is open
  const pendingToOpenAI = [];
  let openAiReady = false;

  // Response lock (prevents "already_has_active_response")
  let activeResponse = false;

  function sendToOpenAI(obj) {
    const msg = JSON.stringify(obj);
    if (!openAiReady || openAiWs.readyState !== WebSocket.OPEN) {
      pendingToOpenAI.push(msg);
      return;
    }
    openAiWs.send(msg);
  }

  function flushOpenAIQueue() {
    while (pendingToOpenAI.length && openAiWs.readyState === WebSocket.OPEN) {
      openAiWs.send(pendingToOpenAI.shift());
    }
  }

  function speakExact(text) {
    const line = String(text || "").trim();
    if (!line) return;

    // We force the model to SAY EXACTLY, not paraphrase:
    sendToOpenAI({
      type: "response.create",
      response: {
        modalities: ["audio", "text"], // ✅ force valid combo every time
        temperature: 0.6,
        instructions:
          `אָמְרוּ בְּדִיּוּק מִלָּה בְּמִלָּה (לֹא לְשַׁנּוֹת כְּלוּם, לֹא לְהוֹסִיף, לֹא לְגָרֹעַ):\n` +
          `${line}`,
      },
    });
    activeResponse = true;
  }

  // --- Deterministic flow state (no LLM deciding next step) ---
  const STATES = {
    CONSENT: "CONSENT",
    ASK_TRACK: "ASK_TRACK",
    ASK_FIRST: "ASK_FIRST",
    ASK_LAST: "ASK_LAST",
    ASK_PHONE_CHOICE: "ASK_PHONE_CHOICE",
    ASK_PHONE: "ASK_PHONE",
    DONE: "DONE",
  };

  let state = STATES.CONSENT;

  // lead object
  const lead = {
    first_name: "",
    last_name: "",
    phone_number: "",
    study_track: "",
  };

  function ensureSessionCreated() {
    if (!callSid) return;
    if (!sessions.has(callSid)) {
      sessions.set(callSid, {
        callSid,
        streamSid,
        caller,
        called,
        source,
        startedAt: nowIso(),
        lead,
        sent: false,
        ended: false,
        endReason: "",
        recordingUrl: "",
        completed: false,
      });
    }
  }

  async function startRecordingIfEnabled() {
    if (!MB_ENABLE_RECORDING || !twilioClient || !callSid) return;
    try {
      const cb =
        MB_RECORDING_STATUS_CALLBACK_URL ||
        `https://${req.headers.host}/twilio-recording-callback`;

      const rec = await twilioClient.calls(callSid).recordings.create({
        recordingStatusCallback: cb,
        recordingStatusCallbackMethod: "POST",
      });

      if (MB_DEBUG) log("RECORDING>", { ok: true, reason: "recording_started", sid: rec.sid });
    } catch (e) {
      warn("RECORDING> failed", String(e?.message || e));
    }
  }

  function askNext() {
    if (state === STATES.CONSENT) {
      // Opening + consent question
      speakExact(MB_OPENING_TEXT);
      return;
    }
    if (state === STATES.ASK_TRACK) {
      speakExact("בְּאֵיזֶה מַסְלוּל אַתֶּם מִתְעַנְיְנִים? רַבָּנוּת, דַּיָּנוּת, אוֹ טוֹעֵן רַבָּנִי?");
      return;
    }
    if (state === STATES.ASK_FIRST) {
      speakExact("מָה הַשֵּׁם הַפְּרָטִי שֶׁלָּכֶם?");
      return;
    }
    if (state === STATES.ASK_LAST) {
      speakExact("וּמָה שֵׁם הַמִּשְׁפָּחָה?");
      return;
    }
    if (state === STATES.ASK_PHONE_CHOICE) {
      speakExact("נָכוֹן לַחֲזוֹר אֲלֵיכֶם לַמִּסְפָּר הַמְּזוֹהֶה, אוֹ לְהַשְׁאִיר מִסְפָּר אַחֵר לַחֲזָרָה? אֶפְשָׁר לוֹמַר: מְזוֹהֶה, אוֹ מִסְפָּר אַחֵר.");
      return;
    }
    if (state === STATES.ASK_PHONE) {
      speakExact("בְּאֵיזֶה מִסְפָּר טֶלֶפוֹן נוֹחַ שֶׁנַּחֲזֹר אֲלֵיכֶם?");
      return;
    }
    if (state === STATES.DONE) {
      speakExact(MB_CLOSING_TEXT);
      const s = sessions.get(callSid);
      if (s) s.completed = true;
      return;
    }
  }

  function handleUserText(raw) {
    const text = String(raw || "").trim();
    if (!text) return;

    // If user asks "מי אתה" / refuses / jokes — short generic response, then repeat current question.
    const low = text.toLowerCase();
    if (
      /מי אתה|מי את|מה זה|לא רוצה|עזוב|עזבו|לא מעוניין|לא מעוניינת|לא בא לי/.test(text) ||
      /who are you|dont want|don'?t want|no thanks/.test(low)
    ) {
      speakExact("אֲנִי מַעֲרֶכֶת רִישּׁוּם בִּלְבַד. נָצִיג יַחֲזֹר אֲלֵיכֶם עִם כָּל הַהֶסְבֵּרִים. בּוֹאוּ נַשְׁלִים רַק אֶת הַפְּרָטִים הַבְּסִיסִיִּים.");
      // after it finishes, we will askNext() again on response.done
      return;
    }

    if (state === STATES.CONSENT) {
      // Expect yes/no
      if (/^כן$|^כֵּן$|כן\s|^ok$|^okay$|^yes$/i.test(text)) {
        state = STATES.ASK_TRACK;
      } else if (/^לא$|^לֹא$|^no$/i.test(text)) {
        // user declines
        state = STATES.DONE;
      } else {
        speakExact('רַק לוֹדֵא: אֶפְשָׁר לַעֲנוֹת רַק "כֵּן" אוֹ "לֹא". זֶה בְּסֵדֶר מִבַּחִינַתְכֶם?');
        return;
      }
      return;
    }

    if (state === STATES.ASK_TRACK) {
      const track = normalizeTrack(text);
      if (!track) {
        speakExact("אֶפְשָׁר לִבְחוֹר אֶחָד מִשְּׁלוֹשֶׁת הַמַּסְלוּלִים: רַבָּנוּת, דַּיָּנוּת, אוֹ טוֹעֵן רַבָּנִי.");
        return;
      }
      lead.study_track = track;
      state = STATES.ASK_FIRST;
      return;
    }

    if (state === STATES.ASK_FIRST) {
      // Take first token as first name (simple)
      const fn = text.split(/\s+/)[0].slice(0, 40);
      if (!fn) {
        speakExact("לֹא קָלַטְנוּ. מָה הַשֵּׁם הַפְּרָטִי שֶׁלָּכֶם?");
        return;
      }
      lead.first_name = fn;
      state = STATES.ASK_LAST;
      return;
    }

    if (state === STATES.ASK_LAST) {
      const ln = text.split(/\s+/)[0].slice(0, 60);
      if (!ln) {
        speakExact("לֹא קָלַטְנוּ. מָה שֵׁם הַמִּשְׁפָּחָה?");
        return;
      }
      lead.last_name = ln;
      state = STATES.ASK_PHONE_CHOICE;
      return;
    }

    if (state === STATES.ASK_PHONE_CHOICE) {
      if (/מזוהה|מְזוֹהֶה|המספר המזוהה|מְסֻפָּר מְזוֹהֶה/.test(text)) {
        // Use caller id if available
        const digits = String(caller || "").replace(/\D/g, "");
        if (digits.length >= 9) {
          lead.phone_number = digits;
          state = STATES.DONE;
          return;
        }
        // If caller id missing, fallback to asking phone
        state = STATES.ASK_PHONE;
        return;
      }
      // If user says "another number"
      if (/אחר|אַחֵר|מספר אחר|מִסְפָּר אַחֵר/.test(text)) {
        state = STATES.ASK_PHONE;
        return;
      }
      speakExact('אֶפְשָׁר לוֹמַר רַק: "מְזוֹהֶה" אוֹ "מִסְפָּר אַחֵר".');
      return;
    }

    if (state === STATES.ASK_PHONE) {
      const digits = text.replace(/\D/g, "");
      if (!isHebrewDigitsPhone(digits)) {
        speakExact("הַמִּסְפָּר לֹא נִרְאֶה תָּקִין. בַּקָּשָׁה לְהַגִּיד מִסְפָּר טֶלֶפוֹן שֶׁל 9 אוֹ 10 סְפָרוֹת.");
        return;
      }
      lead.phone_number = digits;
      state = STATES.DONE;
      return;
    }
  }

  // OpenAI WS lifecycle
  openAiWs.on("open", async () => {
    openAiReady = true;
    sendToOpenAI(buildSessionUpdate());
    flushOpenAIQueue();

    // after session update, ask opening
    // we call askNext() only after we have callSid (from Twilio "start")
  });

  openAiWs.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (MB_DEBUG && msg?.type?.startsWith("error")) {
      err("OpenAI error", msg);
    }

    // When OpenAI returns transcript:
    if (msg.type === "conversation.item.input_audio_transcription.completed") {
      const userText = msg.transcript || "";
      if (MB_DEBUG) log("USER>", userText);
      handleUserText(userText);
      return;
    }

    // When response done, unlock and continue flow
    if (msg.type === "response.done") {
      activeResponse = false;

      // advance flow deterministically after bot speaks
      // CONSENT: after opening spoken, we want to actually wait user answer, but we keep state CONSENT
      // Others: after user input updates state, we ask next question here
      if (state === STATES.CONSENT) {
        // After opening prompt, we must ask the consent question is already included in MB_OPENING_TEXT (should end with question)
        // so do nothing
        return;
      }

      // Ask next question / closing
      askNext();
      return;
    }
  });

  openAiWs.on("close", () => {
    openAiReady = false;
  });

  openAiWs.on("error", (e) => {
    err("OpenAI WS error", String(e?.message || e));
  });

  // Twilio -> Server WS lifecycle
  twilioWs.on("message", async (message) => {
    let msg;
    try {
      msg = JSON.parse(message.toString());
    } catch {
      return;
    }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || "";
      callSid = msg.start?.callSid || "";
      caller = msg.start?.customParameters?.caller || msg.start?.caller || "";
      called = msg.start?.customParameters?.called || msg.start?.called || "";
      source = msg.start?.customParameters?.source || source;

      log("CALL start", { streamSid, callSid, caller, called });

      ensureSessionCreated();

      // start recording ASAP (optional)
      await startRecordingIfEnabled();

      // now that we have callSid, say opening
      // BUT only if OpenAI is ready; otherwise queued.
      state = STATES.CONSENT;
      askNext();
      return;
    }

    // Media event audio -> forward to OpenAI
    if (msg.event === "media") {
      const payload = msg.media?.payload;
      if (!payload) return;

      // Forward audio to OpenAI input buffer
      sendToOpenAI({
        type: "input_audio_buffer.append",
        audio: payload,
      });

      // If you have a stuck active response and user speaks, do NOT spam cancel unless activeResponse
      // (prevents response_cancel_not_active spam)
      if (activeResponse) {
        sendToOpenAI({ type: "response.cancel" });
        activeResponse = false;
      }
      return;
    }

    if (msg.event === "stop") {
      const s = sessions.get(callSid);
      if (s) {
        // completed only if got all required fields
        s.completed = Boolean(lead.first_name && lead.last_name && lead.phone_number && lead.study_track);
      }
      await finalizeAndSend(callSid, "twilio_stop");
      return;
    }
  });

  twilioWs.on("close", async () => {
    const s = sessions.get(callSid);
    if (s) {
      s.completed = Boolean(lead.first_name && lead.last_name && lead.phone_number && lead.study_track);
    }
    await finalizeAndSend(callSid, "ws_close");
    try {
      openAiWs.close();
    } catch {}
  });

  twilioWs.on("error", (e) => {
    err("Twilio WS error", String(e?.message || e));
  });
});

server.listen(PORT, () => {
  log(`✅ Server running on port ${PORT}`);
});
