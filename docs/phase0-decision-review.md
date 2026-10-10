# Phase 0 — Architecture Decision Review

Companion to [`phase0-unified-notes-audit.md`](./phase0-unified-notes-audit.md). Read-only —
no code, config, data, or Google Drive content has been touched to produce this. Six
decisions, each with the problem, every realistic option, a recommendation and why,
trade-offs across security/data-loss/compatibility/usability, and what it blocks. No
implementation, commit, or Phase 1 work begins until you decide.

---

## Decision 1 — Google OAuth: app-owned client vs. BYO client, and verification timing

### The problem

The brief's product vision requires nontechnical users to never create a Google Cloud
project or paste a Client ID. The app currently requires exactly that (`index.html:479-481`,
by deliberate prior design — see `jarvis-google-drive-design.md` §3). Closing that gap means
JARVIS ships its own OAuth client, which immediately runs into Google's publishing-status
rules: an unverified ("Testing") client caps at 100 test users and **expires every refresh
token after 7 days** — silently breaking background sync for everyone, with no error a user
would understand. This is the single highest-leverage decision in the whole brief: it gates
how much of Phase 2 and all of Phase 3 can actually reach a nontechnical user.

### All realistic options

**A. App-owned client, pursue full Google verification/publishing before shipping to
nontechnical users.**
Register one OAuth client under a JARVIS-controlled Google Cloud project, request
`drive.file` (Google's own "non-sensitive" scope tier), submit for verification, wait for
approval, then ship. Until approved, the app-owned path stays behind a flag / internal-only.

**B. App-owned client, ship immediately in Testing mode, accept the 7-day/100-user limits as
a known, surfaced condition.**
Ship now; make the "connection expired, reconnect" UX (already built — `drive-connection.mjs`
already classifies `invalid_grant` as `expired`) do double duty as the once-a-week
re-auth prompt. No nontechnical user ever sees a Client ID field, but they do see a weekly
"please reconnect Google Drive" prompt indefinitely.

**C. Keep BYO-client as the only path (status quo), improve its onboarding UX (copy-paste
instructions, a guided wizard) instead of removing it.**
Does not meet the brief's explicit requirement ("must never be required to create their own
Google Cloud project"), but is the only option with zero new external dependency or waiting
period.

**D. Hybrid: ship the app-owned client behind a flag now (so the code path is built,
tested, and ready), keep BYO-client as the default/only visible path until verification
completes, then flip the default once Google approves it.**

### Recommendation: D, with verification submission started in parallel immediately

Submitting for verification is "start the clock," not "wait to start the clock" — Google's
own review turnaround for a non-sensitive scope is typically on the order of days to a few
weeks, not instant, but it isn't gated on JARVIS writing any more code first. Running A alone
(wait, then build) wastes that calendar time. Running B alone (ship Testing-mode now) directly
contradicts "nontechnical users should not hit confusing friction" — a weekly forced
reconnect is exactly the kind of thing a non-technical person will interpret as "the app is
broken," and support burden lands on you, not Google's docs. D lets engineering and
verification proceed in parallel, with BYO-client as a working fallback the whole time
(nothing currently works regresses), and a single flag flip once Google approves, rather than
a second implementation phase later.

### Trade-offs

- **Security**: no change from today's model — PKCE, no secret to protect (a public desktop
  client's "secret" per Google's own guidance isn't confidential either way), encrypted
  fail-closed token storage. Shipping an app-owned Client ID inside JARVIS's build is safe
  specifically because it was never a secret.
- **Data-loss**: none directly; the risk is entirely availability (users locked out of sync
  weekly until reconnect) if B is chosen without a clear UX, which can indirectly cause
  data-loss anxiety (users think their Drive backup silently stopped).
- **Compatibility**: zero impact on existing BYO-client users during the transition — their
  configured client keeps working regardless of which path the app-owned client takes.
  Existing `drive-client.bin`/`drive-token.bin` storage format needs no change.
- **Usability**: D is the only option that gets nontechnical users to zero-setup *and* avoids
  a confusing weekly prompt, but only once verification lands — until then, a nontechnical
  user is still asked to either use BYO-client or wait.
- **External/process risk unique to this decision**: Google's verification requirements
  (verified domain, privacy policy URL, possibly a demo video depending on current policy)
  are outside engineering's control and can change; this should be tracked as a product
  task with its own owner, not assumed to be a fixed-duration engineering subtask.

### Blocks

**Blocks Phase 2's core promise directly** ("Connect Google Account" with zero setup) and, by
extension, most of **Phase 3** for nontechnical users, since automatic background sync is far
more exposed to the 7-day Testing-mode expiry than a manual once-a-week backup click would be
(a silent background sync failure is worse UX than a manual action failing). Does **not**
block Phase 1 (Unified Notes) or Phase 4 (AI Knowledge) — both are fully local-first and
independent of this decision.

---

## Decision 2 — Legacy Notes retirement: adopt Knowledge Notes' engine as the single model

### The problem

Two storage engines exist for conceptually the same thing: `notes.json` (weak write safety,
no Trash/history, weak IDs) and Knowledge Notes' per-file Markdown store (verified writes,
Trash, version history, strong IDs, revision-checked concurrency). Unifying Notes requires
picking one engine to be the foundation, and the brief explicitly requires the migration to
be safe, idempotent, recoverable, and non-destructive of the originals.

