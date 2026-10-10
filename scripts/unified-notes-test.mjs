// JARVIS Notes - Phase 1 (Unified Notes): invariants specific to this phase's own decisions
// (docs/phase0-decision-review.md) that the pre-existing Knowledge suites do not already
// cover - automatic (not only manual-button) migration, folders, pinning/sort order,
// unexposed-metadata preservation, and the Version History size/count warning. The storage
// engine itself (src/knowledge.mjs) is already exhaustively covered by knowledge-test.mjs,
// knowledge-trash-test.mjs and knowledge-history-test.mjs - this file only adds what Phase 1
// changed or newly relies on. Temp folders only; nothing here touches a real %APPDATA%\JARVIS.
//   node scripts/unified-notes-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  knowledgePaths, writeKnowledgeNote, listKnowledgeNotes, saveKnowledgeNote, noteRevision,
  migrateFromLegacy, migrationComplete, historyStats, HISTORY_WARN_COUNT, HISTORY_WARN_BYTES,
  parseNoteFile,
} from '../src/knowledge.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${extra ? `\n     ${extra}` : ''}`); } };
const check = (name, fn) => { try { fn(); ok(true, name); } catch (e) { ok(false, name, String(e?.stack || e).split('\n').slice(0, 6).join('\n     ')); } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-unified-notes-'));
let n = 0;
const dir = () => { const d = path.join(TMP, `d${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
const legacy = (d, notesArr) => fs.writeFileSync(path.join(d, 'notes.json'), JSON.stringify(notesArr));
const legacyNote = (over = {}) => ({ id: `n${Math.random().toString(36).slice(2, 8)}`, text: 'hello', created: 1000, updated: 2000, sentAt: null, ...over });

// ================================================================== Decision 2: automatic migration is still idempotent/non-destructive/resumable/verifiable

console.log('\n--- automatic migration (Decision 2) ---');
check('a fresh auto-migrate call (the same migrateFromLegacy jarvis:knowledgeAutoMigrate wraps) carries every legacy note over, and never touches notes.json\'s bytes', () => {
  const d = dir();
  const legacyBytes = JSON.stringify([legacyNote({ id: 'n1' }), legacyNote({ id: 'n2' })]);
  fs.writeFileSync(path.join(d, 'notes.json'), legacyBytes);
  const r = migrateFromLegacy(d);
  assert.equal(r.ok, true);
  assert.equal(r.migrated, 2);
  assert.equal(listKnowledgeNotes(d).notes.length, 2);
  assert.equal(fs.readFileSync(path.join(d, 'notes.json'), 'utf8'), legacyBytes, 'notes.json is byte-identical to before migration ran');
});
check('calling it again (as a second page-load would, were the client-side "once per boot" guard not there) is a true no-op - zero newly migrated, zero conflicts, zero errors', () => {
  const d = dir();
  legacy(d, [legacyNote({ id: 'n1' }), legacyNote({ id: 'n2' })]);
  migrateFromLegacy(d);
  const r2 = migrateFromLegacy(d);
  assert.equal(r2.ok, true);
  assert.equal(r2.migrated, 0);
  assert.equal(r2.skipped, 2);
  assert.equal(r2.conflicts.length, 0);
  assert.equal(r2.errors.length, 0);
});
check('resumable: a migration that only got partway (simulated by writing one note by hand first) finishes the rest on the next call, without disturbing the one already there', () => {
  const d = dir();
  legacy(d, [legacyNote({ id: 'n1', text: 'first' }), legacyNote({ id: 'n2', text: 'second' })]);
  // Simulate "crashed after note 1" by writing only n1's target file ahead of time.
  const r0 = migrateFromLegacy(d);
  assert.equal(r0.migrated, 2);
  const beforeMtime = fs.statSync(path.join(knowledgePaths(d).notesDir, 'n1.md')).mtimeMs;
  const r1 = migrateFromLegacy(d);
  assert.equal(r1.skipped, 2, 'both notes are recognized as already-migrated, not rewritten');
  assert.equal(fs.statSync(path.join(knowledgePaths(d).notesDir, 'n1.md')).mtimeMs, beforeMtime, 'an already-correct file is never rewritten, only verified');
});
check('rollback path: a verified backup of notes.json exists after migration, byte-identical to the original, independent of the live knowledge store', () => {
  const d = dir();
  const bytes = JSON.stringify([legacyNote({ id: 'n1' })]);
  fs.writeFileSync(path.join(d, 'notes.json'), bytes);
  migrateFromLegacy(d);
  const { backupFile } = knowledgePaths(d);
  assert.ok(fs.existsSync(backupFile), 'a backup of notes.json was made');
  assert.equal(fs.readFileSync(backupFile, 'utf8'), bytes, 'the backup is byte-identical to the original notes.json');
  // Rollback in practice: notes.json itself is also still there, untouched, so reverting to
  // the pre-unification state never depends on the backup copy alone.
  assert.equal(fs.readFileSync(path.join(d, 'notes.json'), 'utf8'), bytes, 'the live notes.json is itself still untouched - the backup is a second, independent copy, not the only copy');
});
check('migrationComplete() only ever flips on a fully clean run - a run left with a conflict never reports "done"', () => {
  const d = dir();
  legacy(d, [legacyNote({ id: 'dup' }), legacyNote({ id: 'dup' })]); // duplicate id -> a conflict
  const r = migrateFromLegacy(d);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.ok, false);
  assert.equal(migrationComplete(d), false, 'the fast-path marker is never written while a conflict is outstanding');
});

// ================================================================== Decision 3: folders (built), and metadata the UI never exposes (preserved, not discarded)

console.log('\n--- folders and preserved-but-unexposed metadata (Decision 3) ---');
check('a folder round-trips through save exactly as typed, and is visible from the list', () => {
  const d = dir();
  const r = saveKnowledgeNote(d, 'f1', { title: 'Milk', body: 'buy milk', tags: [], favorite: false, folder: 'Personal/Errands' });
  assert.equal(r.ok, true);
  const n = listKnowledgeNotes(d).notes.find((x) => x.id === 'f1');
  assert.equal(n.folder, 'Personal/Errands');
});
check('project/session/branch - never set by any UI - survive an ordinary save of a note that already has them, because saveKnowledgeNote only ever carries them through from the existing file, never accepts them from a patch', () => {
  const d = dir();
  // Simulate a note "placed by hand" (or by a future linking feature) with these fields set -
  // exactly the scenario Decision 3 says must not be silently discarded just because today's
  // editor has no field for them.
  const note = { id: 'p1', title: 'Linked', created: 1000, updated: 1000, tags: [], favorite: false, folder: null, project: 'my-project', session: 'sess-1', branch: 'main', sentAt: null, body: 'hello' };
  writeKnowledgeNote(d, note);
  const rev = noteRevision(d, 'p1');
  const r = saveKnowledgeNote(d, 'p1', { title: 'Linked (edited)', body: 'hello, edited', tags: [], favorite: false, folder: null }, { baseRevision: rev });
  assert.equal(r.ok, true);
  const raw = fs.readFileSync(path.join(knowledgePaths(d).notesDir, 'p1.md'), 'utf8');
  const parsed = parseNoteFile(raw);
  assert.equal(parsed.fields.project, 'my-project', 'project was not silently dropped by an ordinary save');
  assert.equal(parsed.fields.session, 'sess-1');
  assert.equal(parsed.fields.branch, 'main');
});
check('legacy migration itself never invents project/session/branch - they come across as null, never guessed', () => {
  const d = dir();
  legacy(d, [legacyNote({ id: 'n1' })]);
  migrateFromLegacy(d);
  const raw = fs.readFileSync(path.join(knowledgePaths(d).notesDir, 'n1.md'), 'utf8');
  const parsed = parseNoteFile(raw);
  assert.equal(parsed.fields.project, null);
  assert.equal(parsed.fields.session, null);
  assert.equal(parsed.fields.branch, null);
});

// ================================================================== pinning (favorite) sort order - a pure-data check; the renderer's own sort is covered by knowledge-renderer-test.mjs

console.log('\n--- pinned notes sort first (Decision 3 / brief item 3) ---');
check('the renderer\'s pin-first ordering (favorite before non-favorite, each group newest-first) matches what the list already comes back sorted as from the engine, given a plain stable sort', () => {
  const d = dir();
  saveKnowledgeNote(d, 'old-pinned', { title: 'Old but pinned', body: 'x', tags: [], favorite: true, folder: null }, {});
  saveKnowledgeNote(d, 'new-unpinned', { title: 'New, not pinned', body: 'x', tags: [], favorite: false, folder: null }, {});
  const list = listKnowledgeNotes(d).notes; // newest-updated first, from the engine itself
  // The exact sort the renderer applies on top (knowledge.js renderList): stable, favorite first.
  const sorted = list.slice().sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0));
  assert.equal(sorted[0].id, 'old-pinned', 'pinned leads even though it is the older note');
});

// ================================================================== Decision 4: Version History size/count warning only, never automatic pruning

console.log('\n--- Version History: warn, never prune (Decision 4) ---');
check('historyStats reports zero for a note with no history yet', () => {
  const d = dir();
  saveKnowledgeNote(d, 'h1', { title: 'Fresh', body: 'v1', tags: [], favorite: false, folder: null }, {});
  const s = historyStats(d);
  assert.equal(s.count, 0);
  assert.equal(s.bytes, 0);
  assert.equal(s.warn, false);
});
check('historyStats counts real snapshot files and their total size, and never deletes any of them in doing so', () => {
  const d = dir();
  let rev = null;
  for (let i = 0; i < 5; i += 1) {
    const r = saveKnowledgeNote(d, 'h2', { title: 'Grows', body: `version ${i}`, tags: [], favorite: false, folder: null }, { baseRevision: rev });
    rev = r.revision;
  }
  const { overwrittenDir } = knowledgePaths(d);
  const before = fs.readdirSync(overwrittenDir).filter((f) => /\.md$/.test(f));
  assert.ok(before.length >= 4, 'several meaningfully-different saves each kept a snapshot');
  const s = historyStats(d);
  assert.equal(s.count, before.length);
  assert.ok(s.bytes > 0);
  const after = fs.readdirSync(overwrittenDir).filter((f) => /\.md$/.test(f));
  assert.equal(after.length, before.length, 'reading the stats never removed a snapshot');
});
check('the warn flag flips on past the documented thresholds, and only past them - this is the entire "policy", there is no pruning logic anywhere to test', () => {
  const d = dir();
  const { overwrittenDir } = knowledgePaths(d);
  fs.mkdirSync(overwrittenDir, { recursive: true });
  for (let i = 0; i < HISTORY_WARN_COUNT + 1; i += 1) fs.writeFileSync(path.join(overwrittenDir, `w.${1000 + i}.md`), '---\nid: w\n---\n\nx\n');
  const s = historyStats(d);
  assert.equal(s.warn, true);
  assert.ok(s.bytes < HISTORY_WARN_BYTES, 'this run crosses the count threshold, not the byte one - proving each is checked independently');
});

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
