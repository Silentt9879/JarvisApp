// Phase 3 item 5: every app.isPackaged-dependent branch in main.mjs.
//
// main.mjs cannot be imported outside Electron (see main-chat-ipc-test.mjs's own header for
// why), so most of this file is honestly a wiring test: it reads main.mjs's source to confirm
// each packaged-only branch is gated the way it is meant to be, and that the dev/packaged
// split cannot be crossed by accident. The one piece that IS genuinely behavioral is
// `unpacked()` - a small pure path-rewrite with no Electron dependency at all - which this
// file extracts and actually runs.
//
// This is simulated verification only. It does NOT install, run an installer, or alter any
// installed JARVIS, and does not confirm real packaged-OS behavior (actual taskbar identity,
// actual Start-with-Windows registration, an actual NSIS install/update). That would require
// building and installing a real package - which was explicitly left for separate approval
// (`npm run dist`, then installing it) rather than done here.
//   node scripts/packaged-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${extra ? `\n     ${extra}` : ''}`); } };
const check = (name, fn) => { try { fn(); ok(true, name); } catch (e) { ok(false, name, String(e.stack || e).slice(0, 400)); } };

const main = fs.readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8');

// ------------------------------------------------------------------ unpacked(): the one pure, genuinely behavioral piece
check('unpacked() [BEHAVIORAL]: rewrites app.asar to app.asar.unpacked, and leaves an already-unpacked or asar-free path alone', () => {
  const src = /const unpacked = \(p\) => p\.replace\(`app\.asar\$\{path\.sep\}`, `app\.asar\.unpacked\$\{path\.sep\}`\);/.exec(main);
  assert.ok(src, 'the function\'s shape has not drifted from what this test actually runs below');
  // eslint-disable-next-line no-new-func -- running the exact source line extracted above, not arbitrary input
  const unpacked = new Function('path', `return (p) => p.replace(\`app.asar\${path.sep}\`, \`app.asar.unpacked\${path.sep}\`);`)(path);
  const packaged = path.join('C:', 'Program Files', 'JARVIS', 'resources', 'app.asar', 'node_modules', 'x', 'claude.exe');
  const unpackedExpected = path.join('C:', 'Program Files', 'JARVIS', 'resources', 'app.asar.unpacked', 'node_modules', 'x', 'claude.exe');
  assert.equal(unpacked(packaged), unpackedExpected);
  const devPath = path.join('C:', 'dev', 'JarvisApp', 'node_modules', 'x', 'claude.exe');
  assert.equal(unpacked(devPath), devPath, 'a dev checkout has no app.asar at all, so nothing is rewritten');
});
check('claudeExe() and windowIcon() both go through unpacked() - the asar-escape is not special-cased per resource', () => {
  const claudeExeBody = /function claudeExe\(\) \{([\s\S]*?)\n\}/.exec(main)?.[1] || '';
  assert.match(claudeExeBody, /unpacked\(path\.join\(APP_ROOT,/);
  const windowIconBody = /function windowIcon\(\) \{([\s\S]*?)\n\}/.exec(main)?.[1] || '';
  assert.match(windowIconBody, /const ico = unpacked\(path\.join\(APP_ROOT, 'build', 'icon\.ico'\)\);/);
  assert.match(windowIconBody, /const png = unpacked\(path\.join\(APP_ROOT, 'build', 'icon\.png'\)\);/);
});

// ------------------------------------------------------------------ app identity (appId / toast activator CLSID)
check('IDENTITY [wiring]: packaged and dev get a different appId AND a different toast activator - never the same pair, so a dev run can never register under, or answer for, the installed app', () => {
  const m = /const IDENTITY = app\.isPackaged\s*\? \{ appId: '([^']+)', toastActivator: '([^']+)' \}\s*: \{ appId: '([^']+)', toastActivator: '([^']+)' \};/.exec(main);
  assert.ok(m, 'IDENTITY literal found with the expected shape');
  const [, pkgId, pkgCLSID, devId, devCLSID] = m;
  assert.notEqual(pkgId, devId);
  assert.notEqual(pkgCLSID, devCLSID);
  assert.match(pkgId, /^com\.bantuapps\.jarvis$/);
  assert.match(devId, /\.dev$/);
  assert.match(pkgCLSID, /^\{[0-9A-F-]+\}$/i);
  assert.match(devCLSID, /^\{[0-9A-F-]+\}$/i);
});
check('the toast activator is registered defensively - only on win32, only if this Electron build exposes the API, never a crash on an older one', () => {
  assert.match(main, /if \(process\.platform === 'win32' && typeof app\.setToastActivatorCLSID === 'function'\) \{\s*try \{ app\.setToastActivatorCLSID\(IDENTITY\.toastActivator\); \} catch \{/);
});

// ------------------------------------------------------------------ start with Windows
check('startAtLogin() [wiring]: refuses outright for a dev run - never registers electron.exe under the login key', () => {
  const body = /function startAtLogin\(\) \{([\s\S]*?)\n\}/.exec(main)?.[1] || '';
  assert.match(body, /if \(!app\.isPackaged\) return false;/);
});
check('jarvis:startup [wiring]: "available" is false for a dev run (and off Windows), never offering a toggle that cannot work', () => {
  assert.match(main, /ipcMain\.handle\('jarvis:startup', \(\) => \(\{ available: app\.isPackaged && process\.platform === 'win32', atLogin: startAtLogin\(\) \}\)\);/);
});
check('jarvis:setStartup [wiring]: a dev run gets a clear refusal, not a silent no-op or a false "on"', () => {
  const h = /ipcMain\.handle\('jarvis:setStartup', \(_e, on\) => \{([\s\S]*?)\n\}\);/.exec(main)?.[1] || '';
  assert.match(h, /if \(!app\.isPackaged\) return \{ ok: false, error: 'Only the installed JARVIS\.exe can start with Windows\.' \};/);
  const guardIdx = h.indexOf('!app.isPackaged');
  const setIdx = h.indexOf('setLoginItemSettings');
  assert.ok(guardIdx >= 0 && setIdx > guardIdx, 'the guard runs before Windows\' own login-item registry is ever touched');
});
check('both startup handlers pass the SAME path and args (process.execPath, --hidden) - what is read back is exactly what would be set', () => {
  const read = /app\.getLoginItemSettings\(\{ path: process\.execPath, args: LOGIN_ARGS \}\)/.exec(main);
  const write = /app\.setLoginItemSettings\(\{ openAtLogin: !!on, path: process\.execPath, args: LOGIN_ARGS \}\)/.exec(main);
  assert.ok(read && write);
});

// ------------------------------------------------------------------ installer delivery paths (deleteApp / update note)
check('deleteApp() [wiring]: a packaged install cleans only itself - old dist-installer builds are a dev-checkout-only concept', () => {
  const body = /deleteApp: async \(\) => \{([\s\S]*?)\n  \},/.exec(main)?.[1] || '';
  assert.match(body, /const distDir = app\.isPackaged \? null : path\.join\(APP_ROOT, 'dist-installer'\);/);
});
check('watchDeliveries() [wiring]: only the installed app clears a used update note - a run from source never eats the note meant for the real install (see updates-test.mjs for readDelivery/newerDelivery/clearDelivery themselves, already covered behaviorally there)', () => {
  assert.match(main, /if \(app\.isPackaged && readDelivery\(userDir\) && !newerDelivery\(userDir, app\.getVersion\(\)\)\) clearDelivery\(userDir\);/);
});

// ------------------------------------------------------------------ what main.mjs itself exports as "packaged or not"
check('diagnostics expose app.isPackaged verbatim - a diagnostic consumer sees the real runtime, not a guess', () => {
  assert.match(main, /r\.runtime\.packaged = app\.isPackaged;/);
});

console.log(`packaged-test: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
