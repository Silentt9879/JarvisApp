---
name: jarvis-feature-sprint
description: "The 2026-10-07 JARVIS feature sprint ('do all of them'): 15 improvements plus usage on AI Core, shipped as v1.7.0 on the private JarvisApp repo, and what still needs checking on a real device"
metadata:
  node_type: memory
  type: project
  originSessionId: cdf91711-015f-424f-9f18-24c835fdc75a
  modified: 2026-10-06T16:53:34.149Z
---

On 2026-10-07 the user asked for all 15 improvements. All are built, tested, and released as v1.7.0 (commit 49e36d9, tag v1.7.0, installer JARVIS-Setup-1.7.0.exe, 209.6 MB, release on the private JarvisApp repo). The user then asked for usage on AI Core (like Claude's usage page, and `/usage` in the chat) and a Notion-style AI Core; that is done too.

Shipped:
- Health page (status pill), first-run walk-through, What's new card after an update
- Settings in tabs with search; text size and high contrast
- Replies read aloud (Windows voices); "JARVIS" wake word (local speech model, no cloud)
- Routines (read-only by default), two chats side by side (`window:newChat`), Allow/Deny on notifications
- Phone web app (src/companion.mjs + src/companion/index.html; off by default; access code; rate limited)
- Usage: plan limits on AI Core from `/usage` (free) and live rate_limit events; estimated cost and daily budget
- Activity log (secrets hidden, exportable), saved prompts with blanks, project starters
- Smaller installer: onnxruntime DirectML.dll, dxcompiler.dll, dxil.dll left out (CPU speech model verified without them); saves about 14 MB compressed

Not yet checked on real hardware (only unit/capture tested): the wake word with a real microphone, Windows notification Allow/Deny buttons, the phone web app from an actual phone, Telegram delivery of routine results, the second chat window's own session under real use.

Release mechanics that worked: `npm run dist`, commit "Update v1.7.0: ...", tag, push, REST API release with the git-stored token (gh is not installed), and verify with the app's own updater code (resolveToken, jarvisStatus, downloadInstaller).

**Why:** the user wants the app more user-friendly and more capable.
**How to apply:** the running JARVIS is the session I am inside; do not restart it mid-task. Keep `npm test` green. Lessons from this sprint are in [[jarvis-feature-lessons]]. See [[jarvis-app]] and [[jarvis-usage-command-facts]].
