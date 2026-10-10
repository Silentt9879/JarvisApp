# Phase 3 — Automatic Google Drive Sync

Code-complete, tested entirely against `FakeDriveProvider` and in-memory fakes. **No real
Google account or real Drive data was touched** — per the safety rules, and because the
app-owned OAuth path (Phase 2) isn't production-ready yet either, there is currently no way
for this to run against a real account without a person manually configuring BYO-client
first. Multi-device testing in this phase means two separate local temp directories sharing
one `FakeDriveProvider` instance — a real multi-device test procedure is listed at the end.

## Architecture

**Deliberately separate from Backup (Phase 24).** Backup (`src/drive-backup.mjs`) makes an
immutable, timestamped, point-in-time copy on demand into `JARVIS Knowledge Backups/`. Sync
(`src/drive-sync.mjs`, new) maintains ONE live, mutable mirror in a different top-level
folder, `JARVIS Notes Sync/`. Neither file imports or calls the other; a dedicated test
(`drive-sync-test.mjs`) proves the two folders never collide. This makes "keep manual
recovery backups independent of sync" true by construction, not by a runtime check.

**The ledger.** `knowledge/.sync-state.json` records, per file path, the hash and Drive file
id as of the last successful sync for THIS device — the common ancestor a real three-way
compare needs. Every sync pass classifies each path (local ∪ remote ∪ ledger) as: unchanged,
push (add/update), pull (add/update), push-delete, pull-delete, or a genuine conflict — never
guessing, never folding one case into another, the same explicit-naming discipline
`previewRestore`/`previewMigration` already established in this codebase.

**Trash sync needs no special code.** A local note moved to Trash is just "notes/\<id\>.md
disappeared, trash/\<id\>.md appeared" to this engine — two ordinary per-path changes it
already handles generically. Tested end-to-end: device A trashes a note and syncs; device B
(which had the live note) ends up with it in B's own Trash, not still live and not just gone.

**Conflicts are never auto-resolved.** No last-write-wins, no "newest timestamp wins." When
both sides changed a note to two different things since the ledger, neither side is touched
automatically: the remote version is downloaded and written as a real Version History
snapshot (reusing `snapshotBeforeOverwrite`'s own exact mechanism), and local stays exactly
as it was. The person reviews and explicitly restores the preserved version (through the
*existing* Version History UI — no second conflict-resolution interface was built) if they
want it; otherwise their own edit simply stands, with the other side fully recoverable
forever, not silently lost. A conflict already recorded is never re-snapshotted every pass —
only when the remote side changes again.

**Deletions are recoverable by the same mechanism Trash already is** — nothing in sync ever
calls a hard/permanent delete locally. On the remote side, `deleteFile` (a new, sixth
provider-contract method) moves the Drive file to *Drive's own Trash* rather than permanently
deleting it, so even a sync bug can't destroy the only remote copy outright.

**Persistent offline queue.** `markPending`/`markSynced`/`syncDue` in `drive-sync.mjs` keep a
durable "a sync is owed" marker with its own exponential backoff (capped at 30 minutes),
written to the same `.sync-state.json` file — so a device that goes offline mid-edit and
isn't reopened for days still knows to retry once reconnected, surviving a restart (an
in-memory-only timer would not). Per-file retries need no separate bookkeeping: a failed
push/pull is simply re-classified as still-unsynced by the very next ledger diff.

**Debounce + orchestration** (`src/drive-sync-controller.mjs`, new): `requestSync()` (called
after every successful knowledge save/delete/restore/import) collapses several rapid local
changes into one sync pass a few seconds later — local-first, sync always follows, never
blocks a save. `syncNow()` runs immediately (used for "Sync Now," on reconnect, and at
startup if already connected). `syncIfDue()` is a slow heartbeat (every 5 minutes while
connected) that catches another device's remote changes even with no local edit of this
device's own to trigger the debounce.

## Files changed

- `src/drive-sync.mjs` (new) — the engine: ledger, three-way compare (`planSync`), execution
  (`applySync`), conflict preservation, offline-queue primitives.
- `src/drive-sync-controller.mjs` (new) — debounce, lock, connection gating, status.
- `src/google-drive-provider.mjs`, `scripts/fake-drive-provider.mjs` — added `deleteFile` (a
  new, sixth contract method; the backup/restore engine never calls it and is unaffected).
- `src/main.mjs` — `jarvis:driveSyncStatus`/`jarvis:driveSyncNow` IPC; `requestSync()` wired
  into every knowledge mutation handler; `syncNow()` on connect and at startup; a 5-minute
  heartbeat timer, cleared on quit.
