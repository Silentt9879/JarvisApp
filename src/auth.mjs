/* Signing in and out of the Anthropic account, the way the editor does it: the account is
   shown in Settings, with one button beside it.

   Claude Code owns the credentials, not JARVIS - they live in its own config directory and
   are never read, copied or stored here. This file only drives three of its commands:

     claude auth status --json   what account is signed in (no secret in the output)
     claude auth logout          sign out
     claude auth login           sign in, which needs a browser and a terminal of its own

   Nothing here ever handles a token, so there is nothing to redact - but every error
   coming back is scrubbed anyway, in case a future version of the CLI prints one. */
import { execFile, spawn } from 'node:child_process';

const TIMEOUT = 20000;

/** Anything that looks like a key or a token, whatever the CLI printed around it. */
export const scrub = (s) => String(s ?? '')
  .replace(/sk-ant-[\w-]+/g, 'sk-ant-***')
  .replace(/\b(?:ey[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})\b/g, '***')
  .replace(/\b[A-Za-z0-9_-]{60,}\b/g, '***')
  .slice(0, 400);

/** Run one `claude auth ...` command. Resolves - never throws - with the plain output. */
function runAuth(exe, args, { timeoutMs = TIMEOUT } = {}) {
  return new Promise((resolve) => {
    execFile(exe, ['auth', ...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 }, (err, out, errOut) => {
      const stdout = String(out || '');
      const stderr = String(errOut || '');
      if (err && !stdout.trim()) resolve({ ok: false, error: scrub(stderr || err.message || 'The command failed.') });
      else resolve({ ok: true, stdout, stderr });
    });
  });
}

/** The fields worth showing, from `auth status --json`. Unknown shapes read as signed out. */
export function parseStatus(stdout) {
  let j = null;
  try { j = JSON.parse(String(stdout || '').trim()); } catch { return { loggedIn: false, unreadable: true }; }
  if (!j || typeof j !== 'object') return { loggedIn: false, unreadable: true };
  return {
    loggedIn: !!j.loggedIn,
    email: typeof j.email === 'string' ? j.email : null,
    orgName: typeof j.orgName === 'string' ? j.orgName : null,
    subscriptionType: typeof j.subscriptionType === 'string' ? j.subscriptionType : null,
    authMethod: typeof j.authMethod === 'string' ? j.authMethod : null,
    apiProvider: typeof j.apiProvider === 'string' ? j.apiProvider : null,
  };
}

/** Who is signed in. Read-only: this changes nothing. */
export async function authStatus(exe, { run = runAuth } = {}) {
  const r = await run(exe, ['status', '--json']);
  if (!r.ok) return { ok: false, loggedIn: false, error: r.error };
  return { ok: true, ...parseStatus(r.stdout) };
}

/** Sign out. Claude Code forgets the credentials; JARVIS never had them. */
export async function authLogout(exe, { run = runAuth } = {}) {
  const r = await run(exe, ['logout']);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true };
}

/**
 * Sign in. The CLI drives a browser and asks its own questions, so it is given a console
 * window of its own rather than being run hidden - a hidden login would simply hang with
 * nobody to answer it. JARVIS then watches `auth status` to see when it has worked.
 * No credential passes through this process.
 */
export function startLogin(exe, { spawnFn = spawn } = {}) {
  try {
    // cmd's own `start` opens the window; the inner cmd /k leaves it up afterwards, so a
    // refusal can be read instead of flashing past. Verbatim arguments: the paths and the
    // title are quoted here exactly as cmd expects them.
    const cmd = `start "JARVIS - sign in to Claude" cmd /k ""${exe}" auth login"`;
    const child = spawnFn('cmd.exe', ['/c', cmd], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true });
    child.unref?.();
    return { ok: true, started: true };
  } catch (e) {
    return { ok: false, error: scrub(e?.message || e) };
  }
}
