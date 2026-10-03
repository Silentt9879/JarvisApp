// Unit test for remote control (src/remote.mjs), against a fake Telegram - no network, no
// bot, no session. Every safety rule in remote.mjs has a case here, including the attacks:
// a stranger, a group, a message sent while JARVIS was away, and a forged button.
//   node scripts/remote-test.mjs
import { createRemote, chunk, greeting } from '../src/remote.mjs';
import { toTelegramHtml, balanceFences } from '../src/tgformat.mjs';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const ME = 6724782799;
const STRANGER = 1111111;
let pass = 0;
let fail = 0;
const ok = (cond, name) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fake Bot API: records every call, hands out message ids, and queues updates for getUpdates. */
function fakeTelegram() {
  const calls = [];
  const queue = [];
  let nextUpdate = 1;
  let nextMsg = 100;
  const api = async (token, method, body = {}, opts = {}) => {
    if (method !== 'getUpdates') calls.push({ method, body });
    if (method === 'getUpdates') {
      const pending = queue.filter((u) => u.update_id >= (body.offset || 0));
      if (pending.length) { queue.splice(0, queue.length, ...queue.filter((u) => u.update_id >= (body.offset || 0))); return { ok: true, result: pending.splice(0) }; }
      await new Promise((r) => { const t = setTimeout(r, 15); opts.signal?.addEventListener('abort', () => { clearTimeout(t); r(); }); });
      if (opts.signal?.aborted) return { ok: false, aborted: true };
      return { ok: true, result: [] };
    }
    if (method === 'sendMessage' && body.parse_mode && body.text.includes('UNPARSEABLE')) return { ok: false, error: "Bad Request: can't parse entities" };
    if (method === 'sendMessage') return { ok: true, result: { message_id: nextMsg++, text: body.text } };
    return { ok: true, result: true };
  };
  const upload = async (token, method, fields, file) => {
    calls.push({ method, body: fields, file });
    if (fields.fail) return { ok: false, error: 'nope' };
    return { ok: true, result: { message_id: nextMsg++ } };
  };
  return {
    api,
    upload,
    calls,
    files: () => calls.filter((c) => c.file),
    sent: () => calls.filter((c) => c.method === 'sendMessage').map((c) => c.body),
    edits: () => calls.filter((c) => c.method === 'editMessageText').map((c) => c.body),
    clear: () => { calls.length = 0; },
    message(text, { from = ME, chat = ME, type = 'private', date = Math.floor(Date.now() / 1000) + 5, extra = {} } = {}) {
      queue.push({ update_id: nextUpdate++, message: { message_id: 9000 + nextUpdate, date, ...(text != null ? { text } : {}), ...extra, from: { id: from }, chat: { id: chat, type } } });
    },
    tap(data, messageId, { from = ME } = {}) {
      queue.push({ update_id: nextUpdate++, callback_query: { id: `cq${nextUpdate}`, from: { id: from }, data, message: { message_id: messageId } } });
    },
  };
}

const SESSIONS = [
  { id: '11111111-1111-4111-8111-111111111111', title: 'Fix the panel login', lastModified: Date.now() - 5 * 60000 },
  { id: '22222222-2222-4222-8222-222222222222', title: 'Driver app release notes', lastModified: Date.now() - 3 * 3600000 },
  { id: '33333333-3333-4333-8333-333333333333', title: 'Panel web invoices', lastModified: Date.now() - 2 * 86400000 },
];

function rig({ on = true, atDesk = false, remindMs } = {}) {
  const tg = fakeTelegram();
  const cfg = { on, token: TOKEN, chatId: String(ME), name: '@test' };
  const seen = { submitted: [], attached: [], downloads: [], saved: [], responded: [], interrupts: 0, fresh: 0, logs: [], switched: [], transcribed: 0, brief: { on: true, at: '08:00' } };
  const desk = { at: atDesk, current: SESSIONS[0].id, transcript: 'run the tests please', voiceReady: true, screens: 1 };
  const r = createRemote({
    cfg: () => cfg,
    log: (...a) => seen.logs.push(a.join(' ')),
    atDesk: () => desk.at,
    submit: (text, atts = []) => { seen.submitted.push(text); seen.attached.push(atts); return true; },
    // A fake file store: file ids starting "big" are oversized, "gone" fail to download.
    download: async (_token, fileId, maxBytes) => {
      seen.downloads.push(fileId);
      if (fileId.startsWith('gone')) return { ok: false, error: 'file is gone' };
      const data = Buffer.from(`pixels of ${fileId}`);
      return data.length > maxBytes ? { ok: false, tooBig: true } : { ok: true, data };
    },
    newSession: () => { seen.fresh++; },
    interrupt: () => { seen.interrupts++; },
    respond: (id, decision, verdict) => seen.responded.push({ id, decision, verdict }),
    workspace: () => 'C:\\Users\\User\\Downloads\\Bantu Apps',
    api: tg.api,
    upload: tg.upload,
    screens: async () => Array.from({ length: desk.screens }, (_, i) => ({ name: `Screen ${i + 1}`, data: Buffer.from(`jpeg ${i}`) })),
    diff: async (q) => (q ? { text: `📝 ${q} on main`, file: { name: `${q}.diff`, data: Buffer.from('diff --git a b'), type: 'text/x-diff' } } : { text: 'All 9 repositories are clean.' }),
    brief: async () => '☀️ Good morning - the brief',
    briefSet: (patch) => { Object.assign(seen.brief, patch); return { ...seen.brief }; },
    sessions: async () => SESSIONS,
    currentSession: () => desk.current,
    switchSession: async (id, title) => { seen.switched.push({ id, title }); desk.current = id; return { ok: true, last: 'Last thing I said.' }; },
    saveIncoming: async (name, data) => { seen.saved.push({ name, data: data.toString() }); return `C:\\Users\\User\\Downloads\\JARVIS from phone\\${name}`; },
    readAttachment: async (p) => (/huge/.test(p) ? null : Buffer.from(`contents of ${p}`)),
    transcribe: async () => { seen.transcribed++; return { ok: true, text: desk.transcript }; },
    voiceReady: () => desk.voiceReady,
    remindMs,
  });
  return { tg, cfg, seen, r, desk };
}
const settle = () => sleep(120); // let the poll loop take what is queued

