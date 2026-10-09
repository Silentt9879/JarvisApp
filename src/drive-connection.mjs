// JARVIS Knowledge - Phase 24C: connection management ONLY - no backup/restore is triggered
// from here or exposed through it. This ties google-oauth.mjs (the protocol) and
// drive-token.mjs (encrypted storage) together into the five calls main.mjs's IPC layer
// needs: configureClient, connect, disconnect, status, and getAccessToken (for Phase 24C's
// real Drive provider to call - never for a renderer to see).
//
// Never opens a browser, starts a listener, or refreshes a token on its own: every one of
// those only happens inside a call this module's caller makes explicitly, by name. There is
// no timer, no startup hook, and no implicit auto-reconnect anywhere in this file.
import {
  generatePkce, generateState, buildAuthUrl, startLoopbackListener,
  exchangeCode as exchangeCodeDefault, refreshAccessToken as refreshAccessTokenDefault, revokeToken as revokeTokenDefault,
} from './google-oauth.mjs';
import {
  loadDriveClient, saveDriveClient, loadDriveTokens, saveDriveTokens, clearDriveTokens,
} from './drive-token.mjs';

// An access token is refreshed a little before it would actually expire, so a slow upload
// started just before the real deadline never gets cut off mid-call.
const REFRESH_SKEW_MS = 60_000;

export function createDriveConnection({
  tokenFile, clientFile, safeStorage, log = () => {}, now = () => Date.now(),
  openExternal, // (url) => Promise<void> - the system browser; main.mjs supplies shell.openExternal
  startLoopback = startLoopbackListener,
  exchangeCode = exchangeCodeDefault,
  refreshAccessToken = refreshAccessTokenDefault,
  revokeToken = revokeTokenDefault,
}) {
  // In-memory only, and only for UI feedback between calls in THIS run - never persisted, so
  // a restart always re-derives the real state fresh from what's actually on disk.
  let lastError = null; // { kind: 'expired' | 'error', message }

  function client() { return loadDriveClient(clientFile, safeStorage); }

  function configureClient({ clientId, clientSecret }) {
    try { saveDriveClient(clientFile, safeStorage, { clientId, clientSecret }); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e?.message || e) }; }
  }

  /** Synchronous, cheap, safe to call often (e.g. for a UI status pill) - never touches the network. */
  function status() {
    const c = client();
    if (!c) return { status: 'disconnected', reason: 'No Google OAuth Client ID is configured yet.' };
    const t = loadDriveTokens(tokenFile, safeStorage);
    if (!t) return { status: 'disconnected' };
    if (lastError?.kind === 'expired') return { status: 'expired', reason: lastError.message };
    if (lastError?.kind === 'error') return { status: 'error', reason: lastError.message };
    return { status: 'connected' };
  }

  /**
   * The full sign-in flow: PKCE + state, a one-shot loopback listener, the system browser
   * (never an in-app one), the callback validated against the exact state this run generated,
   * then the code exchanged for tokens - which are the only thing ever written to disk, via
   * drive-token.mjs's fail-closed save. Never logs the authorization code, the tokens, or the
   * full callback URL - only this function ever sees them, for the moment it takes to encrypt
   * and store them.
   */
  async function connect({ timeoutMs = 120_000 } = {}) {
    const c = client();
    if (!c) return { ok: false, error: 'Configure a Google OAuth Client ID first.' };
    if (typeof openExternal !== 'function') return { ok: false, error: 'No way to open a browser on this PC.' };

    const pkce = generatePkce();
    const state = generateState();
    let listener;
    try { listener = await startLoopback({ timeoutMs }); }
    catch (e) { return { ok: false, error: `Could not start the sign-in listener: ${e?.message || e}` }; }

    const url = buildAuthUrl({ clientId: c.clientId, redirectUri: listener.redirectUri, state, codeChallenge: pkce.challenge });
    try { await openExternal(url); }
    catch (e) { listener.close(); return { ok: false, error: `Could not open a browser: ${e?.message || e}` }; }

    const callback = await listener.waitForCallback();
    if (!callback.ok) {
      const msg = callback.error === 'timeout' ? 'Sign-in timed out - nothing was connected.'
        : callback.error === 'cancelled' ? 'Sign-in was cancelled.'
          : `Google refused sign-in: ${callback.error}`;
      return { ok: false, error: msg };
    }
    // The one security-critical check in this whole flow: a callback for a DIFFERENT run (a
    // stale browser tab, a replay, anything not started by THIS call) is refused outright.
    if (callback.state !== state) return { ok: false, error: 'The sign-in response did not match this request - refused.' };

    const r = await exchangeCode({ clientId: c.clientId, clientSecret: c.clientSecret, code: callback.code, codeVerifier: pkce.verifier, redirectUri: listener.redirectUri });
    if (!r.ok) return { ok: false, error: r.error || 'Could not complete sign-in.' };
    if (!r.refreshToken) return { ok: false, error: 'Google did not offer a refresh token this time - try disconnecting any prior grant for this app at myaccount.google.com/permissions and reconnecting.' };

    try { saveDriveTokens(tokenFile, safeStorage, { accessToken: r.accessToken, refreshToken: r.refreshToken, expiresAt: r.expiresAt, scope: r.scope }); }
    catch (e) { return { ok: false, error: String(e?.message || e) }; }
    lastError = null;
    log('Google Drive connected');
    return { ok: true, status: 'connected' };
  }

  /** Best-effort revoke at Google's end; the LOCAL copy is cleared either way - a network
   *  failure during revoke must never leave a token this app still believes is usable. */
  async function disconnect() {
    const t = loadDriveTokens(tokenFile, safeStorage);
    if (t?.refreshToken) { try { await revokeToken(t.refreshToken); } catch (e) { log('Drive token revoke:', e?.message || e); } }
    clearDriveTokens(tokenFile);
    lastError = null;
    return { ok: true, status: 'disconnected' };
  }

  /**
   * A usable access token for the real Drive provider to call with - refreshed first if it's
   * due to expire within the skew window. Never returns a token known to be stale. On a
   * revoked/expired grant, marks status() as 'expired' from here on (until a fresh connect())
   * rather than silently returning nothing with no explanation.
   */
  async function getAccessToken() {
    const c = client();
    if (!c) return { ok: false, error: 'Not connected.' };
    const t = loadDriveTokens(tokenFile, safeStorage);
    if (!t) return { ok: false, error: 'Not connected.' };
    if (t.expiresAt - REFRESH_SKEW_MS > now()) return { ok: true, accessToken: t.accessToken };

    const r = await refreshAccessToken({ clientId: c.clientId, clientSecret: c.clientSecret, refreshToken: t.refreshToken });
    if (!r.ok) {
      if (r.revoked) { lastError = { kind: 'expired', message: 'Google Drive access was revoked or expired - reconnect to continue.' }; }
      else { lastError = { kind: 'error', message: r.error || 'Could not refresh the Google Drive connection.' }; }
      return { ok: false, error: lastError.message, revoked: !!r.revoked };
    }
    try { saveDriveTokens(tokenFile, safeStorage, { accessToken: r.accessToken, refreshToken: t.refreshToken, expiresAt: r.expiresAt, scope: r.scope || t.scope }); }
    catch (e) { return { ok: false, error: String(e?.message || e) }; }
    lastError = null;
    return { ok: true, accessToken: r.accessToken };
  }

  return { configureClient, getClient: client, status, connect, disconnect, getAccessToken };
}
