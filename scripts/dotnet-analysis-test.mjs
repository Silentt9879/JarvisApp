// .NET build diagnostics for the Devices page (src/dotnet-analysis.mjs): MSBuild's own
// diagnostic line format parsed, the conflict-marker check, and the runner driven with a
// stand-in for `dotnet` - no SDK needed, and no real project is built.
//   node scripts/dotnet-analysis-test.mjs
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDiagnostics, countProblems, findConflicts, analyzeDotnet, cancelDotnetAnalysis, runningDotnetAnalysis, MAX_PROBLEMS } from '../src/dotnet-analysis.mjs';

let pass = 0; const fails = [];
const check = (n, c, extra) => {
  if (c) { pass += 1; console.log('PASS  ' + n); }
  else { fails.push(n); console.log('FAIL  ' + n + (extra ? '\n        ' + String(extra).slice(0, 300) : '')); }
};
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// ------------------------------------------------------------------ parsing
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-dotnet-analysis-'));
const PROJ_DIR = path.join(WS, 'Call Center Module');
fs.mkdirSync(path.join(PROJ_DIR, 'Controllers'), { recursive: true });
const PROJ = path.join(PROJ_DIR, 'Call Center Module.csproj');
fs.writeFileSync(PROJ, '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>\n');
const OTHER_PROJ = path.join(WS, 'Shared.Lib', 'Shared.Lib.csproj');
const CCM = { key: 'ccm', name: 'Call Center Module', dir: PROJ_DIR, rel: 'Call Center Module', target: PROJ };
const abs = (rel) => path.join(PROJ_DIR, rel);

const OUT = [
  `${abs('Controllers\\ApprovalController.cs')}(428,17): warning CS0219: The variable 'title' is assigned but its value is never used [${PROJ}]`,
  `${abs('Controllers\\ApprovalController.cs')}(454,13): warning CS4014: Because this call is not awaited, execution of the current method continues before the call is completed. [${PROJ}]`,
  `${abs('Controllers\\HomeController.cs')}(517,21): error CS0168: The variable 'e' is declared but never used [${PROJ}]`,
  `${abs('HistoryService.cs')}(121,9): warning CS0219: The variable 'message' is assigned but its value is never used [${PROJ}]`,
  `${PROJ} : warning NU1903: Package 'AutoMapper' 14.0.0 has a known high severity vulnerability, https://github.com/advisories/GHSA-rvv3-g6hj-g44x`,
  // A referenced project rebuilding alongside this one - tagged with ITS OWN path, so it
  // must not show up when analysing Call Center Module.
  `C:\\elsewhere\\Shared.cs(3,1): warning CS1591: Missing XML comment [${OTHER_PROJ}]`,
  'Restore complete.',
  '',
  'not a diagnostic line at all',
  `${abs('Controllers\\ApprovalController.cs')}(428,17): warning CS0219: The variable 'title' is assigned but its value is never used [${PROJ}]`, // an exact repeat, as MSBuild sometimes emits for multi-targeted builds
].join('\r\n');

const list = parseDiagnostics(OUT, PROJ_DIR, PROJ);
check('each diagnostic line becomes one problem; chatter and an exact repeat are dropped', list.length === 5, JSON.stringify(list.map((p) => p.code)));
check('errors come first, then warnings - and within a file, in line order',
  list.map((p) => p.severity).join(',') === 'error,warning,warning,warning,warning', list.map((p) => p.severity).join(','));
check('paths are relative to the project, with forward slashes',
  list.filter((p) => p.line > 0).every((p) => !path.isAbsolute(p.file) && !p.file.includes('\\'))
  && list.find((p) => p.code === 'cs0168').file === 'Controllers/HomeController.cs');
check('a project-level diagnostic (no source line) still comes through, with line 0 and the project\'s own name as its file',
  list.find((p) => p.code === 'nu1903')?.line === 0 && list.find((p) => p.code === 'nu1903')?.file === 'Call Center Module.csproj');
check('another project rebuilt alongside this one is left for ITS OWN analysis, not shown here',
  !list.some((p) => p.code === 'cs1591'), JSON.stringify(list.map((p) => p.code)));
check('codes are lower-cased, the way the Dart analyser\'s codes already are, for one consistent look',
  list.every((p) => p.code === p.code.toLowerCase()));
