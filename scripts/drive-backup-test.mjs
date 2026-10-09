// JARVIS Knowledge - Phase 24B: the Google Drive backup/restore ENGINE (src/drive-backup.mjs),
// driven entirely against the in-memory FakeDriveProvider (scripts/fake-drive-provider.mjs) -
// no network, no Google account, no OAuth, nothing real. Temp folders only for the local
// side; nothing here reads or writes anything under a real %APPDATA%\JARVIS.
//   node scripts/drive-backup-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BACKUP_ROOT_NAME, MANIFEST_NAME, makeBackupId, collectLocalFiles, validateManifest,
  runBackup, listBackups, previewRestore, applyRestore, verifyBackupIntegrity,
} from '../src/drive-backup.mjs';
import { knowledgePaths, writeKnowledgeNote, listKnowledgeNotes, listTrash, listSnapshots, deleteKnowledgeNote, noteRevision, saveKnowledgeNote, snapshotBeforeOverwrite } from '../src/knowledge.mjs';
import { FakeDriveProvider } from './fake-drive-provider.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${extra ? `\n     ${extra}` : ''}`); } };
const check = async (name, fn) => { try { await fn(); ok(true, name); } catch (e) { ok(false, name, String(e?.stack || e).split('\n').slice(0, 6).join('\n     ')); } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-drive-backup-'));
let n = 0;
const dir = () => { const d = path.join(TMP, `d${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
const note = (over = {}) => ({ id: `n${(++n).toString(36)}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`.slice(0, 20), title: 'T', created: 1000, updated: 2000, tags: [], favorite: false, body: 'hello', ...over });
let clock = 1700000000000;
const now = () => (clock += 1000);

function seedNotes(d, count) {
  const ids = [];
  for (let i = 0; i < count; i++) {
    const n1 = note({ body: `note number ${i}` });
    writeKnowledgeNote(d, n1);
    ids.push(n1.id);
  }
  return ids;
}

// ================================================================== collectLocalFiles: the allowlist

await check('an empty Knowledge store collects nothing - no error, no crash', () => {
  const d = dir();
  assert.deepEqual(collectLocalFiles(d), []);
});

await check('only notes/, trash/ and overwritten/ are ever read - nothing else under knowledge/, and nothing outside it', () => {
  const d = dir();
  seedNotes(d, 2);
  const { root } = knowledgePaths(d);
  fs.writeFileSync(path.join(root, '.migration-complete'), '{}');
  fs.writeFileSync(path.join(root, 'notes', 'not-a-note.txt'), 'should never be collected');
  fs.writeFileSync(path.join(d, 'config.json'), '{"secret":"nope"}');
  fs.writeFileSync(path.join(d, 'notes.json'), '[{"id":"legacy","text":"not knowledge"}]');
  fs.writeFileSync(path.join(d, 'github-token.bin'), Buffer.from('not real'));
  const files = collectLocalFiles(d);
  assert.equal(files.length, 2, 'exactly the two real notes, nothing else');
  assert.ok(files.every((f) => /^notes\//.test(f.relPath)));
});

await check('a symlinked "note" is excluded outright - lstat, never stat, is what makes this true', function symlinkTest() {
  const d = dir();
  seedNotes(d, 1);
  const { root } = knowledgePaths(d);
  const secretFile = path.join(TMP, 'outside-secret.md');
  fs.writeFileSync(secretFile, '---\nid: nope\n---\nshould never be backed up');
  const linkPath = path.join(root, 'notes', 'escape12345678901234.md');
  try { fs.symlinkSync(secretFile, linkPath, 'file'); }
  catch { this.skip = true; return; } // some CI/sandbox environments refuse symlink creation without a privilege - not this engine's concern to test around
  const files = collectLocalFiles(d);
  assert.ok(!files.some((f) => f.name === 'escape12345678901234.md'), 'the symlink is never collected');
  assert.equal(files.length, 1, 'only the one real note');
});

await check('a symlinked directory standing in for notes/ is never descended into', function symlinkDirTest() {
  const d = dir();
  const { root } = knowledgePaths(d);
  fs.mkdirSync(root, { recursive: true });
  const outsideDir = path.join(TMP, 'outside-dir');
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, 'secret12345678901234.md'), 'secret content');
  try { fs.symlinkSync(outsideDir, path.join(root, 'notes'), 'dir'); }
  catch { this.skip = true; return; }
  const files = collectLocalFiles(d);
  assert.deepEqual(files, [], 'the linked directory is never read through');
});

await check('a Version History snapshot made by an ordinary meaningful save (no force, no conflict) is collected exactly like any other snapshot', () => {
  const d = dir();
  const id = 'abc123';
  const v1 = saveKnowledgeNote(d, id, { title: 'T', body: 'version one', tags: [], favorite: false, folder: null }, { baseRevision: null });
  saveKnowledgeNote(d, id, { title: 'T', body: 'version two', tags: [], favorite: false, folder: null }, { baseRevision: v1.revision });
  const snaps = listSnapshots(d, id).snapshots;
  assert.equal(snaps.length, 1);
  const files = collectLocalFiles(d);
  const snapFile = files.find((f) => f.kind === 'snapshot');
  assert.ok(snapFile, 'the ordinary-save snapshot is in the backup allowlist, same as a force-overwrite snapshot');
  assert.equal(snapFile.relPath, `overwritten/${snaps[0].file}`);
});

// ================================================================== validateManifest: the security gate

await check('path traversal in a manifest entry is refused', () => {
  const bad = { schema: 1, files: [{ path: '../../evil.md', kind: 'note', size: 5, sha256: 'a'.repeat(64), driveFileId: 'x' }] };
  const r = validateManifest(bad);
  assert.equal(r.ok, false);
});
await check('a backslash-smuggled traversal attempt is refused', () => {
  const bad = { schema: 1, files: [{ path: 'notes/..\\..\\evil.md', kind: 'note', size: 5, sha256: 'a'.repeat(64), driveFileId: 'x' }] };
  assert.equal(validateManifest(bad).ok, false);
});
await check('a path claiming the wrong kind-prefix, or an absolute path, is refused', () => {
  assert.equal(validateManifest({ schema: 1, files: [{ path: 'trash/abc.md', kind: 'note', size: 1, sha256: 'a'.repeat(64), driveFileId: 'x' }] }).ok, false);
  assert.equal(validateManifest({ schema: 1, files: [{ path: 'C:/evil/abc.md', kind: 'note', size: 1, sha256: 'a'.repeat(64), driveFileId: 'x' }] }).ok, false);
});
await check('a duplicate manifest path is refused', () => {
  const entry = { path: 'notes/abc12345678901234567.md', kind: 'note', size: 1, sha256: 'a'.repeat(64), driveFileId: 'x' };
  assert.equal(validateManifest({ schema: 1, files: [entry, { ...entry, driveFileId: 'y' }] }).ok, false);
});
await check('two entries pointing at the same uploaded file id is refused', () => {
  const r = validateManifest({ schema: 1, files: [
    { path: 'notes/abc12345678901234567.md', kind: 'note', size: 1, sha256: 'a'.repeat(64), driveFileId: 'same' },
    { path: 'notes/def12345678901234567.md', kind: 'note', size: 1, sha256: 'b'.repeat(64), driveFileId: 'same' },
  ] });
  assert.equal(r.ok, false);
});
await check('a malformed hash, an unknown kind, or an unknown schema version is refused', () => {
  assert.equal(validateManifest({ schema: 1, files: [{ path: 'notes/abc12345678901234567.md', kind: 'note', size: 1, sha256: 'not-hex', driveFileId: 'x' }] }).ok, false);
  assert.equal(validateManifest({ schema: 1, files: [{ path: 'weird/abc12345678901234567.md', kind: 'weird', size: 1, sha256: 'a'.repeat(64), driveFileId: 'x' }] }).ok, false);
  assert.equal(validateManifest({ schema: 2, files: [] }).ok, false);
});
await check('an empty file list is refused - nothing to restore is not a valid backup', () => {
  assert.equal(validateManifest({ schema: 1, files: [] }).ok, false);
});
await check('a well-formed manifest is accepted, and normalized (hash lower-cased)', () => {
  const r = validateManifest({ schema: 1, backupId: 'x', createdAt: 5, files: [{ path: 'notes/abc12345678901234567.md', kind: 'note', size: 1, sha256: 'A'.repeat(64), driveFileId: 'x' }] });
  assert.equal(r.ok, true);
  assert.equal(r.manifest.files[0].sha256, 'a'.repeat(64));
});

// ================================================================== backup: empty store, valid complete backup

await check('backing up an empty store is refused plainly, not uploaded as a valid empty backup', async () => {
  const d = dir();
  const remote = new FakeDriveProvider();
  const r = await runBackup(d, remote, { now });
  assert.equal(r.ok, false);
  assert.match(r.error, /nothing/i);
  const listed = await listBackups(remote);
  assert.deepEqual(listed.backups, []);
});

await check('a valid, complete backup: every file verified, manifest published last, and the backup is then listed as complete', async () => {
  const d = dir();
  seedNotes(d, 5);
  const remote = new FakeDriveProvider();
  const r = await runBackup(d, remote, { now });
  assert.equal(r.ok, true);
  assert.equal(r.verified, 5);
  assert.deepEqual(r.failed, []);

  const root = await remote.findFolder(null, BACKUP_ROOT_NAME);
  assert.ok(root);
  const run = await remote.findFolder(root.id, r.backupId);
  assert.ok(run);
  const children = await remote.listChildren(run.id);
  assert.ok(children.some((c) => c.name === MANIFEST_NAME), 'the manifest exists in the run folder');

  const listed = await listBackups(remote);
  assert.equal(listed.backups.length, 1);
  assert.equal(listed.backups[0].complete, true);
  assert.equal(listed.backups[0].fileCount, 5);
});

await check('the manifest records real SHA-256 hashes that match the actual local file bytes', async () => {
  const d = dir();
  seedNotes(d, 2);
  const remote = new FakeDriveProvider();
  await runBackup(d, remote, { now });
  const listed = await listBackups(remote);
  const { createHash } = await import('node:crypto');
  for (const entry of listed.backups[0].manifest.files) {
    const bytes = fs.readFileSync(path.join(knowledgePaths(d).root, entry.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
  }
});

// ================================================================== corrupted source / uploaded file

await check('corrupted source file: one local file that cannot be read never aborts the whole backup - the rest still back up, and the bad one is reported', async () => {
  const d = dir();
  const ids = seedNotes(d, 3);
  const badFile = path.join(knowledgePaths(d).notesDir, `${ids[0]}.md`);
  fs.chmodSync(badFile, 0o000);
  const remote = new FakeDriveProvider();
  const r = await runBackup(d, remote, { now });
  fs.chmodSync(badFile, 0o644); // restore permissions so the temp dir can be cleaned up later
  if (process.platform === 'win32' && r.ok) { ok(true, '(chmod has no effect on this platform - skipping the meaningful half of this check)'); return; }
  assert.equal(r.ok, false);
  assert.equal(r.verified, 2);
  assert.equal(r.failed.length, 1);
});

await check('corrupted uploaded file: a bad transfer is caught by the post-upload read-back check, and the backup is not marked complete', async () => {
  const d = dir();
  seedNotes(d, 2);
  const remote = new FakeDriveProvider();
  remote.corruptNextUpload();
  const r = await runBackup(d, remote, { now });
  assert.equal(r.ok, false);
  assert.equal(r.failed.length, 1);
  const listed = await listBackups(remote);
  assert.equal(listed.backups.length, 1, 'the failed run still shows up (so it isn\'t a mystery), but...');
  assert.equal(listed.backups[0].complete, false, '...never as a complete, restorable backup - it has no manifest to be one');
});

// ================================================================== interrupted upload and retry; duplicate attempts

await check('interrupted upload and retry: a failed file is the only one retried, and the retry completes the backup', async () => {
  const d = dir();
  seedNotes(d, 4);
  const remote = new FakeDriveProvider();
  remote.failNextUpload(1);
  const id = makeBackupId(now);
  const r1 = await runBackup(d, remote, { backupId: id, now });
  assert.equal(r1.ok, false);
  assert.equal(r1.verified, 3);
  assert.equal(r1.failed.length, 1);

  const r2 = await runBackup(d, remote, { backupId: id, now }); // same backup id - a real retry, not a new backup
  assert.equal(r2.ok, true);
  assert.equal(r2.verified, 4);
  const listed = await listBackups(remote);
  assert.equal(listed.backups.length, 1, 'still one backup, not two - the retry resumed the same run');
});

await check('duplicate backup attempts at the same id, with nothing changed, cost no new uploads and stay idempotent', async () => {
  const d = dir();
  seedNotes(d, 3);
  const remote = new FakeDriveProvider();
  const id = makeBackupId(now);
  const r1 = await runBackup(d, remote, { backupId: id, now });
  assert.equal(r1.ok, true);
  const beforeFileCount = remote.files.size;
  const r2 = await runBackup(d, remote, { backupId: id, now });
  assert.equal(r2.ok, true);
  assert.equal(r2.verified, 3);
  // The manifest is re-uploaded (it always is, to finalize), but no new NOTE files are created.
  assert.equal(remote.files.size, beforeFileCount, 'no duplicate note files were created on the second, identical attempt');
});

await check('preservation of previous successful backups: a later, failing backup never touches an earlier, complete one', async () => {
  const d = dir();
  seedNotes(d, 2);
  const remote = new FakeDriveProvider();
  const firstId = makeBackupId(now);
  const r1 = await runBackup(d, remote, { backupId: firstId, now });
  assert.equal(r1.ok, true);
  const firstManifestBytesBefore = (await listBackups(remote)).backups[0];

  seedNotes(d, 1); // local state changes
  remote.corruptNextUpload(); // the second run will fail
  const secondId = makeBackupId(now);
  const r2 = await runBackup(d, remote, { backupId: secondId, now });
  assert.equal(r2.ok, false);

  const listed = await listBackups(remote);
  const complete = listed.backups.filter((b) => b.complete);
  assert.equal(complete.length, 1, 'the failed second run never became a listed, complete backup');
  assert.equal(complete[0].backupId, firstId);
  assert.equal(complete[0].fileCount, firstManifestBytesBefore.fileCount, 'the first backup\'s own manifest is untouched');
});

// ================================================================== restore: preview, conflicts, missing/incomplete

await check('restore preview is read-only and reports added/unchanged/replaced correctly, without writing anything', async () => {
  const d = dir();
  const ids = seedNotes(d, 3);
  const remote = new FakeDriveProvider();
  const backupId = makeBackupId(now);
  await runBackup(d, remote, { backupId, now });

  // Change one note locally, delete the local copy of knowledge entirely for a moment to prove "added" too.
  const changedId = ids[0];
  const rev = noteRevision(d, changedId);
  saveKnowledgeNote(d, changedId, { title: 'T', body: 'CHANGED AFTER BACKUP', tags: [], favorite: false, folder: null }, { baseRevision: rev });
  fs.unlinkSync(path.join(knowledgePaths(d).notesDir, `${ids[1]}.md`));

  const preview = await previewRestore(d, remote, backupId);
  assert.equal(preview.ok, true);
  assert.ok(preview.replaced.includes(`notes/${changedId}.md`));
  assert.ok(preview.added.includes(`notes/${ids[1]}.md`));
  assert.ok(preview.unchanged.includes(`notes/${ids[2]}.md`));
  assert.equal(listKnowledgeNotes(d).notes.find((x) => x.id === changedId).body, 'CHANGED AFTER BACKUP', 'preview wrote nothing');
  assert.equal(fs.existsSync(path.join(knowledgePaths(d).notesDir, `${ids[1]}.md`)), false, 'preview restored nothing');
});

await check('restoring reports a missing remote file plainly and does not write that one file, without aborting the rest', async () => {
  const d = dir();
  seedNotes(d, 2);
  const remote = new FakeDriveProvider();
  const backupId = makeBackupId(now);
  await runBackup(d, remote, { backupId, now });
  const listed = await listBackups(remote);
  const victimFileId = listed.backups[0].manifest.files[0].driveFileId;
  remote.files.delete(victimFileId); // deleted from Drive by hand, after the backup completed

  // Make both notes "missing" locally so both would be restored.
  for (const f of fs.readdirSync(knowledgePaths(d).notesDir)) fs.unlinkSync(path.join(knowledgePaths(d).notesDir, f));
  const r = await applyRestore(d, remote, backupId, { now });
  assert.equal(r.ok, false);
  assert.equal(r.failed.length, 1);
  assert.equal(r.written, 1, 'the other, still-present file was still restored');
});

await check('a backup folder with no manifest (an incomplete backup) is never offered for restore, and restoring it by id is refused', async () => {
  const d = dir();
  const remote = new FakeDriveProvider();
  const root = await remote.ensureFolder(null, BACKUP_ROOT_NAME);
  const id = makeBackupId(now);
  await remote.ensureFolder(root.id, id); // a run folder with nothing in it - as if interrupted before any file landed
  const listed = await listBackups(remote);
  assert.equal(listed.backups[0].complete, false);
  const r = await applyRestore(d, remote, id, { now });
  assert.equal(r.ok, false);
});

// ================================================================== restore conflicts, checkpoint, interrupted restore + recovery

await check('restore conflicts: a locally-changed note is checkpointed before being overwritten, and the checkpoint is recoverable through Version History', async () => {
  const d = dir();
  const ids = seedNotes(d, 2);
  const remote = new FakeDriveProvider();
  const backupId = makeBackupId(now);
  await runBackup(d, remote, { backupId, now });

  const changedId = ids[0];
  const rev = noteRevision(d, changedId);
  saveKnowledgeNote(d, changedId, { title: 'T', body: 'local edit after backup', tags: [], favorite: false, folder: null }, { baseRevision: rev });

  const r = await applyRestore(d, remote, backupId, { now });
  assert.equal(r.ok, true);
  assert.equal(r.checkpointed, 1);
  assert.equal(listKnowledgeNotes(d).notes.find((x) => x.id === changedId).body, 'note number 0', 'restored back to the backed-up content');
  const snaps = listSnapshots(d, changedId);
  assert.ok(snaps.snapshots.some((s) => s.body === 'local edit after backup'), 'the overwritten local edit is recoverable, not lost');
});

await check('never silently overwrites: an unchanged note is left alone by restore, not rewritten (and so not needlessly checkpointed either)', async () => {
  const d = dir();
  seedNotes(d, 2);
  const remote = new FakeDriveProvider();
  const backupId = makeBackupId(now);
  await runBackup(d, remote, { backupId, now });
  const r = await applyRestore(d, remote, backupId, { now });
  assert.equal(r.ok, true);
  assert.equal(r.unchanged, 2);
  assert.equal(r.written, 0);
  assert.equal(r.checkpointed, 0);
});

await check('interrupted restore and rollback: a failure partway through leaves earlier files written, and a retry finishes the rest without re-touching what already matches', async () => {
  const d = dir();
  const ids = seedNotes(d, 3);
  const remote = new FakeDriveProvider();
  const backupId = makeBackupId(now);
  await runBackup(d, remote, { backupId, now });
  for (const f of fs.readdirSync(knowledgePaths(d).notesDir)) fs.unlinkSync(path.join(knowledgePaths(d).notesDir, f)); // simulate "all gone, restoring from scratch"

  const listed = await listBackups(remote);
  const targetFileId = listed.backups[0].manifest.files[0].driveFileId;
  remote.failDownloadFor(targetFileId, 1); // one specific file's download fails (not the manifest's); the other two should still proceed
  const r1 = await applyRestore(d, remote, backupId, { now });
  assert.equal(r1.ok, false);
  assert.equal(r1.written, 2);
  assert.equal(r1.failed.length, 1);

  const r2 = await applyRestore(d, remote, backupId, { now }); // retry, no induced failure this time
  assert.equal(r2.ok, true);
  assert.equal(r2.written, 1, 'only the one still-missing file needed writing');
  assert.equal(r2.unchanged, 2, 'the two already-restored files were left alone, not re-downloaded');
  assert.equal(listKnowledgeNotes(d).notes.length, 3, 'all three are back, none duplicated');
  void ids;
});

await check('recovery checkpoint verification: checkpointing happens for every at-risk note before any of them are written, not interleaved one at a time', async () => {
  const d = dir();
  const ids = seedNotes(d, 3);
  const remote = new FakeDriveProvider();
  const backupId = makeBackupId(now);
  await runBackup(d, remote, { backupId, now });
  for (const id of ids) {
    const rev = noteRevision(d, id);
    saveKnowledgeNote(d, id, { title: 'T', body: `edited ${id}`, tags: [], favorite: false, folder: null }, { baseRevision: rev });
  }
  const r = await applyRestore(d, remote, backupId, { now });
  assert.equal(r.ok, true);
  assert.equal(r.checkpointed, 3);
  for (const id of ids) {
    const snaps = listSnapshots(d, id);
    assert.ok(snaps.snapshots.some((s) => s.body === `edited ${id}`), `${id}'s pre-restore edit is checkpointed`);
  }
});

