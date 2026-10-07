// Project tasks: a Build, a Test, a package script - started by a person from the Projects
// view, one at a time per project and action, with the output streamed to the window and a
// Stop that ends the whole process tree.
//
// What runs is never text from the window. The window names a project and an action; the
// main process works out the command from the project's own files (project-providers.mjs)
// and hands this file a spec: { file, args, cwd, via }. Two rules keep that spec honest:
//
//   - No shell sees anything a project controls. An exe is started directly, from its full
//     path. A .cmd/.bat (npm, flutter, a Gradle or Maven wrapper) has to go through cmd.exe,
//     so every argument is checked against a plain character set first - a package script
//     called "build & del *" is refused, not run.
//   - The project folder is the working directory and nothing more. Windows looks for a
//     command in the working directory BEFORE PATH, so a repository holding its own
//     "cmd.exe" or "npm.cmd" would be run instead of the real one. cmd.exe is started by its
//     full path (Node's own lookup would otherwise search the project folder first), cmd's
//     lookup of the tool is turned off in the folder (NoDefaultCurrentDirectoryInExePath in
//     its environment), and a project's own wrapper is named explicitly as .\gradlew.bat.
import { spawn as nodeSpawn, execFile } from 'node:child_process';
import path from 'node:path';

const MAX_LOG = 2000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
/** cmd.exe by its full path - never one sitting in the project folder. */
export const CMD_EXE = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'cmd.exe');
/** What may reach cmd.exe: words, paths and the usual flag characters - no & | < > ^ % " ( ). */
export const SAFE_ARG = /^[A-Za-z0-9_@=+:,.\/\\-]{1,200}$/;

const runs = new Map(); // task id -> run

export const taskId = (projectKey, actionId) => `${projectKey}::${actionId}`;

/** The command line as a person would type it - for display only, never executed. */
export function displayCommand(spec) {
  const show = (a) => (/\s/.test(a) ? `"${a}"` : a);
  return [path.basename(spec.file).replace(/\.exe$/i, ''), ...(spec.args || [])].map(show).join(' ');
}

function validate(spec) {
  if (!spec || typeof spec !== 'object') return 'No task.';
  if (typeof spec.projectKey !== 'string' || !spec.projectKey || typeof spec.actionId !== 'string' || !spec.actionId) return 'No task.';
  if (typeof spec.cwd !== 'string' || !path.isAbsolute(spec.cwd)) return 'The project folder is not known.';
  if (typeof spec.file !== 'string' || !spec.file) return 'No command.';
  if (!Array.isArray(spec.args) || spec.args.some((a) => typeof a !== 'string')) return 'No command.';
  if (spec.via === 'cmd') {
    if (!SAFE_ARG.test(spec.file) || spec.args.some((a) => !SAFE_ARG.test(a))) return 'That command has characters JARVIS will not pass to cmd.exe.';
  } else if (!path.isAbsolute(spec.file)) return 'The tool could not be found on this PC.';
  return null;
}

function killTree(proc) {
  if (!proc?.pid) return;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else try { process.kill(-proc.pid, 'SIGTERM'); } catch { try { proc.kill('SIGTERM'); } catch { /* gone */ } }
}

function stateOf(r) {
  return { id: r.id, projectKey: r.projectKey, actionId: r.actionId, label: r.label, command: r.command, state: r.state, since: r.since, started: r.started, code: r.code ?? null };
}

/**
 * Start a task. Throws (a plain message) if the spec is not acceptable or the same task is
 * already running. `emit(e)` gets task_state and task_log events.
 */
export function startTask(spec, emit = () => {}, { spawnFn = nodeSpawn, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const bad = validate(spec);
  if (bad) throw new Error(bad);
  const id = taskId(spec.projectKey, spec.actionId);
  if (runs.has(id)) throw new Error(`${spec.label || 'That task'} is already running - stop it first.`);

  const env = { ...process.env, NoDefaultCurrentDirectoryInExePath: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1', ...(spec.env || {}) };
  delete env.ELECTRON_RUN_AS_NODE;
  const [file, args] = spec.via === 'cmd' && process.platform === 'win32'
    ? [CMD_EXE, ['/d', '/s', '/c', spec.file, ...spec.args]]
    : [spec.file, spec.args];
  const r = {
    id, projectKey: spec.projectKey, actionId: spec.actionId, label: spec.label || spec.actionId,
    command: displayCommand(spec), state: 'running', since: Date.now(), started: Date.now(),
    proc: null, lines: [], pending: [], flush: null, stopping: false, code: null, timer: null,
  };
  const line = (text, level = 'info') => {
    const t = String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\s+$/, '');
    if (!t) return;
    const entry = { t: Date.now(), level, text: t.length > 2000 ? `${t.slice(0, 2000)}…` : t };
    r.lines.push(entry);
    if (r.lines.length > MAX_LOG) r.lines.splice(0, r.lines.length - MAX_LOG);
    r.pending.push(entry);
    if (!r.flush) r.flush = setTimeout(() => { r.flush = null; const lines = r.pending.splice(0); if (lines.length) emit({ kind: 'task_log', id, lines }); }, 150);
  };

  let proc;
  try {
    proc = spawnFn(file, args, { cwd: spec.cwd, windowsHide: true, env, ...(process.platform === 'win32' ? {} : { detached: true }) });
  } catch (e) {
    throw new Error(`Could not start ${r.command}: ${e.message}`);
  }
  r.proc = proc;
  runs.set(id, r);
  emit({ kind: 'task_state', ...stateOf(r) });
  line(`> ${r.command}`, 'progress');

  const read = (buf, level) => { for (const l of String(buf).split(/\r?\n/)) line(l, /\b(error|failed|exception)\b/i.test(l) ? 'error' : level); };
  proc.stdout?.on('data', (d) => read(d, 'info'));
  proc.stderr?.on('data', (d) => read(d, 'warn'));
  r.timer = setTimeout(() => { line(`Stopped after ${Math.round(timeoutMs / 60000)} minutes.`, 'error'); r.timedOut = true; killTree(proc); }, timeoutMs);
  r.timer.unref?.();
  proc.on('error', (e) => { line(e.code === 'ENOENT' ? `${r.command}: the tool was not found.` : `Could not start: ${e.message}`, 'error'); });
  proc.on('close', (code) => {
    clearTimeout(r.timer);
    if (runs.get(id) === r) runs.delete(id);
    r.code = code;
    r.state = r.stopping ? 'stopped' : code === 0 ? 'passed' : 'failed';
    line(r.stopping ? 'Stopped.' : `Finished (exit ${code}).`, code === 0 || r.stopping ? 'ok' : 'error');
    if (r.flush) { clearTimeout(r.flush); r.flush = null; }
    const lines = r.pending.splice(0);
    if (lines.length) emit({ kind: 'task_log', id, lines });
    r.lastLines = r.lines.slice(-600);
    finished.set(id, r);
    emit({ kind: 'task_state', ...stateOf(r), timedOut: !!r.timedOut });
  });
  return stateOf(r);
}

const finished = new Map(); // the last ended run per task, so its log can still be read

export function stopTask(id) {
  const r = runs.get(id);
  if (!r) return { ok: false, error: 'It is not running.' };
  r.stopping = true;
  killTree(r.proc);
  return { ok: true };
}

export function taskLog(id) {
  return (runs.get(id) || finished.get(id))?.lines.slice(-600) || [];
}

export function runningTasks() {
  return [...runs.values()].map(stateOf);
}

export function shutdownTasks() {
  for (const r of runs.values()) { r.stopping = true; killTree(r.proc); }
  runs.clear();
}
