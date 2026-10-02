// Devices - the Android phones plugged into this PC, for the Devices view.
//
// Screens: scrcpy 3.3.3's server (vendor/, pushed under its own name so the user's own
// scrcpy keeps working) driven by Tango (@yume-chan/*) over the adb server that is already
// running - JARVIS never starts a second adb, which would fight Flutter's and scrcpy's.
// Video goes to the window as H.264 packets; the window decodes them (WebCodecs).
//
// Flutter: one `flutter run --machine -d <serial>` per phone. The machine protocol gives
// hot reload / hot restart / stop as commands and the app's log as events.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AdbServerClient } from '@yume-chan/adb';
import { AdbServerNodeTcpConnector } from '@yume-chan/adb-server-node-tcp';
import { AdbScrcpyClient, AdbScrcpyOptions3_3_3 } from '@yume-chan/adb-scrcpy';
import { AndroidKeyCode, AndroidKeyEventAction, AndroidMotionEventAction, ScrcpyInstanceId } from '@yume-chan/scrcpy';
import { ReadableStream, WritableStream } from '@yume-chan/stream-extra';

const APP_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SERVER_FILE = path.join(APP_ROOT, 'vendor', 'scrcpy-server-v3.3.3');
const SERVER_ON_DEVICE = '/data/local/tmp/jarvis-scrcpy-server-v3.3.3.jar';

/** The Flutter apps in the workspace (directory -> the user's nickname). */
export const FLUTTER_APPS = {
  customer: { dir: 'bantupanduv2', name: 'Customer App' },
  advisor: { dir: 'advisorv2', name: 'Advisor App' },
  driver: { dir: 'BantuRescueDriver_v2', name: 'Driver App' },
  panel: { dir: 'BantuAutoPanel_v2', name: 'Panel App' },
  merchant: { dir: 'bantu2u_merchant', name: 'Merchant App' },
};

const SERIAL = /^[A-Za-z0-9._:-]{1,80}$/;
export const isSerial = (s) => typeof s === 'string' && SERIAL.test(s);

// ---------------------------------------------------------------- adb server
let adbClient = null;
function client() {
  if (!adbClient) adbClient = new AdbServerClient(new AdbServerNodeTcpConnector({ host: '127.0.0.1', port: 5037 }));
  return adbClient;
}

/** The adb Flutter uses (Android SDK) first, so a server we start is the one it expects. */
export function adbExecutable() {
  const sdks = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk')];
  for (const sdk of sdks.filter(Boolean)) {
    const p = path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
    if (fs.existsSync(p)) return p;
  }
  return 'adb';
}

function startAdbServer() {
  return new Promise((resolve) => execFile(adbExecutable(), ['start-server'], { windowsHide: true, timeout: 20000 }, () => resolve()));
}

export async function listDevices() {
  let list;
  try {
    list = await client().getDevices(['device', 'unauthorized', 'offline']);
  } catch (e) {
    if (!/ECONNREFUSED|connect/i.test(String(e?.message || e))) throw e;
    await startAdbServer(); // nothing was listening on 5037
    list = await client().getDevices(['device', 'unauthorized', 'offline']);
  }
  return list.map((d) => ({
    serial: d.serial,
    state: d.state,
    model: (d.model || '').replace(/_/g, ' '),
    product: d.product || '',
    mirroring: mirrors.has(d.serial),
    flutter: runs.has(d.serial) ? runState(runs.get(d.serial)) : null,
  }));
}

// ---------------------------------------------------------------- screens
const mirrors = new Map(); // serial -> { sc, closing }

/**
 * Start a live screen. `video(packet)` gets each H.264 packet; `event(e)` gets
 * mirror_start / mirror_end. Resolves once the stream is up.
 */
export async function startMirror(serial, { video, event, log }) {
  if (!isSerial(serial)) throw new Error('Not a device serial.');
  if (mirrors.has(serial)) return;
  mirrors.set(serial, { sc: null, closing: false }); // reserve: a second click must not start twice
  try {
    const adb = await client().createAdb({ serial });
    const server = fs.readFileSync(SERVER_FILE);
    await AdbScrcpyClient.pushServer(adb, new ReadableStream({ start(c) { c.enqueue(new Uint8Array(server)); c.close(); } }), SERVER_ON_DEVICE);
    const options = new AdbScrcpyOptions3_3_3({
      audio: false,
      control: true,
      videoCodec: 'h264',
      maxSize: 1280,
      videoBitRate: 6_000_000,
      maxFps: 45,
      tunnelForward: true, // adb forward, not a listening socket here: no firewall prompt
      scid: ScrcpyInstanceId.random(), // its own socket name, so it runs beside scrcpy itself
      stayAwake: true,
      clipboardAutosync: false,
      logLevel: 'warn',
    });
    const sc = await AdbScrcpyClient.start(adb, SERVER_ON_DEVICE, options);
    const entry = mirrors.get(serial);
    if (!entry || entry.closing) { await sc.close().catch(() => {}); mirrors.delete(serial); return; }
    entry.sc = sc;
    sc.output.pipeTo(new WritableStream({ write(line) { log?.(`[scrcpy ${serial}]`, line); } })).catch(() => {});
    sc.clipboard?.pipeTo(new WritableStream({ write() {} })).catch(() => {});
    const vs = await sc.videoStream;
    event({ kind: 'mirror_start', serial, width: vs.width, height: vs.height, name: vs.metadata?.deviceName || '' });
    (async () => {
      let reason = 'stopped';
      try {
        const reader = vs.stream.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          video({
            serial,
            type: value.type,
            keyframe: value.type === 'data' ? !!value.keyframe : false,
            pts: value.type === 'data' && value.pts != null ? Number(value.pts) : 0,
            data: value.data.slice(), // a view may share a large buffer; send only these bytes
          });
        }
      } catch (e) {
        reason = String(e?.message || e);
      }
      const had = mirrors.get(serial);
      mirrors.delete(serial);
      if (had?.sc) await had.sc.close().catch(() => {});
      event({ kind: 'mirror_end', serial, reason: had?.closing ? 'stopped' : reason });
    })();
  } catch (e) {
    mirrors.delete(serial);
    throw e;
  }
}

