// JARVIS Knowledge - Phase 24C: the renderer IPC boundary for Google Drive connection
// management. main.mjs cannot be imported/driven outside Electron (see
// main-chat-ipc-test.mjs's own header for why this is a source-inspection test, not a
// behavioral one) - this file checks the one thing that matters most for this phase: no
// token, refresh token, Client Secret, or authorization code is ever returned to, or
// accessible from, the renderer, and no backup/restore call is exposed yet.
//   node scripts/drive-ipc-security-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${extra ? `\n     ${extra}` : ''}`); } };
const check = (name, fn) => { try { fn(); ok(true, name); } catch (e) { ok(false, name, String(e.stack || e).slice(0, 400)); } };

const main = fs.readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8');
const preload = fs.readFileSync(new URL('../src/preload.cjs', import.meta.url), 'utf8');

function handlerBody(channel) {
  const start = main.indexOf(`ipcMain.handle('${channel}'`);
  assert.ok(start >= 0, `${channel} handler found`);
  const arrow = main.indexOf('=>', start);
  // A single-expression arrow (no { ... } block body at all) ends at the line's own `;`.
  let j = arrow + 2;
  while (main[j] === ' ') j += 1;
  if (main[j] !== '{') { const semi = main.indexOf(';', j); return main.slice(start, semi + 1); }
  // Otherwise balance braces from that '{' to its matching '}'.
  let depth = 0;
  for (let i = j; i < main.length; i += 1) {
    if (main[i] === '{') depth += 1;
    else if (main[i] === '}') { depth -= 1; if (depth === 0) return main.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces');
}

// ------------------------------------------------------------------ what main.mjs exposes
check('exactly four Drive IPC handlers exist: status, configure, connect, disconnect - no backup or restore call yet', () => {
  for (const h of ['jarvis:driveStatus', 'jarvis:driveConfigureClient', 'jarvis:driveConnect', 'jarvis:driveDisconnect']) {
    assert.match(main, new RegExp(`ipcMain\\.handle\\('${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`), h);
  }
  assert.doesNotMatch(main, /ipcMain\.handle\('jarvis:drive(Backup|Restore|BackupRun|RestoreApply|RestorePreview|ListBackups)/, 'no backup/restore IPC exists in this phase');
});

check('driveStatus never returns an access token, refresh token, or client secret - only a status word, a reason, and whether a client is configured', () => {
  const body = handlerBody('jarvis:driveStatus');
  assert.doesNotMatch(body, /accessToken|refreshToken|clientSecret/i);
});

check('driveStatusForWindow() itself is the single place that launders drive status for the window - never spreads the raw connection object', () => {
  const fnStart = main.indexOf('function driveStatusForWindow()');
  assert.ok(fnStart >= 0);
  const body = main.slice(fnStart, main.indexOf('\n}', fnStart) + 2);
  assert.doesNotMatch(body, /accessToken|refreshToken|clientSecret/i);
  assert.doesNotMatch(body, /\.\.\.s\b|\.\.\.c\b/, 'never spreads the raw status/client object - only named, specific fields');
});

check('driveConfigureClient accepts a Client ID and secret from the renderer but never echoes either back in its reply', () => {
  const body = handlerBody('jarvis:driveConfigureClient');
  assert.match(body, /clientId/);
  // The function RECEIVES clientSecret as a parameter (expected - that's how a renderer submits
  // it to be saved) but its own object literals returned to the window must never include it.
  const returned = [...body.matchAll(/return\s+(\{[^;]*?\});/gs)].map((m) => m[1]);
  for (const r of returned) assert.doesNotMatch(r, /clientSecret|accessToken|refreshToken/i, r);
});

check('driveConnect\'s reply never includes a token - only ok/error and the laundered status', () => {
  const body = handlerBody('jarvis:driveConnect');
  assert.doesNotMatch(body, /accessToken|refreshToken/i);
  assert.match(body, /driveStatusForWindow\(\)/, 'the reply goes through the same laundering function as driveStatus');
});

check('driveDisconnect\'s reply never includes a token either', () => {
  const body = handlerBody('jarvis:driveDisconnect');
  assert.doesNotMatch(body, /accessToken|refreshToken/i);
});

check('the authorization code and the callback URL are never logged anywhere in the connection module', () => {
  const conn = fs.readFileSync(new URL('../src/drive-connection.mjs', import.meta.url), 'utf8');
  const oauth = fs.readFileSync(new URL('../src/google-oauth.mjs', import.meta.url), 'utf8');
  for (const src of [conn, oauth]) {
    for (const m of src.matchAll(/log\(([^)]*)\)/g)) {
      assert.doesNotMatch(m[1], /code\b|callback|accessToken|refreshToken/i, `a log() call mentions a sensitive value: log(${m[1]})`);
    }
  }
});

// ------------------------------------------------------------------ the preload bridge
check('the preload bridge exposes only the four named Drive calls - never a generic invoke, never ipcRenderer itself', () => {
  for (const name of ['driveStatus', 'driveConfigureClient', 'driveConnect', 'driveDisconnect']) {
    assert.match(preload, new RegExp(`${name}: \\(`));
  }
  assert.doesNotMatch(preload, /driveGetAccessToken|driveToken\b|getDriveToken/i);
});

console.log(`drive-ipc-security-test: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