// ------------------------------------------------------------------ who may speak
{
  const { tg, seen, r } = rig();
  r.start();
  await sleep(30);
  tg.message('rm -rf everything', { from: STRANGER, chat: STRANGER });
  tg.message('run this', { from: ME, chat: -100123, type: 'group' });
  tg.message('sneaky', { from: STRANGER, chat: ME });
  await settle();
  ok(seen.submitted.length === 0, 'strangers, groups and a stranger in my chat are never submitted');
  ok(tg.sent().length === 0, 'and are never answered - silence confirms nothing');
  ok(seen.logs.some((l) => l.includes('not yours')), 'a stranger is logged');
  tg.message('hello from my phone');
  await settle();
  ok(seen.submitted[0] === 'hello from my phone', 'my own message is submitted as typed');
  ok(seen.logs.filter((l) => l.includes('listening for Telegram')).length === 1, 'switched on: the log says it is listening, once');
  r.stop();
}

// ------------------------------------------------------------------ nothing runs late
{
  const { tg, seen, r, cfg } = rig();
  r.start();
  await sleep(30);
  const old = Math.floor(Date.now() / 1000) - 3600;
  tg.message('sent an hour ago', { date: old });
  tg.message('also old', { date: old });
  await settle();
  ok(seen.submitted.length === 0, 'messages from before JARVIS was listening are not run');
  ok(tg.sent().filter((m) => /not listening/.test(m.text)).length === 1, 'one note covers the whole backlog');

  // switched off, a message sent, switched back on: still not run
  cfg.on = false;
  await sleep(1700);
  const sentWhileOff = Math.floor(Date.now() / 1000);
  cfg.on = true;
  await sleep(1700); // the loop notices it is live again; the clock restarts
  tg.message('sent while remote control was off', { date: sentWhileOff - 1 });
  await settle();
  ok(seen.submitted.length === 0, 'a message sent while remote control was off is not run when it comes back on');
  r.stop();
}

// ------------------------------------------------------------------ commands
{
  const { tg, seen, r } = rig();
  r.start();
  await sleep(30);
  r.event({ kind: 'status', state: 'ready' });
  r.event({ kind: 'init', model: 'claude-opus-5-5', permissionMode: 'default' });
  tg.message('/help');
  tg.message('/status');
  tg.message('/stop');
  tg.message('/new');
  tg.message('/delete all');
  await settle();
  const texts = tg.sent().map((m) => m.text);
  ok(texts.some((t) => t.includes('/stop - stop the current turn')), '/help lists the commands');
  ok(texts.some((t) => t.startsWith('Standing by') && t.includes('Bantu Apps')), '/status says the state and the workspace');
  ok(texts.includes('Nothing is running.') && seen.interrupts === 0, '/stop while idle does nothing');
  ok(seen.fresh === 1, '/new while idle starts a new session');
  ok(texts.some((t) => t.includes('only works at the desk')) && !seen.submitted.length, '/delete is refused, never passed through');

  r.event({ kind: 'status', state: 'working' });
  tg.message('/new');
  tg.message('/stop');
  await settle();
  ok(seen.fresh === 1, '/new mid-turn is refused');
  ok(seen.interrupts === 1, '/stop mid-turn interrupts');
  tg.message('/compact');
  await settle();
  ok(seen.submitted.includes('/compact'), 'other slash commands go to Claude Code as typed');
  r.stop();
}

