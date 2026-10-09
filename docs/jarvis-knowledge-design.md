# JARVIS Knowledge — Discovery & Architecture (Phase 23A)

Read-only discovery for upgrading Notes into a full personal knowledge-management module.
Nothing in this document has been implemented. No code, dependency, or user data was changed
to produce it — everything below is checked against the real source as it stands on `main`
after v2.2.0 (commit `c2f7f6a`), not assumed.

---

## 1. Current Notes architecture and limitations

**Files:** [`src/notes.mjs`](../src/notes.mjs) (104 lines), [`src/renderer/notes.js`](../src/renderer/notes.js) (186 lines), three IPC handlers in `main.mjs` (~2576-2595), three preload calls, [`scripts/notes-test.mjs`](../scripts/notes-test.mjs) (38 checks).

**What it is today:**
- One file, `%APPDATA%\JARVIS\notes.json`, holding a single JSON array of every note on the PC. Not scoped to a workspace or project — it's one global notebook regardless of which workspace is open (`new NoteStore(userDir)`, `main.mjs:2576`).
- A note is `{ id, text, created, updated, sentAt }`. Plain text only, capped at 8,000 characters (`MAX_TEXT`) and 500 notes total (`MAX_NOTES`, oldest dropped). No title field — the title shown everywhere is just the first non-empty line (`titleOf()`).
- The editor is a bare `<textarea>` (`index.html:447`). No Markdown rendering, no formatting, no tables, checklists, code blocks, or images, even though the app already bundles `marked` + `DOMPurify` and uses them elsewhere (`JV.renderMarkdown`, `core.js:229`) — Notes is the one text-heavy view that doesn't use the app's own Markdown pipeline.
- Writes are atomic (temp file + rename, `notes.mjs:56-58`) — fixed in the v2.1.3 work, so a crash mid-save can no longer corrupt the file. But the granularity is the whole store: every save rewrites every note, and a parse failure on any one byte anywhere in the file loses access to **all** notes at once (`list()` returns `[]` on any JSON error, `notes.mjs:35`). There is no Trash (delete is permanent, guarded only by a two-press confirm in the UI) and no revision history — overwriting a note's text destroys the previous version with nothing kept.
- Unsaved work is kept as an in-memory draft per note id while the window is open (`drafts` Map, `notes.js:19`), but nothing is persisted to disk until Save is pressed — closing JARVIS loses an unsaved draft.
- The only integration beyond the Notes page itself: **Telegram** — `sendNote()` posts a note's title and body as a plain-text message to the configured chat, through the same `sendTelegram()` transport phone alerts use (`notes.mjs:103-107`); the token never reaches the renderer (confirmed by `notes-test.mjs:250-255`). There is **no** integration with Projects, Claude sessions, or Git — a note carries no project id, workspace id, session id, or branch reference, and nothing elsewhere in the app reads or writes a note.
- Ctrl+K's "Notes" entry (`app.js:282`) is a static view-name shortcut, identical to "Files" or "Devices" — it does not search note content. There is no full-text search over notes at all.
- No export, no backup beyond the one JSON file itself, no attachments.

**Concrete limitations this design has to address:**
1. Single-file-for-everything doesn't scale to attachments, revision history, or real search, and makes one damaged byte a whole-vault failure.
2. Plain text only — the "rich-text and Markdown" vision point starts from zero formatting today.
3. No project/session/Git linking model exists to extend — this is new surface, not an upgrade of something partial.
4. No search beyond the view name.
5. No backup target, no Trash, no revision history, no agent access of any kind.

## 2. Competitor-inspired feature comparison

