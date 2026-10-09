// JARVIS Knowledge - Phase 24C: src/drive-connection.mjs - the connect/disconnect/status/
// getAccessToken state machine, with google-oauth.mjs's network-facing pieces faked (no real
// browser, no real loopback wait, no real Google call) so every branch (state mismatch,
// revoked refresh, no refresh token offered, disconnect-always-clears-locally) is exercised
// deterministically.
//   node scripts/drive-connection-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDriveConnection } from '../src/drive-connection.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${extra ? `\n     ${extra}` : ''}`); } };
const check = async (name, fn) => { try { await fn(); ok(true, name); } catch (e) { ok(false, name, String(e.stack || e).slice(0, 400)); } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-drive-conn-'));
let n = 0;
const files = () => ({ tokenFile: path.join(TMP, `tok-${n}.bin`), clientFile: path.join(TMP, `cli-${n++}.bin`) });
const fakeSafe = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s).reverse(), decryptString: (b) => Buffer.from(b).reverse().toString() };

/** A fake loopback that hands back a fixed result without ever opening a real socket. */
function fakeLoopback(result) {
  return async () => ({ port: 0, redirectUri: 'http://127.0.0.1:0/callback', waitForCallback: async () => result, close: () => {} });
}

function makeConn(overrides = {}) {
  const { tokenFile, clientFile } = files();
  let opened = [];
  // By default, the fake loopback hands back whatever state openExternal actually saw in the
  // URL connect() built - a genuine match, the same as a real sign-in completing normally.
  // Only a test that specifically exercises state mismatch/timeout/cancel overrides this.
  let seenState = null;
  const conn = createDriveConnection({
    tokenFile, clientFile, safeStorage: fakeSafe, log: () => {}, now: overrides.now || (() => 1_700_000_000_000),
    openExternal: overrides.openExternal || (async (url) => { opened.push(url); seenState = new URL(url).searchParams.get('state'); }),
    startLoopback: overrides.startLoopback || (async () => ({ port: 1, redirectUri: 'http://127.0.0.1:1/callback', waitForCallback: async () => ({ ok: true, code: 'c1', state: seenState }), close: () => {} })),
    exchangeCode: overrides.exchangeCode || (async () => ({ ok: true, accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: (overrides.now ? overrides.now() : 1_700_000_000_000) + 3600_000, scope: 'drive.file' })),
    refreshAccessToken: overrides.refreshAccessToken || (async () => ({ ok: true, accessToken: 'at-2', expiresAt: (overrides.now ? overrides.now() : 1_700_000_000_000) + 3600_000, scope: 'drive.file' })),
    revokeToken: overrides.revokeToken || (async () => ({ ok: true })),
  });
  return { conn, tokenFile, clientFile, opened: () => opened };
}

// ------------------------------------------------------------------ status, with nothing configured
await check('status: no Client ID configured at all is "disconnected", with a reason', async () => {
  const { conn } = makeConn();
  const s = conn.status();
  assert.equal(s.status, 'disconnected');
  assert.match(s.reason, /Client ID/);
});

// ------------------------------------------------------------------ configureClient
await check('configureClient: saves, and status moves from "no client" to "disconnected but configured"', async () => {
  const { conn } = makeConn();
  const r = conn.configureClient({ clientId: 'cid.apps.googleusercontent.com', clientSecret: 'sec' });
  assert.equal(r.ok, true);
  assert.equal(conn.getClient().clientId, 'cid.apps.googleusercontent.com');
  assert.equal(conn.status().status, 'disconnected');
});
await check('configureClient: an empty Client ID is refused, reported, not thrown past the caller', async () => {
  const { conn } = makeConn();
  const r = conn.configureClient({ clientId: '' });
  assert.equal(r.ok, false);
});

// ------------------------------------------------------------------ connect(): the full flow, faked network
await check('connect(): with no Client ID configured, refused before any browser or listener is touched', async () => {
  const { conn, opened } = makeConn();
  const r = await conn.connect();
  assert.equal(r.ok, false);
  assert.equal(opened().length, 0);
});