await check('if a checkpoint cannot be made, the whole restore is refused before anything is written', async () => {
  const d = dir();
  const ids = seedNotes(d, 2);
  const remote = new FakeDriveProvider();
  const backupId = makeBackupId(now);
  await runBackup(d, remote, { backupId, now });
  const rev = noteRevision(d, ids[0]);
  saveKnowledgeNote(d, ids[0], { title: 'T', body: 'edited', tags: [], favorite: false, folder: null }, { baseRevision: rev });

  const flaky = { ...fs, writeFileSync: (p, data) => { if (String(p).includes('overwritten')) throw new Error('disk full'); return fs.writeFileSync(p, data); } };
  const r = await applyRestore(d, remote, backupId, { now, fsImpl: flaky });
  assert.equal(r.ok, false);
  assert.match(r.error, /checkpoint/);
  assert.equal(listKnowledgeNotes(d, { fsImpl: flaky }).notes.find((x) => x.id === ids[0]).body, 'edited', 'nothing was restored - the whole operation was refused up front');
});

await check('deleting a note (to Trash) after a backup, then restoring, brings the note back without disturbing Trash itself', async () => {
  const d = dir();
  const ids = seedNotes(d, 2);
  const remote = new FakeDriveProvider();
  const backupId = makeBackupId(now);
  await runBackup(d, remote, { backupId, now });
  deleteKnowledgeNote(d, ids[0], { baseRevision: noteRevision(d, ids[0]) });
  assert.equal(listKnowledgeNotes(d).notes.some((x) => x.id === ids[0]), false);

  const r = await applyRestore(d, remote, backupId, { now });
  assert.equal(r.ok, true);
  assert.ok(listKnowledgeNotes(d).notes.some((x) => x.id === ids[0]), 'restored back to notes/, not left in Trash');
});

