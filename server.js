require("dotenv").config();
const express = require("express");
const WebSocket = require("ws");
const Twilio = require("twilio");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 10000;

// ===== ENV =====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-realtime";
const OPENAI_VOICE = process.env.OPENAI_VOICE || "cedar";

const MB_WEBHOOK_URL = process.env.MB_WEBHOOK_URL || "";
const MB_DEBUG = String(process.env.MB_DEBUG || "false") === "true";

const MB_CLOSING_TEXT =
  process.env.MB_CLOSING_TEXT ||
  "תּוֹדָה רַבָּה, הַפְּרָטִים נִשְׁמְרוּ. נְצִיג הַמֶּרְכָּז יַחֲזֹר אֲלֵיכֶם בְּהֶקְדֵּם. יוֹם טוֹב.";

const MB_CONVERSATION_PROMPT_RAW = process.env.MB_CONVERSATION_PROMPT || "{}";

const MB_ENABLE_RECORDING = String(process.env.MB_ENABLE_RECORDING || "false") === "true";
const MB_RECORDING_STATUS_CALLBACK_URL = process.env.MB_RECORDING_STATUS_CALLBACK_URL || "";

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";

const MB_IDLE_WARNING_MS = Number(process.env.MB_IDLE_WARNING_MS || 25000);
const MB_IDLE_HANGUP_MS = Number(process.env.MB_IDLE_HANGUP_MS || 55000);
const MB_MAX_CALL_MS = Number(process.env.MB_MAX_CALL_MS || 240000);

const MB_VAD_THRESHOLD = Number(process.env.MB_VAD_THRESHOLD || 0.65);
const MB_VAD_PREFIX_MS = Number(process.env.MB_VAD_PREFIX_MS || 200);
const MB_VAD_SILENCE_MS = Number(process.env.MB_VAD_SILENCE_MS || 900);
const MB_VAD_SUFFIX_MS = Number(process.env.MB_VAD_SUFFIX_MS || 200);

function log(...args) { console.log(...args); }

function safeJsonParse(str, fallback) { try { return JSON.parse(str); } catch { return fallback; } }
function nowIso() { return new Date().toISOString(); }

async function postToMake(payload) {
  if (!MB_WEBHOOK_URL) return { ok: false, reason: "no_webhook" };
  try {
    const res = await fetch(MB_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const txt = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, body: txt || "", reason: res.ok ? "make_ok" : "make_http_error" };
  } catch (e) {
    return { ok: false, reason: "make_fetch_error", error: String(e) };
  }
}

// ===== per-call store =====
const calls = new Map();
/*
calls[callSid] = {
  startedAt, streamSid, caller_id, called, source,
  opening_played,
  lead: { first_name,last_name,phone_number,study_track },
  call_status, call_status_code, reason, remarks,
  recording_url,
  ended, sentToMake, waitRecordingTimer
}
*/

function ensureCallRecord(callSid, base) {
  if (!callSid) return null;
  if (!calls.has(callSid)) {
    calls.set(callSid, {
      startedAt: nowIso(),
      streamSid: base.streamSid || "",
      caller_id: base.caller || "",
      called: base.called || "",
      source: base.source || "Voice AI - Nice Line",
      opening_played: base.opening_played || "0",
      lead: { first_name: "", last_name: "", phone_number: "", study_track: "" },
      call_status: "",
      call_status_code: "",
      reason: "",
      remarks: "",
      recording_url: "",
      ended: false,
      sentToMake: false,
      waitRecordingTimer: null,
    });
  } else {
    const c = calls.get(callSid);
    c.streamSid = base.streamSid || c.streamSid;
    c.caller_id = base.caller || c.caller_id;
    c.called = base.called || c.called;
    c.source = base.source || c.source;
    c.opening_played = base.opening_played || c.opening_played || "0";
  }
  return calls.get(callSid);
}

