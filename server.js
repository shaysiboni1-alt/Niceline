// server.js
// Malam – Voice AI (Inbound) – STRICT RECEPTION FLOW
// Twilio Media Streams <-> OpenAI Realtime API
//
// Fixes:
// - OpenAI content type must be "text" (NOT "output_text")
// - Proper audio bridge OpenAI -> Twilio
// - Buffer Twilio audio until OpenAI WS is open (prevents CONNECTING crash)
// - Strong response-lock to avoid "conversation_already_has_active_response"
// - Strict flow: consent -> name -> confirm caller phone -> manual phone -> confirm -> close
// - No email. Always send caller_id + status to Make.
//
// npm i express ws dotenv
// node server.js

require("dotenv").config();
const http = require("http");
const express = require("express");
const WebSocket = require("ws");

/* ------------------------- helpers ------------------------- */
function envStr(name, def = "") {
  const v = process.env[name];
  return v == null || v === "" ? def : String(v);
}
function envNum(name, def) {
  const v = process.env[name];
  if (!v) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function envBool(name, def = false) {
  const v = (process.env[name] || "").toLowerCase();
  if (!v) return def;
  return ["1", "true", "yes", "on"].includes(v);
}
function nowIso() {
  return new Date().toISOString();
}
function digitsOnly(v) {
  return String(v || "").replace(/\D/g, "");
}
function normalizeIsraeliPhone(raw, fallbackCaller) {
  let d = digitsOnly(raw || "");
  if (!d && fallbackCaller) d = digitsOnly(fallbackCaller);
  if (!d) return null;
  if (d.startsWith("972")) d = "0" + d.slice(3);
  if (!/^\d{9,10}$/.test(d)) return null;
  return d;
}
function last4(phoneLocal) {
  const d = digitsOnly(phoneLocal || "");
  return d.length >= 4 ? d.slice(-4) : "";
}
function isYes(text) {
  const t = String(text || "").trim().toLowerCase();
  return ["כן", "כן כן", "בטח", "בוודאי", "נכון", "מאשר", "בסדר", "אוקיי"].some((w) => t === w || t.includes(w));
}
function isNo(text) {
  const t = String(text || "").trim().toLowerCase();
  return ["לא", "לא תודה", "שלילי", "ממש לא", "לא רוצה", "עזוב", "עזבי"].some((w) => t === w || t.includes(w));
}
function looksLikeQuestionAboutInfo(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  const patterns = [
    /מחיר|כמה עולה|תשלום|עלויות/,
    /תוכן|מה לומדים|סילבוס|שיעורים|רב|מרצה/,
    /מועדים|תאריך|פתיחה|מתחיל|הרשמה|קורס/,
    /התאמה|מתאים לי|רמה|דרישות|תנאים/,
    /\?/,
  ];
  return patterns.some((re) => re.test(t));
}
function safeJsonParse(raw, fallback = null) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
async function fetchWithTimeout(url, opts = {}, timeoutMs = 4500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(t);
    return res;
  } finally {
    clearTimeout(t);
  }
}
function renderTemplate(text, vars = {}) {
  let out = String(text || "");
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, "g"), String(v ?? ""));
  }
  return out;
}

/* ------------------------- config ------------------------- */
const PORT = envNum("PORT", 10000);

const OPENAI_API_KEY = envStr("OPENAI_API_KEY", "");
const OPENAI_VOICE = envStr("OPENAI_VOICE", "cedar");

const MB_CONVERSATION_PROMPT_RAW = envStr("MB_CONVERSATION_PROMPT", "");
const MB_WEBHOOK_URL = envStr("MB_WEBHOOK_URL", "").trim();

const MB_DEBUG = envBool("MB_DEBUG", true);

// Noise / VAD
const MB_VAD_THRESHOLD = envNum("MB_VAD_THRESHOLD", 0.65);
const MB_VAD_SILENCE_MS = envNum("MB_VAD_SILENCE_MS", 900);
const MB_VAD_PREFIX_MS = envNum("MB_VAD_PREFIX_MS", 200);
const MB_VAD_SUFFIX_MS = envNum("MB_VAD_SUFFIX_MS", 200);

// Barge-in feel
const MB_ALLOW_BARGE_IN = envBool("MB_ALLOW_BARGE_IN", false);
const MB_NO_BARGE_TAIL_MS = envNum("MB_NO_BARGE_TAIL_MS", 900);

