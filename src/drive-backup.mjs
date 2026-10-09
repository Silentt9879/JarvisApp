// JARVIS Knowledge - Phase 24B: the Google Drive backup/restore ENGINE only. No Electron, no
// OAuth, no network client, and no real Google Drive call lives here - every remote operation
// goes through a `remote` provider the caller injects (see THE PROVIDER CONTRACT below), the
// same way every function in knowledge.mjs takes an injectable `fsImpl` instead of calling
// node:fs directly. scripts/fake-drive-provider.mjs is the in-memory stand-in this phase's
// tests drive against; a real Electron-side Drive client (Phase 24C+) is a second, separate
// module that implements this same contract and is never imported by this file.
//
// THE PROVIDER CONTRACT - five async methods, nothing else, every real Drive detail (auth,
// retries, rate limits, HTTP) hidden behind it:
//   findFolder(parentId, name)      -> { id, name } | null         (read-only; never creates)
//   ensureFolder(parentId, name)    -> { id, name, created }       (find-or-create, idempotent)
//   listChildren(folderId)          -> [{ id, name, kind: 'file'|'folder', size }]
//   uploadFile(folderId, name, bytes) -> { id, name, size }
//   downloadFile(id)                -> Buffer
// `parentId: null` means "the app's own backup root" - this engine never asks a provider for
// anything outside the one folder tree it created, matching drive.file's own per-file grant
// model (see docs/jarvis-google-drive-design.md §5.1): it only ever names folders/files it
// made itself, never a path, a user's existing file, or anyone else's folder id.
//
// WHAT THIS FILE NEVER DOES: read a note's content and trust it without re-hashing it itself;
// write a file to notes/trash/overwritten without the atomic temp-then-rename pattern every
// other write in knowledge.mjs already uses; follow a symlink; accept a manifest path that
// isn't exactly `<kind>/<id-shaped-filename>.md`; or mark a backup complete before every one
// of its files has been uploaded AND read back AND hash-verified.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { knowledgePaths, snapshotBeforeOverwrite } from './knowledge.mjs';

export const BACKUP_SCHEMA = 1;
export const BACKUP_ROOT_NAME = 'JARVIS Knowledge Backups';
export const MANIFEST_NAME = 'manifest.json';

// The explicit, narrow allowlist (design requirement 4): nothing under <userData> is ever
// read for a backup except these three knowledge/ subfolders - not config.json, not any
// *.bin token file, not notes.json, not the migration marker, not jarvis.log, not models/.
const KIND_DIR = { note: 'notes', trash: 'trash', snapshot: 'overwritten' };
const KINDS = Object.keys(KIND_DIR);
const NOTE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.md$/;
const SNAPSHOT_FILENAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.\d+\.md$/;
const KIND_FILENAME = { note: NOTE_FILENAME, trash: NOTE_FILENAME, snapshot: SNAPSHOT_FILENAME };
const BACKUP_ID = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/;

const within = (child, parent) => {
  const a = path.resolve(child).toLowerCase();
  const b = path.resolve(parent).toLowerCase();
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
};

const hashBytes = (buf) => createHash('sha256').update(buf).digest('hex');

/** A fresh backup id: sortable, Drive-folder-name-safe, and collision-proof enough that two
 *  backups started in the same second never fight over one folder. Also the one thing a
 *  caller needs to keep to retry an interrupted backup into the SAME folder (see runBackup). */
