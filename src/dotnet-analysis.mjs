// .NET build diagnostics for the Devices view: the same idea as analysis.mjs's Dart analysis,
// for ASP.NET sites, APIs, libraries and test projects - what Visual Studio's own Error List
// shows after a build, read instead of guessed at.
//
// There is no Dart-analyze equivalent for .NET that reports without actually building (the
// compiler's own diagnostics - and any Roslyn/NuGet analyzers already in the project, which is
// exactly what produced the CS/NU-prefixed rows in the screenshot this was built from - only
// come from a real `dotnet build`). So this runs one, at quiet verbosity (still reports every
// warning and error, just not the task-by-task noise), and parses MSBuild's own diagnostic
// line format - the same lines Visual Studio's Error List is built from:
//
//   File.cs(42,15): warning CS0219: The variable 'x' is assigned but its value is never used [Project.csproj]
//   Project.csproj : warning NU1903: Package 'AutoMapper' 14.0.0 has a known high severity vulnerability, <url>
//
// Reading only: nothing here fixes, formats or writes a file. A build genuinely builds the
// project (there is no dry-run), so this is gated by workspace trust exactly as the Dart
// analyser and the Build/Test task actions already are - MSBuild can run arbitrary <Target>
// elements and source generators, not just compile.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';

export const MAX_PROBLEMS = 3000;
const TIMEOUT_MS = 5 * 60 * 1000;
const ORDER = { error: 0, warning: 1, hint: 2 };

// File.cs(42,15): warning CS0219: message [Project.csproj]  - the ordinary, file-located form.
const FILE_DIAG = /^(.+?)\((\d+),(\d+)\):\s*(warning|error)\s+([A-Za-z]+\d+):\s*(.*?)(?:\s*\[(.+)\])?$/i;
// Project.csproj : warning NU1903: message  - a project-level diagnostic (no source location;
// a restored package, not a line of code, is what is wrong).
const PROJECT_DIAG = /^(.+?\.(?:csproj|vbproj|fsproj|sln))\s*:\s*(warning|error)\s+([A-Za-z]+\d+):\s*(.*)$/i;

/**
 * MSBuild's console diagnostic lines -> problems, worst first, paths relative to `projectDir`.
 * `projectTag` keeps only diagnostics MSBuild attributed to this exact project - a referenced
 * project's own warnings (which a build of the project that depends on it also triggers and
 * reports, tagged with ITS OWN path) are left for that project's own analysis, the same way
 * `dart analyze` only ever reports the package being analysed, not its pub dependencies.
 */
export function parseDiagnostics(text, projectDir, projectFile) {
  const wantTag = projectFile ? path.resolve(projectFile).toLowerCase() : null;
  const wantName = projectFile ? path.basename(projectFile).toLowerCase() : null;
  const seen = new Set();
  const problems = [];
  const relOf = (file) => {
    if (!projectDir) return String(file).replace(/\\/g, '/');
    const abs = path.isAbsolute(file) ? file : path.join(projectDir, file);
    const rel = path.relative(projectDir, abs);
    return (rel && !rel.startsWith('..') ? rel : file).replace(/\\/g, '/');
  };
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    let m = FILE_DIAG.exec(line);
    if (m) {
      const tag = m[7] ? m[7].trim() : null;
      if (wantTag && tag && path.resolve(tag).toLowerCase() !== wantTag) continue;
      const p = { severity: m[4].toLowerCase(), code: m[5].toLowerCase(), file: relOf(m[1]), line: Number(m[2]) || 1, col: Number(m[3]) || 1, message: m[6].trim() };
      const key = `${p.file}|${p.line}|${p.col}|${p.code}|${p.message}`;
      if (!seen.has(key)) { seen.add(key); problems.push(p); }
      continue;
    }
    m = PROJECT_DIAG.exec(line);
    if (m) {
      const tagName = path.basename(m[1]).toLowerCase();
      if (wantName && tagName !== wantName) continue;
      const p = { severity: m[2].toLowerCase(), code: m[3].toLowerCase(), file: relOf(m[1]), line: 0, col: 0, message: m[4].trim() };
      const key = `${p.file}|${p.line}|${p.col}|${p.code}|${p.message}`;
      if (!seen.has(key)) { seen.add(key); problems.push(p); }
    }
  }
  problems.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col);
  return problems;
}

export function countProblems(problems) {
  const c = { error: 0, warning: 0, hint: 0 };
  for (const p of problems) if (c[p.severity] !== undefined) c[p.severity] += 1;
  return c;
}

