// The Telegram bot token: encrypted by Windows for this user, through Electron's own
// safeStorage - the same mechanism and file format as the GitHub token (updates.mjs's
// saveToken/loadToken/clearToken, which this module reuses rather than re-implementing).
//
// An install from before this encryption existed kept the token in config.json's
// phone.telegram.token as plain text. telegramTokenField() decides, on every save, whether
// that field should still hold a copy - only for as long as there is no working encrypted
// one to rely on instead, so a PC where Windows cannot encrypt right now (or ever) never
// loses phone alerts or remote control over it. migrateTelegramToken() moves an existing
// plain-text token across once, and never deletes it until the encrypted copy is confirmed
// written - a PC that cannot encrypt right now, or a save that throws partway through, is
// left exactly as it was, still working from the plain-text field.
import fs from 'node:fs';
import { saveToken, loadToken, clearToken } from './updates.mjs';
import { isToken } from './telegram.mjs';

/** The resolved token phoneConfig() should use: the encrypted copy, else a legacy plain-text value, else null. */
export function resolveTelegramToken(file, safe, legacyToken) {
  return loadToken(file, { safe }) || (isToken(legacyToken) ? legacyToken : null);
}

/**
 * The `telegram.token` field for the next config.json save - the one place that decides
 * whether the token is written there at all.
 *
 *   wanted  a new token to set, `null` to clear it, or `undefined` to leave it as it is
 *
 * Saves or clears the encrypted copy as a side effect. Returns `undefined` so the key is
 * left out of config.json entirely (`JSON.stringify` drops an `undefined` value) once an
 * encrypted copy is the source of truth; returns the plain token only when there is
 * genuinely no working encrypted copy to rely on instead, so an unrelated save (ticking
 * some other switch) can never silently drop a token that has nowhere else to live yet.
 */
export function telegramTokenField(file, safe, wanted, legacyToken, { log = () => {} } = {}) {
  if (wanted === null) {
    try { clearToken(file); } catch { /* best effort - config.json is cleared either way */ }
    return undefined;
  }
  if (wanted !== undefined) {
    try { saveToken(file, wanted, { safe }); return undefined; }
    catch (e) {
      log('could not encrypt the Telegram token on this PC; keeping it in config.json instead:', e?.message || e);
      return wanted;
    }
  }
  // Nothing new being set: keep whatever already works, and nothing more. An encrypted copy
  // covers it on its own; only a legacy plain-text one still needs carrying forward.
  if (loadToken(file, { safe })) return undefined;
  return isToken(legacyToken) ? legacyToken : undefined;
}

/**
 * Move an older install's plain-text token into the encrypted store, once. Returns true if
 * it migrated (the caller should then re-save config.json with the field left out), false
 * if there was nothing to do or it could not be encrypted right now.
 */
export function migrateTelegramToken(file, safe, legacyToken, { log = () => {} } = {}) {
  if (fs.existsSync(file) || !isToken(legacyToken)) return false;
  try { saveToken(file, legacyToken, { safe }); return true; }
  catch (e) { log('Telegram token migration: could not encrypt it yet, keeping the plain-text copy:', e?.message || e); return false; }
}