export async function stopMirror(serial) {
  const m = mirrors.get(serial);
  if (!m) return;
  m.closing = true;
  if (m.sc) await m.sc.close().catch(() => {});
}

/** Ask the phone for a fresh keyframe (after a decoder error in the window). */
export async function resetVideo(serial) {
  const c = mirrors.get(serial)?.sc?.controller;
  if (c?.resetVideo) await c.resetVideo().catch(() => {});
}

const KEYS = {
  back: null, // backOrScreenOn
  home: AndroidKeyCode.AndroidHome,
  recents: AndroidKeyCode.AndroidAppSwitch,
  enter: 66,
  backspace: 67,
  tab: 61,
  delete: 112,
  up: 19,
  down: 20,
  left: 21,
  right: 22,
};
const TOUCH = { down: AndroidMotionEventAction.Down, move: AndroidMotionEventAction.Move, up: AndroidMotionEventAction.Up };
const num = (v, lo, hi) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);

/** Touch, scroll, keys and text from the window. Everything is range-checked here. */
export async function sendInput(serial, ev) {
  const c = mirrors.get(serial)?.sc?.controller;
  if (!c || !ev || typeof ev !== 'object') return;
  const w = num(ev.w, 1, 10000);
  const h = num(ev.h, 1, 10000);
  switch (ev.kind) {
    case 'touch': {
      const action = TOUCH[ev.action];
      const x = num(ev.x, 0, w);
      const y = num(ev.y, 0, h);
      if (action == null || x == null || y == null || !w || !h) return;
      await c.injectTouch({
        action,
        pointerId: -2n, // a generic finger
        pointerX: Math.round(x),
        pointerY: Math.round(y),
        videoWidth: w, // must equal the current video size, or the phone ignores it
        videoHeight: h,
        pressure: ev.action === 'up' ? 0 : 1,
        actionButton: 0,
        buttons: 0,
      });
      return;
    }
    case 'scroll': {
      const x = num(ev.x, 0, w);
      const y = num(ev.y, 0, h);
      if (x == null || y == null || !w || !h) return;
      await c.injectScroll({ pointerX: Math.round(x), pointerY: Math.round(y), videoWidth: w, videoHeight: h, scrollX: num(ev.dx, -1, 1) || 0, scrollY: num(ev.dy, -1, 1) || 0, buttons: 0 });
      return;
    }
    case 'key': {
      if (!(ev.key in KEYS)) return;
      if (ev.key === 'back') {
        await c.backOrScreenOn(AndroidKeyEventAction.Down);
        await c.backOrScreenOn(AndroidKeyEventAction.Up);
        return;
      }
      for (const action of [AndroidKeyEventAction.Down, AndroidKeyEventAction.Up]) {
        await c.injectKeyCode({ action, keyCode: KEYS[ev.key], repeat: 0, metaState: 0 });
      }
      return;
    }
    case 'text': {
      if (typeof ev.text !== 'string' || !ev.text || ev.text.length > 2000) return;
      await c.injectText(ev.text);
      return;
    }
    default:
      return;
  }
}

// ---------------------------------------------------------------- flutter run
const runs = new Map(); // serial -> run
const MAX_LOG = 1500;

function runState(r) {
  return { app: r.app, name: FLUTTER_APPS[r.app].name, state: r.state, since: r.since };
}

function flutterCommand() {
  // flutter is a .bat on Windows: it has to go through cmd. Arguments are fixed words and
  // a checked serial, never free text.
  return process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', 'flutter']] : ['flutter', []];
}

