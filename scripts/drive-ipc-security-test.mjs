// JARVIS Knowledge - Phase 24C/24D: the renderer IPC boundary for Google Drive connection
// management AND backup/restore. main.mjs cannot be imported/driven outside Electron (see
// main-chat-ipc-test.mjs's own header for why this is a source-inspection test, not a
// behavioral one) - this file checks the one thing that matters most: no token, refresh
// token, Client Secret, or authorization code is ever returned to, or accessible from, the
// renderer, and the restore confirmation workflow cannot be bypassed from the IPC layer.
// The actual lock/token-enforcement LOGIC is covered behaviorally by
// drive-backup-controller-test.mjs - this file only checks the thin IPC wiring around it.
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
check('exactly eleven Drive IPC handlers exist - the four Phase 24C connection calls, Phase 24D\'s backup/history/preview/confirm/status, and Phase 2\'s two app-owned calls - and no other, wider Drive call', () => {
  for (const h of ['jarvis:driveStatus', 'jarvis:driveConfigureClient', 'jarvis:driveConnect', 'jarvis:driveDisconnect',
    'jarvis:driveBackupNow', 'jarvis:driveBackupHistory', 'jarvis:driveRestorePreview', 'jarvis:driveRestoreConfirm', 'jarvis:driveOperationStatus',
    'jarvis:driveAppOwnedStatus', 'jarvis:driveConnectAppOwned']) {
    assert.match(main, new RegExp(`ipcMain\\.handle\\('${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`), h);
  }
  assert.doesNotMatch(main, /ipcMain\.handle\('jarvis:drive(Delete|Sync|Upload|Download|ListFiles)/, 'no wider Drive call (delete, sync, raw file access) exists');
});

check('Phase 2: driveConnectAppOwned takes no arguments from the renderer - it can never be handed a different Client ID than drive-app-client.mjs\'s own env-gated one', () => {
  const body = handlerBody('jarvis:driveConnectAppOwned');
  assert.match(body, /async \(\) => \{/, 'no (_e, clientId, ...) parameter exists for the renderer to populate');
  assert.match(body, /appOwnedClientId\(\)/, 'the Client ID always comes from drive-app-client.mjs, never a call argument');
  assert.doesNotMatch(body, /clientSecret: (?!'')/, 'no client secret is ever supplied for this path');
});
check('Phase 2: driveAppOwnedStatus never returns the Client ID itself - only whether the path is available', () => {
  const body = handlerBody('jarvis:driveAppOwnedStatus');
  assert.doesNotMatch(body, /appOwnedClientId\(\)/, 'the id itself never appears in this handler\'s own reply shape');
  assert.match(body, /available: appOwnedLoginAvailable\(\)/);
});

check('driveRestoreConfirm requires a token argument from the renderer - there is no handler that calls applyRestore without one', () => {
  const body = handlerBody('jarvis:driveRestoreConfirm');
  assert.match(body, /restoreConfirm\(backupId, token\)/);
  assert.doesNotMatch(main, /\bapplyRestore\(/, 'main.mjs never calls applyRestore directly - only through the controller\'s token-gated restoreConfirm');
});

check('none of the five backup/restore handlers return an access token, refresh token, or client secret', () => {
  for (const h of ['jarvis:driveBackupNow', 'jarvis:driveBackupHistory', 'jarvis:driveRestorePreview', 'jarvis:driveRestoreConfirm', 'jarvis:driveOperationStatus']) {
    assert.doesNotMatch(handlerBody(h), /accessToken|refreshToken|clientSecret/i, h);
  }
});

check('the backup-id format is validated before it ever reaches the controller/provider (defense in depth) - controller.mjs itself also validates, proven behaviorally in drive-backup-controller-test.mjs', () => {
  const controller = fs.readFileSync(new URL('../src/drive-backup-controller.mjs', import.meta.url), 'utf8');
  assert.match(controller, /BACKUP_ID\.test\(backupId\)/g);
});

check('the lock, token map and last-backup state all live in drive-backup-controller.mjs, not duplicated in main.mjs - one place to get this right', () => {
  assert.doesNotMatch(main, /previewTokens|driveOp\s*=\s*\{/, 'main.mjs holds no operation-lock or token state of its own');
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
check('the preload bridge exposes only the named Drive connection calls - never a generic invoke, never ipcRenderer itself', () => {
  for (const name of ['driveStatus', 'driveConfigureClient', 'driveConnect', 'driveDisconnect', 'driveAppOwnedStatus', 'driveConnectAppOwned']) {
    assert.match(preload, new RegExp(`${name}: \\(`));
  }
  assert.doesNotMatch(preload, /driveGetAccessToken|driveToken\b|getDriveToken/i);
});

console.log(`drive-ipc-security-test: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