// ================================================================== Phase 24C Part 6: restore safety review additions

await check('verifyBackupIntegrity: a fully intact backup verifies every file, without touching the local filesystem at all', async () => {
  const d = dir();
  seedNotes(d, 3);
  const remote = new FakeDriveProvider();
  const backupId = makeBackupId(now);
  await runBackup(d, remote, { backupId, now });
  const before = fs.readdirSync(knowledgePaths(d).notesDir).sort();
  const r = await verifyBackupIntegrity(remote, backupId);
  assert.equal(r.ok, true);
  assert.equal(r.verified, 3);
  assert.deepEqual(fs.readdirSync(knowledgePaths(d).notesDir).sort(), before, 'not one local file was touched by a pure integrity check');
});

await check('verifyBackupIntegrity: a corrupted remote file is caught - reported, never silently passed as intact', async () => {
  const d = dir();
  seedNotes(d, 2);
  const remote = new FakeDriveProvider();
  const backupId = makeBackupId(now);
  await runBackup(d, remote, { backupId, now });
  const listed = await listBackups(remote);
  const victim = listed.backups[0].manifest.files[0];
  remote.files.set(victim.driveFileId, { ...remote.files.get(victim.driveFileId), bytes: Buffer.from('corrupted') });
  const r = await verifyBackupIntegrity(remote, backupId);
  assert.equal(r.ok, false);
  assert.equal(r.failed.length, 1);
  assert.equal(r.verified, 1);
});

