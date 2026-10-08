// Coverage for the chat IPC boundary in src/main.mjs - the routing/gating layer ABOVE
// JarvisSession, which session-test.mjs already covers behaviorally (send, interrupt,
// permission responses of every shape, permission-mode forwarding, session switching, rewind,
// recovery, and that a stale/closed generation can never be approved).
//
// main.mjs itself cannot be imported and driven outside Electron - it creates a real `app`,
// real BrowserWindows and reads real paths the moment it loads. So THIS file is honestly a
// wiring test: every assertion reads main.mjs's own source to confirm the routing/gating
// shape is exactly right (which session a call reaches, what is checked before it reaches
// one, in what order). It does not spend an API token or open a window, and it does not
// claim to be a behavioral test of main.mjs itself - only of the real session logic
// (session-test.mjs) and the real pane-closing logic (pane-windows-test.mjs) that main.mjs's
// handlers are shown here to actually call.
//   node scripts/main-chat-ipc-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${extra ? `\n     ${extra}` : ''}`); } };
const check = (name, fn) => { try { fn(); ok(true, name); } catch (e) { ok(false, name, String(e.stack || e).slice(0, 400)); } };

const main = fs.readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8');
const handler = (channel) => {
  const re = new RegExp(`ipcMain\\.handle\\('${channel.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}', [^\\n]*(?:\\n[^\\n]*)*?\\n\\}\\);`);
  const m = re.exec(main);
  if (m) return m[0];
  // Single-line handlers (an arrow expression, no body braces) end at the first `);` on the line.
  const start = main.indexOf(`ipcMain.handle('${channel}'`);
  if (start < 0) return null;
  const end = main.indexOf(');', start);
  return main.slice(start, end + 2);
};

// ------------------------------------------------------------------ send / interrupt
check('send: goes through sessionFor(e) - the caller\'s OWN session, main or pane, never a hardcoded one', () => {
  const h = handler('jarvis:send');
  assert.ok(h, 'jarvis:send handler found');
  assert.match(h, /submitMessage\(payload, _e\)/, 'the event is passed through, so submitMessage can resolve the right session itself');
  const submit = /function submitMessage\(payload, e = null\) \{([\s\S]{0,1200}?)\n\}/.exec(main)?.[1] || '';
  assert.match(submit, /sessionFor\(e\)\.send\(/, 'submitMessage ultimately sends through sessionFor(e), not the main session unconditionally');
});
check('send: "Power down" typed at the desk is caught before it ever reaches a session - never run as a prompt', () => {
  const h = handler('jarvis:send');
  assert.match(h, /isPowerDown\(payload\?\.text, phoneConfig\(\)\.telegram\.pcName\)/);
  assert.match(h, /powerDown\('desk'\)/);
  // The check happens BEFORE submitMessage is ever reached for that payload.
  const powerDownIdx = h.indexOf('powerDown(');
  const submitIdx = h.indexOf('submitMessage(');
  assert.ok(powerDownIdx > 0 && submitIdx > powerDownIdx, 'the power-down branch returns before falling through to submitMessage');
});
check('send: a Telegram-originated message is never caught as "Power down" at the desk\'s own shortcut - remote.mjs already handles that word itself', () => {
  const h = handler('jarvis:send');
  assert.match(h, /payload\?\.origin !== 'telegram'/);
});
check('interrupt: sessionFor(e).interrupt() - the sender\'s own session, not every session at once', () => {
  assert.match(main, /ipcMain\.handle\('jarvis:interrupt', \(_e\) => sessionFor\(_e\)\.interrupt\(\)\);/);
});
check('interruptAll(): used by the one place that really does mean "every window at once" (Telegram\'s /stop, not a per-window button)', () => {
  const body = /function interruptAll\(\) \{([\s\S]*?)\n\}/.exec(main)?.[1] || '';
  assert.match(body, /session\?\.interrupt\(\)/);
  assert.match(body, /paneSessions\.values\(\)\)\s*s\.interrupt\(\)/);
});

