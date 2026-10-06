// Web apps - the ASP.NET Core sites and APIs in the workspace, run from the Devices view.
//
// One `dotnet watch run` per project (hot reload on save), its console in the window, and
// the site itself shown in a <webview> beside the phones. The URL is read from the app's
// own "Now listening on:" line, never assumed.
//
// These run against the real back end: the Admin Web on localhost talks to PRODUCTION.
// Nothing starts on its own - every run is a click.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';

/**
 * key -> project. `warn` is shown on the card before anything is started: what running it
 * on this machine actually touches.
 */
export const WEB_APPS = {
  adminweb: { name: 'Admin Web', dir: 'Bantu2U_Center-Module', project: 'Call Center Module.csproj', kind: 'web', warn: 'Production data' },
  panelweb: { name: 'Panel Web', dir: 'BantuAutoPanelWeb_v2', project: 'FYPWorkshop.csproj', kind: 'web', warn: 'Production data' },
  gateway: { name: 'API Gateway', dir: path.join('Bantu2u_APIGateway', 'APIGateway'), project: 'APIGateway.csproj', kind: 'api' },
  // Its reminder services (vehicle expiry, maintenance, Bantu Kaki) start with it and read
  // the shared database, so a local copy sends real pushes alongside the deployed one.
  insurapi: { name: 'Insurance API', dir: path.join('myInsurAPI', 'myInsurAPI'), project: 'myInsurAPI.csproj', kind: 'api', warn: 'Live database · sends real reminder pushes' },
};

const MAX_LOG = 1500;
const runs = new Map(); // key -> run
const isKey = (k) => Object.prototype.hasOwnProperty.call(WEB_APPS, k);

/**
 * The address the `http` launch profile will listen on, read from the project's own
 * launchSettings.json - so the card can show it, and check the port, before anything starts.
 */
export function plannedUrl(workspace, a) {
  try {
    const file = path.join(workspace, a.dir, 'Properties', 'launchSettings.json');
    const json = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    const urls = String(json?.profiles?.http?.applicationUrl || '').split(';').map((u) => u.trim());
    const url = urls.find((u) => u.startsWith('http://')) || urls[0];
    if (!url) return null;
    const u = new URL(url.replace('://0.0.0.0', '://localhost').replace('://+', '://localhost').replace('://*', '://localhost'));
    return { url: `${u.protocol}//${u.hostname}:${u.port}`, port: Number(u.port) || null };
  } catch { return null; }
}

