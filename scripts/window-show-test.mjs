// JARVIS - the main window's "did it actually show?" safety net. main.mjs cannot be
// imported/driven outside Electron (see main-chat-ipc-test.mjs's own header for why this is a
// source-inspection test, not a behavioral one) - this file checks the shape of the fix for a
// real bug: 'ready-to-show' can fail to fire at all (a slow first paint, a GPU hiccup,
// antivirus scanning a freshly-installed exe), leaving a note-worthy window created but never
// shown - the tray icon and the process exist, but nothing a person can see. Previously the
// only retry for this lived entirely outside the app, in updaterCommand's PowerShell (see
// src/updates.mjs), and only ran after a self-update - an ordinary launch had no safety net
// at all.
//   node scripts/window-show-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${extra ? `\n     ${extra}` : ''}`); } };
const check = (name, fn) => { try { fn(); ok(true, name); } catch (e) { ok(false, name, String(e?.stack || e).slice(0, 400)); } };

const main = fs.readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8');

function createWindowBody() {
  const start = main.indexOf('function createWindow()');
  assert.ok(start >= 0, 'createWindow() exists');
  let depth = 0;
  const open = main.indexOf('{', start);
  for (let i = open; i < main.length; i += 1) {
    if (main[i] === '{') depth += 1;
    else if (main[i] === '}') { depth -= 1; if (depth === 0) return main.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces in createWindow()');
}

check('a watchdog exists that checks whether the window actually became visible, not just that ready-to-show fired', () => {
  const body = createWindowBody();
  assert.match(body, /setTimeout\(\(\) => \{/, 'a timeout-based check exists');
  assert.match(body, /win\.isVisible\(\)/, 'it checks real visibility, not an assumption');
});

check('the watchdog never fires during a capture (screenshot) run - capture already has its own off-screen showInactive() path', () => {
  const body = createWindowBody();
  const watchdog = body.slice(body.indexOf('Safety net:'));
  assert.match(watchdog, /if \(!capture\) \{\s*\n\s*setTimeout/, 'wrapped in the same !capture guard the rest of this function already uses');
});

check('the watchdog respects a deliberate hidden start (login/--hidden), UNLESS this is the post-update relaunch, which must always end up visible', () => {
  const body = createWindowBody();
  const watchdog = body.slice(body.indexOf('setTimeout(() => {', body.indexOf('Safety net:')));
  assert.match(watchdog, /if \(launchHidden && !process\.argv\.includes\('--updated'\)\) return;/, 'the exact same exception the immediate ready-to-show path already carries for --updated');
});

check('the watchdog does not run before the window is destroyed/gone, and does not re-run after the window is already visible', () => {
  const body = createWindowBody();
  const watchdog = body.slice(body.indexOf('setTimeout(() => {', body.indexOf('Safety net:')));
  assert.match(watchdog, /if \(!win \|\| win\.isDestroyed\(\) \|\| win\.isVisible\(\)\) return;/);
});

check('when it does fire, it uses the exact same show sequence (maximize once, then show, then focus, then mark shownOnce) as the normal path already does - no second, divergent way of showing the window', () => {
  const body = createWindowBody();
  const watchdog = body.slice(body.indexOf('setTimeout(() => {', body.indexOf('Safety net:')));
  assert.match(watchdog, /if \(!shownOnce\) win\.maximize\(\);/);
  assert.match(watchdog, /win\.show\(\);/);
  assert.match(watchdog, /win\.focus\(\);/);
  assert.match(watchdog, /shownOnce = true;/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
