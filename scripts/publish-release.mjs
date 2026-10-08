// Publish this version on GitHub: a release for its tag, with the installer attached, so the
// .exe can be downloaded from the repository's Releases page and Settings > Updates on any PC
// finds it. `npm run deliver` only reaches the JARVIS installed on this PC; this reaches the rest.
//
//   npm run dist                        build dist-installer\JARVIS-Setup-<version>.exe
//   git push origin main v<version>     the tag has to be on GitHub first
//   node scripts/publish-release.mjs    create the release and upload the installer
//
// Safe to run again: an existing release is reused, and an installer already attached at the
// same size is left alone. `--replace` swaps an attached installer of a different size.
//
// The token is the one Git Credential Manager already holds for github.com (`git credential
// fill`), as the rest of JARVIS uses. It is held in memory for this run, sent to GitHub only,
// and never printed, logged or written anywhere.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const tag = `v${version}`;
const name = `JARVIS-Setup-${version}.exe`;
const installer = path.join(root, 'dist-installer', name);
const replace = process.argv.includes('--replace');

const fail = (msg) => { console.error(msg); process.exit(1); };
const git = (args) => new Promise((resolve) => execFile('git', ['-C', root, ...args], { windowsHide: true, timeout: 30000 }, (err, out) => resolve(err ? '' : String(out).trim())));

if (!fs.existsSync(installer)) fail(`There is no installer for ${tag} yet. Run "npm run dist" first.`);
const size = fs.statSync(installer).size;

// Which repository, from the remote this folder pushes to.
const remote = await git(['remote', 'get-url', 'origin']);
const slug = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(remote);
if (!slug) fail(`The "origin" remote is not a GitHub repository: ${remote || '(none)'}`);
const repo = `${slug[1]}/${slug[2]}`;

// A release for a tag GitHub does not have would create the tag there, at whatever main is.
if (!(await git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`]))) fail(`The tag ${tag} is not on GitHub yet. Push it first: git push origin ${tag}`);

/** The github.com credential, from Git Credential Manager. Never shown. */
function credential() {
  return new Promise((resolve) => {
    const child = spawn('git', ['credential', 'fill'], { cwd: root, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => resolve(null));
    child.on('close', () => resolve((/^password=(.+)$/m.exec(out) || [])[1]?.trim() || null));
    child.stdin.end('protocol=https\nhost=github.com\n\n');
  });
}
const token = await credential();
if (!token) fail('No GitHub sign-in was found in Git Credential Manager. Push or fetch once from this folder to sign in, then run this again.');

const api = (url, opts = {}) => fetch(url, {
  ...opts,
  headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'jarvis-publish-release', ...(opts.headers || {}) },
});
/** GitHub's own words for a refusal - a status and its message, nothing of ours. */
async function why(res) {
  let message = '';
  try { message = (await res.json())?.message || ''; } catch { /* no body */ }
  return `GitHub answered ${res.status}${message ? `: ${message}` : ''}`;
}

// The notes: this version's "What's new" section of the README, as `npm run deliver` uses.
function whatsNew() {
  let readme;
  try { readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; }
  const start = readme.indexOf(`What's new in v${version}`);
  if (start < 0) return '';
  const from = readme.indexOf('\n', start) + 1;
  const ends = ['\n<details>', '\n## ', '\n---'].map((m) => readme.indexOf(m, from)).filter((i) => i >= 0);
  return readme.slice(from, ends.length ? Math.min(...ends) : undefined).trim();
}

// ------------------------------------------------------------------ the release
let res = await api(`https://api.github.com/repos/${repo}/releases/tags/${tag}`);
let release;
if (res.ok) {
  release = await res.json();
  console.log(`The release for ${tag} already exists.`);
} else if (res.status === 404) {
  res = await api(`https://api.github.com/repos/${repo}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name: `Update ${tag}`, body: whatsNew() || `JARVIS ${tag}`, draft: false, prerelease: false }),
  });
  if (!res.ok) fail(`The release could not be created. ${await why(res)}`);
  release = await res.json();
  console.log(`Created the release for ${tag}.`);
} else {
  fail(`Could not look for the release. ${await why(res)}`);
}

// ------------------------------------------------------------------ the installer
const had = (release.assets || []).find((a) => a.name === name);
if (had && had.size === size && had.state === 'uploaded') {
  console.log(`${name} is already attached (${(size / 1048576).toFixed(0)} MB).`);
} else {
  if (had) {
    if (!replace) fail(`${name} is already attached at a different size (${had.size} bytes there, ${size} here). Run again with --replace to swap it.`);
    res = await api(`https://api.github.com/repos/${repo}/releases/assets/${had.id}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) fail(`The old installer could not be removed. ${await why(res)}`);
  }
  console.log(`Uploading ${name} (${(size / 1048576).toFixed(0)} MB)…`);
  const upload = String(release.upload_url || '').replace(/\{.*$/, '');
  res = await api(`${upload}?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
    body: fs.readFileSync(installer),
  });
  if (!res.ok) fail(`The installer could not be uploaded. ${await why(res)}`);
}

// ------------------------------------------------------------------ look, do not assume
res = await api(`https://api.github.com/repos/${repo}/releases/tags/${tag}`);
if (!res.ok) fail(`The release could not be read back. ${await why(res)}`);
release = await res.json();
const asset = (release.assets || []).find((a) => a.name === name);
if (!asset || asset.state !== 'uploaded' || asset.size !== size) fail(`The installer is not on the release as it should be (found ${asset ? `${asset.state}, ${asset.size} bytes` : 'nothing'}).`);
res = await api(`https://api.github.com/repos/${repo}/releases/latest`);
const latest = res.ok ? (await res.json()).tag_name : null;

console.log(`Published ${tag}: ${release.html_url}`);
console.log(`  installer: ${asset.browser_download_url}`);
console.log(latest === tag ? '  It is the latest release, so Settings > Updates on other PCs will offer it.' : `  Note: GitHub's latest release is ${latest || 'unknown'}, not ${tag}.`);
