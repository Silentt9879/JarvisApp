// Routines: a prompt JARVIS runs by itself at a set time on set days. The result goes to the
// phone (Telegram) and/or a Windows notification. A routine runs read-only unless it is set to
// "may edit files", and it can never approve its own commands: anything that would need an
// approval simply does not happen, and the result says so.
import crypto from 'node:crypto';
import { readJson, writeJson, localDay } from './store.mjs';

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_ROUTINES = 30;
const MAX_SUMMARY = 1200;

/** "daily" | "weekdays" | an array of day numbers (0 = Sunday) -> a sorted array of numbers. */
export function daysOf(spec) {
  if (spec === 'daily') return [0, 1, 2, 3, 4, 5, 6];
  if (spec === 'weekdays') return [1, 2, 3, 4, 5];
  if (!Array.isArray(spec)) return null;
  const set = [...new Set(spec.map(Number))].filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  return set.length ? set.sort((a, b) => a - b) : null;
}

export function validateRoutine(input = {}) {
  const name = String(input.name ?? '').trim();
  const prompt = String(input.prompt ?? '').trim();
  const time = String(input.time ?? '').trim();
  if (!name) return { ok: false, error: 'Give the routine a name.' };
  if (name.length > 60) return { ok: false, error: 'Keep the name under 60 characters.' };
  if (!prompt) return { ok: false, error: 'Write what JARVIS should do.' };
  if (prompt.length > 4000) return { ok: false, error: 'Keep the instructions under 4000 characters.' };
  if (!TIME.test(time)) return { ok: false, error: 'Pick a time, such as 09:00.' };
  const days = daysOf(input.days);
  if (!days) return { ok: false, error: 'Pick at least one day.' };
  const d = input.deliver || {};
  return {
    ok: true,
    value: {
      name,
      prompt,
      time,
      days,
      cwd: String(input.cwd ?? '').trim(),
      mode: input.mode === 'acceptEdits' ? 'acceptEdits' : 'plan',
      deliver: { telegram: !!d.telegram, toast: d.toast !== false },
      on: input.on !== false,
    },
  };
}

/** Should this routine run now? It runs once a day, at its time or later, if JARVIS was closed then. */
export function isDue(r, now) {
  if (!r.on) return false;
  if (!r.days.includes(now.getDay())) return false;
  const [hh, mm] = r.time.split(':').map(Number);
  if (now.getHours() * 60 + now.getMinutes() < hh * 60 + mm) return false;
  return r.lastRunDay !== localDay(now);
}

/** The next time this routine is due after `from`, or null when it is off. */
export function nextRunAt(r, from) {
  if (!r.on) return null;
  const [hh, mm] = r.time.split(':').map(Number);
  for (let i = 0; i < 8; i++) {
    const c = new Date(from);
    c.setDate(c.getDate() + i);
    c.setHours(hh, mm, 0, 0);
    if (c > from && r.days.includes(c.getDay())) return c;
  }
  return null;
}

export class RoutineStore {
  constructor(file, { now = () => new Date(), makeId = () => crypto.randomUUID() } = {}) {
    this.file = file;
    this.now = now;
    this.makeId = makeId;
  }

  list() {
    const items = readJson(this.file, []);
    return Array.isArray(items) ? items : [];
  }

  add(input) {
    const v = validateRoutine(input);
    if (!v.ok) return v;
    const items = this.list();
    if (items.length >= MAX_ROUTINES) return { ok: false, error: `You can keep up to ${MAX_ROUTINES} routines.` };
    const item = { id: this.makeId(), ...v.value, created: this.now().getTime(), lastRunDay: null, lastRunAt: null, lastOk: null, lastSummary: '' };
    items.push(item);
    writeJson(this.file, items);
    return { ok: true, item };
  }

  update(id, input) {
    const v = validateRoutine(input);
    if (!v.ok) return v;
    const items = this.list();
    const it = items.find((r) => r.id === id);
    if (!it) return { ok: false, error: 'That routine no longer exists.' };
    Object.assign(it, v.value);
    writeJson(this.file, items);
    return { ok: true, item: it };
  }

  remove(id) {
    const items = this.list();
    const next = items.filter((r) => r.id !== id);
    if (next.length === items.length) return { ok: false, error: 'That routine no longer exists.' };
    writeJson(this.file, next);
    return { ok: true };
  }

  markRun(id, { ok, summary = '' }) {
    const items = this.list();
    const it = items.find((r) => r.id === id);
    if (!it) return null;
    const now = this.now();
    Object.assign(it, {
      lastRunDay: localDay(now),
      lastRunAt: now.getTime(),
      lastOk: !!ok,
      lastSummary: String(summary).slice(0, MAX_SUMMARY),
    });
    writeJson(this.file, items);
    return it;
  }
}

/**
 * Run one routine headless, the same way the chat does (same settings, same CLAUDE.md), with
 * the mode it was given. `query` is the agent SDK's query function, passed in so this file
 * does not load the SDK. Never throws: a failed run comes back as { ok: false, error }.
 */
export async function runRoutine(r, { query, exe, defaultCwd, trusted = false, timeoutMs = 10 * 60 * 1000 }) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  let text = '';
  let result = null;
  try {
    const q = query({
      prompt: r.prompt,
      options: {
        cwd: r.cwd || defaultCwd,
        pathToClaudeCodeExecutable: exe,
        // A folder the person trusts brings its own settings, hooks and MCP; any other runs
        // with their user settings only (workspaces.mjs, TRUST).
        settingSources: trusted ? ['user', 'project', 'local'] : ['user'],
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        permissionMode: r.mode === 'acceptEdits' ? 'acceptEdits' : 'plan',
        maxTurns: 40,
        abortController: abort,
      },
    });
    for await (const m of q) {
      if (m.type === 'assistant') {
        for (const b of m.message?.content || []) if (b.type === 'text') text += `${b.text}\n`;
      } else if (m.type === 'result') {
        result = m;
      }
    }
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 300), text: text.trim() };
  } finally {
    clearTimeout(timer);
  }
  if (!result) return { ok: false, error: 'The routine stopped before it finished.', text: text.trim() };
  const ok = result.subtype === 'success' && !result.is_error;
  const reply = (typeof result.result === 'string' && result.result.trim()) || text.trim();
  return {
    ok,
    text: reply,
    costUsd: Number(result.total_cost_usd) || 0,
    turns: Number(result.num_turns) || 0,
    error: ok ? null : (result.errors?.[0] || 'The routine did not finish cleanly.'),
  };
}