| | Notion | Obsidian | OneNote | Google Keep/Docs | Goodnotes |
|---|---|---|---|---|---|
| Storage | Proprietary, cloud-hosted; export is clunky and lossy | **Plain files on disk** (Markdown), the single biggest reason for its popularity | Proprietary `.one` binary, cloud-synced | Cloud-hosted | Proprietary, cloud-synced |
| Offline | Degrades badly without a connection | **Fully offline-first**, sync is optional | Partial, awkward conflict handling | Poor | Decent for ink, poor for sync |
| Search | Good, but server-side (so not private) | Good, local, instant | Weak, especially for ink/handwriting | Good | Weak |
| Linking | Backlinks, databases | **Backlinks, graph view** - excellent | Weak | None | None |
| Extensibility | Plugins via API, cloud-gated | **Huge local plugin ecosystem** | Closed | Closed | Closed |
| Ownership of data | Weak - you're renting your own notes | **Strong** - it's your filesystem | Weak - Microsoft account required | Weak | Weak |
| Weakness to avoid | Slow, requires account+connection for anything, export is a chore | Steep plugin-config learning curve for non-technical users; no first-party rich media | Fragmented across platforms, binary format is opaque | Barely a notes app - no structure | Locked to Apple/Android app stores, no desktop-first story |

**The single strongest lesson, and the one this design leans on hardest:** Obsidian's core idea — *a note is a plain file you own, on your own disk, that still gets backlinks, search, and tags* — is both the most user-respecting model and the cheapest to build well, and it is **already the exact pattern this codebase uses** for Agents and Memory (`.md` files with YAML front matter, discovered by walking a folder — see §4). JARVIS Knowledge should be "Obsidian's local-file philosophy, with Notion's structure (tags, nested pages, templates) and Google Drive's backup convenience bolted on as an *optional* layer, driven by Claude instead of a separate AI add-on."

What NOT to copy: Notion's cloud-dependency (contradicts "offline-first" and "users always retain ownership"); OneNote's proprietary binary format (contradicts portability); any product's own account/sync system as the *only* way to get data in or out (contradicts §10 of the vision — "portable exports").

## 3. Recommended JARVIS Knowledge feature set

Grouped by what ships in the first milestone versus what the architecture should leave room for, without building it yet.

