// Dart analysis for the Devices page (src/analysis.mjs): the machine output parsed, the
// conflict-marker check, and the runner driven with a stand-in for `dart` - no SDK needed,
// and no real project is analysed.   node scripts/analysis-test.mjs
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseMachine, countProblems, findConflicts, analyzeApp, cancelAnalysis, runningAnalysis, MAX_PROBLEMS } from '../src/analysis.mjs';

let pass = 0; const fails = [];
const check = (n, c, extra) => {
  if (c) { pass += 1; console.log('PASS  ' + n); }
  else { fails.push(n); console.log('FAIL  ' + n + (extra ? '\n        ' + String(extra).slice(0, 300) : '')); }
};
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// ------------------------------------------------------------------ parsing
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-analysis-'));
const APP = path.join(WS, 'shop_app');
// A discovered project, as main.mjs hands it over: its id, name, folder and workspace path.
const SHOP = { key: 'shop_app', name: 'Shop App', dir: APP, rel: 'shop_app' };
fs.mkdirSync(path.join(APP, 'lib', 'Views'), { recursive: true });
fs.writeFileSync(path.join(APP, 'pubspec.yaml'), 'name: shop_app\n');
const abs = (rel) => path.join(APP, rel);
const OUT = [
  `INFO|LINT|PREFER_CONST|${abs('lib/main.dart')}|12|5|4|Use 'const' with the constructor.`,
  `WARNING|STATIC_WARNING|UNUSED_IMPORT|${abs('lib/Models/AppVersion.dart')}|1|8|9|Unused import: 'dart:io'.`,
  `ERROR|SYNTACTIC_ERROR|EXPECTED_TOKEN|${abs('lib/Views/orders_view.dart')}|3489|3|3|The '===' operator is not supported.`,
  `ERROR|SYNTACTIC_ERROR|MISSING_IDENTIFIER|${abs('lib/Views/orders_view.dart')}|3487|1|2|Expected an identifier.`,
  `ERROR|COMPILE_TIME_ERROR|X|${abs('lib/a.dart')}|4|2|1|A pipe \\| in a message, and a backslash \\\\ too.`,
  'Analyzing shop_app...',
  '',
  'ERROR|too|few|fields',
  `NOTE|X|Y|${abs('lib/a.dart')}|1|1|1|An unknown severity is not a problem.`,
].join('\r\n');
const list = parseMachine(OUT, APP);
check('each machine line becomes one problem; chatter, short lines and unknown severities are dropped', list.length === 5, list.length);
check('errors come first, then warnings, then hints - and within a file, in line order',
  list.map((p) => p.severity).join(',') === 'error,error,error,warning,hint'
  && list.filter((p) => p.file.endsWith('orders_view.dart')).map((p) => p.line).join(',') === '3487,3489', JSON.stringify(list.map((p) => [p.severity, p.file, p.line])));
check('paths are relative to the app, with forward slashes', list.every((p) => !path.isAbsolute(p.file) && !p.file.includes('\\')) && list[1].file === 'lib/Views/orders_view.dart', list.map((p) => p.file).join(' '));
check('INFO is called a hint, as the IDE calls it', list.at(-1).severity === 'hint' && list.at(-1).code === 'prefer_const');
check('an escaped pipe or backslash in a message is kept as text, not read as a field break',
  list[0].message === 'A pipe | in a message, and a backslash \\ too.', list[0].message);
const counts = countProblems(list);
check('the counts are per severity', counts.error === 3 && counts.warning === 1 && counts.hint === 1);
check('a file outside the app keeps its own path rather than a "../" one',
  parseMachine('ERROR|A|B|C:\\elsewhere\\x.dart|1|1|1|m', APP)[0].file === 'C:/elsewhere/x.dart');
check('empty output is no problems, not an error', parseMachine('', APP).length === 0 && parseMachine(null, APP).length === 0);

// ------------------------------------------------------------------ conflict markers
fs.writeFileSync(abs('lib/Views/orders_view.dart'), ['a', '<<<<<<< Updated upstream', 'x', '=======', 'y', '>>>>>>> Stashed changes', 'b'].join('\n'));
fs.writeFileSync(abs('lib/a.dart'), ['// =======', '=======', 'just a rule, no conflict'].join('\n'));
const conflicts = findConflicts(list, APP);
check('git conflict markers in a file with errors are found, with the line they start at',
  conflicts.length === 1 && conflicts[0].file === 'lib/Views/orders_view.dart' && conflicts[0].line === 2 && conflicts[0].lines.join(',') === '2,4,6', JSON.stringify(conflicts));
