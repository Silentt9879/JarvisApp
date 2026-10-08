---
name: jarvisapp-git-workflow
description: "JarvisApp GitHub routine - push straight to main, fold every other branch into main and delete it, and refresh the README's Simplified + Technical release notes"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 50f13dcf-797c-400a-a6d1-f307fa362435
  modified: 2026-10-06T03:58:46.051Z
---

For the JarvisApp repo (github.com/Silentt9879/JarvisApp, `C:\Users\bantu\Downloads\JarvisApp`), when the user
asks to push / update GitHub (user, 2026-10-06: "every branch except main push it to main, then delete the other
branches except for main, then update readme file for simplified and technical version, keep this in ur memory"):

1. Commit and push straight to `main` - no feature branch. (Overrides the general "branch first on the default
   branch" rule, for this repo only.)
2. Fold every other branch into `main`: `git fetch --prune`, then `git branch -a --no-merged main`; merge anything
   listed (fast-forward when possible), push `main`.
3. Delete every branch except `main`, locally (`git branch -d` - the safe form, refuses unmerged work) and on
   GitHub (`git push origin --delete ...`). Never `-D` without re-checking it is merged.
4. Update `README.md`: a new "What's new in vX.Y.Z" section with **Simplified** (plain words, emoji bullets) and
   **Technical** (files, functions, tests) halves; fold the previous release into a `<details>` "Earlier: vX" block;
   keep the feature table current; bump `package.json` "version" to match.

**Why:** the user wants one branch on GitHub and release notes that read for both a non-developer and a developer.

**How to apply:** do all four in one go whenever JarvisApp is pushed; scan the diff for secrets first; then rebuild
and swap per [[jarvisapp-auto-swap]] so the app's About shows the new version. Not for the BantuApps repos - their
git rules (no commit/push unless asked, branch first) are unchanged.
