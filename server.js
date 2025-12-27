// server.js
//
// NiceLine – Voice AI (Moti) – Twilio Media Streams <-> OpenAI Realtime API
// Flow קשיח + איפוס לכל שיחה + שליחה ל-Make רק בסיום (partial/completed) + הקלטה.
//
// Requirements:
//   npm install express ws
// Node 18+ recommended.
//
// ENV (minimal):
//   OPENAI_API_KEY
//   OPENAI_REALTIME_MODEL   (default: gpt-realtime-2025-08-28)
//   OPENAI_VOICE            (default: cedar)  // גבר בוגר
//   MAKE_WEBHOOK_URL
//   WS_SERVER_URL           (for Twilio Function /voice): wss://<domain>/twilio-media-stream
//   OPENING_TEXT
//   CLOSING_TEXT
//   SYSTEM_PROMPT
//   TIME_ZONE               (default: Asia/Jerusalem)
//
// Recording ENV:
//   ENABLE_RECORDING=true|false
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//   PUBLIC_BASE_URL         (https://<render-domain>)
//
// Notes:
// - לא משתמשים ב-session.temperature ולא ב-response.modalities (גורם ל-unknown_parameter)
// - output_modalities חייב להיות ["audio","text"] (לא ["audio"] בלבד)
// - כל state נשמר בתוך ה-connection בלבד -> מתאפס בכל שיחה
//

const express = require("express");
const WebSocket = require("ws");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 10000;

// --------------------------
// Helpers
// --------------------------
function nowIso() {
  return new Date().toISOString();
}

function toLocalPhoneIL(e164) {
  // +9725XXXXXXXX -> 05XXXXXXXX
  if (!e164) return "";
  const s = String(e164).trim();
  if (s.startsWith("+972")) return "0" + s.slice(4);
  return s.replace(/^\+/, "");
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
  // מסיר ניקוד + תווים לא רלוונטיים
  return (s || "")
    .toString()
    .replace(/[\u0591-\u05C7]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function detectYesNo(s) {
  const t = normalizeHebrewNikudLess(s);
  if (!t) return null;
  const yes = ["כן", "בטח", "בסדר", "אוקיי", "ok", "okay", "yep", "yes"];
  const no = ["לא", "ממש לא", "no", "nope"];
  if (yes.some((w) => t === w || t.includes(` ${w} `) || t.startsWith(w))) return "yes";
  if (no.some((w) => t === w || t.includes(` ${w} `) || t.startsWith(w))) return "no";
  return null;
}

function detectStudyTrack(s) {
  const t = normalizeHebrewNikudLess(s);

  // עברית
  if (t.includes("רבנות")) return "רבנות";
  if (t.includes("דיינות")) return "דיינות";
  if (t.includes("טוען") && t.includes("רבני")) return "טוען רבני";

  // טעויות/אנגלית/תעתיק נפוץ
  const en = t.replace(/\s+/g, "");
  if (en.includes("rabbanut") || en.includes("rabbanut")) return "רבנות";
  if (en.includes("dayanut") || en.includes("dayanut")) return "דיינות";
  if (en.includes("toen") || en.includes("toven") || en.includes("tollen") || en.includes("rabani") || en.includes("rabbani")) {
    // אם אמר "toen rabbani" וכו'
    if (en.includes("toen") || en.includes("toven") || en.includes("tollen")) return "טוען רבני";
  }

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

// --------------------------
// In-memory call store (per callSid)
// --------------------------
const calls = new Map();
// structure:
// calls.set(callSid, {
//   callSid, streamSid, caller, called, callerPhoneLocal,
//   startedAt, endedAt,
//   recordingSid, recordingUrl,
//   lead: { first_name,last_name,phone_number,study_track },
//   finalSent: false,
//   finalTimer: null,
// });

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
  const reqOk =
    !!safeStr(lead.study_track) &&
    !!safeStr(lead.first_name) &&
    !!safeStr(lead.last_name) &&
    !!safeStr(lead.phone_number) &&
    isValidILPhone(lead.phone_number);

  return reqOk
    ? { code: "completed", label: "שיחה מלאה" }
    : { code: "partial", label: "שיחה חלקית" };
}

// --------------------------
// Twilio Recording: start via REST (optional)
// --------------------------
async function startRecordingIfEnabled(callSid) {
  const enabled = String(process.env.ENABLE_RECORDING || "").toLowerCase() === "true";
  const acc = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const base = process.env.PUBLIC_BASE_URL;

  if (!enabled) return { ok: false, reason: "recording_disabled" };
  if (!acc || !token || !base) return { ok: false, reason: "recording_env_missing" };

  const cbUrl = `${base.replace(/\/$/, "")}/twilio-recording-callback`;

  const url = `https://api.twilio.com/2010-04-01/Accounts/${acc}/Calls/${callSid}/Recordings.json`;

  const body = new URLSearchParams({
    RecordingStatusCallback: cbUrl,
    RecordingStatusCallbackMethod: "POST",
    RecordingChannels: "dual",
  });

  try {
    const auth = Buffer.from(`${acc}:${token}`).toString("base64");
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, reason: "recording_start_failed", status: res.status, body: json };
    }
    return { ok: true, reason: "recording_started", sid: json.sid || "" };
  } catch (e) {
    return { ok: false, reason: "recording_start_error", error: String(e?.message || e) };
  }
}