export function makeBackupId(now = () => Date.now()) {
  const d = new Date(now());
  const stamp = d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${stamp}-${randomBytes(4).toString('hex')}`;
}

// ------------------------------------------------------------------ local side: what gets backed up

/**
 * Every file the explicit allowlist covers, read directly off disk - never through a
 * symlink. `fsImpl.lstatSync` (not `statSync`) is what makes that true: a symlink reports
 * `isSymbolicLink()` there, where a followed `statSync` would instead quietly describe
 * whatever the link points at - so a note replaced by a link to some other file on the PC
 * is excluded outright here, never opened, never read, never backed up.
 */
export function collectLocalFiles(userDir, { fsImpl = fs } = {}) {
  const { root } = knowledgePaths(userDir);
  const out = [];
  for (const kind of KINDS) {
    const dirName = KIND_DIR[kind];
    const dir = path.join(root, dirName);
    let dirStat;
    try { dirStat = fsImpl.lstatSync(dir); } catch { continue; } // doesn't exist yet (e.g. no Trash) - nothing to collect, not an error
    if (!dirStat.isDirectory()) continue; // a file or a symlink sitting where a folder should be - skip it, never descend through it
    let names;
    try { names = fsImpl.readdirSync(dir); } catch { continue; }
    for (const name of names.sort()) {
      if (!KIND_FILENAME[kind].test(name)) continue; // only real note/snapshot filenames - a stray manifest.json or marker file is never swept in
      const full = path.join(dir, name);
      if (!within(full, dir)) continue; // belt and braces - readdirSync can't actually produce this, but the check costs nothing
      let st;
      try { st = fsImpl.lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink() || !st.isFile()) continue;
      out.push({ kind, name, relPath: `${dirName}/${name}`, full, size: st.size });
    }
  }
  return out;
}

// ------------------------------------------------------------------ the manifest: built, and validated on the way back in

function buildManifestEntry(f, remoteFile, sha256) {
  return { path: f.relPath, kind: f.kind, size: f.size, sha256, driveFileId: remoteFile.id };
}

/**
 * The one gate every manifest - whether freshly built here or downloaded from Drive during a
 * restore - must pass before a single byte of it is trusted. Rejects: a path that isn't
 * exactly `<kind>/<id-shaped-filename>.md` (no `..`, no absolute path, no backslash, no
 * extra segments - the filename charset itself cannot spell a traversal sequence), a kind
 * this engine doesn't know, a malformed or wrong-length hash, a duplicate path, and a
 * duplicate Drive file id (two manifest entries secretly pointing at the same uploaded
 * bytes, which would make a restore apply one file's content under two different names).
 */
export function validateManifest(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'The backup manifest is not readable data.' };
  if (raw.schema !== BACKUP_SCHEMA) return { ok: false, error: `This backup's format (schema ${raw.schema}) is not one this version of JARVIS understands.` };
  if (!Array.isArray(raw.files)) return { ok: false, error: 'The backup manifest has no file list.' };
  if (raw.files.length === 0) return { ok: false, error: 'The backup manifest lists no files - nothing to restore.' };

  const seenPath = new Set();
  const seenFileId = new Set();
  const files = [];
  for (const f of raw.files) {
    if (!f || typeof f !== 'object') return { ok: false, error: 'A manifest entry is not readable data.' };
    const { path: p, kind, size, sha256, driveFileId } = f;
    if (typeof kind !== 'string' || !KINDS.includes(kind)) return { ok: false, error: `A manifest entry names an unknown kind ("${kind}").` };
    if (typeof p !== 'string') return { ok: false, error: 'A manifest entry has no path.' };
    const expectedPrefix = `${KIND_DIR[kind]}/`;
    if (!p.startsWith(expectedPrefix) || p.includes('\\') || p.includes('..')) return { ok: false, error: `"${p}" is not a usable backup path.` };
    const filename = p.slice(expectedPrefix.length);
    if (!filename || filename.includes('/') || !KIND_FILENAME[kind].test(filename)) return { ok: false, error: `"${p}" is not a usable backup path.` };
    if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return { ok: false, error: `"${p}" has an unusable size.` };
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(sha256)) return { ok: false, error: `"${p}" has an unusable hash.` };
    if (typeof driveFileId !== 'string' || !driveFileId) return { ok: false, error: `"${p}" has no Drive file reference.` };
    if (seenPath.has(p)) return { ok: false, error: `"${p}" appears twice in the manifest.` };
    if (seenFileId.has(driveFileId)) return { ok: false, error: `Two manifest entries point at the same uploaded file.` };
    seenPath.add(p);
    seenFileId.add(driveFileId);
    files.push({ path: p, kind, size, sha256: sha256.toLowerCase(), driveFileId });
  }
  return { ok: true, manifest: { schema: raw.schema, backupId: String(raw.backupId || ''), createdAt: Number(raw.createdAt) || 0, files } };
}

// ------------------------------------------------------------------ backup (upload)

