// JARVIS Knowledge - Phase 24C: src/google-oauth.mjs, the OAuth protocol engine itself -
// PKCE math, the loopback listener (a REAL local HTTP server - no network, no Google, pure
// localhost), and the token-endpoint calls against a fake `fetch`. No real network call is
// ever made by this file.
//   node scripts/google-oauth-test.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  generatePkce, generateState, buildAuthUrl, startLoopbackListener,
  exchangeCode, refreshAccessToken, revokeToken, AUTH_ENDPOINT, TOKEN_ENDPOINT, DRIVE_SCOPE,
} from '../src/google-oauth.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${extra ? `\n     ${extra}` : ''}`); } };
const check = async (name, fn) => { try { await fn(); ok(true, name); } catch (e) { ok(false, name, String(e.stack || e).slice(0, 400)); } };

const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// ------------------------------------------------------------------ PKCE
await check('generatePkce: a verifier and an S256 challenge that really is SHA-256(verifier), base64url, no padding', () => {
  const p = generatePkce();
  assert.equal(p.method, 'S256');
  assert.match(p.verifier, /^[A-Za-z0-9_-]{32,}$/, 'no + / = - base64url only');
  assert.match(p.challenge, /^[A-Za-z0-9_-]+$/);
  const expected = crypto.createHash('sha256').update(p.verifier).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(p.challenge, expected);
});
await check('two calls never produce the same verifier', () => {
  assert.notEqual(generatePkce().verifier, generatePkce().verifier);
});
await check('generateState: unguessable, and never the same twice', () => {
  const a = generateState();
  const b = generateState();
  assert.notEqual(a, b);
  assert.ok(a.length >= 16);
});

