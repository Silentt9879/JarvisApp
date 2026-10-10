# Phase 0 — Architecture Audit: Unified Notes, Google Drive Sync & AI Knowledge

Read-only discovery. No code, config, production AppData, or Google Drive data was touched
to produce this. All claims below are checked against the real source as of commit
`2083cb3` on `main` (v2.4.0), not assumed.

**Headline finding before anything else:** this is not a greenfield redesign. Two of the
four requested phases already have substantial, tested prior art in this repo:

- **Phase 1 (Unified Notes)** has no prior art — legacy Notes and Knowledge Notes are two
  genuinely separate systems today, exactly as the brief assumes.
- **Phase 2 (Simple Google Login)** and **Phase 3 (Automatic Drive Sync)** overlap heavily
  with work already designed and *partially built*: `docs/jarvis-google-drive-design.md`
  (Phases 24A–24E) specifies and implements OAuth (PKCE, loopback), encrypted token
  storage, a backup/restore engine with manifests, integrity verification, conflict-aware
  restore previews, and a tested UI — against a **user-supplied OAuth Client ID**, not an
  app-owned one. The brief explicitly wants an app-owned client instead. That is the one
  piece of Phase 2/3 that does **not** already exist and needs new design, not a port.
- **Phase 4 (AI Knowledge)** has no prior art in the codebase (no retrieval/embedding layer
  exists today), but the brief's own guardrails (no full-DB dump to an external AI, source
  references, explicit approval for bulk edits) line up naturally with this app's existing
  `docRoots()`/`readDoc()` mechanism already used for Memory/Agents docs.

---

## 1. Current legacy Notes architecture

- **Data model** (`src/notes.mjs:28-93`, class `NoteStore`): flat object
  `{ id, text (≤8000 chars), created, updated, sentAt }`. No title (derived from first
  line), no tags, no folders, no favorites. Max 500 notes, oldest dropped.
- **Storage**: single JSON array file, `<userData>/notes.json`. Atomic write (temp+rename,
  `notes.mjs:49-60`) but **no read-back verification**, and any parse failure on the whole
  file is treated as "no notes" (`notes.mjs:33-47`) — one damaged byte loses every note.
- **IPC**: `jarvis:notes`, `jarvis:noteSave`, `jarvis:noteDelete` (`src/main.mjs:2634-2657`);
  preload at `src/preload.cjs:227-229`.
- **Renderer**: `src/renderer/notes.js` (186 lines), view `#view-notes`
  (`index.html:425-460`), nav `#navNotes`. Delete is a two-press, **permanent** action — no
  Trash, no version history. Unsaved drafts live only in an in-memory `Map`, lost on close.
- **Only external integration**: optional "send to Telegram" on save (`notes.mjs:103-107`).
  No project/session/Git linking, no full-text search beyond the view name in Ctrl+K.

## 2. Current Knowledge Notes architecture

- **Data model** (`src/knowledge.mjs`): one Markdown file per note with YAML front matter —
  `id, title, created, updated, tags[], favorite, folder, project, session, branch, sentAt,
  deletedAt`. IDs are UUIDv4 (`randomUUID()`), validated against a filename-safe regex.
  Unknown front-matter keys are preserved byte-for-byte on rewrite.
- **Storage** (`knowledgePaths()`, `knowledge.mjs:236-247`):
  `<userData>/knowledge/notes/<id>.md` (live), `.../trash/<id>.md` (soft-deleted),
  `.../overwritten/<id>.<ts>.md` (version snapshots), `.../.migration-complete` (marker).
  Every write is atomic **and read back to verify** — strictly stronger than legacy Notes.
- **Concurrency**: SHA-256 content-hash "revision" check on every save/delete/restore — a
  stale caller is refused, never silently overwritten. Legacy Notes has no such concept.
- **Trash**: atomic rename `notes/→trash/`, no auto-expiry. **Version history**: automatic
  snapshot before any meaningful overwrite (as of commit `f168e1a`, ordinary edits snapshot
  too, not just conflict-overwrites and restores) — but **no retention cap, unbounded
  growth** (flagged explicitly in the existing design doc §16.6, never addressed).
