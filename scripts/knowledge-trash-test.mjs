// JARVIS Knowledge - Phase 23D: Import preview/import (Part 1), Trash and Restore (Part 2),
// and the overwrite-recovery snapshot (Part 3) - all at the engine level, in src/knowledge.mjs.
// Temp folders only; a synthetic notes.json fixture stands in for real Notes data - nothing
// here reads or writes anything under a real %APPDATA%\JARVIS. The renderer-level flows
// (two-step overwrite confirm, Trash tab, Import dialog, draft preservation) are covered
// separately by scripts/knowledge-renderer-test.mjs.
//   node scripts/knowledge-trash-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  newId, knowledgePaths, writeKnowledgeNote, listKnowledgeNotes, saveKnowledgeNote, noteRevision,
  previewMigration, migrateFromLegacy, migrationComplete, listTrash, deleteKnowledgeNote,
  restoreKnowledgeNote, snapshotBeforeOverwrite,
} from '../src/knowledge.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${extra ? `\n     ${extra}` : ''}`); } };
const check = (name, fn) => { try { fn(); ok(true, name); } catch (e) { ok(false, name, String(e?.stack || e).split('\n').slice(0, 6).join('\n     ')); } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-knowledge-trash-'));
let n = 0;
const dir = () => { const d = path.join(TMP, `d${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
const legacy = (d, notesArr) => fs.writeFileSync(path.join(d, 'notes.json'), JSON.stringify(notesArr));
const legacyNote = (over = {}) => ({ id: `n${Math.random().toString(36).slice(2, 8)}`, text: 'hello', created: 1000, updated: 2000, sentAt: null, ...over });

// ================================================================== PART 1: Import preview + import

check('an empty workspace (no notes.json at all) previews as nothing to import, not an error', () => {
  const d = dir();
  const p = previewMigration(d);
  assert.equal(p.legacyExists, false);
  assert.equal(p.total, 0);
  assert.equal(p.eligible, 0);
  assert.deepEqual(p.conflicts, []);
});

check('import preview accuracy: total, eligible, already imported and the destination, before anything is imported', () => {
  const d = dir();
  const a = legacyNote({ id: 'alpha', text: 'Alpha note' });
  const b = legacyNote({ id: 'beta', text: 'Beta note' });
  legacy(d, [a, b]);
  const p = previewMigration(d);
  assert.equal(p.legacyExists, true);
  assert.equal(p.total, 2);
  assert.equal(p.eligible, 2);
  assert.equal(p.alreadyImported, 0);
  assert.deepEqual(p.conflicts, []);
  assert.equal(p.invalid, 0);
  assert.equal(p.destination, knowledgePaths(d).notesDir);
});

check('after a real import, the preview reflects it: nothing left eligible, everything already imported', () => {
  const d = dir();
  legacy(d, [legacyNote({ id: 'alpha' }), legacyNote({ id: 'beta' })]);
  const r = migrateFromLegacy(d);
  assert.equal(r.ok, true);
  assert.equal(r.migrated, 2);
  const p = previewMigration(d);
  assert.equal(p.eligible, 0);
  assert.equal(p.alreadyImported, 2);
  assert.deepEqual(p.conflicts, []);
});

check('running the import again never creates duplicates - the second run migrates nothing new', () => {
  const d = dir();
  legacy(d, [legacyNote({ id: 'alpha' }), legacyNote({ id: 'beta' })]);
  migrateFromLegacy(d);
  const names1 = fs.readdirSync(knowledgePaths(d).notesDir);
  const r2 = migrateFromLegacy(d);
  assert.equal(r2.ok, true);
  assert.equal(r2.migrated, 0);
  assert.equal(r2.skipped, 2);
  const names2 = fs.readdirSync(knowledgePaths(d).notesDir);
  assert.deepEqual(names1.sort(), names2.sort());
  assert.equal(names2.length, 2);
});

check('an interrupted import (one write fails) leaves the rest done, and a retry finishes only what is left - preview proves it both times', () => {
  const d = dir();
  legacy(d, [legacyNote({ id: 'alpha' }), legacyNote({ id: 'beta' }), legacyNote({ id: 'gamma' })]);
  let fail1 = true;
  const real = fs;
  const flaky = { ...real, renameSync: (from, to) => { if (fail1 && String(to).includes('beta')) { fail1 = false; const e = new Error('simulated crash'); e.code = 'EIO'; throw e; } return real.renameSync(from, to); } };
  const r1 = migrateFromLegacy(d, { fsImpl: flaky });
  assert.equal(r1.ok, false, 'beta failed, so this run as a whole is not ok');
  assert.equal(r1.migrated, 2, 'alpha and gamma still landed');
  assert.ok(r1.errors.some((e) => e.includes('beta')));
  const mid = previewMigration(d);
  assert.equal(mid.eligible, 1, 'only beta is still outstanding');
  assert.equal(mid.alreadyImported, 2);

  const r2 = migrateFromLegacy(d); // a normal retry, real fs
  assert.equal(r2.ok, true);
  assert.equal(r2.migrated, 1, 'only beta needed finishing');
  assert.equal(r2.skipped, 2);
  const done = previewMigration(d);
  assert.equal(done.eligible, 0);
  assert.equal(done.alreadyImported, 3);
});

check('invalid entries in notes.json (missing id or text) are counted separately from valid, un-imported ones', () => {
  const d = dir();
  fs.writeFileSync(path.join(d, 'notes.json'), JSON.stringify([legacyNote({ id: 'alpha' }), { nope: 1 }, 'junk', { id: 'no-text' }]));
  const p = previewMigration(d);
  assert.equal(p.total, 1, 'only alpha has both an id and text');
  assert.equal(p.invalid, 3);
  assert.equal(p.eligible, 1);
  assert.equal(p.corrupted, false);
});

check('corrupted notes.json (not valid JSON at all) previews as corrupted, not as "0 invalid" or a throw - and a real import still makes a verified backup', () => {
  const d = dir();
  fs.writeFileSync(path.join(d, 'notes.json'), '{ not json at all');
  const p = previewMigration(d);
  assert.equal(p.corrupted, true);
  assert.equal(p.total, 0);
  const r = migrateFromLegacy(d);
  assert.equal(r.ok, true);
  assert.match(r.warning, /not valid JSON/);
  assert.ok(fs.existsSync(knowledgePaths(d).backupFile));
  assert.equal(fs.readFileSync(knowledgePaths(d).backupFile, 'utf8'), '{ not json at all', 'the backup is a byte-exact copy, corrupt or not');
});

check('import conflicts: a note imported earlier, then edited inside Knowledge, previews and imports as a conflict - never silently overwritten', () => {
  const d = dir();
  legacy(d, [legacyNote({ id: 'alpha', text: 'Original from Notes' })]);
  migrateFromLegacy(d);
  // Edit it inside Knowledge, the same way the editor's own save would.
  const rev = noteRevision(d, 'alpha');
  const edited = saveKnowledgeNote(d, 'alpha', { title: 'Edited in Knowledge', body: 'Changed here, not in Notes', tags: [], favorite: false, folder: null }, { baseRevision: rev });
  assert.equal(edited.ok, true);

  const p = previewMigration(d);
  assert.equal(p.eligible, 0);
  assert.equal(p.alreadyImported, 0);
  assert.equal(p.conflicts.length, 1);
  assert.equal(p.conflicts[0].id, 'alpha');

  const r = migrateFromLegacy(d); // re-running the import must not clobber the Knowledge edit
  assert.equal(r.ok, false);
  assert.equal(r.conflicts.length, 1);
  const stillThere = listKnowledgeNotes(d).notes.find((x) => x.id === 'alpha');
  assert.equal(stillThere.title, 'Edited in Knowledge', 'the Knowledge edit survives a re-run of the import untouched');
  assert.equal(stillThere.body, 'Changed here, not in Notes');
});

check('a notes.json edited again after the first import (same id, new text there) also previews and imports as a conflict, not a silent re-import', () => {
  const d = dir();
  legacy(d, [legacyNote({ id: 'alpha', text: 'v1', updated: 1000 })]);
  migrateFromLegacy(d);
  legacy(d, [legacyNote({ id: 'alpha', text: 'v2 - edited in Notes after import', updated: 2000 })]);
  const p = previewMigration(d);
  assert.equal(p.conflicts.length, 1);
  const r = migrateFromLegacy(d);
  assert.equal(r.conflicts.length, 1);
  assert.equal(listKnowledgeNotes(d).notes.find((x) => x.id === 'alpha').body, 'v1', 'Knowledge keeps what it already imported, not notes.json\'s newer text');
});

check('migrateFromLegacy never touches notes.json itself, across all of the above - size and bytes unchanged', () => {
  const d = dir();
  const raw = JSON.stringify([legacyNote({ id: 'alpha' })]);
  fs.writeFileSync(path.join(d, 'notes.json'), raw);
  migrateFromLegacy(d);
  migrateFromLegacy(d);
  previewMigration(d);
  assert.equal(fs.readFileSync(path.join(d, 'notes.json'), 'utf8'), raw);
});

// ================================================================== PART 2: Trash and Restore

check('deleting a note moves it to Trash - it disappears from the live list and appears in Trash, with its content intact', () => {
  const d = dir();
  const id = newId();
  writeKnowledgeNote(d, { id, title: 'Keep me', created: 1, updated: 1, tags: ['x'], favorite: true, body: 'content' });
  const rev = noteRevision(d, id);
  const r = deleteKnowledgeNote(d, id, { baseRevision: rev });
  assert.equal(r.ok, true);
  assert.equal(listKnowledgeNotes(d).notes.some((x) => x.id === id), false);
  const trashed = listTrash(d).notes.find((x) => x.id === id);
  assert.ok(trashed);
  assert.equal(trashed.title, 'Keep me');
  assert.equal(trashed.body, 'content');
  assert.deepEqual(trashed.tags, ['x']);
  assert.equal(trashed.favorite, true);
  assert.ok(trashed.deletedAt > 0);
});

check('restoring brings a note back exactly - id, content, tags and favorite all preserved', () => {
  const d = dir();
  const id = newId();
  writeKnowledgeNote(d, { id, title: 'Restore me', created: 1, updated: 1, tags: ['a', 'b'], favorite: true, body: 'body text' });
  deleteKnowledgeNote(d, id, { baseRevision: noteRevision(d, id) });
  const r = restoreKnowledgeNote(d, id);
  assert.equal(r.ok, true);
  const back = listKnowledgeNotes(d).notes.find((x) => x.id === id);
  assert.ok(back);
  assert.equal(back.title, 'Restore me');
  assert.equal(back.body, 'body text');
  assert.deepEqual(back.tags, ['a', 'b']);
  assert.equal(back.favorite, true);
  assert.equal(listTrash(d).notes.some((x) => x.id === id), false, 'it is gone from Trash once restored');
});

check('stale-delete rejection: deleting from a revision that is no longer current is refused, and nothing moves', () => {
  const d = dir();
  const id = newId();
  writeKnowledgeNote(d, { id, title: 'T', created: 1, updated: 1, tags: [], favorite: false, body: 'v1' });
  const oldRev = noteRevision(d, id);
  saveKnowledgeNote(d, id, { title: 'T', body: 'v2 - someone else\'s edit', tags: [], favorite: false, folder: null }, { baseRevision: oldRev });
  const r = deleteKnowledgeNote(d, id, { baseRevision: oldRev }); // a stale editor, still holding v1's revision
  assert.equal(r.ok, false);
  assert.equal(r.stale, true);
  assert.equal(listKnowledgeNotes(d).notes.find((x) => x.id === id).body, 'v2 - someone else\'s edit', 'the newer version is untouched');
  assert.equal(listTrash(d).notes.length, 0, 'nothing was moved to Trash');
});

check('restore conflicts: a live note already exists with this id (restoring twice, or any other reuse) - refused, neither copy is touched', () => {
  const d = dir();
  const id = newId();
  writeKnowledgeNote(d, { id, title: 'Original', created: 1, updated: 1, tags: [], favorite: false, body: 'original' });
  deleteKnowledgeNote(d, id, { baseRevision: noteRevision(d, id) });
  // Something new now lives at the same id outside Trash (synthetic for the test - ids are
  // UUIDs in practice, so a real collision like this would be exceptionally rare).
  writeKnowledgeNote(d, { id, title: 'A different note, same id', created: 2, updated: 2, tags: [], favorite: false, body: 'replacement' });
  const r = restoreKnowledgeNote(d, id);
  assert.equal(r.ok, false);
  assert.equal(r.conflict, true);
  assert.equal(listKnowledgeNotes(d).notes.find((x) => x.id === id).body, 'replacement', 'the live note was not overwritten');
  assert.equal(listTrash(d).notes.find((x) => x.id === id).body, 'original', 'the Trash copy is still there too - nothing was lost either way');
});

check('deleting an already-gone note is refused plainly, not thrown', () => {
  const d = dir();
  const r = deleteKnowledgeNote(d, newId(), { baseRevision: null });
  assert.equal(r.ok, false);
  assert.match(r.error, /already gone/);
});

check('restoring a note that is not in Trash is refused plainly', () => {
  const d = dir();
  const r = restoreKnowledgeNote(d, newId());
  assert.equal(r.ok, false);
  assert.match(r.error, /not in Trash/);
});

check('an interrupted move to Trash (the rename fails) leaves the live note completely untouched - the move happens before anything else, so a failure here has no side effect at all', () => {
  const d = dir();
  const id = newId();
  writeKnowledgeNote(d, { id, title: 'T', created: 1, updated: 1, tags: [], favorite: false, body: 'v1' });
  const rev = noteRevision(d, id);
  const flaky = { ...fs, renameSync: () => { const e = new Error('disk error'); e.code = 'EIO'; throw e; } };
  const r = deleteKnowledgeNote(d, id, { baseRevision: rev, fsImpl: flaky });
  assert.equal(r.ok, false);
  assert.equal(listTrash(d, { fsImpl: flaky }).notes.length, 0);
  assert.ok(listKnowledgeNotes(d).notes.some((x) => x.id === id), 'the note is still live - a failed move never loses it');
  assert.equal(noteRevision(d, id), rev, 'not even the revision changed - nothing was written before the move was attempted');
});

check('delete-ordering fix: if the move succeeds but stamping "deleted at" afterward fails, the note is still safely in Trash - never left live with a changed revision, and never lost', () => {
  const d = dir();
  const id = newId();
  writeKnowledgeNote(d, { id, title: 'T', created: 1, updated: 1, tags: [], favorite: false, body: 'v1' });
  const rev = noteRevision(d, id);
  const flaky = { ...fs, writeFileSync: (p, data) => { if (String(p).includes('.tmp')) { const e = new Error('disk full'); throw e; } return fs.writeFileSync(p, data); } };
  const r = deleteKnowledgeNote(d, id, { baseRevision: rev, fsImpl: flaky });
  assert.equal(r.ok, true, 'the delete as a whole still succeeds - the note did move');
  assert.equal(r.deletedAt, null, 'but the timestamp could not be recorded, and says so rather than lying about it');
  assert.ok(r.warning);
  assert.equal(listKnowledgeNotes(d, { fsImpl: flaky }).notes.some((x) => x.id === id), false, 'gone from the live list');
  const trashed = listTrash(d, { fsImpl: flaky }).notes.find((x) => x.id === id);
  assert.ok(trashed, 'safely in Trash');
  assert.equal(trashed.body, 'v1', 'its content is exactly what was deleted');
  assert.equal(trashed.deletedAt, null, 'deletedAt is simply absent, not a wrong guess');
  // No leftover .tmp file either - the same atomic-write cleanup every other write in this file already does.
  assert.deepEqual(fs.readdirSync(knowledgePaths(d).trashDir).filter((f) => f.includes('.tmp')), []);
});

// ================================================================== PART 3: overwrite recovery

check('overwrite confirmation and recovery: forcing a save past a stale revision backs up what it replaces, and the backup is readable and exact', () => {
  const d = dir();
  const id = newId();
  const v1 = saveKnowledgeNote(d, id, { title: 'T', body: 'version one', tags: [], favorite: false, folder: null }, { baseRevision: null });
  const v2 = saveKnowledgeNote(d, id, { title: 'T', body: 'version two', tags: [], favorite: false, folder: null }, { baseRevision: v1.revision });
  const forced = saveKnowledgeNote(d, id, { title: 'T', body: 'version three, forced', tags: [], favorite: false, folder: null }, { baseRevision: v1.revision, force: true });
  assert.equal(forced.ok, true);
  assert.ok(forced.overwrote, 'the response says an overwrite happened');
  assert.equal(forced.overwrote.revision, v2.revision, 'it records exactly which revision was replaced');
  const snapFile = path.join(knowledgePaths(d).overwrittenDir, forced.overwrote.snapshot);
  assert.ok(fs.existsSync(snapFile));
  assert.match(fs.readFileSync(snapFile, 'utf8'), /version two/, 'the version that was about to be lost is recoverable');
  assert.equal(listKnowledgeNotes(d).notes.find((x) => x.id === id).body, 'version three, forced');
});

check('the very first save of a brand-new note never makes a snapshot - there is nothing yet to back up', () => {
  const d = dir();
  const id = newId();
  const v1 = saveKnowledgeNote(d, id, { title: 'T', body: 'v1', tags: [], favorite: false, folder: null }, { baseRevision: null });
  assert.equal(v1.overwrote, null);
  assert.equal(fs.existsSync(knowledgePaths(d).overwrittenDir), false, 'nothing was ever backed up - nothing was ever actually overwritten');
});

check('a normal, non-conflicting save that meaningfully changes an existing note backs up the version it replaces (Version History on ordinary edits)', () => {
  const d = dir();
  const id = newId();
  const v1 = saveKnowledgeNote(d, id, { title: 'T', body: 'v1', tags: [], favorite: false, folder: null }, { baseRevision: null });
  const v2 = saveKnowledgeNote(d, id, { title: 'T', body: 'v2', tags: [], favorite: false, folder: null }, { baseRevision: v1.revision });
  assert.ok(v2.overwrote, 'this is not a conflict override - it is an ordinary, correctly-based save - but it still preserves v1');
  const snapFile = path.join(knowledgePaths(d).overwrittenDir, v2.overwrote.snapshot);
  assert.match(fs.readFileSync(snapFile, 'utf8'), /v1/, 'v1 is recoverable through Version History');
});

check('a normal, non-conflicting re-save with no actual change makes no snapshot', () => {
  const d = dir();
  const id = newId();
  const v1 = saveKnowledgeNote(d, id, { title: 'T', body: 'v1', tags: [], favorite: false, folder: null }, { baseRevision: null });
  const v2 = saveKnowledgeNote(d, id, { title: 'T', body: 'v1', tags: [], favorite: false, folder: null }, { baseRevision: v1.revision });
  assert.equal(v2.overwrote, null);
  assert.equal(fs.existsSync(knowledgePaths(d).overwrittenDir), false, 'nothing meaningfully changed, so nothing was backed up');
});

check('if the recovery snapshot cannot be written, the overwrite itself is refused - never destructive without a working safety net', () => {
  const d = dir();
  const id = newId();
  const v1 = saveKnowledgeNote(d, id, { title: 'T', body: 'v1', tags: [], favorite: false, folder: null }, { baseRevision: null });
  saveKnowledgeNote(d, id, { title: 'T', body: 'v2', tags: [], favorite: false, folder: null }, { baseRevision: v1.revision });
  const flaky = { ...fs, writeFileSync: (p, data) => { if (String(p).includes('overwritten')) throw new Error('disk full'); return fs.writeFileSync(p, data); } };
  const r = saveKnowledgeNote(d, id, { title: 'T', body: 'v3 attempted', tags: [], favorite: false, folder: null }, { baseRevision: v1.revision, force: true, fsImpl: flaky });
  assert.equal(r.ok, false);
  assert.equal(listKnowledgeNotes(d, { fsImpl: flaky }).notes.find((x) => x.id === id).body, 'v2', 'v2 is untouched - the overwrite never happened');
});

check('snapshotBeforeOverwrite on a note that does not exist yet is a no-op, not an error - there is nothing to protect', () => {
  const d = dir();
  const r = snapshotBeforeOverwrite(d, newId());
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
});

check('snapshotBeforeOverwrite itself writes through a temp file then a rename, like every other write in this module - a crash mid-write never leaves a half-written snapshot under its real name', () => {
  const d = dir();
  const id = newId();
  writeKnowledgeNote(d, { id, title: 'T', created: 1, updated: 1, tags: [], favorite: false, body: 'protect me' });
  const flaky = { ...fs, renameSync: () => { const e = new Error('simulated crash'); e.code = 'EIO'; throw e; } };
  const r = snapshotBeforeOverwrite(d, id, { fsImpl: flaky });
  assert.equal(r.ok, false);
  const names = fs.readdirSync(knowledgePaths(d).overwrittenDir);
  assert.deepEqual(names, [], 'no leftover .tmp file, and nothing under the real snapshot name either');
});

console.log(`\nknowledge-trash-test: ${pass} passed, ${fail} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exitCode = fail ? 1 : 0;