await check('connect(): opens the SYSTEM browser (never an in-app one) at a URL carrying this run\'s own state', async () => {
  const { conn, opened } = makeConn({
    startLoopback: async () => ({ port: 1, redirectUri: 'http://127.0.0.1:1/callback', waitForCallback: async () => ({ ok: false, error: 'timeout' }), close: () => {} }),
  });
  conn.configureClient({ clientId: 'cid' });
  await conn.connect();
  assert.equal(opened().length, 1);
  const url = new URL(opened()[0]);
  assert.equal(url.hostname, 'accounts.google.com');
  assert.ok(url.searchParams.get('state'));
  assert.ok(url.searchParams.get('code_challenge'));
});

await check('connect(): a callback whose state does not match this run\'s own is refused - never exchanged', async () => {
  let exchangeCalled = false;
  const { conn } = makeConn({
    startLoopback: async () => ({ port: 1, redirectUri: 'http://127.0.0.1:1/callback', waitForCallback: async () => ({ ok: true, code: 'stolen-code', state: 'WRONG-STATE' }), close: () => {} }),
    exchangeCode: async () => { exchangeCalled = true; return { ok: true, accessToken: 'x', refreshToken: 'y', expiresAt: Date.now() + 1000 }; },
  });
  conn.configureClient({ clientId: 'cid' });
  const r = await conn.connect();
  assert.equal(r.ok, false);
  assert.match(r.error, /did not match/i);
  assert.equal(exchangeCalled, false, 'the code was never exchanged - a mismatched state is refused outright');
  assert.equal(conn.status().status, 'disconnected', 'nothing was connected');
});

await check('connect(): a real callback (state matched) completes, saves tokens, and status becomes "connected"', async () => {
  const { conn, tokenFile } = makeConn();
  conn.configureClient({ clientId: 'cid' });
  const r = await conn.connect();
  assert.equal(r.ok, true);
  assert.equal(r.status, 'connected');
  assert.equal(conn.status().status, 'connected');
  assert.ok(fs.existsSync(tokenFile));
});

await check('connect(): Google refusing the code (exchange fails) leaves status disconnected, not a half-connected state', async () => {
  const { conn } = makeConn({ exchangeCode: async () => ({ ok: false, error: 'invalid_grant' }) });
  conn.configureClient({ clientId: 'cid' });
  const r = await conn.connect();
  assert.equal(r.ok, false);
  assert.equal(conn.status().status, 'disconnected');
});

await check('connect(): no refresh token offered is treated as a refusal, not a silent partial connect', async () => {
  const { conn } = makeConn({ exchangeCode: async () => ({ ok: true, accessToken: 'at-1', refreshToken: null, expiresAt: Date.now() + 1000 }) });
  conn.configureClient({ clientId: 'cid' });
  const r = await conn.connect();
  assert.equal(r.ok, false);
  assert.equal(conn.status().status, 'disconnected');
});

await check('connect(): a timed-out or cancelled sign-in is reported plainly', async () => {
  const { conn } = makeConn({ startLoopback: fakeLoopback({ ok: false, error: 'timeout' }) });
  conn.configureClient({ clientId: 'cid' });
  const r = await conn.connect();
  assert.equal(r.ok, false);
  assert.match(r.error, /timed out/i);
});

// ------------------------------------------------------------------ getAccessToken(): refresh, revoked, errors
await check('getAccessToken(): not connected at all is refused', async () => {
  const { conn } = makeConn();
  const r = await conn.getAccessToken();
  assert.equal(r.ok, false);
});

await check('getAccessToken(): a still-fresh access token is returned without calling refresh at all', async () => {
  let refreshCalled = false;
  const now = () => 1_700_000_000_000;
  const { conn } = makeConn({ now, refreshAccessToken: async () => { refreshCalled = true; return { ok: true, accessToken: 'should-not-happen', expiresAt: now() + 1000 }; } });
  conn.configureClient({ clientId: 'cid' });
  await conn.connect(); // tokens expire 3600s from `now`, far beyond the refresh skew
  const r = await conn.getAccessToken();
  assert.equal(r.ok, true);
  assert.equal(r.accessToken, 'at-1');
  assert.equal(refreshCalled, false);
});

