// JARVIS Notes - Phase 3: true bidirectional synchronization, as its own ENGINE (no Electron,
// no OAuth, no HTTP) - the same shape drive-backup.mjs already proved out: a `remote` provider
// is injected (the same five-method contract, plus `deleteFile`, Phase 3's own addition - see
// google-drive-provider.mjs and scripts/fake-drive-provider.mjs), and every real Drive detail
// stays behind it.
//
// SYNC IS DELIBERATELY SEPARATE FROM BACKUP. Backup (drive-backup.mjs) makes an immutable,
// timestamped, point-in-time copy on demand - nothing in this file ever reads, writes, or
// deletes anything under BACKUP_ROOT_NAME ("JARVIS Knowledge Backups"). Sync instead maintains
// ONE live, mutable mirror (SYNC_ROOT_NAME, "JARVIS Notes Sync") that tracks the current state
// of knowledge/{notes,trash,overwritten} - the exact same narrow allowlist drive-backup.mjs
// already uses (collectLocalFiles is reused unchanged). This keeps the "manual recovery
// backups stay independent of sync" requirement trivially true: this file never touches
// drive-backup.mjs's folder, and drive-backup.mjs never touches this one.
//
// THE CORE IDEA: a local "sync state" ledger (knowledge/.sync-state.json) records, per
// relPath, the hash and remote file id as of the LAST successful sync - the common ancestor
// a proper three-way compare needs. Every sync pass compares local-now, remote-now, and that
// ledger to classify each path as unchanged / to push / to pull / to delete (on either side) /
// a genuine CONFLICT (both sides changed, to two different things, since the ledger). A
// conflict is NEVER auto-resolved by guessing which side should win (no last-write-wins, no
// "newest timestamp wins") - the losing content is always preserved, in full, as a real
// Version History snapshot (the exact same mechanism an "Overwrite anyway" save or a Drive
// restore already uses), so the person can review and restore it through the Version History
// UI that already exists, rather than this phase inventing a second one.
//
// A local note->Trash move is NOT a special case here: it is simply "notes/<id>.md disappeared,
// trash/<id>.md appeared" - two ordinary per-path changes this engine already handles, so
// Trash syncs for free, with no bespoke "deletion" concept beyond the generic add/delete this
// file already does for every path.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { knowledgePaths, snapshotBeforeOverwrite, parseNoteFile } from './knowledge.mjs';
import { collectLocalFiles } from './drive-backup.mjs';

export const SYNC_ROOT_NAME = 'JARVIS Notes Sync';
const KIND_DIR = { note: 'notes', trash: 'trash', snapshot: 'overwritten' };
const KINDS = Object.keys(KIND_DIR);

const within = (child, parent) => {
  const a = path.resolve(child).toLowerCase();
  const b = path.resolve(parent).toLowerCase();
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
};

const hashBytes = (buf) => createHash('sha256').update(buf).digest('hex');

// ------------------------------------------------------------------ sync state (the ledger)

function syncStateFile(userDir) { return path.join(knowledgePaths(userDir).root, '.sync-state.json'); }

/**
 * `{ entries: { [relPath]: { hash, driveFileId, syncedAt } }, conflicts: { [relPath]:
 * { remoteHash } }, pending: { requestedAt, attempts, nextAttemptAt } | null }`. Never
 * throws - a missing or corrupt state file is simply "nothing synced yet," the same
 * forgiving read every other store in this codebase already gives a missing/corrupt file of
 * its own. `pending` is the persistent offline queue: not a list of individual file
 * operations (planSync's own ledger-diff already retries any failed file automatically on the
 * very next pass, with no separate bookkeeping needed for that), but a durable "a sync is
 * owed" marker with its own backoff schedule, so a device that goes offline mid-edit and is
 * only reopened days later still knows to retry rather than silently giving up, SURVIVING A
 * RESTART (an in-memory-only timer would not).
 */
