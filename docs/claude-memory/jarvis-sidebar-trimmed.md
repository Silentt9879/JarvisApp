---
name: jarvis-sidebar-trimmed
description: "The JARVIS sidebar was trimmed on 2026-10-07 (v1.7.3): Automations, Memory, Activity, Workspace and Knowledge Base are off it, and GitHub Desktop, Devices and AI Core sit under Overview"
metadata:
  node_type: memory
  type: project
  modified: 2026-10-06T17:48:43.016Z
  originSessionId: 48de7c39-b56e-44aa-8406-8e30f378b321
---

On 2026-10-07 the user asked to remove Automations, Memory, Activity, Workspace and Knowledge Base from the JARVIS sidebar ("not needed"), and to move GitHub Desktop, Devices and AI Core up under Overview. Shipped in v1.7.3.

Current order: Chat, Overview, GitHub Desktop, Devices, AI Core, Notes, Files, then the More group (Tasks, Agents, Tools & Skills).

**Why:** the user does not use those five views and wanted a shorter sidebar.
**How to apply:** do not put them back in the sidebar without asking. The views and their code are still there: Memory, Workspace and Knowledge Base still open from search (Ctrl+K). Automations and Activity can no longer be opened from the UI at all. Ctrl+3 now opens GitHub Desktop (`PRIMARY` in app.js). See [[jarvis-app]], [[jarvis-feature-lessons]] and [[jarvis-release-pushes]].
