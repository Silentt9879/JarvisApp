// The workspace folder for the dev scripts - the same one the app uses.
//
// The scripts used to hardcode C:\Users\bantu\Downloads\BantuApps, which only exists on the
// machine they were written on; anywhere else `npm run smoke` failed before it began. This
// resolves the folder the way the app does, so a script and the window always agree:
//
//   1. JARVIS_CWD, for a one-off run against some other folder
//   2. `cwd` in %APPDATA%\JARVIS\config.json - what Settings -> Workspace writes
//   3. the app's built-in default
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_CWD = 'C:\\Users\\bantu\\Downloads\\BantuApps';

export function workspaceDir() {
  if (process.env.JARVIS_CWD) return process.env.JARVIS_CWD;
  try {
    const file = path.join(process.env.APPDATA || '', 'JARVIS', 'config.json');
    const cwd = JSON.parse(fs.readFileSync(file, 'utf8')).cwd;
    if (typeof cwd === 'string' && cwd) return cwd;
  } catch { /* no config yet: fall through to the default */ }
  return DEFAULT_CWD;
}

/** The folder, after checking it exists - a missing folder is a clear error, not a hang. */
export function requireWorkspace() {
  const cwd = workspaceDir();
  if (!fs.existsSync(cwd)) {
    console.error(`Workspace folder not found: ${cwd}\nSet it in JARVIS (Settings -> Workspace), or run with JARVIS_CWD=<folder>.`);
    process.exit(1);
  }
  return cwd;
}
