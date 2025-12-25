// server.js
// Nice Line – Voice AI (Inbound)
// Twilio Media Streams <-> OpenAI Realtime API
//
// FEATURES:
// - Response queue (prevents overlapping responses / conversation_already_has_active_response)
// - Buffer outgoing audio until Twilio start/streamSid (prevents cut opening)
// - Strict flow per spec (no selling, no explanations)
// - Hebrew-first STT/NLP (manual normalization for "רבנות/דיינות/טוען רבני")
// - Full conversation logging (BOT/USER/STATE) + errors
// - CRM delivery via Frontask WebToLead GET (preferred) + optional webhook fallback
// - Send data even on partial calls
//
// INSTALL:
//   npm i express ws dotenv
//
// RUN:
//   node server.js

require('dotenv').config();
const http = require('http');
const express = require('express');
const WebSocket = require('ws');

/* ------------------------- ENV helpers ------------------------- */
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
function envStr(name, def = '') {
  const v = process.env[name];
  return (v == null || v === '') ? def : String(v);
}

/* ------------------------- Core ENV ------------------------- */
const PORT = envNumber('PORT', 3000);

const OPENAI_API_KEY = envStr('OPENAI_API_KEY', '');
const OPENAI_VOICE = envStr('OPENAI_VOICE', 'alloy'); // supported voices: alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar
const MB_SPEECH_SPEED = envNumber('MB_SPEECH_SPEED', 0.95);

const MB_DEBUG = envBool('MB_DEBUG', false);
const MB_LOG_TRANSCRIPTS = envBool('MB_LOG_TRANSCRIPTS', true);
const MB_LOG_BOT = envBool('MB_LOG_BOT', true);
const MB_LOG_CRM = envBool('MB_LOG_CRM', true);
const MB_REDACT_LOGS = envBool('MB_REDACT_LOGS', false); // if true: mask phone/email in logs

// STT language hint (best-effort)
const MB_STT_LANGUAGE = envStr('MB_STT_LANGUAGE', 'he'); // he

/* ------------------------- Scripts ------------------------- */
const MB_OPENING_SCRIPT = envStr(
  'MB_OPENING_SCRIPT',
  'שָׁלוֹם. זֹאת מַעֲרֶכֶת הָרִישּׁוּם שֶׁל מֶרְכַּז מַל״מ. כְּדֵי שֶׁנָּצִיג יַחֲזֹר אֲלֵיכֶם לִבְדִיקַת הַתְאָמָה, אֶשְׁאַל כַּמָּה שְׁאֵלוֹת קְצָרוֹת.'
);

const MB_CLOSING_SCRIPT = envStr(
  'MB_CLOSING_SCRIPT',
  'תּוֹדָה רַבָּה, הַפְּרָטִים נִשְׁמְרוּ. נָצִיג הַמֶּרְכָּז יַחֲזֹר אֲלֵיכֶם בְּהֶקְדֵּם. יוֹם טוֹב.'
);

/* ------------------------- VAD (background noise) ------------------------- */
const MB_VAD_THRESHOLD = envNumber('MB_VAD_THRESHOLD', 0.65);
const MB_VAD_SILENCE_MS = envNumber('MB_VAD_SILENCE_MS', 900);
const MB_VAD_PREFIX_MS = envNumber('MB_VAD_PREFIX_MS', 200);
const MB_VAD_SUFFIX_MS = envNumber('MB_VAD_SUFFIX_MS', 200);

/* ------------------------- Call timers ------------------------- */
const MB_IDLE_WARNING_MS = envNumber('MB_IDLE_WARNING_MS', 25000);
const MB_IDLE_HANGUP_MS = envNumber('MB_IDLE_HANGUP_MS', 55000);
const MB_MAX_CALL_MS = envNumber('MB_MAX_CALL_MS', 4 * 60 * 1000);
const MB_MAX_WARN_BEFORE_MS = envNumber('MB_MAX_WARN_BEFORE_MS', 30000);
const MB_HANGUP_GRACE_MS = envNumber('MB_HANGUP_GRACE_MS', 4500);

/* ------------------------- Barge-in ------------------------- */
const MB_ALLOW_BARGE_IN = envBool('MB_ALLOW_BARGE_IN', false);
const MB_NO_BARGE_TAIL_MS = envNumber('MB_NO_BARGE_TAIL_MS', 1600);

