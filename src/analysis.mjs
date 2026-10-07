// Dart analysis for the Devices view: what is wrong with an app, as the IDE's "Dart
// Analysis" tab shows it - so a run that fails can be read instead of guessed at.
//
// One `dart analyze --format=machine` per app, in that app's folder. Reading only: nothing
// is fixed, formatted or written. The machine format is one problem per line,
//   SEVERITY|TYPE|CODE|file|line|column|length|message
// which is parsed here and never shown raw.
//
// One thing the analyser cannot say for itself: a file left with git's conflict markers in
// it produces a dozen baffling errors ("The name 'Updated' isn't a type", "'===' is not
// supported"). Files with errors are checked for those markers, so the window can say what
// actually happened.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';

export const MAX_PROBLEMS = 3000;      // sent to the window; the counts are always complete
const TIMEOUT_MS = 5 * 60 * 1000;
const SEVERITY = { ERROR: 'error', WARNING: 'warning', INFO: 'hint' };
const ORDER = { error: 0, warning: 1, hint: 2 };

/** Split on "|", honouring the analyser's "\|" and "\\" escapes inside a field. */
function fields(line) {
  const out = [];
  let cur = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\' && (line[i + 1] === '|' || line[i + 1] === '\\')) { cur += line[i + 1]; i += 1; }
    else if (ch === '|') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** The analyser's machine output -> problems, worst first, paths relative to the app. */
export function parseMachine(text, appDir) {
  const problems = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const f = fields(raw.trim());
    if (f.length < 8 || !SEVERITY[f[0]]) continue;
    const line = Number(f[4]);
    if (!Number.isInteger(line)) continue;
    let file = f[3];
    if (appDir && path.isAbsolute(file)) {
      const rel = path.relative(appDir, file);
      if (rel && !rel.startsWith('..')) file = rel;
    }
    problems.push({
      severity: SEVERITY[f[0]],
      code: f[2].toLowerCase(),
      file: file.replace(/\\/g, '/'),
      line,
      col: Number(f[5]) || 1,
      message: f.slice(7).join('|').trim(),
    });
  }
  problems.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col);
  return problems;
}

export function countProblems(problems) {
  const c = { error: 0, warning: 0, hint: 0 };
  for (const p of problems) c[p.severity] += 1;
  return c;
}

/** Lines holding one of git's conflict markers, in the files that have errors. */
export function findConflicts(problems, appDir, { readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  const files = [...new Set(problems.filter((p) => p.severity === 'error').map((p) => p.file))].slice(0, 40);
  const found = [];
  for (const file of files) {
    let text;
    try { text = readFile(path.join(appDir, file)); } catch { continue; }
    const lines = text.split(/\r?\n/);
    const marks = [];
    for (let i = 0; i < lines.length; i += 1) if (/^(<{7}|={7}|>{7})( |$)/.test(lines[i])) marks.push(i + 1);
    // A lone "=======" is somebody's comment rule; a conflict has an opening marker too.
    if (marks.length && lines.some((l) => /^<{7}( |$)/.test(l))) found.push({ file, line: marks[0], lines: marks.slice(0, 12) });
  }
  return found;
}

// ------------------------------------------------------------------ running it
const running = new Map(); // project key -> { proc, promise }

/**
 * dart is a .bat on Windows: through cmd, with fixed words only - never free text. cmd.exe by
 * its full path: it starts in the project folder, which Node would otherwise search first.
 */
function dartCommand() {
  const cmd = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'cmd.exe');
  return process.platform === 'win32' ? [cmd, ['/d', '/s', '/c', 'dart']] : ['dart', []];
}

function killTree(proc) {
  if (!proc?.pid) return;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else try { proc.kill('SIGTERM'); } catch { /* gone */ }
}

/**
 * Analyse one Dart or Flutter project - any one discovery found, an app or a package. `app`
 * is resolved and checked by the caller: { key (its stable id), name, dir (its folder),
 * rel (its path in the workspace, which the window uses to open files) }. Resolves - never
 * throws - with the problems and their counts, or { ok:false, error }. A second call for a
 * project already being analysed joins the first.
 */
export function analyzeApp(app, { spawnFn = spawn, log } = {}) {
  if (!app || typeof app.key !== 'string' || !app.key || typeof app.dir !== 'string' || !path.isAbsolute(app.dir)) return Promise.resolve({ ok: false, error: 'Unknown app.' });
  const appKey = app.key;
  const had = running.get(appKey);
  if (had) return had.promise;
  const appDir = app.dir;
  const rel = app.rel || path.basename(appDir);
  if (!fs.existsSync(path.join(appDir, 'pubspec.yaml'))) return Promise.resolve({ ok: false, app: appKey, name: app.name, error: `${app.name} (${rel}) was not found in the workspace.` });

  const started = Date.now();
  const entry = { proc: null, promise: null, cancelled: false };
  running.set(appKey, entry); // before dart starts: a start that fails at once must find itself here to clear
  entry.promise = new Promise((resolve) => {
    const [cmd, pre] = dartCommand();
    let out = '';
    let err = '';
    let done = false;
    let timer = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (running.get(appKey) === entry) running.delete(appKey);
      resolve({ app: appKey, name: app.name, dir: rel, at: Date.now(), ms: Date.now() - started, ...r });
    };
    let proc;
    try { proc = spawnFn(cmd, [...pre, 'analyze', '--format=machine'], { cwd: appDir, windowsHide: true, env: { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' } }); }
    catch (e) { finish({ ok: false, error: `Could not start dart: ${String(e?.message || e)}` }); return; }
    entry.proc = proc;
    timer = setTimeout(() => { killTree(proc); finish({ ok: false, error: 'The analysis took more than five minutes and was stopped.' }); }, TIMEOUT_MS);
    proc.stdout?.on('data', (d) => { out += d.toString('utf8'); });
    proc.stderr?.on('data', (d) => { err += d.toString('utf8'); });
    proc.on('error', (e) => finish({ ok: false, error: `Could not start dart: ${e.message}. Is the Flutter SDK on the PATH?` }));
    proc.on('close', (code) => {
      if (entry.cancelled) { finish({ ok: false, cancelled: true, error: 'Stopped.' }); return; }
      // Older SDKs write the machine format to stderr; either way it is the same lines.
      const problems = parseMachine(`${out}\n${err}`, appDir);
      // Exit 1-3 only means "problems were found". With none parsed, it failed outright.
      if (!problems.length && code !== 0) {
        const why = (err || out).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-3).join(' ');
        log?.('dart analyze failed', appKey, `exit ${code}`, why.slice(0, 300));
        finish({ ok: false, error: why.slice(0, 300) || `dart analyze ended with exit ${code}.` });
        return;
      }
      const counts = countProblems(problems);
      let conflicts = [];
      try { conflicts = findConflicts(problems, appDir); } catch { /* the list stands without it */ }
      finish({ ok: true, counts, conflicts, total: problems.length, truncated: problems.length > MAX_PROBLEMS, problems: problems.slice(0, MAX_PROBLEMS) });
    });
  });
  return entry.promise;
}

export function cancelAnalysis(appKey) {
  const e = running.get(appKey);
  if (!e) return false;
  e.cancelled = true;
  killTree(e.proc);
  return true;
}

export function shutdownAnalysis() {
  for (const e of running.values()) { e.cancelled = true; killTree(e.proc); }
  running.clear();
}