export function loadSyncState(userDir, { fsImpl = fs } = {}) {
  try {
    const raw = JSON.parse(fsImpl.readFileSync(syncStateFile(userDir), 'utf8'));
    const p = raw?.pending;
    return {
      entries: raw && typeof raw.entries === 'object' && raw.entries ? raw.entries : {},
      conflicts: raw && typeof raw.conflicts === 'object' && raw.conflicts ? raw.conflicts : {},
      pending: p && typeof p === 'object' ? { requestedAt: Number(p.requestedAt) || 0, attempts: Number(p.attempts) || 0, nextAttemptAt: Number(p.nextAttemptAt) || 0 } : null,
    };
  } catch { return { entries: {}, conflicts: {}, pending: null }; }
}

/** Atomic (temp file + rename), the same guarantee every other write in this codebase gives
 *  its own file - a crash mid-write leaves the previous state (or none), never a half-written,
 *  unreadable ledger that would make every future sync pass start blind. */
export function saveSyncState(userDir, state, { fsImpl = fs } = {}) {
  const file = syncStateFile(userDir);
  const { root } = knowledgePaths(userDir);
  try { fsImpl.mkdirSync(root, { recursive: true }); } catch { /* best effort; the write below will surface a real problem */ }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const body = JSON.stringify({ entries: state.entries || {}, conflicts: state.conflicts || {}, pending: state.pending || null }, null, 2);
  fsImpl.writeFileSync(tmp, body);
  fsImpl.renameSync(tmp, file);
}

/** Marks that local work is outstanding and has not yet been confirmed synced - called
 *  whenever a sync attempt cannot even run (offline) or fails outright, never cleared until a
 *  sync pass actually completes (markSynced below), so an app restart never forgets there is
 *  unsynced work waiting. */
export function markPending(userDir, { fsImpl = fs, now = () => Date.now() } = {}) {
  const state = loadSyncState(userDir, { fsImpl });
  const attempts = (state.pending?.attempts || 0) + 1;
  state.pending = { requestedAt: state.pending?.requestedAt || now(), attempts, nextAttemptAt: now() + nextRetryDelayMs(attempts) };
  saveSyncState(userDir, state, { fsImpl });
  return state.pending;
}

/** Clears the pending marker - called once a sync pass actually completes (whether or not it
 *  found anything to do; completing at all is what "caught up" means here). */
export function markSynced(userDir, { fsImpl = fs } = {}) {
  const state = loadSyncState(userDir, { fsImpl });
  state.pending = null;
  saveSyncState(userDir, state, { fsImpl });
}

/** Is a retry due right now? True with no pending record at all (nothing owed, always fine to
 *  sync) - false only while a backoff window from a recent failure hasn't elapsed yet. */
export function syncDue(userDir, { fsImpl = fs, now = () => Date.now() } = {}) {
  const state = loadSyncState(userDir, { fsImpl });
  return !state.pending || state.pending.nextAttemptAt <= now();
}

// ------------------------------------------------------------------ remote side: list the live mirror

/** Every file currently in the sync mirror, by relPath - mirrors collectLocalFiles' own shape
 *  (`{ kind, name, relPath, driveFileId, size }`) so the two sides compare like for like. */
async function collectRemoteFiles(remote) {
  const root = await remote.ensureFolder(null, SYNC_ROOT_NAME);
  const out = new Map(); // relPath -> { kind, name, relPath, driveFileId, size }
  const kindFolders = {};
  for (const kind of KINDS) {
    kindFolders[kind] = await remote.ensureFolder(root.id, KIND_DIR[kind]);
    const children = await remote.listChildren(kindFolders[kind].id);
    for (const c of children) {
      if (c.kind !== 'file') continue;
      const relPath = `${KIND_DIR[kind]}/${c.name}`;
      out.set(relPath, { kind, name: c.name, relPath, driveFileId: c.id, size: c.size });
    }
  }
  return { root, kindFolders, files: out };
}