check('a lone ======= rule is not called a conflict', !conflicts.some((c) => c.file === 'lib/a.dart'));
check('only files with errors are read - a warning-only file is left alone',
  findConflicts(list.filter((p) => p.severity !== 'error'), APP, { readFile: () => { throw new Error('should not be read'); } }).length === 0);
check('a file that cannot be read is skipped, not fatal', findConflicts(list, path.join(WS, 'nowhere')).length === 0);

// ------------------------------------------------------------------ the runner, with a stand-in dart
function fakeDart({ stdout = '', stderr = '', code = 0, hold = false } = {}) {
  const calls = [];
  const spawnFn = (cmd, args, opts) => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.pid = 0; // nothing real to kill
    calls.push({ cmd, args, cwd: opts.cwd, proc });
    proc.finish = (c = code) => { if (stdout) proc.stdout.emit('data', Buffer.from(stdout)); if (stderr) proc.stderr.emit('data', Buffer.from(stderr)); proc.emit('close', c); };
    if (!hold) setImmediate(() => proc.finish());
    return proc;
  };
  return { spawnFn, calls };
}

let d = fakeDart({ stdout: OUT, code: 3 });
let r = await analyzeApp(SHOP, { spawnFn: d.spawnFn });
check('it runs `dart analyze --format=machine` in the app\'s own folder, and nothing else',
  d.calls.length === 1 && d.calls[0].args.slice(-2).join(' ') === 'analyze --format=machine' && d.calls[0].cwd === APP
  && !d.calls[0].args.some((a) => ['fix', 'format', '--apply', '--fix'].includes(a)), JSON.stringify(d.calls[0].args));
check('exit 3 with problems is a result, not a failure - that exit only means "errors found"',
  r.ok && r.counts.error === 3 && r.total === 5 && r.name === 'Shop App' && r.dir === 'shop_app' && r.problems.length === 5 && r.truncated === false, JSON.stringify(r).slice(0, 200));
check('the conflict found in the failing file comes back with the result', r.conflicts.length === 1 && r.conflicts[0].line === 2);

d = fakeDart({ stderr: OUT, code: 3 });
r = await analyzeApp(SHOP, { spawnFn: d.spawnFn });
check('an older SDK that writes the list to stderr reads the same', r.ok && r.counts.error === 3);

d = fakeDart({ stdout: '', code: 0 });
r = await analyzeApp(SHOP, { spawnFn: d.spawnFn });
check('a clean app is ok with zero of everything', r.ok && r.total === 0 && r.counts.error === 0 && r.conflicts.length === 0);

d = fakeDart({ stderr: "'dart' is not recognized as an internal or external command", code: 1 });
r = await analyzeApp(SHOP, { spawnFn: d.spawnFn });
check('dart missing is an error in words, never "no problems found"', !r.ok && /not recognized/.test(r.error), JSON.stringify(r));

r = await analyzeApp(SHOP, { spawnFn: () => { throw new Error('spawn EPERM'); } });
check('a spawn that throws is reported and leaves nothing running', !r.ok && /EPERM/.test(r.error));
r = await analyzeApp(SHOP, { spawnFn: fakeDart({ stdout: '' }).spawnFn });
check('...so the next analysis of the same app still starts', r.ok);

check('an unknown app is refused - nothing that is not a resolved project with a real folder',
  (await analyzeApp(null, { spawnFn: fakeDart().spawnFn })).ok === false
  && (await analyzeApp({ key: 'x', name: 'X', dir: 'relative/path' }, { spawnFn: fakeDart().spawnFn })).ok === false);
r = await analyzeApp({ key: 'gone', name: 'Gone App', dir: path.join(WS, 'gone'), rel: 'gone' }, { spawnFn: fakeDart().spawnFn });
check('an app that is not in the workspace says so, and dart is never started', !r.ok && /not found in the workspace/.test(r.error));

d = fakeDart({ stdout: OUT, code: 3, hold: true });
const first = analyzeApp(SHOP, { spawnFn: d.spawnFn });
const second = analyzeApp(SHOP, { spawnFn: d.spawnFn });
check('pressing Analyse twice joins the run in progress - one dart, not two', first === second && d.calls.length === 1);
d.calls[0].proc.finish();
check('...and both get the same answer', (await first).ok && (await second).counts.error === 3);

