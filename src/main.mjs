// JARVIS - Electron main process.
// Owns the window and the one live JarvisSession; the window talks to it only
// through the narrow IPC surface exposed in preload.cjs.
import { app, BrowserWindow, ipcMain, shell, Menu, dialog, net, nativeTheme, Tray, powerSaveBlocker, desktopCapturer, screen, safeStorage, Notification } from 'electron';
import { query } from '@anthropic-ai/claude-agent-sdk';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { JarvisSession, listRecent, loadHistory, findSessions, removeSession, renameStoredSession, isSessionId, IMAGE_TYPES, MAX_IMAGE_BYTES } from './session.mjs';
import { systemStats, gitStatus, knowledgeStatus, openIssues, handoffFocus, listDocs, readDoc, searchDocs, docRoots, savedEffort, setRepoNames, setGitTrust, GIT_RESTRICTED } from './workspace.mjs';
import { isSerial, listDevices, startMirror, stopMirror, resetVideo, sendInput, flutterRun, flutterCommandFor, flutterLog, shutdownDevices, runningFlutter } from './devices.mjs';
import { analyzeApp, cancelAnalysis, shutdownAnalysis, runningAnalysis } from './analysis.mjs';
import { analyzeDotnet, cancelDotnetAnalysis, shutdownDotnetAnalysis, runningDotnetAnalysis } from './dotnet-analysis.mjs';
import { listWebApps, webRun, webStop, webStopAll, webLog, shutdownWebApps, runningWebApps } from './webapps.mjs';
import { inSnapZone, dockWidth, dockLayout, followLayout, afterPhoneResize, stillDocked } from './dock.mjs';
import { readDraft, readClickUp, syncClickUp, cleanMember } from './tasks.mjs';
import { createGitHub } from './github.mjs';
import { listFiles, readWorkspaceFile, openInVsCode, hasVsCode, inside as insideDir, OPENABLE, reallyInside } from './files.mjs';
import { NoteStore, sendNote, telegramReady } from './notes.mjs';
import {
  newId as newKnowledgeId, knowledgePaths, listKnowledgeNotes, migrationComplete as knowledgeMigrationComplete,
  validateNoteInput, saveKnowledgeNote, noteRevision, previewMigration, migrateFromLegacy,
  listTrash, deleteKnowledgeNote, restoreKnowledgeNote,
  listSnapshots, readSnapshot, restoreSnapshot, historyStats, markKnowledgeNoteSent,
} from './knowledge.mjs';
import { authStatus, authLogout, startLogin } from './auth.mjs';
import { appOwnedLoginAvailable, appOwnedClientId } from './drive-app-client.mjs';
import { createPhoneWatcher, listPhones, enableWifi, connect as phoneConnect, postNotification } from './phone.mjs';
import os from 'node:os';
import { call as telegramCall, sendTelegram, verifyToken, discoverChat, discoverGroup, isToken, isChatId } from './telegram.mjs';
import { createRemote, greeting, isPowerDown, sleepNotice, offlineNotice } from './remote.mjs';
import { createPresence } from './presence.mjs';
import { diffReport, morningBrief } from './reports.mjs';
import { createDeployWatcher } from './deploys.mjs';
import { createTranscriber } from './voice.mjs';
import { assist, cancelAssist, parseCommitMessage } from './gitai.mjs';
// The window's modes (no bypassPermissions), shared with the chat's starting mode.
import { WINDOW_MODES } from './permission-mode.mjs';
import { createFeatures } from './features.mjs';
import { jarvisStatus, jarvisUpdate, vscodeStatus, vscodeUpdate, claudeStatus, claudeUpdate, resolveToken, saveToken, clearToken, savedTokenPath, tokenCanSeeJarvis, readDelivery, newerDelivery, clearDelivery, DELIVERY_FILE, deleteAppCommand, launchUpdater, JARVIS_INSTALL_EXE } from './updates.mjs';
import { resolveTelegramToken, telegramTokenField, migrateTelegramToken } from './phone-token.mjs';
import { createDriveConnection } from './drive-connection.mjs';
import { createGoogleDriveProvider } from './google-drive-provider.mjs';
import { createDriveBackupController } from './drive-backup-controller.mjs';
import { createDriveSyncController } from './drive-sync-controller.mjs';
import { searchNotes, notesForAiContext, buildContextPrompt } from './notes-search.mjs';
import { describeStoppedWork } from './active-work.mjs';
import { closePanes } from './pane-windows.mjs';
import { normalizeWorkspaces, addWorkspace, renameWorkspace, selectWorkspace, removeWorkspace, setWorkspaceTrust, setProjectSettings, projectSettings, workspacesForWindow, NO_WORKSPACE } from './workspaces.mjs';
import { readConfigFile, mergeConfigFile } from './config-file.mjs';
import { createProjectIndex } from './project-index.mjs';
import { projectDir, flutterApps, dartProjects, webAppsFrom, dotnetProjectsFrom, projectActions, actionForWindow, TYPE_LABEL, requirementsFor, capabilityRelevance, INSTALL_HINT } from './project-providers.mjs';
import { discoverProjects } from './project-discovery.mjs';
import { startTask, stopTask, taskLog, runningTasks, shutdownTasks } from './task-runner.mjs';
import { getCapabilities } from './capabilities.mjs';
import { listAgents, readAgent, previewForWindow, saveAgent, createAgents, deleteAgent, setAgentEnabled, planTeam, templatesForWindow, configHome, TOOL_CATALOG, MODEL_ALIASES, READ_ONLY_TOOLS } from './agents.mjs';
import { sourceRepos, repoDetail, allRepoStates, changedFiles, fileDiff, stageFiles, unstageFiles, stageAll, unstageAll, commit as gitCommit, lastCommit, undoLastCommit, discardAll, listBranches, createBranch, switchBranch, renameBranch, deleteBranch, fetchRemote, pullRemote, pushRemote, publishBranch, cancelRemote, remoteState, commitHistory, commitDetail, commitFileDiff, listStashes, createStash, stashDetail, stashFileDiff, applyStash, dropStash, conflictState, conflictDetail, resolveConflict, assistContext, cancelAllRemotes, runningRemotes } from './git.mjs';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.dirname(SRC);
// Before anything starts a process: Windows looks for a program in the working folder BEFORE
// PATH, and Node's own lookup decides that from THIS process's environment, not the child's.
// With JARVIS starting tools inside project folders, a repository holding its own cmd.exe,
// git.exe or python.exe must never be run in place of the real one - so that lookup is off
// for every process JARVIS starts, and for everything those processes start in turn.
process.env.NoDefaultCurrentDirectoryInExePath = '1';
// Before anything creates a window: this is the name Windows shows for the app.
app.setName('JARVIS');

// How Windows knows this app: an app id (taskbar grouping, notifications, Start) and a toast
// activator CLSID (the COM class a notification's click starts). Both are fixed, and the
// shortcuts made by scripts/shortcuts.ps1 carry the same two values.
//
// They were not always fixed, and it showed. Left alone, Electron makes up a random activator
// every run, and when a notification finds no Start Menu shortcut carrying both, it writes its
// own and registers a COM server for it. A development run (electron.exe) did exactly that
// under JARVIS's id - Start Menu\Programs\Electron.lnk - and from then on Windows named the
// real app "Electron", with the atom, in the taskbar, its jump list and its notifications.
//
// So: one id and one activator for the packaged app, and a separate pair for development, so
// a dev run can never again speak for the installed JARVIS. The packaged activator is the one
// JARVIS.exe had already registered, adopted rather than replaced.
const IDENTITY = app.isPackaged
  ? { appId: 'com.bantuapps.jarvis', toastActivator: '{445FDA2C-DFA5-4369-88E1-B275092CB054}' }
  : { appId: 'com.bantuapps.jarvis.dev', toastActivator: '{F6832385-8B84-4FD9-B83E-A232C0D7EAAE}' };
// Early, as Electron asks: before any notification, so it is what gets registered.
if (process.platform === 'win32' && typeof app.setToastActivatorCLSID === 'function') {
  try { app.setToastActivatorCLSID(IDENTITY.toastActivator); } catch { /* an older Electron: random, as before */ }
}
// ---------------------------------------------------------------- config + log
// A test run can use a throwaway data folder (JARVIS_USERDATA), so it never touches the real settings.
if (process.env.JARVIS_USERDATA) app.setPath('userData', process.env.JARVIS_USERDATA);
const userDir = app.getPath('userData');
const configPath = path.join(userDir, 'config.json');
const logPath = path.join(userDir, 'jarvis.log');

// Why config.json cannot be used right now, or null - Health shows it. While it is set,
// JARVIS runs on its defaults and never writes the file (config-file.mjs): a hand edit gone
// wrong is the person's to fix, or move aside, not JARVIS's to replace.
let configProblem = null;

function rawConfig() {
  const r = readConfigFile(configPath);
  configProblem = r.problem ? `config.json ${r.problem}` : null;
  return r.value || {};
}

/**
 * The whole config, so every setting is visible (budget, phone web app, update notes, ...),
 * with `cwd` resolved from the active workspace (workspaces.mjs) - the ONE place a folder is
 * decided. There is no default folder: with no workspace chosen, `cwd` is null, and anything
 * that needs one says so instead of guessing.
 */
function loadConfig() {
  // Capture aid: JARVIS_CAPTURE_CWD points a screenshot run at a throwaway workspace, so a
  // capture can show states (an unpushed commit, a discard dialog) without touching real
  // repositories. Ignored unless JARVIS_CAPTURE is set.
  if (process.env.JARVIS_CAPTURE && process.env.JARVIS_CAPTURE_CWD) {
    const dir = path.resolve(process.env.JARVIS_CAPTURE_CWD);
    return { cwd: dir, phone: {}, workspaces: [{ id: 'ws_capture', name: path.basename(dir), path: dir }], activeWorkspaceId: 'ws_capture' };
  }
  const c = rawConfig();
  const ws = normalizeWorkspaces(c);
  return { ...c, workspaces: ws.workspaces, activeWorkspaceId: ws.activeWorkspaceId, cwd: ws.activePath, phone: c.phone || {} };
}
/** The active workspace entry ({ id, name, path, projects? }), or null. */
function activeWs() {
  const c = loadConfig();
  return c.workspaces.find((w) => w.id === c.activeWorkspaceId) || null;
}

/**
 * Merge into config.json. Only ever called with settings the user chose. Written through a
 * temp file and a rename; a config that is there but cannot be read is never overwritten -
 * nothing is saved until it reads again, and Health says why (config-file.mjs).
 */
function saveConfig(patch) {
  try {
    const r = mergeConfigFile(configPath, patch);
    if (r.ok) { configProblem = null; return r.value; }
    configProblem = `config.json ${r.problem}`;
    log(`settings not saved: ${configProblem}`);
  } catch (e) { log('could not save config:', e?.message || e); }
  return { ...patch };
}

// Version 2 keeps a list of workspaces. An older config (one `cwd`) is migrated once, at
// start: the folder becomes the first workspace, `cwd` stays (mirrored, for older JARVIS
// versions), and the config as it was is kept beside it as config.before-v2.json.
(function migrateWorkspaces() {
  if (process.env.JARVIS_CAPTURE || !fs.existsSync(configPath)) return;
  const raw = rawConfig();
  if (configProblem) { log(`${configProblem} - JARVIS runs on its defaults and saves nothing until it is fixed`); return; }
  const n = normalizeWorkspaces(raw);
  if (!n.migrated) return;
  if (!Array.isArray(raw.workspaces)) {
    const backup = path.join(userDir, 'config.before-v2.json');
    try { if (!fs.existsSync(backup)) fs.copyFileSync(configPath, backup); } catch { /* the migration keeps cwd anyway */ }
  }
  saveConfig(n.patch);
  log(`workspaces: ${n.workspaces.length} known, active ${n.activePath || 'none'}${Array.isArray(raw.workspaces) ? '' : ' (migrated from the single workspace folder)'}`);
})();

// The active workspace's projects (project-discovery.mjs), kept a minute, shared by every view.
const projectIndex = createProjectIndex({ log: (...a) => log(...a) });
// What a repository is called on screen (Source Control, the dashboard, Telegram's /diff):
// the person's own name for it, else the name its files carry, else its folder's name.
setRepoNames((rel) => {
  const ws = activeWs();
  if (!ws) return null;
  const own = projectSettings(ws, rel).name;
  if (own) return own;
  const found = projectIndex.peek(ws)?.projects.find((p) => p.relativePath === rel);
  return found && found.displayName && found.displayName !== found.name ? found.displayName : null;
});
// Git only in a trusted workspace (workspace.mjs, GIT_RESTRICTED). Asked before every git
// call, so it is remembered for a moment rather than read from config.json each time.
let trustMemo = { at: 0, value: false };
setGitTrust(() => {
  if (Date.now() - trustMemo.at > 2000) trustMemo = { at: Date.now(), value: workspaceTrusted() };
  return trustMemo.value;
});
// The last ClickUp sync's failure, for Health - cleared by the next sync that works.
let clickupLastError = null;

/**
 * Phone alerts: { enabled, route, serial, address, minSeconds, telegram }.
 *
 * `route` is how the alert travels. 'adb' is the original: a notification posted straight
 * into the tray over USB or the same Wi-Fi, with nothing leaving this machine and no app on
 * the phone. 'telegram' goes out over the internet instead, so it reaches the phone on
 * mobile data anywhere - at the cost of the text passing through Telegram.
 */
// The Telegram bot token: encrypted by Windows for this user, the same way the GitHub token
// already is (saveToken/loadToken/clearToken, imported above from updates.mjs - same file
// format, same safety guarantee). An install from before this encryption existed kept it in
// config.json's phone.telegram.token as plain text; migrateTelegramToken() moves it across
// once, below, and phoneConfig() still falls back to that field for as long as it is there -
// so a PC where Windows cannot encrypt right now (or ever) never loses phone alerts or
// remote control over it.
const TELEGRAM_TOKEN_FILE = path.join(userDir, 'telegram-token.bin');

// Google Drive connection (Phase 24C) - two separate encrypted files (drive-token.mjs), the
// same fail-closed safeStorage pattern as above, but with no plaintext fallback: a Drive
// token is never kept anywhere JARVIS cannot encrypt. Connection management only - no
// backup/restore IPC exists yet (see the handlers below).
const DRIVE_CLIENT_FILE = path.join(userDir, 'drive-client.bin');
const DRIVE_TOKEN_FILE = path.join(userDir, 'drive-token.bin');
const driveConnection = createDriveConnection({
  tokenFile: DRIVE_TOKEN_FILE,
  clientFile: DRIVE_CLIENT_FILE,
  safeStorage,
  log,
  openExternal: (url) => shell.openExternal(url),
});
/** Never the tokens themselves - only a status word and, for "configured", whether a Client
 *  ID is set (never its value). The same discipline phoneConfigForWindow() applies. */
function driveStatusForWindow() {
  const s = driveConnection.status();
  const c = driveConnection.getClient();
  return {
    status: s.status, reason: s.reason || null, clientConfigured: !!c,
    // Phase 2 (Decision 1): lets the UI say "connected through JARVIS's own sign-in" vs
    // "connected through your own Client ID" - never the id's value either way.
    appOwned: !!c && c.clientId === appOwnedClientId(),
  };
}

