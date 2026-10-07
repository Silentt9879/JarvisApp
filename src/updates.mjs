// Updates for JARVIS itself and the two tools it works with (VS Code, Claude Code).
// Nothing here runs on its own: each step starts from a button in Settings > Updates.
// JARVIS has two sources: a release on GitHub, and an update built on this PC and handed
// over through a note in the data folder (see "an update delivered on this PC" below).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// The source repo is private, so JARVIS signs in to GitHub to read its releases.
export const JARVIS_REPO = 'Silentt9879/JarvisApp';
export const VSCODE_ID = 'Microsoft.VisualStudioCode';
export const CLAUDE_PKG = '@anthropic-ai/claude-code';
// The installer name electron-builder gives the release (see "artifactName" in package.json).
const INSTALLER = /^JARVIS-Setup-\d+\.\d+\.\d+\.exe$/i;
// Where the installer puts JARVIS for this user (perUser, productName JARVIS).
export const JARVIS_INSTALL_EXE = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'JARVIS', 'JARVIS.exe');

const MIN = 60_000;

/** Thrown when GitHub will not show JARVIS's releases to this sign-in. The window offers to connect. */
export class NeedsSignIn extends Error {
  constructor(message) {
    super(message);
    this.needsSignIn = true;
  }
}

/** "1.5.0" -> [1, 5, 0]; anything without a version gives null. */
export function parseVersion(s) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(s || ''));
  return m ? m.slice(1).map(Number) : null;
}

/** -1, 0 or 1. An unknown version compares as equal, so nothing is offered by mistake. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** The last part of a command's output - enough to show, never a wall of text. */
function tail(text, max = 1500) {
  const s = String(text || '').trim();
  return s.length > max ? `…${s.slice(-max)}` : s;
}

/**
 * Run a command and collect what it printed. `shell` lets Windows find the .cmd shims
 * (code.cmd, npm.cmd). Arguments here are fixed strings, never user input.
 */
export function runCommand(file, args, { timeoutMs = 2 * MIN, cwd } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    let out = '';
    let child;
    try {
      child = spawn(file, args, { shell: true, windowsHide: true, env, cwd });
    } catch (e) {
      resolve({ ok: false, code: null, output: e.message });
      return;
    }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, code: null, output: out + e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, output: out }); });
  });
}

// ------------------------------------------------------------------ VS Code

export async function vscodeStatus({ run = runCommand } = {}) {
  const local = await run('code', ['--version'], { timeoutMs: 30_000 });
  const installed = local.ok ? (local.output.match(/\d+\.\d+\.\d+/) || [])[0] || null : null;
  const shown = await run('winget', ['show', '--id', VSCODE_ID, '-e', '--accept-source-agreements'], { timeoutMs: MIN });
  const latest = shown.ok ? (/Version:\s*(\d+\.\d+\.\d+)/.exec(shown.output) || [])[1] || null : null;
  return {
    installed,
    latest,
    available: !!installed && compareVersions(latest, installed) > 0,
    // Not on this PC, or winget cannot see it: say so plainly and let the user decide.
    error: !installed ? 'Visual Studio Code is not installed on this PC.'
      : !latest ? 'Could not check for a newer version right now. Try again in a minute.' : null,
  };
}

export async function vscodeUpdate({ run = runCommand } = {}) {
  const r = await run('winget', [
    'upgrade', '--id', VSCODE_ID, '-e', '--silent',
    '--accept-package-agreements', '--accept-source-agreements',
  ], { timeoutMs: 20 * MIN });
  // winget exits with an error when there is nothing to upgrade - that is still "done".
  const nothingToDo = /No applicable update|No newer package|up to date/i.test(r.output);
  const ok = r.ok || nothingToDo;
  return { ok, upToDate: nothingToDo, output: tail(r.output), error: ok ? null : 'The update did not finish. Close VS Code and try again.' };
}

// ------------------------------------------------------------------ Claude Code

/**
 * The Claude Code command on this PC (if any), and the newest version on npm. JARVIS's own
 * sessions use the copy built into the app, which is updated with each JARVIS release; this
 * button is for the `claude` command you use in a terminal.
 */
