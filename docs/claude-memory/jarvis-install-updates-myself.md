---
name: jarvis-install-updates-myself
description: "User wants me to install JARVIS updates myself (swap build + restart, update bot menu) instead of giving them steps"
metadata:
  node_type: memory
  type: feedback
  originSessionId: cfadd9da-e276-4541-a3f2-3bdc49c3c593
  modified: 2026-10-06T15:05:56.491Z
---

After building a JARVIS change into dist-next, install it myself: run `npm run brand-bot` if Telegram commands changed, then launch `scripts\swap-update.ps1` detached (it waits 4 s, closes the live JARVIS, swaps dist-next into dist\win-unpacked, keeps dist\win-unpacked.old, restarts JARVIS; log in swap-update.log). Since 2026-10-03 it kills every process in the folder (including claude.exe) and copies with robocopy instead of renaming the folder. Renaming kept failing with "file in use" even with nothing running, so don't switch it back to Move-Item. I usually run *inside* JARVIS (my claude.exe is its child), so check swap-update.log on the next turn to confirm it worked. Said 2026-10-03: "U do it again for me from now on".

Since 2026-10-06 (v1.6.0) the build is an installer: `npm run dist` writes dist-installer\, and its `win-unpacked` folder is the same app, so for a swap copy `dist-installer\win-unpacked` into `dist-next\win-unpacked` (robocopy /MIR; exit 1 just means files copied) and then launch swap-update.ps1. On 2026-10-06 the user said "Sure, swap it" for v1.6.0 after I warned that the swap ends this session, since my claude.exe runs under the live JARVIS.

**Why:** The user doesn't want to do the tray-quit and folder swap by hand.

**Changed 2026-10-06:** the user no longer wants swaps. They said "when i press update for jarvis it auto updates it instead of swap it in". From v1.6.0 on, JARVIS updates itself: Settings > Updates > Update JARVIS downloads the GitHub release installer (`JARVIS-Setup-x.y.z.exe`), checks it, closes, installs silently and reopens. So after a JARVIS change, do not swap. Build with `npm run dist`, and publish the installer as a GitHub release (needs the user's go-ahead). The one-time swap on 2026-10-06 was the exception the user asked for.

**How to apply:** Still announce it as a system update ([[jarvis-update-announcements]]), but say it's already installed and JARVIS will restart, rather than listing steps. Warn first that the restart ends a conversation happening through JARVIS. See [[jarvis-app]].