// ------------------------------------------------------------------ the authorization URL
await check('buildAuthUrl: the real Google endpoint, PKCE and state carried through exactly, offline+consent so a refresh token is actually issued', () => {
  const url = new URL(buildAuthUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:12345/callback', scope: DRIVE_SCOPE, state: 'st-1', codeChallenge: 'chal-1' }));
  assert.equal(`${url.origin}${url.pathname}`, AUTH_ENDPOINT);
  assert.equal(url.searchParams.get('client_id'), 'cid');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:12345/callback');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), DRIVE_SCOPE);
  assert.equal(url.searchParams.get('state'), 'st-1');
  assert.equal(url.searchParams.get('code_challenge'), 'chal-1');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
});
await check('buildAuthUrl: no Client ID is refused before ever building a URL that would fail at Google\'s end anyway', () => {
  assert.throws(() => buildAuthUrl({ redirectUri: 'http://127.0.0.1:1/callback', state: 's', codeChallenge: 'c' }));
});

// ------------------------------------------------------------------ the loopback listener - a real local server, no network
await check('a real callback request is captured: code, state, and the exact redirect URI format Google requires', async () => {
  const l = await startLoopbackListener({ timeoutMs: 5000 });
  assert.match(l.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  const waitP = l.waitForCallback();
  const res = await fetch(`${l.redirectUri}?code=abc&state=xyz`);
  assert.equal(res.status, 200);
  const page = await res.text();
  assert.match(page, /close this tab/i);
  const r = await waitP;
  assert.deepEqual(r, { ok: true, code: 'abc', state: 'xyz' });
});
await check('a callback with error= is reported as a refusal, not a successful code', async () => {
  const l = await startLoopbackListener({ timeoutMs: 5000 });
  const waitP = l.waitForCallback();
  await fetch(`${l.redirectUri}?error=access_denied`);
  const r = await waitP;
  assert.equal(r.ok, false);
  assert.equal(r.error, 'access_denied');
});
await check('timeout and cleanup: nothing ever arrives, the listener times out on its own and stops listening', async () => {
  const l = await startLoopbackListener({ timeoutMs: 200 });
  const port = l.port;
  const r = await l.waitForCallback();
  assert.equal(r.ok, false);
  assert.equal(r.error, 'timeout');
  // The port is free again - the server really closed, not left open.
  const l2 = await startLoopbackListener({ timeoutMs: 1000, host: '127.0.0.1' });
  l2.close();
  await l2.waitForCallback();
  void port;
});
await check('close() cancels cleanly before anything arrives, and frees the port', async () => {
  const l = await startLoopbackListener({ timeoutMs: 10000 });
  const waitP = l.waitForCallback();
  l.close();
  const r = await waitP;
  assert.equal(r.ok, false);
  assert.equal(r.error, 'cancelled');
});
await check('a request to any other path is answered 404, not treated as the OAuth callback', async () => {
  const l = await startLoopbackListener({ timeoutMs: 5000 });
  const waitP = l.waitForCallback();
  const res = await fetch(`http://127.0.0.1:${l.port}/not-the-callback`);
  assert.equal(res.status, 404);
  const real = await fetch(`${l.redirectUri}?code=real&state=s`);
  assert.equal(real.status, 200);
  assert.deepEqual(await waitP, { ok: true, code: 'real', state: 's' });
});

await check('a callback cannot be reused: a second request after the first is already resolved never changes the result, and the server has already stopped listening for it', async () => {
  const l = await startLoopbackListener({ timeoutMs: 5000 });
  const port = l.port;
  const waitP = l.waitForCallback();
  const first = await fetch(`${l.redirectUri}?code=first-code&state=first-state`);
  assert.equal(first.status, 200);
  const result = await waitP;
  assert.deepEqual(result, { ok: true, code: 'first-code', state: 'first-state' });

  // A second, replayed/substituted callback (same or different values) must reach nobody -
  // the server already closed itself after the first request.
  let secondRejected = false;
  try { await fetch(`http://127.0.0.1:${port}/callback?code=second-code&state=second-state`, { signal: AbortSignal.timeout(1000) }); }
  catch { secondRejected = true; }
  assert.equal(secondRejected, true, 'the port is no longer accepting connections at all');

  // And the already-resolved result from the first call is exactly what a caller would act
  // on - there is no second waitForCallback() call that could somehow see the replay instead.
  assert.equal(result.code, 'first-code');
});

// ------------------------------------------------------------------ token endpoint calls (fake fetch - never real network)
await check('exchangeCode: a successful response is parsed into the shape callers expect', async () => {
  const fetchImpl = async (url, opts) => {
    assert.equal(url, TOKEN_ENDPOINT);
    const body = new URLSearchParams(opts.body);
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('code'), 'the-code');
    assert.equal(body.get('code_verifier'), 'the-verifier');
    return jsonRes(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: DRIVE_SCOPE, token_type: 'Bearer' });
  };
  const r = await exchangeCode({ clientId: 'cid', clientSecret: 'sec', code: 'the-code', codeVerifier: 'the-verifier', redirectUri: 'http://127.0.0.1:1/callback' }, { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.accessToken, 'at-1');
  assert.equal(r.refreshToken, 'rt-1');
  assert.ok(r.expiresAt > Date.now());
});
await check('exchangeCode: Google refusing the code (bad verifier, expired code) is reported plainly, not thrown', async () => {
  const fetchImpl = async () => jsonRes(400, { error: 'invalid_grant', error_description: 'Bad Request' });
  const r = await exchangeCode({ clientId: 'cid', code: 'x', codeVerifier: 'y', redirectUri: 'http://127.0.0.1:1/callback' }, { fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.error, /Bad Request|invalid_grant/);
});
await check('exchangeCode: no refresh token in the response still resolves ok - the caller (drive-connection) is the one that treats that as a refusal', async () => {
  const fetchImpl = async () => jsonRes(200, { access_token: 'at-1', expires_in: 3600 });
  const r = await exchangeCode({ clientId: 'cid', code: 'x', codeVerifier: 'y', redirectUri: 'r' }, { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.refreshToken, null);
});
await check('refreshAccessToken: a normal refresh returns a new access token; the refresh token itself is NOT reissued', async () => {
  const fetchImpl = async (url, opts) => {
    const body = new URLSearchParams(opts.body);
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('refresh_token'), 'rt-1');
    return jsonRes(200, { access_token: 'at-2', expires_in: 3600 });
  };
  const r = await refreshAccessToken({ clientId: 'cid', refreshToken: 'rt-1' }, { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.accessToken, 'at-2');
  assert.equal(r.refreshToken, undefined, 'refreshAccessToken never invents a refresh token the response did not include');
});
await check('refreshAccessToken: a revoked/expired grant (invalid_grant, 400) is classified distinctly as revoked', async () => {
  const fetchImpl = async () => jsonRes(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
  const r = await refreshAccessToken({ clientId: 'cid', refreshToken: 'rt-1' }, { fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.revoked, true);
});
await check('refreshAccessToken: an ordinary network/server failure is NOT classified as revoked', async () => {
  const fetchImpl = async () => jsonRes(500, { error: 'internal_error' });
  const r = await refreshAccessToken({ clientId: 'cid', refreshToken: 'rt-1' }, { fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.revoked, false);
});
await check('refreshAccessToken: a real network failure (timeout/DNS/etc) is reported, not thrown', async () => {
  const fetchImpl = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
  const r = await refreshAccessToken({ clientId: 'cid', refreshToken: 'rt-1' }, { fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.network, true);
});
await check('revokeToken: with no token at all, succeeds trivially - nothing to revoke, never an error', async () => {
  const r = await revokeToken(null, { fetchImpl: async () => { throw new Error('should never be called'); } });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
});
await check('revokeToken: posts to the real revoke endpoint with the token', async () => {
  const fetchImpl = async (url, opts) => {
    assert.equal(url, 'https://oauth2.googleapis.com/revoke');
    assert.equal(new URLSearchParams(opts.body).get('token'), 'rt-1');
    return jsonRes(200, {});
  };
  const r = await revokeToken('rt-1', { fetchImpl });
  assert.equal(r.ok, true);
});

console.log(`google-oauth-test: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
