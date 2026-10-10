# Phase 6 Task 2 — Windows GUI Validation

## What was automated, and what genuinely requires you

**Automated in this phase:**
- The full `npm test` suite (60 suites) — see `docs/phase6-release-decision.md` for results.
- Building the packaged release candidate (Task 1) — succeeded, binary signed, verified to
  exist at the path below.
- An attempted automated launch-smoke-test of the packaged `.exe` (start the process, confirm
  it stays running a few seconds, no GUI interaction). **Result: this automation environment
  cannot launch a real Electron window at all** — confirmed by testing a known-good prior
  release candidate (`dist-rc-2.4.0`) the exact same way, which exited identically. This is a
  pre-existing, already-documented limitation of this agent's own environment (no interactive
  desktop session available to it), not a defect introduced by this build. **I am not
  claiming any GUI smoke test passed** — only that the build artifact exists, is signed, and
  that the failure mode observed is proven to be environmental, not build-specific.

**Genuinely requires you** (a real Windows desktop session): every numbered step below.

## Release candidate location

```
C:\Users\User\Downloads\JARVIS_App\dist-rc-phase6\win-unpacked\JARVIS.exe
```

Built via `npx electron-builder --dir -c.directories.output=dist-rc-phase6` from
`feature/unified-notes-phase1` at commit `fac7201`. Version number unchanged (`2.4.0`, per
`package.json`) — this is explicitly a validation build, not a new public version. Does not
touch `dist/`, `dist-installer/`, or any existing `dist-rc-*` folder from a previous release.

## Isolated setup (run once, before any step below)

```powershell
$env:JARVIS_USERDATA = "$env:TEMP\jarvis-phase6-gui-validation"
Remove-Item -Recurse -Force $env:JARVIS_USERDATA -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $env:JARVIS_USERDATA | Out-Null
Set-Content -Path "$env:JARVIS_USERDATA\notes.json" -Encoding utf8 -Value @'
[
  {"id":"synth1","text":"Synthetic note - grocery list: milk, eggs, bread, oranges.","created":1700000000000,"updated":1700000001000,"sentAt":null},
  {"id":"synth2","text":"Synthetic note - vet appointment: switch food gradually over two weeks.","created":1700000002000,"updated":1700000003000,"sentAt":null}
]
'@
# Launch with the same env var still set in THIS shell:
& "C:\Users\User\Downloads\JARVIS_App\dist-rc-phase6\win-unpacked\JARVIS.exe"
```

This never touches `%APPDATA%\JARVIS` (your real profile) or any installed JARVIS.

## Verification steps (each independently checkable; run in order the first time)

### 1. Unified Notes navigation
**Do:** Look at the sidebar.
**Expect:** **Notes** appears in the primary row (not under "More"). **Notes (Classic)**
appears under "More". Clicking each switches views correctly; no console errors
(Ctrl+Shift+I → Console).

### 2. Legacy migration
**Do:** Open **Notes**.
**Expect:** A one-time message that the two synthetic notes were carried over automatically
(no button press needed). Both appear in the list. Open `%TEMP%\jarvis-phase6-gui-validation\notes.json`
in Notepad — it must still contain the original two synthetic entries, untouched.

### 3. Folders and pinning
**Do:** Open "grocery list," set Folder to `Test/Shopping`, Save. Pin the "vet appointment" note.
**Expect:** The sidebar folder tree shows `Test` (indented `Shopping` beneath it); clicking
`Shopping` filters to just that note. The pinned note sorts to the top of the list regardless
of its date.

### 4. Telegram Send
**Do:** Open any saved note.
**Expect:** "Send to Telegram" stays **hidden** (this isolated profile has no Telegram token
configured — do not configure a real bot token for this validation run). This confirms the
button is correctly gated on readiness, not shown unconditionally.

### 5. Trash and Version History
**Do:** Delete the "grocery list" note (moves to Trash tab), then Restore it. Edit it twice
more, each time changing the body, then open Version History.
**Expect:** Delete/Restore round-trips correctly. Version History lists at least two earlier
versions; selecting one shows a side-by-side compare; restoring an older version itself gets
checkpointed (the version you just replaced is still listed afterward).

### 6. AI exclusion settings
**Do:** Open the "vet appointment" note, click the shield icon ("Exclude this note from AI
search & chat context"), Save. Fully quit JARVIS (tray icon → Quit, not just closing the
window) and relaunch with the same `$env:JARVIS_USERDATA` still set.
**Expect:** Reopening the note shows the toggle still on. The note is otherwise fully visible
and editable in the normal list — exclusion only affects AI, never the owner's own view.

### 7. AI search and chat composer integration
**Do:** Click "Ask about your notes." Search `vet food` (should match the excluded note AND
possibly nothing else, depending on your other synthetic notes). Then search `grocery milk`
(should match the grocery note, which is not excluded).
**Expect:** Searching `vet food` returns **zero results** (the only matching note is
excluded). Searching `grocery milk` returns the grocery note with a real snippet. Click "Ask
in Chat" on that result — confirm the view switches to **Chat**, the composer is filled with
a prompt citing the note by title, and **nothing is sent automatically** — you must press
Send yourself.

### 8. Existing manual Google Drive backup/restore interface
**Do:** Open the Drive panel (inside Notes' sidebar).
**Expect, with no Client ID configured (the real state of this build)**: looks exactly as the
pre-Phase-2 UI did — only "Configure OAuth Client ID" and the BYO-client fields, no "Connect
Google Account" button, no sync status line (all hidden while disconnected). This proves the
app-owned path adds nothing visible until deliberately configured. Do **not** connect a real
Google account during this routine validation pass (see Task 3/4's own docs for when that's
separately authorized).

### 9. Full restart persistence
**Do:** Fully quit (tray → Quit) and relaunch with the same profile one more time.
**Expect:** Every change from steps 3, 5, 6 above is still exactly as you left it.

## What this procedure deliberately excludes

Real Google account connection, real OAuth consent, and real two-device sync are **not**
part of this routine GUI pass — see `docs/phase6-oauth-production-checklist.md` and
`docs/phase6-two-device-sync-validation.md` for those, which require your own explicit,
separate authorization and a real account.