**Core (this initiative's target):**
- Markdown-as-source-of-truth notes, with a live preview (not a opaque rich-text blob) — tables, checklists, fenced code, images all expressible in GFM Markdown with zero new editing-format risk.
- Folders/notebooks (a note lives at a path, like files already do), tags (frontmatter field, free-form), favorites (a boolean frontmatter field).
- Fast local full-text search, wired into the existing Ctrl+K.
- File-per-note storage, Trash (soft delete), revision history (kept versions, not a diff engine).
- Attachments (images, PDFs, arbitrary files) stored beside the note, rendered safely.
- Optional linking to a Project, a Claude session, or a Git branch — set explicitly, never inferred silently.
- Opt-in: Claude Code can read your notes as a doc root (same mechanism as Memory/Knowledge today), so "AI-assisted search and summaries" is a reuse of the chat itself, not a new AI system.
- Opt-in manual Google Drive **backup** (a single zip, your own app-scoped Drive space) — explicitly not sync.
- Markdown export (notes are already just `.md` files, so this is close to free) and a "export everything as a zip" button.

**Deliberately deferred, with the storage model built so it doesn't block them later:**
- True rich-text WYSIWYG editing (Tiptap/ProseMirror) — evaluated in §9, not adopted yet.
- Backlinks and a graph view — needs an index of note→note Markdown links, which the full-text search index (§8 Phase 4) is the natural place to build from, but is its own phase.
- Nested pages as a first-class hierarchy beyond folders — folders cover most of the value at far less complexity.
- Templates — a thin feature once Markdown notes and folders exist (a "New from template" button over a `templates/` folder of note files).
- Two-way Google Drive sync, conflict merging.
- Handwriting/stylus/PDF annotation/canvas — needs a completely different input and rendering model (Electron + a canvas library, touch/pen event handling); explicitly out of scope until the Markdown core is solid.

## 4. Proposed storage model and migration strategy

**The key architectural decision: one Markdown file per note, with YAML front matter, not a database and not a single growing JSON array.**

This is not a new pattern for this codebase — it is the *exact* shape `src/agents.mjs` already implements for agent files, and `workspace.mjs`'s `docRoots()`/`listDocs()`/`readDoc()`/`frontMatter()` already implements for Memory and Knowledge documents. Reusing it means the storage layer is close to a port, not a new design:

```
%APPDATA%\JARVIS\knowledge\
  notes\<id>.md              one file per note, YAML front matter + Markdown body
  trash\<id>.md              soft-deleted notes (moved here, not removed)
  history\<id>\<ts>.md       kept versions, same pattern as agents.mjs's keepBackup()
  attachments\<id>\<file>    files attached to a note
  search-index.json          a rebuildable MiniSearch cache (never authoritative)
```

A note file:
```markdown
---
id: n1a2b3c4d
title: Shopping list
created: 2026-10-10T09:00:00.000Z
updated: 2026-10-10T09:04:00.000Z
tags: [home, errands]
favorite: false
folder: Personal/Errands
project: null        # a workspace-relative path, set explicitly
session: null        # a Claude session id, set explicitly
branch: null          # a Git branch name, set explicitly
sentAt: null
---

- [ ] Milk
- [ ] Bread
```

Why this beats the alternatives:
- **vs. keeping one `notes.json`:** a damaged byte anywhere today loses every note at once (`notes.mjs:35` treats any parse failure as "no notes"). With one file per note, a damaged file is one damaged note — every other note is unaffected and still readable, exactly the resilience property `config-file.mjs` already protects *config* with.
- **vs. a database (SQLite, etc.):** a new native dependency (`better-sqlite3` needs a prebuilt binary per Electron/Node ABI, which is exactly the kind of `@electron/rebuild` complexity already visible in the `npm run dist` build log for the native deps the app *does* ship), a new backup story (you can't just copy a `.md` file out of a SQLite file to "keep your data"), and a real step away from "portable exports, users retain ownership" (point 10 of the vision). A folder of `.md` files *is* the portable export - there's no format to escape.
- **vs. IndexedDB/a renderer-side store:** this app's renderer has no persistent storage today and the CSP (`connect-src 'none'`) and process-boundary model keep all real data in the main process - introducing browser storage would be a new, inconsistent persistence story the rest of the app doesn't have.

**Revision history** reuses `src/agents.mjs`'s already-shipped, already-tested pattern: before overwriting a note, copy the current version to `knowledge/history/<id>/<timestamp>.md`, capped at N kept versions (the same `MAX_BACKUPS` idea `agents.mjs:74` already uses for agent edits).

**Trash** reuses the idea already documented in the README's Safety section for Source Control's Discard: move, don't delete - `knowledge/trash/<id>.md` with a `deletedAt` stamp, a "Restore" action, and an auto-purge (or manual "Empty trash") after a configurable period.

**Full-text search:** index the `notes/` folder's front matter + body with **MiniSearch** (pure JS, zero network calls, tiny - see §9), rebuilt at startup (the corpus is a personal notebook, not a filesystem - hundreds to low thousands of documents, well inside "rebuild on every launch is fine" territory, the same assumption `project-discovery.mjs` already makes about scanning a workspace) and incrementally updated on save/delete. The result feeds the *existing* Ctrl+K (`app.js`'s `runSearch()`), the same way `searchDocs()` already feeds it for Knowledge/Memory documents - Notes becomes one more source in a mechanism that already exists, not a new one.

### Migration strategy

One-time, idempotent, and never destructive - the same shape the v1→v2 workspace migration already uses successfully (`main.mjs`'s `migrateWorkspaces()`, which keeps `config.before-v2.json` automatically):

1. On first run of the new code, if `notes.json` exists and `knowledge/notes/` does not yet have a `.migrated` marker:
2. Read every entry with the *existing* `NoteStore.list()` (already handles junk entries, missing timestamps, corrupt files gracefully — reuse it unchanged).
3. Write each as `knowledge/notes/<id>.md` with front matter built from the existing fields (`id`, `created`, `updated`, `sentAt`) and the existing text as the body. No data is reinterpreted or guessed.
4. Rename (never delete) `notes.json` → `notes.json.pre-knowledge-backup`.
5. Write the `.migrated` marker only after every note is confirmed written and read back correctly (count and a spot-check of ids, not just "the loop finished").
6. If anything fails partway, the original `notes.json` is untouched (steps 2-3 never modify it) and the `.migrated` marker is never written, so the migration simply retries next launch rather than running twice or silently losing notes.

No existing note is edited, reinterpreted, or dropped by this plan. Capacity limits (`MAX_TEXT`, `MAX_NOTES`) can be relaxed in the new model (file-per-note removes the reason for a global note-count cap; a per-note size cap can stay, generously raised, since attachments live beside the file rather than inside it).

## 5. Google Drive integration design

**Backup only, explicitly not sync**, per the instruction - and because sync is a materially harder problem (conflict resolution, watching for remote changes, partial-failure recovery) that deserves its own later design, not a rider on this one.

**Auth flow:** a Desktop-app OAuth client (the client type Google continues to support for the loopback flow — [Google's own migration guide confirms Desktop apps are unaffected by the native-app loopback deprecation](https://developers.google.com/identity/protocols/oauth2/resources/loopback-migration)), with **PKCE and no client secret to protect** — Google's own guidance is that an installed app cannot keep a secret confidential anyway, so there is nothing to store that would need protecting the way the client secret pattern implies. The flow:
1. JARVIS starts a short-lived HTTP listener on `127.0.0.1:<random port>`, in the main process only.
2. `shell.openExternal()` opens the system browser to Google's consent screen — the exact same "real browser, never an in-app one" pattern the app already uses for every other sign-in and link (`openOutside()`, `main.mjs:2460`).
3. Google redirects to the loopback listener with an auth code; the listener exchanges it for tokens, then closes itself immediately.
4. The refresh token is encrypted with `safeStorage` into `%APPDATA%\JARVIS\google-drive-token.bin` — the *same* function (`saveToken`/`loadToken`/`clearToken`) `updates.mjs` already uses for the GitHub token, applied to a new file.

**Scope: `drive.file` only.** This scope is explicitly ["non-sensitive" per Google's own scope documentation](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) and grants access only to files the app itself creates — JARVIS can never see, list, or touch anything else in the user's Drive, and critically this avoids Google's costly app-verification/security-assessment process that a broader `drive` scope would require. The user can see exactly what JARVIS has stored, and revoke it, from Drive's own "Manage Apps" settings.

**What gets backed up:** one timestamped zip of the whole `knowledge/` folder (notes + attachments; history optional, behind a setting, since it multiplies the size) per backup, uploaded as a single Drive file. A manual **"Back up now"** button is the whole v1 surface. A scheduled daily backup is a natural, low-risk Phase 2 addition once manual backup is proven — it would reuse the *already-built* Routines timer in `features.mjs` rather than inventing a new scheduler.

**Never in the renderer.** The CSP (`index.html:6`) sets `connect-src 'none'` — the renderer cannot make a network request at all, by design. Every Drive call, like every GitHub and Telegram call today, happens in the main process; the token and the Drive API responses never cross into the window. This is not a new rule to add - it is already true of everything else in the app, and Drive backup simply has to respect it like everything else does.

**Conflict handling (for the later, harder sync phase, not this one):** when it comes, the app's own established instinct — demonstrated by git-risk-policy's "ask, never silently resolve," the Agent Builder's exclusive-write-plus-version-check, and Source Control's Discard-to-Recycle-Bin — points at "never silently overwrite or merge; if both sides changed, keep both and let the person choose" over last-write-wins. That is a recommendation for when sync is designed, not a commitment made here.

## 6. Security, privacy, and data-loss threat analysis

| Risk | Current exposure | Mitigation in this design |
|---|---|---|
| One corrupt byte loses every note | **Real today** — `notes.mjs:35` treats any parse failure as "no notes," for the *whole* store | File-per-note: a damaged file is one damaged note |
| Crash mid-write | Already fixed (v2.1.3, atomic temp+rename) | Same pattern, applied per-note |
| Accidental permanent delete | Real today - delete is permanent after a two-press confirm | Trash (soft delete), matching Source Control's Discard-to-Recycle-Bin precedent |
| Overwriting loses the previous version | Real today - no history | Kept versions, reusing `agents.mjs`'s backup pattern |
| A note's image reaching outside the app | N/A (no images today) | Must go through a main-process-mediated path - **direct consequence of the Markdown-image hardening shipped in v2.2.0**, which now strips any `<img>` that isn't a `data:` URI. An attachment shown inline must be read by the main process and handed to the renderer as a `data:` URI (over IPC, size-capped), never as a `file://`/UNC path the renderer resolves itself. This is a hard constraint already proven necessary (the exact defect fixed in v2.2.0 was a Markdown image reaching outside the app and leaking a Windows network sign-in) - Notes attachments must not reopen it. |
| The Drive token reaching the renderer | N/A (no Drive integration today) | Never - same boundary already proven for the GitHub and Telegram tokens (`notes-test.mjs:250-255`'s exact kind of assertion extends naturally to a new `google-drive-token-test`) |
| An agent reading private notes without being asked | N/A (no agent access today) | Opt-in only, default off, its own explicit setup step - matching every other optional integration (Telegram, ClickUp, voice, the companion web app) |
| XSS via a crafted note (Markdown/HTML injection) | N/A (plain textarea today, nothing is rendered) | The *same* `DOMPurify`-sanitized `JV.renderMarkdown()` already proven across Chat, GitHub PR bodies, and the Agents page - no new rendering path, no new sanitizer to get wrong |
| A failed or partial Drive upload reported as success | N/A | Verify size (and, like `updates.mjs`'s installer check, a hash) after upload before marking a backup successful - reusing a pattern already proven for the installer download |
| Search index as a privacy leak | N/A | MiniSearch is pure JS, in-process, zero network calls - the index never leaves the device, and is itself just a rebuildable cache, never the source of truth |
| Private notes backed up to the cloud without being asked | N/A | Off by default; its own explicit sign-in and its own "Back up now" button, never automatic until the person has both connected Drive *and* turned on scheduled backups as two separate opt-ins |

**What this design does *not* need to worry about, and why:** Notes already live in `%APPDATA%\JARVIS`, outside any Git-tracked workspace, so none of the workspace-trust machinery (restricted workspaces, `.git/config`-triggered programs) applies to them - they are JARVIS's own data, not a project's.

## 7. UI/UX structure for the upgraded Notes module

Keep the existing two-pane shape (list left, editor right) that's already in `index.html` and already tested - it's a good layout, it just needs more on both sides:

- **Left pane:** a folder tree above the note list (folders are just a `folder:` front-matter field with a tree built from its `/`-separated value, no real nested-folder filesystem needed at first), a tag filter row, a Favorites toggle, and the list itself gains a small icon row (attachment count, linked project/session badge if set).
- **Editor header:** title (now a real field, pulled from the first heading or set explicitly - matching how Agents already derives a title, `agents.mjs`'s `firstHeading()`), tag chips with add/remove, a folder picker, the existing Send-to-Telegram switch, and a new **Link** button (to a Project, a Claude session, or a Git branch - each opens the same kind of picker the rest of the app already has: the project list, the session switcher, the branch list).
- **Editor body:** a Markdown/Preview split, toggleable to preview-only or source-only - *not* a WYSIWYG surface for v1 (see §9's reasoning). Attachments drop onto the editor the same way the Chat composer already accepts drag-and-drop (`chat.js:766`), reusing that exact interaction.
- **A History panel** (behind a clock icon), listing kept versions with a one-click "Restore this version" - mirroring the Undo/rewind pattern the Chat view already has for file changes.
- **A Trash view** (behind the existing page, not a new sidebar entry - a tab within Notes, like GitHub Desktop's Conflicts tab is a tab within Source Control), with Restore and Empty Trash.
- **Settings → Notes** (new tab, alongside the existing Phone alerts/ClickUp/Voice tabs): Google Drive connect/disconnect and "Back up now," the agent-access toggle, and the revision-history retention setting.
- Ctrl+K gains note results the same way it already shows Memory and Knowledge document hits - a note's title and a matched-text snippet, opening straight into the editor.

## 8. Small implementation phases, with tests and acceptance criteria

Each phase is independently shippable and testable, following this codebase's existing pattern of one focused `scripts/<name>-test.mjs` per feature slice.

| Phase | What ships | Acceptance criteria / tests |
|---|---|---|
| **1. Storage migration** | File-per-note storage, the one-time migration, `NoteStore` rebuilt over the new layout with the *same* public API `notes.js` already calls (so the renderer needs zero changes this phase) | Every existing `notes-test.mjs` check still passes unchanged; a new migration test proves: every note round-trips byte-for-byte, a mid-migration crash (simulated) leaves `notes.json` intact and retries cleanly, and running the migration twice is a no-op |
| **2. Markdown + metadata UI** | Live preview (reusing `JV.renderMarkdown`), title/tags/folder fields, Favorites | A note with a table/checklist/code block renders correctly in preview; tag and folder round-trip through save/reload; existing plain-text notes still open and edit correctly (no forced reformatting) |
| **3. Trash + revision history** | Soft delete, Restore, kept versions, Restore-a-version | Deleting moves (never removes) the file; two presses are still required to delete, as today; every save beyond the first keeps a prior version, capped; restoring a version replaces the current text and keeps a version of *that*, so restoring is itself never destructive |
| **4. Full-text search** | MiniSearch index, wired into Ctrl+K | A note is findable by a word only in its body (not just the title) within one keystroke-debounce of being saved; the index rebuilds correctly from a cold start with zero notes, with 1 note, and with notes added/edited/deleted while JARVIS is open |
| **5. Attachments** | Drag-and-drop attach, inline image rendering via the main-process `data:` path | An attached image renders in preview; the exact same `security-test.mjs`-style assertion (no `file://`/UNC image ever reaches the DOM) is extended to cover note attachments; a non-image attachment opens via `shell.openPath`'s existing `OPENABLE`-allowlist pattern, never run directly |
| **6. Linking** | Project/session/branch fields + pickers, a "Save as note" action from Chat and Source Control | A note linked to a project shows on that project's detail pane (reusing the existing detail-pane layout); linking is always an explicit user action, never automatic |
| **7. Agent-readable notes (opt-in)** | A `knowledge` doc root Claude Code can read when the person has switched it on, surfaced the same way Memory/Knowledge already are | Off by default - a session reports no awareness of notes until the toggle is on; once on, the existing `docRoots()`/`readDoc()` path proves it (same containment tests `security-test.mjs` already runs for Memory/Knowledge, extended one more root) |
| **8. Google Drive backup** | Connect, disconnect, manual "Back up now," later a scheduled option | OAuth round-trip tested with a fake token server (no real Google call in CI); the token is proven never to reach the renderer (mirroring `notes-test.mjs:250-255`); a backup's upload is verified by size+hash before being reported successful, matching `updates.mjs`'s installer-download verification |

Each phase ships behind the same quiet, additive discipline the rest of this app uses: nothing is granted, connected, or changed automatically, and every phase after the first can be reviewed and approved on its own, the same way this discovery document itself is being reviewed before any of it is built.

## 9. Estimated dependencies and maintenance costs

| Candidate | Role | Verdict | Why |
|---|---|---|---|
| **MiniSearch** | Full-text search index | **Recommend** | Pure JS, zero dependencies of its own, tiny, built-in fuzzy/prefix matching and ranking - a good fit for a personal-notebook-sized corpus (hundreds to low thousands of documents), far less maintenance surface than FlexSearch's larger config API or standing up Lunr for the same job. [Comparison](https://socket.dev/npm/package/minisearch/overview/7.2.0) |
| **FlexSearch** | (alternative) | Not recommended for v1 | Faster at real scale, but that scale (hundreds of thousands+ documents) isn't this corpus, and its API is more to maintain for no benefit here |
| Existing `marked` + `DOMPurify` | Markdown preview | **Already shipped, zero new cost** | Already a dependency, already proven across the app; no new library at all for Phase 2's preview |
| **CodeMirror 6** (optional, Phase 2+) | A nicer Markdown-source editing surface than a bare `<textarea>` (syntax highlighting, line handling) | Worth considering, not required | Small, modular, actively maintained; purely additive polish over the textarea the rest of the app already uses successfully (chat composer, agent instructions) - can be skipped entirely with no loss of core functionality |
| **Tiptap / ProseMirror** | True WYSIWYG rich-text editing | **Defer, do not adopt yet** | A real, ongoing maintenance commitment (a large extension API surface, its own security-patching cadence) for a feature (binary-ish rich-text blocks) that Markdown source + preview already covers at v1 scope. Revisit only once Markdown-first notes are shipped and real user demand for block-based WYSIWYG (not just formatting) shows up. No other part of this app uses a UI framework (React/Vue) either - adopting one just for Tiptap would be a second inconsistency, not one |
| **Google APIs client** | Drive backup | Prefer a minimal hand-rolled REST client over `googleapis` | The existing codebase already talks to GitHub's and Telegram's REST APIs with plain `fetch` and no SDK (`github.mjs`, `telegram.mjs`) - Drive's `drive.file`-scoped upload surface (list, create, update, get) is small enough that pulling in Google's large `googleapis` package (and its own dependency tree) isn't needed, matching this app's consistent "no SDK where a few `fetch` calls do the job" style |
| A new agent runtime / MCP server for notes | Agent access | **Not needed for v1** (§3, §8 Phase 7) | Exposing notes as a `docRoots()` entry lets Claude Code read them with its *existing* Read/Grep tools - no new tool-exposure mechanism, no new runtime, directly satisfying "no second AI runtime" |
| A real database (SQLite et al.) | Storage | **Not recommended** | See §4 - a new native-binary dependency and a real step away from "portable exports, user owns their data," for no benefit this corpus size needs |

**Net new runtime dependencies for the full phase plan above: one (MiniSearch).** CodeMirror is optional polish. Nothing else in the plan needs a new package.

## 10. Recommended first implementation milestone

**Phase 1 + Phase 2 together** (storage migration, then Markdown/metadata), shipped as one release:

- It is the one phase where getting the *migration* right matters most, and it's also the one phase with no user-visible risk if something is wrong (the renderer's calls don't change, so a bug would show up as "notes behave exactly as before," not as a new failure mode) - the safest place to prove the new storage model before building anything on top of it.
- It immediately fixes the single worst existing weakness (one corrupt byte loses every note) without yet asking the user to trust anything new (no cloud, no agent access, nothing optional to turn on).
- It gives every later phase (search, trash, history, attachments, linking) a stable foundation to build on, in the order that defers the costliest/least-certain pieces (Drive OAuth, agent access, rich WYSIWYG) the longest.

Everything from Phase 3 onward should wait for your review of how Phase 1+2 actually feels in use, rather than being speculatively built ahead of that - consistent with "small implementation phases" being the point, not just the words.