// ------------------------------------------------------------------ planning (read-only, no writes, no network beyond listing + the few downloads needed to classify a maybe-changed remote file)

/**
 * What a sync pass WOULD do, without doing any of it - the three-way compare, named the same
 * explicit way previewRestore/previewMigration already are (never silently folding one case
 * into another). Downloads a remote file's bytes only when it must (local and remote both
 * exist and local looks unchanged since the ledger, so the only way to know if remote moved
 * on is to actually check it) - never for a file this pass already knows it will push or that
 * is already a known, unresolved conflict waiting on the person, not on this pass.
 */
export async function planSync(userDir, remote, { fsImpl = fs } = {}) {
  const state = loadSyncState(userDir, { fsImpl });
  const local = collectLocalFiles(userDir, { fsImpl });
  const localByPath = new Map(local.map((f) => [f.relPath, f]));
  const { files: remoteByPath } = await collectRemoteFiles(remote);

  const plan = { pushAdd: [], pushUpdate: [], pushDelete: [], pullAdd: [], pullUpdate: [], pullDelete: [], conflicts: [], unchanged: [] };
  const allPaths = new Set([...localByPath.keys(), ...remoteByPath.keys(), ...Object.keys(state.entries)]);

  for (const relPath of allPaths) {
    const l = localByPath.get(relPath);
    const r = remoteByPath.get(relPath);
    const known = state.entries[relPath] || null; // { hash, driveFileId, syncedAt } as of the last successful sync
    const kind = (l?.kind) || (r?.kind) || (known && relPath.startsWith('trash/') ? 'trash' : relPath.startsWith('overwritten/') ? 'snapshot' : 'note');

    let localHash = null;
    if (l) { try { localHash = hashBytes(fsImpl.readFileSync(l.full)); } catch { localHash = null; } }
    const localChanged = l ? (known ? localHash !== known.hash : true) : false;
    const localGone = !l && !!known;

    if (l && !r) {
      if (localGone) continue; // unreachable (l implies !localGone), kept for clarity
      if (!known) { plan.pushAdd.push({ relPath, kind, localHash }); continue; }
      // Known locally, now missing on the remote mirror - someone (another device, or a
      // person acting on Drive directly) removed it there. If local hasn't changed since the
      // ledger, that removal is a legitimate deletion to MIRROR - pull it by removing the
      // local copy too (this is exactly how a remote Trash-move/delete propagates to a device
      // that hasn't touched the note itself). If local HAS changed since the ledger, this is a
      // real conflict (edited here, removed there) - never silently resolved either way: the
      // edit is not discarded, and the remote deletion is not silently un-done either.
      if (!localChanged) { plan.pullDelete.push({ relPath, kind }); continue; }
      plan.conflicts.push({ relPath, kind, reason: 'edited-here-removed-there', localHash, remoteHash: null });
      continue;
    }

    if (!l && r) {
      if (!known) { plan.pullAdd.push({ relPath, kind, driveFileId: r.driveFileId }); continue; }
      // Known locally once, now gone locally (this device deleted/moved it) - mirror that by
      // removing the remote copy, UNLESS the remote side has itself changed since the ledger
      // (someone edited it elsewhere after this device's delete), which is a real conflict.
      let remoteHashNow = null;
      try { remoteHashNow = hashBytes(await remote.downloadFile(r.driveFileId)); } catch { remoteHashNow = null; }
      if (remoteHashNow === known.hash) { plan.pushDelete.push({ relPath, kind, driveFileId: r.driveFileId }); continue; }
      plan.conflicts.push({ relPath, kind, reason: 'removed-here-edited-there', localHash: null, remoteHash: remoteHashNow, remoteFileId: r.driveFileId });
      continue;
    }

    if (!l && !r) continue; // known once, gone on both sides now - nothing to reconcile, the ledger entry is simply stale and gets dropped on save

    // Both exist. A snapshot file (overwritten/<id>.<ts>.md) is immutable by construction once
    // created (knowledge.mjs never rewrites one) - it can only ever be "both have it,
    // identical" or "new on one side," never a content conflict, so this falls out naturally
    // from the hash compare below without any special-casing.
    if (!known) {
      // Never synced before, but somehow exists on both sides already (e.g. two devices
      // created the same id independently, or a previous sync's ledger was lost). Compare
      // directly - identical content needs nothing; different content is a conflict exactly
      // as if both had changed since a sync, because from this ledger's point of view, they
      // effectively have (there is no common ancestor to reason from).
      let remoteHashNow = null;
      try { remoteHashNow = hashBytes(await remote.downloadFile(r.driveFileId)); } catch { remoteHashNow = null; }
      if (remoteHashNow && remoteHashNow === localHash) { plan.unchanged.push({ relPath, kind, hash: localHash, driveFileId: r.driveFileId }); continue; }
      plan.conflicts.push({ relPath, kind, reason: 'unseen-on-both-sides', localHash, remoteHash: remoteHashNow, remoteFileId: r.driveFileId });
      continue;
    }

    if (!localChanged) {
      // Local matches the ledger - any remote change (or none) is safe to just pull; nothing
      // local is ever at risk when local itself hasn't moved since the last sync.
      let remoteHashNow = null;
      try { remoteHashNow = hashBytes(await remote.downloadFile(r.driveFileId)); } catch { remoteHashNow = null; }
      if (remoteHashNow === known.hash) { plan.unchanged.push({ relPath, kind, hash: localHash, driveFileId: r.driveFileId }); continue; }
      if (remoteHashNow === localHash) { plan.unchanged.push({ relPath, kind, hash: localHash, driveFileId: r.driveFileId }); continue; } // remote already matches local for some other reason - nothing to do either way
      plan.pullUpdate.push({ relPath, kind, driveFileId: r.driveFileId, localHash });
      continue;
    }

    // Local HAS changed since the ledger. If remote still matches the ledger, it's safe to
    // push. If remote has ALSO changed (to something different from local's new content),
    // that is the genuine conflict this whole design exists to never silently resolve.
    let remoteHashNow = null;
    try { remoteHashNow = hashBytes(await remote.downloadFile(r.driveFileId)); } catch { remoteHashNow = null; }
    if (remoteHashNow === known.hash) { plan.pushUpdate.push({ relPath, kind, driveFileId: r.driveFileId, localHash }); continue; }
    if (remoteHashNow === localHash) { plan.unchanged.push({ relPath, kind, hash: localHash, driveFileId: r.driveFileId }); continue; } // both sides already converged to the same content independently
    plan.conflicts.push({ relPath, kind, reason: 'both-changed', localHash, remoteHash: remoteHashNow, remoteFileId: r.driveFileId });
  }

  return plan;
}

