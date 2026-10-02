# JARVIS - desktop app

A windowed front end for Claude Code in the BantuApps workspace. It is the same JARVIS
as the terminal and VS Code: it runs in `C:\Users\bantu\Downloads\BantuApps` with the
project `CLAUDE.md`, the 13 specialists in `.claude/agents`, skills, hooks and the MCP
servers, on the signed-in Claude account.

Desktop shortcut **JARVIS** -> `dist\win-unpacked\JARVIS.exe`.

## Views

Every panel shows real data. Nothing is invented; where there is no source (weather,
location, calendar) there is no panel.

| View | What it shows | Source |
|---|---|---|
| **Command Center** | The core orb, the live intelligence feed, active specialists, the mission timeline, CPU / RAM / disk, models and connected systems | session events, `os`, git, knowledge files |
| **AI Core** | Model, effort, thinking, mode, Claude Code version, account, the context window by category, memory files in context | `getContextUsage`, `initializationResult` |
| **Agents** | The specialists, lit while working; click for the brief, or hand one a task | `supportedAgents`, `.claude/agents/*.md` |
| **Tasks** | Your ClickUp board (every sprint, every status), the workspace draft of work not logged yet, this session's task list and turns, the handoff's CURRENT FOCUS | ClickUp MCP (cached), `clickup-task-draft.md`, TodoWrite / TaskCreate / TaskUpdate, `JARVIS_HANDOFF.md` |
| **Memory** | Memories as a star map (lines are `[[links]]`) and a reader | `~\.claude\projects\...\memory` |
| **Conversations** | The chat and recent sessions (terminal and VS Code sessions too); hover a session to rename or delete it, hover your message to undo its file changes | Claude Agent SDK |
| **Knowledge Base** | Knowledge, rules, agents, skills and commands; stale warning + `/relearn` | `.claude\*`, `scan-status.py --json` |
| **Tools & Skills** | Slash commands and skills, MCP servers with their tools, built-in tools | `supportedCommands`, `mcpServerStatus` |
| **Workspace** | The nine repos (branch, ahead/behind, modified/staged/untracked, last commit, open in VS Code), open issues, knowledge freshness | `git --no-optional-locks status`, `open-issues.md` |
| **Files** | Every text file in the workspace, read-only, with a preview and one click into VS Code | the workspace folder |

Header: system status (derived: session, MCP, knowledge, pending decisions - hover for
reasons), clock, search (Ctrl+K: views, sessions, agents, commands, repos, documents),
notifications, settings, the signed-in account. Bottom bar: network, session time, context
and Executive Briefing.

The chevron beside the JARVIS mark narrows the sidebar to a 66px icon rail - labels and the
Core Status panel go, badges shrink to corner pills, and every button keeps its name as a
tooltip. The chevron moves under the mark so it is still reachable, and the choice is
remembered in `localStorage` under `jarvis.navCollapsed`.

## The composer

`+` attach files or images (or paste / drag them in) · `/` commands and skills (or type `/`)
· context ring (click for AI Core) · session timer · thinking toggle · model and effort
(Low / Medium / High / Extra high / Max) · mode · send / stop.

- Images (PNG, JPEG, GIF, WebP, up to 3.75 MB) go to the model as images. Other files are
  named by path; JARVIS reads them with its own tools, under the usual permissions.
- Effort and thinking apply to this session only (nothing is written to settings). The
  effort shown by default is the one saved in your settings for the current model.
- Modes: **Ask** (default), **Accept edits**, **Plan**, **Auto** (a classifier approves
  routine actions and asks for risky ones). There is deliberately no "bypass permissions".
- Permission prompts: *Deny / Allow once / Allow for this session*. "For this session" is
  exactly that: Claude Code's suggested rules are forced to the `session` destination, so
  nothing lands in `.claude\settings.local.json` (it used to). A prompt never takes the
  keyboard focus onto an Allow button - only onto Deny, and only when you are not typing.
  Questions from JARVIS appear as buttons. **Esc** or **Stop** interrupts; typing while
  JARVIS works queues. A message that fails to send goes back into the composer.
