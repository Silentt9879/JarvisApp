// JARVIS - Electron main process.
// Owns the window and the one live JarvisSession; the window talks to it only
// through the narrow IPC surface exposed in preload.cjs.
import { app, BrowserWindow, ipcMain, shell, Menu, dialog, net, nativeTheme, Tray, powerSaveBlocker, desktopCapturer, screen } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { JarvisSession, listRecent, loadHistory, findSessions, removeSession, renameStoredSession, isSessionId, IMAGE_TYPES, MAX_IMAGE_BYTES } from './session.mjs';
import { systemStats, gitStatus, knowledgeStatus, openIssues, handoffFocus, listDocs, readDoc, searchDocs, docRoots, savedEffort } from './workspace.mjs';
import { FLUTTER_APPS, isSerial, listDevices, startMirror, stopMirror, resetVideo, sendInput, flutterRun, flutterCommandFor, flutterLog, shutdownDevices } from './devices.mjs';
import { listWebApps, webRun, webStop, webLog, shutdownWebApps } from './webapps.mjs';
import { readDraft, readClickUp, syncClickUp } from './tasks.mjs';
import { createGitHub } from './github.mjs';
import { listFiles, readWorkspaceFile, openInVsCode, hasVsCode } from './files.mjs';
import { createPhoneWatcher, listPhones, enableWifi, connect as phoneConnect, postNotification } from './phone.mjs';
import { sendTelegram, verifyToken, discoverChat, isToken, isChatId } from './telegram.mjs';
import { createRemote, greeting } from './remote.mjs';
import { diffReport, morningBrief } from './reports.mjs';
import { createDeployWatcher } from './deploys.mjs';
import { createTranscriber } from './voice.mjs';
import { assist, cancelAssist, parseCommitMessage } from './gitai.mjs';
import { sourceRepos, repoDetail, allRepoStates, changedFiles, fileDiff, stageFiles, unstageFiles, stageAll, unstageAll, commit as gitCommit, listBranches, createBranch, switchBranch, renameBranch, deleteBranch, fetchRemote, pullRemote, pushRemote, publishBranch, cancelRemote, remoteState, commitHistory, commitDetail, commitFileDiff, listStashes, createStash, stashDetail, stashFileDiff, applyStash, dropStash, conflictState, conflictDetail, resolveConflict, assistContext } from './git.mjs';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.dirname(SRC);
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
const DEFAULT_CWD = 'C:\\Users\\bantu\\Downloads\\BantuApps';
const WINDOW_MODES = ['default', 'acceptEdits', 'plan', 'auto']; // deliberately no bypassPermissions

// ---------------------------------------------------------------- config + log
const userDir = app.getPath('userData');
const configPath = path.join(userDir, 'config.json');
const logPath = path.join(userDir, 'jarvis.log');

function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return { cwd: c.cwd || DEFAULT_CWD, phone: c.phone || {} };
  } catch {
    return { cwd: DEFAULT_CWD, phone: {} };
  }
}