// timers
const MB_IDLE_WARNING_MS = envNum("MB_IDLE_WARNING_MS", 25000);
const MB_IDLE_HANGUP_MS = envNum("MB_IDLE_HANGUP_MS", 55000);
const MB_MAX_CALL_MS = envNum("MB_MAX_CALL_MS", 3 * 60 * 1000);
const MB_MAX_WARN_BEFORE_MS = envNum("MB_MAX_WARN_BEFORE_MS", 25000);
const MB_HANGUP_GRACE_MS = envNum("MB_HANGUP_GRACE_MS", 4500);

// response safety
const MB_RESPONSE_FAILSAFE_MS = envNum("MB_RESPONSE_FAILSAFE_MS", 12000);

function ilog(...a) {
  console.log("[INFO]", ...a);
}
function elog(...a) {
  console.error("[ERROR]", ...a);
}
function dlog(...a) {
  if (MB_DEBUG) console.log("[DEBUG]", ...a);
}

if (!OPENAI_API_KEY) elog("[FATAL] Missing OPENAI_API_KEY");
if (!MB_CONVERSATION_PROMPT_RAW) elog("[FATAL] Missing MB_CONVERSATION_PROMPT");
if (!MB_WEBHOOK_URL) ilog("[WARN] Missing MB_WEBHOOK_URL (Make) – will not push leads.");

/* ------------------------- prompt JSON ------------------------- */
const CONV = safeJsonParse(MB_CONVERSATION_PROMPT_RAW, null);
if (!CONV) {
  elog("[FATAL] MB_CONVERSATION_PROMPT must be valid JSON");
  process.exit(1);
}
function getStr(path, def = "") {
  const parts = path.split(".");
  let cur = CONV;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in cur) cur = cur[p];
    else return def;
  }
  return typeof cur === "string" ? cur : def;
}

/* ------------------------- Make webhook ------------------------- */
async function sendToMake(payload) {
  if (!MB_WEBHOOK_URL) return { ok: false, reason: "make_webhook_not_configured" };
  try {
    const res = await fetchWithTimeout(
      MB_WEBHOOK_URL,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
      4500
    );
    if (!res.ok) return { ok: false, reason: `make_http_${res.status}` };
    return { ok: true, reason: "make_ok" };
  } catch (e) {
    return { ok: false, reason: `make_error_${e?.name || "err"}` };
  }
}

/* ------------------------- server ------------------------- */
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/twilio-media-stream" });

app.get("/health", (_req, res) => res.json({ ok: true, time: nowIso() }));