// ------------------------------------------------------------------ a turn from the phone
{
  const { tg, seen, r } = rig({ atDesk: true });
  r.start();
  await sleep(30);
  r.event({ kind: 'status', state: 'ready' });
  r.noteSend('telegram', { ok: true });
  r.event({ kind: 'status', state: 'working' });
  ok(tg.calls.some((c) => c.method === 'sendChatAction'), 'typing shows while JARVIS works on a phone turn');

  // an approval mid-turn, while sitting at the desk: still goes to the phone, it is a phone turn
  const claimed = r.event({ kind: 'permission', id: 'toolu_1', toolName: 'Bash', detail: 'npm test', canAlways: true });
  await settle();
  const perm = tg.sent().at(-1);
  ok(claimed === true, 'a phone turn\u2019s approval is claimed, so the alert watcher stays quiet');
  ok(perm.text.includes('npm test'), 'the approval shows the exact command');
  const kb = perm.reply_markup.inline_keyboard;
  ok(kb[0].map((b) => b.text).join('|') === '✗ Deny|✓ Allow once' && kb[1][0].text === 'Allow for this session', 'Deny / Allow once, and Allow for this session on its own row');

  const permMsg = 100 + tg.sent().length - 1;
  const key = kb[0][1].callback_data.split(':')[1];
  // forged: right key, wrong message
  tg.tap(`a:${key}`, permMsg + 50);
  // a stranger tapping the real message
  tg.tap(`a:${key}`, permMsg, { from: STRANGER });
  await settle();
  ok(seen.responded.length === 0, 'a forged button and a stranger\u2019s tap approve nothing');
  tg.tap(`a:${key}`, permMsg);
  await settle();
  ok(seen.responded.length === 1 && seen.responded[0].decision.type === 'allow' && seen.responded[0].id === 'toolu_1', 'my tap on the real button allows once');
  ok(/from your phone/.test(seen.responded[0].verdict), 'the window is told it was answered from the phone');
  ok(seen.logs.some((l) => l.includes('approval sent to the phone - Bash')) && seen.logs.some((l) => l.includes('Allowed once from your phone - Bash')),
    'the audit trail records what went to the phone and what was decided there');
  ok(!seen.logs.some((l) => l.includes('npm test')), 'and never the command text, which can carry secrets');
  tg.tap(`d:${key}`, permMsg);
  await settle();
  ok(seen.responded.length === 1, 'a second tap changes nothing');
  r.event({ kind: 'prompt_done', id: 'toolu_1' });

  // typing instead of tapping: a reply, not a decision and not a new message
  r.event({ kind: 'permission', id: 'toolu_r', toolName: 'Bash', detail: 'rm -rf build' });
  await settle();
  ok(/type a reply instead/.test(tg.sent().at(-1).text), 'the approval says a typed reply is an option');
  tg.message('wait, check the logs first');
  await settle();
  const rep = seen.responded.at(-1);
  ok(rep.id === 'toolu_r' && rep.decision.type === 'reply' && rep.decision.text === 'wait, check the logs first', 'a typed message replies to the open approval');
  ok(!seen.submitted.includes('wait, check the logs first'), 'and is not sent to JARVIS as a new message');
  ok(tg.edits().some((e) => /replied instead/.test(e.text)), 'the approval is marked as replied to');
  r.event({ kind: 'prompt_done', id: 'toolu_r' });

  // updates along the way, then the reply: each one reaches the chat as it is written, in order
  tg.clear();
  r.event({ kind: 'text_final', text: 'Quick update: running the tests now.' });
  r.event({ kind: 'text_final', text: 'Tests pass: 42 of 42.' });
  await settle();
  ok(tg.sent().map((m) => m.text).join('|') === 'Quick update: running the tests now.|Tests pass: 42 of 42.',
    'every update of a phone turn reaches the chat as it is written, not only the last one at the end');
  tg.clear();
  const claimedResult = r.event({ kind: 'result', ok: true, durationMs: 9100 });
  await settle();
  ok(claimedResult === true && tg.sent().length === 0, 'a clean ending adds no duplicate of the reply');
  ok(r._state().origins.length === 0, 'and the turn is closed');

  // a phone turn that wrote nothing still says it finished
  r.noteSend('telegram', { ok: true });
  tg.clear();
  r.event({ kind: 'result', ok: true, durationMs: 2000 });
  await settle();
  ok(tg.sent()[0]?.text === 'Done in 2.0s.', 'a turn with no text says Done');
  r.stop();
}

// ------------------------------------------------------------------ a turn from the desk
{
  const { tg, r, desk } = rig({ atDesk: true });
  r.start();
  await sleep(30);
  r.noteSend('desk', { ok: true });
  ok(r.event({ kind: 'permission', id: 't2', toolName: 'Edit', detail: 'a.txt' }) === false, 'at the desk, a desk turn\u2019s approval stays at the desk');
  desk.at = false;
  ok(r.event({ kind: 'permission', id: 't3', toolName: 'Edit', detail: 'b.txt' }) === true, 'away from the desk, it follows you to the phone');
  await settle();
  r.event({ kind: 'text_final', text: 'desk reply' });
  tg.clear();
  ok(r.event({ kind: 'result', ok: true }) === false, 'a desk turn\u2019s reply is left to the alerts');
  await settle();
  ok(!tg.sent().some((m) => m.text === 'desk reply'), 'and is not sent twice');

  // answered at the desk: the phone loses its buttons
  r.event({ kind: 'prompt_done', id: 't3' });
  await settle();
  ok(tg.edits().some((e) => /answered at the desk/.test(e.text)), 'a prompt settled at the desk is marked so on the phone');
  r.stop();
}