await check('verifyBackupIntegrity: an unknown backup id is refused the same way applyRestore refuses one', async () => {
  const remote = new FakeDriveProvider();
  const r = await verifyBackupIntegrity(remote, makeBackupId(now));
  assert.equal(r.ok, false);
});

await check('restore safety review: restoring over an existing, DIFFERENT Trash file quarantines the pre-restore copy - not just live notes', async () => {
  const d = dir();
  const ids = seedNotes(d, 1);
  deleteKnowledgeNote(d, ids[0], { baseRevision: noteRevision(d, ids[0]) });
  const remote = new FakeDriveProvider();
  const backupId = makeBackupId(now);
  await runBackup(d, remote, { backupId, now }); // backs up the Trash file as it is now

  // The local Trash file is changed by hand after the backup - restoring must not silently lose this.
  const trashFile = path.join(knowledgePaths(d).trashDir, `${ids[0]}.md`);
  const originalTrashBytes = fs.readFileSync(trashFile);
  fs.writeFileSync(trashFile, 'a different trash body written after the backup');

  const r = await applyRestore(d, remote, backupId, { now });
  assert.equal(r.ok, true);
  assert.ok(r.quarantined >= 1, 'at least the Trash file was quarantined');
  assert.deepEqual(fs.readFileSync(trashFile), originalTrashBytes, 'restored back to the backed-up Trash content');

  const quarantineFile = path.join(knowledgePaths(d).root, 'restore-recovery', backupId, 'trash', `${ids[0]}.md`);
  assert.ok(fs.existsSync(quarantineFile), 'a recovery copy exists');
  assert.equal(fs.readFileSync(quarantineFile, 'utf8'), 'a different trash body written after the backup', 'and it holds exactly the content that was about to be lost');
});

