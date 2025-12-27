/**
 * Niceline – MisterBot Realtime Voice (MALAM)
 * Twilio Media Streams <-> OpenAI Realtime API
 *
 * Fixes:
 * 1) twilio dependency is required (recordings + auth)
 * 2) OpenAI modalities must be ['audio','text'] (NOT ['audio'] alone)
 * 3) Send MAKE webhook only ONCE at call end, with recording_url included if available
 */

require("dotenv").config();
const express = require("express");
const WebSocket = require("ws");
const Twilio = require("twilio");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;

// ========= ENV =========
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-realtime";
const OPENAI_VOICE = process.env.OPENAI_VOICE || "cedar";

const MB_WEBHOOK_URL = process.env.MB_WEBHOOK_URL || ""; // Make webhook
const MB_DEBUG = String(process.env.MB_DEBUG || "false") === "true";

const MB_OPENING_TEXT = process.env.MB_OPENING_TEXT || "שלום, הגעתם למערכת הרישום של מרכז מל\"מ. כדי שיועץ לימודים יחזור אליכם לבדיקת התאמה, אשאל כמה שאלות קצרות. זה בסדר מבחינתכם?";
const MB_CLOSING_TEXT = process.env.MB_CLOSING_TEXT || "תודה רבה, הפרטים נשמרו. נציג המרכז יחזור אליכם בהקדם. יום טוב.";
const MB_CONVERSATION_PROMPT_RAW = process.env.MB_CONVERSATION_PROMPT || "{}";

const MB_ENABLE_RECORDING = String(process.env.MB_ENABLE_RECORDING || "false") === "true";
const MB_RECORDING_STATUS_CALLBACK_URL = process.env.MB_RECORDING_STATUS_CALLBACK_URL || ""; // e.g. https://niceline.onrender.com/twilio-recording-callback

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";

const MB_IDLE_WARNING_MS = Number(process.env.MB_IDLE_WARNING_MS || 25000);
const MB_IDLE_HANGUP_MS = Number(process.env.MB_IDLE_HANGUP_MS || 55000);
const MB_MAX_CALL_MS = Number(process.env.MB_MAX_CALL_MS || 240000);

const MB_VAD_THRESHOLD = Number(process.env.MB_VAD_THRESHOLD || 0.65);
const MB_VAD_PREFIX_MS = Number(process.env.MB_VAD_PREFIX_MS || 200);
const MB_VAD_SILENCE_MS = Number(process.env.MB_VAD_SILENCE_MS || 900);
const MB_VAD_SUFFIX_MS = Number(process.env.MB_VAD_SUFFIX_MS || 200);

function log(...args) {
  console.log(...args);
}

// ========= Call store (per-call, no global conversation reuse) =========
/**
 * calls[callSid] = {
 *   startedAt,
 *   streamSid,
 *   caller_id,
 *   called,
 *   source,
 *   lead: {first_name,last_name,phone_number,study_track},
 *   call_status, call_status_code, reason,
 *   recording_url,
 *   ended: boolean,
 *   sentToMake: boolean,
 *   waitRecordingTimer: NodeJS.Timeout | null,
 * }
 */
const calls = new Map();

