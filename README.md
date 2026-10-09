<div align="center">

<img src="build/icon.png" width="110" alt="JARVIS">

# JARVIS

**Claude Code on your desktop, and in your pocket.**

A Windows command center for Claude Code and the projects in your workspace: chat, Git, devices and builds in one window, which you can also drive from your phone over Telegram.

![Windows](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D6?logo=windows&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-app-47848F?logo=electron&logoColor=white)
![Claude](https://img.shields.io/badge/Claude-Agent%20SDK-D97757)
![Telegram](https://img.shields.io/badge/Telegram-remote-26A5E4?logo=telegram&logoColor=white)

</div>

---

## 🆕 What's new in v2.4.0

See the [Releases page](https://github.com/Silentt9879/JarvisApp/releases) for every published build; this is the current one.

**Simplified**

- 📓 **Knowledge Notes.** A second, separate Markdown note store alongside the existing Notes page - a two-pane editor (title, tags, favorite, Markdown with live preview), Trash with Restore, and full **Version History**: every meaningfully different save keeps the version it replaces, browsable, comparable against the current one, and restorable. Import your existing Notes in with a preview before anything happens.
- ☁️ **Google Drive backup & restore for Knowledge Notes.** Connect your own Google account (a one-time OAuth sign-in, in your own browser) and back up Knowledge Notes, Trash and Version History to a folder in your Drive - manually, with a press of **Back Up Now**. Restore shows a read-only preview of exactly what would change before anything happens, and needs an explicit second confirmation. See [Google Drive backup & restore](#google-drive-backup--restore) below.
- 🧭 **A sidebar that actually collapses.** Resize JARVIS to around half your screen and the navigation sidebar now properly shrinks to a compact icon-only rail with hover tooltips, instead of hiding the labels but leaving the same wide, mostly-empty sidebar behind.

**Fixed**

- 📜 **Version History now covers ordinary edits.** Previously it only kept a version when a save explicitly overrode someone else's newer change, or when restoring an older version - an everyday edit that changed a note's content had nothing to recover from. Every meaningfully different save now preserves what it replaces.
- 🗂️ A fresh install with no workspace chosen yet no longer throws a raw error when JARVIS looks up workspace documents - it reports "nothing found" cleanly instead.

**Technical**

- New: `src/knowledge.mjs` (the note store: atomic verified writes, byte-for-byte idempotent migration from `notes.json`, optimistic-concurrency saves, Trash, Version History snapshots), `src/renderer/knowledge.js` (the editor, Trash, Version History and Drive panels).
- New: `src/google-oauth.mjs` (Authorization Code + PKCE against a loopback redirect - Google's only supported flow for a desktop app), `src/drive-token.mjs` (encrypted credential storage via Electron's `safeStorage`, no plaintext fallback), `src/drive-connection.mjs` (connect/disconnect/status, no automatic reconnect or background refresh), `src/google-drive-provider.mjs` (the real Drive client, scoped to `drive.file` only - JARVIS can only ever see files it created itself), `src/drive-backup.mjs` and `src/drive-backup-controller.mjs` (the backup/restore engine: SHA-256-verified uploads, a manifest published only once every file is confirmed, single-use time-limited restore confirmation tokens, and a restore preview that re-verifies the remote backup's integrity before offering it).
- `src/workspace.mjs`: `docRoots(cwd)` now returns no roots (not a throw) when `cwd` isn't a usable workspace path yet.
- `src/renderer/styles.css`, `src/renderer/index.html`: the sidebar's narrow-window breakpoint now sets both `width` and `flex-basis` together (a flex item's rendered size follows `flex-basis`, not a standalone `width`), reusing the same compact-rail layout the manual sidebar toggle already had; every nav icon gained a `title` attribute for its hover tooltip.
- Tests: 13 new suites (`knowledge`, `knowledge-ipc`, `knowledge-trash`, `knowledge-history`, `knowledge-renderer`, `drive-backup`, `google-oauth`, `drive-token`, `drive-connection`, `google-drive-provider`, `drive-ipc-security`, `drive-backup-controller`, `nav-sidebar`); `npm test` runs 51 suites, all passing.

<details>
<summary><b>Earlier: v2.3.1</b></summary>

**Simplified**

- 📐 **Less scrolling on the Devices page.** Dart analysis and .NET build diagnostics now collapse behind their own header - each used to stay fully open even when empty, pushing everything below off screen. Click a header to open one; it remembers your choice, and still opens and scrolls into view by itself the moment a run or build actually fails.

**Technical**

- `src/renderer/index.html`: both panels' body (toolbar, banners, list) now sits in a `.pb-body` wrapper under a clickable `.pb-head`, collapsed by default via a `collapsed` class on the section.
- `src/renderer/problems.js`, `src/renderer/dotnet-problems.js`: an `open`/`setOpen()` toggle per panel, persisted to `localStorage` (`jarvis.problemsOpen`, `jarvis.dotnetProblemsOpen`), forced open on the existing failed-run/failed-build auto-trigger.
- Styling only, no new behaviour beyond the toggle itself: the panel's own trust-gating, discovery and build/analyse logic are unchanged.

</details>

<details>
<summary><b>Earlier: v2.3.0</b></summary>

**Simplified**

- 🩺 **.NET build diagnostics, on the Devices page.** The same idea as Dart analysis - what is wrong with a project, as Visual Studio's own Error List shows it, without leaving JARVIS. One project at a time from chips, grouped by file, worst first, click a problem to open it at that line in VS Code. Covers every .NET project in the workspace - sites, APIs, libraries, test projects - not only the ones that serve pages.

**Technical**

- New: `src/dotnet-analysis.mjs` (parses MSBuild's own diagnostic line format from a real `dotnet build -v:quiet` - both the file-located form and project-level ones like `NU1903` package warnings; deduplicates repeats and filters a referenced project's own diagnostics out, the same way `dart analyze` only ever reports the package being analysed), `src/renderer/dotnet-problems.js` (the panel, built on the exact structure and CSS `problems.js` already proved, no new styling).
- `src/project-providers.mjs`: `dotnetProjectsFrom()` resolves every .NET project's build target the same way the existing Build task action already does - the project's own file, or a solution marker, never guessed further.
- A real build runs (there is no dry-run diagnostic mode for .NET the way `dart analyze` is), so this is trust-gated exactly like Dart analysis and the Build/Test task actions, and wired into the same shutdown and power-down bookkeeping every other long-running tool already has.
- Tests: `dotnet-analysis-test`, 44 checks; `npm test` runs 38 suites, all passing.

</details>

<details>
<summary><b>Earlier: v2.2.0</b></summary>

**Simplified**

- 🧑‍🏭 **Build your own specialists.** The Agents page can now create, edit, duplicate, switch off and delete Claude Code subagents - the same kind of file that gives JARVIS its built-in specialists. Start from a blank page or one of six ready-made starters (Code Reviewer, Debugger, Test Engineer, Security Reviewer, Performance Analyst, Documentation Specialist), each one ready to use as it stands.
- ✨ **Build my team.** One button looks at the projects already found in your workspace and suggests a small team - a Flutter app gets a developer, a widget tester and a performance reviewer; a workspace with more than one kind of project gets a few that work across all of it. Nothing is sent to Claude to work this out, so it costs nothing; you choose, customize and preview the exact files before anything is created.

**Fixed**

- 🩹 **"Accept ours/theirs" in a Git conflict no longer corrupts the file.** Resolving a conflict on a binary file, a text file that is not UTF-8, or one larger than about 8 MB, could write it back corrupted - or, for the larger case, delete it outright - while saying it had worked. It now takes the file exactly as Git holds it, whatever it is.
- 🖼️ **A picture in a reply can no longer reach outside the app.** A Markdown image pointing at another computer (`![x](//host/share/a.png)`), from a reply, a workspace document or a GitHub pull request body, would make Windows try to fetch it - handing that computer your network sign-in. Only a picture carried in the text itself (a `data:` image) is shown now.

**Technical**

- New: `src/agents.mjs` (parsing, validating, creating, editing and deleting agent files, and the rule-based `planTeam()` behind Build My Team), `src/renderer/agents-page.js` (the roster, grouped by where each agent comes from, and its drawer), `src/renderer/agent-builder.js` (the editor and Build My Team dialogs) - no second agent runtime, just the same `.claude/agents` files Claude Code already reads.
- Every write is checked before it reaches disk: an edit must name the exact version it was opened at (an exclusive write otherwise, so nothing is silently overwritten), a new file's name comes only from the validated agent name, a link or junction is read but never written through, and a change to a restricted workspace, to the user's own Claude folder, or a grant of a tool that edits files or runs commands, needs an explicit approval passed back from the window. An edited or deleted agent's earlier version is always kept.
- `src/session.mjs`: a session now reports which agents the running Claude Code has and which background agent tasks are still open, and can restart itself in the same conversation (`reloadAgents()`) once nothing is left running - which is how a new or changed agent is picked up, since Claude Code only reads its agent folders when a session starts.
- `src/git.mjs`: `resolveConflict()` now writes the chosen side's bytes straight from `git cat-file blob` through a temp file and a rename, never through a JavaScript string - the fix behind the conflict-resolution defect above. New regression suite: `scripts/sc-conflict-test.mjs`.
- `src/renderer/core.js`: the Markdown sanitizer's DOMPurify hook now strips every attribute that fetches something (`src`, `srcset`, `poster`, `background`, and `href` off anything but a link) except a `data:` image - the fix behind the Markdown-image defect above.
- `scripts/session-test.mjs`: isolated from whoever's machine runs it - it now points `CLAUDE_CONFIG_DIR` at its own empty, throwaway folder for its own lifetime, so a personal `~/.claude/settings.json` can no longer change what the test expects.
- Verified against the bundled Claude Code itself, not just assumed: `scripts/agents-live-test.mjs` starts a real, isolated, signed-out session and confirms what it reports matches what `agents.mjs` says would load - sub-folders read, the front matter's name as the identity, a workspace agent hiding a personal one of the same name, a restricted workspace loading none of its own.
- Tests: two new suites (`agents-test`: 27 checks covering creation, editing, deletion, conflicts, trust, invalid drafts, path traversal, linked folders, discovery, templates and teams; `agents-live-test`: 7 checks against the real Claude Code); `npm test` runs 37 suites, all passing.

</details>

<details>
<summary><b>Earlier: v2.1.3</b></summary>

**Fixed**

- 🔒 **Telegram bot token, encrypted.** Stored the same way the GitHub token already is (Windows' own per-user encryption), not in config.json as plain text. An existing plain-text token is moved across automatically, once, the first time this build runs - and kept in place for as long as this PC cannot encrypt it, so nothing about phone alerts or remote control breaks over it.
- 😴 **Power down actually stops everything.** A Dart analysis run, a build/test task, or a Git fetch/pull/push left running when you say "Power down" is now stopped too - the phone is told what got stopped, since power down still does not wait for anything to finish. Previously these could keep running, invisibly, while JARVIS slept.
- 🪟 **Every side chat window closes too.** A popped-out chat window (File > New chat window) no longer keeps its own Claude session - and its own API usage - running after JARVIS reports itself asleep; the window itself closes along with the main one.
- 🐙 **A GitHub check miscounted a blocked request as "rate limited."** A 403 with no rate-limit headers at all - SSO required, a plain forbidden - was being read as "0 of your hourly limit left" and reported the wrong reason. It now reports the real one.
- 📝 **Notes survive a crash mid-save.** `notes.json` is now written the same crash-safe way `config.json` already is (a temp file, then a rename), so a crash or power loss mid-write can no longer leave it half-written and unreadable.

**Technical**

- New: `src/phone-token.mjs` (the Telegram token's encrypted storage and plain-text migration, reusing `updates.mjs`'s existing `saveToken`/`loadToken`/`clearToken`), `src/active-work.mjs` (the plain-English "what power down also stopped" message), `src/pane-windows.mjs` (closes every side chat's session and window together, shared by power down and the ordinary shutdown path).
- `src/main.mjs`: every phone-settings save now goes through `savePhoneConfig()`, which launders the token field through `phone-token.mjs` rather than writing it to config.json directly; `powerDown()` now also stops running tasks, Dart analysis and Git remote operations, and closes every side chat window, not only the main session.
- `src/git.mjs`: a `git pull` cancelled mid-merge or mid-rebase now says so plainly - an unfinished merge or rebase is left for you to resolve; nothing is reset, stashed or discarded automatically.
- `src/github.mjs`: `noteRate()` no longer misreads a response with no rate-limit headers as "0 of 0 remaining."
- `src/notes.mjs`: `NoteStore.write()` now writes through a temp file and a rename.
- Tests: 10 new suites (`phone-token`, `power-down`, `github`, `phone-mjs`, `session`, `pane-windows`, `pull-cancel`, `main-chat-ipc`, `files-docs`, `packaged`); `npm test` runs 35 suites, all passing.

</details>

<details>
<summary><b>Earlier: v2.1.2</b></summary>

**Fixed**

- 🏷️ **Every agent has a name of its own.** On the Agents floor, several specialists shared a name: two Tims, two Herbs, two Kevins, two Tonys, two Daves and two Jons among sixteen. Now no two share one. An agent that was not sharing keeps the name it had; only the ones that doubled up get a new one, and they keep it from then on.
- 👥 **The same name everywhere.** An agent is called the same on its desk, on the bench of resting agents, in the agents panel of the chat bar, on the chat's agent badges and in the activity feed.

**Technical**

- Cause: `JV.minionName` in `renderer/crew.js` gave each agent the pool name its own name works out to, and nothing compared it with the others. Sixteen agents over a pool of 28 names repeat more often than not; the workspace the report came from had six repeats.
- `renderer/crew.js`: `minionNames(agents)` works the names out for the whole list at once. Agents are taken in name order, so the order the session lists them in never matters. Whoever is first to a name keeps it, and an agent that meets a namesake takes the next free name after its own (`freeName`). Past the pool a name is numbered ("Kevin 2") rather than repeated. Claude Code's built-in agents keep their fixed names, and an agent the session never listed still gets a name nobody has. `JV.minionName` keeps the result per agent list. A desk now follows its minion's name when it is painted, because the list can arrive after the desk was built.
- `scripts/crew-test.mjs`: 18 new checks (45 in all) that lift the naming block out of the real `crew.js`. They reproduce the six repeats under the old rule, then show sixteen different names, that only those six agents were renamed, the same names in any order and on a fresh start, and 70 agents over 28 names with no two alike.

</details>

<details>
<summary><b>Earlier: v2.1.1</b></summary>

**Fixed**

- ⏹️ **A "Stopping…" that never ended, in GitHub Desktop.** After a fetch, pull or push had already finished, the button could switch itself back to "Fetching…" with nothing running. Pressing Stop then showed "Stopping…" for ever, because there was nothing to stop. The button now returns to rest as soon as the operation answers, and stays there.
- 🛑 **Stop can no longer hang.** If there is nothing to stop, it says so at once. If a stop is accepted but no answer comes back, JARVIS checks what is really running after six seconds instead of waiting.
- 🔄 **Refresh puts it right.** Pressing Refresh on the page also clears a button that is showing work that is not running.

**Technical**

- Cause: progress reaches the window as events (`webContents.send`) and the result as the reply to its own call (`ipcRenderer.invoke`). The two are not delivered in order relative to each other; in a test of this Electron version, events sent before the reply arrived after it in 194 of 300 rounds. A late progress event set `remoteOp` to a busy state after `runRemote` had set it to idle, the `idle` event that followed was ignored, and `stopRemote` waited on an answer that was never coming.
- `renderer/git.js`: `remoteLive` is true only between starting an operation and receiving its reply, and a busy state is accepted from an event only while it is true. `stopRemote` reads the answer to the cancel request and settles at once when nothing is live; otherwise it calls the new `reconcileRemote` after six seconds, which reads the app's own record through `gitRemoteState` (no remote is contacted). `refresh` reconciles too.
- `scripts/remote-button-test.mjs`: 18 checks driving the real `git.js` through that order of arrival. The same test fails on the v2.1.0 code.

</details>

<details>
<summary><b>Earlier: v2.1.0</b></summary>

**Simplified**

- ↔️ **The chat fits your window.** The conversation used to sit in a narrow column with empty space either side. It now fills the chat area on any screen, large or small, and follows the window as you resize it.
- 🎚️ **Set the width yourself.** A new width button in the message box (beside the mode button) offers **Fit**, **Wide** and **Reading** (the old narrow column), plus a slider for your own share of the window. JARVIS remembers your choice.

**Fixed**

- 🟡 **"Needs attention" with nothing wrong.** The status at the top could say "Needs attention" while Health showed every row in order. The two kept separate lists: the status also counted a connected tool that was not signed in, and workspace knowledge that was behind the code, which Health never showed. They are now one verdict, so the status only says "Needs attention" when Health shows what and why.
- 🧰 **Health now lists those two.** *Connected tools* shows which tools Claude is connected to, and treats one that only needs signing in as optional. *Workspace knowledge* says when it is behind the code as "Good to know", not as a fault.
- 🔔 A tool that only needs signing in no longer appears as a warning in the activity feed.

**Technical**

- New `renderer/chat-width.js` and a `widthPop` panel: the choice (`fit`, `wide`, `reading`, or a share from 50 to 100) is kept in the window's preferences and set as `data-width` on `.chat-main`. `styles.css` drives the transcript, the message box and its hint from `--chat-w` and `--chat-gut`; Fit is `100%` with margins of `clamp(28px, 4%, 80px)`. Percentages are used rather than container units, because making `.chat-main` a query container would re-anchor the menus that open from the message box.
- `health.mjs`: `connectors` and `knowledge` facts, and a fifth state, `note`, that never counts against the verdict. `features.mjs` keeps the tools from the session's `mcp` events; `main.mjs` passes the knowledge check it already ran and whether the workspace has `/relearn`.
- `renderer/app.js`: `renderSysStatus` shows the session's own state or Health's `level`, and no longer reads the tool list or the knowledge state. Health is asked again on `mcp`, `account` and `init`, when the workspace's knowledge changes state, and every ten minutes while the window is on screen. "Check again" in Health updates the status too.
- `scripts/status-width-test.mjs`: 46 checks, running the real Health rules, the real status function lifted from `app.js`, and the real `chat-width.js`. Screenshot runs at 1920 and 1100 wide showed the message box filling the chat area, and Health agreeing with the status.

</details>

<details>
<summary><b>Earlier: v2.0.0</b></summary>

**Simplified**

- 🗂️ **Any folder, any projects.** JARVIS no longer comes set up for one particular set of apps. Choose the folder that holds your work and it finds what is inside: Flutter and Dart, .NET, Node, Python, Gradle and Maven projects and Git repositories, including projects nested inside others. It only looks - nothing runs while it reads.
- 🧭 **A Projects page.** Each project in one place: what it is, what it needs from this PC and whether that is here, its Git state, what is running, and the Build, Test and Run actions its own files support. Every action is a click and shows its exact command.
- 🔀 **More than one workspace.** Add, rename, switch and remove them in **Settings → Workspaces**. A switch says what would stop, then restarts JARVIS cleanly in the new folder.
- 🛡️ **Workspace trust.** A folder you add starts restricted: Claude works there with your own settings only, and JARVIS reads the folder but runs nothing from it - no hooks, MCP servers, scripts, builds, tests, apps or Git - until you trust it.
- 🩺 **Health that knows your projects.** A missing tool is a warning only when a project here needs it.
- ✍️ **Your own names and warnings.** Give a project your name for it, a warning shown before it runs, and the case-code prefix your commit messages use.
- 🔐 **Source Control in any workspace.** Without a policy file of its own, a workspace gets JARVIS's built-in rules: everyday work runs, and anything that can throw work away asks first.
- 👋 **A fuller walk-through** for new installs, and Agents, ClickUp and Git AI that assume nothing about you or your projects.

**Upgrading from 1.x:** your workspace folder carries over, already trusted. The project names and warnings 1.x had built in are gone - set your own with a project's **Settings** button on the Projects page. ClickUp asks once whose tasks to show.

**Technical**

- New: `workspaces.mjs` (config v2 with several workspaces; the old config is kept as `config.before-v2.json`), `project-discovery.mjs` (asynchronous, bounded, read-only), `project-index.mjs`, `project-providers.mjs` (needs and actions per ecosystem), `task-runner.mjs`, `capabilities.mjs` (the developer tools on this PC), `defaults/git-risk-policy.json` and `renderer/projects-view.js`.
- Retired: `FLUTTER_APPS`, `WEB_APPS`, `NICKNAMES` and the default workspace path. Devices, Web apps, Dart analysis, Source Control and Files read the discovered projects.
- Hardening: every window refuses to navigate away from JARVIS's own pages; `NoDefaultCurrentDirectoryInExePath` is set for JARVIS and everything it starts, and `cmd.exe` and `dotnet` start by full path; file reads are checked through real paths, so a link or junction cannot lead outside the workspace; a crafted project file cannot stall a scan.
- Tests: six new suites; `npm test` runs 23, all passing.

</details>

<details>
<summary><b>Earlier: v1.12.0</b></summary>

**Simplified**

- 🧹 **/deleteapp, from your phone.** Send it to your JARVIS bot and it stops JARVIS, removes the installed copy through its own uninstaller, and clears any old installer builds left in `dist-installer` on this dev PC - so a fresh download from GitHub Releases has nothing old in the way. Nothing reopens on its own; that's what the **Update** button is for.
- 🧽 **`npm run clean`, at the desk.** The same cleanup as a one-off script (`scripts/clean-and-run.ps1`), with an optional `-Run <path>` to launch an installer once everything old is gone.

**Technical**

- `src/updates.mjs`: `deleteAppCommand({ waitPid, installDir, distDir, logPath })` builds the PowerShell - waits for the given pid, stops any stray `JARVIS` processes, runs `Uninstall JARVIS.exe /S`, removes the install folder, and (only when `distDir` is given, i.e. a dev checkout) clears `JARVIS-Setup-*.exe*` and `win-unpacked`. It shares `launchUpdater` (WMI-started, outlives JARVIS) with the update flow, but relaunches nothing.
- `src/main.mjs`: `remote`'s `deleteApp` builds that script with this process's pid and `APP_ROOT/dist-installer` (unpacked only), refuses during a screenshot run, and quits JARVIS once Windows confirms the cleanup script started.
- `src/remote.mjs`: `/deleteapp` - refused while JARVIS is busy (like `/new` and `/switch`), confirmed in chat before anything runs, and plain if an older host has no `deleteApp` to call.
- `scripts/clean-and-run.ps1` (`npm run clean`): the same steps, run by hand - safe to re-run, everything no-ops once there's nothing left to do.
- `scripts/updates-test.mjs`: 15 new checks (96 in all) on the generated script and the wiring into `main.mjs` and `remote.mjs`.

</details>

<details>
<summary><b>Earlier: v1.11.0</b></summary>

**Simplified**

- 🐞 **See why a run went wrong.** The Devices page has a new **Dart analysis** panel - the same list of errors and warnings your IDE shows, grouped by file. Pick an app, press **Analyse**, and click any problem to open that file at that line in VS Code.
- ⚡ **It runs by itself when a build fails.** If Run stops before the app ever starts, JARVIS checks that app straight away and tells you how many errors there are.
- 🔀 **It spots a merge conflict for you.** A file left with git's `<<<<<<<` markers gives a dozen baffling errors; the panel says so in one line and takes you to it.
- 🧹 **Readable by default.** Errors first, hints hidden until you ask (there are usually hundreds), a filter box, and an **Ask JARVIS to fix** button that puts the errors in the chat box for you to send.

**Technical**

- New `src/analysis.mjs`: `analyzeApp` runs `dart analyze --format=machine` in the app's folder (single flight per app, 5 minute limit, `cancelAnalysis`), `parseMachine` reads the `SEVERITY|TYPE|CODE|file|line|col|len|message` lines with their `\|` escapes from stdout or stderr, and `findConflicts` looks for conflict markers in files that have errors. Reading only: no `dart fix`, no write. At most 3000 problems go to the window; the counts stay complete.
- `src/main.mjs`: `jarvis:analyze` / `jarvis:analyzeCancel`, stopped on quit. `src/devices.mjs`: the exit event of a `flutter run` now carries `failed` (it ended by itself, not by Stop) and `built` (the app had started).
- New `src/renderer/problems.js` and the `devProblems` section: app chips with an error badge, severity toggles, grouped rows that call `openInCode(file, line)`, and the auto-run on `failed && !built`. `JARVIS_DEMO=problems` draws a made-up result for screenshots.
- `scripts/analysis-test.mjs`: 37 checks with a stand-in `dart`. It caught one real fault before release (a start that failed at once left the app marked as busy). A real run on a Flutter app returned its list and found a real merge conflict.

</details>

<details>
<summary><b>Earlier: v1.10.0</b></summary>

**Simplified**

- 🔄 **A popped-out phone now follows a cable swap.** Unplug phone A and plug in phone B, and the phone window used to sit forever on "device not found". It now notices on its own: one new, unclaimed phone is picked up automatically; the same phone coming back just resumes; and if more than one new phone shows up, it asks which rather than guessing.
- 🔀 **Switch phones on purpose, any time.** A new button beside the phone's name opens the same picker - no need to unplug anything first.

**Technical**

- `src/renderer/phone.js`: `serial` is now `let`, read live everywhere rather than fixed from the URL for the window's life. `watchForReplacement()` polls `devices()` only while the screen is down; `adopt(d)` calls the new `phoneWindow(old, 'rebind', new)` IPC, then updates the model, serial, label and title in place and restarts the screen. `offerChoice()` renders one button per candidate when more than one is possible, reusing `setOverlay`'s new multi-action form. The header's new swap icon (`core.js`) opens the same picker on demand.
- `src/main.mjs`: the `jarvis:phoneWindow` IPC gains a `rebind` action that moves the window's `phoneWindows` map entry to the new serial (refusing a phone that already has its own window), tells the Devices view both cards' new state, and leaves the old slot free. `pw.currentSerial` is now the one source of truth for which phone a window shows - `wireDocking`, the close handler and the window-error logger all read it live, so docking and video keep following the right phone after a switch instead of the serial the window opened with.
- `scripts/phone-switch-test.mjs`: 18 checks driving the real renderer (auto-adopt, the same phone returning, an ambiguous choice, a phone already popped elsewhere being left alone, the manual switch button) plus source checks on the main-process bookkeeping.

</details>

<details>
<summary><b>Earlier: v1.9.0</b></summary>

**Simplified**

- ⬆️ **Updates come to you.** When a new JARVIS is built on this PC, a blue **Update to v…** button appears at the top of the window by itself. Press it, press **Update now**, and JARVIS closes, installs and opens again. No trip to GitHub, no download, no sign-in.
- 🔔 **You are told when one is ready.** A new build also shows up in the bell, and the button waits for you if JARVIS was closed when it arrived. Nothing installs until you press it.

**Technical**

- `updates.mjs`: a second update source beside the GitHub release. `writeDelivery` leaves `update-ready.json` in the data folder (version, installer path, size, SHA-256, notes) through a temp file and a rename. `readDelivery` accepts only an existing `JARVIS-Setup-<version>.exe` of the stated size with a SHA-256. `jarvisStatus` and `jarvisUpdate` take the newer delivery first and then never call GitHub. `copyInstaller` copies to the temp folder while hashing, and shares `saveChecked` with `downloadInstaller`; the checked copy is what the unchanged updater runs.
- `main.mjs`: `watchDeliveries` watches the data folder for that one file and sends `updates:ready`; `ipcMain.handle('updates:ready')` answers at start. Only the packaged app deletes a note whose version is running. A screenshot run (`JARVIS_CAPTURE`) can no longer start a JARVIS update.
- `preload.cjs`: `updateReady`, `onUpdateReady`. `renderer/updates.js` and `index.html`: the `updReadyBtn` pill, a bell notification, and one press through to the existing question, which now says when a running task would be cut off.
- `scripts/deliver-update.mjs` (`npm run deliver`): writes the note for `dist-installer\JARVIS-Setup-<version>.exe` with this version's README notes, and refuses an installer older than the source.
- `scripts/updates-test.mjs`: 27 new checks (81 in all). Two capture runs against a throwaway data folder showed the pill appearing while JARVIS ran, and the question after one press. The install itself was not run from a delivery; it is the same updater script as before.
- A JARVIS older than v1.9.0 does not read the note, so the first move to v1.9.0 is the installer run by hand (or a GitHub release).

</details>

<details>
<summary><b>Earlier: v1.8.0</b></summary>

**Simplified**

- 🧑‍🏭 **Three new specialists.** Josh (ARCHIVIST) looks after git and GitHub Desktop, Tony (TASKMASTER) looks after ClickUp, and Eric (SCRIBE) looks after your Notes. They sit on the Agent floor like the others, each wearing the icon of the page it works on, in a new "Git, tasks & notes" group.
- 📝 **JARVIS can use your notes.** Ask in chat to "note this down" or "what did I note about the wheel?" and SCRIBE reads or writes the same notes the Notes page shows.

**Technical**

- `renderer/crew.js`: `MINION_NAMES` gains `archivist: 'Josh'`, `taskmaster: 'Tony'` and `scribe: 'Eric'`. `renderer/dashboard.js`: `AGENT_ICON` maps them to `github`, `clickup` and `edit`, the icons of the GitHub Desktop, Clickup and Notes pages.
- `renderer/pages.js`: a `ROSTER` group can hold several icons (space-separated). The new group "Git, tasks & notes" sits before Support crew.
- The agents themselves are workspace files, not app code: `.claude/agents/github-desktop.md`, `clickup.md` and `notes.md`. ARCHIVIST has no Edit or Write tool and never reaches a remote. TASKMASTER writes to ClickUp only when the user asked. SCRIBE writes `notes.json` only through the workspace tool `.claude/tools/notes.py`, which keeps `NoteStore`'s shape and limits, writes through a temp file and a rename, and refuses to write when the file cannot be parsed.
- `npm test` passes in full. Capture runs (`JARVIS_CAPTURE`, `JARVIS_VIEW=agents`) confirmed the three cards, the group, the bench and three working desks. `NoteStore` read back a file the tool wrote, and the tool read back one `NoteStore` wrote.

</details>

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
| 💬 **Chat** | Talk to Claude Code. Attach images and files, pick the model and effort level, and approve each action |
| 🧭 **Projects** | Every project JARVIS found in your workspace: type, needs, Git state, and the actions its own files support |
| 🐙 **GitHub Desktop** | Changes, commits, Undo, stashes, branches, push and pull, plus pull requests and checks from GitHub (read-only) |
| 📲 **Devices** | Live Android phone screens with `flutter run`, ASP.NET sites and APIs with `dotnet watch`, and build diagnostics for both - Dart analysis and .NET build errors/warnings |
| 🧑‍🏭 **Agents** | Your Claude Code subagents and the built-in ones, working as minions on the Agent floor; build your own from a blank page or a starter, or let JARVIS suggest a team for this workspace |
| 📂 **Files** | Read any text file in the workspace, and double-click to open it in VS Code |
| 📝 **Notes** | Write something down, save it, and send it to your Telegram |
| 📓 **Knowledge Notes** | A second, separate Markdown note store with tags, favorites, Trash and full Version History |
| ☁️ **Google Drive backup** | Manual backup and restore of Knowledge Notes to your own Google Drive, with a preview before any restore |
| ✅ **ClickUp** | Your ClickUp tasks, synced through Claude Code's ClickUp connection and grouped by sprint (optional) |
| ↩️ **Undo** | Undo every file change made since any message, in one click |
| 🩺 **Health** | What is in order and what needs setting up, judged against the projects you actually have |
| ⬆️ **Updates** | One press in the app: from a GitHub release, or straight from a build made on this PC |

---

## 📷 Screenshots

> No screenshots are published in this repository yet. This section is a placeholder for
> future images of Chat, Projects, Devices, Knowledge Notes and the Google Drive panel.

---

## 🧰 What you need

- **Windows 10 or 11**, 64-bit.
- **A Claude account that can use Claude Code.** Claude Code itself comes inside JARVIS; you sign in from the walk-through or **Settings → Account**.
- **Git for Windows**, for Source Control.
- Only for the projects you have: the **Flutter SDK** and Android **platform-tools** (`adb`) to run apps on a phone, the **.NET SDK**, **Node.js**, **Python**, or a **JDK** for Gradle and Maven. **Health** lists what is missing - and says nothing about a tool none of your projects need.

---

## 🚀 Getting started

1. Download `JARVIS-Setup-<version>.exe` from this repository's **Releases** page and run it. It installs for you alone, with no administrator rights. The installer is not code-signed yet, so Windows SmartScreen may warn the first time: **More info → Run anyway**.
2. The walk-through opens: sign in to Claude, **choose your workspace** (the folder that holds your projects), see what JARVIS found in it and what this PC has, then the optional extras. Every step can be skipped and done later.
3. Decide whether to **trust** the workspace (below). JARVIS asks when you add one.
4. Open **Knowledge Notes** in the sidebar to start a Markdown note, or **Import from Notes** to bring in what you already wrote on the plain Notes page.
5. To back Knowledge Notes up to your own Google Drive, open the Drive panel inside Knowledge Notes and follow [Google Drive backup & restore](#google-drive-backup--restore) below - entirely optional, and off until you connect it yourself.

---

## 🗂️ Workspaces and projects

A **workspace** is a folder: one project, or many side by side. Keep as many as you like in **Settings → Workspaces** - add, rename, remove (nothing on disk is deleted) and switch. Switching restarts JARVIS in the new folder, because the session, file index and Git views all belong to the folder they started in. JARVIS asks first, and says what would stop: a chat turn, a phone run, a web app, a build.

**Discovery** reads the workspace to find its projects. It looks at folder listings and a few small marker files, and nothing else: no project code runs, nothing is installed, no file is written, and it does not even run `git`. It goes up to 6 folders deep, skips dependency and build folders (`node_modules`, `bin`, `obj`, `build`, `.dart_tool`, `.gradle`, virtual environments…), never follows a link or junction out of the workspace, and stops at 20,000 folders. Results are kept for a minute; **Look again** on the Projects page reads the folder afresh.

**Nested projects** stay together: a Flutter app's `android/` and `ios/` folders show as its platforms, not as separate apps, and packages, modules and test projects inside another project sit under it.

**Your own settings per project** (the **Settings** button on a project): the name JARVIS shows, a **warning** shown before anything runs (for example "Uses the live database"), and the **case-code prefix** your commit messages carry, so a suggested commit message keeps your ticket codes. All optional; nothing is built in.

| Ecosystem | Found by | What JARVIS offers |
|---|---|---|
| **Git** | a `.git` folder | Source Control (the GitHub Desktop page); GitHub pull requests and workflow runs, read-only |
| **Flutter** | `pubspec.yaml` using Flutter | **Run on a phone** (Devices: live screen, hot reload), **Analyse**, **Test** (`flutter test`) when there is a `test` folder |
| **Dart** | `pubspec.yaml` | **Analyse** (`dart analyze`), **Test** (`dart test`) |
| **.NET** | `*.csproj`, `*.sln` | **Run** (`dotnet watch run`) for ASP.NET sites and APIs, **Build** (`dotnet build`), **Test** (`dotnet test`) for test projects and solutions |
| **Node** | `package.json` | Only scripts the project defines, from `dev`, `start`, `serve`, `test`, `build`, `lint`, `typecheck`, `check` - through its own package manager (npm, pnpm, yarn or bun, from its lock file) |
| **Python** | `pyproject.toml`, `requirements.txt`, `setup.py` | **Test** (`python -m pytest`), only when pytest is already in the project's own `.venv`, `venv` or `env`. Nothing is installed or created |
| **Gradle** | `build.gradle(.kts)`, `settings.gradle(.kts)`, `gradlew` | **Build** (`assemble`) and **Test**, through the project's own wrapper first |
| **Maven** | `pom.xml` | **Build** (`compile`) and **Test**, wrapper first. Never `install` or `deploy` |

An action this PC cannot run yet still shows, with the reason ("The .NET SDK is not installed on this PC"). Builds never publish or deploy. Anything else - a migration, a release, a one-off command - is a message to JARVIS in the chat, where it is approved like any other action.

---

## 🧑‍🏭 Custom agents

An agent is a Claude Code subagent - one file, with a name, a description and instructions - that JARVIS can hand a task to. The Agents page manages the same files Claude Code itself reads; there is no separate agent system of JARVIS's own.

- **Create, edit, duplicate, switch off, delete.** **New agent** opens a form: name, description, the model it uses, which tools it may use, and its instructions, with a **Preview the file** tab showing exactly what would be written before anything is. A card's drawer lets you **Edit** it, **Duplicate** it as a starting point for another, **Switch off** (kept on disk, just not loaded - switch it back on any time) or **Delete** (a copy is kept first, in case it was a mistake).
- **Six starters.** Code Reviewer, Debugger, Test Engineer, Security Reviewer, Performance Analyst and Documentation Specialist - each a complete, working agent you can use as-is or change. Every one starts able only to read and search; nothing that edits files or runs commands is switched on without you choosing it.
- **Build my team.** Looks at the projects already found in your workspace and suggests a small team by rule - a Flutter project gets a developer, a widget tester and a performance reviewer; a workspace with more than one kind of project gets a few that work across all of it, with a developer for each one offered unticked. Nothing is sent to Claude and nothing is spent working this out; you tick, rename or customize each suggestion, see the exact files, and only then press **Create**.
- **Workspace agents vs. your own.** An agent lives in this workspace's `.claude/agents` (used here only) or in your own Claude folder (`~/.claude/agents`, used in every workspace, and by Claude Code in the terminal and VS Code too). If both have an agent of the same name, the workspace's own is what runs here.
- **Permissions and backups.** Nothing is ever overwritten - an edit has to name the exact version it started from, so a change made elsewhere is never silently lost. Writing to your own Claude folder, or giving an agent a tool that changes files or runs commands, always asks first. A restricted workspace's agents are listed but never loaded or changed. Every edited or deleted agent's earlier version is kept, so nothing made here is a one-way trip.
- **Reload to use it.** Claude Code reads its agent folders when a chat starts, not while one is already running, so a new or changed agent shows as "reload to use" until you press **Reload session** - which restarts the chat in the same conversation, not a new one.

---

## 📓 Knowledge Notes

A second, separate Markdown note store from the plain Notes page above - one file per note, with tags, favorites, a two-pane editor (write on the left, a live Markdown preview on the right), Trash with Restore, and full **Version History**.

- **Version History.** Every save that meaningfully changes a note's title, body, tags, favorite or folder keeps the version it replaces - browsable, compared side-by-side with the current version, and restorable at any time. A restore is itself reversible: the version it replaces is kept too. Nothing here is ever pruned automatically, so history only grows; there is no retention limit yet.
- **Conflict-safe saves.** A save names the exact version it started from; if the note changed elsewhere since you opened it, the save is refused rather than silently overwriting - with an explicit "Overwrite anyway" that backs up what it would replace first.
- **Import from Notes**, with a preview of exactly what would be added before you confirm anything.
- Entirely separate from the plain Notes page and its `notes.json` file - nothing here touches that store, and nothing in it touches Knowledge Notes.

---

## ☁️ Google Drive backup & restore

Knowledge Notes can be backed up to, and restored from, your own Google Drive - **manually only**. There is no automatic sync, no scheduled backup, and no background upload; a backup happens only when you press **Back Up Now**, and a restore only after you explicitly confirm it.

**What it backs up:** only your Knowledge Notes, their Trash, and their Version History. It does **not** back up the plain Notes page, your JARVIS settings, your workspace, your agents, or anything else JARVIS stores.

**Connecting:**
1. In Google Cloud Console, create an OAuth 2.0 Client ID of type **Desktop app**, and paste its Client ID (and secret, if given one) into Knowledge Notes' Drive panel.
2. Press **Connect Google Drive** - your system browser opens to Google's own sign-in and consent screen, requesting only the `drive.file` scope (JARVIS can only ever see files and folders it creates itself through this connection - never your existing Drive content).
3. Once signed in, the panel shows **Connected**, and the backup/restore controls appear.

**Backing up and restoring:**
- **Back Up Now** uploads every Knowledge Note, Trash entry and Version History snapshot, verifying each one by hashing it after upload - a backup is only ever marked complete once every file has been confirmed.
- **Backup History** lists every backup made, distinguishing a complete one from an interrupted or corrupted one; only a complete, re-verified backup can be restored.
- **Restore** first shows a read-only preview of exactly what would be added, replaced or left unchanged, then requires a second, explicit confirmation before anything is written locally. Whatever a restore would overwrite is itself backed up first, so a restore is never a one-way trip.

**Known limits:**
- The Google OAuth consent screen for this project is currently in Google's **Testing** publishing status; a test user's refresh token expires after about seven days, after which JARVIS will ask you to reconnect.
- A restore is verified and protected file-by-file, but is not one single all-or-nothing transaction across the whole backup - if an individual file fails partway through, the files already restored stay restored, and the failure is reported plainly rather than silently.
- Backups and Version History are both kept indefinitely for now - there is no automatic cleanup of old ones.

---

## 🛡️ Safety

- **You approve what Claude does.** Every action goes through Claude Code's permission prompt in the mode you pick (Ask, Accept edits, Plan or Auto). There is deliberately no "bypass permissions".
- **Workspace trust.** A workspace you have not trusted runs Claude with your own user settings only - its `CLAUDE.md`, `.claude` hooks, MCP servers, agents and permission rules are not loaded - and JARVIS reads it but runs nothing from it: no scripts, builds, tests, apps, Dart analysis or Git (a repository's own `.git/config` can name programs Git runs by itself). Trust it in **Settings → Workspaces** once it is your code or you have read it. The folder JARVIS 1.x was using is trusted when you upgrade, because it already ran there.
- **Git safety rules.** Source Control classifies every Git operation before it runs. A workspace's own `.claude/jarvis/git-risk-policy.json` always wins; without one, JARVIS's built-in rules apply - staging, committing, branching and an ordinary push run, while discarding, a hard reset, a forced push, deleting a branch or tag, or rewriting history asks first, and anything unknown is treated as destructive. A policy file that exists but cannot be read makes every change ask. **Discard** copies your changes to the Recycle Bin before it removes them.
- **Actions run only when you press them.** Each is a fixed command, shown before it runs, with your warning first and a Stop button; nothing from a project's files reaches a command line unchecked. Everything JARVIS started stops when it quits or switches workspace.
- **Programs are found safely.** Windows is told never to look for a program in the folder a command runs in - for JARVIS itself and for everything it starts - and `cmd.exe` and .NET start by their full paths, so a file planted in a project cannot stand in for `cmd`, `git`, `npm`, `flutter` or `dotnet`.
- **Reading stays in the workspace.** Files, documents and **Open in VS Code** only reach paths inside it, checked through the real path, so a link cannot lead elsewhere. Without VS Code, only plain documents and pictures open in their usual app; anything else - a script, a program - is shown in Explorer, never run.
- **Your settings file is never overwritten.** If `config.json` cannot be read (a hand edit gone wrong), JARVIS runs on its defaults, saves nothing, and Health shows the file to fix.
- **A locked-down window.** No Node.js in the page, context isolation, a sandbox, a strict content security policy, and every window refuses to navigate anywhere but JARVIS's own pages. Web links open in your browser.
- **Secrets stay put.** The Telegram bot token and the GitHub sign-in never go back to the window, and secrets are scrubbed from logs, the activity export and error messages. The phone web app's access code is shown only when you press **Show the access code**.
- **Google Drive credentials are encrypted at rest**, through Windows' own per-user encryption (Electron's `safeStorage`) - the same mechanism already protecting the GitHub and Telegram tokens, with no plaintext fallback for Drive. Your Drive connection is scoped to `drive.file`, so JARVIS can only ever see files and folders it created itself - never your existing Drive content - and nothing is uploaded or restored without you pressing the button for it.

---

## 📱 From your phone

> Set up once in **Settings → Phone alerts**: create a bot with @BotFather, press **Check token**, then press **Find my chat**. Remote control is off until you switch it on.

| Send | You get |
|---|---|
| A message | It runs on the PC, just as if you typed it there |
| 📷 A photo or 📎 a file | It's saved in `Downloads\JARVIS from phone` and shown in the PC chat |
| 🎙 A voice note | It's transcribed on the PC (nothing goes to the cloud), then run |
| `/status` `/stop` `/new` | What JARVIS is doing, stop the current turn, start fresh |
| `/sessions` `/switch` | Pick up an earlier conversation |
| `/screen` | A screenshot of the PC |
| `/diff` | What has changed in each repository |
| `/brief` | The morning brief (sent automatically on weekdays at 08:00) |
| `/deleteapp` | Uninstall JARVIS from this PC, after you confirm, ready for a fresh install |

**PC → phone:** with mirroring on, what you type and attach on the PC shows up in Telegram too.

👋 **Hello on startup:** when JARVIS opens on the PC, your phone gets a "Good morning / afternoon / evening" message, so you know it's online.

💤 **Power down / Wake up:** say "Power down" (phone or PC) and JARVIS goes to sleep in the tray. Say "Wake up" in Telegram, or click the tray icon, to bring it back. Quitting from the tray shuts it down fully, and Telegram tells you it's offline.

🖥️ **More than one PC:** give each PC its own bot and a name (Home-PC, Work-PC…), then put all the bots in one Telegram group with you. "Wake up" there wakes the only PC that's asleep, or asks which one with a button per PC. Add a name to pick one directly: "Wake up Work-PC".

🔒 Only *your* Telegram account is obeyed. Messages sent while JARVIS was off never run later, and every approval still needs your tap.

---

## ⌨️ Shortcuts

| Keys | Action |
|---|---|
| `Ctrl` + `1`…`6` | Chat, Overview, GitHub Desktop, Notes, Files, Projects |
| `Ctrl` + `N` | New session |
| `Ctrl` + `K` | Search everything |
| `Ctrl` + `,` | Settings |
| `Esc` | Stop JARVIS |

---

## ⚠️ Good to know

- **Windows only**, and phones are **Android** (through `adb`).
- **Updates from GitHub** need a GitHub sign-in that can read this repository (**Settings → Updates**). Without one, install a newer version by hand, or deliver a local build with `npm run deliver`.
- **Source Control** lists the repositories at the top of the workspace and up to two folders down; the Projects page shows deeper ones too.
- **ClickUp** works through Claude Code's own ClickUp connection, so connect ClickUp in Claude Code first. JARVIS only reads; nothing is written back.
- **Voice** runs on this PC; the speech model (about 250 MB) downloads the first time you use it.
- **Google Drive backup is manual only** - there is no scheduled or automatic backup, and no two-way sync.
- **Knowledge Notes' Version History, and Drive backups, are both kept indefinitely** - nothing is pruned automatically yet.
- **A Drive restore is not one atomic transaction** across the whole backup - each file is individually verified and protected, but a failure partway through leaves the files already restored in place rather than rolling everything back.
- **The Google OAuth consent screen is in Testing status** - a signed-in test account's refresh token expires after about seven days, after which reconnecting is needed.

---

## 🔧 Build from source

Prerequisites: [Node.js](https://nodejs.org/) and npm, on Windows (this project targets Windows only - see **What you need** above).

```powershell
npm install        # first time
npm start          # run from source
npm test           # every test suite (no network needed)
npm run pack       # build -> dist\win-unpacked\JARVIS.exe
npm run dist       # installer -> dist-installer\JARVIS-Setup-<version>.exe
npm run deliver    # offer that installer to the JARVIS installed on this PC
```

> 💡 From a VS Code terminal, first run `Remove-Item Env:ELECTRON_RUN_AS_NODE`.

---

## 📄 License

This repository does not currently include a `LICENSE` file, and no open-source license has
been published for this project. All rights are reserved by the author unless a license is
added in the future.

---

## 🔗 Releases

Every published build is on the [**Releases page**](https://github.com/Silentt9879/JarvisApp/releases) - **v2.4.0 is the current release**. See [What's new in v2.4.0](#whats-new-in-v240) above for a summary, or `JARVIS-Setup-2.4.0.exe`'s own release notes for the exact text published with it.

---

<div align="center">

📖 **[Full technical details →](docs/DETAILS.md)**

<sub>Built on the Claude Agent SDK · Electron · Telegram Bot API</sub>

</div>