- **Focus Mode** hides everything but the conversation. **Leave focus** sits at the top left
  while it is on, and Esc leaves it when JARVIS is idle.

## Undo file changes (rewind)

Hover one of your messages and click the undo arrow: every file JARVIS changed since that
message goes back to how it was. A preview card lists the files and line counts first; the
conversation itself is kept. It uses the SDK's file checkpoints (`enableFileCheckpointing`,
`rewindFiles`), keyed by the id the app gives each message - so it also works on messages
of a resumed session. Stop JARVIS before undoing. Later edits to those same files,
including your own, are undone too. Tested for real: an edit, a rewind, and a rewind after
closing and resuming the session.

## Renaming sessions

Hover a session and click the pencil; Enter saves, Esc cancels. The app's own live session is
renamed through Claude Code's `/rename` (it keeps the title in memory as well); any other
session through the SDK's `renameSession`. A session open in another window is refused -
rename it there. Typing `/rename <title>` in the composer works too.

## Files - reading the workspace, editing in VS Code

JARVIS is not an editor and should not become one: VS Code is one click away and better at
it in every respect. What this view adds is the short path - find the file, read it without
leaving the app, then open it where you will actually change it. Nothing here writes.

- A folder tree, the way the editor shows it: a folder per repo, closed until you open one,
  each with the number of files in it. The root's own `.sql` scripts sit under the folders.
  About 3,000 files - build output, `node_modules` and `.git` are skipped - indexed in about
  half a second, and only what is open gets built.
- A repo with uncommitted work is marked amber with a dot, from the same git read the
  Workspace page uses.
- Filter by kind - **SQL**, Notes, C#, Dart, Web, Config - or search by name or folder: the
  folders holding matches open themselves. Sort A-Z or by what changed most recently, and
  close everything again with one button.
- Click to read it here with line numbers; **double-click to open it straight in VS Code**.
- **Copy** takes the whole file (a .sql script goes straight into Workbench), **Copy path**
  takes the relative path, **Show in folder** opens Explorer.
- Elsewhere: each repo card on **Workspace** has a VS Code button, and the Knowledge Base
  reader opens the real file in VS Code rather than whatever Windows picks for `.md`.
- Only paths inside the workspace are ever read or opened - both are refused otherwise.
  VS Code is found from its usual install path; if it is missing, Windows' default opens.
  It is launched as `Code.exe <path>`, which hands the file to the window you already have
  open. The `code.cmd` wrapper is not used: cmd mangles the spaces in "Microsoft VS Code"
  and fails silently, and neither `-g` nor the bundled `cli.js` opened anything when
  measured against a running VS Code. There is no jump-to-line through this route.

## Tasks - the ClickUp board

- **Sync** reads every task assigned to **Jayvian** across every sprint and every status.
  There is no API key to set up: ClickUp is a remote OAuth MCP server, so the sync borrows
  the connection Claude Code already has. It runs ONE short Claude Code query of its own -
  outside your conversation, on Haiku, with only the read-only `clickup_get/search/filter/
  find/resolve/list` tools allowed - and asks for JSON. Nothing is ever written back.
- It takes a minute or two (248 tasks took about three), so the answer is cached in
  `%APPDATA%\JARVIS\clickup-tasks.json` and the page opens from the cache instantly. Sync
  again when you want a fresh copy.
- Sprints are collapsible groups, newest first; the current sprint and anything with open
  work starts expanded. Search by code or title, pick one sprint, or show only unfinished.
  The summary tiles are clickable filters, and the few unfinished tasks are listed in full
  at the top so they are never buried. Each row opens in ClickUp in your browser.
