// Custom agents: Claude Code subagent definitions, managed from the Agents page.
//
// An agent is a Markdown file with YAML front matter (name, description, and optionally tools
// and model) whose body is its system prompt. Claude Code takes them from two folders, and so
// does everything here - there is no second agent runtime, only files Claude Code already reads:
//
//   project   <workspace>/.claude/agents    this workspace only
//   user      <Claude config>/agents        every workspace, and the terminal and VS Code too
//
// What Claude Code does with those folders was measured against the bundled build, not assumed
// (scripts/agents-live-test.mjs repeats it): sub-folders are read too; the front matter's `name`
// is the agent's identity, not the file's name; a project agent hides a user agent of the same
// name; a file that does not end in .md is not read (which is how Disable works here); and a
// session that is already running does not notice a new file until it starts again.
//
// The rules this file keeps, whoever calls it:
//   - Nothing is ever overwritten silently. A new agent is created with an exclusive write; an
//     edit must name the version it was made from, and a copy of the old file is kept first.
//   - A path never comes from the window. A new file's name is built from the validated agent
//     name; an existing one is named relative to its folder and checked through the real path,
//     so `..`, an absolute path, a link or a junction cannot lead a write somewhere else.
//   - A restricted workspace is read and nothing more, so its agents are listed, never changed.
//   - The user folder is the person's own Claude configuration: every change there needs an
//     explicit approval, passed in by the caller after the person has seen the exact path.
//   - Tools that change files or run commands are never granted without being confirmed, and
//     no template or generated team asks for them by default.
//   - Only name, description, tools and model are managed. Every other key in an existing file
//     (hooks, mcpServers, permissionMode, ...) is kept exactly as written - and none of them is
//     ever written into a new file.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const MAX_AGENT_BYTES = 256 * 1024;
const MAX_FILES = 400;
const MAX_DEPTH = 4;
const MAX_DESCRIPTION = 4000;
const MAX_BODY = 120_000;
const MAX_TOOLS = 60;
const MAX_BACKUPS = 40;
const DISABLED = '.disabled';

/** Claude Code's own agents: reported by every session, defined in no file. */
export const BUILTIN_AGENTS = ['general-purpose', 'Explore', 'Plan', 'statusline-setup', 'claude-code-guide', 'claude'];

/** A model an agent may name: an alias, or a full model id. Absent means Claude Code's default. */
export const MODEL_ALIASES = ['inherit', 'sonnet', 'opus', 'haiku', 'fable'];
const MODEL_ID = /^claude-[a-z0-9][a-z0-9.-]{2,60}(?:\[1m\])?$/;

/**
 * The tools offered as tick boxes. `group` is what granting one means:
 *   read      looks only            network   reaches the internet
 *   write     changes files         execute   runs commands on this PC
 *   delegate  starts other agents
 */
export const TOOL_CATALOG = [
  { name: 'Read', group: 'read', label: 'Read files' },
  { name: 'Grep', group: 'read', label: 'Search inside files' },
  { name: 'Glob', group: 'read', label: 'Find files by name' },
  { name: 'TodoWrite', group: 'read', label: 'Keep a task list' },
  { name: 'WebSearch', group: 'network', label: 'Search the web' },
  { name: 'WebFetch', group: 'network', label: 'Read web pages' },
  { name: 'Edit', group: 'write', label: 'Edit existing files' },
  { name: 'Write', group: 'write', label: 'Create or replace files' },
  { name: 'NotebookEdit', group: 'write', label: 'Edit notebooks' },
  { name: 'Bash', group: 'execute', label: 'Run shell commands' },
  { name: 'PowerShell', group: 'execute', label: 'Run PowerShell commands' },
  { name: 'Agent', group: 'delegate', label: 'Hand work to other agents' },
];
/** The default for anything JARVIS proposes: it can look, and nothing else. */
export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];
const GROUP_OF = new Map(TOOL_CATALOG.map((t) => [t.name, t.group]));
GROUP_OF.set('MultiEdit', 'write');
GROUP_OF.set('Task', 'delegate');

export const NO_WORKSPACE_AGENTS = 'Choose a workspace first: a workspace agent lives in its .claude/agents folder.';
export const RESTRICTED_AGENTS = 'This workspace is restricted, so JARVIS changes nothing in it - and Claude does not load its agents. If it is your code, trust it in Settings > Workspaces.';

// ------------------------------------------------------------------ front matter
//
// A small reader for the YAML these files really use: `key: value`, quoted or plain, a
// comma-separated or listed `tools`, and a `|` or `>` block for a long description. It is not a
// YAML parser and does not pretend to be: a key it does not manage is never interpreted, only
// carried through as the lines it was written in.

const KEY_LINE = /^([A-Za-z_][\w-]*)[ \t]*:(?:[ \t]|$)/;
const MANAGED = ['name', 'description', 'tools', 'model'];