function phoneConfig() {
  const p = loadConfig().phone || {};
  const t = p.telegram && typeof p.telegram === 'object' ? p.telegram : {};
  // The encrypted copy wins when there is one; otherwise an older install's plain-text field
  // still works, until migrateTelegramToken() moves it (or it never can, and this stays the
  // one place the token lives).
  const token = resolveTelegramToken(TELEGRAM_TOKEN_FILE, safeStorage, t.token);
  return {
    enabled: !!p.enabled,
    // Remote control: messages from your Telegram chat run here. Telegram route only.
    remote: !!p.remote,
    // Mirror: what is typed at the desk, and JARVIS's replies to it, appear in the chat too.
    mirror: !!p.mirror,
    route: p.route === 'telegram' ? 'telegram' : 'adb',
    serial: isSerial(p.serial) ? p.serial : null,
    address: typeof p.address === 'string' ? p.address : null,
    minSeconds: Number.isFinite(p.minSeconds) ? p.minSeconds : 30,
    telegram: {
      token,
      chatId: isChatId(t.chatId) ? String(t.chatId) : null,
      name: typeof t.name === 'string' ? t.name.slice(0, 60) : null,
      // With more than one PC: this PC's name, and the group shared with the others (presence.mjs).
      pcName: cleanPcName(t.pcName) || cleanPcName(os.hostname()) || 'PC',
      groupId: isChatId(t.groupId) ? String(t.groupId) : null,
      groupName: typeof t.groupName === 'string' ? t.groupName.slice(0, 60) : null,
    },
  };
}
/** This PC's name in messages to the phone - only once there is a group, so more than one PC. */
function pcLabel() {
  const t = phoneConfig().telegram;
  return t.groupId ? t.pcName : null;
}
/** A PC's name as it is said in Telegram: letters, digits, spaces, dots and dashes, up to 24. */
function cleanPcName(s) {
  return typeof s === 'string' ? s.replace(/[^\w .-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24) : '';
}

/**
 * The window must never be handed the bot token: it is a credential, and the renderer has
 * no business holding one. It is told only whether a token is set, and what the bot is
 * called.
 */
function phoneConfigForWindow(c) {
  return {
    ...c,
    telegram: { hasToken: !!c.telegram.token, chatId: c.telegram.chatId, name: c.telegram.name, pcName: c.telegram.pcName, groupId: c.telegram.groupId, groupName: c.telegram.groupName },
  };
}

/**
 * Save phone settings with the Telegram token laundered through telegramTokenField()
 * (phone-token.mjs), no matter what `next.telegram.token` already holds - every call site
 * here builds `next` by spreading phoneConfig()'s resolved view (which legitimately carries
 * the real token along while changing some unrelated field), so this is the one place
 * responsible for never writing that value back out as plain text. Pass `setToken` only from
 * the two places that actually mean to change the token.
 */
function savePhoneConfig(next, { setToken } = {}) {
  const t = (next && next.telegram) || {};
  const legacy = rawConfig().phone?.telegram?.token;
  const token = telegramTokenField(TELEGRAM_TOKEN_FILE, safeStorage, setToken, legacy, { log });
  return saveConfig({ phone: { ...next, telegram: { ...t, token } } });
}

/**
 * Move an older install's plain-text Telegram token into the encrypted store, once
 * (phone-token.mjs decides whether there is anything to do and performs the encrypted
 * write; this just re-saves config.json without the field once that succeeds).
 */
function runTelegramTokenMigration() {
  if (process.env.JARVIS_CAPTURE) return;
  const cur = rawConfig();
  const legacy = cur.phone?.telegram?.token;
  if (migrateTelegramToken(TELEGRAM_TOKEN_FILE, safeStorage, legacy, { log })) {
    savePhoneConfig(cur.phone || {});
    log('Telegram token migrated to encrypted storage');
  }
}

/** Route one alert. Returns { ok } or { ok: false, error, skip? } - never throws. */
async function sendAlert(item) {
  const c = phoneConfig();
  if (c.route === 'telegram') {
    if (!c.telegram.token || !c.telegram.chatId) return { ok: false, skip: true, error: 'Telegram is not set up yet.' };
    return sendTelegram(c.telegram, item);
  }
  if (!c.serial) return { ok: false, skip: true, error: 'No phone chosen yet.' };
  return postNotification(c.serial, item);
}

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`;
  try { fs.appendFileSync(logPath, line); } catch { /* logging must never break the app */ }
}

/** A packaged file that must exist on disk, not inside the asar archive. */
const unpacked = (p) => p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

/** The Claude Code binary shipped with the SDK. Packaged builds keep it outside the asar. */
function claudeExe() {
  return unpacked(path.join(APP_ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe'));
}

/**
 * The window icon. Windows reads this file natively, and a path inside app.asar is not a
 * real file - that is what left the taskbar showing Electron's own icon and name.
 */
function windowIcon() {
  const ico = unpacked(path.join(APP_ROOT, 'build', 'icon.ico'));
  if (fs.existsSync(ico)) return ico;
  const png = unpacked(path.join(APP_ROOT, 'build', 'icon.png'));
  return fs.existsSync(png) ? png : undefined;
}

// ---------------------------------------------------------------- window
/** The only addresses the Devices view may send to a browser: this machine. */
const LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?(\/|$)/i;
let win = null;
let session = null;

// Your phone hears about the same events the window does, but only the ones that mean
// work has stopped, and only while the window does not have your attention.
const phone = createPhoneWatcher({
  cfg: phoneConfig,
  atDesk: () => !!win && !win.isDestroyed() && win.isFocused(),
  log,
  send: sendAlert,
});

// Remote control (remote.mjs): your Telegram chat as a second keyboard. It is fed every
// session event like the alert watcher, and goes first: an approval or a reply it has put
// on the phone is "claimed", so the watcher does not send a second message about it.
// serial -> BrowserWindow of a phone shown in its own window (see "IPC: devices"). Declared
// here, before anything can send an event, because toWindow reads it.
const phoneWindows = new Map();
const toWindow = (evt) => {
  if (win && !win.isDestroyed()) win.webContents.send('jarvis:event', evt);
  // A phone's own window gets that phone's events too (screen started or stopped, flutter run).
  const pw = evt && evt.serial ? phoneWindows.get(evt.serial) : null;
  if (pw && !pw.isDestroyed()) pw.webContents.send('jarvis:event', evt);
};
const remote = createRemote({
  cfg: () => {
    const c = phoneConfig();
    // Never during a screenshot run: those start and quit by themselves, and must not take
    // a real message off the queue. JARVIS_REMOTE_TEST=1 allows it for a run that is
    // about remote control.
    const allowed = !process.env.JARVIS_CAPTURE || process.env.JARVIS_REMOTE_TEST === '1';
    return { on: allowed && c.remote && c.route === 'telegram', mirror: c.mirror, token: c.telegram.token, chatId: c.telegram.chatId, name: c.telegram.name, pcName: c.telegram.groupId ? c.telegram.pcName : null, groupId: c.telegram.groupId };
  },
  log,
  atDesk: () => !!win && !win.isDestroyed() && win.isFocused(),
  // The window submits it, through the same path as the composer.
  submit: (text, attachments) => {
    if (!win || win.isDestroyed()) return false;
    toWindow({ kind: 'remote_prompt', text, attachments: Array.isArray(attachments) ? attachments : [] });
    return true;
  },
  newSession: () => toWindow({ kind: 'remote_new' }),
  powerDown: (from) => powerDown(from),
  wakeUp: (from) => wakeUp(from),
  asleep: () => asleep,
  peers: () => presence.peers(),
  groupMoved: (id) => {
    const cur = phoneConfig();
    savePhoneConfig({ ...cur, telegram: { ...cur.telegram, groupId: id } });
    presence.set(asleep ? 'asleep' : 'awake');
  },
  interrupt: () => { toWindow({ kind: 'remote_stop' }); ensureSession().interrupt(); },
  respond: (id, decision, verdict) => { toWindow({ kind: 'prompt_remote', id, verdict }); features.noteDecision(id, decision, 'Telegram'); ensureSession().respond(id, decision); },
  workspace: () => loadConfig().cwd,
  screens: captureScreens,
  diff: (query) => diffReport(loadConfig().cwd, query),
  brief: buildBrief,
  briefSet: (patch) => { const next = { ...briefConfig(), ...patch }; saveConfig({ brief: next }); log('morning brief:', next.on ? `on at ${next.at}` : 'off'); return next; },
  // No workspace, no list: the SDK reads a missing folder as "every project's conversations".
  sessions: async () => { const { cwd } = loadConfig(); return cwd ? listRecent(cwd) : []; },
  // /deleteapp (Telegram only): removes this install, and - in a dev checkout - old
  // installer builds, so a GitHub Release download or Update has nothing old in the way.
  // Nothing is relaunched; JARVIS quits once the cleanup is safely started.
  deleteApp: async () => {
    if (process.env.JARVIS_CAPTURE) return { ok: false, error: 'A screenshot run never deletes the install.' };
    const distDir = app.isPackaged ? null : path.join(APP_ROOT, 'dist-installer');
    const started = await launchUpdater(deleteAppCommand({
      waitPid: process.pid,
      installDir: path.dirname(JARVIS_INSTALL_EXE),
      distDir,
      logPath,
    }));
    if (!started.ok) return { ok: false, error: started.error };
    log('deleteapp: removing this install - JARVIS closes now');
    setTimeout(() => app.quit(), 500);
    return { ok: true };
  },
  currentSession: () => session?.sessionId || null,
  // Through the window, like /new: it redraws the transcript the same way a click would.
  switchSession: async (id, title) => {
    if (!win || win.isDestroyed() || !isSessionId(id)) return { ok: false };
    toWindow({ kind: 'remote_switch', id, title });
    let last = null;
    try { last = (await loadHistory(loadConfig().cwd, id)).filter((h) => h.role === 'assistant').at(-1)?.text || null; } catch { /* the switch still happened */ }
    return { ok: true, last };
  },
  saveIncoming,
  // A file attached at the desk, so the mirror can send it to the phone. 50 MB is Telegram's upload limit.
  readAttachment: async (p) => {
    const st = await fsp.stat(p);
    return st.isFile() && st.size <= 50 * 1024 * 1024 ? fsp.readFile(p) : null;
  },
  transcribe: (buf) => voice.transcribe(buf),
  voiceReady: () => voice.ready,
});

// This PC's line on the group's status board (presence.mjs). Set while remote control is on,
// cleared when it goes off or JARVIS quits. Without a group it does nothing.
const presence = createPresence({
  cfg: () => {
    const c = phoneConfig().telegram;
    return { token: c.token, groupId: c.groupId, name: c.pcName };
  },
  api: telegramCall,
  log,
});

// Photos and files sent from the phone are kept here, where you would look for them anyway,
// and are the only files the window may open directly (jarvis:openAttachment).
const INBOX = path.join(app.getPath('downloads'), 'JARVIS from phone');
async function saveIncoming(name, data) {
  await fsp.mkdir(INBOX, { recursive: true });
  const clean = String(name || 'file').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file';
  const ext = path.extname(clean);
  const base = clean.slice(0, clean.length - ext.length);
  let full = path.join(INBOX, clean);
  for (let i = 2; fs.existsSync(full); i++) full = path.join(INBOX, `${base} (${i})${ext}`);
  await fsp.writeFile(full, data);
  return full;
}
const inInbox = (p) => {
  const full = path.resolve(String(p || ''));
  return full.toLowerCase().startsWith(INBOX.toLowerCase() + path.sep);
};

// Voice notes are transcribed here, with a model kept beside the config (voice.mjs).
const voice = createTranscriber({ cacheDir: path.join(userDir, 'models'), log });

// The features of 2026-10-07 (activity, usage, routines, the phone web app, ...). See features.mjs.
// Created once, before any window; their IPC is registered now so the first window can use it.
const features = createFeatures({
  app, ipcMain, shell, dialog, Notification, safeStorage, userDir, srcDir: SRC, configPath,
  firstRun: !fs.existsSync(configPath),
  log, loadConfig, saveConfig, query,
  claudeExe: () => claudeExe(),
  remote, voice,
  getWin: () => win,
  isCapture: !!process.env.JARVIS_CAPTURE,
  showWindow: () => showWindow(),
  showView: (view) => toWindow({ kind: 'navigate', view }),
  respondAny: (id, decision) => respondAny(id, decision),
  interruptAll: () => interruptAll(),
  submitMessage: (payload) => submitMessage(payload, null),
  startSignIn: () => startSignInWindow(),
  authState: async () => noteAccount(await authStatus(claudeExe())),
  githubOn: async () => !!(await resolveToken(tokenStore)).source,
  telegramOn: () => { const t = phoneConfig().telegram || {}; return !!(t.token && (t.chatId || t.groupId)); },
  // Switched on in Settings (alerts by Telegram, or remote control) - set up or not.
  telegramWanted: () => { const c = phoneConfig(); return c.route === 'telegram' && (c.enabled || c.remote); },
  // Set up = a member name is set. Synced before but no name now: it needs one to carry on.
  clickupState: () => {
    const member = cleanMember(loadConfig().clickup?.member);
    const before = !!readClickUp(userDir).fetchedAt;
    return { used: !!member, error: clickupLastError || (!member && before ? 'JARVIS needs your name as it appears in ClickUp (on the Tasks page) to keep syncing.' : null), member };
  },
  projects: ({ refresh } = {}) => projectIndex.get(activeWs(), { refresh: !!refresh }),
  // A folder is trusted when it is a workspace the person trusted (workspaces.mjs, TRUST).
  folderTrusted: (dir) => {
    if (!dir) return false;
    const want = path.resolve(dir).toLowerCase();
    return loadConfig().workspaces.some((w) => w.trusted === true && path.resolve(w.path).toLowerCase() === want);
  },
  workspaceTrusted: () => workspaceTrusted(),
  configProblem: () => configProblem,
  updateInfo: () => lastUpdateInfo,
  // The knowledge check the window last asked for (jarvis:workspace), and whether this
  // workspace has a /relearn command to bring it up to date. Null until it has been checked.
  knowledge: () => {
    if (!wsCache?.knowledge) return null;
    const cwd = loadConfig().cwd || '';
    return { ...wsCache.knowledge, relearn: !!cwd && fs.existsSync(path.join(cwd, '.claude', 'commands', 'relearn.md')) };
  },
});
features.registerIpc();

/** A JPEG of every screen, at its real resolution (capped at 2560 wide for Telegram). */
async function captureScreens() {
  const displays = screen.getAllDisplays();
  const w = Math.max(...displays.map((d) => d.size.width * d.scaleFactor));
  const h = Math.max(...displays.map((d) => d.size.height * d.scaleFactor));
  const k = Math.min(1, 2560 / w); // the thumbnail keeps each screen's shape inside this box
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(w * k), height: Math.round(h * k) } });
  return sources.filter((s) => !s.thumbnail.isEmpty()).map((s, i) => ({ name: s.name || `Screen ${i + 1}`, data: s.thumbnail.toJPEG(85) }));
}

// ---------------------------------------------------------------- the morning brief
// On weekdays at the set time (08:00 unless /brief says otherwise), while remote control is
// on: one message with the repos, open issues, the handoff's focus and ClickUp. No model is
// involved. Sent once a day - the date is kept in the config, so a restart does not repeat
// it - and only within three hours of the time: a PC switched on at 3 pm gets no "morning".
function briefConfig() {
  const b = rawConfig().brief || {};
  return { on: b.on !== false, at: /^\d\d:\d\d$/.test(b.at || '') ? b.at : '08:00', sent: typeof b.sent === 'string' ? b.sent : null };
}
async function buildBrief() {
  const { cwd } = loadConfig();
  const recent = cwd ? await listRecent(cwd).catch(() => []) : [];
  return morningBrief({ cwd, userDir, lastSession: recent[0] || null });
}
const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
async function briefTick() {
  const b = briefConfig();
  const d = new Date();
  if (!b.on || !remote.ready || d.getDay() === 0 || d.getDay() === 6 || b.sent === localDay(d)) return;
  const [hh, mm] = b.at.split(':').map(Number);
  const late = (d.getHours() * 60 + d.getMinutes()) - (hh * 60 + mm);
  if (late < 0 || late > 180) return;
  saveConfig({ brief: { on: b.on, at: b.at, sent: localDay(d) } });
  try { await remote.announce(await buildBrief()); log('morning brief sent'); } catch (e) { log('morning brief failed:', e?.message || e); }
}
setInterval(() => { briefTick().catch(() => {}); }, 60000).unref?.();

// ---------------------------------------------------------------- deploy alerts
// A deploy, release build or publish that JARVIS runs tells the phone when it ends, and
// whether it worked (deploys.mjs). Over Telegram while remote control is on; otherwise
// through the phone alerts, if those are on.
const deploys = createDeployWatcher({
  enabled: () => remote.ready || phoneConfig().enabled,
  notify: (item) => {
    log('deploy alert:', item.title);
    if (remote.ready) remote.announce(`${item.title}\n${item.body}`);
    else sendAlert(item).catch(() => {});
  },
});

// ---------------------------------------------------------------- running in the background
// Remote control is only as good as the PC's willingness to answer. A sleeping PC answers
// nothing, and a closed window cannot submit the message (remote_prompt goes through the
// window, like the composer). So while remote control is on, two things change:
//  - the system is kept from sleeping ('prevent-app-suspension': the screen may still turn
//    off and the PC lock, which is what you want when you walk away), and
//  - closing the window hides it to the tray instead of quitting.
// Both end the moment remote control is switched off.
let tray = null;
let quitting = false;
let awakeId = null;
// Started by Windows at login (see jarvis:setStartup): straight to the tray, no window.
let launchHidden = process.argv.includes('--hidden');
let shownOnce = false;
let trayHinted = false;
// Powered down: the window, the session and everything they started are closed, and only the
// Telegram listener is left, waiting for "Wake up". See powerDown() and wakeUp().
let asleep = false;

function remoteWanted() {
  const c = phoneConfig();
  return !process.env.JARVIS_CAPTURE && c.remote && c.route === 'telegram';
}

/** Bring the window back from the tray, the taskbar or a login start. */
function showWindow() {
  // The tray or the shortcut while asleep is a wake-up at the desk.
  if (asleep) { wakeUp('desk'); return; }
  launchHidden = false;
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (!win.isVisible()) { if (!shownOnce) win.maximize(); win.show(); shownOnce = true; }
  if (win.isMinimized()) win.restore();
  win.focus();
}

function createTray() {
  const icon = windowIcon();
  if (!icon || process.env.JARVIS_CAPTURE) return;
  try { tray = new Tray(icon); } catch (e) { log('tray failed:', e?.message || e); return; }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open JARVIS', click: showWindow },
    { type: 'separator' },
    { label: 'Quit JARVIS', click: () => app.quit() },
  ]));
  tray.on('click', showWindow);
  syncBackground();
}

/** Follow the remote-control setting: keep-awake on or off, and the tray tooltip. */
function syncBackground() {
  const on = remoteWanted();
  if (on && awakeId === null) {
    awakeId = powerSaveBlocker.start('prevent-app-suspension');
    log('keep awake: on (remote control is on)');
  } else if (!on && awakeId !== null) {
    if (powerSaveBlocker.isStarted(awakeId)) powerSaveBlocker.stop(awakeId);
    awakeId = null;
    log('keep awake: off');
  }
  tray?.setToolTip(asleep ? 'JARVIS - asleep (click, or say "Wake up" in Telegram)' : on ? 'JARVIS - listening to Telegram' : 'JARVIS');
}

// Start with Windows. Packaged only: a development run would register electron.exe under
// the login key, which is the same mistake as the stray Electron.lnk (see IDENTITY).
const LOGIN_ARGS = ['--hidden'];
function startAtLogin() {
  if (!app.isPackaged) return false;
  return app.getLoginItemSettings({ path: process.execPath, args: LOGIN_ARGS }).openAtLogin;
}
ipcMain.handle('jarvis:startup', () => ({ available: app.isPackaged && process.platform === 'win32', atLogin: startAtLogin() }));
ipcMain.handle('jarvis:setStartup', (_e, on) => {
  if (!app.isPackaged) return { ok: false, error: 'Only the installed JARVIS.exe can start with Windows.' };
  app.setLoginItemSettings({ openAtLogin: !!on, path: process.execPath, args: LOGIN_ARGS });
  const atLogin = startAtLogin();
  log('start with Windows:', atLogin ? 'on' : 'off');
  return { ok: atLogin === !!on, atLogin };
});

function send(evt) {
  toWindow(evt);
  features.onEvent(evt);
  let claimed = false;
  try { claimed = remote.event(evt); } catch (e) { log('remote:', e?.message || e); }
  try { phone.event(evt, { claimed }); } catch (e) { log('phone watcher:', e?.message || e); }
  try { deploys.event(evt); } catch (e) { log('deploy watcher:', e?.message || e); }
}

function createWindow() {
  const capture = !!process.env.JARVIS_CAPTURE;
  // JARVIS_SIZE=<w>x<h> lets a capture check a state at a particular window size.
  const sized = /^(\d{3,4})x(\d{3,4})$/.exec(process.env.JARVIS_SIZE || '');
  const dark = nativeTheme.shouldUseDarkColors;
  win = new BrowserWindow({
    width: 1500,
    height: 930,
    // Small enough to sit beside your editor with one phone on screen, the way scrcpy does.
    minWidth: 380,
    minHeight: 520,
    title: 'JARVIS',
    // The page's own background, so there is no flash of another colour before it paints.
    backgroundColor: dark ? '#0d0e10' : '#f7f8f9',
    icon: windowIcon(),
    titleBarStyle: 'hidden',
    // The caption buttons sit on the header, so they wear its colour. This is a first guess
    // from the OS theme; the window sends the exact colours once it knows which theme is in
    // use (Settings can pin one), and again whenever that changes - see jarvis:titleBar.
    titleBarOverlay: TITLE_BAR[dark ? 'dark' : 'light'],
    show: false,
    webPreferences: {
      preload: path.join(SRC, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      backgroundThrottling: !capture,
    },
  });

  // A screenshot run is a debug aid that opens and quits on its own: it must not put real
  // notifications on the user's screen. Today's runs did, as electron.exe, wearing
  // Electron's icon. Refused here for the whole window, and checked again in JV.notify.
  if (capture) {
    const ses = win.webContents.session;
    ses.setPermissionCheckHandler((_wc, permission) => permission !== 'notifications');
    ses.setPermissionRequestHandler((_wc, permission, done) => done(permission !== 'notifications'));
  }

  win.loadFile(path.join(SRC, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    // Capture runs (a debug aid) stay off-screen and never take focus from the user.
    if (capture) {
      win.setBounds({ x: -5000, y: 0, width: sized ? Number(sized[1]) : 1600, height: sized ? Number(sized[2]) : 960 });
      win.showInactive();
    }
    // Opened again by a system update: always show the window, never just the tray.
    else if (!launchHidden || process.argv.includes('--updated')) { win.maximize(); win.show(); shownOnce = true; }
    // Opened by the updater, Windows often shows a window it did not start in the foreground:
    // it can sit behind other apps, or only in the tray. So bring it to the front too.
    if (!capture && process.argv.includes('--updated')) {
      win.show(); win.focus();
      if (app.focus) app.focus({ steal: true });
    }
  });

  // Safety net: 'ready-to-show' can fail to fire at all - a slow first paint, a GPU hiccup,
  // antivirus scanning a freshly-installed exe - leaving the window created but never shown:
  // the tray icon and the process are there, but nothing a person can see or interact with,
  // and no later action (even the single-instance "open it again" bring-to-front) is
  // guaranteed to recover it once this has happened. Previously the ONLY retry for this was
  // external, in updaterCommand (src/updates.mjs) - this gives an ordinary launch the same
  // "if it didn't actually show, show it again" guarantee, without needing a whole separate
  // process relaunch to do it. Never overrides a deliberate hidden start (login, `--hidden`)
  // unless this was itself the post-update relaunch, which must always end up visible.
  if (!capture) {
    setTimeout(() => {
      if (!win || win.isDestroyed() || win.isVisible()) return;
      if (launchHidden && !process.argv.includes('--updated')) return;
      log('the window did not become visible after launch - showing it now');
      if (!shownOnce) win.maximize();
      win.show();
      win.focus();
      shownOnce = true;
    }, 8000);
  }

  // While remote control is on, closing hides to the tray: the window is what submits a
  // message from Telegram, so it has to stay alive. Quit from the tray menu.
  win.on('close', (e) => {
    if (quitting || !tray || !remoteWanted()) return;
    e.preventDefault();
    win.hide();
    if (!trayHinted) {
      trayHinted = true;
      tray.displayBalloon?.({ iconType: 'info', title: 'JARVIS is still listening', content: 'Remote control is on, so JARVIS keeps running in the tray. Right-click the icon to quit.' });
    }
  });

  // Links open in the real browser and the window never navigates away - for this window and
  // every other one, by the app-wide guard (see 'web-contents-created' below).

  // Ctrl+Shift+I for developer tools (there is no menu bar).
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') {
      win.webContents.toggleDevTools();
    }
  });

  wireDockFollow();
  win.on('closed', () => {
    win = null;
    // A phone window never outlives JARVIS's own window.
    for (const pw of phoneWindows.values()) if (!pw.isDestroyed()) pw.close();
  });
  win.webContents.on('render-process-gone', (_e, d) => log('window renderer gone:', d.reason, d.exitCode));
  // Script errors in the window (uncaught exceptions included) go to jarvis.log, not just devtools.
  win.webContents.on('console-message', (e, lvl, msg, line, src) => {
    const level = e?.level ?? lvl;
    if (level !== 'error' && level !== 3) return;
    log('[window error]', String(e?.message ?? msg), `${e?.sourceId ?? src ?? ''}:${e?.lineNumber ?? line ?? ''}`);
  });

  // Debug aid: JARVIS_CAPTURE=<file.png> saves a screenshot of this window
  // (only this window) after a delay, then quits. Unused in normal runs.
  // JARVIS_VIEW picks the view first; JARVIS_AUTOPROMPT sends one message first.
  if (capture) {
    const view = /^[a-z]+$/.test(process.env.JARVIS_VIEW || '') ? process.env.JARVIS_VIEW : null;
    if (process.env.JARVIS_AUTOPROMPT) {
      win.webContents.once('did-finish-load', () => setTimeout(() => {
        win.webContents.executeJavaScript(`window.__jarvisAutoprompt && window.__jarvisAutoprompt(${JSON.stringify(process.env.JARVIS_AUTOPROMPT)});`);
      }, 3500));
    }
    // JARVIS_CAPTURE_SCRIPT=<file.js> runs that script in the window before the screenshot - for
    // showing a dialog or Settings on a tab. Capture runs only, like the other aids above.
    if (process.env.JARVIS_CAPTURE_SCRIPT && fs.existsSync(process.env.JARVIS_CAPTURE_SCRIPT)) {
      const scriptText = fs.readFileSync(process.env.JARVIS_CAPTURE_SCRIPT, 'utf8');
      win.webContents.once('did-finish-load', () => setTimeout(() => {
        win.webContents.executeJavaScript(scriptText).catch((e) => log('capture script failed:', e?.message || e));
      }, Number(process.env.JARVIS_CAPTURE_SCRIPT_AT || 4000)));
    }
    // JARVIS_DEMO=crew plays a scripted set of agent events into the Agents floor, so a capture
    // can show minions at work without a real (paid) agent run. Capture runs only.
    if (/^[a-z]+$/.test(process.env.JARVIS_DEMO || '')) {
      win.webContents.once('did-finish-load', () => setTimeout(() => {
        win.webContents.executeJavaScript(`window.__jarvisDemo && window.__jarvisDemo(${JSON.stringify(process.env.JARVIS_DEMO)});`);
      }, 2500));
    }
    // JARVIS_STORE=key=value seeds one localStorage item before the view opens, so a
    // capture can be pointed at a particular saved state (which repository Source Control
    // reopens, say) without clicking through the UI or disturbing the real settings.
    const store = /^([\w.]{1,60})=(.{0,200})$/.exec(process.env.JARVIS_STORE || '');
    // localStorage is the real one, shared with normal runs, so the previous value is put
    // back before the capture quits - a capture must not change where the next launch opens.
    let storeBefore;
    if (store) {
      win.webContents.once('did-finish-load', async () => {
        try {
          storeBefore = await win.webContents.executeJavaScript(
            `(() => { try { const k = ${JSON.stringify(store[1])}; const was = localStorage.getItem(k);
               localStorage.setItem(k, ${JSON.stringify(store[2])}); return was; } catch { return undefined; } })();`,
          );
        } catch { /* a capture aid only */ }
      });
    }
    if (view) {
      win.webContents.once('did-finish-load', () => setTimeout(() => {
        win.webContents.executeJavaScript(`window.__jarvisShow && window.__jarvisShow(${JSON.stringify(view)});`);
      }, 1500));
    }
    // JARVIS_FILL=<id>=<text> types into one field before the clicks run, so a capture can
    // exercise a form end to end. The input event is dispatched too, since the window
    // reacts to typing, not to the value appearing.
    const fill = /^([A-Za-z][\w-]{0,40})=([\s\S]{0,200})$/.exec(process.env.JARVIS_FILL || '');
    if (fill) {
      // Late enough that a form opened by an earlier JARVIS_CLICK already exists - or, with
      // JARVIS_FILL_AT=<ms>, at that moment, so a later click can submit what was typed.
      const fillAt = Number(process.env.JARVIS_FILL_AT || 0);
      const delay = fillAt > 0 ? fillAt : Number(process.env.JARVIS_CAPTURE_DELAY || 9000) - 1800;
      win.webContents.once('did-finish-load', () => setTimeout(() => {
        win.webContents.executeJavaScript(
          `(() => { const n = document.getElementById(${JSON.stringify(fill[1])});
             if (!n) return; n.value = ${JSON.stringify(fill[2])};
             n.dispatchEvent(new Event('input', { bubbles: true })); })();`,
        );
      }, Math.max(1500, delay)));
    }
    // JARVIS_CLICK=<id or .class>, comma-separated to click several in turn before the capture.
    // A class may end in :first-of-type, :last-of-type or :nth-of-type(n), to reach a row that
    // is not the first - the middle or last file of a commit, say.
    const SEL = /^[.#]?[A-Za-z][\w.#-]*(?::(?:first-of-type|last-of-type|nth-of-type\(\d{1,3}\)))?$/;
    const clicks = (process.env.JARVIS_CLICK || '').split(',').map((c) => c.trim())
      .filter((c) => SEL.test(c));
    // JARVIS_HOVER=<selector> puts the mouse over an element, and JARVIS_FOCUS=<selector> gives
    // one keyboard-style focus, 800 ms before the capture - so :hover and :focus-visible can be
    // seen in a screenshot. The pointer is a synthetic event into this window only.
    const late = Math.max(1500, Number(process.env.JARVIS_CAPTURE_DELAY || 9000) - 800);
    const hover = (process.env.JARVIS_HOVER || '').trim();
    if (SEL.test(hover)) {
      const sel = hover.startsWith('.') ? hover : `#${hover}`;
      win.webContents.once('did-finish-load', () => setTimeout(async () => {
        try {
          const at = await win.webContents.executeJavaScript(`(() => { const n = document.querySelector(${JSON.stringify(sel)});
            if (!n) return null; const b = n.getBoundingClientRect();
            return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })();`);
          if (at) win.webContents.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
        } catch { /* a capture aid only */ }
      }, late));
    }
    // JARVIS_KEYS=<combo>[;<combo>...] presses keys, a second apart, from JARVIS_KEYS_AT ms
    // (default: 2.5 s before the capture) - so a keyboard shortcut can be proven in a
    // screenshot, not just a click. A combo is modifiers and one key: "Ctrl+3", "Ctrl+,",
    // "Escape". Semicolons separate them, since a comma can be the key itself. They go to the
    // page as real key events, through the same path as typing.
    const KEY = /^((?:Ctrl|Shift|Alt)\+){0,3}([A-Za-z0-9,.\/]|Escape|Enter|Tab)$/;
    const keys = (process.env.JARVIS_KEYS || '').split(';').map((k) => k.trim()).filter((k) => KEY.test(k));
    if (keys.length) {
      const keysAt = Number(process.env.JARVIS_KEYS_AT || 0) || Math.max(1500, Number(process.env.JARVIS_CAPTURE_DELAY || 9000) - 2500);
      win.webContents.once('did-finish-load', () => keys.forEach((combo, i) => setTimeout(() => {
        const parts = combo.split(/\+(?=.)/);
        const keyCode = parts.pop();
        const modifiers = parts.map((m) => m.toLowerCase());
        for (const type of ['keyDown', 'char', 'keyUp']) {
          if (type === 'char' && (modifiers.length || keyCode.length > 1)) continue;
          try { win.webContents.sendInputEvent({ type, keyCode, modifiers }); } catch { /* a capture aid only */ }
        }
      }, keysAt + i * 1000)));
    }
    const focus = (process.env.JARVIS_FOCUS || '').trim();
    if (SEL.test(focus)) {
      const sel = focus.startsWith('.') ? focus : `#${focus}`;
      win.webContents.once('did-finish-load', () => setTimeout(async () => {
        // The capture window never takes real focus, and an unfocused page matches no :focus
        // at all. DevTools' focus emulation makes the page behave as focused - without
        // activating the window or taking focus from whatever the user is doing.
        try {
          win.webContents.debugger.attach('1.3');
          await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
        } catch { /* a capture aid only */ }
        win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(sel)})?.focus({ focusVisible: true });`).catch(() => {});
      }, late));
    }
    if (clicks.length) {
      // By default the clicks land just before the capture, which suits anything instant.
      // JARVIS_CLICK_AT=<ms> fires the first click at that moment instead. Anything that
      // takes time after a click - a model query, a sync - needs it: otherwise the app is
      // screenshotted and QUIT 1.5 s after the click, and the work is killed mid-flight. That
      // is exactly what made Phase 8's assistance and the ClickUp sync look like they hung.
      const clickAt = Number(process.env.JARVIS_CLICK_AT || 0);
      // JARVIS_CLICK_GAP=<ms> spaces the clicks further apart than the default 1.2 s, for a
      // flow where each click waits on the answer to the one before (a GitHub request, say).
      const gap = Math.max(300, Number(process.env.JARVIS_CLICK_GAP || 1200));
      const start = clickAt > 0 ? clickAt
        : Number(process.env.JARVIS_CAPTURE_DELAY || 9000) - 1500 - (clicks.length - 1) * gap;
      clicks.forEach((click, i) => {
        win.webContents.once('did-finish-load', () => setTimeout(() => {
          const sel = click.startsWith('.') ? click : `#${click}`;
          win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(sel)})?.click();`);
        }, Math.max(1500, start + i * gap)));
      });
    }
    // JARVIS_HINT_AT=<ms> shows the phone drop zone; JARVIS_DOCK_AT=<ms> docks the first phone
    // window as a drop would, and logs both windows' bounds - docking cannot be dragged here.
    const hintAt = Number(process.env.JARVIS_HINT_AT || 0);
    if (hintAt) win.webContents.once('did-finish-load', () => setTimeout(() => { hintOn = false; snapHint(true, 440); }, hintAt));
    const dockAt = Number(process.env.JARVIS_DOCK_AT || 0);
    if (dockAt) {
      win.webContents.once('did-finish-load', () => setTimeout(() => {
        const [serial, pw] = [...phoneWindows][0] || [];
        if (!pw) { log('capture: no phone window to dock'); return; }
        const before = win.getBounds();
        dockPhone(serial, pw);
        setTimeout(() => log('capture: dock bounds', JSON.stringify({ before, phone: pw.getBounds(), jarvis: win.getBounds() })), 300);
      }, dockAt));
    }
    // JARVIS_CONTEXT=<selector> right-clicks an element (a contextmenu event at its centre),
    // at JARVIS_CONTEXT_AT ms or 2.5 s before the capture - so a right-click menu can be seen.
    const context = (process.env.JARVIS_CONTEXT || '').trim();
    if (SEL.test(context)) {
      const sel = context.startsWith('.') ? context : `#${context}`;
      const at = Number(process.env.JARVIS_CONTEXT_AT || 0) || Math.max(1500, Number(process.env.JARVIS_CAPTURE_DELAY || 9000) - 2500);
      win.webContents.once('did-finish-load', () => setTimeout(() => {
        win.webContents.executeJavaScript(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return;
          const b = n.getBoundingClientRect();
          n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
            clientX: Math.round(b.left + b.width / 2), clientY: Math.round(b.top + b.height / 2) })); })();`).catch(() => {});
      }, at));
    }
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      try { fs.writeFileSync(process.env.JARVIS_CAPTURE, (await win.webContents.capturePage()).toPNG()); }
      catch (e) { log('capture failed', e?.message || e); }
      // A phone opened in its own window is saved beside it, as <name>-phone.png.
      for (const pw of phoneWindows.values()) {
        if (pw.isDestroyed()) continue;
        try { fs.writeFileSync(`${process.env.JARVIS_CAPTURE.replace(/\.png$/i, '')}-phone.png`, (await pw.webContents.capturePage()).toPNG()); }
        catch (e) { log('phone capture failed', e?.message || e); }
      }
      if (store && storeBefore !== undefined) {
        try {
          await win.webContents.executeJavaScript(storeBefore === null
            ? `localStorage.removeItem(${JSON.stringify(store[1])});`
            : `localStorage.setItem(${JSON.stringify(store[1])}, ${JSON.stringify(storeBefore)});`);
        } catch { /* a capture aid only */ }
      }
      app.quit();
    }, Number(process.env.JARVIS_CAPTURE_DELAY || 9000)));
  }
}

// ---------------------------------------------------------------- IPC: session
/** Is the active workspace trusted (workspaces.mjs, TRUST)? A screenshot run's folder is a throwaway one. */
function workspaceTrusted() {
  if (process.env.JARVIS_CAPTURE && process.env.JARVIS_CAPTURE_CWD) return true;
  return activeWs()?.trusted === true;
}
/**
 * What a restricted workspace is told when something would run its code. Restricted means
 * JARVIS reads the folder and nothing more: no build, test, script, app, analysis or Git -
 * each of those runs code or configuration the folder itself supplies.
 */
const RESTRICTED_RUN = 'This workspace is restricted, so JARVIS runs nothing from it - no builds, tests, apps or Git. If it is your code, trust it in Settings > Workspaces.';
function ensureSession() {
  if (!session) {
    const { cwd } = loadConfig();
    session = new JarvisSession({ cwd, exe: claudeExe(), emit: send, log, trusted: workspaceTrusted() });
  }
  return session;
}

// Side-by-side chats: each extra chat window (File > New chat window, or the button in the chat)
// has its own session. The main window keeps `session`, which Telegram and the phone web app use.
const paneSessions = new Map(); // window id -> that window's session
const paneWindows = new Map();  // the same window id -> that window's BrowserWindow
let paneCount = 0;
/** The chat session for the window that sent an IPC call (the main one when unknown). */
function sessionFor(e) {
  const wc = e?.sender;
  if (!wc || !win || wc.id === win.webContents.id) return ensureSession();
  let s = paneSessions.get(wc.id);
  if (!s) {
    const { cwd } = loadConfig();
    s = new JarvisSession({
      cwd,
      exe: claudeExe(),
      emit: (evt) => {
        if (!wc.isDestroyed()) wc.send('jarvis:event', evt);
        features.onEvent(evt, { pane: true });
      },
      log,
      trusted: workspaceTrusted(),
    });
    paneSessions.set(wc.id, s);
    wc.once('destroyed', () => {
      try { s.close(); } catch { /* already gone */ }
      paneSessions.delete(wc.id);
    });
  }
  return s;
}
/**
 * Every secondary chat window stopped: its session closed (so it can never go on spending
 * API tokens or leave a permission request nobody can answer) and the window itself closed,
 * not left open showing a conversation that no longer exists. Safe with none open, and safe
 * to call alongside the window's own close handler - closing an already-closed session, or
 * destroying an already-destroyed window, is a no-op either way.
 */
function closeAllPanes() { closePanes(paneSessions, paneWindows); }
/** Answer a permission request, whichever session is waiting on it. */
function respondAny(id, decision) {
  if (session?.pending?.has(id)) return session.respond(id, decision);
  for (const s of paneSessions.values()) if (s.pending?.has(id)) return s.respond(id, decision);
  return undefined;
}
function interruptAll() {
  session?.interrupt();
  for (const s of paneSessions.values()) s.interrupt();
}
/**
 * A message to the chat, from the window, Telegram or the phone web app. Power-down words and
 * the sign-in check are handled first; every message is noted with where it came from.
 */
function submitMessage(payload, e = null) {
  const atts = Array.isArray(payload?.attachments) ? payload.attachments : [];
  const r = !loadConfig().cwd ? { ok: false, error: NO_WORKSPACE }
    : signedOut ? { ok: false, error: SIGNED_OUT } : sessionFor(e).send(payload);
  features.noteUser(payload?.text, payload?.origin || 'desk');
  // Every message is noted with where it came from, so its reply can go back there.
  try {
    remote.noteSend(payload?.origin === 'telegram' ? 'telegram' : 'desk', r, { text: typeof payload?.text === 'string' ? payload.text : '', attachments: atts });
  } catch (err) { log('remote:', err?.message || err); }
  return r;
}
/** Sign-in opens its own console window, as Settings does. */
function startSignInWindow() {
  if (!fs.existsSync(claudeExe())) return { ok: false, error: 'Claude Code is not installed here.' };
  if (process.env.JARVIS_CAPTURE) return { ok: true, started: true };
  const r = startLogin(claudeExe());
  log(r.ok ? 'sign-in window opened' : `could not open the sign-in window: ${r.error}`);
  return r;
}
let lastUpdateInfo = null; // the newest JARVIS version seen by the last check, for the health page
/** A second chat window, so two chats can sit side by side. */
function openPane() {
  paneCount += 1;
  const dark = nativeTheme.shouldUseDarkColors;
  const pw = new BrowserWindow({
    width: 980,
    height: 900,
    minWidth: 380,
    minHeight: 480,
    title: `JARVIS - chat ${paneCount + 1}`,
    backgroundColor: dark ? '#0d0e10' : '#f7f8f9',
    icon: windowIcon(),
    show: false,
    webPreferences: {
      preload: path.join(SRC, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  pw.loadFile(path.join(SRC, 'renderer', 'index.html'), { query: { pane: String(paneCount) } });
  pw.once('ready-to-show', () => pw.show());
  paneWindows.set(pw.webContents.id, pw);
  pw.webContents.once('destroyed', () => paneWindows.delete(pw.webContents.id));
  return { ok: true };
}
ipcMain.handle('window:newChat', () => openPane());

/** `claude.exe --version`, so the window can show it before the session's first reply. */
let ccVersion = null;
function claudeVersion() {
  if (ccVersion) return Promise.resolve(ccVersion);
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    execFile(claudeExe(), ['--version'], { timeout: 15000, windowsHide: true, env }, (err, out) => {
      const m = /(\d+\.\d+\.\d+)/.exec(String(out || ''));
      ccVersion = !err && m ? m[1] : null;
      resolve(ccVersion);
    });
  });
}

ipcMain.handle('jarvis:info', () => {
  const ws = activeWs();
  const cwd = ws?.path || null;
  return {
    cwd,
    cwdExists: !!cwd && fs.existsSync(cwd),
    workspace: ws ? { id: ws.id, name: ws.name, path: ws.path, trusted: workspaceTrusted() } : null,
    version: app.getVersion(),
    electron: process.versions.electron,
    exeFound: fs.existsSync(claudeExe()),
    capture: !!process.env.JARVIS_CAPTURE,
  };
});

// Settings > Updates. Checks only look; nothing installs until the user presses Update.
// The JARVIS repo is private, so its checks and downloads use a GitHub sign-in (see updates.mjs).
const GITHUB_TOKEN_FILE = savedTokenPath(userDir);
const tokenStore = { file: GITHUB_TOKEN_FILE, safe: safeStorage };
ipcMain.handle('updates:check', async (_e, tool) => {
  if (tool === 'jarvis') {
    // An update delivered on this PC answers by itself: no sign-in is looked up for it.
    const { token } = newerDelivery(userDir, app.getVersion()) ? { token: null } : await resolveToken(tokenStore);
    return jarvisStatus(app.getVersion(), { token, userDir })
      .then((s) => { lastUpdateInfo = s; return s; })
      .catch((e) => ({ current: app.getVersion(), available: false, needsSignIn: !!e.needsSignIn, error: e.message }));
  }
  if (tool === 'vscode') return vscodeStatus();
  if (tool === 'claude') return claudeStatus();
  return { error: 'Unknown tool.' };
});
ipcMain.handle('updates:connection', async () => {
  const { source } = await resolveToken(tokenStore);
  return { connected: !!source, source, savedByJarvis: source === 'saved' };
});
ipcMain.handle('updates:connect', async (_e, token) => {
  const t = String(token || '').trim();
  if (!t) return { ok: false, error: 'Paste your GitHub token first.' };
  try {
    if (!(await tokenCanSeeJarvis({ token: t }))) return { ok: false, error: 'That code did not work for JARVIS. Make sure you copied the whole code, and that it can read JarvisApp.' };
    saveToken(GITHUB_TOKEN_FILE, t, { safe: safeStorage });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('updates:disconnect', () => { clearToken(GITHUB_TOKEN_FILE); return { ok: true }; });
// The page where the token is made, opened in the browser (a fixed address, never from the window).
ipcMain.handle('updates:openGithub', () => shell.openExternal('https://github.com/settings/tokens?type=beta'));
ipcMain.handle('updates:run', async (_e, tool) => {
  if (tool === 'vscode') return vscodeUpdate();
  if (tool === 'claude') return claudeUpdate();
  if (tool !== 'jarvis') return { ok: false, error: 'Unknown tool.' };
  // A screenshot run opens and quits by itself; it must never replace the installed JARVIS.
  if (process.env.JARVIS_CAPTURE) return { ok: false, error: 'A screenshot run never installs an update.' };
  const progress =(p) => { if (win && !win.isDestroyed()) win.webContents.send('updates:progress', { tool: 'jarvis', ...p }); };
  try {
    const { token } = newerDelivery(userDir, app.getVersion()) ? { token: null } : await resolveToken(tokenStore);
    const r = await jarvisUpdate({
      currentVersion: app.getVersion(),
      tempDir: app.getPath('temp'),
      pid: process.pid,
      logPath,
      onProgress: progress,
      token,
      userDir,
    });
    if (r.ok && !r.upToDate) {
      // The updater waits for this process to exit, then installs and opens JARVIS again.
      // The window shows these notes once JARVIS is back on the new version ("What's new").
      saveConfig({ whatsNewPending: { version: r.version, notes: String(r.notes || '').slice(0, 4000) } });
      log(`system update to v${r.version} ${r.source === 'local' ? 'copied from this PC' : 'downloaded'} - JARVIS closes so it can install`);
      setTimeout(() => app.quit(), 500);
    }
    return r;
  } catch (e) {
    log(`system update failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
});