const counts = countProblems(list);
check('the counts are per severity', counts.error === 1 && counts.warning === 4 && counts.hint === 0, JSON.stringify(counts));
check('empty output is no problems, not an error', parseDiagnostics('', PROJ_DIR, PROJ).length === 0 && parseDiagnostics(null, PROJ_DIR, PROJ).length === 0);
check('with no project to filter by, every diagnostic in the text is kept',
  parseDiagnostics(OUT, PROJ_DIR, null).length === 6, parseDiagnostics(OUT, PROJ_DIR, null).length);

// ------------------------------------------------------------------ conflict markers
fs.writeFileSync(abs('Controllers/HomeController.cs'), ['a', '<<<<<<< HEAD', 'x', '=======', 'y', '>>>>>>> branch', 'b'].join('\n'));
fs.writeFileSync(abs('HistoryService.cs'), ['// =======', '=======', 'just a rule, no conflict'].join('\n'));
const conflicts = findConflicts(list, PROJ_DIR);
check('git conflict markers in a file with errors are found, with the line they start at',
  conflicts.length === 1 && conflicts[0].file === 'Controllers/HomeController.cs' && conflicts[0].line === 2, JSON.stringify(conflicts));
check('a lone ======= rule is not called a conflict', !conflicts.some((c) => c.file === 'HistoryService.cs'));
check('a project-level diagnostic (line 0) is never treated as a file to scan for conflicts',
  findConflicts(list, PROJ_DIR, { readFile: (p) => { if (/\.csproj$/i.test(p)) throw new Error('must not read the project file itself'); return fs.readFileSync(p, 'utf8'); } }).length === 1);
check('a file that cannot be read is skipped, not fatal', findConflicts(list, path.join(WS, 'nowhere')).length === 0);

// ------------------------------------------------------------------ the runner, with a stand-in dotnet
const DOTNET = path.join(WS, 'tools', 'dotnet.exe');
function fakeDotnet({ stdout = '', stderr = '', code = 0, hold = false } = {}) {
  const calls = [];
  const spawnFn = (cmd, args, opts) => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.pid = 0;
    calls.push({ cmd, args, cwd: opts.cwd, proc });
    proc.finish = (c = code) => { if (stdout) proc.stdout.emit('data', Buffer.from(stdout)); if (stderr) proc.stderr.emit('data', Buffer.from(stderr)); proc.emit('close', c); };
    if (!hold) setImmediate(() => proc.finish());
    return proc;
  };
  return { spawnFn, calls };
}

let d = fakeDotnet({ stdout: OUT, code: 1 });
let r = await analyzeDotnet(CCM, { dotnet: DOTNET, spawnFn: d.spawnFn });
check('it runs `dotnet build <target> --nologo -v:quiet` in the project\'s own folder, and nothing that writes or publishes',
  d.calls.length === 1 && d.calls[0].cmd === DOTNET && d.calls[0].args[0] === 'build' && d.calls[0].args[1] === PROJ && d.calls[0].cwd === PROJ_DIR
  && d.calls[0].args.includes('-v:quiet') && !d.calls[0].args.some((a) => ['publish', 'pack', '--fix-format', 'clean'].includes(a)), JSON.stringify(d.calls[0]?.args));
check('exit 1 with diagnostics parsed is a result, not a failure - that is what "errors found" looks like',
  r.ok && r.counts.error === 1 && r.counts.warning === 4 && r.total === 5 && r.name === 'Call Center Module' && r.dir === 'Call Center Module' && r.problems.length === 5, JSON.stringify(r).slice(0, 200));
check('the conflict found in the failing file comes back with the result', r.conflicts.length === 1 && r.conflicts[0].file === 'Controllers/HomeController.cs');

d = fakeDotnet({ stdout: '', code: 0 });
r = await analyzeDotnet(CCM, { dotnet: DOTNET, spawnFn: d.spawnFn });
check('a clean project is ok with zero of everything', r.ok && r.total === 0 && r.counts.error === 0 && r.conflicts.length === 0);

d = fakeDotnet({ stderr: 'MSB1009: Project file does not exist.', code: 1 });
r = await analyzeDotnet(CCM, { dotnet: DOTNET, spawnFn: d.spawnFn });
check('a real failure with no diagnostics parsed is an error in words, never "no problems found"', !r.ok && /MSB1009/.test(r.error), JSON.stringify(r));

