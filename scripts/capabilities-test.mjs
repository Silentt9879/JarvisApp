// Unit test for the Capability Registry (src/capabilities.mjs). The command runner is always
// faked here - this must never depend on what happens to be installed on the machine it runs on.
//   node scripts/capabilities-test.mjs
import assert from 'node:assert/strict';
import { getCapabilities, invalidateCapabilities, CAPABILITY_IDS } from '../src/capabilities.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${extra ? `\n     ${extra}` : ''}`); } };
const check = async (name, fn) => {
  try { await fn(); ok(true, name); } catch (e) { ok(false, name, String(e.message || e).slice(0, 300)); }
};

/** A fake runCommand: a list of { match(file, args), result } tried in order, else "not found". */
function fakeRun(table) {
  const calls = [];
  const run = async (file, args) => {
    calls.push(`${file} ${(args || []).join(' ')}`.trim());
    for (const t of table) if (t.match(file, args || [])) return t.result;
    return { ok: false, code: 9009, output: `'${file}' is not recognized as an internal or external command.` };
  };
  return { run, calls };
}

const versionFlag = (name, output) => ({ match: (file, args) => file === name && args[0] === '--version', result: { ok: true, code: 0, output } });
const whereOf = (name, path) => ({ match: (file, args) => file === 'where' && args[0] === name, result: { ok: true, code: 0, output: `${path}\n` } });

ok(CAPABILITY_IDS.length === 14 && CAPABILITY_IDS.includes('gh') && CAPABILITY_IDS.includes('adb'), 'all 14 requested capabilities are registered');

