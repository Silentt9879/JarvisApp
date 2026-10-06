---
name: jarvis-release-pushes
description: "When pushing new JARVIS features to GitHub, release them as \"Update vX.Y.Z\" with a version bump, tag, and a simplified + technical \"What's new\" README section"
metadata:
  node_type: memory
  type: feedback
  originSessionId: a1943e0b-d7ce-414d-bb34-f0703102d3e8
  modified: 2026-10-06T17:48:36.998Z
---

When pushing new JARVIS app features to GitHub (Silentt9879/JarvisApp, main):
1. Bump `version` in package.json (minor for new features, patch for fixes).
2. Put a "## 🆕 What's new in vX.Y.Z" section near the top of README.md (after the header, before "What it does") with two parts: **Simplified** (plain-language bullets with emoji) and **Technical** (modules, functions, tests). Fold the previous release into a collapsed `<details>` block titled "Earlier: vX.Y.Z" (the older ones are already folded there), so the README stays short.
3. Commit with the subject "Update vX.Y.Z", tag `vX.Y.Z`, then push main and the tag.
4. `npm test` (all suites), `npm run dist`, then create the GitHub release for the tag with the README section as its body, and upload `dist-installer\JARVIS-Setup-X.Y.Z.exe` as the asset. Use Node's fetch with the token from `git credential fill` (never print it); python and gh are not installed.

v1.3.0 was released on 2026-10-03 (Power down/Wake up, multi-PC). v1.7.2 (window comes back after an update) and v1.7.3 (tidier sidebar) were released on 2026-10-07.

**Why:** the user asked for this from now on: version-numbered updates and a README that both a layperson and a developer can read.
**How to apply:** on any "push to GitHub" for JARVIS. In PowerShell, write the commit message to a file and use `git commit -F`, because an apostrophe in a here-string message broke the commit once. See [[jarvis-app]].
