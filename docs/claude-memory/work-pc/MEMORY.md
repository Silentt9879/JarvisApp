# Memory Index

- [App nicknames](app-nicknames.md) — user's nicknames for the 6 named Bantu Apps projects (Customer/Driver/Panel/Advisor App, Admin/Panel Web App)
- [Communication style](communication-style.md) — terse token-efficient reply rules the user wants followed
- [Deploy steps carry commit messages](deploy-commit-messages.md) — every deploy step names each repo (API = /Fire, Gateway = /SelamatFire) with a ready-to-paste commit message
- [Backup on command](backup-on-command.md) — "do backup" = single rolling .jarvis-backup snapshot, copy new before deleting old
- [Permission mode: auto](permission-mode-auto.md) — user wants every session in auto mode; the user applies the setting, Claude never changes it
- [JarvisApp auto-swap](jarvisapp-auto-swap.md) — after a verified JarvisApp build, swap in + restart without asking; swap last (it can end the session)
- [JarvisApp git workflow](jarvisapp-git-workflow.md) — on push: straight to main, fold + delete every other branch, README "What's new" Simplified + Technical, bump version
- [JARVIS feature auto-push](jarvisapp-feature-autopush.md) — JARVIS features: edit source only, user updates the app, I auto-push to GitHub and publish a GitHub release with the installer .exe, every time