### All realistic options

**A. Adopt Knowledge Notes' storage engine as the one model for all notes.** Legacy
`notes.json` is migrated via the existing `migrateFromLegacy`, then kept untouched as a
recovery artifact (already renamed to `notes.json.pre-knowledge-backup` by that function).

**B. Adopt legacy Notes' simpler JSON-array model as the one model**, porting Trash/version
history/revision-checking down onto it.

**C. Build a third, new storage engine** that supersedes both (e.g., SQLite or another
database), migrating both existing stores into it.

**D. Keep both engines running side by side indefinitely**, with a unified *UI* only (a thin
view layer that reads/writes to whichever store a given note already lives in).

### Recommendation: A

The existing Knowledge Notes engine is already strictly better on every axis that matters for
this merge: write-safety (read-back verification vs. none), damage isolation (one corrupt file
vs. one corrupt byte losing everything), ID strength (CSPRNG UUIDs vs. `Math.random()`), and
it already has 187+ passing tests covering exactly the edge cases a migration-based design
needs (duplicate IDs, corrupt sources, interrupted runs, idempotent re-runs). Option B would
mean re-building all of that from scratch on a weaker foundation. Option C adds a native
dependency (`better-sqlite3` or similar, with its own prebuilt-binary-per-ABI complexity) for
no benefit at this data volume (personal notes, not a document corpus) and is a real step away
from "a note is a plain file you own" — the architectural principle the existing Knowledge
design doc already validated and that the new brief's own "local-first, user owns their data"
principle reinforces. Option D avoids a migration decision only by deferring it — it does not
unify anything, just adds a dispatch layer, and still leaves legacy Notes' permanent-delete/
no-history behavior live and user-visible, which contradicts the brief's own "distinguish
local saves, synchronization and recovery backups" clarity requirement.

### Trade-offs

- **Security**: no new surface — same IPC validation discipline, same containment checks
  already tested in `knowledge-ipc-test.mjs`.
- **Data-loss**: the migration itself is the data-loss risk surface, but it's the
  *already-mitigated* kind — `migrateFromLegacy` never deletes/renames `notes.json` until a
  verified backup copy exists, is idempotent (safe to retry/re-run), and reports duplicate
  IDs as conflicts rather than silently merging. The main residual risk is **telling the user
  clearly** that their old notes are preserved and where, since the migration is otherwise
  already safe at the code level.
- **Compatibility**: legacy Notes' one feature Knowledge Notes lacks — "send to Telegram" —
  must be ported onto the new save path, or users relying on it will perceive a regression.
  `jarvis:noteSave`/`jarvis:noteDelete` IPC calls would need to be redirected to the Knowledge
  engine or deprecated with a compatibility shim for any external callers (none currently
  found outside `notes.js`).
