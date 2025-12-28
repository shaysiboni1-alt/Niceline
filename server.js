// server.js
//
// NiceLine / מרכז מל"מ – Voice AI
// Twilio Media Streams (audio) <-> Render (WS)
// OpenAI Realtime: STT only (תמלול בלבד)
// ElevenLabs: TTS only (דיבור בלבד)
//
// עקרונות לפי בקשתך:
// ✅ פתיח מהשרת (MB_OPENING_TEXT). אין פתיח בטוויליו.
// ✅ אין שאלת אישור אחרי פתיח. מיד ASK_NAME.
// ✅ פלואו קשיח: ASK_NAME -> CONFIRM_NAME -> CONFIRM_CALLER_LAST4/ASK_PHONE -> CONFIRM_PHONE -> DONE
// ✅ וובהוק/CRM נשאר כמו שהוא (לא נוגעים בשדות/מבנה).
// ✅ תיקון שגיאת Eleven: לא שולחים optimize_streaming_latency עם eleven_v3 (הוסר לגמרי).
//
// דרישות:
//   npm install express ws

const express = require("express");
const WebSocket = require("ws");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 10000;

// ---------- ENV (לא משנים שמות קיימים) ----------
const ENV = {
  MAKE_WEBHOOK_URL: process.env.MAKE_WEBHOOK_URL || "",

  MB_CLOSING_TEXT: process.env.MB_CLOSING_TEXT || "",
  MB_OPENING_TEXT: process.env.MB_OPENING_TEXT || "",

  MB_DEBUG: String(process.env.MB_DEBUG || "false").toLowerCase() === "true",
  MB_LOG_BOT: String(process.env.MB_LOG_BOT || "true").toLowerCase() === "true",
  MB_LOG_CRM: String(process.env.MB_LOG_CRM || "true").toLowerCase() === "true",

  MB_HANGUP_GRACE_MS: Number(process.env.MB_HANGUP_GRACE_MS || "4500"),

  // OpenAI (STT בלבד)
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
  PENAI_REALTIME_MODEL: process.env.PENAI_REALTIME_MODEL || "gpt-realtime-2025-08-28",
  MB_STT_LANGUAGE: process.env.MB_STT_LANGUAGE || "he",

  // Twilio
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || "",
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || "",
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || "",

  // Eleven
  ELEVEN_API_KEY: process.env.ELEVEN_API_KEY || process.env.ELEVENLABS_API_KEY || "",
  ELEVEN_VOICE_ID: process.env.ELEVEN_VOICE_ID || "",
  ELEVEN_OUTPUT_FORMAT: process.env.ELEVEN_OUTPUT_FORMAT || "ulaw_8000",
  ELEVEN_TTS_MODEL: process.env.ELEVEN_TTS_MODEL || process.env.ELEVENLABS_MODEL_ID || "eleven_v3",
  ELEVENLABS_STABILITY: Number(process.env.ELEVENLABS_STABILITY || "0.5"),
  ELEVENLABS_STYLE: Number(process.env.ELEVENLABS_STYLE || "0.15"),
  ELEVENLABS_LANGUAGE: process.env.ELEVENLABS_LANGUAGE || "he",
};

function logInfo(...args) { console.log("[INFO]", ...args); }
function logError(...args) { console.log("[ERROR]", ...args); }

