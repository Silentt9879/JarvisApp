// Remote control: talk to JARVIS from Telegram.
//
// You message your bot; the message is submitted exactly as if it had been typed into the
// window's composer, and JARVIS runs it on this machine. Approvals and questions come back
// to the chat as buttons, and the reply comes back when the turn ends. Alerts (phone.mjs)
// only ever spoke; this listens.
//
// That makes it a way to drive Claude Code on this PC from anywhere, so the rules are
// strict, and each one is here because the alternative is someone else at the keyboard:
//
//   - Off unless switched on in Settings, and only with the Telegram route fully set up.
//   - Only YOUR chat is obeyed: a private chat whose id is the configured chat id, from the
//     user with that same id. Telegram sets `from` on its own servers; a stranger who finds
//     the bot gets silence (and a line in jarvis.log), never a reply that confirms anything.
//   - Nothing runs late. A message sent while JARVIS was closed is never executed when it
//     comes back - you are told it was skipped, and send it again if you still want it.
//   - A button counts only on the message JARVIS sent it on. Buttons are keyed by a short
//     local number, and the callback must come from the message id recorded for that
//     prompt - a look-alike message with forged buttons cannot approve anything.
//   - The gates are the window's gates. Approvals still need approving and there is no
//     bypass mode; "Allow for this session" is offered only where the window offers it,
//     and means this session, never a settings file. Answers go through the same respond()
//     as the window's buttons, which takes the first answer and ignores any later one, so
//     the desk and the phone can never both decide the same prompt.
//   - /delete is refused here: it deletes conversations and asks its questions at the desk.
//
// The window stays the single place a message is submitted: main.mjs hands it the text
// (kind 'remote_prompt') and chat.js runs the same submit() the composer uses, so the
// bubble, the timeline, the rewind button and restarting a closed session all behave
// exactly as they do for typed messages.
//
// The token goes only to telegram.mjs, which keeps it out of every log and error.
import { call as telegramCall, upload as telegramUpload, downloadFile, isToken, isChatId } from './telegram.mjs';
import { toTelegramHtml, balanceFences } from './tgformat.mjs';

const POLL_SECONDS = 25;          // Telegram holds a getUpdates open this long when idle
const MAX_TEXT = 4000;            // Telegram's limit is 4096; leave room
const RICH_PART = 3000;           // Markdown per message; escaping and table padding make the HTML longer
const LONG_AS_FILE = 6000;        // a reply longer than this arrives as a preview and a file
const PREVIEW = 1500;             // how much of a long reply is shown before the file
const MAX_DOWNLOAD = 20 * 1024 * 1024; // the most the Bot API lets a bot download
const MAX_VOICE_BYTES = MAX_DOWNLOAD;
const MAX_VOICE_SECONDS = 300;
const SESSIONS_SHOWN = 8;
const TYPING_EVERY_MS = 4500;     // "typing…" lasts about 5 s on the phone
const REMIND_AFTER_MS = 30000;    // a decision left this long gets a nudge on the phone
// What the model takes as an image - the same rules as session.mjs (IMAGE_TYPES,
// MAX_IMAGE_BYTES), repeated here so this file does not pull in the SDK.
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_IMAGE_BYTES = 3.75 * 1024 * 1024;
const HELP = [
  'Send me anything and I will run it on your PC, exactly as if you had typed it there.',
  'Photos and files work too (up to 20 MB) - put what you want done with them in the caption. They are saved on the PC in Downloads\\JARVIS from phone and shown in the chat there. Voice notes are transcribed on the PC and run like a typed message.',
  '',
  'Approvals and questions come here as buttons. Type a message instead of tapping an approval and I will read it first, then ask again.',
  '',
  'Commands:',
  '/status - what I am doing',
  '/stop - stop the current turn',
  '/new - start a new session',
  '/sessions - recent sessions, tap one to switch',
  '/switch <number or name> - carry on an earlier session',
  '/screen - a screenshot of the PC',
  '/diff - what has changed in the repos; /diff <repo> for the patch',
  '/brief - the morning brief now; /brief off, /brief on, /brief 07:30',
  '/help - this list',
  'Power down - put JARVIS on the PC to sleep; Wake up brings it back',
  '',
  'Other slash commands (/compact, /context, /cost …) go to Claude Code as they are.',
].join('\n');

/** Split text for Telegram, preferring paragraph, then line, then word boundaries. */
export function chunk(text, max = MAX_TEXT) {
  const out = [];
  let s = String(text || '');
  while (s.length > max) {
    let cut = s.lastIndexOf('\n\n', max);
    if (cut < max * 0.5) cut = s.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = s.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    out.push(s.slice(0, cut).trimEnd());
    s = s.slice(cut).trimStart();
  }
  if (s) out.push(s);
  return out;
}

/**
 * The phone's hello when JARVIS opens or wakes on the PC: morning before noon, afternoon until
 * 17:00, evening after. `pc` names the PC once there is more than one.
 */
export function greeting(date = new Date(), pc = null) {
  const h = date.getHours();
  const part = h >= 5 && h < 12 ? 'morning' : h >= 12 && h < 17 ? 'afternoon' : 'evening';
  return `Good ${part}. JARVIS is online on ${pc || 'your PC'} and standing by - send me anything and I will run it there.`;
}
/** Said when JARVIS goes to sleep: the window is closed, only the Telegram listener is left. */
export const sleepNotice = (pc = null) => `💤 JARVIS on ${pc || 'the PC'} has powered down. Say "Wake up" to bring it back.`;
/** Said when JARVIS is quit outright (the tray's Quit): nothing is listening any more. */
export const offlineNotice = (pc = null) => `🔌 JARVIS on ${pc || 'the PC'} has shut down and is offline. Switch it on again at the PC to resume talking.`;

const sameName = (a, b) => {
  const n = (s) => String(s || '').toLowerCase().replace(/[\s_.-]+/g, '');
  return !!n(a) && n(a) === n(b);
};

/**
 * "Wake up" and "Power down", alone or with a PC's name before or after ("Wake up PC2",
 * "PC2, power down", "JARVIS, wake up"). Only a whole message of that shape counts.
 * Returns { cmd: 'wake' | 'power', target: name | null }, or null.
 */
export function controlWord(text) {
  const m = /^(?:([\w .-]{1,24}?)[\s,:]+)?(?:jarvis[\s,.!]+)?(wake\s*up|power\s*down)(?:[\s,]+([\w .-]{1,24}?))?[\s.!]*$/i.exec(String(text || '').trim());
  if (!m) return null;
  const target = [m[1], m[3]].map((s) => (s || '').trim()).find((s) => s && !/^jarvis$/i.test(s)) || null;
  return { cmd: /^wake/i.test(m[2]) ? 'wake' : 'power', target };
}
/** "Power down" meant for this PC: no name, or this PC's name. */
export function isPowerDown(text, me = null) {
  const c = controlWord(text);
  return !!c && c.cmd === 'power' && (!c.target || sameName(c.target, me));
}