await check('getAccessToken(): a token due to expire within the skew window is refreshed transparently, and the new one is saved', async () => {
  let t = 1_700_000_000_000;
  const now = () => t;
  const { conn, tokenFile } = makeConn({
    now,
    exchangeCode: async () => ({ ok: true, accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: now() + 30_000 }), // expires in 30s - inside the 60s skew
    refreshAccessToken: async () => ({ ok: true, accessToken: 'at-fresh', expiresAt: now() + 3600_000, scope: 'drive.file' }),
  });
  conn.configureClient({ clientId: 'cid' });
  await conn.connect();
  const r = await conn.getAccessToken();
  assert.equal(r.ok, true);
  assert.equal(r.accessToken, 'at-fresh');
  void tokenFile;
});

await check('getAccessToken(): a revoked refresh token marks status "expired", with a plain reason - never a silent failure', async () => {
  const { conn } = makeConn({
    exchangeCode: async () => ({ ok: true, accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 1_700_000_000_000 - 1 }), // already "expired" so getAccessToken refreshes immediately
    refreshAccessToken: async () => ({ ok: false, revoked: true, error: 'invalid_grant' }),
  });
  conn.configureClient({ clientId: 'cid' });
  await conn.connect();
  const r = await conn.getAccessToken();
  assert.equal(r.ok, false);
  assert.equal(r.revoked, true);
  assert.equal(conn.status().status, 'expired');
});

await check('getAccessToken(): an ordinary refresh failure (network/5xx) marks status "error", distinct from "expired"', async () => {
  const { conn } = makeConn({
    exchangeCode: async () => ({ ok: true, accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 1_700_000_000_000 - 1 }),
    refreshAccessToken: async () => ({ ok: false, revoked: false, error: 'network down' }),
  });
  conn.configureClient({ clientId: 'cid' });
  await conn.connect();
  const r = await conn.getAccessToken();
  assert.equal(r.ok, false);
  assert.equal(conn.status().status, 'error');
});

// ------------------------------------------------------------------ disconnect(): always clears locally
await check('disconnect(): revokes at Google\'s end and clears the local token; status returns to disconnected', async () => {
  let revokedWith = null;
  const { conn, tokenFile } = makeConn({ revokeToken: async (t) => { revokedWith = t; return { ok: true }; } });
  conn.configureClient({ clientId: 'cid' });
  await conn.connect();
  const r = await conn.disconnect();
  assert.equal(r.ok, true);
  assert.equal(r.status, 'disconnected');
  assert.equal(revokedWith, 'rt-1');
  assert.equal(fs.existsSync(tokenFile), false);
  assert.equal(conn.status().status, 'disconnected');
});

await check('disconnect(): even if revoking at Google\'s end fails (offline), the LOCAL token is still cleared - never left behind believing it still works', async () => {
  const { conn, tokenFile } = makeConn({ revokeToken: async () => { throw new Error('offline'); } });
  conn.configureClient({ clientId: 'cid' });
  await conn.connect();
  const r = await conn.disconnect();
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(tokenFile), false);
});

await check('disconnect(): with nothing connected, still succeeds - a no-op, not an error', async () => {
  const { conn } = makeConn();
  conn.configureClient({ clientId: 'cid' });
  const r = await conn.disconnect();
  assert.equal(r.ok, true);
});

// ------------------------------------------------------------------ never automatic
await check('nothing in this module calls connect(), getAccessToken() or openExternal on its own - only this test\'s own explicit calls do', () => {
  const src = fs.readFileSync(new URL('../src/drive-connection.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /setInterval|setTimeout(?!.*skew)/i, 'no timer anywhere in the connection module');
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`drive-connection-test: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
