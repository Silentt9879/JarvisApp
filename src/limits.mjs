// Usage limits: how much of the plan's session and weekly allowance is used, when it resets, and
// what is using it. Claude Code reports these itself. The "/usage" command runs locally - no model
// call, so no cost - and every request also reports the limits as it goes (rate_limit_event).
// The last reading is kept, so the page opens with numbers and says how old they are.
import { readJson, writeJson } from './store.mjs';

const LABEL_OF = {
  five_hour: 'Current session',
  seven_day: 'This week (all models)',
  seven_day_opus: 'This week (Opus)',
  seven_day_sonnet: 'This week (Sonnet)',
};

/** Turn the text /usage prints into numbers. Lines that are not there give nothing, never an error. */
export function parseUsageText(text) {
  const t = String(text || '');
  const windows = [];
  const line = /^\s*(Current session|Current week \(([^)]+)\)):\s*(\d+(?:\.\d+)?)%\s+used(?:\s*·\s*resets\s+(.+?))?\s*$/gm;
  for (const m of t.matchAll(line)) {
    const week = m[2];
    const key = week ? `week:${week.toLowerCase()}` : 'session';
    const label = week
      ? (week.toLowerCase() === 'all models' ? 'This week (all models)' : `This week (${week})`)
      : 'Current session';
    windows.push({ key, label, percent: Number(m[3]), resets: m[4] ? m[4].trim() : '', resetsAt: null });
  }
  const contributing = [];
  const block = /^Last (24h|7d) · (\d+) requests · (\d+) sessions\s*\n\s*(\d+)% of your usage was at >(\d+)k context/gm;
  for (const m of t.matchAll(block)) {
    contributing.push({
      span: m[1] === '24h' ? 'Last 24 hours' : 'Last 7 days',
      requests: Number(m[2]),
      sessions: Number(m[3]),
      longPercent: Number(m[4]),
      longOverK: Number(m[5]),
    });
  }
  return { windows, contributing };
}

/** The windows from a live rate_limit_event (utilization is a fraction of the limit). */
export function windowsFromEvent(info) {
  const out = [];
  const unified = info?.unifiedWindows || {};
  for (const [type, w] of Object.entries(unified)) {
    if (!w || typeof w !== 'object') continue;
    const u = Number(w.utilization);
    if (!Number.isFinite(u)) continue;
    const percent = Math.round((u <= 1 ? u * 100 : u) * 10) / 10;
    const label = LABEL_OF[type] || type.replace(/_/g, ' ');
    const key = type === 'five_hour' ? 'session' : type === 'seven_day' ? 'week:all models' : `week:${type.replace(/^seven_day_/, '')}`;
    out.push({ key, label, percent, resets: '', resetsAt: Number(w.resetsAt) ? Number(w.resetsAt) * 1000 : null });
  }
  return out;
}

export function overageFromEvent(info) {
  if (!info || !info.overageStatus) return null;
  return {
    status: info.overageStatus,
    reason: info.overageDisabledReason || null,
    inUse: !!info.isUsingOverage,
  };
}

/** The last reading, kept in a small file: windows merged by key, so a new reading replaces only what it has. */
export class LimitsStore {
  constructor(file, { now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
  }

  get() {
    const v = readJson(this.file, null);
    return v && typeof v === 'object' ? v : { updatedAt: null, source: null, windows: [], contributing: [], overage: null };
  }

  #save(next) {
    try { writeJson(this.file, next); } catch { /* the reading stays in memory for this run */ }
    return next;
  }

  mergeWindows(windows, { source, contributing = null, overage = undefined }) {
    const cur = this.get();
    const byKey = new Map((cur.windows || []).map((w) => [w.key, w]));
    for (const w of windows) byKey.set(w.key, w);
    const next = {
      updatedAt: this.now(),
      source,
      windows: [...byKey.values()],
      contributing: contributing ?? cur.contributing ?? [],
      overage: overage === undefined ? (cur.overage ?? null) : overage,
    };
    return this.#save(next);
  }
}

/**
 * Run "/usage" through the agent, the same way the chat runs it: no model call, and the text comes
 * back as the result. `query` is the SDK's query function. Never throws.
 */
export async function runUsageCommand({ query, exe, cwd, timeoutMs = 60000 }) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const q = query({
      prompt: '/usage',
      options: {
        cwd,
        pathToClaudeCodeExecutable: exe,
        settingSources: ['user'],
        permissionMode: 'plan',
        maxTurns: 2,
        abortController: abort,
      },
    });
    let text = '';
    let ok = false;
    for await (const m of q) {
      if (m.type === 'result') {
        ok = m.subtype === 'success' && !m.is_error;
        text = String(m.result || '');
      }
    }
    return ok && text.trim() ? { ok: true, text } : { ok: false, error: 'Claude Code did not return the usage.' };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

/** Refresh from "/usage" and keep the reading. Returns the stored reading, or { ok: false, error }. */
export async function refreshUsage(store, deps) {
  const r = await runUsageCommand(deps);
  if (!r.ok) return { ok: false, error: r.error, reading: store.get() };
  const parsed = parseUsageText(r.text);
  if (!parsed.windows.length) return { ok: false, error: 'The usage text was not in the form JARVIS reads.', reading: store.get() };
  return { ok: true, reading: store.mergeWindows(parsed.windows, { source: 'usage', contributing: parsed.contributing }) };
}
