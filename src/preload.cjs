// The only bridge between the window and the app. The page gets these few
// functions - no Node, no file system, no shell.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('jarvis', {
  info: () => ipcRenderer.invoke('jarvis:info'),
  // The window's caption buttons are drawn by the system; this tells it the theme in use.
  titleBar: (theme) => ipcRenderer.invoke('jarvis:titleBar', theme),
  // The workspace folder: pick one (a dialog, nothing saved), then switch to it (saved,
  // and JARVIS restarts into it).
  pickWorkspace: () => ipcRenderer.invoke('jarvis:pickWorkspace'),
  setWorkspace: (dir) => ipcRenderer.invoke('jarvis:setWorkspace', dir),
  // Workspaces: the list, and each change by id. Selecting or removing the active one
  // restarts JARVIS - nothing is switched in place. Removing never touches the folder.
  workspaces: () => ipcRenderer.invoke('workspaces:list'),
  workspaceAdd: (dir, name) => ipcRenderer.invoke('workspaces:add', dir, name),
  workspaceRename: (id, name) => ipcRenderer.invoke('workspaces:rename', id, name),
  workspaceSelect: (id, opts) => ipcRenderer.invoke('workspaces:select', id, opts && typeof opts.trust === 'boolean' ? { trust: opts.trust } : {}),
  // Trust: a trusted folder's .claude hooks, MCP servers and settings load; a restricted one's do not.
  workspaceTrust: (id, trusted) => ipcRenderer.invoke('workspaces:trust', id, trusted === true),
  workspaceRemove: (id) => ipcRenderer.invoke('workspaces:remove', id),
  workspaceBusy: () => ipcRenderer.invoke('workspaces:busy'),
  // The active workspace's projects, found by looking only (refresh: look again), and the
  // person's own name or Run warning for one of them.
  projects: (refresh) => ipcRenderer.invoke('workspaces:projects', !!refresh),
  projectSettings: (relPath, patch) => ipcRenderer.invoke('workspaces:projectSettings', relPath, patch),
  // What can be done with a project. The window names a project and an action by id; the
  // command itself is worked out in the main process from the project's own files.
  projectActions: (key) => ipcRenderer.invoke('projects:actions', key),
  projectDetail: (key) => ipcRenderer.invoke('projects:detail', key),
  // The PC's developer tools: names and versions only. refresh: ask the tools afresh.
  capabilities: (refresh) => ipcRenderer.invoke('capabilities:list', refresh === true),
  // Set-up: what is in a workspace just added (by id), looked at before switching to it.
  workspacePreview: (id) => ipcRenderer.invoke('workspaces:preview', id),
  projectRun: (key, actionId) => ipcRenderer.invoke('projects:run', key, actionId),
  projectStop: (taskId) => ipcRenderer.invoke('projects:stop', taskId),
  projectTasks: () => ipcRenderer.invoke('projects:tasks'),
  projectTaskLog: (taskId) => ipcRenderer.invoke('projects:taskLog', taskId),
  // Start with Windows (to the tray). Packaged JARVIS.exe only.
  startup: () => ipcRenderer.invoke('jarvis:startup'),
  setStartup: (on) => ipcRenderer.invoke('jarvis:setStartup', !!on),
  claudeVersion: () => ipcRenderer.invoke('jarvis:claudeVersion'),
  // Settings > Updates: 'jarvis' | 'vscode' | 'claude'. Progress for the JARVIS download comes as events.
  updateCheck: (tool) => ipcRenderer.invoke('updates:check', tool),
  updateRun: (tool) => ipcRenderer.invoke('updates:run', tool),
  // An update built on this PC and handed over: { version, notes } or null. Asked once at start, then pushed.
  updateReady: () => ipcRenderer.invoke('updates:ready'),
  onUpdateReady: (cb) => {
    const handler = (_e, r) => cb(r);
    ipcRenderer.on('updates:ready', handler);
    return () => ipcRenderer.removeListener('updates:ready', handler);
  },
  // GitHub sign-in for JARVIS's private releases: saved token (encrypted), or Git's own sign-in.
  updateConnection: () => ipcRenderer.invoke('updates:connection'),
  updateConnect: (token) => ipcRenderer.invoke('updates:connect', token),
  updateDisconnect: () => ipcRenderer.invoke('updates:disconnect'),
  updateOpenGithub: () => ipcRenderer.invoke('updates:openGithub'),
  // The features of 2026-10-07. Each one asks the main process; the window cannot do more than these.
  welcome: () => ipcRenderer.invoke('app:welcome'),
  welcomeDone: (what) => ipcRenderer.invoke('app:welcomeDone', what),
  zoom: (factor) => ipcRenderer.invoke('ui:zoom', factor),
  // refresh: ask the developer tools afresh instead of using the last few minutes' answer.
  health: (refresh) => ipcRenderer.invoke('health:get', !!refresh),
  healthFix: (action) => ipcRenderer.invoke('health:fix', action),
  activity: (opts) => ipcRenderer.invoke('activity:list', opts || {}),
  activityExport: () => ipcRenderer.invoke('activity:export'),
  usage: () => ipcRenderer.invoke('usage:summary'),
  usageLimits: () => ipcRenderer.invoke('usage:limits'),
  refreshUsageLimits: () => ipcRenderer.invoke('usage:refreshLimits'),
  setBudget: (n) => ipcRenderer.invoke('usage:budget', n),
  prompts: () => ipcRenderer.invoke('prompts:list'),
  addPrompt: (p) => ipcRenderer.invoke('prompts:add', p),
  updatePrompt: (id, p) => ipcRenderer.invoke('prompts:update', id, p),
  removePrompt: (id) => ipcRenderer.invoke('prompts:remove', id),
  routines: () => ipcRenderer.invoke('routines:list'),
  addRoutine: (r) => ipcRenderer.invoke('routines:add', r),
  updateRoutine: (id, r) => ipcRenderer.invoke('routines:update', id, r),
  removeRoutine: (id) => ipcRenderer.invoke('routines:remove', id),
  runRoutine: (id) => ipcRenderer.invoke('routines:runNow', id),
  companion: () => ipcRenderer.invoke('companion:status'),
  setCompanion: (opts) => ipcRenderer.invoke('companion:set', opts),
  revealCompanionCode: () => ipcRenderer.invoke('companion:reveal'),
  newCompanionCode: () => ipcRenderer.invoke('companion:newCode'),
  transcribePcm: (samples) => ipcRenderer.invoke('voice:transcribe', samples),
  projectTemplates: () => ipcRenderer.invoke('project:templates'),
  createProject: (p) => ipcRenderer.invoke('project:create', p),
  openProject: (p) => ipcRenderer.invoke('project:open', p),
  newChatWindow: () => ipcRenderer.invoke('window:newChat'),
  onUpdateProgress: (cb) => {
    const handler = (_e, p) => cb(p);
    ipcRenderer.on('updates:progress', handler);
    return () => ipcRenderer.removeListener('updates:progress', handler);
  },
  start: (opts) => ipcRenderer.invoke('jarvis:start', opts),
  send: (payload) => ipcRenderer.invoke('jarvis:send', payload),
  interrupt: () => ipcRenderer.invoke('jarvis:interrupt'),
  respond: (id, decision) => ipcRenderer.invoke('jarvis:respond', id, decision),
  setModel: (model) => ipcRenderer.invoke('jarvis:setModel', model),
  setMode: (mode) => ipcRenderer.invoke('jarvis:setMode', mode),
  setEffort: (level) => ipcRenderer.invoke('jarvis:setEffort', level),
  setThinking: (on) => ipcRenderer.invoke('jarvis:setThinking', on),
  context: (detail) => ipcRenderer.invoke('jarvis:context', detail),
  sessions: () => ipcRenderer.invoke('jarvis:sessions'),
  history: (id) => ipcRenderer.invoke('jarvis:history', id),
  findSessions: (text) => ipcRenderer.invoke('jarvis:findSessions', text),
  deleteSession: (id) => ipcRenderer.invoke('jarvis:deleteSession', id),
  renameSession: (id, title) => ipcRenderer.invoke('jarvis:renameSession', id, title),
  rewind: (uuid, dryRun) => ipcRenderer.invoke('jarvis:rewind', uuid, dryRun),
  pickFiles: () => ipcRenderer.invoke('jarvis:pickFiles'),
  // Drag-and-drop: the path of a dropped file, so it can be named in the message.
  pathForFile: (file) => { try { return webUtils.getPathForFile(file) || null; } catch { return null; } },
  // A clicked attachment: a file from the phone opens; anything else is shown in Explorer.
  openAttachment: (p) => ipcRenderer.invoke('jarvis:openAttachment', p),
  stats: () => ipcRenderer.invoke('jarvis:stats'),
  online: () => ipcRenderer.invoke('jarvis:online'),
  savedEffort: (model) => ipcRenderer.invoke('jarvis:savedEffort', model),
  workspace: (force) => ipcRenderer.invoke('jarvis:workspace', !!force),
  roots: () => ipcRenderer.invoke('jarvis:roots'),
  docs: (root) => ipcRenderer.invoke('jarvis:docs', root),
  doc: (root, rel) => ipcRenderer.invoke('jarvis:doc', root, rel),
  openDoc: (root, rel) => ipcRenderer.invoke('jarvis:openDoc', root, rel),
  search: (q) => ipcRenderer.invoke('jarvis:search', q),
  openLogs: () => ipcRenderer.invoke('jarvis:openLogs'),
  // The workspace's files, read-only, and the jump into VS Code.
  files: (force) => ipcRenderer.invoke('jarvis:files', !!force),
  fileText: (rel) => ipcRenderer.invoke('jarvis:fileText', rel),
  openInCode: (rel, line) => ipcRenderer.invoke('jarvis:openInCode', rel, line),
  revealFile: (rel) => ipcRenderer.invoke('jarvis:revealFile', rel),
  onEvent: (cb) => {
    const handler = (_e, evt) => cb(evt);
    ipcRenderer.on('jarvis:event', handler);
    return () => ipcRenderer.removeListener('jarvis:event', handler);
  },
  // Phones: list, live screens (H.264 packets on their own channel), input, flutter run.
  devices: () => ipcRenderer.invoke('jarvis:devices'),
  // The workspace's Flutter apps (Run) and Dart/Flutter projects (analysis) - both discovered.
  flutterApps: () => ipcRenderer.invoke('jarvis:flutterApps'),
  dartProjects: () => ipcRenderer.invoke('jarvis:dartProjects'),
  // Dart analysis of one app: the problems list on the Devices page. Reading only.
  analyze: (app) => ipcRenderer.invoke('jarvis:analyze', app),
  analyzeCancel: (app) => ipcRenderer.invoke('jarvis:analyzeCancel', app),
  // .NET build diagnostics - the same idea, for sites, APIs, libraries and test projects.
  // Reading only: nothing here writes, but a real `dotnet build` does run.
  dotnetProjects: () => ipcRenderer.invoke('jarvis:dotnetProjects'),
  dotnetAnalyze: (key) => ipcRenderer.invoke('jarvis:dotnetAnalyze', key),
  dotnetAnalyzeCancel: (key) => ipcRenderer.invoke('jarvis:dotnetAnalyzeCancel', key),
  mirror: (serial, on) => ipcRenderer.invoke('jarvis:mirror', serial, !!on),
  resetVideo: (serial) => ipcRenderer.invoke('jarvis:resetVideo', serial),
  deviceInput: (serial, ev) => ipcRenderer.send('jarvis:deviceInput', serial, ev),
  // The right-click menu: cut | copy | paste on this page, exactly as the keyboard does.
  edit: (cmd) => ipcRenderer.invoke('jarvis:edit', cmd),
  // A phone in its own window: open | focus | close | dock.
  phoneWindow: (serial, action, extra) => ipcRenderer.invoke('jarvis:phoneWindow', serial, action, extra),
  flutterRun: (serial, app) => ipcRenderer.invoke('jarvis:flutterRun', serial, app),
  flutterCmd: (serial, cmd) => ipcRenderer.invoke('jarvis:flutterCmd', serial, cmd),
  flutterLog: (serial) => ipcRenderer.invoke('jarvis:flutterLog', serial),
  // Source Control: repository discovery and status, read-only, no model involved.
  gitRepos: () => ipcRenderer.invoke('jarvis:gitRepos'),
  gitDetail: (key) => ipcRenderer.invoke('jarvis:gitDetail', key),
  gitChanges: (key) => ipcRenderer.invoke('jarvis:gitChanges', key),
  gitDiff: (key, file, which) => ipcRenderer.invoke('jarvis:gitDiff', key, file, which),
  gitStage: (key, paths) => ipcRenderer.invoke('jarvis:gitStage', key, paths),
  gitUnstage: (key, paths) => ipcRenderer.invoke('jarvis:gitUnstage', key, paths),
  gitStageAll: (key) => ipcRenderer.invoke('jarvis:gitStageAll', key),
  gitUnstageAll: (key) => ipcRenderer.invoke('jarvis:gitUnstageAll', key),
  gitCommit: (key, message) => ipcRenderer.invoke('jarvis:gitCommit', key, message),
  gitLastCommit: (key) => ipcRenderer.invoke('jarvis:gitLastCommit', key),
  gitUndoCommit: (key, sha) => ipcRenderer.invoke('jarvis:gitUndoCommit', key, sha),
  gitDiscardAll: (key, confirmed, expect) => ipcRenderer.invoke('jarvis:gitDiscardAll', key, confirmed, expect),
  gitBranches: (key) => ipcRenderer.invoke('jarvis:gitBranches', key),
  gitCreateBranch: (key, name, opts) => ipcRenderer.invoke('jarvis:gitCreateBranch', key, name, opts),
  gitSwitchBranch: (key, name) => ipcRenderer.invoke('jarvis:gitSwitchBranch', key, name),
  gitRenameBranch: (key, from, to) => ipcRenderer.invoke('jarvis:gitRenameBranch', key, from, to),
  gitDeleteBranch: (key, name, opts) => ipcRenderer.invoke('jarvis:gitDeleteBranch', key, name, opts),
  // Remote: only ever called from an explicit user action in the Source Control header.
  gitFetch: (key) => ipcRenderer.invoke('jarvis:gitFetch', key),
  gitPull: (key) => ipcRenderer.invoke('jarvis:gitPull', key),
  gitPush: (key) => ipcRenderer.invoke('jarvis:gitPush', key),
  gitPublish: (key) => ipcRenderer.invoke('jarvis:gitPublish', key),
  gitRemoteCancel: (key) => ipcRenderer.invoke('jarvis:gitRemoteCancel', key),
  gitRemoteState: (key) => ipcRenderer.invoke('jarvis:gitRemoteState', key),
  gitHistory: (key, opts) => ipcRenderer.invoke('jarvis:gitHistory', key, opts),
  gitCommitDetail: (key, sha) => ipcRenderer.invoke('jarvis:gitCommitDetail', key, sha),
  gitCommitDiff: (key, sha, file) => ipcRenderer.invoke('jarvis:gitCommitDiff', key, sha, file),
  gitStashes: (key) => ipcRenderer.invoke('jarvis:gitStashes', key),
  gitStashCreate: (key, opts) => ipcRenderer.invoke('jarvis:gitStashCreate', key, opts),
  gitStashDetail: (key, sha) => ipcRenderer.invoke('jarvis:gitStashDetail', key, sha),
  gitStashDiff: (key, sha, file) => ipcRenderer.invoke('jarvis:gitStashDiff', key, sha, file),
  gitStashApply: (key, sha, pop) => ipcRenderer.invoke('jarvis:gitStashApply', key, sha, pop),
  gitStashDrop: (key, sha, confirmed) => ipcRenderer.invoke('jarvis:gitStashDrop', key, sha, confirmed),
  gitConflicts: (key) => ipcRenderer.invoke('jarvis:gitConflicts', key),
  gitConflictDetail: (key, file) => ipcRenderer.invoke('jarvis:gitConflictDetail', key, file),
  gitResolveConflict: (key, file, choice) => ipcRenderer.invoke('jarvis:gitResolveConflict', key, file, choice),
  gitAssistScope: (key, action, opts) => ipcRenderer.invoke('jarvis:gitAssistScope', key, action, opts),
  gitAssist: (key, action, opts, id) => ipcRenderer.invoke('jarvis:gitAssist', key, action, opts, id),
  gitAssistCancel: (id) => ipcRenderer.invoke('jarvis:gitAssistCancel', id),
  gitParseMessage: (text) => ipcRenderer.invoke('jarvis:gitParseMessage', text),
  // GitHub, read-only (Phase 9). Named operations taking a repository key - never a URL.
  ghInfo: (key) => ipcRenderer.invoke('jarvis:ghInfo', key),
  ghLink: (key, which, arg) => ipcRenderer.invoke('jarvis:ghLink', key, which, arg),
  ghOpen: (key, which, arg) => ipcRenderer.invoke('jarvis:ghOpen', key, which, arg),
  ghPulls: (key, opts) => ipcRenderer.invoke('jarvis:ghPulls', key, opts),
  ghPull: (key, number) => ipcRenderer.invoke('jarvis:ghPull', key, number),
  ghPullFiles: (key, number, page) => ipcRenderer.invoke('jarvis:ghPullFiles', key, number, page),
  ghPullPatch: (key, number, path) => ipcRenderer.invoke('jarvis:ghPullPatch', key, number, path),
  ghChecks: (key, sha) => ipcRenderer.invoke('jarvis:ghChecks', key, sha),
  ghRuns: (key, sha) => ipcRenderer.invoke('jarvis:ghRuns', key, sha),
  ghCancel: (key) => ipcRenderer.invoke('jarvis:ghCancel', key),
  // Phone alerts: a notification on your own phone when work stops, over USB or Wi-Fi.
  phoneState: () => ipcRenderer.invoke('jarvis:phoneState'),
  phoneSet: (patch) => ipcRenderer.invoke('jarvis:phoneSet', patch),
  phoneWifi: (serial) => ipcRenderer.invoke('jarvis:phoneWifi', serial),
  phoneTest: (serial) => ipcRenderer.invoke('jarvis:phoneTest', serial),
  // Telegram: the route that reaches the phone on mobile data. The token travels one way
  // only - the window sends it in and is never given it back.
  telegramVerify: (token) => ipcRenderer.invoke('jarvis:telegramVerify', token),
  telegramFindChat: () => ipcRenderer.invoke('jarvis:telegramFindChat'),
  telegramFindGroup: () => ipcRenderer.invoke('jarvis:telegramFindGroup'),
  // The Anthropic account: who is signed in, and the two buttons beside it. Claude Code
  // keeps the credentials; none of them comes through here.
  authStatus: () => ipcRenderer.invoke('jarvis:authStatus'),
  authLogin: () => ipcRenderer.invoke('jarvis:authLogin'),
  authLogout: () => ipcRenderer.invoke('jarvis:authLogout'),
  restartApp: () => ipcRenderer.invoke('jarvis:restartApp'),
  // Notes: written here, kept in notes.json, and sent to Telegram when asked. The window
  // is told only whether a Telegram chat is set up, never the token.
  notes: () => ipcRenderer.invoke('jarvis:notes'),
  noteSave: (note, opts) => ipcRenderer.invoke('jarvis:noteSave', note, opts),
  noteDelete: (id) => ipcRenderer.invoke('jarvis:noteDelete', id),
  // Knowledge: a second, separate note store - Markdown with front matter, one file per
  // note. Kept apart from Notes above; nothing here touches notes.json.
  knowledgeStatus: () => ipcRenderer.invoke('jarvis:knowledgeStatus'),
  knowledgeList: () => ipcRenderer.invoke('jarvis:knowledgeList'),
  knowledgeRead: (id) => ipcRenderer.invoke('jarvis:knowledgeRead', id),
  knowledgeSave: (input) => ipcRenderer.invoke('jarvis:knowledgeSave', input),
  knowledgeImportPreview: () => ipcRenderer.invoke('jarvis:knowledgeImportPreview'),
  knowledgeImport: () => ipcRenderer.invoke('jarvis:knowledgeImport'),
  knowledgeAutoMigrate: () => ipcRenderer.invoke('jarvis:knowledgeAutoMigrate'),
  knowledgeSendTelegram: (id) => ipcRenderer.invoke('jarvis:knowledgeSendTelegram', id),
  knowledgeTrash: () => ipcRenderer.invoke('jarvis:knowledgeTrash'),
  knowledgeTrashRead: (id) => ipcRenderer.invoke('jarvis:knowledgeTrashRead', id),
  knowledgeDelete: (id, baseRevision) => ipcRenderer.invoke('jarvis:knowledgeDelete', id, baseRevision),
  knowledgeRestore: (id) => ipcRenderer.invoke('jarvis:knowledgeRestore', id),
  knowledgeSnapshots: (id) => ipcRenderer.invoke('jarvis:knowledgeSnapshots', id),
  knowledgeSnapshotRead: (id, file) => ipcRenderer.invoke('jarvis:knowledgeSnapshotRead', id, file),
  knowledgeSnapshotRestore: (id, file, baseRevision) => ipcRenderer.invoke('jarvis:knowledgeSnapshotRestore', id, file, baseRevision),
  // Google Drive connection (Phase 24C): status/configure/connect/disconnect only - never a
  // token, never a backup or restore call (neither exists yet).
  driveStatus: () => ipcRenderer.invoke('jarvis:driveStatus'),
  driveConfigureClient: (clientId, clientSecret) => ipcRenderer.invoke('jarvis:driveConfigureClient', clientId, clientSecret),
  driveConnect: () => ipcRenderer.invoke('jarvis:driveConnect'),
  driveDisconnect: () => ipcRenderer.invoke('jarvis:driveDisconnect'),
  // Phase 2 (Decision 1): the app-owned, no-Client-ID path - available only once both of
  // drive-app-client.mjs's env gates are open on this build.
  driveAppOwnedStatus: () => ipcRenderer.invoke('jarvis:driveAppOwnedStatus'),
  driveConnectAppOwned: () => ipcRenderer.invoke('jarvis:driveConnectAppOwned'),
  driveBackupNow: () => ipcRenderer.invoke('jarvis:driveBackupNow'),
  driveBackupHistory: () => ipcRenderer.invoke('jarvis:driveBackupHistory'),
  driveRestorePreview: (backupId) => ipcRenderer.invoke('jarvis:driveRestorePreview', backupId),
  driveRestoreConfirm: (backupId, token) => ipcRenderer.invoke('jarvis:driveRestoreConfirm', backupId, token),
  driveOperationStatus: () => ipcRenderer.invoke('jarvis:driveOperationStatus'),
  // ASP.NET sites and APIs: dotnet watch run, shown in the window.
  webApps: () => ipcRenderer.invoke('jarvis:webApps'),
  webRun: (key, watch) => ipcRenderer.invoke('jarvis:webRun', key, watch),
  webStop: (key) => ipcRenderer.invoke('jarvis:webStop', key),
  webStopAll: () => ipcRenderer.invoke('jarvis:webStopAll'),
  webLog: (key) => ipcRenderer.invoke('jarvis:webLog', key),
  openUrl: (url) => ipcRenderer.invoke('jarvis:openUrl', url),
  // Custom agents: Claude Code subagent files in this workspace's .claude/agents and in your
  // own agents folder. An agent is named by its folder ('project' | 'user') and file - never a
  // path. Nothing is written without the approvals in `opts`, checked again in the main process.
  agentsList: () => ipcRenderer.invoke('agents:list'),
  agentRead: (scope, file) => ipcRenderer.invoke('agents:read', scope, file),
  agentOptions: () => ipcRenderer.invoke('agents:options'),
  agentPreview: (draft, opts) => ipcRenderer.invoke('agents:preview', draft, opts || {}),
  agentSave: (draft, opts) => ipcRenderer.invoke('agents:save', draft, opts || {}),
  agentsCreate: (drafts, opts) => ipcRenderer.invoke('agents:createMany', drafts, opts || {}),
  agentDelete: (ref, opts) => ipcRenderer.invoke('agents:delete', ref, opts || {}),
  agentSetEnabled: (ref, enabled, opts) => ipcRenderer.invoke('agents:setEnabled', ref, enabled === true, opts || {}),
  // Build My Team: proposals from project discovery, by rule - no model is asked, nothing is spent.
  agentsTeamPlan: (projectKey) => ipcRenderer.invoke('agents:teamPlan', projectKey || null),
  // Restart the chat in the same conversation so it reads the agents folders again. Idle only.
  agentsReload: () => ipcRenderer.invoke('agents:reload'),
  // Tasks: the ClickUp board (cached) and the workspace's own draft list.
  clickup: () => ipcRenderer.invoke('jarvis:clickup'),
  clickupSync: () => ipcRenderer.invoke('jarvis:clickupSync'),
  // Whose tasks: the person's own name as ClickUp knows it ('' clears it). Never guessed.
  clickupMember: (name) => ipcRenderer.invoke('jarvis:clickupMember', name),
  draftTasks: () => ipcRenderer.invoke('jarvis:draftTasks'),
  onVideo: (cb) => {
    const handler = (_e, p) => cb(p);
    ipcRenderer.on('jarvis:video', handler);
    return () => ipcRenderer.removeListener('jarvis:video', handler);
  },
});
