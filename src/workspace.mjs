// Read-only facts about the machine and the BantuApps workspace, for the dashboard:
// machine load, each repo's git state, knowledge freshness, open issues, the handoff's
// current focus, and the memory / knowledge documents.
//
// Nothing here writes. Git runs with --no-optional-locks (no index refresh), and
// documents are only read from a fixed set of folders, and only .md files.
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

/** The user's names for the nine repos (see .claude/CLAUDE.md section 4). */
export const NICKNAMES = {
  bantupanduv2: 'Customer App',
  BantuRescueDriver_v2: 'Driver App',
  BantuAutoPanel_v2: 'Panel App',
  advisorv2: 'Advisor App',
  bantu2u_merchant: 'Merchant App',
  'Bantu2U_Center-Module': 'Admin Web',
  BantuAutoPanelWeb_v2: 'Panel Web',
  Bantu2u_APIGateway: 'API Gateway',
  myInsurAPI: 'Insurance API',
};

/**
 * Run a command and collect its output.
 *
 * The options beyond `cwd` and `timeout` exist for operations that talk to a network and
 * so may need to be watched or stopped. They are all optional, and every existing caller
 * behaves exactly as before:
 *
 *   signal      an AbortSignal; aborting it kills the child and resolves `cancelled: true`
 *   onChild     receives the ChildProcess, so a caller can kill a whole process tree -
 *               on Windows `git fetch` spawns helpers that outlive a kill of git itself
 *   onLine      called with each line of stderr as it arrives, for live progress; git
 *               reports progress on stderr, not stdout
 *
 * A cancelled or timed-out run is NEVER reported as success: `ok` is false and the reason
 * is distinguishable, because "the user stopped it" and "it failed" are different things.
 */
export function run(cmd, args, { cwd, timeout = 12000, signal, onChild, onLine } = {}) {
  return new Promise((resolve) => {
    // GIT_OPTIONAL_LOCKS=0 reaches git run by child scripts too (scan-status.py): a status
    // refresh must never hold index.lock while the user or an agent commits.
    // GIT_TERMINAL_PROMPT=0 keeps a missing credential a clean failure instead of a
    // hidden prompt nobody can answer.
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', PYTHONIOENCODING: 'utf-8' };
    delete env.ELECTRON_RUN_AS_NODE;

    const opts = { cwd, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env };
    if (signal) opts.signal = signal;

    const child = execFile(cmd, args, opts, (err, stdout, stderr) => {
      const cancelled = !!(signal?.aborted) || err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
      const timedOut = !cancelled && !!err?.killed;
      resolve({
        ok: !err,
        code: typeof err?.code === 'number' ? err.code : (err ? 1 : 0),
        out: String(stdout || ''),
        err: String(stderr || err?.message || ''),
        cancelled,
        timedOut,
      });
    });

    if (onLine && child.stderr) {
      let buf = '';
      child.stderr.on('data', (d) => {
        buf += String(d);
        // git draws progress with \r; treat both as line ends.
        const parts = buf.split(/\r\n|\r|\n/);
        buf = parts.pop() || '';
        for (const line of parts) { const t = line.trim(); if (t) { try { onLine(t); } catch { /* reporting must not break the run */ } } }
      });
    }
    if (onChild) { try { onChild(child); } catch { /* the caller's problem, not the run's */ } }
  });
}

/**
 * Kill a process and everything it started. `child.kill()` on Windows leaves git's helper
 * processes (git-remote-https and friends) running, which can hold a lock or a connection
 * open long after the user pressed Stop.
 */
export function killTree(child) {
  if (!child || child.killed || typeof child.pid !== 'number') return;
  if (process.platform === 'win32') {
    try { execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {}); }
    catch { try { child.kill(); } catch { /* already gone */ } }
  } else {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
}

// ------------------------------------------------------------------ machine
let lastCpu = null;
function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  return { idle, total };
}

