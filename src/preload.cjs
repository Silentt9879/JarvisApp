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
  // Start with Windows (to the tray). Packaged JARVIS.exe only.
  startup: () => ipcRenderer.invoke('jarvis:startup'),
  setStartup: (on) => ipcRenderer.invoke('jarvis:setStartup', !!on),
  claudeVersion: () => ipcRenderer.invoke('jarvis:claudeVersion'),
  // Settings > Updates: 'jarvis' | 'vscode' | 'claude'. Progress for the JARVIS download comes as events.
  updateCheck: (tool) => ipcRenderer.invoke('updates:check', tool),
  updateRun: (tool) => ipcRenderer.invoke('updates:run', tool),
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
  flutterApps: () => ipcRenderer.invoke('jarvis:flutterApps'),
  mirror: (serial, on) => ipcRenderer.invoke('jarvis:mirror', serial, !!on),
  resetVideo: (serial) => ipcRenderer.invoke('jarvis:resetVideo', serial),
  deviceInput: (serial, ev) => ipcRenderer.send('jarvis:deviceInput', serial, ev),
  // The right-click menu: cut | copy | paste on this page, exactly as the keyboard does.
  edit: (cmd) => ipcRenderer.invoke('jarvis:edit', cmd),
  // A phone in its own window: open | focus | close | dock.
  phoneWindow: (serial, action) => ipcRenderer.invoke('jarvis:phoneWindow', serial, action),
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
  // ASP.NET sites and APIs: dotnet watch run, shown in the window.
  webApps: () => ipcRenderer.invoke('jarvis:webApps'),
  webRun: (key, watch) => ipcRenderer.invoke('jarvis:webRun', key, watch),
  webStop: (key) => ipcRenderer.invoke('jarvis:webStop', key),
  webStopAll: () => ipcRenderer.invoke('jarvis:webStopAll'),
  webLog: (key) => ipcRenderer.invoke('jarvis:webLog', key),
  openUrl: (url) => ipcRenderer.invoke('jarvis:openUrl', url),
  // Tasks: the ClickUp board (cached) and the workspace's own draft list.
  clickup: () => ipcRenderer.invoke('jarvis:clickup'),
  clickupSync: () => ipcRenderer.invoke('jarvis:clickupSync'),
  draftTasks: () => ipcRenderer.invoke('jarvis:draftTasks'),
  onVideo: (cb) => {
    const handler = (_e, p) => cb(p);
    ipcRenderer.on('jarvis:video', handler);
    return () => ipcRenderer.removeListener('jarvis:video', handler);
  },
});
