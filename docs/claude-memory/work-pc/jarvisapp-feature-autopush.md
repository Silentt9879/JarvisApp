---
name: jarvisapp-feature-autopush
description: "For JARVIS app features: I add the feature in the JarvisApp source only, the user updates the installed app, and I auto-push to GitHub AND publish a GitHub release with the installer .exe attached, every time"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 4b9b381e-20b4-495d-98c9-1a45ee9f102b
  modified: 2026-10-08T06:31:10.958Z
---

Every time a new JARVIS app feature is requested, I implement it in the source at `C:\Users\bantu\Downloads\JarvisApp`
and stop there. The user updates the installed JARVIS app themselves. Then I push to GitHub without being asked again.
User, 2026-10-07: "Every time there is a new feature that is added to the JARVIS app that i need u to add, add it then
i will update jarvis app, and u will auto push it to github as well."

**Why:** the user wants to control when the installed app changes. They do the update, and GitHub stays in sync
with the source.

**How to apply:**
- Edit the source only. Do not reinstall, overwrite, or swap the installed copy at `AppData\Local\Programs\JARVIS`,
  and do not run `swap-update.ps1` for feature work. This overrides [[jarvisapp-auto-swap]] for feature changes.
- After the feature is in the source, push to GitHub by the routine in [[jarvisapp-git-workflow]]: commit to `main`,
  fold and delete other branches, update the README release notes, bump the version.
- Also publish a release so Settings > Updates offers it in-app: `npm test`, `npm run dist`, tag `vX.Y.Z`, then a
  GitHub release on JarvisApp with `dist-installer\JARVIS-Setup-X.Y.Z.exe` attached. Steps are in
  `docs/claude-memory/jarvis-release-pushes.md`. Without this the Update button shows "newest version" (the user saw
  this on 2026-10-07 with 1.7.3 while 1.7.4 was pushed but unreleased).
- Set up the release every time, so the user can update from Settings in the app.
- **The GitHub release with the downloadable .exe is part of every feature update, not an optional extra.** User,
  2026-10-08: "Everytime got new feature, also release a new update to be downloadable as exe at the github."
  Pushing the commit and tag, and running `npm run deliver` (which only reaches this PC), do not satisfy it: the
  release page on github.com/Silentt9879/JarvisApp must exist for the tag, with `JARVIS-Setup-X.Y.Z.exe` attached.
  From v1.10.0 to v2.1.1 I skipped this because auto mode's permission check refused the step and I reported it
  instead of doing it; the user has now asked for it in their own words, so do it, and if the check still refuses,
  say so plainly in the same reply - never leave it as a quiet footnote.
- **How to publish it:** `node scripts/publish-release.mjs` in JarvisApp (added 2026-10-08, first used for v2.1.1).
  It creates the release for the current version's tag, uploads the installer, and reads the result back. The
  order for every feature update is: bump version, README notes -> `npm test` -> `npm run dist` -> commit, tag,
  push `main` and the tag -> `node scripts/publish-release.mjs` -> `npm run deliver` LAST. The tag must be on
  GitHub before the script runs. Only the newest version needs a release; do not backfill old ones.
- Scan the diff for secrets before pushing.
- Tell the user what changed in the source so they know what to update.
- The push is pre-authorized for JarvisApp feature work only. The BantuApps repos keep their own rules (no commit or
  push unless asked).

Related: [[jarvisapp-git-workflow]], [[jarvisapp-auto-swap]].
