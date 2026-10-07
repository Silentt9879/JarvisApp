<div align="center">

<img src="build/icon.png" width="110" alt="JARVIS">

# JARVIS

**Claude Code on your desktop, and in your pocket.**

A Windows app for the Bantu Apps workspace that you can also drive from your phone over Telegram.

![Windows](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D6?logo=windows&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-app-47848F?logo=electron&logoColor=white)
![Claude](https://img.shields.io/badge/Claude-Agent%20SDK-D97757)
![Telegram](https://img.shields.io/badge/Telegram-remote-26A5E4?logo=telegram&logoColor=white)

</div>

---

## 🆕 What's new in v1.8.0

**Simplified**

- 🧑‍🏭 **Three new specialists.** Josh (ARCHIVIST) looks after git and GitHub Desktop, Tony (TASKMASTER) looks after ClickUp, and Eric (SCRIBE) looks after your Notes. They sit on the Agent floor like the others, each wearing the icon of the page it works on, in a new "Git, tasks & notes" group.
- 📝 **JARVIS can use your notes.** Ask in chat to "note this down" or "what did I note about the wheel?" and SCRIBE reads or writes the same notes the Notes page shows.

**Technical**

- `renderer/crew.js`: `MINION_NAMES` gains `archivist: 'Josh'`, `taskmaster: 'Tony'` and `scribe: 'Eric'`. `renderer/dashboard.js`: `AGENT_ICON` maps them to `github`, `clickup` and `edit`, the icons of the GitHub Desktop, Clickup and Notes pages.
- `renderer/pages.js`: a `ROSTER` group can hold several icons (space-separated). The new group "Git, tasks & notes" sits before Support crew.
- The agents themselves are workspace files, not app code: `.claude/agents/github-desktop.md`, `clickup.md` and `notes.md`. ARCHIVIST has no Edit or Write tool and never reaches a remote. TASKMASTER writes to ClickUp only when the user asked. SCRIBE writes `notes.json` only through the workspace tool `.claude/tools/notes.py`, which keeps `NoteStore`'s shape and limits, writes through a temp file and a rename, and refuses to write when the file cannot be parsed.
- `npm test` passes in full. Capture runs (`JARVIS_CAPTURE`, `JARVIS_VIEW=agents`) confirmed the three cards, the group, the bench and three working desks. `NoteStore` read back a file the tool wrote, and the tool read back one `NoteStore` wrote.

<details>
<summary><b>Earlier: v1.7.4</b></summary>

**Simplified**

- 🔗 **Clickup.** The Tasks page in the More group is now called Clickup and shows the ClickUp logo in place of the checklist icon.

**Technical**

- `renderer/index.html`: the `navTasks` button is labelled "Clickup" with icon key `clickup`. `renderer/core.js`: new `ICONS.clickup` (the simple-icons ClickUp mark, CC0), drawn solid in `currentColor` like the GitHub mark.

</details>

<details>
<summary><b>Earlier: v1.7.3</b></summary>

**Simplified**

- 🧭 **A tidier sidebar.** Automations, Memory, Activity, Workspace and Knowledge Base are off the sidebar. GitHub Desktop, Devices and AI Core now sit right under Overview. Memory, Workspace and Knowledge Base still open from search (Ctrl+K).

**Technical**

- `renderer/index.html`: `navAutomations`, `navMemory`, `navActivity`, `navWorkspace` and `navKnowledge` are removed from `#navList`. `navSource`, `navDevices` and `navCore` move up to follow `navCommand`. Tasks, Agents and Tools & Skills stay in the More group.
- `renderer/app.js`: `PRIMARY` (Ctrl+1 to Ctrl+5) has `source` in place of `automations`. `renderNavBadges` no longer writes the Workspace, Knowledge or Memory badges, which are gone (writing to them would throw), and the `memory` listener that drove only those is removed.
- The views and their modules are unchanged. Automations and Activity can no longer be opened from the sidebar or search.
- `npm test` passes in full. A capture run (`JARVIS_CAPTURE`) confirmed the new sidebar order.

</details>

<details>
<summary><b>Earlier: v1.7.2</b></summary>

**Simplified**

- 🔁 **Update brings JARVIS back in front.** After an update, JARVIS opens its window on top, instead of only in the tray.

**Technical**

- `main.mjs` `createWindow`: when started with `--updated`, the window is shown, focused and brought forward with `app.focus({ steal: true })`. Windows can leave a window started by a background process behind other apps.
- The updater's final window check wrote nothing to `jarvis.log` after the 1.7.1 update. This fix does not depend on it; the cause of that gap is still open.
- `scripts/updates-test.mjs`: 54 checks.

</details>

<details>
<summary><b>Earlier: v1.7.0</b></summary>

**Simplified**

- 🩺 **Health.** One place that says what is in order and what needs setting up, with a button for each fix. Click the status pill at the top.
- 👋 **A walk-through for new installs.** Sign in, pick a folder and set up the phone, in plain steps. Every step can be skipped.
- 🆕 **What's new.** After an update, JARVIS shows what changed.
- 🗂️ **Settings in tabs, with search.**
- 🔊 **Replies read aloud, and "JARVIS" to start.** Hands-free, listening on this PC only, and only while you have it on.
- ⏰ **Routines.** Have JARVIS do something on its own at a set time, read-only by default, and get the result on your phone or as a notification.
- 🪟 **Two chats side by side.** Open a chat in a new window and put it beside this one.
- ✅ **Allow or deny from the notification.** No need to open JARVIS for an approval.
- 📱 **A phone web app.** Read the chat and answer approvals from your phone's browser on your Wi-Fi. Off until you turn it on, and protected by an access code.
- 💸 **Usage and budget.** The estimated cost today and this week, and an optional daily limit that tells you once when it is passed.
- 📜 **Activity log.** Everything JARVIS did, searchable and exportable, with passwords and tokens hidden.
- 💬 **Saved prompts.** Reuse the prompts you ask often from the chat. Blanks such as `{file}` are filled in each time.
- 🔤 **Text size and high contrast** in Settings.
- 📁 **New project.** Starters for Node, Python, Flutter and .NET, each with a CLAUDE.md and a git repository.
- 📦 **A smaller installer.** The GPU runtime the speech model does not use is no longer packed (about 37 MB).

**Technical**

- New modules: `src/features.mjs` (the wiring), `activity.mjs`, `usage.mjs`, `prompts.mjs`, `routines.mjs` (runs through the agent SDK in plan mode unless allowed to edit), `health.mjs`, `companion.mjs` (token-protected, rate-limited, constant-time code check; only the page shell is served without the code), `projects.mjs`, `store.mjs`, and `src/companion/index.html` for the phone.
- Renderer: `dialogs.js`, `welcome.js`, `health.js`, `activity.js`, `automations.js`, `voice.js` with `wakeword-core.js` (energy segmenter and whole-word wake word), `settings-extra.js`, `projects.js`.
- `main.mjs`: `sessionFor(e)` gives each window its own session; `window:newChat` opens a second window; `submitMessage` is shared by the window, Telegram and the phone app; `loadConfig` returns the whole config (it had been dropping every key but two); `JARVIS_USERDATA` and `JARVIS_CAPTURE_SCRIPT` help test runs.
- Tests: `scripts/features-test.mjs` (42 checks), `scripts/features-wiring-test.mjs` (11 checks, a real config file and the phone app over HTTP), `updates-test` (54). `npm test` runs them all except the undo test, which is skipped until the workspace policy file is back.

</details>

<details>
<summary><b>Earlier: v1.6.2</b></summary>


**Simplified**

- 🔁 **Update really brings JARVIS back.** Pressing Update now starts the new version and opens it again by itself. Before, the updater could be stopped the moment JARVIS closed, so nothing was installed and JARVIS did not come back.
- 🛟 **Safer failures.** If the update cannot be started, JARVIS stays open and tells you, instead of closing with nothing happening.

**Technical**

- `updates.mjs` `launchUpdater`: a process started from JARVIS dies when JARVIS quits (reproduced on this PC; a `detached` PowerShell never ran at all). The updater is now started through WMI (`Win32_Process.Create`) by a short launcher, and JARVIS quits only after Windows confirms the start. `jarvisUpdate` returns an error, and the window stays open, if the start is refused.
- `scripts/updates-test.mjs`: 54 checks, including the WMI start and the refused-start path.
- Reproduction: a hidden PowerShell launched from Node was gone within seconds of Node exiting; the WMI-started one ran to completion.

</details>

<details>
<summary><b>Earlier: v1.6.1</b></summary>

**Simplified**

- 🔐 **Signing out no longer breaks the chat.** After you sign out, JARVIS says "You're signed out. Sign in from Settings to carry on", on the PC and on Telegram, instead of "the session is not running".
- 🧭 **Buttons don't get stuck.** Sign out, Restart in this folder and their error messages come back properly.
- 🔑 **Friendlier GitHub sign-in.** When JARVIS needs to sign in, Settings walks you through three steps. It never pops up Git's own sign-in window.
- 👋 **No repeat greeting.** The phone is greeted when JARVIS starts, not every time it restarts or updates.
- 🧪 **`npm test` finishes.** The source-control undo test is skipped, with a message, until the workspace's git risk policy file is back.

**Technical**

- `main.mjs`: a `signedOut` flag, set by a readable "not signed in" answer (`noteAccount`) and by sign-out. `jarvis:send` and `jarvis:start` refuse with `SIGNED_OUT`. Sign-out sends the window status `closed` (not `ready`). Restarts relaunch with `--restarted`, which skips the greeting.
- `renderer/app.js`: the sign-out, restart and workspace buttons read `e.currentTarget` before their `await` (it is null after one), and always restore the button and show errors.
- `updates.mjs`: the Git credential helper runs with `GCM_INTERACTIVE=never`. The updater stops anything still running from the install folder before the silent install.
- Tests: `notes-test` and `auth-test` find the app from their own folder. `sc-undo-discard-test` runs only when `JARVIS_POLICY_FILE` points at the workspace policy.

</details>

<details>
<summary><b>Earlier: v1.6.0</b></summary>

**Simplified**

- 📦 **A proper installer.** Download `JARVIS-Setup-1.6.0.exe` from the Releases page and double-click it. Click Next a few times and JARVIS is installed, with a desktop icon and a Start menu entry. No administrator rights needed.
- ⬆️ **Update from Settings.** Open **Settings → Updates** and press **Check**. If a newer JARVIS is out, press **Update**: JARVIS asks once, closes for about a minute, installs the new version and opens again by itself.
- 🆚 **VS Code and Claude Code too.** The same Updates section checks both, and one press updates each.

**Technical**

- New `src/updates.mjs`: `jarvisStatus` / `jarvisUpdate` (GitHub `releases/latest`, the `JARVIS-Setup-x.y.z.exe` asset, SHA-256 checked against the release digest, a mismatched download is deleted and never run); `vscodeStatus` / `vscodeUpdate` (winget `show` / `upgrade`); `claudeStatus` / `claudeUpdate` (`claude update` when the command exists, otherwise `npm i -g @anthropic-ai/claude-code@latest`). The updater is a detached PowerShell that waits for JARVIS to exit, runs the installer with `/S`, then reopens JARVIS with `--updated` so it announces the update.
- NSIS target in `package.json` (`npm run dist` writes `dist-installer/`, per-user, no directory page), `build/installer.nsh` for the setup wording, `src/renderer/updates.js` and an Updates section in Settings, 3 IPC handlers in `main.mjs`, `scripts/updates-test.mjs` (35 checks, commands and GitHub stubbed).

</details>

<details>
<summary><b>Earlier: v1.5.0</b></summary>

**Simplified**

- 📝 **Notes.** A new sidebar page for jotting something down: write it, hit Save, and it's kept. Tick **Send to Telegram** and it also goes to the same chat your phone alerts use - the note is saved either way, even if Telegram is down. Switching notes never loses an unfinished edit (parked as a draft, marked "unsaved"), and Delete asks once in the button itself before it removes anything.
- 👤 **Sign in / sign out, from Settings.** A new **Account** section shows who JARVIS is signed in as. **Sign out** asks first, then stops the session cleanly. **Sign in** opens a window for the browser-based flow and watches for you to finish, then offers to restart JARVIS so every part picks up the new account. Nothing you sign in with is ever stored by JARVIS or shown in a log.
- 🎛️ **Chats open in the mode you set.** If your own Claude Code settings say `"defaultMode": "auto"` (or `acceptEdits`, or `plan`), a new or resumed chat now starts there instead of always asking first - the same settings files, read in the same order, as the terminal uses.

**Technical**

- New `src/notes.mjs` (`NoteStore` on `notes.json` in the user data folder; `sendNote` through the existing `telegram.mjs`), `src/renderer/notes.js`, 3 IPC handlers in `main.mjs`, `scripts/notes-test.mjs` (38 checks: store, Telegram send with the transport stubbed, and the real renderer driven through save / send / failure / drafts / delete).
- New `src/auth.mjs` wrapping `claude auth status --json` / `logout` / `login` (the last opens its own console window via `cmd start`, since the CLI drives a browser); errors are scrubbed of key-shaped strings before they reach the window or the log. 4 IPC handlers, `scripts/auth-test.mjs` (22 checks), verified against a packaged build.
- New `src/permission-mode.mjs`: `startingMode(cwd)` reads `permissions.defaultMode` from local → project → user settings, the same precedence Claude Code itself uses; `session.mjs` passes the result as `permissionMode` instead of a hard-coded `'default'`. Still never `bypassPermissions`. `scripts/permission-mode-test.mjs`.

</details>

<details>
<summary><b>Earlier: v1.4.0</b></summary>

**Simplified**

- 🧑‍🏭 **Watch your agents work.** The Agents page has an **Agent floor**: every specialist JARVIS sends out sits at a desk as a little minion with its own name (Kevin, Otto, Bob…). A speech bubble says what it is doing right now ("Reading HttpService.dart", "Running dotnet build"), with a timer and its last few steps. Idle ones nap on the bench.
- 🟢 **"N agents" in the chat box.** See who is working without leaving the chat. Click it to watch, and click a name to jump to its desk.
- 🗂️ **A tidier Agents page.** Specialists are grouped (Mobile apps, Web apps, APIs, Support crew) as small cards; the full brief is one click away.
- 🐙 **GitHub Desktop** (was Source Control): **Undo** the last commit, right-click for **Discard all** / **Stash all**, **Pull origin** beside the branch, and history times you can read ("Yesterday 6:07 PM").
- 📱 **A phone in its own window**, and drag it onto JARVIS's left edge to snap the two side by side.
- ▶️ **Web apps:** Run starts `dotnet watch`, and a busy port or a failed start is explained in plain words.
- 🔄 Reload buttons spin while they reload, right-click Cut / Copy / Paste works everywhere, and the big clock is back.

**Technical**

- `src/session.mjs` forwards the SDK's `task_started` / `task_progress` / `task_notification` / `task_updated` system messages as `agent_task` events (ambient and `skip_transcript` tasks dropped).
- New `src/renderer/crew-model.js` (no DOM): a run is keyed by its Agent `tool_use` id, and its steps are the tool calls whose `parent` is that id. A background run (`is_backgrounded`, or a "launched" result) ends only on its task notification; going idle closes a foreground run that missed its result; a closed session stops them all. `scripts/crew-test.mjs`, 27 checks.
- New `src/renderer/crew.js` draws the floor (desks updated in place, not redrawn), the bench and the chat-bar pill and panel. It owns `state.agentActive`, so the cards, the nav badge and the Overview count a background agent until it really ends. `JV.minionName(agent)` gives fixed names, with a pool for new agents.
- GitHub Desktop: `undoLastCommit()` is `git reset --soft HEAD~1`, offered only for an unpushed commit. `discardAll()` copies the changes to the Recycle Bin first, then restores tracked files (`git restore --source=HEAD --staged --worktree -- .`) and removes new ones (`git clean -f`). Both go through `git-risk-policy.json`. Tests: `scripts/sc-undo-discard-test.mjs`.
- Devices: `phone.html` / `phone.js` share the decoder in `phone-screen.js`; snap-docking geometry is in `src/dock.mjs` (`scripts/dock-test.mjs`). Web apps: `src/webapps.mjs` checks the port first and names its owner (`scripts/webapps-test.mjs`).
- `JV.spinWhile(btn, work)` spins a reload icon for the whole reload and at least one full turn. Capture aid `JARVIS_DEMO=crew` plays a scripted floor for screenshots.

<details>
<summary><b>Earlier: v1.3.0</b></summary>

**Simplified**

- 💤 Say **"Power down"** and JARVIS naps in the tray instead of closing. Say **"Wake up"** on Telegram, or click the tray icon, to bring it back.
- 🔌 Quitting from the tray still closes it fully, and your phone is told it's offline.
- 🖥️ Use JARVIS on **more than one PC**: each PC gets a name (Home-PC, Work-PC…), and one Telegram group controls them all. "Wake up Work-PC" picks one, or JARVIS asks which with a button.

**Technical**

- `controlWord()` in `src/remote.mjs` matches a message that is only "Power down" / "Wake up" (any case, optional "JARVIS, " and a PC name). It is caught before questions and approvals, and at the desk in `jarvis:send`. Late messages are still skipped.
- `powerDown()` destroys the window and stops the session, web apps and mirrors, but keeps the Telegram listener and keep-awake running. `wakeUp()` reopens the window with a fresh session and sends the greeting. If remote control is off, Power down quits.
- New `src/presence.mjs`: bots can't read each other's messages, so each PC writes a status line in the shared group's description (`🟢 Home-PC · awake · <time>`). It refreshes every 5 min, counts as stale after 12 min, and is read back and retried after each write. It also follows a supergroup migration.
- In the group (`onGroupText()`), only the owner's Wake up, Power down and /status are obeyed. An unnamed command goes to the only PC that can answer it. Otherwise each PC posts an inline button that only the owner can press and that expires after 2 min.
- Settings → Phone alerts adds **PC name**, **Find my group** and **Leave group**. Tests: `scripts/presence-test.mjs` (new) and `scripts/remote-test.mjs`.

</details>

</details>

---

## ✨ What it does

| | |
|---|---|
| 💬 **Chat** | Talk to JARVIS. Attach images and files, pick the model and effort level, and approve each action |
| 📱 **Telegram remote** | Send messages, photos, files and voice notes from your phone, and approve actions with one tap |
| 🧑‍🏭 **Agents** | Watch the specialists work as minions on the Agent floor, or from the "N agents" pill in the chat box |
| 🐙 **GitHub Desktop** | Changes, commits, Undo, stashes, branches, push and pull, plus pull requests and checks from GitHub |
| ✅ **Clickup** | Your ClickUp board, synced and grouped by sprint |
| 📂 **Files** | Read any workspace file, and double-click to open it in VS Code |
| 📝 **Notes** | Write something down, save it, and send it to your Telegram |
| 📲 **Devices** | Live phone screens with `flutter run` (also in their own window), and web apps with `dotnet watch` |
| ↩️ **Undo** | Undo every file change made since any message, in one click |

---

## 📱 From your phone

> Set up once in **Settings → Phone alerts**: create a bot with @BotFather, press **Check token**, then press **Find my chat**.

| Send | You get |
|---|---|
| A message | It runs on the PC, just as if you typed it there |
| 📷 A photo or 📎 a file | It's saved in `Downloads\JARVIS from phone` and shown in the PC chat |
| 🎙 A voice note | It's transcribed on the PC (nothing goes to the cloud), then run |
| `/status` `/stop` `/new` | What JARVIS is doing, stop the current turn, start fresh |
| `/sessions` `/switch` | Pick up an earlier conversation |
| `/screen` | A screenshot of the PC |
| `/diff` | What has changed in each repo |
| `/brief` | The morning brief (sent automatically on weekdays at 08:00) |

**PC → phone:** with mirroring on, what you type and attach on the PC shows up in Telegram too.

👋 **Hello on startup:** when JARVIS opens on the PC, your phone gets a "Good morning / afternoon / evening" message, so you know it's online.

💤 **Power down / Wake up:** say "Power down" (phone or PC) and JARVIS goes to sleep in the tray. Say "Wake up" in Telegram, or click the tray icon, to bring it back. Quitting from the tray shuts it down fully, and Telegram tells you it's offline.

🖥️ **More than one PC:** give each PC its own bot and a name (Home-PC, Work-PC…), then put all the bots in one Telegram group with you. "Wake up" there wakes the only PC that's asleep, or asks which one with a button per PC. Add a name to pick one directly: "Wake up Work-PC".

🔒 Only *your* Telegram account is obeyed. Messages sent while JARVIS was off never run later, and every approval still needs your tap.

---

## ⌨️ Shortcuts

| Keys | Action |
|---|---|
| `Ctrl` + `1`…`6` | Switch view |
| `Ctrl` + `N` | New session |
| `Ctrl` + `K` | Search everything |
| `Ctrl` + `,` | Settings |
| `Esc` | Stop JARVIS |

---

## 🚀 Run it

```powershell
npm install        # first time
npm start          # run from source
npm test           # tests (no network needed)
npm run pack       # build -> dist\win-unpacked\JARVIS.exe
```

> 💡 From a VS Code terminal, first run `Remove-Item Env:ELECTRON_RUN_AS_NODE`.

---

<div align="center">

📖 **[Full technical details →](docs/DETAILS.md)**

<sub>Built on the Claude Agent SDK · Electron · Telegram Bot API</sub>

</div>
