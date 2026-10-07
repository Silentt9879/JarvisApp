// Project actions (src/project-providers.mjs) and the task runner (src/task-runner.mjs):
// what each kind of project offers, how a missing tool is said, which package scripts are
// offered, and that nothing a project controls ever reaches a shell. Temp folders only; the
// one real process started is this Node itself, printing a line.
//   node scripts/project-actions-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { discoverProjects } from '../src/project-discovery.mjs';
import { projectActions, actionForWindow, nodeManager, pythonEnv, NODE_SCRIPTS, flutterApps, dotnetFacts } from '../src/project-providers.mjs';
import { startTask, stopTask, taskLog, taskId, runningTasks, SAFE_ARG, displayCommand, CMD_EXE } from '../src/task-runner.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${extra ? `\n     ${extra}` : ''}`); } };
const check = async (name, fn) => { try { await fn(); ok(true, name); } catch (e) { ok(false, name, String(e.message || e).slice(0, 400)); } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-actions-'));
const write = (rel, text = '') => { const p = path.join(TMP, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
const DOTNET = path.join(TMP, 'tools', 'dotnet.exe');
const caps = (...ids) => ids.map((id) => ({ id, installed: true, where: id === 'dotnet' ? DOTNET : null }));
const ALL = caps('git', 'flutter', 'dart', 'dotnet', 'node', 'npm', 'python', 'java', 'gradle', 'maven');
let scanned = null;
const project = async (rel) => {
  if (!scanned) scanned = await discoverProjects(TMP);
  const p = scanned.projects.find((x) => x.relativePath === rel);
  assert.ok(p, `${rel} was discovered`);
  return p;
};
const actionsOf = async (rel, c = ALL) => projectActions(await project(rel), path.join(TMP, rel), c);
const byId = (list) => Object.fromEntries(list.map((a) => [a.id, a]));

// ------------------------------------------------------------------ the fixtures: one of each
fs.mkdirSync(path.join(TMP, 'shop', '.git'), { recursive: true });
write('shop/pubspec.yaml', 'name: shop\ndependencies:\n  flutter:\n    sdk: flutter\n');
write('shop/lib/main.dart', 'void main() {}');
write('shop/test/widget_test.dart', '');
write('shop/android/build.gradle', '');
write('dartlib/pubspec.yaml', 'name: dartlib\n');
write('dartlib/test/a_test.dart', '');
write('api/Api.csproj', '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>');
write('api.tests/Api.Tests.csproj', '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" /></ItemGroup></Project>');
write('lib/Lib.csproj', '<Project Sdk="Microsoft.NET.Sdk"></Project>');
write('web/package.json', JSON.stringify({ name: 'web', scripts: { dev: 'vite', test: 'vitest', build: 'vite build', lint: 'eslint .', deploy: 'firebase deploy', 'evil & del': 'x', postinstall: 'node x.js' } }));
write('pnpm-app/package.json', JSON.stringify({ name: 'p', scripts: { build: 'tsc' } }));
write('pnpm-app/pnpm-lock.yaml', '');
write('broken-node/package.json', '{ nope');
write('py-none/pyproject.toml', '[project]\nname = "none"\n');
write('py-env/requirements.txt', 'pytest\n');
write('py-env/.venv/pyvenv.cfg', 'home = C:\\Python312\n');
write('py-env/.venv/Scripts/python.exe', '');
write('py-env/.venv/Scripts/pytest.exe', '');
write('py-nopytest/requirements.txt', 'flask\n');
write('py-nopytest/.venv/pyvenv.cfg', '');
write('py-nopytest/.venv/Scripts/python.exe', '');
write('gradle-app/build.gradle', '');
write('gradle-app/gradlew.bat', '@echo off');
write('gradle-bare/build.gradle', '');
write('maven-app/pom.xml', '<project/>');
write('maven-app/mvnw.cmd', '@echo off');

// ------------------------------------------------------------------ Flutter / Dart
await check('a Flutter app: Source Control, Run (Devices), Analyse, and Test with flutter', async () => {
  const a = byId(await actionsOf('shop'));
  assert.deepEqual(Object.keys(a).sort(), ['analyse', 'git', 'run', 'test']);
  assert.equal(a.git.kind, 'jump');
  assert.equal(a.git.to, 'source');
  assert.equal(a.run.to, 'devices');
  assert.equal(a.run.appKey, 'shop');
  assert.equal(a.analyse.to, 'analysis');
  assert.deepEqual([a.test.spec.file, ...a.test.spec.args], ['flutter', 'test']);
  assert.equal(a.test.spec.via, 'cmd');
});
await check('without Flutter installed: Test says why instead of vanishing; Run is marked as needing it', async () => {
  const a = byId(await actionsOf('shop', caps('git')));
  assert.equal(a.test.available, false);
  assert.match(a.test.reason, /Flutter is not installed/);
  assert.equal(a.run.needs, 'Flutter');
});
await check('a Flutter app\'s android/ host project offers nothing of its own', async () => {
  assert.deepEqual(await actionsOf('shop/android'), []);
});
await check('a plain Dart package tests with dart (or flutter, which includes dart)', async () => {
  const a = byId(await actionsOf('dartlib'));
  assert.equal(a.test.spec.file, 'dart');
  assert.equal(a.run, undefined, 'a package is not run on a phone');
  const viaFlutter = byId(await actionsOf('dartlib', caps('flutter')));
  assert.equal(viaFlutter.test.spec.file, 'flutter');
});
await check('the Devices app list carries the person\'s own warning for a project, and none is invented', async () => {
  const shop = await project('shop');
  const [plain] = flutterApps([shop]);
  assert.equal(plain.key, 'shop');
  assert.equal(plain.warn, null);
  const [warned] = flutterApps([{ ...shop, warning: 'Uses the live database' }]);
  assert.equal(warned.warn, 'Uses the live database');
  assert.deepEqual(flutterApps([await project('dartlib'), await project('shop/android')]), [], 'a package and a platform folder are not apps');
});

// ------------------------------------------------------------------ .NET
await check('a .NET web project: Run (the Web apps panel) and Build with the SDK\'s full path; no Test', async () => {
  const a = byId(await actionsOf('api'));
  assert.equal(a.run.to, 'webapps');
  assert.equal(a.build.spec.file, DOTNET, 'dotnet by its full path - never a name looked up in the project folder');
  assert.deepEqual(a.build.spec.args, ['build', 'Api.csproj', '--nologo']);
  assert.equal(a.build.spec.via, null, 'an exe, started directly - no shell');
  assert.equal(a.test, undefined, 'not a test project: no invented Test');
});
await check('a .NET test project offers Test; a class library only Build', async () => {
  assert.deepEqual(byId(await actionsOf('api.tests')).test.spec.args, ['test', 'Api.Tests.csproj', '--nologo']);
  const lib = byId(await actionsOf('lib'));
  assert.ok(lib.build && !lib.test && !lib.run);
});
await check('without the .NET SDK: Build and Run say so', async () => {
  const a = byId(await actionsOf('api', caps('git')));
  assert.equal(a.build.available, false);
  assert.match(a.build.reason, /\.NET SDK is not installed/);
  assert.equal(a.run.needs, '.NET SDK');
});
await check('a crafted project file (a megabyte of "<Project " and no ">") is read in moments, not minutes', async () => {
  const dir = path.join(TMP, 'crafted-dotnet');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Evil.csproj'), '<Project '.repeat(116000));
  const t = Date.now();
  const f = await dotnetFacts(dir, ['Evil.csproj']);
  assert.ok(Date.now() - t < 1000, `${Date.now() - t} ms`);
  assert.equal(f.web, false, 'and it is no web project');
  const web = await dotnetFacts(path.join(TMP, 'api'), ['Api.csproj']);
  assert.equal(web.kind, 'api', 'an ordinary one still reads as before');
});

// ------------------------------------------------------------------ Node
await check('Node: only the common scripts the project DEFINES - never deploy, never install hooks, never odd names', async () => {
  const a = await actionsOf('web');
  const ids = a.map((x) => x.id);
  assert.deepEqual(ids, ['script:dev', 'test', 'build', 'script:lint']);
  assert.ok(!ids.some((i) => /deploy|postinstall|evil/.test(i)));
  const dev = byId(a)['script:dev'];
  assert.deepEqual([dev.spec.file, ...dev.spec.args], ['npm', 'run', 'dev']);
  assert.equal(dev.script, 'vite', 'what the script does is shown before it runs');
});
await check('Node: the lock file picks the package manager; a broken package.json offers nothing', async () => {
  assert.equal(nodeManager(path.join(TMP, 'pnpm-app')), 'pnpm');
  assert.equal(byId(await actionsOf('pnpm-app')).build.spec.file, 'pnpm');
  assert.deepEqual(await actionsOf('broken-node'), []);
  assert.ok(NODE_SCRIPTS.every((s) => !/deploy|publish|release|install/.test(s)));
});
await check('Node not installed: the scripts are listed, unavailable, with the reason', async () => {
  const a = byId(await actionsOf('web', caps('git')));
  assert.equal(a.test.available, false);
  assert.match(a.test.reason, /Node\.js is not installed/);
});

// ------------------------------------------------------------------ Python
await check('Python: nothing runs without the project\'s own environment - none is created', async () => {
  assert.deepEqual(await actionsOf('py-none'), []);
  assert.ok(!fs.existsSync(path.join(TMP, 'py-none', '.venv')), 'no environment was made');
  assert.deepEqual(await actionsOf('py-nopytest'), [], 'an environment without pytest: no guessed test command');
});
await check('Python: with pytest already in its .venv, Test runs that environment\'s pytest', async () => {
  const env = pythonEnv(path.join(TMP, 'py-env'));
  assert.equal(env.dir, '.venv');
  const a = byId(await actionsOf('py-env'));
  assert.equal(a.test.spec.file, path.join(TMP, 'py-env', '.venv', 'Scripts', 'python.exe'));
  assert.deepEqual(a.test.spec.args, ['-m', 'pytest']);
});

// ------------------------------------------------------------------ Gradle / Maven
await check('Gradle: the project\'s own wrapper, named explicitly; assemble and test - nothing that publishes', async () => {
  const a = byId(await actionsOf('gradle-app'));
  assert.equal(a.build.spec.file, '.\\gradlew.bat');
  assert.deepEqual(a.build.spec.args, ['assemble', '--console=plain']);
  assert.deepEqual(a.test.spec.args, ['test', '--console=plain']);
});
await check('Gradle without a JDK, or without a wrapper or Gradle, says why', async () => {
  assert.match(byId(await actionsOf('gradle-app', caps('gradle'))).build.reason, /needs a JDK/);
  assert.match(byId(await actionsOf('gradle-bare', caps('java'))).build.reason, /No Gradle wrapper/);
  assert.equal(byId(await actionsOf('gradle-bare', caps('java', 'gradle'))).build.spec.file, 'gradle');
});
await check('Maven: the wrapper; compile and test - never install or deploy', async () => {
  const a = byId(await actionsOf('maven-app'));
  assert.equal(a.build.spec.file, '.\\mvnw.cmd');
  assert.deepEqual(a.build.spec.args, ['-B', 'compile']);
  assert.deepEqual(a.test.spec.args, ['-B', 'test']);
});

// ------------------------------------------------------------------ what the window sees
await check('the window sees a label and a display command - never a full path or a spec', async () => {
  const shown = (await actionsOf('api')).map(actionForWindow);
  const build = shown.find((a) => a.id === 'build');
  assert.equal(build.command, 'dotnet build Api.csproj --nologo');
  assert.ok(!JSON.stringify(shown).includes(TMP), 'no full path leaves the main process');
  assert.ok(!('spec' in build));
});

// ------------------------------------------------------------------ the task runner
function fakeSpawn() {
  const calls = [];
  const spawnFn = (file, args, opts) => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.pid = 0;
    calls.push({ file, args, opts, proc });
    return proc;
  };
  return { spawnFn, calls };
}

await check('a cmd task goes through cmd.exe with checked words, and the working folder never searched first', async () => {
  const { spawnFn, calls } = fakeSpawn();
  const events = [];
  const cwd = path.join(TMP, 'web');
  const st = startTask({ projectKey: 'web', actionId: 'test', label: 'Test', file: 'npm', args: ['run', 'test'], via: 'cmd', cwd }, (e) => events.push(e), { spawnFn });
  assert.equal(st.state, 'running');
  if (process.platform === 'win32') {
    assert.equal(calls[0].file, CMD_EXE, 'cmd.exe by its full path, never a bare name');
    assert.ok(path.isAbsolute(CMD_EXE) && /System32[\\/]cmd\.exe$/i.test(CMD_EXE), CMD_EXE);
    assert.deepEqual(calls[0].args, ['/d', '/s', '/c', 'npm', 'run', 'test']);
  }
  assert.equal(calls[0].opts.cwd, cwd);
  assert.equal(calls[0].opts.env.NoDefaultCurrentDirectoryInExePath, '1');
  assert.throws(() => startTask({ projectKey: 'web', actionId: 'test', file: 'npm', args: ['run', 'test'], via: 'cmd', cwd }, () => {}, { spawnFn }), /already running/);
  calls[0].proc.stdout.emit('data', 'ok 1 adds\n');
  calls[0].proc.emit('close', 0);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(events.at(-1).kind, 'task_state');
  assert.equal(events.at(-1).state, 'passed');
  assert.ok(taskLog(taskId('web', 'test')).some((l) => l.text === 'ok 1 adds'));
});

await check('anything that could be a shell metacharacter never reaches cmd.exe', async () => {
  const { spawnFn, calls } = fakeSpawn();
  const cwd = path.join(TMP, 'web');
  for (const bad of ['build & del *', 'a|b', 'x>y', '%PATH%', 'a"b', 'a^b', '(x)', 'two words']) {
    assert.ok(!SAFE_ARG.test(bad), bad);
    assert.throws(() => startTask({ projectKey: 'web', actionId: `s-${bad}`, file: 'npm', args: ['run', bad], via: 'cmd', cwd }, () => {}, { spawnFn }), /will not pass to cmd\.exe/);
  }
  assert.equal(calls.length, 0, 'nothing was started');
  assert.throws(() => startTask({ projectKey: 'x', actionId: 'b', file: 'dotnet.exe', args: ['build'], via: null, cwd }, () => {}, { spawnFn }), /could not be found/, 'a direct exe must be a full path');
  assert.throws(() => startTask({ projectKey: 'x', actionId: 'b', file: 'npm', args: [], via: 'cmd', cwd: 'relative' }, () => {}, { spawnFn }), /folder is not known/);
});

await check('Stop ends a task as stopped, not failed; a failing one reports failed', async () => {
  const { spawnFn, calls } = fakeSpawn();
  const events = [];
  const cwd = path.join(TMP, 'api');
  startTask({ projectKey: 'api', actionId: 'build', file: DOTNET, args: ['build'], via: null, cwd }, (e) => events.push(e), { spawnFn });
  assert.equal(calls[0].file, DOTNET, 'started directly by its full path');
  assert.equal(stopTask(taskId('api', 'build')).ok, true);
  calls[0].proc.emit('close', 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(events.filter((e) => e.kind === 'task_state').at(-1).state, 'stopped');
  assert.equal(stopTask(taskId('api', 'build')).ok, false, 'nothing left to stop');
  startTask({ projectKey: 'api', actionId: 'test', file: DOTNET, args: ['test'], via: null, cwd }, (e) => events.push(e), { spawnFn });
  calls[1].proc.emit('close', 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(events.filter((e) => e.kind === 'task_state').at(-1).state, 'failed');
  assert.equal(runningTasks().length, 0);
});

await check('a real task end to end: this Node prints a line, and it comes back in the log', async () => {
  const events = [];
  startTask({ projectKey: 'real', actionId: 'echo', label: 'Echo', file: process.execPath, args: ['-e', 'console.log(42)'], via: null, cwd: TMP }, (e) => events.push(e));
  const deadline = Date.now() + 10000;
  while (!events.some((e) => e.kind === 'task_state' && e.state !== 'running') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.equal(events.filter((e) => e.kind === 'task_state').at(-1).state, 'passed');
  assert.ok(taskLog(taskId('real', 'echo')).some((l) => l.text === '42'));
  assert.equal(displayCommand({ file: process.execPath, args: ['-e', 'x y'] }), 'node -e "x y"');
});

await check('a project holding its own cmd.exe and npm.cmd: the real ones run, not the planted ones', async () => {
  if (process.platform !== 'win32') return;
  // The planted cmd.exe is a copy of Windows' harmless hostname.exe: if it ran, the log would
  // hold this PC's name instead of the echo. The planted npm.cmd would print PLANTED.
  const planted = path.join(TMP, 'planted');
  fs.mkdirSync(planted, { recursive: true });
  fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'HOSTNAME.EXE'), path.join(planted, 'cmd.exe'));
  fs.writeFileSync(path.join(planted, 'npm.cmd'), '@echo PLANTED\r\n');
  fs.writeFileSync(path.join(planted, 'where-am-i.cmd'), '@echo PLANTED\r\n');
  // As JARVIS is when started from the Start menu: nothing set in this process's own environment.
  const saved = process.env.NoDefaultCurrentDirectoryInExePath;
  delete process.env.NoDefaultCurrentDirectoryInExePath;
  try {
    const events = [];
    startTask({ projectKey: 'planted', actionId: 'echo', label: 'Echo', file: 'echo', args: ['REAL_CMD'], via: 'cmd', cwd: planted }, (e) => events.push(e));
    startTask({ projectKey: 'planted', actionId: 'tool', label: 'Tool', file: 'where-am-i', args: [], via: 'cmd', cwd: planted }, (e) => events.push(e));
    const deadline = Date.now() + 15000;
    const done = (key) => events.some((e) => e.kind === 'task_state' && e.id === taskId('planted', key) && e.state !== 'running');
    while (!(done('echo') && done('tool')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const echo = taskLog(taskId('planted', 'echo')).map((l) => l.text);
    assert.ok(echo.includes('REAL_CMD'), `the real cmd.exe ran: ${echo.join(' | ')}`);
    const tool = taskLog(taskId('planted', 'tool')).map((l) => l.text);
    assert.ok(!tool.includes('PLANTED'), `cmd did not take a tool from the project folder: ${tool.join(' | ')}`);
  } finally {
    if (saved === undefined) delete process.env.NoDefaultCurrentDirectoryInExePath; else process.env.NoDefaultCurrentDirectoryInExePath = saved;
  }
});

await check('main.mjs turns the working-folder lookup off for itself, before anything starts', async () => {
  const main = fs.readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8');
  const at = main.indexOf("process.env.NoDefaultCurrentDirectoryInExePath = '1';");
  assert.ok(at > 0, 'set in the main process');
  for (const first of ['spawn(', 'execFile(', 'app.whenReady(']) {
    const i = main.indexOf(first);
    assert.ok(i === -1 || i > at, `before the first ${first}`);
  }
  for (const f of ['../src/devices.mjs', '../src/analysis.mjs']) {
    const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.ok(!/\['cmd\.exe'/.test(src) && /'System32', 'cmd\.exe'/.test(src), `${f}: cmd.exe by its full path`);
  }
});

// ------------------------------------------------------------------ wiring
await check('wiring: the window sends only a project and an action id; main works out the command itself', async () => {
  const main = fs.readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8');
  const pre = fs.readFileSync(new URL('../src/preload.cjs', import.meta.url), 'utf8');
  assert.match(main, /ipcMain\.handle\('projects:run', async \(_e, key, actionId\) => \{[\s\S]{0,300}const r = await actionsFor\(key\);[\s\S]{0,200}const a = r\.actions\.find\(\(x\) => x\.id === actionId\);/);
  assert.match(main, /startTask\(\{ \.\.\.a\.spec, cwd: r\.hit\.dir/, 'the folder is the checked project folder, never from the window');
  assert.ok(pre.includes("projectRun: (key, actionId) => ipcRenderer.invoke('projects:run', key, actionId)"));
  assert.match(main, /shutdownTasks\(\)/, 'quitting or switching stops running tasks');
  const web = fs.readFileSync(new URL('../src/webapps.mjs', import.meta.url), 'utf8');
  assert.ok(/NoDefaultCurrentDirectoryInExePath: '1'/.test(web) && /spawn\(dotnet, args/.test(web), 'dotnet watch runs from a full path, with the working-folder lookup off');
  for (const f of ['../src/devices.mjs', '../src/analysis.mjs']) assert.match(fs.readFileSync(new URL(f, import.meta.url), 'utf8'), /NoDefaultCurrentDirectoryInExePath: '1'/, f);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`project-actions-test: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