// Recording status callback endpoint (Twilio -> us)
app.post("/twilio-recording-callback", async (req, res) => {
  const callSid = req.body?.CallSid || req.body?.callSid || "";
  const recordingUrl = req.body?.RecordingUrl || req.body?.RecordingUrl || "";
  const recordingSid = req.body?.RecordingSid || req.body?.RecordingSid || "";

  console.log("[INFO] RECORDING callback", { callSid, recordingUrl, recordingSid });

  if (callSid) {
    const c = getCall(callSid);
    if (recordingSid) c.recordingSid = recordingSid;
    if (recordingUrl) c.recordingUrl = recordingUrl;

    // אם כבר סיימנו ושלחנו final בלי הקלטה — שלח עדכון נוסף
    if (c.finalSent && recordingUrl) {
      const payload = {
        update_type: "recording_update",
        callSid: c.callSid,
        streamSid: c.streamSid,
        caller_id: c.caller, // ✅ לקוח
        called: c.called,    // ✅ הבוט
        recording_url: recordingUrl,
        timestamp: nowIso(),
      };
      const r = await postJson(process.env.MAKE_WEBHOOK_URL, payload);
      console.log("[INFO] CRM> recording update result", r);
    }
  }

  res.status(200).send("OK");
});

// --------------------------
// Final send to Make (ONLY at end)
// --------------------------
async function sendFinal(callSid, reason) {
  const c = getCall(callSid);
  if (c.finalSent) return;

  const status = computeStatus(c.lead);
  const payload = {
    update_type: "lead_final",
    first_name: c.lead.first_name || "",
    last_name: c.lead.last_name || "",
    phone_number: digitsOnly(c.lead.phone_number || ""),     // מספר לחזרה (מה שהמשתמש בחר/אמר)
    study_track: c.lead.study_track || "",
    source: "Voice AI - Nice Line",
    timestamp: nowIso(),

    // ✅ המספר המזוהה צריך להיות הלקוח (From)
    caller_id: c.caller || "",
    caller_phone_local: c.callerPhoneLocal || "",

    // מספר הבוט (To)
    called: c.called || "",

    callSid: c.callSid,
    streamSid: c.streamSid,

    call_status: status.label,
    call_status_code: status.code,

    reason: reason || "call_end",
    recording_url: c.recordingUrl || "",

    remarks: `מסלול: ${c.lead.study_track || ""} | סטטוס: ${status.label} | caller: ${c.caller || ""} | callSid: ${c.callSid}`,
  };

  console.log("[INFO] CRM> sending FINAL", payload);
  const r = await postJson(process.env.MAKE_WEBHOOK_URL, payload);
  console.log("[INFO] CRM> final result", r);

  c.finalSent = true;

  // ניקוי אחרי דקה
  setTimeout(() => calls.delete(callSid), 60_000);
}

