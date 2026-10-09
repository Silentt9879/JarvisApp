// JARVIS Knowledge - Phase 24C: src/drive-token.mjs - encrypted storage for the OAuth Client
// ID/secret and the access/refresh tokens. The one thing this phase changes versus
// phone-token.mjs: there is NO plaintext fallback here - every save must fail closed if this
// PC cannot encrypt right now, never write a Drive credential in the clear.
//   node scripts/drive-token-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadDriveClient, saveDriveClient, clearDriveClient,
  loadDriveTokens, saveDriveTokens, clearDriveTokens,
} from '../src/drive-token.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${extra ? `\n     ${extra}` : ''}`); } };
const check = (name, fn) => { try { fn(); ok(true, name); } catch (e) { ok(false, name, String(e.message || e).slice(0, 300)); } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-drive-token-'));
let n = 0;
const freshFile = () => path.join(TMP, `f-${n++}.bin`);

const fakeSafe = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s).reverse(), decryptString: (b) => Buffer.from(b).reverse().toString() };
const noEncryption = { isEncryptionAvailable: () => false };

// ------------------------------------------------------------------ client credentials
check('no file: no client configured', () => {
  assert.equal(loadDriveClient(freshFile(), fakeSafe), null);
});
check('save then load: round-trips exactly, never in the clear on disk', () => {
  const file = freshFile();
  saveDriveClient(file, fakeSafe, { clientId: 'abc.apps.googleusercontent.com', clientSecret: 'shh' });
  const c = loadDriveClient(file, fakeSafe);
  assert.deepEqual(c, { clientId: 'abc.apps.googleusercontent.com', clientSecret: 'shh' });
  assert.doesNotMatch(fs.readFileSync(file).toString('latin1'), /abc\.apps\.googleusercontent\.com|shh/);
});
check('a client secret is optional - an empty string round-trips too', () => {
  const file = freshFile();
  saveDriveClient(file, fakeSafe, { clientId: 'abc', clientSecret: '' });
  assert.deepEqual(loadDriveClient(file, fakeSafe), { clientId: 'abc', clientSecret: '' });
});
check('an empty/missing Client ID is refused outright - never saved as "configured" with nothing in it', () => {
  const file = freshFile();
  assert.throws(() => saveDriveClient(file, fakeSafe, { clientId: '' }));
  assert.throws(() => saveDriveClient(file, fakeSafe, {}));
  assert.equal(fs.existsSync(file), false);
});
check('FAILS CLOSED: encryption unavailable means the save is refused outright - never a plaintext fallback', () => {
  const file = freshFile();
  assert.throws(() => saveDriveClient(file, noEncryption, { clientId: 'abc', clientSecret: 'shh' }));
  assert.equal(fs.existsSync(file), false, 'nothing was written at all');
});
check('clearDriveClient removes the file; loading afterward is null, not a crash', () => {
  const file = freshFile();
  saveDriveClient(file, fakeSafe, { clientId: 'abc' });
  clearDriveClient(file);
  assert.equal(fs.existsSync(file), false);
  assert.equal(loadDriveClient(file, fakeSafe), null);
});
check('a corrupted/foreign file reads as "not configured", not a thrown error', () => {
  const file = freshFile();
  fs.writeFileSync(file, fakeSafe.encryptString('not json at all'));
  assert.equal(loadDriveClient(file, fakeSafe), null);
});

// ------------------------------------------------------------------ tokens
check('no file: not connected', () => {
  assert.equal(loadDriveTokens(freshFile(), fakeSafe), null);
});
check('save then load: round-trips every field, never in the clear on disk', () => {
  const file = freshFile();
  saveDriveTokens(file, fakeSafe, { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 12345, scope: 'drive.file' });
  const t = loadDriveTokens(file, fakeSafe);
  assert.deepEqual(t, { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 12345, scope: 'drive.file' });
  assert.doesNotMatch(fs.readFileSync(file).toString('latin1'), /at-1|rt-1/);
});
check('no access token to save is refused outright', () => {
  const file = freshFile();
  assert.throws(() => saveDriveTokens(file, fakeSafe, { refreshToken: 'rt-1' }));
  assert.equal(fs.existsSync(file), false);
});
check('FAILS CLOSED: encryption unavailable means tokens are never written in the clear', () => {
  const file = freshFile();
  assert.throws(() => saveDriveTokens(file, noEncryption, { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 1 }));
  assert.equal(fs.existsSync(file), false);
});
check('a refreshed access token (no new refresh token issued) overwrites cleanly - refreshToken carried forward by the caller', () => {
  const file = freshFile();
  saveDriveTokens(file, fakeSafe, { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 100 });
  saveDriveTokens(file, fakeSafe, { accessToken: 'at-2', refreshToken: 'rt-1', expiresAt: 200 });
  assert.deepEqual(loadDriveTokens(file, fakeSafe), { accessToken: 'at-2', refreshToken: 'rt-1', expiresAt: 200, scope: '' });
});
check('clearDriveTokens removes the file - disconnect leaves nothing recoverable locally', () => {
  const file = freshFile();
  saveDriveTokens(file, fakeSafe, { accessToken: 'at-1', expiresAt: 1 });
  clearDriveTokens(file);
  assert.equal(fs.existsSync(file), false);
  assert.equal(loadDriveTokens(file, fakeSafe), null);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`drive-token-test: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
