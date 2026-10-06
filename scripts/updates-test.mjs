// Unit test for the update checks and installs (src/updates.mjs). Commands, GitHub, the
// download and the token store are faked, so nothing is installed or downloaded here.
//   node scripts/updates-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  compareVersions, parseVersion, vscodeStatus, vscodeUpdate, claudeStatus, claudeUpdate,
  latestJarvisRelease, jarvisStatus, downloadInstaller, updaterCommand, launchUpdater, jarvisUpdate,
  NeedsSignIn, saveToken, loadToken, clearToken, resolveToken, gitCredentialToken,
} from '../src/updates.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

// A fake command runner: answers by "file + first argument", and records what was asked.
function fakeRun(answers) {
  const calls = [];
  const run = async (file, args) => {
    const key = `${file} ${args[0]}`;
    calls.push(key);
    return answers[key] || { ok: false, code: 1, output: 'not found' };
  };
  return { run, calls };
}

const jsonResponse = (status, body) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const SHA_OF = (buf) => createHash('sha256').update(buf).digest('hex');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-updates-test-'));
// Stands in for Electron's safeStorage: "encrypts" by reversing bytes.
const fakeSafe = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s).reverse(), decryptString: (b) => Buffer.from(b).reverse().toString() };

// ------------------------------------------------------------------ versions
ok(compareVersions('1.6.0', '1.5.0') === 1, 'newer minor is newer');
ok(compareVersions('1.5.9', '1.10.0') === -1, '1.10.0 beats 1.5.9 (numbers, not text)');
ok(compareVersions('v2.0.0', '2.0.0') === 0, 'a leading v is ignored');
ok(compareVersions(null, '1.0.0') === 0, 'an unknown version is never offered as an update');
ok(JSON.stringify(parseVersion('Claude Code 2.1.4 (build)')) === '[2,1,4]', 'a version is found inside a sentence');

// ------------------------------------------------------------------ VS Code
{
  const { run } = fakeRun({
    'code --version': { ok: true, output: '1.140.0\nabc123\nx64' },
    'winget show': { ok: true, output: 'Found Microsoft Visual Studio Code\nVersion: 1.141.0\n' },
  });
  const s = await vscodeStatus({ run });
  ok(s.installed === '1.140.0' && s.latest === '1.141.0' && s.available === true, 'VS Code: newer version is offered');
}
{
  const { run } = fakeRun({
    'code --version': { ok: true, output: '1.140.0' },
    'winget show': { ok: true, output: 'Version: 1.140.0' },
  });
  const s = await vscodeStatus({ run });
  ok(s.available === false && s.error === null, 'VS Code: same version is up to date');
}
{
  const { run } = fakeRun({ 'code --version': { ok: false, output: '' }, 'winget show': { ok: true, output: 'Version: 1.141.0' } });
  const s = await vscodeStatus({ run });
  ok(s.installed === null && /not installed/.test(s.error), 'VS Code: a missing install is said plainly');
}
{
  const { run } = fakeRun({ 'winget upgrade': { ok: false, code: 1, output: 'No applicable update found.' } });
  const u = await vscodeUpdate({ run });
  ok(u.ok === true && u.upToDate === true, 'VS Code: "no applicable update" counts as done');
}
{
  const { run } = fakeRun({ 'winget upgrade': { ok: false, code: 1, output: 'boom' } });
  const u = await vscodeUpdate({ run });
  ok(u.ok === false && /did not finish/.test(u.error), 'VS Code: a failed update gives a plain message');
}

// ------------------------------------------------------------------ Claude Code
{
  const { run } = fakeRun({
    'claude --version': { ok: false, output: 'not recognized' },
    'npm view': { ok: true, output: '2.1.4\n' },
  });
  const s = await claudeStatus({ run });
  ok(s.installed === null && s.latest === '2.1.4' && s.available === true, 'Claude Code: a missing command is offered as an install');
}
{
  const { run } = fakeRun({
    'claude --version': { ok: true, output: '2.0.9 (Claude Code)' },
    'npm view': { ok: true, output: '2.1.4' },
  });
  const s = await claudeStatus({ run });
  ok(s.installed === '2.0.9' && s.available === true, 'Claude Code: an older command is offered an update');
}
{
  const { run, calls } = fakeRun({
    'claude --version': { ok: true, output: '2.1.4' },
    'claude update': { ok: true, output: 'updated' },
  });
  const u = await claudeUpdate({ run });
  ok(u.ok && calls.includes('claude update'), 'Claude Code: uses "claude update" when the command exists');
}
{
  const { run, calls } = fakeRun({ 'npm install': { ok: true, output: 'added 1 package' } });
  const u = await claudeUpdate({ run });
  ok(u.ok && calls.includes('npm install'), 'Claude Code: installs from npm when there is no command');
}