/* ------------------------- CRM (Frontask preferred) ------------------------- */
const MB_FRONTASK_WEBTOLEAD_BASE = envStr('MB_FRONTASK_WEBTOLEAD_BASE', '').trim();
const MB_FRONTASK_SYSTEM_ID = envStr('MB_FRONTASK_SYSTEM_ID', '').trim();
const MB_FRONTASK_PROCESS_STEP_ID = envStr('MB_FRONTASK_PROCESS_STEP_ID', '').trim();
const MB_FRONTASK_MAILINGLIST = envStr('MB_FRONTASK_MAILINGLIST', '0').trim(); // 0/1
const MB_FRONTASK_UPDATE_EXISTING = envStr('MB_FRONTASK_UPDATE_EXISTING', '1').trim(); // 0/1

// Optional fallback webhook
const MB_WEBHOOK_URL = envStr('MB_WEBHOOK_URL', '').trim();

/* ------------------------- Logging helpers ------------------------- */
function dlog(...a) {
  if (MB_DEBUG) console.log('[DEBUG]', ...a);
}
function ilog(...a) {
  console.log('[INFO]', ...a);
}
function elog(...a) {
  console.error('[ERROR]', ...a);
}

function redactPhone(p) {
  const s = String(p || '');
  if (s.length < 4) return '***';
  return s.slice(0, 2) + '****' + s.slice(-2);
}
function redactEmail(e) {
  const s = String(e || '');
  const at = s.indexOf('@');
  if (at <= 1) return '***@***';
  return s[0] + '***' + s.slice(at);
}
function safeLogLead(lead) {
  if (!MB_REDACT_LOGS) return lead;
  return {
    ...lead,
    phone_number: redactPhone(lead.phone_number),
    email: redactEmail(lead.email)
  };
}

/* ------------------------- Normalization helpers ------------------------- */
function digitsOnly(v) {
  return String(v || '').replace(/\D/g, '');
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
  const t = String(s || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(t);
}
function normalizeStudyTrack(raw) {
  const t = String(raw || '').trim().toLowerCase();
  if (!t) return null;

  // Hebrew "Jewish" / yeshivish variations and common STT confusions
  const norm = t
    .replace(/ײַ/g, 'י')
    .replace(/״/g, '"')
    .replace(/׳/g, "'");

  // detect "טוען רבני" even if separated or slightly wrong
  if (norm.includes('טוען') || norm.includes('טוען רבני') || norm.includes('טוען-רבני')) return 'טוען רבני';

  // dayanut
  if (norm.includes('דיינות') || norm.includes('דיין') || norm.includes('דיינ')) return 'דיינות';

  // rabbanut
  if (norm.includes('רבנות') || norm.includes('רב')) return 'רבנות';

  return null;
}
function nowIso() {
  return new Date().toISOString();
}

/* ------------------------- HTTP helpers ------------------------- */
async function fetchWithTimeout(url, method = 'GET', body = null, timeoutMs = 4500, headers = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: ctrl.signal
    });
    clearTimeout(t);
    return res;
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

/* ------------------------- CRM senders ------------------------- */
async function sendLeadFrontask(leadPayload) {
  if (!MB_FRONTASK_WEBTOLEAD_BASE) return { ok: false, reason: 'frontask_not_configured' };

  const params = new URLSearchParams();
  params.set('type', 'get');
  params.set('FirstName', leadPayload.first_name || '');
  params.set('LastName', leadPayload.last_name || '');
  params.set('Phone', leadPayload.phone_number || '');
  params.set('MobilePhone', leadPayload.phone_number || '');
  params.set('Email', leadPayload.email || '');

  // Optional fields kept empty
  params.set('NamePrefix', '');
  params.set('Title', '');
  params.set('Address', '');
  params.set('City', '');
  params.set('AccountName', '');

  // remarks for staff context
  params.set('Remarks', leadPayload.remarks || '');

  params.set('MailingList', MB_FRONTASK_MAILINGLIST);
  if (MB_FRONTASK_SYSTEM_ID) params.set('SystemID', MB_FRONTASK_SYSTEM_ID);
  if (MB_FRONTASK_PROCESS_STEP_ID) params.set('ProcessDefinitionStepID', MB_FRONTASK_PROCESS_STEP_ID);
  params.set('RedirectTo', '');
  params.set('UpdateExistingDetails', MB_FRONTASK_UPDATE_EXISTING);

  const url = `${MB_FRONTASK_WEBTOLEAD_BASE}?${params.toString()}`;

  try {
    const res = await fetchWithTimeout(url, 'GET', null, 4500);
    if (!res.ok) {
      return { ok: false, reason: `frontask_http_${res.status}` };
    }
    return { ok: true, reason: 'frontask_ok' };
  } catch (e) {
    return { ok: false, reason: `frontask_error_${e?.name || 'err'}` };
  }
}