// ------------------------------------------------------------------ questions
{
  const { tg, seen, r } = rig();
  r.start();
  await sleep(30);
  r.noteSend('telegram', { ok: true });
  r.event({
    kind: 'question', id: 'q1', questions: [
      { question: 'Which database?', header: 'DB', options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
      { question: 'Which checks?', multiSelect: true, options: [{ label: 'Lint' }, { label: 'Types' }, { label: 'Tests' }] },
    ],
  });
  await settle();
  const qMsg = 100 + tg.sent().length - 1;
  const kb1 = tg.sent().at(-1).reply_markup.inline_keyboard;
  const keyQ = kb1[0][0].callback_data.split(':')[1];
  tg.tap(`o:${keyQ}:0:1`, qMsg);           // SQLite
  await settle();
  ok(tg.edits().at(-1)?.text.includes('Question 2 of 2'), 'answering the first question moves to the second');
  tg.tap(`o:${keyQ}:0:0`, qMsg);           // a stale tap on question 1
  tg.tap(`o:${keyQ}:1:0`, qMsg);           // Lint
  tg.tap(`o:${keyQ}:1:2`, qMsg);           // Tests
  tg.tap(`n:${keyQ}:1`, qMsg);             // Done
  await settle();
  const ans = seen.responded.at(-1);
  ok(ans?.decision.type === 'answer' && ans.decision.answers['Which database?'] === 'SQLite' && ans.decision.answers['Which checks?'] === 'Lint, Tests',
    'single and multiple choices come back in the window\u2019s answer format');
  ok(seen.responded.length === 1, 'a stale tap on an earlier question is ignored');

  // a typed answer is an "Other", not a new message
  r.event({ kind: 'question', id: 'q2', questions: [{ question: 'Name the branch?', options: [{ label: 'main' }] }] });
  await settle();
  tg.message('feature/wheel-v2');
  await settle();
  ok(seen.responded.at(-1).decision.answers['Name the branch?'] === 'feature/wheel-v2', 'a typed reply answers the open question');
  ok(!seen.submitted.includes('feature/wheel-v2'), 'and is not sent to JARVIS as a new message');

  // skip
  r.event({ kind: 'question', id: 'q3', questions: [{ question: 'Proceed?', options: [{ label: 'Yes' }] }] });
  await settle();
  const k3 = tg.sent().at(-1).reply_markup.inline_keyboard.at(-1)[0].callback_data;
  tg.tap(k3, 100 + tg.sent().length - 1);
  await settle();
  ok(seen.responded.at(-1).decision.type === 'deny' && /skipped/.test(seen.responded.at(-1).decision.message), 'Skip declines the question');
  r.stop();
}

// ------------------------------------------------------------------ stopping, failures, length
{
  const { tg, r } = rig();
  r.start();
  await sleep(30);
  r.event({ kind: 'status', state: 'working' });
  r.noteSend('telegram', { ok: true });
  tg.message('/stop');
  await settle();
  r.event({ kind: 'text_final', text: 'Half way' });
  await settle();
  tg.clear();
  r.event({ kind: 'result', ok: false, subtype: 'error_during_execution' });
  await settle();
  ok(tg.sent()[0]?.text === 'Stopped, as you asked.', 'a /stop ending says so, not "error" - after the update already sent');

  tg.clear();
  r.noteSend('telegram', { ok: false, error: 'The session is not running.' });
  await settle();
  ok(/did not go through/.test(tg.sent()[0]?.text || ''), 'a message the session refused is reported back');

  const long = `${'a'.repeat(3000)}\n\n${'b'.repeat(3000)}`;
  const parts = chunk(long);
  ok(parts.length === 2 && parts[0] === 'a'.repeat(3000) && parts[1] === 'b'.repeat(3000), 'long replies split at a paragraph');
  ok(chunk('x'.repeat(9000)).every((p) => p.length <= 4000), 'no part over the limit');
  r.stop();
}

// ------------------------------------------------------------------ photos
{
  const { tg, seen, r } = rig();
  r.start();
  await sleep(30);
  const MB = 1024 * 1024;
  const sizes = [
    { file_id: 'small', file_size: 20000 },
    { file_id: 'medium', file_size: 200000 },
    { file_id: 'large', file_size: 1.5 * MB },
  ];
  tg.message(null, { extra: { photo: sizes, caption: '  fix the layout in this screenshot ' } });
  await settle();
  const att = seen.attached.at(-1)?.[0];
  ok(seen.submitted.at(-1) === 'fix the layout in this screenshot', 'a photo’s caption is submitted as the message');
  ok(att?.kind === 'image' && att.mediaType === 'image/jpeg' && Buffer.from(att.data, 'base64').toString() === 'pixels of large',
    'the photo goes along as an image, the largest size, base64');
  ok(seen.logs.some((l) => /photo from Telegram submitted/.test(l)) && !seen.logs.some((l) => l.includes('fix the layout')),
    'the log records the photo, never its caption');

  // the largest size over the limit: the next one down is used
  tg.message(null, { extra: { photo: [{ file_id: 'ok-size', file_size: 1 * MB }, { file_id: 'huge', file_size: 5 * MB }] } });
  await settle();
  ok(seen.downloads.at(-1) === 'ok-size' && seen.submitted.at(-1) === '', 'a size over 3.75 MB is skipped for a smaller one; no caption is fine');

  // an image sent as a file: its own type, and a copy kept on the PC to open
  tg.message(null, { extra: { document: { file_id: 'png-doc', mime_type: 'image/png', file_name: 'bug.png', file_size: 300000 } } });
  await settle();
  ok(seen.attached.at(-1)?.[0]?.mediaType === 'image/png' && seen.attached.at(-1)[0].name === 'bug.png', 'an image sent as a file keeps its type and name');
  ok(/JARVIS from phone\\bug\.png$/.test(seen.attached.at(-1)[0].path || ''), 'and is saved on the PC, so the window can open it');

  // any other file: saved on the PC and attached by its path, caption and all
  tg.message(null, { extra: { document: { file_id: 'pdf', mime_type: 'application/pdf', file_name: 'invoice.pdf', file_size: 80000 }, caption: 'check this' } });
  await settle();
  const pdf = seen.attached.at(-1)?.[0];
  ok(pdf?.kind === 'file' && pdf.name === 'invoice.pdf' && /JARVIS from phone\\invoice\.pdf$/.test(pdf.path) && seen.submitted.at(-1) === 'check this',
    'a PDF is saved on the PC and attached as a file');
  ok(seen.saved.some((s) => s.name === 'invoice.pdf' && s.data === 'pixels of pdf'), 'with the bytes Telegram sent');
  tg.message(null, { extra: { video: { file_id: 'clip', mime_type: 'video/mp4', file_size: 900000 } } });
  await settle();
  ok(seen.attached.at(-1)?.[0]?.kind === 'file' && /\.mp4$/.test(seen.attached.at(-1)[0].name), 'a video comes through as a file too');

  const before = seen.submitted.length;
  tg.message(null, { extra: { document: { file_id: 'big-zip', mime_type: 'application/zip', file_size: 25 * MB } } });
  tg.message(null, { extra: { photo: [{ file_id: 'gone1', file_size: 1000 }] } });
  tg.message(null, { extra: { sticker: { file_id: 'stk' } } });
  await settle();
  ok(seen.submitted.length === before, 'a file over 20 MB, a failed download and a sticker submit nothing');
  const said = tg.sent().map((m) => m.text).join('\n');
  ok(/over 20 MB/.test(said) && /could not fetch/.test(said) && /photos, files and voice notes/.test(said), 'and each one says why');
  ok(!seen.downloads.includes('big-zip'), 'a file Telegram says is too big is never downloaded');

  // the safety rules hold for photos too
  const n = seen.submitted.length;
  tg.message(null, { from: STRANGER, chat: STRANGER, extra: { photo: [{ file_id: 'stranger', file_size: 1000 }] } });
  tg.message(null, { date: Math.floor(Date.now() / 1000) - 3600, extra: { photo: [{ file_id: 'late', file_size: 1000 }] } });
  await settle();
  ok(seen.submitted.length === n && !seen.downloads.includes('stranger') && !seen.downloads.includes('late'),
    'a stranger’s photo and a photo sent while away are never downloaded or run');
  r.stop();
}

// ------------------------------------------------------------------ nudges for unanswered decisions
{
  const { tg, seen, r, desk } = rig({ remindMs: 150 });
  r.start();
  await sleep(30);
  r.noteSend('telegram', { ok: true });
  r.event({ kind: 'permission', id: 'p1', toolName: 'Bash', detail: 'npm run build' });
  await sleep(60);
  const permMsg = 100 + tg.sent().length - 1;
  await sleep(250);
  const nudge = tg.sent().find((m) => m.text.startsWith('⏰'));
  ok(nudge && /approve Bash/.test(nudge.text) && nudge.reply_to_message_id === permMsg, 'an approval left 30 s gets one nudge, as a reply to it');
  await sleep(300);
  ok(tg.sent().filter((m) => m.text.startsWith('⏰')).length === 1, 'only one nudge, not a stream of them');

  // answered in time: no nudge
  tg.clear();
  r.event({ kind: 'permission', id: 'p2', toolName: 'Edit', detail: 'x' });
  await sleep(60);
  const key = tg.sent().at(-1).reply_markup.inline_keyboard[0][1].callback_data.split(':')[1];
  tg.tap(`a:${key}`, 100 + (permMsg - 100) + 2);
  await sleep(350);
  ok(seen.responded.some((x) => x.id === 'p2') && !tg.sent().some((m) => m.text.startsWith('⏰')), 'an approval answered in time gets no nudge');

  // a question gets one too
  tg.clear();
  r.event({ kind: 'question', id: 'q9', questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }] }] });
  await sleep(350);
  ok(tg.sent().some((m) => /⏰.*answer a question/.test(m.text)), 'a question left unanswered gets a nudge');
  r.event({ kind: 'prompt_done', id: 'q9' });

  // kept at the desk because you were there, then left: it comes to the phone
  r.event({ kind: 'result', ok: true });
  r.event({ kind: 'status', state: 'ready' });
  desk.at = true;
  r.noteSend('desk', { ok: true });
  await settle(); // the last turn's "Done" goes out first
  tg.clear();
  ok(r.event({ kind: 'permission', id: 'p3', toolName: 'Write', detail: 'y' }) === false, 'at the desk, an approval stays there at first');
  await sleep(60);
  ok(!tg.sent().length, 'nothing goes to the phone straight away');
  await sleep(200);
  const late = tg.sent().find((m) => m.reply_markup);
  ok(late && /Waiting at the PC/.test(late.text), 'left unanswered at the desk, it comes to the phone with its buttons');

  // answered at the desk in time: never sent
  tg.clear();
  r.event({ kind: 'permission', id: 'p4', toolName: 'Write', detail: 'z' });
  r.event({ kind: 'prompt_done', id: 'p4' });
  await sleep(300);
  ok(!tg.sent().some((m) => m.reply_markup), 'answered at the desk in time: it never goes to the phone');
  r.stop();
}

