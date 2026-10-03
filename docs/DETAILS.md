# JARVIS - desktop app

A windowed front end for Claude Code in the BantuApps workspace. It is the same JARVIS
as the terminal and VS Code: it runs in `C:\Users\bantu\Downloads\BantuApps` with the
project `CLAUDE.md`, the 13 specialists in `.claude/agents`, skills, hooks and the MCP
servers, on the signed-in Claude account.

Desktop shortcut **JARVIS** -> `dist\win-unpacked\JARVIS.exe`.

The workspace folder is chosen in **Settings → Workspace** and saved as `cwd` in
`%APPDATA%\JARVIS\config.json`; until one is chosen it is `DEFAULT_CWD` in `src\main.mjs`.
Settings marks the path in red when it does not exist on this machine. Switching restarts
JARVIS into the new folder rather than half-switching: the session, the file index, the
memory path and every git read are tied to the folder they started in. The restart stops
everything the app started first (`shutdownChildren`), so no `claude.exe`, `dotnet watch` or
`flutter run` is left behind working on the old folder.

## Design

Flat, neutral and quiet. One surface family, 1px borders instead of glows, type at its
natural letter-spacing, and colour reserved for things that mean something: a state, a
severity, a diff side. Every value is a token in `:root`, and every token is defined twice,
so the window follows the operating system's light/dark setting. Settings → Appearance pins
**System**, **Light** or **Dark**; pinning sets `data-theme` on `<html>`, which the
stylesheet gives priority over `prefers-color-scheme`.

The window opens on **Chat**, because that is what the app is for. Six views sit in the
sidebar; the six you reach for less often are folded under **More**, which remembers
whether you left it open (`localStorage`, `jarvis.navMore`) and opens itself whenever you
navigate to something inside it. **Ctrl+K** still reaches any view by name, so nothing is
more than one keystroke away.

| Keys | Does |
|---|---|
| **Ctrl+1** … **Ctrl+6** | Chat, Overview, Tasks, Source Control, Files, Memory - the sidebar's order |
| **Ctrl+N** | New session (asks first if JARVIS is mid-turn) |
| **Ctrl+K** | Search |
| **Ctrl+,** | Settings (again to close) |
| **Esc** | Stops a running turn - unless a dialog or the search results are open, which it closes instead |

Digits are read from `KeyboardEvent.code`, so the shortcuts work on any keyboard layout. Each
sidebar entry shows its shortcut in its tooltip.

Esc used to do both at once: the chat listens for it on the whole document, so closing the
search results or a dialog while JARVIS worked also stopped the turn. Now the search box
stops the event itself, and Settings catches Esc in the capture phase on `window`, before
the chat can see it. A stop you make yourself reads **Stopped by you** - Claude Code reports
an interrupt as `error_during_execution` with a diagnostic string, which used to be drawn
as a red error card and a "the turn stopped" notification for something you had just done.

Settings is a proper dialog: focus moves into it, Tab stays inside it, Esc closes it, and
focus returns to where it was. The sidebar marks the current view with `aria-current`,
**More** reports `aria-expanded`, Source Control's tabs are a `tablist`, and the theme and
alert-route switches are radio groups.

## Views

Every panel shows real data. Nothing is invented; where there is no source (weather,
location, calendar) there is no panel.

| View | What it shows | Source |
|---|---|---|
| **Overview** | The session's state in a line, the activity feed, this machine's CPU / RAM / disk, the specialists, the session's turns and tasks, models and connected systems | session events, `os`, git, knowledge files |
| **AI Core** | Model, effort, thinking, mode, Claude Code version, account, the context window by category, memory files in context | `getContextUsage`, `initializationResult` |
| **Agents** | The specialists, lit while working; click for the brief, or hand one a task | `supportedAgents`, `.claude/agents/*.md` |
| **Tasks** | Your ClickUp board (every sprint, every status), the workspace draft of work not logged yet, this session's task list and turns, the handoff's CURRENT FOCUS | ClickUp MCP (cached), `clickup-task-draft.md`, TodoWrite / TaskCreate / TaskUpdate, `JARVIS_HANDOFF.md` |
| **Memory** | Memories as a star map (lines are `[[links]]`) and a reader | `~\.claude\projects\...\memory` |
| **Chat** (the default) | The chat and recent sessions (terminal and VS Code sessions too); hover a session to rename or delete it, hover your message to undo its file changes | Claude Agent SDK |
| **Knowledge Base** | Knowledge, rules, agents, skills and commands; stale warning + `/relearn` | `.claude\*`, `scan-status.py --json` |
| **Tools & Skills** | Slash commands and skills, MCP servers with their tools, built-in tools | `supportedCommands`, `mcpServerStatus` |
| **Workspace** | The nine repos (branch, ahead/behind, modified/staged/untracked, last commit, open in VS Code), open issues, knowledge freshness | `git --no-optional-locks status`, `open-issues.md` |
| **Files** | Every text file in the workspace, read-only, with a preview and one click into VS Code | the workspace folder |
| **Source Control** | One repository at a time: changes and diffs, staging and commits, branches, fetch / pull / push, history, stashes, conflicts - and, for a GitHub repository, its pull requests and workflow runs (read-only) | `git`, the GitHub API on request |

