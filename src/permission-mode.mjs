// Which permission mode a JARVIS chat starts in.
//
// The window used to hard-code 'default' (ask before every tool), so a user whose own
// Claude Code settings say `"defaultMode": "auto"` still got ask mode in every new or
// resumed chat (user, 2026-10-06). A chat now starts in the mode the USER chose in their
// own settings - the same files, in the same order, that Claude Code reads (local, then
// project, then user) - and the window's rule still holds: never bypassPermissions,
// whatever a settings file says. Nothing here writes a setting; it only reads the user's.
//
// Only the chat session uses this. The locked-down background queries (Git assist, the
// ClickUp fetch, diagnostics) keep 'default' on purpose: their tool allowlists are enforced
// in canUseTool, and a looser mode must never widen them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The modes the window offers. Deliberately no bypassPermissions. */
export const WINDOW_MODES = ['default', 'acceptEdits', 'plan', 'auto'];

/** permissions.defaultMode from one settings file, or null if the file does not set it. */
function readMode(file) {
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    const m = json && json.permissions && json.permissions.defaultMode;
    return typeof m === 'string' && m.trim() ? m.trim() : null;
  } catch {
    return null; // missing, unreadable or not JSON: not set there
  }
}

/**
 * The mode a new or resumed chat starts in, and where it came from.
 * `asked` is what the settings said; `mode` is what the window will use (they differ only
 * when a settings file asks for a mode the window does not allow).
 */
export function startingMode(cwd, { home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude') } = {}) {
  const files = [
    cwd ? path.join(cwd, '.claude', 'settings.local.json') : null,
    cwd ? path.join(cwd, '.claude', 'settings.json') : null,
    path.join(home, 'settings.json'),
  ].filter(Boolean);
  for (const from of files) {
    const asked = readMode(from);
    if (asked) return { mode: WINDOW_MODES.includes(asked) ? asked : 'default', asked, from };
  }
  return { mode: 'default', asked: null, from: null };
}