- **Migration from legacy Notes**: `migrateFromLegacy`/`previewMigration`
  (`knowledge.mjs:356-493`) — one-way, additive-only, idempotent, verified-backup-first,
  never mutates `notes.json`. Already has 187+ passing tests across five suites covering
  corrupt files, duplicate IDs (reported as conflict, not merged), interrupted/resumed runs,
  and non-interference with the live Notes feature.
- **IPC**: 13 handlers (`jarvis:knowledge*`, `src/main.mjs:2659-2773`); preload
  `src/preload.cjs:232-244`.
- **Renderer**: `src/renderer/knowledge.js` (818 lines), tabs for Notes/Trash, version
  history modal, Import-from-Notes flow, and the Drive connection panel (§3 below) all live
  in this one view. Nav `#navKne`, labeled "Knowledge Notes."
- **Dead/unimplemented fields**: `folder`, `project`, `session`, `branch` are modeled
  end-to-end in the backend but have **zero renderer UI** — effectively vestigial.
- **Naming collision risk**: there is a *third*, unrelated "Knowledge" concept — the
  Workspace page's "Knowledge Base" tab (`src/renderer/pages.js:206-357`), a `.claude/
  knowledge` docs browser, nothing to do with notes. Three different "Knowledge"-named UI
  surfaces exist today; this needs cleanup as part of the redesign's naming, not just
  consolidation of storage.

### Storage/IPC comparison

| | Legacy Notes | Knowledge Notes |
|---|---|---|
| Format | one JSON array file | one `.md` file per note (YAML front matter + body) |
| Write safety | atomic, **no** read-back verify | atomic **+** read-back verify |
| Concurrency | none (last write wins) | SHA-256 revision check, stale-save rejected |
| Trash | none (hard delete) | yes, no auto-expiry |
| Version history | none | yes, no retention cap (unbounded growth) |
| ID scheme | `n<ts36><rand5>` (weak `Math.random()`) | `randomUUID()` (strong) |

## 3. Current Google OAuth implementation

- **Model today: user brings their own OAuth client.** The UI (`index.html:479-481`) has a
  "OAuth Client ID" + optional "Client secret" field; nothing is pre-registered by JARVIS.
  This was a deliberate, documented decision (`jarvis-google-drive-design.md` §3) — explicitly
  to avoid the maintainer being on the hook for a shared Cloud project's verification status
  and the Testing-mode 100-user cap. **This is the one piece the new brief wants changed.**
- **Flow**: Authorization Code + PKCE (S256), loopback redirect
  (`http://127.0.0.1:<random port>`), real system browser via `shell.openExternal` — never an
  embedded webview. Implemented in `src/google-oauth.mjs`; orchestrated in
  `src/drive-connection.mjs`. `state` is validated byte-for-byte before any token exchange.
- **Token storage**: two separate `safeStorage`-encrypted files,
  `<userData>/drive-client.bin` (client id/secret) and `drive-token.bin` (access/refresh
  token). **Fail-closed** — unlike the Telegram token, there is no plaintext fallback if OS
  encryption is unavailable. Scope: `drive.file` only (narrow, non-sensitive, per-file grant).
- **Known platform constraint already surfaced in the existing design doc**: a Testing-mode
  (unverified) OAuth consent screen expires refresh tokens after 7 days and caps at 100 test
  users. The brief's own instruction ("don't assume removing the client-ID field alone
  resolves Testing-mode restrictions") is **already correct and already documented** — an
  app-owned client will need to go through Google's verification process (or stay severely
  limited) to avoid this, and that process has its own (non-trivial, multi-week, possibly
  paid-security-assessment) requirements depending on scope. This is the central open
  question for Phase 2 — see §"Decisions needing approval" below.
- **Security check performed**: no client secret, API key, or token found anywhere in the
  repo or git history (searched for `client_secret`, `GOCSPX-`, `AIza...`, credentials
  filenames). No secrets are logged. Client secret is scrubbed from the DOM immediately after
  submission.

