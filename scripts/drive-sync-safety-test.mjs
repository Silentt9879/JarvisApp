// JARVIS Notes - Phase 5 Task 3: Drive Sync safety audit. Covers the scenarios
// drive-sync-test.mjs / drive-sync-controller-test.mjs (Phase 3) did not yet exercise
// explicitly: Trash restoration re-syncing correctly, token expiry, corrupted remote data,
// conflicts holding up across more than two cycles, and recovery after a simulated JARVIS
// restart (a brand-new controller instance, no shared in-memory state). All against
// FakeDriveProvider - no network, no real Google account.
//   node scripts/drive-sync-safety-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planSync, applySync, loadSyncState, markPending } from '../src/drive-sync.mjs';
import { createDriveSyncController } from '../src/drive-sync-controller.mjs';
import {
  saveKnowledgeNote, deleteKnowledgeNote, restoreKnowledgeNote, noteRevision,
  listKnowledgeNotes, listTrash, knowledgePaths,
} from '../src/knowledge.mjs';
import { FakeDriveProvider } from './fake-drive-provider.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${extra ? `\n     ${extra}` : ''}`); } };
const check = async (name, fn) => { try { await fn(); ok(true, name); } catch (e) { ok(false, name, String(e?.stack || e).split('\n').slice(0, 6).join('\n     ')); } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-drive-sync-safety-'));
let n = 0;
const dir = () => { const d = path.join(TMP, `d${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
let clock = 1700000000000;
const now = () => (clock += 1000);

async function syncOnce(d, remote) {
  const plan = await planSync(d, remote, {});
  return applySync(d, remote, plan, { now });
}

// ================================================================== Trash restoration, then re-sync

console.log('\n--- Trash restoration propagates correctly, both directions ---');
await check('A trashes then restores a note before B ever syncs - B ends up with the LIVE note, never stuck in Trash', async () => {
  const remote = new FakeDriveProvider();
  const a = dir(); const b = dir();
  saveKnowledgeNote(a, 'n1', { title: 'T', body: 'x', tags: [], favorite: false, folder: null }, {});
  await syncOnce(a, remote);
  deleteKnowledgeNote(a, 'n1', { baseRevision: noteRevision(a, 'n1') });
  await syncOnce(a, remote); // trash/n1.md pushed, notes/n1.md pushDeleted
  restoreKnowledgeNote(a, 'n1');
  await syncOnce(a, remote); // notes/n1.md re-pushed, trash/n1.md pushDeleted

  await syncOnce(b, remote);
  assert.equal(listKnowledgeNotes(b).notes.length, 1, 'B sees the note live');
  assert.equal(listTrash(b).notes.length, 0, 'and NOT also stuck in B\'s own Trash from the intermediate state');
});
await check('A trashes a note and syncs; B syncs (gets it in Trash) and restores it LOCALLY; a later sync does not re-trash it on A', async () => {
  const remote = new FakeDriveProvider();
  const a = dir(); const b = dir();
  saveKnowledgeNote(a, 'n1', { title: 'T', body: 'x', tags: [], favorite: false, folder: null }, {});
  await syncOnce(a, remote);
  await syncOnce(b, remote);
  deleteKnowledgeNote(a, 'n1', { baseRevision: noteRevision(a, 'n1') });
  await syncOnce(a, remote);
  await syncOnce(b, remote);
  assert.equal(listTrash(b).notes.length, 1, 'B received the trash move');

  restoreKnowledgeNote(b, 'n1'); // B decides to un-delete it locally
  await syncOnce(b, remote);
  await syncOnce(a, remote);
  assert.equal(listKnowledgeNotes(a).notes.length, 1, 'A sees it live again too - B\'s restore propagated back');
  assert.equal(listTrash(a).notes.length, 0, 'and it is not left behind in A\'s own Trash either');
});

// ================================================================== Interrupted sync / token expiry

console.log('\n--- interrupted sync and token/auth failures never corrupt state or duplicate work ---');
await check('an exception thrown mid-plan (simulating a dropped connection) leaves the ledger exactly as it was before - no partial/corrupt state written', async () => {
  const remote = new FakeDriveProvider();
  const d = dir();
  saveKnowledgeNote(d, 'n1', { title: 'T', body: 'x', tags: [], favorite: false, folder: null }, {});
  await syncOnce(d, remote);
  const before = loadSyncState(d);

  const brokenRemote = { ...remote, listChildren: async () => { throw new Error('simulated connection drop'); } };
  await assert.rejects(() => planSync(d, brokenRemote, {}));
  const after = loadSyncState(d);
  assert.deepEqual(after.entries, before.entries, 'the ledger is untouched by a failed attempt - nothing was half-written');
});
await check('a controller-level auth/token failure (DriveAuthError-style) is recorded as a hard error, not confused with "nothing to do"', async () => {
  const d = dir();
  saveKnowledgeNote(d, 'n1', { title: 'T', body: 'x', tags: [], favorite: false, folder: null }, {});
  class DriveAuthError extends Error {}
  const ctrl = createDriveSyncController({
    userDir: d, now,
    getProvider: () => { throw new DriveAuthError('Google Drive rejected the connection - reconnect to continue.'); },
    isConnected: () => true, // "connected" per drive-connection.mjs's own status, but the token itself is dead - the realistic shape of an expired-token failure
  });
  const r = await ctrl.syncNow();
  assert.equal(r.ok, false);
  assert.match(r.error, /reconnect/i);
  assert.equal(ctrl.status().state, 'error');
  assert.ok(ctrl.status().pending, 'a retry is still recorded, so reconnecting later picks this up automatically');
});
await check('after a simulated reconnect (the provider starts working again), the next sync succeeds and clears the error', async () => {
  const d = dir();
  saveKnowledgeNote(d, 'n1', { title: 'T', body: 'x', tags: [], favorite: false, folder: null }, {});
  let broken = true;
  const remote = new FakeDriveProvider();
  const ctrl = createDriveSyncController({
    userDir: d, now,
    getProvider: () => { if (broken) throw new Error('token expired'); return remote; },
    isConnected: () => true,
  });
  const r1 = await ctrl.syncNow();
  assert.equal(r1.ok, false);
  broken = false; // "reconnected"
  const r2 = await ctrl.syncNow();
  assert.equal(r2.ok, true);
  assert.equal(ctrl.status().state, 'idle');
});

// ================================================================== Corrupted remote data

console.log('\n--- corrupted remote data is pulled faithfully, never silently "fixed" or crashed on ---');
await check('a remote file that is not valid note content (corrupted by something other than JARVIS) is still pulled byte-for-byte, and the existing corrupt-note handling catches it afterward', async () => {
  const remote = new FakeDriveProvider();
  const a = dir(); const b = dir();
  saveKnowledgeNote(a, 'n1', { title: 'Fine', body: 'hello', tags: [], favorite: false, folder: null }, {});
  await syncOnce(a, remote);

  // Simulate the remote copy being corrupted by something outside JARVIS entirely (not a
  // JARVIS upload at all) - garbage bytes with no valid front matter.
  const root = await remote.findFolder(null, 'JARVIS Notes Sync');
  const notesFolder = await remote.findFolder(root.id, 'notes');
  const children = await remote.listChildren(notesFolder.id);
  const fileId = children.find((c) => c.name === 'n1.md').id;
  remote.files.get(fileId).bytes = Buffer.from('%%% not front matter, just garbage %%%');

  const rB = await syncOnce(b, remote);
  assert.equal(rB.failed.length, 0, 'the pull itself does not fail or throw on corrupted-but-readable bytes');
  const pulled = listKnowledgeNotes(b).notes.find((x) => x.id === 'n1');
  assert.ok(pulled, 'the file exists locally');
  assert.equal(pulled.corrupt, true, 'and the existing, already-tested corrupt-note flag correctly catches it on the way back out - no special sync-side crash or silent repair');
});

// ================================================================== Conflicts across more than two cycles

console.log('\n--- a conflict that keeps diverging is re-detected and re-preserved each time it actually changes ---');
await check('three consecutive rounds of A and B both editing the same note differently each round: every round is caught as a conflict, and B never loses its own edit', async () => {
  const remote = new FakeDriveProvider();
  const a = dir(); const b = dir();
  saveKnowledgeNote(a, 'n1', { title: 'T', body: 'v0', tags: [], favorite: false, folder: null }, {});
  await syncOnce(a, remote); await syncOnce(b, remote);

  const rounds = [['A round 1', 'B round 1'], ['A round 2', 'B round 2'], ['A round 3', 'B round 3']];
  const snapshotCounts = [];
  for (const [aEdit, bEdit] of rounds) {
    saveKnowledgeNote(a, 'n1', { title: 'T', body: aEdit, tags: [], favorite: false, folder: null }, { baseRevision: noteRevision(a, 'n1') });
    saveKnowledgeNote(b, 'n1', { title: 'T', body: bEdit, tags: [], favorite: false, folder: null }, { baseRevision: noteRevision(b, 'n1') });
    await syncOnce(a, remote);
    const r = await syncOnce(b, remote);
    assert.equal(r.conflicts, 1, `round "${aEdit}" vs "${bEdit}" must be caught as a conflict`);
    assert.equal(listKnowledgeNotes(b).notes.find((x) => x.id === 'n1').body, bEdit, 'B\'s own edit for this round is never overwritten');
    const { listSnapshots } = await import('../src/knowledge.mjs');
    snapshotCounts.push(listSnapshots(b, 'n1').snapshots.length);
  }
  assert.ok(snapshotCounts[1] > snapshotCounts[0], 'round 2\'s genuinely different conflicting content produced a new preserved snapshot');
  assert.ok(snapshotCounts[2] > snapshotCounts[1], 'and so did round 3 - re-detection keeps working across many cycles, not just the first one');
});

// ================================================================== Recovery after restarting JARVIS

console.log('\n--- recovery after a simulated restart (a brand-new controller, no shared in-memory state) ---');
await check('a pending retry recorded before "restart" is still honored by a freshly constructed controller pointed at the same disk state', async () => {
  const d = dir();
  saveKnowledgeNote(d, 'n1', { title: 'T', body: 'x', tags: [], favorite: false, folder: null }, {});
  markPending(d, { now }); // simulates an earlier process having failed and recorded this before exiting
  const remote = new FakeDriveProvider();
  // A brand-new controller instance - nothing carried over from before "restart" except what
  // is actually on disk (the ledger/pending state), the same as a real app relaunch.
  const freshCtrl = createDriveSyncController({ userDir: d, getProvider: () => remote, isConnected: () => true, now });
  const r = await freshCtrl.syncNow();
  assert.equal(r.ok, true, 'the fresh instance recovers and completes a real sync, with no special "restore my previous state" code needed');
  assert.equal(loadSyncState(d).pending, null, 'the pending marker is cleared once caught up');
});
await check('the ledger itself (ids/hashes already synced) survives a restart and is not rebuilt from scratch, so a restart never re-uploads everything', async () => {
  const remote = new FakeDriveProvider();
  const d = dir();
  saveKnowledgeNote(d, 'n1', { title: 'T', body: 'x', tags: [], favorite: false, folder: null }, {});
  const ctrl1 = createDriveSyncController({ userDir: d, getProvider: () => remote, isConnected: () => true, now });
  await ctrl1.syncNow();
  // "Restart": a new controller, same disk.
  const ctrl2 = createDriveSyncController({ userDir: d, getProvider: () => remote, isConnected: () => true, now });
  const r = await ctrl2.syncNow();
  assert.equal(r.pushed, 0, 'nothing is re-pushed - the ledger already on disk says it is already synced');
});

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
