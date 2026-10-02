// Phone alerts over the internet, through a Telegram bot.
//
// The adb route in phone.mjs needs the cable or the same Wi-Fi. This one needs neither:
// the alert goes to Telegram's API over HTTPS and Telegram delivers it to the phone on
// whatever network it happens to be on - mobile data, a hotel's Wi-Fi, anywhere. What it
// costs is that the text leaves this machine, so sendAlert in main.mjs keeps the bodies it
// sends this way short on detail.
//
// Setup is two values, both kept in %APPDATA%\JARVIS\config.json, which is outside the
// repository and is never committed:
//
//   token   from @BotFather in Telegram, of the form 123456789:AA...
//   chatId  your own chat with that bot. discoverChat() reads it out of getUpdates after
//           you send the bot one message, so it never has to be looked up by hand.
//
// The token is a credential. It is never logged, never sent back to the window, and
// redact() scrubs it out of error text before that text goes anywhere at all.
import { setTimeout as delay } from 'node:timers/promises';

const API = 'https://api.telegram.org';
const TOKEN = /^\d{5,16}:[A-Za-z0-9_-]{30,60}$/;
const TIMEOUT = 15000;

export const isToken = (t) => typeof t === 'string' && TOKEN.test(t.trim());
export const isChatId = (c) => /^-?\d{1,20}$/.test(String(c ?? '').trim());

/**
 * Remove the token from any text. Telegram puts it in the URL, so it turns up in fetch's
 * own error messages ("request to https://api.telegram.org/bot123:ABC/... failed"), and
 * those messages are shown in the window and written to the log.
 */
function redact(text, token) {
  let s = String(text ?? '');
  if (token) {
    s = s.split(token).join('<token>');
    const id = String(token).split(':')[0];
    if (id && id.length >= 5) s = s.split(`bot${id}:`).join('bot<token>');
  }
  return s.replace(/bot\d{5,16}:[A-Za-z0-9_-]{10,}/g, 'bot<token>').slice(0, 300);
}

/**
 * One Bot API call. Resolves { ok, result } or { ok: false, error, status } - it never
 * throws and never rejects, because every caller is on a path that must not take the app
 * down. `timeoutMs` exists for getUpdates' long poll, which holds the request open on
 * purpose; everything else uses the 15 seconds. `signal` lets a caller abandon a long poll.
 */