function safeJsonParse(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

function nowIso() {
  return new Date().toISOString();
}

async function postToMake(payload) {
  if (!MB_WEBHOOK_URL) return { ok: false, reason: "no_webhook" };
  try {
    const res = await fetch(MB_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const txt = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, body: txt || "" , reason: res.ok ? "make_ok" : "make_http_error" };
  } catch (e) {
    return { ok: false, reason: "make_fetch_error", error: String(e) };
  }
}

function buildLeadPayload(callSid, update_type = "lead_final") {
  const c = calls.get(callSid) || {};
  const lead = c.lead || {};
  const payload = {
    update_type,
    first_name: lead.first_name || "",
    last_name: lead.last_name || "",
    phone_number: lead.phone_number || "",
    study_track: lead.study_track || "",
    source: c.source || "Voice AI - Nice Line",
    timestamp: nowIso(),
    caller_id: c.caller_id || "",      // ✅ זה המספר של הלקוח (From)
    called: c.called || "",            // ✅ זה המספר של הבוט (To)
    callSid: callSid || "",
    streamSid: c.streamSid || "",
    call_status: c.call_status || "",
    call_status_code: c.call_status_code || "",
    reason: c.reason || "",
    recording_url: c.recording_url || "",
    remarks: c.remarks || ""
  };
  return payload;
}

async function finalizeAndSendOnce(callSid) {
  const c = calls.get(callSid);
  if (!c) return;

  if (c.sentToMake) return; // ✅ פעם אחת בלבד

  c.sentToMake = true;

  const payload = buildLeadPayload(callSid, "lead_final");
  log("[INFO] CRM> sending FINAL", payload);

  const result = await postToMake(payload);
  log("[INFO] CRM> final result", result);
}

function scheduleFinalizeWaitingRecording(callSid) {
  const c = calls.get(callSid);
  if (!c) return;

  // אם כבר יש recording_url או הקלטה לא מופעלת – שולחים מיד
  if (!MB_ENABLE_RECORDING || c.recording_url) {
    finalizeAndSendOnce(callSid);
    return;
  }

  // אחרת מחכים קצת שה-recording callback יגיע ואז שולחים payload אחד שמכיל recording_url
  if (c.waitRecordingTimer) clearTimeout(c.waitRecordingTimer);

  c.waitRecordingTimer = setTimeout(() => {
    c.waitRecordingTimer = null;
    finalizeAndSendOnce(callSid);
  }, 9000); // 9 שניות המתנה (מספיק ברוב המקרים)
}

// ========= Health =========
app.get("/health", (req, res) => {
  res.json({ ok: true, time: nowIso() });
});

// ========= Twilio Recording Callback (server-side) =========
// Twilio will call this endpoint when recording is ready (if you set RecordingStatusCallback)
app.post("/twilio-recording-callback", async (req, res) => {
  // Twilio sends x-www-form-urlencoded by default, but express.json won't parse it.
  // In practice, many people configure Twilio callback to send form-encoded.
  // We'll accept both: if body is empty, try manual parsing.
  try {
    // If your Render has only json parser, Twilio might not parse -> you can add urlencoded middleware.
    // We'll add it below too.
    res.status(200).send("ok");
  } catch {
    res.status(200).send("ok");
  }
});

// add urlencoded to properly parse Twilio form callbacks
app.use(express.urlencoded({ extended: false }));

app.post("/twilio-recording-callback", async (req, res) => {
  const callSid = req.body.CallSid || req.body.callSid || "";
  const recordingUrl = req.body.RecordingUrl || req.body.recordingUrl || "";
  log("[INFO] RECORDING callback", { callSid, recordingUrl });

  if (callSid && calls.has(callSid)) {
    const c = calls.get(callSid);
    c.recording_url = recordingUrl || c.recording_url || "";

    // אם השיחה כבר הסתיימה ומחכים להקלטה – שולחים עכשיו
    if (c.ended && !c.sentToMake) {
      if (c.waitRecordingTimer) {
        clearTimeout(c.waitRecordingTimer);
        c.waitRecordingTimer = null;
      }
      await finalizeAndSendOnce(callSid);
    }
  }

  res.status(200).send("ok");
});

// ========= Start server =========
const server = app.listen(PORT, () => {
  log("[INFO] ✅ Server running on port", PORT);
});

// ========= WebSocket server for Twilio Media Streams =========
const wss = new WebSocket.Server({ server, path: "/twilio-media-stream" });

function openaiWsConnect() {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`;

  const ws = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
  });

  return ws;
}

function sendOpenAi(ws, obj) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(obj));
  return true;
}

function normalizeText(s) {
  return String(s || "").trim();
}

// Very simple parsers for lead fields (you can expand later)
function detectTrack(text) {
  const t = normalizeText(text).toLowerCase();

  // Hebrew
  if (t.includes("רבנות")) return "רבנות";
  if (t.includes("דיינות") || t.includes("דיינ")) return "דיינות";
  if (t.includes("טוען") || t.includes("טוען רבני") || t.includes("טוען-רבני")) return "טוען רבני";

  // English-ish
  if (/(dayanut|dayanut|dayanut|dayan)/i.test(t)) return "דיינות";
  if (/(toen|toen rabani|rabani)/i.test(t)) return "טוען רבני";
  if (/(rabbanut|rabb?anut|rabba\s?nut|rabbanut)/i.test(t)) return "רבנות";

  return "";
}

function extractPhone(text) {
  const s = normalizeText(text).replace(/[^\d+]/g, "");
  // Israel numbers often 10 digits starting 05/0
  const digits = s.replace(/\D/g, "");
  if (digits.length >= 9 && digits.length <= 15) return digits;
  return "";
}

function isYes(text) {
  const t = normalizeText(text).toLowerCase();
  return ["כן", "כן.", "יאפ", "בטח", "אוקיי", "ok", "okay", "yes", "yep", "sure"].some(x => t === x || t.includes(x));
}
function isNo(text) {
  const t = normalizeText(text).toLowerCase();
  return ["לא", "לא.", "לא רוצה", "no", "nope", "never"].some(x => t === x || t.includes(x));
}

function buildSystemPrompt() {
  const j = safeJsonParse(MB_CONVERSATION_PROMPT_RAW, {});
  const sys = (j && typeof j.system === "string") ? j.system : "";
  // We keep your rule: opening/closing are NOT to be rewritten by the model.
  return [
    sys,
    "",
    "חוקים טכניים:",
    "- הפתיח מגיע מ-MB_OPENING_TEXT והסגירה מ-MB_CLOSING_TEXT. אסור לשנות/לנסח אותם מחדש.",
    "- תענו קצר וברור. אם מישהו מתחכם: משפט אחד קצר וחזרה לשאלה הנוכחית."
  ].join("\n");
}

function ttsExact(openaiWs, text) {
  // Ask the model to speak EXACTLY this text (best-effort).
  sendOpenAi(openaiWs, {
    type: "response.create",
    response: {
      modalities: ["audio", "text"], // ✅ must be audio+text
      instructions: `קראו מילה במילה, ללא שינוי, בדיוק כך:\n${text}`,
      // temperature must be >= 0.6 according to your error
      temperature: 0.7,
    }
  });
}

wss.on("connection", (twilioWs, req) => {
  let callSid = "";
  let streamSid = "";
  let caller = "";
  let called = "";
  let source = "Voice AI - Nice Line";

  let openaiWs = null;

  // per-call state machine
  let state = "CONSENT"; // CONSENT -> ASK_TRACK -> ASK_FIRST -> ASK_LAST -> ASK_PHONE_CHOICE -> ASK_PHONE -> DONE
  let lastUserHeardAt = Date.now();
  let callStartedAt = Date.now();
  let idleWarningSent = false;

  function ensureCallRecord() {
    if (!callSid) return;
    if (!calls.has(callSid)) {
      calls.set(callSid, {
        startedAt: nowIso(),
        streamSid,
        caller_id: caller,
        called,
        source,
        lead: { first_name: "", last_name: "", phone_number: "", study_track: "" },
        call_status: "",
        call_status_code: "",
        reason: "",
        recording_url: "",
        remarks: "",
        ended: false,
        sentToMake: false,
        waitRecordingTimer: null,
      });
    } else {
      // refresh
      const c = calls.get(callSid);
      c.streamSid = streamSid || c.streamSid;
      c.caller_id = caller || c.caller_id;
      c.called = called || c.called;
      c.source = source || c.source;
    }
  }

  function setLeadField(key, val) {
    ensureCallRecord();
    const c = calls.get(callSid);
    if (!c) return;
    c.lead[key] = val;
  }

  function endCall(reasonCode) {
    ensureCallRecord();
    const c = calls.get(callSid);
    if (c) {
      c.ended = true;
      c.call_status = "שיחה חלקית";
      c.call_status_code = "partial";
      c.reason = reasonCode || "twilio_stop";
      const lead = c.lead || {};
      c.remarks = `מסלול: ${lead.study_track || ""} | סטטוס: ${c.call_status} | caller: ${c.caller_id || ""} | callSid: ${callSid}`;
      scheduleFinalizeWaitingRecording(callSid);
    }

    // tell Twilio to stop the stream
    try {
      twilioWs.close();
    } catch {}

    try {
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
    } catch {}
  }

  function askNext() {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;

    if (state === "CONSENT") {
      ttsExact(openaiWs, MB_OPENING_TEXT);
      return;
    }
    if (state === "ASK_TRACK") {
      ttsExact(openaiWs, "בְּאֵיזֶה מַסְלוּל אַתֶּם מִתְעַנְיְנִים — רַבָּנוּת, דַּיָּנוּת, אוֹ טוֹעֵן רַבָּנִי?");
      return;
    }
    if (state === "ASK_FIRST") {
      ttsExact(openaiWs, "מָה הַשֵּׁם הַפְּרָטִי שֶׁלָּכֶם?");
      return;
    }
    if (state === "ASK_LAST") {
      ttsExact(openaiWs, "וּמָה שֵׁם הַמִּשְׁפָּחָה?");
      return;
    }
    if (state === "ASK_PHONE_CHOICE") {
      ttsExact(openaiWs, `לְאֵיזֶה מִסְפָּר תִּרְצוּ שֶׁנַּחֲזֹר?
אֶפְשָׁר לוֹמַר "לַמִּסְפָּר הַמְּזֻהֶה", אוֹ לְהַקְרִיא מִסְפָּר אֶחָד.`);
      return;
    }
    if (state === "ASK_PHONE") {
      ttsExact(openaiWs, "בְּסֵדֶר. אֲנָא הַקְרִיאוּ אֶת מִסְפָּר הַטֶּלֶפוֹן לַחֲזָרָה.");
      return;
    }
    if (state === "DONE") {
      ttsExact(openaiWs, MB_CLOSING_TEXT);
      // small delay then hangup
      setTimeout(() => endCall("flow_done"), 1200);
      return;
    }
  }

  function handleUserText(userText) {
    lastUserHeardAt = Date.now();
    const t = normalizeText(userText);

    // "התחכמויות" / שאלות כלליות — תשובה קצרה ולחזור לשאלה
    const lower = t.toLowerCase();
    if (
      lower.includes("מי אתה") || lower.includes("מי את") ||
      lower.includes("מה אתה") || lower.includes("מה את") ||
      lower.includes("לא רוצה להשאיר") || lower.includes("לא רוצה פרטים") ||
      lower.includes("bye") || lower.includes("goodbye")
    ) {
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        ttsExact(openaiWs, "אֲנִי מַעֲרֶכֶת רִישּׁוּם בִּלְבַד. נָצִיג יַחֲזֹר אֲלֵיכֶם עִם כָּל הַהֶסְבֵּרִים.");
        setTimeout(() => askNext(), 600);
      }
      return;
    }

    if (state === "CONSENT") {
      if (isYes(t)) {
        state = "ASK_TRACK";
        askNext();
      } else if (isNo(t)) {
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          ttsExact(openaiWs, "הַבָּנְתִּי. בְּלִי אִשּׁוּר לֹא נוּכַל לְהַמְשִׁיךְ. יוֹם טוֹב.");
          setTimeout(() => endCall("no_consent"), 900);
        }
      } else {
        // reprompt
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          ttsExact(openaiWs, "רַק לוֹדֵא: זֶה בְּסֵדֶר מִבַּחִינַתְכֶם? אֶפְשָׁר לַעֲנוֹת רַק כֵּן אוֹ לֹא.");
        }
      }
      return;
    }

    if (state === "ASK_TRACK") {
      const track = detectTrack(t);
      if (track) {
        setLeadField("study_track", track);
        state = "ASK_FIRST";
        askNext();
      } else {
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          ttsExact(openaiWs, "אֶפְשָׁר לִבְחֹר אֶחָד מִשְּׁלֹשָׁה: רַבָּנוּת, דַּיָּנוּת, אוֹ טוֹעֵן רַבָּנִי.");
          setTimeout(() => askNext(), 500);
        }
      }
      return;
    }

    if (state === "ASK_FIRST") {
      // prevent phone mistaken as name
      const maybePhone = extractPhone(t);
      if (maybePhone) {
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          ttsExact(openaiWs, "תּוֹדָה. רַק קֹדֶם — מָה הַשֵּׁם הַפְּרָטִי שֶׁלָּכֶם?");
        }
        return;
      }
      setLeadField("first_name", t);
      state = "ASK_LAST";
      askNext();
      return;
    }

    if (state === "ASK_LAST") {
      const maybePhone = extractPhone(t);
      if (maybePhone) {
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          ttsExact(openaiWs, "רַק שֵׁם מִשְׁפָּחָה בַּשָּׁלָב הַזֶּה, בְּבַקָּשָׁה.");
        }
        return;
      }
      setLeadField("last_name", t);
      state = "ASK_PHONE_CHOICE";
      askNext();
      return;
    }

    if (state === "ASK_PHONE_CHOICE") {
      if (lower.includes("מזוהה") || lower.includes("המספר המזוהה") || lower.includes("למזוהה")) {
        // use caller id
        setLeadField("phone_number", (caller || "").replace(/\D/g, ""));
        state = "DONE";
        askNext();
        return;
      }
      const p = extractPhone(t);
      if (p) {
        setLeadField("phone_number", p);
        state = "DONE";
        askNext();
      } else {
        state = "ASK_PHONE";
        askNext();
      }
      return;
    }

    if (state === "ASK_PHONE") {
      const p = extractPhone(t);
      if (p) {
        setLeadField("phone_number", p);
        state = "DONE";
        askNext();
      } else {
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          ttsExact(openaiWs, "לֹא הִצְלַחְתִּי לִקְלֹט מִסְפָּר. אֲנָא הַקְרִיאוּ שׁוּב לְאַט וּבְרֹרוּת.");
        }
      }
      return;
    }
  }

  // ---- Timers (idle + max call) ----
  const interval = setInterval(() => {
    const now = Date.now();

    if (now - callStartedAt > MB_MAX_CALL_MS) {
      ensureCallRecord();
      const c = calls.get(callSid);
      if (c) {
        c.call_status = "שיחה חלקית";
        c.call_status_code = "partial";
        c.reason = "max_call_timeout";
        c.remarks = `Timeout max call | caller: ${caller} | callSid: ${callSid}`;
      }
      endCall("max_call_timeout");
      return;
    }

    const idleFor = now - lastUserHeardAt;
    if (!idleWarningSent && idleFor > MB_IDLE_WARNING_MS && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      idleWarningSent = true;
      ttsExact(openaiWs, "רַק בּוֹדֵק — אַתֶּם אִתָּנוּ?");
    }
    if (idleFor > MB_IDLE_HANGUP_MS) {
      ensureCallRecord();
      const c = calls.get(callSid);
      if (c) {
        c.call_status = "שיחה חלקית";
        c.call_status_code = "partial";
        c.reason = "idle_timeout";
        c.remarks = `Idle timeout | caller: ${caller} | callSid: ${callSid}`;
      }
      endCall("idle_timeout");
    }
  }, 500);

  // ---- Twilio WS messages ----
  twilioWs.on("message", async (msg) => {
    let data;
    try { data = JSON.parse(msg); } catch { return; }

    if (data.event === "start") {
      streamSid = data.start.streamSid || "";
      callSid = data.start.callSid || "";
      // Custom params
      const params = data.start.customParameters || {};
      caller = params.caller || "";
      called = params.called || "";
      source = params.source || source;

      log("[INFO] CALL start", { streamSid, callSid, caller, called });

      // create call record
      ensureCallRecord();

      // start recording (optional)
      if (MB_ENABLE_RECORDING && TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && callSid) {
        try {
          const client = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
          const rec = await client.calls(callSid).recordings.create({
            recordingStatusCallback: MB_RECORDING_STATUS_CALLBACK_URL || undefined,
            recordingStatusCallbackMethod: "POST",
          });
          log("[INFO] RECORDING>", { ok: true, reason: "recording_started", sid: rec.sid });
        } catch (e) {
          log("[WARN] RECORDING start failed", String(e));
        }
      }

      // OpenAI connect per call
      try {
        openaiWs = openaiWsConnect();

        openaiWs.on("open", () => {
          if (MB_DEBUG) log("[DEBUG] OpenAI WS open");

          // session.update (Realtime GA)
          sendOpenAi(openaiWs, {
            type: "session.update",
            session: {
              type: "realtime",
              model: OPENAI_MODEL,
              instructions: buildSystemPrompt(),
              temperature: 0.7, // ✅ must be >= 0.6
              modalities: ["audio", "text"], // ✅ correct
              audio: {
                output: { voice: OPENAI_VOICE }
              },
              turn_detection: {
                type: "server_vad",
                threshold: MB_VAD_THRESHOLD,
                prefix_padding_ms: MB_VAD_PREFIX_MS,
                silence_duration_ms: MB_VAD_SILENCE_MS,
                suffix_padding_ms: MB_VAD_SUFFIX_MS
              }
            }
          });

          // Start the flow
          state = "CONSENT";
          askNext();
        });

        openaiWs.on("message", (raw) => {
          let evt;
          try { evt = JSON.parse(raw); } catch { return; }

          // stream audio deltas back to Twilio
          if (evt.type === "response.output_audio.delta" && evt.delta) {
            // Twilio expects base64 mu-law chunks
            twilioWs.send(JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: evt.delta }
            }));
          }

          // user transcription comes via output_audio_transcript (when model transcribes) OR input transcription events depending on config
          if (evt.type === "response.output_audio_transcript.done" && evt.transcript) {
            const userText = String(evt.transcript || "").trim();
            if (userText) {
              log("[INFO] USER>", userText);
              handleUserText(userText);
            }
          }

          if (evt.type === "error") {
            log("[ERROR] OpenAI error", evt);
            // do not spam make; just end gracefully
            endCall("openai_error");
          }
        });

        openaiWs.on("close", () => {
          if (MB_DEBUG) log("[DEBUG] OpenAI WS closed");
        });

      } catch (e) {
        log("[ERROR] failed to init OpenAI WS", String(e));
        endCall("openai_connect_failed");
      }

      return;
    }

    if (data.event === "media") {
      // audio from Twilio -> OpenAI
      if (!openaiWs) return;
      if (openaiWs.readyState !== WebSocket.OPEN) return;

      // append audio to OpenAI input buffer
      sendOpenAi(openaiWs, {
        type: "input_audio_buffer.append",
        audio: data.media.payload
      });

      return;
    }

    if (data.event === "stop") {
      // call ended
      ensureCallRecord();
      const c = calls.get(callSid);
      if (c) {
        c.ended = true;
        c.call_status = "שיחה חלקית";
        c.call_status_code = "partial";
        c.reason = "twilio_stop";
        const lead = c.lead || {};
        c.remarks = `מסלול: ${lead.study_track || ""} | סטטוס: ${c.call_status} | caller: ${c.caller_id || ""} | callSid: ${callSid}`;
      }

      // ✅ Send to Make only once, at end (and wait for recording if needed)
      scheduleFinalizeWaitingRecording(callSid);

      try { if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close(); } catch {}
      try { twilioWs.close(); } catch {}
      return;
    }
  });

  twilioWs.on("close", () => {
    clearInterval(interval);
    // if Twilio closed unexpectedly, mark ended and finalize once
    if (callSid) {
      ensureCallRecord();
      const c = calls.get(callSid);
      if (c && !c.ended) {
        c.ended = true;
        c.call_status = "שיחה חלקית";
        c.call_status_code = "partial";
        c.reason = "twilio_ws_close";
        scheduleFinalizeWaitingRecording(callSid);
      }
    }
    try { if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close(); } catch {}
  });

  twilioWs.on("error", (e) => {
    if (MB_DEBUG) log("[DEBUG] Twilio WS error", String(e));
  });
});
