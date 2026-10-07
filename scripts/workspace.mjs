// The workspace folder for the dev scripts - the same one the app uses.
//
// Resolved the way the app resolves it (src/workspaces.mjs), so a script and the window
// always agree:
//
//   1. JARVIS_CWD, for a one-off run against some other folder
//   2. the active workspace in %APPDATA%\JARVIS\config.json (Settings -> Workspaces)
//
// There is no built-in default: with neither, a script says so and stops.
import fs from 'node:fs';
import path from 'node:path';
import { normalizeWorkspaces } from '../src/workspaces.mjs';

function active() {
  try {
    const file = path.join(process.env.APPDATA || '', 'JARVIS', 'config.json');
    const n = normalizeWorkspaces(JSON.parse(fs.readFileSync(file, 'utf8')));
    return { path: n.activePath, trusted: !!n.workspaces.find((w) => w.id === n.activeWorkspaceId)?.trusted };
  } catch {
    return null; // no config yet
  }
}

export function workspaceDir() {
  if (process.env.JARVIS_CWD) return process.env.JARVIS_CWD;
  return active()?.path || null;
}

/**
 * Whether JARVIS trusts that folder (Settings -> Workspaces), so a script loads its .claude
 * hooks, MCP servers and agents only when the app would. A JARVIS_CWD folder is trusted only
 * with JARVIS_TRUST=1.
 */
export function workspaceTrusted() {
  if (process.env.JARVIS_CWD) return process.env.JARVIS_TRUST === '1';
  return !!active()?.trusted;
}

/** The folder, after checking it exists - a missing folder is a clear error, not a hang. */
export function requireWorkspace() {
  const cwd = workspaceDir();
  if (!cwd || !fs.existsSync(cwd)) {
    console.error(`${cwd ? `Workspace folder not found: ${cwd}` : 'No workspace is set up.'}\nChoose one in JARVIS (Settings -> Workspaces), or run with JARVIS_CWD=<folder>.`);
    process.exit(1);
  }
  return cwd;
}