await check('restore safety review: restoring over an existing, DIFFERENT Version History snapshot quarantines the pre-restore copy too', async () => {
  const d = dir();
  const ids = seedNotes(d, 1);
  const snap = snapshotBeforeOverwrite(d, ids[0], { now });
  assert.equal(snap.ok, true);
  const remote = new FakeDriveProvider();
  const backupId = makeBackupId(now);
  await runBackup(d, remote, { backupId, now });

  const snapFile = path.join(knowledgePaths(d).overwrittenDir, path.basename(snap.file));
  const originalSnapBytes = fs.readFileSync(snapFile);
  fs.writeFileSync(snapFile, 'a different snapshot body written after the backup');

  const r = await applyRestore(d, remote, backupId, { now });
  assert.equal(r.ok, true);
  assert.deepEqual(fs.readFileSync(snapFile), originalSnapBytes);
  const quarantineFile = path.join(knowledgePaths(d).root, 'restore-recovery', backupId, 'overwritten', path.basename(snap.file));
  assert.equal(fs.readFileSync(quarantineFile, 'utf8'), 'a different snapshot body written after the backup');
});

await check('restore safety review: if even one file cannot be quarantined, the WHOLE restore is refused before anything is written - not just the checkpoint step', async () => {
  const d = dir();
  const ids = seedNotes(d, 2);
  const remote = new FakeDriveProvider();
  const backupId = makeBackupId(now);
  await runBackup(d, remote, { backupId, now });
  const rev = noteRevision(d, ids[0]);
  saveKnowledgeNote(d, ids[0], { title: 'T', body: 'edited locally after backup', tags: [], favorite: false, folder: null }, { baseRevision: rev });

  const flaky = { ...fs, mkdirSync: (p, opts) => { if (String(p).includes('restore-recovery')) throw new Error('disk full'); return fs.mkdirSync(p, opts); } };
  const r = await applyRestore(d, remote, backupId, { now, fsImpl: flaky });
  assert.equal(r.ok, false);
  assert.match(r.error, /protected/);
  assert.equal(listKnowledgeNotes(d, { fsImpl: flaky }).notes.find((x) => x.id === ids[0]).body, 'edited locally after backup', 'nothing was restored - the whole operation was refused up front');
});

