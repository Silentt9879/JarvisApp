---
name: jarvis-feature-lessons
description: "Practical lessons from the 2026-10-07 JARVIS feature sprint: a config loader that returned two keys hid every setting, Git Bash mangles backslashes and quotes in commands, capture-mode screenshots with JARVIS_USERDATA, and where unit tests stop"
metadata:
  node_type: feedback
  type: feedback
  originSessionId: cdf91711-015f-424f-9f18-24c835fdc75a
  modified: 2026-10-06T17:48:38.640Z
---

- `loadConfig()` in main.mjs returned only `cwd` and `phone`, so every feature that read another key (budget, phone web app switch, update notes, first-run flag) silently saw nothing. Found only by a visual check (the What's new card did not appear). Fixed: it returns the whole file. Unit tests that inject their own config cannot catch this; scripts/features-wiring-test.mjs builds the features with a real config file, and that is the test to extend.
- In this tool environment, backslashes and single quotes inside a bash command get mangled: a config written with `\\` ended up with single backslashes (invalid JSON), and the app quietly fell back to its default folder. Write JSON with forward slashes (Windows accepts them), or write a small .mjs file with the Write tool and run it.
- Visual QA that works: `JARVIS_USERDATA=<temp folder>` (a throwaway data folder, with a valid config.json), `JARVIS_VIEW=<view>` or `JARVIS_CAPTURE_SCRIPT=<file.js>` (runs the script before the screenshot, at `JARVIS_CAPTURE_SCRIPT_AT` ms), `JARVIS_CAPTURE=<file.png>`. Then Read the PNG. Renderer errors show in the temp folder's jarvis.log.
- The Edit tool refuses files that were changed by scripts in this session until they are Read with the Read tool; read first.
- New popovers in the composer copy the position of `.slash-pop` (`bottom: calc(100% + 8px)`); a popover without it opens below the window.
- The new dialogs take buttons as specs `{ label, value, onClick, role }`; passing DOM nodes there silently breaks the dialog.

- After an in-app update the window could stay in the tray. On the 1.7.1 update the updater's last line ("window is showing" / "no window yet") never reached jarvis.log, so its fallback never ran. Fixed in 1.7.2 by focusing the window when started with `--updated` (`app.focus({ steal: true })`). The gap in the updater is still unexplained: check the "update:" lines in jarvis.log first.
- Removing a sidebar button is not just deleting markup: `renderNavBadges` wrote to the Workspace, Knowledge and Memory badges, so removing them would have thrown on every refresh. Before deleting a DOM element, grep for its id and for `$('<id>')` writes, and check index-based shortcuts (`PRIMARY` in app.js mapped Ctrl+3 to Automations).

**Why:** these cost real time in this sprint.
**How to apply:** before calling a feature done, run it once through the window (capture or the real app) and read the log; do not rely only on unit tests. See [[jarvis-feature-sprint]].