r = await analyzeDotnet(CCM, { dotnet: DOTNET, spawnFn: () => { throw new Error('spawn EPERM'); } });
check('a spawn that throws is reported and leaves nothing running', !r.ok && /EPERM/.test(r.error));
r = await analyzeDotnet(CCM, { dotnet: DOTNET, spawnFn: fakeDotnet({ stdout: '' }).spawnFn });
check('...so the next analysis of the same project still starts', r.ok);

check('without a resolved dotnet path, nothing is spawned - never guessed at by name',
  (await analyzeDotnet(CCM, { dotnet: null, spawnFn: fakeDotnet().spawnFn })).ok === false
  && (await analyzeDotnet(CCM, { dotnet: 'dotnet', spawnFn: fakeDotnet().spawnFn })).ok === false);
check('an unknown project is refused - nothing that is not a resolved project with a real target',
  (await analyzeDotnet(null, { dotnet: DOTNET, spawnFn: fakeDotnet().spawnFn })).ok === false
  && (await analyzeDotnet({ key: 'x', name: 'X', dir: 'relative/path', target: PROJ }, { dotnet: DOTNET, spawnFn: fakeDotnet().spawnFn })).ok === false
  && (await analyzeDotnet({ key: 'x', name: 'X', dir: PROJ_DIR }, { dotnet: DOTNET, spawnFn: fakeDotnet().spawnFn })).ok === false);
r = await analyzeDotnet({ key: 'gone', name: 'Gone', dir: path.join(WS, 'gone'), rel: 'gone', target: path.join(WS, 'gone', 'Gone.csproj') }, { dotnet: DOTNET, spawnFn: fakeDotnet().spawnFn });
check('a project not in the workspace says so, and dotnet is never started', !r.ok && /not found in the workspace/.test(r.error));

d = fakeDotnet({ stdout: OUT, code: 1, hold: true });
const first = analyzeDotnet(CCM, { dotnet: DOTNET, spawnFn: d.spawnFn });
const second = analyzeDotnet(CCM, { dotnet: DOTNET, spawnFn: d.spawnFn });
check('pressing Build twice joins the run in progress - one dotnet, not two', first === second && d.calls.length === 1);
d.calls[0].proc.finish();
check('...and both get the same answer', (await first).ok && (await second).counts.error === 1);

d = fakeDotnet({ stdout: OUT, code: 1, hold: true });
const stopped = analyzeDotnet(CCM, { dotnet: DOTNET, spawnFn: d.spawnFn });
check('Stop is accepted while it runs, and refused when nothing is running', cancelDotnetAnalysis('ccm') === true && cancelDotnetAnalysis('another') === false);
check('runningDotnetAnalysis() counts it while it runs - this is what power-down warns about', runningDotnetAnalysis() === 1);
d.calls[0].proc.finish(1);
r = await stopped;
check('a stopped build reports "stopped" - not the half-read list', !r.ok && r.cancelled === true);
check('...and runningDotnetAnalysis() is back to zero once it has', runningDotnetAnalysis() === 0);

const many = Array.from({ length: MAX_PROBLEMS + 50 }, (_, i) => `${abs('HistoryService.cs')}(${i + 1},1): warning CS9999: filler ${i} [${PROJ}]`).join('\r\n');
r = await analyzeDotnet(CCM, { dotnet: DOTNET, spawnFn: fakeDotnet({ stdout: `${OUT}\r\n${many}`, code: 1 }).spawnFn });
check('a huge list is cut for the window, errors kept, and the counts stay complete',
  r.ok && r.truncated && r.problems.length === MAX_PROBLEMS && r.total === MAX_PROBLEMS + 55 && r.problems[0].severity === 'error', `total=${r.total} truncated=${r.truncated}`);