await check('restore safety review: a file unchanged from the backup is neither checkpointed nor quarantined - nothing at risk, nothing to protect', async () => {
  const d = dir();
  const ids = seedNotes(d, 1);
  deleteKnowledgeNote(d, ids[0], { baseRevision: noteRevision(d, ids[0]) });
  const remote = new FakeDriveProvider();
  const backupId = makeBackupId(now);
  await runBackup(d, remote, { backupId, now });
  const r = await applyRestore(d, remote, backupId, { now }); // nothing changed locally since the backup
  assert.equal(r.ok, true);
  assert.equal(r.quarantined, 0);
  assert.equal(r.checkpointed, 0);
});

await check('ENFORCEMENT: applyRestore() itself verifies every file it will restore before writing ANY of them - not left to a caller to call verifyBackupIntegrity() first', async () => {
  const d = dir();
  const ids = seedNotes(d, 3);
  const remote = new FakeDriveProvider();
  const backupId = makeBackupId(now);
  await runBackup(d, remote, { backupId, now });
  for (const f of fs.readdirSync(knowledgePaths(d).notesDir)) fs.unlinkSync(path.join(knowledgePaths(d).notesDir, f));

  const order = [];
  const realDownload = remote.downloadFile.bind(remote);
  remote.downloadFile = async (id) => { order.push(`download:${id}`); return realDownload(id); };
  const flakyWrite = { ...fs, writeFileSync: (p, data) => { order.push(`write:${path.basename(String(p))}`); return fs.writeFileSync(p, data); } };

  const r = await applyRestore(d, remote, backupId, { now, fsImpl: flakyWrite });
  assert.equal(r.ok, true);
  assert.equal(r.written, 3);

  const lastDownloadIdx = order.map((e, i) => [e, i]).filter(([e]) => e.startsWith('download:')).at(-1)[1];
  const firstWriteIdx = order.findIndex((e) => e.startsWith('write:'));
  assert.ok(lastDownloadIdx < firstWriteIdx, `every download must finish before the first write starts - order was: ${order.join(', ')}`);
  void ids;
});