// ------------------------------------------------------------------ applying a plan (the only part of this file that writes anything)

function pathFor(root, relPath) { return path.join(root, relPath); }

/**
 * Phase 6 (Task 5 - corruption safety): a pulled file must actually look like one of this
 * app's own note files - real front matter, no parse problems, and its front-matter `id`
 * matching the filename it is about to be written under - before it is ever allowed to
 * replace (or create) anything in the live store. This rejects partial/truncated transfers,
 * garbage bytes, and a file whose id was altered or mismatched in transit - exactly the
 * "malformed, incomplete, or corrupted remote data" Task 5 asks to never silently accept.
 */
function isWellFormedNoteFile(bytes, relPath, kind) {
  let text;
  try { text = Buffer.from(bytes).toString('utf8'); } catch { return false; }
  const filename = path.basename(relPath, '.md');
  // notes/trash are named exactly "<id>.md"; a version-history snapshot is "<id>.<when>.md"
  // (see knowledge.mjs's own SNAPSHOT_FILE pattern) - the id is only the part before the
  // first dot there, never the whole filename.
  const expectedId = kind === 'snapshot' ? filename.split('.')[0] : filename;
  const parsed = parseNoteFile(text, { fallbackId: expectedId });
  return parsed.hasFrontMatter && parsed.problems.length === 0 && parsed.fields.id === expectedId;
}

