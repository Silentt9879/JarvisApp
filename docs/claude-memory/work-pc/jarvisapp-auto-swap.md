---
name: jarvisapp-auto-swap
description: "After building a JarvisApp change, swap it in / restart JARVIS straight away without asking the user"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 50f13dcf-797c-400a-a6d1-f307fa362435
  modified: 2026-10-06T03:11:53.792Z
---

When a JarvisApp (desktop JARVIS) change is built into `dist-next` and verified, swap it in and restart
JARVIS immediately (`scripts/swap-update.ps1`, run detached) - do not ask "say swap it in" first.
User, 2026-10-06: "in the future, just restart without asking me".

**Why:** the user always answered "swap it in" anyway; asking only adds a round trip.

**How to apply:**
- Build, verify (tests + a capture where useful), then swap. Report what changed after, not before.
- The swap closes everything running from `dist\win-unpacked`, including claude.exe sessions JARVIS
  started - it can end the current session. So finish every other step first (memory, notes, report
  text), say in one line that JARVIS is restarting, and make the swap the LAST tool call.
- Still ask first if the change is risky or unverified (failed tests, untested data-writing flow).
Related: [[permission-mode-auto]].
