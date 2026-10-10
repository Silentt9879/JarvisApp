# Phase 5 Task 5 — Isolated Windows Validation Profile & Procedure

This is a **procedure to run**, not something this session executed — it requires a real
Windows GUI session, which this agent cannot drive directly (confirmed repeatedly across this
project's own history; see `docs/jarvis-google-drive-design.md` §16 for the precedent of a
human-run live test documented the same way). Everything below is written so you (or anyone
else) can run it directly, safely isolated from your real JARVIS install.

## Why isolation, and how it's guaranteed

JARVIS reads its working folder from the `JARVIS_USERDATA` environment variable when set
(the same mechanism the project's own Phase 24E live Drive test already used), falling back to
the real `%APPDATA%\JARVIS` only when it's unset. Setting it to a throwaway temp folder means:

- No file under your real `%APPDATA%\JARVIS` is ever opened, read, or written.
- No real `notes.json`, real Knowledge notes, real Drive tokens, or real config.json are
  touched.
- The installed, production JARVIS (if you have one) is untouched — this procedure runs a
  **packaged-but-separate** build (`electron-builder --win --dir`, never `npm run dist`'s
  installer), in its own folder, never overwriting or registering over the real install.

## Setup

```powershell
# 1. A disposable profile folder - never your real one.
$env:JARVIS_USERDATA = "$env:TEMP\jarvis-phase5-validation"
Remove-Item -Recurse -Force $env:JARVIS_USERDATA -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $env:JARVIS_USERDATA | Out-Null

# 2. Build a standalone, unpacked copy - never touches the real installed JARVIS.exe or its
#    Start Menu entry, and is not the installer (`npm run dist`).
cd C:\Users\User\Downloads\JARVIS_App
git status  # confirm you're on feature/unified-notes-phase1 with nothing uncommitted you'd lose
npm run pack   # electron-builder --dir, per package.json's own script

# 3. Launch the unpacked build with the isolated profile still set in THIS shell.
.\dist\win-unpacked\JARVIS.exe
```

Keep `$env:JARVIS_USERDATA` set in the same PowerShell session you launch `JARVIS.exe` from —
closing and reopening a new terminal without re-setting it would fall back to the real
profile, which this procedure must never touch.

To start completely clean between test runs: `Remove-Item -Recurse -Force
$env:JARVIS_USERDATA` and recreate it, rather than reusing a profile across unrelated test
scenarios.

## Synthetic test data (never real notes)

Seed the isolated profile with synthetic data **before** first launch, so the automatic
migration has something realistic to carry over:

```powershell
$cfg = $env:JARVIS_USERDATA
Set-Content -Path "$cfg\notes.json" -Encoding utf8 -Value @'
[
  {"id":"synth1","text":"Synthetic test note one - grocery list: milk, eggs, bread.","created":1700000000000,"updated":1700000001000,"sentAt":null},
  {"id":"synth2","text":"Synthetic test note two - vet appointment: switch food gradually over two weeks.","created":1700000002000,"updated":1700000003000,"sentAt":null}
]
'@
```

For a synthetic "test Google account," per the safety rules this procedure does **not**
connect to any real Google account for routine validation — use the fake-provider-backed
automated suite for anything that would otherwise need one. If a real-account test is
specifically authorized later (Phase 2/3's own production-readiness gate), use a **disposable
throwaway Google account and a disposable OAuth test client in Testing mode**, never a
personal or production account — the same precedent as the Phase 24E live test, which used a
dedicated test project and test user.

## Repeatable GUI verification procedure

Each numbered step is independently repeatable (re-run after any code change) and checks one
thing; run them in order the first time, since several depend on state the earlier ones create.

1. **Launch** — confirm no console errors (Ctrl+Shift+I → Console) on startup.
2. **Nav** — confirm **Notes** is the primary-row item; **Notes (Classic)** is under "More".
3. **Automatic migration** — open Notes; confirm a one-time message that synthetic notes were
   carried over; confirm `$env:JARVIS_USERDATA\notes.json` still exists, byte-identical to what
   you seeded (`Get-FileHash` before/after, or just reopen it in Notepad).
4. **Folders** — open a note, set Folder to `Test/Nested`, Save; confirm it appears nested
   (indented) in the sidebar tree; click it, confirm only that note shows.
5. **Pinning** — pin an older note; confirm it sorts first.
6. **Telegram** — without Telegram configured, confirm "Send to Telegram" stays hidden on a
   saved note (this profile has no Telegram token, so this should be the only reachable state
   in this procedure — do not configure a real Telegram bot token for this isolated profile).
7. **Exclude from AI** — toggle it on a note, Save, close JARVIS (not just the window - fully
   quit, including tray), relaunch with the same `$env:JARVIS_USERDATA` still set, reopen the
   note, confirm the toggle is still on.
8. **Ask about your notes** — open the modal, search for a word from one of your synthetic
   notes, confirm a result with a snippet; search for a word that exists ONLY in the
   AI-excluded note from step 7, confirm **zero** results; click "Ask in Chat" on a real
   result, confirm it switches to Chat with the composer filled and **does not send**.
9. **Trash + Version History** — delete a note (moves to Trash), restore it; edit a note twice,
   open Version History, confirm two versions, restore the older one, confirm the newer one is
   itself still listed (nothing is a one-way trip).
10. **Drive panel, no real account** — confirm it looks exactly as the pre-Phase-2 UI did
    (BYO-client fields only) unless you've deliberately set a test Client ID in
    `src/drive-app-client-config.json` or via `JARVIS_GOOGLE_CLIENT_ID` for this run — if you
    have, confirm the "Connect Google Account" button and its early/testing notice appear, and
    that "Use my own Client ID instead" still reveals the original fields.
11. **Backup/Sync status, disconnected** — confirm Back Up Now / Sync Now sections stay hidden
    while disconnected (no Drive account connected in this profile).
12. **Full quit and relaunch** — fully quit JARVIS (tray → Quit, not just closing the window),
    relaunch with the same isolated profile, confirm every change above (folder, pin,
    AI-exclusion, trash state, version history) persisted correctly.

Only steps involving a real Google account (10–11, if you deliberately opt into a disposable
test account) require anything beyond this isolated local profile; every other step is fully
offline and uses only the synthetic data above.

## Running the automated suite as part of this procedure

Before or after the manual steps, from the same `JARVIS_App` checkout (this does **not** need
`JARVIS_USERDATA` set — the automated suite only ever uses its own `fs.mkdtempSync` temp
directories, never `%APPDATA%\JARVIS` or the variable above):

```powershell
npm test
```

Expected: exit code 0, every suite reporting `0 failed`. If anything regresses, fix it and
re-run before proceeding with the manual GUI steps — the manual procedure is meant to confirm
what the automated suite already proved, in a real window, not to substitute for it.

## What this procedure deliberately does not do

- Does not touch `%APPDATA%\JARVIS` (the real profile) at any point.
- Does not run `npm run dist` (the real installer) or register anything in Windows'
  Programs/Start Menu.
- Does not connect to a real, personal, or production Google account under any circumstance
  unless you explicitly choose to, with a disposable test account and test OAuth client, as a
  separate, deliberate decision outside this routine procedure.
- Does not modify, read, or depend on any real Drive backup you may already have.
