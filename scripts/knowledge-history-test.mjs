// JARVIS Knowledge - Phase 23E: Version History at the engine level (src/knowledge.mjs) -
// listSnapshots, readSnapshot, restoreSnapshot. Temp folders only; nothing here reads or
// writes anything under a real %APPDATA%\JARVIS. The renderer-level flow (opening the
// dialog, comparing, the two-step restore confirm) is covered separately by
// scripts/knowledge-renderer-test.mjs; the IPC wiring by scripts/knowledge-ipc-test.mjs.
//   node scripts/knowledge-history-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  newId, knowledgePaths, writeKnowledgeNote, listKnowledgeNotes, saveKnowledgeNote, noteRevision,
  listSnapshots, readSnapshot, restoreSnapshot,
} from '../src/knowledge.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${extra ? `\n     ${extra}` : ''}`); } };
const check = (name, fn) => { try { fn(); ok(true, name); } catch (e) { ok(false, name, String(e?.stack || e).split('\n').slice(0, 6).join('\n     ')); } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-knowledge-history-'));
let n = 0;
const dir = () => { const d = path.join(TMP, `d${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };

/** Three real versions of one note. v1 -> v2 is an ordinary meaningful save (snapshots v1);
 *  v2 -> v3 forces past v1's now-stale revision while v2 is actually current (snapshots v2) -
 *  so this leaves two snapshots on disk: v1 ("version one") and v2 ("version two"). */
function threeVersions(d) {
  const id = newId();
  const v1 = saveKnowledgeNote(d, id, { title: 'T', body: 'version one', tags: ['a'], favorite: false, folder: null }, { baseRevision: null });
  const v2raw = saveKnowledgeNote(d, id, { title: 'T', body: 'version two', tags: ['a'], favorite: false, folder: null }, { baseRevision: v1.revision });
  const v3 = saveKnowledgeNote(d, id, { title: 'T', body: 'version three', tags: ['a', 'b'], favorite: true, folder: null }, { baseRevision: v1.revision, force: true }); // forces past v1 while v2 is current - v2 is snapshotted
  return { id, v1, v2: v2raw, v3 };
}

// ================================================================== listing and preview

check('a note with no overwrite yet has no version history - an empty list, not an error', () => {
  const d = dir();
  const id = newId();
  writeKnowledgeNote(d, { id, title: 'T', created: 1, updated: 1, tags: [], favorite: false, body: 'only version' });
  const r = listSnapshots(d, id);
  assert.equal(r.ok, true);
  assert.deepEqual(r.snapshots, []);
});

check('snapshot listing and preview: newest first, each with its own timestamp and readable content', () => {
  const d = dir();
  const { id } = threeVersions(d);
  const r = listSnapshots(d, id);
  assert.equal(r.ok, true);
  assert.equal(r.snapshots.length, 2, 'the ordinary v1->v2 save and the forced v2->v3 overwrite each made one snapshot');
  const s = r.snapshots[0];
  assert.equal(s.readable, true);
  assert.equal(s.body, 'version two', 'newest first - the forced overwrite (of v2) happened after the ordinary save (of v1)');
  assert.ok(s.when > 0);
  assert.equal(r.snapshots[1].body, 'version one');

  const one = readSnapshot(d, id, s.file);
  assert.equal(one.ok, true);
  assert.equal(one.snapshot.body, 'version two');
  assert.equal(one.snapshot.when, s.when);
});

check('several overwrites of the same note build up several snapshots, each exactly what it replaced', () => {
  const d = dir();
  const id = newId();
  const a = saveKnowledgeNote(d, id, { title: 'T', body: 'a1', tags: [], favorite: false, folder: null }, { baseRevision: null });
  const a2 = saveKnowledgeNote(d, id, { title: 'T', body: 'a2', tags: [], favorite: false, folder: null }, { baseRevision: a.revision }); // ordinary meaningful save - snapshots a1
  // Both of these force past a1's (now stale) revision while a different version is actually
  // current - each one backs up whatever it is about to replace, so two more snapshots.
  const forced1 = saveKnowledgeNote(d, id, { title: 'T', body: 'a3 (forced past a1)', tags: [], favorite: false, folder: null }, { baseRevision: a.revision, force: true });
  const forced2 = saveKnowledgeNote(d, id, { title: 'T', body: 'a4 (forced past a1 again)', tags: [], favorite: false, folder: null }, { baseRevision: a.revision, force: true });
  assert.ok(a2.overwrote && forced1.overwrote && forced2.overwrote);
  const list = listSnapshots(d, id);
  assert.equal(list.snapshots.length, 3);
  assert.deepEqual(list.snapshots.map((s) => s.body).sort(), ['a1', 'a2', 'a3 (forced past a1)'].sort());
});

// ================================================================== restoring

check('restoring a previous version replaces the current one, preserving id and the version\'s own metadata', () => {
  const d = dir();
  const { id, v2 } = threeVersions(d);
  const snap = listSnapshots(d, id).snapshots[0];
  const before = noteRevision(d, id);
  const r = restoreSnapshot(d, id, snap.file, { baseRevision: before });
  assert.equal(r.ok, true);
  assert.equal(r.note.id, id);
  assert.equal(r.note.body, 'version two');
  assert.deepEqual(r.note.tags, ['a']);
  assert.equal(r.note.favorite, false);
  const live = listKnowledgeNotes(d).notes.find((x) => x.id === id);
  assert.equal(live.body, 'version two');
  void v2;
});

check('preserving the current version before restoration: restoring makes a brand-new snapshot of what it replaced', () => {
  const d = dir();
  const { id } = threeVersions(d);
  const before = listSnapshots(d, id).snapshots.length;
  const currentRev = noteRevision(d, id);
  const target = listSnapshots(d, id).snapshots[0];
  restoreSnapshot(d, id, target.file, { baseRevision: currentRev });
  const after = listSnapshots(d, id);
  assert.equal(after.snapshots.length, before + 1, 'the version that was just replaced (version three) is now itself a snapshot');
  assert.ok(after.snapshots.some((s) => s.body === 'version three'));
  assert.ok(after.snapshots.some((s) => s.body === 'version two'), 'the version just restored FROM is still there too - nothing here deletes a snapshot');
});

check('stale restoration attempts: restoring from a revision that is no longer current is refused, and nothing changes', () => {
  const d = dir();
  const { id } = threeVersions(d);
  const staleRev = noteRevision(d, id); // "current" at this moment
  const snap = listSnapshots(d, id).snapshots[0];
  // Someone else edits the note after Version History was opened but before Restore is pressed.
  saveKnowledgeNote(d, id, { title: 'T', body: 'edited elsewhere while History was open', tags: [], favorite: false, folder: null }, { baseRevision: staleRev });
  const r = restoreSnapshot(d, id, snap.file, { baseRevision: staleRev });
  assert.equal(r.ok, false);
  assert.equal(r.stale, true);
  assert.equal(listKnowledgeNotes(d).notes.find((x) => x.id === id).body, 'edited elsewhere while History was open', 'the concurrent edit is untouched');
});

check('concurrent modifications: the stale response hands back the current revision, so a retry (after reloading) can proceed', () => {
  const d = dir();
  const { id } = threeVersions(d);
  const oldRev = noteRevision(d, id);
  const snap = listSnapshots(d, id).snapshots[0];
  const elsewhere = saveKnowledgeNote(d, id, { title: 'T', body: 'concurrent edit', tags: [], favorite: false, folder: null }, { baseRevision: oldRev });
  const stale = restoreSnapshot(d, id, snap.file, { baseRevision: oldRev });
  assert.equal(stale.currentRevision, elsewhere.revision);
  const retried = restoreSnapshot(d, id, snap.file, { baseRevision: stale.currentRevision });
  assert.equal(retried.ok, true);
  assert.equal(listKnowledgeNotes(d).notes.find((x) => x.id === id).body, 'version two');
});

check('restoring a note that was deleted (moved to Trash) since Version History was opened is refused, not recreated silently', () => {
  const d = dir();
  const { id } = threeVersions(d);
  const rev = noteRevision(d, id);
  const snap = listSnapshots(d, id).snapshots[0];
  fs.rmSync(path.join(knowledgePaths(d).notesDir, `${id}.md`));
  const r = restoreSnapshot(d, id, snap.file, { baseRevision: rev });
  assert.equal(r.ok, false);
  assert.equal(r.stale, true);
  assert.match(r.error, /deleted/);
});

// ================================================================== corruption, missing files, path safety

check('snapshot corruption: a version with damaged front matter is still listed and readable - the body is recovered, not thrown away', () => {
  const d = dir();
  const { id } = threeVersions(d);
  const snap = listSnapshots(d, id).snapshots[0];
  const full = path.join(knowledgePaths(d).overwrittenDir, snap.file);
  fs.writeFileSync(full, 'not front matter at all, just text');
  const r = listSnapshots(d, id);
  assert.equal(r.snapshots[0].readable, true);
  assert.equal(r.snapshots[0].corrupt, true);
  assert.equal(r.snapshots[0].body, 'not front matter at all, just text');
});

check('missing snapshot files: one that is listed but cannot be read (deleted or permission-denied in the instant between readdir and read) is reported in its own row, never fatal to the rest of the list', () => {
  const d = dir();
  const { id, v1 } = threeVersions(d); // already has two snapshots (v1, v2)
  saveKnowledgeNote(d, id, { title: 'T', body: 'v4', tags: [], favorite: false, folder: null }, { baseRevision: v1.revision, force: true }); // v1's revision is stale now (v3 is current) - this snapshots v3
  const files = listSnapshots(d, id).snapshots.map((s) => s.file);
  assert.equal(files.length, 3);
  const flaky = { ...fs, readFileSync: (p, enc) => { if (String(p).includes(files[0])) { const e = new Error('gone'); e.code = 'ENOENT'; throw e; } return fs.readFileSync(p, enc); } };
  const r = listSnapshots(d, id, { fsImpl: flaky });
  assert.equal(r.snapshots.length, 3, 'every row is still reported');
  assert.equal(r.snapshots.find((s) => s.file === files[0]).readable, false);
  assert.equal(r.snapshots.find((s) => s.file === files[1]).readable, true);
  assert.equal(r.snapshots.find((s) => s.file === files[2]).readable, true);
});

check('reading a snapshot that was removed from disk between listing and reading is refused plainly, not thrown', () => {
  const d = dir();
  const { id } = threeVersions(d);
  const snap = listSnapshots(d, id).snapshots[0];
  fs.unlinkSync(path.join(knowledgePaths(d).overwrittenDir, snap.file));
  const r = readSnapshot(d, id, snap.file);
  assert.equal(r.ok, false);
  assert.match(r.error, /no longer/);
});

check('restoring a snapshot that was removed from disk between listing and restoring is refused plainly, not thrown', () => {
  const d = dir();
  const { id } = threeVersions(d);
  const rev = noteRevision(d, id);
  const snap = listSnapshots(d, id).snapshots[0];
  fs.unlinkSync(path.join(knowledgePaths(d).overwrittenDir, snap.file));
  const r = restoreSnapshot(d, id, snap.file, { baseRevision: rev });
  assert.equal(r.ok, false);
  assert.match(r.error, /no longer/);
  assert.equal(listKnowledgeNotes(d).notes.find((x) => x.id === id).body, 'version three', 'the current note is untouched by a failed restore');
});

check('a snapshot reference naming a DIFFERENT note\'s id is refused - never read or restored across notes', () => {
  const d = dir();
  const { id } = threeVersions(d);
  const otherId = newId();
  writeKnowledgeNote(d, { id: otherId, title: 'Other', created: 1, updated: 1, tags: [], favorite: false, body: 'unrelated note' });
  const snap = listSnapshots(d, id).snapshots[0];
  assert.equal(readSnapshot(d, otherId, snap.file).ok, false, 'reading id A\'s snapshot while claiming to be note B is refused');
  assert.equal(restoreSnapshot(d, otherId, snap.file, { baseRevision: null }).ok, false);
  assert.equal(listKnowledgeNotes(d).notes.find((x) => x.id === otherId).body, 'unrelated note', 'the unrelated note was never touched');
});

check('path safety: a directory-traversal or malformed file reference is refused outright, for list, read and restore alike', () => {
  const d = dir();
  const { id } = threeVersions(d);
  for (const bad of ['../escape.md', `${id}.md`, `${id}..123.md`, '', 'not-a-snapshot-name', `${id}.123`, `..\\..\\evil.md`]) {
    assert.equal(readSnapshot(d, id, bad).ok, false, `read refuses "${bad}"`);
    assert.equal(restoreSnapshot(d, id, bad, { baseRevision: null }).ok, false, `restore refuses "${bad}"`);
  }
});

check('listSnapshots itself refuses an unusable id rather than reading a directory with it', () => {
  const d = dir();
  for (const bad of ['../escape', 'a/b', '']) {
    const r = listSnapshots(d, bad);
    assert.equal(r.ok, false);
  }
});

// ================================================================== interrupted restore

check('interrupted restoration and recovery: if the rename fails, the current note is left exactly as it was', () => {
  const d = dir();
  const { id } = threeVersions(d);
  const rev = noteRevision(d, id);
  const snap = listSnapshots(d, id).snapshots[0];
  const flaky = { ...fs, renameSync: () => { const e = new Error('disk error'); e.code = 'EIO'; throw e; } };
  const r = restoreSnapshot(d, id, snap.file, { baseRevision: rev, fsImpl: flaky });
  assert.equal(r.ok, false);
  assert.equal(noteRevision(d, id), rev, 'the live note is untouched by the failed restore');
  assert.equal(listKnowledgeNotes(d).notes.find((x) => x.id === id).body, 'version three');
});

check('if the pre-restore backup of the current version cannot be made, the restore itself is refused - never destructive without its own safety net', () => {
  const d = dir();
  const { id } = threeVersions(d);
  const rev = noteRevision(d, id);
  const snap = listSnapshots(d, id).snapshots[0];
  const flaky = { ...fs, writeFileSync: (p, data) => { if (String(p).includes('overwritten')) throw new Error('disk full'); return fs.writeFileSync(p, data); } };
  const r = restoreSnapshot(d, id, snap.file, { baseRevision: rev, fsImpl: flaky });
  assert.equal(r.ok, false);
  assert.equal(listKnowledgeNotes(d, { fsImpl: flaky }).notes.find((x) => x.id === id).body, 'version three', 'untouched - the restore never happened without a working backup');
});

check('a retry after a failed restore succeeds normally, once whatever stopped it is gone', () => {
  const d = dir();
  const { id } = threeVersions(d);
  const rev = noteRevision(d, id);
  const snap = listSnapshots(d, id).snapshots[0];
  let fail1 = true;
  const flaky = { ...fs, renameSync: (from, to) => { if (fail1) { fail1 = false; const e = new Error('simulated crash'); e.code = 'EIO'; throw e; } return fs.renameSync(from, to); } };
  const r1 = restoreSnapshot(d, id, snap.file, { baseRevision: rev, fsImpl: flaky });
  assert.equal(r1.ok, false);
  const r2 = restoreSnapshot(d, id, snap.file, { baseRevision: rev }); // real fs this time
  assert.equal(r2.ok, true);
  assert.equal(listKnowledgeNotes(d).notes.find((x) => x.id === id).body, 'version two');
});

// ================================================================== Version History on ordinary saves

check('first save of a brand-new note creates no history - there is nothing yet to keep', () => {
  const d = dir();
  const id = newId();
  const v1 = saveKnowledgeNote(d, id, { title: 'T', body: 'hello', tags: [], favorite: false, folder: null }, { baseRevision: null });
  assert.equal(v1.ok, true);
  assert.equal(v1.overwrote, null);
  assert.deepEqual(listSnapshots(d, id).snapshots, []);
});

check('a second, meaningfully different save (no force, no stale revision) preserves version 1', () => {
  const d = dir();
  const id = newId();
  const v1 = saveKnowledgeNote(d, id, { title: 'T', body: 'version one', tags: [], favorite: false, folder: null }, { baseRevision: null });
  const v2 = saveKnowledgeNote(d, id, { title: 'T', body: 'version two', tags: [], favorite: false, folder: null }, { baseRevision: v1.revision });
  assert.equal(v2.ok, true);
  assert.ok(v2.overwrote, 'an ordinary meaningful save reports that the version it replaced was backed up');
  const snaps = listSnapshots(d, id).snapshots;
  assert.equal(snaps.length, 1);
  assert.equal(snaps[0].body, 'version one');
  assert.equal(listKnowledgeNotes(d).notes.find((x) => x.id === id).body, 'version two');
});

check('several ordinary meaningful saves in a row each produce their own distinct, recoverable version - none lost to a filename collision', () => {
  const d = dir();
  const id = newId();
  let prev = saveKnowledgeNote(d, id, { title: 'T', body: 'v1', tags: [], favorite: false, folder: null }, { baseRevision: null });
  const bodies = ['v2', 'v3', 'v4', 'v5'];
  for (const body of bodies) {
    prev = saveKnowledgeNote(d, id, { title: 'T', body, tags: [], favorite: false, folder: null }, { baseRevision: prev.revision });
    assert.equal(prev.ok, true);
  }
  const snaps = listSnapshots(d, id).snapshots;
  assert.equal(snaps.length, 4, 'v1 through v4 were each snapshotted once, replaced by the next save');
  assert.deepEqual(snaps.map((s) => s.body).sort(), ['v1', 'v2', 'v3', 'v4'].sort());
  assert.equal(new Set(snaps.map((s) => s.file)).size, 4, 'four distinct filenames - no collision silently discarded one');
  assert.equal(listKnowledgeNotes(d).notes.find((x) => x.id === id).body, 'v5');
});

check('re-saving a note with no actual change (same title, body, tags, favorite, folder) never creates a duplicate snapshot', () => {
  const d = dir();
  const id = newId();
  const v1 = saveKnowledgeNote(d, id, { title: 'T', body: 'unchanged content', tags: ['x'], favorite: true, folder: 'f' }, { baseRevision: null });
  const v2 = saveKnowledgeNote(d, id, { title: 'T', body: 'unchanged content', tags: ['x'], favorite: true, folder: 'f' }, { baseRevision: v1.revision });
  assert.equal(v2.ok, true);
  assert.equal(v2.overwrote, null, 'nothing meaningfully changed, so nothing was backed up');
  assert.deepEqual(listSnapshots(d, id).snapshots, []);
});

check('a save that only touches the generated `updated` timestamp (everything else identical) is not treated as a meaningful change', () => {
  const d = dir();
  const id = newId();
  const v1 = saveKnowledgeNote(d, id, { title: 'T', body: 'same', tags: [], favorite: false, folder: null }, { baseRevision: null, now: () => 1000 });
  const v2 = saveKnowledgeNote(d, id, { title: 'T', body: 'same', tags: [], favorite: false, folder: null }, { baseRevision: v1.revision, now: () => 2000 });
  assert.equal(v2.ok, true);
  assert.equal(v2.overwrote, null);
  assert.deepEqual(listSnapshots(d, id).snapshots, []);
});

check('a metadata-only meaningful edit (tags/favorite/folder change, body and title unchanged) still preserves the previous version', () => {
  const d = dir();
  const id = newId();
  const v1 = saveKnowledgeNote(d, id, { title: 'T', body: 'same body throughout', tags: ['a'], favorite: false, folder: null }, { baseRevision: null });
  const v2 = saveKnowledgeNote(d, id, { title: 'T', body: 'same body throughout', tags: ['a', 'b'], favorite: true, folder: 'work' }, { baseRevision: v1.revision });
  assert.equal(v2.ok, true);
  assert.ok(v2.overwrote);
  const snaps = listSnapshots(d, id).snapshots;
  assert.equal(snaps.length, 1);
  assert.deepEqual(snaps[0].tags, ['a']);
  assert.equal(snaps[0].favorite, false);
  assert.equal(snaps[0].body, 'same body throughout');
});

check('if the snapshot write fails, the save itself is refused outright - the previous version is never silently discarded', () => {
  const d = dir();
  const id = newId();
  const v1 = saveKnowledgeNote(d, id, { title: 'T', body: 'safe original', tags: [], favorite: false, folder: null }, { baseRevision: null });
  const flaky = { ...fs, writeFileSync: (p, data) => { if (String(p).includes('overwritten')) throw new Error('disk full'); return fs.writeFileSync(p, data); } };
  const v2 = saveKnowledgeNote(d, id, { title: 'T', body: 'this must not land without a backup', tags: [], favorite: false, folder: null }, { baseRevision: v1.revision, fsImpl: flaky });
  assert.equal(v2.ok, false);
  assert.match(v2.error, /backed up/);
  assert.equal(listKnowledgeNotes(d).notes.find((x) => x.id === id).body, 'safe original', 'the live note was never overwritten without a working backup');
  assert.deepEqual(listSnapshots(d, id).snapshots, [], 'no half-made snapshot was left behind either');
});

check('two meaningful saves of the same note landing in the exact same millisecond still produce two distinct, recoverable snapshots', () => {
  const d = dir();
  const id = newId();
  const frozen = () => 123456789;
  const v1 = saveKnowledgeNote(d, id, { title: 'T', body: 'frozen-v1', tags: [], favorite: false, folder: null }, { baseRevision: null, now: frozen });
  const v2 = saveKnowledgeNote(d, id, { title: 'T', body: 'frozen-v2', tags: [], favorite: false, folder: null }, { baseRevision: v1.revision, now: frozen });
  const v3 = saveKnowledgeNote(d, id, { title: 'T', body: 'frozen-v3', tags: [], favorite: false, folder: null }, { baseRevision: v2.revision, now: frozen });
  assert.equal(v2.ok, true); assert.equal(v3.ok, true);
  const snaps = listSnapshots(d, id).snapshots;
  assert.equal(snaps.length, 2);
  assert.equal(new Set(snaps.map((s) => s.file)).size, 2, 'distinct filenames despite an identical `now()` on every call');
  assert.deepEqual(snaps.map((s) => s.body).sort(), ['frozen-v1', 'frozen-v2'].sort());
});

console.log(`\nknowledge-history-test: ${pass} passed, ${fail} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exitCode = fail ? 1 : 0;