await check('ENFORCEMENT: a later file failing verification never un-writes or blocks an earlier file that verified fine - partial, resumable restore is preserved', async () => {
  const d = dir();
  const ids = seedNotes(d, 3);
  const remote = new FakeDriveProvider();
  const backupId = makeBackupId(now);
  await runBackup(d, remote, { backupId, now });
  for (const f of fs.readdirSync(knowledgePaths(d).notesDir)) fs.unlinkSync(path.join(knowledgePaths(d).notesDir, f));
  const listed = await listBackups(remote);
  const lastEntry = listed.backups[0].manifest.files.at(-1);
  remote.files.delete(lastEntry.driveFileId); // the last file to be processed is the one that fails

  const r = await applyRestore(d, remote, backupId, { now });
  assert.equal(r.ok, false);
  assert.equal(r.written, 2, 'the two files that verified fine were still restored');
  assert.equal(r.failed.length, 1);
  void ids;
});

// ================================================================== Phase 24D: progress reporting (for the backup/restore UI)

await check('runBackup: onProgress reports every file, ending at total/total, for real UI progress bars', async () => {
  const d = dir();
  seedNotes(d, 3);
  const remote = new FakeDriveProvider();
  const events = [];
  const r = await runBackup(d, remote, { now, onProgress: (e) => events.push(e) });
  assert.equal(r.ok, true);
  assert.ok(events.length >= 3);
  assert.ok(events.every((e) => e.phase === 'backup' && e.total === 3));
  assert.equal(events.at(-1).current, 3);
});

