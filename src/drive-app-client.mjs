// JARVIS Google Drive - Phase 2 (Decision 1): the app-owned OAuth path, so a nontechnical
// person can click "Connect Google Account" without ever creating a Google Cloud project or
// pasting a Client ID. See docs/phase2-google-login.md for exactly what still has to happen
// in Google's own console before this can be switched on for real users - registering an
// OAuth client and getting Google's verification for the non-sensitive drive.file scope is a
// manual, external, account-owning action nothing in this codebase can do on its own.
//
// Two independent gates, both environment-driven - the same JARVIS_CAPTURE-style convention
// main.mjs already uses for other build/dev-time switches - so shipping this file changes
// NOTHING for an existing install until both are deliberately set:
//   JARVIS_DRIVE_APP_OWNED=1          the feature flag itself (code-complete, not yet offered)
//   JARVIS_GOOGLE_CLIENT_ID=<id>      the app's own (non-secret) OAuth Client ID
//
// A Client ID is never a secret - google-oauth.mjs's own header, and Google's own developer
// documentation, agree a public/installed-app OAuth client cannot keep a secret confidential
// anyway (see docs/phase0-decision-review.md Decision 1) - so reading it from an environment
// variable is about deployment convenience, never about protecting a value that needs
// protecting the way a token or password would. Nothing here ever reads or sets a client
// SECRET for this path - the app-owned connection always passes an empty one through to the
// exact same drive-connection.mjs/google-oauth.mjs PKCE flow BYO-client already uses.
export function appOwnedLoginFlag() { return process.env.JARVIS_DRIVE_APP_OWNED === '1'; }

export function appOwnedClientId() {
  const v = process.env.JARVIS_GOOGLE_CLIENT_ID;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Both gates must be open - the flag AND a real Client ID - before the app-owned,
 *  no-setup "Connect Google Account" path is offered at all. Absent either, this is false
 *  and nothing about Drive's existing BYO-client flow changes in any way. */
export function appOwnedLoginAvailable() { return appOwnedLoginFlag() && !!appOwnedClientId(); }
