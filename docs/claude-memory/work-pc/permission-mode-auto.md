---
name: permission-mode-auto
description: "User wants every Claude session (new and resumed) in auto permission mode, not ask; applying the setting is the user's own step"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 50f13dcf-797c-400a-a6d1-f307fa362435
  modified: 2026-10-05T05:20:12.131Z
---

User wants every chat, new or resumed, to run in **auto** permission mode instead of ask (2026-10-05).

**Why:** fewer approval prompts during long work sessions.

**How to apply:** treat it as a standing preference. Claude must NOT change the permission mode or any settings file itself: the auto-mode classifier blocked that as self-modification on 2026-10-05, and the user was told how to set it. If a session starts in ask mode, mention it once; don't change it. Auto mode does not relax the safety rules: still confirm destructive or outward-facing actions as CLAUDE.md requires.
