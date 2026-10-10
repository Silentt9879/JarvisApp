// JARVIS Google Drive - Phase 2 (Decision 1): src/drive-app-client.mjs's two environment
// gates. Pure, Electron-free logic - this file only proves that BOTH gates must be open
// before the app-owned, no-setup "Connect Google Account" path is ever considered available,
// and that today's default (neither env var set) leaves it unavailable, so an existing
// install's BYO-client flow is completely unaffected by this module simply existing.
//   node scripts/drive-app-client-test.mjs
import assert from 'node:assert/strict';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${extra ? `\n     ${extra}` : ''}`); } };
const check = (name, fn) => { try { fn(); ok(true, name); } catch (e) { ok(false, name, String(e?.stack || e).split('\n').slice(0, 6).join('\n     ')); } };

const FLAG = 'JARVIS_DRIVE_APP_OWNED';
const CLIENT = 'JARVIS_GOOGLE_CLIENT_ID';
const savedFlag = process.env[FLAG];
const savedClient = process.env[CLIENT];
const reset = () => { delete process.env[FLAG]; delete process.env[CLIENT]; };
const restore = () => {
  if (savedFlag === undefined) delete process.env[FLAG]; else process.env[FLAG] = savedFlag;
  if (savedClient === undefined) delete process.env[CLIENT]; else process.env[CLIENT] = savedClient;
};

// Each module import reads process.env live (functions, not top-level constants), so a fresh
// import isn't needed between checks - only the env vars need to change.
const M = await import('../src/drive-app-client.mjs');

check('neither env var set (today\'s default on every build): unavailable, flag off, no client id', () => {
  reset();
  assert.equal(M.appOwnedLoginFlag(), false);
  assert.equal(M.appOwnedClientId(), null);
  assert.equal(M.appOwnedLoginAvailable(), false);
});
check('flag on, but no Client ID: still unavailable - a flag alone is never enough', () => {
  reset();
  process.env[FLAG] = '1';
  assert.equal(M.appOwnedLoginAvailable(), false);
});
check('a Client ID present, but the flag off: still unavailable - the flag is the deliberate kill switch', () => {
  reset();
  process.env[CLIENT] = 'some-client-id.apps.googleusercontent.com';
  assert.equal(M.appOwnedLoginAvailable(), false);
});
check('both open: available, and the id is returned exactly (trimmed) - it is not a secret, so no obfuscation is expected', () => {
  reset();
  process.env[FLAG] = '1';
  process.env[CLIENT] = '  some-client-id.apps.googleusercontent.com  ';
  assert.equal(M.appOwnedLoginAvailable(), true);
  assert.equal(M.appOwnedClientId(), 'some-client-id.apps.googleusercontent.com');
});
check('an empty or whitespace-only Client ID counts as "not set", not as a usable id', () => {
  reset();
  process.env[FLAG] = '1';
  process.env[CLIENT] = '   ';
  assert.equal(M.appOwnedClientId(), null);
  assert.equal(M.appOwnedLoginAvailable(), false);
});
check('the flag only recognizes the exact string "1" - "true", "yes", "0" are all treated as off, never guessed at', () => {
  reset();
  process.env[CLIENT] = 'x';
  for (const v of ['true', 'yes', '0', 'TRUE', '']) {
    process.env[FLAG] = v;
    assert.equal(M.appOwnedLoginFlag(), false, `"${v}" should not enable the flag`);
  }
});

restore();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