export async function call(token, method, body, { timeoutMs = TIMEOUT, signal } = {}) {
  if (!isToken(token)) return { ok: false, error: 'That bot token does not look right. Copy the whole line @BotFather gave you.' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const onAbort = () => ac.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    // A FormData body is a file upload (multipart/form-data, which sets its own boundary
    // header); anything else goes as JSON.
    const multipart = typeof FormData !== 'undefined' && body instanceof FormData;
    const res = await fetch(`${API}/bot${token.trim()}/${method}`, {
      method: 'POST',
      ...(multipart ? {} : { headers: { 'content-type': 'application/json' } }),
      body: multipart ? body : JSON.stringify(body || {}),
      signal: ac.signal,
    });
    const data = await res.json().catch(() => null);
    if (data && data.ok) return { ok: true, result: data.result };
    // Telegram explains itself properly, so its own words are the most useful thing to show.
    const why = data?.description || `HTTP ${res.status}`;
    const status = res.status;
    if (status === 401) return { ok: false, status, error: 'Telegram rejected that token. Check it with @BotFather.' };
    if (status === 400 && /chat not found/i.test(why)) {
      return { ok: false, status, error: 'Telegram cannot find that chat. Send your bot a message first, then press "Find my chat".' };
    }
    if (status === 403) return { ok: false, status, error: 'Your bot is blocked. Open the chat in Telegram and unblock it.' };
    // 429 carries how long to wait; the caller decides whether to.
    return { ok: false, status, retryAfter: data?.parameters?.retry_after, error: redact(why, token) };
  } catch (e) {
    if (signal?.aborted) return { ok: false, aborted: true, error: 'Stopped.' };
    if (ac.signal.aborted) return { ok: false, timeout: true, error: `Telegram did not answer within ${Math.round(timeoutMs / 1000)} seconds.` };
    const msg = redact(e?.message || e, token);
    if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|fetch failed|network/i.test(msg)) {
      return { ok: false, offline: true, error: 'No route to Telegram - this machine looks offline.' };
    }
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Download a file someone sent the bot (a photo, for remote control). Two steps, as the Bot
 * API has it: getFile turns the file id into a path, then the path is fetched from the file
 * endpoint - whose URL also carries the token, so its errors are redacted like any other.
 * Refused before the download when Telegram already says it is over `maxBytes`, and checked
 * again after, since file_size is optional. Resolves { ok, data: Buffer } - never throws.
 */
export async function downloadFile(token, fileId, maxBytes, { timeoutMs = 30000 } = {}) {
  const meta = await call(token, 'getFile', { file_id: String(fileId || '') });
  if (!meta.ok) return meta;
  const filePath = meta.result?.file_path;
  if (!filePath) return { ok: false, error: 'Telegram did not say where that file is.' };
  if (Number(meta.result?.file_size) > maxBytes) return { ok: false, tooBig: true, error: 'That file is too large.' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}/file/bot${token.trim()}/${filePath}`, { signal: ac.signal });
    if (!res.ok) return { ok: false, status: res.status, error: `Telegram would not hand the file over (HTTP ${res.status}).` };
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > maxBytes) return { ok: false, tooBig: true, error: 'That file is too large.' };
    return { ok: true, data };
  } catch (e) {
    if (ac.signal.aborted) return { ok: false, timeout: true, error: `The download did not finish within ${Math.round(timeoutMs / 1000)} seconds.` };
    return { ok: false, error: redact(e?.message || e, token) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send a file: a screenshot (sendPhoto, field 'photo') or a document (sendDocument, field
 * 'document'). `fields` are the method's other parameters; an object among them
 * (reply_markup) goes as JSON, as multipart wants. Resolves like call() - never throws.
 */
export function upload(token, method, fields, { field, name, data, type = 'application/octet-stream' }) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields || {})) {
    if (v != null) fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  fd.append(field, new Blob([data], { type }), name);
  // Up to 50 MB can go, which takes a while on a slow line.
  return call(token, method, fd, { timeoutMs: 180000 });
}

/** Who the token belongs to. Used to confirm setup, and to name the bot in the window. */
export async function verifyToken(token) {
  const r = await call(token, 'getMe');
  if (!r.ok) return r;
  return { ok: true, name: r.result?.username ? `@${r.result.username}` : (r.result?.first_name || 'your bot') };
}

/**
 * Find the chat to send to, from the messages the bot has already received.
 *
 * getUpdates is the only way to learn a chat id without the user digging for it, and it
 * only knows about chats that have written to the bot - which is exactly why the window
 * tells you to message the bot first. Telegram keeps those updates for about 24 hours.
 *
 * The newest chat wins, and a private chat is preferred over a group: a personal alert
 * belongs in the personal chat even if the bot was also added to a group somewhere.
 */
export async function discoverChat(token) {
  const r = await call(token, 'getUpdates', { limit: 100, timeout: 0, allowed_updates: ['message'] });
  if (!r.ok) return r;
  const chats = [];
  for (const u of Array.isArray(r.result) ? r.result : []) {
    const c = u?.message?.chat || u?.edited_message?.chat;
    if (c && isChatId(c.id)) chats.push({ id: String(c.id), type: c.type, name: c.username ? `@${c.username}` : [c.first_name, c.last_name].filter(Boolean).join(' ') || c.title || String(c.id) });
  }
  if (!chats.length) {
    return { ok: false, error: 'Your bot has had no messages. Open it in Telegram, send it anything (even "hi"), then press this again.' };
  }
  const priv = chats.filter((c) => c.type === 'private');
  const pick = (priv.length ? priv : chats)[(priv.length ? priv : chats).length - 1];
  return { ok: true, chatId: pick.id, name: pick.name };
}

/**
 * Send one alert. Plain text, no parse_mode: the body can contain a file path, a tool name
 * or whatever the model last said, and none of that is written to be safe inside Telegram's
 * Markdown - an unbalanced asterisk would make the whole message fail to send.
 *
 * A 429 is the one error worth waiting out, because Telegram says exactly how long.
 */
export async function sendTelegram({ token, chatId }, { title, body }) {
  if (!isChatId(chatId)) return { ok: false, error: 'No Telegram chat set yet.' };
  const text = [title, body].filter(Boolean).join('\n').slice(0, 3500) || 'JARVIS';
  const payload = { chat_id: String(chatId).trim(), text, disable_web_page_preview: true };
  let r = await call(token, 'sendMessage', payload);
  if (!r.ok && /too many requests|retry after (\d+)/i.test(r.error || '')) {
    const secs = Math.min(30, Number((/retry after (\d+)/i.exec(r.error) || [])[1] || 3));
    await delay(secs * 1000);
    r = await call(token, 'sendMessage', payload);
  }
  return r.ok ? { ok: true } : r;
}