await check('applyRestore: onProgress reports a verify phase then a restore phase, each ending at its own total', async () => {
  const d = dir();
  seedNotes(d, 2);
  const remote = new FakeDriveProvider();
  const backupId = makeBackupId(now);
  await runBackup(d, remote, { backupId, now });
  for (const f of fs.readdirSync(knowledgePaths(d).notesDir)) fs.unlinkSync(path.join(knowledgePaths(d).notesDir, f));
  const events = [];
  const r = await applyRestore(d, remote, backupId, { now, onProgress: (e) => events.push(e) });
  assert.equal(r.ok, true);
  assert.ok(events.some((e) => e.phase === 'verify'));
  assert.ok(events.some((e) => e.phase === 'restore'));
});

await check('verifyBackupIntegrity: onProgress reports a verify phase for every manifest file', async () => {
  const d = dir();
  seedNotes(d, 2);
  const remote = new FakeDriveProvider();
  const backupId = makeBackupId(now);
  await runBackup(d, remote, { backupId, now });
  const events = [];
  await verifyBackupIntegrity(remote, backupId, { onProgress: (e) => events.push(e) });
  assert.equal(events.length, 2);
  assert.ok(events.every((e) => e.phase === 'verify' && e.total === 2));
});

console.log(`\ndrive-backup-test: ${pass} passed, ${fail} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exitCode = fail ? 1 : 0;