- **Usability**: users gain Trash and version history for notes that never had them before —
  a strict improvement, but should be called out explicitly (e.g., a one-time "your notes are
  now safer" notice) since behavior change (delete is now recoverable, not instant/permanent)
  could otherwise be surprising in either direction.

### Blocks

**Blocks Phase 1 entirely** — this is Phase 1's central decision. Also indirectly affects
**Phase 3**, since whichever engine is chosen becomes what the Drive backup allowlist and
sync layer operate on (today's allowlist already only covers the Knowledge-engine paths, so A
requires no change there; B or C would require re-deriving the backup allowlist and the
existing tested manifest/integrity logic against a different storage shape).

---

## Decision 3 — Dead fields: build `folder` UI (and `project`/`session`/`branch`) or drop them

### The problem

Knowledge Notes' schema already carries `folder`, `project`, `session`, `branch` end-to-end
through the backend, but no renderer UI ever sets or displays them — they're backend-only,
unused in practice today. The brief asks for folders and pinned notes in the unified Notes
UI, which gives `folder` a real purpose; `project`/`session`/`branch` have no corresponding
ask in the brief.

### All realistic options

**A. Build real UI for `folder` now (per the brief); formally drop `project`/`session`/
`branch` from the schema** (remove the fields, with a one-time migration that just discards
them since they're always empty in practice today — confirmed by the audit, no renderer has
ever written to them).

**B. Build UI for all four fields now**, including project/session/Git-branch linking
pickers, even though the current brief doesn't ask for it.

**C. Drop all four fields**, including `folder`, and build a *new* folder mechanism from
scratch if/when needed.

**D. Leave all four exactly as they are** (backend-only, no UI) and revisit later.

### Recommendation: A

`folder` has a direct, explicit ask in the brief ("Add folders... where appropriate") and the
field, validation, and IPC plumbing already exist and are already tested — building the UI
for it is the cheapest way to satisfy that requirement. `project`/`session`/`branch` have no
corresponding ask anywhere in the current brief; carrying them forward unused (option B or D)
means maintaining schema surface, migration logic, and test coverage for a feature nobody has
asked for and that was speculative when it was first added (per the original Knowledge design
doc, "set explicitly, never inferred silently" — i.e., it was always meant to be optional/
deferred). Dropping unused fields now, while the schema is already being touched for
unification, is cheaper than dropping them in a later migration once real user data might
start populating them. Option C (drop `folder` too) would mean re-doing work that already
exists and is tested, for no reason — the brief wants folders.

### Trade-offs

- **Security**: none — removing unused optional fields has no security implication; keeping
  them doesn't either, since they're validated the same as any other front-matter field.
- **Data-loss**: essentially zero risk either way — the audit confirmed these three fields
  are never set by any existing UI, so dropping them discards nothing a user has ever
  populated. (Still worth a defensive check-and-log during migration — if any value is found
  non-null, surface it rather than assume, in case some external tool wrote to the file
  directly.)
- **Compatibility**: dropping fields from the schema is backward-compatible with existing
  `.md` files (unknown/removed keys are simply absent going forward; the engine's existing
  "preserve unknown keys" behavior means any stray value wouldn't be silently destroyed if
  present, just no longer managed).
- **Usability**: building real folder UI directly satisfies a stated requirement; not
  building project/session/branch avoids shipping half-finished, confusing linking UI for a
  feature with no current use case (avoids violating the "don't design for hypothetical
  future requirements" principle this project already follows elsewhere).

### Blocks

**Blocks Phase 1's folder requirement** if not decided, but does not block Phase 2/3/4 at
all — this is a self-contained Phase 1 scoping decision.

---

## Decision 4 — Version History retention: cap it now or defer

### The problem

Every meaningfully different save now creates a permanent snapshot (`knowledge/overwritten/`,
as of commit `f168e1a`), with no retention cap or expiry — a known, already-documented gap
(design doc §16.6). Unifying Notes into this engine means *every* note (including
high-frequency-edit notes that previously had no history at all under legacy Notes) starts
accumulating snapshots, and every Drive backup after this now includes whatever
`overwritten/` has grown to. This compounds an existing, acknowledged problem rather than
introducing a new one — but unification is exactly the moment it stops being a minor gap.

### All realistic options

**A. Design and ship a retention policy as part of Phase 1** (e.g., keep N most recent
snapshots per note, or keep all snapshots within the last N days, or a combination,
configurable, with a safe pruning job that's itself tested the way every other mutation here
is — atomic, never prunes the only remaining version, etc.).

**B. Ship Phase 1 with retention unchanged (unbounded), track it as an explicit, prioritized
follow-up**, with a warning surfaced to the user once their Knowledge folder passes some size
threshold ("Version History is using N MB — manage it in Settings").

**C. Cap retention very conservatively right now with a hardcoded limit** (e.g., always keep
only the last 10 versions per note, no configurability), as a stop-gap.

### Recommendation: B, with a size/count warning, deferring full policy design to its own
reviewed follow-up

Designing a good retention policy (what counts as "safe to prune," how it interacts with a
note that's also in Trash, how it interacts with a Drive restore that expects a manifest's
files to still exist locally for hash verification, whether pruned versions should be
recoverable from a completed Drive backup even after local pruning) is nontrivial enough that
rushing it into Phase 1 risks exactly the kind of "half-finished implementation" the project
explicitly wants to avoid. The risk of deferring is bounded and visible (storage growth, not
data loss — nothing is silently lost by *not* pruning) where the risk of a rushed pruning
policy is not (a bad prune *is* data loss). A simple size/count warning is cheap to add now and
buys time to design pruning properly without leaving the user blind to the growth in the
meantime.

### Trade-offs

- **Security**: none.
- **Data-loss**: this decision is specifically about *preventing future data-loss from a
  rushed pruning feature* vs. *accepting disk-growth as the lesser, reversible problem* — B
  is the data-loss-conservative choice.
- **Compatibility**: a future pruning feature must be designed to never prune the only
  surviving backup copy of a note's content, and must account for the Drive backup's own
  manifest expecting files to exist — this is exactly the kind of cross-cutting constraint
  that justifies not bolting it on hastily now.
- **Usability**: unbounded growth will eventually cause slow Drive backups and large local
  storage for heavy users; a visible warning at least sets expectations rather than a silent
  surprise.

### Blocks

**Does not block Phase 1, 2, or 3 directly** — it's additive and can ship independently at
any point. It does make **Phase 3 (sync)** progressively more expensive the longer it's
deferred (more snapshot files to reconcile per sync pass), so it should be prioritized
*before* Phase 3's heavy lifting begins, even if not bundled into Phase 1.

---

## Decision 5 — Naming cleanup: resolve the three "Knowledge"-named surfaces

### The problem

Today's nav has "Notes," "Knowledge Notes," and (unrelated) the Workspace page's "Knowledge
Base" tab (a `.claude/knowledge` docs browser). Unifying Notes removes the "Notes" vs.
"Knowledge Notes" split but leaves "Knowledge Base" sitting there with a confusingly similar
name to whatever the unified feature ends up called.

### All realistic options

**A. Rename the unified feature to something unambiguous (e.g., "Notes"), and separately
rename the Workspace "Knowledge Base" tab to something that doesn't collide (e.g., "Project
Docs" or "Docs")** — two independent renames, each cheap, each removing one axis of
confusion.

**B. Rename only the unified notes feature, leave "Knowledge Base" as-is.** Reduces three
collisions to two-ish (still "Notes" vs. "Knowledge Base" sound related to a new user).

**C. Leave all naming as-is**, relying on the Phase 1 UI merge itself (one nav entry instead
of two) to implicitly resolve most of the confusion.

### Recommendation: A

This is a pure UX/naming decision with essentially no engineering cost or risk — a nav label
and a few UI strings, not a data model change. Given the brief explicitly lists "Clear UX:
users can distinguish..." as an architectural principle, and the audit found this exact
confusion already flagged, doing the full cleanup (both renames) rather than a partial one is
the lowest-cost way to fully satisfy that principle rather than leaving a residual, lesser
version of the same problem.

### Trade-offs

- **Security/Data-loss**: none — purely cosmetic/label changes, zero storage or logic impact.
- **Compatibility**: zero — renaming a nav label and tab title doesn't touch any file format,
  IPC contract, or stored data.
- **Usability**: strictly positive; the only "cost" is that existing users have to learn a
  slightly different label, which is minor compared to the confusion it resolves.

### Blocks

**Blocks nothing** — purely cosmetic, can be done at any point, cheapest to bundle into
Phase 1's UI work since that's when the nav is being touched anyway.

---

## Decision 6 — Multi-device sync conflicts: never auto-merge vs. allow automatic resolution

### The problem

Phase 3 explicitly requires "detect concurrent modifications and preserve conflicts" — this
decision is about *what happens when a note changed both locally and in Drive since the last
sync*. This is the hardest and highest-risk decision in the whole brief: get it wrong and
either (a) a user silently loses an edit on one device, or (b) the app becomes so cautious
it's unusable (every edit triggers a conflict prompt).

### All realistic options

**A. Never auto-merge content; always surface true conflicts (both sides changed since last
common sync point) to the user, who picks "keep mine," "keep theirs," or "keep both" (saving
one side as a duplicate/snapshot).** Non-conflicting changes (only one side changed) sync
automatically with no prompt. This mirrors the existing restore design's own "preview,
named conflicts, explicit confirm" pattern and the project's established "ask, never silently
resolve" instinct (cited directly in the existing Drive design doc for the *future* sync
case).

**B. Last-write-wins by timestamp** (whichever side has the more recent `updated` timestamp
overwrites the other silently). Simple, but directly risks silent data loss — exactly the
failure mode the brief explicitly says to avoid ("never silently overwrite or discard
changes").

**C. Automatic three-way text merge** (like Git) for the note body, falling back to a
conflict prompt only if the merge itself can't be resolved cleanly (overlapping edits to the
same lines).

**D. Field-level merge** (if only front-matter like `tags`/`favorite` changed on one side and
only body text changed on the other, merge both without a prompt; only prompt if the *same*
field changed on both sides).

### Recommendation: A, with D as a refinement once A is proven in practice

A is the only option that fully satisfies the brief's explicit "never silently overwrite or
discard changes" requirement with zero ambiguity, and it reuses a conflict-surfacing/
explicit-confirmation pattern that is already built, tested, and proven in this exact codebase
(the restore preview→confirm flow). B is explicitly ruled out by the brief's own stated
principle. C (automatic text merge) sounds appealing but is real, hard-to-get-right
complexity for Markdown notes specifically — a "clean" line-based merge can still silently
produce a nonsensical combined note (e.g., two edits to the same checklist in different
orders) that *looks* successful but corrupts meaning, which is arguably worse than an explicit
prompt because the user doesn't even know to check. D is a reasonable later refinement
(reduces prompt frequency for the common case of "I added a tag on my phone, edited the body
on my laptop") but should be built as a refinement *on top of* A's conflict-detection logic
once that's shipped and trusted, not as the initial design — shipping D first risks getting
the "same field changed on both sides" detection subtly wrong on day one with no simpler
fallback already proven in production.

### Trade-offs

- **Security**: not materially affected by this choice either way.
- **Data-loss**: this is the data-loss decision for Phase 3. A is the only option with a
  rigorous guarantee (nothing is ever discarded without the user explicitly choosing);
  B has a direct, demonstrable data-loss failure mode; C has a subtler "silently wrong content"
  failure mode that's arguably worse than data loss because it's harder to detect after the
  fact.
- **Compatibility**: A requires no new fields beyond what optimistic-concurrency already
  needs (a revision/hash per side, already how Knowledge Notes' local concurrency works
  today) — extending that same revision concept to "last known synced revision" per note is a
  natural, additive extension, not a redesign.
- **Usability**: A's cost is conflict prompts whenever genuine concurrent edits happen across
  devices — for most personal-notes usage patterns (edit on one device at a time) this should
  be rare, but a user who regularly edits the same note from two devices simultaneously will
  see prompts more often. This is the correct trade against B's silent-loss risk and C's
  silent-corruption risk, and is mitigated over time by D once proven.

### Blocks

**Blocks Phase 3 entirely** — this is Phase 3's central design decision, and should be locked
in before any sync-loop code is written, since the revision/metadata model the sync engine
tracks per note depends directly on which resolution strategy is chosen.

---

## Summary table

| # | Decision | Recommended option | Blocks |
|---|---|---|---|
| 1 | OAuth: app-owned vs BYO client, verification timing | D — build app-owned path behind a flag now, submit verification in parallel, flip default once approved | Phase 2 core promise; most of Phase 3 for nontechnical users |
| 2 | Storage engine for unified Notes | A — adopt Knowledge Notes' engine, migrate legacy via existing `migrateFromLegacy` | Phase 1 entirely; shapes Phase 3's backup allowlist |
| 3 | Dead fields (`folder`/`project`/`session`/`branch`) | A — build `folder` UI now, drop the other three | Phase 1's folder requirement only |
| 4 | Version History retention | B — defer full policy, ship a size/count warning now | Nothing directly; should land before Phase 3's heavy sync work |
| 5 | Naming cleanup | A — rename both the unified feature and the Workspace "Knowledge Base" tab | Nothing; bundle into Phase 1's UI work |
| 6 | Sync conflict resolution | A — never auto-merge, always surface true conflicts; D as a later refinement | Phase 3 entirely |

No code, configuration, or data has been changed. Waiting for your decisions on the six items
above before any Phase 1 implementation work begins.