const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/**
 * @param o.cfg           () => { on, token, chatId, name, pcName, groupId } - read fresh on every use;
 *                        groupId is the group shared with your other PCs, if any
 * @param o.log           (...parts) => void
 * @param o.atDesk        () => boolean - the window has focus
 * @param o.submit        (text, attachments?) => boolean - hand a message to the window to send; false if no window
 * @param o.newSession    () => void - start a fresh session (only called while idle)
 * @param o.interrupt     () => void
 * @param o.respond       (id, decision, verdict) => void - answer a prompt; verdict is for the window
 * @param o.workspace     () => string - the folder, for /status
 * @param o.api           (token, method, body, opts) => Promise - the Bot API; injectable for tests
 * @param o.download      (token, fileId, maxBytes) => Promise<{ ok, data }> - injectable for tests
 * @param o.upload        (token, method, fields, file) => Promise - a file upload; injectable for tests
 * @param o.screens       () => Promise<[{ name, data: Buffer }]> - a JPEG of each screen
 * @param o.diff          (query) => Promise<{ text, file? }> - see reports.mjs
 * @param o.brief         () => Promise<string> - the morning brief
 * @param o.briefSet      ({ on?, at? }) => { on, at } - change and report the brief's schedule
 * @param o.sessions      () => Promise<[{ id, title, lastModified }]> - newest first
 * @param o.currentSession () => string | null
 * @param o.switchSession (id, title) => Promise<{ ok, last? }> - resume it in the window
 * @param o.saveIncoming  (name, Buffer) => Promise<string> - keep a photo or file from the phone on the PC; its path
 * @param o.readAttachment (path) => Promise<Buffer|null> - a file attached at the desk, for the mirror; null if too big
 * @param o.transcribe    (oggBuffer) => Promise<{ ok, text, error }> - voice notes
 * @param o.voiceReady    () => boolean - the speech model is loaded (no first-time download)
 * @param o.powerDown     (from) => void - "Power down" was sent: put JARVIS on the PC to sleep
 * @param o.wakeUp        (from) => void - "Wake up" was sent: open JARVIS again
 * @param o.asleep        () => boolean - powered down: the window is closed, only this listener is left
 * @param o.peers         () => Promise<[{ name, state }]> - the other PCs in the group (presence.mjs)
 * @param o.groupMoved    (newId) => void - Telegram turned the group into a supergroup, with a new id
 * @param o.now           () => ms - injectable clock
 * @param o.remindMs      ms before an unanswered decision is nudged - injectable for tests
 */