/** CPU (since the previous call), RAM and the workspace drive. */
export function systemStats(cwd) {
  const now = cpuTimes();
  let cpu = null;
  if (lastCpu) {
    const dt = now.total - lastCpu.total;
    if (dt > 0) cpu = Math.max(0, Math.min(100, Math.round(100 * (1 - (now.idle - lastCpu.idle) / dt))));
  }
  lastCpu = now;
  const total = os.totalmem();
  const used = total - os.freemem();
  let disk = null;
  const root = path.parse(cwd).root;
  try {
    const s = fs.statfsSync(root);
    const tot = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    disk = { root, used: tot - free, total: tot, pct: Math.round((100 * (tot - free)) / tot) };
  } catch { /* drive unreadable - shown as unknown */ }
  const cpus = os.cpus();
  return {
    cpu,
    cpuModel: (cpus[0]?.model || '').trim(),
    cores: cpus.length,
    ram: { used, total, pct: Math.round((100 * used) / total) },
    disk,
    uptime: os.uptime(),
    host: os.hostname(),
  };
}

// ------------------------------------------------------------------ repos
export function listRepos(cwd) {
  try {
    return fs.readdirSync(cwd, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(cwd, d.name, '.git')))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
  } catch { return []; }
}

/**
 * The state of one repository, given its directory. Source Control needs this for a repo
 * that is NOT a child of the workspace - the app's own - so the path-based form is the
 * real one and `repoState` below is the workspace-relative convenience over it. One
 * implementation, so the Workspace view and Source Control can never disagree.
 */
export async function repoStateAt(dir, name = path.basename(dir)) {
  const [st, lg] = await Promise.all([
    run('git', ['--no-optional-locks', '-C', dir, 'status', '--porcelain=v1', '-b']),
    run('git', ['--no-optional-locks', '-C', dir, 'log', '-1', '--format=%cr%x1f%s%x1f%ct']),
  ]);
  const r = { name, nickname: NICKNAMES[name] || name, ok: st.ok, branch: null, upstream: null, ahead: 0, behind: 0, modified: 0, staged: 0, untracked: 0, lastCommit: null };
  if (!st.ok) { r.error = st.err.split('\n')[0].slice(0, 200); return r; }
  const lines = st.out.split(/\r?\n/).filter(Boolean);
  const head = lines.shift() || '';
  const m = /^## (.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/.exec(head);
  if (m) {
    r.branch = m[1].replace(/^No commits yet on /, '');
    r.upstream = m[2] || null;
    const a = /ahead (\d+)/.exec(m[3] || '');
    const b = /behind (\d+)/.exec(m[3] || '');
    r.ahead = a ? Number(a[1]) : 0;
    r.behind = b ? Number(b[1]) : 0;
  }
  for (const l of lines) {
    const x = l[0];
    const y = l[1];
    if (x === '?' && y === '?') r.untracked++;
    else {
      if (x !== ' ') r.staged++;
      if (y !== ' ') r.modified++;
    }
  }
  if (lg.ok && lg.out.trim()) {
    const [ago, subject, ts] = lg.out.trim().split('\x1f');
    r.lastCommit = { ago, subject: (subject || '').slice(0, 160), at: Number(ts) * 1000 };
  }
  return r;
}

export async function gitStatus(cwd) {
  return Promise.all(listRepos(cwd).map((n) => repoStateAt(path.join(cwd, n), n)));
}

// ------------------------------------------------------------------ knowledge
async function python(args, cwd) {
  let r = await run('python', args, { cwd, timeout: 30000 });
  if (!r.ok && !r.out && /ENOENT/.test(r.err)) r = await run('py', args, { cwd, timeout: 30000 });
  return r;
}

/** Knowledge freshness from .claude/knowledge/scan-status.py --json (exit 1 = stale, still valid). */
export async function knowledgeStatus(cwd) {
  const script = path.join(cwd, '.claude', 'knowledge', 'scan-status.py');
  if (!fs.existsSync(script)) return { available: false };
  const r = await python([script, '--json'], cwd);
  try {
    const j = JSON.parse(r.out);
    const stale = Object.entries(j.stale || {}).map(([file, sources]) => ({ file, sources: (sources || []).slice(0, 6) }));
    return {
      available: true,
      lastScan: j.lastScan || null,
      state: (j.needsBaseline || []).length ? 'no-baseline' : stale.length ? 'stale' : 'current',
      stale,
      unmapped: (j.unmapped || []).length,
      needsBaseline: j.needsBaseline || [],
      changedRepos: (j.repos || []).filter((x) => x.status !== 'ok').map((x) => ({ repo: x.repo, changed: (x.changed || []).length })),
    };
  } catch {
    return { available: true, state: 'unknown', error: (r.err || 'no output').split('\n')[0].slice(0, 200) };
  }
}

