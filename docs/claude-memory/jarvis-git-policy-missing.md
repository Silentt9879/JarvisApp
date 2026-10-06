---
name: jarvis-git-policy-missing
description: "The workspace C:\\Users\\User\\Downloads\\Bantu Apps has no .claude\\jarvis\\git-risk-policy.json, so JARVIS's Source Control treats every write as destructive; sc-undo-discard-test is skipped until it is restored"
metadata:
  node_type: memory
  type: project
  originSessionId: cdf91711-015f-424f-9f18-24c835fdc75a
  modified: 2026-10-06T15:53:18.231Z
---

As of 2026-10-06 the workspace folder on this PC, C:\Users\User\Downloads\Bantu Apps, has no `.claude` folder at all, so there is no `.claude\jarvis\git-risk-policy.json`. The rules are kept in the workspace on purpose (src/git-policy.mjs says so; `.claude/hooks/git-guard.py` reads the same file), so the repo cannot supply them.

Effect: with no policy, `classify()` fails closed. Source Control reads still work, but every write (undo, discard, commit-undo) asks for confirmation as destructive, and "undo the last commit" is refused as not undoable. The git guard hook for Claude Code is also not reading any rules here.

`scripts/sc-undo-discard-test.mjs` now prints SKIPPED unless `JARVIS_POLICY_FILE` points at the policy file. Do not invent rules to make it pass; the user has to bring the real file back (their other PC's BantuApps workspace may have it).

**Why:** Found during the "find all problems" pass on 2026-10-06; the user said "do all" and the policy was the one item I could not honestly fix.

**How to apply:** If the user asks why Source Control keeps asking to confirm, or why undo is refused, check for this file first. Do not write a policy file yourself without the user's rules. See [[jarvis-app]].
