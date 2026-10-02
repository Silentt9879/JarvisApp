// JARVIS - Electron main process.
// Owns the window and the one live JarvisSession; the window talks to it only
// through the narrow IPC surface exposed in preload.cjs.
import { app, BrowserWindow, ipcMain, shell, Menu, dialog, net } from 'electron';
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
import { listFiles, readWorkspaceFile, openInVsCode, hasVsCode } from './files.mjs';
import { createPhoneWatcher, listPhones, enableWifi, connect as phoneConnect, postNotification } from './phone.mjs';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.dirname(SRC);
// Before anything creates a window: this is the name Windows shows for the app.
app.setName('JARVIS');
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

/** Phone alerts: { enabled, serial, address, minSeconds }. */
function phoneConfig() {
  const p = loadConfig().phone || {};
  return {
    enabled: !!p.enabled,
    serial: isSerial(p.serial) ? p.serial : null,
    address: typeof p.address === 'string' ? p.address : null,
    minSeconds: Number.isFinite(p.minSeconds) ? p.minSeconds : 30,
  };
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
});

function send(evt) {
  if (win && !win.isDestroyed()) win.webContents.send('jarvis:event', evt);
  try { phone.event(evt); } catch (e) { log('phone watcher:', e?.message || e); }
}

function createWindow() {
  const capture = !!process.env.JARVIS_CAPTURE;
  // JARVIS_SIZE=<w>x<h> lets a capture check a state at a particular window size.
  const sized = /^(\d{3,4})x(\d{3,4})$/.exec(process.env.JARVIS_SIZE || '');
  win = new BrowserWindow({
    width: 1500,
    height: 930,
    // Small enough to sit beside your editor with one phone on screen, the way scrcpy does.
    minWidth: 380,
    minHeight: 520,
    title: 'JARVIS',
    backgroundColor: '#020812',
    icon: windowIcon(),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#030c18', symbolColor: '#7fd4ff', height: 40 },
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

  win.loadFile(path.join(SRC, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    // Capture runs (a debug aid) stay off-screen and never take focus from the user.
    if (capture) {
      win.setBounds({ x: -5000, y: 0, width: sized ? Number(sized[1]) : 1600, height: sized ? Number(sized[2]) : 960 });
      win.showInactive();
    }
    else { win.maximize(); win.show(); }
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
    if (view) {
      win.webContents.once('did-finish-load', () => setTimeout(() => {
        win.webContents.executeJavaScript(`window.__jarvisShow && window.__jarvisShow(${JSON.stringify(view)});`);
      }, 1500));
    }
    // JARVIS_CLICK=<id or .class>, comma-separated to click several in turn before the capture.
    const clicks = (process.env.JARVIS_CLICK || '').split(',').map((c) => c.trim())
      .filter((c) => /^[.#]?[A-Za-z][\w.#-]*$/.test(c));
    if (clicks.length) {
      const start = Number(process.env.JARVIS_CAPTURE_DELAY || 9000) - 1500 - (clicks.length - 1) * 1200;
      clicks.forEach((click, i) => {
        win.webContents.once('did-finish-load', () => setTimeout(() => {
          const sel = click.startsWith('.') ? click : `#${click}`;
          win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(sel)})?.click();`);
        }, Math.max(1500, start + i * 1200)));
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
  return { cwd, version: app.getVersion(), electron: process.versions.electron, exeFound: fs.existsSync(claudeExe()) };
});
ipcMain.handle('jarvis:claudeVersion', () => (fs.existsSync(claudeExe()) ? claudeVersion() : null));
ipcMain.handle('jarvis:start', (_e, opts) => { ensureSession().start(opts || {}); return true; });
ipcMain.handle('jarvis:send', (_e, payload) => ensureSession().send(payload));
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
  return { ...cfg, phones, connected: phones.some((p) => p.serial === cfg.serial && p.state === 'device') };
});
ipcMain.handle('jarvis:phoneSet', (_e, patch) => {
  const cur = phoneConfig();
  const p = patch && typeof patch === 'object' ? patch : {};
  const next = {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : cur.enabled,
    serial: p.serial === null ? null : (isSerial(p.serial) ? p.serial : cur.serial),
    address: p.address === null ? null : (typeof p.address === 'string' ? p.address : cur.address),
    minSeconds: Number.isFinite(p.minSeconds) ? Math.max(0, Math.min(3600, p.minSeconds)) : cur.minSeconds,
  };
  saveConfig({ phone: next });
  phone.reset();
  log('phone alerts:', next.enabled ? `on for ${next.serial || 'no phone'}` : 'off');
  return next;
});
ipcMain.handle('jarvis:phoneWifi', async (_e, serial) => {
  const r = await enableWifi(serial);
  if (r.ok) { saveConfig({ phone: { ...phoneConfig(), serial: r.address, address: r.address } }); phone.reset(); }
  else log('phone wifi setup failed:', r.error || '');
  return r;
});
ipcMain.handle('jarvis:phoneTest', async (_e, serial) => {
  const target = isSerial(serial) ? serial : phoneConfig().serial;
  if (!target) return { ok: false, error: 'No phone chosen yet.' };
  return postNotification(target, {
    title: 'JARVIS',
    body: 'Phone alerts are working. You will hear from me when a long turn finishes or I need a decision.',
  });
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
// Capture runs (debug aid) skip the lock so they work beside an open JARVIS window.
if (!process.env.JARVIS_CAPTURE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    app.setAppUserModelId('com.bantuapps.jarvis'); // Windows needs this for desktop notifications
    log('JARVIS starting; claude.exe at', claudeExe(), 'exists:', fs.existsSync(claudeExe()));
    createWindow();
  });
  app.on('window-all-closed', async () => {
    try { session?.close(); } catch { /* shutting down */ }
    // Phone screens, flutter runs and any site started here end with the app; the apps stay
    // installed on the phones.
    try { shutdownWebApps(); } catch { /* shutting down */ }
    await Promise.race([shutdownDevices().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
    app.quit();
  });
}