/**
 * Back up every file the allowlist covers into its own new or resumed Drive folder, verifying
 * each one by downloading it back and hash-comparing before it is ever counted as done, and
 * publishing manifest.json - the one thing that makes a backup restorable at all - only once
 * every file has passed that check. A file that fails verification is retried once (a fresh
 * upload, then re-verified) and, failing that, is reported and the whole run is left
 * incomplete - never finished with a gap silently left in it.
 *
 * Safe to call again with the same `backupId` after any interruption: a file already present
 * in the run's Drive folder, at the expected size, is downloaded and hash-checked rather than
 * re-uploaded (saving the upload, never the verification), so a resumed run only spends new
 * upload bandwidth on what is actually still missing or still wrong.
 */
export async function runBackup(userDir, remote, { backupId, now = () => Date.now(), fsImpl = fs, log = () => {} } = {}) {
  const id = backupId || makeBackupId(now);
  if (!BACKUP_ID.test(id)) return { ok: false, error: `"${id}" is not a usable backup id.` };

  const files = collectLocalFiles(userDir, { fsImpl });
  if (!files.length) return { ok: false, backupId: id, total: 0, verified: 0, failed: [], error: 'There is nothing in Knowledge to back up yet.' };

  const root = await remote.ensureFolder(null, BACKUP_ROOT_NAME);
  const run = await remote.ensureFolder(root.id, id);
  const kindFolders = {};
  for (const kind of KINDS) kindFolders[kind] = await remote.ensureFolder(run.id, KIND_DIR[kind]);

  const existingByKind = {};
  for (const kind of KINDS) {
    const children = await remote.listChildren(kindFolders[kind].id);
    existingByKind[kind] = new Map(children.filter((c) => c.kind === 'file').map((c) => [c.name, c]));
  }

  const manifestFiles = [];
  const failed = [];
  for (const f of files) {
    let bytes;
    try { bytes = fsImpl.readFileSync(f.full); }
    catch (e) { failed.push({ path: f.relPath, error: `could not read the local file: ${e?.message || e}` }); continue; }
    const sha256 = hashBytes(bytes);
    let remoteFile = existingByKind[f.kind].get(f.name);
    let verified = false;

    if (remoteFile && remoteFile.size === f.size) {
      try { verified = hashBytes(await remote.downloadFile(remoteFile.id)) === sha256; } catch { verified = false; }
    }
    if (!verified) {
      try {
        remoteFile = await remote.uploadFile(kindFolders[f.kind].id, f.name, bytes);
        verified = hashBytes(await remote.downloadFile(remoteFile.id)) === sha256;
      } catch (e) {
        failed.push({ path: f.relPath, error: String(e?.message || e) });
        continue;
      }
    }
    if (!verified) { failed.push({ path: f.relPath, error: 'uploaded, but did not read back the same bytes' }); continue; }
    manifestFiles.push(buildManifestEntry(f, remoteFile, sha256));
  }

  if (failed.length) {
    log(`backup ${id}: ${failed.length} of ${files.length} file(s) failed verification - not marking complete`);
    return { ok: false, backupId: id, total: files.length, verified: manifestFiles.length, failed, error: 'Some files could not be backed up and verified.' };
  }

  const manifest = { schema: BACKUP_SCHEMA, backupId: id, createdAt: now(), files: manifestFiles };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
  const manifestUpload = await remote.uploadFile(run.id, MANIFEST_NAME, manifestBytes);
  const manifestVerified = hashBytes(await remote.downloadFile(manifestUpload.id)) === hashBytes(manifestBytes);
  if (!manifestVerified) return { ok: false, backupId: id, total: files.length, verified: manifestFiles.length, failed: [{ path: MANIFEST_NAME, error: 'did not read back the same bytes' }], error: 'The backup\'s own manifest could not be verified - not marking complete.' };

  log(`backup ${id}: ${manifestFiles.length} file(s) verified and complete`);
  return { ok: true, backupId: id, total: files.length, verified: manifestFiles.length, failed: [] };
}

// ------------------------------------------------------------------ listing (read-only)

/**
 * Every backup this app has ever made, newest first - read-only: nothing here creates the
 * root folder if it doesn't exist yet, and nothing downloads a note's content, only its
 * manifest. A run with no manifest.json (interrupted mid-backup) or a manifest that fails
 * validateManifest is reported as `complete: false` and is never offered as restorable.
 */