wss.on("connection", (twilioWs) => {
  let streamSid = "";
  let callSid = "";
  let caller = "";
  let called = "";
  let callerPhoneLocal = "";

  const STATES = {
    CONSENT: "CONSENT",
    ASK_NAME: "ASK_NAME",
    CONFIRM_CALLER_PHONE: "CONFIRM_CALLER_PHONE",
    ASK_PHONE_MANUAL: "ASK_PHONE_MANUAL",
    CONFIRM_PHONE_MANUAL: "CONFIRM_PHONE_MANUAL",
  };
  let state = STATES.CONSENT;

  let openAiReady = false;
  let callEnded = false;
  let leadSent = false;

  let lastMediaTs = Date.now();
  let idleWarned = false;

  // speaking / barge-in
  let botSpeaking = false;
  let noListenUntilTs = 0;

  // buffers
  const inAudioBuffer = [];
  const MAX_IN_AUDIO_BUFFER = 300;

  const outAudioBuffer = [];
  const MAX_OUT_AUDIO_BUFFER = 600;

  // strict response queue lock
  let responseInFlight = false;
  let responseTimer = null;
  const speakQueue = [];

  const lead = {
    first_name: "",
    last_name: "",
    phone_number: "",
    study_track: "",
    source: "Voice AI - Nice Line",
    timestamp: "",
    caller_id: "",
    called: "",
  };

  function logState(note) {
    ilog(`[STATE] ${state}${note ? " | " + note : ""}`);
  }
  function logBot(text) {
    ilog("BOT>", text);
  }
  function logUser(text) {
    ilog("USER>", text);
  }

  function clearInFlight() {
    responseInFlight = false;
    if (responseTimer) {
      clearTimeout(responseTimer);
      responseTimer = null;
    }
  }
  function startInFlightFailsafe() {
    if (responseTimer) clearTimeout(responseTimer);
    responseTimer = setTimeout(() => {
      elog("Response failsafe fired. Releasing in-flight lock.");
      clearInFlight();
      pumpSpeakQueue();
    }, MB_RESPONSE_FAILSAFE_MS);
  }

  function pumpSpeakQueue() {
    if (callEnded) return;
    if (!openAiReady) return;
    if (responseInFlight) return;
    if (speakQueue.length === 0) return;
    if (openAiWs.readyState !== WebSocket.OPEN) return;

    const { text, why } = speakQueue.shift();
    responseInFlight = true;
    startInFlightFailsafe();
    dlog("SPEAK>", why, text);

    // ✅ IMPORTANT: content type must be "text"
    openAiWs.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text }],
        },
      })
    );
    openAiWs.send(JSON.stringify({ type: "response.create" }));
  }

  function speakExact(text, why = "speak") {
    const line = String(text || "").trim();
    if (!line) return;
    speakQueue.push({ text: line, why });
    logBot(line);
    pumpSpeakQueue();
  }

  function askCurrent() {
    const qs = CONV.questions || {};
    if (state === STATES.CONSENT) return speakExact(getStr("opening", ""), "opening_consent");
    if (state === STATES.ASK_NAME) return speakExact(qs.ask_name || "", "ask_name");
    if (state === STATES.CONFIRM_CALLER_PHONE) {
      return speakExact(renderTemplate(qs.confirm_caller_phone || "", { last4: last4(callerPhoneLocal) }), "confirm_caller_phone");
    }
    if (state === STATES.ASK_PHONE_MANUAL) return speakExact(qs.ask_phone_manual || "", "ask_phone_manual");
    if (state === STATES.CONFIRM_PHONE_MANUAL) {
      return speakExact(renderTemplate(qs.confirm_phone_manual || "", { phone: digitsOnly(lead.phone_number) }), "confirm_phone_manual");
    }
  }

  async function deliver(statusHe, statusCode, reason) {
    if (leadSent) return;
    leadSent = true;

    const payload = {
      first_name: lead.first_name || "",
      last_name: lead.last_name || "",
      phone_number: lead.phone_number || "",
      study_track: lead.study_track || "",
      source: lead.source || "Voice AI - Nice Line",
      timestamp: lead.timestamp || nowIso(),

      caller_id: lead.caller_id || caller || "",
      called: lead.called || called || "",
      callSid: callSid || "",
      streamSid: streamSid || "",

      call_status: statusHe,
      call_status_code: statusCode,
      reason: reason || "",

      remarks: `סטטוס: ${statusHe} | caller: ${lead.caller_id || caller || ""} | callSid: ${callSid || ""}`,
    };

    ilog("CRM> sending", payload);
    const r = await sendToMake(payload);
    ilog("CRM> result", r);
    if (!r.ok) elog("CRM> FAILED", r);
  }

  async function finish(statusHe, statusCode, reason) {
    if (callEnded) return;
    callEnded = true;

    await deliver(statusHe, statusCode, reason);

    speakExact(getStr("closing", ""), "closing");

    setTimeout(() => {
      try { openAiWs?.close(); } catch {}
      try { twilioWs?.close(); } catch {}
    }, Math.max(2500, Math.min(MB_HANGUP_GRACE_MS, 9000)));
  }

  function guardrailAndClose() {
    speakExact(getStr("guardrail", "אֲנַחְנוּ מַעֲרֶכֶת רִישּׁוּם בִּלְבַד. נָצִיג יַחֲזֹר אֲלֵיכֶם עִם כָּל הַהֶסְבֵּרִים. יוֹם טוֹב."), "guardrail");
    finish("שיחה חלקית", "partial", "guardrail_question");
  }

  /* ------------------------- OpenAI Realtime WS ------------------------- */
  const openAiWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17", {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" },
  });

  openAiWs.on("open", () => {
    openAiReady = true;

    openAiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          model: "gpt-4o-realtime-preview-2024-12-17",
          modalities: ["audio", "text"],
          voice: OPENAI_VOICE,
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          input_audio_transcription: { model: "whisper-1" },
          turn_detection: {
            type: "server_vad",
            threshold: MB_VAD_THRESHOLD,
            silence_duration_ms: MB_VAD_SILENCE_MS + MB_VAD_SUFFIX_MS,
            prefix_padding_ms: MB_VAD_PREFIX_MS,
          },
          max_response_output_tokens: 120,
          instructions:
            (getStr("system", "") || "") +
            "\n\nחוקים: אתם גבר בשם מוטי. מדברים בלשון רבים בלבד. אין איסוף אימייל. אין לשנות ניסוחים. " +
            "אם נשאלת שאלה על מחיר/תוכן/מועדים/התאמה/הלכה – לענות רק guardrail ואז לסיים.",
        },
      })
    );

    // flush buffered Twilio->OpenAI audio
    while (inAudioBuffer.length) {
      const b64 = inAudioBuffer.shift();
      openAiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
    }

    state = STATES.CONSENT;
    logState("start");
    askCurrent();
  });

  openAiWs.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "response.audio.delta") {
      botSpeaking = true;
      noListenUntilTs = Date.now() + MB_NO_BARGE_TAIL_MS;

      if (!streamSid) {
        outAudioBuffer.push(msg.delta);
        if (outAudioBuffer.length > MAX_OUT_AUDIO_BUFFER) outAudioBuffer.shift();
        return;
      }
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: msg.delta } }));
      return;
    }

    if (msg.type === "response.audio.done" || msg.type === "response.done" || msg.type === "response.completed") {
      botSpeaking = false;
      clearInFlight();
      pumpSpeakQueue();
      return;
    }

    if (msg.type === "conversation.item.input_audio_transcription.completed") {
      const userText = (msg.transcript || "").trim();
      if (!userText || callEnded) return;

      logUser(userText);

      if (looksLikeQuestionAboutInfo(userText) && state !== STATES.CONFIRM_PHONE_MANUAL) {
        guardrailAndClose();
        return;
      }

      if (state === STATES.CONSENT) {
        if (isYes(userText)) {
          state = STATES.ASK_NAME;
          logState("yes");
          askCurrent();
          return;
        }
        if (isNo(userText)) {
          await finish("שיחה חלקית", "not_interested", "consent_no");
          return;
        }
        speakExact(getStr("consent_retry", "רַק לוֹדֵא: זֶה בְּסֵדֶר מִבַּחִינַתְכֶם?"), "consent_retry");
        return;
      }

      if (state === STATES.ASK_NAME) {
        lead.first_name = userText;

        callerPhoneLocal = normalizeIsraeliPhone("", caller) || "";
        if (callerPhoneLocal) {
          state = STATES.CONFIRM_CALLER_PHONE;
          logState("have_caller_phone");
          askCurrent();
        } else {
          state = STATES.ASK_PHONE_MANUAL;
          logState("no_caller_phone");
          askCurrent();
        }
        return;
      }

      if (state === STATES.CONFIRM_CALLER_PHONE) {
        if (isYes(userText)) {
          lead.phone_number = callerPhoneLocal;
          await finish("שיחה מלאה", "completed", "caller_phone_confirmed");
          return;
        }
        if (isNo(userText)) {
          state = STATES.ASK_PHONE_MANUAL;
          logState("caller_phone_no");
          askCurrent();
          return;
        }
        speakExact(getStr("questions.confirm_caller_phone_retry", "אֶפְשָׁר לַעֲנוֹת רַק כֵּן אוֹ לֹא."), "confirm_retry");
        return;
      }

      if (state === STATES.ASK_PHONE_MANUAL) {
        const p = normalizeIsraeliPhone(userText, "");
        if (!p) {
          speakExact(getStr("questions.phone_retry", "סְלִיחָה, אֲנָא אִמְרוּ מִסְפָּר תָּקִין בְּסִפְרוֹת."), "phone_retry");
          return;
        }
        lead.phone_number = p;
        state = STATES.CONFIRM_PHONE_MANUAL;
        logState("got_manual_phone");
        askCurrent();
        return;
      }

      if (state === STATES.CONFIRM_PHONE_MANUAL) {
        if (isYes(userText)) {
          await finish("שיחה מלאה", "completed", "manual_phone_confirmed");
          return;
        }
        if (isNo(userText)) {
          state = STATES.ASK_PHONE_MANUAL;
          logState("manual_phone_no");
          askCurrent();
          return;
        }
        speakExact(getStr("questions.confirm_phone_manual_retry", "אֶפְשָׁר לַעֲנוֹת רַק כֵּן אוֹ לֹא."), "confirm_manual_retry");
        return;
      }
    }

    if (msg.type === "error") {
      const code = msg?.error?.code;
      elog("OpenAI error", msg);

      // IMPORTANT: don't clear lock for "already active" (wait for done)
      if (code === "conversation_already_has_active_response") {
        // just ignore; lock stays
        return;
      }

      // for any other error, release lock and continue queue
      clearInFlight();
      pumpSpeakQueue();
    }
  });

  openAiWs.on("close", async () => {
    if (!callEnded) {
      elog("OpenAI WS closed");
      await finish("שיחה חלקית", "partial", "openai_closed");
    }
  });

  openAiWs.on("error", async (e) => {
    if (!callEnded) {
      elog("OpenAI WS error", e?.message || e);
      await finish("שיחה חלקית", "partial", "openai_ws_error");
    }
  });

  /* ------------------------- idle + max timers ------------------------- */
  const idleInterval = setInterval(async () => {
    if (callEnded) return;
    const since = Date.now() - lastMediaTs;

    if (!idleWarned && since >= MB_IDLE_WARNING_MS) {
      idleWarned = true;
      speakExact(getStr("idle_warning", "רַק לוֹדֵא שֶׁאַתֶּם עִמָּנוּ."), "idle_warning");
    }
    if (since >= MB_IDLE_HANGUP_MS) {
      await finish("שיחה חלקית", "partial", "idle_timeout");
      clearInterval(idleInterval);
    }
  }, 1000);

  let maxWarnT = null;
  let maxEndT = null;
  if (MB_MAX_CALL_MS > 0) {
    if (MB_MAX_WARN_BEFORE_MS > 0 && MB_MAX_CALL_MS > MB_MAX_WARN_BEFORE_MS) {
      maxWarnT = setTimeout(() => {
        if (!callEnded) speakExact(getStr("max_call_warning", ""), "max_call_warning");
      }, MB_MAX_CALL_MS - MB_MAX_WARN_BEFORE_MS);
    }
    maxEndT = setTimeout(async () => {
      if (!callEnded) await finish("שיחה חלקית", "partial", "max_call_duration");
    }, MB_MAX_CALL_MS);
  }

  /* ------------------------- Twilio WS ------------------------- */
  twilioWs.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || "";
      callSid = msg.start?.callSid || "";

      const p = msg.start?.customParameters || {};
      caller = p.caller || "";
      called = p.called || "";

      lead.caller_id = caller || "";
      lead.called = called || "";
      lead.timestamp = nowIso();

      callerPhoneLocal = normalizeIsraeliPhone("", caller) || "";

      ilog("CALL start", { streamSid, callSid, caller, called, callerPhoneLocal });

      // flush buffered OpenAI->Twilio audio
      if (streamSid && outAudioBuffer.length) {
        for (const b64 of outAudioBuffer.splice(0, outAudioBuffer.length)) {
          twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: b64 } }));
        }
      }
      return;
    }

    if (msg.event === "media") {
      lastMediaTs = Date.now();

      const now = Date.now();
      if (!MB_ALLOW_BARGE_IN) {
        if (botSpeaking || now < noListenUntilTs) return;
      }

      const payload = msg.media?.payload;
      if (!payload) return;

      if (!openAiReady || openAiWs.readyState !== WebSocket.OPEN) {
        inAudioBuffer.push(payload);
        if (inAudioBuffer.length > MAX_IN_AUDIO_BUFFER) inAudioBuffer.shift();
        return;
      }

      openAiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: payload }));
      return;
    }

    if (msg.event === "stop") {
      const full = !!(lead.first_name && (lead.phone_number || callerPhoneLocal));
      finish(full ? "שיחה מלאה" : "שיחה חלקית", full ? "completed" : "partial", "twilio_stop");
    }
  });

  twilioWs.on("close", () => {
    clearInterval(idleInterval);
    if (maxWarnT) clearTimeout(maxWarnT);
    if (maxEndT) clearTimeout(maxEndT);
    dlog("Twilio WS closed");
  });

  twilioWs.on("error", (e) => {
    clearInterval(idleInterval);
    if (maxWarnT) clearTimeout(maxWarnT);
    if (maxEndT) clearTimeout(maxEndT);
    elog("Twilio WS error", e?.message || e);
  });
});

server.listen(PORT, () => {
  ilog(`✅ Server running on port ${PORT}`);
});
