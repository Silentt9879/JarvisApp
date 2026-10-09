# JARVIS Knowledge: Google Drive Backup — Architecture (Phase 24A) and Engine (Phase 24B)

**Status, updated for Phase 24B:** §§1–12 below are still the Phase 24A design as written -
unchanged, because nothing in it turned out to need revising. What's new is §13: the backup
and restore **engine** (`src/drive-backup.mjs`) is now implemented and tested - 30 passing
checks against an in-memory fake Drive (`scripts/fake-drive-provider.mjs`), 0 real network
calls, 0 OAuth requests, 0 dependencies added. There is still no OAuth client, no Electron
IPC wiring, no renderer UI, and no connection, real or attempted, to any Google account - §13
explains exactly where the line was kept and why.

It extends [`docs/jarvis-knowledge-design.md`](./jarvis-knowledge-design.md)
§5 (which first sketched Drive backup as "optional... bolted on") with the research that
section didn't yet have: a second look at Google's current OAuth documentation, the shape
Knowledge actually grew into by Phase 23E (Trash, Version History, revision-checked saves),
and the concrete manifest/restore/retry design those shipped primitives make possible.

**Scope of this phase:** backup and restore. Not sync. There is one direction of truth per
operation — either the local disk is the source and Drive the destination (Back Up Now), or
Drive is the source and local disk the destination (Restore) — and the two are never
reconciled automatically. §9 explains why that's a deliberate simplification, not a
deferred feature.

---

## 1. What already exists (reviewed for this phase)

### 1.1 The Knowledge storage engine (`src/knowledge.mjs`)

Everything this design needs is already there, proven by 187 passing checks across five
test suites (Phases 23B–23E):

- **Layout**, from `knowledgePaths(userDir)`: `knowledge/notes/<id>.md` (live notes),
  `knowledge/trash/<id>.md` (deleted, recoverable), `knowledge/overwritten/<id>.<when>.md`
  (snapshots made before an explicit "Overwrite anyway" or a Version History restore),
  `knowledge/.migration-complete` (a fast-path marker, never load-bearing).
- **Every write is atomic** — temp file, then rename, then a read-back verification — and
  every mutation (`writeKnowledgeNote`, `saveKnowledgeNote`, `deleteKnowledgeNote`,
  `restoreKnowledgeNote`, `restoreSnapshot`) is revision-checked: a stale caller is refused,
  never silently overwritten.
- **`snapshotBeforeOverwrite`** already does exactly what a restore's own rollback needs:
  given a note id, it backs up whatever is currently on disk, verified, before anything
  replaces it. §6 reuses this directly rather than inventing a second rollback mechanism.
- **`previewMigration`** already does exactly what a restore's own preview needs: a
  read-only pass that reports what *would* happen (eligible / already-there / conflicting)
  before anything is written. §6 mirrors its shape for backups.

Nothing here changes. Drive backup reads this tree to build a backup, and writes into it
through the exact same `writeKnowledgeNote`/`saveKnowledgeNote` functions a restore from
Trash or Version History already uses — never a parallel write path.

### 1.2 How JARVIS already keeps a secret (`src/updates.mjs`, `src/phone-token.mjs`)

There is one established pattern, used for both the GitHub token and the Telegram bot
token, and this design does not invent a second one:

```js
// src/updates.mjs
export function saveToken(file, token, { safe }) {
  if (!safe?.isEncryptionAvailable?.()) throw new Error('This PC cannot keep the token safely, so it was not saved.');
  fs.writeFileSync(file, safe.encryptString(String(token).trim()));
}
export function loadToken(file, { safe }) {
  try { if (!fs.existsSync(file) || !safe?.isEncryptionAvailable?.()) return null;
    return safe.decryptString(fs.readFileSync(file)) || null; } catch { return null; }
}
```

One `.bin` file per credential (`github-token.bin`, `telegram-token.bin`), encrypted by
Electron's `safeStorage` (Windows DPAPI, tied to the signed-in Windows user — the same
guarantee the OS already gives Chrome's and Windows Credential Manager's own saved
passwords). A PC where encryption isn't available refuses to save the secret at all rather
than falling back to plain text, with one deliberate, already-tested exception: an older
install's plain-text Telegram token is migrated in, once, and only removed once the
encrypted copy is confirmed written. §4 reuses this verbatim: `google-drive-token.bin`,
same functions, same PC-can't-encrypt refusal.

### 1.3 The main-process-only network boundary (already enforced, not new)

`index.html`'s CSP is `connect-src 'none'` — the renderer cannot make a network request at
all. Every GitHub call (`github.mjs`), every Telegram call (`telegram.mjs`), every update
check (`updates.mjs`) already happens in the main process over plain `fetch`, with
structured results (never the token, never a raw response) crossing into the window through
`ipcMain.handle`. `github.mjs`'s own header states the rule this design follows: *"The
window names an operation; it never supplies a URL, a path or an owner."* Drive backup adds
IPC handlers of exactly this shape (`jarvis:driveConnect`, `jarvis:driveBackup`,
`jarvis:driveRestorePreview`, `jarvis:driveRestore`, `jarvis:driveDisconnect`,
`jarvis:driveStatus`) and nothing else; the Drive token and every Drive API response live
and die in the main process.

### 1.4 "Real browser, never an in-app one" (already the house rule)

Every external sign-in or link already opens through `shell.openExternal()` — four call
sites in `main.mjs` today, all pointed at GitHub. Google's OAuth consent screen opens the
exact same way. JARVIS never renders a login form and never sees the user's Google password.

---

## 2. Google's current OAuth requirements — verified against the live docs today, not assumed

The original design doc cited Google's loopback-migration page once; this phase re-checked
it and the two pages beside it, because this document's whole job is to not trust memory
for something Google can and does change.

