// JARVIS Notes - Phase 3: the orchestration behind sync's IPC handlers - debounce, the one
// in-flight-operation lock, the persistent offline queue (drive-sync.mjs's own pending
// marker), and status reporting - as its own pure, dependency-injected module, the same split
// drive-backup-controller.mjs already uses for backup/restore. main.mjs only wires this to
// the real provider/connection/timers; it adds no sync logic of its own.
import path from 'node:path';
import { planSync, applySync, markPending, markSynced, syncDue, loadSyncState } from './drive-sync.mjs';
import { listKnowledgeNotes, listTrash } from './knowledge.mjs';

const DEFAULT_DEBOUNCE_MS = 4_000; // local-first: a save lands on disk immediately; sync follows a few seconds later, not on every keystroke

export function createDriveSyncController({
  userDir,
  getProvider, // () => the Drive provider for this call, or null/throws if not connected
  isConnected, // () => boolean - whether Drive is currently connected at all; sync never attempts a call when this is false
  log = () => {},
  now = () => Date.now(),
  debounceMs = DEFAULT_DEBOUNCE_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h),
}) {
  let op = null;           // { startedAt, progress } while a sync pass is actually running
  let debounceHandle = null;
  let lastResult = null;   // the most recent completed pass's summary, for status()
  let lastError = null;    // a hard failure (offline, thrown) from the most recent attempt - distinct from per-file `failed` entries in lastResult
  let lastSyncAt = null;

  /** Phase 5 (Task 3 - "conflict notifications must be clearly visible"): a bare count is not
   *  enough to act on - this resolves each conflicted path back to the actual note (id,
   *  title) so the status line can name which notes need attention, not just how many. Reads
   *  are cheap (a personal notebook's worth of notes) and this is only called for status(),
   *  never on a hot path. A note that is itself unreadable/missing is still named by its
   *  bare id rather than silently dropped from the list. */
  function conflictNotes(state) {
    const paths = Object.keys(state.conflicts || {});
    if (!paths.length) return [];
    const live = new Map(listKnowledgeNotes(userDir).notes.map((n) => [n.id, n]));
    const trashed = new Map(listTrash(userDir).notes.map((n) => [n.id, n]));
    return paths.map((relPath) => {
      const id = path.basename(relPath, '.md');
      const n = live.get(id) || trashed.get(id);
      return { id, title: n?.title || 'Untitled note', relPath };
    });
  }

  function status() {
    const state = loadSyncState(userDir);
    const conflictCount = Object.keys(state.conflicts || {}).length;
    // Quarantine (Task 5) is tracked only for the most recently completed pass - unlike
    // conflicts, a quarantined item is never "stuck" (the very next pass re-evaluates it
    // fresh against whatever the remote now holds), so there is no durable per-path ledger
    // entry for it the way conflicts have one; surfacing the last pass's count is enough to
    // make it visible without inventing persistent state that would mislead once it clears.
    const quarantinedCount = lastResult?.quarantined?.length || 0;
    let kind = 'idle';
    if (op) kind = 'syncing';
    else if (!isConnected()) kind = 'offline';
    else if (lastError) kind = 'error';
    else if (conflictCount) kind = 'conflict';
    else if (quarantinedCount) kind = 'quarantine';
    return {
      state: kind,
      conflictingNotes: conflictNotes(state),
      quarantinedCount,
      syncing: !!op,
      progress: op?.progress || null,
      lastSyncAt,
      lastError,
      lastResult,
      conflictCount,
      pending: state.pending || null,
    };
  }

  /** The actual sync pass: plan, then apply, then record what happened - never two passes
   *  overlapping (the same single in-flight lock backup/restore already use), and never
   *  attempted at all while Drive isn't connected (recorded as a pending retry instead, so
   *  reconnecting - or simply the next debounced request - picks it up automatically). */
  async function runOnce() {
    if (op) return { ok: false, error: 'A sync is already running.' };
    if (!isConnected()) { markPending(userDir, { now }); return { ok: false, error: 'Not connected to Google Drive.', offline: true }; }
    op = { startedAt: now(), progress: null };
    try {
      const provider = getProvider();
      const plan = await planSync(userDir, provider, {});
      const onProgress = (p) => { if (op) op.progress = p; };
      const r = await applySync(userDir, provider, plan, { now, onProgress });
      lastError = null;
      lastSyncAt = now();
      markSynced(userDir, {});
      lastResult = r;
      if (r.failed.length || r.conflicts || r.quarantined?.length) {
        log('Drive sync: partial -', `${r.pushed} pushed, ${r.pulled} pulled, ${r.deleted} deleted, ${r.conflicts} conflict(s), ${r.quarantined?.length || 0} quarantined, ${r.failed.length} failed`);
      } else {
        log('Drive sync: complete -', `${r.pushed} pushed, ${r.pulled} pulled, ${r.deleted} deleted`);
      }
      return { ok: true, ...r };
    } catch (e) {
      const msg = String(e?.message || e);
      lastError = msg;
      markPending(userDir, { now });
      log('Drive sync failed:', msg);
      return { ok: false, error: msg };
    } finally { op = null; }
  }

  /** Immediate sync - used for "Sync now," app startup (if already connected), and right
   *  after a successful Connect/Reconnect. No debounce: the person (or the app) explicitly
   *  wants this to happen now. */
  async function syncNow() {
    if (debounceHandle) { clearTimer(debounceHandle); debounceHandle = null; }
    return runOnce();
  }

  /** Debounced background sync - the call every local note save/delete/restore makes. Several
   *  calls in a row (typing, then a quick second edit) collapse into ONE sync a few seconds
   *  after the last one, not a sync per keystroke or per save. */
  function requestSync() {
    if (debounceHandle) clearTimer(debounceHandle);
    debounceHandle = setTimer(() => { debounceHandle = null; return runOnce(); }, debounceMs);
  }

  /** Called on a slow background heartbeat (main.mjs's own timer, if it chooses to run one) -
   *  or simply before showing the Notes page - to pick up a retry whose backoff window has
   *  elapsed, without the caller needing to track backoff timing itself. A no-op if nothing is
   *  owed or the backoff window hasn't passed yet. */
  function syncIfDue() {
    if (op || debounceHandle) return false;
    if (!isConnected()) return false;
    if (!syncDue(userDir, { now })) return false;
    runOnce();
    return true;
  }

  return { syncNow, requestSync, syncIfDue, status };
}