// ------------------------------------------------------------------ mirroring the desk
{
  const { tg, cfg, r } = rig({ atDesk: true });
  r.start();
  await sleep(30);
  // mirror off (the default): a desk turn stays off the chat, as before
  r.noteSend('desk', { ok: true }, { text: 'private desk question' });
  r.event({ kind: 'text_final', text: 'desk answer' });
  ok(r.event({ kind: 'result', ok: true }) === false, 'mirror off: a desk turn is left to the alerts');
  await settle();
  ok(!tg.sent().some((m) => /private desk question|desk answer/.test(m.text)), 'mirror off: nothing typed at the desk reaches the chat');

  cfg.mirror = true;
  tg.clear();
  r.noteSend('desk', { ok: true }, { text: 'check the build', attachments: 2 });
  r.event({ kind: 'text_final', text: 'Checking now.' });
  r.event({ kind: 'text_final', text: 'Build is green.' });
  const claimed = r.event({ kind: 'result', ok: true });
  await settle();
  ok(tg.sent().map((m) => m.text).join('|') === '💻 PC: check the build (+2 attachments)|Checking now.|Build is green.',
    'mirror on: the desk message, tagged, then each reply, in order');
  ok(claimed === true, 'and the turn is claimed, so no "finished" alert repeats it');
  ok(!tg.calls.some((c) => c.method === 'sendChatAction'), 'no "typing…" for a desk turn');
  r.event({ kind: 'result', ok: true });

  // what was attached at the desk reaches the phone as itself
  tg.clear();
  r.noteSend('desk', { ok: true }, { text: 'look', attachments: [
    { kind: 'image', name: 'shot.png', mediaType: 'image/png', data: Buffer.from('png bytes').toString('base64') },
    { kind: 'file', name: 'notes.txt', path: 'C:\\x\\notes.txt' },
    { kind: 'file', name: 'huge.iso', path: 'C:\\x\\huge.iso' },
  ] });
  await settle();
  const sentFiles = tg.files();
  ok(sentFiles[0]?.method === 'sendPhoto' && sentFiles[0].file.data.toString() === 'png bytes', 'a desk image is sent to the phone as a photo');
  ok(sentFiles[1]?.method === 'sendDocument' && sentFiles[1].file.name === 'notes.txt' && sentFiles[1].file.data.toString() === 'contents of C:\\x\\notes.txt', 'a desk file is sent as a document');
  ok(sentFiles.length === 2 && /huge\.iso - attached at the PC, but it could not be sent/.test(tg.sent().map((m) => m.text).join('\n')), 'one too big to send is named instead');
  r.event({ kind: 'result', ok: true });

  // a desk turn that stopped is still left to the alerts
  r.noteSend('desk', { ok: true }, { text: 'long job' });
  ok(r.event({ kind: 'result', ok: false, subtype: 'error_during_execution' }) === false, 'a stopped desk turn is left to the alerts');

  // a refused send is not mirrored
  await settle();
  tg.clear();
  r.noteSend('desk', { ok: false, error: 'x' }, { text: 'never sent' });
  await settle();
  ok(!tg.sent().length, 'a message the session refused is not shown as sent');

  // the mirror needs remote control on
  cfg.on = false;
  r.noteSend('desk', { ok: true }, { text: 'while off' });
  await settle();
  ok(!tg.sent().some((m) => /while off/.test(m.text)), 'remote control off: the mirror is off too');
  r.stop();
}