Header: system status (derived: session, MCP, knowledge, pending decisions - hover for
reasons), clock, search (Ctrl+K: views, sessions, agents, commands, repos, documents),
notifications, settings, the signed-in account. Bottom bar: network, session time, context
and Executive Briefing.

The chevron beside the JARVIS mark narrows the sidebar to a 56px icon rail - labels and the
status chip's words go, badges shrink to corner pills, and every button keeps its name as a
tooltip. The chevron moves under the mark so it is still reachable, and the choice is
remembered in `localStorage` under `jarvis.navCollapsed`.

The identity is kept but quiet: the wordmark, a status dot at the foot of the sidebar, and
one line on the Overview. The animated core orb is gone - its canvas is still in the page,
and `drawOrb` still works if it is ever given a size again, but nothing draws while it has
none, so there is no animation frame being spent on it.

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
  find/resolve/list` tools allowed. Nothing is ever written back.
- The model only makes the calls. The tasks are read from the `filter_tasks` results
  themselves, and the query is stopped the moment the last page (`has_more: false`) is in -
  248 tasks take 20-55 s. The cache in `%APPDATA%\JARVIS\clickup-tasks.json` is replaced
  only by a list proven complete: every page from 0 with no gap, closed tasks included, every
  space covered. Anything less fails with a message and leaves the board as it was. A
  5-minute limit bounds a remote that never answers. The page opens from the cache instantly.
- Sprints are collapsible groups, newest first; the current sprint and anything with open
  work starts expanded. Search by code or title, pick one sprint, or show only unfinished.
  The summary tiles are clickable filters, and the few unfinished tasks are listed in full
  at the top so they are never buried. Each row opens in ClickUp in your browser.
- **Not in ClickUp yet** reads `.claude/jarvis/clickup-task-draft.md` from the workspace and
  lists what is waiting to be logged, above what has already gone.
- The code is split out of the task name (`BE331 - Fix ...`) into its own chip, including the
  `QA-` variants.

## Source Control - git first, GitHub read-only

GitHub Desktop's everyday workflow for the nine repositories and the app's own: Changes,
History and Stashes tabs beside a diff, the commit box beneath, and one remote button whose
label comes from refs already on disk. Remote git runs only when you press it. The full
design, its safety rules and every verification are in the workspace's
`.claude/jarvis/proposals.md`, P-009.

**GitHub** is a fourth tab, shown only when the repository's `origin` is on github.com
(HTTPS or SSH; any other host shows no GitHub UI). It is read-only - JARVIS creates,
comments on, merges or re-runs nothing on GitHub.
- **Links, no API call:** Repository, Branch and Commit (each "↗" to open in the browser,
  "Copy" for the address); "GitHub" beside a file's diff; "View on GitHub" in a commit. They
  are built from local refs, and a link that would 404 because something is not pushed yet
  is refused with the reason.
- **Pull requests:** opening the tab loads this branch's pull request and the open ones, 20
  at a time (Open / Closed, Load more). Choosing one loads its detail; "Changed files"
  loads its files, 50 at a time; choosing a file shows its patch in the same diff view as
  Changes. No pull request for your branch? "Open a pull request on GitHub" opens GitHub's
  page - you create it there.
- **Checks:** "Check workflow runs" asks GitHub about the latest commit GitHub has from this
  branch (or a commit from History, or a pull request's head): each workflow run with its
  status, times and a link, and the commit's checks. Four repositories deploy to dev on a
  push to `development`, so this answers "did my push deploy?". After a push the window
  offers the button; it never presses it.
- **When GitHub is asked:** only when you open the tab, press Refresh, Load more, Check or
  Try again, or choose a pull request or a file. Never at startup, on choosing a repository
  or branch, on a timer, or after a commit, fetch, pull or push. The last answer stays,
  labelled with its time.
- **Sign-in:** the Git Credential Manager sign-in git already uses, read through git's
  credential protocol, without any prompt, only when a request needs it. It is held in
  memory by the main process - never in the window, a file, a log or an error - and never
  removed, even if GitHub rejects it (fetch or push once in git to renew it).
- **If GitHub fails** (offline, rate-limited, signed out, slow), the tab says so and offers
  Try again; everything else in Source Control is unaffected. Requests are logged as
  operation, repository and status, e.g. `github pulls myInsurAPI 200 (graphql 4998/5000)`.

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

**Settings → Phone alerts**: **Alert my phone when work stops**. Turn it on and JARVIS tells
you when a turn finishes or when it is blocked waiting for you, so a long job can be started
and left. It used to sit above the phones on the Devices page; it moved beside the desktop
notification setting, where you would look for it, because the Telegram route has nothing
to do with the phones plugged in. **Only for turns longer than N seconds** sets
`minSeconds`; approvals and questions come through whatever it says.

There are two routes, and the strip switches between them. `createPhoneWatcher` decides
*when* to buzz; the route decides *how*, through the `send` function main.mjs hands it, so
the rules below about what earns a buzz are identical either way.

| Route | Reaches the phone | Needs | Privacy |
|---|---|---|---|
| **This phone** (`adb`) | On the cable, or the same Wi-Fi | Nothing on the phone | The text never leaves this machine |
| **Telegram** | Anywhere it has signal, including mobile data | A bot you make once, free | The text passes through Telegram |

#### Telegram - the route that works away from the house

Three steps, all in Settings, and no phone number anywhere:

1. In Telegram, message **@BotFather** and send `/newbot`. Paste the token it gives you into
   the box and press **Check token**. JARVIS asks Telegram whether the token is real
   (`getMe`) and only then writes it to `config.json`.
2. Open your new bot in Telegram and send it anything. Press **Find my chat**: JARVIS reads
   the chat id out of `getUpdates`, so it never has to be looked up by hand. A private chat
   is preferred over a group, and the newest wins.
3. **Test**.

- **The token is a credential and is treated as one.** It goes one way - the window posts it
  to the main process and is never given it back; `phoneConfigForWindow` tells the window
  only whether a token is set and what the bot is called. It is never logged, and `redact()`
  in `telegram.mjs` scrubs it out of error text before that text reaches the window or the
  log (Telegram puts the token in the URL, so `fetch`'s own failure messages carry it).
- Messages are sent as plain text with no `parse_mode`. A body can contain a file path, a
  tool name or whatever the model last said, and none of that is written to be safe inside
  Telegram's Markdown - one unbalanced asterisk would fail the whole send.
- A `429` is waited out once, for as long as Telegram says. Everything else is reported in
  Telegram's own words, which are clearer than anything worth writing here.
- Because the text does leave the machine on this route, the bodies are kept short on detail.

#### Remote control - talk to JARVIS from Telegram

**Settings → Phone alerts → Chat with JARVIS from Telegram.** With it on, your bot's chat is
a second keyboard: what you send it runs on this PC exactly as if you had typed it, approvals
and questions come to the chat as buttons, and the reply comes back when the turn ends. The
desk shows the message too, tagged *via Telegram*, and the feed says a message came in.
`src/remote.mjs`; tested by `node scripts/remote-test.mjs`.

| In the chat | Does |
|---|---|
| any message | Runs it - queued behind a running turn, like typing at the desk |
| a button on an approval | **Deny**, **Allow once**, or **Allow for this session** where the desk would offer it |
| a button on a question | That option; for several-answer questions tick them, then **Done**. Or reply with your own words |
| `/status` | Working, waiting or standing by; how many decisions wait on you; model, mode, folder |
| `/stop` | Stops the running turn (the desk reads "Stopped by you") |
| `/new` | New session - refused mid-turn, `/stop` first |
| `/sessions` | The 8 most recent sessions, the current one marked ▶, a button for each - tap to carry it on |
| `/switch <n or words>` | Resume session *n* from the last list, or the one whose title matches; says where it left off. Refused mid-turn |
| `/screen` | A screenshot of every screen, as photos (a file if Telegram refuses the size) |
| `/diff` | Which repositories have uncommitted, unpushed or unpulled work |
| `/diff <repo>` | That repo's `git diff --stat` and new files, with the full patch attached as a `.diff` file |
| `/brief` | The morning brief now. `/brief off`, `/brief on`, `/brief 07:30` change its schedule |
| a voice note | Transcribed on this PC, shown back as `🎙 "…"`, then handled exactly like typed text |
| `/help` | The list |
| other `/commands` | Go to Claude Code as typed (`/compact`, `/context`, `/cost` …) - except `/delete`, which only works at the desk |

**Show the PC's conversation in Telegram** (under remote control, needs it on) mirrors the
desk too: a message typed at the PC appears in the chat as `💻 PC: …`, then each of JARVIS's
replies as it is written, so the chat holds the whole conversation. A mirrored turn is
claimed, so no "finished" alert repeats it; a desk turn that stopped is left to the alerts.
The text passes through Telegram, which is why it is off until switched on.

**Nudges.** An approval or question on the phone left unanswered for 30 seconds gets one
more message - "⏰ JARVIS is still waiting for you…", sent as a reply to it, so the phone
buzzes again and a tap jumps to the buttons. One kept at the desk because the window had
focus, and not answered there within 30 seconds, is sent on to the phone with its buttons:
the window can have focus with nobody in front of it. Both only while remote control is on.

**Which turns reach the phone.** A turn you started from the phone sends you everything: its
approvals, its questions, its reply, and *typing…* while it works (paused while it waits on
you). A turn started at the desk sends its approvals and questions to the phone only while
the window does not have focus - you have stepped away - and its ending goes out as the
usual alert, so you never get an alert and a button for the same thing (remote control
"claims" what it sends, and `phone.event` stays quiet about a claimed event). A prompt
answered at the desk loses its buttons on the phone ("answered at the desk"); one answered
on the phone shows the verdict on the desk's card ("✓ Allowed once from your phone").

**The rules, and why each exists** - this is a way to drive Claude Code on this PC from
anywhere, so:

- **Off unless switched on**, with a plain-words confirmation, and only once the Telegram
  route is set up. Switching it on says so in the chat, which also proves the route works.
- **Only your chat is obeyed**: a private chat whose id is the configured one, from the
  user with that same id. Telegram sets `from` on its own servers, so it cannot be forged
  from outside. Anyone else - a stranger who finds the bot, a group it was added to - gets
  silence, which confirms nothing, and one line in `jarvis.log`.
- **Nothing runs late.** A message sent while JARVIS was closed, or while remote control was
  off, is never executed afterwards: Telegram would happily deliver it later, and it was
  written to a JARVIS that was not listening. The clock restarts every time listening
  starts - at launch, on switching back on, and after **Find my chat** (so the "hi" you sent
  to be found is not run either). One note in the chat says what was skipped.
- **A button counts only on the message it was sent on.** Buttons carry a short local key,
  and a tap is accepted only if it comes from you *and* from the message id recorded for
  that prompt - so a look-alike message with forged buttons, from anyone holding the bot
  token, cannot approve anything. A second tap, or a tap after the desk answered, does
  nothing: `respond()` takes the first answer for a prompt and ignores the rest.
- **The desk's gates, unchanged.** Approvals still need approving; there is no bypass mode;
  *Allow for this session* appears only where the desk offers it, on its own row away from
  *Allow once*, and means this session - never a settings file.
- **Screenshot runs never listen** (`JARVIS_CAPTURE`): they start and quit on their own and
  must not take a real message off the queue. `JARVIS_REMOTE_TEST=1` overrides that for a
  run that is about remote control.
- **One reader at a time.** Telegram serves a single `getUpdates` per bot; a second reader
  (another JARVIS, a bot tool) gets `409 Conflict`, logged once and retried quietly.

JARVIS has to be running for any of this - minimized is fine - and the PC awake. So while
remote control is on, JARVIS keeps the PC from sleeping (`powerSaveBlocker`,
`prevent-app-suspension`: the screen may still turn off and lock), and closing the window
hides it to the tray instead of quitting - the window is what submits a Telegram message, so
it must stay alive. Quit from the tray icon's menu. Both stop when remote control is switched
off. **Settings → Preferences → Start JARVIS when Windows starts** registers the packaged
exe with `--hidden`, so it comes up in the tray at login (not offered in a development run,
which would register `electron.exe`). Closing a laptop lid can still sleep it, depending on
Windows' lid setting. Text and
photos: a photo goes to the model as an image (the largest size Telegram has that fits the
3.75 MB limit), with its caption as the message - an image sent "as a file" works too if it
is PNG, JPEG, GIF or WebP. It is downloaded only after the same checks as text (your chat,
not sent while away), and the log records its size, never the caption. Other files get a
polite refusal. An album arrives as one message per photo. A turn started from
the phone sends every update to the chat as it is written, not only the last one when the
turn ends - a long job used to stay silent on the phone for minutes. Messages are plain text with no
Markdown, so replies show code as typed. A reply over 6,000 characters arrives as its first
part plus the whole reply as a `.md` file (if the upload fails, as split messages instead);
shorter ones over 4,096 are split at paragraph, then line, then word boundaries.

**Voice notes** (`src/voice.mjs`) are transcribed locally, with no audio leaving the PC: the
Ogg/Opus note is decoded by a WebAssembly Opus decoder (`ogg-opus-decoder`), mixed to 16 kHz
mono, and read by Whisper small (`onnx-community/whisper-small`, 8-bit) on the CPU via
`@huggingface/transformers` and onnxruntime. The model, about 250 MB, is downloaded once on
the first voice note into `%APPDATA%\JARVIS\models`, and loaded on demand; after that a short
note takes a second or two. The transcript is echoed so you see what was heard, then goes
through the same path as typing: an answer to an open question, a reply instead of an
approval, a command, or a message. Silence (Whisper's "you" / "Thank you.") runs nothing;
notes over 5 minutes are refused before download. The log records duration, never words.

**The morning brief** (`src/reports.mjs`, no model tokens): on weekdays at 08:00, while remote
control is on, one message with the PC's state, each repository with work in progress, open
issues, the handoff's current focus, ClickUp in-progress tasks and the last session. Sent once
a day (`brief.sent` in config.json, so a restart does not repeat it) and only within three
hours of the set time. `/brief` gets it any time.

**The startup greeting** (`greeting()` in `src/remote.mjs`, sent from `main.mjs`): each time
JARVIS starts, by hand or at login, one message goes to the phone while remote control is on:
"Good morning / afternoon / evening. JARVIS is online on your PC and standing by". Morning is
05:00-11:59, afternoon 12:00-16:59, evening the rest, all by the PC's clock. It is a normal
message, so the phone buzzes. After a system update (`--updated`) the "System update installed"
message is sent instead, never both. Reopening a JARVIS that is already running (from the tray
or the shortcut) sends nothing. Tested in `scripts/remote-test.mjs`.

**Power down and Wake up** (`controlWord()` in `src/remote.mjs`, `powerDown()` / `wakeUp()` in
`main.mjs`): a message that is just "Power down" or "Wake up" counts. Any case and trailing
punctuation are fine, as is "JARVIS, " in front, and a PC's name before or after ("Wake up
Work-PC", "Home-PC, power down"). It can be typed or sent as a voice note. Anything longer,
like "power down the test server", runs as a normal message.

- *Power down* puts JARVIS to sleep: the window is destroyed and the session, web apps and phone
  mirrors stop, but the Telegram listener stays in the tray (with keep-awake, so it can still
  hear you). The phone gets "💤 JARVIS on … has powered down. Say "Wake up" to bring it back."
  While asleep, tasks, photos and files get "asleep, say Wake up first", and /status says
  "Asleep". With remote control off there is nothing to wake it from, so Power down at the desk
  quits instead.
- *Wake up*, a click on the tray icon, or opening the shortcut brings the window back with a
  fresh session and sends the time-of-day greeting.
- *Quit JARVIS* in the tray still shuts down fully. With remote control on, the phone first gets
  "🔌 JARVIS on … has shut down and is offline" (4 s at most).

From the phone these words are caught before anything else, so they are never taken as the
answer to a question or a reply to an approval. At the desk "Power down" is caught in
`jarvis:send` before the session sees it. Words sent while JARVIS was not listening are skipped
like any other late message.

**More than one PC** (`src/presence.mjs`, `onGroupText()` in `remote.mjs`). Each PC has its own
bot and a name, set in **Settings → Phone alerts** (letters, digits, spaces, dots, dashes;
names match ignoring case and punctuation, but "Work-PC" is not "Work-PC1"). Your private chat
with a PC's bot is that PC's alone, so commands there act at once. For choosing between PCs,
put every bot in one Telegram group with you and make each one an admin with "Change group
info". The admin rights let a bot see ordinary group messages and edit the group description.
Send "hi" there and press **Find my group**. In the group:

- Only your messages are obeyed, and only "Wake up", "Power down" and /status (each PC answers
  with its state). Anything else is never run, because every PC would run it. The first PC by
  name replies with a hint instead.
- A named command is acted on by that PC alone.
- Unnamed, a PC acts at once if it is the only one that could answer (the only one asleep for
  Wake up, the only one awake for Power down). If more than one could answer, each posts its
  own button ("☀️ Wake Home-PC"), and you tap the one you mean. A button works only on the
  message it came on, only for you, and expires after 2 minutes.

Telegram never shows a bot what another bot writes, so the PCs share state through the group's
description, used as a board: one line per PC, like `🟢 Home-PC · awake · 2026-10-03 12:43Z`.
A PC rewrites its line on every change and refreshes it every 5 minutes. A line older than 12
minutes belongs to a PC that is off, and is ignored. Every write is read back and retried, in
case two PCs wrote at once. Other text in the description is kept. A PC removes its line when
it quits, when remote control is turned off, or when it leaves the group, and renaming a PC
moves its line. If Telegram turns the group into a supergroup (new id), JARVIS follows the
move. Tested in `scripts/remote-test.mjs` and `scripts/presence-test.mjs`.

**Deploy alerts** (`src/deploys.mjs`): when a Bash or PowerShell command JARVIS runs looks like
a deploy - anything with `deploy`, `dotnet publish`, `flutter build apk|appbundle|ipa|ios|web|windows`,
`eas build|submit|update`, `vercel --prod`, `docker push`, `az webapp deploy` and a few more -
its ending is sent to the phone: 🚀 finished or ❌ failed, how long it took, the command and its
last five lines. Over Telegram while remote control is on, else through phone alerts if those
are on. Whoever started the turn. A command sent to the background is not announced. Tested by
`node scripts/deploy-test.mjs`.

What the bot token can and cannot do matters more now. Whoever holds it can read what you
send the bot and message you as JARVIS - but cannot make JARVIS act, because commands are
only taken from your account. Keep it private, and rotate it with @BotFather's `/revoke`
if it has ever been shown anywhere: paste the new one into **Check token**, and the chat id
stays.

#### This phone - the local route

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
- **Test** sends one immediately, *by the route currently selected* - so what it proves is
  the route you will be relying on. If three in a row are refused JARVIS stops trying and
  says so in `jarvis.log`, until the setting changes. Every alert that does go out is logged
  as `phone alert sent`. A route that is simply not set up yet is skipped silently rather
  than counted as a failure.
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
- Nothing is polled while the window is hidden; stats refresh only on the Overview.
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
- **`npm run shortcuts`** makes that shortcut (and the desktop one) on a new machine. Windows'
  own shortcut tool cannot write an app id, so `scripts/shortcuts.ps1` goes through
  `IShellLink` and `IPropertyStore`, writes the app id **and the toast activator CLSID**, reads
  both back to prove they took, removes any Start Menu shortcut a development run made for
  this repository's `electron.exe`, and refreshes the icon cache.
- **The identity is fixed in code** (`IDENTITY` in `src/main.mjs`): app id
  `com.bantuapps.jarvis` and toast activator `{445FDA2C-…}` for the packaged app, and a separate
  pair (`com.bantuapps.jarvis.dev`) for development. How it went wrong without that: Electron
  invents a random activator every run, and when a notification finds no Start Menu shortcut
  carrying the app id and that activator, it writes its own and registers a COM server for
  it. A screenshot run - `electron.exe`, under the real id - did exactly that, leaving
  `Start Menu\Programs\Electron.lnk`; Windows then resolved JARVIS's id to "Electron", and the
  taskbar button, its jump list and every notification showed the name and the atom. The fix
  is three-sided: dev runs no longer use the real id, the real app always registers the same
  activator, and the shortcut carries it, so Electron finds what it looks for and writes
  nothing. Start's name for an id is cached; rewriting the shortcut is what refreshes it.
  A running JARVIS keeps the identity it started with - restart it after `npm run shortcuts`.
- **Screenshot runs never notify** - the window's notification permission is refused and
  `JV.notify` checks again - and never listen to Telegram. They used to put real toasts on the
  screen, as Electron's.
- The window's caption buttons (drawn by Windows, not the page) wear the header's colours and
  follow the theme: the window tells the main process which theme is showing (`jarvis:titleBar`)
  at start, when Settings changes it, and when Windows switches light/dark. They are 40 px tall,
  the height of the fullscreen phone's title strip they sit on.

**The Telegram bot is dressed as JARVIS too**: `npm run brand-bot` sets its profile picture,
description and the `/` command menu (`/status /stop /new /sessions /switch /screen /diff /brief /help`) through the Bot API
(`setMyProfilePhoto` arrived in Bot API 9.4). The picture is `build/telegram-avatar.jpg` -
`build/source.png` cropped square around the HUD ring and scaled to 640 px, because Telegram
shows profile pictures as circles and the whole rounded-square icon would lose its corners;
a JPEG because a static profile photo must be one. Rotating the token does not undo any of
it - these belong to the bot.

## Rebuild after a change

```powershell
cd C:\Users\bantu\Downloads\JarvisApp
npm install          # first time / after a package change
npm run pack         # -> dist\win-unpacked\JARVIS.exe  (the shortcut points here)
```

Close JARVIS first (the build replaces its files). To update Claude Code inside the app:
`npm install @anthropic-ai/claude-agent-sdk@latest`, then `npm run pack`.

**`npm run pack` can fail and still exit 0.** If anything holds `dist\win-unpacked` open -
a running JARVIS.exe, or a shell sitting in that directory - electron-builder stops with
`⨯ EBUSY: resource busy or locked, rmdir`, prints it, and the exit code is still zero. The
build then looks successful while the exe on disk is the previous one. Read the last lines
of the output, not the exit code, and confirm the new code actually landed:

```powershell
npx asar extract dist\win-unpacked\resources\app.asar tmp-asar
Compare-Object (Get-Content src\main.mjs) (Get-Content tmp-asar\src\main.mjs)   # no output = identical
```

**Updating without closing JARVIS by hand.** Build beside the running copy with
`npx electron-builder --dir "-c.directories.output=dist-next"`, then run
`scripts\swap-update.ps1` detached. It waits 4 s, closes every process running from
`dist\win-unpacked` (JARVIS and the `claude.exe` sessions it started, which would otherwise
outlive it), backs the live copy up to `dist\win-unpacked.old`, copies the new build in and
restarts JARVIS. It copies with robocopy instead of renaming folders, because Windows refuses
to rename a folder that anything has open (Search or a virus scan), even with nothing running
from it. Each step retries for 30 s. If copying the new build fails partway, the backup is put
back. The log is in `swap-update.log`.

## Develop

```powershell
npm start
```

**From a VS Code terminal, clear `ELECTRON_RUN_AS_NODE` first** (`Remove-Item
Env:ELECTRON_RUN_AS_NODE`) - VS Code sets it for child processes, and Electron then runs as
plain Node ("electron does not provide an export named BrowserWindow").

- **`npm test`** runs both unit tests below - no network, no window, a second or two.
- `node scripts/content-test.mjs` - unit test for how text + attachments become a message.
- `node scripts/remote-test.mjs` - remote control against a fake Telegram: who may speak,
  nothing running late, forged buttons, questions, the audit trail, the log never claiming to
  listen when it is not. Each safety rule was also broken on purpose once, to prove its test
  fails when it should.
- **Rebuilding while JARVIS is open**: build beside it, then swap when it closes -
  `npx electron-builder --dir -c.directories.output=dist-next`, and once JARVIS is closed,
  move `dist-next\win-unpacked` over `dist\win-unpacked`. A plain `npm run pack` would fail
  on the locked folder (and still exit 0 - see above).
- `npm run smoke` / `node scripts/smoke.mjs B` - checks the SDK and login without the window.
- `node scripts/bridge-test.mjs` - one real turn through `JarvisSession`, all prompts allowed.
- Both run in the same folder as the app (`scripts/workspace.mjs`): `JARVIS_CWD` if set, else
  `cwd` from `config.json`, else the default - and stop with a clear message if that folder
  is missing. They used to hardcode the original machine's path and fail anywhere else.
  Each real turn they run leaves a session in that folder's history; delete them from the
  session list afterwards (hover → bin) if you would rather not see them.
- Screenshots: `JARVIS_CAPTURE=<file.png>` (+ `JARVIS_CAPTURE_DELAY` ms, `JARVIS_VIEW=<view>`,
  `JARVIS_CLICK=<id or .class, comma-separated to click several in turn>`,
  `JARVIS_SIZE=<w>x<h>`, `JARVIS_AUTOPROMPT=<text>`).
  By default the click lands 1.5 s before the capture, and the app quits right after it - fine
  for instant UI, fatal for anything slow. For a model query or a sync, set
  `JARVIS_CLICK_AT=<ms>` to click early and a `JARVIS_CAPTURE_DELAY` long enough to finish.
  `JARVIS_CLICK_GAP=<ms>` spaces the clicks further apart than 1.2 s, for a flow where each
  click waits on a request; `JARVIS_FILL_AT=<ms>` types the `JARVIS_FILL` text at that
  moment, so a later click can submit it. Chromium switches pass through, so
  `-- --proxy-server=127.0.0.1:9` makes GitHub unreachable without touching git. A click
  selector may end in `:first-of-type`, `:last-of-type` or `:nth-of-type(n)` to reach a later
  row. `JARVIS_HOVER=<selector>` moves the mouse over an element and `JARVIS_FOCUS=<selector>`
  gives it keyboard focus (with DevTools focus emulation, so the window never takes real
  focus), 800 ms before the capture. `JARVIS_KEYS=<combo>;<combo>` presses keys a second
  apart from `JARVIS_KEYS_AT=<ms>` (default 2.5 s before the capture) - `Ctrl+3`, `Ctrl+,`,
  `Escape` - as real key events, so a shortcut can be proven, not assumed. Semicolons
  separate them because a comma can be the key. The Esc fix was proven this way: a turn
  streaming 1-80, `Ctrl+,` then `Escape` mid-stream, and the turn finished; the control run,
  `Escape` alone at the same moment, stopped it at 52.
  A page capture never includes the Windows caption buttons - those are window frame, not page. The window opens off-screen,
  never takes focus, screenshots itself and quits. `JARVIS_AUTOPROMPT` sends a real message.
- Packaged SDK health check: `JARVIS_DIAG_QUERY=<out.json>` runs one minimal query ("Reply
  exactly: OK", every tool denied, no MCP) with no window, writes its lifecycle and runtime
  facts to the file, and exits. It never records a credential, a token or real prompt content.
- Developer tools: **Ctrl+Shift+I**. Log (also crashes, and script errors in the window as
  `[window error]`): `%APPDATA%\JARVIS\jarvis.log`.
- Every PowerShell or terminal run needs `ELECTRON_RUN_AS_NODE` cleared first - that includes
  starting `dist\win-unpacked\JARVIS.exe` from a shell VS Code opened, or it exits at once.
  The tell: exit code 0 in well under a second, no screenshot, and nothing new in
  `jarvis.log` (not even "JARVIS starting"). Confirm it with `JARVIS.exe --version` - a Node
  version such as `v24.15.0` means the variable is still set. In bash the one-off fix is
  `env -u ELECTRON_RUN_AS_NODE ./JARVIS.exe`.
- Settings (gear, or **Ctrl+,**): the workspace folder, appearance (System / Light / Dark),
  phone alerts, desktop notifications, reduce motion, 24-hour clock. Appearance and the
  window preferences are stored per window in `localStorage` under `jarvis.prefs`; the
  workspace and phone alerts in `config.json`, because the main process needs them whatever
  view is open.

## Not in the app

- Voice (deliberately left out).
- Weather, location and calendar - no data source.
- The terminal's agent view for background sessions; interactive commands such as
  `/agents` or `/doctor` need the terminal.