async function sendLeadWebhook(leadPayload) {
  if (!MB_WEBHOOK_URL) return { ok: false, reason: 'webhook_not_configured' };
  try {
    const res = await fetchWithTimeout(
      MB_WEBHOOK_URL,
      'POST',
      JSON.stringify(leadPayload),
      4500,
      { 'Content-Type': 'application/json' }
    );
    if (!res.ok) return { ok: false, reason: `webhook_http_${res.status}` };
    return { ok: true, reason: 'webhook_ok' };
  } catch (e) {
    return { ok: false, reason: `webhook_error_${e?.name || 'err'}` };
  }
}

async function deliverLead(leadPayload) {
  // Prefer Frontask if configured; fallback to webhook if provided
  if (MB_FRONTASK_WEBTOLEAD_BASE) {
    const r = await sendLeadFrontask(leadPayload);
    if (r.ok) return r;
    if (MB_WEBHOOK_URL) return await sendLeadWebhook(leadPayload);
    return r;
  }
  return await sendLeadWebhook(leadPayload);
}

/* ------------------------- Strict prompt & flow ------------------------- */
const STRICT_SYSTEM_PROMPT = `
אַתֶּם מַעֲרֶכֶת רִישּׁוּם אוֹטוֹמָטִית שֶׁל מַכּוֹן תּוֹרָנִי.
מַטָּרָה בִּלְבַד:
- לִשְׁאֹל שְׁאֵלָה אַחַת שֶׁל סִינוּן מַסְלוּל: רַבָּנוּת / דַּיָּנוּת / טוֹעֵן רַבָּנִי
- לֶאֱסֹף פְּרָטֵי קֶשֶׁר בְּסִיסִיִּים: שֵׁם פְּרָטִי, שֵׁם מִשְׁפָּחָה, טֵלֵפוֹן, מֵייל (אוֹפְּצְיוֹנָלִי)
- לְהַעֲבִיר לְנָצִיג אֱנוֹשִׁי.
אֲסוּר:
- לְהַסְבִּיר עַל הַמַּסְלוּלִים
- לַעֲנוֹת שְׁאֵלוֹת הֲלָכָה אוֹ תּוֹכֶן
- לְהַבְטִיחַ הַבְטָחוֹת
אִם שׁוֹאֲלִים שְׁאֵלָה: "אֲנִי מַעֲרֶכֶת רִישּׁוּם בִּלְבַד. נָצִיג יַחֲזֹר אֵלֶיךָ עִם כָּל הַהֶסְבֵּרִים."
תְּשׁוּבוֹת קְצָרוֹת, עִנְיָנִיּוֹת, בְּעִבְרִית בִּלְבַד.
`.trim();

const STATES = {
  ASK_TRACK: 'ASK_TRACK',
  ASK_FIRST: 'ASK_FIRST',
  ASK_LAST: 'ASK_LAST',
  ASK_PHONE: 'ASK_PHONE',
  ASK_EMAIL: 'ASK_EMAIL'
};

const QUESTIONS = {
  [STATES.ASK_TRACK]: 'לְאֵיזֶה מַסְלוּל אַתֶּם מְעוֹנְיָנִים? רַבָּנוּת, דַּיָּנוּת, אוֹ טוֹעֵן רַבָּנִי?',
  [STATES.ASK_FIRST]: 'מַה הַשֵּׁם הַפְּרָטִי שֶׁלָּכֶם?',
  [STATES.ASK_LAST]: 'וּמָה שֵׁם הַמִּשְׁפָּחָה?',
  [STATES.ASK_PHONE]: 'בְּאֵיזֶה מִסְפָּר טֵלֵפוֹן נוֹחַ שֶׁנַּחְזֹר אֲלֵיכֶם?',
  [STATES.ASK_EMAIL]: 'הַאִם יֵשׁ לָכֶם כְּתוֹבֶת מֵייל? אִם אֵין, אֶפְשָׁר לְהַמְשִׁיךְ גַּם בְּלִי.'
};

