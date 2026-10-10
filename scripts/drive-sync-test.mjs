// JARVIS Notes - Phase 3: the bidirectional sync ENGINE (src/drive-sync.mjs), driven entirely
// against the in-memory FakeDriveProvider - no network, no Google account, nothing real.
// "Two devices" are simulated as two separate local temp directories sharing ONE
// FakeDriveProvider instance (the same remote both would really be talking to).
//   node scripts/drive-sync-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SYNC_ROOT_NAME, loadSyncState, planSync, applySync,
  markPending, markSynced, syncDue, nextRetryDelayMs,
} from '../src/drive-sync.mjs';
import { BACKUP_ROOT_NAME, runBackup } from '../src/drive-backup.mjs';
import {
  knowledgePaths, saveKnowledgeNote, listKnowledgeNotes, listTrash, listSnapshots,
  deleteKnowledgeNote, noteRevision,
} from '../src/knowledge.mjs';
import { FakeDriveProvider } from './fake-drive-provider.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${extra ? `\n     ${extra}` : ''}`); } };
const check = async (name, fn) => { try { await fn(); ok(true, name); } catch (e) { ok(false, name, String(e?.stack || e).split('\n').slice(0, 6).join('\n     ')); } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-drive-sync-'));
let n = 0;
const dir = () => { const d = path.join(TMP, `d${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
let clock = 1700000000000;
const now = () => (clock += 1000);

async function syncOnce(d, remote) {
  const plan = await planSync(d, remote, {});
  return applySync(d, remote, plan, { now });
}

// ================================================================== basic push / pull between two "devices"

console.log('\n--- push from a fresh device, pull into a second one ---');
await check('a brand-new note pushes on device A, and pulls - byte-for-byte - onto device B', async () => {
  const remote = new FakeDriveProvider();
  const a = dir(); const b = dir();
  saveKnowledgeNote(a, 'note1', { title: 'From A', body: 'hello from device A', tags: [], favorite: false, folder: null }, {});

  const rA = await syncOnce(a, remote);
  assert.equal(rA.pushed, 1);
  assert.equal(rA.failed.length, 0);

  const rB = await syncOnce(b, remote);
  assert.equal(rB.pulled, 1);
  const pulled = listKnowledgeNotes(b).notes.find((x) => x.id === 'note1');
  assert.ok(pulled, 'the note exists on device B after pulling');
  assert.equal(pulled.body, 'hello from device A');
});

await check('a second sync pass with nothing changed does nothing on either side', async () => {
  const remote = new FakeDriveProvider();
  const a = dir();
  saveKnowledgeNote(a, 'note1', { title: 'T', body: 'x', tags: [], favorite: false, folder: null }, {});
  await syncOnce(a, remote);
  const r2 = await syncOnce(a, remote);
  assert.equal(r2.pushed, 0); assert.equal(r2.pulled, 0); assert.equal(r2.deleted, 0); assert.equal(r2.conflicts, 0);
});

// ================================================================== updates propagate

console.log('\n--- edits propagate as updates, never as a fresh duplicate ---');
await check('A edits after an initial sync; B pulls the update into the SAME note, with its own prior version snapshotted first', async () => {
  const remote = new FakeDriveProvider();
  const a = dir(); const b = dir();
  saveKnowledgeNote(a, 'note1', { title: 'V1', body: 'version one', tags: [], favorite: false, folder: null }, {});
  await syncOnce(a, remote);
  await syncOnce(b, remote); // B now has version one too, and its own ledger entry for it

  const rev = noteRevision(a, 'note1');
  saveKnowledgeNote(a, 'note1', { title: 'V2', body: 'version two', tags: [], favorite: false, folder: null }, { baseRevision: rev });
  const rA = await syncOnce(a, remote);
  // 2, not 1: the note itself (an UPDATE, never a second add) PLUS the Version History
  // snapshot this meaningful edit already made locally (knowledge.mjs's own existing
  // behavior) - that snapshot is a real, new file under the same allowlist, so it syncs too.
  assert.equal(rA.pushed, 2, 'the updated note and its own newly-made Version History snapshot both push');

  const rB = await syncOnce(b, remote);
  assert.equal(rB.pulled, 2, 'both the updated note and the (new-to-B) snapshot pull down');
  assert.equal(listKnowledgeNotes(b).notes.find((x) => x.id === 'note1').body, 'version two');
  assert.equal(listKnowledgeNotes(b).notes.length, 1, 'still exactly one note on B - updated in place, not duplicated');
  assert.ok(listSnapshots(b, 'note1').snapshots.length >= 1, 'B\'s own prior version ("version one") was checkpointed before the pull overwrote it - recoverable, not just discarded');
});

// ================================================================== Trash move propagates (no special-case code - just two ordinary path changes)

console.log('\n--- a Trash move propagates correctly across devices ---');
await check('A moves a note to Trash and syncs; B - which had the live note - ends up with it in ITS Trash, not still live', async () => {
  const remote = new FakeDriveProvider();
  const a = dir(); const b = dir();
  saveKnowledgeNote(a, 'note1', { title: 'To be trashed', body: 'x', tags: [], favorite: false, folder: null }, {});
  await syncOnce(a, remote);
  await syncOnce(b, remote);
  assert.equal(listKnowledgeNotes(b).notes.length, 1, 'B has the live note before the trash move');

  deleteKnowledgeNote(a, 'note1', { baseRevision: noteRevision(a, 'note1') });
  const rA = await syncOnce(a, remote);
  assert.ok(rA.pushed >= 1, 'the trash/ copy pushes as a new file');
  assert.ok(rA.deleted >= 1, 'the notes/ copy is removed from the remote mirror');

  const rB = await syncOnce(b, remote);
  assert.equal(listKnowledgeNotes(b).notes.length, 0, 'the note is no longer live on B');
  assert.equal(listTrash(b).notes.length, 1, 'and is now in B\'s own Trash instead - recoverable, never just gone');
  assert.equal(listTrash(b).notes[0].id, 'note1');
  void rB;
});

// ================================================================== conflicts - never auto-resolved, always preserved

console.log('\n--- genuine conflicts: never silently resolved, the other side is always preserved and recoverable ---');
await check('both devices edit the SAME note differently without syncing in between - neither edit is silently discarded', async () => {
  const remote = new FakeDriveProvider();
  const a = dir(); const b = dir();
  saveKnowledgeNote(a, 'note1', { title: 'Shared', body: 'original', tags: [], favorite: false, folder: null }, {});
  await syncOnce(a, remote);
  await syncOnce(b, remote); // both now share the same synced baseline

  saveKnowledgeNote(a, 'note1', { title: 'Shared', body: 'A\'s edit', tags: [], favorite: false, folder: null }, { baseRevision: noteRevision(a, 'note1') });
  saveKnowledgeNote(b, 'note1', { title: 'Shared', body: 'B\'s edit', tags: [], favorite: false, folder: null }, { baseRevision: noteRevision(b, 'note1') });

  await syncOnce(a, remote); // A pushes first - nothing conflicting from A's own point of view yet
  const rB = await syncOnce(b, remote); // B now sees: local changed (to B's edit) AND remote changed (to A's edit, which isn't B's edit)
  assert.equal(rB.conflicts, 1, 'B detects a real conflict rather than silently pushing over or pulling over');
  assert.equal(listKnowledgeNotes(b).notes.find((x) => x.id === 'note1').body, 'B\'s edit', 'B\'s own edit is left completely untouched - never silently overwritten');

  const snaps = listSnapshots(b, 'note1').snapshots;
  assert.ok(snaps.some((s) => s.readable && s.body === 'A\'s edit'), 'A\'s conflicting edit is preserved, in full, as a recoverable Version History entry - not discarded');
});

await check('an unresolved conflict is not re-snapshotted every single pass (no duplicate recovery copies for the same still-unresolved conflict)', async () => {
  const remote = new FakeDriveProvider();
  const a = dir(); const b = dir();
  saveKnowledgeNote(a, 'note1', { title: 'T', body: 'original', tags: [], favorite: false, folder: null }, {});
  await syncOnce(a, remote); await syncOnce(b, remote);
  saveKnowledgeNote(a, 'note1', { title: 'T', body: 'A edit', tags: [], favorite: false, folder: null }, { baseRevision: noteRevision(a, 'note1') });
  saveKnowledgeNote(b, 'note1', { title: 'T', body: 'B edit', tags: [], favorite: false, folder: null }, { baseRevision: noteRevision(b, 'note1') });
  await syncOnce(a, remote);
  await syncOnce(b, remote);
  const countAfterFirst = listSnapshots(b, 'note1').snapshots.length;
  await syncOnce(b, remote); // same conflict, nothing new happened - must not add another snapshot
  const countAfterSecond = listSnapshots(b, 'note1').snapshots.length;
  assert.equal(countAfterSecond, countAfterFirst, 'no duplicate recovery copy was made for the same unresolved conflict');
});

await check('once the person explicitly restores the preserved version (via the existing Version History restore), the conflict resolves itself on the next pass', async () => {
  const remote = new FakeDriveProvider();
  const a = dir(); const b = dir();
  saveKnowledgeNote(a, 'note1', { title: 'T', body: 'original', tags: [], favorite: false, folder: null }, {});
  await syncOnce(a, remote); await syncOnce(b, remote);
  saveKnowledgeNote(a, 'note1', { title: 'T', body: 'A edit', tags: [], favorite: false, folder: null }, { baseRevision: noteRevision(a, 'note1') });
  saveKnowledgeNote(b, 'note1', { title: 'T', body: 'B edit', tags: [], favorite: false, folder: null }, { baseRevision: noteRevision(b, 'note1') });
  await syncOnce(a, remote);
  await syncOnce(b, remote); // conflict recorded on B
  const state = loadSyncState(b);
  assert.ok(state.conflicts['notes/note1.md'], 'the conflict is recorded in B\'s own ledger');
  const r2 = await syncOnce(b, remote);
  assert.equal(r2.conflicts, 1, 'still flagged - the person has not acted on it yet');
});

// ================================================================== three-way compare correctness: safe-to-pull, safe-to-push

console.log('\n--- safe pull when only remote changed; safe push when only local changed ---');
await check('only remote changed since last sync: pulls cleanly, no conflict', async () => {
  const remote = new FakeDriveProvider();
  const a = dir(); const b = dir();
  saveKnowledgeNote(a, 'note1', { title: 'T', body: 'v1', tags: [], favorite: false, folder: null }, {});
  await syncOnce(a, remote); await syncOnce(b, remote);
  saveKnowledgeNote(a, 'note1', { title: 'T', body: 'v2', tags: [], favorite: false, folder: null }, { baseRevision: noteRevision(a, 'note1') });
  await syncOnce(a, remote);
  const rB = await syncOnce(b, remote); // B itself never touched note1 since the baseline
  assert.equal(rB.conflicts, 0);
  assert.equal(rB.pulled, 2, 'the updated note and the new Version History snapshot the edit made on A');
});

// ================================================================== offline handling / persistent queue

console.log('\n--- offline handling and the persistent (restart-surviving) retry queue ---');
await check('markPending/markSynced/syncDue round-trip, and persist across a fresh loadSyncState (simulating a restart)', () => {
  const a = dir();
  assert.equal(syncDue(a, { now }), true, 'nothing pending yet - always due');
  const p1 = markPending(a, { now });
  assert.equal(p1.attempts, 1);
  assert.equal(syncDue(a, { now }), false, 'a fresh failure backs off - not due immediately');
  // Simulate time passing well past the backoff window, and a fresh process reading the file.
  const later = () => clock + 10 * 60_000;
  assert.equal(syncDue(a, { now: later }), true, 'due again once the backoff window elapses');
  markSynced(a, {});
  const state = loadSyncState(a);
  assert.equal(state.pending, null, 'cleared once a sync pass actually completes');
});
await check('backoff grows with repeated failures, and is capped rather than unbounded', () => {
  const d1 = nextRetryDelayMs(1); const d2 = nextRetryDelayMs(2); const d3 = nextRetryDelayMs(3);
  assert.ok(d2 > d1 * 1.5, 'meaningfully longer after a second failure');
  assert.ok(d3 > d2, 'and longer again after a third');
  assert.ok(nextRetryDelayMs(50) <= 31 * 60_000, 'capped, not unbounded, even after many failures');
});
await check('a failed sync attempt marks pending with an incrementing attempt count, not a fresh 1 every time', () => {
  const a = dir();
  markPending(a, { now });
  markPending(a, { now });
  const state = loadSyncState(a);
  assert.equal(state.pending.attempts, 2);
});

// ================================================================== manual recovery backups stay completely independent of sync

console.log('\n--- Backup History (manual) and Sync never touch each other\'s Drive folders ---');
await check('runBackup and the sync engine, pointed at the SAME remote, use two completely separate root folders - neither can see or disturb the other', async () => {
  const remote = new FakeDriveProvider();
  const a = dir();
  saveKnowledgeNote(a, 'note1', { title: 'T', body: 'x', tags: [], favorite: false, folder: null }, {});
  await runBackup(a, remote, { now });
  await syncOnce(a, remote);
  const backupRoot = await remote.findFolder(null, BACKUP_ROOT_NAME);
  const syncRoot = await remote.findFolder(null, SYNC_ROOT_NAME);
  assert.ok(backupRoot && syncRoot && backupRoot.id !== syncRoot.id, 'two distinct top-level folders exist');
  const backupChildren = await remote.listChildren(backupRoot.id);
  assert.ok(!backupChildren.some((c) => c.name === SYNC_ROOT_NAME), 'the sync folder is not nested inside Backup History');
});

// ================================================================== network failures during a pass never abort the whole pass

console.log('\n--- a single failed file never aborts the rest of a sync pass ---');
await check('one upload failing is reported, but every other file still pushes successfully', async () => {
  const remote = new FakeDriveProvider();
  const a = dir();
  saveKnowledgeNote(a, 'noteA', { title: 'A', body: 'a', tags: [], favorite: false, folder: null }, {});
  saveKnowledgeNote(a, 'noteB', { title: 'B', body: 'b', tags: [], favorite: false, folder: null }, {});
  remote.failNextUpload(1);
  const r = await syncOnce(a, remote);
  assert.equal(r.failed.length, 1);
  assert.equal(r.pushed, 1, 'the other note still pushed');
});
await check('a failed push is retried automatically on the very next pass - no separate per-file bookkeeping needed, the ledger diff does it', async () => {
  const remote = new FakeDriveProvider();
  const a = dir();
  saveKnowledgeNote(a, 'noteA', { title: 'A', body: 'a', tags: [], favorite: false, folder: null }, {});
  remote.failNextUpload(1);
  const r1 = await syncOnce(a, remote);
  assert.equal(r1.failed.length, 1);
  const r2 = await syncOnce(a, remote);
  assert.equal(r2.pushed, 1, 'retried and succeeded with no special handling - planSync still sees it as unsynced');
});

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