// An update built on this PC arrives as a note in the data folder (updates.mjs, "an update
// delivered on this PC"). Reading one local file reaches no network, so unlike a GitHub check
// it may happen unasked: the window is told when a newer build lands, and asks at start-up
// for one that landed while JARVIS was closed. Telling is all - installing takes the button.
function deliveredUpdate() {
  const d = newerDelivery(userDir, app.getVersion());
  return d ? { version: d.version, notes: d.notes.slice(0, 4000) } : null;
}
ipcMain.handle('updates:ready', () => deliveredUpdate());
let deliveryTimer = null;
function watchDeliveries() {
  // The version a note was written for is running now: the note has done its job. Only the
  // installed app tidies up, so a run from source cannot eat the note meant for it.
  if (app.isPackaged && readDelivery(userDir) && !newerDelivery(userDir, app.getVersion())) clearDelivery(userDir);
  try {
    fs.watch(userDir, (_ev, name) => {
      if (name !== DELIVERY_FILE) return;
      // The note is written through a rename, which Windows reports more than once.
      clearTimeout(deliveryTimer);
      deliveryTimer = setTimeout(() => {
        const ready = deliveredUpdate();
        if (ready) log(`update v${ready.version} delivered on this PC`);
        if (win && !win.isDestroyed()) win.webContents.send('updates:ready', ready);
      }, 400);
    });
  } catch (e) {
    log('could not watch for delivered updates:', e?.message || e);
  }
}

