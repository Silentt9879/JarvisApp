// JARVIS Google Drive - Phase 2/5 (Decision 1): the app-owned OAuth path, so a nontechnical
// person can click "Connect Google Account" without ever creating a Google Cloud project or
// pasting a Client ID. See docs/phase2-google-login.md for exactly what still has to happen
// in Google's own console before this can be switched on for real users - registering an
// OAuth client and getting Google's verification for the non-sensitive drive.file scope is a
// manual, external, account-owning action nothing in this codebase can do on its own.
//
// Phase 5 hardening: the Client ID now comes from a BUILD-TIME config file
// (drive-app-client-config.json, shipped inside src/** by electron-builder's existing "files"
// list - no packaging change needed), not an environment variable a real user would somehow
// have to set. A production build ships with a real Client ID baked into that JSON file at
// build time by the maintainer, once Google verification is complete - at that point the
// app-owned path becomes available automatically, with NOTHING for an end user to configure,
// satisfying Phase 5 Task 2 directly. The checked-in default ships with an EMPTY id, so this
// changes nothing for any build until the maintainer deliberately fills it in.
//
// Two independent, still-preserved DEV overrides (the same JARVIS_CAPTURE-style convention
// main.mjs already uses for other dev-time switches), checked first so local testing never
// needs to touch the committed config file:
//   JARVIS_GOOGLE_CLIENT_ID=<id>   overrides the Client ID for this run only (dev/test)
//   JARVIS_DRIVE_APP_OWNED=0       force-disables the app-owned path even if a real Client ID
//                                  is configured (BYO-only), for QA testing that path
//                                  deliberately; JARVIS_DRIVE_APP_OWNED=1 is accepted too, as
//                                  an explicit no-op "yes" for anyone who set it under the
//                                  pre-Phase-5 convention - it is never REQUIRED any more.
//
// A Client ID is never a secret - google-oauth.mjs's own header, and Google's own developer
// documentation, agree a public/installed-app OAuth client cannot keep a secret confidential
// anyway (see docs/phase0-decision-review.md Decision 1) - so a plain, committed JSON file is
// an appropriate place for it; nothing here ever reads or sets a client SECRET for this path -
// the app-owned connection always passes an empty one through to the exact same
// drive-connection.mjs/google-oauth.mjs PKCE flow BYO-client already uses.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'drive-app-client-config.json');

function readBuildConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const id = raw?.googleDriveClientId;
    return typeof id === 'string' ? id.trim() : '';
  } catch { return ''; } // missing/corrupt config file: treated as "no id configured," never thrown
}

/** The env override wins when set (dev/test convenience); otherwise the build-time config
 *  file - the one a packaged, production build actually ships with. */
export function appOwnedClientId() {
  const envId = process.env.JARVIS_GOOGLE_CLIENT_ID;
  if (typeof envId === 'string' && envId.trim()) return envId.trim();
  const built = readBuildConfig();
  return built || null;
}

/** The dev-only kill switch: JARVIS_DRIVE_APP_OWNED=0 forces the app-owned path off even with
 *  a real Client ID configured, so BYO-only behavior stays testable on demand. Any other
 *  value (including the old "1", or unset) leaves availability decided by whether a real
 *  Client ID actually resolved - no environment variable is required to turn this ON. */
export function appOwnedLoginFlag() { return process.env.JARVIS_DRIVE_APP_OWNED !== '0'; }

/** Both gates must be open - the (not force-disabled) flag AND a real Client ID - before the
 *  app-owned, no-setup "Connect Google Account" path is offered at all. With the checked-in
 *  empty config and no env override (every build today), this is false and nothing about
 *  Drive's existing BYO-client flow changes in any way. */
export function appOwnedLoginAvailable() { return appOwnedLoginFlag() && !!appOwnedClientId(); }