export function createRemote(o) {
  const api = o.api || telegramCall;
  const upload = o.upload || telegramUpload;
  const download = o.download || downloadFile;
  const remindMs = o.remindMs ?? REMIND_AFTER_MS;
  const now = o.now || (() => Date.now());
  const log = o.log || (() => {});

  // ---------------------------------------------------------------- state
  let running = false;      // the poll loop
  let paused = false;       // getUpdates is busy elsewhere (Find my chat)
  let live = false;         // listening right now - switched on, set up, and not paused
  let abort = null;         // ends a long poll early
  let offset = 0;           // next update id wanted
  let startedAt = 0;        // seconds: anything sent before this was sent while we were away
  let warnedStale = false;
  const strangers = new Set();

  let status = 'offline';
  let model = null;
  let mode = 'default';
  const origins = [];       // one per message in flight, oldest first: 'telegram' | 'desk'
  let lastText = '';        // the most recent final text of the current turn, not yet sent
  let sentInTurn = false;   // something from this turn has already reached the phone
  let outbox = Promise.resolve(); // replies go out one after another, in the order written
  let stopAsked = 0;        // when /stop was sent, to word the ending
  let typingTimer = null;

  let nextKey = 1;
  const prompts = new Map(); // key -> { id, kind, messageId, ... }
  const byId = new Map();    // prompt id -> key
  const heldAtDesk = new Map(); // prompt id -> timer: kept at the desk, sent on if left unanswered

  const ready = () => {
    const c = o.cfg();
    return !!(c && c.on && isToken(c.token) && isChatId(c.chatId));
  };

  // ---------------------------------------------------------------- outbound
  /** A plain message - to your chat, or to the group with `extra.chat_id`. */
  async function say(text, extra = {}) {
    const c = o.cfg();
    if (!ready()) return null;
    const { chat_id: to, ...rest } = extra;
    const chat = String(to ?? c.chatId);
    extra = rest;
    let last = null;
    for (const part of chunk(text)) {
      const r = await api(c.token, 'sendMessage', { chat_id: chat, text: part, disable_web_page_preview: true, ...extra });
      if (!r.ok) { log('remote: send failed:', r.error || ''); return null; }
      last = r.result;
      extra = {}; // buttons ride on the first part only
    }
    return last;
  }
  /**
   * Model text, formatted: tables, bold, code and lists as Telegram shows them (tgformat.mjs).
   * A part Telegram will not parse goes again as plain text - formatting is never worth a
   * lost reply.
   */
  async function sayRich(md) {
    const c = o.cfg();
    if (!ready()) return null;
    let last = null;
    for (const part of balanceFences(chunk(md, RICH_PART))) {
      const html = toTelegramHtml(part);
      const r = html && html.length <= MAX_TEXT
        ? await api(c.token, 'sendMessage', { chat_id: String(c.chatId), text: html, parse_mode: 'HTML', disable_web_page_preview: true })
        : { ok: false, error: 'too long once formatted' };
      if (r.ok) { last = r.result; continue; }
      log('remote: formatted send failed, sending plain:', r.error || '');
      last = await say(part);
      if (!last) return null;
    }
    return last;
  }
  async function edit(messageId, text, keyboard = null, chat = null) {
    const c = o.cfg();
    if (!ready() || !messageId) return;
    const r = await api(c.token, 'editMessageText', {
      chat_id: String(chat ?? c.chatId), message_id: messageId, text: clip(text, MAX_TEXT), disable_web_page_preview: true,
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    });
    // "message is not modified" is Telegram saying it already looks like that - not a fault.
    if (!r.ok && !/not modified/i.test(r.error || '')) log('remote: edit failed:', r.error || '');
  }
  async function sendFile(method, field, file, extra = {}) {
    const c = o.cfg();
    if (!ready()) return null;
    const r = await upload(c.token, method, { chat_id: String(c.chatId), ...extra }, { field, ...file });
    if (!r.ok) { log(`remote: ${method} failed:`, r.error || ''); return null; }
    return r.result;
  }
  /**
   * A reply. Past LONG_AS_FILE it would be a wall of messages on a phone, so it arrives as
   * its opening and the whole thing as a file - which also keeps code and tables intact.
   * If the file will not go, the reply goes as messages after all: never lost.
   */
  async function reply(text) {
    const s = String(text || '');
    if (s.length <= LONG_AS_FILE) return sayRich(s);
    const head = chunk(s, PREVIEW)[0];
    const sent = await sayRich(`${balanceFences([head])[0]}\n\n… the full reply (${Math.round(s.length / 1000)}k characters) is in the file below.`);
    if (!sent) return null;
    const stamp = new Date(now()).toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const f = await sendFile('sendDocument', 'document', { name: `jarvis-reply-${stamp}.md`, data: Buffer.from(s, 'utf8'), type: 'text/markdown' });
    if (f) return f;
    return sayRich(s.slice(head.length).trimStart());
  }
  /** Queue a reply behind the ones before it, so an update can never overtake the ending. */
  function sayInOrder(text) { return inOrder(() => reply(text)); }
  function inOrder(job) {
    outbox = outbox.then(job).catch((e) => log('remote: send failed:', e?.message || e));
    return outbox;
  }
  /**
   * What was attached at the desk, as the things themselves: a picture as a photo (or a file,
   * if Telegram will not take it as one), anything else as a document. A file that cannot be
   * read or is over Telegram's 50 MB is named instead, so the phone still knows it was there.
   */
  async function sendAttachments(list) {
    for (const a of list) {
      const name = String(a?.name || 'attachment');
      if (a?.kind === 'image' && typeof a.data === 'string') {
        const file = { name, data: Buffer.from(a.data, 'base64'), type: a.mediaType || 'image/jpeg' };
        if (await sendFile('sendPhoto', 'photo', file, { caption: `💻 ${clip(name, 200)}` }) || await sendFile('sendDocument', 'document', file)) continue;
      } else if (a?.kind === 'file' && typeof a.path === 'string' && o.readAttachment) {
        const data = await o.readAttachment(a.path).catch(() => null);
        if (data && await sendFile('sendDocument', 'document', { name, data, type: 'application/octet-stream' })) continue;
      }
      await say(`📎 ${name} - attached at the PC, but it could not be sent here (over 50 MB, or unreadable).`);
    }
  }
  const action = (what) => { const c = o.cfg(); if (ready()) api(c.token, 'sendChatAction', { chat_id: String(c.chatId), action: what }); };
  function typing(on) {
    clearInterval(typingTimer);
    typingTimer = null;
    if (!on || !ready()) return;
    const tick = () => { const c = o.cfg(); if (ready()) api(c.token, 'sendChatAction', { chat_id: String(c.chatId), action: 'typing' }); };
    tick();
    typingTimer = setInterval(tick, TYPING_EVERY_MS);
  }

  // ---------------------------------------------------------------- whose turn is it
  const currentIsRemote = () => origins[0] === 'telegram';
  /** Mirror on: the desk's side of the conversation is shown in the chat as well. */
  const mirroring = () => ready() && !!o.cfg().mirror;
  /** This turn's words go to the chat: it came from the phone, or it came from the desk and is mirrored. */
  const turnGoesOut = () => currentIsRemote() || (origins[0] === 'desk' && mirroring());
  /** Prompts reach the phone when the turn came from it, or when you are away from the desk. */
  const promptsGoOut = () => ready() && (currentIsRemote() || !o.atDesk());

  // ---------------------------------------------------------------- nudges
  // A decision stops all work, and a Telegram message that arrived while the phone was in a
  // pocket is easy to miss. So once, after remindMs, an unanswered one gets a second message -
  // a reply to the original, so it buzzes again and one tap jumps to the buttons.
  function scheduleReminder(p) {
    clearTimeout(p.remind);
    p.remind = setTimeout(() => {
      if (p.settled || !p.messageId || !ready()) return;
      const what = p.kind === 'permission' ? `approve ${p.tool}` : 'answer a question';
      log('remote: reminder sent -', p.kind === 'permission' ? p.tool : 'a question');
      say(`⏰ JARVIS is still waiting for you to ${what} - everything is paused until you reply.`, { reply_to_message_id: p.messageId });
    }, remindMs);
    p.remind.unref?.();
  }
  /**
   * A decision kept at the desk (you were there when it came up) that nobody answers is
   * sent on to the phone after remindMs - the window can have focus with nobody in front of it.
   */
  function holdAtDesk(e, post) {
    if (!ready() || heldAtDesk.has(e.id)) return;
    const t = setTimeout(() => {
      heldAtDesk.delete(e.id);
      if (!ready()) return;
      log('remote: unanswered at the desk, sent to the phone');
      post({ ...e, waitedAtDesk: true }).catch((err) => log('remote: post failed:', err?.message || err));
    }, remindMs);
    t.unref?.();
    heldAtDesk.set(e.id, t);
  }

  // ---------------------------------------------------------------- prompts -> buttons
  async function postPermission(e) {
    const key = nextKey++;
    const who = e.displayName || String(e.toolName || 'a tool').replace(/^mcp__[^_]+__/, '');
    const p = { key, id: e.id, kind: 'permission', tool: who, messageId: null, settled: false };
    prompts.set(key, p);
    byId.set(e.id, key);
    log('remote: approval sent to the phone -', who);
    const lines = [`🔐 ${e.title || `JARVIS wants to use ${who}`}${e.fromAgent ? ' (for a specialist)' : ''}`];
    if (e.waitedAtDesk) lines.push('(Waiting at the PC with no answer, so it came here.)');
    const desc = e.description || e.reason;
    if (desc) lines.push(clip(desc, 400));
    if (e.detail) lines.push('', clip(e.detail, 1500));
    if (e.blockedPath) lines.push('', `Path: ${e.blockedPath}`);
    lines.push('', '💬 Or just type a reply instead - I will ask again after.');
    const keyboard = [[{ text: '✗ Deny', callback_data: `d:${key}` }, { text: '✓ Allow once', callback_data: `a:${key}` }]];
    // On its own row, away from "Allow once" - a thumb that misses should not widen a grant.
    if (e.canAlways) keyboard.push([{ text: 'Allow for this session', callback_data: `s:${key}` }]);
    p.text = lines.join('\n');
    const m = await say(p.text, { reply_markup: { inline_keyboard: keyboard } });
    p.messageId = m?.message_id || null;
    // Answered at the desk while the message was on its way.
    if (p.settled && p.messageId) await edit(p.messageId, `${p.text}\n\n— no longer waiting on you`);
    else if (p.messageId) scheduleReminder(p);
  }

  function questionText(p) {
    const q = p.questions[p.idx];
    const lines = [];
    lines.push(`❓ ${p.questions.length > 1 ? `Question ${p.idx + 1} of ${p.questions.length}` : 'JARVIS has a question'}${q.header ? ` - ${q.header}` : ''}`);
    lines.push('', q.question || '');
    for (const opt of q.options || []) lines.push(`• ${opt.label}${opt.description ? ` - ${clip(opt.description, 160)}` : ''}`);
    lines.push('', q.multiSelect ? 'Tap every option that applies, then Done - or reply with your own answer.' : 'Tap an option, or reply with your own answer.');
    return lines.join('\n');
  }
  function questionKeyboard(p) {
    const q = p.questions[p.idx];
    const rows = (q.options || []).map((opt, i) => [{
      text: clip(`${q.multiSelect ? (p.chosen.has(i) ? '☑ ' : '☐ ') : ''}${opt.label}`, 60),
      callback_data: `o:${p.key}:${p.idx}:${i}`,
    }]);
    const last = [{ text: 'Skip', callback_data: `k:${p.key}` }];
    if (q.multiSelect) last.unshift({ text: 'Done', callback_data: `n:${p.key}:${p.idx}` });
    rows.push(last);
    return rows;
  }
  async function postQuestion(e) {
    const questions = (e.questions || []).filter((q) => q && q.question);
    if (!questions.length) return false;
    const key = nextKey++;
    const p = { key, id: e.id, kind: 'question', questions, idx: 0, answers: {}, chosen: new Set(), messageId: null, settled: false };
    prompts.set(key, p);
    byId.set(e.id, key);
    log('remote: question sent to the phone');
    const m = await say(`${e.waitedAtDesk ? '(Waiting at the PC with no answer, so it came here.)\n' : ''}${questionText(p)}`, { reply_markup: { inline_keyboard: questionKeyboard(p) } });
    p.messageId = m?.message_id || null;
    if (p.settled && p.messageId) await edit(p.messageId, `${questionText(p)}\n\n— no longer waiting on you`);
    else if (p.messageId) scheduleReminder(p);
    return true;
  }
  /** The question currently waiting on a typed answer, if any - the newest one wins. */
  function openQuestion() {
    let found = null;
    for (const p of prompts.values()) if (p.kind === 'question' && !p.settled && p.messageId) found = p;
    return found;
  }
  /** The approval a typed message replies to instead of deciding, if any - the newest one wins. */
  function openPermission() {
    let found = null;
    for (const p of prompts.values()) if (p.kind === 'permission' && !p.settled && p.messageId) found = p;
    return found;
  }

  function settle(p, verdict, decision) {
    if (p.settled) return false;
    p.settled = true;
    clearTimeout(p.remind);
    // The audit trail: what was decided from the phone, and when. The tool, never the
    // command text - a command can carry a password or a token, and the log is a file.
    log(`remote: ${verdict} -`, p.kind === 'permission' ? p.tool : 'a question');
    o.respond(p.id, decision, verdict);
    return true;
  }
  async function answerQuestion(p, value) {
    const q = p.questions[p.idx];
    p.answers[q.question] = value;
    if (p.idx + 1 < p.questions.length) {
      p.idx += 1;
      p.chosen = new Set();
      await edit(p.messageId, questionText(p), questionKeyboard(p));
      return;
    }
    const summary = p.questions.map((x) => `${x.question}\n→ ${p.answers[x.question]}`).join('\n\n');
    if (settle(p, 'Answered from your phone', { type: 'answer', answers: p.answers })) {
      await edit(p.messageId, `❓ Answered\n\n${summary}`);
    }
  }

  // ---------------------------------------------------------------- inbound: buttons
  async function onCallback(cq) {
    const c = o.cfg();
    const ack = (text) => api(c.token, 'answerCallbackQuery', { callback_query_id: cq.id, ...(text ? { text } : {}) });
    if (String(cq.from?.id) !== String(c.chatId)) { stranger(cq.from); await ack(); return; }
    const [verb, rawKey, a1, a2] = String(cq.data || '').split(':');
    // "Which PC?" in the group: only on the very message this PC posted for it.
    if (verb === 'g') {
      const g = groupAsks.get(Number(rawKey));
      if (!g || cq.message?.message_id !== g.messageId || String(cq.message?.chat?.id) !== String(g.chat)) { await ack('That choice is no longer open.'); return; }
      groupAsks.delete(Number(rawKey));
      clearTimeout(g.expire);
      await ack(g.cmd === 'wake' ? `Waking ${me()}` : `Powering down ${me()}`);
      await edit(g.messageId, g.cmd === 'wake' ? `☀️ ${me()} chosen.` : `🔌 ${me()} chosen.`, null, g.chat);
      await act(g.cmd, g.chat);
      return;
    }
    // A session from /sessions: only on that very list, like any other button.
    if (verb === 'w') {
      const s = shownSessions.list[Number(rawKey)];
      if (!s || !shownSessions.messageId || cq.message?.message_id !== shownSessions.messageId) { await ack('That list is out of date - send /sessions again.'); return; }
      if (busyNow()) { await ack('Busy - /stop first, then switch.'); return; }
      await ack(clip(s.title, 60));
      await resume(s);
      return;
    }
    const p = prompts.get(Number(rawKey));
    // The button must be on the very message JARVIS sent for this prompt.
    if (!p || !p.messageId || cq.message?.message_id !== p.messageId) { await ack('That request is no longer open.'); return; }
    if (p.settled) { await ack('Already answered.'); return; }

    if (p.kind === 'permission') {
      const choice = { a: ['allow', '✓ Allowed once'], d: ['deny', '✗ Denied'], s: ['allow_always', '✓ Allowed for this session'] }[verb];
      if (!choice) { await ack(); return; }
      await ack(choice[1]);
      if (settle(p, `${choice[1]} from your phone`, { type: choice[0] })) await edit(p.messageId, `${p.text}\n\n${choice[1]}`);
      return;
    }

    // a question
    if (verb === 'k') {
      await ack('Skipped');
      if (settle(p, 'Skipped from your phone', { type: 'deny', message: 'The user skipped the question.' })) await edit(p.messageId, '❓ Skipped');
      return;
    }
    if (Number(a1) !== p.idx) { await ack('That question has moved on.'); return; }
    const q = p.questions[p.idx];
    if (verb === 'o') {
      const i = Number(a2);
      const opt = (q.options || [])[i];
      if (!opt) { await ack(); return; }
      if (q.multiSelect) {
        if (p.chosen.has(i)) p.chosen.delete(i); else p.chosen.add(i);
        await ack();
        await edit(p.messageId, questionText(p), questionKeyboard(p));
        return;
      }
      await ack(opt.label);
      await answerQuestion(p, opt.label);
      return;
    }
    if (verb === 'n') {
      if (!p.chosen.size) { await ack('Pick at least one, or reply with your own answer.'); return; }
      await ack();
      await answerQuestion(p, [...p.chosen].sort((x, y) => x - y).map((i) => q.options[i].label).join(', '));
    }
  }

  // ---------------------------------------------------------------- inbound: messages
  function stranger(from) {
    const id = String(from?.id ?? 'unknown');
    if (strangers.has(id)) return;
    strangers.add(id);
    log('remote: ignored a message from a chat that is not yours, id', id);
  }

  async function onMessage(m) {
    const c = o.cfg();
    // The group shared with your other PCs: still only your own messages, and only the
    // control words (onGroupText). Its id changes if Telegram makes it a supergroup.
    const inGroup = !!c.groupId && String(m.chat?.id) === String(c.groupId) && /group/.test(m.chat?.type || '');
    if (inGroup && m.migrate_to_chat_id) { log('remote: the group became a supergroup - following it'); o.groupMoved?.(String(m.migrate_to_chat_id)); return; }
    if (inGroup && String(m.from?.id) === String(c.chatId)) {
      // Sent while this PC was not listening: dropped without a word - every PC would say it.
      if (Number(m.date) >= startedAt && typeof m.text === 'string') await onGroupText(m.text.trim(), m);
      return;
    }
    if (m.chat?.type !== 'private' || String(m.chat?.id) !== String(c.chatId) || String(m.from?.id) !== String(c.chatId)) {
      stranger(m.from);
      return;
    }
    const text = typeof m.text === 'string' ? m.text.trim() : '';
    // Sent while JARVIS was not listening: never run it now. One note covers the backlog.
    if (Number(m.date) < startedAt) {
      if (!warnedStale) {
        warnedStale = true;
        await say('I was not listening when you sent that, so I did not run it - nothing sent while JARVIS is closed or remote control is off is ever run later. Send it again if you still want it.');
      }
      return;
    }
    const voice = m.voice || (m.audio && /ogg|opus/i.test(m.audio.mime_type || '') ? m.audio : null);
    if (voice?.file_id) { await onVoice(voice); return; }
    const incoming = pickIncoming(m);
    if (incoming) { await onIncoming(incoming, typeof m.caption === 'string' ? m.caption.trim() : ''); return; }
    if (!text) { await say('I can take text, photos, files and voice notes - not that kind of message.'); return; }
    await onText(text);
  }

  /** Typed text, or a voice note's transcript: an answer, a reply instead, a command or a message. */
  async function onText(text) {
    // Before anything else, even an open question: "Wake up" and "Power down" are never
    // taken as an answer. This chat is this PC's alone, so there is nobody to choose between.
    const cw = controlWord(text);
    if (cw && (!cw.target || sameName(cw.target, me()))) { await control(cw.cmd, null); return; }
    if (cw && (await o.peers?.().catch(() => []) || []).some((p) => sameName(p.name, cw.target))) {
      await say(`That is for ${cw.target} - this chat is ${me()}. Say it in your JARVIS group, or in ${cw.target}'s own chat.`);
      return;
    }
    if (o.asleep?.() && !/^\/(status|help|start)\b/i.test(text)) { await say(`💤 JARVIS on ${me()} is asleep. Say "Wake up" first.`); return; }
    // A typed reply to a question answers it ("Other").
    const q = openQuestion();
    if (q && !text.startsWith('/')) { await answerQuestion(q, text); return; }
    // A typed message while an approval waits is a reply instead of a decision: the
    // action does not run, JARVIS reads the message and asks for it again afterwards.
    const perm = openPermission();
    if (perm && !text.startsWith('/')) {
      if (settle(perm, '💬 Replied instead from your phone', { type: 'reply', text })) {
        await edit(perm.messageId, `${perm.text}\n\n💬 You replied instead - I will ask again after.`);
      }
      return;
    }

    const cmd = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text);
    if (cmd) {
      const name = cmd[1].toLowerCase();
      if (name === 'start' || name === 'help') { await say(HELP); return; }
      if (name === 'status') { await say(statusLine()); return; }
      if (name === 'stop') {
        if (status === 'working' || status === 'waiting') { stopAsked = now(); o.interrupt(); await say('Stopping…'); }
        else await say('Nothing is running.');
        return;
      }
      if (name === 'new') {
        if (status === 'working' || status === 'waiting') { await say('I am in the middle of something. /stop first, then /new.'); return; }
        o.newSession();
        await say('New session started.');
        return;
      }
      if (name === 'delete') { await say('/delete deletes conversations, so it only works at the desk.'); return; }
      const arg = (cmd[2] || '').trim();
      if (name === 'screen') { await sendScreens(); return; }
      if (name === 'diff') { await sendDiff(arg); return; }
      if (name === 'brief') { await onBrief(arg); return; }
      if (name === 'sessions') { await showSessions(); return; }
      if (name === 'switch') { await switchTo(arg); return; }
      // anything else is a Claude Code command and goes through as typed
    }
    if (!o.submit(text)) { await say('The JARVIS window is not open, so I could not take that.'); return; }
    log('remote: message from Telegram submitted,', text.length, 'chars');
  }

  /**
   * The photo or file in a message, if there is one. A photo arrives as several sizes,
   * smallest first: the largest the model will take is used. Anything else - a document,
   * a video, music - is taken whole, up to the 20 MB the Bot API hands a bot.
   */
  function pickIncoming(m) {
    const d = new Date(now());
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    if (Array.isArray(m.photo) && m.photo.length) {
      const sizes = m.photo.filter((s) => s?.file_id);
      const fits = sizes.filter((s) => !(Number(s.file_size) > MAX_IMAGE_BYTES));
      const best = fits[fits.length - 1] || sizes[sizes.length - 1];
      return best ? { fileId: best.file_id, mediaType: 'image/jpeg', name: `photo-${stamp}.jpg`, size: Number(best.file_size) || 0 } : null;
    }
    const f = m.document || m.video || m.animation || m.audio || m.video_note;
    if (!f?.file_id) return null;
    const ext = { 'video/mp4': '.mp4', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a' }[f.mime_type] || (m.video_note ? '.mp4' : '');
    return { fileId: f.file_id, mediaType: f.mime_type || '', name: clip(f.file_name || `file-${stamp}${ext}`, 120), size: Number(f.file_size) || 0 };
  }

  /**
   * A photo or file from the phone: kept on the PC (so it can be opened there), shown in the
   * window's chat, and handed to JARVIS with the caption. An image the model can read goes
   * in as an image; anything else is named by its path, like a file attached at the desk.
   */
  async function onIncoming(f, caption) {
    if (o.asleep?.()) { await say(`💤 JARVIS on ${me()} is asleep. Say "Wake up", then send that again.`); return; }
    if (f.size > MAX_DOWNLOAD) { await say('That is over 20 MB, the most Telegram lets me fetch. Send it a smaller way.'); return; }
    action('upload_document');
    const c = o.cfg();
    const r = await download(c.token, f.fileId, MAX_DOWNLOAD);
    if (!r.ok) {
      await say(r.tooBig ? 'That is over 20 MB, the most Telegram lets me fetch.' : `I could not fetch that from Telegram: ${r.error || 'no answer'}`);
      return;
    }
    let saved = null;
    try { saved = o.saveIncoming ? await o.saveIncoming(f.name, r.data) : null; } catch (e) { log('remote: could not save a file from the phone:', e?.message || e); }
    const isImage = IMAGE_TYPES.includes(f.mediaType) && r.data.length <= MAX_IMAGE_BYTES;
    let att;
    if (isImage) att = { kind: 'image', name: f.name, mediaType: f.mediaType, data: r.data.toString('base64'), ...(saved ? { path: saved } : {}) };
    else if (saved) att = { kind: 'file', name: f.name, path: saved, size: r.data.length };
    else { await say('I could not save that on the PC, so I could not take it.'); return; }
    if (!o.submit(caption, [att])) { await say('The JARVIS window is not open, so I could not take that.'); return; }
    // Size only - never the caption, which is a prompt like any other.
    log(`remote: ${isImage ? 'photo' : 'file'} from Telegram submitted,`, Math.round(r.data.length / 1024), 'KB');
  }

  /**
   * A voice note: transcribed on the PC (voice.mjs), shown back so you can see what was
   * heard, then handled exactly as if it had been typed - an answer to an open question, a
   * reply instead of an approval, a command, or a message to run.
   */
  async function onVoice(v) {
    if (!o.transcribe) { await say('Voice notes are not available in this JARVIS.'); return; }
    if (Number(v.duration) > MAX_VOICE_SECONDS) { await say(`That voice note is over ${MAX_VOICE_SECONDS / 60} minutes. Keep it shorter, or type it.`); return; }
    if (!o.voiceReady?.()) await say('🎙 Setting up speech recognition - the first voice note takes a minute while the model downloads to the PC. After that it takes seconds.');
    action('typing');
    const c = o.cfg();
    const r = await download(c.token, v.file_id, MAX_VOICE_BYTES);
    if (!r.ok) { await say(r.tooBig ? 'That voice note is too large for Telegram to hand over.' : `I could not fetch that voice note from Telegram: ${r.error || 'no answer'}`); return; }
    const t = await o.transcribe(r.data);
    if (!t.ok) { await say(`I could not transcribe that: ${t.error || 'unknown error'}`); return; }
    // Whisper writes a lone "you" or "Thank you." for silence; that, or no word at all, is nothing.
    const heard = String(t.text || '').trim();
    if (!/[\p{L}\p{N}]{2,}/u.test(heard) || /^(you|thank you|thanks for watching)[.!]*$/i.test(heard)) { await say('I could not make out any words in that voice note.'); return; }
    log('remote: voice note transcribed,', Number(v.duration) || '?', 's');
    await say(`🎙 "${clip(t.text, 3500)}"`);
    await onText(t.text);
  }

  // ---------------------------------------------------------------- power: sleep, wake, the group
  // Your own chat with this PC's bot is this PC's alone: "Wake up" and "Power down" there act
  // at once. The group holds every PC's bot, and each of them hears every message - so there
  // each PC asks the board (presence.mjs) who else could answer. Nobody: it acts. Somebody:
  // every PC that could answer posts one button for itself, and you tap the one you mean.
  const me = () => o.cfg().pcName || 'this PC';
  let nextAsk = 1;
  const groupAsks = new Map(); // key -> { cmd, chat, messageId, expire }
  const ASK_OPEN_MS = 2 * 60 * 1000;

  /** Wake or sleep this PC, and say so where it was asked: your chat (null) or the group. */
  async function act(cmd, chat) {
    const to = chat ? { chat_id: chat } : {};
    if (cmd === 'wake') {
      log('remote: wake up from the', chat ? 'group' : 'phone');
      await o.wakeUp?.(chat ? 'group' : 'phone');
      await say(`☀️ ${greeting(new Date(now()), o.cfg().pcName || null)}`, to);
    } else {
      log('remote: power down from the', chat ? 'group' : 'phone');
      await say(sleepNotice(o.cfg().pcName || null), to);
      await o.powerDown?.(chat ? 'group' : 'phone');
    }
  }

  /** "Wake up" / "Power down" in your own chat: there is only this PC to mean. */
  async function control(cmd, chat) {
    const asleep = !!o.asleep?.();
    if (cmd === 'wake' && !asleep) { await say(`JARVIS on ${me()} is already awake.`); return; }
    if (cmd === 'power' && asleep) { await say(`JARVIS on ${me()} is already asleep. Say "Wake up" to bring it back.`); return; }
    await act(cmd, chat);
  }

  /** This PC speaks for all of them (a hint, "all awake"): the first name on the board that is still there. */
  function leader(peers) {
    const names = [me(), ...peers.map((p) => p.name)];
    names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    return sameName(names[0], me());
  }

  async function onGroupText(text, m) {
    const chat = String(m.chat.id);
    const to = { chat_id: chat };
    const asleep = !!o.asleep?.();
    if (/^\/status\b/i.test(text)) { await say(`${asleep ? '💤' : '🟢'} ${me()} - ${asleep ? 'asleep' : statusWord()}`, to); return; }
    const cw = controlWord(text);
    const peers = await o.peers?.().catch(() => []) || [];
    if (!cw) {
      // Anything else is not taken here - every PC would run it. One of them says so.
      if (leader(peers)) await say('In this group I take only "Wake up", "Power down" and /status - add a name to pick a PC ("Wake up PC2"). For tasks, message a PC\'s own bot.', { ...to, reply_to_message_id: m.message_id });
      return;
    }
    if (cw.target && !sameName(cw.target, me())) return;            // for another PC
    const want = cw.cmd === 'wake' ? 'asleep' : 'awake';             // who can answer
    if ((asleep ? 'asleep' : 'awake') !== want) {
      if (cw.target) await say(`${me()} is already ${asleep ? 'asleep' : 'awake'}.`, to);
      else if (!peers.some((p) => p.state === want) && leader(peers)) await say(cw.cmd === 'wake' ? 'Every PC is already awake.' : 'Every PC is already asleep.', to);
      return;
    }
    // Named, or the only PC that could answer: act now.
    if (cw.target || !peers.some((p) => p.state === want)) { await act(cw.cmd, chat); return; }
    // More than one could: this PC offers itself, as each of the others does.
    const key = nextAsk++;
    const label = cw.cmd === 'wake' ? `☀️ Wake ${me()}` : `💤 Power down ${me()}`;
    const sent = await say(`${asleep ? '💤' : '🟢'} ${me()} is ${asleep ? 'asleep' : 'awake'}. Which PC do you mean?`, {
      ...to, reply_to_message_id: m.message_id, reply_markup: { inline_keyboard: [[{ text: label, callback_data: `g:${key}` }]] },
    });
    if (!sent) return;
    const g = { cmd: cw.cmd, chat, messageId: sent.message_id, expire: null };
    g.expire = setTimeout(() => { if (groupAsks.delete(key)) edit(g.messageId, `${me()} - not chosen.`, null, chat); }, ASK_OPEN_MS);
    g.expire.unref?.();
    groupAsks.set(key, g);
  }

  // ---------------------------------------------------------------- inbound: reports
  async function sendScreens() {
    if (!o.screens) { await say('Screenshots are not available in this JARVIS.'); return; }
    action('upload_photo');
    let shots = [];
    try { shots = await o.screens(); } catch (e) { log('remote: screenshot failed:', e?.message || e); }
    if (!shots.length) { await say('I could not capture the screen.'); return; }
    let sent = 0;
    for (const [i, s] of shots.entries()) {
      const file = { name: `screen-${i + 1}.jpg`, data: s.data, type: 'image/jpeg' };
      const caption = shots.length > 1 ? { caption: s.name || `Screen ${i + 1}` } : {};
      // A photo Telegram will not take (too many pixels) still goes, as a file.
      if (await sendFile('sendPhoto', 'photo', file, caption) || await sendFile('sendDocument', 'document', file, caption)) sent++;
    }
    log('remote: screenshot sent to the phone,', sent, 'of', shots.length, 'screen(s)');
    if (!sent) await say('I took the screenshot but Telegram would not accept it.');
  }

  async function sendDiff(query) {
    if (!o.diff) { await say('/diff is not available in this JARVIS.'); return; }
    action('typing');
    let r;
    try { r = await o.diff(query); } catch (e) { await say(`I could not read the repositories: ${e?.message || e}`); return; }
    await reply(r.text);
    if (r.file && !await sendFile('sendDocument', 'document', r.file)) await say('The patch would not upload - it may be too large. Open Source Control at the desk.');
  }

  async function onBrief(arg) {
    const a = arg.toLowerCase();
    const time = /^([01]?\d|2[0-3])[:.h]?([0-5]\d)$/.exec(a);
    if (o.briefSet && (a === 'on' || a === 'off' || time)) {
      const s = o.briefSet(time ? { on: true, at: `${time[1].padStart(2, '0')}:${time[2]}` } : { on: a === 'on' });
      await say(s.on ? `☀️ The morning brief will come at ${s.at} on weekdays.` : 'The morning brief is off. /brief on to bring it back.');
      return;
    }
    if (a) { await say('Use /brief for the brief now, /brief on or /brief off, or /brief 07:30 to set the time.'); return; }
    if (!o.brief) { await say('The brief is not available in this JARVIS.'); return; }
    action('typing');
    try { await reply(await o.brief()); } catch (e) { await say(`I could not put the brief together: ${e?.message || e}`); }
  }

  // ---------------------------------------------------------------- inbound: sessions
  // The last list shown, so "/switch 3" and its buttons mean what you saw - not whatever
  // the list says by the time you answer.
  let shownSessions = { messageId: null, list: [] };
  const busyNow = () => status === 'working' || status === 'waiting';

  async function showSessions() {
    if (!o.sessions) { await say('Sessions are not available in this JARVIS.'); return; }
    const list = (await o.sessions().catch(() => [])).slice(0, SESSIONS_SHOWN);
    if (!list.length) { await say('No sessions yet.'); return; }
    const cur = o.currentSession?.() || null;
    const lines = ['💬 Recent sessions:', ''];
    list.forEach((s, i) => lines.push(`${i + 1}. ${s.id === cur ? '▶ ' : ''}${clip(s.title, 70)} - ${ago(s.lastModified)}`));
    lines.push('', 'Tap one to carry it on here, or send /switch <number>.');
    const keyboard = list.map((s, i) => [{ text: clip(`${i + 1}. ${s.id === cur ? '▶ ' : ''}${s.title}`, 60), callback_data: `w:${i}` }]);
    const m = await say(lines.join('\n'), { reply_markup: { inline_keyboard: keyboard } });
    shownSessions = { messageId: m?.message_id || null, list };
  }

  async function switchTo(arg) {
    if (!arg) { await showSessions(); return; }
    if (busyNow()) { await say('I am in the middle of something. /stop first, then switch.'); return; }
    let pick = null;
    if (/^\d+$/.test(arg)) {
      const list = shownSessions.list.length ? shownSessions.list : (await o.sessions?.().catch(() => [])) || [];
      pick = list[Number(arg) - 1] || null;
      if (!pick) { await say(`There is no session ${arg}. /sessions shows the list.`); return; }
    } else {
      const q = arg.toLowerCase();
      const hits = ((await o.sessions?.().catch(() => [])) || []).filter((s) => s.title.toLowerCase().includes(q) || s.id.startsWith(q));
      if (!hits.length) { await say(`No session matches "${arg}". /sessions shows the list.`); return; }
      if (hits.length > 1) {
        shownSessions = { messageId: null, list: hits.slice(0, SESSIONS_SHOWN) };
        await say([`"${arg}" matches ${hits.length} sessions:`, ...shownSessions.list.map((s, i) => `${i + 1}. ${clip(s.title, 70)}`), '', 'Send /switch <number>.'].join('\n'));
        return;
      }
      pick = hits[0];
    }
    await resume(pick);
  }

  async function resume(s) {
    if (s.id === o.currentSession?.()) { await say(`Already in "${clip(s.title, 80)}".`); return; }
    const r = await o.switchSession(s.id, s.title);
    if (!r?.ok) { await say(r?.error || 'The JARVIS window is not open, so I could not switch.'); return; }
    log('remote: switched session from the phone');
    await say(`Switched to "${clip(s.title, 80)}". Send a message to carry on.${r.last ? `\n\nWhere it left off:\n${clip(r.last, 800)}` : ''}`);
  }

  function ago(ms) {
    const m = Math.round((now() - ms) / 60000);
    if (!(m >= 0)) return '';
    if (m < 60) return `${Math.max(1, m)} min ago`;
    const h = Math.round(m / 60);
    return h < 36 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
  }

  function statusWord() {
    if (o.asleep?.()) return 'Asleep - say "Wake up" to bring it back';
    return { starting: 'Starting up', ready: 'Standing by', working: 'Working', waiting: 'Waiting for you', closed: 'Offline', offline: 'Offline' }[status] || status;
  }
  function statusLine() {
    const word = statusWord();
    const modeWord = { default: 'Ask', acceptEdits: 'Accept edits', plan: 'Plan', auto: 'Auto' }[mode] || mode;
    const folder = String(o.workspace?.() || '').split(/[\\/]/).filter(Boolean).pop() || '-';
    const open = [...prompts.values()].filter((p) => !p.settled).length;
    return [
      `${word}${open ? ` - ${open} decision${open > 1 ? 's' : ''} waiting` : ''}`,
      `Model: ${model || 'default'} · Mode: ${modeWord}`,
      `Workspace: ${folder}${o.cfg().groupId ? ` · PC: ${me()}` : ''}`,
    ].join('\n');
  }

  // ---------------------------------------------------------------- the poll loop
  async function poll() {
    let backoff = 1000;
    let warned409 = false;
    while (running) {
      if (paused || !ready()) {
        // Logged only on the change, and only when it is true: the log is the record of
        // when this PC could be driven from the phone.
        if (live && !paused) log('remote: stopped listening');
        live = false;
        await sleep(1500);
        continue;
      }
      if (!live) {
        // Switched on (or back on, or resumed after Find my chat): the clock starts now.
        // Messages sent while it was off are still waiting in Telegram's queue, and they
        // were sent to a JARVIS that was not listening - they must not run now.
        live = true;
        startedAt = Math.floor(now() / 1000);
        warnedStale = false;
        log('remote: listening for Telegram messages');
      }
      const c = o.cfg();
      abort = new AbortController();
      const r = await api(c.token, 'getUpdates', {
        offset, timeout: POLL_SECONDS, allowed_updates: ['message', 'callback_query'],
      }, { timeoutMs: (POLL_SECONDS + 10) * 1000, signal: abort.signal });
      abort = null;
      if (!running) break;
      if (!r.ok) {
        if (r.aborted) continue;
        if (r.status === 409) {
          // Another getUpdates is running against this bot - a second JARVIS, or a bot
          // tool somewhere. Telegram allows one; say so once, and keep trying quietly.
          if (!warned409) { warned409 = true; log('remote: another program is reading this bot’s messages (409) - retrying'); }
        } else if (r.status === 401) {
          log('remote: Telegram rejected the bot token - remote control paused until it is fixed');
          await sleep(30000);
          continue;
        } else if (!r.timeout) log('remote: poll failed:', r.error || '');
        await sleep(Math.min(backoff, 60000));
        backoff = Math.min(backoff * 2, 60000);
        continue;
      }
      backoff = 1000;
      warned409 = false;
      for (const u of Array.isArray(r.result) ? r.result : []) {
        offset = Math.max(offset, Number(u.update_id) + 1);
        try {
          if (u.callback_query) await onCallback(u.callback_query);
          else if (u.message) await onMessage(u.message);
        } catch (e) { log('remote: update failed:', e?.message || e); }
      }
    }
  }
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  // ---------------------------------------------------------------- public
  return {
    /** Start listening. Safe to call again; anything sent before now is never run. */
    start() {
      if (running) return;
      running = true;
      poll().catch((e) => log('remote: loop ended:', e?.message || e)).finally(() => { running = false; });
    },
    stop() {
      if (!running) return;
      running = false;
      abort?.abort();
      typing(false);
      if (live) log('remote: stopped listening');
      live = false;
    },
    /** Hold the poll while something else needs getUpdates (Find my chat). */
    pause(on) { paused = !!on; if (on) abort?.abort(); },
    get listening() { return live; },

    /** The jarvis:send handler reports every message, so each turn knows where it came from. */
    noteSend(origin, result, msg = {}) {
      if (!result?.ok) {
        if (origin === 'telegram') say(`That did not go through: ${result?.error || 'the session refused it'}.`);
        return;
      }
      origins.push(origin === 'telegram' ? 'telegram' : 'desk');
      if (origin === 'telegram') typing(true);
      // Typed at the desk, with the mirror on: the chat shows it, tagged, before the reply.
      else if (mirroring()) {
        const list = Array.isArray(msg.attachments) ? msg.attachments : [];
        const n = list.length || Number(msg.attachments) || 0;
        const text = String(msg.text || '').trim();
        if (text || n) sayInOrder(`💻 PC: ${text}${n ? `${text ? ' ' : ''}(+${n} attachment${n > 1 ? 's' : ''})` : ''}`);
        if (list.length) inOrder(() => sendAttachments(list));
      }
    },
    /** A new or resumed session: nothing is in flight any more. */
    sessionStarted() { origins.length = 0; lastText = ''; sentInTurn = false; typing(false); },

    /**
     * Every session event passes through here. Returns true when this event has been fully
     * handled for Telegram, so the alert watcher stays quiet about it - one message per
     * thing, never an alert and a button for the same decision.
     */
    event(e) {
      if (!e || typeof e !== 'object') return false;
      switch (e.kind) {
        case 'status':
          status = e.state;
          // Idle means every queued message is answered - including any Claude Code merged.
          if (e.state === 'ready' || e.state === 'closed') { origins.length = 0; typing(false); }
          // "typing…" while JARVIS waits on you would say the opposite of what is happening.
          else if (e.state === 'waiting') typing(false);
          else if (e.state === 'working' && currentIsRemote()) typing(true);
          return false;
        case 'init':
          if (e.model) model = e.model;
          if (e.permissionMode) mode = e.permissionMode;
          return false;
        case 'mode': mode = e.mode || mode; return false;
        case 'model': if (e.model) model = e.model; return false;
        case 'text_final':
          // A turn from the phone hears every update as it is written, not only the last
          // one when the turn ends - a long job used to sit silent on the phone for minutes,
          // with everything said along the way left on the desk.
          if (e.text && turnGoesOut() && ready()) { sayInOrder(e.text); sentInTurn = true; lastText = ''; return false; }
          lastText = e.text || lastText;
          return false;
        case 'permission':
          if (!promptsGoOut()) { holdAtDesk(e, postPermission); return false; }
          postPermission(e).catch((err) => log('remote: permission post failed:', err?.message || err));
          return true;
        case 'question':
          if (!promptsGoOut()) { holdAtDesk(e, postQuestion); return false; }
          postQuestion(e).catch((err) => log('remote: question post failed:', err?.message || err));
          return true;
        case 'prompt_done': {
          clearTimeout(heldAtDesk.get(e.id));
          heldAtDesk.delete(e.id);
          const key = byId.get(e.id);
          byId.delete(e.id);
          const p = key && prompts.get(key);
          if (p) {
            prompts.delete(key);
            if (!p.settled) {
              // Settled at the desk (or cancelled): take the buttons off the phone.
              p.settled = true;
              clearTimeout(p.remind);
              const base = p.kind === 'permission' ? p.text : '❓ JARVIS had a question';
              if (p.messageId) edit(p.messageId, `${base}\n\n— answered at the desk`);
            }
          }
          return false;
        }
        case 'result': {
          const origin = origins.shift();
          const text = lastText;
          const already = sentInTurn;
          lastText = '';
          sentInTurn = false;
          if (!origins.length) typing(false); else if (origins[0] === 'telegram') typing(true);
          if (origin === 'desk' && mirroring()) {
            // The chat already shows this desk turn, so the "finished" alert would repeat it.
            // A turn that stopped is left to the alerts, which word a stop at the desk properly.
            if (!e.ok) return false;
            if (text) sayInOrder(text);
            return already || !!text;
          }
          if (origin !== 'telegram' || !ready()) return false;
          const secs = e.durationMs ? `${(e.durationMs / 1000).toFixed(1)}s` : '';
          let body;
          // The reply itself has usually gone out already, as it was written; a clean ending
          // then needs no extra message. A stop or an error is still said.
          if (e.ok) body = text || (already ? '' : `Done${secs ? ` in ${secs}` : ''}.`);
          else if (stopAsked && now() - stopAsked < 60000) body = `${text ? `${text}\n\n` : ''}Stopped, as you asked.`;
          else body = `${text ? `${text}\n\n` : ''}The turn stopped (${e.subtype || 'unknown'}).${e.errors?.length ? `\n${clip(e.errors.join('\n'), 600)}` : ''}`;
          stopAsked = 0;
          if (body) sayInOrder(body);
          return true;
        }
        default:
          return false;
      }
    },

    /** Send a message to the phone: remote control switched on, an update, the morning brief, a deploy. */
    announce(text) { return ready() ? sayInOrder(text) : Promise.resolve(null); },
    get ready() { return ready(); },

    // for tests
    _state: () => ({ origins: [...origins], prompts: prompts.size, offset, startedAt }),
  };
}