export async function claudeStatus({ run = runCommand } = {}) {
  const local = await run('claude', ['--version'], { timeoutMs: 30_000 });
  const installed = local.ok ? (local.output.match(/\d+\.\d+\.\d+/) || [])[0] || null : null;
  const npm = await run('npm', ['view', CLAUDE_PKG, 'version'], { timeoutMs: MIN });
  const latest = npm.ok ? (npm.output.match(/\d+\.\d+\.\d+/) || [])[0] || null : null;
  return {
    installed,
    latest,
    // Missing counts as "available": pressing the button installs it.
    available: !installed || compareVersions(latest, installed) > 0,
    error: !latest ? 'Could not check for a newer version right now. Try again in a minute.' : null,
  };
}

export async function claudeUpdate({ run = runCommand } = {}) {
  const probe = await run('claude', ['--version'], { timeoutMs: 30_000 });
  // `claude update` for a Claude Code that is already here; otherwise install it from npm.
  const r = probe.ok
    ? await run('claude', ['update'], { timeoutMs: 10 * MIN })
    : await run('npm', ['install', '-g', `${CLAUDE_PKG}@latest`], { timeoutMs: 10 * MIN });
  return { ok: r.ok, output: tail(r.output), error: r.ok ? null : 'Claude Code did not update. Check your internet connection and try again.' };
}

// ------------------------------------------------------------------ GitHub sign-in

/** The GitHub token for JARVIS's releases: one saved in Settings, or the one Git already uses here. */
export async function resolveToken({ file, safe, spawnImpl } = {}) {
  const saved = loadToken(file, { safe });
  if (saved) return { token: saved, source: 'saved' };
  const fromGit = await gitCredentialToken({ spawnImpl });
  if (fromGit) return { token: fromGit, source: 'git' };
  return { token: null, source: null };
}

