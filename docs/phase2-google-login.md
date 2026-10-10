# Phase 2 — Simple Google Login: what's built, and what still needs your action

Code-complete, **not** production-ready — see "What's still required" below. Nothing here is
reachable by a real user yet: the checked-in build-time config file ships with an **empty**
Client ID, so BYO-client (unchanged) remains the only path until you deliberately fill in a
real, Google-registered Client ID.

## What was built

A second way to connect Google Drive, reusing 100% of the existing PKCE/token-storage engine
(`src/google-oauth.mjs`, `src/drive-connection.mjs`, `src/drive-token.mjs`) — nothing about the
OAuth protocol, token encryption, or refresh logic was duplicated or changed:

- `src/drive-app-client.mjs` + `src/drive-app-client-config.json` (new; the config file
  revised in Phase 5 per Task 2 — see below): the Client ID now comes from a **build-time
  config file**, shipped inside `src/**` by electron-builder's existing `files` list (no
  packaging change needed) — not an environment variable, so **no end user, and no launch
  environment, ever needs to configure anything** for a production build to offer this path.
  **Not a secret** — Google's own guidance is that a public/installed-app client cannot keep a
  secret confidential anyway (confirmed in the existing `docs/jarvis-google-drive-design.md`
  §2-3), so committing it in a plain JSON file carries no confidentiality concern.
  - `src/drive-app-client-config.json`: `{ "googleDriveClientId": "" }` — fill this in, once
    (see the Google Cloud steps below), and every subsequently packaged build ships with it.
  - Dev overrides, preserved: `JARVIS_GOOGLE_CLIENT_ID=<id>` overrides the config file for a
    single local run (no need to edit the committed file while testing); `JARVIS_DRIVE_APP_OWNED=0`
    force-disables the app-owned path even with a real Client ID configured, for QA that wants
    to deliberately exercise the BYO-only path.
- `jarvis:driveAppOwnedStatus` / `jarvis:driveConnectAppOwned` (new IPC, `src/main.mjs`):
  `driveConnectAppOwned` takes **no arguments from the renderer** — it always calls
  `driveConnection.configureClient({ clientId: appOwnedClientId(), clientSecret: '' })` then
  the existing `driveConnection.connect()`, so a renderer can never substitute a different
  Client ID through this call. `driveAppOwnedStatus` never returns the Client ID itself, only
  `{ available }`.
- Renderer (`knowledge.js`/`index.html`): a "Connect Google Account" button, shown **only**
  when a real Client ID is actually configured, with an "Early/testing configuration" notice
  and an escape hatch ("Use my own Google Cloud Client ID instead") back to the unchanged
  BYO-client UI. With the checked-in empty config — the real state of every build today —
  this section never appears, and BYO-client's own UI is pixel-for-pixel what it was before
  this phase.

## Development/testing vs. production-ready — the explicit distinction requested