- **Not in ClickUp yet** reads `.claude/jarvis/clickup-task-draft.md` from the workspace and
  lists what is waiting to be logged, above what has already gone.
- The code is split out of the task name (`BE331 - Fix ...`) into its own chip, including the
  `QA-` variants.

## Devices - the phones and the web apps, side by side

Every phone on adb appears as a live, touchable screen with its own `flutter run`, and every
ASP.NET project in the workspace as a card running `dotnet watch run` with the site itself in
the window. So a referral can be driven on a phone and checked in the Admin Web beside it,
without leaving JARVIS.

- **Per phone:** a label you choose (Referrer / Referee, remembered), the app picker, Run /
  Stop, hot reload, hot restart, and that run's log. Back / Home / Recents under the screen.
- **Run on every phone** starts the same app on all of them at once.
- **Fullscreen:** the ⤢ button under a screen, or double-click the phone's title row. **Esc**
  leaves it. The log hides so the screen is as tall as the window allows; Back / Home /
  Recents stay, so Esc is free to mean "leave fullscreen".
- **Side by side:** one row, each phone as tall as the window allows (the row is sized from
  the window, not from a chain of flex parents - that chain used to squeeze the phone row to
  nothing when the web column below it was taller than the space left), with a **draggable
  divider** between them - drag to give one phone more room, double-click the divider to even
  them out. The split is remembered per phone. Logs hide in this mode; the `<>` button under a
  screen brings one back.
- **Input:** click to tap, drag to swipe, wheel to scroll; type when a screen is selected, and
  Ctrl+V pastes the PC clipboard into the phone.
- **Shrink it like scrcpy:** fullscreen a phone and drag the window down to about 380x520. The
  phone's name becomes a slim title bar you can drag to move the window - Windows draws its
  minimise / maximise / close on that strip (the right 150px is kept clear for them, as in the
  main header), so they never float over the picture. The run controls step aside, the phone
  fills what is left, and the keys and the way out stay on screen. Double-click the strip and
  Windows maximises, as on any title bar; leave fullscreen with the button or Esc.
- Screens stream only while the Devices view is open; `flutter run` keeps going regardless.
- Built on scrcpy 3.3.3's server (`vendor/`, pushed to the phone under its own name) driven by
  Tango over the adb server that is already running. The installed scrcpy keeps working.

### Phone alerts - a buzz in your pocket when work stops

The strip above the phones: **Alert my phone when work stops**. Pick a phone, turn it on, and
JARVIS notifies it when a turn finishes or when it is blocked waiting for you, so a long job
can be started and left.

- **Nothing is installed on the phone and nothing leaves this machine.** Android's own
  `cmd notification post` runs as the shell user, so adb alone can raise a notification. No
  account, no push service, no internet hop.
- **Over USB** it works the moment the cable is in and USB debugging is allowed.
  **Over Wi-Fi** moves the phone to `adb tcpip 5555` and connects to it, so the cable can come
  out; the phone and the PC must be on the same network. The address is remembered and
  re-connected on demand, since the phone drops it on reboot.
  The phone's address is taken only from a private LAN interface - a phone on mobile data has
  a valid-looking address too, but it sits behind the carrier's NAT and is unreachable here.
- **What earns a buzz** is deliberately much less than what earns a line on screen:
  a turn that finished and took at least `minSeconds` (30 by default, in `config.json`), and
  any approval request or question, however short - those stop work dead. A finished turn
  carries the last thing JARVIS said, and how long it took.
- **Nothing while you are at the desk.** If the JARVIS window has focus, the phone stays quiet;
  you are already looking at the answer.
- One notification at a time: they all share a tag, so the newest replaces the last rather than
  stacking. Alerts arriving together are queued, not dropped - an approval request on the heels
  of something else is the one that most needs to be heard.
- **Test** sends one immediately. If the phone refuses three in a row JARVIS stops trying and
  says so in `jarvis.log`, until the setting or the phone changes. Every alert that does go
  out is logged as `phone alert sent`.
