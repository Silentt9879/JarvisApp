// The only bridge between the window and the app. The page gets these few
// functions - no Node, no file system, no shell.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('jarvis', {
  info: () => ipcRenderer.invoke('jarvis:info'),
  claudeVersion: () => ipcRenderer.invoke('jarvis:claudeVersion'),
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
  flutterRun: (serial, app) => ipcRenderer.invoke('jarvis:flutterRun', serial, app),
  flutterCmd: (serial, cmd) => ipcRenderer.invoke('jarvis:flutterCmd', serial, cmd),
  flutterLog: (serial) => ipcRenderer.invoke('jarvis:flutterLog', serial),
  // Phone alerts: a notification on your own phone when work stops, over USB or Wi-Fi.
  phoneState: () => ipcRenderer.invoke('jarvis:phoneState'),
  phoneSet: (patch) => ipcRenderer.invoke('jarvis:phoneSet', patch),
  phoneWifi: (serial) => ipcRenderer.invoke('jarvis:phoneWifi', serial),
  phoneTest: (serial) => ipcRenderer.invoke('jarvis:phoneTest', serial),
  // ASP.NET sites and APIs: dotnet watch run, shown in the window.
  webApps: () => ipcRenderer.invoke('jarvis:webApps'),
  webRun: (key, watch) => ipcRenderer.invoke('jarvis:webRun', key, watch),
  webStop: (key) => ipcRenderer.invoke('jarvis:webStop', key),
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