- `src/preload.cjs`, `src/renderer/knowledge.js`, `src/renderer/index.html` — a sync status
  line (idle/syncing/offline/error/conflict, in plain language) and a "Sync Now" button.

## A real bug this phase's own tests caught before anything shipped

The first draft of `planSync`'s "local unchanged, remote file now missing" case had the logic
backwards — it re-pushed the file to Drive instead of mirroring the deletion locally, which
would have *resurrected* a note another device had legitimately deleted or trashed. The
Trash-propagation test caught this immediately (asserting B ends up with the note in Trash,
not still live) before any other code was built on top of it. Documented here because it's
exactly the kind of three-way-merge subtlety this phase's own safety rules exist to catch.

## Test results

- `scripts/drive-sync-test.mjs` (new): 14/14 — push/pull, updates-not-duplicates, Trash-move
  propagation across simulated devices, conflicts (detected, preserved, deduplicated, and
  resolved once the person acts), safe-pull/safe-push with no conflict, the offline queue and
  its backoff, Backup/Sync folder independence, partial-failure resilience and automatic retry.
- `scripts/drive-sync-controller-test.mjs` (new): 7/7 — debounce coalescing, `syncNow()`
  bypassing debounce and cancelling a pending one, offline gating and pending-marker recording,
  the heartbeat (`syncIfDue`) retrying once reconnected and past backoff, conflict status
  surfacing without treating a conflict as a hard failure.
- `scripts/knowledge-renderer-test.mjs` (extended): 100/100 — the new status line and button,
  through the real renderer code.
- `scripts/drive-ipc-security-test.mjs` (extended): 16/16 — the two new handlers take no
  renderer-supplied path/id that could redirect sync, and never return a token.
- Full `npm test`: exit code 0 (also caught and fixed one unrelated pre-existing wiring-test
  regex that an insertion point change broke — see commit history).

## Known limitations

- **Never run against a real Google account.** Every test is against `FakeDriveProvider`.
  Real-world messiness (partial writes, a Drive API quota error mid-sync, genuinely large
  notebooks) is only as well-handled as `google-drive-provider.mjs`'s existing retry/backoff
  (unchanged by this phase) already is for backup/restore — not independently re-verified
  here for sync's own call pattern (many more, smaller round trips than a backup run).
- **Remote-change detection downloads and hashes every existing file, every pass**, rather
  than using a cheaper remote-metadata signal (Drive's own reported `md5Checksum`, which the
  five/six-method contract doesn't currently expose). Fine at the volume this app's own design
  docs already assume (a personal notebook, not a document corpus) but would not scale to a
  very large notebook without a future contract extension.
- **No UI for reviewing/resolving a conflict beyond "open Version History and look"** — there
  is no dedicated conflict inbox; a conflict is just a note whose preserved alternate version
  sits in that note's own Version History, discoverable but not centrally listed anywhere
  else in the app yet.
- **The periodic heartbeat (5 minutes) is a fixed interval**, not configurable, and is the
  only mechanism that catches a remote-only change when this device has made no local edit of
  its own — a person who wants "see what changed on my phone" sooner than 5 minutes away must
  press "Sync Now."
- Folder hierarchy, pinned notes, and Trash itself are unaffected by this phase except that
  their underlying files now sync — no new interaction was introduced with Phase 1's own
  folder/pin UI.

## Multi-device synchronization testing procedure (for real-world verification, once Phase 2 is production-ready)

1. Set up two Windows machines (or two separate `%APPDATA%\JARVIS` profiles via
   `JARVIS_USERDATA`, the same isolation this project's own live Drive test already used for
   Phase 24E) and connect both to the **same** Google account via a real, verified OAuth
   client.
2. On device A, create a note, wait for "Synced" in the status line (or press Sync Now).
3. On device B, open Notes — confirm the note appears automatically within one sync pass
   (startup sync, or press Sync Now).
4. Edit the SAME note on both devices without syncing in between (disconnect A's network,
   edit both, reconnect). Sync A first, then B. Confirm: B's own edit is not overwritten, and
   A's edit is recoverable from B's Version History for that note.
5. On device A, delete (trash) a note; sync. On device B, sync — confirm the note moved to
   Trash on B too, with its content intact, and is restorable there.
6. Disconnect device A's network entirely, edit several notes, then reconnect — confirm the
   status line shows "Offline" while disconnected and all edits sync automatically once back
   online, with no data loss and no duplicate notes.
7. Confirm Backup History (manual) on either device is unaffected — a backup taken before,
   during, or after any of the above still restores correctly and independently.

## Release readiness

**Code-complete, not production-ready** — gated on Phase 2's own Google verification (sync
cannot reach a real user until the app-owned OAuth path, or a documented BYO-client setup, is
actually usable) and on real-world (non-fake) testing per the procedure above.