// ------------------------------------------------------------------ wiring
console.log('\n--- wiring ---');
const main = read('src/main.mjs');
const pre = read('src/preload.cjs');
const html = read('src/renderer/index.html');
const js = read('src/renderer/dotnet-problems.js');
const pp = read('src/project-providers.mjs');
const code = read('src/dotnet-analysis.mjs').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('the analyser only reads: no write, no publish, no pack, no clean', !/writeFileSync|appendFile|'publish'|'pack'|'clean'/.test(code));
check('main offers analyse and stop, for a DISCOVERED .NET project of the active workspace only, trust-gated like the Dart one',
  /ipcMain\.handle\('jarvis:dotnetAnalyze', async \(_e, key\) => \{\s*if \(!workspaceTrusted\(\)\) return \{ ok: false, restricted: true, error: RESTRICTED_RUN \};\s*const hit = await resolveProject\(key, isDotnetProject\);\s*if \(!hit\) return \{ ok: false/.test(main) && main.includes("ipcMain.handle('jarvis:dotnetAnalyzeCancel'"));
check('the window is never handed this PC\'s absolute paths for the project list - only a key, a name and a relative dir',
  /ipcMain\.handle\('jarvis:dotnetProjects', async \(\) => \{[\s\S]{0,400}return list\.map\(\(a\) => \(\{ key: a\.key, name: a\.name, kind: a\.kind, dir: a\.dir, found: a\.found \}\)\);/.test(main));
check('quitting JARVIS, and power-down, both stop a .NET build analysis that is still running',
  (main.match(/shutdownDotnetAnalysis\(\)/g) || []).length === 2);
check('power-down\'s "what would stop" message knows about a .NET build in progress, the same way it knows about Dart analysis',
  /dotnetAnalysis = runningDotnetAnalysis\(\)/.test(main) && /dotnetAnalysis,/.test(main) && /work\.dotnetAnalysis/.test(read('src/active-work.mjs')));
check('the bridge exposes the three calls', pre.includes("dotnetProjects: () => ipcRenderer.invoke('jarvis:dotnetProjects')")
  && pre.includes("dotnetAnalyze: (key) => ipcRenderer.invoke('jarvis:dotnetAnalyze', key)") && pre.includes('dotnetAnalyzeCancel:'));
check('the Devices page has the panel, right after the Dart one, and its ids are each declared once',
  ['devDotnetProblems', 'dnpbSummary', 'dnpbNote', 'dnpbApps', 'dnpbFilters', 'dnpbSearch', 'dnpbFix', 'dnpbRun', 'dnpbBanners', 'dnpbList'].every((id) => html.split(`id="${id}"`).length === 2)
  && html.indexOf('id="devProblems"') < html.indexOf('id="devDotnetProblems"') && html.indexOf('id="devDotnetProblems"') < html.indexOf('</main>'));
check('dotnet-problems.js is loaded after problems.js and before app.js',
  html.indexOf('"problems.js"') < html.indexOf('dotnet-problems.js') && html.indexOf('dotnet-problems.js') < html.indexOf('"app.js"'));
check('it lists every discovered .NET project - sites, APIs, libraries and tests, not only the runnable web apps',
  /window\.jarvis\.dotnetProjects\(\)/.test(js) && (() => {
    const start = pp.indexOf('export async function dotnetProjectsFrom');
    const end = pp.indexOf('\n}\n', start);
    const body = pp.slice(start, end);
    return body.length > 0 && !/if \(!f\.web/.test(body);
  })());
check('the target to build is resolved the same way the existing Build action already resolves it - the project\'s own file, else a solution marker',
  /const target = f\.project \? path\.join\(absDir, f\.project\) : sln \? path\.join\(absDir, sln\) : null;/.test(pp));
check('a build that fails to start a site triggers this panel by itself, same as Dart analysis does for a failed Flutter run',
  /if \(e\.state !== 'exited' \|\| !e\.failed \|\| !e\.key\) return;/.test(js));
check('hints start hidden; errors and warnings start shown', /const show = \{ error: true, warning: true, hint: false \};/.test(js));
check('"Ask JARVIS to fix" fills the chat box and does not send', /JV\.chat\.insert\(text\)/.test(js) && !/window\.jarvis\.send/.test(js));
check('no fixed list of .NET projects anywhere - discovered, the same rule as Dart/Flutter and web apps',
  !/FLUTTER_APPS|WEB_APPS|DOTNET_PROJECTS/.test(main + code + js));

console.log(`\n${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('  FAILED: ' + f);
fs.rmSync(WS, { recursive: true, force: true });
process.exit(fails.length ? 1 : 0);