function safeStr(s) { return (s || "").toString().trim(); }
function normalizeText(s) {
  return (s || "")
    .toString()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
function digitsOnly(s) { return (s || "").toString().replace(/[^\d]/g, ""); }
function isValidILPhoneDigits(d) {
  const x = digitsOnly(d);
  return x.length === 9 || x.length === 10;
}
function last4Digits(d) {
  const x = digitsOnly(d);
  return x.length >= 4 ? x.slice(-4) : "";
}
function digitsSpaced(d) {
  return digitsOnly(d).split("").join(" ");
}

// כן/לא גמיש
function detectYesNo(s) {
  const t = normalizeText(s);
  if (!t) return null;
  const tokens = t.split(" ").filter(Boolean);

  const YES = new Set(["כן","בטח","בסדר","אוקיי","אוקי","ok","okay","yes","נכון","מאשר","מאשרת","סבבה","יאללה"]);
  const hasYes = tokens.some(w => YES.has(w));
  const hasNo = tokens.some(w => w === "לא" || w === "no");

  const strongNo =
    t.includes("לא רוצה") || t.includes("לא מעוניין") || t.includes("לא מעוניינת") ||
    t.includes("ממש לא") || t === "עזוב" || t === "עזבי";

  if ((hasYes && hasNo) || (hasYes && strongNo)) return null;
  if (strongNo) return "no";
  if (hasNo && tokens.length <= 6) return "no";
  if (hasYes) return "yes";
  return null;
}

// חילוץ טלפון מהתמלול (ספרות בלבד + מילים בעברית בסיסי)
const HEB_DIGIT_WORDS = new Map([
  ["אפס","0"],["0","0"],
  ["אחד","1"],["אחת","1"],["1","1"],
  ["שתיים","2"],["שניים","2"],["שתים","2"],["2","2"],
  ["שלוש","3"],["שלושה","3"],["3","3"],
  ["ארבע","4"],["ארבעה","4"],["4","4"],
  ["חמש","5"],["חמישה","5"],["5","5"],
  ["שש","6"],["שישה","6"],["6","6"],
  ["שבע","7"],["שבעה","7"],["7","7"],
  ["שמונה","8"],["8","8"],
  ["תשע","9"],["תשעה","9"],["9","9"],
]);
function extractPhoneFromTranscript(text) {
  const direct = digitsOnly(text);
  if (direct.length >= 9 && direct.length <= 10) return direct;

  const tokens = normalizeText(text).split(" ").filter(Boolean);
  const digits = [];
  for (const tok of tokens) if (HEB_DIGIT_WORDS.has(tok)) digits.push(HEB_DIGIT_WORDS.get(tok));
  const joined = digits.join("");
  if (joined.length >= 9 && joined.length <= 10) return joined;
  return "";
}

// ------------------- CRM/WEBHOOK (משאיר את אותו מבנה) -------------------
async function postJson(url, payload) {
  if (!url) return { ok: false, reason: "webhook_not_configured" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, body, reason: res.ok ? "make_ok" : "make_http_error" };
  } catch (e) {
    return { ok: false, reason: "make_fetch_error", error: String(e?.message || e) };
  }
}

// ------------------- ElevenLabs TTS (ulaw_8000) -------------------
async function elevenSpeakToTwilio(wsTwilio, text) {
  const t = safeStr(text);
  if (!t) return;

  if (!ENV.ELEVEN_API_KEY || !ENV.ELEVEN_VOICE_ID) {
    throw new Error("ELEVEN_API_KEY / ELEVEN_VOICE_ID missing");
  }

  // NOTE: חשוב – לא שולחים optimize_streaming_latency (גורם ל-400 עם eleven_v3)
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
    ENV.ELEVEN_VOICE_ID
  )}/stream?output_format=${encodeURIComponent(ENV.ELEVEN_OUTPUT_FORMAT)}`;

  const body = {
    text: t,
    model_id: ENV.ELEVEN_TTS_MODEL,
    voice_settings: {
      stability: ENV.ELEVENLABS_STABILITY,
      style: ENV.ELEVENLABS_STYLE,
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ENV.ELEVEN_API_KEY,
      "content-type": "application/json",
      accept: "audio/mpeg",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errTxt = await resp.text().catch(() => "");
    throw new Error(`Eleven stream failed (${resp.status}): ${errTxt}`);
  }

  // Twilio expects base64 audio payload chunks
  const reader = resp.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.length === 0) continue;

    const b64 = Buffer.from(value).toString("base64");
    const msg = { event: "media", media: { payload: b64 } };
    wsTwilio.send(JSON.stringify(msg));
  }
}

// ------------------- OpenAI Realtime (STT בלבד) -------------------
function openaiWsUrl() {
  // Realtime WS endpoint
  return `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(ENV.PENAI_REALTIME_MODEL)}`;
}

function createOpenAIWs() {
  if (!ENV.OPENAI_API_KEY) return null;

  const ws = new WebSocket(openaiWsUrl(), {
    headers: {
      Authorization: `Bearer ${ENV.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  return ws;
}

