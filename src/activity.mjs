// The activity log: what JARVIS did, in order - approvals, commands, file edits, git commits,
// messages from the phone, routine runs. One JSON line per entry, newest kept, ~5000 at most.
// Secrets are scrubbed before anything is written: a token typed into a command must not end
// up in a log file or an export.
import fs from 'node:fs';
import path from 'node:path';

export const KINDS = {
  approval: 'Approval',
  command: 'Command',
  edit: 'File change',
  git: 'Git',
  phone: 'Phone',
  routine: 'Routine',
  system: 'JARVIS',
};

const MAX_ENTRIES = 5000;
const MAX_TEXT = 300;

// Things that look like credentials: key=value pairs, bearer tokens, and the usual token prefixes.
const SECRET_PAIR = /\b(token|password|passwd|secret|api[_-]?key|apikey|auth|access[_-]?key)(\s*[=:]\s*|\s+)(["']?)[^\s"'&;]+/gi;
const BEARER = /\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const PREFIXED = /\b(gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|\d{8,12}:[A-Za-z0-9_-]{30,})/g;

/** The text with anything credential-shaped replaced by "[hidden]". */
export function redact(text) {
  return String(text ?? '')
    .replace(SECRET_PAIR, (m, k, sep, q) => `${k}${sep}${q}[hidden]`)
    .replace(BEARER, (m, b) => `${b} [hidden]`)
    .replace(PREFIXED, '[hidden]');
}

function clip(text) {
  const s = redact(text).replace(/\s+/g, ' ').trim();
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s;
}

export class ActivityLog {
  constructor(file, { max = MAX_ENTRIES, now = () => Date.now() } = {}) {
    this.file = file;
    this.max = max;
    this.now = now;
    this.entries = null; // loaded on first use
  }

  #load() {
    if (this.entries) return this.entries;
    this.entries = [];
    let text = '';
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { /* no log yet */ }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { this.entries.push(JSON.parse(line)); } catch { /* a damaged line is skipped, not fatal */ }
    }
    return this.entries;
  }

  /** Record one entry. Returns it. Never throws: a log must not break the thing it records. */
  add(kind, text, extra = {}) {
    const entry = { t: this.now(), kind: KINDS[kind] ? kind : 'system', text: clip(text) };
    if (extra.where) entry.where = clip(extra.where).slice(0, 120);
    try {
      const all = this.#load();
      all.push(entry);
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (all.length > this.max) {
        all.splice(0, all.length - this.max);
        fs.writeFileSync(this.file, all.map((e) => JSON.stringify(e)).join('\n') + '\n');
      } else {
        fs.appendFileSync(this.file, JSON.stringify(entry) + '\n');
      }
    } catch { /* not written - the in-memory copy still has it */ }
    return entry;
  }

  /** Newest first. `kind` filters to one kind, `query` matches the text, case-insensitive. */
  recent({ kind = null, query = '', limit = 300 } = {}) {
    const q = String(query || '').trim().toLowerCase();
    const out = [];
    const all = this.#load();
    for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
      const e = all[i];
      if (kind && e.kind !== kind) continue;
      if (q && !`${e.text} ${e.where || ''}`.toLowerCase().includes(q)) continue;
      out.push(e);
    }
    return out;
  }

  /** A plain-text export, oldest first, one line per entry. */
  exportText(entries = this.#load()) {
    const lines = [...entries].reverse().map((e) => {
      const when = new Date(e.t).toLocaleString();
      return `${when}  [${KINDS[e.kind] || e.kind}]  ${e.text}${e.where ? `  (${e.where})` : ''}`;
    });
    return `JARVIS activity log\n${lines.join('\n')}\n`;
  }
}

/**
 * Turn one session event into a log entry (or none). Pure, so it can be tested without the app.
 * `evt` is what session.mjs emits.
 */
export function entryFor(evt) {
  if (!evt || typeof evt !== 'object') return null;
  if (evt.kind === 'permission') return { kind: 'approval', text: `Asked to use ${evt.displayName || evt.toolName}: ${evt.detail || ''}`.trim() };
  if (evt.kind === 'tool_use' && !evt.parent) {
    if (evt.name === 'Bash') return { kind: 'command', text: evt.detail || 'Ran a command' };
    if (evt.name === 'Edit' || evt.name === 'Write' || evt.name === 'MultiEdit' || evt.name === 'NotebookEdit') return { kind: 'edit', text: `${evt.name}: ${evt.detail || 'a file'}` };
  }
  if (evt.kind === 'result' && evt.ok === false) return { kind: 'system', text: `A reply stopped early${evt.errors?.length ? `: ${evt.errors[0]}` : ''}` };
  return null;
}