// --------------------------
// OpenAI Realtime (WS) config
// --------------------------
function openaiWsUrl() {
  const model = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2025-08-28";
  return `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
}

function makeSystemPrompt() {
  return (
    process.env.SYSTEM_PROMPT ||
    "אַתֶּם מוֹטִי, בּוֹט רִישּׁוּם גֶּבֶר לְמֶרְכַּז מַל״מ. " +
      "אַתֶּם מְדַבְּרִים בְּעִבְרִית תַּקִּינָה וּמְנֻקֶּדֶת, בִּלְשׁוֹן רַבִּים בִּלְבַד. " +
      "תַּפְקִידְכֶם רַק לְרַשֵּׁם לִיד: מַסְלוּל לִמּוּד (רַבָּנוּת/דַּיָּנוּת/טוֹעֵן רַבָּנִי), שֵׁם פְּרָטִי, שֵׁם מִשְׁפָּחָה, וּמִסְפָּר טֶלֶפוֹן. " +
      "אֵין לָכֶם רְשׁוּת לְהַסְבִּיר עַל הַמַּסְלוּלִים, לֹא לָתֵת תֹּכֶן הִלְכָתִי, וְלֹא לְמָכֹר. " +
      "אִם שׁוֹאֲלִים שְׁאֵלוֹת — עוֹנִים קָצָר: 'אֲנִי מַעֲרֶכֶת רִישּׁוּם בִּלְבַד. נָצִיג יַחֲזֹר אֲלֵיכֶם עִם כָּל הַהֶסְבֵּרִים.'"
  );
}

// --------------------------
// Twilio Media Streams WS endpoint
// --------------------------
const server = app.listen(PORT, () => {
  console.log(`[INFO] ✅ Server running on port ${PORT}`);
});

const wss = new WebSocket.Server({ server, path: "/twilio-media-stream" });

wss.on("connection", (twilioWs) => {
  // Per-call state (MUST be inside this connection)
  let streamSid = "";
  let callSid = "";
  let caller = "";
  let called = "";
  let callerPhoneLocal = "";

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

  // for retries (one retry max)
  const retries = {
    track: 0,
    phone: 0,
  };

  // OpenAI WS
  const openaiWs = new WebSocket(openaiWsUrl(), {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
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

  function sayExact(text) {
    // שליטה מלאה בטקסט: אנחנו נותנים הוראה "תגיד בדיוק"
    sendOpenAI({
      type: "response.create",
      response: {
        output_modalities: ["audio", "text"],
        instructions:
          "תֹּאמְרוּ בְּדִיּוּק אֶת הַטֶּקְסְט הַבָּא, לְלֹא שִׁנּוּי מִלָּה, לְלֹא תּוֹסֶפֶת, וּבְקֶצֶב מְהִיר מְעַט: \n" +
          text,
      },
    });
  }

  function handleSmallTalkOrRefusal(userText) {
    // תגובה גנרית קצרה למי שמתחכם / "מי אתה" / לא רוצה להשאיר פרטים
    const t = normalizeHebrewNikudLess(userText);

    // סירוב
    if (t.includes("לא רוצה") || t.includes("לא מעוניין") || t.includes("לא מעונינת") || t.includes("עזוב") || t.includes("ביי")) {
      sayExact("בְּסֵדֶר גָּמוּר. אִם תִּרְצוּ שֶׁנָּצִיג יַחֲזֹר, תּוּכְלוּ לְהִתְקַשֵּׁר בְּכָל עֵת. יוֹם טוֹב.");
      state = STATES.DONE;
      return true;
    }

    // "מי אתה" / שאלות
    if (t.includes("מי אתה") || t.includes("מי אתם") || t.includes("מה זה") || t.includes("למה") || t.includes("כמה") || t.includes("הלכה") || t.includes("מסלול")) {
      sayExact("אֲנִי מַעֲרֶכֶת רִישּׁוּם בִּלְבַד. נָצִיג יַחֲזֹר אֲלֵיכֶם עִם כָּל הַהֶסְבֵּרִים.");
      // חוזרים לשאלה הנוכחית מיד
      askCurrentQuestion();
      return true;
    }

    return false;
  }

  function askCurrentQuestion() {
    if (state === STATES.ASK_TRACK) {
      sayExact("בְּאֵיזֶה מַסְלוּל אַתֶּם מִתְעַנְיְנִים? רַבָּנוּת, דַּיָּנוּת, אוֹ טוֹעֵן רַבָּנִי.");
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
      // אפשרות לחזור למספר המזוהה
      const local = callerPhoneLocal || "";
      if (local) {
        sayExact(
          `לְאֵיזֶה מִסְפָּר נוֹחַ שֶׁנַּחֲזֹר אֲלֵיכֶם? אֶפְשָׁר לְהָגִיד "כֵּן" וְנַחֲזֹר לְמִסְפָּר ${local}. אוֹ לְהַגִּיד מִסְפָּר אַחֵר.`
        );
      } else {
        state = STATES.ASK_PHONE;
        askCurrentQuestion();
      }
      return;
    }
    if (state === STATES.ASK_PHONE) {
      sayExact("בְּאֵיזֶה מִסְפָּר טֶלֶפוֹן נוֹחַ שֶׁנַּחֲזֹר אֲלֵיכֶם? אֲנָא אִמְרוּ רַק סְפָרוֹת.");
      return;
    }
  }

  function advanceAfter(text) {
    const c = getCall(callSid);

    // קודם כל טיפול בהתחכמויות/שאלות
    if (handleSmallTalkOrRefusal(text)) return;

    if (state === STATES.ASK_TRACK) {
      const track = detectStudyTrack(text);
      if (!track) {
        if (retries.track >= 1) {
          // אחרי ניסיון אחד – נשארים במסלול אבל ממשיכים כדי לא להיתקע
          // (עם track ריק זה עדיין יהיה partial בסוף)
          state = STATES.ASK_FIRST;
          askCurrentQuestion();
          return;
        }
        retries.track += 1;
        sayExact("אֶפְשָׁר לִבְחוֹר אֶחָד מִשְּׁלֹשֶׁת הַמַּסְלוּלִים: רַבָּנוּת, דַּיָּנוּת, אוֹ טוֹעֵן רַבָּנִי.");
        askCurrentQuestion();
        return;
      }
      c.lead.study_track = track;
      console.log("[INFO] [STATE] ASK_TRACK -> ASK_FIRST", { track });
      state = STATES.ASK_FIRST;
      askCurrentQuestion();
      return;
    }

    if (state === STATES.ASK_FIRST) {
      const name = safeStr(text);
      if (!name) {
        askCurrentQuestion();
        return;
      }
      c.lead.first_name = name;
      console.log("[INFO] [STATE] ASK_FIRST -> ASK_LAST", { first_name: name });
      state = STATES.ASK_LAST;
      askCurrentQuestion();
      return;
    }

    if (state === STATES.ASK_LAST) {
      const last = safeStr(text);
      if (!last) {
        askCurrentQuestion();
        return;
      }
      c.lead.last_name = last;
      console.log("[INFO] [STATE] ASK_LAST -> ASK_PHONE_CHOICE", { last_name: last });
      state = STATES.ASK_PHONE_CHOICE;
      askCurrentQuestion();
      return;
    }

    if (state === STATES.ASK_PHONE_CHOICE) {
      const yn = detectYesNo(text);
      if (yn === "yes" && callerPhoneLocal) {
        const c = getCall(callSid);
        c.lead.phone_number = callerPhoneLocal;
        console.log("[INFO] [STATE] ASK_PHONE_CHOICE -> DONE", { phone_number: callerPhoneLocal });
        state = STATES.DONE;
        // סיום
        sayExact(process.env.CLOSING_TEXT || "תּוֹדָה רַבָּה, הַפְּרָטִים נִשְׁמְרוּ. נְצִיג הַמֶּרְכָּז יַחֲזֹר אֲלֵיכֶם בְּהֶקְדֵּם. יוֹם טוֹב.");
        return;
      }

      // אם לא "כן" – ננסה להבין אם זה מספר
      const d = digitsOnly(text);
      if (d.length >= 9) {
        // נחשב כאילו אמר מספר
        state = STATES.ASK_PHONE;
        advanceAfter(d);
        return;
      }

      // אחרת מבקשים מספר
      state = STATES.ASK_PHONE;
      askCurrentQuestion();
      return;
    }

    if (state === STATES.ASK_PHONE) {
      const d = digitsOnly(text);
      if (!isValidILPhone(d)) {
        if (retries.phone >= 1) {
          // לא נתקעים לנצח – מסיימים כ-partial
          state = STATES.DONE;
          sayExact(process.env.CLOSING_TEXT || "תּוֹדָה רַבָּה, הַפְּרָטִים נִשְׁמְרוּ. נְצִיג הַמֶּרְכָּז יַחֲזֹר אֲלֵיכֶם בְּהֶקְדֵּם. יוֹם טוֹב.");
          return;
        }
        retries.phone += 1;
        sayExact("לַצּוֹרֶךְ חֲזָרָה אֲנִי צָרִיךְ מִסְפָּר תַּקִּין בֵּין תֵּשַׁע לְעֶשֶׂר סְפָרוֹת. אֲנָא אִמְרוּ רַק סְפָרוֹת.");
        return;
      }
      const c = getCall(callSid);
      c.lead.phone_number = d;
      console.log("[INFO] [STATE] ASK_PHONE -> DONE", { phone_number: d });
      state = STATES.DONE;
      sayExact(process.env.CLOSING_TEXT || "תּוֹדָה רַבָּה, הַפְּרָטִים נִשְׁמְרוּ. נְצִיג הַמֶּרְכָּז יַחֲזֹר אֲלֵיכֶם בְּהֶקְדֵּם. יוֹם טוֹב.");
      return;
    }
  }

  // --- OpenAI WS events ---
  openaiWs.on("open", () => {
    openaiReady = true;
    console.log("[INFO] OpenAI WS open");
    flushOpenAI();

    // session.update – רק שדות תקינים
    sendOpenAI({
      type: "session.update",
      session: {
        instructions: makeSystemPrompt(),
        voice: process.env.OPENAI_VOICE || "cedar",
        modalities: ["audio", "text"],
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",

        // server_vad: אנחנו לא רוצים שייצר תשובה לבד.
        // אנחנו רק רוצים תמלול יציב, ואז אנחנו מפעילים response.create בעצמנו.
        turn_detection: {
          type: "server_vad",
          create_response: false,
          threshold: 0.6,
          prefix_padding_ms: 300,
          silence_duration_ms: 700,
        },

        input_audio_transcription: { model: "gpt-4o-mini-transcribe", language: "he" },
      },
    });

    // פתיח קבוע מה-ENV (לא מתוך הפרומפט)
    const opening = process.env.OPENING_TEXT || "";
    if (opening) {
      console.log("[INFO] BOT> (opening)");
      sayExact(opening);
    }

    // מתחילים מיד בשאלת מסלול
    setTimeout(() => {
      console.log("[INFO] [STATE] ASK_TRACK | start");
      askCurrentQuestion();
    }, 250);
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
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: msg.delta },
        })
      );
      return;
    }

    // Input transcription (user)
    if (msg.type === "conversation.item.input_audio_transcription.completed") {
      const transcript = (msg.transcript || "").trim();
      if (!transcript) return;

      console.log("[INFO] USER>", transcript);
      // advance flow
      advanceAfter(transcript);
      return;
    }

    // Optional: assistant text transcript (debug)
    if (msg.type === "response.output_text.delta") {
      // ignore deltas
      return;
    }
    if (msg.type === "response.done") {
      // can log if needed
      return;
    }

    if (msg.type === "error") {
      console.log("[ERROR] OpenAI error", msg);
      // אם יש error – נסיים שיחה כ-partial בסוף (ב-stop)
      return;
    }
  });

  openaiWs.on("close", () => {
    console.log("[INFO] OpenAI WS closed");
  });

  openaiWs.on("error", (e) => {
    console.log("[ERROR] OpenAI WS error", String(e?.message || e));
  });

  // --- Twilio stream events ---
  twilioWs.on("message", async (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      return;
    }

    if (data.event === "start") {
      streamSid = data.start?.streamSid || "";
      callSid = data.start?.callSid || "";
      const custom = data.start?.customParameters || {};

      caller = custom.caller || "";
      called = custom.called || "";
      callerPhoneLocal = toLocalPhoneIL(caller);

      console.log("[INFO] CALL start", { streamSid, callSid, caller, called, callerPhoneLocal });

      // store
      const c = getCall(callSid);
      c.streamSid = streamSid;
      c.caller = caller;
      c.called = called;
      c.callerPhoneLocal = callerPhoneLocal;

      // start recording (optional)
      const rec = await startRecordingIfEnabled(callSid);
      if (rec.ok) {
        c.recordingSid = rec.sid || "";
        console.log("[INFO] RECORDING>", rec);
      } else {
        console.log("[INFO] RECORDING>", rec);
      }

      return;
    }

    if (data.event === "media") {
      const payload = data.media?.payload;
      if (!payload) return;

      // append audio to OpenAI
      sendOpenAI({
        type: "input_audio_buffer.append",
        audio: payload,
      });
      return;
    }

    if (data.event === "stop") {
      // Call ended
      console.log("[INFO] Twilio stop", { streamSid, callSid });
      const c = getCall(callSid);
      c.endedAt = nowIso();

      // סוגרים OpenAI
      try {
        openaiWs.close();
      } catch {}

      // שולחים FINAL רק בסוף.
      // נחכה קצת כדי לתת צ'אנס ש-recording callback יגיע, כדי לצרף recording_url לאותו payload.
      if (c.finalTimer) clearTimeout(c.finalTimer);
      c.finalTimer = setTimeout(() => {
        sendFinal(callSid, "twilio_stop").catch(() => {});
      }, 4000);

      return;
    }
  });

  twilioWs.on("close", () => {
    // אם נסגר בלי stop – עדיין נשלח FINAL
    if (callSid) {
      const c = getCall(callSid);
      if (!c.finalSent) {
        if (c.finalTimer) clearTimeout(c.finalTimer);
        c.finalTimer = setTimeout(() => {
          sendFinal(callSid, "ws_close").catch(() => {});
        }, 3000);
      }
    }
    try {
      openaiWs.close();
    } catch {}
  });

  twilioWs.on("error", (e) => {
    console.log("[ERROR] Twilio WS error", String(e?.message || e));
  });
});

// health
app.get("/", (req, res) => res.status(200).send("OK"));