/** Ask Git's credential store for the github.com sign-in. Never prompts; gives null if there is none. */
export function gitCredentialToken({ spawnImpl = spawn, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      // Never a prompt: no terminal question, and no Git Credential Manager sign-in window from Settings.
      child = spawnImpl('git', ['credential', 'fill'], {
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => { child.kill(); resolve(null); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => { clearTimeout(timer); resolve(/^password=(.+)$/m.exec(out)?.[1]?.trim() || null); });
    child.stdin.end('protocol=https\nhost=github.com\n\n');
  });
}

/** Where a pasted token is kept: encrypted by Windows for this user, never plain text. */
export function savedTokenPath(userDir) {
  return path.join(userDir, 'github-token.bin');
}

export function saveToken(file, token, { safe }) {
  if (!safe?.isEncryptionAvailable?.()) throw new Error('This PC cannot keep the token safely, so it was not saved.');
  fs.writeFileSync(file, safe.encryptString(String(token).trim()));
}

export function loadToken(file, { safe }) {
  try {
    if (!fs.existsSync(file) || !safe?.isEncryptionAvailable?.()) return null;
    return safe.decryptString(fs.readFileSync(file)) || null;
  } catch {
    return null;
  }
}

export function clearToken(file) {
  fs.rmSync(file, { force: true });
}

function ghHeaders(token, accept = 'application/vnd.github+json') {
  const h = { Accept: accept, 'User-Agent': 'JARVIS-app' };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/** Does this token open the JARVIS repo at all? Used before a token is saved. */
export async function tokenCanSeeJarvis({ fetchImpl = fetch, repo = JARVIS_REPO, token } = {}) {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}`, {
    headers: ghHeaders(token),
    signal: AbortSignal.timeout(20_000),
  });
  return res.ok;
}

// ------------------------------------------------------------------ an update delivered on this PC
//
// A build made on this PC does not need GitHub to reach the JARVIS installed beside it.
// `npm run deliver` leaves a small note in the app's data folder naming the installer, its
// size and its SHA-256; JARVIS reads that one local file, so it can offer the update without
// a sign-in, a release or any network. Other PCs still update from the GitHub release.

export const DELIVERY_FILE = 'update-ready.json';

export function deliveryPath(userDir) {
  return path.join(userDir, DELIVERY_FILE);
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    fs.createReadStream(file).on('data', (d) => hash.update(d)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

/** "JARVIS-Setup-1.9.0.exe" for version "1.9.0", and nothing else. */
const installerFor = (file, version) => INSTALLER.test(path.basename(file)) && path.basename(file).includes(`-${version}.`);

/**
 * Leave the note for an installer that was just built. Written through a temp file and a
 * rename, so JARVIS never reads half a note. Returns what was written.
 */
export async function writeDelivery(userDir, { version, installer, notes = '' } = {}) {
  const v = (parseVersion(version) || []).join('.');
  const file = path.resolve(String(installer || ''));
  if (!v) throw new Error('The update has no version number.');
  if (!installerFor(file, v)) throw new Error(`The installer must be named JARVIS-Setup-${v}.exe.`);
  const size = fs.statSync(file).size;
  const note = { version: v, installer: file, size, sha256: await sha256File(file), notes: String(notes || '').trim(), deliveredAt: new Date().toISOString() };
  fs.mkdirSync(userDir, { recursive: true });
  const tmp = `${deliveryPath(userDir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(note, null, 2)}\n`);
  fs.renameSync(tmp, deliveryPath(userDir));
  return note;
}

/**
 * The update delivered on this PC, or null. Only an installer that is really there, under
 * its release name, at the size the note states and with a SHA-256 to check it against,
 * counts - anything else reads as "nothing delivered".
 */
export function readDelivery(userDir) {
  let j;
  try { j = JSON.parse(fs.readFileSync(deliveryPath(userDir), 'utf8')); } catch { return null; }
  const version = (parseVersion(j?.version) || []).join('.');
  const file = typeof j?.installer === 'string' ? j.installer : '';
  const sha = /^[0-9a-f]{64}$/i.test(j?.sha256 || '') ? j.sha256.toLowerCase() : null;
  if (!version || !sha || !path.isAbsolute(file) || !installerFor(file, version)) return null;
  let size;
  try { size = fs.statSync(file).size; } catch { return null; }
  if (!size || size !== Number(j.size)) return null;
  return { version, notes: String(j.notes || '').trim(), installer: { name: path.basename(file), path: file, size, sha256: sha } };
}

/** The note has done its job once that version is running. */
export function clearDelivery(userDir) {
  fs.rmSync(deliveryPath(userDir), { force: true });
}

/** The delivered update, only when it is newer than the version that is running. */
export function newerDelivery(userDir, current) {
  const d = userDir ? readDelivery(userDir) : null;
  return d && compareVersions(d.version, current) > 0 ? d : null;
}

// ------------------------------------------------------------------ JARVIS

/**
 * The newest published release, or { release: null } when the repo has none yet.
 * A private repo answers 404 to anyone who is not signed in, so that means "connect first".
 */
export async function latestJarvisRelease({ fetchImpl = fetch, repo = JARVIS_REPO, token = null } = {}) {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: ghHeaders(token),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404 || res.status === 401) {
    if (!(await tokenCanSeeJarvis({ fetchImpl, repo, token }).catch(() => false))) {
      throw new NeedsSignIn(token
        ? 'GitHub did not accept this sign-in for JARVIS. Connect again with a token that can read JarvisApp.'
        : 'Connect your GitHub account once, so JARVIS can check for updates.');
    }
    return { release: null };
  }
  if (!res.ok) throw new Error(`GitHub answered ${res.status}. Try again later.`);
  const j = await res.json();
  const asset = (j.assets || []).find((a) => INSTALLER.test(a.name));
  const sha = /^sha256:([0-9a-f]{64})$/i.exec(asset?.digest || '');
  return {
    release: {
      version: (/\d+\.\d+\.\d+/.exec(j.tag_name || '') || [])[0] || null,
      notes: String(j.body || '').trim(),
      installer: asset ? { name: asset.name, apiUrl: asset.url, size: asset.size, sha256: sha ? sha[1].toLowerCase() : null } : null,
    },
  };
}

export async function jarvisStatus(current, deps = {}) {
  // An update delivered on this PC is offered as it is: GitHub is not asked, so there is
  // nothing to sign in to and nothing to wait for.
  const local = newerDelivery(deps.userDir, current);
  if (local) return { current, latest: local.version, available: true, notes: local.notes, source: 'local', error: null };
  const { release } = await latestJarvisRelease(deps);
  if (!release) return { current, latest: null, available: false, notes: '', error: null };
  if (!release.installer) return { current, latest: release.version, available: false, notes: '', error: 'The newest release has no installer yet.' };
  return {
    current,
    latest: release.version,
    available: compareVersions(release.version, current) > 0,
    notes: release.notes,
    error: null,
  };
}

/**
 * Download the installer to `dest` through GitHub's API (the only route that works for a
 * private repo), checking it against the release's SHA-256 when there is one. A file that
 * does not match is deleted, never run.
 */
export async function downloadInstaller(installer, dest, { fetchImpl = fetch, onProgress, token = null } = {}) {
  const res = await fetchImpl(installer.apiUrl, {
    headers: ghHeaders(token, 'application/octet-stream'),
    signal: AbortSignal.timeout(30 * MIN),
  });
  if (!res.ok || !res.body) throw new Error(`The download did not start (${res.status}). Try again.`);
  const total = Number(res.headers.get('content-length')) || installer.size || 0;
  return saveChecked(Readable.fromWeb(res.body), installer, dest, {
    onProgress, total, mismatch: 'The download was incomplete or changed, so it was thrown away. Press Update again.',
  });
}

/**
 * Copy the installer delivered on this PC to `dest`, checking it against the note's size
 * and SHA-256 on the way. What runs is the checked copy, so a build that is replaced while
 * JARVIS installs cannot change what is installed.
 */
export async function copyInstaller(installer, dest, { onProgress } = {}) {
  return saveChecked(fs.createReadStream(installer.path), installer, dest, {
    onProgress, total: installer.size, mismatch: 'The update on this PC changed after it was delivered, so it was not installed. Deliver it again.',
  });
}

/** Write `source` to `dest`, counting and hashing every byte. A file that does not match is deleted, never run. */
async function saveChecked(source, installer, dest, { onProgress, total, mismatch }) {
  const hash = createHash('sha256');
  let got = 0;
  const tap = async function* (chunks) {
    for await (const chunk of chunks) {
      got += chunk.length;
      hash.update(chunk);
      onProgress?.({ received: got, total });
      yield chunk;
    }
  };
  try {
    await pipeline(source, tap, fs.createWriteStream(dest));
    const sizeOk = !installer.size || got === installer.size;
    const hashOk = !installer.sha256 || hash.digest('hex') === installer.sha256;
    if (!sizeOk || !hashOk) throw new Error(mismatch);
  } catch (e) {
    fs.rmSync(dest, { force: true });
    throw e;
  }
  return dest;
}

/**
 * The PowerShell that installs the update after JARVIS has closed, then opens it again.
 * Passed encoded, so no path needs quoting. The log sits beside the app's own log.
 */
export function updaterCommand({ installerPath, waitPid, relaunchExe, logPath, installDir = path.dirname(JARVIS_INSTALL_EXE) + path.sep }) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  return [
    `function Log($m) { "$(Get-Date -Format s) $m" | Out-File -Append -Encoding utf8 ${q(logPath)} }`,
    `Log 'update: waiting for JARVIS to close'`,
    `try { Wait-Process -Id ${Number(waitPid)} -Timeout 60 -ErrorAction Stop } catch { Log 'update: JARVIS is closed (or did not close in time), installing' }`,
    `Start-Sleep -Seconds 2`,
    // Safety net: anything still running from the install folder (the agent's claude.exe, say)
    // would lock its files, so close it first. Trailing separator, so "JARVIS2" is not matched.
    `$dir = ${q(installDir)}`,
    `for ($i = 0; $i -lt 20; $i++) { $left = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase) }); if ($left.Count -eq 0) { break }; $left | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }`,
    `Log 'update: nothing left running from the install folder'`,
    `Log 'update: installing'`,
    `$p = Start-Process -FilePath ${q(installerPath)} -ArgumentList '/S' -Wait -PassThru`,
    `Log "update: installer finished (exit $($p.ExitCode))"`,
    `Start-Sleep -Seconds 1`,
    // Open JARVIS again, and check that a JARVIS process really appears (a start that fails
    // silently is the thing this guards against). Up to three tries, then Explorer starts it.
    `$exe = ${q(relaunchExe)}`,
    `if (-not (Test-Path $exe)) { Log 'update: could not find JARVIS to open again' }`,
    `else {`,
    `  $up = $false`,
    `  for ($try = 1; $try -le 3 -and -not $up; $try++) {`,
    `    try { Start-Process -FilePath $exe -ArgumentList '--updated' -WorkingDirectory (Split-Path -Parent $exe) -ErrorAction Stop | Out-Null } catch { Log "update: start attempt $try failed: $($_.Exception.Message)" }`,
    `    for ($i = 0; $i -lt 15 -and -not $up; $i++) { Start-Sleep -Milliseconds 1000; if (Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }) { $up = $true } }`,
    `  }`,
    `  if ($up) { Log 'update: JARVIS opened again' } else { Log 'update: JARVIS did not start itself; asking Explorer to open it'; Start-Process -FilePath 'explorer.exe' -ArgumentList $exe | Out-Null }`,
    // The window must come up too, not just the tray icon. If none is showing after a while, start
    // JARVIS once more: a second start only brings the running window forward (single-instance).
    `  $shown = $false`,
    `  for ($i = 0; $i -lt 20 -and -not $shown; $i++) { Start-Sleep -Milliseconds 1000; if (Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe -and $_.MainWindowHandle -ne 0 }) { $shown = $true } }`,
    `  if ($shown) { Log 'update: JARVIS window is showing' } else { Log 'update: no window yet; starting JARVIS again to bring it forward'; Start-Process -FilePath $exe -ArgumentList '--updated' -WorkingDirectory (Split-Path -Parent $exe) | Out-Null }`,
    `}`,
  ].join('\n');
}

/**
 * Start the updater so it outlives JARVIS. A PowerShell started straight from JARVIS dies the
 * moment JARVIS quits (tested on this PC: the installer never ran, so nothing came back). So a
 * short launcher asks Windows, through WMI, to start the updater - a process Windows owns, not
 * JARVIS. JARVIS quits only after this resolves. Resolves { ok, error }.
 */
export function launchUpdater(script, { spawnImpl = spawn, timeoutMs = 20_000 } = {}) {
  const inner = Buffer.from(script, 'utf16le').toString('base64');
  const create = "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "
    + `'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ${inner}' } `
    + '| ForEach-Object { if ($_.ReturnValue -ne 0) { exit 1 } }';
  const launcher = Buffer.from(create, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', launcher], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (e) {
      resolve({ ok: false, error: e.message });
      return;
    }
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, error: 'Windows took too long to start the installer.' }); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true } : { ok: false, error: 'Windows did not start the installer.' });
    });
  });
}

/**
 * The whole JARVIS update: check, fetch (a copy from this PC, or a download), verify, then
 * hand over to the updater. The caller quits JARVIS after this returns, so the installer
 * can replace the files.
 */
export async function jarvisUpdate({ currentVersion, tempDir, pid, logPath, onProgress, token = null, fetchImpl, spawnImpl, userDir = null } = {}) {
  // The update delivered on this PC, when there is one; otherwise the release on GitHub.
  const local = newerDelivery(userDir, currentVersion);
  let release = local;
  let dest;
  if (local) {
    dest = path.join(tempDir, local.installer.name);
    await copyInstaller(local.installer, dest, { onProgress });
  } else {
    ({ release } = await latestJarvisRelease({ fetchImpl, token }));
    if (!release?.installer) return { ok: false, error: 'There is no update to install yet.' };
    if (compareVersions(release.version, currentVersion) <= 0) return { ok: true, upToDate: true };
    dest = path.join(tempDir, release.installer.name);
    await downloadInstaller(release.installer, dest, { fetchImpl, onProgress, token });
  }
  const started = await launchUpdater(updaterCommand({
    installerPath: dest,
    waitPid: pid,
    relaunchExe: JARVIS_INSTALL_EXE,
    logPath,
  }), { spawnImpl });
  // Only a confirmed start lets JARVIS quit; otherwise it stays open and says what happened.
  if (!started.ok) return { ok: false, error: `The update is ready, but it could not be started (${started.error}). JARVIS is still open. Press Update again.` };
  return { ok: true, version: release.version, notes: release.notes, source: local ? 'local' : 'github' };
}
