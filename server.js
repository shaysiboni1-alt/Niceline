// server.js
//
// Nice Line – Voice AI (Inbound)
// Twilio Media Streams <-> OpenAI Realtime API (Alloy)
//
// FIX: Prevent "conversation_already_has_active_response" by using a response queue.
// Always allow ONLY one active response at a time. Next prompts are queued and sent
// only after response.completed.
//
// Install:
//   npm i express ws dotenv
//
// Run:
//   node server.js

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

function envNumber(name, def) {
  const v = process.env[name];
  if (!v) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function envBool(name, def = false) {
  const raw = (process.env[name] || '').toLowerCase();
  if (!raw) return def;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

const PORT = envNumber('PORT', 3000);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MB_WEBHOOK_URL = process.env.MB_WEBHOOK_URL;

const MB_OPENING_SCRIPT =
  process.env.MB_OPENING_SCRIPT ||
  'שָׁלוֹם, הִגַּעְתֶּם לְמַעֲרֶכֶת הָרִישּׁוּם שֶׁל מֶרְכַּז מַל״מ. כְּדֵי שֶׁיּוֹעֵץ לִמּוּדִים יַחֲזֹר אֲלֵיכֶם לִבְדִיקַת הַתְאָמָה, אֶשְׁאַל כַּמָּה שְׁאֵלוֹת קְצָרוֹת.';
const MB_CLOSING_SCRIPT =
  process.env.MB_CLOSING_SCRIPT ||
  'תּוֹדָה רַבָּה, הַפְּרָטִים נִשְׁמְרוּ. נָצִיג הַמֶּרְכָּז יַחֲזֹר אֲלֵיכֶם בְּהֶקְדֵּם. יוֹם טוֹב.';

const MB_DEBUG = envBool('MB_DEBUG', false);

const OPENAI_VOICE = process.env.OPENAI_VOICE || 'alloy';
const MB_SPEECH_SPEED = envNumber('MB_SPEECH_SPEED', 1.05);

// VAD – מחוזק לרעשי רקע
const MB_VAD_THRESHOLD = envNumber('MB_VAD_THRESHOLD', 0.65);
const MB_VAD_SILENCE_MS = envNumber('MB_VAD_SILENCE_MS', 900);
const MB_VAD_PREFIX_MS = envNumber('MB_VAD_PREFIX_MS', 200);
const MB_VAD_SUFFIX_MS = envNumber('MB_VAD_SUFFIX_MS', 200);

// Idle + Max call + Grace
const MB_IDLE_WARNING_MS = envNumber('MB_IDLE_WARNING_MS', 25000);
const MB_IDLE_HANGUP_MS = envNumber('MB_IDLE_HANGUP_MS', 55000);
const MB_MAX_CALL_MS = envNumber('MB_MAX_CALL_MS', 4 * 60 * 1000);
const MB_MAX_WARN_BEFORE_MS = envNumber('MB_MAX_WARN_BEFORE_MS', 30000);
const MB_HANGUP_GRACE_MS = envNumber('MB_HANGUP_GRACE_MS', 4500);

// barge-in
const MB_ALLOW_BARGE_IN = envBool('MB_ALLOW_BARGE_IN', false);
const MB_NO_BARGE_TAIL_MS = envNumber('MB_NO_BARGE_TAIL_MS', 1600);

if (!OPENAI_API_KEY) console.error('❌ Missing OPENAI_API_KEY');
if (!MB_WEBHOOK_URL) console.error('❌ Missing MB_WEBHOOK_URL');

function logDebug(...a) {
  if (MB_DEBUG) console.log('[DEBUG]', ...a);
}
function logInfo(...a) {
  console.log('[INFO]', ...a);
}
function logError(...a) {
  console.error('[ERROR]', ...a);
}

function digitsOnly(v) {
  if (!v) return '';
  return String(v).replace(/\D/g, '');
}
function normalizeIsraeliPhone(raw, fallbackCaller) {
  let d = digitsOnly(raw || '');
  if (!d && fallbackCaller) d = digitsOnly(fallbackCaller);
  if (!d) return null;
  if (d.startsWith('972') && (d.length === 11 || d.length === 12)) d = '0' + d.slice(3);
  if (!/^\d{9,10}$/.test(d)) return null;
  return d;
}
function isValidEmailLike(s) {
  if (!s) return false;
  const t = String(s).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(t);
}
function normalizeStudyTrack(raw) {
  const t = (raw || '').toString().trim().toLowerCase();
  if (!t) return null;
  if (t.includes('רבנות') || t.includes('רב')) return 'רבנות';
  if (t.includes('דיינות') || t.includes('דיין')) return 'דיינות';
  if (t.includes('טוען')) return 'טוען רבני';
  return null;
}
function nowIso() {
  return new Date().toISOString();
}

async function sendWebhook(payload) {
  if (!MB_WEBHOOK_URL) return;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4500);
    const res = await fetch(MB_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    clearTimeout(t);
    if (!res.ok) logError('CRM HTTP', res.status);
  } catch (e) {
    logError('CRM send failed', e?.message || e);
  }
}

const STRICT_SYSTEM_PROMPT = `
אַתֶּם מַעֲרֶכֶת רִישּׁוּם אוֹטוֹמָטִית שֶׁל מֶרְכַּז מַל״מ.
תַּפְקִידְכֶם בִּלְבַד:
1) לִשְׁאֹל סִינוּן מַסְלוּל: רַבָּנוּת / דַּיָּנוּת / טוֹעֵן רַבָּנִי
2) לֶאֱסֹף: שֵׁם פְּרָטִי, שֵׁם מִשְׁפָּחָה, טֵלֵפוֹן, מֵייל (אוֹפְּצְיוֹנָלִי)
אֲסוּר לְהַסְבִּיר מַסְלוּלִים/הֲלָכָה.
אִם שׁוֹאֲלִים שְׁאֵלָה: "אֲנַחְנוּ מַעֲרֶכֶת רִישּׁוּם בִּלְבַד. נָצִיג יַחֲזֹר אֲלֵיכֶם עִם כָּל הַהֶסְבֵּרִים."
תְּשׁוּבוֹת קְצָרוֹת, עִנְיָנִיּוֹת, עִבְרִית בִּלְבַד.
`.trim();

const STATES = {
  ASK_TRACK: 'ASK_TRACK',
  ASK_FIRST: 'ASK_FIRST',
  ASK_LAST: 'ASK_LAST',
  ASK_PHONE: 'ASK_PHONE',
  ASK_EMAIL: 'ASK_EMAIL',
  DONE: 'DONE'
};

const QUESTIONS = {
  [STATES.ASK_TRACK]:
    'לְאֵיזֶה מַסְלוּל אַתֶּם מְעוֹנְיָנִים? רַבָּנוּת, דַּיָּנוּת, אוֹ טוֹעֵן רַבָּנִי?',
  [STATES.ASK_FIRST]: 'מַה הַשֵּׁם הַפְּרָטִי שֶׁלָּכֶם?',
  [STATES.ASK_LAST]: 'וּמָה שֵׁם הַמִּשְׁפָּחָה?',
  [STATES.ASK_PHONE]: 'בְּאֵיזֶה מִסְפָּר טֵלֵפוֹן נוֹחַ שֶׁנַּחְזֹר אֲלֵיכֶם?',
  [STATES.ASK_EMAIL]: 'הַאִם יֵשׁ לָכֶם כְּתוֹבֶת מֵייל? אִם אֵין, אֶפְשָׁר לְהַמְשִׁיךְ גַּם בְּלִי.'
};

function isOffScriptQuestion(text) {
  const t = (text || '').trim();
  if (!t) return false;
  const patterns = [/\?/, /תסביר/, /פרטים/, /הלכה/, /כמה עולה/, /משך/, /תנאים/, /שיטת/, /מסלול/];
  return patterns.some((re) => re.test(t));
}
function offScriptReply() {
  return 'אֲנַחְנוּ מַעֲרֶכֶת רִישּׁוּם בִּלְבַד. נָצִיג יַחֲזֹר אֲלֵיכֶם עִם כָּל הַהֶסְבֵּרִים.';
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/twilio-media-stream' });

wss.on('connection', (twilioWs) => {
  const tag = 'CALL';

  let streamSid = null;
  let callSid = null;
  let caller = '';
  let called = '';
  let source = 'Voice AI - Nice Line';

  let openAiReady = false;
  let callEnded = false;
  let crmSent = false;

  let state = STATES.ASK_TRACK;

  const lead = {
    first_name: '',
    last_name: '',
    phone_number: '',
    email: '',
    study_track: '',
    source: 'Voice AI - Nice Line',
    timestamp: ''
  };

  let lastMediaTs = Date.now();
  let idleWarned = false;

  // barge-in / tail guard
  let botSpeaking = false;
  let noListenUntilTs = 0;

  // --- RESPONSE QUEUE (the fix) ---
  let responseInFlight = false;
  const responseQueue = [];
  function enqueueTextPrompt(text, why = '') {
    responseQueue.push({ text, why });
    pumpQueue();
  }
  function pumpQueue() {
    if (callEnded) return;
    if (!openAiReady) return;
    if (responseInFlight) return;
    if (responseQueue.length === 0) return;

    const { text, why } = responseQueue.shift();
    responseInFlight = true;
    logDebug('QUEUE SEND', why, text);

    openAiWs.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
      })
    );
    openAiWs.send(JSON.stringify({ type: 'response.create' }));
  }

  function graceMs() {
    return Math.max(2000, Math.min(MB_HANGUP_GRACE_MS, 8000));
  }

  async function sendCrm(call_status, reason) {
    if (crmSent) return;
    crmSent = true;

    const payload = {
      first_name: lead.first_name || '',
      last_name: lead.last_name || '',
      phone_number: lead.phone_number || normalizeIsraeliPhone('', caller) || '',
      email: lead.email || '',
      study_track: lead.study_track || '',
      call_status,
      source,
      timestamp: lead.timestamp || nowIso(),
      caller_id: caller || '',
      called: called || '',
      callSid: callSid || '',
      streamSid: streamSid || '',
      reason: reason || ''
    };

    await sendWebhook(payload);
  }

  function finish(status, reason) {
    if (callEnded) return;
    callEnded = true;

    lead.timestamp = lead.timestamp || nowIso();
    sendCrm(status, reason).catch(() => {});

    // closing -> then close after grace (also queued safely)
    enqueueTextPrompt(`סיימו במשפט הבא בלבד: "${MB_CLOSING_SCRIPT}"`, 'closing');

    setTimeout(() => {
      try {
        openAiWs?.close();
      } catch {}
      try {
        twilioWs?.close();
      } catch {}
    }, graceMs());
  }

  function askCurrent() {
    const q = QUESTIONS[state];
    if (!q) return;
    enqueueTextPrompt(`שאלו במשפט אחד בלבד: "${q}"`, `ask_${state}`);
  }

  function sayThanksThenAskNext(nextState) {
    state = nextState;
    // בלי setTimeout בכלל — הכל בתור, לפי response.completed
    enqueueTextPrompt('אמרו בקצרה: "תּוֹדָה."', 'thanks');
    askCurrent();
  }

  // OpenAI WS
  const openAiWs = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    }
  );

  openAiWs.on('open', () => {
    openAiReady = true;

    openAiWs.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          model: 'gpt-4o-realtime-preview-2024-12-17',
          modalities: ['audio', 'text'],
          voice: OPENAI_VOICE,
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          input_audio_transcription: { model: 'whisper-1' },
          turn_detection: {
            type: 'server_vad',
            threshold: MB_VAD_THRESHOLD,
            silence_duration_ms: MB_VAD_SILENCE_MS + MB_VAD_SUFFIX_MS,
            prefix_padding_ms: MB_VAD_PREFIX_MS
          },
          max_response_output_tokens: 240,
          instructions: STRICT_SYSTEM_PROMPT
        }
      })
    );

    // IMPORTANT: Opening + First question in ONE queued response chain (no overlap)
    enqueueTextPrompt(
      `פתחו במשפט הבא בלבד: "${MB_OPENING_SCRIPT}" ולאחר מכן, בלי להוסיף שום דבר נוסף, שאלו: "${QUESTIONS[STATES.ASK_TRACK]}"`,
      'opening_and_first'
    );
  });

  openAiWs.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'response.audio.delta') {
      if (!streamSid) return;
      botSpeaking = true;
      noListenUntilTs = Date.now() + MB_NO_BARGE_TAIL_MS;
      twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: msg.delta } }));
      return;
    }

    if (msg.type === 'response.audio.done') {
      botSpeaking = false;
      return;
    }

    // This is the key: only after completed we allow next queued response
    if (msg.type === 'response.completed') {
      responseInFlight = false;
      pumpQueue();
      return;
    }

    if (msg.type === 'conversation.item.input_audio_transcription.completed') {
      const userText = (msg.transcript || '').trim();
      if (!userText || callEnded) return;

      logDebug('USER', userText);

      // Off-script
      if (isOffScriptQuestion(userText)) {
        enqueueTextPrompt(`ענו במשפט אחד בלבד: "${offScriptReply()}"`, 'off_script_reply');
        // then repeat current question
        askCurrent();
        return;
      }

      // State machine
      if (state === STATES.ASK_TRACK) {
        const tr = normalizeStudyTrack(userText);
        if (!tr) {
          enqueueTextPrompt(
            'אפשר לבחור אחד משלושת המסלולים: רַבָּנוּת, דַּיָּנוּת, אוֹ טוֹעֵן רַבָּנִי.',
            'track_clarify_once'
          );
          // repeat same question
          askCurrent();
          return;
        }
        lead.study_track = tr;
        sayThanksThenAskNext(STATES.ASK_FIRST);
        return;
      }

      if (state === STATES.ASK_FIRST) {
        lead.first_name = userText;
        sayThanksThenAskNext(STATES.ASK_LAST);
        return;
      }

      if (state === STATES.ASK_LAST) {
        lead.last_name = userText;
        sayThanksThenAskNext(STATES.ASK_PHONE);
        return;
      }

      if (state === STATES.ASK_PHONE) {
        const phone = normalizeIsraeliPhone(userText, caller);
        if (!phone) {
          if (!lead.__phone_retry) {
            lead.__phone_retry = true;
            enqueueTextPrompt(
              'לצורך רישום, צריך מספר בספרות בלבד, באורך תשע עד עשר ספרות. אפשר לחזור על המספר?',
              'phone_retry_once'
            );
            // ask again
            askCurrent();
            return;
          }
          // invalid twice -> partial
          finish('partial', 'invalid_phone_twice');
          return;
        }
        lead.phone_number = phone;
        sayThanksThenAskNext(STATES.ASK_EMAIL);
        return;
      }

      if (state === STATES.ASK_EMAIL) {
        const t = userText.toLowerCase();
        const saysNo = t.includes('אין') || t.includes('לא') || t.includes('בלי');

        if (saysNo) {
          lead.email = '';
          lead.timestamp = nowIso();
          finish('completed', 'done_no_email');
          return;
        }

        if (isValidEmailLike(userText)) {
          lead.email = userText.trim();
          lead.timestamp = nowIso();
          finish('completed', 'done_with_email');
          return;
        }

        if (!lead.__email_retry) {
          lead.__email_retry = true;
          enqueueTextPrompt('אם יש מייל, אפשר לומר אותו שוב לאט. ואם אין, אפשר לומר "אין".', 'email_retry_once');
          // ask again (same prompt)
          askCurrent();
          return;
        }

        // give up without pressure
        lead.email = '';
        lead.timestamp = nowIso();
        finish('completed', 'done_email_skipped');
        return;
      }
    }

    if (msg.type === 'error') {
      // IMPORTANT: don't crash the call. Mark response as not in flight and keep going.
      logError('OpenAI error', msg);
      responseInFlight = false;
      pumpQueue();
      // If the error is persistent, call will end by close/error handlers.
    }
  });

  openAiWs.on('close', () => {
    if (!callEnded) finish('partial', 'openai_closed');
  });
  openAiWs.on('error', () => {
    if (!callEnded) finish('partial', 'openai_ws_error');
  });

  // Idle timers
  const idleInterval = setInterval(() => {
    if (callEnded) return;
    const since = Date.now() - lastMediaTs;

    if (!idleWarned && since >= MB_IDLE_WARNING_MS) {
      idleWarned = true;
      enqueueTextPrompt('אני עדיין כאן על הקו. אתם איתי?', 'idle_warning');
    }
    if (since >= MB_IDLE_HANGUP_MS) {
      finish('partial', 'idle_timeout');
      clearInterval(idleInterval);
    }
  }, 1000);

  // Max call timers
  let maxWarnT = null,
    maxEndT = null;
  if (MB_MAX_CALL_MS > 0) {
    if (MB_MAX_WARN_BEFORE_MS > 0 && MB_MAX_CALL_MS > MB_MAX_WARN_BEFORE_MS) {
      maxWarnT = setTimeout(() => {
        if (!callEnded) enqueueTextPrompt('אנחנו מתקרבים לסיום. אפשר להשלים את הפרטים עכשיו.', 'max_call_warning');
      }, MB_MAX_CALL_MS - MB_MAX_WARN_BEFORE_MS);
    }
    maxEndT = setTimeout(() => {
      if (!callEnded) finish('partial', 'max_call_duration');
    }, MB_MAX_CALL_MS);
  }

  // Twilio WS side
  twilioWs.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.event === 'start') {
      streamSid = msg.start?.streamSid || null;
      callSid = msg.start?.callSid || null;

      const p = msg.start?.customParameters || {};
      caller = p.caller || '';
      called = p.called || '';
      source = p.source || source;

      logInfo(tag, 'start', { streamSid, callSid, caller, called });
      return;
    }

    if (msg.event === 'media') {
      lastMediaTs = Date.now();
      if (!openAiReady) return;

      // If barge-in disabled, ignore user audio while bot is speaking / tail window
      const now = Date.now();
      if (!MB_ALLOW_BARGE_IN) {
        if (botSpeaking || now < noListenUntilTs) return;
      }

      const payload = msg.media?.payload;
      if (!payload) return;

      openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: payload }));
      return;
    }

    if (msg.event === 'stop') {
      if (!callEnded) {
        // if we have enough -> completed else partial
        const enough =
          lead.study_track &&
          lead.first_name &&
          lead.last_name &&
          (lead.phone_number || normalizeIsraeliPhone('', caller));
        finish(enough ? 'completed' : 'partial', 'twilio_stop');
      }
    }
  });

  twilioWs.on('close', () => {
    clearInterval(idleInterval);
    if (maxWarnT) clearTimeout(maxWarnT);
    if (maxEndT) clearTimeout(maxEndT);
    if (!callEnded) finish('partial', 'twilio_ws_closed');
  });

  twilioWs.on('error', () => {
    clearInterval(idleInterval);
    if (maxWarnT) clearTimeout(maxWarnT);
    if (maxEndT) clearTimeout(maxEndT);
    if (!callEnded) finish('partial', 'twilio_ws_error');
  });
});

server.listen(PORT, () => {
  console.log(`✅ Nice Line WS server running on :${PORT}`);
});
