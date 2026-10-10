# Phase 6 Task 4 — Two-Device Real-Account Sync Validation

**Not executed.** This document is the procedure only. Running it requires a real Google
account connected to real Google Drive, which this session will not do without your explicit,
separate approval — per the brief's own instruction and this project's standing safety rules.
Nothing here has touched, and will not touch, your real Google Drive data unless and until you
run it yourself (or explicitly direct an agent to, with a disposable test account — see the
recommendation below).

## Before you run this: a recommendation, not a requirement

Use a **disposable test Google account**, not your primary one, even though `drive.file`
scope means JARVIS can only ever see files it creates itself (never your existing Drive
content). This is the same precedent this project's own prior live test used
(`docs/jarvis-google-drive-design.md` §16, Phase 24E) and costs nothing extra — a free Google
account works fine for this. If you choose to use your real account instead, that is your
call to make, not something this procedure assumes or defaults to.

## Setup: two isolated profiles, one real account

```powershell
# Device A
$env:JARVIS_USERDATA_A = "$env:TEMP\jarvis-sync-device-a"
Remove-Item -Recurse -Force $env:JARVIS_USERDATA_A -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $env:JARVIS_USERDATA_A | Out-Null

# Device B (a second, independent profile - simulating a second machine)
$env:JARVIS_USERDATA_B = "$env:TEMP\jarvis-sync-device-b"
Remove-Item -Recurse -Force $env:JARVIS_USERDATA_B -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $env:JARVIS_USERDATA_B | Out-Null
```

Launch two separate instances, each in its own PowerShell window so each keeps its own
`JARVIS_USERDATA`/`$env:JARVIS_USERDATA_A` or `_B` set:

```powershell
# Window 1
$env:JARVIS_USERDATA = $env:JARVIS_USERDATA_A
& "C:\Users\User\Downloads\JARVIS_App\dist-rc-phase6\win-unpacked\JARVIS.exe"

# Window 2
$env:JARVIS_USERDATA = $env:JARVIS_USERDATA_B
& "C:\Users\User\Downloads\JARVIS_App\dist-rc-phase6\win-unpacked\JARVIS.exe"
```

Both instances must connect to the **same** Google account (the disposable test one) via
either BYO-client (paste the same test Client ID + your own OAuth consent on each) or, if
you've completed Phase 6 Task 3's Testing-mode setup, the app-owned path with
`JARVIS_GOOGLE_CLIENT_ID` set to your test Client ID on both.

## Verification steps

### 1. Initial sync
**Do:** On Device A, create a note "Sync Test 1" with some body text. Press Sync Now (or wait
for the debounce).
**Expect:** Status line shows "Syncing…" then "Synced [time]." No errors.

### 2. Remote note discovery
**Do:** On Device B (which has never seen this note), open Notes, or press Sync Now.
**Expect:** "Sync Test 1" appears on B within one sync pass, with identical content.

### 3. Simultaneous edits
**Do:** Disconnect Device A's network (airplane mode, or disable the network adapter). Edit
"Sync Test 1" differently on both A (offline) and B (online), each to distinctly different
text. Reconnect A's network, then trigger sync on both (A first, then B).
**Expect:** **Neither edit is silently lost.** Whichever device syncs second reports a
conflict in its status line, naming "Sync Test 1" by title. Open Version History on that
note on the device that shows the conflict — confirm the OTHER device's edit is present and
fully readable as a recoverable version, and that device's own edit is untouched in the live
note.

### 4. Offline queue recovery
**Do:** Disconnect Device A's network. Create 3 more notes and edit 2 existing ones, all while
offline. Confirm the status line shows "Offline." Reconnect.
**Expect:** All 5 changes sync automatically within a few sync passes (no manual re-entry
needed), with no duplicates and no lost edits, verified by comparing A and B's note lists.

### 5. Deletion and Trash propagation
**Do:** On A, delete (trash) "Sync Test 1." Sync both devices.
**Expect:** B's copy moves to its own Trash too (not still live, not just vanished). Restore
it on B, sync both again — confirm A sees it live again too.

### 6. Conflict resolution
**Do:** Repeat step 3's conflict scenario, then on the device showing the conflict, explicitly
restore the other device's preserved version via Version History's own Restore button.
**Expect:** After the next sync pass, both devices converge on the restored content, with no
further conflict reported for that note.

### 7. Restart recovery
**Do:** While Device A has an offline/pending sync queued (per step 4), fully quit JARVIS
(tray → Quit) and relaunch with the same profile.
**Expect:** The pending sync resumes automatically once reconnected — no manual "retry" action
needed, no re-entry of anything, no duplicate uploads of work already synced before the
restart.

### 8. Backup/Restore independence
**Do:** On either device, press "Back Up Now" (manual backup), then make a few more edits and
sync normally. Open Backup History and Preview the backup taken earlier.
**Expect:** The earlier backup's preview reflects exactly what existed at backup time, not
affected by anything Sync has done since — confirming Backup remains fully independent of
Sync, per Phase 3's own architectural guarantee.

## Recording results

For each step, record: date run, both devices' JARVIS version/build, pass/fail, and (for any
failure) the exact status line text and any error shown. Do not mark a step "passed" unless
it was actually executed against the real account — per the brief's own instruction, this
document will not claim completion on your behalf, and neither should the record of running
it.

## Cleanup

When finished, disconnect both profiles from the test Google account (Settings → Drive →
Disconnect on each, or revoke access directly at myaccount.google.com/permissions for the
test account), and delete both temp profile directories. Nothing about this procedure leaves
anything connected or running afterward.
