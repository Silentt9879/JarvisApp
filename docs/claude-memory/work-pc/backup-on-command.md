---
name: backup-on-command
description: When the user says "do backup", replace the single .jarvis-backup snapshot (new first, then delete old)
metadata:
  type: feedback
---

When the boss says "do backup" (or similar), refresh the session safety net in
`BantuApps/.jarvis-backup/`. Keep exactly ONE snapshot, always the newest.

Procedure (order matters):
1. Create `.jarvis-backup/<YYYYMMDD-HHMMSS>/` and copy into it:
   - `transcripts/` = ALL `.jsonl` files from the Claude projects folder for
     this workspace (copy them all, not just the newest; ~160MB total)
   - `memory/` (that project's whole memory folder)
   - `JARVIS_HANDOFF.md` from the workspace root
2. Verify the copy (files present, sizes non-zero).
3. THEN delete the older timestamped folder(s). Never delete first.
4. Keep `.jarvis-backup/RECOVERY.md` at the folder root, outside the snapshots.
5. ALSO regenerate `.jarvis-backup/tasks/TASKS.md` - overwrite it fresh every time,
   same replace-the-old-one rule as the snapshot. It is a plain-language report of
   what the boss still has to do himself: Mac/Xcode/Apple-portal steps, pending
   deploys, app rebuilds + what to test on device, uncommitted work, DB checks, and
   a "known and deliberately not fixed" section so nothing surprises him later.
   Layman's terms with checkboxes, not engineer shorthand. It sits at the folder
   root next to RECOVERY.md, NOT inside the timestamped snapshot.

**Why:** he lost a session's context once and does not want to depend on the
Claude session list surviving. One rolling snapshot keeps disk usage flat while
guaranteeing a recoverable transcript. Deleting before copying would leave a
window with zero backups.

**How to apply:** run it on command, not on a schedule, unless he asks for one.
The folder is gitignored and holds credentials from the transcript: never commit
it, never send it anywhere. See [[deploy-reality]] and [[communication-style]].