function buildFinalPayload(callSid) {
  const c = calls.get(callSid) || {};
  const lead = c.lead || {};
  return {
    update_type: "lead_final",
    first_name: lead.first_name || "",
    last_name: lead.last_name || "",
    phone_number: lead.phone_number || "",
    study_track: lead.study_track || "",
    source: c.source || "Voice AI - Nice Line",
    timestamp: nowIso(),

    // ✅ IMPORTANT: caller_id is the CUSTOMER
    caller_id: c.caller_id || "",
    // ✅ called is the BOT number
    called: c.called || "",

    callSid,
    streamSid: c.streamSid || "",
    call_status: c.call_status || "",
    call_status_code: c.call_status_code || "",
    reason: c.reason || "",
    recording_url: c.recording_url || "",
    remarks: c.remarks || "",
  };
}

async function finalizeAndSendOnce(callSid) {
  const c = calls.get(callSid);
  if (!c || c.sentToMake) return;
  c.sentToMake = true;

  const payload = buildFinalPayload(callSid);
  log("[INFO] CRM> sending FINAL", payload);
  const result = await postToMake(payload);
  log("[INFO] CRM> final result", result);
}

function scheduleFinalizeWaitingRecording(callSid) {
  const c = calls.get(callSid);
  if (!c) return;

  // if recording disabled or already have recording_url -> send immediately
  if (!MB_ENABLE_RECORDING || c.recording_url) {
    finalizeAndSendOnce(callSid);
    return;
  }

  if (c.waitRecordingTimer) clearTimeout(c.waitRecordingTimer);
  c.waitRecordingTimer = setTimeout(() => {
    c.waitRecordingTimer = null;
    finalizeAndSendOnce(callSid);
  }, 9000);
}

