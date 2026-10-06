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

## 🆕 What's new in v1.5.0

**Simplified**

- 📝 **Notes.** A new sidebar page for jotting something down: write it, hit Save, and it's kept. Tick **Send to Telegram** and it also goes to the same chat your phone alerts use - the note is saved either way, even if Telegram is down. Switching notes never loses an unfinished edit (parked as a draft, marked "unsaved"), and Delete asks once in the button itself before it removes anything.
- 👤 **Sign in / sign out, from Settings.** A new **Account** section shows who JARVIS is signed in as. **Sign out** asks first, then stops the session cleanly. **Sign in** opens a window for the browser-based flow and watches for you to finish, then offers to restart JARVIS so every part picks up the new account. Nothing you sign in with is ever stored by JARVIS or shown in a log.
- 🎛️ **Chats open in the mode you set.** If your own Claude Code settings say `"defaultMode": "auto"` (or `acceptEdits`, or `plan`), a new or resumed chat now starts there instead of always asking first - the same settings files, read in the same order, as the terminal uses.

**Technical**

- New `src/notes.mjs` (`NoteStore` on `notes.json` in the user data folder; `sendNote` through the existing `telegram.mjs`), `src/renderer/notes.js`, 3 IPC handlers in `main.mjs`, `scripts/notes-test.mjs` (38 checks: store, Telegram send with the transport stubbed, and the real renderer driven through save / send / failure / drafts / delete).
- New `src/auth.mjs` wrapping `claude auth status --json` / `logout` / `login` (the last opens its own console window via `cmd start`, since the CLI drives a browser); errors are scrubbed of key-shaped strings before they reach the window or the log. 4 IPC handlers, `scripts/auth-test.mjs` (22 checks), verified against a packaged build.
- New `src/permission-mode.mjs`: `startingMode(cwd)` reads `permissions.defaultMode` from local → project → user settings, the same precedence Claude Code itself uses; `session.mjs` passes the result as `permissionMode` instead of a hard-coded `'default'`. Still never `bypassPermissions`. `scripts/permission-mode-test.mjs`.

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
| ✅ **Tasks** | Your ClickUp board, synced and grouped by sprint |
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
