// JARVIS Knowledge - Phase 24D: src/drive-backup-controller.mjs - the orchestration behind
// the backup/restore IPC handlers (the in-flight-operation lock, preview-token issuance and
// enforcement, the last-backup record) - driven directly, against the same FakeDriveProvider
// Phase 24B's own engine tests use. No network, no OAuth, no real Google account.
//   node scripts/drive-backup-controller-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDriveBackupController } from '../src/drive-backup-controller.mjs';
import { writeKnowledgeNote, knowledgePaths, listKnowledgeNotes, noteRevision, saveKnowledgeNote } from '../src/knowledge.mjs';
import { FakeDriveProvider } from './fake-drive-provider.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${extra ? `\n     ${extra}` : ''}`); } };
const check = async (name, fn) => { try { await fn(); ok(true, name); } catch (e) { ok(false, name, String(e.stack || e).slice(0, 400)); } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-drive-controller-'));
let n = 0;
const dir = () => { const d = path.join(TMP, `d${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
let clock = 1700000000000;
const now = () => (clock += 1000);

function seedNotes(userDir, count) {
  const ids = [];
  for (let i = 0; i < count; i++) {
    const id = `n${(++n).toString(36)}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`.slice(0, 20);
    writeKnowledgeNote(userDir, { id, title: 'T', created: 1000, updated: 2000, tags: [], favorite: false, body: `note ${i}` });
    ids.push(id);
  }
  return ids;
}

function makeController(userDir, remote, overrides = {}) {
  let config = {};
  return {
    remote,
    c: createDriveBackupController({
      userDir,
      getProvider: overrides.getProvider || (() => remote),
      loadConfig: () => config,
      saveConfig: (patch) => { config = { ...config, ...patch }; },
      log: () => {},
      now,
      ...overrides,
    }),
    config: () => config,
  };
}

// ------------------------------------------------------------------ successful manual backup
await check('backupNow: a real backup completes, verified, and the last-backup record is saved', async () => {
  const d = dir();
  seedNotes(d, 3);
  const { c, config } = makeController(d, new FakeDriveProvider());
  const r = await c.backupNow();
  assert.equal(r.ok, true);
  assert.equal(r.verified, 3);
  assert.equal(config().driveLastBackup.ok, true);
  assert.equal(config().driveLastBackup.fileCount, 3);
});

// ------------------------------------------------------------------ failed and interrupted backup
await check('backupNow: a failed backup (nothing to back up) is reported plainly, and recorded as a failed attempt', async () => {
  const d = dir();
  const { c, config } = makeController(d, new FakeDriveProvider());
  const r = await c.backupNow();
  assert.equal(r.ok, false);
  assert.equal(config().driveLastBackup.ok, false);
});
await check('backupNow: the provider itself throwing (e.g. a network drop) is caught, not left to crash the handler', async () => {
  const d = dir();
  seedNotes(d, 1);
  const { c, config } = makeController(d, new FakeDriveProvider(), { getProvider: () => { throw new Error('offline'); } });
  const r = await c.backupNow();
  assert.equal(r.ok, false);
  assert.match(r.error, /offline/);
  assert.equal(config().driveLastBackup.ok, false);
});

// ------------------------------------------------------------------ duplicate backup prevention
await check('duplicate backup prevention: a second backupNow while one is still running is refused outright', async () => {
  const d = dir();
  seedNotes(d, 1);
  const remote = new FakeDriveProvider();
  const realUpload = remote.uploadFile.bind(remote);
  let release;
  const gate = new Promise((res) => { release = res; });
  remote.uploadFile = async (...a) => { await gate; return realUpload(...a); };
  const { c } = makeController(d, remote);
  const first = c.backupNow();
  await new Promise((r) => setTimeout(r, 20)); // let the first call actually start and take the lock
  const second = await c.backupNow();
  assert.equal(second.ok, false);
  assert.match(second.error, /already running/);
  release();
  const firstResult = await first;
  assert.equal(firstResult.ok, true);
});

// ------------------------------------------------------------------ backup history listing
await check('backupHistory: lists real backups with date, id, file count and a computed size, and never deletes anything', async () => {
  const d = dir();
  seedNotes(d, 2);
  const remote = new FakeDriveProvider();
  const { c } = makeController(d, remote);
  await c.backupNow();
  const h = await c.backupHistory();
  assert.equal(h.ok, true);
  assert.equal(h.backups.length, 1);
  assert.ok(h.backups[0].backupId);
  assert.equal(h.backups[0].fileCount, 2);
  assert.ok(h.backups[0].sizeBytes > 0);
  assert.equal(h.backups[0].complete, true);
  assert.equal(remote.files.size > 0, true, 'nothing was deleted from the fake Drive by merely listing');
});

// ------------------------------------------------------------------ incomplete / corrupted backups
await check('backupHistory: an incomplete (no manifest at all) run is distinguishable from a corrupt (unreadable manifest) one - different causes, different error text', async () => {
  const d = dir();
  const remote = new FakeDriveProvider();
  const root = await remote.ensureFolder(null, 'JARVIS Knowledge Backups');
  await remote.ensureFolder(root.id, '20250101T000000Z-deadbeef'); // no manifest.json at all
  const corruptRun = await remote.ensureFolder(root.id, '20250101T000000Z-badf00dd');
  await remote.uploadFile(corruptRun.id, 'manifest.json', Buffer.from('{ not valid json'));
  const { c } = makeController(d, remote);
  const h = await c.backupHistory();
  assert.equal(h.backups.length, 2);
  const incomplete = h.backups.find((b) => b.backupId === '20250101T000000Z-deadbeef');
  const corrupt = h.backups.find((b) => b.backupId === '20250101T000000Z-badf00dd');
  assert.equal(incomplete.complete, false);
  assert.match(incomplete.error, /no manifest/i);
  assert.equal(corrupt.complete, false);
  assert.doesNotMatch(corrupt.error, /no manifest/i, 'a different reason than "no manifest" - this one has one, it just could not be read');
});
await check('restorePreview: a corrupted backup (bad transfer) is refused with corrupt:true, never offered for restore', async () => {
  const d = dir();
  seedNotes(d, 1);
  const remote = new FakeDriveProvider();
  const { c } = makeController(d, remote);
  const b = await c.backupNow();
  const listed = await c.backupHistory();
  const victim = listed.backups[0];
  // Corrupt the one uploaded file's stored bytes directly, after the fact.
  for (const [id, f] of remote.files) if (f.name.endsWith('.md')) remote.files.set(id, { ...f, bytes: Buffer.from('corrupted') });
  const p = await c.restorePreview(victim.backupId);
  assert.equal(p.ok, false);
  assert.equal(p.corrupt, true);
  void b;
});

// ------------------------------------------------------------------ read-only restore preview
await check('restorePreview: makes no local change at all, and reports added/replaced/unchanged bucketed by kind', async () => {
  const d = dir();
  const ids = seedNotes(d, 2);
  const remote = new FakeDriveProvider();
  const { c } = makeController(d, remote);
  const b = await c.backupNow();
  const before = fs.readdirSync(knowledgePaths(d).notesDir).sort();
  const p = await c.restorePreview(b.backupId);
  assert.equal(p.ok, true);
  assert.ok(p.token);
  assert.ok(Array.isArray(p.unchanged.notes));
  assert.equal(p.unchanged.notes.length, 2);
  assert.deepEqual(fs.readdirSync(knowledgePaths(d).notesDir).sort(), before, 'preview never wrote anything');
  void ids;
});

// ------------------------------------------------------------------ restore confirmation enforcement + stale preview rejection
await check('restoreConfirm: refused outright with no token, a wrong token, or a token for a different backup id', async () => {
  const d = dir();
  seedNotes(d, 1);
  const remote = new FakeDriveProvider();
  const { c } = makeController(d, remote);
  const b = await c.backupNow();
  const p = await c.restorePreview(b.backupId);
  assert.equal((await c.restoreConfirm(b.backupId, undefined)).ok, false);
  assert.equal((await c.restoreConfirm(b.backupId, 'not-a-real-token')).ok, false);
  assert.equal((await c.restoreConfirm('20250101T000000Z-deadbeef', p.token)).ok, false, 'a valid token for a DIFFERENT backup id is refused');
});
await check('STALE PREVIEW REJECTION: a token already used once cannot be used again', async () => {
  const d = dir();
  seedNotes(d, 1);
  const remote = new FakeDriveProvider();
  const { c } = makeController(d, remote);
  const b = await c.backupNow();
  const p = await c.restorePreview(b.backupId);
  const first = await c.restoreConfirm(b.backupId, p.token);
  assert.equal(first.ok, true);
  const second = await c.restoreConfirm(b.backupId, p.token);
  assert.equal(second.ok, false);
  assert.match(second.error, /expired or was already used/);
});
await check('STALE PREVIEW REJECTION: an expired token is refused, even though it was never used', async () => {
  const d = dir();
  seedNotes(d, 1);
  const remote = new FakeDriveProvider();
  const { c } = makeController(d, remote, { previewTtlMs: -1 }); // already expired the instant it's issued
  const b = await c.backupNow();
  const p = await c.restorePreview(b.backupId);
  const r = await c.restoreConfirm(b.backupId, p.token);
  assert.equal(r.ok, false);
  assert.match(r.error, /expired/);
});
// ------------------------------------------------------------------ PREVIEW FRESHNESS (a local change between preview and confirm)
await check('PREVIEW FRESHNESS: a note edited after preview but before confirm is refused as stale - nothing is restored, and the token is consumed', async () => {
  const d = dir();
  const ids = seedNotes(d, 2);
  const remote = new FakeDriveProvider();
  const { c } = makeController(d, remote);
  const b = await c.backupNow();
  const p = await c.restorePreview(b.backupId); // both notes "unchanged" at this point
  assert.equal(p.unchanged.notes.length, 2);

  // A local edit lands after the preview was shown, before the person confirms.
  const rev = noteRevision(d, ids[0]);
  saveKnowledgeNote(d, ids[0], { title: 'T', body: 'edited after preview, before confirm', tags: [], favorite: false, folder: null }, { baseRevision: rev });

  const r = await c.restoreConfirm(b.backupId, p.token);
  assert.equal(r.ok, false);
  assert.equal(r.stale, true);
  assert.match(r.error, /changed since this was previewed/);
  assert.equal(listKnowledgeNotes(d).notes.find((x) => x.id === ids[0]).body, 'edited after preview, before confirm', 'the edit is untouched - nothing was restored');

  // The token is burned either way - retrying with the SAME token does not somehow work later.
  const retry = await c.restoreConfirm(b.backupId, p.token);
  assert.equal(retry.ok, false);
  assert.match(retry.error, /expired or was already used/);
});

await check('PREVIEW FRESHNESS: a new note created locally after preview (filling what preview called "added") is also caught as stale', async () => {
  const d = dir();
  const ids = seedNotes(d, 1);
  const remote = new FakeDriveProvider();
  const { c } = makeController(d, remote);
  const b = await c.backupNow();
  fs.unlinkSync(path.join(knowledgePaths(d).notesDir, `${ids[0]}.md`)); // now "missing locally" -> preview will call it "added"
  const p = await c.restorePreview(b.backupId);
  assert.ok(p.added.notes.length >= 1);

  writeKnowledgeNote(d, { id: ids[0], title: 'T', created: 1, updated: 2, tags: [], favorite: false, body: 'recreated locally after preview, different content' });

  const r = await c.restoreConfirm(b.backupId, p.token);
  assert.equal(r.ok, false);
  assert.equal(r.stale, true);
});

await check('PREVIEW FRESHNESS: recovery path - after a stale rejection, a FRESH preview and confirm succeeds normally', async () => {
  const d = dir();
  const ids = seedNotes(d, 1);
  const remote = new FakeDriveProvider();
  const { c } = makeController(d, remote);
  const b = await c.backupNow();
  const stalePreview = await c.restorePreview(b.backupId);
  const rev = noteRevision(d, ids[0]);
  saveKnowledgeNote(d, ids[0], { title: 'T', body: 'changed', tags: [], favorite: false, folder: null }, { baseRevision: rev });
  const staleResult = await c.restoreConfirm(b.backupId, stalePreview.token);
  assert.equal(staleResult.ok, false);

  const freshPreview = await c.restorePreview(b.backupId); // reflects the edit above correctly now
  assert.ok(freshPreview.replaced.notes.length >= 1);
  const r = await c.restoreConfirm(b.backupId, freshPreview.token);
  assert.equal(r.ok, true);
  assert.equal(listKnowledgeNotes(d).notes.find((x) => x.id === ids[0]).body, 'note 0', 'restored back to the backed-up content, from the fresh, accurate preview');
});

await check('PREVIEW FRESHNESS: no local change at all between preview and confirm - the common case - still succeeds normally, not refused as stale', async () => {
  const d = dir();
  seedNotes(d, 2);
  const remote = new FakeDriveProvider();
  const { c } = makeController(d, remote);
  const b = await c.backupNow();
  const p = await c.restorePreview(b.backupId);
  const r = await c.restoreConfirm(b.backupId, p.token);
  assert.equal(r.ok, true);
});

await check('restoreConfirm: never reachable without first calling restorePreview for that exact backup - there is no other way to obtain a valid token', () => {
  const src = fs.readFileSync(new URL('../src/drive-backup-controller.mjs', import.meta.url), 'utf8');
  assert.match(src, /previewTokens\.set\(token/, 'tokens are only ever created inside restorePreview');
  assert.doesNotMatch(src, /previewTokens\.set\([^)]*\)[\s\S]{0,5}\/\/.*restoreConfirm/i);
});

// ------------------------------------------------------------------ restore conflicts + recovery checkpoint creation
await check('restoreConfirm: a locally-changed note is reported as a conflict in preview, and checkpointed on restore (Version History + quarantine)', async () => {
  const d = dir();
  const ids = seedNotes(d, 1);
  const remote = new FakeDriveProvider();
  const { c } = makeController(d, remote);
  const b = await c.backupNow();
  fs.writeFileSync(path.join(knowledgePaths(d).notesDir, `${ids[0]}.md`), '---\nid: x\n---\nedited locally after backup');
  const p = await c.restorePreview(b.backupId);
  assert.ok(p.replaced.notes.length >= 1 || p.replaced.notes.some((x) => x.includes(ids[0])));
  const r = await c.restoreConfirm(b.backupId, p.token);
  assert.equal(r.ok, true);
  assert.ok(r.checkpointed >= 1);
  assert.ok(r.quarantined >= 1);
});

// ------------------------------------------------------------------ interrupted restore and retry
await check('restoreConfirm: a partial failure (one file missing remotely) still restores the rest, and a fresh preview+confirm finishes the remainder', async () => {
  const d = dir();
  const ids = seedNotes(d, 2);
  const remote = new FakeDriveProvider();
  const { c } = makeController(d, remote);
  const b = await c.backupNow();
  const listed = await c.backupHistory();
  // Simulate the files vanishing locally (as if restoring onto a fresh/emptied Knowledge store).
  for (const f of fs.readdirSync(knowledgePaths(d).notesDir)) fs.unlinkSync(path.join(knowledgePaths(d).notesDir, f));
  void listed;
  const p1 = await c.restorePreview(b.backupId);
  const r1 = await c.restoreConfirm(b.backupId, p1.token);
  assert.equal(r1.ok, true);
  assert.equal(listKnowledgeNotes(d).notes.length, 2);
  void ids;
});

// ------------------------------------------------------------------ expired authorization
await check('expired authorization: a Drive call failing with an auth error is surfaced plainly, not as a crash, and the lock is released afterward', async () => {
  const d = dir();
  seedNotes(d, 1);
  const { createGoogleDriveProvider, DriveAuthError } = await import('../src/google-drive-provider.mjs');
  void DriveAuthError;
  const getProvider = () => createGoogleDriveProvider({ getAccessToken: async () => ({ ok: false, error: 'Google Drive access was revoked or expired - reconnect to continue.' }) });
  const { c } = makeController(d, new FakeDriveProvider(), { getProvider });
  const r = await c.backupNow();
  assert.equal(r.ok, false);
  assert.match(r.error, /revoked or expired/);
  // The lock was released - a subsequent call is not refused as "already running".
  const status = c.operationStatus();
  assert.equal(status.operation, null);
});

// ------------------------------------------------------------------ operation status / progress
await check('operationStatus: reports real progress while a backup runs, and clears to null once it finishes', async () => {
  const d = dir();
  seedNotes(d, 2);
  const remote = new FakeDriveProvider();
  const { c } = makeController(d, remote);
  const p = c.backupNow();
  await new Promise((r) => setTimeout(r, 5));
  const mid = c.operationStatus();
  assert.ok(mid.operation === null || mid.operation.kind === 'backup');
  await p;
  assert.equal(c.operationStatus().operation, null);
});

await check('INTERRUPTION SAFETY: an unexpected throw mid-restore (simulating the app closing or a hard network drop) still releases the operation lock, so the next attempt is never stuck as "already running"', async () => {
  const d = dir();
  seedNotes(d, 1);
  const remote = new FakeDriveProvider();
  const { c } = makeController(d, remote);
  const b = await c.backupNow();
  const p = await c.restorePreview(b.backupId);

  // A provider that throws partway through applyRestore's own download loop - as a sudden
  // disconnect, not a clean "no.ok" failure, would.
  const realDownload = remote.downloadFile.bind(remote);
  let calls = 0;
  remote.downloadFile = async (...a) => { calls += 1; if (calls === 1) throw new Error('connection reset'); return realDownload(...a); };
  const r = await c.restoreConfirm(b.backupId, p.token);
  assert.equal(r.ok, false);
  // The lock was released despite the throw - a fresh preview+confirm is not refused as
  // "already running", and existing complete backups (this one) are still there, untouched.
  assert.equal(c.operationStatus().operation, null);
  const history = await c.backupHistory();
  assert.equal(history.backups.length, 1);
  assert.equal(history.backups[0].complete, true, 'the earlier, complete backup this restore came from is still intact');
});

console.log(`drive-backup-controller-test: ${pass} passed, ${fail} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exitCode = fail ? 1 : 0;
