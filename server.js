// server.js
// Nice Line – Voice AI (Inbound) – STRICT FLOW ENGINE
// Twilio Media Streams <-> OpenAI Realtime API

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
function isYes(text) {
  const t = String(text || "").trim().toLowerCase();
  return ["כן", "בטח", "בוודאי", "נכון", "כן."].some(w => t.includes(w));
}
function isNo(text) {
  const t = String(text || "").trim().toLowerCase();
  return ["לא", "לא תודה", "שלילי", "לא."].some(w => t.includes(w));
}

/* ------------------------- config ------------------------- */
const PORT = envNum("PORT", 10000);
const OPENAI_API_KEY = envStr("OPENAI_API_KEY");
const OPENAI_VOICE = envStr("OPENAI_VOICE", "cedar");
const MB_CONVERSATION_PROMPT_RAW = envStr("MB_CONVERSATION_PROMPT");
const MB_WEBHOOK_URL = envStr("MB_WEBHOOK_URL", "").trim();
const MB_DEBUG = envBool("MB_DEBUG", true);

/* ------------------------- logging ------------------------- */
const ilog = (...a) => console.log("[INFO]", ...a);
const elog = (...a) => console.error("[ERROR]", ...a);

/* ------------------------- conversation json ------------------------- */
let CONV;
try {
  CONV = JSON.parse(MB_CONVERSATION_PROMPT_RAW);
} catch {
  elog("MB_CONVERSATION_PROMPT must be valid JSON");
  process.exit(1);
}
function getStr(path, def = "") {
  return path.split(".").reduce((o, k) => (o && o[k] != null ? o[k] : def), CONV);
}

/* ------------------------- ✅ FIXED study track normalization ------------------------- */
function normalizeStudyTrackStrong(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return null;

  // עברית
  if (s.includes("טוען")) return "טוען רבני";
  if (s.includes("דיינ")) return "דיינות";
  if (s.includes("רבנ")) return "רבנות";

  // טוען רבני – תעתיקים
  if (
    (s.includes("tolen") || s.includes("tollen") || s.includes("toen") || s.includes("toan")) &&
    (s.includes("rabboni") || s.includes("rabbani") || s.includes("rabani") || s.includes("rabbi"))
  ) {
    return "טוען רבני";
  }

  // רבנות – תעתיקים
  if (
    s.includes("rabbanut") ||
    s.includes("rabba nut") ||
    s.includes("rabba-nut") ||
    s.includes("rabanut")
  ) {
    return "רבנות";
  }

  // דיינות – תעתיקים
  if (
    s.includes("dayanut") ||
    s.includes("dayanoot") ||
    s.includes("dayan") ||
    s.includes("dajan")
  ) {
    return "דיינות";
  }

  return null;
}

/* ------------------------- Make webhook ------------------------- */
async function sendToMake(payload) {
  if (!MB_WEBHOOK_URL) return;
  try {
    await fetchWithTimeout(MB_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    elog("Make webhook failed", e.message);
  }
}

/* ------------------------- server ------------------------- */
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/twilio-media-stream" });

app.get("/health", (_, res) => res.json({ ok: true }));

wss.on("connection", (twilioWs) => {
  let streamSid, callSid, caller = "", called = "";
  let state = "ASK_TRACK";
  const lead = {
    first_name: "",
    last_name: "",
    phone_number: "",
    study_track: "",
    source: "Voice AI - Nice Line",
    timestamp: nowIso(),
    caller_id: "",
    called: "",
  };

  const openAiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  openAiWs.on("open", () => {
    openAiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        voice: OPENAI_VOICE,
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        input_audio_transcription: { model: "whisper-1" },
        instructions: getStr("system", "")
      }
    }));

    speak(getStr("opening", ""));
    speak(getStr("questions.track", ""));
  });

  function speak(text) {
    if (!text) return;
    openAiWs.send(JSON.stringify({
      type: "conversation.item.create",
      item: { type: "message", role: "assistant", content: [{ type: "output_text", text }] }
    }));
    openAiWs.send(JSON.stringify({ type: "response.create" }));
    ilog("BOT>", text);
  }

  openAiWs.on("message", async (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type !== "conversation.item.input_audio_transcription.completed") return;

    const userText = msg.transcript.trim();
    ilog("USER>", userText);

    if (state === "ASK_TRACK") {
      const tr = normalizeStudyTrackStrong(userText);
      if (!tr) {
        speak(getStr("questions.track_clarify"));
        return;
      }
      lead.study_track = tr;
      state = "ASK_FIRST";
      speak(getStr("thanks"));
      speak(getStr("questions.first"));
      return;
    }

    if (state === "ASK_FIRST") {
      lead.first_name = userText;
      state = "ASK_LAST";
      speak(getStr("thanks"));
      speak(getStr("questions.last"));
      return;
    }

    if (state === "ASK_LAST") {
      lead.last_name = userText;
      state = "ASK_PHONE_CONFIRM";
      speak(getStr("thanks"));
      speak(renderTemplate(getStr("questions.phone_confirm"), {
        caller_phone: normalizeIsraeliPhone("", caller) || ""
      }));
      return;
    }

    if (state === "ASK_PHONE_CONFIRM") {
      if (isYes(userText)) {
        lead.phone_number = normalizeIsraeliPhone("", caller);
        await sendToMake(lead);
        speak(getStr("closing"));
        return;
      }
      if (isNo(userText)) {
        speak("אנא אמרו מספר טלפון לחזרה.");
        state = "ASK_PHONE_MANUAL";
        return;
      }
    }

    if (state === "ASK_PHONE_MANUAL") {
      const p = normalizeIsraeliPhone(userText);
      if (p) {
        lead.phone_number = p;
        await sendToMake(lead);
        speak(getStr("closing"));
      }
    }
  });

  twilioWs.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      callSid = msg.start.callSid;
      caller = msg.start.customParameters?.caller || "";
      called = msg.start.customParameters?.called || "";
      lead.caller_id = caller;
      lead.called = called;
      ilog("CALL start", { streamSid, callSid, caller, called });
    }
    if (msg.event === "media") {
      openAiWs.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: msg.media.payload
      }));
    }
  });
});

server.listen(PORT, () => {
  ilog(`✅ Server running on port ${PORT}`);
});