// ------------------------------------------------------------------ JARVIS release lookup
const SHA = 'ab'.repeat(32);
{
  // The repo answers, but has no release yet: not an error.
  const fetchImpl = async (url) => (String(url).endsWith('/releases/latest') ? jsonResponse(404) : jsonResponse(200, { name: 'JarvisApp' }));
  const r = await latestJarvisRelease({ fetchImpl, token: 'x' });
  ok(r.release === null, 'a repo with no release yet is not an error');
}
{
  // Private repo, not signed in: GitHub says 404 for everything, so JARVIS asks to connect.
  let msg = null;
  try { await latestJarvisRelease({ fetchImpl: async () => jsonResponse(404) }); } catch (e) { msg = e; }
  ok(msg instanceof NeedsSignIn && msg.needsSignIn === true, 'not signed in: JARVIS asks to connect instead of failing');
}
{
  let msg = null;
  try { await latestJarvisRelease({ fetchImpl: async () => jsonResponse(404), token: 'bad' }); } catch (e) { msg = e; }
  ok(msg instanceof NeedsSignIn && /Connect again/.test(msg.message), 'a token that cannot read JarvisApp asks to connect again');
}
{
  let threw = false;
  try { await latestJarvisRelease({ fetchImpl: async () => jsonResponse(500) }); } catch (e) { threw = /500/.test(e.message); }
  ok(threw, 'a GitHub server error is thrown with its status');
}
{
  const body = {
    tag_name: 'v1.6.0',
    body: 'Faster updates',
    assets: [
      { name: 'JARVIS-1.6.0.zip', url: 'x', size: 1 },
      { name: 'JARVIS-Setup-1.6.0.exe', url: 'https://api.test/assets/9', size: 42, digest: `sha256:${SHA}` },
    ],
  };
  const r = await latestJarvisRelease({ fetchImpl: async () => jsonResponse(200, body), token: 't' });
  ok(r.release.version === '1.6.0' && r.release.installer.name === 'JARVIS-Setup-1.6.0.exe', 'the setup .exe is picked, not the zip');
  ok(r.release.installer.sha256 === SHA && r.release.installer.size === 42 && r.release.installer.apiUrl === 'https://api.test/assets/9', 'digest, size and API download address come from the release');
}
{
  // The token is sent to GitHub, and never to anywhere else.
  let auth = null;
  await latestJarvisRelease({ fetchImpl: async (url, o) => { auth = o.headers.Authorization; return jsonResponse(200, { tag_name: 'v1.0.0', assets: [] }); }, token: 'secret' });
  ok(auth === 'Bearer secret', 'the release lookup is signed with the token');
}

// ------------------------------------------------------------------ JARVIS status
{
  const body = { tag_name: 'v1.6.0', body: '', assets: [{ name: 'JARVIS-Setup-1.6.0.exe', url: 'u', size: 1 }] };
  const f = async () => jsonResponse(200, body);
  const s = await jarvisStatus('1.5.0', { fetchImpl: f, token: 't' });
  ok(s.available === true && s.latest === '1.6.0', 'JARVIS: a newer release is offered');
  const same = await jarvisStatus('1.6.0', { fetchImpl: f, token: 't' });
  ok(same.available === false, 'JARVIS: the same version is not offered');
  const noExe = await jarvisStatus('1.5.0', { fetchImpl: async () => jsonResponse(200, { tag_name: 'v1.6.0', assets: [] }), token: 't' });
  ok(noExe.available === false && /no installer/.test(noExe.error), 'JARVIS: a release without the .exe says so');
  let needs = false;
  try { await jarvisStatus('1.5.0', { fetchImpl: async () => jsonResponse(404) }); } catch (e) { needs = e.needsSignIn === true; }
  ok(needs, 'JARVIS: not signed in is reported as needing sign-in');
}

