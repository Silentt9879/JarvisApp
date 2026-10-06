---
name: jarvis-update-announcements
description: "How to tell the user to close/restart JARVIS after changing it - frame it as a \"system update\" and say which side (PC app or Telegram)"
metadata:
  node_type: memory
  type: feedback
  originSessionId: c6049c46-bad0-4b7e-8f5c-e98fa7674a85
  modified: 2026-10-02T15:11:35.638Z
---

Whenever I change the JARVIS app (C:\Users\User\Downloads\JARVIS_App) and the user needs to close or restart something, announce it like a system update (e.g. "⚙️ System update ready - JARVIS (PC)" / "JARVIS (Telegram)"), and always say which side has to be closed: the PC desktop app, or the Telegram side. Use the update framing for every new JARVIS feature, whether it affects the PC side, Telegram, or both.

**Why:** The user runs JARVIS both at the desk and remotely through the Telegram bot, so "close JARVIS" is ambiguous. They want updates to feel like a product's system updates.

**How to apply:** At the end of any JARVIS change, add a short "System update" block: what's new, which side to close (PC / Telegram / both), and the exact steps. See [[jarvis-app]].