// The caption buttons' colours, matched to the header (--surface and --text-2 in styles.css).
// 40 px tall: the fullscreen phone's title strip is the same height, so the buttons sit
// exactly on it there, and on the 52 px header they sit in the same colour as the header.
const TITLE_BAR = {
  dark: { color: '#15171a', symbolColor: '#a4abb3', height: 40 },
  light: { color: '#ffffff', symbolColor: '#555d66', height: 40 },
};
ipcMain.handle('jarvis:titleBar', (e, theme) => {
  const t = TITLE_BAR[theme === 'light' ? 'light' : 'dark'];
  // Whichever window asked: JARVIS itself, or a phone in its own window.
  const target = BrowserWindow.fromWebContents(e.sender) || win;
  try { if (target && !target.isDestroyed()) target.setTitleBarOverlay(t); } catch { /* not supported here */ }
  try { if (target && !target.isDestroyed()) target.setBackgroundColor(theme === 'light' ? '#f7f8f9' : '#0d0e10'); } catch { /* cosmetic */ }
  return true;
});

// ---------------------------------------------------------------- workspaces
// The folders JARVIS can work in (workspaces.mjs), one active at a time. The session takes
// its folder when it is created, and so do the file index, the memory path, every git read,
// every flutter run and dotnet watch - so a switch is never applied in place: the choice is
// saved and JARVIS restarts into it, through the same shutdown as quitting.
// (projectIndex - the active workspace's discovered projects - is created near the top.)

/** Restart JARVIS - after a workspace switch or a new sign-in. One path, one shutdown. */
function restartJarvis(reason) {
  log(reason);
  // Give the reply a moment to reach the window, then stop everything this app started -
  // app.exit skips window-all-closed, and claude.exe, a dotnet watch or a flutter run left
  // behind would keep running against the old folder.
  setTimeout(async () => {
    await shutdownChildren();
    // Not --hidden (a JARVIS started at login would come back with no window) and not
    // --updated (it would announce the same update again): this restart is the person's.
    const keep = process.argv.slice(1).filter((a) => !['--restarted', '--hidden', '--updated'].includes(a));
    app.relaunch({ args: [...keep, '--restarted'] });
    app.exit(0);
  }, 400);
  return { ok: true, restarting: true };
}

/** What would stop if JARVIS restarted now - so the window can say so before a switch. */
function activeWork() {
  const busy = (s) => !!s && (!!s.running || s.pending?.size > 0);
  const busyChat = busy(session) || [...paneSessions.values()].some(busy);
  let flutter = 0;
  let web = 0;
  let analysis = 0;
  let dotnetAnalysis = 0;
  let gitRemote = 0;
  try { flutter = runningFlutter(); } catch { /* none */ }
  try { web = runningWebApps(); } catch { /* none */ }
  try { analysis = runningAnalysis(); } catch { /* none */ }
  try { dotnetAnalysis = runningDotnetAnalysis(); } catch { /* none */ }
  try { gitRemote = runningRemotes(); } catch { /* none */ }
  return { chat: busyChat, flutter, web, tasks: runningTasks().length, analysis, dotnetAnalysis, gitRemote, remote: !!remote.ready };
}

ipcMain.handle('jarvis:pickWorkspace', async () => {
  const cur = loadConfig().cwd;
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose a workspace folder - the one that holds your projects',
    defaultPath: cur && fs.existsSync(cur) ? cur : app.getPath('home'),
    properties: ['openDirectory'],
  });
  if (r.canceled || !r.filePaths?.[0]) return { ok: false, canceled: true };
  return { ok: true, path: r.filePaths[0] };
});
ipcMain.handle('workspaces:list', () => workspacesForWindow(rawConfig()));
ipcMain.handle('workspaces:busy', () => activeWork());
ipcMain.handle('workspaces:add', async (_e, dir, name) => {
  const r = await addWorkspace(rawConfig(), dir, { name });
  if (!r.ok) return r;
  if (!r.duplicate) { saveConfig(r.patch); log('workspace added:', r.workspace.path); }
  return { ok: true, duplicate: !!r.duplicate, workspace: { id: r.workspace.id, name: r.workspace.name, path: r.workspace.path } };
});
ipcMain.handle('workspaces:rename', (_e, id, name) => {
  const r = renameWorkspace(rawConfig(), id, name);
  if (!r.ok) return r;
  saveConfig(r.patch);
  return { ok: true, workspace: { id: r.workspace.id, name: r.workspace.name, path: r.workspace.path } };
});
/** Make a workspace active. Saved first, then JARVIS restarts into it. */
ipcMain.handle('workspaces:select', async (_e, id, opts) => {
  if (process.env.JARVIS_CAPTURE) return { ok: false, error: 'A screenshot run never switches workspaces.' };
  const trust = typeof opts?.trust === 'boolean' ? opts.trust : undefined;
  const r = await selectWorkspace(rawConfig(), id, { trust });
  if (!r.ok || r.unchanged) return r.ok ? { ok: true, unchanged: true } : r;
  saveConfig(r.patch);
  return restartJarvis(`workspace switched to ${r.workspace.path} (${r.workspace.trusted ? 'trusted' : 'restricted'}) - restarting`);
});
/**
 * Trust a workspace, or take trust back. Trusted: its .claude settings, hooks and MCP load
 * and its knowledge script may run. The active one restarts, so nothing half-applies.
 */