// ------------------- State machine -------------------
const STATE = {
  OPENING: "OPENING",
  ASK_NAME: "ASK_NAME",
  CONFIRM_NAME: "CONFIRM_NAME",
  ASK_NAME_CORRECT: "ASK_NAME_CORRECT",
  CONFIRM_CALLER_LAST4: "CONFIRM_CALLER_LAST4",
  ASK_PHONE: "ASK_PHONE",
  CONFIRM_PHONE: "CONFIRM_PHONE",
  DONE: "DONE",
};

function splitName(full) {
  const parts = safeStr(full).split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

function isGibberishOrOffTopic(t) {
  const s = normalizeText(t);
  if (!s) return true;
  // ג׳יבריש נפוץ/כעס/שיחה לא רלוונטית
  if (s.includes("מה אתה") || s.includes("למה אתה") || s.includes("נתקע") || s.includes("חופר")) return true;
  if (s.includes("מסלולי לימוד") || s.includes("קורסים") || s.includes("פרטים על")) return true;
  if (s.length < 2) return true;
  return false;
}

// ------------------- Twilio Media Stream WS server -------------------
const wss = new WebSocket.Server({ noServer: true });

app.get("/health", (_, res) => res.status(200).send("ok"));

// Recording callback (אם כבר קיים אצלך) – משאירים
app.post("/twilio-recording-callback", async (req, res) => {
  try {
    logInfo("RECORDING callback", req.body || {});
    res.status(200).send("ok");
  } catch (e) {
    res.status(200).send("ok");
  }
});

// Serve recording (אם כבר קיים אצלך בעבר) – משאירים מינימלי
app.get("/recording/:sid.mp3", (req, res) => {
  res.status(404).send("not_implemented_here");
});

const server = app.listen(PORT, () => {
  logInfo(`Server listening on port ${PORT}`);
});

server.on("upgrade", (request, socket, head) => {
  if (request.url && request.url.startsWith("/twilio-media-stream")) {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  } else {
    socket.destroy();
  }
});

wss.on("connection", (wsTwilio) => {
  logInfo("Twilio WS client connected");

  const ctx = {
    streamSid: "",
    callSid: "",
    caller: "",
    called: "",
    callerPhoneLocal: "",
    recordingSid: "",
    recording_public_url: "",

    state: STATE.OPENING,

    first_name: "",
    last_name: "",
    phone_number: "",

    caller_last4: "",
    usedCaller: false,

    // log remark
    consent: "skipped",
  };

  let openai = null;
  let openaiReady = false;

  // --- helper: bot speak with logging ---
  const speakQueue = [];
  let speaking = false;

  async function speak(text) {
    const t = safeStr(text);
    if (!t) return;
    if (ENV.MB_LOG_BOT) logInfo("BOT>", t);

    speakQueue.push(t);
    if (speaking) return;
    speaking = true;

    while (speakQueue.length) {
      const next = speakQueue.shift();
      try {
        await elevenSpeakToTwilio(wsTwilio, next);
      } catch (e) {
        logError("Eleven speak error", e?.message || e);
        // אם TTS נפל – אין מה לעשות כאן, נשבור כדי לא להיתקע בלולאה
        break;
      }
    }

    speaking = false;
  }

  function finalizeCallStatus() {
    const completed = Boolean(ctx.first_name && ctx.last_name && ctx.phone_number);
    return completed
      ? { call_status: "שיחה מלאה", call_status_code: "completed" }
      : { call_status: "שיחה חלקית", call_status_code: "partial" };
  }

  async function sendFinal(reason) {
    const { call_status, call_status_code } = finalizeCallStatus();

    const payload = {
      update_type: "lead_final",
      first_name: ctx.first_name || "",
      last_name: ctx.last_name || "",
      phone_number: ctx.phone_number || "",
      study_track: "",

      caller_id: ctx.caller || "",
      caller_phone_local: ctx.callerPhoneLocal || "",
      called: ctx.called || "",
      callSid: ctx.callSid || "",
      streamSid: ctx.streamSid || "",

      call_status,
      call_status_code,

      recording_url: "",
      recording_public_url: ctx.recording_public_url || "",

      source: "Voice AI - Nice Line",
      timestamp: new Date().toISOString(),
      reason: reason || "",
      remarks: `סטטוס: ${call_status} | consent: ${ctx.consent} | name: ${[ctx.first_name, ctx.last_name].filter(Boolean).join(" ")}`,
    };

    if (ENV.MB_LOG_CRM) logInfo("CRM> sending FINAL", payload);
    const r = await postJson(ENV.MAKE_WEBHOOK_URL, payload);
    if (ENV.MB_LOG_CRM) logInfo("CRM> final result", r);
  }

  // --- flow transitions ---
  async function startFlowProactive() {
    // 1) פתיח
    if (ctx.state === STATE.OPENING) {
      if (ENV.MB_OPENING_TEXT) {
        await speak(ENV.MB_OPENING_TEXT);
      }
      // 2) ישר לשם
      ctx.state = STATE.ASK_NAME;
      logInfo("[FLOW] opening -> ASK_NAME (proactive)");
      await speak("מה השם שלכם? שם פרטי ושם משפחה.");
    }
  }

  async function handleUserText(text) {
    const user = safeStr(text);
    if (!user) return;

    logInfo("USER>", user);

    // אם המשתמש סטה / קשקוש / קטיעה – מחזירים למסלול בלי “ללמד”
    if (isGibberishOrOffTopic(user) && ctx.state !== STATE.DONE) {
      await speak("סבבה. כדי שנוכל לחזור אליכם, מה השם שלכם? שם פרטי ושם משפחה.");
      ctx.state = STATE.ASK_NAME;
      return;
    }

    switch (ctx.state) {
      case STATE.ASK_NAME: {
        const { first, last } = splitName(user);
        ctx.first_name = first;
        ctx.last_name = last;

        ctx.state = STATE.CONFIRM_NAME;
        await speak(`רשמתי: ${[first, last].filter(Boolean).join(" ")}. נכון?`);
        return;
      }

      case STATE.ASK_NAME_CORRECT: {
        const { first, last } = splitName(user);
        ctx.first_name = first;
        ctx.last_name = last;

        ctx.state = STATE.CONFIRM_NAME;
        await speak(`רשמתי: ${[first, last].filter(Boolean).join(" ")}. נכון?`);
        return;
      }

      case STATE.CONFIRM_NAME: {
        const yn = detectYesNo(user);
        if (yn === "yes") {
          ctx.state = STATE.CONFIRM_CALLER_LAST4;
          const last4 = ctx.caller_last4;
          if (!last4) {
            ctx.state = STATE.ASK_PHONE;
            await speak("מה מספר הטלפון לחזרה? אפשר לומר 10 ספרות.");
            return;
          }
          await speak(`המספר לחזרה מסתיים ב-${digitsSpaced(last4)}. נכון?`);
          return;
        }
        if (yn === "no") {
          ctx.state = STATE.ASK_NAME_CORRECT;
          await speak("אוקיי. תגידו שוב שם פרטי ושם משפחה.");
          return;
        }
        await speak("רק כן או לא בבקשה.");
        return;
      }

      case STATE.CONFIRM_CALLER_LAST4: {
        const yn = detectYesNo(user);
        if (yn === "yes") {
          ctx.usedCaller = true;
          ctx.phone_number = ctx.callerPhoneLocal || "";
          ctx.state = STATE.DONE;

          if (ENV.MB_CLOSING_TEXT) await speak(ENV.MB_CLOSING_TEXT);
          else await speak("תודה. הפרטים נרשמו.");

          await sendFinal("completed_flow");
          // ניתוק “רך”
          setTimeout(() => {
            try { wsTwilio.close(); } catch {}
          }, ENV.MB_HANGUP_GRACE_MS);
          return;
        }
        if (yn === "no") {
          ctx.state = STATE.ASK_PHONE;
          await speak("אוקיי. מה מספר הטלפון הנכון לחזרה?");
          return;
        }
        await speak("רק כן או לא בבקשה.");
        return;
      }

      case STATE.ASK_PHONE: {
        const phone = extractPhoneFromTranscript(user);
        if (!isValidILPhoneDigits(phone)) {
          await speak("לא הצלחתי לקלוט מספר תקין. תגידו שוב בבקשה, 9 או 10 ספרות.");
          return;
        }
        ctx.phone_number = phone;
        ctx.state = STATE.CONFIRM_PHONE;
        await speak(`רשמתי מספר שמסתיים ב-${digitsSpaced(last4Digits(phone))}. נכון?`);
        return;
      }

      case STATE.CONFIRM_PHONE: {
        const yn = detectYesNo(user);
        if (yn === "yes") {
          ctx.state = STATE.DONE;

          if (ENV.MB_CLOSING_TEXT) await speak(ENV.MB_CLOSING_TEXT);
          else await speak("תודה. הפרטים נרשמו.");

          await sendFinal("completed_flow");
          setTimeout(() => {
            try { wsTwilio.close(); } catch {}
          }, ENV.MB_HANGUP_GRACE_MS);
          return;
        }
        if (yn === "no") {
          ctx.state = STATE.ASK_PHONE;
          await speak("אוקיי. תגידו שוב את המספר לחזרה.");
          return;
        }
        await speak("רק כן או לא בבקשה.");
        return;
      }

      case STATE.DONE:
      default:
        return;
    }
  }

  // ---- Twilio WS messages ----
  wsTwilio.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.event === "start") {
      const start = msg.start || {};
      ctx.streamSid = start.streamSid || "";
      ctx.callSid = start.callSid || "";

      const params = start.customParameters || {};
      ctx.caller = params.caller || "";
      ctx.called = params.called || "";

      const local = (ctx.caller || "").replace(/^\+972/, "0");
      ctx.callerPhoneLocal = local;

      ctx.caller_last4 = last4Digits(local);

      logInfo("CALL start", {
        streamSid: ctx.streamSid,
        callSid: ctx.callSid,
        caller: ctx.caller,
        called: ctx.called,
        callerPhoneLocal: ctx.callerPhoneLocal,
      });

      // TODO: אם אצלך הקלטה קיימת – כאן תישאר הלוגיקה שלך. משאירים מינימלי.
      logInfo("RECORDING>", { ok: true, reason: "recording_started", sid: "unknown_here" });

      // OpenAI connect (STT only)
      openai = createOpenAIWs();
      if (openai) {
        openai.on("open", () => {
          openaiReady = true;
          logInfo("OpenAI WS open");

          // session.update – STT only
          // לא שולחים response.output_modalities (כבר ראית שזה מפיל)
          const sess = {
            type: "session.update",
            session: {
              modalities: ["text"], // אנחנו רוצים רק טקסט (תמלול)
              input_audio_format: "g711_ulaw",
              output_audio_format: "g711_ulaw",
              turn_detection: { type: "server_vad" },
              input_audio_transcription: {
                model: "gpt-4o-transcribe",
                language: ENV.MB_STT_LANGUAGE || "he",
              },
            },
          };
          try { openai.send(JSON.stringify(sess)); } catch {}
        });

        openai.on("message", async (raw) => {
          let evt;
          try { evt = JSON.parse(raw.toString()); } catch { return; }

          // תמלול סופי
          if (evt.type === "conversation.item.input_audio_transcription.completed") {
            const text = evt.transcript || "";
            await handleUserText(text);
          }

          if (evt.type === "error") {
            logError("OpenAI error", evt);
          }
        });

        openai.on("close", () => {
          logInfo("OpenAI WS closed");
          openaiReady = false;
        });

        openai.on("error", (e) => {
          logError("OpenAI ws error", e?.message || e);
        });
      }

      // מתחילים פלואו מיד (פתיח + שאלה)
      await startFlowProactive();
    }

    // Media from Twilio -> OpenAI (for STT)
    if (msg.event === "media") {
      const payloadB64 = msg.media?.payload;
      if (!payloadB64) return;

      if (openaiReady && openai) {
        const evt = {
          type: "input_audio_buffer.append",
          audio: payloadB64,
        };
        try { openai.send(JSON.stringify(evt)); } catch {}
      }
    }

    if (msg.event === "stop") {
      logInfo("Twilio stop", { streamSid: ctx.streamSid, callSid: ctx.callSid });
      await sendFinal("twilio_stop");
      try { if (openai) openai.close(); } catch {}
      try { wsTwilio.close(); } catch {}
    }
  });

  wsTwilio.on("close", async () => {
    // סיום שיחה
    try { if (openai) openai.close(); } catch {}
  });

  wsTwilio.on("error", (e) => {
    logError("Twilio WS error", e?.message || e);
  });
});

// Safety: לא להיעלם בלי לוג
process.on("uncaughtException", (err) => {
  console.error("[FATAL] uncaughtException", err);
});
process.on("unhandledRejection", (err) => {
  console.error("[FATAL] unhandledRejection", err);
});