// ------------------------------------------------------------------ download and check
{
  const data = Buffer.from('pretend this is an installer');
  const installer = { name: 'JARVIS-Setup-1.6.0.exe', apiUrl: 'https://api.test/assets/1', size: data.length, sha256: SHA_OF(data) };
  const dest = path.join(tmp, 'good.exe');
  const seen = [];
  let sent = null;
  await downloadInstaller(installer, dest, {
    token: 'secret',
    fetchImpl: async (url, o) => { sent = { url, accept: o.headers.Accept, auth: o.headers.Authorization }; return new Response(data, { status: 200, headers: { 'content-length': String(data.length) } }); },
    onProgress: (p) => seen.push(p.received),
  });
  ok(fs.existsSync(dest) && fs.readFileSync(dest).equals(data), 'a matching download is saved as it is');
  ok(seen.length > 0 && seen.at(-1) === data.length, 'progress reports the bytes received');
  ok(sent.url === installer.apiUrl && sent.accept === 'application/octet-stream' && sent.auth === 'Bearer secret', 'the download goes through the API with the token');
}
{
  const data = Buffer.from('tampered');
  const installer = { name: 'JARVIS-Setup-1.6.0.exe', apiUrl: 'u', size: data.length, sha256: SHA };
  const dest = path.join(tmp, 'bad.exe');
  let msg = '';
  try { await downloadInstaller(installer, dest, { fetchImpl: async () => new Response(data, { status: 200 }) }); } catch (e) { msg = e.message; }
  ok(/thrown away/.test(msg), 'a download that does not match the release is refused');
  ok(!fs.existsSync(dest), 'and the bad file is deleted, never run');
}
{
  const dest = path.join(tmp, 'short.exe');
  let msg = '';
  try { await downloadInstaller({ name: 'x', apiUrl: 'u', size: 999, sha256: null }, dest, { fetchImpl: async () => new Response(Buffer.from('abc'), { status: 200 }) }); } catch (e) { msg = e.message; }
  ok(/incomplete/.test(msg) && !fs.existsSync(dest), 'a short download is refused and removed');
}

// ------------------------------------------------------------------ the updater script
{
  const script = updaterCommand({ installerPath: "C:\\Temp\\it's.exe", waitPid: 4321, relaunchExe: 'C:\\JARVIS.exe', logPath: 'C:\\log.txt' });
  ok(script.includes('-Id 4321'), 'the updater waits for this JARVIS process');
  ok(script.includes("'C:\\Temp\\it''s.exe'"), 'an apostrophe in the path is escaped, not a broken command');
  ok(script.includes("-ArgumentList '/S'"), 'the installer runs silently');
  ok(script.includes("'--updated'"), 'JARVIS opens again with --updated, so it announces the update');
}
{
  let args = null;
  const fakeSpawn = (file, a) => { args = { file, a }; return { unref() {} }; };
  launchUpdater('Write-Output hi', { spawnImpl: fakeSpawn });
  const decoded = Buffer.from(args.a.at(-1), 'base64').toString('utf16le');
  ok(args.file === 'powershell.exe' && args.a.includes('-EncodedCommand') && decoded === 'Write-Output hi', 'the updater is passed encoded and starts detached');
}

// ------------------------------------------------------------------ the whole JARVIS update
{
  const data = Buffer.from('installer bytes');
  const body = { tag_name: 'v1.6.0', body: '', assets: [{ name: 'JARVIS-Setup-1.6.0.exe', url: 'https://api.test/assets/2', size: data.length, digest: `sha256:${SHA_OF(data)}` }] };
  let spawned = null;
  const r = await jarvisUpdate({
    currentVersion: '1.5.0', tempDir: tmp, pid: 99, logPath: path.join(tmp, 'log.txt'), token: 't',
    fetchImpl: async (url) => (String(url).includes('api.github.com/repos') && String(url).endsWith('/latest') ? jsonResponse(200, body) : new Response(data, { status: 200 })),
    spawnImpl: (f, a) => { spawned = a; return { unref() {} }; },
  });
  ok(r.ok && r.version === '1.6.0' && spawned, 'JARVIS update: downloads, then hands over to the updater');
  ok(fs.existsSync(path.join(tmp, 'JARVIS-Setup-1.6.0.exe')), 'JARVIS update: the installer is in the temp folder');
}
{
  let spawned = false;
  const body = { tag_name: 'v1.5.0', assets: [{ name: 'JARVIS-Setup-1.5.0.exe', url: 'u', size: 1 }] };
  const r = await jarvisUpdate({
    currentVersion: '1.5.0', tempDir: tmp, pid: 1, logPath: 'x',
    fetchImpl: async () => jsonResponse(200, body),
    spawnImpl: () => { spawned = true; return { unref() {} }; },
  });
  ok(r.ok && r.upToDate && !spawned, 'JARVIS update: already on the newest version does nothing');
}

