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
import { createGitHub } from './github.mjs';
import { listFiles, readWorkspaceFile, openInVsCode, hasVsCode } from './files.mjs';
import { createPhoneWatcher, listPhones, enableWifi, connect as phoneConnect, postNotification } from './phone.mjs';
import { assist, cancelAssist, parseCommitMessage } from './gitai.mjs';
import { sourceRepos, repoDetail, allRepoStates, changedFiles, fileDiff, stageFiles, unstageFiles, stageAll, unstageAll, commit as gitCommit, listBranches, createBranch, switchBranch, renameBranch, deleteBranch, fetchRemote, pullRemote, pushRemote, publishBranch, cancelRemote, remoteState, commitHistory, commitDetail, commitFileDiff, listStashes, createStash, stashDetail, stashFileDiff, applyStash, dropStash, conflictState, conflictDetail, resolveConflict, assistContext } from './git.mjs';

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