// ------------------------------------------------------------------ everything installed
await check('every capability reports installed, a version and a where, when the tool answers', async () => {
  invalidateCapabilities();
  const { run } = fakeRun([
    versionFlag('claude', 'claude 2.1.0'),
    versionFlag('git', 'git version 2.43.0.windows.1'),
    { match: (f, a) => f === 'gh' && a[0] === '--version', result: { ok: true, code: 0, output: 'gh version 2.40.0 (2024-01-01)' } },
    { match: (f, a) => f === 'gh' && a[0] === 'auth' && a[1] === 'status', result: { ok: true, code: 0, output: 'Logged in to github.com as me (keyring)' } },
    versionFlag('node', 'v20.11.0'),
    versionFlag('npm', '10.2.4'),
    { match: (f, a) => f === 'flutter' && a[0] === '--version', result: { ok: true, code: 0, output: 'Flutter 3.24.0 \u2022 channel stable \u2022 https://github.com/flutter/flutter.git' } },
    { match: (f, a) => f === 'dart' && a[0] === '--version', result: { ok: true, code: 0, output: 'Dart SDK version: 3.5.0 (stable) (Tue Jan 1 00:00:00 2026)' } },
    versionFlag('dotnet', '8.0.100'),
    { match: (f, a) => a[0] === 'version', result: { ok: true, code: 0, output: 'Android Debug Bridge version 1.0.41' } },
    { match: (f, a) => f === 'code' && a[0] === '--version', result: { ok: true, code: 0, output: '1.90.0\nabcdef1234\nx64' } },
    { match: (f, a) => f === 'python' && a[0] === '--version', result: { ok: true, code: 0, output: 'Python 3.12.1' } },
    { match: (f, a) => f === 'java' && a[0] === '-version', result: { ok: true, code: 0, output: 'openjdk version "21.0.1" 2023-10-17' } },
    { match: (f, a) => f === 'gradle' && a[0] === '--version', result: { ok: true, code: 0, output: 'Gradle 8.5\n------------------------------------------------------------' } },
    { match: (f, a) => f === 'mvn' && a[0] === '--version', result: { ok: true, code: 0, output: 'Apache Maven 3.9.6 (abcdef)' } },
    whereOf('claude', 'C:\\tools\\claude.exe'),
    whereOf('git', 'C:\\Program Files\\Git\\cmd\\git.exe'),
    whereOf('gh', 'C:\\tools\\gh.exe'),
    whereOf('node', 'C:\\Program Files\\nodejs\\node.exe'),
    whereOf('npm', 'C:\\Program Files\\nodejs\\npm.cmd'),
    whereOf('flutter', 'C:\\flutter\\bin\\flutter.bat'),
    whereOf('dart', 'C:\\flutter\\bin\\dart.bat'),
    whereOf('dotnet', 'C:\\Program Files\\dotnet\\dotnet.exe'),
    whereOf('code', 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd'),
    whereOf('python', 'C:\\Python312\\python.exe'),
    whereOf('java', 'C:\\Program Files\\Java\\jdk-21\\bin\\java.exe'),
    whereOf('gradle', 'C:\\gradle\\bin\\gradle.bat'),
    whereOf('mvn', 'C:\\maven\\bin\\mvn.cmd'),
  ]);
  const caps = await getCapabilities({ run, force: true });
  const by = Object.fromEntries(caps.map((c) => [c.id, c]));
  assert.equal(caps.length, 14);
  assert.equal(by.claude.installed, true);
  assert.equal(by.git.version, '2.43.0');
  assert.equal(by.gh.installed, true);
  assert.equal(by.gh.configured, true);
  assert.equal(by.node.version, '20.11.0');
  assert.equal(by.npm.version, '10.2.4');
  assert.equal(by.flutter.version, '3.24.0');
  assert.equal(by.dart.version, '3.5.0');
  assert.equal(by.dotnet.version, '8.0.100');
  assert.equal(by.adb.version, '1.0.41');
  assert.equal(by.vscode.version, '1.90.0');
  assert.equal(by.python.version, '3.12.1');
  assert.equal(by.java.version, '21.0.1');
  assert.equal(by.gradle.version, '8.5');
  assert.equal(by.maven.version, '3.9.6');
  assert.equal(by.git.where, 'C:\\Program Files\\Git\\cmd\\git.exe');
  assert.equal(by.git.error, null);
});

// ------------------------------------------------------------------ nothing installed
await check('a PC with none of these tools gets plain "not installed" states, never a throw', async () => {
  invalidateCapabilities();
  const { run } = fakeRun([]); // every command "not recognized"
  const caps = await getCapabilities({ run, force: true });
  assert.equal(caps.length, 14);
  for (const c of caps) {
    assert.equal(c.installed, false, `${c.id} should read as not installed`);
    assert.equal(c.version, null);
    assert.equal(c.where, null);
    assert.ok(c.error && c.error.length, `${c.id} should explain why`);
  }
});

// ------------------------------------------------------------------ GitHub CLI: installed but not signed in
await check('gh installed but signed out is reported as installed, not configured, with a plain reason', async () => {
  invalidateCapabilities();
  const { run } = fakeRun([
    { match: (f, a) => f === 'gh' && a[0] === '--version', result: { ok: true, code: 0, output: 'gh version 2.40.0' } },
    { match: (f, a) => f === 'gh' && a[0] === 'auth' && a[1] === 'status', result: { ok: false, code: 1, output: 'You are not logged into any GitHub hosts.' } },
    { match: (f, a) => f === 'where', result: { ok: false, code: 1, output: 'INFO: Could not find files' } },
  ]);
  const caps = await getCapabilities({ run, force: true });
  const gh = caps.find((c) => c.id === 'gh');
  assert.equal(gh.installed, true);
  assert.equal(gh.configured, false);
  assert.match(gh.error, /not signed in/);
  // The raw `gh auth status` text (which can name an account) never reaches the result.
  assert.ok(!JSON.stringify(gh).includes('logged into'));
});

// ------------------------------------------------------------------ Python: python missing, py present
await check('Python falls back to the Windows launcher "py" when "python" is not on PATH', async () => {
  invalidateCapabilities();
  const { run } = fakeRun([
    { match: (f, a) => f === 'py' && a[0] === '--version', result: { ok: true, code: 0, output: 'Python 3.11.9' } },
  ]);
  const caps = await getCapabilities({ run, force: true });
  const python = caps.find((c) => c.id === 'python');
  assert.equal(python.installed, true);
  assert.equal(python.version, '3.11.9');
});

// ------------------------------------------------------------------ caching
await check('results are cached: a second call without force makes no new runs', async () => {
  invalidateCapabilities();
  const { run, calls } = fakeRun([versionFlag('git', 'git version 2.43.0')]);
  await getCapabilities({ run, force: true });
  const after1 = calls.length;
  await getCapabilities({ run });
  assert.equal(calls.length, after1, 'a cached read must not run any command again');
});

await check('force: true (or invalidateCapabilities first) probes again', async () => {
  invalidateCapabilities();
  const { run, calls } = fakeRun([versionFlag('git', 'git version 2.43.0')]);
  await getCapabilities({ run, force: true });
  const after1 = calls.length;
  await getCapabilities({ run, force: true });
  assert.ok(calls.length > after1, 'force: true must probe again, not reuse the cache');
});

await check('invalidateCapabilities() clears the cache for the very next call', async () => {
  const { run, calls } = fakeRun([versionFlag('git', 'git version 2.43.0')]);
  await getCapabilities({ run, force: true });
  invalidateCapabilities();
  const after1 = calls.length;
  await getCapabilities({ run });
  assert.ok(calls.length > after1, 'a call right after invalidateCapabilities() must not read the stale cache');
});

console.log(`capabilities-test: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