/** Is something already listening on this local port? IPv4 then IPv6 loopback. */
export function portBusy(port) {
  const tryHost = (host) => new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(500, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
  if (!port) return Promise.resolve(false);
  return tryHost('127.0.0.1').then((v) => v || tryHost('::1'));
}

/** Which program holds a listening port (Windows), for a message that says who. */
function portOwner(port) {
  if (process.platform !== 'win32' || !port) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true, timeout: 5000 }, (err, out) => {
      if (err) return resolve(null);
      const line = String(out).split(/\r?\n/).find((l) => new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+\\d+`).test(l));
      const pid = line ? Number(line.trim().split(/\s+/).pop()) : null;
      if (!pid) return resolve(null);
      execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000 }, (e2, o2) => {
        const name = !e2 ? (/^"([^"]+)"/.exec(String(o2).trim()) || [])[1] : null;
        resolve({ pid, name: name || 'another program' });
      });
    });
  });
}

/** Every project, with its address and whether something outside JARVIS is serving it. */
export async function listWebApps(workspace) {
  return Promise.all(Object.entries(WEB_APPS).map(async ([key, a]) => {
    const r = runs.get(key);
    const planned = plannedUrl(workspace, a);
    // Only asked when JARVIS is not running it itself: then a listener on the port means
    // it was started somewhere else - a terminal, Visual Studio - and Run would collide.
    const external = !r && planned?.port && await portBusy(planned.port)
      ? { url: planned.url, port: planned.port, owner: await portOwner(planned.port) }
      : null;
    return {
      key,
      name: a.name,
      kind: a.kind,
      warn: a.warn || null,
      dir: a.dir,
      found: fs.existsSync(path.join(workspace, a.dir, a.project)),
      planned,
      external,
      run: r ? state(r) : null,
    };
  }));
}

function state(r) {
  return { key: r.key, name: r.name, state: r.state, url: r.url, since: r.since, watch: r.watch, problem: r.problem || null, started: r.started };
}

/**
 * Plain words for the usual reasons a `dotnet run` does not come up. The first match wins
 * and stays, so the card says why it failed, not just that it did.
 */
const PROBLEMS = [
  [/MSB30(21|26|27)|being used by another process/i, () => 'The build files are locked - this project is already running somewhere else (Visual Studio or a terminal). Stop it there, then Run again.'],
  [/address already in use|Failed to bind to address/i, (_m, port) => `Port ${port || ''} is already in use by another program.`.replace('Port  ', 'The port ')],
  [/You must install or update \.NET|compatible \.NET SDK was not found|framework '.*' .*was not found/i, (m) => `.NET is missing for this project: ${m.input.trim().slice(0, 160)}`],
  [/Unhandled exception\.?\s*(.*)/i, (m) => `It crashed while starting${m[1] ? `: ${m[1].trim().slice(0, 180)}` : '.'} See the log.`],
];

/** The .NET CLI. On Windows `dotnet` is an exe, so no shell is needed. */
const DOTNET = process.platform === 'win32' ? 'dotnet.exe' : 'dotnet';

/**
 * Start one project. `watch` true = `dotnet watch` (hot reload), false = plain `dotnet run`.
 * `emit(e)` gets web_state and web_log events.
 */
export async function webRun(workspace, key, { watch = true } = {}, emit) {
  if (!isKey(key)) throw new Error('Unknown project.');
  const a = WEB_APPS[key];
  if (runs.has(key)) throw new Error(`${a.name} is already running - stop it first.`);
  const cwd = path.join(workspace, a.dir);
  const proj = path.join(cwd, a.project);
  if (!fs.existsSync(proj)) throw new Error(`${a.name} (${a.project}) was not found in the workspace.`);

  // Before anything is built: a second copy on the same port cannot start, and its build
  // would fight the running one over the same files. Say so, with who holds the port.
  const planned = plannedUrl(workspace, a);
  if (planned?.port && await portBusy(planned.port)) {
    const owner = await portOwner(planned.port);
    const who = owner ? `${owner.name} (PID ${owner.pid})` : 'another program';
    const e = new Error(`${a.name} is already running on ${planned.url} - started outside JARVIS by ${who}, probably a terminal or Visual Studio. Open it, or stop that copy first.`);
    e.code = 'PORT_IN_USE';
    throw e;
  }
  if (runs.has(key)) throw new Error(`${a.name} is already running - stop it first.`);

  // -lp http: the plain-HTTP profile, so the browser needs no dev certificate.
  const args = watch
    ? ['watch', '--non-interactive', '--project', proj, '-lp', 'http', 'run']
    : ['run', '--project', proj, '-lp', 'http'];
  const env = {
    ...process.env,
    DOTNET_WATCH_SUPPRESS_LAUNCH_BROWSER: '1', // JARVIS opens the page itself, once
    DOTNET_WATCH_SUPPRESS_EMOJIS: '1',
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
  };
  const proc = spawn(DOTNET, args, { cwd, windowsHide: true, env });
  const r = { key, name: a.name, proc, state: 'building', url: null, since: Date.now(), started: Date.now(), watch, problem: null, errors: 0, lines: [], pending: [], flush: null, emit };
  runs.set(key, r);

  const setState = (s, message) => { r.state = s; r.since = Date.now(); emit({ kind: 'web_state', ...state(r), message: message || null }); };
  const noteProblem = (raw) => {
    if (r.problem) return;
    for (const [re, say] of PROBLEMS) {
      const m = re.exec(raw);
      if (m) { r.problem = say(m, planned?.port); return; }
    }
  };
  const line = (text, level = 'info') => {
    const t = String(text).replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+$/, '');
    if (!t) return;
    const entry = { t: Date.now(), level, text: t.length > 2000 ? t.slice(0, 2000) + '…' : t };
    r.lines.push(entry);
    if (r.lines.length > MAX_LOG) r.lines.splice(0, r.lines.length - MAX_LOG);
    r.pending.push(entry);
    if (!r.flush) r.flush = setTimeout(() => { r.flush = null; const lines = r.pending.splice(0); if (lines.length) emit({ kind: 'web_log', key, lines }); }, 150);
  };

  // dotnet watch writes its ordinary status ("Waiting for changes") to stderr, so the
  // level comes from what the line says, not from which stream it arrived on.
  const read = (buf, fallback) => {
    for (const raw of buf.toString('utf8').split(/\r?\n/)) {
      if (!raw.trim()) continue;
      // Build output repeats every warning; "0 Error(s)" is a count, not an error.
      const isError = /\berror\s+[A-Z]{2,}\d+\b|\bunhandled\b|\bexception\b|\bfailed to\b/i.test(raw) && !/\b0 Error\(s\)/i.test(raw);
      const level = isError ? 'error'
        : /\bwarning\b|\bwarn:/i.test(raw) ? 'warn'
          : /^\s*dotnet watch/i.test(raw) ? 'info' : (fallback || 'info');
      noteProblem(raw);   // the patterns are specific; some causes are not worded as errors
      const cs = /error (CS\d+|MSB\d+): (.*?)(\s+\[|$)/.exec(raw);
      if (cs) r.errors += 1;

      // The app's own startup line is the only trustworthy source of its address.
      const m = /Now listening on:\s*(https?:\/\/\S+)/i.exec(raw);
      if (m && !r.url) {
        r.url = m[1].replace('://0.0.0.0', '://localhost').replace('://[::]', '://localhost').replace(/\/$/, '');
        r.problem = null;
        setState('running');
      }
      if (/Application is shutting down/i.test(raw) && r.state === 'running' && r.watch) setState('building', 'Restarting…');

      // dotnet watch does not exit when the build fails or the app crashes: it waits for a
      // file to change. Without this the card would say "Building…" forever.
      if (r.watch && r.state !== 'failed'
        && /Waiting for a file to change before restarting|Exited with error code|^\s*dotnet watch\s*:?.*\bBuild failed\b/i.test(raw)) {
        if (!r.problem) {
          r.problem = r.errors ? `The build failed with ${r.errors} error${r.errors === 1 ? '' : 's'} - the first is in the log. Fix it and save: hot reload tries again.`
            : 'It stopped while starting - the reason is in the log. Save a file to try again, or Stop.';
        }
        r.url = null;
        setState('failed', r.problem);
      }
      // A save after a failure: watch builds again.
      if (r.watch && r.state === 'failed' && /dotnet watch.*\b(Building|Started|Restarting|File changed)/i.test(raw)) {
        r.problem = null;
        r.errors = 0;
        setState('building', 'Trying again…');
      }
      if (cs && !r.problem) r.problem = `Build error: ${cs[2].trim().slice(0, 200)}`;
      line(raw, level);
    }
  };
  proc.stdout.on('data', (d) => read(d, 'info'));
  proc.stderr.on('data', (d) => read(d, 'warn'));
  proc.on('error', (e) => {
    r.problem = e.code === 'ENOENT' ? 'dotnet was not found. Install the .NET SDK, then restart JARVIS.' : `Could not start dotnet: ${e.message}`;
    line(r.problem, 'error');
  });
  proc.on('close', (code) => {
    if (runs.get(key) === r) runs.delete(key);
    line(`${watch ? 'dotnet watch' : 'dotnet run'} ended (exit ${code}).`, code ? 'error' : 'info');
    if (r.flush) { clearTimeout(r.flush); r.flush = null; const lines = r.pending.splice(0); if (lines.length) emit({ kind: 'web_log', key, lines }); }
    // Stopped by the person is not a failure; anything else that ends unasked is.
    const failed = !r.stopping && (code !== 0 || !r.url);
    if (failed && !r.problem) r.problem = code ? `It stopped with exit code ${code} - the reason is in the log.` : 'It stopped before it started listening.';
    r.state = 'exited';
    r.url = null;
    emit({ kind: 'web_state', ...state(r), failed, message: r.stopping ? 'stopped' : `exit ${code}` });
  });

  setState('building', `${watch ? 'dotnet watch' : 'dotnet run'} in ${a.dir}`);
  return state(r);
}

export function webStop(key) {
  const r = runs.get(key);
  if (!r) return { ok: false, error: 'It is not running.' };
  r.stopping = true;
  killTree(r.proc);
  return { ok: true };
}

/** Stop every project JARVIS started. Ones running elsewhere are not touched. */
export function webStopAll() {
  let n = 0;
  for (const r of runs.values()) { r.stopping = true; killTree(r.proc); n += 1; }
  return { ok: true, stopped: n };
}

export function webLog(key) {
  return runs.get(key)?.lines.slice(-600) || [];
}

function killTree(proc) {
  if (!proc?.pid) return;
  // dotnet watch starts the app as a child: the whole tree has to go.
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else try { process.kill(-proc.pid, 'SIGTERM'); } catch { try { proc.kill('SIGTERM'); } catch { /* gone */ } }
}

/** On quit: every site started from here stops with the window. */
export function shutdownWebApps() {
  for (const r of runs.values()) killTree(r.proc);
  runs.clear();
}