function isOffScriptQuestion(text) {
  const t = (text || '').trim();
  if (!t) return false;
  // Keep it strict: any question/explanation request -> off script
  return [/\?/, /תסביר/, /פרטים/, /הלכה/, /כמה עולה/, /משך/, /תנאים/, /שיטת/, /מסלול/].some((re) => re.test(t));
}
function offScriptReply() {
  return 'אֲנִי מַעֲרֶכֶת רִישּׁוּם בִּלְבַד. נָצִיג יַחֲזֹר אֵלֶיךָ עִם כָּל הַהֶסְבֵּרִים.';
}

/* ------------------------- Server setup ------------------------- */
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/twilio-media-stream' });

app.get('/health', (_req, res) => res.json({ ok: true, time: nowIso() }));

wss.on('connection', (twilioWs) => {
  const tag = 'CALL';

  let streamSid = null;
  let callSid = null;
  let caller = '';
  let called = '';
  let source = 'Voice AI - Nice Line';

  let openAiReady = false;
  let callEnded = false;
  let leadSent = false;

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

  // outgoing audio buffer until streamSid exists
  const outAudioBuffer = [];
  const MAX_AUDIO_BUFFER = 300;

  // response queue to avoid overlap
  let responseInFlight = false;
  const responseQueue = [];

  // idle tracking
  let lastMediaTs = Date.now();
  let idleWarned = false;

  // barge-in tail
  let botSpeaking = false;
  let noListenUntilTs = 0;

  function graceMs() {
    return Math.max(2000, Math.min(MB_HANGUP_GRACE_MS, 8000));
  }

  function logState(note) {
    ilog(`[STATE] ${state}${note ? ' | ' + note : ''}`);
  }

  function logUser(text) {
    if (!MB_LOG_TRANSCRIPTS) return;
    ilog(`USER> ${text}`);
  }

  function logBot(text) {
    if (!MB_LOG_BOT) return;
    ilog(`BOT> ${text}`);
  }

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
    dlog('QUEUE SEND', why, text);

    openAiWs.send(JSON.stringify({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
    }));
    openAiWs.send(JSON.stringify({ type: 'response.create' }));
  }

  async function deliver(call_status, reason) {
    if (leadSent) return;
    leadSent = true;

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
      reason: reason || '',
      remarks: `מסלול: ${lead.study_track || ''} | סטטוס: ${call_status} | caller: ${caller || ''} | callSid: ${callSid || ''}`
    };

    if (MB_LOG_CRM) ilog('CRM> sending', safeLogLead(payload));

    const r = await deliverLead(payload);
    if (MB_LOG_CRM) ilog('CRM> result', r);

    if (!r.ok) elog('CRM> FAILED', r);
  }

  async function finish(status, reason) {
    if (callEnded) return;
    callEnded = true;

    lead.timestamp = lead.timestamp || nowIso();

    await deliver(status, reason);

    enqueueTextPrompt(`סיימו במשפט הבא בלבד: "${MB_CLOSING_SCRIPT}"`, 'closing');

    setTimeout(() => {
      try { openAiWs?.close(); } catch {}
      try { twilioWs?.close(); } catch {}
    }, graceMs());
  }

  function askCurrent() {
    const q = QUESTIONS[state];
    if (!q) return;
    enqueueTextPrompt(`שאלו במשפט אחד בלבד: "${q}"`, `ask_${state}`);
    logBot(q);
  }

  function sayThanksThen(nextState) {
    state = nextState;
    logState('next');
    enqueueTextPrompt('אמרו בקצרה: "תּוֹדָה."', 'thanks');
    logBot('תודה.');
    askCurrent();
  }

  /* ------------------------- OpenAI WS ------------------------- */
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

    // Session update (best-effort language hint via instructions + STT model)
    openAiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        model: 'gpt-4o-realtime-preview-2024-12-17',
        modalities: ['audio', 'text'],
        voice: OPENAI_VOICE,
        // speed: best-effort (not all endpoints support it; harmless if ignored)
        // If ignored, we still control pace via short prompts
        speed: MB_SPEECH_SPEED,

        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        input_audio_transcription: {
          model: 'whisper-1'
          // Some deployments support language; if ignored, it won't break:
          // language: MB_STT_LANGUAGE
        },
        turn_detection: {
          type: 'server_vad',
          threshold: MB_VAD_THRESHOLD,
          silence_duration_ms: MB_VAD_SILENCE_MS + MB_VAD_SUFFIX_MS,
          prefix_padding_ms: MB_VAD_PREFIX_MS
        },
        max_response_output_tokens: 280,
        instructions:
          STRICT_SYSTEM_PROMPT +
          `\n\nהנחיית תמלול: השיחה בעברית. מונחים נפוצים: "רבנות", "דיינות", "טוען רבני", "מל״מ".`
      }
    }));

    // Split opening + first question (prevents truncation + more natural)
    enqueueTextPrompt(`פתחו במשפט הבא בלבד (בלי להוסיף שום דבר): "${MB_OPENING_SCRIPT}"`, 'opening_only');
    logBot(MB_OPENING_SCRIPT);

    enqueueTextPrompt(`שאלו עכשיו במשפט אחד בלבד: "${QUESTIONS[STATES.ASK_TRACK]}"`, 'first_question');
    logBot(QUESTIONS[STATES.ASK_TRACK]);

    logState('start');
  });

  openAiWs.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'response.audio.delta') {
      botSpeaking = true;
      noListenUntilTs = Date.now() + MB_NO_BARGE_TAIL_MS;

      if (!streamSid) {
        outAudioBuffer.push(msg.delta);
        if (outAudioBuffer.length > MAX_AUDIO_BUFFER) outAudioBuffer.shift();
        return;
      }
      twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: msg.delta } }));
      return;
    }

    if (msg.type === 'response.audio.done') {
      botSpeaking = false;
      return;
    }

    if (msg.type === 'response.completed') {
      responseInFlight = false;
      pumpQueue();
      return;
    }

    // Transcription completed => user said something
    if (msg.type === 'conversation.item.input_audio_transcription.completed') {
      const userText = (msg.transcript || '').trim();
      if (!userText || callEnded) return;

      logUser(userText);

      // Off-script handling
      if (isOffScriptQuestion(userText)) {
        const reply = offScriptReply();
        enqueueTextPrompt(`ענו במשפט אחד בלבד: "${reply}"`, 'off_script');
        logBot(reply);
        askCurrent();
        return;
      }

      // State machine (strict)
      if (state === STATES.ASK_TRACK) {
        const tr = normalizeStudyTrack(userText);
        if (!tr) {
          const clarify =
            'אפשר לבחור אחד משלושת המסלולים: רַבָּנוּת, דַּיָּנוּת, אוֹ טוֹעֵן רַבָּנִי.';
          enqueueTextPrompt(clarify, 'track_clarify');
          logBot(clarify);
          askCurrent();
          return;
        }
        lead.study_track = tr;
        sayThanksThen(STATES.ASK_FIRST);
        return;
      }

      if (state === STATES.ASK_FIRST) {
        lead.first_name = userText;
        sayThanksThen(STATES.ASK_LAST);
        return;
      }

      if (state === STATES.ASK_LAST) {
        lead.last_name = userText;
        sayThanksThen(STATES.ASK_PHONE);
        return;
      }

      if (state === STATES.ASK_PHONE) {
        const phone = normalizeIsraeliPhone(userText, caller);
        if (!phone) {
          if (!lead.__phone_retry) {
            lead.__phone_retry = true;
            const retry =
              'לצורך רישום, צריך מספר בספרות בלבד, באורך תשע עד עשר ספרות. אפשר לחזור על המספר?';
            enqueueTextPrompt(retry, 'phone_retry');
            logBot(retry);
            askCurrent();
            return;
          }
          await finish('partial', 'invalid_phone_twice');
          return;
        }
        lead.phone_number = phone;
        sayThanksThen(STATES.ASK_EMAIL);
        return;
      }

      if (state === STATES.ASK_EMAIL) {
        const t = userText.toLowerCase();
        const saysNo = t.includes('אין') || t.includes('לא') || t.includes('בלי');

        if (saysNo) {
          lead.email = '';
          await finish('completed', 'done_no_email');
          return;
        }

        if (isValidEmailLike(userText)) {
          lead.email = userText.trim();
          await finish('completed', 'done_with_email');
          return;
        }

        if (!lead.__email_retry) {
          lead.__email_retry = true;
          const retry = 'אם יש מייל, אפשר לומר אותו שוב לאט. ואם אין, אפשר לומר "אין".';
          enqueueTextPrompt(retry, 'email_retry');
          logBot(retry);
          askCurrent();
          return;
        }

        // Give up without pressure
        lead.email = '';
        await finish('completed', 'done_email_skipped');
        return;
      }
    }

    if (msg.type === 'error') {
      // Don't crash the call; log and continue queue
      elog('OpenAI error', msg);
      responseInFlight = false;
      pumpQueue();
    }
  });

  openAiWs.on('close', async () => {
    if (!callEnded) {
      elog('OpenAI WS closed');
      await finish('partial', 'openai_closed');
    }
  });

  openAiWs.on('error', async (e) => {
    if (!callEnded) {
      elog('OpenAI WS error', e?.message || e);
      await finish('partial', 'openai_ws_error');
    }
  });

  /* ------------------------- Idle + Max timers ------------------------- */
  const idleInterval = setInterval(async () => {
    if (callEnded) return;
    const since = Date.now() - lastMediaTs;

    if (!idleWarned && since >= MB_IDLE_WARNING_MS) {
      idleWarned = true;
      const warn = 'אני עדיין כאן על הקו. אתם איתי?';
      enqueueTextPrompt(warn, 'idle_warning');
      logBot(warn);
    }
    if (since >= MB_IDLE_HANGUP_MS) {
      await finish('partial', 'idle_timeout');
      clearInterval(idleInterval);
    }
  }, 1000);

  let maxWarnT = null, maxEndT = null;
  if (MB_MAX_CALL_MS > 0) {
    if (MB_MAX_WARN_BEFORE_MS > 0 && MB_MAX_CALL_MS > MB_MAX_WARN_BEFORE_MS) {
      maxWarnT = setTimeout(() => {
        if (!callEnded) {
          const warn = 'אנחנו מתקרבים לסיום. אפשר להשלים את הפרטים עכשיו.';
          enqueueTextPrompt(warn, 'max_call_warning');
          logBot(warn);
        }
      }, MB_MAX_CALL_MS - MB_MAX_WARN_BEFORE_MS);
    }
    maxEndT = setTimeout(async () => {
      if (!callEnded) await finish('partial', 'max_call_duration');
    }, MB_MAX_CALL_MS);
  }

  /* ------------------------- Twilio WS ------------------------- */
  twilioWs.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.event === 'start') {
      streamSid = msg.start?.streamSid || null;
      callSid = msg.start?.callSid || null;

      const p = msg.start?.customParameters || {};
      caller = p.caller || '';
      called = p.called || '';
      source = p.source || source;

      ilog('[INFO] CALL start', { streamSid, callSid, caller, called });

      // flush buffered bot audio now that streamSid exists
      if (streamSid && outAudioBuffer.length) {
        for (const b64 of outAudioBuffer.splice(0, outAudioBuffer.length)) {
          twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: b64 } }));
        }
      }
      return;
    }

    if (msg.event === 'media') {
      lastMediaTs = Date.now();
      if (!openAiReady) return;

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
        // determine completed vs partial by required fields
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
    dlog('Twilio WS closed');
  });

  twilioWs.on('error', (e) => {
    clearInterval(idleInterval);
    if (maxWarnT) clearTimeout(maxWarnT);
    if (maxEndT) clearTimeout(maxEndT);
    elog('Twilio WS error', e?.message || e);
  });
});

/* ------------------------- Boot ------------------------- */
server.listen(PORT, () => {
  ilog(`✅ Nice Line WS server running on :${PORT}`);
  ilog('✅ Health:', `/health`);
});
