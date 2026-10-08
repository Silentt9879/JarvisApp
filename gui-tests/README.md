# GUI regression tests (Playwright + Electron)

Real end-to-end tests that launch the actual packaged (or dev) JARVIS, drive its real
windows, and assert real visible behavior — not source-text/regex "wiring" checks like
`scripts/main-chat-ipc-test.mjs` uses for the things that genuinely can't be driven this way.

## Why these don't run from the same place as `npm test`

Playwright's Electron support (`_electron`) and every other Windows GUI automation approach
(Windows UI Automation, PowerShell's `UIAutomation` module, raw `SendInput`) all ultimately
depend on the OS **window station** the target process's windows are created on. They can
only see and interact with windows on their own, interactive window station.

On the machine this harness was written on, a spawned GUI process (verified with plain
`notepad.exe`, independent of JARVIS or Electron entirely) fails to create any window at all
— confirmed twice, with two different parent processes: once launched directly from the
agent's own shell (Phase 9), and once launched by the Windows Task Scheduler service into the
real interactive console session, completely independent of that shell's process tree (Phase
11) — the Notepad process didn't even survive 800ms in the second case. That rules out "it's
just this shell's own restricted process tree" as the explanation; the limitation is broader
than that, specific to this particular machine/session, and not something either launch path
could get around. No GUI framework can get past it, because they all sit on the same OS
window-station primitive that's already unavailable here. See the Phase 9 and Phase 11
reports for the exact diagnostics.

**Run these on a machine that actually has a working interactive desktop for GUI processes**
— most ordinary Windows machines qualify; this one specifically does not, for reasons not
fully understood beyond what's described above. They are not wired into `npm test` or any CI
here, specifically so they never silently fail to run or silently "pass" with nothing tested.

## One-time setup (on a GUI-capable machine)

```
npm install --save-dev @playwright/test
npx playwright test --config gui-tests/playwright.config.mjs
```

(Electron automation doesn't need `playwright install`'s browser downloads — it drives the
app's own Electron/Chromium, not a separately-launched browser.)

## What's covered

| Spec | What it does | How |
|---|---|---|
| `jarvis.spec.mjs` → startup/shutdown | Launches JARVIS, asserts the main window really appears with real visible text, then closes it and asserts the process actually exits | Real window, real DOM text, real process exit code |
| `jarvis.spec.mjs` → secondary chat window | Clicks "Open a chat in a new window", asserts a second real window exists, closes it by itself, asserts it's gone | `electronApp.windows().length` before/after |
| `jarvis.spec.mjs` → power down quits with remote control unset | Opens a secondary window, types "power down" in the main chat and sends it, asserts **both** windows close as the process exits | Real typed text, real click, real window count, real process exit |
| `jarvis.spec.mjs` → application logs | After a session, asserts the isolated `jarvis.log` file has real, readable startup lines | Real file read, post-run |
| `telegram-migration.spec.mjs` | Pre-seeds an isolated config with a plain-text Telegram token, launches JARVIS, asserts the encrypted file now exists and the plain-text field is gone from config.json | Real app startup, real file-level assertions — **no real Telegram network call**, so this doesn't drive the "Check token" button (see the spec's own comment for why) |
| `workspace-trust.spec.mjs` | Points JARVIS at a restricted (untrusted) folder, asserts the real "Restricted workspace" warning is shown, clicks "Trust this folder", asserts it clears | Real DOM text and button — launched **without** `JARVIS_CAPTURE` (see the spec's own comment: capture mode always reports the workspace as trusted, so the shared fixture can't be used for this one) |

A Phase 10 review found the power-down test originally claimed to verify the sleep-to-tray
path (every window closes, process stays alive), but that path only runs when
`remote.ready` is true (a configured Telegram token+chat id) — under this harness's disposable
config it's always false, so `powerDown()` actually takes `app.quit()` instead (main.mjs).
The test above was rewritten to match the path it can safely and honestly exercise. Testing
the sleep-to-tray path itself would mean either a real (harmless but real) network call to
Telegram's `getUpdates`, or a small, explicitly-approved production test seam (an injectable
`api` for remote.mjs's poll loop, the same pattern `git.mjs`/`github.mjs` already use) — not
something to default into silently either way.

## What's deliberately not here yet

- **GitHub error handling** through the real UI: would need the main process's own outbound
  HTTPS calls intercepted (not just Playwright's page-level network routing, which doesn't
  see Electron main-process `fetch`/`https` traffic). Sketched as a stretch goal, not
  implemented — `scripts/github-test.mjs` already covers this behaviorally at the module
  level with a fake `fetch`.
- **Start-with-Windows**, **real NSIS install/uninstall**, **taskbar identity**: these need
  the actual installed app and real Windows shell state, not just a launched process — out of
  scope for an Electron-level harness regardless of window-station access. Covered by the
  manual checklist (`v2.1.3-manual-test-checklist.md`) instead.
- **Tray icon interactions** (clicking "Wake up" from the tray): the tray isn't part of any
  `BrowserWindow`'s page content, so Playwright can't click it directly; it would need OS-level
  UI Automation on top of Playwright, which needs the same window-station access this
  environment doesn't have either way.

## Isolation

Every test launches JARVIS with `JARVIS_USERDATA` pointed at a fresh temp directory and
`JARVIS_CAPTURE`/`JARVIS_CAPTURE_CWD` set (the app's own existing screenshot/demo-run mode —
see `src/main.mjs`), the same mechanism used for the Phase 5 manual smoke check. No test
touches the real `%APPDATA%\JARVIS`, no test uses a real Telegram token, and no test sends a
real Claude API request. Each spec cleans up only the temp directory it created.
