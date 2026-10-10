# Phase 5 Task 6 — Release Readiness Matrix

Snapshot as of commit `88d9277` on `feature/unified-notes-phase1`. Nothing merged, pushed,
tagged, or released. This is a decision input, not a decision — it stops short of
recommending a release date, per the brief's own instruction to await your authorization.

## Passed automated tests

Full `npm test` (60 suites, chained): **exit code 0**, zero failures, across every phase
checkpoint from Phase 1 through Phase 5. Notable additions this phase: `drive-sync-safety-test`
(9), `ai-security-boundary-test` (11), `integration-audit-test` (7) — all passed on first run,
meaning the audit *confirmed* correctness rather than needing fixes, with two exceptions:

- A real UX gap found and fixed: conflict status showed only a count, not which notes
  (`drive-sync-controller.mjs`'s new `conflictingNotes`).
- Two real preservation bugs found and fixed in Phase 4 itself (documented in that phase's
  report): `markKnowledgeNoteSent` and `deleteKnowledgeNote` both silently dropped the new
  `aiExcluded` field.

No regressions were found in Phase 5 testing of Phases 1–4's existing behavior — Task 1's
integration audit, specifically designed to catch cross-phase breakage, found none.

## GUI tests still requiring manual verification

Everything in `docs/phase5-windows-validation.md`'s 12-step procedure — none of it has been
run against a real Windows GUI session by this agent (confirmed limitation, not skipped).
Highest-value steps: #3 (automatic migration, real window), #7 (AI-exclusion survives a full
quit/relaunch), #8 (Ask-about-your-notes never auto-sends), #12 (full persistence after a real
restart, not just a fresh function call in a test).

## Real Google OAuth tests still required

None have been run this phase (by design — no real Google account was touched, per the
safety rules). Specifically outstanding before Phase 2 can be called production-ready:

1. A real OAuth consent flow against a **Published, verified** Client ID (the one real
   account test already run, Phase 24E, used a Testing-mode client and predates the app-owned
   path entirely).
2. The app-owned "Connect Google Account" one-click flow, end to end, against a real account.
3. Token refresh over a real multi-day span (Testing-mode's 7-day refresh expiry is a known
   platform fact, never observed live in this project).

## Real two-device sync tests still required

None have been run against real hardware/real Drive — every sync test in this project
(Phases 3 and 5) runs against `FakeDriveProvider`. Required before Phase 3 can be called
production-ready: the full procedure in `docs/phase3-drive-sync.md`'s own "Multi-device
synchronization testing procedure" section, against two real machines (or two isolated
profiles, per Task 5's own isolation method) sharing one real, verified Google account.

## External Google verification blockers

Unchanged from Phase 2/3's own reports: Google Cloud Console project + OAuth consent screen
verification for the `drive.file` scope, requiring your own Google account and real calendar
time for Google's review (historically days to a few weeks for a non-sensitive scope) —
outside engineering's control. Exact steps are in `docs/phase2-google-login.md`. As of this
phase, the only engineering-side change needed once verification completes is editing one
field in `src/drive-app-client-config.json` — no code change, no environment variable.

## Security or data-loss risks

None found at **CONFIRMED** severity during this phase's audit. Noted, pre-existing, and
already documented limitations (not new findings):

- Sync's remote-change detection re-downloads/hashes every file each pass — a scaling
  limitation, not a correctness risk, at the personal-notebook volumes this app targets.
- No dedicated conflict-review inbox beyond the (now-named, per this phase's fix) status line
  and Version History — a discoverability limitation, not a data-loss one (nothing is ever
  lost; it's always a snapshot away).
- Version History has no pruning (a deliberate Decision 4 choice) — unbounded growth is a
  storage-size concern, flagged with a warning, never a loss risk.
- AI search is keyword-only, not semantic — a quality limitation on "natural language," not a
  security one; the exclusion/permission boundary itself was specifically audited this phase
  and held (11/11 checks, Task 4).

## Remaining release blockers

1. **External**: Google OAuth verification (gates Phase 2, and most of Phase 3 for real
   users) — not something engineering can accelerate.
2. **Manual, not yet run**: the Windows GUI procedure (Task 5) and the real-account/
   real-two-device tests above — all explicitly deferred per the safety rules, not skipped by
   oversight.
3. **Your own decision, not a code gap**: whether to ship Phase 1 (Unified Notes) and Phase 4
   (AI Knowledge) ahead of Phases 2/3, since neither has an external dependency — this is a
   product-sequencing choice, not something this audit can resolve for you.

## Summary

| Area | Code-complete | Integration-audited | Real-account/real-device tested | Externally blocked |
|---|---|---|---|---|
| Phase 1 — Unified Notes | Yes | Yes | N/A (no external dependency) | No |
| Phase 2 — Google Login | Yes | Yes (fake provider) | **No** | **Yes** (Google verification) |
| Phase 3 — Drive Sync | Yes | Yes (fake provider) | **No** | **Yes** (depends on Phase 2) |
| Phase 4 — AI Knowledge | Yes | Yes, including a dedicated security audit | N/A (no external AI call exists) | No |

**No merge, push, tag, or release is recommended by this report — that decision is explicitly
yours.** Phases 1 and 4 have cleared every gate available to automated testing; Phases 2 and 3
are code-complete but gated on work outside this session's reach.
