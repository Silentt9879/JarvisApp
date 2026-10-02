// Web apps - the ASP.NET Core sites and APIs in the workspace, run from the Devices view.
//
// One `dotnet watch run` per project (hot reload on save), its console in the window, and
// the site itself shown in a <webview> beside the phones. The URL is read from the app's
// own "Now listening on:" line, never assumed.
//
// These run against the real back end: the Admin Web on localhost talks to PRODUCTION.
// Nothing starts on its own - every run is a click.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';

/** key -> project. `warn` is shown on the card before anything is started. */
export const WEB_APPS = {
  adminweb: { name: 'Admin Web', dir: 'Bantu2U_Center-Module', project: 'Call Center Module.csproj', kind: 'web', warn: 'Talks to production data.' },
  panelweb: { name: 'Panel Web', dir: 'BantuAutoPanelWeb_v2', project: 'FYPWorkshop.csproj', kind: 'web', warn: 'Talks to production data.' },
  gateway: { name: 'API Gateway', dir: path.join('Bantu2u_APIGateway', 'APIGateway'), project: 'APIGateway.csproj', kind: 'api' },
  insurapi: { name: 'Insurance API', dir: path.join('myInsurAPI', 'myInsurAPI'), project: 'myInsurAPI.csproj', kind: 'api' },
};

const MAX_LOG = 1500;
const runs = new Map(); // key -> run
const isKey = (k) => Object.prototype.hasOwnProperty.call(WEB_APPS, k);

export function listWebApps(workspace) {
  return Object.entries(WEB_APPS).map(([key, a]) => {
    const r = runs.get(key);
    return {
      key,
      name: a.name,
      kind: a.kind,
      warn: a.warn || null,
      dir: a.dir,
      found: fs.existsSync(path.join(workspace, a.dir, a.project)),
      run: r ? state(r) : null,
    };
  });
}

function state(r) {
  return { key: r.key, name: r.name, state: r.state, url: r.url, since: r.since, watch: r.watch };
}

/** The .NET CLI. On Windows `dotnet` is an exe, so no shell is needed. */
const DOTNET = process.platform === 'win32' ? 'dotnet.exe' : 'dotnet';

/**
 * Start one project. `watch` true = `dotnet watch` (hot reload), false = plain `dotnet run`.
 * `emit(e)` gets web_state and web_log events.
 */
export function webRun(workspace, key, { watch = true } = {}, emit) {
  if (!isKey(key)) throw new Error('Unknown project.');
  const a = WEB_APPS[key];
  if (runs.has(key)) throw new Error(`${a.name} is already running - stop it first.`);
  const cwd = path.join(workspace, a.dir);
  const proj = path.join(cwd, a.project);
  if (!fs.existsSync(proj)) throw new Error(`${a.name} (${a.project}) was not found in the workspace.`);

  // -lp http: the plain-HTTP profile, so the embedded view needs no dev certificate.
  const args = watch
    ? ['watch', '--non-interactive', '--project', proj, '-lp', 'http', 'run']
    : ['run', '--project', proj, '-lp', 'http'];
  const env = {
    ...process.env,
    DOTNET_WATCH_SUPPRESS_LAUNCH_BROWSER: '1', // the site opens in the window, not a browser
    DOTNET_WATCH_SUPPRESS_EMOJIS: '1',
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
  };
  const proc = spawn(DOTNET, args, { cwd, windowsHide: true, env });
  const r = { key, name: a.name, proc, state: 'building', url: null, since: Date.now(), watch, lines: [], pending: [], flush: null, emit };
  runs.set(key, r);

  const setState = (s, message) => { r.state = s; r.since = Date.now(); emit({ kind: 'web_state', ...state(r), message: message || null }); };
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
      const level = /\b(error|exception|unhandled|failed to)\b/i.test(raw) ? 'error'
        : /\bwarn(ing)?\b/i.test(raw) ? 'warn'
          : /^\s*dotnet watch/i.test(raw) ? 'info' : (fallback || 'info');
      // The app's own startup line is the only trustworthy source of its address.
      const m = /Now listening on:\s*(https?:\/\/\S+)/i.exec(raw);
      if (m && !r.url) {
        r.url = m[1].replace('://0.0.0.0', '://localhost').replace('://[::]', '://localhost').replace(/\/$/, '');
        setState('running');
      }
      if (/Application is shutting down/i.test(raw) && r.state === 'running' && r.watch) setState('building', 'Restarting…');
      line(raw, level);
    }
  };
  proc.stdout.on('data', (d) => read(d, 'info'));
  proc.stderr.on('data', (d) => read(d, 'warn'));
  proc.on('error', (e) => line(`Could not start dotnet: ${e.message}`, 'error'));
  proc.on('close', (code) => {
    if (runs.get(key) === r) runs.delete(key);
    line(`${watch ? 'dotnet watch' : 'dotnet run'} ended (exit ${code}).`, code ? 'error' : 'info');
    if (r.flush) { clearTimeout(r.flush); r.flush = null; const lines = r.pending.splice(0); if (lines.length) emit({ kind: 'web_log', key, lines }); }
    r.state = 'exited';
    r.url = null;
    emit({ kind: 'web_state', ...state(r), message: `exit ${code}` });
  });

  setState('building', `${watch ? 'dotnet watch' : 'dotnet run'} in ${a.dir}`);
  return state(r);
}

export function webStop(key) {
  const r = runs.get(key);
  if (!r) return { ok: false, error: 'It is not running.' };
  killTree(r.proc);
  return { ok: true };
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
