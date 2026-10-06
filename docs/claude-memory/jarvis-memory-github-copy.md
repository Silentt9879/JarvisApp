---
name: jarvis-memory-github-copy
description: "The Claude memory notes are also copied to the private JarvisApp repo on GitHub at docs/claude-memory, as a snapshot; the memory folder on this PC is the source of truth"
metadata:
  node_type: memory
  type: reference
  modified: 2026-10-06T17:48:44.968Z
  originSessionId: 48de7c39-b56e-44aa-8406-8e30f378b321
---

On 2026-10-07 the user asked for the memory notes to be pushed to GitHub. They are copied to the private repo Silentt9879/JarvisApp under `docs/claude-memory/` (same file names, MEMORY.md included), in their own commit "Add Claude memory notes", separate from release commits.

**Why:** the user wants the notes backed up on GitHub. JarvisApp is the only GitHub repo they use, and they do not want a second repo.
**How to apply:** the folder on this PC, C:\Users\User\.claude\projects\C--Users-User-Downloads-Bantu-Apps\memory\, is the source of truth. When the user asks to push memory again, copy the folder over, commit and push. The copy is a snapshot, so it goes stale until the next push. The memory folder is not packed into the app, because package.json `build.files` only includes src, the build icons, package.json and vendor. See [[jarvis-app]] and [[jarvis-release-pushes]].
