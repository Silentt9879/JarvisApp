# Phase 4 — AI Knowledge

Code-complete. Entirely local/offline-testable (no network, no AI provider call in any test),
and — by design — this phase never calls an AI provider at all; it hands a composed prompt to
the *existing* chat composer for the person to review and send themselves.

## Architectural decision: reuse the chat, don't build a second AI runtime

The Phase 0 audit's own recommendation (`docs/phase0-unified-notes-audit.md`) was explicit:
"Opt-in: Claude Code can read your notes... so 'AI-assisted search and summaries' is a reuse
of the chat itself, not a new AI system." This phase follows that literally rather than
building a parallel Claude API integration:

- **Search and retrieval** (`src/notes-search.mjs`, new) is local, pure-JS keyword scoring —
  no embeddings, no external call, consistent with the existing Knowledge design doc's own
  choice (§9) to prefer a small, dependency-free approach at this corpus size.
- **"Answer questions using notes as context"** is implemented as: retrieve the few
  best-matching notes, compose a prompt that cites them explicitly, and call
  `JV.chat.insert(prompt)` — the *exact* function the search box's command-palette already
  uses to pre-fill the composer (`app.js`'s own `/command` handler). This switches to the
  Chat view and fills the composer; **nothing is sent until the person presses Send
  themselves.** No new SDK call, no new tool registration, no second permission boundary to
  get right — the existing chat session's own tool access, token handling, and SDK call path
  are the only ones involved, unchanged.
- This also directly satisfies "require user confirmation for destructive or bulk AI edits"
  by construction: this phase gives an AI model no write access to Notes at all. There is no
  destructive-AI-edit code path to confirm, because none exists.

## What was built

- **`aiExcluded`** (`src/knowledge.mjs`): a new per-note front-matter field, default `false`
  (included), the exact mechanics `favorite` already has (parse/render/validate/
  meaningfully-changed comparison). A note with `aiExcluded: true` is filtered out before
  `notes-search.mjs` ever scores it — never a result, never AI context, no matter how well it
  matches. Also fixed two real preservation bugs found while wiring this through:
  `markKnowledgeNoteSent` and `deleteKnowledgeNote`'s own note-rebuilding both omitted the
  field entirely, which would have silently reset a note back to "included" the next time it
  was sent to Telegram or moved to Trash — caught and fixed before anything else was built on
  top of the field.
- **`src/notes-search.mjs`** (new): `tokenize`, `scoreNote` (title > tag > body, keyword
  matching, capped per-term so repetition can't dominate), `searchNotes` (ranked, zero results
  for no match — never "every note, sorted"), `notesForAiContext` (bounded to
  `MAX_CONTEXT_NOTES` = 5 notes, each truncated at `MAX_CHARS_PER_NOTE` = 4000 characters,
  returns `ok:false` rather than a silent empty/fallback context when nothing matches),
  `buildContextPrompt` (pure string composition, numbered citations).
- **`jarvis:notesSearch` / `jarvis:notesAskContext`** (`src/main.mjs`, read-only; a dedicated
  test confirms neither calls any write/save/delete/migrate function, and neither calls
  `fetch`/an external API directly).
- **Renderer** (`knowledge.js`/`index.html`): an "Exclude this note from AI search & chat
  context" toggle next to Pin; an "Ask about your notes" button opening a small modal
  (debounced local search-as-you-type, result list with title/folder/snippet as the citation,
  "Ask in Chat" which fetches the composed prompt and calls `JV.chat.insert`).

## Respecting note-level AI permissions / excluding private notes

`aiExcluded` is the permission. It is checked once, centrally, inside `searchNotes` (both the
plain search path and the AI-context path call it) — there is exactly one place in the
codebase that decides whether a note is eligible, not a check duplicated (and potentially
missed) in several call sites. A dedicated test proves an excluded note never appears even
when it is the single best textual match for the query.

## Never sending the entire notes database to an external AI provider

Two independent guarantees, both tested:

1. `notesForAiContext` caps at 5 notes (`MAX_CONTEXT_NOTES`) and 4000 characters each
   (`MAX_CHARS_PER_NOTE`) — never "all of them."
2. It returns `ok:false` (not an empty-but-successful result) when nothing actually matches
   the query, so a caller can never mistake "nothing relevant" for "here's some context
   anyway" — there is no silent fallback to recent/random notes filling the gap.

And because sending anything to Claude at all still goes through the person's own,
already-open chat composer and their own press of Send, the actual decision of "does this
leave my machine" is always theirs, not automatic.

## Files changed

- `src/knowledge.mjs` — `aiExcluded` field throughout (parse/render/validate/save/preserve);
  fixed two pre-existing field-preservation bugs this change exposed.
- `src/notes-search.mjs` (new) — the local search/retrieval engine.
- `src/main.mjs`, `src/preload.cjs` — `jarvis:notesSearch`/`jarvis:notesAskContext`.
- `src/renderer/knowledge.js`, `src/renderer/index.html`, `src/renderer/styles.css` — the
  "Exclude from AI" toggle and the "Ask about your notes" modal.

## Test results

- `scripts/notes-search-test.mjs` (new): 14/14 — tokenizing, scoring, zero-results-for-no-match,
  the `aiExcluded` gate (search and AI-context paths both), corrupt-note exclusion, the
  context-notes cap, per-note truncation, and the composed prompt's citations.
- `scripts/knowledge-renderer-test.mjs` (extended): 113/113 — the toggle round-tripping
  through a real save and surviving a reopen; the full Ask flow (search, citation display,
  "Ask in Chat" inserting into the real `JV.chat.insert`, and the empty-result case), through
  the real renderer code.
- `scripts/knowledge-ipc-test.mjs` (extended): 58/58 — both new handlers proven read-only
  (never call a write/save/delete/migrate function) and proven to never call `fetch` or an
  external API directly; the renderer proven to only ever call `JV.chat.insert`, never a
  direct send/submit of its own.
- Full `npm test`: exit code 0.

## Known limitations

- **Keyword matching, not semantic/embedding search.** A question phrased very differently
  from how a note is written may not match well. This was a deliberate scope choice
  (consistent with the existing Knowledge design doc's own corpus-size reasoning), not an
  oversight — upgrading to a real local embedding model would be a much larger, separate
  decision (a new dependency, a model to ship or download, meaningfully more compute) that
  this phase did not attempt.
- **No "ask and get an answer inline" experience** — the person must switch to Chat and press
  Send themselves. This is the deliberate safety/consent boundary described above, not a
  missing feature to fix later without revisiting that tradeoff first.
- **No bulk/automated AI note editing of any kind exists**, so "require confirmation for
  destructive AI edits" has nothing to guard yet — if a future phase gives an AI model write
  access to Notes, that confirmation gate would need to be designed and built then, not
  assumed to already exist because this phase's own read-only scope made it moot.
- **The composed prompt is plain text, not a structured tool call** — if a future phase wants
  Claude to be able to decide for itself when to search notes (rather than the person
  triggering it from the Notes page), that would need real SDK tool/MCP registration, which
  this phase deliberately did not attempt (see the architectural decision above).