// ------------------------------------------------------------------ long replies arrive as a file
{
  const { tg, r } = rig();
  r.start();
  await sleep(30);
  r.noteSend('telegram', { ok: true });
  const long = `# Report\n\n${'All the details. '.repeat(600)}`;
  r.event({ kind: 'text_final', text: long });
  await settle();
  const msgs = tg.sent();
  const doc = tg.files().find((c) => c.method === 'sendDocument');
  ok(msgs.length === 1 && msgs[0].text.length < 2000 && /full reply .* is in the file below/.test(msgs[0].text), 'a long reply sends one short preview, not a wall of messages');
  ok(doc && doc.file.data.toString() === long && /\.md$/.test(doc.file.name) && doc.file.field === 'document', 'and the whole reply as a .md file');
  tg.clear();
  r.event({ kind: 'text_final', text: 'short one' });
  await settle();
  ok(tg.sent()[0]?.text === 'short one' && !tg.files().length, 'a short reply is still a plain message');
  r.stop();
}

// ------------------------------------------------------------------ replies are formatted for Telegram
{
  const html = toTelegramHtml('**Done** with `a<b` & snake_case_name\n\n| Time | Result |\n|---|---|\n| 2 Oct, 23:46 | Closed JARVIS, swapped in the new build, restarted it |\n\n- one');
  ok(html.startsWith('<b>Done</b> with <code>a&lt;b</code> &amp; snake_case_name'), 'bold and code become tags; <, & are escaped; snake_case is left alone');
  const grid = /<pre>([\s\S]*?)<\/pre>/.exec(html)?.[1] || '';
  ok(grid.includes('Time') && grid.includes(' | ') && grid.includes('-+-') && /^[\x20-\x7e\n]*$/.test(grid) && grid.split('\n').every((l) => l.length <= 34), 'a table becomes a monospace grid that fits a phone');
  ok(html.endsWith('• one'), 'a list item gets a bullet');
  const wide = toTelegramHtml('| A | B | C | D | E | F | G | H |\n|-|-|-|-|-|-|-|-|\n| alpha | beta | gamma | delta | epsilon | zeta | eta | theta |');
  ok(!wide.includes('<pre>') && wide.startsWith('<b>alpha</b>\nB: beta'), 'a table too wide for a phone becomes cards');
  ok(toTelegramHtml('```js\nif (a < b) {}\n```') === '<pre><code class="language-js">if (a &lt; b) {}</code></pre>', 'a code block keeps its text, escaped');
  const parts = balanceFences(['text\n```\ncode 1', 'code 2\n```\nafter']);
  ok(parts[0].endsWith('code 1\n```') && parts[1].startsWith('```\ncode 2'), 'a code block split between messages is closed and reopened');

  const { tg, seen, r } = rig();
  r.start();
  await sleep(30);
  r.noteSend('telegram', { ok: true });
  r.event({ kind: 'text_final', text: '| A | B |\n|---|---|\n| 1 | 2 |' });
  await settle();
  ok(tg.sent()[0]?.parse_mode === 'HTML' && tg.sent()[0].text.startsWith('<pre>'), 'a reply goes as HTML, its table as a grid');
  tg.clear();
  r.event({ kind: 'text_final', text: '**UNPARSEABLE** reply' });
  await settle();
  ok(tg.sent().length === 2 && tg.sent()[1].text === '**UNPARSEABLE** reply' && !tg.sent()[1].parse_mode
    && seen.logs.some((l) => l.includes('formatted send failed')), 'HTML Telegram rejects goes again as plain text');
  r.stop();
}