/** One scalar as written: quoted (either kind) or plain with a trailing comment removed. */
function scalar(raw) {
  const s = String(raw).trim();
  if (s[0] === '"') {
    let i = 1;
    for (; i < s.length; i++) { if (s[i] === '\\') { i++; continue; } if (s[i] === '"') break; }
    const quoted = s.slice(0, i + 1);
    try { return String(JSON.parse(quoted)); } catch { return quoted.replace(/^"|"$/g, '').replace(/\\(["\\])/g, '$1'); }
  }
  if (s[0] === "'") {
    let out = '';
    for (let i = 1; i < s.length; i++) {
      if (s[i] === "'") { if (s[i + 1] === "'") { out += "'"; i++; continue; } break; }
      out += s[i];
    }
    return out;
  }
  return s.replace(/[ \t]+#.*$/, '').trim();
}

/** "Read, Agent(a, b), mcp__x" -> its parts; a comma inside brackets does not split. */
export function splitList(text) {
  const out = [];
  let cur = '';
  let depth = 0;
  for (const ch of String(text ?? '')) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => scalar(x)).filter(Boolean);
}

/** The value of one front-matter block: its first line is `key: ...`, the rest belongs to it. */
function blockValue(lines) {
  const rest = lines[0].replace(/^[^:]*:/, '').trim();
  const more = lines.slice(1);
  const block = /^([|>])[+\-0-9]{0,2}[ \t]*(?:#.*)?$/.exec(rest);
  if (block) {
    const body = more.filter((l, i) => l.trim() || i < more.length - 1);
    const filled = body.filter((l) => l.trim());
    const indent = filled.length ? Math.min(...filled.map((l) => /^[ \t]*/.exec(l)[0].length)) : 0;
    const ded = body.map((l) => l.slice(Math.min(indent, l.length)));
    const text = block[1] === '|' ? ded.join('\n')
      : ded.reduce((acc, l) => (l.trim() ? (acc && !acc.endsWith('\n') ? `${acc} ${l.trim()}` : acc + l.trim()) : `${acc}\n`), '');
    return { kind: 'scalar', text: text.replace(/\s+$/, '') };
  }
  const plain = more.filter((l) => !/^\s*#/.test(l));
  if (!rest || rest[0] === '#') {
    const items = plain.filter((l) => /^\s*-(\s|$)/.test(l));
    if (items.length) return { kind: 'list', list: items.map((l) => scalar(l.replace(/^\s*-\s*/, ''))).filter(Boolean) };
    return plain.some((l) => l.trim()) ? { kind: 'map' } : { kind: 'empty' };
  }
  if (rest[0] === '[') {
    const end = rest.lastIndexOf(']');
    return { kind: 'list', list: splitList(end > 0 ? rest.slice(1, end) : rest.slice(1)) };
  }
  if (rest[0] === '{') return { kind: 'map' };
  return { kind: 'scalar', text: scalar([rest, ...plain.map((l) => l.trim()).filter(Boolean)].join(' ')) };
}

/**
 * An agent file, taken apart: its front matter as blocks (so the ones JARVIS does not manage
 * can be put back untouched), the fields it does manage, and the body. Never throws.
 */
export function parseAgentFile(text) {
  const raw = String(text ?? '').replace(/^\uFEFF/, '');
  const eol = /\r\n/.test(raw) ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const out = { hasFrontMatter: false, eol, blocks: [], body: raw, fields: { name: null, description: null, tools: null, model: null }, extras: {}, otherKeys: [], problems: [] };
  if (lines[0]?.trim() !== '---') { out.problems.push('No front matter: Claude Code needs a name and a description between --- lines.'); return out; }
  const close = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)[ \t]*$/.test(l));
  if (close < 0) { out.problems.push('The front matter is never closed with a --- line.'); return out; }
  out.hasFrontMatter = true;
  out.body = lines.slice(close + 1).join('\n').replace(/^\n+/, '').replace(/\s+$/, '');

  let cur = null;
  for (const line of lines.slice(1, close)) {
    const m = KEY_LINE.exec(line);
    if (m) { cur = { key: m[1], lines: [line] }; out.blocks.push(cur); continue; }
    if (!cur) { cur = { key: null, lines: [] }; out.blocks.push(cur); }
    cur.lines.push(line);
  }
  const seen = new Set();
  for (const b of out.blocks) {
    if (!b.key) continue;
    if (seen.has(b.key)) { out.problems.push(`"${b.key}" is set twice in the front matter.`); continue; }
    seen.add(b.key);
    const v = blockValue(b.lines);
    const text1 = v.kind === 'scalar' ? v.text : v.kind === 'list' ? v.list.join(', ') : '';
    if (b.key === 'name' || b.key === 'description' || b.key === 'model') out.fields[b.key] = text1 || null;
    else if (b.key === 'tools') out.fields.tools = v.kind === 'list' ? v.list : v.kind === 'scalar' ? splitList(v.text) : [];
    else {
      out.otherKeys.push(b.key);
      if (b.key === 'permissionMode' || b.key === 'color') out.extras[b.key] = text1 || null;
      else if (b.key === 'disallowedTools') out.extras.disallowedTools = v.kind === 'list' ? v.list : v.kind === 'scalar' ? splitList(v.text) : [];
      else if (b.key === 'hooks' || b.key === 'mcpServers') out.extras[b.key] = true;
    }
  }
  if (!out.fields.name) out.problems.push('No name in the front matter, so Claude Code cannot load this agent.');
  if (!out.fields.description) out.problems.push('No description in the front matter, so Claude Code cannot tell when to use this agent.');
  if (Array.isArray(out.fields.tools) && !out.fields.tools.length) out.problems.push('"tools" is there but lists nothing.');
  return out;
}

/** A string as YAML: plain when that is unambiguous, otherwise double-quoted (JSON's form is YAML's). */
function yamlString(value, plainOk = /^[A-Za-z][A-Za-z0-9 _.,;()/+'!?-]*$/) {
  const v = String(value);
  const plain = plainOk.test(v) && !/\s$/.test(v) && !/^(true|false|null|yes|no|on|off|y|n|~)$/i.test(v);
  return plain ? v : JSON.stringify(v);
}

/**
 * The file for an agent. With `original` (a parseAgentFile result) the managed keys are
 * replaced where they stand and everything else in the front matter is kept line for line.
 */
export function renderAgentFile({ name, description, tools = null, model = null, body }, original = null) {
  const eol = original?.eol || '\n';
  const line = {
    name: `name: ${yamlString(name)}`,
    description: `description: ${yamlString(description)}`,
    tools: tools === null ? null : `tools: ${yamlString(tools.join(', '), /^[A-Za-z][A-Za-z0-9_(), *.-]*$/)}`,
    model: model ? `model: ${yamlString(model)}` : null,
  };
  const out = [];
  const done = new Set();
  let lastManaged = -1;
  for (const b of (original?.hasFrontMatter ? original.blocks : [])) {
    if (!b.key || !MANAGED.includes(b.key)) { out.push(...b.lines); continue; }
    if (done.has(b.key)) continue; // a key set twice: the first one stands
    done.add(b.key);
    if (line[b.key] !== null) { out.push(line[b.key]); lastManaged = out.length - 1; }
    // A comment written under a managed key is the person's note, not part of its value.
    out.push(...b.lines.slice(1).filter((l) => /^#/.test(l)));
  }
  const missing = MANAGED.filter((k) => !done.has(k) && line[k] !== null).map((k) => line[k]);
  out.splice(lastManaged + 1, 0, ...missing);
  // No blank line may end the front matter by accident of an edit.
  while (out.length && !out[out.length - 1].trim()) out.pop();
  const text = String(body ?? '').replace(/\r\n?/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '');
  return ['---', ...out, '---', '', ...text.split('\n'), ''].join(eol);
}

// ------------------------------------------------------------------ validation

const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const TOOL = /^(?:[A-Z][A-Za-z0-9]{1,40}(?:\([A-Za-z0-9_:*., /-]{0,200}\))?|mcp__(?:\*|[A-Za-z0-9_.-]{1,80}(?:__[A-Za-z0-9_.*-]{1,120})?))$/;

/** Why a name cannot be used for a new agent, or null. Stricter than Claude Code, on purpose: it becomes a file name. */
export function nameProblem(name) {
  const n = String(name ?? '');
  if (!n) return 'Give the agent a name.';
  if (n.length < 2 || n.length > 64) return 'A name is 2 to 64 characters.';
  if (!NAME.test(n)) return 'A name is lowercase letters, digits and single hyphens, starting with a letter - like "code-reviewer".';
  if (WINDOWS_DEVICE.test(n)) return `"${n}" is a name Windows reserves for a device, so it cannot be a file name.`;
  if (BUILTIN_AGENTS.some((b) => b.toLowerCase() === n)) return `"${n}" is one of Claude Code's own agents. Pick another name.`;
  return null;
}

/** Line ends made plain and control characters dropped: this text ends up in a YAML string. */
function cleanText(s, { lines = true } = {}) {
  const t = String(s ?? '').replace(/\r\n?|[\u0085\u2028\u2029]/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return (lines ? t : t.replace(/\s*\n\s*/g, ' ')).trim();
}

/**
 * What a tool list allows, as words the window can show:
 *   all-tools, runs-commands, edits-files   need the person's explicit yes
 *   delegates, network, mcp                 are said, not asked about
 */
export function toolRisks(tools) {
  if (tools === null || tools === undefined) return ['all-tools'];
  const out = new Set();
  for (const t of tools) {
    const base = String(t).replace(/\(.*$/, '');
    const g = GROUP_OF.get(base);
    if (g === 'execute') out.add('runs-commands');
    else if (g === 'write') out.add('edits-files');
    else if (g === 'delegate') out.add('delegates');
    else if (g === 'network') out.add('network');
    else if (base.startsWith('mcp__')) out.add('mcp');
  }
  return [...out];
}
const NEEDS_YES = ['all-tools', 'runs-commands', 'edits-files'];
export const riskNeedsApproval = (risks) => (risks || []).some((r) => NEEDS_YES.includes(r));

/** A draft from the window, checked field by field. `keepName` lets an edit keep an older-style name. */
export function validateDraft(draft, { keepName = null } = {}) {
  const d = draft && typeof draft === 'object' ? draft : {};
  const errors = [];
  const warnings = [];
  const name = typeof d.name === 'string' ? d.name.trim() : '';
  if (!(keepName && name === keepName)) { const p = nameProblem(name); if (p) errors.push({ field: 'name', message: p }); }

  const description = cleanText(d.description, { lines: true });
  if (!description) errors.push({ field: 'description', message: 'Say when this agent should be used: Claude decides from the description.' });
  else if (description.length > MAX_DESCRIPTION) errors.push({ field: 'description', message: `Keep the description under ${MAX_DESCRIPTION} characters.` });

  const body = String(d.body ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (!body) errors.push({ field: 'body', message: 'Write the agent\'s instructions: they are its whole system prompt.' });
  else if (body.length > MAX_BODY) errors.push({ field: 'body', message: `Keep the instructions under ${MAX_BODY.toLocaleString('en-GB')} characters.` });

  let tools = null;
  if (d.tools !== null && d.tools !== undefined) {
    if (!Array.isArray(d.tools)) errors.push({ field: 'tools', message: 'Tools must be a list.' });
    else {
      tools = [...new Set(d.tools.map((t) => String(t ?? '').trim()).filter(Boolean))];
      if (!tools.length) errors.push({ field: 'tools', message: 'Tick at least one tool, or let the agent use the same tools as the chat.' });
      if (tools.length > MAX_TOOLS) errors.push({ field: 'tools', message: `That is more than ${MAX_TOOLS} tools.` });
      const bad = tools.filter((t) => !TOOL.test(t));
      if (bad.length) errors.push({ field: 'tools', message: `Not a tool name: ${bad.slice(0, 3).join(', ')}. Tools look like Read, Bash or mcp__server__tool.` });
      const unknown = tools.filter((t) => TOOL.test(t) && !t.startsWith('mcp__') && !GROUP_OF.has(t.replace(/\(.*$/, '')));
      if (unknown.length) warnings.push(`JARVIS does not know ${unknown.join(', ')}. It is written as typed; Claude Code ignores a tool it does not have.`);
    }
  }

  let model = null;
  if (d.model !== null && d.model !== undefined && String(d.model).trim()) {
    model = String(d.model).trim();
    if (!MODEL_ALIASES.includes(model) && !MODEL_ID.test(model)) errors.push({ field: 'model', message: `A model is ${MODEL_ALIASES.join(', ')}, or a full id like claude-sonnet-5-5.` });
  }
  return { ok: !errors.length, errors, warnings, clean: { name, description, body, tools, model } };
}

// ------------------------------------------------------------------ folders and paths

/** Claude Code's configuration folder: CLAUDE_CONFIG_DIR when set, else ~/.claude. */
export const configHome = (env = process.env) => env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

/** Windows paths are case-insensitive, and "C:\ws-other" is not inside "C:\ws". */
function within(child, parent) {
  const a = path.resolve(child).toLowerCase();
  const b = path.resolve(parent).toLowerCase();
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

function scopeInfo(ctx, scope) {
  if (scope === 'project') {
    if (!ctx?.cwd) return { ok: false, error: NO_WORKSPACE_AGENTS };
    return { ok: true, scope, root: ctx.cwd, dir: path.join(ctx.cwd, '.claude', 'agents'), display: '.claude/agents' };
  }
  if (scope === 'user') {
    const home = ctx?.home || configHome();
    const dir = path.join(home, 'agents');
    const userHome = os.homedir();
    const display = within(dir, userHome) ? `~/${path.relative(userHome, dir).split(path.sep).join('/')}` : dir;
    return { ok: true, scope, root: home, dir, display };
  }
  return { ok: false, error: 'An agent lives in this workspace, or in your own Claude folder.' };
}

/**
 * Where a scope's folder really is. `linked` means it (or a folder above it) is a link or a
 * junction that leaves its root - someone else manages those files, so they are read, not written.
 */
async function folderState(s) {
  const st = { exists: false, linked: false, real: null, rootReal: null };
  try { st.rootReal = await fsp.realpath(s.root); } catch { st.rootReal = null; }
  // Walk up from the agents folder to the first thing that exists: a folder not made yet has no
  // real path, but the one above it does, and that is where a link would be.
  let probe = s.dir;
  for (let i = 0; i < 4; i++) {
    try {
      const real = await fsp.realpath(probe);
      if (probe === s.dir) { st.exists = (await fsp.stat(real)).isDirectory(); st.real = real; }
      st.linked = !st.rootReal || !within(real, st.rootReal);
      break;
    } catch { probe = path.dirname(probe); if (!within(probe, s.root)) break; }
  }
  return st;
}

/** May this scope be changed, and if not, why? Looking is never refused. */
function writeGate(ctx, scope) {
  const s = scopeInfo(ctx, scope);
  if (!s.ok) return s;
  if (scope === 'project' && ctx.trusted !== true) return { ok: false, restricted: true, error: RESTRICTED_AGENTS };
  if (scope === 'user' && ctx.userWritable === false) return { ok: false, error: 'This run does not change your own Claude folder.' };
  return s;
}

const isAgentFile = (n) => /\.md$/i.test(n) || /\.md\.disabled$/i.test(n);
const isDisabledFile = (n) => /\.md\.disabled$/i.test(n);
const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 24);

/** A file named by the window (relative to its scope's folder, "/"-separated), as a real path - or why not. */
async function resolveExisting(s, file) {
  if (typeof file !== 'string' || !file || file.length > 300 || file.includes('\0') || file.includes('\\') || path.isAbsolute(file)) return { ok: false, error: 'That is not an agent file.' };
  const parts = file.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || /[:*?"<>|]/.test(p)) || !isAgentFile(parts[parts.length - 1])) return { ok: false, error: 'That is not an agent file.' };
  const full = path.join(s.dir, ...parts);
  if (!within(full, s.dir)) return { ok: false, error: 'That file is outside the agents folder.' };
  let lst;
  try { lst = await fsp.lstat(full); } catch { return { ok: false, gone: true, error: 'That agent file is no longer there.' }; }
  if (lst.isSymbolicLink()) return { ok: false, linked: true, error: 'That agent is a link to a file kept somewhere else, so JARVIS leaves it alone.' };
  if (!lst.isFile()) return { ok: false, error: 'That is not an agent file.' };
  try {
    const [real, dirReal, rootReal] = await Promise.all([fsp.realpath(full), fsp.realpath(s.dir), fsp.realpath(s.root)]);
    if (!within(real, dirReal) || !within(dirReal, rootReal)) return { ok: false, linked: true, error: 'That agent sits behind a link that leads out of its folder, so JARVIS leaves it alone.' };
  } catch { return { ok: false, error: 'That agent file could not be checked.' }; }
  return { ok: true, full, size: lst.size };
}

// ------------------------------------------------------------------ discovery

function riskList(fields, extras) {
  const risks = toolRisks(fields.tools);
  if (extras.permissionMode === 'bypassPermissions') risks.push('bypass-permissions');
  if (extras.hooks) risks.push('hooks');
  if (extras.mcpServers) risks.push('mcp-servers');
  return risks;
}

/** Every agent file under one scope's folder, read and described. Never throws. */
async function scanScope(ctx, scope) {
  const s = scopeInfo(ctx, scope);
  const info = { scope, available: s.ok, dir: s.ok ? s.display : null, exists: false, writable: false, reason: s.ok ? null : s.error, entries: [], truncated: false };
  if (!s.ok) return info;
  const st = await folderState(s);
  info.exists = st.exists;
  const gate = writeGate(ctx, scope);
  info.writable = gate.ok && !st.linked;
  info.reason = !gate.ok ? gate.error : st.linked ? 'This agents folder is a link to somewhere else, so JARVIS reads it and changes nothing.' : null;
  if (!st.exists) return info;

  const walk = async (dir, rel, depth) => {
    let list;
    try { list = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    list.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of list) {
      if (info.entries.length >= MAX_FILES) { info.truncated = true; return; }
      const r = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      // A linked folder is not followed: what is behind it is not this folder's to list.
      if (e.isDirectory()) { if (depth < MAX_DEPTH && !e.name.startsWith('.')) await walk(full, r, depth + 1); continue; }
      if (!isAgentFile(e.name)) continue;
      const linked = e.isSymbolicLink();
      let stat;
      try { stat = await fsp.stat(full); } catch { continue; }
      if (!stat.isFile()) continue;
      const entry = {
        scope, file: r, enabled: !isDisabledFile(e.name), linked,
        name: e.name.replace(/\.md(\.disabled)?$/i, ''), description: '', model: null, tools: null,
        otherKeys: [], extras: {}, risks: [], problems: [], size: stat.size, modified: stat.mtimeMs, hash: null,
      };
      if (stat.size > MAX_AGENT_BYTES) entry.problems.push('This file is too large for JARVIS to manage.');
      else {
        try {
          const buf = await fsp.readFile(full);
          entry.hash = sha(buf);
          const p = parseAgentFile(buf.toString('utf8'));
          entry.named = !!p.fields.name;
          if (p.fields.name) entry.name = p.fields.name;
          entry.description = p.fields.description || '';
          entry.model = p.fields.model;
          entry.tools = p.fields.tools;
          entry.otherKeys = p.otherKeys;
          entry.extras = p.extras;
          entry.problems = p.problems;
          // A file with no front matter is not an agent yet: it allows nothing, so it warns of nothing.
          entry.risks = p.hasFrontMatter ? riskList(p.fields, p.extras) : [];
        } catch { entry.problems.push('This file could not be read.'); }
      }
      entry.editable = info.writable && !linked && entry.hash !== null;
      entry.lock = entry.editable ? null
        : !info.writable ? info.reason
          : linked ? 'A link to a file kept somewhere else.' : entry.problems[0] || 'This file cannot be changed here.';
      info.entries.push(entry);
    }
  };
  await walk(s.dir, '', 0);
  return info;
}

const LOCK = {
  builtin: 'Built into Claude Code.',
  plugin: 'Provided by a Claude Code plugin - managed by that plugin.',
  other: 'Defined outside the agents folders (a setting, a policy or a start-up flag).',
};

/**
 * Every agent there is, from the two folders and from what the running session reports
 * (`session`: [{ name, description, model }], or null before it has connected):
 *
 *   source     project | user | builtin | plugin | other
 *   loads      Claude Code would load this file in this workspace (enabled, sound, and - for a
 *              workspace agent - the workspace trusted)
 *   shadowedBy 'project' for a user agent hidden here by a workspace agent of the same name
 *   inSession  the running session has it (null: no session yet)
 *   pending    'add' | 'remove' | 'change' - what a session restart would change
 */
export async function listAgents(ctx, { session = null } = {}) {
  const [project, user] = await Promise.all([scanScope(ctx, 'project'), scanScope(ctx, 'user')]);
  const trusted = ctx?.trusted === true;
  const live = Array.isArray(session) ? new Map(session.map((a) => [a.name, a])) : null;
  const agents = [];
  const winners = new Map(); // name -> the file entry Claude Code uses
  for (const info of [project, user]) {
    const seen = new Map();
    for (const e of info.entries) {
      const sound = e.named === true && !!e.description && e.hash !== null;
      const a = {
        id: `${e.scope}:${e.file}`, name: e.name, description: e.description, model: e.model, tools: e.tools,
        source: e.scope, scope: e.scope, file: e.file, path: `${info.dir}/${e.file}`,
        enabled: e.enabled, editable: e.editable, lock: e.lock, linked: e.linked,
        loads: e.enabled && sound && (e.scope === 'user' || trusted),
        shadowedBy: null, inSession: null, pending: null,
        risks: e.risks, problems: [...e.problems], otherKeys: e.otherKeys, modified: e.modified, hash: e.hash,
      };
      if (a.loads) {
        const key = a.name.toLowerCase();
        if (seen.has(key)) { a.loads = false; a.problems.push(`Another file in this folder (${seen.get(key)}) already defines "${a.name}".`); }
        else {
          seen.set(key, e.file);
          const first = winners.get(key);
          if (first) { a.loads = false; a.shadowedBy = first.scope; } else winners.set(key, a);
        }
      }
      if (BUILTIN_AGENTS.some((b) => b.toLowerCase() === a.name.toLowerCase())) a.problems.push(`"${a.name}" is also the name of one of Claude Code's own agents.`);
      agents.push(a);
    }
  }
  if (live) {
    for (const a of agents) {
      a.inSession = a.loads && live.has(a.name);
      const lv = live.get(a.name);
      // The session reports name, description and model - enough to see a description or model edit.
      if (a.loads && !lv) a.pending = 'add';
      else if (a.loads && lv && ((lv.description || '') !== a.description || (a.model && lv.model && lv.model !== a.model))) a.pending = 'change';
    }
    // Still in the session, but its file is gone, switched off or hidden: there until a restart.
    const fileNames = new Set(agents.map((a) => a.name));
    for (const a of agents) {
      if (!a.loads && !a.shadowedBy && live.has(a.name) && !winners.has(a.name.toLowerCase())) a.pending = 'remove';
    }
    for (const [name, lv] of live) {
      if (winners.has(name.toLowerCase()) || fileNames.has(name)) continue;
      const source = BUILTIN_AGENTS.includes(name) ? 'builtin' : name.includes(':') ? 'plugin' : 'other';
      agents.push({
        id: `session:${name}`, name, description: lv.description || '', model: lv.model || null, tools: undefined,
        source, scope: null, file: null, path: null, enabled: true, editable: false, lock: LOCK[source], linked: false,
        loads: true, shadowedBy: null, inSession: true, pending: null, risks: [], problems: [], otherKeys: [], modified: null, hash: null,
      });
    }
  }
  const strip = (i) => ({ available: i.available, dir: i.dir, exists: i.exists, writable: i.writable, reason: i.reason, truncated: i.truncated });
  return {
    ok: true,
    workspace: { available: !!ctx?.cwd, trusted },
    scopes: { project: strip(project), user: strip(user) },
    sessionLoaded: !!live,
    agents,
    pending: agents.filter((a) => a.pending).length,
  };
}

/** One agent file in full - its fields, its instructions and the version stamp an edit must quote. */
export async function readAgent(ctx, scope, file) {
  const s = scopeInfo(ctx, scope);
  if (!s.ok) return s;
  const hit = await resolveExisting(s, file);
  // A linked file may still be read: looking is never the risk.
  let full = hit.full;
  if (!hit.ok) {
    if (!hit.linked) return hit;
    full = path.join(s.dir, ...file.split('/'));
  }
  try {
    const buf = await fsp.readFile(full);
    if (buf.length > MAX_AGENT_BYTES) return { ok: false, error: 'That file is too large to show.' };
    const text = buf.toString('utf8');
    const p = parseAgentFile(text);
    return {
      ok: true,
      agent: {
        scope, file, enabled: !isDisabledFile(file), editable: hit.ok && writeGate(ctx, scope).ok,
        name: p.fields.name || path.basename(file).replace(/\.md(\.disabled)?$/i, ''), description: p.fields.description || '',
        tools: p.fields.tools, model: p.fields.model, body: p.body, otherKeys: p.otherKeys,
        risks: riskList(p.fields, p.extras), problems: p.problems, hash: sha(buf), text: text.replace(/^\uFEFF/, ''),
      },
    };
  } catch { return { ok: false, error: 'That agent file could not be read.' }; }
}

// ------------------------------------------------------------------ changes

/** A copy of a file about to be changed or removed, kept outside any folder Claude Code reads. */
async function keepBackup(ctx, s, full, name) {
  if (!ctx?.backupDir) return { ok: true, file: null };
  const where = s.scope === 'user' ? 'user' : `project-${createHash('sha256').update(path.resolve(s.root).toLowerCase()).digest('hex').slice(0, 10)}`;
  const dir = path.join(ctx.backupDir, where);
  try {
    await fsp.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safe = String(name).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'agent';
    const file = path.join(dir, `${stamp}-${safe}.md.bak`);
    await fsp.copyFile(full, file, fs.constants.COPYFILE_EXCL);
    const old = (await fsp.readdir(dir)).filter((n) => n.endsWith('.md.bak')).sort();
    for (const n of old.slice(0, Math.max(0, old.length - MAX_BACKUPS))) await fsp.rm(path.join(dir, n), { force: true });
    return { ok: true, file };
  } catch (e) {
    return { ok: false, error: `The old version could not be kept (${e?.code || 'error'}), so nothing was changed.` };
  }
}

/** Make sure a scope's folder exists and is really inside its root. */
async function ensureFolder(s) {
  let st = await folderState(s);
  if (st.linked) return { ok: false, error: 'This agents folder is a link to somewhere else, so JARVIS writes nothing into it.' };
  if (!st.exists) {
    try { await fsp.mkdir(s.dir, { recursive: true }); } catch (e) { return { ok: false, error: `The agents folder could not be made (${e?.code || 'error'}).` }; }
    st = await folderState(s);
    if (!st.exists || st.linked) return { ok: false, error: 'The agents folder is not where it should be, so nothing was written.' };
  }
  return { ok: true };
}

/** The other agents in a scope, by lower-cased name - for "that name is taken". */
async function namesIn(ctx, scope, exceptFile = null) {
  const info = await scanScope(ctx, scope);
  const map = new Map();
  for (const e of info.entries) if (e.file !== exceptFile) map.set(e.name.toLowerCase(), e);
  return map;
}

/** What the person has to agree to before this draft is written, beyond pressing Save. */
function approvalsFor(scope, risks, opts, { widened = true } = {}) {
  const needs = [];
  if (scope === 'user' && opts?.approveUserScope !== true) needs.push('user-scope');
  if (widened && riskNeedsApproval(risks) && opts?.allowRisky !== true) needs.push('risky-tools');
  return needs;
}

/**
 * Check a draft and say exactly what saving it would do - the text of the file, where it goes,
 * what it would replace, what it allows, and which approvals are still needed. Writes nothing.
 *
 * draft: { scope, file?, expect?, name, description, tools, model, body }
 *   `file` + `expect` (the hash it was opened at) make it an edit; without them it is a new agent.
 */
export async function previewAgent(ctx, draft, opts = {}) {
  const scope = draft?.scope;
  const gate = writeGate(ctx, scope);
  if (!gate.ok) return gate;
  const editing = typeof draft.file === 'string' && !!draft.file;
  let original = null;
  let current = null;
  if (editing) {
    const hit = await resolveExisting(gate, draft.file);
    if (!hit.ok) return hit;
    try {
      const buf = await fsp.readFile(hit.full);
      if (buf.length > MAX_AGENT_BYTES) return { ok: false, error: 'That file is too large for JARVIS to manage.' };
      current = { full: hit.full, hash: sha(buf), text: buf.toString('utf8') };
      original = parseAgentFile(current.text);
    } catch { return { ok: false, error: 'That agent file could not be read.' }; }
    if (typeof draft.expect !== 'string' || draft.expect !== current.hash) {
      return { ok: false, conflict: 'changed', error: 'This agent was changed outside JARVIS since you opened it. Reopen it to see the current version; nothing was overwritten.' };
    }
  }
  const v = validateDraft(draft, { keepName: original?.fields.name || null });
  if (!v.ok) return { ok: false, invalid: true, error: v.errors[0].message, errors: v.errors };
  const d = v.clean;

  const taken = await namesIn(ctx, scope, editing ? draft.file : null);
  const clash = taken.get(d.name.toLowerCase());
  if (clash) return { ok: false, conflict: 'name', error: `There is already an agent called "${clash.name}" here (${clash.file}${clash.enabled ? '' : ', switched off'}). Pick another name, or edit that one.` };

  const renamed = editing && d.name !== original.fields.name;
  const disabled = editing && isDisabledFile(draft.file);
  const target = editing && !renamed ? draft.file
    : `${editing ? path.posix.dirname(draft.file).replace(/^\.$/, '') : ''}${editing && path.posix.dirname(draft.file) !== '.' ? '/' : ''}${d.name}.md${disabled ? DISABLED : ''}`;
  const targetFull = path.join(gate.dir, ...target.split('/'));
  if (!within(targetFull, gate.dir)) return { ok: false, error: 'That file would be outside the agents folder.' };
  const targetTaken = (!editing || renamed) && fs.existsSync(targetFull);
  if (targetTaken) return { ok: false, conflict: 'file', error: `A file called ${target} is already in that folder. Nothing was overwritten - pick another name.` };

  const warnings = [...v.warnings];
  // The same name in the other folder is allowed, and worth saying: one of the two is hidden.
  const other = scope === 'project' ? 'user' : 'project';
  const twin = (await namesIn(ctx, other)).get(d.name.toLowerCase());
  if (twin?.enabled) {
    warnings.push(scope === 'project'
      ? `You also have your own agent called "${d.name}". In this workspace, this one is used instead of it.`
      : `This workspace has its own agent called "${d.name}", which is used here instead of this one.`);
  }
  if (original?.otherKeys.length) warnings.push(`Kept as written: ${original.otherKeys.join(', ')}.`);

  const risks = toolRisks(d.tools);
  const before = original ? toolRisks(original.fields.tools) : [];
  const widened = !editing || risks.some((r) => NEEDS_YES.includes(r) && !before.includes(r));
  return {
    ok: true,
    draft: d,
    scope,
    creating: !editing,
    renamed,
    file: target,
    path: `${gate.display}/${target}`,
    text: renderAgentFile(d, original),
    before: current ? current.text.replace(/^\uFEFF/, '') : null,
    risks,
    warnings,
    needs: approvalsFor(scope, risks, opts, { widened }),
    internal: { gate, current, targetFull },
  };
}

const forWindow = (p) => { if (!p || typeof p !== 'object') return p; const { internal, ...rest } = p; return rest; };
/** previewAgent without the paths only this process needs. */
export async function previewForWindow(ctx, draft, opts) { return forWindow(await previewAgent(ctx, draft, opts)); }

/**
 * Create an agent, or save an edit to one. Refused - with nothing written - when the draft is
 * invalid, the name or file is taken, the file changed since it was opened, the workspace is
 * restricted, or an approval is missing (`needs`).
 */
export async function saveAgent(ctx, draft, opts = {}) {
  const p = await previewAgent(ctx, draft, opts);
  if (!p.ok) return p;
  if (p.needs.length) return { ...forWindow(p), ok: false, needsApproval: true, error: 'This needs your approval first.' };
  const { gate, current, targetFull } = p.internal;
  const folder = await ensureFolder(gate);
  if (!folder.ok) return folder;
  let backup = null;
  try {
    if (p.creating) {
      // Exclusive: if a file appeared here since the check, this fails instead of replacing it.
      await fsp.writeFile(targetFull, p.text, { flag: 'wx' });
    } else {
      const kept = await keepBackup(ctx, gate, current.full, p.draft.name);
      if (!kept.ok) return kept;
      backup = kept.file;
      if (p.renamed) {
        await fsp.writeFile(targetFull, p.text, { flag: 'wx' });
        await fsp.rm(current.full, { force: true });
      } else {
        const tmp = `${current.full}.${process.pid}.${Date.now()}.tmp`;
        await fsp.writeFile(tmp, p.text, { flag: 'wx' });
        try { await fsp.rename(tmp, current.full); } catch (e) { await fsp.rm(tmp, { force: true }); throw e; }
      }
    }
  } catch (e) {
    if (e?.code === 'EEXIST') return { ok: false, conflict: 'file', error: `A file called ${p.file} appeared in that folder. Nothing was overwritten.` };
    return { ok: false, error: `The agent could not be saved (${e?.code || e?.message || 'error'}).` };
  }
  return { ok: true, created: p.creating, renamed: p.renamed, scope: p.scope, file: p.file, path: p.path, name: p.draft.name, risks: p.risks, warnings: p.warnings, backup: !!backup };
}

/**
 * Several new agents at once (templates, a generated team). Every draft is checked before
 * anything is written, so one bad draft means none are created; each is still an exclusive write.
 */
export async function createAgents(ctx, drafts, opts = {}) {
  if (!Array.isArray(drafts) || !drafts.length) return { ok: false, error: 'Nothing was chosen.' };
  if (drafts.length > 12) return { ok: false, error: 'That is a lot of agents at once. Create up to 12 at a time.' };
  const previews = [];
  const names = new Set();
  for (const d of drafts) {
    const p = await previewAgent(ctx, { ...d, file: undefined, expect: undefined }, opts);
    const key = `${d?.scope}:${String(d?.name || '').toLowerCase()}`;
    if (p.ok && names.has(key)) previews.push({ ok: false, conflict: 'name', error: `"${d.name}" is chosen twice.`, name: d.name });
    else previews.push(p.ok ? p : { ...p, name: d?.name || '' });
    names.add(key);
  }
  const bad = previews.filter((p) => !p.ok);
  if (bad.length) return { ok: false, error: bad[0].error, results: previews.map((p) => ({ name: p.ok ? p.draft.name : p.name, ok: p.ok, error: p.ok ? null : p.error })) };
  const needs = [...new Set(previews.flatMap((p) => p.needs))];
  if (needs.length) return { ok: false, needsApproval: true, needs, error: 'This needs your approval first.', results: previews.map((p) => ({ name: p.draft.name, ok: true, path: p.path, risks: p.risks })) };
  const results = [];
  for (const d of drafts) {
    const r = await saveAgent(ctx, { ...d, file: undefined, expect: undefined }, opts);
    results.push({ name: d.name, ok: r.ok, error: r.ok ? null : r.error, path: r.path || null });
  }
  return { ok: results.every((r) => r.ok), results, error: results.find((r) => !r.ok)?.error || null };
}

/** Remove an agent file. A copy is kept first; `confirmed` must be the person's own yes. */
export async function deleteAgent(ctx, { scope, file, expect } = {}, opts = {}) {
  const gate = writeGate(ctx, scope);
  if (!gate.ok) return gate;
  if (opts?.confirmed !== true) return { ok: false, needsApproval: true, needs: ['delete'], error: 'Deleting an agent has to be confirmed.' };
  const hit = await resolveExisting(gate, file);
  if (!hit.ok) return hit;
  try {
    const buf = await fsp.readFile(hit.full);
    if (typeof expect === 'string' && expect !== sha(buf)) return { ok: false, conflict: 'changed', error: 'This agent was changed outside JARVIS since you opened it, so it was not deleted. Look again first.' };
    const name = parseAgentFile(buf.toString('utf8')).fields.name || path.basename(file).replace(/\.md(\.disabled)?$/i, '');
    const kept = await keepBackup(ctx, gate, hit.full, name);
    if (!kept.ok) return kept;
    await fsp.rm(hit.full);
    return { ok: true, name, scope, file, backup: !!kept.file };
  } catch (e) {
    return { ok: false, error: `The agent could not be deleted (${e?.code || 'error'}).` };
  }
}

/**
 * Switch an agent off or on by renaming its file (x.md <-> x.md.disabled): Claude Code reads
 * only .md files, so nothing in any settings file is touched and the agent comes back whole.
 */
export async function setAgentEnabled(ctx, { scope, file } = {}, enabled, opts = {}) {
  const gate = writeGate(ctx, scope);
  if (!gate.ok) return gate;
  if (scope === 'user' && opts?.approveUserScope !== true) return { ok: false, needsApproval: true, needs: ['user-scope'], error: 'This needs your approval first.' };
  const hit = await resolveExisting(gate, file);
  if (!hit.ok) return hit;
  const isOn = !isDisabledFile(file);
  if (isOn === (enabled === true)) return { ok: true, unchanged: true, scope, file, enabled: isOn };
  const next = enabled === true ? file.replace(/\.disabled$/i, '') : `${file}${DISABLED}`;
  const nextFull = path.join(gate.dir, ...next.split('/'));
  if (fs.existsSync(nextFull)) return { ok: false, conflict: 'file', error: `A file called ${next} is already there. Nothing was renamed.` };
  if (enabled === true) {
    // Switching on must not land a second agent on a name that is in use.
    const name = (await readAgent(ctx, scope, file)).agent?.name;
    const clash = name ? [...(await namesIn(ctx, scope, file)).values()].find((e) => e.enabled && e.name.toLowerCase() === name.toLowerCase()) : null;
    if (clash) return { ok: false, conflict: 'name', error: `Another agent called "${clash.name}" is already switched on here (${clash.file}).` };
  }
  try { await fsp.rename(hit.full, nextFull); } catch (e) { return { ok: false, error: `The agent could not be switched ${enabled ? 'on' : 'off'} (${e?.code || 'error'}).` }; }
  return { ok: true, scope, file: next, enabled: enabled === true };
}

// ------------------------------------------------------------------ starters

const BOUNDARY = 'If you have not been given tools that edit files or run commands, do not work around it: say exactly what should be changed or run (file, line, command), and stop there.';

/**
 * Starter agents. Every one is a valid Claude Code definition as it stands, and every one
 * starts read-only: `optional` lists the tools that would make it more useful, for the person
 * to tick on themselves.
 */
export const TEMPLATES = [
  {
    id: 'code-reviewer', name: 'code-reviewer', title: 'Code Reviewer',
    description: 'Reviews code for correctness, clarity and maintainability. Use after writing or changing code, or when asked for a second opinion on a diff or a file.',
    tools: READ_ONLY_TOOLS, optional: ['Bash'], optionalWhy: 'Bash lets it read the diff with git itself.',
    body: `You are a careful senior code reviewer. Your job is to find what is wrong or risky in the code you are pointed at, and to say so plainly.

When you are invoked:
1. Work out what changed or what you were asked to look at. Read the code itself, and enough of what surrounds it to understand how it is used.
2. Review it for, in this order: correctness (wrong behaviour, edge cases, error handling), security (untrusted input, secrets, injection), then clarity and maintainability.
3. Check your suspicions before reporting them: read the caller, the type, the test. Do not report a guess as a finding.

Report back as a short list, most serious first. For each finding give the file and line, what is wrong, why it matters, and the smallest change that fixes it. Separate "must fix" from "consider". If you found nothing serious, say so in one line - do not invent findings to fill the list.

Stay on what you were asked to review. Do not rewrite code that is fine, and do not restyle it.
${BOUNDARY}`,
  },
  {
    id: 'debugger', name: 'debugger', title: 'Debugger',
    description: 'Finds the root cause of a bug, error message, failing test or unexpected behaviour. Use when something is broken and the cause is not yet known.',
    tools: READ_ONLY_TOOLS, optional: ['Bash', 'Edit'], optionalWhy: 'Bash lets it reproduce the failure; Edit lets it apply the fix.',
    body: `You are a debugging specialist. Your job is to find the root cause of a problem - not the nearest symptom - and to prove it.

When you are invoked:
1. State the failure precisely: what was expected, what happened, the exact error text and where it came from.
2. Form hypotheses and rank them. Test the most likely first by reading the code on the path from the input to the failure.
3. Follow the evidence. For each hypothesis say what you checked and whether it held. Drop one as soon as the code contradicts it.
4. Stop when you can name the line or the condition that causes the failure, and explain why it produces exactly the behaviour seen.

Report back with: the root cause (file and line), the evidence for it, the smallest fix, and how to confirm the fix worked. If you could not get to a cause, say what you ruled out and what you would look at next - a clear "not found yet" is more useful than a confident guess.

Fix the cause, not the symptom: no swallowed errors, no special cases that hide the bug.
${BOUNDARY}`,
  },
  {
    id: 'test-engineer', name: 'test-engineer', title: 'Test Engineer',
    description: 'Designs and reviews tests: finds untested behaviour, proposes test cases and judges whether existing tests really check what they claim. Use when adding a feature, fixing a bug, or assessing coverage.',
    tools: READ_ONLY_TOOLS, optional: ['Edit', 'Write', 'Bash'], optionalWhy: 'Edit and Write let it add the tests; Bash lets it run them.',
    body: `You are a test engineer. Your job is to make sure the code's real behaviour is checked by tests that would fail if it broke.

When you are invoked:
1. Read the code under test and the tests that already exist. Learn the project's test framework and its conventions from those tests, and follow them.
2. List the behaviours that matter: the normal path, the boundaries, the error paths and anything a past bug touched.
3. Compare the list with the existing tests. Name what is untested, and name any test that passes without really checking the behaviour (asserts nothing useful, mocks the thing it claims to test).
4. Propose the tests to add, most valuable first, each as a concrete case: the setup, the action and the expected result.

Prefer a few tests that check real behaviour over many that check implementation details. Never weaken or delete a test to make it pass; if a test is wrong, say why.

Report back with the gaps you found, the tests you propose (or added), and - if you ran them - the actual result, including failures, quoted as they appeared.
${BOUNDARY}`,
  },
  {
    id: 'security-reviewer', name: 'security-reviewer', title: 'Security Reviewer',
    description: 'Reviews code and configuration for security weaknesses: injection, broken authentication or authorization, exposed secrets and unsafe handling of untrusted input. Use before merging changes that touch input handling, auth, data access or configuration.',
    tools: READ_ONLY_TOOLS, optional: [], optionalWhy: '',
    body: `You are an application security reviewer. Your job is to find weaknesses someone could actually exploit, and to explain each one well enough that it gets fixed.

When you are invoked:
1. Find where untrusted data comes in (requests, files, messages, environment, third-party responses) and follow it to where it is used: queries, commands, file paths, HTML, deserialisation, redirects.
2. Check authentication and authorisation on every path you look at: who may call this, and is that checked on the server, for this specific record?
3. Look for secrets in code, configuration and logs, and for sensitive data sent or stored where it should not be.
4. Check the configuration that matters: CORS, cookies, TLS, error detail shown to users, dependency versions with known problems.

Report each finding with: severity (critical, high, medium, low), the file and line, how it could be exploited in concrete terms, and the specific fix. Only report what you can trace in the code - mark anything you could not confirm as "needs checking". If an area is sound, say which checks you made, so it is clear what was covered.

This is a defensive review of the user's own code. Do not write exploit code beyond what is needed to explain the weakness, and never print a secret you find: say where it is.
${BOUNDARY}`,
  },
  {
    id: 'performance-analyst', name: 'performance-analyst', title: 'Performance Analyst',
    description: 'Finds performance problems and their causes: slow queries, wasteful loops, unnecessary work, memory growth and slow rendering. Use when something is slow, or before a change that will run often or on large data.',
    tools: READ_ONLY_TOOLS, optional: ['Bash'], optionalWhy: 'Bash lets it run a benchmark or a profiler.',
    body: `You are a performance analyst. Your job is to find where time and memory really go, and to recommend the change that is worth making.

When you are invoked:
1. Establish what is slow and how slow: the operation, the data size, the measurement if there is one. If nothing has been measured, say so and say what to measure first.
2. Read the hot path end to end. Look for work repeated inside loops, queries issued per item, data loaded and then discarded, blocking calls on a path that should not block, and structures that grow without bound.
3. Estimate the cost of each suspect in terms of the data size, so the biggest one is clear.
4. Recommend the fix with the best return, and say what it costs in complexity.

Report back with the bottleneck (file and line), why it is slow, the proposed change, the improvement you expect and how to measure it. Distinguish what you measured from what you inferred from reading. Do not recommend optimising code that is not on a hot path, and do not trade away correctness or readability for a gain nobody will notice.
${BOUNDARY}`,
  },
  {
    id: 'documentation-specialist', name: 'documentation-specialist', title: 'Documentation Specialist',
    description: 'Writes and reviews documentation: READMEs, setup guides, API references and comments that explain why. Use when code has changed and the documentation has not, or when something is hard for a newcomer to understand.',
    tools: READ_ONLY_TOOLS, optional: ['Edit', 'Write'], optionalWhy: 'Edit and Write let it update the documents itself.',
    body: `You are a documentation specialist. Your job is to make sure a capable newcomer can understand and use this code from what is written down.

When you are invoked:
1. Read the code first, then the documentation. The code is the truth: where they disagree, the documentation is what is wrong.
2. Find what a reader needs and cannot find: how to set it up, how to run it, what each part is for, and the decisions that are not obvious from the code.
3. Write for the reader who arrives cold. Lead with what they need to do; use full sentences; define a term the first time it appears; give a real, working example rather than a description of one.
4. Match the project's existing style and structure. Update the document that already covers the topic rather than adding a second one.

Never document behaviour you have not confirmed in the code, and never invent an option, a flag or an endpoint. If something is unclear, say so and say what you could not confirm.

Report back with what was out of date or missing, and the text you propose (or the changes you made), file by file.
${BOUNDARY}`,
  },
];

/** The starters as the window lists them. */
export const templatesForWindow = () => TEMPLATES.map((t) => ({ ...t, tools: [...t.tools], optional: [...t.optional] }));

// ------------------------------------------------------------------ Build My Team
//
// A team for a workspace is worked out from what project discovery already found - which
// kinds of project are there - by fixed rules. No model is asked and nothing is spent: the
// person presses a button, gets a short list with a reason beside each, and decides.

/** A name or a path from a project, made safe to put into an agent's instructions. */
const safeLabel = (s) => String(s ?? '').replace(/[^\w .()/+@&-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

const STACK_LABEL = { flutter: 'Flutter', dotnet: '.NET', node: 'Node.js', python: 'Python', jvm: 'Java / Kotlin', dart: 'Dart' };
/** Which stacks a discovered project belongs to. A Flutter app's android/ host is not a JVM project. */
export function stacksOf(project) {
  const t = project?.types || [];
  if (project?.role === 'platform') return [];
  const out = [];
  if (t.includes('flutter')) out.push('flutter');
  else if (t.includes('dart')) out.push('dart');
  if (t.includes('dotnet')) out.push('dotnet');
  if (t.includes('node')) out.push('node');
  if (t.includes('python')) out.push('python');
  if (t.includes('gradle') || t.includes('maven')) out.push('jvm');
  return out;
}

function projectList(projects) {
  const lines = projects.slice(0, 8).map((p) => `- ${safeLabel(p.displayName || p.name)}${p.relativePath && p.relativePath !== '.' ? ` (${safeLabel(p.relativePath)})` : ' (the workspace folder itself)'}`);
  if (projects.length > 8) lines.push(`- and ${projects.length - 8} more`);
  return lines.join('\n');
}
const where = (kind, projects) => (projects.length ? `\n\nThe ${kind} projects in this workspace:\n${projectList(projects)}\n\nRead a project's own files to learn its conventions before proposing a change; do not assume them.` : '');

const developer = (stack, title, extra) => ({
  role: `${stack}-developer`, covers: new RegExp(`\\b${stack === 'dotnet' ? '(\\.?net|c#|csharp|asp)' : stack === 'jvm' ? '(java|kotlin|gradle|maven|spring)' : stack}\\b.*\\b(dev|engineer|expert|specialist)|\\b(dev|engineer|expert|specialist)\\w*\\b.*\\b${stack === 'dotnet' ? '(\\.?net|c#|csharp|asp)' : stack}\\b`, 'i'),
  title, tools: READ_ONLY_TOOLS, optional: ['Edit', 'Write', 'Bash'],
  optionalWhy: 'Edit and Write let it make the change; Bash lets it build and run the tests.',
  ...extra,
});

/** Every role a team can be offered. `prompt(projects)` writes the instructions for this workspace. */
const ROLES = {
  'flutter-developer': developer('flutter', 'Flutter Developer', {
    name: 'flutter-developer',
    description: 'Builds and changes Flutter and Dart code: widgets, state, navigation, platform channels and packages. Use for feature work or fixes in the Flutter apps of this workspace.',
    why: (p) => `${p.length} Flutter project${p.length > 1 ? 's' : ''} found (${p.slice(0, 3).map((x) => safeLabel(x.displayName || x.name)).join(', ')}).`,
    prompt: (p) => `You are a senior Flutter developer working in this workspace.${where('Flutter', p)}

When you are invoked:
1. Read pubspec.yaml, analysis_options.yaml and the code around the change. Follow the state management, folder layout and naming this app already uses - do not introduce another approach beside it.
2. Make the smallest change that does the job. Keep widgets small, keep build methods free of side effects, dispose what you create, and handle loading, empty and error states.
3. Check your work the way this project does: \`dart analyze\` must stay clean, and the tests that cover the change must pass.

Report back with what you changed and why, file by file, and the exact result of any analysis or test you ran.
${BOUNDARY}`,
  }),
  'widget-tester': {
    role: 'widget-tester', name: 'widget-tester', title: 'Widget Tester', covers: /\b(widget|flutter)\b.*\btest|\btest\w*\b.*\b(widget|flutter)\b/i,
    description: 'Writes and reviews Flutter widget, unit and integration tests. Use when Flutter code is added or changed, or when a screen has no tests.',
    tools: READ_ONLY_TOOLS, optional: ['Edit', 'Write', 'Bash'], optionalWhy: 'Edit and Write let it add the tests; Bash lets it run `flutter test`.',
    why: () => 'Flutter screens are easy to break without noticing; widget tests catch it before a phone does.',
    prompt: (p) => `You are a Flutter test engineer working in this workspace.${where('Flutter', p)}

When you are invoked:
1. Read the widget or class under test, and the tests already in the project's test/ and integration_test/ folders. Use the same helpers, fakes and structure they use.
2. Test behaviour a user would notice: what is shown for each state (loading, data, empty, error), what a tap or an entry does, and what is sent to the layer below. Pump the widget, act, then expect.
3. Replace real network, storage and platform calls with fakes. A widget test must not depend on a device, the clock or the network.
4. Never loosen or delete a test to make it pass; if a test is wrong, say why.

Report back with the cases you propose or added, and - if you ran them - the real output of \`flutter test\`, failures included.
${BOUNDARY}`,
  },
  'flutter-performance-reviewer': {
    role: 'flutter-performance-reviewer', name: 'flutter-performance-reviewer', title: 'Performance Reviewer', covers: /\bperformance|\bperf\b|\bjank\b/i,
    description: 'Reviews Flutter code for dropped frames, needless rebuilds, heavy work on the UI thread, image and list cost, and memory leaks. Use when a screen feels slow or before shipping a list-heavy or animation-heavy screen.',
    tools: READ_ONLY_TOOLS, optional: [], optionalWhy: '',
    why: () => 'Slow frames come from a handful of well-known causes that a focused review finds.',
    prompt: (p) => `You are a Flutter performance reviewer working in this workspace.${where('Flutter', p)}

When you are invoked, read the screen or flow you were pointed at and look for:
- rebuilds wider than they need to be (state held too high, missing const, a builder that rebuilds a whole subtree);
- work in build methods, or synchronous work on the UI thread that belongs in an isolate or behind an await;
- lists built eagerly instead of lazily, and images decoded at full size for a small box;
- controllers, streams, timers and listeners that are never disposed.

For each finding give the file and line, why it costs frames or memory, and the specific change. Say which findings you would confirm with the Flutter DevTools performance view before changing anything. Do not recommend an optimisation for code that runs once.
${BOUNDARY}`,
  },
  'dotnet-developer': developer('dotnet', '.NET Developer', {
    name: 'dotnet-developer',
    description: 'Builds and changes C# and ASP.NET code: controllers, services, data access, dependency injection and configuration. Use for feature work or fixes in the .NET projects of this workspace.',
    why: (p) => `${p.length} .NET project${p.length > 1 ? 's' : ''} found (${p.slice(0, 3).map((x) => safeLabel(x.displayName || x.name)).join(', ')}).`,
    prompt: (p) => `You are a senior .NET developer working in this workspace.${where('.NET', p)}

When you are invoked:
1. Read the project file, Program.cs or Startup.cs, and the code around the change. Follow the layering, naming and dependency injection this solution already uses.
2. Make the smallest change that does the job. Use async all the way down, pass cancellation tokens through, validate input at the edge, and never build SQL by joining strings.
3. Check your work the way this solution does: it must build without new warnings, and the tests that cover the change must pass.

Report back with what you changed and why, file by file, and the exact result of any build or test you ran.
${BOUNDARY}`,
  }),
  'api-tester': {
    role: 'api-tester', name: 'api-tester', title: 'API Tester', covers: /\bapi\b.*\btest|\btest\w*\b.*\b(api|endpoint|integration)\b/i,
    description: 'Designs and reviews tests for HTTP APIs: status codes, validation, authorization and error responses for each endpoint. Use when an endpoint is added or changed.',
    tools: READ_ONLY_TOOLS, optional: ['Edit', 'Write', 'Bash'], optionalWhy: 'Edit and Write let it add the tests; Bash lets it run `dotnet test`.',
    why: () => 'An API\'s contract - status codes, validation, who may call what - is exactly what tests should pin down.',
    prompt: (p) => `You are an API test engineer working in this workspace.${where('.NET', p)}

When you are invoked:
1. Read the endpoint, its request and response types, and its authorisation rules. Read the existing test project and use its framework, fixtures and naming.
2. For each endpoint cover: the success case, each validation failure, the unauthenticated and the unauthorised caller, the missing record, and the conflict or duplicate. Assert the status code and the body, not just that no exception was thrown.
3. Test through the HTTP surface where the project already does (a test host), and keep real external services out of it with fakes.
4. Never loosen or delete a test to make it pass.

Report back with the cases you propose or added, and - if you ran them - the real test output, failures included.
${BOUNDARY}`,
  },
  'security-reviewer': {
    role: 'security-reviewer', name: 'security-reviewer', title: 'Security Reviewer', covers: /\bsecur|\bvulnerab|\bpentest|\bappsec/i,
    description: TEMPLATES[3].description, tools: READ_ONLY_TOOLS, optional: [], optionalWhy: '',
    why: () => 'Code that takes requests and talks to a database is where injection and authorization mistakes live.',
    prompt: () => TEMPLATES[3].body,
  },
  'backend-developer': developer('node', 'Backend Developer', {
    name: 'backend-developer', role: 'backend-developer', covers: /\bback-?end\b|\bnode\b.*\b(dev|engineer)|\bserver\b.*\b(dev|engineer)/i,
    description: 'Builds and changes Node.js server code: routes, services, data access, validation and background jobs. Use for feature work or fixes in the Node.js services of this workspace.',
    why: (p) => `${p.length} Node.js project${p.length > 1 ? 's' : ''} found (${p.slice(0, 3).map((x) => safeLabel(x.displayName || x.name)).join(', ')}).`,
    prompt: (p) => `You are a senior Node.js backend developer working in this workspace.${where('Node.js', p)}

When you are invoked:
1. Read package.json (scripts, module type, dependencies) and the code around the change. Use the package manager whose lock file is there, and the framework and patterns this project already uses.
2. Make the smallest change that does the job. Validate input at the edge, handle every rejected promise, never build a query or a shell command by joining strings, and keep secrets in configuration.
3. Check your work with the project's own scripts (lint, typecheck, test) - only the ones package.json defines.

Report back with what you changed and why, file by file, and the exact result of anything you ran.
${BOUNDARY}`,
  }),
  'python-developer': developer('python', 'Python Developer', {
    name: 'python-developer',
    description: 'Builds and changes Python code: modules, scripts, services and their dependencies. Use for feature work or fixes in the Python projects of this workspace.',
    why: (p) => `${p.length} Python project${p.length > 1 ? 's' : ''} found (${p.slice(0, 3).map((x) => safeLabel(x.displayName || x.name)).join(', ')}).`,
    prompt: (p) => `You are a senior Python developer working in this workspace.${where('Python', p)}

When you are invoked:
1. Read pyproject.toml or requirements.txt and the code around the change. Follow the layout, typing and formatting this project already uses, and work inside its own virtual environment if it has one.
2. Make the smallest change that does the job. Prefer the standard library, type what you add, raise specific exceptions, and never swallow one silently.
3. Check your work with the tools the project already has configured (its tests, its linter).

Report back with what you changed and why, file by file, and the exact result of anything you ran.
${BOUNDARY}`,
  }),
  'jvm-developer': developer('jvm', 'Java / Kotlin Developer', {
    name: 'jvm-developer',
    description: 'Builds and changes Java and Kotlin code in Gradle or Maven projects. Use for feature work or fixes in the JVM projects of this workspace.',
    why: (p) => `${p.length} Gradle or Maven project${p.length > 1 ? 's' : ''} found (${p.slice(0, 3).map((x) => safeLabel(x.displayName || x.name)).join(', ')}).`,
    prompt: (p) => `You are a senior Java and Kotlin developer working in this workspace.${where('Gradle and Maven', p)}

When you are invoked:
1. Read the build file and the code around the change. Follow the module layout, dependency versions and patterns this project already uses, and build with its own wrapper (gradlew or mvnw) when it has one.
2. Make the smallest change that does the job, with nulls and exceptions handled deliberately.
3. Check your work the way this project does: it must compile, and the tests that cover the change must pass.

Report back with what you changed and why, file by file, and the exact result of anything you ran.
${BOUNDARY}`,
  }),
  'test-engineer': {
    role: 'test-engineer', name: 'test-engineer', title: 'Test Engineer', covers: /\btest\w*\b|\bqa\b/i,
    description: TEMPLATES[2].description, tools: READ_ONLY_TOOLS, optional: TEMPLATES[2].optional, optionalWhy: TEMPLATES[2].optionalWhy,
    why: () => 'Whatever the stack, changes are safer with someone whose only job is the tests.',
    prompt: () => TEMPLATES[2].body,
  },
  'architecture-reviewer': {
    role: 'architecture-reviewer', name: 'architecture-reviewer', title: 'Architecture Reviewer', covers: /\barchitect/i,
    description: 'Reviews how the projects in this workspace fit together: boundaries, shared contracts, duplicated logic and changes that must land in more than one project. Use before a change that crosses projects, or to understand how a feature flows end to end.',
    tools: READ_ONLY_TOOLS, optional: [], optionalWhy: '',
    why: (p, f) => `This workspace mixes ${f.stacks.map((s) => STACK_LABEL[s]).join(', ')} - someone has to keep the seams between them in view.`,
    prompt: (p) => `You are an architecture reviewer for a workspace that holds several projects in different technologies.${where('', p).replace('The  projects', 'The projects')}

When you are invoked:
1. Map the part you were asked about: which projects are involved, what each one owns, and how they talk (HTTP contracts, shared types, queues, files, databases).
2. Trace the feature or the change end to end across those projects. Name every place that has to change together, and what breaks if one changes alone.
3. Look for the same rule implemented twice in two projects, a contract that is only implied, and a dependency that points the wrong way.

Report back with a short map of the flow, the contracts that matter, the risks you found (most serious first, with file and line) and the order in which a cross-project change should land. Recommend the smallest structural change that solves the problem in front of you - not a rewrite.
${BOUNDARY}`,
  },
  debugger: {
    role: 'debugger', name: 'debugger', title: 'Debugger', covers: /\bdebug|\bdiagnos|\btroubleshoot|\broot cause/i,
    description: TEMPLATES[1].description, tools: READ_ONLY_TOOLS, optional: TEMPLATES[1].optional, optionalWhy: TEMPLATES[1].optionalWhy,
    why: () => 'In a mixed workspace a bug often starts in one project and shows up in another.',
    prompt: () => TEMPLATES[1].body,
  },
  'documentation-specialist': {
    role: 'documentation-specialist', name: 'documentation-specialist', title: 'Documentation Specialist', covers: /\bdocument|\bdocs?\b|\breadme|\btechnical writ/i,
    description: TEMPLATES[5].description, tools: READ_ONLY_TOOLS, optional: TEMPLATES[5].optional, optionalWhy: TEMPLATES[5].optionalWhy,
    why: () => 'Several projects mean several setups; written down once, nobody has to rediscover them.',
    prompt: () => TEMPLATES[5].body,
  },
  'code-reviewer': {
    role: 'code-reviewer', name: 'code-reviewer', title: 'Code Reviewer', covers: /\breview/i,
    description: TEMPLATES[0].description, tools: READ_ONLY_TOOLS, optional: TEMPLATES[0].optional, optionalWhy: TEMPLATES[0].optionalWhy,
    why: () => 'A second pair of eyes is useful in any code, whatever it is written in.',
    prompt: () => TEMPLATES[0].body,
  },
};

/** The roles for one stack on its own: someone to build, someone to test, and at most one reviewer. */
const TEAM_FOR = {
  flutter: ['flutter-developer', 'widget-tester', 'flutter-performance-reviewer'],
  dart: ['test-engineer', 'code-reviewer'],
  dotnet: ['dotnet-developer', 'api-tester', 'security-reviewer'],
  node: ['backend-developer', 'test-engineer'],
  python: ['python-developer', 'test-engineer'],
  jvm: ['jvm-developer', 'test-engineer'],
};
const MIXED_TEAM = ['architecture-reviewer', 'debugger', 'documentation-specialist'];
const STACK_DEVELOPER = { flutter: 'flutter-developer', dotnet: 'dotnet-developer', node: 'backend-developer', python: 'python-developer', jvm: 'jvm-developer' };

/**
 * A small team for a workspace, or for one project in it. Pure: it reads nothing and asks no
 * model. `projects` is project discovery's list; `target` a project id, or null for the whole
 * workspace; `existing` the agents there already are (listAgents), so no role is offered twice.
 *
 * Each member comes back with a reason (`why`), its read-only tools, the optional tools the
 * person may add, and `selected` - false for a role that an existing agent seems to cover
 * already (`existing`), or whose name is taken (`conflict`).
 */
export function planTeam({ projects = [], target = null, existing = [] } = {}) {
  const all = (projects || []).filter((p) => p && p.role !== 'platform');
  const inScope = target ? all.filter((p) => p.id === target || p.relativePath === target || String(p.relativePath || '').startsWith(`${target}/`)) : all;
  if (target && !inScope.length) return { ok: false, error: 'That project is not in this workspace.' };
  const by = {};
  for (const p of inScope) for (const s of stacksOf(p)) (by[s] = by[s] || []).push(p);
  // The biggest stack first; Dart packages only count when there is no Flutter beside them.
  const stacks = Object.keys(by).filter((s) => !(s === 'dart' && by.flutter)).sort((a, b) => by[b].length - by[a].length || a.localeCompare(b));
  const facts = { stacks, counts: Object.fromEntries(stacks.map((s) => [s, by[s].length])), projects: inScope.length };

  let recommended;
  let optional = [];
  let summary;
  if (!stacks.length) {
    recommended = ['code-reviewer', 'debugger'];
    summary = inScope.length
      ? 'No Flutter, .NET, Node.js, Python or JVM project was recognised here, so this is a general pair that is useful in any code.'
      : 'No projects were found in this workspace yet, so this is a general pair that is useful in any code.';
  } else if (stacks.length === 1) {
    recommended = TEAM_FOR[stacks[0]];
    summary = `${STACK_LABEL[stacks[0]]} only (${by[stacks[0]].length} project${by[stacks[0]].length > 1 ? 's' : ''}), so the team is one that builds, one that tests${recommended.length > 2 ? ' and one that reviews' : ''}.`;
  } else {
    recommended = MIXED_TEAM;
    optional = stacks.map((s) => STACK_DEVELOPER[s]).filter(Boolean).slice(0, 3);
    summary = `A mixed workspace (${stacks.map((s) => STACK_LABEL[s]).join(', ')}), so the team is three that work across all of it. A developer for each technology is offered below, unticked.`;
  }

  const have = (existing || []).filter((a) => a && a.source !== 'builtin');
  const taken = new Set(have.map((a) => String(a.name).toLowerCase()));
  const member = (key, selected) => {
    const r = ROLES[key];
    const mine = key.startsWith('flutter') || key === 'widget-tester' ? by.flutter
      : key === 'dotnet-developer' || key === 'api-tester' ? by.dotnet
        : key === 'backend-developer' ? by.node
          : key === 'python-developer' ? by.python
            : key === 'jvm-developer' ? by.jvm : inScope;
    const list = mine || [];
    const covered = have.find((a) => a.enabled !== false && r.covers.test(`${a.name} ${a.description || ''}`));
    const conflict = taken.has(r.name);
    return {
      key, name: r.name, title: r.title, description: r.description,
      why: r.why(list, facts),
      tools: [...r.tools], optional: [...(r.optional || [])], optionalWhy: r.optionalWhy || '',
      model: null,
      body: r.prompt(list, facts),
      existing: covered ? covered.name : null,
      conflict,
      selected: selected && !covered && !conflict,
    };
  };
  return {
    ok: true,
    target: target || null,
    facts,
    summary,
    members: [...recommended.map((k) => member(k, true)), ...optional.map((k) => member(k, false))],
    existing: have.filter((a) => a.source === 'project' || a.source === 'user').map((a) => ({ name: a.name, source: a.source, enabled: a.enabled !== false })),
  };
}
