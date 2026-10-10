// JARVIS Knowledge - Phase 23B: safe storage and migration only.
//
// Not wired into the running app yet. No IPC handler calls this file, no renderer knows it
// exists, and nothing in main.mjs imports it - on purpose. This phase builds and proves the
// storage engine and the migration path in isolation, against temp directories only, so
// shipping it carries zero risk to the live Notes feature or to a real notes.json. Wiring it
// into the app (an IPC surface, a new editor) is a later, separate phase, done once this one
// has been reviewed.
//
// THE MODEL (see docs/jarvis-knowledge-design.md §4): one Markdown file per note, with YAML
// front matter, under <userData>/knowledge/notes/<id>.md - the same shape src/agents.mjs
// already uses for agent files, so the resilience properties below are proven, not new:
//
//   - A damaged byte in one note's file cannot affect any other note. Today's notes.json
//     (src/notes.mjs) treats ANY parse failure as "no notes at all" - this fixes that.
//   - A note's `id` in its front matter is its identity - never its filename, and never its
//     title (both can change; the id does not). The filename is a convenience that should
//     match the id, not the source of truth for it.
//   - Every write is atomic: a temp file, then a rename. A crash mid-write leaves the
//     previous good file (or no file), never a half-written one - the same guarantee
//     notes.mjs, config-file.mjs and store.mjs already give their own files.
//   - Unknown front-matter keys are preserved byte-for-byte on a rewrite, the same way
//     agents.mjs keeps hooks/mcpServers/permissionMode on an agent it edits - this format is
//     not JARVIS's alone to rewrite however it likes.
//
// MIGRATION (see docs/jarvis-knowledge-design.md §4, "Migration strategy"). notes.json is
// NEVER moved, renamed or deleted by this phase - the live Notes page still reads it, and
// this phase's whole point is to not touch that. Migration only ever ADDS: a verified backup
// copy, and a parallel knowledge/notes/*.md tree. It is idempotent (each note's presence and
// exact content at its target path IS the "already done" check, so a second run - or a run
// resumed after a crash, a permission failure, or a kill -9 - only ever does the work still
// outstanding) and it never overwrites a file that does not match what it would have written
// (a hand-edited or hand-placed file there is left alone and reported as a conflict, not
// silently replaced).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { NoteStore } from './notes.mjs';

export const SCHEMA_VERSION = 1;
// `deletedAt` (Phase 23D): set the moment a note moves to Trash, cleared by nothing (a
// restored note keeps it as "was deleted, then restored" history) - not read by anything in
// the live store today, only by listTrash(), but it is a managed key like created/updated/
// sentAt rather than something a later phase would have to carry through by hand.
// `aiExcluded` (Phase 4, AI Knowledge): a per-note opt-out, checked by notes-search.mjs
// before a note's content is ever included in a search result or an AI chat context -
// "respect note-level AI permissions... exclude private or restricted notes" from the brief.
// Defaults to false (included) the same way `favorite` defaults to false - a note is
// discoverable unless its own owner has explicitly said otherwise.
const MANAGED_KEYS = ['id', 'title', 'created', 'updated', 'tags', 'favorite', 'folder', 'project', 'session', 'branch', 'sentAt', 'deletedAt', 'aiExcluded'];
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
// Windows reserves these as device names, whatever the extension - "con.md" cannot be a real file.
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** A fresh note id. Migrated notes keep their original id instead - see migrateFromLegacy. */
export const newId = () => randomUUID();

// ------------------------------------------------------------------ front matter (read)
//
// A small, hand-rolled reader for the subset of YAML this format actually uses - plain and
// quoted scalars, a `[a, b]` or `- a\n- b` list for tags, true/false/null. Not a YAML parser,
// and not trying to be one: a key this module does not manage is carried through as the exact
// lines it was written in (`otherKeys`/`raw`), never interpreted, so a future field added by a
// later phase - or by a person's own hand edit - is never silently dropped by an older build.