| | Development/testing (what exists now) | Production-ready (what still requires your action) |
|---|---|---|
| Client ID source | `JARVIS_GOOGLE_CLIENT_ID` env override, or a non-empty value written into `drive-app-client-config.json` for local testing | A **real** Client ID from a Google Cloud project you (or JARVIS's publisher) control, committed into `drive-app-client-config.json` |
| OAuth consent screen status | Testing mode (Google's default for an unverified client) | **Published/In production**, and verified for the `drive.file` scope |
| Refresh token lifetime | **Expires every 7 days** (Google's own Testing-mode policy) | No forced expiry |
| User cap | 100 test users max | No cap |
| Who can click "Connect Google Account" | Nobody, until the config file (or an env override) names a real Client ID | Any JARVIS user, automatically, once a verified Client ID ships in the packaged build |

**This code must never be presented to end users as "Google login" until the production
column above is actually true.** The gate is the Client ID itself: the checked-in config
ships empty, and turning this on for real users means deliberately committing a real,
verified Client ID into the build — never a UI toggle a user could stumble into, and never
something that depends on a launch-time environment variable being present on every machine.

## Exact steps required in Google's own console (external, manual, not something this
## session can do)

These require your own Google account and cannot be scripted or automated from here:

1. Create (or choose) a Google Cloud project you control, at console.cloud.google.com.
2. Enable the Google Drive API for that project.
3. Configure the OAuth consent screen:
   - User type: External (or Internal, if you'll restrict this to a Google Workspace org).
   - Scopes: `https://www.googleapis.com/auth/drive.file` only — Google's own documentation
     classifies this as "non-sensitive," requiring only **basic** verification (no security
     assessment), unlike broader Drive scopes.
   - App name, support email, logo, privacy policy URL (Google requires a reachable privacy
     policy page for anything beyond Testing status).
4. Create an OAuth 2.0 Client ID of type **Desktop app** (not Web, not Android/iOS — the
   loopback redirect flow this app already uses is specific to the Desktop type and is
   explicitly *not* subject to Google's loopback-deprecation notice for other client types).
5. Copy the Client ID (not the secret — a Desktop client's secret is not confidential and
   this app never uses one for this path).
6. Submit the consent screen for verification and request **Published** status. Expect
   Google's review to take real calendar time (historically days to a few weeks for a
   non-sensitive scope) — this is outside engineering's control and should be tracked as its
   own task, not assumed to complete by any particular date.
7. Once published and verified, edit `src/drive-app-client-config.json` and set
   `googleDriveClientId` to the real Client ID, then build/package normally - no environment
   variable, launch script, or installer change is needed; the value ships with the app the
   same way any other file under `src/**` already does.

Until step 6 completes, this code should stay exactly as it is today: present, tested, and
inert by default (the config file's `googleDriveClientId` stays `""`).

## Token expiry, disconnect, cancellation, and authorization errors

All already handled, unchanged, by the existing `drive-connection.mjs`/`google-oauth.mjs`
machinery this phase reuses rather than reimplements:

- **Expiry**: a refresh that comes back `invalid_grant` is classified `expired`, never a
  silent failure — `jarvis:driveStatus` reports it, and the UI offers "Reconnect."
- **Disconnect**: always clears the local token immediately, even if Google's own revoke
  call fails over the network — a connection this app still believed was usable is never left
  behind by a failed revoke.
- **Cancellation**: a closed browser tab / abandoned sign-in times out after 120 seconds
  (`connect({ timeoutMs: 120000 })`) and reports "Sign-in timed out" rather than hanging.
  `callback.error === 'cancelled'` is reported as "Sign-in was cancelled."
- **Authorization errors**: a mismatched `state` (a stale or replayed callback) is refused
  outright before any token exchange is attempted — the one security-critical check in the
  whole flow, unchanged by this phase.

## Test results

- `scripts/drive-app-client-test.mjs` (rewritten for Phase 5 Task 2): 8/8 passed — the
  checked-in default stays empty/unavailable, a build-time config id makes the path available
  with no environment variable, the dev env override takes priority, the `=0` kill switch
  force-disables even with a real id configured, the legacy `=1` convention still works as a
  no-op, and a missing/corrupt config file is treated as "not configured," never thrown.
- `scripts/drive-ipc-security-test.mjs` (extended): 14/14 passed — confirms
  `driveConnectAppOwned` takes no renderer-supplied Client ID/secret, and
  `driveAppOwnedStatus` never leaks the id itself.
- `scripts/knowledge-renderer-test.mjs` (extended): 96/96 passed — the new UI section's
  visibility, the one-click connect call, and the "use my own Client ID" escape hatch, all
  exercised through the real renderer code.
- Full `npm test`: exit code 0.

## Known limitations

- No real Google account or real Google Cloud project has been touched by this phase — by
  design, per the safety rules. The flow above has never been exercised against a real,
  published OAuth client; only against fakes and the existing drive-connection test fixtures.
- There is no UI for a developer to flip the feature flag from inside JARVIS itself (by
  design — it's an environment-gated build-time switch, not a user setting, so a real user
  can never accidentally turn on an unverified path).
- The "early/testing configuration" notice is static copy; it does not currently detect or
  display whether the configured client is specifically in Testing vs Published status (that
  information isn't available from the client ID alone — it would need an extra Google API
  call this phase does not add).