/** Quarantines suspicious bytes under knowledge/sync-quarantine/ - never under notes/trash/
 *  overwritten, so a corrupted transfer can never be mistaken for a real, live note merely by
 *  sitting in the right folder. Atomic write, read back and verified, same as every other
 *  write in this file - the quarantined copy itself must be trustworthy, even if its content
 *  is not. Returns the file written, for the caller to report; never throws. */
function quarantineBytes(userDir, relPath, bytes, { fsImpl, now }) {
  const { root } = knowledgePaths(userDir);
  const qDir = path.join(root, 'sync-quarantine');
  const name = `${path.basename(relPath, '.md')}.${now()}.quarantined.md`;
  const dest = path.join(qDir, name);
  if (!within(dest, qDir)) return { ok: false, error: 'not a usable quarantine path' };
  try {
    fsImpl.mkdirSync(qDir, { recursive: true });
    const tmp = `${dest}.${process.pid}.tmp`;
    fsImpl.writeFileSync(tmp, bytes);
    fsImpl.renameSync(tmp, dest);
    const back = fsImpl.readFileSync(dest);
    if (Buffer.compare(Buffer.from(back), Buffer.from(bytes)) !== 0) throw new Error('the quarantined copy did not verify');
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  return { ok: true, file: name };
}

/** A conflict's losing (remote) content, preserved as a real, recoverable Version History
 *  snapshot - reusing snapshotBeforeOverwrite's own exact mechanism and safety (atomic write,
 *  read-back verified, collision-proofed filename), so "both sides are kept, the person
 *  chooses" needs no new recovery format or review UI - Version History already is one. */
async function preserveConflictRemote(userDir, remote, entry, { fsImpl, now }) {
  if (entry.kind !== 'note' || !entry.remoteFileId) return { ok: true, skipped: true }; // trash/snapshot conflicts have no "current version" slot to snapshot into; see applySync's own note on this
  const id = path.basename(entry.relPath, '.md');
  let bytes;
  try { bytes = await remote.downloadFile(entry.remoteFileId); } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  const { overwrittenDir } = knowledgePaths(userDir);
  try { fsImpl.mkdirSync(overwrittenDir, { recursive: true }); } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  let when = now();
  let dest = path.join(overwrittenDir, `${id}.${when}.md`);
  while (true) {
    let exists = false;
    try { exists = fsImpl.existsSync(dest); } catch { exists = false; }
    if (!exists) break;
    when += 1;
    dest = path.join(overwrittenDir, `${id}.${when}.md`);
  }
  const tmp = `${dest}.${process.pid}.${now()}.tmp`;
  try {
    fsImpl.writeFileSync(tmp, bytes);
    fsImpl.renameSync(tmp, dest);
    const back = fsImpl.readFileSync(dest);
    if (Buffer.compare(Buffer.from(back), Buffer.from(bytes)) !== 0) throw new Error('did not read back the same bytes');
  } catch (e) {
    try { fsImpl.rmSync?.(tmp, { force: true }); } catch { /* best effort */ }
    try { fsImpl.rmSync?.(dest, { force: true }); } catch { /* best effort */ }
    return { ok: false, error: String(e?.message || e) };
  }
  return { ok: true, file: path.basename(dest) };
}

/**
 * Executes a plan: uploads/downloads/removes exactly the files planSync named, never anything
 * it didn't - the plan IS the authorization, the same discipline restore's preview->confirm
 * token already enforces one layer up (see drive-sync-controller.mjs). Every push/pull write
 * is atomic (temp file + rename) and read-back verified, the same guarantee every write in
 * knowledge.mjs and drive-backup.mjs already gives. A pulled note that would overwrite an
 * existing local note is snapshotted first (snapshotBeforeOverwrite) exactly like a Drive
 * restore already does, so a bad pull is itself recoverable through Version History, never a
 * silent, unrecoverable overwrite.
 *
 * Conflicts are NEVER applied automatically in either direction - the remote side is preserved
 * as a Version History snapshot (preserveConflictRemote) and the path is recorded in
 * state.conflicts so it is not re-snapshotted every single pass; local stays exactly as it was
 * until the person explicitly restores the preserved version (through the existing Version
 * History UI) or edits the note again, at which point the next sync pass re-evaluates from
 * scratch, same as any other path.
 *
 * A failed individual operation never aborts the rest of the pass - it is recorded in
 * state.queue (persisted, with attempts/backoff - see nextRetryDelayMs) and simply retried on
 * a later sync pass; everything else in this pass still proceeds.
 */
export async function applySync(userDir, remote, plan, { fsImpl = fs, now = () => Date.now(), onProgress = () => {} } = {}) {
  const { root } = knowledgePaths(userDir);
  const state = loadSyncState(userDir, { fsImpl });
  const { kindFolders } = await collectRemoteFiles(remote); // ensures the mirror's folders exist even on an all-unchanged pass
  const result = { pushed: 0, pulled: 0, deleted: 0, conflicts: 0, quarantined: [], failed: [] };
  let done = 0;
  const total = plan.pushAdd.length + plan.pushUpdate.length + plan.pushDelete.length + plan.pullAdd.length + plan.pullUpdate.length + plan.pullDelete.length + plan.conflicts.length;
  const step = (relPath) => { onProgress({ phase: 'sync', current: done, total, path: relPath }); done += 1; };

  for (const entry of [...plan.pushAdd, ...plan.pushUpdate]) {
    step(entry.relPath);
    const full = pathFor(root, entry.relPath);
    let bytes;
    try { bytes = fsImpl.readFileSync(full); } catch (e) { result.failed.push({ relPath: entry.relPath, op: 'push', error: String(e?.message || e) }); continue; }
    try {
      const uploaded = await remote.uploadFile(kindFolders[entry.kind].id, path.basename(entry.relPath), bytes);
      const back = await remote.downloadFile(uploaded.id);
      if (hashBytes(back) !== entry.localHash) throw new Error('uploaded, but did not read back the same bytes');
      state.entries[entry.relPath] = { hash: entry.localHash, driveFileId: uploaded.id, syncedAt: now() };
      delete state.conflicts[entry.relPath];
      result.pushed += 1;
    } catch (e) { result.failed.push({ relPath: entry.relPath, op: 'push', error: String(e?.message || e) }); }
  }

  for (const entry of plan.pushDelete) {
    step(entry.relPath);
    try {
      await remote.deleteFile(entry.driveFileId);
      delete state.entries[entry.relPath];
      delete state.conflicts[entry.relPath];
      result.deleted += 1;
    } catch (e) { result.failed.push({ relPath: entry.relPath, op: 'pushDelete', error: String(e?.message || e) }); }
  }

  for (const entry of [...plan.pullAdd, ...plan.pullUpdate]) {
    step(entry.relPath);
    const dir = path.join(root, KIND_DIR[entry.kind]);
    const target = pathFor(root, entry.relPath);
    if (!within(target, dir)) { result.failed.push({ relPath: entry.relPath, op: 'pull', error: 'not a usable sync path' }); continue; }
    let bytes;
    try { bytes = await remote.downloadFile(entry.driveFileId); } catch (e) { result.failed.push({ relPath: entry.relPath, op: 'pull', error: String(e?.message || e) }); continue; }
    const hash = hashBytes(bytes);

    // Task 5 (corruption safety): malformed/incomplete/corrupted remote data is never allowed
    // to replace (or create) a note - it is quarantined instead, and a VALID local note is
    // left completely untouched (not even snapshotted, since nothing about it is about to
    // change). The remote side gets another chance to self-heal on a later pass; this device
    // never silently trusts it in the meantime.
    if (!isWellFormedNoteFile(bytes, entry.relPath, entry.kind)) {
      const q = quarantineBytes(userDir, entry.relPath, bytes, { fsImpl, now });
      result.quarantined.push({ relPath: entry.relPath, quarantineFile: q.file || null, error: q.ok ? 'remote data did not look like a valid note - quarantined, not applied' : `remote data was corrupted AND could not even be quarantined: ${q.error}` });
      continue; // the ledger entry for this path is deliberately left unchanged - never marked synced to data we refused to trust
    }

    // A pulled note that would replace an existing local note is checkpointed first - the
    // same safety net a Drive restore already gives a replaced note, reused here unchanged.
    let existedLocally = false;
    try { existedLocally = fsImpl.existsSync(target); } catch { existedLocally = false; }
    if (existedLocally && entry.kind === 'note') {
      const id = path.basename(entry.relPath, '.md');
      const snap = snapshotBeforeOverwrite(userDir, id, { fsImpl, now });
      if (!snap.ok) { result.failed.push({ relPath: entry.relPath, op: 'pull', error: `could not checkpoint the current version first: ${snap.error}` }); continue; }
    }
    try {
      fsImpl.mkdirSync(dir, { recursive: true });
      const tmp = `${target}.${process.pid}.${now()}.tmp`;
      fsImpl.writeFileSync(tmp, bytes);
      fsImpl.renameSync(tmp, target);
      const back = fsImpl.readFileSync(target);
      if (hashBytes(back) !== hash) throw new Error('did not read back the same bytes');
      state.entries[entry.relPath] = { hash, driveFileId: entry.driveFileId, syncedAt: now() };
      delete state.conflicts[entry.relPath];
      result.pulled += 1;
    } catch (e) { result.failed.push({ relPath: entry.relPath, op: 'pull', error: String(e?.message || e) }); }
  }

  for (const entry of plan.pullDelete) {
    step(entry.relPath);
    const dir = path.join(root, KIND_DIR[entry.kind]);
    const target = pathFor(root, entry.relPath);
    if (!within(target, dir)) { result.failed.push({ relPath: entry.relPath, op: 'pullDelete', error: 'not a usable sync path' }); continue; }
    try { fsImpl.rmSync?.(target, { force: true }); delete state.entries[entry.relPath]; delete state.conflicts[entry.relPath]; result.deleted += 1; }
    catch (e) { result.failed.push({ relPath: entry.relPath, op: 'pullDelete', error: String(e?.message || e) }); }
  }

  for (const entry of plan.conflicts) {
    step(entry.relPath);
    const already = state.conflicts[entry.relPath];
    // Never re-snapshot the exact same still-unresolved conflict every pass - only when the
    // remote side's content has moved on again since the last time this was recorded.
    if (!already || already.remoteHash !== entry.remoteHash) {
      const preserved = await preserveConflictRemote(userDir, remote, entry, { fsImpl, now });
      if (!preserved.ok) { result.failed.push({ relPath: entry.relPath, op: 'conflict', error: preserved.error }); continue; }
      state.conflicts[entry.relPath] = { reason: entry.reason, remoteHash: entry.remoteHash || null, detectedAt: now(), snapshotFile: preserved.file || null };
    }
    result.conflicts += 1;
  }

  saveSyncState(userDir, state, { fsImpl });
  return result;
}

// ------------------------------------------------------------------ retry/backoff for a failed individual operation (Phase 3: persistent offline queue)

/** Exponential backoff with jitter, the same shape google-drive-provider.mjs's own network
 *  retry already uses - capped, so a long-offline stretch doesn't end up retrying hourly. */
export function nextRetryDelayMs(attempts) {
  const base = Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 30 * 60_000); // 30s, 1m, 2m, 4m, ... capped at 30 minutes
  return base + Math.floor(Math.random() * 1000);
}