- **Desktop apps keep the loopback flow.** [Google's loopback-migration guide](https://developers.google.com/identity/protocols/oauth2/resources/loopback-migration),
  fetched for this phase: *"The loopback IP address flow is being deprecated for iOS,
  Android, and Chrome OAuth client types but will continue to be supported on desktop
  apps."* Confirmed current, no deadline applies to the Desktop client type.
- **Redirect URI shape**, from [Google's native-app OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app):
  `http://127.0.0.1:PORT` (or `http://[::1]:PORT`), with the port chosen at **runtime** —
  never hardcoded, never pre-registered with Google. The guide also confirms the right
  shape for the one screen the user sees mid-flow: after the redirect lands, show an HTML
  page saying "you can close this and return to JARVIS," then close the listener.
- **PKCE: Google's own page calls it "Recommended," not "Required."** This design treats it
  as non-negotiable anyway — RFC 8252 (the IETF spec for native-app OAuth that Google's own
  guidance follows) and [Google's own security blog](https://developers.googleblog.com/en/making-google-oauth-interactions-safer-by-using-more-secure-oauth-flows/)
  both push installed apps toward PKCE specifically because a public client (no way to keep
  a secret) is exactly the case PKCE exists for. There is no cost to doing it anyway.
- **No client secret.** Confirmed current: the native-app guide marks the secret field
  "Optional" for this client type, and explicitly states it isn't applicable to a public
  client that can't protect one. See §3 for what this means for *where* the client
  credential lives.
- **Scope: `drive.file`, confirmed non-sensitive today.** [Google's scope guide](https://developers.google.com/workspace/drive/api/guides/api-specific-auth),
  fetched for this phase: `drive.file` is explicitly listed as a **non-sensitive** scope,
  "only require[ing] basic OAuth App Verification," and it grants only "Create new Drive
  files, or modify existing files, that you open with an app" — per-file, not blanket Drive
  access. This is unchanged from the original design doc's claim, now re-verified rather
  than assumed.
- **New finding this phase didn't have before: the Testing-mode refresh-token expiry.**
  Google's OAuth consent screen has a "Testing" publishing status (the default for a new,
  unverified client) that caps authorization at **100 test users** and — the important part
  for a background backup feature — **expires every refresh token after 7 days** ([Google's
  own support documentation](https://support.google.com/cloud/answer/15549945) confirms
  this). A JARVIS user who connects Drive and leaves their own OAuth client in Testing mode
  will silently stop being able to back up after a week, with no code bug to blame. §4.3
  turns this into an explicit, handled status rather than a mystery failure.

**None of this requires anything to exist yet** — these are facts about Google's platform,
checked against its current documentation, not a claim that JARVIS has done any of it.

---

## 3. Whose OAuth client is it? (a decision this design has to make explicitly)

Two options exist for where the Google Cloud OAuth Client ID comes from:

| | A. JARVIS ships one shared Client ID | B. Each user creates their own (chosen) |
|---|---|---|
| Matches existing patterns | No — GitHub's token is the user's own PAT, pasted in; nothing in JARVIS today embeds a shared credential for every install | Yes — identical shape to the GitHub token field already in Settings |
| Testing-mode 100-user cap | A real ceiling once enough people install JARVIS | Irrelevant — it's one person's own project, with themself as the one test user, or their own choice to publish it |
| Who can see what was authorized | A shared client's Drive "Manage Apps" entry says "JARVIS" for every installer, indistinguishable from each other to Google and to the user | The user's own named project in their own Google Cloud console — maximally transparent |
| What JARVIS's maintainer is on the hook for | Keeping a Cloud project, its verification status, and its quota healthy for every user, forever | Nothing — no account, no project, no quota, no verification to maintain |

**Decision: B.** The user pastes their own Client ID (never a secret — there isn't one,
per §2) into Settings, exactly like the GitHub token field works today. JARVIS documents
the handful of console.cloud.google.com clicks needed (create a project, enable the Drive
API, create a Desktop OAuth client, copy the Client ID) the same way it already documents
creating a GitHub personal access token. This is also what makes the Testing-mode 7-day
expiry the user's own informed choice rather than a shared, silent ceiling everyone hits at
the same install count.

---

## 4. Connect: the auth flow

### 4.1 Sequence

1. User pastes their Client ID into Settings → Notes → Google Drive, clicks **Connect**.
2. Main process picks a free loopback port, starts a short-lived local HTTP listener on it,
   generates a PKCE `code_verifier`/`code_challenge` pair and a random `state` (`node:crypto`,
   no new dependency), and builds the authorization URL: the Client ID, the loopback
   redirect, `scope=drive.file`, `access_type=offline` (so the exchange returns a refresh
   token), `prompt=consent` (so a *re-connect* after a revoke still gets a fresh refresh
   token rather than silently reusing a dead one), the challenge, and the state.
3. `shell.openExternal()` opens that URL in the system's real browser (§1.4).
4. The user signs in and consents **only to `drive.file`** — Google's own consent screen
   will say, plainly, that the app can see files it creates, nothing already in the user's
   Drive.
5. Google redirects to `http://127.0.0.1:PORT/...` with a code (or an error) and the `state`
   back. The listener verifies `state` matches, then closes itself — it accepts exactly one
   request, ever, per Connect attempt, and times out (say 120s) if nothing arrives, so a
   closed browser tab doesn't leave a port open indefinitely.
6. Main process exchanges the code for tokens directly with Google's token endpoint
   (`POST https://oauth2.googleapis.com/token`, a plain `fetch`, no SDK — see §8) using the
   `code_verifier`, never a secret.
7. The refresh token is encrypted via `safeStorage` into `google-drive-token.bin` (§1.2).
   The short-lived access token is kept **only in memory** for the remainder of that
   session; it is never written to disk, because it's trivially re-derived from the
   refresh token and persisting it would just be one more thing that could leak.
8. Status becomes `connected`, with the consented account's email (from the token
   response's ID token, decoded locally — never a separate profile-scope request) shown in
   Settings, exactly as the GitHub token field shows whose PAT is in use today.

### 4.2 What never happens

- No password field. No embedded browser / webview (Google already blocks those for OAuth;
  JARVIS was never going to use one anyway — see §1.4).
- No client secret stored, requested, or sent — there isn't one, by design (§2).
- No scope broader than `drive.file` is ever requested. If a future phase wants to read a
  folder the user picked by hand (Google Picker), that is a **separate, additional**
  consent, never bundled into this one, and would need its own design review the same way
  this one exists.

### 4.3 Disconnect

- Clears `google-drive-token.bin` immediately (local-first: even if the next step fails,
  the credential is already gone from this PC).
- Best-effort calls Google's own revoke endpoint (`POST https://oauth2.googleapis.com/revoke`
  with the refresh token) so the grant is also gone from Google's side, not just forgotten
  locally — the same "leave nothing behind" instinct `authLogout`'s Claude Code delegation
  already has. A revoke failure (offline, token already dead) is reported but does not
  block the local disconnect — the user asked to disconnect, and locally, they now are.
- Status line also offers, informationally: *"You can also remove JARVIS from
  myaccount.google.com/permissions."* — the same thing the existing Phase 23A doc already
  promised for Drive's own "Manage Apps" view, now written down as an actual disconnect-flow
  step rather than a forward reference.

### 4.4 The Testing-mode reconnect state

`jarvis:driveStatus` distinguishes **`expired`** from every other failure: a refresh call
that specifically comes back `invalid_grant` is the signature of either a revoked grant or
(per §2's new finding) a 7-day Testing-mode expiry. The status shown to the user is neither
a generic error nor silence — it's "Your Google connection expired — reconnect to keep
backing up," with the Connect button re-offered directly. No retry loop ever fires on its
own for this (§7 covers retry policy generally); the fix is always a deliberate reconnect.

---

## 5. Where backups live, and why

### 5.1 `drive.file`, a visible, app-created folder — not `drive.appdata`

Both `drive.file` and [`drive.appdata`](https://developers.google.com/workspace/drive/api/guides/appdata)
are classified **non-sensitive** by Google today (re-verified for this phase, not assumed)
— so the choice between them isn't a verification-cost question, it's a philosophy one:

| | `drive.file` (chosen) | `drive.appdata` (rejected for this phase) |
|---|---|---|
| Visible in the user's own Drive | Yes — a normal folder, "JARVIS Knowledge Backups" | No — Google's own docs: "hidden from the user and from other Google Drive apps," not reachable through the Drive UI at all |
| User can open a backup and look at a note without JARVIS | Yes — it's a plain `.md` file in a plain folder | No |
| Matches "a note is a plain file you own" (Phase 23A doc §2's core lesson) | Yes | No — contradicts it |
| Accidental deletion from Drive's own UI | Possible (same risk as any Drive file the user can see) | Not possible — arguably the one real advantage |

**Decision:** `drive.file`, with the app creating its own top-level folder
(`JARVIS Knowledge Backups/`) the first time Back Up Now runs, and one subfolder per backup
run inside it, named by timestamp (`2026-10-09T17-05-00Z/`). Because `drive.file` grants
access only to files/folders the app itself creates, JARVIS's access is automatically
scoped to exactly that folder tree forever — it cannot see anything the user already had in
Drive, or anything placed there by another app, even by accident. `drive.appdata` is worth
revisiting later specifically for people who want backups Drive's own UI can't show or let
them fat-finger-delete, but it is out of scope for this phase (§9).

### 5.2 One backup = one folder of plain files, not one zip

The original Phase 23A sketch proposed "one timestamped zip." Reviewed against what's
actually in the repository today: **no zip/archive dependency exists** (checked
`package.json`; Node's built-in `node:zlib` does gzip/deflate streams, not a multi-entry ZIP
container), and the codebase's own consistent rule — stated outright in `github.mjs`'s
header and reflected in `telegram.mjs` — is "no SDK where a few `fetch` calls do the job."
Revised design: **each backed-up file is its own Drive file**, uploaded individually into
that run's timestamped folder, plus one `manifest.json` uploaded **last**.

This isn't just dependency-avoidance; it's strictly better for three things this phase's
objective specifically asks for:

- **Interrupted uploads (§7).** A failure on file 140 of 300 means retrying file 140
  onward, not re-building and re-sending one giant blob from scratch.
- **Integrity (§6).** Drive's own `files.get` already returns an `md5Checksum` per file; a
  restore can cross-check Drive's own reported checksum against the manifest's recorded
  SHA-256 for that file (converted representations aside, both exist as independent proof
  the bytes are intact) before ever trusting it, with no zip-parsing step in the critical
  path that could itself be a source of corruption.
- **Transparency.** The user can open Drive, click into a backup folder, and see their own
  Markdown notes sitting there as plain files — the single strongest idea in the existing
  design doc, now true for the backup copy too, not just the local one.

### 5.3 Manifest format

`manifest.json`, uploaded last in each backup folder — its presence is what makes a backup
**restorable**; its absence (an interrupted run) is what makes the restore picker correctly
skip it (§7):

```json
{
  "schema": 1,
  "createdAt": "2026-10-09T17:05:00.000Z",
  "jarvisVersion": "2.3.1",
  "source": { "notes": 42, "trash": 3, "snapshots": 11 },
  "encryption": { "enabled": false },
  "files": [
    { "path": "notes/3f9a....md", "kind": "note", "size": 842, "sha256": "…", "driveFileId": "…" },
    { "path": "trash/8b21....md", "kind": "trash", "size": 301, "sha256": "…", "driveFileId": "…" },
    { "path": "overwritten/3f9a....1733784000000.md", "kind": "snapshot", "size": 790, "sha256": "…", "driveFileId": "…" }
  ]
}
```

`schema` exists from day one (a lesson already learned once — `SCHEMA_VERSION` in
`knowledge.mjs` was added at the very start of Phase 23B specifically so a later format
change never has to guess what it's reading). `kind` lets a restore rebuild the right
subfolder (`notes/`, `trash/`, `overwritten/`) without inferring it from the path alone.

---

## 6. Restore: preview, confirmation, rollback

Every one of these three words already means something specific and already-tested
elsewhere in Knowledge; restore reuses that meaning rather than inventing new vocabulary.

1. **List backups** — `jarvis:driveRestoreList` fetches only the folder names and each
   folder's `manifest.json` (small, metadata-only) under `JARVIS Knowledge Backups/`, newest
   first. A folder with no manifest is shown as *"Incomplete backup, not restorable"* and
   excluded from being picked — never offered as if it were whole.
2. **Preview** (`jarvis:driveRestorePreview`, read-only, same shape as `previewMigration`
   in §1.1) — for the chosen backup, compare its manifest against the current local
   `knowledge/` tree and report, before touching anything: how many notes would be added,
   how many would be **replaced** (a local note with the same id already exists, with
   *different* content — named explicitly, never silently folded into "added"), how many
   are already identical (nothing to do), and the same for Trash and Version History
   entries. This is `previewMigration`'s own exact job, pointed at a different source.
3. **Explicit confirmation** — the same two-step pattern Overwrite-anyway and Version
   History's own Restore already use (arm, then confirm, with the confirm button naming
   what it's about to replace), not a single click. A restore that would replace zero
   existing notes (a clean, empty-store restore) can skip the two-step arm — there's
   nothing to protect against yet.
4. **Rollback is `snapshotBeforeOverwrite`, not a new mechanism.** For every local note the
   preview identified as "would be replaced," the restore calls `snapshotBeforeOverwrite`
   on it **before** the incoming version is written — identical to what an "Overwrite
   anyway" save already does. The practical result: a bad cloud restore is itself undoable,
   for free, through the Version History the user already has, with zero new rollback code
   to write or test. If snapshotting any one note fails, that note's restore is skipped and
   reported (never force through "well, we tried") — the same fail-closed rule
   `saveKnowledgeNote`'s own force-overwrite path already follows.
5. **Each file is verified before it's written** — downloaded, SHA-256'd, compared to the
   manifest's recorded hash, and only written to disk (through the existing atomic
   `writeKnowledgeNote`/direct restore-into-Trash primitives) once it matches. A mismatch is
   reported per-file and that file is skipped, not silently accepted — mirroring
   `updates.mjs`'s own installer-hash check before it ever treats a download as real.
6. **Resumable.** A restore interrupted partway through (crash, network loss) can be
   re-run: for each manifest entry, if a local file already exists with the exact matching
   content (by hash, the same "already correct, nothing to do" check `migrateFromLegacy`
   already performs per-note), it's skipped; only what's missing or still mismatched is
   downloaded. No manual "clean up and start over" step is ever required.
7. **Completion report** — the same shape Import's own confirm step already returns:
   counts of restored / already-current / skipped-mismatch / failed, never a bare "done."

---

## 7. Offline operation, interrupted uploads, retry

- **No timers, no background polling, ever** — Back Up Now and Restore only ever run on an
  explicit click, the same rule `github.mjs`'s own header states outright for every GitHub
  call JARVIS makes today. A scheduled/automatic backup is explicitly **not** part of this
  phase (§9), and when it does arrive later, "the user must have opted into it as a second,
  separate toggle from merely connecting Drive" (carried forward verbatim from the original
  Phase 23A doc's own stated safeguard).
- **Offline is a status, not a crash.** A `fetch` failure before anything was sent reports
  *"You're offline — try Back Up Now again once you're connected"* and changes nothing.
  Nothing here auto-retries in the background; the user controls when network is spent,
  consistent with the rest of the app's "explicit action only" design.
- **Interrupted mid-upload** (§5.2's per-file design is what makes this tractable): the
  backup is retried file-by-file, skipping any file already present in that run's Drive
  folder with a matching hash — not re-uploaded, not duplicated. `manifest.json` is only
  ever written once every other file in that run has been confirmed uploaded, which is also
  exactly what makes "finished" mean something concrete (§5.3, §6 step 1).
- **A failed backup never corrupts a previous one.** Each run gets its own new, separate,
  timestamped Drive folder — an interrupted or failed run simply leaves behind one
  incomplete folder (clearly marked as such, per §6 step 1) beside any earlier, complete
  ones, which remain exactly as good as they were.

---

## 8. Dependencies and the API surface actually needed

**No new dependency is required**, confirmed by checking what Drive's REST API (not the
`googleapis` npm SDK) actually needs for this scope, against the codebase's existing
`fetch`-only pattern (`github.mjs`, `telegram.mjs`):

| Need | Call |
|---|---|
| Exchange code / refresh token for an access token | `POST oauth2.googleapis.com/token` |
| Revoke a token on disconnect | `POST oauth2.googleapis.com/revoke` |
| Create the backups folder (once) / a per-run subfolder | `POST www.googleapis.com/drive/v3/files` (`mimeType: application/vnd.google-apps.folder`) |
| Upload one file | `POST www.googleapis.com/upload/drive/v3/files?uploadType=multipart` (small Markdown/JSON files — no resumable-upload session protocol needed at this size) |
| List backup folders / read a manifest | `GET www.googleapis.com/drive/v3/files` (list, scoped by parent folder id) and a normal authenticated file download |

Five endpoints, all plain JSON over `fetch` with a bearer token — the same shape
`github.mjs` already has for a REST surface roughly this size. `googleapis` (Google's own
Node SDK) is deliberately not proposed: it is a large package with its own dependency tree,
for a surface this small, which is exactly the tradeoff the codebase has already made twice
(GitHub, Telegram) in favor of a small hand-rolled client.

---

## 9. What this phase deliberately does not do

- **No two-way sync.** A note edited on two machines and reconciled automatically is a
  fundamentally different, much harder problem (the Phase 23A doc already named this a
  non-goal at line 67; this phase doesn't relitigate it). Backup and restore are each
  one-directional and always explicit about which direction.
- **No scheduled/automatic backup.** Manual "Back Up Now" only, in this phase. The
  `features.mjs` Routines timer the original doc flagged as reusable is still the right
  foundation for a later, separately-opted-into scheduled backup — just not built here.
- **No `drive.appdata`.** Revisit only if a user specifically wants backups hidden from
  Drive's own UI (§5.1); not needed for this phase's goal.
- **No agent access to private notes**, Knowledge or Drive-backed — unchanged, unrelated to
  this feature, not touched by it.
- **No shared/embedded OAuth client** — every user brings their own (§3).

---

## 10. Client-side backup encryption — evaluated, recommended as opt-in and off by default

**The question this phase was asked to answer, not defer:** should a backup's file content
be encrypted with a user passphrase before it ever leaves the PC, on top of Google's own
server-side encryption-at-rest?

**Recommendation: offer it, but opt-in, off by default**, for a reason grounded in what
this codebase already chose for a comparable tradeoff: JARVIS's existing secret storage
(§1.2) relies on **OS-level** encryption (`safeStorage`/DPAPI) that asks the user for
nothing and can never be lost to a forgotten passphrase — recoverable as long as the user
can sign into Windows. A user-passphrase scheme is strictly less forgiving: lose the
passphrase, lose every backup, permanently, with nobody — not JARVIS, not Google — able to
help. That is a real cost, not a hypothetical one, for a *backup* feature whose entire
purpose is "a safety net for when something goes wrong."

Weighed against that cost: some users keep content in notes they'd rather not have sitting
on Google's servers even encrypted-at-rest under Google's own keys — a legitimate, real
concern this design shouldn't dismiss by only offering the OS-trust model.

**Design if/when built:** per-file AES-256-GCM (`node:crypto`, already in Node, no new
dependency) with a key derived from a user passphrase via `scrypt` (also `node:crypto`), a
random salt stored in the plaintext `manifest.json` (safe — a salt is not a secret), and the
encrypted bytes replacing the plaintext file content uploaded to Drive. The manifest's own
`encryption` field (§5.3) already reserves space for this. A one-time, impossible-to-miss
warning before first use: *"If you forget this passphrase, nobody — including us — can
recover these backups."* Restore prompts for the passphrase before preview can show any
real content, since preview requires decrypting first.

**Not recommended for this phase's actual implementation** (a later, separate opt-in
addition) — called out here because the question was specifically asked, and "yes, but not
by default, and only once the unencrypted path is proven" is a real, deliberate answer, not
a non-answer.

---

## 11. Tests this design implies (for the implementation phase, not written yet)

Mirroring the existing Knowledge test suites' own shape — pure engine-level tests against a
fake Drive (an injectable `fetchImpl`, the same style `fsImpl` already lets every storage
test run without touching real disk) plus wiring tests against the IPC/UI, no real Google
call in CI, ever:

| Area | What must be proven |
|---|---|
| Backup integrity | Every file in a completed backup's manifest has a SHA-256 that matches what was actually uploaded; nothing in `knowledge/` is silently left out |
| Corruption | A manifest entry whose recorded hash doesn't match the downloaded bytes is refused, flagged per-file, never written |
| Incomplete uploads | A backup folder with no `manifest.json` never appears as restorable; a retried backup uploads only what's missing, never duplicates a file already there |
| Authentication failures | A revoked/expired (§4.4) token produces the `expired` status and a reconnect prompt — never a silent retry loop, never a crash, never treated the same as "offline" |
| Restore conflicts | A local note changed since the chosen backup was made is reported as "would replace, different content" in the preview, never silently folded into "would add"; the pre-replacement version is snapshotted (§6 step 4) and provably recoverable afterward |
| Token boundary | The refresh token and every Drive API response never reach the renderer — the exact `notes-test.mjs`-style assertion already proven for the GitHub and Telegram tokens, extended to a new `google-drive-token-test.mjs` |
| Offline | A backup or restore attempted with no network fails with the specific offline status (§7), changes nothing on disk or in Drive, and is safe to simply press again |

---

## 12. Acceptance criteria for the next phase (23H / 24B — implementation)

Only once every one of these is true should Connect ever request a real OAuth grant:

1. `google-drive-token.bin` exists, uses the exact `saveToken`/`loadToken`/`clearToken`
   functions `updates.mjs` already exports, and a dedicated test proves the refresh token
   never reaches the renderer.
2. Every new IPC handler validates its own input server-side (id/path/shape), the same
   standard every Phase 23C–23E Knowledge handler was already held to.
3. A real backup, built against a fake Drive, round-trips through a real restore (preview →
   confirm → verify-then-write) in a test, end to end, with every file's hash checked.
4. A corrupted manifest entry, a missing file, an expired token, and an offline attempt each
   have their own test proving the specific, correct status — not just "it didn't crash."
5. No code path calls Google's token endpoint, the Drive API, or `shell.openExternal` except
   in direct response to Connect, Back Up Now, Restore, or Disconnect being clicked.
6. `npm test` stays fully green, exactly as it has been held to for every Knowledge phase so
   far.

---

## 13. Phase 24B — the engine, as built

Everything below describes `src/drive-backup.mjs` and `scripts/fake-drive-provider.mjs` as
they actually exist today, not as proposed. The design in §§1–12 needed no revision to
implement; this section is the follow-through, not a correction.

### 13.1 Per-file vs. archive — finalized, with the comparison §5.2 asked for made explicit

§5.2 already decided against one zip per backup. Restated here as the direct side-by-side
comparison this phase was asked to produce, now informed by having actually built both the
manifest and the upload/verify loop rather than reasoning about them in the abstract:

| | Per-file (built) | Single archive (zip/tar) |
|---|---|---|
| New dependency | None - `node:crypto`, `node:fs`, `node:path` only | At least one; no zip/tar library exists in this `package.json` today, and Node's built-in `node:zlib` is a single-stream (de)compressor, not a multi-entry container format |
| A corrupted/interrupted file | Exactly one manifest entry fails; `runBackup` retries only that file, `applyRestore` likewise | The whole archive is suspect - a zip's integrity is typically whole-file (central directory at the end); a truncated or bit-flipped archive can fail to open at all, not just lose one entry |
| Retry cost after interruption | Only the files not yet verified - proven directly by the "interrupted upload and retry" test, which re-verifies 3 unaffected files for free and only re-sends the 1 that failed | The entire archive, every time - there is no partial-archive upload to resume from without re-deriving the whole blob |
| User can inspect a backup from Drive's own UI | Yes - a plain folder of plain `.md`/`.json` files, openable without JARVIS | No - an opaque `.zip`, meaningless without downloading and extracting it first |
| Matches `drive.file`'s per-file grant model | Exactly - each file the app creates is its own grant | Also fine, but gives up the inspection/retry advantages for no gain at this volume |

**Why per-file suits JARVIS's expected volume specifically:** Knowledge is personal notes,
not a document corpus - the existing Phase 23E test fixtures and the shipped feature's own
design assume dozens to a few hundred notes for a genuinely heavy user, each a few hundred
bytes to a handful of kilobytes of Markdown (`MAX_BODY` in `knowledge.mjs` caps a single note
at 2,000,000 characters, but that is a safety ceiling against a mistaken paste, not a typical
note). At an estimated upper bound of a few thousand notes/trash/snapshot files combined, a
full from-scratch backup is a few thousand small multipart uploads plus their verification
downloads - each on the order of a request-latency round trip, not a bulk-transfer one. That
is minutes, not hours, for a cold backup, and **every backup after the first is incremental
in practice** even though the engine doesn't track deltas explicitly: `runBackup`'s own
existence-check (§13.2) means a file whose content hasn't changed since the last backup under
the same id is downloaded-and-verified rather than re-uploaded, and a genuinely *new* backup
(a fresh id) only has to newly upload whatever changed since the last one was taken - the vast
majority of files in a day-to-day backup. The archive approach's main advantage - fewer total
HTTP round trips - only matters at a volume (tens of thousands of files, or files large enough
that per-request overhead is the bottleneck) that personal Markdown notes don't reach.

### 13.2 What the engine actually guarantees (mapped to the Phase 24B requirements)

| Requirement | How it's met |
|---|---|
| Narrowly scoped allowlist | `collectLocalFiles` reads exactly `knowledge/{notes,trash,overwritten}` and nothing else under `<userData>` - no `config.json`, no `*.bin` token, no `notes.json`, no `jarvis.log`, no `.migration-complete` |
| Versioned manifest | `schema`, `backupId`, `createdAt`, and per-file `path`/`kind`/`size`/`sha256`/`driveFileId` - `BACKUP_SCHEMA` exists from day one so a future format change is never a guess |
| Never complete before every file is uploaded and verified | Each file is downloaded back and hash-compared before being added to `manifestFiles`; any failure short-circuits before `manifest.json` is ever uploaded |
| Manifest published last | `runBackup` uploads every note/trash/snapshot file first; `manifest.json` is the literal last write of a successful run |
| Previous successful backups preserved on a later failure | Every run gets its own new, separately-named Drive folder; a failed run's incomplete folder never touches an earlier run's files or manifest - proven directly by a dedicated test |
| Idempotent, safe retries | Re-running `runBackup` (or `applyRestore`) with the same id re-verifies what's already there by content hash and only does new work for what's missing or still wrong - proven for both backup and restore |
| Unsafe paths / duplicate entries / corruption / incomplete manifests rejected | `validateManifest` is the single gate every manifest (built or downloaded) passes through - traversal, wrong-kind prefixes, backslashes, malformed hashes, duplicate paths, and duplicate Drive file ids are all refused outright, each with its own test |
| Symlinks and traversal can't escape Knowledge | `lstatSync` (never `statSync`) excludes a symlinked file or a symlinked `notes/`/`trash/`/`overwritten/` directory outright; every path (local and from a manifest) is also re-checked with the same `within()` containment helper `knowledge.mjs` already uses |
| Read-only restore preview | `previewRestore` only reads; `added`/`unchanged`/`replaced` are reported, named explicitly (never "replaced" silently folded into "added") |
| Validate before applying | Every byte downloaded during a restore is hashed and compared to the manifest's recorded value before it is ever written |
| Verified, complete checkpoint before any restore write | Every at-risk local note is checkpointed via `snapshotBeforeOverwrite` **before any of them** are overwritten; if checkpointing even one fails, nothing is written at all |
| Explicit confirmation before applying | Enforced one layer up, by whichever caller invokes `applyRestore` after showing `previewRestore`'s result - the engine itself has no "auto-apply" entry point; there is no code path from reading a backup to writing one without a caller choosing to call `applyRestore` by name |
| Never silently overwrite | `previewRestore` names every conflict as `replaced` before anything happens; `applyRestore` checkpoints every one of them first |
| Safe recovery if restore is interrupted | A retried `applyRestore` only writes what's still missing or mismatched - proven by a dedicated interrupted-restore-and-retry test, including that the already-restored files are provably left alone, not re-downloaded |
| Previous local state preserved until restore success is verified | The atomic temp-then-rename-then-verify write (identical pattern to every other write in `knowledge.mjs`) means the old file is never even momentarily absent |
| No automatic restore at startup | There is no startup hook, timer, or auto-invocation anywhere in this file - `applyRestore` only ever runs when a caller calls it, by name, with a specific backup id it chose |

### 13.3 Dependency injection and the fake provider

The engine takes `remote` as a parameter to every function that needs it - never imports or
constructs a Drive client itself, and never imports Electron, `node:https`, or anything
OAuth-related. `scripts/fake-drive-provider.mjs` implements the five-method contract (§ see
the file header in `drive-backup.mjs`) as a plain in-memory `Map`-backed object, with three
explicit fault-injection hooks (`corruptNextUpload`, `failNextUpload`/`failNextDownload`, and
the more targeted `failDownloadFor(fileId)`) that let a test reproduce a bad transfer, a
dropped connection, or a partial outage deterministically, without any real flakiness to wait
for. A real Electron-side provider (Phase 24C) implements the identical five methods against
the real Drive REST API and is a drop-in replacement - `drive-backup.mjs` does not change.

### 13.4 Test coverage (`scripts/drive-backup-test.mjs`, 30 checks)

Every scenario the phase asked for has its own check: an empty store, a valid complete
backup (with the manifest's hashes independently re-verified against the real local bytes),
a corrupted source file (unreadable locally - the rest of the backup still completes), a
corrupted uploaded file (caught by read-back verification, backup not marked complete), a
missing remote file at restore time, an incomplete manifest (no `manifest.json` at all - the
backup is listed but never restorable), an interrupted upload with a successful retry into
the same backup id, duplicate backup attempts (idempotent, no duplicate files created),
manifest path traversal (forward-slash `..`, backslash-smuggled, wrong kind-prefix, absolute
path - each its own check), a symlinked file and a symlinked directory both excluded from
collection, restore conflicts (named explicitly, checkpointed before being overwritten and
provably recoverable afterward through Version History), an interrupted restore with a
successful, non-duplicating retry, recovery-checkpoint verification (every at-risk note
checkpointed before any of them are written, not interleaved one at a time), a refusal to
restore anything at all if even one checkpoint can't be made, and preservation of an earlier
successful backup when a later one fails.

### 13.5 Backup and restore safety assessment

**Confirmed safe for this phase's stated boundaries:**
- No OAuth request, no network call, no real Drive access, no dependency added - verified by
  inspection of every import in both new files (`node:fs`, `node:path`, `node:crypto`, and
  `./knowledge.mjs` only) and by the test run producing zero network activity.
- No production data touched - every test runs against a freshly made temp directory
  (`fs.mkdtempSync`), the same pattern every existing Knowledge test suite already uses, and
  the full temp tree is removed at the end of the run.
- No renderer or IPC surface exists yet for this engine - `drive-backup.mjs` is not imported
  by `main.mjs`, `preload.cjs`, or any renderer file, confirmed by inspection; nothing a user
  could click exists to invoke it.
- No code path calls `applyRestore` except a caller choosing to, by name, with a specific
  backup id - there is no startup hook, timer, or implicit trigger anywhere in the file.

**Residual risk, carried forward rather than hidden:**
- The engine trusts its `now()` clock for backup ids and checkpoint timestamps; a caller
  passing a non-monotonic or attacker-influenced clock could in principle produce colliding
  backup ids. Not a concern for this phase (ids are also randomized, see `makeBackupId`), but
  worth a note for Phase 24C if backup ids are ever derived from anything externally supplied.
- `applyRestore`'s checkpoint step only protects **live notes** (`kind: 'note'`) being
  replaced - a Trash or Version History entry being restored over an existing one of the same
  name is written through the same atomic, verified path, but without first snapshotting
  what it replaces the way a live note does, since a Trash/snapshot entry is already itself a
  historical artifact rather than something the user is actively editing. This is a
  deliberate scope choice, not an oversight, but it is the one place this phase's otherwise
  uniform "checkpoint everything at risk" rule doesn't apply, and is worth re-confirming
  explicitly if Phase 24C's real-world usage ever suggests users expect otherwise.
- The fake provider's fault injection is manually triggered per test, not randomized/fuzzed -
  real network failures are messier (partial writes, slow timeouts, retried-by-the-HTTP-
  -library-itself duplicate requests) than the clean "this call throws" model used here. The
  engine's own logic (verify by hash, never trust size alone, never trust a remote-reported
  checksum as authoritative) should generalize to messier real failures, but that claim is
  itself untested until Phase 24C's real provider exists.

### 13.6 Recommendation for Phase 24C

Build the real Electron-side Drive provider next, strictly as an implementation of the
five-method contract this phase already finalized and tested against - no changes to
`drive-backup.mjs` should be needed to plug it in. Concretely, in order:

1. The OAuth loopback flow from §4 (Connect/Disconnect), with its own dedicated test suite
   (a fake token endpoint, never a real Google call in CI) - proven, as §2 and §4.4 require,
   to handle the Testing-mode 7-day refresh-token expiry as an explicit `expired` status.
2. The real Drive REST calls (§8's five endpoints) behind the same provider contract, tested
   first against a local fake HTTP server before ever being pointed at the real API by hand.
3. Only once both of those exist on their own, wire `jarvis:drive*` IPC handlers and the
   Settings → Notes UI (Connect, Back Up Now, Restore, Disconnect) - reusing this phase's
   `runBackup`/`listBackups`/`previewRestore`/`applyRestore` directly, unchanged.
4. A real, manual, explicitly-consented end-to-end test against one real (throwaway test)
   Google account, only after 1–3 are independently green - the first and only point in this
   whole feature where a real Google account should be involved at all.

## 14. Phase 24C — OAuth, the real provider, and connection management

Built, per the plan above: items 1 and 2 are done and tested; item 3 is **partially** done
(connection management only - Connect/Disconnect/status, never Back Up Now/Restore, which
stay unexposed until a later phase); item 4 (a real account) was not done in this phase,
deliberately - every test below runs against a fake token endpoint and a fake in-memory Drive,
never `accounts.google.com` or `googleapis.com`.

### 14.1 OAuth (`src/google-oauth.mjs`)

Reverified against Google's own current documentation, not assumed: the out-of-band
("copy this code") flow is retired; loopback (`http://127.0.0.1:<port>`) is the only supported
desktop redirect; PKCE (S256) is fully supported end to end; a Testing-mode OAuth consent
screen issues a 7-day refresh token unless the only scopes requested are name/email/profile
(§2, §4.4 already covered this; unchanged). Authorization endpoint
`https://accounts.google.com/o/oauth2/v2/auth`, token endpoint
`https://oauth2.googleapis.com/token`, revoke endpoint `https://oauth2.googleapis.com/revoke`,
scope `drive.file` only (§5.1's minimum, unchanged).

Flow: `generatePkce()` (32-byte random verifier, S256 challenge) + `generateState()` (24-byte
random) → `startLoopbackListener()` opens a one-shot local HTTP server on a random port, with a
2-minute default timeout and guaranteed `close()` cleanup → `buildAuthUrl()` → the caller opens
that URL in the **system** browser (`shell.openExternal`, never an embedded one, per §4.2) →
the listener's `waitForCallback()` resolves once, with whichever came first: a real callback, a
timeout, or an explicit cancel → the returned `state` is compared byte-for-byte against the one
this run generated **before** anything is exchanged - a mismatch is refused outright, proven by
a dedicated test (`drive-connection-test.mjs`) that confirms `exchangeCode` is never even
called when it doesn't match.

### 14.2 Token security (`src/drive-token.mjs`, `src/drive-connection.mjs`)

Reuses `updates.mjs`'s `saveToken`/`loadToken`/`clearToken` verbatim - the same encrypted-file
primitive the GitHub token and the Telegram bot token already use - rather than inventing a
second one. Unlike the Telegram token, there is **no plaintext fallback**: `saveToken()`
already throws if `safeStorage.isEncryptionAvailable()` is false, and neither
`saveDriveClient()` nor `saveDriveTokens()` catches that and writes anywhere in the clear -
proven directly (`drive-token-test.mjs`: "FAILS CLOSED" cases, asserting the file was never
created at all). Two separate encrypted files (Client ID/secret vs. the actual tokens), so
replacing one never touches the other. `drive-connection.mjs`'s `getAccessToken()` refreshes
transparently inside a 60-second skew window before expiry, and classifies a refresh failure as
`revoked` (Google's `invalid_grant`) vs. an ordinary `error` (network/5xx) - distinctly,
so the UI can say "reconnect" rather than "try again" when that's actually what's needed.
Disconnect revokes at Google's end on a best-effort basis but **always** clears the local
token regardless of whether the revoke call itself succeeds - a network failure during
disconnect must never leave a token this app still believes is usable.

Never logged: the authorization code, any token, or the full callback URL - checked directly
by a test that scans every `log()` call in both new files for those terms.

### 14.3 The real provider (`src/google-drive-provider.mjs`)

Implements Phase 24B's five-method contract exactly - `drive-backup.mjs` was not changed to
accommodate it. Every call goes through one `call()` helper: a bounded timeout (30s default),
one retry on 401 (in case the access token was due for a refresh `getAccessToken()` hadn't
yet noticed) before classifying a persistent 401 as `DriveAuthError`, and bounded exponential
backoff with jitter (default 4 retries) on a 429/`rateLimitExceeded`/`userRateLimitExceeded`
403 or a 5xx - classified as `DriveNetworkError`. An ordinary 4xx (not found, bad request) is
never retried - that's the caller's own mistake, not a flake. Uploads use Drive's multipart
endpoint (every file here is a small Markdown note or a JSON manifest - never large enough to
need the separate resumable-upload protocol, per §13.1's own reasoning). **Compatibility is
proven directly, not by inspection**: `google-drive-provider-test.mjs` runs an actual
`runBackup` → `previewRestore` → `applyRestore` sequence through this real provider (backed by
a small in-memory fake of the Drive v3 REST API, not `FakeDriveProvider`) and confirms it
behaves identically.

### 14.4 Connection UI (Knowledge Notes)

A collapsible panel, status-only: Disconnected / Connecting / Connected / Authentication
expired / Connection error, each with a plain-language reason where one applies. "Configure
OAuth Client ID" reveals Client ID/secret fields (the secret field is cleared from the DOM
immediately after saving); Connect/Reconnect/Disconnect appear only when each is actually a
valid next action for the current status. No token is ever displayed, and none could be - the
IPC layer's replies never carry one (§14.5).

### 14.5 IPC surface - connection management only

Four calls: `jarvis:driveStatus`, `jarvis:driveConfigureClient`, `jarvis:driveConnect`,
`jarvis:driveDisconnect`. Deliberately **no** `jarvis:driveBackup`/`driveRestore` yet - this
phase is authentication and connection reliability only, per its own objective. Every reply is
laundered through `driveStatusForWindow()`, the same discipline `phoneConfigForWindow()`
already applies to the Telegram token - proven by a dedicated test that scans each handler's
own source for `accessToken`/`refreshToken`/`clientSecret` and asserts none appear. No
automatic OAuth on startup, no timer, no auto-reconnect anywhere in `drive-connection.mjs` -
every network/browser action happens only inside a call a caller makes explicitly, by name.

### 14.6 Restore safety review (Part 6) - findings and fixes

Reviewing §13.5's own residual-risk notes against this phase's explicit checklist:

1. **Full-manifest integrity verification before the first local modification** - the first
   version of this fix added a new, read-only `verifyBackupIntegrity(remote, backupId)` but
   left it as a separate function a future restore UI would have to remember to call first;
   final review caught that `applyRestore()` itself still did not enforce it. **Fixed
   properly**: `applyRestore()` now runs its own internal Phase 1 that downloads and
   hash-verifies every file it would actually need to restore, in full, before Phase 2
   (recovery copies) or Phase 3 (writes) ever starts - proven directly by a test that
   instruments both `downloadFile` and the local write call and asserts every download
   completes before the first write begins. `verifyBackupIntegrity()` still exists as a
   standalone, side-effect-free check a restore UI can run on its own (e.g. to grey out a
   corrupt backup in a list before the person even picks "Restore") - it now shares its
   download-and-hash-check logic with `applyRestore()`'s own Phase 1 (`downloadAndVerify()`)
   rather than being a second, divergent implementation of the same check.
2. **Recovery checkpoints for every local file category that can be overwritten, including
   Trash and Version History** - §13.5 had flagged this as a deliberate scope gap: only live
   notes got a real checkpoint (`snapshotBeforeOverwrite`), so restoring over an existing,
   locally-changed Trash or Version-History file had no recovery path at all. **Fixed**:
   `quarantineBeforeOverwrite` now makes a verbatim copy of whatever any kind of file is about
   to be overwritten (under `knowledge/restore-recovery/<backupId>/<kind>/<name>`), run for
   every kind in the same before-any-write pass as the existing note checkpoint - if protecting
   even one file fails, the whole restore is refused before anything changes, same as the
   existing checkpoint-failure behavior. Proven directly for both Trash and Version-History
   entries (`drive-backup-test.mjs`).
3. **Safe handling of interrupted multi-file restores** - already correct in Phase 24B
   (atomic per-file writes, resumable retries) and unaffected by the two fixes above, since
   `verifyBackupIntegrity` makes no local writes at all and quarantine copies are themselves
   written atomically (temp-then-rename) and are naturally idempotent on a retry (an
   already-quarantined file whose local content hasn't changed is simply quarantined again
   with the same bytes).
4. **Clear rollback and retry behavior** - this phase did not add a transactional "undo the
   whole restore" rollback, and recommends against building one: it would contradict the
   deliberate, tested, per-file-resumable design §13.1 and §13.5 already established (a partial
   restore's progress is meant to be kept and finished by a retry, not discarded). "Rollback"
   in the sense that matters - refusing to make *any* change when the operation can't be made
   safely - already existed for note checkpoints and now applies uniformly to every kind via
   quarantine.

## 15. Phase 24D — the Backup & Restore UI

Makes the Phase 24B engine and Phase 24C connection usable directly from Knowledge Notes - a
polished interface over the existing backend, not a reimplementation of it.

### 15.1 Architecture: a thin IPC layer over a new, pure orchestration module

`src/drive-backup-controller.mjs` holds the actual orchestration - the one in-flight-operation
lock (shared across backup, restore preview and restore confirm, so none of the three can run
concurrently with another), preview-token issuance/enforcement, and the small non-sensitive
"last backup" record (persisted via the existing `saveConfig`/`loadConfig` merge helper, same
as any other setting). `main.mjs`'s five new `jarvis:drive*` handlers do nothing but validate
what the renderer supplied and call straight into this module - the same split every other
IPC-backing piece of this app already uses (`features.mjs`, `task-runner.mjs`, `git.mjs`, ...).
This made the whole thing directly testable (`drive-backup-controller-test.mjs`, 16 checks)
without needing Electron or a real IPC round trip.

### 15.2 The restore confirmation workflow - server-side, not just a UI step

`driveRestorePreview(backupId)` re-verifies the whole backup's integrity (via
`verifyBackupIntegrity`, Phase 24C's own enforcement work) and, only if that passes, returns a
read-only preview **plus a one-time, server-issued token**. `driveRestoreConfirm(backupId,
token)` refuses outright without that exact token for that exact backup id - consuming it
either way (right or wrong), so it can never be replayed, and re-verifying the backup's
integrity a second time, fresh, before calling `applyRestore`. A renderer literally cannot
reach a restore without first calling preview and getting back a token that hasn't expired
(5 minutes) or already been used - proven directly, not by convention
(`drive-backup-controller-test.mjs`'s "STALE PREVIEW REJECTION" checks).

**Preview freshness** (added on final review): the token also carries a structural fingerprint
of what the preview actually showed - exactly which paths would be added/replaced/left alone.
`driveRestoreConfirm` re-runs `previewRestore` fresh (cheap, local-only, no second network
round trip for this part) and compares; any local Knowledge change since the preview - an
edit, a new note filling what was "added," a delete - produces a different fingerprint and is
refused as stale, token consumed either way, with a plain instruction to preview again. This
is a workflow-integrity guarantee, not a data-safety one: `applyRestore` already re-reads local
state fresh for its own checkpoint-before-write decisions regardless, so even the narrow
window between this check and the write itself is never a data-loss risk - only "did the
person actually approve what's about to happen" is what this closes.

### 15.3 Progress reporting

`runBackup`, `verifyBackupIntegrity` and `applyRestore` each gained an optional `onProgress`
callback (default a no-op - every existing call site and test is unaffected), reporting
`{phase, current, total, path}` per file. The controller stores the latest progress on its one
in-flight-operation record; `jarvis:driveOperationStatus` (polled by the renderer every ~700ms
while an operation is running) reads it - real progress, never simulated.

### 15.4 UI

A Back Up Now button, a Last Successful Backup line, and live progress, all in the existing
Drive connection panel in Knowledge Notes. Backup History opens a modal listing every backup
(date, id, file count, size, complete/incomplete/corrupt) with a Preview button on each
complete one - never offered on an incomplete or corrupt one, and nothing here ever deletes a
backup (`listBackups` itself has no delete path at all). Preview opens a second modal: added/
replaced/unchanged, bucketed into Notes/Trash/Version History, read-only. Pressing its
"Restore…" button reveals the explicit confirmation text (what changes, that a recovery
checkpoint is made for everything replaced) before "Yes, restore" becomes available - two
separate presses, never one.

### 15.5 Draft preservation and refresh after restore

`load()` (the function that already refreshes the sidebar list on every view switch) only ever
replaces the note **list** - it never touches the open editor's own fields. An unsaved draft
survives a restore's refresh for the same structural reason it already survives switching to
Trash and back: nothing about a restore calls anything other than `load()`. Proven directly,
not assumed, in `knowledge-renderer-test.mjs`'s new "Google Drive backup/restore UI" block -
the real renderer code, with a real controller and a real (in-memory) Drive behind it, run
through an actual Back Up Now → edit → Preview → Restore cycle, with an unsaved draft open the
whole time.

### 15.6 What this phase deliberately did not build

No two-way sync, no automatic/scheduled backups, no change to `notes.json` (the separate,
legacy store) or to any production AppData. A corrupted/incomplete backup is never silently
offered for restore - `restorePreview` refuses it outright with `corrupt: true` before a
preview is even shown.

### 15.7 Known limitations

All testing used `FakeDriveProvider`/synthetic credentials - no real Google account, no real
network call. Retry/backoff behavior under messier real-world failure patterns remains
untested, same caveat Phase 24B and 24C already carried forward.

## 16. Phase 24E — real Windows validation and Version History improvement

### 16.1 What this section is, and isn't

Sections 1-15 above describe behavior proven by this repo's automated test suite - every
assertion in it runs against `FakeDriveProvider` or a real-but-local filesystem, never a real
Google account. This section instead records a real, human-observed test against a real Google
account and the real Google Drive API, run once by the project owner on their own Windows
desktop, with a disposable OAuth client, a disposable Windows user-data profile, and
disposable Knowledge Notes created only for this test. **These are observed results reported
by the person who ran the test, not something this agent watched directly or re-derived from
logs** - this agent cannot host or observe a GUI process in its own environment (confirmed
repeatedly across this project's history). Nothing below should be read as a claim that
additional live tests beyond what is listed here were performed.

### 16.2 Live test environment

- Date: 2026-10-10.
- Disposable Windows profile (`JARVIS_USERDATA`): `%TEMP%\jarvis-drive-live-24e2`.
- Isolated packaged build directory: `dist-24e2` (built via `electron-builder --win --dir`,
  never the installed production JARVIS, never production `%APPDATA%\JARVIS`).
- A dedicated Google Cloud project and OAuth 2.0 Client ID of type "Desktop app", consent
  screen in Testing mode, `drive.file` scope only, with the test Google account added under
  "Test users" - no scope beyond `drive.file` was requested or granted.

### 16.3 Observed results (human-reported, not automated)

- Google OAuth sign-in completed through the real system browser against the real Google
  account, through the packaged `JARVIS.exe`; the Drive panel updated to "Connected."
- A manual "Back Up Now" produced a complete backup containing six files, later listed as a
  complete entry in Backup History.
- A restore preview, run against that backup after locally editing one of the test notes,
  correctly identified one note as modified (to be replaced) and two notes as identical
  (unchanged) - matching this phase's "added/unchanged/replaced" preview design (§6, §15.4).
  The modified note was `DRIVE_TEST_NOTE_B`.
- Confirming the restore recovered `DRIVE_TEST_NOTE_B`'s original backed-up content.
- A separate test note moved to Trash before the backup (`DRIVE_TEST_TRASH`) was still present
  in Trash after the restore, untouched - consistent with Trash being included in the backup
  allowlist (§15, `KIND_DIR`) and restore only ever adding/replacing files a backup's manifest
  names, never deleting anything locally that isn't in it.
- A note used to exercise Version History (`DRIVE_TEST_VERSION_HISTORY`) kept its earlier
  "Version 2" snapshot accessible through Version History after the restore.
- Separately, in a fix landed between the live Drive test and this review (commit `f168e1a`,
  "Preserve version history on ordinary meaningful Knowledge Note saves"), the project owner
  observed that saving `DRIVE_TEST_VERSION_HISTORY` a second time with meaningfully different
  content did not add a new recoverable version - this was confirmed to be the pre-fix
  behavior described in §16.5 below (Version History only captured conflict-overwrites and
  restores, not ordinary saves), not a defect in the Drive feature itself, and is now fixed and
  covered by automated regression tests (`knowledge-history-test.mjs`).

### 16.4 Untested scenarios and limitations (as of this review)

- Multi-hundred/thousand-note backups, very large individual notes, and sustained real-network
  retry/backoff under packet loss or rate limiting were not exercised live - only the
  automated suite's synthetic failure injection covers those paths.
- OAuth token refresh across a long-lived connection (hours/days later) and the "Testing"
  publishing status's 7-day refresh-token expiry (Google's own general policy for an
  unverified OAuth consent screen) were not observed live in this short test session.
- Backup History and Version History storage growth over many backups/edits was not observed
  over a long real-world timeframe - only reasoned about structurally (see §16.6 and the
  Version History improvement's own report).
- A real interrupted-mid-upload backup (e.g. killing the app mid-run) was not reproduced live;
  this path is covered only by the automated suite's simulated I/O failures.

### 16.5 Version History on ordinary saves (summary; full detail in the commit itself)

Before commit `f168e1a`, `saveKnowledgeNote()` only took a Version History snapshot when a
save explicitly force-overwrote a stale (conflicting) revision, or when restoring an older
version - an ordinary, non-conflicting edit that meaningfully changed a note silently replaced
the old content with nothing to recover it from. This is the gap the live test surfaced. The
fix snapshots the version being replaced whenever a save meaningfully changes an existing
note's title, body, tags, favorite, or folder (timestamp-only and cosmetic/line-ending-only
differences do not count), reusing the existing snapshot mechanism and on-disk file format
unchanged, with a same-millisecond filename-collision guard added since snapshots are now
far more frequent than before. See the commit message and `knowledge-history-test.mjs` for
the complete regression coverage.

### 16.6 Storage growth (flagged, not addressed this phase)

Version History currently never prunes - every meaningfully different save, and every real
Drive backup after it, keeps every prior version indefinitely. For a note edited often over a
long period this means unbounded growth in `knowledge/overwritten/` and in the size of every
subsequent Drive backup that includes it. No retention policy has been implemented; one should
be designed and separately approved before this becomes a problem in practice (see Phase 24E-3
release-readiness assessment).