// ------------------------------------------------------------------ /screen, /diff, /brief
{
  const { tg, seen, r, desk } = rig();
  r.start();
  await sleep(30);
  tg.message('/screen');
  await settle();
  const shot = tg.files()[0];
  ok(shot?.method === 'sendPhoto' && shot.file.type === 'image/jpeg' && shot.file.field === 'photo', '/screen sends the screen as a photo');
  ok(!seen.submitted.length, 'and never goes to Claude');
  desk.screens = 2;
  tg.clear();
  tg.message('/screen');
  await settle();
  ok(tg.files().length === 2 && tg.files()[1].body.caption === 'Screen 2', 'two screens, two captioned photos');

  tg.clear();
  tg.message('/diff');
  await settle();
  ok(tg.sent()[0]?.text === 'All 9 repositories are clean.' && !tg.files().length, '/diff alone is a summary, no file');
  tg.clear();
  tg.message('/diff panel');
  await settle();
  ok(tg.sent()[0]?.text.startsWith('📝 panel') && tg.files()[0]?.file.name === 'panel.diff', '/diff <repo> sends the summary and the patch as a file');

  tg.clear();
  tg.message('/brief');
  await settle();
  ok(tg.sent()[0]?.text.startsWith('☀️ Good morning'), '/brief sends the brief now');
  tg.message('/brief 7:30');
  await settle();
  ok(seen.brief.on && seen.brief.at === '07:30' && /07:30 on weekdays/.test(tg.sent().at(-1).text), '/brief 7:30 sets the time');
  tg.message('/brief off');
  await settle();
  ok(seen.brief.on === false && /is off/.test(tg.sent().at(-1).text), '/brief off turns it off');
  tg.message('/brief tomorrow');
  await settle();
  ok(seen.brief.on === false && /Use \/brief/.test(tg.sent().at(-1).text), 'anything else explains the options and changes nothing');

  // strangers get none of it
  tg.clear();
  tg.message('/screen', { from: STRANGER, chat: STRANGER });
  tg.message('/diff', { from: STRANGER, chat: STRANGER });
  await settle();
  ok(!tg.calls.length, 'a stranger asking for /screen or /diff gets nothing at all');
  r.stop();
}