function scalar(raw) {
  const s = String(raw).trim();
  if (s[0] === '"') {
    let i = 1;
    for (; i < s.length; i++) { if (s[i] === '\\') { i++; continue; } if (s[i] === '"') break; }
    try { return String(JSON.parse(s.slice(0, i + 1))); } catch { return s.slice(1, i).replace(/\\(["\\])/g, '$1'); }
  }
  if (s[0] === "'") {
    let out = '';
    for (let i = 1; i < s.length; i++) { if (s[i] === "'") { if (s[i + 1] === "'") { out += "'"; i++; continue; } break; } out += s[i]; }
    return out;
  }
  const bare = s.replace(/[ \t]+#.*$/, '').trim();
  return bare;
}
// No bare comma: a tag list ("tags: [a, b]") splits on comma, so an unquoted value containing
// one would be indistinguishable from two values - quoting it is what keeps it one value.
const UNQUOTED = /^[A-Za-z][A-Za-z0-9 _.;()/+'!?-]*$/;
function yamlString(value) {
  const v = String(value);
  return UNQUOTED.test(v) && !/\s$/.test(v) && !/^(true|false|null|yes|no|on|off|y|n|~)$/i.test(v) ? v : JSON.stringify(v);
}

/** "a, \"needs: care\", 'x,y'" -> its parts; a comma inside a quoted value does not split - a
 *  quoted value is exactly what lets a tag contain one, so splitting there would defeat it. */
function splitList(text) {
  const out = [];
  let cur = '';
  let depth = 0;
  let quote = null; // '"' or "'" while inside that kind of quoted value, else null
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      cur += ch;
      if (quote === '"' && ch === '\\') { if (i + 1 < s.length) cur += s[++i]; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '[' || ch === '(') depth += 1; else if (ch === ']' || ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => scalar(x)).filter(Boolean);
}

/** The value of one front-matter block, given its first line and the lines that follow it. */
function blockValue(lines) {
  const rest = lines[0].replace(/^[^:]*:/, '').trim();
  const more = lines.slice(1);
  if (rest[0] === '[') {
    const end = rest.lastIndexOf(']');
    return { kind: 'list', list: splitList(end > 0 ? rest.slice(1, end) : rest.slice(1)) };
  }
  if (!rest || rest[0] === '#') {
    const items = more.filter((l) => /^\s*-(\s|$)/.test(l));
    if (items.length) return { kind: 'list', list: items.map((l) => scalar(l.replace(/^\s*-\s*/, ''))).filter(Boolean) };
    return { kind: 'scalar', text: '' };
  }
  return { kind: 'scalar', text: scalar(rest) };
}

const KEY_LINE = /^([A-Za-z_][\w-]*)[ \t]*:(?:[ \t]|$)/;

/**
 * One note file, taken apart: the managed fields (as real JS values), every other key kept as
 * its raw lines (`otherKeys` names them, `raw` holds the Map for a lossless rewrite), and the
 * Markdown body. `problems` lists anything wrong enough to flag; it is never fatal - the body
 * is always recovered, even from a file with no front matter at all (the whole file becomes
 * the body, so nothing already written to disk is ever treated as unreadable).
 */
export function parseNoteFile(text, { fallbackId = null } = {}) {
  const raw = String(text ?? '').replace(/^\uFEFF/, '');
  const eol = /\r\n/.test(raw) ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const out = {
    hasFrontMatter: false, eol, problems: [],
    fields: { id: null, title: null, created: null, updated: null, tags: null, favorite: null, folder: null, project: null, session: null, branch: null, sentAt: null, deletedAt: null, aiExcluded: null },
    otherKeys: [], raw: new Map(), body: raw,
  };
  if (lines[0]?.trim() !== '---') {
    out.problems.push('No front matter: the whole file is kept as the note\'s text.');
    out.fields.id = fallbackId;
    return out;
  }
  const close = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)[ \t]*$/.test(l));
  if (close < 0) {
    out.problems.push('The front matter is never closed with a --- line: the whole file is kept as the note\'s text.');
    out.fields.id = fallbackId;
    return out;
  }
  out.hasFrontMatter = true;
  // Trailing whitespace is trimmed to match what renderNoteFile always writes (the body, then
  // exactly one trailing newline) - so a note's body round-trips to itself exactly, not to
  // itself-plus-a-newline. A file with no front matter at all (below) is never touched this
  // way: that branch's whole point is to hand back unmanaged content exactly as it was.
  out.body = lines.slice(close + 1).join('\n').replace(/^\n+/, '').replace(/\s+$/, '');

  const blocks = [];
  let cur = null;
  for (const line of lines.slice(1, close)) {
    const m = KEY_LINE.exec(line);
    if (m) { cur = { key: m[1], lines: [line] }; blocks.push(cur); continue; }
    if (!cur) { cur = { key: null, lines: [] }; blocks.push(cur); }
    cur.lines.push(line);
  }
  const seen = new Set();
  for (const b of blocks) {
    if (!b.key) continue;
    if (seen.has(b.key)) { out.problems.push(`"${b.key}" is set twice in the front matter - the first one stands.`); continue; }
    seen.add(b.key);
    const v = blockValue(b.lines);
    if (MANAGED_KEYS.includes(b.key)) {
      if (b.key === 'tags') out.fields.tags = v.kind === 'list' ? v.list : (v.text ? splitList(v.text) : []);
      else if (b.key === 'favorite') out.fields.favorite = /^true$/i.test(v.text || '');
      else if (b.key === 'aiExcluded') out.fields.aiExcluded = /^true$/i.test(v.text || '');
      else if (b.key === 'created' || b.key === 'updated' || b.key === 'sentAt' || b.key === 'deletedAt') { const n = Number(v.text); out.fields[b.key] = Number.isFinite(n) ? n : null; }
      else out.fields[b.key] = v.kind === 'scalar' ? (v.text || null) : null;
    } else {
      out.otherKeys.push(b.key);
      out.raw.set(b.key, b.lines);
    }
  }
  if (!out.fields.id) { out.problems.push('No id in the front matter.'); out.fields.id = fallbackId; }
  else if (!ID.test(out.fields.id)) out.problems.push(`"${out.fields.id}" is not a valid id shape.`);
  if (out.fields.tags == null) out.fields.tags = [];
  if (out.fields.favorite == null) out.fields.favorite = false;
  if (out.fields.aiExcluded == null) out.fields.aiExcluded = false;
  return out;
}

// ------------------------------------------------------------------ front matter (write)

/**
 * A note file's exact bytes. Deterministic: the same fields and the same `original` (or none)
 * always render identically, which is what lets migration tell "already migrated, matches
 * exactly" apart from "something else is at this path" without a separate marker per note.
 * `original`'s unmanaged keys (`otherKeys`/`raw`) are carried through unchanged, in their
 * original position, the same way agents.mjs preserves an agent file's hooks or permissionMode.
 */
export function renderNoteFile(note, original = null) {
  const eol = original?.eol || '\n';
  const line = (k, v) => {
    if (v === null || v === undefined || v === '') return null;
    if (k === 'tags') return Array.isArray(v) && v.length ? `tags: [${v.map((t) => yamlString(String(t))).join(', ')}]` : null;
    if (k === 'favorite') return v ? 'favorite: true' : null;
    if (k === 'aiExcluded') return v ? 'aiExcluded: true' : null;
    if (k === 'created' || k === 'updated' || k === 'sentAt' || k === 'deletedAt') return `${k}: ${Number(v)}`;
    return `${k}: ${yamlString(String(v))}`;
  };
  const rendered = Object.fromEntries(MANAGED_KEYS.map((k) => [k, line(k, note[k])]));
  const out = [];
  const done = new Set();
  let lastManaged = -1;
  for (const k of MANAGED_KEYS) {
    if (done.has(k)) continue;
    done.add(k);
    if (rendered[k] !== null) { out.push(rendered[k]); lastManaged = out.length - 1; }
  }
  if (original) {
    const extra = original.otherKeys.filter((k) => !MANAGED_KEYS.includes(k));
    const insertion = extra.flatMap((k) => original.raw.get(k) || []);
    out.splice(lastManaged + 1, 0, ...insertion);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  const body = String(note.body ?? '').replace(/\r\n?/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '');
  return ['---', ...out, '---', '', ...body.split('\n'), ''].join(eol);
}

// ------------------------------------------------------------------ paths

const within = (child, parent) => {
  const a = path.resolve(child).toLowerCase();
  const b = path.resolve(parent).toLowerCase();
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
};

export function knowledgePaths(userDir) {
  const root = path.join(userDir, 'knowledge');
  return {
    root,
    notesDir: path.join(root, 'notes'),
    trashDir: path.join(root, 'trash'),
    overwrittenDir: path.join(root, 'overwritten'),
    legacyFile: path.join(userDir, 'notes.json'),
    backupFile: path.join(userDir, 'notes.json.pre-knowledge-backup'),
    marker: path.join(root, '.migration-complete'),
  };
}

/** A note's intended file path, or null for an id that cannot safely become one. */
function fileFor(notesDir, id) {
  if (typeof id !== 'string' || !ID.test(id) || WINDOWS_DEVICE.test(id)) return null;
  const full = path.join(notesDir, `${id}.md`);
  return within(full, notesDir) ? full : null;
}

// ------------------------------------------------------------------ the store (read side)

/**
 * Every note file under `<userDir>/knowledge/notes`, read independently - a file this module
 * cannot read (a permission error, for instance) or cannot parse never affects any other file.
 * `fsImpl` is injectable so a permission failure can be simulated deterministically in a test,
 * without depending on how any one OS happens to enforce file permissions.
 */
export function listKnowledgeNotes(userDir, { fsImpl = fs } = {}) {
  const { notesDir } = knowledgePaths(userDir);
  let names;
  try { names = fsImpl.readdirSync(notesDir).filter((n) => /\.md$/i.test(n)); }
  catch (e) { return { ok: e?.code === 'ENOENT', notes: [], error: e?.code === 'ENOENT' ? null : `Could not read the notes folder: ${e?.code || e?.message || e}` }; }

  const out = [];
  for (const name of names.sort()) {
    const full = path.join(notesDir, name);
    const fallbackId = name.replace(/\.md$/i, '');
    let stat;
    try { stat = fsImpl.statSync(full); } catch (e) { out.push({ id: fallbackId, file: name, readable: false, error: `Could not read this file: ${e?.code || e?.message || e}` }); continue; }
    if (!stat.isFile()) continue;
    let text;
    try { text = fsImpl.readFileSync(full, 'utf8'); } catch (e) { out.push({ id: fallbackId, file: name, readable: false, error: `Could not read this file: ${e?.code || e?.message || e}` }); continue; }
    const p = parseNoteFile(text, { fallbackId });
    const idMismatch = p.fields.id !== fallbackId;
    out.push({
      id: p.fields.id || fallbackId, file: name, readable: true,
      title: p.fields.title, created: p.fields.created, updated: p.fields.updated, tags: p.fields.tags,
      favorite: p.fields.favorite, folder: p.fields.folder, project: p.fields.project, session: p.fields.session,
      branch: p.fields.branch, sentAt: p.fields.sentAt, aiExcluded: p.fields.aiExcluded, body: p.body,
      corrupt: p.problems.length > 0, problems: p.problems,
      idMismatch, otherKeys: p.otherKeys, modified: stat.mtimeMs, size: stat.size,
    });
  }
  return { ok: true, notes: out.sort((a, b) => (b.updated || 0) - (a.updated || 0)), error: null };
}

/** One note by its id (the front matter's, not necessarily the filename - see idMismatch above). */
export function readKnowledgeNote(userDir, id, { fsImpl = fs } = {}) {
  const { notes } = listKnowledgeNotes(userDir, { fsImpl });
  return notes.find((n) => n.id === id) || null;
}

// ------------------------------------------------------------------ the store (write side)

/**
 * Write one note file atomically: a temp file in the same folder, then a rename - so a crash
 * mid-write leaves the previous file (or none) exactly as it was, never a half-written one.
 * Verifies the write by reading it back, since this is the guarantee migration's idempotency
 * depends on. Never overwrites a file whose current content differs from what would be
 * written, unless `force` is explicitly passed - the caller decides that, this function never
 * assumes it.
 */
export function writeKnowledgeNote(userDir, note, { force = false, fsImpl = fs } = {}) {
  const { notesDir } = knowledgePaths(userDir);
  const target = fileFor(notesDir, note.id);
  if (!target) return { ok: false, error: `"${note.id}" is not a usable note id.` };
  try { fsImpl.mkdirSync(notesDir, { recursive: true }); }
  catch (e) { return { ok: false, error: `The notes folder could not be made: ${e?.code || e?.message || e}` }; }

  const rendered = renderNoteFile(note, note.original || null);
  let existing = null;
  try { existing = fsImpl.readFileSync(target, 'utf8'); } catch { /* nothing there yet */ }
  if (existing !== null) {
    if (existing === rendered) return { ok: true, unchanged: true, file: path.basename(target) };
    if (!force) return { ok: false, conflict: true, error: `${path.basename(target)} already exists with different content.` };
  }

  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fsImpl.writeFileSync(tmp, rendered);
    fsImpl.renameSync(tmp, target);
  } catch (e) {
    try { fsImpl.rmSync?.(tmp, { force: true }); } catch { /* best effort */ }
    return { ok: false, error: `Could not write ${path.basename(target)}: ${e?.code || e?.message || e}` };
  }
  let back;
  try { back = fsImpl.readFileSync(target, 'utf8'); } catch (e) { return { ok: false, error: `Written, but could not be read back to verify: ${e?.code || e?.message || e}` }; }
  if (back !== rendered) return { ok: false, error: `${path.basename(target)} was written but does not match what was sent - not trusted.` };
  return { ok: true, unchanged: false, file: path.basename(target) };
}

// ------------------------------------------------------------------ migration

/**
 * Migrate the legacy `notes.json` (src/notes.mjs's single-file store) into the new
 * one-file-per-note layout, leaving notes.json exactly where it is and exactly as it was.
 *
 * Safe to call any number of times, including after a crash or a kill mid-run: every note's
 * presence and exact content at its target path is re-checked each time, so work already done
 * is never repeated and work not yet done (or that failed last time) is simply retried. A
 * verified backup copy of notes.json is made before anything else, and is never overwritten
 * once it exists. Nothing destructive ever happens to the legacy file - this function only
 * ever reads it and copies it, never writes to or renames it.
 *
 * Returns `{ ok, reason?, migrated, skipped, conflicts, errors, total }`. `ok` is true only
 * when every legacy note ended the run either freshly migrated or already-migrated-and-
 * verified, with zero conflicts and zero errors - the `.migration-complete` marker (a fast
 * path only, never load-bearing for correctness) is written only then.
 */
export function migrateFromLegacy(userDir, { fsImpl = fs, now = () => Date.now() } = {}) {
  void now;
  const { notesDir, legacyFile, backupFile, marker, root } = knowledgePaths(userDir);
  const result = { ok: false, reason: null, migrated: 0, skipped: 0, conflicts: [], errors: [], total: 0, warning: null };

  let legacyExists = false;
  try { legacyExists = fsImpl.existsSync(legacyFile); } catch (e) { result.reason = `Could not look for notes.json: ${e?.code || e?.message || e}`; result.errors.push(result.reason); return result; }
  if (!legacyExists) {
    try { fsImpl.mkdirSync(notesDir, { recursive: true }); fsImpl.writeFileSync(marker, JSON.stringify({ at: Date.now(), reason: 'no-legacy-file', schema: SCHEMA_VERSION }, null, 2)); }
    catch { /* nothing to migrate either way; the marker is only a fast path */ }
    return { ...result, ok: true, reason: 'no-legacy-file' };
  }

  // 1. A verified backup, made once, never overwritten, and never substituted for the real
  //    file: if the copy does not come back byte-identical, nothing else in this function
  //    runs - an unverified "backup" is worse than none, because it would be trusted later.
  let backupExists = false;
  try { backupExists = fsImpl.existsSync(backupFile); } catch { /* treated as not existing */ }
  if (!backupExists) {
    let legacyBytes;
    try { legacyBytes = fsImpl.readFileSync(legacyFile); }
    catch (e) { result.reason = `notes.json could not be read, so nothing was migrated: ${e?.code || e?.message || e}`; result.errors.push(result.reason); return result; }
    try {
      fsImpl.mkdirSync(path.dirname(backupFile), { recursive: true });
      fsImpl.writeFileSync(backupFile, legacyBytes);
      const readBack = fsImpl.readFileSync(backupFile);
      if (Buffer.compare(Buffer.from(readBack), Buffer.from(legacyBytes)) !== 0) throw new Error('backup did not verify');
      // The backup is of the file's real bytes regardless of whether they parse - a corrupt
      // notes.json is still backed up faithfully. Only the migration step below needs valid
      // JSON; say plainly when there was none, rather than a silent "0 notes migrated."
      try { JSON.parse(legacyBytes.toString('utf8')); } catch { result.warning = 'notes.json is not valid JSON, so there was nothing in it to migrate. A verified backup of it was still made, exactly as it was.'; }
    } catch (e) {
      try { fsImpl.rmSync?.(backupFile, { force: true }); } catch { /* best effort cleanup */ }
      result.reason = `A verified backup of notes.json could not be made, so nothing was migrated: ${e?.code || e?.message || e}`;
      result.errors.push(result.reason);
      return result;
    }
  }

  // 2. Read the legacy notes through NoteStore - the exact, already-tested reader notes.mjs
  //    itself uses, so a corrupt or partially unreadable notes.json is handled exactly as the
  //    live app already handles it (never thrown, never half-trusted), not reinterpreted here.
  //    (knowledgePaths() builds legacyFile as <userDir>/notes.json, so this is the same file.)
  let legacyNotes;
  try { legacyNotes = new NoteStore(userDir).list(); }
  catch (e) { result.reason = `notes.json could not be read safely, so nothing was migrated: ${e?.code || e?.message || e}`; result.errors.push(result.reason); return result; }
  result.total = legacyNotes.length;

  try { fsImpl.mkdirSync(notesDir, { recursive: true }); }
  catch (e) { result.reason = `The knowledge folder could not be made, so nothing was migrated: ${e?.code || e?.message || e}`; result.errors.push(result.reason); return result; }

  // 3. Each note, independently - one failing never stops the rest.
  const seenIds = new Set();
  for (const legacy of legacyNotes) {
    if (seenIds.has(legacy.id)) { result.conflicts.push({ id: legacy.id, reason: 'duplicate id in notes.json - only the first copy was considered' }); continue; }
    seenIds.add(legacy.id);
    const note = {
      id: legacy.id, title: null, created: legacy.created, updated: legacy.updated, tags: [], favorite: false,
      folder: null, project: null, session: null, branch: null, sentAt: legacy.sentAt, body: legacy.text,
    };
    const r = writeKnowledgeNote(userDir, note, { fsImpl });
    if (r.ok && r.unchanged) result.skipped += 1;
    else if (r.ok) result.migrated += 1;
    else if (r.conflict) result.conflicts.push({ id: legacy.id, reason: r.error });
    else result.errors.push(`${legacy.id}: ${r.error}`);
  }

  result.ok = result.conflicts.length === 0 && result.errors.length === 0 && (result.migrated + result.skipped) === result.total;
  if (result.ok) {
    try { fsImpl.mkdirSync(root, { recursive: true }); fsImpl.writeFileSync(marker, JSON.stringify({ at: Date.now(), migrated: result.migrated, total: result.total, schema: SCHEMA_VERSION }, null, 2)); }
    catch { /* the migration itself still succeeded; the marker is only a fast path for next time */ }
  }
  return result;
}

/** notes.mjs's own parsing (corrupt-file and junk-entry handling included), pointed at one exact file rather than a folder. */
function readLegacyNotesFrom(fsImpl, file) {
  let raw = null;
  try { raw = JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch { return []; }
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.notes) ? raw.notes : [];
  return arr
    .filter((n) => n && typeof n.id === 'string' && typeof n.text === 'string')
    .map((n) => ({ id: n.id, text: String(n.text ?? ''), created: Number(n.created) || 0, updated: Number(n.updated) || Number(n.created) || 0, sentAt: Number(n.sentAt) || null }))
    .sort((a, b) => b.updated - a.updated);
}

/** Has migration already run to completion? A fast path only - migrateFromLegacy is safe to call regardless. */
export function migrationComplete(userDir, { fsImpl = fs } = {}) {
  try { return fsImpl.existsSync(knowledgePaths(userDir).marker); } catch { return false; }
}

// Decision 4 (Phase 0 review): Version History never auto-prunes - a rushed pruning policy
// risks real data loss, where unbounded growth is only a visible, reversible nuisance. These
// thresholds back a size/count WARNING only, surfaced to the user; nothing here ever deletes
// a snapshot. Chosen generously (a personal notebook's worth of history, not a hard limit).
export const HISTORY_WARN_COUNT = 300;
export const HISTORY_WARN_BYTES = 25_000_000; // 25 MB

/**
 * How much Version History ("knowledge/overwritten") is actually using on disk - a read-only
 * count and byte total, never a trigger to remove anything. `warn` is true once either
 * threshold above is passed, so the UI can say "this is getting large" without this function
 * (or anything else) ever pruning on its own.
 */
export function historyStats(userDir, { fsImpl = fs } = {}) {
  const { overwrittenDir } = knowledgePaths(userDir);
  let names = [];
  try { names = fsImpl.readdirSync(overwrittenDir).filter((n) => /\.md$/i.test(n)); } catch { /* no history yet */ }
  let bytes = 0;
  for (const name of names) {
    try { bytes += fsImpl.statSync(path.join(overwrittenDir, name)).size; } catch { /* a file that vanished mid-count is simply not counted - not fatal */ }
  }
  const count = names.length;
  return { count, bytes, warn: count > HISTORY_WARN_COUNT || bytes > HISTORY_WARN_BYTES };
}

/**
 * Phase 23D: what migrateFromLegacy *would* do, without doing any of it - read-only, so an
 * "Import from Notes" screen can show an accurate count before anyone presses the button.
 * Runs the exact same per-note comparison migrateFromLegacy itself uses (a byte-identical
 * render means "already imported"; anything else already there is a conflict, never silently
 * counted as either), so the preview can never promise something the real import would not
 * also do - including the case this phase was specifically asked to guard: a note imported
 * earlier, then edited inside Knowledge, now differs from what notes.json would produce - that
 * counts as a conflict here too, not a silent overwrite.
 */
export function previewMigration(userDir, { fsImpl = fs } = {}) {
  const { notesDir, legacyFile } = knowledgePaths(userDir);
  const out = { legacyExists: false, corrupted: false, total: 0, invalid: 0, eligible: 0, alreadyImported: 0, conflicts: [], destination: notesDir };

  let legacyExists = false;
  try { legacyExists = fsImpl.existsSync(legacyFile); } catch { /* treated as not existing */ }
  out.legacyExists = legacyExists;
  if (!legacyExists) return out;

  let rawCount = 0;
  try {
    const raw = JSON.parse(fsImpl.readFileSync(legacyFile, 'utf8'));
    rawCount = (Array.isArray(raw) ? raw : Array.isArray(raw?.notes) ? raw.notes : []).length;
  } catch { out.corrupted = true; }

  let legacyNotes;
  try { legacyNotes = new NoteStore(userDir).list(); } catch { legacyNotes = []; }
  out.total = legacyNotes.length;
  out.invalid = Math.max(0, rawCount - legacyNotes.length);

  const seenIds = new Set();
  for (const legacy of legacyNotes) {
    if (seenIds.has(legacy.id)) { out.conflicts.push({ id: legacy.id, reason: 'duplicate id in notes.json - only the first copy would be considered' }); continue; }
    seenIds.add(legacy.id);
    const note = {
      id: legacy.id, title: null, created: legacy.created, updated: legacy.updated, tags: [], favorite: false,
      folder: null, project: null, session: null, branch: null, sentAt: legacy.sentAt, body: legacy.text,
    };
    const target = fileFor(notesDir, legacy.id);
    let existingText = null;
    try { existingText = fsImpl.readFileSync(target, 'utf8'); } catch { /* not imported yet */ }
    if (existingText == null) { out.eligible += 1; continue; }
    if (existingText === renderNoteFile(note)) out.alreadyImported += 1;
    else out.conflicts.push({ id: legacy.id, reason: 'already in Knowledge with different content - edited there since the last import, or placed by hand' });
  }
  return out;
}

// ------------------------------------------------------------------ Phase 23C: editor IPC surface
//
// Everything below is still electron-free and still takes userDir from its caller, same as
// the rest of this file (see the Phase 23B header above) - only main.mjs, which does know
// about Electron and about where the user's data folder lives, is new to this phase. The storage
// primitives above (parseNoteFile/renderNoteFile/writeKnowledgeNote/listKnowledgeNotes) are
// untouched; this section only adds what an editor needs on top of them: input validation
// that never trusts the renderer, and optimistic-concurrency saves.

const MAX_BODY = 2_000_000;  // characters - generous for a note, small enough a mistaken paste cannot wedge things
const MAX_TITLE = 300;
const MAX_FOLDER = 200;
const MAX_TAGS = 50;
const MAX_TAG_LEN = 60;

/** A clean tag list: strings only, trimmed, deduplicated, capped in count and length. Never throws - anything that is not a usable tag is simply dropped, not rejected. */
export function sanitizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  for (const t of tags) {
    if (typeof t !== 'string') continue;
    const s = t.trim();
    if (!s || s.length > MAX_TAG_LEN || out.includes(s)) continue;
    out.push(s);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/**
 * What the renderer is allowed to send for a note's editable fields - title, body, tags,
 * favorite, folder. Never trusts shape or size: a wrong type is coerced to its empty value
 * (never thrown), and a body over MAX_BODY is refused outright rather than silently
 * truncated, so a save never quietly drops the second half of what was typed.
 */
export function validateNoteInput(input) {
  if (!input || typeof input !== 'object') return { ok: false, error: 'No note data was sent.' };
  const body = typeof input.body === 'string' ? input.body : '';
  if (body.length > MAX_BODY) return { ok: false, error: `This note is too long to save (over ${MAX_BODY.toLocaleString()} characters).` };
  const title = typeof input.title === 'string' ? input.title.trim().slice(0, MAX_TITLE) : '';
  const folder = typeof input.folder === 'string' ? input.folder.trim().slice(0, MAX_FOLDER) : '';
  return { ok: true, value: { title: title || null, body, tags: sanitizeTags(input.tags), favorite: input.favorite === true, folder: folder || null, aiExcluded: input.aiExcluded === true } };
}

const hashText = (text) => createHash('sha256').update(text).digest('hex');

/** A note's current content hash - what an editor compares its own `baseRevision` against before trusting a save. Null means the file does not exist (a brand-new note, or one deleted since it was opened). */
export function noteRevision(userDir, id, { fsImpl = fs } = {}) {
  const { notesDir } = knowledgePaths(userDir);
  const target = fileFor(notesDir, id);
  if (!target) return null;
  try { return hashText(fsImpl.readFileSync(target, 'utf8')); } catch { return null; }
}

/**
 * Phase 23D, Part 3: a recovery copy of a note's current content, taken just before an
 * explicit "overwrite anyway" is about to replace it. Not shown anywhere in the app yet (there
 * is no browser for it) - it exists so that bypassing the normal stale-save protection is
 * still never truly destructive: the version about to be lost is on disk, verified, under
 * `knowledge/overwritten/<id>.<when>.md`, before the real file is touched at all.
 */
export function snapshotBeforeOverwrite(userDir, id, { fsImpl = fs, now = () => Date.now() } = {}) {
  const { notesDir, overwrittenDir } = knowledgePaths(userDir);
  const source = fileFor(notesDir, id);
  if (!source) return { ok: false, error: `"${id}" is not a usable note id.` };
  let text = null;
  try { text = fsImpl.readFileSync(source, 'utf8'); } catch { return { ok: true, skipped: true }; }
  try { fsImpl.mkdirSync(overwrittenDir, { recursive: true }); }
  catch (e) { return { ok: false, error: `Could not prepare the recovery folder: ${e?.code || e?.message || e}` }; }
  // Two snapshots of the same note landing in the same millisecond (now that an ordinary
  // meaningful save snapshots too, not only a rare explicit conflict-overwrite, saves in quick
  // succession are a real possibility) must never collide on this filename - a second one
  // silently overwriting the first would quietly discard a version this exact mechanism exists
  // to keep. `when` is bumped forward one at a time until it names a file that does not exist
  // yet - still exactly `<id>.<digits>.md`, so listSnapshots' SNAPSHOT_FILE pattern and every
  // other reader of that name need no change at all.
  let when = now();
  let name = `${id}.${when}.md`;
  let dest = path.join(overwrittenDir, name);
  if (!within(dest, overwrittenDir)) return { ok: false, error: `"${id}" is not a usable note id.` };
  while (true) {
    let exists = false;
    try { exists = fsImpl.existsSync(dest); } catch { exists = false; }
    if (!exists) break;
    when += 1;
    name = `${id}.${when}.md`;
    dest = path.join(overwrittenDir, name);
  }
  // A temp file, then a rename, the same as every other write in this file - so a crash mid-
  // write can never leave a half-written, corrupt snapshot sitting under its real name; the
  // rename either lands it whole or not at all, and the tmp file is cleaned up either way.
  const tmp = `${dest}.${process.pid}.${now()}.tmp`;
  try {
    fsImpl.writeFileSync(tmp, text);
    fsImpl.renameSync(tmp, dest);
    const back = fsImpl.readFileSync(dest, 'utf8');
    if (back !== text) throw new Error('the recovery copy did not verify');
  } catch (e) {
    try { fsImpl.rmSync?.(tmp, { force: true }); } catch { /* best effort cleanup */ }
    try { fsImpl.rmSync?.(dest, { force: true }); } catch { /* best effort cleanup */ }
    return { ok: false, error: `Could not save a recovery copy before overwriting: ${e?.code || e?.message || e}` };
  }
  return { ok: true, file: name };
}

/**
 * Save an edit to one note - new or existing - with optimistic concurrency. `baseRevision`
 * must be the revision this edit actually started from (null for a note that does not exist
 * yet, from this editor's point of view); if the file on disk has moved on since then - a
 * second window, a second save that landed first - the save is refused as `stale` rather
 * than silently overwriting whatever is there now. The caller decides what happens next:
 * reload and retry, or call again with `force: true` to explicitly overwrite - saveKnowledgeNote
 * itself never guesses which one is wanted.
 *
 * `patch` carries only the fields an editor can change (title, body, tags, favorite, folder);
 * everything else already in the file - unknown front-matter keys, `created`, `project`,
 * `session`, `branch`, `sentAt` - is read back off the existing file and carried through
 * untouched, the same preservation writeKnowledgeNote/renderNoteFile already give agents.mjs's
 * own files. A failed write (writeKnowledgeNote's own atomic-rename guarantee) leaves whatever
 * was already on disk exactly as it was - this function adds no write path of its own.
 */
export function saveKnowledgeNote(userDir, id, patch, { baseRevision = null, force = false, fsImpl = fs, now = () => Date.now() } = {}) {
  const { notesDir } = knowledgePaths(userDir);
  const target = fileFor(notesDir, id);
  if (!target) return { ok: false, error: `"${id}" is not a usable note id.` };

  let existingText = null;
  try { existingText = fsImpl.readFileSync(target, 'utf8'); } catch { /* no file yet: a new note */ }
  const currentRevision = existingText == null ? null : hashText(existingText);
  const isStale = baseRevision !== currentRevision;

  if (!force && isStale) {
    return {
      ok: false,
      stale: true,
      error: currentRevision == null
        ? 'This note was deleted since you opened it.'
        : baseRevision == null
          ? 'A note with this id already exists.'
          : 'This note was changed elsewhere since you opened it. Reload it to see the latest version before saving over it.',
      currentRevision,
    };
  }

  const original = existingText != null ? parseNoteFile(existingText, { fallbackId: id }) : null;

  // A previous version is worth keeping exactly when the user-editable fields it carries
  // actually differ from what is about to be written - not when only `updated`'s timestamp
  // would change (every save touches that), and never for a brand-new note (there is nothing
  // yet to keep). The body side of the comparison is normalized the same way renderNoteFile
  // normalizes it before writing, so a save that only changes line endings or trailing
  // whitespace - not real content - is not treated as a meaningful change either.
  const normalizeBody = (b) => String(b ?? '').replace(/\r\n?/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '');
  const tagsEqual = (a, b) => { const x = Array.isArray(a) ? a : []; const y = Array.isArray(b) ? b : []; return x.length === y.length && x.every((t, i) => t === y[i]); };
  const meaningfullyChanged = original != null && (
    (patch.title ?? null) !== (original.fields.title ?? null)
    || normalizeBody(patch.body) !== normalizeBody(original.body)
    || !tagsEqual(patch.tags, original.fields.tags)
    || (patch.favorite === true) !== (original.fields.favorite === true)
    || (patch.folder ?? null) !== (original.fields.folder ?? null)
    || (patch.aiExcluded === true) !== (original.fields.aiExcluded === true)
  );

  // Two reasons to keep a recovery copy of what is on disk right now, before it is replaced:
  // an explicit "overwrite anyway" past a conflicting revision (always, regardless of whether
  // the content it is about to lose happens to differ - it may be someone else's work), or an
  // ordinary save that meaningfully changes the note. Either way this is the same snapshot
  // mechanism Phase 23D's conflict recovery already proved - a write failure here refuses the
  // save outright (see the `!snap.ok` return below) rather than letting the previous version be
  // silently discarded.
  let overwrote = null;
  if (existingText != null && currentRevision != null && ((force && isStale) || meaningfullyChanged)) {
    const snap = snapshotBeforeOverwrite(userDir, id, { fsImpl, now });
    if (!snap.ok) return { ok: false, error: `The version being replaced could not be safely backed up, so nothing was overwritten: ${snap.error}` };
    if (!snap.skipped) overwrote = { revision: currentRevision, snapshot: snap.file || null };
  }
  const note = {
    id,
    title: patch.title ?? null,
    created: original?.fields.created ?? now(),
    updated: now(),
    tags: Array.isArray(patch.tags) ? patch.tags : [],
    favorite: patch.favorite === true,
    folder: patch.folder ?? null,
    aiExcluded: patch.aiExcluded === true,
    project: original?.fields.project ?? null,
    session: original?.fields.session ?? null,
    branch: original?.fields.branch ?? null,
    sentAt: original?.fields.sentAt ?? null,
    body: typeof patch.body === 'string' ? patch.body : '',
    original,
  };
  const r = writeKnowledgeNote(userDir, note, { force: true, fsImpl });
  if (!r.ok) return r;
  const { original: _original, ...saved } = note;
  return { ok: true, unchanged: r.unchanged, file: r.file, note: saved, revision: noteRevision(userDir, id, { fsImpl }), overwrote };
}

/**
 * Phase 1 (Unified Notes): stamp that a note reached Telegram - cosmetic, best-effort, the
 * same spirit as notes.mjs's own markSent: a failure here is never worth failing the send
 * itself (the caller already knows the send succeeded by the time this runs), so it reports
 * ok:false rather than throwing and never touches `updated` (not a real edit) or triggers a
 * Version History snapshot (nothing about the note's own content changed).
 */
export function markKnowledgeNoteSent(userDir, id, at, { fsImpl = fs } = {}) {
  const { notesDir } = knowledgePaths(userDir);
  const target = fileFor(notesDir, id);
  if (!target) return { ok: false };
  let text;
  try { text = fsImpl.readFileSync(target, 'utf8'); } catch { return { ok: false }; }
  const p = parseNoteFile(text, { fallbackId: id });
  const note = {
    id, title: p.fields.title, created: p.fields.created, updated: p.fields.updated, tags: p.fields.tags,
    favorite: p.fields.favorite, folder: p.fields.folder, project: p.fields.project, session: p.fields.session,
    branch: p.fields.branch, sentAt: at, aiExcluded: p.fields.aiExcluded, body: p.body,
  };
  const rendered = renderNoteFile(note, p);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fsImpl.writeFileSync(tmp, rendered);
    fsImpl.renameSync(tmp, target);
  } catch {
    try { fsImpl.rmSync?.(tmp, { force: true }); } catch { /* best effort cleanup */ }
    return { ok: false };
  }
  return { ok: true };
}

// ------------------------------------------------------------------ Phase 23D: Trash and restore
//
// Deleting a note moves its file from notes/ to trash/ - the content, the id and every field
// are exactly what they were; nothing is rewritten except one field (deletedAt), and that is
// written and verified while the file is still safely in notes/, before it ever moves. The
// move itself is a single rename within the same knowledge/ folder (same volume, so it is
// atomic at the OS level: a crash mid-move leaves the file fully in one place or the other,
// never half-moved or duplicated) and is itself verified by reading the file back afterwards.
// There is no automatic emptying or expiry in this phase - a note stays in Trash until it is
// restored, by hand, for as long as the app exists.

/** Every note currently in Trash, newest-deleted first. Same shape as listKnowledgeNotes, plus `deletedAt`. */
export function listTrash(userDir, { fsImpl = fs } = {}) {
  const { trashDir } = knowledgePaths(userDir);
  let names;
  try { names = fsImpl.readdirSync(trashDir).filter((n) => /\.md$/i.test(n)); }
  catch (e) { return { ok: e?.code === 'ENOENT', notes: [], error: e?.code === 'ENOENT' ? null : `Could not read Trash: ${e?.code || e?.message || e}` }; }

  const out = [];
  for (const name of names.sort()) {
    const full = path.join(trashDir, name);
    const fallbackId = name.replace(/\.md$/i, '');
    let text;
    try { text = fsImpl.readFileSync(full, 'utf8'); }
    catch (e) { out.push({ id: fallbackId, file: name, readable: false, error: `Could not read this file: ${e?.code || e?.message || e}` }); continue; }
    const p = parseNoteFile(text, { fallbackId });
    out.push({
      id: p.fields.id || fallbackId, file: name, readable: true,
      title: p.fields.title, created: p.fields.created, updated: p.fields.updated, tags: p.fields.tags,
      favorite: p.fields.favorite, body: p.body, deletedAt: p.fields.deletedAt,
      corrupt: p.problems.length > 0, problems: p.problems,
    });
  }
  return { ok: true, notes: out.sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0)), error: null };
}

/**
 * Move a note to Trash - never a permanent delete. Revision-checked the same way a save is:
 * `baseRevision` must match the note's current content, so an editor holding a stale, already-
 * superseded view of a note can never delete the newer version out from under whoever wrote
 * it. A note already gone (already deleted, or never existed) is reported plainly, not thrown.
 */
export function deleteKnowledgeNote(userDir, id, { baseRevision = null, fsImpl = fs, now = () => Date.now() } = {}) {
  const { notesDir, trashDir } = knowledgePaths(userDir);
  const source = fileFor(notesDir, id);
  if (!source) return { ok: false, error: `"${id}" is not a usable note id.` };

  let existingText = null;
  try { existingText = fsImpl.readFileSync(source, 'utf8'); } catch { /* already gone */ }
  if (existingText == null) return { ok: false, error: 'That note is already gone.' };
  const currentRevision = hashText(existingText);
  if (baseRevision !== currentRevision) {
    return { ok: false, stale: true, error: 'This note was changed elsewhere since you opened it. Reload it to see the latest version before deleting it.', currentRevision };
  }

  // Move first, stamp second - in that order on purpose. A rename is the one step here that
  // cannot partly happen (the OS either moves the whole file or none of it), so doing it
  // before anything else means a failure at this point leaves the live note completely
  // untouched - not moved, not mutated, not re-revisioned. Only once the note is already
  // safe in Trash does this stamp deletedAt onto it there; if THAT step fails, the note is
  // still exactly as safe (recoverable, not lost, not duplicated) - it is only missing a
  // "deleted X ago" label, reported as a warning rather than a failure.
  try { fsImpl.mkdirSync(trashDir, { recursive: true }); }
  catch (e) { return { ok: false, error: `The Trash folder could not be made: ${e?.code || e?.message || e}` }; }
  const dest = fileFor(trashDir, id);
  if (!dest) return { ok: false, error: `"${id}" is not a usable note id.` };
  let destExisting = null;
  try { destExisting = fsImpl.readFileSync(dest, 'utf8'); } catch { /* trash slot is free */ }
  if (destExisting != null) return { ok: false, error: 'A deleted note with this id is already in Trash - empty or restore it first, then try again.' };

  try { fsImpl.renameSync(source, dest); }
  catch (e) { return { ok: false, error: `Could not move this note to Trash: ${e?.code || e?.message || e}` }; }
  let moved;
  try { moved = fsImpl.readFileSync(dest, 'utf8'); } catch (e) { return { ok: false, error: `Moved to Trash, but could not be read back to verify: ${e?.code || e?.message || e}` }; }
  if (moved !== existingText) return { ok: false, error: 'The note in Trash does not match what was deleted - not trusted.' };

  const deletedAt = now();
  const original = parseNoteFile(moved, { fallbackId: id });
  const note = {
    id, title: original.fields.title, created: original.fields.created, updated: original.fields.updated,
    tags: original.fields.tags, favorite: original.fields.favorite, folder: original.fields.folder,
    project: original.fields.project, session: original.fields.session, branch: original.fields.branch,
    sentAt: original.fields.sentAt, aiExcluded: original.fields.aiExcluded, deletedAt, body: original.body, original,
  };
  const rendered = renderNoteFile(note, original);
  const tmp = `${dest}.${process.pid}.${deletedAt}.tmp`;
  try {
    fsImpl.writeFileSync(tmp, rendered);
    fsImpl.renameSync(tmp, dest);
    const back = fsImpl.readFileSync(dest, 'utf8');
    if (back !== rendered) throw new Error('the deletion timestamp did not verify');
  } catch (e) {
    try { fsImpl.rmSync?.(tmp, { force: true }); } catch { /* best effort cleanup */ }
    return { ok: true, deletedAt: null, warning: `Moved to Trash, but its "deleted" timestamp could not be recorded: ${e?.code || e?.message || e}` };
  }
  return { ok: true, deletedAt };
}

/**
 * Move a note back out of Trash. Refuses, rather than overwrites, if a note with this id
 * already exists outside Trash (restoring twice, or an id reused some other way) - the
 * live note is never touched, and the Trash copy is left exactly where it was so nothing
 * is lost either way.
 */
export function restoreKnowledgeNote(userDir, id, { fsImpl = fs } = {}) {
  const { notesDir, trashDir } = knowledgePaths(userDir);
  const source = fileFor(trashDir, id);
  if (!source) return { ok: false, error: `"${id}" is not a usable note id.` };
  let text = null;
  try { text = fsImpl.readFileSync(source, 'utf8'); } catch { /* not there */ }
  if (text == null) return { ok: false, error: 'That note is not in Trash.' };

  const dest = fileFor(notesDir, id);
  let liveExisting = null;
  try { liveExisting = fsImpl.readFileSync(dest, 'utf8'); } catch { /* the usual case: nothing live with this id */ }
  if (liveExisting != null) {
    return { ok: false, conflict: true, error: 'A note with this id already exists outside Trash - restoring would overwrite it, so nothing was moved.' };
  }

  try { fsImpl.mkdirSync(notesDir, { recursive: true }); fsImpl.renameSync(source, dest); }
  catch (e) { return { ok: false, error: `Could not restore this note: ${e?.code || e?.message || e}` }; }
  let back;
  try { back = fsImpl.readFileSync(dest, 'utf8'); } catch (e) { return { ok: false, error: `Restored, but could not be read back to verify: ${e?.code || e?.message || e}` }; }
  if (back !== text) return { ok: false, error: 'The restored note does not match what was in Trash - not trusted.' };
  const p = parseNoteFile(text, { fallbackId: id });
  return { ok: true, note: { id: p.fields.id || id, title: p.fields.title, tags: p.fields.tags, favorite: p.fields.favorite, aiExcluded: p.fields.aiExcluded }, revision: noteRevision(userDir, id, { fsImpl }) };
}

// ------------------------------------------------------------------ Phase 23E: version history
//
// Snapshots already exist (snapshotBeforeOverwrite, Phase 23D Part 3) - this phase only makes
// them reachable: list a note's own snapshots, read one to preview or compare, and restore one
// as the current version. A snapshot's name (`<id>.<when>.md`) carries its own id, so a
// snapshot can never be listed, read or restored under the wrong note - fileFor's own id
// shape check plus `within()` keep it inside knowledge/overwritten the same way every other
// path in this file is kept inside its own folder.

const SNAPSHOT_FILE = /^([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.(\d+)\.md$/;

/** The real, contained path for one snapshot, or null if `file` does not name a snapshot of
 *  this exact note - never any other note's, and never anything outside the folder. */
function snapshotPath(overwrittenDir, id, file) {
  const m = SNAPSHOT_FILE.exec(String(file || ''));
  if (!m || m[1] !== id || !ID.test(id)) return null;
  const full = path.join(overwrittenDir, file);
  return within(full, overwrittenDir) ? full : null;
}

/** Every snapshot on file for one note, newest first - a damaged or missing snapshot is
 *  reported in its own row (`readable: false`), never dropped silently and never fatal to
 *  the rest of the list. */
export function listSnapshots(userDir, id, { fsImpl = fs } = {}) {
  const { overwrittenDir } = knowledgePaths(userDir);
  if (!ID.test(String(id || ''))) return { ok: false, error: `"${id}" is not a usable note id.`, snapshots: [] };
  let names;
  try { names = fsImpl.readdirSync(overwrittenDir); }
  catch (e) { return { ok: e?.code === 'ENOENT', snapshots: [], error: e?.code === 'ENOENT' ? null : `Could not read the version history folder: ${e?.code || e?.message || e}` }; }

  const mine = names.filter((name) => { const m = SNAPSHOT_FILE.exec(name); return m && m[1] === id; });
  const out = [];
  for (const name of mine.sort()) {
    const when = Number(SNAPSHOT_FILE.exec(name)[2]);
    const full = path.join(overwrittenDir, name);
    let text;
    try { text = fsImpl.readFileSync(full, 'utf8'); }
    catch (e) { out.push({ file: name, when, readable: false, error: `Could not read this version: ${e?.code === 'ENOENT' ? 'it is missing from disk.' : (e?.code || e?.message || e)}` }); continue; }
    const p = parseNoteFile(text, { fallbackId: id });
    out.push({
      file: name, when, readable: true, title: p.fields.title, tags: p.fields.tags, favorite: p.fields.favorite,
      body: p.body, corrupt: p.problems.length > 0, problems: p.problems,
    });
  }
  return { ok: true, snapshots: out.sort((a, b) => b.when - a.when), error: null };
}

/** One snapshot's full content, for a preview or a side-by-side compare before restoring it. */
export function readSnapshot(userDir, id, file, { fsImpl = fs } = {}) {
  const { overwrittenDir } = knowledgePaths(userDir);
  const full = snapshotPath(overwrittenDir, id, file);
  if (!full) return { ok: false, error: 'That is not a usable version reference.' };
  let text;
  try { text = fsImpl.readFileSync(full, 'utf8'); }
  catch (e) { return { ok: false, error: e?.code === 'ENOENT' ? 'That version is no longer on disk - it may have been removed by hand.' : `Could not read that version: ${e?.code || e?.message || e}` }; }
  const p = parseNoteFile(text, { fallbackId: id });
  return {
    ok: true,
    snapshot: {
      file, when: Number(SNAPSHOT_FILE.exec(file)[2]), title: p.fields.title, tags: p.fields.tags,
      favorite: p.fields.favorite, body: p.body, corrupt: p.problems.length > 0,
    },
  };
}

/**
 * Restore a note to one of its own previous, overwritten versions - itself revision-checked
 * exactly like a save (a stale editor, one that opened Version History before someone else's
 * newer edit landed, is refused rather than clobbering that edit), and itself preserving what
 * it is about to replace: the current version is snapshotted first (snapshotBeforeOverwrite),
 * the same safety net an explicit "Overwrite anyway" save already gets - so restoring an old
 * version is never a one-way trip either, and every earlier snapshot is still exactly where
 * it was (nothing here ever deletes one). The restore itself is the same atomic temp-file-
 * then-rename, verified by reading back, every other write in this file already uses.
 */
export function restoreSnapshot(userDir, id, file, { baseRevision = null, fsImpl = fs, now = () => Date.now() } = {}) {
  const { notesDir, overwrittenDir } = knowledgePaths(userDir);
  const target = fileFor(notesDir, id);
  if (!target) return { ok: false, error: `"${id}" is not a usable note id.` };
  const snapPath = snapshotPath(overwrittenDir, id, file);
  if (!snapPath) return { ok: false, error: 'That is not a usable version reference.' };

  let snapText;
  try { snapText = fsImpl.readFileSync(snapPath, 'utf8'); }
  catch (e) { return { ok: false, error: e?.code === 'ENOENT' ? 'That version is no longer available - it may have been removed from disk by hand.' : `Could not read that version: ${e?.code || e?.message || e}` }; }

  let currentText = null;
  try { currentText = fsImpl.readFileSync(target, 'utf8'); } catch { /* the note itself may be gone (deleted, trashed) since Version History was opened */ }
  const currentRevision = currentText == null ? null : hashText(currentText);
  if (baseRevision !== currentRevision) {
    return {
      ok: false,
      stale: true,
      error: currentRevision == null
        ? 'This note was deleted since you opened Version History.'
        : 'This note was changed elsewhere since you opened Version History. Reload it to see the latest version before restoring an older one.',
      currentRevision,
    };
  }

  if (currentText != null) {
    const snap = snapshotBeforeOverwrite(userDir, id, { fsImpl, now });
    if (!snap.ok) return { ok: false, error: `The current version could not be safely backed up, so nothing was restored: ${snap.error}` };
  }

  const tmp = `${target}.${process.pid}.${now()}.tmp`;
  try {
    fsImpl.writeFileSync(tmp, snapText);
    fsImpl.renameSync(tmp, target);
  } catch (e) {
    try { fsImpl.rmSync?.(tmp, { force: true }); } catch { /* best effort cleanup */ }
    return { ok: false, error: `Could not restore this version: ${e?.code || e?.message || e}` };
  }
  let back;
  try { back = fsImpl.readFileSync(target, 'utf8'); } catch (e) { return { ok: false, error: `Restored, but could not be read back to verify: ${e?.code || e?.message || e}` }; }
  if (back !== snapText) return { ok: false, error: 'The restored note does not match the chosen version - not trusted.' };

  const p = parseNoteFile(snapText, { fallbackId: id });
  return {
    ok: true,
    note: {
      id, title: p.fields.title, created: p.fields.created, updated: p.fields.updated, tags: p.fields.tags,
      favorite: p.fields.favorite, folder: p.fields.folder, sentAt: p.fields.sentAt, aiExcluded: p.fields.aiExcluded, body: p.body,
    },
    revision: noteRevision(userDir, id, { fsImpl }),
  };
}