ipcMain.handle('workspaces:trust', (_e, id, trusted) => {
  if (process.env.JARVIS_CAPTURE) return { ok: false, error: 'A screenshot run never changes workspaces.' };
  const r = setWorkspaceTrust(rawConfig(), id, trusted === true);
  if (!r.ok) return r;
  saveConfig(r.patch);
  log(`workspace ${trusted === true ? 'trusted' : 'restricted'}:`, r.workspace.path);
  return r.active && r.changed ? restartJarvis('workspace trust changed - restarting') : { ok: true };
});
/** Forget a workspace. The folder is not touched. Forgetting the active one restarts. */
ipcMain.handle('workspaces:remove', (_e, id) => {
  if (process.env.JARVIS_CAPTURE) return { ok: false, error: 'A screenshot run never changes workspaces.' };
  const r = removeWorkspace(rawConfig(), id);
  if (!r.ok) return r;
  saveConfig(r.patch);
  log('workspace removed from the list:', r.removed.path);
  if (!r.switched) return { ok: true };
  return restartJarvis(`the active workspace was removed - restarting ${r.next ? `in ${r.next.path}` : 'with no workspace'}`);
});
/** The active workspace's projects (project-discovery.mjs, read-only). refresh: scan again. */
ipcMain.handle('workspaces:projects', async (_e, refresh) => {
  const ws = activeWs();
  const r = await projectIndex.get(ws, { refresh: !!refresh });
  return { ...r, workspace: ws ? { id: ws.id, name: ws.name, path: ws.path } : null };
});
// ---------------------------------------------------------------- project actions
// What can be done with a project (project-providers.mjs): jumps into existing views, and
// Build / Test / script tasks (task-runner.mjs). The window names a project and an action -
// never a command: the command is worked out here, from the project's own files, each time.
async function actionsFor(key) {
  const hit = await resolveProject(key);
  if (!hit) return null;
  const caps = await getCapabilities().catch(() => []);
  const trusted = workspaceTrusted();
  const inSourceControl = new Set(sourceRepos(hit.ws.path).map((x) => x.key));
  const actions = (await projectActions(hit.project, hit.dir, caps)).map((a) => {
    // Restricted: every action runs the folder's own code or configuration (Git included).
    if (!trusted) return { ...a, available: false, reason: RESTRICTED_RUN };
    // Source Control lists repositories down to two folders; a deeper one is not offered there.
    if (a.id === 'git' && !inSourceControl.has(a.repoKey)) {
      return { ...a, available: false, reason: 'Source Control shows the repositories at the top of the workspace and up to two folders down - this one is deeper. Ask JARVIS, or open it in a terminal.' };
    }
    return a;
  });
  return { hit, actions, trusted };
}
ipcMain.handle('projects:actions', async (_e, key) => {
  const r = await actionsFor(key);
  if (!r) return { ok: false, error: 'That project is not in this workspace.' };
  return { ok: true, key: r.hit.project.id, actions: r.actions.map(actionForWindow) };
});
ipcMain.handle('projects:run', async (_e, key, actionId) => {
  if (typeof actionId !== 'string') return { ok: false, error: 'Unknown action.' };
  const r = await actionsFor(key);
  if (!r) return { ok: false, error: 'That project is not in this workspace.' };
  const a = r.actions.find((x) => x.id === actionId);
  if (!a || a.kind !== 'task') return { ok: false, error: 'Unknown action.' };
  if (!a.available) return { ok: false, error: a.reason || 'That cannot run on this PC.' };
  try {
    const run = startTask({ ...a.spec, cwd: r.hit.dir, projectKey: r.hit.project.id, actionId: a.id, label: `${a.label} - ${r.hit.project.displayName || r.hit.project.name}` }, send);
    log('project task started', r.hit.project.id, a.id, `(${run.command})`);
    return { ok: true, run };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});
/**
 * One project, as the Projects view shows it: what it is, what it needs from this PC and
 * whether that is here, what can be done with it, and the person's own settings for it.
 */
ipcMain.handle('projects:detail', async (_e, key) => {
  const r = await actionsFor(key);
  if (!r) return { ok: false, error: 'That project is not in this workspace.' };
  const caps = await getCapabilities().catch(() => []);
  const installed = new Map(caps.filter((c) => c.installed).map((c) => [c.id, c]));
  const p = r.hit.project;
  const needs = requirementsFor(p).map((group) => {
    const by = group.find((id) => installed.has(id)) || null;
    const first = caps.find((c) => c.id === group[0]);
    return { ids: group, label: first?.label || group[0], met: !!by, by: by ? { id: by, label: installed.get(by).label, version: installed.get(by).version || null } : null, hint: by ? null : INSTALL_HINT[group[0]] || null };
  });
  const settings = projectSettings(r.hit.ws, p.relativePath);
  const repos = sourceRepos(r.hit.ws.path);
  const repo = repos.find((x) => x.key === p.relativePath) || null;
  return {
    ok: true,
    project: { id: p.id, name: p.name, displayName: p.displayName, foundName: p.foundName, relativePath: p.relativePath, types: p.types, role: p.role, parentId: p.parentId, children: p.children, meta: p.meta, warning: p.warning || null },
    settings: { name: settings.name || '', warning: settings.warning || '', casePrefix: settings.casePrefix || '' },
    needs,
    actions: r.actions.map(actionForWindow),
    repoKey: repo ? repo.key : null,
    restricted: !r.trusted,
  };
});
/** The machine's developer tools, for onboarding and Settings: names and versions, never paths. */
ipcMain.handle('capabilities:list', async (_e, refresh) => (await getCapabilities({ force: refresh === true }).catch(() => []))
  .map((c) => ({ id: c.id, label: c.label, installed: c.installed, version: c.version, configured: c.configured })));
/**
 * Onboarding: what is in a workspace that was just added, before switching to it - looked at,
 * not changed. Only a folder already in the list (added through the folder dialog and checked
 * there) can be looked at, never a path from the window.
 */
ipcMain.handle('workspaces:preview', async (_e, id) => {
  const ws = workspacesForWindow(rawConfig()).workspaces.find((w) => w.id === id);
  if (!ws) return { ok: false, error: 'That workspace is not in the list.' };
  const r = await discoverProjects(ws.path, { maxDirs: 8000 });
  const caps = await getCapabilities().catch(() => []);
  const rel = capabilityRelevance(r.projects, caps);
  const tops = r.projects.filter((p) => p.parentId === null);
  return {
    ok: !r.errors.some((e) => e.path === ws.path),
    error: r.errors[0]?.error || null,
    truncated: r.truncated,
    count: r.projects.length,
    projects: tops.slice(0, 60).map((p) => ({ id: p.id, name: p.displayName || p.name, types: p.types })),
    needs: Object.entries(rel).filter(([, v]) => v.used).map(([id, v]) => {
      const c = caps.find((x) => x.id === id);
      return { id, label: c?.label || id, installed: !!c?.installed, version: c?.version || null, unmet: v.unmet, hint: c?.installed ? null : INSTALL_HINT[id] || null };
    }),
  };
});
ipcMain.handle('projects:stop', (_e, id) => (typeof id === 'string' ? stopTask(id) : { ok: false, error: 'Unknown task.' }));
ipcMain.handle('projects:tasks', () => runningTasks());
ipcMain.handle('projects:taskLog', (_e, id) => (typeof id === 'string' ? taskLog(id) : []));

/** A person's own name or Run warning for one project. Stored in config, never in the project. */
ipcMain.handle('workspaces:projectSettings', (_e, relPath, patch) => {
  const ws = activeWs();
  if (!ws) return { ok: false, error: NO_WORKSPACE };
  const r = setProjectSettings(rawConfig(), ws.id, relPath, patch && typeof patch === 'object' ? patch : {});
  if (!r.ok) return r;
  saveConfig(r.patch);
  return { ok: true, settings: r.settings };
});
// The older one-step call (the setup walk-through, New project): add the folder if it is
// new, make it active, restart. Same checks as above.
ipcMain.handle('jarvis:setWorkspace', async (_e, dir) => {
  if (process.env.JARVIS_CAPTURE) return { ok: false, error: 'A screenshot run never switches workspaces.' };
  const added = await addWorkspace(rawConfig(), dir);
  if (!added.ok) return added;
  if (!added.duplicate) saveConfig(added.patch);
  const r = await selectWorkspace(rawConfig(), added.workspace.id);
  if (!r.ok) return r;
  if (r.unchanged) return { ok: true, unchanged: true };
  saveConfig(r.patch);
  return restartJarvis(`workspace changed to ${r.workspace.path} - restarting`);
});

/**
 * Stop everything this app started: the Claude Code sessions (the main chat and any side
 * chat), any web app or API run from the Devices view, phone mirrors and flutter runs, a
 * project scan. The apps stay installed on the phones. Bounded at three seconds, so a phone
 * that never answers cannot hold the app open.
 */
async function shutdownChildren() {
  try { remote.stop(); } catch { /* shutting down */ }
  try { await features.stop(); } catch { /* shutting down */ }
  try { session?.close(); } catch { /* shutting down */ }
  closeAllPanes();
  try { shutdownWebApps(); } catch { /* shutting down */ }
  try { shutdownAnalysis(); } catch { /* shutting down */ }
  try { shutdownDotnetAnalysis(); } catch { /* shutting down */ }
  try { shutdownTasks(); } catch { /* shutting down */ }
  try { cancelAllRemotes(); } catch { /* shutting down */ }
  try { projectIndex.stop(); } catch { /* shutting down */ }
  await Promise.race([shutdownDevices().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
}
ipcMain.handle('jarvis:claudeVersion', () => (fs.existsSync(claudeExe()) ? claudeVersion() : null));

// ---------------------------------------------------------------- IPC: the account
// Claude Code owns the credentials; JARVIS only asks who is signed in, and runs its own
// sign-in and sign-out commands. Nothing secret crosses this boundary.
// Signed out: nothing can be sent until the account is back, so the window and the phone are
// told plainly, instead of "the session is not running". A readable "not signed in" answer
// sets it; a failed check never does (that would look like signed out when it is not).
let signedOut = false;
const SIGNED_OUT = "You're signed out. Sign in from Settings to carry on.";
function noteAccount(r) {
  if (r?.ok && r.loggedIn === true) signedOut = false;
  else if (r?.ok && r.loggedIn === false && !r.unreadable) signedOut = true;
  return r;
}
ipcMain.handle('jarvis:authStatus', async () => (fs.existsSync(claudeExe()) ? noteAccount(await authStatus(claudeExe())) : { ok: false, loggedIn: false, error: 'Claude Code is not installed here.' }));
ipcMain.handle('jarvis:authLogin', () => {
  if (!fs.existsSync(claudeExe())) return { ok: false, error: 'Claude Code is not installed here.' };
  if (process.env.JARVIS_CAPTURE) { log('capture: would open the sign-in window'); return { ok: true, started: true }; }
  const r = startLogin(claudeExe());
  log(r.ok ? 'sign-in window opened' : `could not open the sign-in window: ${r.error}`);
  return r;
});
ipcMain.handle('jarvis:authLogout', async () => {
  if (!fs.existsSync(claudeExe())) return { ok: false, error: 'Claude Code is not installed here.' };
  if (process.env.JARVIS_CAPTURE) { log('capture: would sign out'); return { ok: false, error: 'Signing out is disabled during a screenshot run.' }; }
  const r = await authLogout(claudeExe());
  if (!r.ok) { log('sign out failed:', r.error); return r; }
  // The running claude.exe holds the old credentials; it goes with them, and the next
  // start brings up a fresh one. The window is told, so the chat does not look alive.
  try { session?.close(); } catch { /* already gone */ }
  session = null;
  signedOut = true;
  log('signed out of the Anthropic account');
  // Window only: the phone and the Telegram watchers must not be told a turn just ended.
  // "closed" (not "ready"): the window then knows to start a session again, which is refused
  // with the plain sign-in message until the account is back.
  toWindow({ kind: 'status', state: 'closed' });
  return { ok: true };
});
/** Restart JARVIS itself - how a new sign-in is picked up everywhere at once. */
ipcMain.handle('jarvis:restartApp', () => restartJarvis('restarting at the window\'s request'));
ipcMain.handle('jarvis:start', async (_e, opts) => {
  // No workspace, no session: Claude Code always works IN a folder, and there is no default.
  if (!loadConfig().cwd) { toWindow({ kind: 'status', state: 'closed' }); return { ok: false, error: NO_WORKSPACE, needsWorkspace: true }; }
  // Starting with nobody signed in would only fail inside the session; say so here instead.
  if (fs.existsSync(claudeExe())) {
    noteAccount(await authStatus(claudeExe()));
    if (signedOut) { toWindow({ kind: 'status', state: 'closed' }); return { ok: false, error: SIGNED_OUT }; }
  }
  remote.sessionStarted();
  sessionFor(_e).start(opts || {});
  return true;
});
/**
 * "Power down", typed at the desk or sent from the phone or the group: JARVIS goes to sleep.
 * The window closes and the session, the web apps and the phone mirrors stop, but the
 * Telegram listener stays in the tray so "Wake up" can bring it all back. Without remote
 * control there is nothing to wake it from, so it is an ordinary quit instead.
 * The phone is told by remote.mjs when the phone asked; here only when the desk did.
 */
function powerDown(from) {
  if (asleep) return;
  if (!remote.ready) { log('power down from the desk - quitting (remote control is off)'); app.quit(); return; }
  asleep = true;
  log('power down from the', from, '- asleep in the tray');
  if (from === 'desk') remote.announce(sleepNotice(pcLabel()));
  remote.sessionStarted();
  // Left running with the window gone and nothing watching it, a build/test run, Dart
  // analysis or a git fetch/pull/push would be invisible and could outlive the sleep
  // entirely. They are stopped the same as on a restart or a quit (shutdownChildren);
  // power-down itself still asks nothing first (that is the point of it being instant), so
  // the phone is told what got stopped instead, never left to find out by surprise later.
  const stopped = describeStoppedWork(activeWork());
  try { shutdownTasks(); } catch { /* going to sleep */ }
  try { shutdownAnalysis(); } catch { /* going to sleep */ }
  try { shutdownDotnetAnalysis(); } catch { /* going to sleep */ }
  try { cancelAllRemotes(); } catch { /* going to sleep */ }
  if (stopped.length) {
    log('power down also stopped:', stopped.join(', '));
    remote.announce(`⏹️ Also stopped, since power down does not wait for anything to finish: ${stopped.join(', ')}.`);
  }
  try { session?.close(); } catch { /* going to sleep */ }
  session = null;
  // Every secondary chat window too - "asleep" means no session of this app's is still
  // running, not just the one behind the main window. Each one is a real, visible window
  // closing, same as the main one; nothing more needs to be said about it on the phone.
  closeAllPanes();
  try { shutdownWebApps(); } catch { /* going to sleep */ }
  shutdownDevices().catch(() => {});
  // destroy, not close: close would only hide it to the tray. window-all-closed sees `asleep`.
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
  syncBackground();
  presence.set('asleep');
}
/** "Wake up", or the tray clicked while asleep: the window again, with a fresh session. */
function wakeUp(from) {
  if (!asleep) return;
  asleep = false;
  log('wake up from the', from);
  showWindow();
  syncBackground();
  presence.set('awake');
  if (from === 'desk') remote.announce(`☀️ ${greeting(new Date(), pcLabel())}`);
}
ipcMain.handle('jarvis:send', (_e, payload) => {
  const atts = Array.isArray(payload?.attachments) ? payload.attachments : [];
  if (payload?.origin !== 'telegram' && !atts.length && isPowerDown(payload?.text, phoneConfig().telegram.pcName)) {
    powerDown('desk');
    return { ok: true };
  }
  return submitMessage(payload, _e);
});
ipcMain.handle('jarvis:interrupt', (_e) => sessionFor(_e).interrupt());
ipcMain.handle('jarvis:respond', (_e, id, decision) => { features.noteDecision(id, decision, 'desk'); sessionFor(_e).respond(id, decision); return true; });
ipcMain.handle('jarvis:setModel', (_e, model) => sessionFor(_e).setModel(model));
ipcMain.handle('jarvis:setMode', (_e, mode) => {
  // Deliberately no bypass: the window only offers modes that still check before acting.
  if (!WINDOW_MODES.includes(mode)) return false;
  return sessionFor(_e).setPermissionMode(mode);
});
ipcMain.handle('jarvis:setEffort', (_e, level) => sessionFor(_e).setEffort(level));
ipcMain.handle('jarvis:setThinking', (_e, on) => sessionFor(_e).setThinking(on));
ipcMain.handle('jarvis:context', (_e, detail) => sessionFor(_e).refreshContext(detail === 'full' ? 'full' : 'summary'));
// Conversations belong to a folder (Claude Code keeps them per project). With no workspace
// there are none to show - never another folder's.
ipcMain.handle('jarvis:sessions', async () => {
  const { cwd } = loadConfig();
  if (!cwd) return [];
  try { return await listRecent(cwd); }
  catch (e) { log('listSessions failed', e?.message || e); return []; }
});
ipcMain.handle('jarvis:history', async (_e, id) => {
  const { cwd } = loadConfig();
  if (!cwd) return [];
  try { return await loadHistory(cwd, id); }
  catch (e) { log('history failed', e?.message || e); return []; }
});
ipcMain.handle('jarvis:findSessions', async (_e, text) => {
  const { cwd } = loadConfig();
  if (!cwd) return [];
  try { return await findSessions(cwd, text); }
  catch (e) { log('findSessions failed', e?.message || e); return []; }
});
/** Permanently delete a session. This app's own conversation is closed first; the window then starts a new one. */
ipcMain.handle('jarvis:deleteSession', async (_e, id) => {
  if (!isSessionId(id)) return { ok: false, error: 'That is not a session id.' };
  if (!loadConfig().cwd) return { ok: false, error: NO_WORKSPACE }; // never another folder's conversation
  const own = !!session && session.sessionId === id;
  try {
    if (own) session.close();
    await removeSession(loadConfig().cwd, id, { waitMs: own ? 8000 : 0 });
    log('session deleted', id);
    return { ok: true, own };
  } catch (e) {
    log('deleteSession failed', id, e?.message || e);
    return { ok: false, own, error: e?.message || String(e) };
  }
});
/** Rename a session. The live one goes through Claude Code's own /rename, so its in-memory title agrees. */
ipcMain.handle('jarvis:renameSession', async (_e, id, title) => {
  const t = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '';
  if (!isSessionId(id)) return { ok: false, error: 'That is not a session id.' };
  if (!t || t.length > 100) return { ok: false, error: 'A title is 1 to 100 characters.' };
  if (!loadConfig().cwd) return { ok: false, error: NO_WORKSPACE };
  try {
    if (session && session.sessionId === id && session.canRenameLive) {
      const r = session.send(`/rename ${t}`);
      return r.ok ? { ok: true, title: t } : r;
    }
    await renameStoredSession(loadConfig().cwd, id, t);
    return { ok: true, title: t };
  } catch (e) {
    log('renameSession failed', id, e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
});
/** Undo the file changes made since a user message. dryRun lists them without touching anything. */
ipcMain.handle('jarvis:rewind', async (_e, uuid, dryRun) => {
  if (!isSessionId(uuid)) return { canRewind: false, error: 'That message has no id to rewind to.' };
  const r = await sessionFor(_e).rewindFiles(uuid, dryRun !== false);
  if (dryRun === false) log('rewind', uuid, JSON.stringify({ ok: r.canRewind, error: r.error || null, skippedLinks: r.skippedLinks || 0 }));
  return r;
});

/** File picker for the + button. Images come back as data; other files as a path to reference. */
ipcMain.handle('jarvis:pickFiles', async () => {
  if (!win) return [];
  const r = await dialog.showOpenDialog(win, { title: 'Attach to message', defaultPath: loadConfig().cwd, properties: ['openFile', 'multiSelections'] });
  if (r.canceled) return [];
  const out = [];
  for (const p of r.filePaths.slice(0, 10)) {
    try {
      const st = await fsp.stat(p);
      const ext = path.extname(p).toLowerCase().replace('.', '');
      const mediaType = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[ext];
      if (mediaType && IMAGE_TYPES.includes(mediaType) && st.size <= MAX_IMAGE_BYTES) {
        out.push({ kind: 'image', name: path.basename(p), mediaType, data: (await fsp.readFile(p)).toString('base64'), size: st.size });
      } else {
        out.push({ kind: 'file', name: path.basename(p), path: p, size: st.size });
      }
    } catch (e) { log('attach failed', p, e?.message || e); }
  }
  return out;
});

/**
 * An attachment chip clicked in the chat. A file from the phone opens in its own app; any
 * other attached file is only shown in Explorer - the window never launches arbitrary paths.
 */
ipcMain.handle('jarvis:openAttachment', async (_e, p) => {
  if (typeof p !== 'string' || !p || !path.isAbsolute(p) || !fs.existsSync(p)) return { ok: false, error: 'That file is no longer there.' };
  if (inInbox(p)) {
    const err = await shell.openPath(p);
    if (!err) return { ok: true };
  }
  shell.showItemInFolder(p);
  return { ok: true };
});

// ---------------------------------------------------------------- IPC: devices (phones)
// A phone can have its own window (phone.html), like scrcpy. While it is open, that phone's
// video goes there and nowhere else - it is never decoded twice - and its events go to both,
// so the Devices card can say where the phone went. Closing the window brings it back.
// (phoneWindows is declared beside toWindow, near the top.)

/** Video packets go on their own channel: dozens a second, never through the chat event path. */
function sendVideo(p) {
  const pw = phoneWindows.get(p.serial);
  if (pw && !pw.isDestroyed()) { pw.webContents.send('jarvis:video', p); return; }
  if (win && !win.isDestroyed()) win.webContents.send('jarvis:video', p);
}

function openPhoneWindow(serial) {
  const had = phoneWindows.get(serial);
  const capture = !!process.env.JARVIS_CAPTURE;
  if (had && !had.isDestroyed()) {
    if (!capture) { had.show(); had.focus(); }
    return { ok: true, already: true };
  }
  const dark = nativeTheme.shouldUseDarkColors;
  const pw = new BrowserWindow({
    width: 440,
    height: 900,
    minWidth: 300,
    minHeight: 480,
    title: 'Phone - JARVIS',
    backgroundColor: dark ? '#0d0e10' : '#f7f8f9',
    icon: windowIcon(),
    titleBarStyle: 'hidden',
    titleBarOverlay: TITLE_BAR[dark ? 'dark' : 'light'],
    show: false,
    webPreferences: {
      preload: path.join(SRC, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // On screen beside other windows, so it keeps drawing when it is not the focused one.
      backgroundThrottling: false,
    },
  });
  // The phone this window currently shows. Fixed at open, but can change later if the
  // window rebinds itself to a replacement phone (see the 'rebind' action below) - every
  // closure that outlives a possible rebind reads it from here, never from the `serial`
  // parameter, so it never goes stale.
  pw.currentSerial = serial;
  phoneWindows.set(serial, pw);
  pw.loadFile(path.join(SRC, 'renderer', 'phone.html'), { query: { serial } });
  pw.once('ready-to-show', () => {
    // A capture run (debug aid) keeps it off-screen and never takes focus, like the main window.
    if (capture) { place(pw, { x: -5000, y: 0, width: 440, height: 900 }); pw.showInactive(); }
    else pw.show();
  });
  pw.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  pw.webContents.on('will-navigate', (e) => e.preventDefault());
  pw.webContents.on('console-message', (e, lvl, msg) => {
    const level = e?.level ?? lvl;
    if (level === 'error' || level === 3) log('[phone window error]', pw.currentSerial, String(e?.message ?? msg));
  });
  pw.on('closed', () => {
    const cur = pw.currentSerial;
    if (phoneWindows.get(cur) === pw) phoneWindows.delete(cur);
    toWindow({ kind: 'phone_docked', serial: cur });
    log('phone window closed', cur);
  });
  wireDocking(pw);
  toWindow({ kind: 'phone_popped', serial });
  log('phone window opened', serial);
  return { ok: true };
}

// ---------------------------------------------------------------- phone window docking
// Drag a phone's window onto JARVIS's left edge and let go: it docks there at full height and
// JARVIS makes room beside it, like Windows Snap. While it is being dragged, JARVIS shows
// where it will land. Dragging it away or closing it gives JARVIS its old size back. The
// geometry is dock.mjs; this only reads bounds and applies them.
let dock = null;          // { serial, width, at: {x, y}, prev: { maximized, bounds } }
let ownMoveUntil = 0;     // our own setBounds fires move / resize events too: ignored until then
const ours = () => Date.now() < ownMoveUntil;
function place(w, b) {
  if (!w || w.isDestroyed()) return;
  ownMoveUntil = Date.now() + 700;
  w.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });
}

/** Where JARVIS is: its window, or the screen's work area when maximized. Null if hidden. */
function jarvisArea() {
  if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return null;
  return win.isMaximized() ? screen.getDisplayMatching(win.getBounds()).workArea : win.getBounds();
}

function dockPhone(serial, pw, { keepPrev = false } = {}) {
  const area = jarvisArea();
  if (!area || !pw || pw.isDestroyed()) return;
  const prev = keepPrev && dock ? dock.prev
    : { maximized: win.isMaximized(), bounds: win.isMaximized() ? win.getNormalBounds() : win.getBounds() };
  const l = dockLayout(area, pw.getBounds().width);
  ownMoveUntil = Date.now() + 900;
  if (win.isMaximized()) win.unmaximize();
  place(pw, l.phone);
  place(win, l.jarvis);
  dock = { serial, width: l.width, at: { x: l.phone.x, y: l.phone.y }, prev };
  log('phone window docked', serial, `${l.width}px`);
}

function undockPhone({ restore = true } = {}) {
  if (!dock) return;
  const { prev, serial } = dock;
  dock = null;
  if (restore && win && !win.isDestroyed()) {
    ownMoveUntil = Date.now() + 900;
    if (prev.maximized) win.maximize();
    else if (prev.bounds) win.setBounds(prev.bounds);
  }
  log('phone window undocked', serial);
}

let hintOn = false;
/** The drop zone shown in JARVIS while a phone window is dragged over its left edge. */
function snapHint(on, width = 0) {
  if (on === hintOn) return;
  hintOn = on;
  if (win && !win.isDestroyed()) win.webContents.send('jarvis:event', { kind: 'phone_snap_hint', on, width });
}

function wireDocking(pw) {
  pw.on('move', () => {
    if (ours() || dock) return;
    const area = jarvisArea();
    const b = pw.getBounds();
    snapHint(inSnapZone(b, area), area ? dockWidth(b.width, area) : 0);
  });
  // 'moved' comes once, when the drag ends: that is the drop.
  pw.on('moved', () => {
    snapHint(false);
    if (ours()) return;
    const serial = pw.currentSerial;
    if (dock?.serial === serial) { if (!stillDocked(pw.getBounds(), dock.at)) undockPhone(); return; }
    if (!dock && inSnapZone(pw.getBounds(), jarvisArea())) dockPhone(serial, pw);
  });
  pw.on('resized', () => {
    if (ours() || dock?.serial !== pw.currentSerial || !win || win.isDestroyed()) return;
    const p = pw.getBounds();
    const j = win.getBounds();
    dock.width = p.width;
    place(win, afterPhoneResize(p, { x: dock.at.x, y: p.y, width: j.x + j.width - dock.at.x, height: p.height }));
  });
  pw.on('closed', () => {
    snapHint(false);
    if (dock?.serial === pw.currentSerial) undockPhone();
  });
}

/** JARVIS moved, resized or maximized by hand while a phone is docked: keep them together. */
function wireDockFollow() {
  const follow = () => {
    if (ours() || !dock) return;
    const pw = phoneWindows.get(dock.serial);
    if (!pw || pw.isDestroyed()) { dock = null; return; }
    const b = followLayout(win.getBounds(), dock.width);
    place(pw, b);
    dock.at = { x: b.x, y: b.y };
  };
  win.on('moved', follow);
  win.on('resized', follow);
  win.on('maximize', () => {
    if (ours() || !dock) return;
    const pw = phoneWindows.get(dock.serial);
    if (pw && !pw.isDestroyed()) dockPhone(dock.serial, pw, { keepPrev: true });
  });
}

/** The right-click menu's Cut / Copy / Paste, on whichever window asked - as Ctrl+X / C / V. */
ipcMain.handle('jarvis:edit', (e, cmd) => {
  const wc = e.sender;
  if (cmd === 'cut') wc.cut();
  else if (cmd === 'copy') wc.copy();
  else if (cmd === 'paste') wc.paste();
  else return false;
  return true;
});

/** open | focus | close | dock (close it and bring JARVIS forward) | rebind (switch phone). */
ipcMain.handle('jarvis:phoneWindow', (_e, serial, action, extra) => {
  if (!isSerial(serial)) return { ok: false, error: 'Not a device serial.' };
  const pw = phoneWindows.get(serial);
  const alive = pw && !pw.isDestroyed();
  if (action === 'open') return openPhoneWindow(serial);
  if (action === 'focus') { if (alive) { pw.show(); pw.focus(); } return { ok: !!alive }; }
  if (action === 'close' || action === 'dock') {
    if (alive) pw.close();
    if (action === 'dock' && win && !win.isDestroyed()) { win.show(); win.focus(); }
    return { ok: true };
  }
  if (action === 'rebind') {
    // The window keeps running, now pointed at a different phone - unplugged and replaced,
    // or picked by hand. The window itself drives this (it notices the replacement); this
    // only moves the bookkeeping, so every event and video packet for the new serial finds
    // this window from here on, and the old slot is free for the Devices card to reclaim.
    if (!alive) return { ok: false, error: 'That window is not open.' };
    if (!isSerial(extra)) return { ok: false, error: 'Not a device serial.' };
    if (extra === serial) return { ok: true };
    if (phoneWindows.has(extra)) return { ok: false, error: 'That phone already has its own window.' };
    phoneWindows.delete(serial);
    phoneWindows.set(extra, pw);
    pw.currentSerial = extra;
    if (dock && dock.serial === serial) dock.serial = extra;
    toWindow({ kind: 'phone_docked', serial });
    toWindow({ kind: 'phone_popped', serial: extra });
    log('phone window switched phone', serial, '->', extra);
    return { ok: true };
  }
  return { ok: false, error: 'Unknown action.' };
});

ipcMain.handle('jarvis:devices', async () => {
  try {
    const list = await listDevices();
    return { ok: true, list: list.map((d) => ({ ...d, popped: phoneWindows.has(d.serial) })) };
  } catch (e) { log('listDevices failed', e?.message || e); return { ok: false, error: String(e?.message || e), list: [] }; }
});
/**
 * A discovered project of the active workspace, by its id, with its folder checked again
 * against the workspace at the moment of use (project-providers.mjs, projectDir) - or null.
 * Every Run, Analyse and Stop goes through here: nothing acts on a name from the window.
 */
async function resolveProject(key, accept) {
  const ws = activeWs();
  if (!ws || typeof key !== 'string' || !key || key.length > 400) return null;
  const p = await projectIndex.find(ws, key);
  if (!p || (accept && !accept(p))) return null;
  const dir = projectDir(ws.path, p);
  return dir ? { project: p, dir, ws } : null;
}
const isDartProject = (p) => p.types.includes('dart') && p.role !== 'platform';
const isFlutterApp = (p) => p.types.includes('flutter') && !!p.meta?.app && p.role !== 'platform';
const isDotnetProject = (p) => p.types.includes('dotnet') && p.role !== 'platform';
const runTarget = (hit) => ({ key: hit.project.id, name: hit.project.displayName || hit.project.name, dir: hit.dir, rel: hit.project.relativePath });

// Dart analysis (analysis.mjs): what is wrong with a project, for the Devices view. Reading only.
ipcMain.handle('jarvis:analyze', async (_e, key) => {
  // dart analyze can load analyzer plugins the project names: the project's code, so trust first.
  if (!workspaceTrusted()) return { ok: false, restricted: true, error: RESTRICTED_RUN };
  const hit = await resolveProject(key, isDartProject);
  if (!hit) return { ok: false, error: 'That project is not in this workspace.' };
  const r = await analyzeApp(runTarget(hit), { log });
  if (r.ok) log('dart analyze', key, `${r.counts.error} errors, ${r.counts.warning} warnings, ${r.counts.hint} hints`, `${r.ms} ms`);
  return r;
});
ipcMain.handle('jarvis:analyzeCancel', (_e, key) => (typeof key === 'string' ? cancelAnalysis(key) : false));
// .NET build diagnostics (dotnet-analysis.mjs): the same idea, for ASP.NET sites, APIs,
// libraries and test projects - what Visual Studio's own Error List shows. Reading only: a
// real `dotnet build` runs (there is no dry-run diagnostic mode), so this is trust-gated
// exactly as the Dart analyser and the Build/Test task actions already are.
ipcMain.handle('jarvis:dotnetAnalyze', async (_e, key) => {
  if (!workspaceTrusted()) return { ok: false, restricted: true, error: RESTRICTED_RUN };
  const hit = await resolveProject(key, isDotnetProject);
  if (!hit) return { ok: false, error: 'That project is not in this workspace.' };
  const list = await dotnetProjectsFrom(hit.ws.path, [hit.project]);
  const target = list.find((a) => a.key === hit.project.id)?.target || null;
  if (!target) return { ok: false, error: `${hit.project.displayName || hit.project.name} has no project or solution file dotnet build can target.` };
  const dotnet = (await getCapabilities()).find((c) => c.id === 'dotnet' && c.installed)?.where || null;
  const r = await analyzeDotnet({ ...runTarget(hit), target }, { dotnet, log });
  if (r.ok) log('dotnet build (analysis)', key, `${r.counts.error} errors, ${r.counts.warning} warnings`, `${r.ms} ms`);
  return r;
});
ipcMain.handle('jarvis:dotnetAnalyzeCancel', (_e, key) => (typeof key === 'string' ? cancelDotnetAnalysis(key) : false));
/** The workspace's Flutter APPS (what a phone can run), discovered - never a fixed list. */
ipcMain.handle('jarvis:flutterApps', async () => {
  const ws = activeWs();
  return ws ? flutterApps((await projectIndex.get(ws)).projects || []) : [];
});
/** Every Dart and Flutter project, packages too - what Dart analysis can look at. */
ipcMain.handle('jarvis:dartProjects', async () => {
  const ws = activeWs();
  return ws ? dartProjects((await projectIndex.get(ws)).projects || []) : [];
});
/** Every .NET project with something to build - what the build-diagnostics panel can look at. */
ipcMain.handle('jarvis:dotnetProjects', async () => {
  const ws = activeWs();
  if (!ws) return [];
  const list = await dotnetProjectsFrom(ws.path, (await projectIndex.get(ws)).projects || []);
  // This PC's absolute paths (absDir, target) stay in the main process - the window is told
  // only the key it hands back to ask for an analysis, the same as every other project list.
  return list.map((a) => ({ key: a.key, name: a.name, kind: a.kind, dir: a.dir, found: a.found }));
});
ipcMain.handle('jarvis:mirror', async (_e, serial, on) => {
  if (!isSerial(serial)) return { ok: false, error: 'Not a device serial.' };
  try {
    if (on) await startMirror(serial, { video: sendVideo, event: send, log });
    else await stopMirror(serial);
    return { ok: true };
  } catch (e) {
    log('mirror failed', serial, e?.stack || e);
    return { ok: false, error: String(e?.message || e) };
  }
});
ipcMain.handle('jarvis:resetVideo', (_e, serial) => (isSerial(serial) ? resetVideo(serial) : null));
// Fire-and-forget: touch moves arrive many times a second.
ipcMain.on('jarvis:deviceInput', (_e, serial, ev) => {
  if (isSerial(serial)) sendInput(serial, ev).catch((err) => log('device input failed', serial, err?.message || err));
});
ipcMain.handle('jarvis:flutterRun', async (_e, serial, key) => {
  if (!isSerial(serial)) return { ok: false, error: 'Not a device serial.' };
  // A run builds the app - its Gradle scripts and plugins included: the project's own code.
  if (!workspaceTrusted()) return { ok: false, restricted: true, error: RESTRICTED_RUN };
  const hit = await resolveProject(key, isFlutterApp);
  if (!hit) return { ok: false, error: 'That app is not in this workspace.' };
  try { return { ok: true, run: flutterRun(runTarget(hit), serial, send) }; }
  catch (e) { return { ok: false, error: String(e?.message || e) }; }
});
ipcMain.handle('jarvis:flutterCmd', (_e, serial, cmd) => (isSerial(serial) ? flutterCommandFor(serial, cmd) : { ok: false, error: 'Not a device serial.' }));
ipcMain.handle('jarvis:flutterLog', (_e, serial) => (isSerial(serial) ? flutterLog(serial) : []));

// ---------------------------------------------------------------- IPC: phone alerts
ipcMain.handle('jarvis:phoneState', async () => {
  const cfg = phoneConfig();
  let phones = [];
  try { phones = await listPhones(); } catch (e) { log('listPhones failed', e?.message || e); }
  // A Wi-Fi phone drops off when it reboots or the network changes; try once to get it back.
  if (cfg.address && !phones.some((p) => p.serial === cfg.address)) {
    const r = await phoneConnect(cfg.address);
    if (r.ok) { phone.reset(); try { phones = await listPhones(); } catch { /* keep what we had */ } }
  }
  return { ...phoneConfigForWindow(cfg), phones, connected: phones.some((p) => p.serial === cfg.serial && p.state === 'device') };
});
ipcMain.handle('jarvis:phoneSet', (_e, patch) => {
  const cur = phoneConfig();
  const p = patch && typeof patch === 'object' ? patch : {};
  const t = p.telegram && typeof p.telegram === 'object' ? p.telegram : {};
  const next = {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : cur.enabled,
    remote: typeof p.remote === 'boolean' ? p.remote : cur.remote,
    mirror: typeof p.mirror === 'boolean' ? p.mirror : cur.mirror,
    route: p.route === 'telegram' || p.route === 'adb' ? p.route : cur.route,
    serial: p.serial === null ? null : (isSerial(p.serial) ? p.serial : cur.serial),
    address: p.address === null ? null : (typeof p.address === 'string' ? p.address : cur.address),
    minSeconds: Number.isFinite(p.minSeconds) ? Math.max(0, Math.min(3600, p.minSeconds)) : cur.minSeconds,
    telegram: {
      chatId: t.chatId === null ? null : (isChatId(t.chatId) ? String(t.chatId).trim() : cur.telegram.chatId),
      name: t.name === null ? null : (typeof t.name === 'string' ? t.name.slice(0, 60) : cur.telegram.name),
      pcName: cleanPcName(t.pcName) || cur.telegram.pcName,
      // Only cleared from here (leaving the group); it is set by jarvis:telegramFindGroup.
      groupId: t.groupId === null ? null : cur.telegram.groupId,
      groupName: t.groupId === null ? null : cur.telegram.groupName,
      // token: handled by savePhoneConfig below - a token is only ever replaced by a valid
      // one, or cleared outright with null. A half-typed token must not wipe a working one out.
    },
  };
  // Renamed, or leaving the group: take the old line off the board first, while it can still be found.
  const renamed = next.telegram.pcName !== cur.telegram.pcName;
  if (cur.telegram.groupId && (renamed || !next.telegram.groupId)) presence.clear();
  savePhoneConfig(next, { setToken: t.token === null ? null : (isToken(t.token) ? t.token.trim() : undefined) });
  if (renamed) log('this PC is now called', next.telegram.pcName);
  phone.reset();
  const where = next.route === 'telegram' ? `Telegram ${next.telegram.name || next.telegram.chatId || '(not set up)'}` : (next.serial || 'no phone');
  log('phone alerts:', next.enabled ? `on via ${where}` : 'off');
  const remoteBefore = cur.remote && cur.route === 'telegram';
  const remoteNow = next.remote && next.route === 'telegram';
  if (renamed && remoteNow && remoteBefore) presence.set(asleep ? 'asleep' : 'awake');
  if (remoteNow !== remoteBefore) {
    log('remote control:', remoteNow ? 'on' : 'off');
    syncBackground();
    if (remoteNow) presence.set('awake'); else presence.clear();
    // Said on the phone too: it is the first thing you will look at, and it proves the
    // route works in the direction that matters before you rely on it.
    if (remoteNow) remote.announce('Remote control is on. Send me a task and I will run it on your PC - approvals and questions will come here as buttons. /help lists the commands.');
  }
  return phoneConfigForWindow(next);
});

// Telegram setup. The token arrives from the window, is checked against Telegram, and is
// only written to the config once Telegram has confirmed it belongs to a real bot.
ipcMain.handle('jarvis:telegramVerify', async (_e, token) => {
  const use = isToken(token) ? token.trim() : phoneConfig().telegram.token;
  if (!use) return { ok: false, error: 'Paste the token @BotFather gave you first.' };
  const r = await verifyToken(use);
  if (!r.ok) { log('telegram verify failed:', r.error || ''); return r; }
  const cur = phoneConfig();
  savePhoneConfig({ ...cur, telegram: { ...cur.telegram, name: r.name } }, { setToken: use });
  phone.reset();
  log('telegram bot verified:', r.name);
  return { ok: true, name: r.name };
});

ipcMain.handle('jarvis:telegramFindChat', async () => {
  const cur = phoneConfig();
  if (!cur.telegram.token) return { ok: false, error: 'Add the bot token first.' };
  // Telegram serves one getUpdates reader at a time: remote control steps aside meanwhile.
  // Its clock restarts when it resumes, so the "hi" you sent to be found is not run.
  remote.pause(true);
  let r;
  try { r = await discoverChat(cur.telegram.token); } finally { remote.pause(false); }
  if (!r.ok) return r;
  savePhoneConfig({ ...cur, telegram: { ...cur.telegram, chatId: r.chatId } });
  phone.reset();
  log('telegram chat found:', r.name);
  return { ok: true, chatId: r.chatId, name: r.name };
});
// The group shared with your other PCs (presence.mjs): found like the chat, from getUpdates.
ipcMain.handle('jarvis:telegramFindGroup', async () => {
  const cur = phoneConfig();
  if (!cur.telegram.token || !cur.telegram.chatId) return { ok: false, error: 'Set up the bot and find your chat first.' };
  remote.pause(true);
  let r;
  try { r = await discoverGroup(cur.telegram.token, cur.telegram.chatId); } finally { remote.pause(false); }
  if (!r.ok) return r;
  savePhoneConfig({ ...cur, telegram: { ...cur.telegram, groupId: r.chatId, groupName: r.name } });
  log('telegram group found:', r.name, r.admin ? '' : '(the bot is not an admin yet)');
  if (remote.ready) presence.set(asleep ? 'asleep' : 'awake');
  return { ok: true, name: r.name, admin: r.admin };
});
ipcMain.handle('jarvis:phoneWifi', async (_e, serial) => {
  const r = await enableWifi(serial);
  if (r.ok) { savePhoneConfig({ ...phoneConfig(), serial: r.address, address: r.address }); phone.reset(); }
  else log('phone wifi setup failed:', r.error || '');
  return r;
});
// ---------------------------------------------------------------- IPC: Source Control
// Phase 1 is read-only. Every call names its repository by key and git.mjs resolves that
// key afresh, so a reply can never belong to a repository other than the one asked about.
// No model is involved: a status costs zero tokens.
ipcMain.handle('jarvis:gitRepos', async () => {
  // A restricted workspace runs no Git (workspace.mjs): said once, here, not per repository.
  if (loadConfig().cwd && !workspaceTrusted()) return { ok: false, restricted: true, error: GIT_RESTRICTED, list: [] };
  try { return { ok: true, list: await allRepoStates(loadConfig().cwd) }; }
  catch (e) { log('gitRepos failed', e?.message || e); return { ok: false, error: String(e?.message || e), list: [] }; }
});
ipcMain.handle('jarvis:gitDetail', async (_e, key) => {
  try { return await repoDetail(loadConfig().cwd, key); }
  catch (e) { log('gitDetail failed', key, e?.message || e); return { ok: false, error: String(e?.message || e) }; }
});
ipcMain.handle('jarvis:gitChanges', async (_e, key) => {
  try { return await changedFiles(loadConfig().cwd, key); }
  catch (e) { log('gitChanges failed', key, e?.message || e); return { ok: false, error: String(e?.message || e) }; }
});
ipcMain.handle('jarvis:gitDiff', async (_e, key, file, which) => {
  try { return await fileDiff(loadConfig().cwd, key, file, { which: which || 'auto' }); }
  catch (e) { log('gitDiff failed', key, e?.message || e); return { ok: false, error: String(e?.message || e) }; }
});
// Mutations. Local only - none of these contacts a remote, and a commit never leads to one.
ipcMain.handle('jarvis:gitStage', async (_e, key, paths) => {
  try { return await stageFiles(loadConfig().cwd, key, paths); }
  catch (e) { log('gitStage failed', key, e?.message || e); return { ok: false, error: String(e?.message || e) }; }
});
ipcMain.handle('jarvis:gitUnstage', async (_e, key, paths) => {
  try { return await unstageFiles(loadConfig().cwd, key, paths); }
  catch (e) { log('gitUnstage failed', key, e?.message || e); return { ok: false, error: String(e?.message || e) }; }
});
ipcMain.handle('jarvis:gitStageAll', async (_e, key) => {
  try { return await stageAll(loadConfig().cwd, key); }
  catch (e) { log('gitStageAll failed', key, e?.message || e); return { ok: false, error: String(e?.message || e) }; }
});
ipcMain.handle('jarvis:gitUnstageAll', async (_e, key) => {
  try { return await unstageAll(loadConfig().cwd, key); }
  catch (e) { log('gitUnstageAll failed', key, e?.message || e); return { ok: false, error: String(e?.message || e) }; }
});
/**
 * What the git assistant is told about where it is - from discovery, never a fixed story:
 * the workspace's name, this repository's name and the kinds of code in it, and up to eight
 * neighbouring projects by name and kind. Plus the repository's own case-code prefix, if the
 * person set one. Short on purpose: it rides along with every request.
 */
async function gitContextFor(key, repo) {
  const ws = activeWs();
  const where = { repo: repo?.nickname || repo?.name || key };
  if (!ws || key === '@app') return { where, casePrefix: null };
  const all = (await projectIndex.get(ws).catch(() => null))?.projects || [];
  const inside = (p, rel) => rel === '.' || p.relativePath === rel || p.relativePath.startsWith(`${rel}/`);
  const kindsOf = (list) => [...new Set(list.filter((p) => p.role !== 'platform').flatMap((p) => p.types).filter((t) => t !== 'git'))].map((t) => TYPE_LABEL[t] || t);
  const related = key === '.' ? [] : all
    .filter((p) => p.parentId === null && !inside(p, key))
    .map((p) => ({ name: p.displayName || p.name, kinds: kindsOf(all.filter((q) => inside(q, p.relativePath))) }));
  const prefix = projectSettings(ws, key).casePrefix;
  return { where: { workspace: ws.name, ...where, kinds: kindsOf(all.filter((p) => inside(p, key))), related }, casePrefix: prefix || null };
}

// Optional JARVIS assistance. EVERY handler here exists because a person pressed an
// assistance button; nothing in Phases 1-7 calls them, so normal Source Control still
// costs zero model tokens. An assistance failure never touches git - these only return text.
ipcMain.handle('jarvis:gitAssistScope', async (_e, key, action, opts) => {
  try { return await assistContext(loadConfig().cwd, key, action, opts || {}); }
  catch (e) { log('gitAssistScope failed', key, action, e?.message || e); return { ok: false, error: String(e?.message || e) }; }
});
ipcMain.handle('jarvis:gitAssist', async (_e, key, action, opts, id) => {
  const { cwd } = loadConfig();
  try {
    const context = await assistContext(cwd, key, action, opts || {});
    if (!context.ok) return context;
    if (context.tooLarge && !(opts || {}).allowLarge) {
      return { ok: false, tooLarge: true, scope: context, key,
        error: `That is ${context.lines} lines across ${context.files} files. Confirm before sending something that large.` };
    }
    log('git assist requested by the user', key, action, `${context.files} file(s) ${context.lines} line(s)`,
      context.secrets.length ? `[redacted: ${context.secrets.join(', ')}]` : '');
    const r = await assist({
      cwd, exe: claudeExe(), log, id: id || null, action, context,
      extra: { repoName: context.repo.name, path: (opts || {}).path, meta: context.meta, ...(await gitContextFor(key, context.repo)) },
    });
    log('git assist finished', key, action, r.ok ? `ok (${(r.text || '').length} chars)` : `failed: ${(r.error || '').slice(0, 160)}`);
    return { ...r, key, scopeInfo: { files: context.files, lines: context.lines, label: context.scope, secrets: context.secrets, condensed: context.condensed || null } };
  } catch (e) {
    log('gitAssist failed', key, action, e?.message || e);
    return { ok: false, key, error: String(e?.message || e) };
  }
});
ipcMain.handle('jarvis:gitAssistCancel', (_e, id) => {
  try { return cancelAssist(id); } catch (e) { return { ok: false, error: String(e?.message || e) }; }
});
ipcMain.handle('jarvis:gitParseMessage', (_e, text) => {
  try { return { ok: true, ...parseCommitMessage(text) }; } catch (e) { return { ok: false, error: String(e?.message || e) }; }
});

// Stash and conflicts. Local only; destructive paths go through the shared risk policy.
ipcMain.handle('jarvis:gitStashes', async (_e, key) => {
  try { return await listStashes(loadConfig().cwd, key); }
  catch (e) { log('gitStashes failed', key, e?.message || e); return { ok: false, error: String(e?.message || e) }; }
});
ipcMain.handle('jarvis:gitStashCreate', async (_e, key, opts) => {
  try {
    const r = await createStash(loadConfig().cwd, key, opts || {});
    if (r.ok) log('git stash created', key, r.created?.ref, opts?.includeUntracked ? '(with untracked)' : '(tracked only)');
    return r;
  } catch (e) { log('gitStashCreate failed', key, e?.message || e); return { ok: false, error: String(e?.message || e) }; }
});
ipcMain.handle('jarvis:gitStashDetail', async (_e, key, sha) => {
  try { return await stashDetail(loadConfig().cwd, key, sha); }
  catch (e) { return { ok: false, error: String(e?.message || e) }; }
});
ipcMain.handle('jarvis:gitStashDiff', async (_e, key, sha, file) => {
  try { return await stashFileDiff(loadConfig().cwd, key, sha, file); }
  catch (e) { return { ok: false, error: String(e?.message || e) }; }
});
ipcMain.handle('jarvis:gitStashApply', async (_e, key, sha, pop) => {
  try {
    const r = await applyStash(loadConfig().cwd, key, sha, { pop: !!pop });
    log('git stash ' + (pop ? 'pop' : 'apply'), key, r.ok ? 'ok' : 'failed: ' + String(r.error || '').slice(0, 100));
    return r;
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
});
ipcMain.handle('jarvis:gitStashDrop', async (_e, key, sha, confirmed) => {
  try {
    const r = await dropStash(loadConfig().cwd, key, sha, { confirmed: !!confirmed });
    if (r.ok) log('git stash dropped', key, r.dropped?.ref);
    return r;
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
});
ipcMain.handle('jarvis:gitConflicts', async (_e, key) => {
  try { return await conflictState(loadConfig().cwd, key); }
  catch (e) { return { ok: false, error: String(e?.message || e) }; }
});
ipcMain.handle('jarvis:gitConflictDetail', async (_e, key, file) => {
  try { return await conflictDetail(loadConfig().cwd, key, file); }
  catch (e) { return { ok: false, error: String(e?.message || e) }; }
});
ipcMain.handle('jarvis:gitResolveConflict', async (_e, key, file, choice) => {
  try {
    const r = await resolveConflict(loadConfig().cwd, key, file, choice);
    if (r.ok) log('git conflict resolved', key, file, '(' + choice + ')');
    return r;
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
});

// History. Local objects and refs only; lazy, so nothing reads a diff nobody opened.
ipcMain.handle('jarvis:gitHistory', async (_e, key, opts) => {
  try { return await commitHistory(loadConfig().cwd, key, opts || {}); }
  catch (e) { log('gitHistory failed', key, e?.message || e); return { ok: false, error: String(e?.message || e) }; }
});
ipcMain.handle('jarvis:gitCommitDetail', async (_e, key, sha) => {
  try { return await commitDetail(loadConfig().cwd, key, sha); }
  catch (e) { log('gitCommitDetail failed', key, e?.message || e); return { ok: false, error: String(e?.message || e) }; }
});
ipcMain.handle('jarvis:gitCommitDiff', async (_e, key, sha, file) => {
  try { return await commitFileDiff(loadConfig().cwd, key, sha, file); }
  catch (e) { log('gitCommitDiff failed', key, e?.message || e); return { ok: false, error: String(e?.message || e) }; }
});

// Remote operations. THE ONLY NETWORK PATH IN THE APP, and every one of these handlers
// exists because the user pressed a button or asked for it. Nothing calls them on a timer,
// at startup, on repository selection, or after a commit.
function remoteProgress(evt) {
  send({ kind: 'git_remote', ...evt });
}
ipcMain.handle('jarvis:gitRemoteState', (_e, key) => {
  try { return remoteState(loadConfig().cwd, key); }
  catch (e) { return { ok: false, error: String(e?.message || e) }; }
});
ipcMain.handle('jarvis:gitRemoteCancel', (_e, key) => {
  try { log('git remote cancel requested', key); return cancelRemote(loadConfig().cwd, key); }
  catch (e) { return { ok: false, error: String(e?.message || e) }; }
});
for (const [channel, fn, label] of [
  ['jarvis:gitFetch', fetchRemote, 'fetch'],
  ['jarvis:gitPull', pullRemote, 'pull'],
  ['jarvis:gitPush', pushRemote, 'push'],
  ['jarvis:gitPublish', publishBranch, 'publish'],
]) {
  ipcMain.handle(channel, async (_e, key) => {
    try {
      log(`git ${label} requested by the user`, key);
      const r = await fn(loadConfig().cwd, key, { onProgress: remoteProgress });
      log(`git ${label}`, key, r.ok ? 'ok' : `failed: ${(r.error || '').slice(0, 120)}`);
      return r;
    } catch (e) {
      log(`git ${label} threw`, key, e?.message || e);
      return { ok: false, key, error: String(e?.message || e) };
    }
  });
}

// Branches. Local refs only - nothing here contacts a remote, including the picker.
ipcMain.handle('jarvis:gitBranches', async (_e, key) => {
  try { return await listBranches(loadConfig().cwd, key); }
  catch (e) { log('gitBranches failed', key, e?.message || e); return { ok: false, error: String(e?.message || e) }; }
});
ipcMain.handle('jarvis:gitCreateBranch', async (_e, key, name, opts) => {
  try {
    const r = await createBranch(loadConfig().cwd, key, name, opts || {});
    if (r.ok) log('git branch created', key, r.created, r.switched ? '(switched)' : '');
    return r;
  } catch (e) { log('gitCreateBranch failed', key, e?.message || e); return { ok: false, error: String(e?.message || e) }; }
});
ipcMain.handle('jarvis:gitSwitchBranch', async (_e, key, name) => {
  try {
    const r = await switchBranch(loadConfig().cwd, key, name);
    if (r.ok) log('git switch', key, '->', r.current);
    return r;
  } catch (e) { log('gitSwitchBranch failed', key, e?.message || e); return { ok: false, error: String(e?.message || e) }; }
});
ipcMain.handle('jarvis:gitRenameBranch', async (_e, key, from, to) => {
  try {
    const r = await renameBranch(loadConfig().cwd, key, from, to);
    if (r.ok) log('git branch renamed', key, from, '->', to);
    return r;
  } catch (e) { log('gitRenameBranch failed', key, e?.message || e); return { ok: false, error: String(e?.message || e) }; }
});
ipcMain.handle('jarvis:gitDeleteBranch', async (_e, key, name, opts) => {
  try {
    const r = await deleteBranch(loadConfig().cwd, key, name, opts || {});
    if (r.ok) log('git branch deleted', key, name, r.forced ? '(forced)' : '');
    return r;
  } catch (e) { log('gitDeleteBranch failed', key, e?.message || e); return { ok: false, error: String(e?.message || e) }; }
});
ipcMain.handle('jarvis:gitCommit', async (_e, key, message) => {
  try {
    const r = await gitCommit(loadConfig().cwd, key, message || {});
    if (r.ok) log('git commit', key, r.commit.sha, '->', r.commit.branch, `(${r.commit.count} file(s))`);
    return r;
  } catch (e) { log('gitCommit failed', key, e?.message || e); return { ok: false, error: String(e?.message || e) }; }
});
// GitHub Desktop's Undo: the newest commit, and taking it back with its changes kept staged.
ipcMain.handle('jarvis:gitLastCommit', async (_e, key) => {
  try { return await lastCommit(loadConfig().cwd, key); }
  catch (e) { log('gitLastCommit failed', key, e?.message || e); return { ok: false, error: String(e?.message || e) }; }
});
ipcMain.handle('jarvis:gitUndoCommit', async (_e, key, sha) => {
  try {
    const r = await undoLastCommit(loadConfig().cwd, key, { sha });
    if (r.ok) log('git commit undone', key, r.undone.sha, 'on', r.undone.branch);
    return r;
  } catch (e) { log('gitUndoCommit failed', key, e?.message || e); return { ok: false, error: String(e?.message || e) }; }
});
// Discard all changes: destructive, so it runs only once the window has confirmed, and a
// copy of every changed file goes to the Recycle Bin first.
ipcMain.handle('jarvis:gitDiscardAll', async (_e, key, confirmed, expect) => {
  try {
    const r = await discardAll(loadConfig().cwd, key, {
      confirmed: confirmed === true,
      expect: Array.isArray(expect) ? expect : null,
      trash: (p) => shell.trashItem(p),
    });
    if (r.discarded) log('git discarded all changes', key, `(${r.discarded} change(s))`, r.backup ? `copy in Recycle Bin: ${r.backup}` : '');
    return r;
  } catch (e) { log('gitDiscardAll failed', key, e?.message || e); return { ok: false, error: String(e?.message || e) }; }
});

// The test goes by whichever route is configured, so what it proves is the route you will
// actually be relying on - not just that adb can still see a phone.
ipcMain.handle('jarvis:phoneTest', async (_e, serial) => {
  const item = {
    title: 'JARVIS',
    body: 'Phone alerts are working. You will hear from me when a long turn finishes or I need a decision.',
  };
  const cfg = phoneConfig();
  let r;
  if (cfg.route === 'telegram') {
    if (!cfg.telegram.token) return { ok: false, error: 'Add the bot token first.' };
    if (!cfg.telegram.chatId) return { ok: false, error: 'Press "Find my chat" first, after sending your bot a message.' };
    r = await sendTelegram(cfg.telegram, item);
  } else {
    const target = isSerial(serial) ? serial : cfg.serial;
    if (!target) return { ok: false, error: 'No phone chosen yet.' };
    r = await postNotification(target, item);
  }
  // Logged like every real alert, so "did the test go?" has an answer after the fact.
  log('phone alert test', r.ok ? `sent via ${cfg.route}` : `failed via ${cfg.route}: ${r.error || ''}`);
  return r;
});

// ---------------------------------------------------------------- IPC: web apps (ASP.NET)
// The workspace's sites and APIs, discovered (project-providers.mjs, webAppsFrom): any .NET
// project on the Web SDK. A warning shown before Run is the person's own, per project.
async function webAppList() {
  const ws = activeWs();
  if (!ws) return [];
  return webAppsFrom(ws.path, (await projectIndex.get(ws)).projects || []);
}
ipcMain.handle('jarvis:webApps', async () => listWebApps(await webAppList()));
ipcMain.handle('jarvis:webRun', async (_e, key, watch) => {
  // A run builds the project - its MSBuild targets included: the project's own code.
  if (!workspaceTrusted()) return { ok: false, restricted: true, error: RESTRICTED_RUN };
  try {
    const app = typeof key === 'string' ? (await webAppList()).find((a) => a.key === key) : null;
    if (!app) return { ok: false, error: 'That project is not in this workspace.' };
    const dotnet = (await getCapabilities()).find((c) => c.id === 'dotnet' && c.installed)?.where || null;
    const run = await webRun(app, { watch: watch !== false, dotnet }, send);
    log('web app started', key, watch !== false ? '(dotnet watch)' : '(dotnet run)');
    return { ok: true, run };
  } catch (e) {
    log('web app refused', key, e?.message || e);
    return { ok: false, code: e?.code || null, error: String(e?.message || e) };
  }
});
ipcMain.handle('jarvis:webStop', (_e, key) => webStop(key));
ipcMain.handle('jarvis:webStopAll', () => webStopAll());
/** Open a running local site in the normal browser. Nothing but this machine's own ports. */
ipcMain.handle('jarvis:openUrl', (_e, url) => {
  if (typeof url !== 'string' || !LOCAL_URL.test(url)) { log('refused to open', url); return false; }
  // A screenshot run must not throw a browser window onto the screen of whoever is working.
  if (process.env.JARVIS_CAPTURE) { log('capture: would open', url); return true; }
  shell.openExternal(url);
  return true;
});
ipcMain.handle('jarvis:webLog', (_e, key) => webLog(key));

// ---------------------------------------------------------------- IPC: GitHub (Phase 9, read-only)
// github.mjs is a separate service: git.mjs never imports it, so nothing here can affect
// staging, commits, branches, stashes, history or fetch / pull / push. Every handler names
// one read operation and takes a repository KEY plus a number, a cursor or a SHA - never a
// URL, an API path, an owner or a repository name. Each exists because the user opened the
// GitHub tab or pressed something in it; nothing calls them at startup, on repository or
// branch selection, on a timer, or after a commit or push. No model is involved.
const github = createGitHub({
  cwd: () => loadConfig().cwd,
  fetch: (url, init) => net.fetch(url, init),
  online: () => net.isOnline(),
  log,
});
// Local only: GitHub identity from the origin remote, and links built from local refs.
ipcMain.handle('jarvis:ghInfo', (_e, key) => github.info(key));
ipcMain.handle('jarvis:ghLink', (_e, key, which, arg) => github.link(key, which, arg));
ipcMain.handle('jarvis:ghOpen', async (_e, key, which, arg) => {
  const r = await github.link(key, which, arg);
  if (!r.ok) return r;
  if (!/^https:\/\/github\.com\//.test(r.url)) { log('refused to open a non-GitHub link'); return { ok: false, error: 'Not a GitHub link.' }; }
  shell.openExternal(r.url);
  log('github page opened', which, key);
  return { ok: true, key: r.key };
});
// The GitHub API. Read-only: github.mjs sends GETs from a fixed route table and checked
// GraphQL queries, and nothing else.
ipcMain.handle('jarvis:ghPulls', (_e, key, opts) => github.pulls(key, opts));
ipcMain.handle('jarvis:ghPull', (_e, key, number) => github.pull(key, number));
ipcMain.handle('jarvis:ghPullFiles', (_e, key, number, page) => github.pullFiles(key, number, page));
ipcMain.handle('jarvis:ghPullPatch', (_e, key, number, path) => github.pullPatch(key, number, path));
ipcMain.handle('jarvis:ghChecks', (_e, key, sha) => github.checks(key, sha ?? null));
ipcMain.handle('jarvis:ghRuns', (_e, key, sha) => github.runs(key, sha ?? null));
ipcMain.handle('jarvis:ghCancel', (_e, key) => github.cancel(key));

// ---------------------------------------------------------------- IPC: tasks (ClickUp + draft)
// ClickUp is optional, and whose tasks it shows is the person's own setting - a name as it
// appears in ClickUp. Never guessed; a board fetched for a different name is not shown as theirs.
const clickupMember = () => cleanMember(loadConfig().clickup?.member);
ipcMain.handle('jarvis:clickup', () => {
  const member = clickupMember();
  const c = readClickUp(userDir);
  const mine = !!member && c.member === member;
  return { ...(mine ? c : { tasks: [], fetchedAt: null }), member, cachedFor: !mine && c.fetchedAt ? c.member || null : null };
});
ipcMain.handle('jarvis:clickupMember', (_e, name) => {
  const raw = String(name ?? '').trim();
  if (!raw) { saveConfig({ clickup: { ...(loadConfig().clickup || {}), member: null } }); return { ok: true, member: null }; }
  const member = cleanMember(raw);
  if (!member) return { ok: false, error: 'Use your name as it appears in ClickUp: letters, digits, spaces, dots, dashes.' };
  saveConfig({ clickup: { ...(loadConfig().clickup || {}), member } });
  log('clickup: tasks will be read for the member set in Settings');
  return { ok: true, member };
});
ipcMain.handle('jarvis:draftTasks', () => {
  const { cwd } = loadConfig();
  if (!cwd) return { available: false, sections: [] };
  try { return readDraft(cwd); }
  catch (e) { log('readDraft failed', e?.message || e); return { available: false, sections: [] }; }
});
let syncing = null;
ipcMain.handle('jarvis:clickupSync', () => {
  // One sync at a time; a second click joins the one already running.
  if (!syncing) {
    log('clickup sync requested');
    syncing = syncClickUp({ cwd: loadConfig().cwd || app.getPath('home'), exe: claudeExe(), userDir, log, member: clickupMember() })
      .then((r) => { clickupLastError = r?.ok || r?.needsMember ? null : (r?.error || 'The sync did not finish.'); return r; })
      .finally(() => { syncing = null; });
  }
  return syncing;
});

// ---------------------------------------------------------------- IPC: workspace (read-only)
// The disk gauge is the workspace's drive; with no workspace, the home folder's.
ipcMain.handle('jarvis:stats', () => systemStats(loadConfig().cwd || app.getPath('home')));
ipcMain.handle('jarvis:online', () => net.isOnline());
ipcMain.handle('jarvis:savedEffort', (_e, model) => savedEffort(loadConfig().cwd || app.getPath('home'), model));

let wsCache = null;
let wsAt = 0;
let wsBusy = null;
ipcMain.handle('jarvis:workspace', async (_e, force) => {
  if (wsBusy) return wsBusy;
  if (!force && wsCache && Date.now() - wsAt < 20000) return wsCache;
  const { cwd } = loadConfig();
  if (!cwd) return { repos: [], knowledge: { available: false }, issues: { available: false, list: [] }, focus: { available: false, items: [] }, at: Date.now() };
  wsBusy = (async () => {
    const [repos, knowledge, issues, focus] = await Promise.all([
      gitStatus(cwd).catch((e) => { log('git status failed', e?.message || e); return []; }),
      // The knowledge check RUNS a script from the workspace (.claude/knowledge/scan-status.py):
      // only in a workspace the person has trusted, never in a restricted one.
      workspaceTrusted()
        ? knowledgeStatus(cwd).catch((e) => ({ available: false, error: String(e?.message || e) }))
        : Promise.resolve({ available: false, restricted: true }),
      openIssues(cwd).catch(() => ({ available: false, list: [] })),
      handoffFocus(cwd).catch(() => ({ available: false, items: [] })),
    ]);
    wsCache = { repos, knowledge, issues, focus, at: Date.now() };
    wsAt = Date.now();
    return wsCache;
  })();
  try { return await wsBusy; } finally { wsBusy = null; }
});

ipcMain.handle('jarvis:docs', async (_e, root) => {
  try { return await listDocs(loadConfig().cwd, root); }
  catch (e) { log('listDocs failed', e?.message || e); return []; }
});
ipcMain.handle('jarvis:doc', async (_e, root, rel) => {
  try { const d = await readDoc(loadConfig().cwd, root, rel); delete d.full; return d; }
  catch (e) { return { error: e?.message || String(e) }; }
});
ipcMain.handle('jarvis:search', async (_e, q) => {
  try { return await searchDocs(loadConfig().cwd, q); }
  catch (e) { log('search failed', e?.message || e); return []; }
});
ipcMain.handle('jarvis:roots', () => {
  const { cwd } = loadConfig();
  return cwd ? Object.fromEntries(Object.entries(docRoots(cwd)).map(([k, v]) => [k, v.label])) : {};
});
/** Open a browsable document in the default editor (same folder checks as reading it). */
ipcMain.handle('jarvis:openDoc', async (_e, root, rel) => {
  try { const d = await readDoc(loadConfig().cwd, root, rel); return (await shell.openPath(d.full)) === ''; }
  catch { return false; }
});
ipcMain.handle('jarvis:openLogs', () => shell.openPath(userDir));

// ---------------------------------------------------------------- IPC: agents
// Custom agents (agents.mjs): Claude Code subagent files in this workspace's .claude/agents and
// in the person's own agents folder. The window names an agent by its folder ('project' or
// 'user') and its file inside it - never a path - and every rule is applied again here: a
// restricted workspace is not written to, nothing is overwritten, and a change to the person's
// own Claude folder or a grant of tools that change things needs the approval passed with it.
function agentCtx() {
  const { cwd } = loadConfig();
  return {
    cwd: cwd || null,
    trusted: workspaceTrusted(),
    home: configHome(),
    // Old versions of edited and deleted agents, kept beside the config - never in a folder
    // Claude Code reads, where a copy would load as a second agent.
    backupDir: path.join(userDir, 'agent-backups'),
    // A screenshot run works in throwaway folders. The person's own Claude folder is not one,
    // unless the run was given its own (CLAUDE_CONFIG_DIR).
    userWritable: !process.env.JARVIS_CAPTURE || !!process.env.CLAUDE_CONFIG_DIR,
  };
}
/** The chat session of the window that asked, if it has one - listing agents never starts a session. */
const peekSession = (e) => {
  const wc = e?.sender;
  return !wc || !win || wc.id === win.webContents.id ? session : paneSessions.get(wc.id) || null;
};
const agentOpts = (o) => ({ approveUserScope: o?.approveUserScope === true, allowRisky: o?.allowRisky === true, confirmed: o?.confirmed === true });
/** A draft as the window sent it, cut down to the fields there are and the sizes they may be. */
function agentDraft(d) {
  if (!d || typeof d !== 'object') return {};
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);
  return {
    scope: d.scope === 'user' ? 'user' : d.scope === 'project' ? 'project' : null,
    file: str(d.file, 300),
    expect: str(d.expect, 64),
    name: str(d.name, 100) ?? '',
    description: str(d.description, 8000) ?? '',
    body: str(d.body, 200000) ?? '',
    tools: d.tools === null || d.tools === undefined ? null : Array.isArray(d.tools) ? d.tools.slice(0, 100).filter((t) => typeof t === 'string') : 'not a list',
    model: str(d.model, 100) ?? null,
  };
}
const agentRef = (r) => ({ scope: r?.scope === 'user' ? 'user' : r?.scope === 'project' ? 'project' : null, file: typeof r?.file === 'string' ? r.file.slice(0, 300) : '', expect: typeof r?.expect === 'string' ? r.expect.slice(0, 64) : undefined });
/** Run one agents call; a failure nobody expected is logged and said plainly, never thrown at the window. */
const agentCall = (what, fn) => async (...args) => {
  try { return await fn(...args); }
  catch (err) { log(`agents: ${what} failed`, err?.message || err); return { ok: false, error: `The agents could not be ${what}.` }; }
};

ipcMain.handle('agents:list', agentCall('listed', (e) => listAgents(agentCtx(), { session: peekSession(e)?.agentList || null })));
ipcMain.handle('agents:read', agentCall('read', (_e, scope, file) => readAgent(agentCtx(), scope === 'user' ? 'user' : scope === 'project' ? 'project' : null, typeof file === 'string' ? file.slice(0, 300) : '')));
/** What the editor offers: the starters, the tools with what each one allows, and the models. */
ipcMain.handle('agents:options', () => ({ ok: true, templates: templatesForWindow(), tools: TOOL_CATALOG, readOnly: READ_ONLY_TOOLS, models: MODEL_ALIASES }));
/** Exactly what saving a draft would write, and where. Writes nothing. */
ipcMain.handle('agents:preview', agentCall('checked', (_e, draft, opts) => previewForWindow(agentCtx(), agentDraft(draft), agentOpts(opts))));
ipcMain.handle('agents:save', agentCall('saved', async (_e, draft, opts) => {
  const r = await saveAgent(agentCtx(), agentDraft(draft), agentOpts(opts));
  if (r.ok) log(`agents: ${r.created ? 'created' : 'saved'} ${r.name} (${r.scope}: ${r.file})${r.risks.length ? ` - allows ${r.risks.join(', ')}` : ''}`);
  return r;
}));
ipcMain.handle('agents:createMany', agentCall('created', async (_e, drafts, opts) => {
  const r = await createAgents(agentCtx(), Array.isArray(drafts) ? drafts.slice(0, 20).map(agentDraft) : [], agentOpts(opts));
  if (r.results && !r.needsApproval) log(`agents: created ${r.results.filter((x) => x.ok).map((x) => x.name).join(', ') || 'none'}${r.ok ? '' : ` - ${r.error}`}`);
  return r;
}));
ipcMain.handle('agents:delete', agentCall('deleted', async (_e, ref, opts) => {
  const r = await deleteAgent(agentCtx(), agentRef(ref), agentOpts(opts));
  if (r.ok) log(`agents: deleted ${r.name} (${r.scope}: ${r.file})${r.backup ? ', a copy was kept' : ''}`);
  return r;
}));
ipcMain.handle('agents:setEnabled', agentCall('changed', async (_e, ref, enabled, opts) => {
  const r = await setAgentEnabled(agentCtx(), agentRef(ref), enabled === true, agentOpts(opts));
  if (r.ok && !r.unchanged) log(`agents: switched ${r.enabled ? 'on' : 'off'} ${r.file} (${r.scope})`);
  return r;
}));
/**
 * Build My Team: a short list of specialists for this workspace, or one project in it, from
 * what project discovery already found. Rules, not a model - pressing it costs nothing, and it
 * only proposes: nothing is written until the person approves each one (agents:createMany).
 */
ipcMain.handle('agents:teamPlan', agentCall('planned', async (e, projectKey) => {
  const ws = activeWs();
  if (!ws) return { ok: false, error: NO_WORKSPACE };
  const [idx, list] = await Promise.all([
    projectIndex.get(ws),
    listAgents(agentCtx(), { session: peekSession(e)?.agentList || null }),
  ]);
  const projects = idx.projects || [];
  const plan = planTeam({ projects, target: typeof projectKey === 'string' && projectKey ? projectKey.slice(0, 400) : null, existing: list.agents });
  if (!plan.ok) return plan;
  return {
    ...plan,
    workspace: { name: ws.name, trusted: workspaceTrusted() },
    scopes: list.scopes,
    scanned: { ok: idx.ok !== false, truncated: !!idx.truncated, error: idx.error || null },
    projects: projects.filter((p) => p.role !== 'platform').slice(0, 80).map((p) => ({ id: p.id, name: p.displayName || p.name, path: p.relativePath, types: p.types })),
  };
}));
/**
 * Start the chat session again, in the same conversation, so it reads the agents folders
 * afresh. Only while it is idle: a restart ends every agent still working (session.mjs).
 */
ipcMain.handle('agents:reload', (e) => {
  const s = peekSession(e);
  if (!s) return { ok: false, notRunning: true, error: 'The session is not running. It reads the agents folders when it next starts.' };
  if (signedOut) return { ok: false, error: SIGNED_OUT };
  const r = s.reloadAgents();
  if (r.ok) {
    if (s === session) remote.sessionStarted();
    log('agents: the session was restarted to read the agents folders again');
  }
  return r;
});

// ---------------------------------------------------------------- IPC: notes
// Written in the window, kept in notes.json beside the config, and optionally sent to the
// same Telegram chat the phone alerts use. The window never sees the token - only whether
// a chat is set up, and what it is called.
const notes = new NoteStore(userDir);
function telegramStatus() {
  const tg = phoneConfig().telegram;
  return { ready: telegramReady(tg), name: tg.name || null };
}
ipcMain.handle('jarvis:notes', () => {
  try { return { ok: true, notes: notes.list(), telegram: telegramStatus() }; }
  catch (e) { return { ok: false, error: String(e?.message || e), notes: [], telegram: telegramStatus() }; }
});
ipcMain.handle('jarvis:noteSave', async (_e, note, opts) => {
  // Saved first, always: a note is not lost because Telegram is down.
  const r = notes.save({ id: note?.id, text: note?.text });
  if (!r.ok) return r;
  if (!(opts && opts.telegram)) return { ...r, telegram: telegramStatus() };
  const sent = await sendNote(phoneConfig().telegram, r.note);
  if (sent.ok) { notes.markSent(r.note.id); log('note sent to Telegram'); }
  else log('note not sent to Telegram:', sent.error);
  return { ok: true, note: { ...r.note, sentAt: sent.ok ? Date.now() : r.note.sentAt }, sent, telegram: telegramStatus() };
});
ipcMain.handle('jarvis:noteDelete', (_e, id) => notes.remove(typeof id === 'string' ? id : ''));

// ---------------------------------------------------------------- IPC: Knowledge (Phase 23C)
// A second, separate note store (src/knowledge.mjs) - one Markdown file per note, with YAML
// front matter, under <userData>/knowledge/notes. Deliberately kept apart from notes.json
// above: nothing here reads, writes, renames or deletes it, and nothing migrates it on its
// own - knowledgeStorageStatus() only ever reports numbers, never acts on them. Every save
// goes through saveKnowledgeNote's optimistic-concurrency check, so a second window (or a
// second save that lands first) is never silently overwritten.
function knowledgeStorageStatus() {
  const { notesDir } = knowledgePaths(userDir);
  let legacyNoteCount = 0;
  try { legacyNoteCount = notes.list().length; } catch { /* unreadable legacy file: reported as 0, never thrown */ }
  const history = historyStats(userDir);
  return {
    storageDir: notesDir, migrationComplete: knowledgeMigrationComplete(userDir), legacyNoteCount,
    // Decision 4: a size/count warning only - nothing here ever prunes Version History.
    historyCount: history.count, historyBytes: history.bytes, historyWarn: history.warn,
    // Phase 1 hardening item 1: lets the unified editor show/hide "Send to Telegram" the same
    // way notes.js already decides it, without a second round trip.
    telegram: telegramStatus(),
  };
}
ipcMain.handle('jarvis:knowledgeStatus', () => knowledgeStorageStatus());
ipcMain.handle('jarvis:knowledgeList', () => {
  const r = listKnowledgeNotes(userDir);
  if (!r.ok) return { ok: false, error: r.error, notes: [], status: knowledgeStorageStatus() };
  return {
    ok: true,
    status: knowledgeStorageStatus(),
    notes: r.notes.map((n) => ({
      id: n.id, title: n.title, created: n.created, updated: n.updated, tags: n.tags,
      favorite: n.favorite, folder: n.folder, sentAt: n.sentAt, aiExcluded: n.aiExcluded, corrupt: n.corrupt,
    })),
  };
});
ipcMain.handle('jarvis:knowledgeRead', (_e, id) => {
  if (typeof id !== 'string' || !id) return { ok: false, error: 'No note id was given.' };
  const r = listKnowledgeNotes(userDir);
  const n = r.ok && r.notes.find((x) => x.id === id);
  if (!n) return { ok: false, error: 'That note could not be found.' };
  return {
    ok: true,
    note: {
      id: n.id, title: n.title, created: n.created, updated: n.updated, tags: n.tags,
      favorite: n.favorite, folder: n.folder, sentAt: n.sentAt, aiExcluded: n.aiExcluded, body: n.body,
    },
    revision: noteRevision(userDir, id),
  };
});
ipcMain.handle('jarvis:knowledgeSave', (_e, input) => {
  const v = validateNoteInput(input);
  if (!v.ok) return { ok: false, error: v.error };
  const id = typeof input?.id === 'string' && input.id ? input.id : newKnowledgeId();
  const baseRevision = typeof input?.baseRevision === 'string' ? input.baseRevision : null;
  const force = input?.force === true;
  const r = saveKnowledgeNote(userDir, id, v.value, { baseRevision, force });
  if (!r.ok) return r;
  if (r.overwrote) log('knowledge note overwrite confirmed', id, '- prior revision backed up as', r.overwrote.snapshot || '(nothing to back up)');
  log('knowledge note saved', id);
  if (!r.unchanged) driveSyncController.requestSync(); // Phase 3: debounced - local-first, Drive follows in the background
  return { ok: true, note: r.note, revision: r.revision, unchanged: r.unchanged, overwrote: r.overwrote };
});

// ---------------------------------------------------------------- Phase 23D: Import, Trash, restore
// Import only ever reads notes.json and adds to Knowledge - migrateFromLegacy (Phase 23B,
// unchanged here) never deletes, renames or writes to notes.json, and never overwrites a
// Knowledge note that already differs from what a fresh import would produce (an edit made
// there since the last import counts as a conflict, not something to silently replace).
ipcMain.handle('jarvis:knowledgeImportPreview', () => previewMigration(userDir));
ipcMain.handle('jarvis:knowledgeImport', () => {
  const r = migrateFromLegacy(userDir);
  log('knowledge import from Notes', `migrated ${r.migrated}, skipped ${r.skipped}, conflicts ${r.conflicts.length}, errors ${r.errors.length}`);
  if (r.migrated > 0) driveSyncController.requestSync();
  return r;
});

// Phase 1 (Unified Notes), hardening item 1: porting "Send to Telegram" from Notes (Classic).
// The token itself never crosses into the window - exactly the same boundary notes.mjs's own
// sendNote already holds (see notes-test.mjs's assertion of that); this handler only ever
// hands back {ok} or {ok:false,error}, the same shape jarvis:noteSave's telegram branch uses.
ipcMain.handle('jarvis:knowledgeSendTelegram', async (_e, id) => {
  if (typeof id !== 'string' || !id) return { ok: false, error: 'No note id was given.' };
  const r = listKnowledgeNotes(userDir);
  const n = r.ok && r.notes.find((x) => x.id === id);
  if (!n) return { ok: false, error: 'That note could not be found.' };
  const tg = phoneConfig().telegram;
  if (!telegramReady(tg)) return { ok: false, error: 'Telegram is not set up yet - do that in Settings > Phone alerts.' };
  const when = new Date(n.updated || Date.now()).toLocaleString('en-GB');
  const sent = await sendTelegram(tg, { title: `📝 Note · ${n.title || 'Untitled note'}`, body: `${when}\n\n${n.body}` });
  if (sent.ok) { markKnowledgeNoteSent(userDir, id, Date.now()); log('knowledge note sent to Telegram', id); }
  else log('knowledge note not sent to Telegram:', sent.error);
  return sent.ok ? { ok: true, sentAt: Date.now() } : { ok: false, error: sent.error };
});

// Phase 1 (Unified Notes): the same migrateFromLegacy above, called automatically rather than
// only from the "Import from Notes" button - the unified Notes page calls this once when it
// opens so a person never has to find and press Import by hand for their notes to show up.
// Safe to call unconditionally (migrateFromLegacy already is), but the fast marker check
// skips the real work entirely once migration has already completed, so this costs nothing on
// every later load. Still never touches notes.json - same guarantees as Import above.
ipcMain.handle('jarvis:knowledgeAutoMigrate', () => {
  if (knowledgeMigrationComplete(userDir)) return { ok: true, already: true, migrated: 0, skipped: 0, conflicts: [], errors: [], total: 0 };
  const r = migrateFromLegacy(userDir);
  if (r.migrated > 0 || r.conflicts.length > 0 || r.errors.length > 0) {
    log('knowledge auto-migrate from Notes', `migrated ${r.migrated}, skipped ${r.skipped}, conflicts ${r.conflicts.length}, errors ${r.errors.length}`);
  }
  if (r.migrated > 0) driveSyncController.requestSync();
  return { ...r, already: false };
});

// Delete moves a note to Trash - it is never gone for good from here, and a stale editor (one
// that opened the note before someone else's newer edit) cannot delete that newer version out
// from under them, the same revision check a save already uses.
ipcMain.handle('jarvis:knowledgeTrash', () => {
  const r = listTrash(userDir);
  if (!r.ok) return { ok: false, error: r.error, notes: [] };
  return {
    ok: true,
    notes: r.notes.map((n) => ({ id: n.id, title: n.title, created: n.created, updated: n.updated, tags: n.tags, favorite: n.favorite, deletedAt: n.deletedAt, corrupt: n.corrupt })),
  };
});
ipcMain.handle('jarvis:knowledgeTrashRead', (_e, id) => {
  if (typeof id !== 'string' || !id) return { ok: false, error: 'No note id was given.' };
  const r = listTrash(userDir);
  const n = r.ok && r.notes.find((x) => x.id === id);
  if (!n) return { ok: false, error: 'That note could not be found in Trash.' };
  return { ok: true, note: { id: n.id, title: n.title, created: n.created, updated: n.updated, tags: n.tags, favorite: n.favorite, deletedAt: n.deletedAt, body: n.body } };
});
ipcMain.handle('jarvis:knowledgeDelete', (_e, id, baseRevision) => {
  if (typeof id !== 'string' || !id) return { ok: false, error: 'No note id was given.' };
  const rev = typeof baseRevision === 'string' ? baseRevision : null;
  const r = deleteKnowledgeNote(userDir, id, { baseRevision: rev });
  if (r.ok) { log('knowledge note moved to Trash', id); driveSyncController.requestSync(); }
  return r;
});
ipcMain.handle('jarvis:knowledgeRestore', (_e, id) => {
  if (typeof id !== 'string' || !id) return { ok: false, error: 'No note id was given.' };
  const r = restoreKnowledgeNote(userDir, id);
  if (r.ok) { log('knowledge note restored from Trash', id); driveSyncController.requestSync(); }
  return r;
});

// Phase 23E: version history - every id and file reference is checked server-side before it
// ever reaches knowledge.mjs (which checks it again, properly, with path containment); the
// window only ever gets back a note's own snapshots, never a directory listing of anything else.
ipcMain.handle('jarvis:knowledgeSnapshots', (_e, id) => {
  if (typeof id !== 'string' || !id) return { ok: false, error: 'No note id was given.', snapshots: [] };
  return listSnapshots(userDir, id);
});
ipcMain.handle('jarvis:knowledgeSnapshotRead', (_e, id, file) => {
  if (typeof id !== 'string' || !id || typeof file !== 'string' || !file) return { ok: false, error: 'No version reference was given.' };
  return readSnapshot(userDir, id, file);
});
ipcMain.handle('jarvis:knowledgeSnapshotRestore', (_e, id, file, baseRevision) => {
  if (typeof id !== 'string' || !id || typeof file !== 'string' || !file) return { ok: false, error: 'No version reference was given.' };
  const rev = typeof baseRevision === 'string' ? baseRevision : null;
  const r = restoreSnapshot(userDir, id, file, { baseRevision: rev });
  if (r.ok) { log('knowledge note restored from version history', id, file); driveSyncController.requestSync(); }
  return r;
});

// ---------------------------------------------------------------- IPC: Notes AI Knowledge (Phase 4)
// Read-only, local-only: both handlers only ever call into notes-search.mjs, which only ever
// calls listKnowledgeNotes - nothing here writes a note, calls an external AI provider, or
// can be used to bypass aiExcluded. jarvis:notesAskContext hands back a composed PROMPT the
// window inserts into the chat composer (JV.chat.insert - see knowledge.js) for the person to
// review and press Send themselves; nothing here sends anything to Claude on its own.
ipcMain.handle('jarvis:notesSearch', (_e, query) => searchNotes(userDir, typeof query === 'string' ? query : ''));
ipcMain.handle('jarvis:notesAskContext', (_e, query) => {
  const r = notesForAiContext(userDir, typeof query === 'string' ? query : '');
  if (!r.ok) return r;
  return { ok: true, prompt: buildContextPrompt(r.query, r.sources), sources: r.sources.map((s) => ({ id: s.id, title: s.title, folder: s.folder })) };
});

// ---------------------------------------------------------------- IPC: Google Drive connection (Phase 24C)
// Connection management ONLY - configure a Client ID, connect, disconnect, read status.
// No backup or restore operation is reachable from here; driveConnection.getAccessToken is
// for a future Drive-backed backup/restore IPC call this phase deliberately does not add.
// Every reply is laundered through driveStatusForWindow() so a token can never reach the
// renderer by accident, the same discipline phoneConfigForWindow() already applies to the
// Telegram token.
ipcMain.handle('jarvis:driveStatus', () => driveStatusForWindow());
ipcMain.handle('jarvis:driveConfigureClient', (_e, clientId, clientSecret) => {
  if (typeof clientId !== 'string' || !clientId.trim()) return { ok: false, error: 'A Client ID is required.' };
  const r = driveConnection.configureClient({ clientId, clientSecret: typeof clientSecret === 'string' ? clientSecret : '' });
  log('Drive Client ID configured:', r.ok);
  return r;
});
ipcMain.handle('jarvis:driveConnect', async () => {
  const r = await driveConnection.connect({ timeoutMs: 120000 });
  log('Drive connect:', r.ok ? 'connected' : `failed (${r.error})`);
  if (r.ok) driveSyncController.syncNow(); // Phase 3: "sync on reconnection" - fire-and-forget, never blocks the Connect reply
  return { ok: r.ok, error: r.ok ? undefined : r.error, ...driveStatusForWindow() };
});
ipcMain.handle('jarvis:driveDisconnect', async () => {
  await driveConnection.disconnect();
  log('Drive disconnected');
  return driveStatusForWindow();
});

// Phase 2 (Decision 1): the app-owned, no-setup path - "Connect Google Account" with nothing
// to paste. Both environment gates (drive-app-client.mjs) must be open for `available` to be
// true; until a real, Google-verified Client ID exists, this is false on every build and the
// button below it in the renderer simply never appears - BYO-client above is completely
// unaffected either way. driveConnectAppOwned does not reimplement anything: it calls the
// exact same configureClient + connect PKCE flow BYO-client uses, just with the app's own
// (non-secret) Client ID instead of one the person typed in - see drive-connection.mjs, which
// has no idea which source a Client ID came from.
ipcMain.handle('jarvis:driveAppOwnedStatus', () => ({ available: appOwnedLoginAvailable() }));
ipcMain.handle('jarvis:driveConnectAppOwned', async () => {
  if (!appOwnedLoginAvailable()) return { ok: false, error: 'Google sign-in through JARVIS is not available on this build yet.' };
  const configured = driveConnection.configureClient({ clientId: appOwnedClientId(), clientSecret: '' });
  if (!configured.ok) return configured;
  const r = await driveConnection.connect({ timeoutMs: 120000 });
  log('Drive connect (app-owned):', r.ok ? 'connected' : `failed (${r.error})`);
  if (r.ok) driveSyncController.syncNow();
  return { ok: r.ok, error: r.ok ? undefined : r.error, ...driveStatusForWindow() };
});

// ---------------------------------------------------------------- IPC: Google Drive backup/restore (Phase 24D)
// Main process owns every Drive operation - but the actual orchestration (the one in-flight-
// operation lock, preview-token issuance/enforcement, the last-backup record) lives in
// drive-backup-controller.mjs, a pure DI'd module, the same split every other IPC-backing
// piece of this app already uses. These handlers only validate what the renderer supplied and
// wire the result to the window - no path from the renderer ever becomes a local file path:
// Knowledge's own folder is always `userDir` (fixed, never renderer-supplied), and a backup id
// is only ever used as a Drive folder NAME, never a filesystem path.
const driveBackupController = createDriveBackupController({
  userDir,
  getProvider: () => createGoogleDriveProvider({ getAccessToken: driveConnection.getAccessToken, log }),
  loadConfig,
  saveConfig,
  log,
});

ipcMain.handle('jarvis:driveBackupNow', () => driveBackupController.backupNow());
ipcMain.handle('jarvis:driveBackupHistory', () => driveBackupController.backupHistory());
ipcMain.handle('jarvis:driveRestorePreview', (_e, backupId) => driveBackupController.restorePreview(backupId));
ipcMain.handle('jarvis:driveRestoreConfirm', async (_e, backupId, token) => {
  const r = await driveBackupController.restoreConfirm(backupId, token);
  if (r.ok) send({ kind: 'drive_restored', backupId });
  return r;
});
ipcMain.handle('jarvis:driveOperationStatus', () => driveBackupController.operationStatus());

// ---------------------------------------------------------------- IPC: Google Drive sync (Phase 3)
// Deliberately separate from the backup controller above: sync maintains one LIVE mirror
// (src/drive-sync.mjs's own "JARVIS Notes Sync" folder) and keeps backup's own immutable,
// timestamped runs completely untouched - "manual recovery backups stay independent of sync"
// is true by construction, not by a runtime check, since this controller never imports or
// calls anything backup-related. requestSync() is wired into every knowledge save/delete/
// restore/import handler below, debounced - local-first: a save lands on disk immediately,
// regardless of Drive; sync follows a few seconds later, in the background, never blocking.
const driveSyncController = createDriveSyncController({
  userDir,
  getProvider: () => createGoogleDriveProvider({ getAccessToken: driveConnection.getAccessToken, log }),
  isConnected: () => driveConnection.status().status === 'connected',
  log,
});
ipcMain.handle('jarvis:driveSyncStatus', () => driveSyncController.status());
ipcMain.handle('jarvis:driveSyncNow', () => driveSyncController.syncNow());
// A slow heartbeat (not a tight poll) picks up a retry whose backoff has elapsed, and is also
// how a device notices another device's remote changes with no local edit of its own to
// trigger the debounce. No-op whenever nothing is actually due - see drive-sync-controller.mjs.
const driveSyncHeartbeat = setInterval(() => driveSyncController.syncIfDue(), 5 * 60_000);
app.on('before-quit', () => clearInterval(driveSyncHeartbeat));

// ---------------------------------------------------------------- IPC: files (read-only) + VS Code
let fileIndex = null;
let fileIndexAt = 0;
ipcMain.handle('jarvis:files', (_e, force) => {
  if (!force && fileIndex && Date.now() - fileIndexAt < 30000) return fileIndex;
  try {
    fileIndex = { ...listFiles(loadConfig().cwd), vscode: hasVsCode() };
    fileIndexAt = Date.now();
  } catch (e) {
    log('listFiles failed', e?.message || e);
    return { files: [], truncated: false, vscode: hasVsCode(), error: String(e?.message || e) };
  }
  return fileIndex;
});
ipcMain.handle('jarvis:fileText', async (_e, rel) => {
  try { return await readWorkspaceFile(loadConfig().cwd, rel); }
  catch (e) { return { error: String(e?.message || e) }; }
});
/** Hand a workspace file (or folder) to VS Code; fall back to whatever Windows uses. */
ipcMain.handle('jarvis:openInCode', async (_e, rel, line) => {
  const { cwd } = loadConfig();
  if (!cwd) return { ok: false, error: NO_WORKSPACE };
  const r = await openInVsCode(cwd, rel, Number.isInteger(line) ? line : undefined);
  if (r.ok || r.outside) return r;
  log('open in VS Code failed', rel, r.error);
  const full = insideDir(cwd, String(rel || ''));
  if (!full || !fs.existsSync(full) || !(await reallyInside(cwd, full))) return r;
  // Without VS Code: a folder opens in Explorer, a plain document or picture in its usual
  // app (files.mjs, OPENABLE). Anything else - a script, a program, a shortcut, a type this
  // PC may run - is only shown in Explorer.
  let isDir = false;
  try { isDir = fs.statSync(full).isDirectory(); } catch { /* gone: shown below */ }
  if (!isDir && !OPENABLE.test(full)) { shell.showItemInFolder(full); return { ok: true, fallback: true, revealed: true }; }
  const err = await shell.openPath(full);
  return err ? r : { ok: true, fallback: true };
});
ipcMain.handle('jarvis:revealFile', (_e, rel) => {
  const { cwd } = loadConfig();
  const full = cwd ? insideDir(cwd, String(rel || '')) : null;
  if (!full) return false;
  shell.showItemInFolder(full);
  return true;
});

// ---------------------------------------------------------------- every window: our pages only
// The preload gives a page the whole window.jarvis bridge, so only JARVIS's own pages may
// ever hold it. For EVERY web contents - the main window, side chats, phone windows, and any
// future one - a link opens in the real browser (http/https only), a new window is never
// made, a navigation away from the page is refused, and <webview> is never attached. One
// guard, here, so a window that forgets its own (side chats once did) is still covered.
const OWN_PAGES = new Set(['index.html', 'phone.html'].map((f) => path.join(SRC, 'renderer', f).toLowerCase()));
const isOwnPage = (url) => {
  try { const u = new URL(url); return u.protocol === 'file:' && OWN_PAGES.has(fileURLToPath(u).toLowerCase()); } catch { return false; }
};
const openOutside = (url) => {
  if (!/^https?:\/\//i.test(String(url))) { log('refused to open a non-web link'); return; }
  if (process.env.JARVIS_CAPTURE) { log('capture: would open a link'); return; }
  shell.openExternal(url);
};
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: 'deny' }; });
  contents.on('will-navigate', (e, url) => {
    if (url === contents.getURL() || isOwnPage(url)) return;
    e.preventDefault();
    openOutside(url);
  });
  contents.on('will-redirect', (e, url) => { if (!isOwnPage(url)) e.preventDefault(); });
  contents.on('will-attach-webview', (e) => e.preventDefault());
});

// ---------------------------------------------------------------- lifecycle
process.on('uncaughtException', (e) => log('uncaught exception:', e?.stack || String(e)));
process.on('unhandledRejection', (e) => log('unhandled rejection:', e?.stack || String(e)));
app.on('child-process-gone', (_e, d) => log('child process gone:', d.type, d.reason, d.exitCode));
app.on('will-quit', () => log('JARVIS quitting'));
// Set before any window is asked to close, so the close-to-tray handler lets them go.
// With remote control on, quitting outright is said on the phone and taken off the group's
// board - then nothing is listening, so "Wake up" cannot work until JARVIS is started again.
// Four seconds at most, so no signal never holds the quit up.
let farewell = false;
app.on('before-quit', (e) => {
  quitting = true;
  if (farewell || !remote.ready || process.env.JARVIS_CAPTURE) return;
  farewell = true;
  e.preventDefault();
  log('quitting - telling the phone');
  const said = Promise.all([remote.announce(offlineNotice(pcLabel())), presence.clear()]).catch(() => {});
  Promise.race([said, new Promise((r) => setTimeout(r, 4000))]).then(() => app.quit());
});
// Diagnostic only: JARVIS_DIAG_QUERY=<out.json> runs the minimal SDK query in THIS process
// (the Electron main process, dev or packaged), writes the lifecycle to that file and quits.
// Nothing else starts - no window, no session. Off in normal use.
if (process.env.JARVIS_DIAG_QUERY) {
  app.whenReady().then(async () => {
    const out = process.env.JARVIS_DIAG_QUERY;
    try {
      const { runDiag } = await import('./diag-query.mjs');
      const r = await runDiag({
        exe: claudeExe(),
        cwd: process.env.JARVIS_DIAG_CWD || loadConfig().cwd,
        mode: process.env.JARVIS_DIAG_MODE || 'string',
        settingSources: (process.env.JARVIS_DIAG_SOURCES || 'user').split(',').filter(Boolean),
      });
      r.runtime.appPath = app.getAppPath();
      r.runtime.packaged = app.isPackaged;
      fs.writeFileSync(out, JSON.stringify(r, null, 2));
    } catch (e) {
      fs.writeFileSync(out, JSON.stringify({ ok: false, fatal: String(e?.stack || e).slice(0, 600) }, null, 2));
    }
    app.exit(0);
  });
} else
// Capture runs (debug aid) skip the lock so they work beside an open JARVIS window.
if (!process.env.JARVIS_CAPTURE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Opening JARVIS again (the shortcut, Start) brings back the one already running,
  // including from the tray.
  app.on('second-instance', () => { showWindow(); });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    // See IDENTITY at the top: only the packaged JARVIS.exe answers to the real id.
    app.setAppUserModelId(IDENTITY.appId);
    log('JARVIS starting; claude.exe at', claudeExe(), 'exists:', fs.existsSync(claudeExe()));
    if (launchHidden) log('started at login, in the tray');
    runTelegramTokenMigration();
    createWindow();
    // Phase 3: "sync on startup" - fire-and-forget; a disconnected account is simply a no-op
    // (driveSyncController's own isConnected() check), never a startup delay either way.
    if (driveConnection.status().status === 'connected') driveSyncController.syncNow();
    createTray();
    watchDeliveries();
    // Idle until remote control is switched on; then it listens. See remote.mjs.
    remote.start();
    // Routines' timer and the phone web app (if it is switched on). See features.mjs.
    features.start().catch((e) => log('features:', e?.message || e));
    syncBackground();
    if (remote.ready) presence.set('awake');
    // Restarted by a system update (the updater passes --updated): say so in the chat, so
    // the phone knows JARVIS is back and listening.
    if (process.argv.includes('--updated')) {
      log('started after a system update');
      remote.announce(`✅ System update installed - JARVIS v${app.getVersion()} is back online and listening.`);
    } else {
      // Opened at the desk (or at login): a hello on the phone, so it buzzes when the PC side comes up.
      // Not after an in-app restart (sign-in, folder change): the phone already knows JARVIS is up.
      if (!process.argv.includes('--restarted')) remote.announce(`👋 ${greeting(new Date(), pcLabel())}`).then((m) => { if (m) log('greeting sent to the phone'); });
    }
  });
  app.on('window-all-closed', async () => {
    // Powered down: the window went on purpose, and the listener stays for "Wake up".
    if (asleep) return;
    await shutdownChildren();
    app.quit();
  });
}