/** Merge into config.json. Only ever called with settings the user chose. */
function saveConfig(patch) {
  let current = {};
  try { current = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { /* first write */ }
  const next = { ...current, ...patch };
  try { fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`); } catch (e) { log('could not save config:', e?.message || e); }
  return next;
}

/**
 * Phone alerts: { enabled, route, serial, address, minSeconds, telegram }.
 *
 * `route` is how the alert travels. 'adb' is the original: a notification posted straight
 * into the tray over USB or the same Wi-Fi, with nothing leaving this machine and no app on
 * the phone. 'telegram' goes out over the internet instead, so it reaches the phone on
 * mobile data anywhere - at the cost of the text passing through Telegram.
 */
function phoneConfig() {
  const p = loadConfig().phone || {};
  const t = p.telegram && typeof p.telegram === 'object' ? p.telegram : {};
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
      token: isToken(t.token) ? t.token : null,
      chatId: isChatId(t.chatId) ? String(t.chatId) : null,
      name: typeof t.name === 'string' ? t.name.slice(0, 60) : null,
    },
  };
}

/**
 * The window must never be handed the bot token: it is a credential, and the renderer has
 * no business holding one. It is told only whether a token is set, and what the bot is
 * called.
 */
function phoneConfigForWindow(c) {
  return {
    ...c,
    telegram: { hasToken: !!c.telegram.token, chatId: c.telegram.chatId, name: c.telegram.name },
  };
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
const toWindow = (evt) => { if (win && !win.isDestroyed()) win.webContents.send('jarvis:event', evt); };
const remote = createRemote({
  cfg: () => {
    const c = phoneConfig();
    // Never during a screenshot run: those start and quit by themselves, and must not take
    // a real message off the queue. JARVIS_REMOTE_TEST=1 allows it for a run that is
    // about remote control.
    const allowed = !process.env.JARVIS_CAPTURE || process.env.JARVIS_REMOTE_TEST === '1';
    return { on: allowed && c.remote && c.route === 'telegram', mirror: c.mirror, token: c.telegram.token, chatId: c.telegram.chatId, name: c.telegram.name };
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
  interrupt: () => { toWindow({ kind: 'remote_stop' }); ensureSession().interrupt(); },
  respond: (id, decision, verdict) => { toWindow({ kind: 'prompt_remote', id, verdict }); ensureSession().respond(id, decision); },
  workspace: () => loadConfig().cwd,
  screens: captureScreens,
  diff: (query) => diffReport(loadConfig().cwd, query),
  brief: buildBrief,
  briefSet: (patch) => { const next = { ...briefConfig(), ...patch }; saveConfig({ brief: next }); log('morning brief:', next.on ? `on at ${next.at}` : 'off'); return next; },
  sessions: () => listRecent(loadConfig().cwd),
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
  let b = {};
  try { b = JSON.parse(fs.readFileSync(configPath, 'utf8')).brief || {}; } catch { /* defaults */ }
  return { on: b.on !== false, at: /^\d\d:\d\d$/.test(b.at || '') ? b.at : '08:00', sent: typeof b.sent === 'string' ? b.sent : null };
}
async function buildBrief() {
  const { cwd } = loadConfig();
  const recent = await listRecent(cwd).catch(() => []);
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

function remoteWanted() {
  const c = phoneConfig();
  return !process.env.JARVIS_CAPTURE && c.remote && c.route === 'telegram';
}

/** Bring the window back from the tray, the taskbar or a login start. */
function showWindow() {
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
  tray?.setToolTip(on ? 'JARVIS - listening to Telegram' : 'JARVIS');
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
    else if (!launchHidden) { win.maximize(); win.show(); shownOnce = true; }
  });

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

  // Links open in the real browser; the app window never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  // Ctrl+Shift+I for developer tools (there is no menu bar).
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') {
      win.webContents.toggleDevTools();
    }
  });

  win.on('closed', () => { win = null; });
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
    // JARVIS_STORE=key=value seeds one localStorage item before the view opens, so a
    // capture can be pointed at a particular saved state (which repository Source Control
    // reopens, say) without clicking through the UI or disturbing the real settings.
    const store = /^([\w.]{1,60})=(.{0,200})$/.exec(process.env.JARVIS_STORE || '');
    if (store) {
      win.webContents.once('did-finish-load', () => {
        win.webContents.executeJavaScript(
          `try { localStorage.setItem(${JSON.stringify(store[1])}, ${JSON.stringify(store[2])}); } catch {}`,
        );
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
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      try { fs.writeFileSync(process.env.JARVIS_CAPTURE, (await win.webContents.capturePage()).toPNG()); }
      catch (e) { log('capture failed', e?.message || e); }
      app.quit();
    }, Number(process.env.JARVIS_CAPTURE_DELAY || 9000)));
  }
}

// ---------------------------------------------------------------- IPC: session
function ensureSession() {
  if (!session) {
    const { cwd } = loadConfig();
    session = new JarvisSession({ cwd, exe: claudeExe(), emit: send, log });
  }
  return session;
}

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
  const { cwd } = loadConfig();
  return { cwd, cwdExists: fs.existsSync(cwd), version: app.getVersion(), electron: process.versions.electron, exeFound: fs.existsSync(claudeExe()), capture: !!process.env.JARVIS_CAPTURE };
});

// The caption buttons' colours, matched to the header (--surface and --text-2 in styles.css).
// 40 px tall: the fullscreen phone's title strip is the same height, so the buttons sit
// exactly on it there, and on the 52 px header they sit in the same colour as the header.
const TITLE_BAR = {
  dark: { color: '#15171a', symbolColor: '#a4abb3', height: 40 },
  light: { color: '#ffffff', symbolColor: '#555d66', height: 40 },
};
ipcMain.handle('jarvis:titleBar', (_e, theme) => {
  const t = TITLE_BAR[theme === 'light' ? 'light' : 'dark'];
  try { if (win && !win.isDestroyed()) win.setTitleBarOverlay(t); } catch { /* not supported here */ }
  try { if (win && !win.isDestroyed()) win.setBackgroundColor(theme === 'light' ? '#f7f8f9' : '#0d0e10'); } catch { /* cosmetic */ }
  return true;
});

// ---------------------------------------------------------------- the workspace folder
// Chosen in Settings. The session takes its folder when it is created, and so do the file
// index, the memory path and every git read, so a change cannot be applied in place
// honestly: the new folder is saved and JARVIS restarts into it. Picking a folder and
// switching to it are separate calls, so the window can confirm in between.
ipcMain.handle('jarvis:pickWorkspace', async () => {
  const cur = loadConfig().cwd;
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose the workspace folder',
    defaultPath: fs.existsSync(cur) ? cur : app.getPath('home'),
    properties: ['openDirectory'],
  });
  if (r.canceled || !r.filePaths?.[0]) return { ok: false, canceled: true };
  return { ok: true, path: r.filePaths[0] };
});
ipcMain.handle('jarvis:setWorkspace', (_e, dir) => {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return { ok: false, error: 'That is not a full folder path.' };
  let st = null;
  try { st = fs.statSync(dir); } catch { /* reported below */ }
  if (!st || !st.isDirectory()) return { ok: false, error: 'That folder does not exist.' };
  const resolved = path.resolve(dir);
  if (resolved === path.resolve(loadConfig().cwd)) return { ok: true, unchanged: true };
  saveConfig({ cwd: resolved });
  log('workspace changed to', resolved, '- restarting');
  // Give the reply a moment to reach the window, then stop everything this app started -
  // app.exit skips window-all-closed, and claude.exe, a dotnet watch or a flutter run left
  // behind would keep running against the old folder.
  setTimeout(async () => { await shutdownChildren(); app.relaunch(); app.exit(0); }, 400);
  return { ok: true, restarting: true };
});

/**
 * Stop everything this app started: the Claude Code session, any web app or API run from
 * the Devices view, phone mirrors and flutter runs. The apps stay installed on the phones.
 * Bounded at three seconds, so a phone that never answers cannot hold the app open.
 */
async function shutdownChildren() {
  try { remote.stop(); } catch { /* shutting down */ }
  try { session?.close(); } catch { /* shutting down */ }
  try { shutdownWebApps(); } catch { /* shutting down */ }
  await Promise.race([shutdownDevices().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
}
ipcMain.handle('jarvis:claudeVersion', () => (fs.existsSync(claudeExe()) ? claudeVersion() : null));
ipcMain.handle('jarvis:start', (_e, opts) => { remote.sessionStarted(); ensureSession().start(opts || {}); return true; });
ipcMain.handle('jarvis:send', (_e, payload) => {
  const r = ensureSession().send(payload);
  // Every message is noted with where it came from, so its reply can go back there.
  try {
    const atts = Array.isArray(payload?.attachments) ? payload.attachments : [];
    remote.noteSend(payload?.origin === 'telegram' ? 'telegram' : 'desk', r, { text: typeof payload?.text === 'string' ? payload.text : '', attachments: atts });
  } catch (e) { log('remote:', e?.message || e); }
  return r;
});
ipcMain.handle('jarvis:interrupt', () => ensureSession().interrupt());
ipcMain.handle('jarvis:respond', (_e, id, decision) => { ensureSession().respond(id, decision); return true; });
ipcMain.handle('jarvis:setModel', (_e, model) => ensureSession().setModel(model));
ipcMain.handle('jarvis:setMode', (_e, mode) => {
  // Deliberately no bypass: the window only offers modes that still check before acting.
  if (!WINDOW_MODES.includes(mode)) return false;
  return ensureSession().setPermissionMode(mode);
});
ipcMain.handle('jarvis:setEffort', (_e, level) => ensureSession().setEffort(level));
ipcMain.handle('jarvis:setThinking', (_e, on) => ensureSession().setThinking(on));
ipcMain.handle('jarvis:context', (_e, detail) => ensureSession().refreshContext(detail === 'full' ? 'full' : 'summary'));
ipcMain.handle('jarvis:sessions', async () => {
  try { return await listRecent(loadConfig().cwd); }
  catch (e) { log('listSessions failed', e?.message || e); return []; }
});
ipcMain.handle('jarvis:history', async (_e, id) => {
  try { return await loadHistory(loadConfig().cwd, id); }
  catch (e) { log('history failed', e?.message || e); return []; }
});
ipcMain.handle('jarvis:findSessions', async (_e, text) => {
  try { return await findSessions(loadConfig().cwd, text); }
  catch (e) { log('findSessions failed', e?.message || e); return []; }
});
/** Permanently delete a session. This app's own conversation is closed first; the window then starts a new one. */
ipcMain.handle('jarvis:deleteSession', async (_e, id) => {
  if (!isSessionId(id)) return { ok: false, error: 'That is not a session id.' };
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
  const r = await ensureSession().rewindFiles(uuid, dryRun !== false);
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
/** Video packets go on their own channel: dozens a second, never through the chat event path. */
function sendVideo(p) {
  if (win && !win.isDestroyed()) win.webContents.send('jarvis:video', p);
}
ipcMain.handle('jarvis:devices', async () => {
  try { return { ok: true, list: await listDevices() }; }
  catch (e) { log('listDevices failed', e?.message || e); return { ok: false, error: String(e?.message || e), list: [] }; }
});
ipcMain.handle('jarvis:flutterApps', () => {
  const { cwd } = loadConfig();
  return Object.entries(FLUTTER_APPS).map(([key, a]) => ({ key, name: a.name, dir: a.dir, found: fs.existsSync(path.join(cwd, a.dir, 'pubspec.yaml')) }));
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
ipcMain.handle('jarvis:flutterRun', (_e, serial, app) => {
  try { return { ok: true, run: flutterRun(loadConfig().cwd, serial, app, send) }; }
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
      // A token is only ever replaced by a valid one, or cleared outright with null. A
      // half-typed token must not wipe a working one out of the config.
      token: t.token === null ? null : (isToken(t.token) ? t.token.trim() : cur.telegram.token),
      chatId: t.chatId === null ? null : (isChatId(t.chatId) ? String(t.chatId).trim() : cur.telegram.chatId),
      name: t.name === null ? null : (typeof t.name === 'string' ? t.name.slice(0, 60) : cur.telegram.name),
    },
  };
  saveConfig({ phone: next });
  phone.reset();
  const where = next.route === 'telegram' ? `Telegram ${next.telegram.name || next.telegram.chatId || '(not set up)'}` : (next.serial || 'no phone');
  log('phone alerts:', next.enabled ? `on via ${where}` : 'off');
  const remoteBefore = cur.remote && cur.route === 'telegram';
  const remoteNow = next.remote && next.route === 'telegram';
  if (remoteNow !== remoteBefore) {
    log('remote control:', remoteNow ? 'on' : 'off');
    syncBackground();
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
  saveConfig({ phone: { ...cur, telegram: { ...cur.telegram, token: use, name: r.name } } });
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
  saveConfig({ phone: { ...cur, telegram: { ...cur.telegram, chatId: r.chatId } } });
  phone.reset();
  log('telegram chat found:', r.name);
  return { ok: true, chatId: r.chatId, name: r.name };
});
ipcMain.handle('jarvis:phoneWifi', async (_e, serial) => {
  const r = await enableWifi(serial);
  if (r.ok) { saveConfig({ phone: { ...phoneConfig(), serial: r.address, address: r.address } }); phone.reset(); }
  else log('phone wifi setup failed:', r.error || '');
  return r;
});
// ---------------------------------------------------------------- IPC: Source Control
// Phase 1 is read-only. Every call names its repository by key and git.mjs resolves that
// key afresh, so a reply can never belong to a repository other than the one asked about.
// No model is involved: a status costs zero tokens.
ipcMain.handle('jarvis:gitRepos', async () => {
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
      extra: { repoName: context.repo.name, path: (opts || {}).path, meta: context.meta },
    });
    log('git assist finished', key, action, r.ok ? `ok (${(r.text || '').length} chars)` : `failed: ${(r.error || '').slice(0, 160)}`);
    return { ...r, key, scopeInfo: { files: context.files, lines: context.lines, label: context.scope, secrets: context.secrets } };
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
ipcMain.handle('jarvis:webApps', () => listWebApps(loadConfig().cwd));
ipcMain.handle('jarvis:webRun', (_e, key, watch) => {
  try { return { ok: true, run: webRun(loadConfig().cwd, key, { watch: watch !== false }, send) }; }
  catch (e) { return { ok: false, error: String(e?.message || e) }; }
});
ipcMain.handle('jarvis:webStop', (_e, key) => webStop(key));
/** Open a running local site in the normal browser. Nothing but this machine's own ports. */
ipcMain.handle('jarvis:openUrl', (_e, url) => {
  if (typeof url !== 'string' || !LOCAL_URL.test(url)) { log('refused to open', url); return false; }
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
ipcMain.handle('jarvis:clickup', () => readClickUp(userDir));
ipcMain.handle('jarvis:draftTasks', () => {
  try { return readDraft(loadConfig().cwd); }
  catch (e) { log('readDraft failed', e?.message || e); return { available: false, sections: [] }; }
});
let syncing = null;
ipcMain.handle('jarvis:clickupSync', () => {
  // One sync at a time; a second click joins the one already running.
  if (!syncing) {
    log('clickup sync requested');
    syncing = syncClickUp({ cwd: loadConfig().cwd, exe: claudeExe(), userDir, log })
      .finally(() => { syncing = null; });
  }
  return syncing;
});

// ---------------------------------------------------------------- IPC: workspace (read-only)
ipcMain.handle('jarvis:stats', () => systemStats(loadConfig().cwd));
ipcMain.handle('jarvis:online', () => net.isOnline());
ipcMain.handle('jarvis:savedEffort', (_e, model) => savedEffort(loadConfig().cwd, model));

let wsCache = null;
let wsAt = 0;
let wsBusy = null;
ipcMain.handle('jarvis:workspace', async (_e, force) => {
  if (wsBusy) return wsBusy;
  if (!force && wsCache && Date.now() - wsAt < 20000) return wsCache;
  const { cwd } = loadConfig();
  wsBusy = (async () => {
    const [repos, knowledge, issues, focus] = await Promise.all([
      gitStatus(cwd).catch((e) => { log('git status failed', e?.message || e); return []; }),
      knowledgeStatus(cwd).catch((e) => ({ available: false, error: String(e?.message || e) })),
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
ipcMain.handle('jarvis:roots', () => Object.fromEntries(Object.entries(docRoots(loadConfig().cwd)).map(([k, v]) => [k, v.label])));
/** Open a browsable document in the default editor (same folder checks as reading it). */
ipcMain.handle('jarvis:openDoc', async (_e, root, rel) => {
  try { const d = await readDoc(loadConfig().cwd, root, rel); return (await shell.openPath(d.full)) === ''; }
  catch { return false; }
});
ipcMain.handle('jarvis:openLogs', () => shell.openPath(userDir));

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
  const r = await openInVsCode(cwd, rel, Number.isInteger(line) ? line : undefined);
  if (r.ok) return r;
  log('open in VS Code failed', rel, r.error);
  const full = path.resolve(cwd, String(rel || ''));
  if (full.startsWith(path.resolve(cwd))) {
    const err = await shell.openPath(full);
    if (!err) return { ok: true, fallback: true };
  }
  return r;
});
ipcMain.handle('jarvis:revealFile', (_e, rel) => {
  const { cwd } = loadConfig();
  const full = path.resolve(cwd, String(rel || ''));
  if (!full.startsWith(path.resolve(cwd))) return false;
  shell.showItemInFolder(full);
  return true;
});

// ---------------------------------------------------------------- lifecycle
process.on('uncaughtException', (e) => log('uncaught exception:', e?.stack || String(e)));
process.on('unhandledRejection', (e) => log('unhandled rejection:', e?.stack || String(e)));
app.on('child-process-gone', (_e, d) => log('child process gone:', d.type, d.reason, d.exitCode));
app.on('will-quit', () => log('JARVIS quitting'));
// Set before any window is asked to close, so the close-to-tray handler lets them go.
app.on('before-quit', () => { quitting = true; });
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
    createWindow();
    createTray();
    // Idle until remote control is switched on; then it listens. See remote.mjs.
    remote.start();
    syncBackground();
    // Restarted by a system update (the updater passes --updated): say so in the chat, so
    // the phone knows JARVIS is back and listening.
    if (process.argv.includes('--updated')) {
      log('started after a system update');
      remote.announce(`✅ System update installed - JARVIS v${app.getVersion()} is back online and listening.`);
    } else {
      // Opened at the desk (or at login): a hello on the phone, so it buzzes when the PC side comes up.
      remote.announce(`👋 ${greeting()}`).then((m) => { if (m) log('greeting sent to the phone'); });
    }
  });
  app.on('window-all-closed', async () => {
    await shutdownChildren();
    app.quit();
  });
}