## 4. Current Google Drive backup/restore implementation

- **Not sync — backup/restore only**, by explicit prior design choice. Full local→Drive
  upload (not incremental in the chunked-diff sense, but skip-if-unchanged by content hash,
  so a re-run only transfers what changed).
- **Layout**: a visible Drive folder "JARVIS Knowledge Backups" → one subfolder per backup
  run (`<timestamp>-<8hex>`) → per-file uploads (one Drive file per note/trash/snapshot file,
  deliberately not a zip — see design doc §5.2/§13.1 for the reasoning) → a `manifest.json`
  uploaded **last**, which is what makes a run "restorable." An allowlist covers only
  `knowledge/{notes,trash,overwritten}` — never `config.json`, `*.bin` tokens, `notes.json`,
  or logs.
- **Restore**: two-phase preview→confirm, with a server-issued one-time token (5 min TTL)
  tying the confirm step to the exact preview the user saw — a restore cannot silently apply
  to a changed local state. Every file is hash-verified before being written. Every
  at-risk local file (including Trash/Version History entries, after a fix in Phase 24C
  review) is quarantined/snapshotted before being overwritten — a bad restore is itself
  undoable through existing Version History/quarantine, with no new rollback code.
- **Error handling**: proactive token refresh (60s skew), `invalid_grant` classified as
  `expired` (prompts reconnect, never silently retried), network errors retried with bounded
  exponential backoff + jitter, rate limits (429/`rateLimitExceeded`) retried the same way,
  ordinary 4xx never retried. Revoke-on-disconnect failure never blocks clearing the local
  token.
- **Conflict handling today**: "refuse rather than silently overwrite" — not true two-way
  sync. There is no remote-change detection outside of an explicit user-initiated restore,
  and no background/scheduled sync at all (manual "Back Up Now" / "Restore" only, by design).
- **Real-world validation**: one human-run live test against a real Google account (§16 of
  the design doc, 2026-10-10) confirmed OAuth, backup, restore-with-conflict-detection, Trash
  preservation, and Version History preservation all worked against the real Drive API using
  a disposable test OAuth client and disposable profile. Multi-thousand-file volume, long-term
  token refresh (days), and real packet-loss/rate-limit retry behavior remain unexercised live.

## 5. Storage formats, IPC contracts, and renderer navigation (cross-cutting)

Already captured above per-system; the one additional cross-talk point: `main.mjs`'s
`knowledgeStorageStatus` reads `notes.list().length` purely for a read-only "legacy note
count" display — the only place the two stores currently touch each other at runtime besides
the explicit Import flow.

Navigation is fully separate today: `#navNotes` → `"notes"` view, `#navKne` → `"kne"` view,
no shared renderer component, no shared DOM IDs, independent draft-handling and `JV.on('view',
...)` listeners in `notes.js` vs `knowledge.js`.

## 6. Existing automated tests and coverage gaps

Extensive hand-rolled `check()`-style suites under `scripts/*-test.mjs` (no Jest/Mocha), plus
one Playwright e2e spec. Notably strong: `knowledge-test.mjs` (459 lines, migration
edge cases), `knowledge-history-test.mjs` (368 lines, version history/snapshots),
`knowledge-trash-test.mjs` (356 lines, import/trash), `knowledge-ipc-test.mjs` (362 lines,
input validation/concurrency/wiring), `drive-backup-test.mjs` (30 checks against a fake Drive
provider), `drive-connection-test.mjs`, `drive-token-test.mjs` (proves fail-closed, no
plaintext fallback), `drive-backup-controller-test.mjs` (16 checks, stale-preview rejection).

**Concrete gaps relevant to this redesign:**
1. No test merges the two ID spaces, or exercises a caller-supplied `id` colliding with an
   existing note across stores.
2. No true multi-process concurrency test (all "concurrent edit" tests are simulated
   sequentially via revision mismatches in a single process).
3. No test file at all for `src/config-file.mjs` (no `config-file-test.mjs`).
4. No retention/expiry test for `knowledge/overwritten/` snapshots — consistent with there
   being no cap in the implementation (unbounded growth, flagged in design doc §16.6, still
   unaddressed).
