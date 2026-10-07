// Hand the installer that was just built to the JARVIS installed on this PC.
//   npm run dist      build dist-installer\JARVIS-Setup-<version>.exe
//   npm run deliver   tell JARVIS it is there
//
// It leaves a note in the app's data folder (src/updates.mjs, "an update delivered on this
// PC"). A running JARVIS shows "Update to v<version>" in its top bar within a second; a
// closed one shows it when it opens. Nothing is installed here - that takes the button.
//
// Pressing that button closes JARVIS and every session it runs, so deliver LAST: after the
// commit and the push, when nothing else is waiting on this session.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeDelivery, deliveryPath } from '../src/updates.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const installer = path.join(root, 'dist-installer', `JARVIS-Setup-${version}.exe`);
// Where the installed JARVIS keeps its data (JARVIS_USERDATA points a test run elsewhere).
const userDir = process.env.JARVIS_USERDATA || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'JARVIS');
const force = process.argv.includes('--force');

const fail = (msg) => { console.error(msg); process.exit(1); };

if (!fs.existsSync(installer)) fail(`There is no installer for v${version} yet. Run "npm run dist" first.`);

// An installer older than the source would deliver yesterday's code under today's number.
function newestSource() {
  let newest = { at: fs.statSync(path.join(root, 'package.json')).mtimeMs, file: 'package.json' };
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else { const at = fs.statSync(full).mtimeMs; if (at > newest.at) newest = { at, file: path.relative(root, full) }; }
    }
  };
  walk(path.join(root, 'src'));
  return newest;
}
const src = newestSource();
if (src.at > fs.statSync(installer).mtimeMs && !force) {
  fail(`The installer is older than the source (${src.file} changed after it was built). Run "npm run dist" again, or pass --force.`);
}

// The release notes: this version's "What's new" section of the README, when there is one.
function whatsNew() {
  let readme;
  try { readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; }
  const start = readme.indexOf(`What's new in v${version}`);
  if (start < 0) return '';
  const from = readme.indexOf('\n', start) + 1;
  const ends = ['\n<details>', '\n## ', '\n---'].map((m) => readme.indexOf(m, from)).filter((i) => i >= 0);
  return readme.slice(from, ends.length ? Math.min(...ends) : undefined).trim();
}

const notes = whatsNew();
const note = await writeDelivery(userDir, { version, installer, notes });
console.log(`Delivered JARVIS v${note.version} (${(note.size / 1048576).toFixed(0)} MB, sha256 ${note.sha256.slice(0, 12)}…)`);
console.log(`  note:  ${deliveryPath(userDir)}`);
console.log(`  notes: ${notes ? `${notes.split('\n').length} lines from the README` : 'none - the README has no "What\'s new" section for this version'}`);
console.log(`A JARVIS on this PC older than v${note.version} now shows "Update to v${note.version}" in its top bar.`);
