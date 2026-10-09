// JARVIS Knowledge - Phase 24D: the orchestration behind the backup/restore IPC handlers -
// the one in-flight-operation lock, the preview-token issuance and enforcement, and the
// non-sensitive "last backup" record - as its own pure, dependency-injected module so it can
// be driven and tested directly, the same way every other IPC-backing module in this
// codebase already is (features.mjs, task-runner.mjs, git.mjs, ...). main.mjs only wires this
// to the real provider/config/IPC - it adds no logic of its own.
//
// Main process owns every Drive operation: this module never runs in, and is never exposed
// to, the renderer - only main.mjs's `ipcMain.handle` calls ever reach it, each already
// format-checking whatever the renderer supplied before calling in.
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { runBackup, listBackups, previewRestore, applyRestore, verifyBackupIntegrity, BACKUP_ID } from './drive-backup.mjs';

const DRIVE_PREVIEW_TTL_MS = 5 * 60 * 1000;

function bucket(paths) {
  const by = { notes: [], trash: [], overwritten: [] };
  for (const p of paths) {
    const kind = p.startsWith('trash/') ? 'trash' : p.startsWith('overwritten/') ? 'overwritten' : 'notes';
    by[kind].push(p);
  }
  return by;
}

/** A structural fingerprint of a previewRestore() result - what matters is exactly WHICH
 *  paths would be added/replaced/left alone, not the order previewRestore happened to walk
 *  the manifest in. Two previews of the same backup against the same local state always
 *  produce the same signature; a local edit, add or delete between them never does. */
function previewSignature(preview) {
  return JSON.stringify({
    added: [...preview.added].sort(),
    replaced: [...preview.replaced].sort(),
    unchanged: [...preview.unchanged].sort(),
  });
}

export function createDriveBackupController({
  userDir,
  getProvider, // () => the five-method Drive provider to use for this call
  loadConfig, // () => the current config object (read-only here)
  saveConfig, // (patch) => persists { driveLastBackup } - same merge helper every other setting uses
  log = () => {},
  now = () => Date.now(),
  randomBytes = nodeRandomBytes,
  previewTtlMs = DRIVE_PREVIEW_TTL_MS,
}) {
  let op = null; // { kind: 'backup'|'preview'|'restore', backupId, startedAt, progress }
  const previewTokens = new Map(); // token -> { backupId, expiresAt }

  function operationStatus() {
    return {
      operation: op ? { kind: op.kind, backupId: op.backupId, startedAt: op.startedAt, progress: op.progress || null } : null,
      lastBackup: loadConfig().driveLastBackup || null,
    };
  }

  async function backupNow() {
    if (op) return { ok: false, error: 'An operation is already running.' };
    op = { kind: 'backup', backupId: null, startedAt: now(), progress: null };
    try {
      const onProgress = (p) => { if (op) op.progress = p; };
      const r = await runBackup(userDir, getProvider(), { now, onProgress });
      saveConfig({ driveLastBackup: { at: now(), backupId: r.backupId || null, ok: !!r.ok, error: r.ok ? null : (r.error || 'Backup failed.'), fileCount: r.verified || 0 } });
      log('Drive backup', r.ok ? 'succeeded' : 'failed', r.backupId || '', r.ok ? '' : (r.error || ''));
      return { ok: r.ok, backupId: r.backupId, total: r.total, verified: r.verified, failed: r.failed, error: r.ok ? undefined : r.error };
    } catch (e) {
      const msg = String(e?.message || e);
      saveConfig({ driveLastBackup: { at: now(), backupId: null, ok: false, error: msg, fileCount: 0 } });
      log('Drive backup threw:', msg);
      return { ok: false, error: msg };
    } finally { op = null; }
  }

  async function backupHistory() {
    try {
      const r = await listBackups(getProvider());
      if (!r.ok) return r;
      return {
        ok: true,
        lastBackup: loadConfig().driveLastBackup || null,
        backups: r.backups.map((b) => ({
          backupId: b.backupId,
          createdAt: b.createdAt || null,
          complete: b.complete,
          fileCount: b.fileCount || 0,
          sizeBytes: b.manifest ? b.manifest.files.reduce((n, f) => n + (f.size || 0), 0) : 0,
          error: b.error || null,
        })),
      };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  }

  async function restorePreview(backupId) {
    if (typeof backupId !== 'string' || !BACKUP_ID.test(backupId)) return { ok: false, error: 'Not a usable backup id.' };
    if (op) return { ok: false, error: 'An operation is already running.' };
    op = { kind: 'preview', backupId, startedAt: now(), progress: null };
    try {
      const provider = getProvider();
      const onProgress = (p) => { if (op) op.progress = p; };
      const integrity = await verifyBackupIntegrity(provider, backupId, { onProgress });
      if (!integrity.ok) return { ok: false, corrupt: true, error: 'This backup could not be fully verified and cannot be restored.', failed: integrity.failed };
      const preview = await previewRestore(userDir, provider, backupId);
      if (!preview.ok) return preview;
      const token = randomBytes(16).toString('hex');
      previewTokens.set(token, { backupId, expiresAt: now() + previewTtlMs, signature: previewSignature(preview) });
      return {
        ok: true,
        token,
        backupId,
        createdAt: preview.createdAt,
        total: preview.total,
        added: bucket(preview.added),
        replaced: bucket(preview.replaced),
        unchanged: bucket(preview.unchanged),
        expiresInMs: previewTtlMs,
      };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
    finally { op = null; }
  }

  async function restoreConfirm(backupId, token) {
    if (typeof backupId !== 'string' || !BACKUP_ID.test(backupId)) return { ok: false, error: 'Not a usable backup id.' };
    if (typeof token !== 'string' || !token) return { ok: false, error: 'Missing confirmation.' };
    const entry = previewTokens.get(token);
    // One-time use either way: present-but-wrong is consumed too, so it can never be retried.
    if (entry) previewTokens.delete(token);
    if (!entry || entry.backupId !== backupId || entry.expiresAt < now()) {
      return { ok: false, error: 'This preview has expired or was already used - preview the backup again before restoring.' };
    }
    if (op) return { ok: false, error: 'An operation is already running.' };
    op = { kind: 'restore', backupId, startedAt: now(), progress: null };
    try {
      const provider = getProvider();
      const integrity = await verifyBackupIntegrity(provider, backupId);
      if (!integrity.ok) return { ok: false, corrupt: true, error: 'This backup could not be re-verified and was not restored.', failed: integrity.failed };
      // Preview freshness: a local Knowledge file (added, edited or deleted) since the
      // preview the person actually reviewed changes what this restore would now do - refused
      // rather than silently restoring a different set of changes than what was shown and
      // approved. Cheap and local-only; does not touch the network a second time.
      const recheck = await previewRestore(userDir, provider, backupId);
      if (!recheck.ok) return recheck;
      if (previewSignature(recheck) !== entry.signature) {
        return { ok: false, stale: true, error: 'Local Knowledge files changed since this was previewed - preview the backup again before restoring.' };
      }
      const onProgress = (p) => { if (op) op.progress = p; };
      const r = await applyRestore(userDir, provider, backupId, { now, onProgress });
      if (r.ok) log('Drive restore complete', backupId, `${r.written} written, ${r.unchanged} unchanged`);
      else log('Drive restore incomplete', backupId, r.error || '');
      return r;
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
    finally { op = null; }
  }

  return { backupNow, backupHistory, restorePreview, restoreConfirm, operationStatus };
}
