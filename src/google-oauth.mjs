// JARVIS Knowledge - Phase 24C: Google OAuth 2.0 for a desktop app, Authorization Code +
// PKCE, against a loopback redirect - no Electron, no renderer, no real network call unless
// the caller supplies a real `fetch`. Every HTTP call and every random value is injectable, so
// tests exercise the real logic (PKCE math, state comparison, token-response parsing, retry/
// backoff) without ever reaching accounts.google.com.
//
// Reverified against Google's own current documentation for this phase (not assumed from
// memory): the out-of-band ("copy this code") flow is retired - loopback is the only
// supported desktop redirect today, as http://127.0.0.1:<port> or http://[::1]:<port> with a
// per-run random port; PKCE (RFC 7636, S256) is supported end to end; the installed-app
// "client secret" Google issues is not treated as confidential by Google itself, but this
// module still only ever holds it encrypted, never in config.json, matching every other
// credential this app keeps (see drive-token.mjs).
import http from 'node:http';
import crypto from 'node:crypto';

export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
// drive.file: only files/folders this app itself creates or the user explicitly opens with
// it - never blanket access to the person's whole Drive. The minimum scope this phase needs.
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

const base64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A fresh PKCE pair: a 32-byte random verifier and its S256 challenge (RFC 7636 §4.1-4.2). */
export function generatePkce({ randomBytes = crypto.randomBytes } = {}) {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

/** A fresh, unguessable state value - compared byte-for-byte against whatever the loopback
 *  callback actually receives, so a request from anywhere else is refused outright. */
export function generateState({ randomBytes = crypto.randomBytes } = {}) {
  return base64url(randomBytes(24));
}

/** The URL to open in the person's own system browser - never an in-app/embedded one. */
export function buildAuthUrl({ clientId, redirectUri, scope = DRIVE_SCOPE, state, codeChallenge }) {
  if (!clientId) throw new Error('No Google OAuth Client ID is configured.');
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline', // a refresh token, not just a short-lived access token
    prompt: 'consent', // re-asks every time, so a refresh token is issued even on a reconnect
  });
  return `${AUTH_ENDPOINT}?${q.toString()}`;
}

/**
 * A one-shot HTTP server on a random loopback port: it answers exactly one request (Google's
 * redirect), extracts `code`/`state`/`error` from the query string, shows a plain "you can
 * close this tab" page, and closes itself - either on that first request, on `timeoutMs`
 * (default 2 minutes - long enough for a real sign-in, never left open indefinitely), or on
 * `.close()`. Never logs the callback URL (it can carry the authorization code).
 */
export function startLoopbackListener({ timeoutMs = 120_000, host = '127.0.0.1', createServer = http.createServer } = {}) {
  return new Promise((resolveListen, rejectListen) => {
    let closed = false;
    let timer = null;
    let pendingResult = null; // set if the callback (or a timeout/close) lands before waitForCallback() is called
    let settleWait = null;    // the resolver of an already-pending waitForCallback() promise

    const finish = (result) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      if (settleWait) { const s = settleWait; settleWait = null; server.close(() => s(result)); }
      else { pendingResult = result; server.close(); }
    };

    const server = createServer((req, res) => {
      let parsed;
      try { parsed = new URL(req.url, `http://${host}`); } catch { res.writeHead(400).end('Bad request.'); return; }
      if (parsed.pathname !== '/callback') { res.writeHead(404).end('Not found.'); return; }
      const code = parsed.searchParams.get('code');
      const state = parsed.searchParams.get('state');
      const error = parsed.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(error
        ? '<html><body>Sign-in was cancelled or refused. You can close this tab and go back to JARVIS.</body></html>'
        : '<html><body>Signed in. You can close this tab and go back to JARVIS.</body></html>');
      finish(error ? { ok: false, error } : { ok: true, code, state });
    });
    server.on('error', (e) => rejectListen(e));
    server.listen(0, host, () => {
      const { port } = server.address();
      timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs);
      resolveListen({
        port,
        redirectUri: `http://${host}:${port}/callback`,
        // Resolves once a request lands, the timeout fires, or close() is called early -
        // whichever happens first. Safe to call any time, before or after that happens.
        waitForCallback: () => new Promise((res) => { if (pendingResult) res(pendingResult); else settleWait = res; }),
        close: () => finish({ ok: false, error: 'cancelled' }),
      });
    });
  });
}

function tokenBody(params) {
  return new URLSearchParams(params).toString();
}

async function postForm(url, params, { fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { ok: false, network: true, error: e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timed out' : String(e?.message || e) };
  }
  let json = null;
  try { json = await res.json(); } catch { /* not JSON, or empty */ }
  if (!res.ok) return { ok: false, status: res.status, errorCode: json?.error || null, error: json?.error_description || json?.error || `HTTP ${res.status}` };
  return { ok: true, json };
}

/** Authorization code -> tokens. Never logs `code` or the response body - only the caller
 *  (drive-token.mjs) ever sees the access/refresh tokens, and only to encrypt them at once. */
export async function exchangeCode({ clientId, clientSecret, code, codeVerifier, redirectUri }, opts = {}) {
  const r = await postForm(TOKEN_ENDPOINT, {
    client_id: clientId, client_secret: clientSecret || '', code, code_verifier: codeVerifier,
    redirect_uri: redirectUri, grant_type: 'authorization_code',
  }, opts);
  if (!r.ok) return r;
  const { access_token, refresh_token, expires_in, scope, token_type } = r.json;
  if (!access_token) return { ok: false, error: 'No access token in the response.' };
  return { ok: true, accessToken: access_token, refreshToken: refresh_token || null, expiresAt: Date.now() + (Number(expires_in) || 3600) * 1000, scope, tokenType: token_type };
}

/** Refresh token -> a new access token. Google does not reissue the refresh token itself on
 *  a normal refresh - the caller keeps the one it already has. */
export async function refreshAccessToken({ clientId, clientSecret, refreshToken }, opts = {}) {
  const r = await postForm(TOKEN_ENDPOINT, {
    client_id: clientId, client_secret: clientSecret || '', refresh_token: refreshToken, grant_type: 'refresh_token',
  }, opts);
  if (!r.ok) {
    // Google reports a revoked/expired refresh token as invalid_grant.
    const revoked = r.status === 400 && r.errorCode === 'invalid_grant';
    return { ...r, revoked };
  }
  const { access_token, expires_in, scope, token_type } = r.json;
  if (!access_token) return { ok: false, error: 'No access token in the response.' };
  return { ok: true, accessToken: access_token, expiresAt: Date.now() + (Number(expires_in) || 3600) * 1000, scope, tokenType: token_type };
}

/** Best-effort revoke at Google's end, on disconnect. A network failure here never blocks
 *  clearing the LOCAL copy - the caller clears local storage regardless of this result. */
export async function revokeToken(token, opts = {}) {
  if (!token) return { ok: true, skipped: true };
  const r = await postForm(REVOKE_ENDPOINT, { token }, opts);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}
