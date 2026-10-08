// Behavioral regression test for the secondary-chat power-down bug: before closePanes()
// existed, nothing closed a pane's JarvisSession or its window when JARVIS powered down -
// only the main window and its own session were touched. A secondary chat kept running,
// possibly mid-turn, spending API tokens and able to leave an unanswered permission request,
// for as long as JARVIS reported itself asleep.
//
// closePanes() (src/pane-windows.mjs) is the one place both are stopped together; this test
// drives it directly with fake sessions/windows (no Electron, no real JarvisSession, no API
// token spent) and separately confirms, by reading main.mjs, that BOTH powerDown() and
// shutdownChildren() actually call it - the wiring is what main.mjs alone can prove, since it
// cannot be imported and driven outside Electron.
//   node scripts/pane-windows-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { closePanes } from '../src/pane-windows.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${extra ? `\n     ${extra}` : ''}`); } };
const check = (name, fn) => { try { fn(); ok(true, name); } catch (e) { ok(false, name, String(e.stack || e).slice(0, 400)); } };

function fakeSession() { const s = { closed: 0 }; s.close = () => { s.closed += 1; }; return s; }
function fakeWindow() { const w = { destroyed: false, destroyCalls: 0 }; w.isDestroyed = () => w.destroyed; w.destroy = () => { w.destroyCalls += 1; w.destroyed = true; }; return w; }

// ------------------------------------------------------------------ the original bug, made concrete
check('the bug this fixes: before closePanes(), nothing stopped a pane at all - demonstrated by NOT calling it', () => {
  const sessions = new Map([['p1', fakeSession()]]);
  const windows = new Map([['p1', fakeWindow()]]);
  // This is what powerDown() used to do: close the main session, stop web apps/devices -
  // and nothing else. A pane's session and window are simply never reached.
  // (No call to closePanes here - that is the point.)
  assert.equal(sessions.get('p1').closed, 0, 'a pane session, untouched, is still "running" - this is the bug');
  assert.equal(windows.get('p1').isDestroyed(), false, 'and its window is still open - still spending tokens, still visible, while JARVIS claims to be asleep');
});

// ------------------------------------------------------------------ the fix
check('closePanes(): every pane session closed, every pane window destroyed, both maps left empty', () => {
  const s1 = fakeSession();
  const s2 = fakeSession();
  const w1 = fakeWindow();
  const w2 = fakeWindow();
  const sessions = new Map([['a', s1], ['b', s2]]);
  const windows = new Map([['a', w1], ['b', w2]]);
  closePanes(sessions, windows);
  assert.equal(s1.closed, 1);
  assert.equal(s2.closed, 1);
  assert.equal(w1.destroyCalls, 1);
  assert.equal(w2.destroyCalls, 1);
  assert.equal(sessions.size, 0, 'no pane looks "still open" to activeWork()/respondAny()/interruptAll() afterward');
  assert.equal(windows.size, 0);
});
check('closePanes(): safe with nothing open at all', () => {
  const sessions = new Map();
  const windows = new Map();
  assert.doesNotThrow(() => closePanes(sessions, windows));
});
check('closePanes(): a session whose close() throws does not stop the rest from being closed', () => {
  const bad = fakeSession();
  bad.close = () => { throw new Error('already gone'); };
  const good = fakeSession();
  const w1 = fakeWindow();
  const w2 = fakeWindow();
  const sessions = new Map([['bad', bad], ['good', good]]);
  const windows = new Map([['bad', w1], ['good', w2]]);
  assert.doesNotThrow(() => closePanes(sessions, windows));
  assert.equal(good.closed, 1, 'one throwing session does not stop a sibling from being closed');
  assert.equal(w1.destroyCalls, 1, 'its window is still destroyed even though closing its session threw');
  assert.equal(w2.destroyCalls, 1);
});
check('closePanes(): a window already destroyed (the user closed it a moment earlier) is never destroyed twice', () => {
  const s = fakeSession();
  const w = fakeWindow();
  w.destroyed = true; // as if the window's own close handler already ran
  closePanes(new Map([['x', s]]), new Map([['x', w]]));
  assert.equal(w.destroyCalls, 0, 'isDestroyed() was honoured - destroy() was never called on it again');
  assert.equal(s.closed, 1, 'the session is still closed regardless');
});
check('closePanes(): calling it twice in a row (powerDown() then, moments later, shutdownChildren() on quit) is a harmless no-op the second time', () => {
  const s = fakeSession();
  const w = fakeWindow();
  const sessions = new Map([['x', s]]);
  const windows = new Map([['x', w]]);
  closePanes(sessions, windows);
  assert.doesNotThrow(() => closePanes(sessions, windows));
  assert.equal(s.closed, 1, 'not closed a second time - the map was already empty');
  assert.equal(w.destroyCalls, 1);
});
check('closePanes(): the race with a window\'s own "destroyed" cleanup - deleting from an already-cleared map is harmless', () => {
  // Mirrors the real listener in main.mjs: wc.once('destroyed', () => { s.close(); map.delete(id); }).
  // closePanes() clears the maps synchronously; this listener firing afterward must not throw
  // or resurrect an entry.
  const s = fakeSession();
  const w = fakeWindow();
  const sessions = new Map([['x', s]]);
  const windows = new Map([['x', w]]);
  closePanes(sessions, windows);
  assert.doesNotThrow(() => { s.close(); sessions.delete('x'); }); // the late listener's own work
  assert.equal(sessions.has('x'), false);
  assert.equal(s.closed, 2, 'idempotent close is expected to tolerate being called again by the listener');
});

// ------------------------------------------------------------------ wiring: main.mjs actually uses it, everywhere it must
check('wiring: openPane() tracks every pane window it creates, keyed the same way paneSessions already is', () => {
  const main = fs.readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8');
  assert.match(main, /const paneWindows = new Map\(\);/);
  assert.match(main, /function openPane\(\) \{[\s\S]{0,700}paneWindows\.set\(pw\.webContents\.id, pw\);[\s\S]{0,200}pw\.webContents\.once\('destroyed', \(\) => paneWindows\.delete\(pw\.webContents\.id\)\);/);
});
check('wiring: both powerDown() and shutdownChildren() call closeAllPanes() - not just one of them', () => {
  const main = fs.readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8');
  assert.match(main, /import \{ closePanes \} from '\.\/pane-windows\.mjs';/);
  assert.match(main, /function closeAllPanes\(\) \{ closePanes\(paneSessions, paneWindows\); \}/);
  const powerDownBody = /function powerDown\(from\) \{([\s\S]*?)\n\}/.exec(main)?.[1] || '';
  assert.match(powerDownBody, /closeAllPanes\(\);/, 'powerDown() closes every pane, not only the main session');
  const shutdownBody = /async function shutdownChildren\(\) \{([\s\S]*?)\n\}/.exec(main)?.[1] || '';
  assert.match(shutdownBody, /closeAllPanes\(\);/, 'shutdownChildren() (restart/quit) does too, so the invariant does not depend on process exit timing');
  // Order matters: closed before the window is destroyed, not after - so a pane's own
  // "destroyed" listener never fires on a session that main.mjs itself forgot to close.
  const sessionCloseIdx = powerDownBody.indexOf('session?.close()');
  const closePanesIdx = powerDownBody.indexOf('closeAllPanes()');
  const winDestroyIdx = powerDownBody.indexOf('win.destroy()');
  assert.ok(sessionCloseIdx > 0 && closePanesIdx > sessionCloseIdx && winDestroyIdx > closePanesIdx, 'main session, then every pane, then the main window - in that order');
});

console.log(`pane-windows-test: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