export async function listBackups(remote) {
  const root = await remote.findFolder(null, BACKUP_ROOT_NAME);
  if (!root) return { ok: true, backups: [] };
  const runs = (await remote.listChildren(root.id)).filter((c) => c.kind === 'folder');
  const out = [];
  for (const run of runs) {
    const children = await remote.listChildren(run.id);
    const manifestEntry = children.find((c) => c.kind === 'file' && c.name === MANIFEST_NAME);
    if (!manifestEntry) { out.push({ backupId: run.name, folderId: run.id, complete: false, error: 'No manifest - an interrupted or still-running backup.' }); continue; }
    let raw;
    try { raw = JSON.parse((await remote.downloadFile(manifestEntry.id)).toString('utf8')); }
    catch (e) { out.push({ backupId: run.name, folderId: run.id, complete: false, error: `The manifest could not be read: ${e?.message || e}` }); continue; }
    const v = validateManifest(raw);
    if (!v.ok) { out.push({ backupId: run.name, folderId: run.id, complete: false, error: v.error }); continue; }
    out.push({ backupId: run.name, folderId: run.id, complete: true, createdAt: v.manifest.createdAt, fileCount: v.manifest.files.length, manifest: v.manifest });
  }
  return { ok: true, backups: out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)) };
}

// ------------------------------------------------------------------ restore preview (read-only)

function localFileState(userDir, entry, { fsImpl }) {
  const { root } = knowledgePaths(userDir);
  const full = path.join(root, entry.path);
  const dir = path.join(root, KIND_DIR[entry.kind]);
  if (!within(full, dir)) return { exists: false, matches: false }; // defence in depth; validateManifest already guarantees this
  let bytes;
  try { bytes = fsImpl.readFileSync(full); } catch { return { exists: false, matches: false, full }; }
  return { exists: true, matches: hashBytes(bytes) === entry.sha256, full };
}

/**
 * What applying this backup WOULD do, without doing any of it: for every file in its
 * manifest, whether it would be added (nothing local with that name), left alone (local
 * content already matches, byte for byte), or replaced (local content exists and differs) -
 * named explicitly, the same three words `previewMigration` already uses for the same reason.
 */
export async function previewRestore(userDir, remote, backupId, { fsImpl = fs } = {}) {
  const found = await findBackup(remote, backupId);
  if (!found.ok) return found;
  const { manifest } = found;
  const added = [];
  const unchanged = [];
  const replaced = [];
  for (const entry of manifest.files) {
    const state = localFileState(userDir, entry, { fsImpl });
    if (!state.exists) added.push(entry.path);
    else if (state.matches) unchanged.push(entry.path);
    else replaced.push(entry.path);
  }
  return { ok: true, backupId: manifest.backupId, createdAt: manifest.createdAt, total: manifest.files.length, added, unchanged, replaced };
}

async function findBackup(remote, backupId) {
  if (!BACKUP_ID.test(String(backupId || ''))) return { ok: false, error: `"${backupId}" is not a usable backup id.` };
  const root = await remote.findFolder(null, BACKUP_ROOT_NAME);
  if (!root) return { ok: false, error: 'There are no backups yet.' };
  const run = await remote.findFolder(root.id, backupId);
  if (!run) return { ok: false, error: 'That backup could not be found.' };
  const children = await remote.listChildren(run.id);
  const manifestEntry = children.find((c) => c.kind === 'file' && c.name === MANIFEST_NAME);
  if (!manifestEntry) return { ok: false, error: 'That backup has no manifest - it is incomplete and cannot be restored.' };
  let raw;
  try { raw = JSON.parse((await remote.downloadFile(manifestEntry.id)).toString('utf8')); }
  catch (e) { return { ok: false, error: `The manifest could not be read: ${e?.message || e}` }; }
  const v = validateManifest(raw);
  if (!v.ok) return { ok: false, error: v.error };
  return { ok: true, manifest: v.manifest };
}

// ------------------------------------------------------------------ restore safety review (Phase 24C, Part 6)

