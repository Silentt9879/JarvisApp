# Phase 6 Task 3 — Google OAuth Production Checklist

**Current status of this build: unverified, inactive, and safe.** `src/drive-app-client-config.json`
ships with `"googleDriveClientId": ""` — the app-owned "Connect Google Account" path does not
appear in the UI, and no unverified OAuth configuration is active in this (or any) build. This
document is a checklist for *you* to execute in Google's own console; nothing in it has been
done on your behalf, no credentials have been invented, and no verification is claimed to
have occurred.

## What this session can and cannot do

**Cannot do** (requires your Google account, your payment/identity verification where
applicable, and your own judgment calls about branding/support contact):
- Create or choose a Google Cloud project.
- Fill in the OAuth consent screen's business/contact/branding details.
- Host a privacy policy page.
- Click "Submit for verification."
- Receive or act on Google's review correspondence.

**Can do** (already done, in Phase 2/5): build and test the entire OAuth code path against
fakes; make the Client ID field a one-line build-time edit with no other code change needed
once you complete the steps below.

## Exact steps, in order

### 1. Google Cloud project
Go to [console.cloud.google.com](https://console.cloud.google.com). Create a new project (or
choose an existing one you control) dedicated to JARVIS, or clearly named within a larger
project. Note the project name/ID for your own records.

### 2. Enable the Drive API
Within that project: **APIs & Services → Library → Google Drive API → Enable**.

### 3. Privacy policy
Google **requires** a reachable, real privacy policy URL for any OAuth consent screen beyond
Testing status. This needs to:
- Be hosted somewhere you control (a page on JARVIS's own site/repo README/GitHub Pages — any
  stable, public URL).
- Accurately describe what JARVIS's Drive integration actually does: it requests the
  `drive.file` scope only (access limited to files the app itself creates — never your
  existing Drive contents), stores an encrypted OAuth token locally on the user's own machine
  (never transmitted to JARVIS's developer or any third party), and is used solely for the
  user's own backup/sync of their own Notes.
- This document does not draft that page for you, since its accuracy is a representation you
  are making to Google and to your users — but the factual claims above are accurate as of
  this codebase (`docs/jarvis-google-drive-design.md`, `docs/phase2-google-login.md`).

### 4. OAuth consent screen configuration
**APIs & Services → OAuth consent screen**:
- **User type**: External (unless you specifically want to restrict this to a Google
  Workspace organization you control, in which case Internal).
- **App name**: something clearly identifying JARVIS.
- **Support email**: an email you monitor.
- **App logo**: optional but recommended for user trust during consent.
- **Scopes**: add exactly `https://www.googleapis.com/auth/drive.file` — **no other scope**.
  Google classifies this as **non-sensitive**, requiring only basic verification (no security
  assessment, no CASA audit) — confirmed against Google's current scope documentation in
  `docs/jarvis-google-drive-design.md` §2 and re-confirmed in `docs/phase2-google-login.md`.
- **Authorized domains**: the domain hosting your privacy policy.
- **Privacy policy URL**: the page from step 3.

### 5. OAuth 2.0 Client ID
**APIs & Services → Credentials → Create Credentials → OAuth client ID**:
- **Application type**: **Desktop app** — not Web, not Android, not iOS. This is the type
  this codebase's loopback-redirect PKCE flow (`src/google-oauth.mjs`) is built for, and the
  one type Google's own loopback-deprecation notice explicitly does **not** apply to.
- Name it something identifiable (e.g. "JARVIS Desktop - Production").
- Copy the **Client ID** (a string ending in `.apps.googleusercontent.com`). Do **not** copy
  or save a client secret for this — a Desktop app's secret is not confidential per Google's
  own guidance, and this codebase's OAuth flow never uses one (`clientSecret: ''` always, for
  this path).

### 6. Submit for verification
Back on the OAuth consent screen, submit for verification and request **Published** status.
Google's review for a non-sensitive scope has historically taken days to a few weeks — this
is **entirely outside engineering's control**; track it as its own external task with its own
timeline, not something to assume completes by a target release date.

### 7. Only once Published/verified: activate it in the codebase
Edit `src/drive-app-client-config.json`:
```json
{ "googleDriveClientId": "YOUR_REAL_CLIENT_ID.apps.googleusercontent.com" }
```
Commit that one-line change, then build/package normally. No environment variable, no
installer change, no other code change is needed — this is the single activation point.

## Explicit non-actions (what this checklist will never do without your separate say)

- This session will never mark this checklist "complete" on your behalf, never fabricate a
  Client ID, and never flip `drive-app-client-config.json` away from its empty default without
  you explicitly providing a real, verified Client ID to use.
- This session will never claim "Google verification succeeded" — only you, reading Google's
  own correspondence, know that.
- No unverified OAuth configuration will be activated in a build intended for public/general
  release. If you want to test the app-owned flow yourself *before* verification completes,
  that is a Testing-mode exercise (100-user cap, 7-day refresh-token expiry — both already
  documented in `docs/phase2-google-login.md`) using your own test Client ID via the
  `JARVIS_GOOGLE_CLIENT_ID` dev override, never the committed production config file.

## Status tracking (fill in as you progress)

| Step | Status |
|---|---|
| 1. Cloud project created | Not started |
| 2. Drive API enabled | Not started |
| 3. Privacy policy hosted | Not started |
| 4. Consent screen configured | Not started |
| 5. Client ID created | Not started |
| 6. Submitted for verification | Not started |
| 7. Published/verified, config updated | Not started |

This table is yours to update; nothing in this codebase reads or depends on it.