// ------------------------------------------------------------------ sign-in storage
{
  const file = path.join(tmp, 'github-token.bin');
  saveToken(file, '  ghp_example  ', { safe: fakeSafe });
  ok(!fs.readFileSync(file).toString().includes('ghp_example'), 'the saved token is not readable as plain text on disk');
  ok(loadToken(file, { safe: fakeSafe }) === 'ghp_example', 'a saved token reads back trimmed');
  clearToken(file);
  ok(loadToken(file, { safe: fakeSafe }) === null, 'a cleared token is gone');
  let refused = false;
  try { saveToken(file, 'x', { safe: { isEncryptionAvailable: () => false } }); } catch { refused = true; }
  ok(refused && !fs.existsSync(file), 'without OS encryption the token is refused, never saved in plain text');
}
{
  const file = path.join(tmp, 'none.bin');
  const got = await resolveToken({ file, safe: fakeSafe, spawnImpl: () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stdin = { end() {} }; c.kill = () => {}; setImmediate(() => c.emit('close', 1)); return c; } });
  ok(got.token === null && got.source === null, 'no saved token and no Git sign-in: nothing is guessed');
  saveToken(file, 'saved-one', { safe: fakeSafe });
  const first = await resolveToken({ file, safe: fakeSafe, spawnImpl: () => { throw new Error('should not ask git'); } });
  ok(first.token === 'saved-one' && first.source === 'saved', 'a saved token is used first');
  clearToken(file);
}
{
  // Git's credential store answers with a password line; that becomes the token.
  const fakeGit = () => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter();
    c.stdin = { end() { setImmediate(() => { c.stdout.emit('data', 'protocol=https\nhost=github.com\nusername=x\npassword=gho_fromgit\n'); c.emit('close', 0); }); } };
    c.kill = () => {};
    return c;
  };
  ok(await gitCredentialToken({ spawnImpl: fakeGit }) === 'gho_fromgit', 'the Git sign-in for github.com is picked up silently');
  const got = await resolveToken({ file: path.join(tmp, 'absent.bin'), safe: fakeSafe, spawnImpl: fakeGit });
  ok(got.token === 'gho_fromgit' && got.source === 'git', 'with no saved token, the Git sign-in is used');
}
{
  // Settings must never open a Git sign-in window or ask a question in a terminal.
  let env = null;
  const spy = (file, args, opts) => { env = opts.env; const c = fakeGit(); return c; };
  function fakeGit() {
    const c = new EventEmitter();
    c.stdout = new EventEmitter();
    c.stdin = { end() { setImmediate(() => c.emit('close', 1)); } };
    c.kill = () => {};
    return c;
  }
  await gitCredentialToken({ spawnImpl: spy });
  ok(env?.GCM_INTERACTIVE === 'never' && env?.GIT_TERMINAL_PROMPT === '0', 'Git is told never to prompt (no sign-in window from Settings)');
}
{
  // The updater closes anything still running from the install folder first, so a leftover
  // process cannot lock the files the installer has to replace.
  const script = updaterCommand({ installerPath: 'C:\\x\\setup.exe', waitPid: 1, relaunchExe: 'C:\\JARVIS.exe', logPath: 'C:\\l.txt', installDir: 'C:\\Users\\me\\Programs\\JARVIS\\' });
  ok(script.includes("$dir = 'C:\\Users\\me\\Programs\\JARVIS\\'"), 'the install folder (with its trailing slash) is named');
  ok(script.includes('Stop-Process -Force') && script.includes('StringComparison]::OrdinalIgnoreCase'), 'anything running from that folder is stopped');
  ok(script.indexOf('Stop-Process') < script.indexOf("-ArgumentList '/S'"), 'the stop happens before the installer runs');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`updates-test: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