// ------------------------------------------------------------------ /sessions and /switch
{
  const { tg, seen, r } = rig();
  r.start();
  await sleep(30);
  r.event({ kind: 'status', state: 'ready' });
  tg.message('/sessions');
  await settle();
  const list = tg.sent().at(-1);
  const listMsg = 100 + tg.sent().length - 1;
  ok(/1\. ▶ Fix the panel login/.test(list.text) && /3\. Panel web invoices/.test(list.text), '/sessions lists them newest first, the current one marked');
  ok(list.reply_markup.inline_keyboard.length === 3 && list.reply_markup.inline_keyboard[1][0].callback_data === 'w:1', 'with a button for each');

  tg.tap('w:1', listMsg + 40);                // forged: right data, wrong message
  tg.tap('w:1', listMsg, { from: STRANGER }); // a stranger
  await settle();
  ok(!seen.switched.length, 'a forged or stranger’s session button switches nothing');
  tg.tap('w:1', listMsg);
  await settle();
  ok(seen.switched[0]?.id === SESSIONS[1].id && /Switched to "Driver app release notes"/.test(tg.sent().at(-1).text) && /Last thing I said/.test(tg.sent().at(-1).text),
    'my tap switches, and says where the session left off');

  tg.message('/switch 3');
  await settle();
  ok(seen.switched.at(-1)?.id === SESSIONS[2].id, '/switch <number> uses the list I was shown');
  tg.message('/switch login');
  await settle();
  ok(seen.switched.at(-1)?.id === SESSIONS[0].id, '/switch <words> finds a session by its title');
  const n = seen.switched.length;
  tg.message('/switch panel');
  await settle();
  ok(seen.switched.length === n && /matches 2 sessions/.test(tg.sent().at(-1).text), 'an ambiguous name lists the matches instead of guessing');
  tg.message('/switch 9');
  tg.message('/switch nothing-like-this');
  await settle();
  ok(seen.switched.length === n, 'no such number or name: nothing happens');

  r.event({ kind: 'status', state: 'working' });
  tg.message('/switch 2');
  await settle();
  ok(seen.switched.length === n && /middle of something/.test(tg.sent().at(-1).text), 'mid-turn, /switch is refused');
  r.stop();
}

// ------------------------------------------------------------------ voice notes
{
  const { tg, seen, r, desk } = rig();
  r.start();
  await sleep(30);
  desk.voiceReady = false;
  tg.message(null, { extra: { voice: { file_id: 'v1', duration: 4, mime_type: 'audio/ogg' } } });
  await settle();
  const said = tg.sent().map((m) => m.text);
  ok(said.some((t) => /first voice note takes a minute/.test(t)), 'the first voice note warns about the one-off model download');
  ok(said.some((t) => t === '🎙 "run the tests please"') && seen.submitted.at(-1) === 'run the tests please', 'a voice note is shown as heard, then run like a typed message');
  ok(seen.logs.some((l) => /voice note transcribed/.test(l)) && !seen.logs.some((l) => l.includes('run the tests')), 'the log records the voice note, never its words');

  // a transcript answers an open question, like typing would
  desk.voiceReady = true;
  desk.transcript = 'use the staging branch';
  r.noteSend('telegram', { ok: true });
  r.event({ kind: 'question', id: 'vq', questions: [{ question: 'Which branch?', options: [{ label: 'main' }] }] });
  await settle();
  tg.message(null, { extra: { voice: { file_id: 'v2', duration: 3 } } });
  await settle();
  ok(seen.responded.at(-1)?.decision.answers['Which branch?'] === 'use the staging branch', 'a spoken answer answers the open question');

  // silence, too long, a stranger
  desk.transcript = ' you ';
  const before = seen.submitted.length;
  tg.message(null, { extra: { voice: { file_id: 'v3', duration: 2 } } });
  tg.message(null, { extra: { voice: { file_id: 'v4', duration: 900 } } });
  await settle();
  ok(seen.submitted.length === before && tg.sent().some((m) => /could not make out/.test(m.text)) && tg.sent().some((m) => /over 5 minutes/.test(m.text)),
    'silence and an over-long note run nothing, and say why');
  ok(!seen.downloads.includes('v4'), 'an over-long note is never downloaded');
  const t = seen.transcribed;
  tg.message(null, { from: STRANGER, chat: STRANGER, extra: { voice: { file_id: 'sv', duration: 2 } } });
  await settle();
  ok(seen.transcribed === t && !seen.downloads.includes('sv'), 'a stranger’s voice note is never downloaded or transcribed');
  r.stop();
}

// ------------------------------------------------------------------ switched off
{
  const { tg, seen, r } = rig({ on: false });
  r.start();
  await sleep(30);
  tg.message('anyone there?');
  await settle();
  ok(seen.submitted.length === 0 && !tg.sent().length, 'switched off: nothing is read, nothing is sent');
  ok(r.event({ kind: 'permission', id: 'z', toolName: 'Bash' }) === false, 'switched off: approvals stay at the desk');
  ok(!seen.logs.some((l) => l.includes('listening for Telegram')), 'switched off: the log never claims to be listening');
  r.stop();
}

// ------------------------------------------------------------------ greeting
{
  const at = (h) => greeting(new Date(2026, 9, 3, h, 30));
  ok(at(8).startsWith('Good morning'), 'greeting: 08:30 is morning');
  ok(at(12).startsWith('Good afternoon') && at(16).startsWith('Good afternoon'), 'greeting: 12:30 and 16:30 are afternoon');
  ok(at(17).startsWith('Good evening') && at(23).startsWith('Good evening') && at(2).startsWith('Good evening'), 'greeting: 17:30, 23:30 and 02:30 are evening');
}

console.log(`remote-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
