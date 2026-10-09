// JARVIS Knowledge - Phase 24C: encrypted storage for Google Drive OAuth state. Two separate
// encrypted files, not one, so a Client ID/secret (configured once, rarely changed) and the
// actual tokens (replaced on every connect/refresh) never share a write:
//   - the OAuth client credentials (clientId, clientSecret for a dev-configured client)
//   - the access/refresh tokens from a completed sign-in
//
// Reuses updates.mjs's saveToken/loadToken/clearToken verbatim - the same encrypted-file
// primitive the GitHub token and the Telegram bot token already use - rather than inventing a
// second one. Unlike phone-token.mjs's Telegram token, there is no plaintext fallback here:
// saveToken() already throws if safeStorage is unavailable (see updates.mjs), and every
// function below lets that failure surface as a plain refusal rather than catching it and
// writing anywhere in the clear. This is deliberate: a Drive token reaches a person's real
// files, not just a Telegram chat, so this phase fails closed instead of degrading.
import { saveToken, loadToken, clearToken } from './updates.mjs';

/** { clientId, clientSecret } for a dev-configured Google OAuth client, or null. */
export function loadDriveClient(file, safe) {
  const raw = loadToken(file, { safe });
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v.clientId !== 'string' || !v.clientId) return null;
    return { clientId: v.clientId, clientSecret: typeof v.clientSecret === 'string' ? v.clientSecret : '' };
  } catch { return null; }
}

/** Throws if this PC cannot encrypt right now - callers must not catch-and-fall-back-to-plaintext. */
export function saveDriveClient(file, safe, { clientId, clientSecret = '' }) {
  if (typeof clientId !== 'string' || !clientId.trim()) throw new Error('A Client ID is required.');
  saveToken(file, JSON.stringify({ clientId: clientId.trim(), clientSecret: clientSecret.trim() }), { safe });
}

export function clearDriveClient(file) { clearToken(file); }

/** { accessToken, refreshToken, expiresAt, scope } for the signed-in account, or null. */
export function loadDriveTokens(file, safe) {
  const raw = loadToken(file, { safe });
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v.accessToken !== 'string' || !v.accessToken) return null;
    return {
      accessToken: v.accessToken,
      refreshToken: typeof v.refreshToken === 'string' ? v.refreshToken : null,
      expiresAt: Number(v.expiresAt) || 0,
      scope: typeof v.scope === 'string' ? v.scope : '',
    };
  } catch { return null; }
}

/** Throws if this PC cannot encrypt right now. */
export function saveDriveTokens(file, safe, tokens) {
  const { accessToken, refreshToken = null, expiresAt, scope = '' } = tokens || {};
  if (typeof accessToken !== 'string' || !accessToken) throw new Error('No access token to save.');
  saveToken(file, JSON.stringify({ accessToken, refreshToken, expiresAt: Number(expiresAt) || 0, scope }), { safe });
}

export function clearDriveTokens(file) { clearToken(file); }