// ===== Recording callback =====
app.post("/twilio-recording-callback", async (req, res) => {
  const callSid = req.body.CallSid || req.body.callSid || "";
  const recordingUrl = req.body.RecordingUrl || req.body.recordingUrl || "";
  log("[INFO] RECORDING callback", { callSid, recordingUrl });

  if (callSid && calls.has(callSid)) {
    const c = calls.get(callSid);
    c.recording_url = recordingUrl || c.recording_url || "";

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

app.get("/health", (req, res) => res.json({ ok: true, time: nowIso() }));

const server = app.listen(PORT, () => log("[INFO] ✅ Server running on port", PORT));

// ===== OpenAI WS connect =====
function openaiWsConnect() {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`;
  return new WebSocket(url, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } });
}

function sendOpenAi(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(obj));
  return true;
}

function normalizeText(s) { return String(s || "").trim(); }

function detectTrack(text) {
  const t = normalizeText(text).toLowerCase();

  if (t.includes("רבנות")) return "רבנות";
  if (t.includes("דיינות") || t.includes("דיינ")) return "דיינות";
  if (t.includes("טוען")) return "טוען רבני";

  if (/rabbanut|rabb?anut|rabba\s?nut/i.test(t)) return "רבנות";
  if (/dayanut|dayan/i.test(t)) return "דיינות";
  if (/toen|rabani/i.test(t)) return "טוען רבני";

  return "";
}

function extractPhone(text) {
  const digits = normalizeText(text).replace(/\D/g, "");
  if (digits.length >= 9 && digits.length <= 15) return digits;
  return "";
}

function isYes(text) {
  const t = normalizeText(text).toLowerCase();
  return ["כן", "בטח", "בסדר", "אוקיי", "ok", "okay", "yes", "sure"].some(x => t === x || t.includes(x));
}
function isNo(text) {
  const t = normalizeText(text).toLowerCase();
  return ["לא", "לא רוצה", "no", "nope"].some(x => t === x || t.includes(x));
}

function buildSystemPrompt() {
  const j = safeJsonParse(MB_CONVERSATION_PROMPT_RAW, {});
  const sys = (j && typeof j.system === "string") ? j.system : "";
  return [
    sys,
    "",
    "כללים טכניים:",
    "- הפתיח נקרא ע\"י Twilio לפני הסטרים. אסור לשכתב פתיח.",
    "- הסגירה נקראת מהסביבה MB_CLOSING_TEXT מילה במילה.",
    "- קצר, ברור, לשון רבים בלבד."
  ].join("\n");
}

function ttsExact(openaiWs, text) {
  sendOpenAi(openaiWs, {
    type: "response.create",
    response: {
      modalities: ["audio", "text"], // ✅ must be both
      instructions: `קראו מילה במילה, ללא שינוי, בדיוק כך:\n${text}`,
      temperature: 0.7, // ✅ >= 0.6
    },
  });
}

// ===== Twilio Media Stream WS =====
const wss = new WebSocket.Server({ server, path: "/twilio-media-stream" });

wss.on("connection", (twilioWs) => {
  let callSid = "";
  let streamSid = "";
  let caller = "";
  let called = "";
  let source = "Voice AI - Nice Line";
  let opening_played = "0";

  let openaiWs = null;

  // state machine
  let state = "WAIT_START"; // -> ASK_CONSENT -> ASK_TRACK -> ASK_FIRST -> ASK_LAST -> ASK_PHONE_CHOICE -> ASK_PHONE -> DONE
  let lastUserHeardAt = Date.now();
  let callStartedAt = Date.now();
  let idleWarningSent = false;

  function setLeadField(key, val) {
    const c = calls.get(callSid);
    if (!c) return;
    c.lead[key] = val;
  }

  function endAndFinalize(reasonCode) {
    const c = calls.get(callSid);
    if (c) {
      c.ended = true;
      // אם לא הצלחנו להגיע ל-DONE זה partial
      if (!c.call_status_code) {
        c.call_status = "שיחה חלקית";
        c.call_status_code = "partial";
      }
      c.reason = reasonCode || c.reason || "twilio_stop";
      const lead = c.lead || {};
      c.remarks = `מסלול: ${lead.study_track || ""} | סטטוס: ${c.call_status} | caller: ${c.caller_id || ""} | callSid: ${callSid}`;
      scheduleFinalizeWaitingRecording(callSid);
    }

    try { twilioWs.close(); } catch {}
    try { if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close(); } catch {}
  }

  function askNext() {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;

    if (state === "ASK_CONSENT") {
      // Twilio כבר הקריא פתיח. פה רק שאלה קצרה של הסכמה:
      ttsExact(openaiWs, "זֶה בְּסֵדֶר מִבַּחִינַתְכֶם? אֶפְשָׁר לַעֲנוֹת רַק כֵּן אוֹ לֹא.");
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
      ttsExact(openaiWs, 'לְאֵיזֶה מִסְפָּר תִּרְצוּ שֶׁנַּחֲזֹר? אֶפְשָׁר לוֹמַר "לַמִּסְפָּר הַמְּזֻהֶה", אוֹ לְהַקְרִיא מִסְפָּר אֶחָד.');
      return;
    }
    if (state === "ASK_PHONE") {
      ttsExact(openaiWs, "בְּסֵדֶר. אֲנָא הַקְרִיאוּ אֶת מִסְפָּר הַטֶּלֶפוֹן לַחֲזָרָה.");
      return;
    }
    if (state === "DONE") {
      const c = calls.get(callSid);
      if (c) {
        c.call_status = "שיחה מלאה";
        c.call_status_code = "completed";
        c.reason = "flow_done";
      }
      ttsExact(openaiWs, MB_CLOSING_TEXT);
      setTimeout(() => endAndFinalize("flow_done"), 1200);
    }
  }

  function handleUserText(userText) {
    lastUserHeardAt = Date.now();
    const t = normalizeText(userText);
    const lower = t.toLowerCase();

    // תשובה גנרית להתחכמויות ושאלות
    if (
      lower.includes("מי אתה") || lower.includes("מי את") ||
      lower.includes("מה אתה") || lower.includes("מה את") ||
      lower.includes("לא רוצה להשאיר") || lower.includes("לא רוצה פרטים")
    ) {
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        ttsExact(openaiWs, "אֲנִי מַעֲרֶכֶת רִישּׁוּם בִּלְבַד. נָצִיג יַחֲזֹר אֲלֵיכֶם עִם כָּל הַהֶסְבֵּרִים.");
        setTimeout(() => askNext(), 500);
      }
      return;
    }

    if (state === "ASK_CONSENT") {
      if (isYes(t)) { state = "ASK_TRACK"; askNext(); }
      else if (isNo(t)) {
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          ttsExact(openaiWs, "הַבָּנְתִּי. בְּלִי אִשּׁוּר לֹא נוּכַל לְהַמְשִׁיךְ. יוֹם טוֹב.");
          setTimeout(() => endAndFinalize("no_consent"), 900);
        }
      } else {
        ttsExact(openaiWs, "רַק לוֹדֵא: אֶפְשָׁר לַעֲנוֹת רַק כֵּן אוֹ לֹא.");
      }
      return;
    }

    if (state === "ASK_TRACK") {
      const track = detectTrack(t);
      if (track) { setLeadField("study_track", track); state = "ASK_FIRST"; askNext(); }
      else {
        ttsExact(openaiWs, "אֶפְשָׁר לִבְחֹר אֶחָד מִשְּׁלֹשָׁה: רַבָּנוּת, דַּיָּנוּת, אוֹ טוֹעֵן רַבָּנִי.");
        setTimeout(() => askNext(), 400);
      }
      return;
    }

    if (state === "ASK_FIRST") {
      if (extractPhone(t)) { ttsExact(openaiWs, "רַק שֵׁם פְּרָטִי בַּשָּׁלָב הַזֶּה, בְּבַקָּשָׁה."); return; }
      setLeadField("first_name", t);
      state = "ASK_LAST";
      askNext();
      return;
    }

    if (state === "ASK_LAST") {
      if (extractPhone(t)) { ttsExact(openaiWs, "רַק שֵׁם מִשְׁפָּחָה בַּשָּׁלָב הַזֶּה, בְּבַקָּשָׁה."); return; }
      setLeadField("last_name", t);
      state = "ASK_PHONE_CHOICE";
      askNext();
      return;
    }

    if (state === "ASK_PHONE_CHOICE") {
      if (lower.includes("מזוהה") || lower.includes("המספר המזוהה") || lower.includes("למזוהה")) {
        setLeadField("phone_number", (caller || "").replace(/\D/g, ""));
        state = "DONE";
        askNext();
        return;
      }
      const p = extractPhone(t);
      if (p) { setLeadField("phone_number", p); state = "DONE"; askNext(); }
      else { state = "ASK_PHONE"; askNext(); }
      return;
    }

    if (state === "ASK_PHONE") {
      const p = extractPhone(t);
      if (p) { setLeadField("phone_number", p); state = "DONE"; askNext(); }
      else ttsExact(openaiWs, "לֹא הִצְלַחְתִּי לִקְלֹט מִסְפָּר. אֲנָא הַקְרִיאוּ שׁוּב לְאַט וּבְרֹרוּת.");
      return;
    }
  }

  // Timers
  const interval = setInterval(() => {
    const now = Date.now();

    if (now - callStartedAt > MB_MAX_CALL_MS) {
      const c = calls.get(callSid);
      if (c) { c.call_status = "שיחה חלקית"; c.call_status_code = "partial"; c.reason = "max_call_timeout"; }
      endAndFinalize("max_call_timeout");
      return;
    }

    const idleFor = now - lastUserHeardAt;
    if (!idleWarningSent && idleFor > MB_IDLE_WARNING_MS && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      idleWarningSent = true;
      ttsExact(openaiWs, "רַק בּוֹדֵק — אַתֶּם אִתָּנוּ?");
    }
    if (idleFor > MB_IDLE_HANGUP_MS) {
      const c = calls.get(callSid);
      if (c) { c.call_status = "שיחה חלקית"; c.call_status_code = "partial"; c.reason = "idle_timeout"; }
      endAndFinalize("idle_timeout");
    }
  }, 500);

  // Twilio WS
  twilioWs.on("message", async (msg) => {
    let data;
    try { data = JSON.parse(msg); } catch { return; }

    if (data.event === "start") {
      streamSid = data.start.streamSid || "";
      callSid = data.start.callSid || "";

      const params = data.start.customParameters || {};
      caller = params.caller || "";
      called = params.called || "";
      source = params.source || source;
      opening_played = params.opening_played || "0";

      log("[INFO] CALL start", { streamSid, callSid, caller, called, callerPhoneLocal: (caller || "").replace("+972","0") });

      const c = ensureCallRecord(callSid, { streamSid, caller, called, source, opening_played });

      // Start recording (optional)
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

      // OpenAI per-call
      try {
        openaiWs = openaiWsConnect();

        openaiWs.on("open", () => {
          if (MB_DEBUG) log("[DEBUG] OpenAI WS open");

          sendOpenAi(openaiWs, {
            type: "session.update",
            session: {
              type: "realtime",
              model: OPENAI_MODEL,
              instructions: buildSystemPrompt(),
              temperature: 0.7,
              modalities: ["audio", "text"], // ✅ correct
              audio: { output: { voice: OPENAI_VOICE } },
              turn_detection: {
                type: "server_vad",
                threshold: MB_VAD_THRESHOLD,
                prefix_padding_ms: MB_VAD_PREFIX_MS,
                silence_duration_ms: MB_VAD_SILENCE_MS,
                suffix_padding_ms: MB_VAD_SUFFIX_MS
              }
            }
          });

          // Start flow:
          // Since Twilio already said opening, we always start from consent question.
          state = "ASK_CONSENT";
          askNext();
        });

        openaiWs.on("message", (raw) => {
          let evt;
          try { evt = JSON.parse(raw); } catch { return; }

          if (evt.type === "response.output_audio.delta" && evt.delta) {
            twilioWs.send(JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: evt.delta }
            }));
          }

          // Handle user transcription events (we accept multiple shapes to be safe)
          if (evt.type === "response.output_audio_transcript.done" && evt.transcript) {
            const userText = String(evt.transcript || "").trim();
            if (userText) {
              log("[INFO] USER>", userText);
              handleUserText(userText);
            }
          }
          if (evt.type === "conversation.item.input_audio_transcription.completed" && evt.transcript) {
            const userText = String(evt.transcript || "").trim();
            if (userText) {
              log("[INFO] USER>", userText);
              handleUserText(userText);
            }
          }

          if (evt.type === "error") {
            log("[ERROR] OpenAI error", evt);
            endAndFinalize("openai_error");
          }
        });

      } catch (e) {
        log("[ERROR] failed to init OpenAI WS", String(e));
        endAndFinalize("openai_connect_failed");
      }
      return;
    }

    if (data.event === "media") {
      if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
      sendOpenAi(openaiWs, { type: "input_audio_buffer.append", audio: data.media.payload });
      return;
    }

    if (data.event === "stop") {
      const c = calls.get(callSid);
      if (c) {
        c.ended = true;
        if (!c.call_status_code) { c.call_status = "שיחה חלקית"; c.call_status_code = "partial"; }
        c.reason = "twilio_stop";
      }
      scheduleFinalizeWaitingRecording(callSid); // ✅ only at end
      try { if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close(); } catch {}
      try { twilioWs.close(); } catch {}
      return;
    }
  });

  twilioWs.on("close", () => {
    clearInterval(interval);
    const c = calls.get(callSid);
    if (c && !c.ended) {
      c.ended = true;
      if (!c.call_status_code) { c.call_status = "שיחה חלקית"; c.call_status_code = "partial"; }
      c.reason = "twilio_ws_close";
      scheduleFinalizeWaitingRecording(callSid);
    }
    try { if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close(); } catch {}
  });
});