/**
 * Download and hash-verify EVERY file a backup's manifest lists, without touching the local
 * filesystem at all - the "is this backup actually fully intact and restorable" check a
 * restore UI must run, and must refuse to offer Restore over, before applyRestore() ever
 * writes a single local file. Complements applyRestore()'s own per-file verification (which
 * happens immediately before each file's own write) with a whole-backup check a caller can
 * run first, on its own, as many times as it likes - this makes no local change whatsoever.
 */
/** Shared by verifyBackupIntegrity() and applyRestore()'s own internal verification pass -
 *  one file, downloaded and hash-checked against the manifest. Never writes anything. */
async function downloadAndVerify(remote, entry) {
  let bytes;
  try { bytes = await remote.downloadFile(entry.driveFileId); }
  catch (e) { return { ok: false, error: String(e?.message || e) }; }
  if (hashBytes(bytes) !== entry.sha256) return { ok: false, error: 'downloaded content does not match the backup\'s recorded hash' };
  return { ok: true, bytes };
}

export async function verifyBackupIntegrity(remote, backupId) {
  const found = await findBackup(remote, backupId);
  if (!found.ok) return found;
  const { manifest } = found;
  const failed = [];
  for (const entry of manifest.files) {
    const r = await downloadAndVerify(remote, entry);
    if (!r.ok) failed.push({ path: entry.path, error: r.error });
  }
  return { ok: failed.length === 0, backupId: manifest.backupId, total: manifest.files.length, verified: manifest.files.length - failed.length, failed };
}

/**
 * A verbatim copy of whatever is about to be overwritten, for every kind - not only live notes
 * (which already get a real Version History entry via snapshotBeforeOverwrite). A Trash or
 * Version History file restore would replace has no "current version" slot of its own to
 * checkpoint into, so this gives it the same guarantee a different way: the exact pre-restore
 * bytes, under this one backup's own recovery folder, never touched by anything else JARVIS
 * does. Written BEFORE any real restore write, same as the note checkpoint loop - if copying
 * even one of them fails, the whole restore is refused before anything changes.
 */
function quarantineDir(root, backupId) { return path.join(root, 'restore-recovery', backupId); }

function quarantineBeforeOverwrite(root, backupId, entry, { fsImpl }) {
  const dir = quarantineDir(root, backupId);
  const sub = path.join(dir, KIND_DIR[entry.kind]);
  const filename = path.basename(entry.path);
  const target = path.join(sub, filename);
  if (!within(target, sub)) return { ok: false, error: 'not a usable recovery path' };
  const source = path.join(root, entry.path);
  let bytes;
  try { bytes = fsImpl.readFileSync(source); } catch (e) { return { ok: false, error: `could not read the current file to protect it: ${e?.message || e}` }; }
  try {
    fsImpl.mkdirSync(sub, { recursive: true });
    const tmp = `${target}.tmp`;
    fsImpl.writeFileSync(tmp, bytes);
    fsImpl.renameSync(tmp, target);
  } catch (e) { return { ok: false, error: `could not save a recovery copy: ${e?.message || e}` }; }
  return { ok: true };
}

// ------------------------------------------------------------------ restore (apply)

/**
 * Apply a backup: for every file it would replace, TWO recovery copies are made FIRST, before
 * a single file is written - a real Version History entry for a live note
 * (`snapshotBeforeOverwrite`, the exact function an "Overwrite anyway" save already uses), AND
 * a verbatim quarantine copy for every kind including Trash and Version History entries
 * themselves (`quarantineBeforeOverwrite` - Phase 24C's own safety review found these had no
 * recovery path before). If protecting even one of them fails, the whole restore is refused
 * before anything changes. Every file is then downloaded and its hash checked against the
 * manifest before it is written, through the same atomic temp-then-rename-then-verify pattern
 * every write in knowledge.mjs already uses, so the previous local file is never even
 * momentarily gone - it is either still fully there, or already fully replaced, never caught
 * in between.
 *
 * A caller that wants the WHOLE backup's integrity confirmed before touching anything locally
 * (not just each file right before its own write) should call verifyBackupIntegrity() first -
 * a restore UI must do this and refuse to offer Restore over a backup it reports as failing.
 *
 * Resumable: a file whose local content already matches the manifest (because a previous,
 * interrupted attempt already wrote it) is left alone, not re-downloaded, re-written, or
 * re-quarantined - there is nothing further to protect it from on a retry.
 */