// ------------------------------------------------------------------ permission responses
check('respond: notes the decision, then sessionFor(e).respond(id, decision) - the SENDER\'S session', () => {
  assert.match(main, /ipcMain\.handle\('jarvis:respond', \(_e, id, decision\) => \{ features\.noteDecision\(id, decision, 'desk'\); sessionFor\(_e\)\.respond\(id, decision\); return true; \}\);/);
});
check('respondAny(): for Telegram/the phone web app, which do not own a window - tries the main session, then every pane, answering whichever one is actually waiting', () => {
  const body = /function respondAny\(id, decision\) \{([\s\S]*?)\n\}/.exec(main)?.[1] || '';
  assert.match(body, /session\?\.pending\?\.has\(id\)\) return session\.respond\(id, decision\)/);
  assert.match(body, /for \(const s of paneSessions\.values\(\)\) if \(s\.pending\?\.has\(id\)\) return s\.respond\(id, decision\)/);
});

// ------------------------------------------------------------------ permission mode changes
check('setMode: WINDOW_MODES is checked BEFORE sessionFor(e).setPermissionMode() is ever called - no path to bypassPermissions through this handler', () => {
  const h = handler('jarvis:setMode');
  assert.match(h, /if \(!WINDOW_MODES\.includes\(mode\)\) return false;/);
  const guardIdx = h.indexOf('WINDOW_MODES.includes');
  const callIdx = h.indexOf('setPermissionMode(mode)');
  assert.ok(guardIdx > 0 && callIdx > guardIdx, 'the gate runs first, and an invalid mode never reaches the session at all');
});
check('WINDOW_MODES itself excludes bypassPermissions, so the gate above actually excludes it, not just happens to', () => {
  assert.match(main, /import \{ WINDOW_MODES \} from '\.\/permission-mode\.mjs';/);
  const pm = fs.readFileSync(new URL('../src/permission-mode.mjs', import.meta.url), 'utf8');
  const arr = /export const WINDOW_MODES = (\[[^\]]*\])/.exec(pm)?.[1];
  assert.ok(arr, 'WINDOW_MODES was found in permission-mode.mjs');
  assert.doesNotMatch(arr, /bypassPermissions/);
});