d = fakeDart({ stdout: OUT, code: 3, hold: true });
const stopped = analyzeApp(SHOP, { spawnFn: d.spawnFn });
check('Stop is accepted while it runs, and refused when nothing is running', cancelAnalysis('shop_app') === true && cancelAnalysis('another_app') === false);
check('runningAnalysis() counts it while it runs - this is what power-down warns about', runningAnalysis() === 1);
d.calls[0].proc.finish(1);
r = await stopped;
check('a stopped analysis reports "stopped" - not the half-read list', !r.ok && r.cancelled === true);
check('...and runningAnalysis() is back to zero once it has', runningAnalysis() === 0);

const many = Array.from({ length: MAX_PROBLEMS + 50 }, (_, i) => `INFO|LINT|X|${abs('lib/main.dart')}|${i + 1}|1|1|hint ${i}`).join('\n');
r = await analyzeApp(SHOP, { spawnFn: fakeDart({ stdout: `${OUT}\n${many}`, code: 3 }).spawnFn });
check('a huge list is cut for the window, errors kept, and the counts stay complete',
  r.ok && r.truncated && r.problems.length === MAX_PROBLEMS && r.total === MAX_PROBLEMS + 55 && r.counts.hint === MAX_PROBLEMS + 51 && r.problems[0].severity === 'error');

// ------------------------------------------------------------------ wiring
console.log('\n--- wiring ---');
const main = read('src/main.mjs');
const pre = read('src/preload.cjs');
const html = read('src/renderer/index.html');
const js = read('src/renderer/problems.js');
const dev = read('src/devices.mjs');
const code = read('src/analysis.mjs').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('the analyser only reads: no write, no `dart fix`, no `dart format`', !/writeFile|appendFile|unlink|rmSync|'fix'|'format'/.test(code));
check('main offers analyse and stop, for a DISCOVERED Dart project of the active workspace only',
  /ipcMain\.handle\('jarvis:analyze', async \(_e, key\) => \{[\s\S]{0,200}if \(!workspaceTrusted\(\)\) return \{ ok: false, restricted: true, error: RESTRICTED_RUN \};\s*const hit = await resolveProject\(key, isDartProject\);\s*if \(!hit\) return \{ ok: false/.test(main) && main.includes("ipcMain.handle('jarvis:analyzeCancel'"));
check('no fixed list of apps is left anywhere in JARVIS: projects are discovered',
  !/FLUTTER_APPS|WEB_APPS/.test(main + dev + read('src/analysis.mjs') + read('src/webapps.mjs') + js + read('src/renderer/devices.js') + read('src/renderer/webapps.js')));
check('the Dart analysis panel lists every discovered Dart/Flutter project, packages too',
  /window\.jarvis\.dartProjects\(\)/.test(js) && pre.includes("dartProjects: () => ipcRenderer.invoke('jarvis:dartProjects')"));
check('quitting JARVIS stops an analysis that is still running', /shutdownAnalysis\(\)/.test(main));
check('the bridge exposes the two calls', pre.includes("analyze: (app) => ipcRenderer.invoke('jarvis:analyze', app)") && pre.includes('analyzeCancel:'));
check('the Devices page has the panel, and its ids are each declared once',
  ['devProblems', 'pbSummary', 'pbNote', 'pbApps', 'pbFilters', 'pbSearch', 'pbFix', 'pbRun', 'pbBanners', 'pbList'].every((id) => html.split(`id="${id}"`).length === 2)
  && html.indexOf('id="devProblems"') > html.indexOf('id="view-devices"') && html.indexOf('id="devProblems"') < html.indexOf('</main>'));
check('problems.js is loaded by the window, after crew.js (it extends the capture demo) and before app.js',
  html.indexOf('crew.js') < html.indexOf('problems.js') && html.indexOf('problems.js') < html.indexOf('"app.js"'));
check('a run that fails to build says so: `failed` (not Stop) and `built` travel with the exit',
  /failed: !!code && !r\.stopAsked, built: !!r\.everRan/.test(dev) && /r\.stopAsked = true;/.test(dev) && /r\.everRan = true;/.test(dev));
check('...and the window analyses that app by itself only for a failed build, never after Stop or a crash at run time',
  /if \(e\.state !== 'exited' \|\| !e\.failed \|\| e\.built \|\| !e\.app\) return;/.test(js));
check('hints start hidden; errors and warnings start shown', /const show = \{ error: true, warning: true, hint: false \};/.test(js));
check('"Ask JARVIS to fix" fills the chat box and does not send', /JV\.chat\.insert\(text\)/.test(js) && !/window\.jarvis\.send/.test(js));

console.log(`\n${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('  FAILED: ' + f);
fs.rmSync(WS, { recursive: true, force: true });
process.exit(fails.length ? 1 : 0);