- **A post is confirmed, not assumed.** `cmd notification post` reports success as soon as it
  has built the notification, which says nothing about the phone showing it - a phone with
  notifications turned off for "Shell" swallows every one in silence. So the tray is read back
  afterwards. Mind the race: the notification is reliably *absent* from
  `cmd notification list` for the first half second, so the check waits and retries rather
  than believing the first look (chasing that race is what produced the stray `jarvis1`…`jarvis5`
  notifications during development).
- The notification appears under **Shell** with a generic icon. That is Android's doing: a
  shell-posted notification belongs to `com.android.shell`, and there is no app of ours to
  brand it with.
- Settings live in `%APPDATA%\JARVIS\config.json` under `phone`, not in the window, because the
  watcher runs in the main process and must work whatever view is open.

### The web apps (Admin Web, Panel Web, API Gateway, Insurance API)

A compact column beside the phones - a web app belongs in a browser with its dev tools, so
nothing is embedded here.

- **Run** starts `dotnet watch run -lp http` and, as soon as the app reports its address,
  **opens it in your normal browser**. The address is read from the app's own
  `Now listening on:` line, never assumed. A hot-reload restart does not throw a second
  window at you.
- **Hot reload** (on by default) rebuilds and reloads when you save a file; untick it for a
  plain `dotnet run`. **Log** shows more of the output. The address can be clicked to open
  again, or copied.
- **Stop** ends the whole process tree; everything started here also stops when JARVIS closes.
- The Admin Web and Panel Web cards carry a standing **"Talks to production data."** warning,
  because on localhost they do. Nothing starts on its own - every run is a click.
- Only an address on this machine can be handed to the browser (`jarvis:openUrl` checks it).
  The window itself embeds nothing: there is no `webviewTag`.

## Deleting sessions (anthropics/claude-code#25304)

- `/delete` deletes this session; `/delete <name or id>` deletes that one (id prefix, then
  the exact /rename title, then any title or first prompt containing the text). Several
  matches show a list to pick from. `-f` skips the confirmation.
- The trash button on a session in the list does the same.
- Handled in the window, not sent to Claude. Confirmation is a card in the conversation
  (focus on *Keep it*) - not `window.confirm`, which returned true when the window closed.
- Deletes `<id>.jsonl` and the `<id>/` folder through the SDK's `deleteSession`. This app's
  own session is closed first and a new one starts. A session open in another window
  (terminal, VS Code) is refused - Claude Code's live registry `~\.claude\sessions\<pid>.json`
  says which are open. Code: `findSessions`, `removeSession`, `openSessionIds` in
  `session.mjs`; `jarvis:findSessions` / `jarvis:deleteSession` in `main.mjs`.

## How it works

```
renderer (src/renderer: core, chat, dashboard, pages, devices, webapps, app)
      --preload IPC-->  main (src/main.mjs)
      main --> JarvisSession (src/session.mjs) --> Claude Agent SDK --> claude.exe
      main --> workspace.mjs (read-only: os, git, knowledge, memory, documents)
      main --> devices.mjs  (adb + scrcpy, flutter run)
      main --> webapps.mjs  (dotnet watch run)
```

- `session.mjs` drives Claude Code through the official **Claude Agent SDK** in
  streaming-input mode: `settingSources` user+project+local and the `claude_code`
  system-prompt preset (that is what loads CLAUDE.md). `canUseTool` turns permission
  requests into prompts in the window.
- Working / ready comes from Claude Code's own `session_state_changed` events (enabled with
  `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`), so queued messages keep the Stop button until
  the last one is answered. Older Claude Code without them falls back to `result`.
- Switching sessions stops the old one before its history is drawn, and a late history is
  dropped. Sessions over 16 MB show only their last 6 MB (a 300 MB transcript used to stall
  the app). The transcript keeps the latest 400 messages.