/** Lines holding one of git's conflict markers, in the files that have errors - same check as analysis.mjs's, for the same reason: a merge conflict left in a .cs file produces a wall of baffling compiler errors that are not really about the code. */
export function findConflicts(problems, projectDir, { readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  const files = [...new Set(problems.filter((p) => p.severity === 'error' && p.line > 0).map((p) => p.file))].slice(0, 40);
  const found = [];
  for (const file of files) {
    let text;
    try { text = readFile(path.join(projectDir, file)); } catch { continue; }
    const lines = text.split(/\r?\n/);
    const marks = [];
    for (let i = 0; i < lines.length; i += 1) if (/^(<{7}|={7}|>{7})( |$)/.test(lines[i])) marks.push(i + 1);
    if (marks.length && lines.some((l) => /^<{7}( |$)/.test(l))) found.push({ file, line: marks[0], lines: marks.slice(0, 12) });
  }
  return found;
}

// ------------------------------------------------------------------ running it
const running = new Map(); // project key -> { proc, promise, cancelled }

function killTree(proc) {
  if (!proc?.pid) return;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else try { proc.kill('SIGTERM'); } catch { /* gone */ }
}

/**
 * Build one .NET project and report its diagnostics. `app` is resolved and checked by the
 * caller: { key, name, dir (its folder, absolute), rel (its path in the workspace, for
 * opening files), target (the exact .csproj/.sln dotnet build should build) }. Resolves -
 * never throws - with the problems and their counts, or { ok:false, error }. A second call
 * for a project already being analysed joins the first, the same as analyzeApp.
 */
export function analyzeDotnet(app, { dotnet, spawnFn = spawn, log } = {}) {
  if (!app || typeof app.key !== 'string' || !app.key || typeof app.dir !== 'string' || !path.isAbsolute(app.dir) || typeof app.target !== 'string') {
    return Promise.resolve({ ok: false, error: 'Unknown project.' });
  }
  if (typeof dotnet !== 'string' || !path.isAbsolute(dotnet)) return Promise.resolve({ ok: false, error: 'dotnet was not found. Install the .NET SDK, then press Check again in Health.' });
  const appKey = app.key;
  const had = running.get(appKey);
  if (had) return had.promise;
  const projectDir = app.dir;
  const rel = app.rel || path.basename(projectDir);
  if (!fs.existsSync(app.target)) return Promise.resolve({ ok: false, app: appKey, name: app.name, error: `${app.name} (${rel}) was not found in the workspace.` });

  const started = Date.now();
  const entry = { proc: null, promise: null, cancelled: false };
  running.set(appKey, entry);
  entry.promise = new Promise((resolve) => {
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
    const args = ['build', app.target, '--nologo', '-v:quiet', '/clp:NoSummary'];
    const env = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', NoDefaultCurrentDirectoryInExePath: '1' };
    let proc;
    try { proc = spawnFn(dotnet, args, { cwd: projectDir, windowsHide: true, env }); }
    catch (e) { finish({ ok: false, error: `Could not start dotnet: ${String(e?.message || e)}` }); return; }
    entry.proc = proc;
    timer = setTimeout(() => { killTree(proc); finish({ ok: false, error: 'The build took more than five minutes and was stopped.' }); }, TIMEOUT_MS);
    proc.stdout?.on('data', (d) => { out += d.toString('utf8'); });
    proc.stderr?.on('data', (d) => { err += d.toString('utf8'); });
    proc.on('error', (e) => finish({ ok: false, error: `Could not start dotnet: ${e.message}` }));
    proc.on('close', (code) => {
      if (entry.cancelled) { finish({ ok: false, cancelled: true, error: 'Stopped.' }); return; }
      const problems = parseDiagnostics(`${out}\n${err}`, projectDir, app.target);
      // Exit 0 with diagnostics parsed is "built, with warnings" - still a result to show.
      // A non-zero exit with nothing parsed (a restore failure, a missing SDK) is a real failure.
      if (!problems.length && code !== 0) {
        const why = (err || out).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-5).join(' ');
        log?.('dotnet build failed', appKey, `exit ${code}`, why.slice(0, 300));
        finish({ ok: false, error: why.slice(0, 300) || `dotnet build ended with exit ${code}.` });
        return;
      }
      const counts = countProblems(problems);
      let conflicts = [];
      try { conflicts = findConflicts(problems, projectDir); } catch { /* the list stands without it */ }
      finish({ ok: true, counts, conflicts, total: problems.length, truncated: problems.length > MAX_PROBLEMS, problems: problems.slice(0, MAX_PROBLEMS) });
    });
  });
  return entry.promise;
}

export function cancelDotnetAnalysis(appKey) {
  const e = running.get(appKey);
  if (!e) return false;
  e.cancelled = true;
  killTree(e.proc);
  return true;
}

export function shutdownDotnetAnalysis() {
  for (const e of running.values()) { e.cancelled = true; killTree(e.proc); }
  running.clear();
}

/** How many `dotnet build` analysis runs are in flight right now - for the "what would stop" warnings. */
export function runningDotnetAnalysis() {
  return running.size;
}
