// Secondary chat windows ("File > New chat window"): stopping every one of them together.
//
// Before this existed, powerDown() closed the main window and its session but never touched
// a pane's - a secondary chat kept its window open and its JarvisSession running, mid-turn
// if it was, spending API tokens and able to leave an unanswered permission request, for as
// long as JARVIS reported itself "asleep". closePanes() is the one place both the window and
// the session are stopped together, used by both powerDown() and shutdownChildren() so the
// two can never drift apart again.
/**
 * Stop every secondary chat window: each session closed, each window destroyed. Safe with
 * none open, and safe to call more than once - closing an already-closed session, or
 * destroying an already-destroyed window, is a no-op either way (JarvisSession.close() is
 * idempotent; Electron's BrowserWindow reports isDestroyed() once it is).
 *
 *   sessions  Map<id, { close() }>              - each pane's JarvisSession
 *   windows   Map<id, { isDestroyed(), destroy() }> - each pane's BrowserWindow, same keys
 *
 * Both maps are left empty afterward, so "this map is non-empty" keeps meaning "a pane is
 * genuinely open" for every other caller (activeWork(), respondAny(), interruptAll()).
 */
export function closePanes(sessions, windows) {
  const list = [...windows.values()];
  for (const s of sessions.values()) { try { s.close(); } catch { /* already gone */ } }
  sessions.clear();
  for (const w of list) { try { if (!w.isDestroyed()) w.destroy(); } catch { /* already gone */ } }
  windows.clear();
}