// ------------------------------------------------------------------ session switching / secondary chat ownership
check('sessionFor(e): the main window\'s own webContents gets ensureSession() (the one shared session); every other window gets its own, created lazily on first use', () => {
  const body = /function sessionFor\(e\) \{([\s\S]*?)\n\}/.exec(main)?.[1] || '';
  assert.match(body, /if \(!wc \|\| !win \|\| wc\.id === win\.webContents\.id\) return ensureSession\(\);/);
  assert.match(body, /let s = paneSessions\.get\(wc\.id\);/);
  assert.match(body, /if \(!s\) \{/, 'created only once per window, not on every call');
  assert.match(body, /paneSessions\.set\(wc\.id, s\);/);
});
check('each pane\'s own session is built the same way the main one is - its own cwd, exe and (critically) its own trust check, not a shared/stale one', () => {
  const body = /function sessionFor\(e\) \{([\s\S]*?)\n\}/.exec(main)?.[1] || '';
  assert.match(body, /new JarvisSession\(\{[\s\S]{0,300}trusted: workspaceTrusted\(\),?\s*\}\);/);
});
check('workspace trust: the MAIN session is built the same way - workspaceTrusted() read fresh at creation, both places, not a cached value threaded through', () => {
  const main_ = /function ensureSession\(\) \{([\s\S]*?)\n\}/.exec(main)?.[1] || '';
  assert.match(main_, /trusted: workspaceTrusted\(\)/);
  // Exactly two JarvisSession constructions in the whole file - main and pane - and both ask fresh.
  const count = (main.match(/new JarvisSession\(\{/g) || []).length;
  assert.equal(count, 2, `expected exactly 2 (main + pane), found ${count}`);
  // Every `new JarvisSession({...})` block itself asks workspaceTrusted() for its own
  // `trusted:` field - not a value computed once and threaded through from elsewhere.
  for (const m of main.matchAll(/new JarvisSession\(\{[\s\S]{0,400}?\n\s*\}\);/g)) {
    assert.match(m[0], /trusted: workspaceTrusted\(\)/, 'each JarvisSession construction asks fresh');
  }
});

// ------------------------------------------------------------------ window destruction / secondary chat cleanup
check('a pane window being destroyed (the user closes it) closes ITS session immediately - not left for the next power-down/restart to notice', () => {
  const body = /function sessionFor\(e\) \{([\s\S]*?)\n\}/.exec(main)?.[1] || '';
  assert.match(body, /wc\.once\('destroyed', \(\) => \{\s*try \{ s\.close\(\); \} catch \{[^}]*\}\s*paneSessions\.delete\(wc\.id\);\s*\}\);/);
});
check('openPane() tracks the window itself too (paneWindows), so power-down/shutdownChildren can destroy windows that were never closed by hand - see pane-windows-test.mjs for the behavioral half of this', () => {
  assert.match(main, /paneWindows\.set\(pw\.webContents\.id, pw\);/);
  assert.match(main, /pw\.webContents\.once\('destroyed', \(\) => paneWindows\.delete\(pw\.webContents\.id\)\);/);
});

// ------------------------------------------------------------------ error handling and stale responses
check('rewind: refuses a malformed message id before ever touching a session - and otherwise goes through the SENDER\'S session', () => {
  const h = handler('jarvis:rewind');
  assert.match(h, /if \(!isSessionId\(uuid\)\) return \{ canRewind: false, error:/);
  assert.match(h, /sessionFor\(_e\)\.rewindFiles\(uuid, dryRun !== false\)/);
});
check('deleteSession/renameSession: a malformed id, or no workspace at all, is refused before any file is touched - never another folder\'s conversation', () => {
  const del = handler('jarvis:deleteSession');
  assert.match(del, /if \(!isSessionId\(id\)\) return \{ ok: false, error: 'That is not a session id\.' \};/);
  assert.match(del, /if \(!loadConfig\(\)\.cwd\) return \{ ok: false, error: NO_WORKSPACE \};/);
  const ren = handler('jarvis:renameSession');
  assert.match(ren, /if \(!isSessionId\(id\)\) return \{ ok: false, error: 'That is not a session id\.' \};/);
  assert.match(ren, /if \(!loadConfig\(\)\.cwd\) return \{ ok: false, error: NO_WORKSPACE \};/);
});
check('deleteSession: this app\'s OWN live session is closed first when it is the one being deleted, before the SDK is asked to remove its files - never deletes a session still being written to', () => {
  const del = handler('jarvis:deleteSession');
  assert.match(del, /const own = !!session && session\.sessionId === id;/);
  const closeIdx = del.indexOf('session.close()');
  const removeIdx = del.indexOf('removeSession(');
  assert.ok(closeIdx > 0 && removeIdx > closeIdx, 'closed before the files are removed');
});
check('sessions/findSessions/history: with no workspace at all, an empty list - never another folder\'s sessions by accident (the SDK reads a missing dir as "every project")', () => {
  // jarvis:sessions is wired through the features.mjs injection (`sessions: async () => ...`);
  // the other two are direct handlers in main.mjs.
  assert.match(main, /sessions: async \(\) => \{ const \{ cwd \} = loadConfig\(\); return cwd \? listRecent\(cwd\) : \[\]; \}/);
  assert.match(handler('jarvis:findSessions'), /if \(!cwd\) return \[\];/);
  assert.match(handler('jarvis:history'), /if \(!cwd\) return \[\];/);
});
check('renameSession: the live session renames through its own /rename (so its in-memory title agrees); any other stored session renames on disk - never both paths for the same id', () => {
  const ren = handler('jarvis:renameSession');
  assert.match(ren, /if \(session && session\.sessionId === id && session\.canRenameLive\) \{/);
  assert.match(ren, /await renameStoredSession\(loadConfig\(\)\.cwd, id, t\);/);
});

console.log(`main-chat-ipc-test: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