/** Start `flutter run` for one app on one phone. `emit(e)` gets flutter_state / flutter_log. */
export function flutterRun(workspace, serial, appKey, emit) {
  if (!isSerial(serial)) throw new Error('Not a device serial.');
  const app = FLUTTER_APPS[appKey];
  if (!app) throw new Error('Unknown app.');
  if (runs.has(serial)) throw new Error(`${runs.get(serial).name} is already running on this phone - stop it first.`);
  const cwd = path.join(workspace, app.dir);
  if (!fs.existsSync(path.join(cwd, 'pubspec.yaml'))) throw new Error(`${app.name} (${app.dir}) was not found in the workspace.`);

  const [cmd, pre] = flutterCommand();
  const proc = spawn(cmd, [...pre, 'run', '--machine', '-d', serial], { cwd, windowsHide: true, env: { ...process.env } });
  const r = { serial, app: appKey, name: app.name, proc, state: 'building', since: Date.now(), appId: null, seq: 0, lines: [], pending: [], flush: null, emit };
  runs.set(serial, r);
  const state = (s, message) => { r.state = s; r.since = Date.now(); emit({ kind: 'flutter_state', serial, ...runState(r), message: message || null }); };
  const line = (text, level = 'info') => {
    const t = String(text).replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+$/, '');
    if (!t) return;
    const entry = { t: Date.now(), level, text: t.length > 2000 ? t.slice(0, 2000) + '…' : t };
    r.lines.push(entry);
    if (r.lines.length > MAX_LOG) r.lines.splice(0, r.lines.length - MAX_LOG);
    r.pending.push(entry);
    // Batched: a build prints hundreds of lines a second.
    if (!r.flush) r.flush = setTimeout(() => { r.flush = null; const lines = r.pending.splice(0); if (lines.length) emit({ kind: 'flutter_log', serial, lines }); }, 150);
  };
  state('building', `flutter run -d ${serial} in ${app.dir}`);

  const onMessage = (m) => {
    if (m.event) {
      const p = m.params || {};
      switch (m.event) {
        case 'app.start': r.appId = p.appId; state('starting'); return;
        case 'app.started': state('running'); line('App started.', 'ok'); return;
        case 'app.log': line(p.log, p.error ? 'error' : 'info'); return;
        case 'app.progress': if (p.message) line(p.message, 'progress'); return;
        case 'daemon.logMessage': line(p.message, p.level === 'error' ? 'error' : 'info'); return;
        case 'app.stop': state('stopped', p.error || null); if (p.error) line(p.error, 'error'); return;
        default: return;
      }
    }
    if (m.id != null) {
      if (m.error) line(`Command failed: ${typeof m.error === 'string' ? m.error : JSON.stringify(m.error)}`, 'error');
      else if (m.result && typeof m.result === 'object' && m.result.message) line(m.result.message, m.result.code ? 'error' : 'ok');
    }
  };
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const raw = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (raw.startsWith('[{') && raw.endsWith('}]')) {
        try { for (const m of JSON.parse(raw)) onMessage(m); continue; } catch { /* not JSON after all */ }
      }
      line(raw);
    }
  });
  proc.stderr.on('data', (d) => d.toString('utf8').split(/\r?\n/).forEach((l) => line(l, 'error')));
  proc.on('error', (e) => { line(`Could not start flutter: ${e.message}`, 'error'); });
  proc.on('close', (code) => {
    if (runs.get(serial) === r) runs.delete(serial);
    line(`flutter run ended (exit ${code}).`, code ? 'error' : 'info');
    if (r.flush) { clearTimeout(r.flush); r.flush = null; const lines = r.pending.splice(0); if (lines.length) emit({ kind: 'flutter_log', serial, lines }); }
    r.state = 'exited';
    emit({ kind: 'flutter_state', serial, app: r.app, name: r.name, state: 'exited', since: Date.now(), message: `exit ${code}` });
  });
  return runState(r);
}

function send(r, method, params) {
  const id = ++r.seq;
  try { r.proc.stdin.write(JSON.stringify([{ id, method, params }]) + '\n'); } catch { /* process gone */ }
  return id;
}

/** reload | restart | stop for the app running on a phone. */
export function flutterCommandFor(serial, cmd) {
  const r = runs.get(serial);
  if (!r) return { ok: false, error: 'Nothing is running on this phone.' };
  if (cmd === 'stop') {
    if (r.appId) send(r, 'app.stop', { appId: r.appId });
    // A build in progress ignores app.stop; if the process is still here after a moment, end it.
    setTimeout(() => { if (runs.get(r.serial) === r) killTree(r.proc); }, r.appId ? 6000 : 0);
    return { ok: true };
  }
  if (!r.appId || r.state !== 'running') return { ok: false, error: 'The app is still starting.' };
  if (cmd === 'reload' || cmd === 'restart') {
    send(r, 'app.restart', { appId: r.appId, fullRestart: cmd === 'restart', pause: false, reason: 'manual' });
    return { ok: true };
  }
  return { ok: false, error: 'Unknown command.' };
}

export function flutterLog(serial) {
  return runs.get(serial)?.lines.slice(-600) || [];
}

function killTree(proc) {
  if (!proc?.pid) return;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else try { proc.kill('SIGTERM'); } catch { /* gone */ }
}

/** On quit: close every screen and end every flutter run (the apps stay on the phones). */
export async function shutdownDevices() {
  for (const serial of [...mirrors.keys()]) await stopMirror(serial).catch(() => {});
  for (const r of runs.values()) killTree(r.proc);
  runs.clear();
}
