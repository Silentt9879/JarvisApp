// Presence: which of your PCs running JARVIS are awake, asleep or gone, for "Wake up" and
// "Power down" in a Telegram group that holds more than one of them.
//
// Each PC has its own bot, and all of them sit in one group with you. Telegram never shows a
// bot what another bot says, so PC1 cannot hear PC2 say "I am asleep". What every member CAN
// read is the group's description - so that is the board. Each PC keeps one line of it:
//
//   🟢 PC1 · awake · 2026-10-03 12:43Z
//   💤 PC2 · asleep · 2026-10-03 12:40Z
//
// A line is rewritten on every change and refreshed every few minutes. One that has not been
// refreshed for FRESH_MS belongs to a PC that is off (shut down, crashed, no network) and is
// treated as not there. Anything else in the description is the user's and is left alone.
//
// Writing needs the bot to be a group admin with "Change group info". Two PCs can write at
// the same moment and one line can be lost, so every write is read back and repeated if it
// did not stick - and the heartbeat puts a lost line back within minutes regardless.
const FRESH_MS = 12 * 60 * 1000;
const HEARTBEAT_MS = 5 * 60 * 1000;
const MAX_DESCRIPTION = 255;
const LINE = /^(?:🟢|💤)\s+(.+?)\s+·\s+(awake|asleep)\s+·\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2})Z$/u;

const norm = (s) => String(s || '').toLowerCase().replace(/[\s_.-]+/g, '');
/** PC names match ignoring case, spaces, dots, dashes and underscores: "pc 2" is "PC2". */
export const sameName = (a, b) => !!norm(a) && norm(a) === norm(b);

const stamp = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')}Z`;
const unstamp = (s) => Date.parse(`${s.replace(' ', 'T')}:00Z`);

/** The board's PC lines, and every other line kept as written. */
export function parseBoard(text) {
  const pcs = [];
  const other = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = LINE.exec(line.trim());
    if (m) pcs.push({ name: m[1], state: m[2], at: unstamp(m[3]) });
    else if (line.trim()) other.push(line);
  }
  return { pcs, other };
}

/** The description with this PC's line set to `state` (or removed, for null). */
export function renderBoard(text, me, state, at) {
  const { pcs, other } = parseBoard(text);
  const list = pcs.filter((p) => !sameName(p.name, me));
  if (state) list.push({ name: me, state, at });
  list.sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
  const lines = list.map((p) => `${p.state === 'awake' ? '🟢' : '💤'} ${p.name} · ${p.state} · ${stamp(p.at)}`);
  return [...other, ...lines].join('\n').slice(0, MAX_DESCRIPTION);
}

/**
 * @param o.cfg  () => { token, groupId, name } - name is this PC's; off unless all three are set
 * @param o.api  (token, method, body) => Promise<{ ok, result, error }>
 * @param o.log  (...parts) => void
 * @param o.now  () => ms - injectable clock
 * @param o.settleMs  how long to wait before reading a write back - injectable for tests
 */
export function createPresence(o) {
  const now = o.now || (() => Date.now());
  const log = o.log || (() => {});
  const settleMs = o.settleMs ?? 1500;
  let state = null;
  let queue = Promise.resolve();
  let warned = false;
  let timer = null;

  const usable = (c) => !!(c && c.token && c.groupId && c.name);
  const active = () => usable(o.cfg());

  async function read(c) {
    const r = await o.api(c.token, 'getChat', { chat_id: String(c.groupId) });
    return r.ok ? String(r.result?.description || '') : null;
  }

  // `c` is the settings when the change was asked for: a rename clears the OLD name's line.
  async function write(c, state) {
    if (!usable(c)) return false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const before = await read(c);
      if (before === null) { log('presence: could not read the group'); return false; }
      const next = renderBoard(before, c.name, state, now());
      if (next !== before) {
        const r = await o.api(c.token, 'setChatDescription', { chat_id: String(c.groupId), description: next });
        if (!r.ok && !/not modified/i.test(r.error || '')) {
          if (!warned) { warned = true; log('presence: cannot update the group board -', r.error || '', '- make the bot a group admin with "Change group info"'); }
          return false;
        }
      }
      warned = false;
      // Read it back: another PC writing at the same moment can overwrite this line.
      await new Promise((res) => setTimeout(res, settleMs + Math.random() * settleMs));
      const mine = parseBoard(await read(c) ?? '').pcs.find((p) => sameName(p.name, c.name));
      if (state ? mine?.state === state : !mine) return true;
    }
    log('presence: the board kept losing this PC\'s line');
    return false;
  }

  const run = () => {
    const c = o.cfg();
    const s = state;
    queue = queue.then(() => write(c, s)).catch((e) => { log('presence:', e?.message || e); return false; });
    return queue;
  };

  function beat() {
    clearInterval(timer);
    timer = null;
    if (!state) return;
    timer = setInterval(() => { if (state && active()) run(); }, HEARTBEAT_MS);
    timer.unref?.();
  }

  return {
    /** This PC is 'awake' or 'asleep'. Resolves once the board says so (or it could not). */
    set(next) { state = next; beat(); return run(); },
    /** This PC is going away: take its line off. */
    clear() { state = null; beat(); return run(); },
    /** The other PCs on the board that are still there, with their state. Empty without a group. */
    async peers() {
      const c = o.cfg();
      if (!usable(c)) return [];
      const text = await read(c);
      if (text === null) return [];
      return parseBoard(text).pcs.filter((p) => !sameName(p.name, c.name) && now() - p.at < FRESH_MS);
    },
    get active() { return active(); },
    stop() { clearInterval(timer); timer = null; },
  };
}