5. No test for the legacy Notes store's own weak `Math.random()`-based ID generator
   producing a duplicate.
6. All Drive tests run against a fake provider/fake token endpoint — no automated coverage of
   messier real-world failure patterns (only one manual live run exists).
7. No existing retrieval/embedding/search-index code at all (relevant to Phase 4).

## 7. Data-loss, security, concurrency, and compatibility risks (synthesized)

| Risk | Where it lives today | Severity for this redesign |
|---|---|---|
| Merging two ID namespaces | Legacy weak-random IDs vs. Knowledge UUIDs; `main.mjs:2702` lets a caller supply an arbitrary `id` to `knowledgeSave`, defended only by the revision check, not the ID generator | Medium — must be an explicit decision, not implicit, when unifying |
| Unbounded Version History growth | `knowledge/overwritten/`, no cap, no retention policy (known, documented, unaddressed) | Medium — will compound once Notes feed into the same history mechanism, and multiplies the size of every Drive backup |
| Legacy Notes has no Trash/history | One-way permanent delete today | High if unified Notes silently adopts Knowledge's model without migrating user expectations — but *this is the fix*, not a new risk |
| App-owned OAuth client + Google verification | Not built; current model is BYO-client specifically to dodge this | High — this is the single biggest unresolved risk in the whole brief; needs explicit scoping before any code is written (see below) |
| Two-way Drive sync (remote-change detection, true conflict merge) | Not built; current design is backup/restore only, explicitly not sync | High — this is new, hard distributed-systems work with no existing scaffolding to lean on beyond the backup engine's integrity-check and quarantine primitives |
| AI retrieval over notes | Nothing exists | Medium — needs a new local index; must not become "send everything to the LLM" by default |
| Dead `folder`/`project`/`session`/`branch` fields | Backend-only, no UI, in Knowledge Notes | Low — either build real folder UI (brief asks for this) or formally drop the unused fields during unification |
| Three different "Knowledge"-named UI surfaces | Notes / Knowledge Notes / Workspace "Knowledge Base" | Low-Medium — a UX confusion risk worth fixing as part of the nav consolidation, not a data risk |

---

## Proposed architecture (summary — detailed design to follow after approval)

### Phase 1 — Unified Notes: reuse, don't rebuild, the Knowledge Notes engine

The existing `docs/jarvis-knowledge-design.md` already made the right call on storage
(file-per-note Markdown + front matter beats the legacy single-JSON-array model on every
axis: damage isolation, portability, no new native dependency). **Recommendation: Knowledge
Notes' storage/IPC engine (`knowledge.mjs`) becomes the single engine for all notes.** Legacy
Notes' only genuinely distinct feature — "send to Telegram" — gets ported onto Knowledge
Notes' save path as an optional per-note action. The existing `migrateFromLegacy` function is
already exactly the "safe migration from legacy notes.json" the brief asks for; it needs no
redesign, only wiring it to run as part of the unification (not just an opt-in "Import"
button) and a decision on when/whether to retire the separate legacy Notes nav item (brief
says: only after the unified experience is fully verified — consistent with existing
discipline in this codebase).

Open items for this phase: building real UI for the already-modeled `folder` field (brief
asks for folders); deciding whether `project`/`session`/`branch` are built out now or
formally dropped; renaming the "Knowledge Base" Workspace tab or the "Knowledge Notes" nav
entry to remove the three-way naming collision.

### Phase 2 — Simple Google Login: the actual open question

The brief wants an app-owned OAuth client so nontechnical users never see a Client ID field.
The existing BYO-client design is solid (PKCE, loopback, scoped `drive.file`, encrypted
storage, fail-closed) and **the auth/token/API code does not need to be rewritten** — only
*where the client ID/secret come from* changes. The hard part is entirely on Google's side:

- An app-owned client needs to be in **Production/Published** status (not Testing) to avoid
  the 100-user cap and 7-day refresh-token expiry — the brief's own instruction that this
  isn't automatic from removing the field is correct.