/** Open issues from .claude/knowledge/open-issues.md: `### OI-nnn — title` + `- **Status:** ...`. */
export async function openIssues(cwd) {
  const file = path.join(cwd, '.claude', 'knowledge', 'open-issues.md');
  let text;
  try { text = await fsp.readFile(file, 'utf8'); } catch { return { available: false, list: [] }; }
  const list = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const h = /^### (OI-\d+)\s*[—-]\s*(.+)$/.exec(line);
    if (h) { cur = { id: h[1], title: h[2].replace(/`/g, '').trim(), status: 'unknown', severity: null }; list.push(cur); continue; }
    if (!cur) continue;
    const s = /^- \*\*Status:\*\*\s*(.+)$/.exec(line);
    if (s) cur.status = s[1].trim();
    const sev = /^- \*\*Severity:\*\*\s*(\w+)/i.exec(line);
    if (sev) cur.severity = sev[1].toLowerCase();
  }
  for (const i of list) i.open = /^open\b/i.test(i.status);
  return { available: true, list, open: list.filter((i) => i.open).length };
}

/** The numbered items of the handoff's CURRENT FOCUS section, first line of each. */
export async function handoffFocus(cwd) {
  const file = path.join(cwd, '.claude', 'jarvis', 'JARVIS_HANDOFF.md');
  let text;
  try { text = (await fsp.readFile(file, 'utf8')).replace(/^﻿/, ''); } catch { return { available: false, items: [] }; }
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^## CURRENT FOCUS/i.test(l));
  if (start < 0) return { available: true, asOf: null, items: [] };
  const asOf = (/as of ([0-9-]+)/i.exec(lines[start]) || [])[1] || null;
  const items = [];
  for (let i = start + 1; i < lines.length && !/^## /.test(lines[i]); i++) {
    const m = /^(\d+[a-z]?)\.\s+\*\*(.+?)\*\*(.*)$/.exec(lines[i]);
    if (m) items.push({ n: m[1], title: m[2].replace(/[:.]$/, '').replace(/`/g, ''), rest: m[3].trim().replace(/`/g, '').slice(0, 200) });
  }
  return { available: true, asOf, items };
}

// ------------------------------------------------------------------ saved effort
/**
 * The effort level Claude Code will use for a model when the session does not say:
 * `modelSettings[<model>].effortLevel`, else top-level `effortLevel`, from user, project
 * and local settings (later files win) - the same places /effort saves to.
 */
export function savedEffort(cwd, model) {
  const canon = String(model || '').replace(/\[.*?\]$/, '').replace(/-\d{8}$/, '');
  const files = [
    path.join(os.homedir(), '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.local.json'),
  ];
  let level = null;
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(f, 'utf8'));
      const v = s?.modelSettings?.[canon]?.effortLevel || s?.effortLevel;
      if (typeof v === 'string') level = v;
    } catch { /* missing or unreadable - skip */ }
  }
  return level;
}

// ------------------------------------------------------------------ documents
/** Claude Code's per-project folder name: every non-alphanumeric character becomes '-'. */
function projectDirFor(cwd) {
  const base = path.join(os.homedir(), '.claude', 'projects');
  const want = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  try {
    const hit = fs.readdirSync(base).find((d) => d.toLowerCase() === want.toLowerCase());
    return hit ? path.join(base, hit) : path.join(base, want);
  } catch { return path.join(base, want); }
}

/** The folders the window may browse. Keys are what the window refers to. */
export function docRoots(cwd) {
  const c = path.join(cwd, '.claude');
  return {
    memory: { label: 'Memory', dir: path.join(projectDirFor(cwd), 'memory'), deep: false },
    knowledge: { label: 'Knowledge', dir: path.join(c, 'knowledge'), deep: true },
    rules: { label: 'Rules', dir: path.join(c, 'jarvis'), deep: false },
    agents: { label: 'Agents', dir: path.join(c, 'agents'), deep: false },
    skills: { label: 'Skills', dir: path.join(c, 'skills'), deep: true },
    commands: { label: 'Commands', dir: path.join(c, 'commands'), deep: false },
  };
}

/** Split `---\nkey: value\n---` front matter (one level of nesting, enough for our files). */
function frontMatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^\s*([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv && kv[2] !== '') meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return { meta, body: text.slice(m[0].length) };
}

function firstHeading(body) {
  const h = /^#\s+(.+)$/m.exec(body);
  return h ? h[1].trim() : null;
}

async function walk(dir, deep, rel = '') {
  let entries;
  try { entries = await fsp.readdir(path.join(dir, rel), { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    const r = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory() && deep && !e.name.startsWith('.')) out.push(...(await walk(dir, deep, r)));
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(r);
  }
  return out;
}

/** Documents under one root, with front-matter name / description / type and [[links]]. */
export async function listDocs(cwd, rootKey) {
  const root = docRoots(cwd)[rootKey];
  if (!root) return [];
  const files = await walk(root.dir, root.deep);
  const docs = [];
  for (const rel of files) {
    const full = path.join(root.dir, rel);
    try {
      const [text, st] = await Promise.all([fsp.readFile(full, 'utf8'), fsp.stat(full)]);
      const { meta, body } = frontMatter(text);
      const links = [...body.matchAll(/\[\[([^\]]+)\]\]/g)].map((x) => x[1].trim());
      docs.push({
        root: rootKey,
        path: rel.replace(/\\/g, '/'),
        name: meta.name || path.basename(rel, '.md'),
        title: firstHeading(body) || meta.name || path.basename(rel, '.md'),
        description: meta.description || '',
        type: meta.type || null,
        links: [...new Set(links)],
        size: st.size,
        modified: st.mtimeMs,
      });
    } catch { /* unreadable file - skipped */ }
  }
  docs.sort((a, b) => a.path.localeCompare(b.path));
  return docs;
}

/** One document's text. The path must resolve inside the chosen root and be a .md file. */
export async function readDoc(cwd, rootKey, rel) {
  const root = docRoots(cwd)[rootKey];
  if (!root || typeof rel !== 'string') throw new Error('Unknown document.');
  const base = path.resolve(root.dir);
  const full = path.resolve(base, rel);
  if (!full.startsWith(base + path.sep) || !full.toLowerCase().endsWith('.md')) throw new Error('That document is outside the allowed folders.');
  const st = await fsp.stat(full);
  if (st.size > 2 * 1024 * 1024) throw new Error('That document is too large to show.');
  const text = (await fsp.readFile(full, 'utf8')).replace(/^﻿/, '');
  // wsRel lets the window hand this file to VS Code; memory lives outside the workspace,
  // so it stays null there and the caller falls back to the default handler.
  const wsRel = path.relative(path.resolve(cwd), full);
  return {
    root: rootKey, path: rel, text: frontMatter(text).body, modified: st.mtimeMs, full,
    wsRel: wsRel && !wsRel.startsWith('..') ? wsRel : null,
  };
}

/** Case-insensitive search across every browsable document: title, description and text. */
export async function searchDocs(cwd, q) {
  const needle = String(q || '').trim().toLowerCase();
  if (needle.length < 2) return [];
  const hits = [];
  for (const key of Object.keys(docRoots(cwd))) {
    const root = docRoots(cwd)[key];
    for (const rel of await walk(root.dir, root.deep)) {
      let text;
      try { text = await fsp.readFile(path.join(root.dir, rel), 'utf8'); } catch { continue; }
      const i = text.toLowerCase().indexOf(needle);
      const nameHit = rel.toLowerCase().includes(needle);
      if (i < 0 && !nameHit) continue;
      const snippet = i >= 0 ? text.slice(Math.max(0, i - 50), i + needle.length + 70).replace(/\s+/g, ' ').trim() : '';
      hits.push({ root: key, rootLabel: root.label, path: rel.replace(/\\/g, '/'), name: path.basename(rel, '.md'), snippet, score: nameHit ? 2 : 1 });
      if (hits.length >= 60) break;
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 40);
}