- Nothing is polled while the window is hidden; stats refresh only on the Command Center.
- `workspace.mjs` only reads. Git runs with `--no-optional-locks` (and `GIT_OPTIONAL_LOCKS=0`
  for the scripts it runs, such as `scan-status.py`); documents are read
  only from `.claude\{knowledge,jarvis,agents,skills,commands}` and the memory folder, and
  only `.md` files (paths are checked to stay inside those folders).
- The window has no Node access: `contextIsolation`, `sandbox`, a strict CSP, and only the
  functions in `preload.cjs`. Model and tool text is inserted as text or as Markdown
  sanitized by DOMPurify - with `style`, `class`, `id` and form controls removed, so text
  from a web page or file cannot draw a fake approval card. Links open in the normal browser.
- The SDK ships Claude Code as `claude.exe`; the packaged app keeps it outside the asar
  (`asarUnpack`). Its version follows the SDK version.
- The window icon is unpacked the same way. Windows reads that file natively, and a path
  inside `app.asar` is not a real file - which is what left the taskbar showing Electron's
  own icon and name even though the exe itself was branded JARVIS. The Start Menu shortcut
  carries the app id `com.bantuapps.jarvis`, so the taskbar button and notifications resolve
  to JARVIS.

## Rebuild after a change

```powershell
cd C:\Users\bantu\Downloads\JarvisApp
npm install          # first time / after a package change
npm run pack         # -> dist\win-unpacked\JARVIS.exe  (the shortcut points here)
```

Close JARVIS first (the build replaces its files). To update Claude Code inside the app:
`npm install @anthropic-ai/claude-agent-sdk@latest`, then `npm run pack`.

## Develop

```powershell
npm start
```

**From a VS Code terminal, clear `ELECTRON_RUN_AS_NODE` first** (`Remove-Item
Env:ELECTRON_RUN_AS_NODE`) - VS Code sets it for child processes, and Electron then runs as
plain Node ("electron does not provide an export named BrowserWindow").

- `node scripts/content-test.mjs` - unit test for how text + attachments become a message.
- `npm run smoke` / `node scripts/smoke.mjs B` - checks the SDK and login without the window.
- `node scripts/bridge-test.mjs` - one real turn through `JarvisSession`, all prompts allowed.
- Screenshots: `JARVIS_CAPTURE=<file.png>` (+ `JARVIS_CAPTURE_DELAY` ms, `JARVIS_VIEW=<view>`,
  `JARVIS_CLICK=<id or .class, comma-separated to click several in turn>`,
  `JARVIS_SIZE=<w>x<h>`, `JARVIS_AUTOPROMPT=<text>`).
  A page capture never includes the Windows caption buttons - those are window frame, not page. The window opens off-screen,
  never takes focus, screenshots itself and quits. `JARVIS_AUTOPROMPT` sends a real message.
- Developer tools: **Ctrl+Shift+I**. Log (also crashes, and script errors in the window as
  `[window error]`): `%APPDATA%\JARVIS\jarvis.log`.
- Every PowerShell or terminal run needs `ELECTRON_RUN_AS_NODE` cleared first - that includes
  starting `dist\win-unpacked\JARVIS.exe` from a shell VS Code opened, or it exits at once.
  The tell: exit code 0 in well under a second, no screenshot, and nothing new in
  `jarvis.log` (not even "JARVIS starting"). Confirm it with `JARVIS.exe --version` - a Node
  version such as `v24.15.0` means the variable is still set. In bash the one-off fix is
  `env -u ELECTRON_RUN_AS_NODE ./JARVIS.exe`.
- Settings (gear): desktop notifications, reduce motion, 24-hour clock - stored per window.

## Not in the app

- Voice (deliberately left out).
- Weather, location and calendar - no data source.
- The terminal's agent view for background sessions; interactive commands such as
  `/agents` or `/doctor` need the terminal.