- `drive.file` is a *non-sensitive* scope, requiring only "basic" verification per Google's
  current docs (no security assessment) — meaningfully easier than a broader Drive scope,
  but still requires: a verified domain/brand presenting the OAuth consent screen, a privacy
  policy URL, and Google's review turnaround (historically days-to-weeks, not instant).
- A client secret for a **public desktop app** cannot be kept confidential — Google's own
  guidance says so. An app-owned client of type "Desktop" still uses PKCE with no secret to
  protect, same as today; the credential that changes is only the **Client ID**, which is not
  secret. This means shipping an app-owned client ID *inside* JARVIS's own code/build is fine
  from a "don't embed a confidential secret" standpoint — it was never going to be confidential
  anyway.
- This phase is the one place in the whole brief where I'd flag: **the actual unblocking work
  is a Google Cloud Console / verification process task for the user/maintainer, not an
  engineering task** — the code change itself (ship a Client ID constant instead of a UI
  field, same OAuth flow underneath) is comparatively small.

### Phase 3 — Automatic Drive Sync: genuinely new work, built on top of existing primitives

The backup/restore engine's integrity-verification, manifest, and quarantine/snapshot
machinery are directly reusable as the safety net under a sync layer, but **true two-way
sync** (remote-change detection, concurrent-modification conflict preservation, a persistent
offline retry queue, background debounced saves) is new design, not a port. Recommend:
layering sync as periodic "detect remote changes since last known Drive state" + "detect
local changes since last sync" reconciliation passes that reuse `previewRestore`'s
added/unchanged/replaced classification shape but in both directions, surfacing true
conflicts (both sides changed) as a conflict state rather than auto-merging — consistent with
every "never silently overwrite" precedent already established in this codebase.

### Phase 4 — AI Knowledge: reuse the existing docRoots mechanism, add a local index

No existing retrieval code to build on, but the existing `docRoots()`/`readDoc()` pattern
(already used for Memory/Agents docs, already has containment/security tests) is the natural
mechanism to expose unified Notes to Claude Code for reading — not a new AI runtime. A local,
pure-JS search index (the existing Knowledge design doc already evaluated and recommended
MiniSearch for this exact purpose) gives "search notes" and feeds source references without
ever sending the whole notes database to an external AI provider.

---

## Decisions needing your approval before implementation

1. **Phase 2 scope**: do you want to pursue Google OAuth app verification/publishing now (a
   process with external dependencies and turnaround time outside engineering control), or
   ship the app-owned-client code path behind a flag while verification is in progress, with
   BYO-client kept as a fallback for Testing-mode use in the meantime?
2. **Legacy Notes retirement**: confirm the unification should fully adopt Knowledge Notes'
   storage model (Markdown+front matter, Trash, Version History) as the one engine, with
   legacy `notes.json` migrated and kept only as an immutable backup — rather than, e.g.,
   building a new third storage model.
3. **Dead fields**: build real UI for `folder` (brief asks for this) — and either build
   `project`/`session`/`branch` linking too, or formally drop them from the schema now rather
   than carrying unused fields forward into the unified model.
4. **Version History retention**: the existing unbounded-growth gap (flagged, never fixed)
   will get worse once legacy Notes feed into the same mechanism and once Drive backups
   include it — should a retention cap be designed as part of Phase 1, or tracked as a
   separate follow-up?
5. **Naming cleanup**: rename one or more of "Notes" / "Knowledge Notes" / Workspace's
   "Knowledge Base" tab to remove the three-way collision, as part of the unified nav.
6. **Sync conflict UX**: confirm the "never auto-merge, always surface a conflict for the
   user to resolve" policy (consistent with this codebase's existing instincts) as the
   Phase 3 conflict-resolution default, rather than any last-write-wins shortcut.

Everything above is discovery only — no implementation code, config, or data was changed.
Awaiting direction on the decisions above (and specifically on Phase 2's Google verification
question, since it gates how much of Phase 2/3 can actually ship to non-technical users)
before proceeding to detailed design + milestones.