export async function applyRestore(userDir, remote, backupId, { fsImpl = fs, now = () => Date.now() } = {}) {
  const found = await findBackup(remote, backupId);
  if (!found.ok) return found;
  const { manifest } = found;
  const { root } = knowledgePaths(userDir);

  // Phase 1 - verify EVERY file this run would actually need to restore, in full, before a
  // single local file is touched (not just immediately before that one file's own write).
  // This is the same check verifyBackupIntegrity() offers standalone, now enforced here
  // unconditionally rather than left for a caller to remember to run first - a whole-backup
  // guarantee, not only a per-file one. A file whose local copy already matches is left out
  // of this pass entirely: nothing is at risk for it, so there is nothing to verify or write.
  const unchanged = [];
  const toRestore = [];
  const replacing = new Set(); // paths of entries that overwrite an existing local file - the only ones needing a recovery copy
  const failed = [];
  const verifiedBytes = new Map(); // entry.path -> downloaded, hash-checked bytes
  for (const entry of manifest.files) {
    const state = localFileState(userDir, entry, { fsImpl });
    if (state.exists && state.matches) { unchanged.push(entry.path); continue; }
    const v = await downloadAndVerify(remote, entry);
    if (!v.ok) { failed.push({ path: entry.path, error: v.error }); continue; }
    verifiedBytes.set(entry.path, v.bytes);
    toRestore.push(entry);
    if (state.exists) replacing.add(entry.path); // existed locally with different content - "added" (never existed) entries need no recovery copy
  }

  // Phase 2 - recovery copies, only for entries actually replacing an existing local file - a
  // file that failed verification is never written, so there is nothing to protect it from,
  // and a brand-new "added" file has no prior local content worth protecting either.
  const toCheckpoint = toRestore.filter((entry) => entry.kind === 'note' && replacing.has(entry.path)); // a real Version History entry, in addition to the quarantine copy below
  const toQuarantine = toRestore.filter((entry) => replacing.has(entry.path)); // every kind, including notes - belt and suspenders
  for (const entry of toCheckpoint) {
    const id = path.basename(entry.path, '.md');
    const snap = snapshotBeforeOverwrite(userDir, id, { fsImpl, now });
    if (!snap.ok) return { ok: false, error: `The current version of "${id}" could not be safely checkpointed, so nothing was restored: ${snap.error}` };
  }
  for (const entry of toQuarantine) {
    const q = quarantineBeforeOverwrite(root, manifest.backupId, entry, { fsImpl });
    if (!q.ok) return { ok: false, error: `"${entry.path}" could not be safely protected before restoring over it, so nothing was restored: ${q.error}` };
  }

  // Phase 3 - write, from the bytes Phase 1 already downloaded and verified (never re-fetched).
  const written = [];
  for (const entry of toRestore) {
    const bytes = verifiedBytes.get(entry.path);
    const dir = path.join(root, KIND_DIR[entry.kind]);
    const target = path.join(root, entry.path);
    if (!within(target, dir)) { failed.push({ path: entry.path, error: 'not a usable restore path' }); continue; }
    try { fsImpl.mkdirSync(dir, { recursive: true }); } catch (e) { failed.push({ path: entry.path, error: `could not prepare the folder: ${e?.message || e}` }); continue; }
    const tmp = `${target}.${process.pid}.${now()}.tmp`;
    try {
      fsImpl.writeFileSync(tmp, bytes);
      fsImpl.renameSync(tmp, target);
      const back = fsImpl.readFileSync(target);
      if (hashBytes(back) !== entry.sha256) throw new Error('did not read back the same bytes');
    } catch (e) {
      try { fsImpl.rmSync?.(tmp, { force: true }); } catch { /* best effort */ }
      failed.push({ path: entry.path, error: String(e?.message || e) });
      continue;
    }
    written.push(entry.path);
  }

  return { ok: failed.length === 0, backupId: manifest.backupId, total: manifest.files.length, written: written.length, unchanged: unchanged.length, failed, checkpointed: toCheckpoint.length, quarantined: toQuarantine.length };
}
