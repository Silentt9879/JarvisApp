// Real GUI regression tests: a real launched JARVIS, real windows, real clicks and typed
// text, real assertions on what's actually on screen - not a regex over main.mjs's source.
// See README.md for why these can't be executed from this project's usual shell, and the
// Phase 9 report for the exact diagnostic behind that.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures.mjs';

test('startup: the main window really appears, with real visible text, and shuts down cleanly', async ({ jarvis }) => {
  const { electronApp, window } = jarvis;
  await expect(window.locator('#welcomeLine')).toBeVisible();
  await expect(window.locator('#welcomeLine')).toHaveText(/JARVIS is ready/);
  await expect(window.locator('#input')).toBeVisible();

  await electronApp.close();
  // Playwright's own ElectronApplication.close() waits for the process to actually exit;
  // reaching here without throwing already proves a clean shutdown, and exitCode confirms it.
  expect(electronApp.process().exitCode).toBe(0);
});

test('a secondary chat window is a real, separate window, and can close on its own', async ({ jarvis }) => {
  const { electronApp, window } = jarvis;
  expect(electronApp.windows().length).toBe(1);

  const paneOpened = electronApp.waitForEvent('window');
  await window.locator('#newWindow').click();
  const pane = await paneOpened;
  await expect.poll(() => electronApp.windows().length).toBe(2);
  await expect(pane.locator('#input')).toBeVisible();

  await pane.close();
  await expect.poll(() => electronApp.windows().length).toBe(1);
});

// "power down" closing every window including a secondary one is the exact regression this
// release fixes (src/main.mjs's powerDown() + closeAllPanes()) - but powerDown() only takes
// the sleep-to-tray path when remote.ready is true (a configured, format-valid Telegram token
// + chat id); otherwise it calls app.quit() instead (main.mjs:1466). Making remote.ready true
// here would also start remote.mjs's real getUpdates poll against Telegram's actual servers
// within seconds (remote.mjs's poll()) - a real outbound network call on every run, which is
// exactly what this project's own testing standard has avoided everywhere else (github-test.mjs
// mocks fetch rather than touching the real GitHub API; the Phase 5/9 instructions were
// explicit about never a real Telegram message). So this is a CONFIRMED defect from Phase 9,
// not executed there: fixed here to test the one power-down path that's actually safe to
// reach with disposable/dummy config - a full quit, which this isolated harness's config
// (no phone/remote set up at all) genuinely exercises. The sleep-to-tray variant needs either
// a one-time accepted real network probe or a production-side test seam (e.g. an injectable
// `api` for remote.mjs's poll, mirroring git.mjs/github.mjs's existing DI pattern) - a decision
// for a human, not something to default silently either way.
test('power down with remote control unset quits the app outright - every window closes with it', async ({ jarvis }) => {
  const { electronApp, window } = jarvis;

  await window.locator('#newWindow').click();
  await expect.poll(() => electronApp.windows().length).toBe(2);

  // The same one-word shortcut the desk chat itself recognizes (remote.mjs's controlWord()).
  await window.locator('#input').fill('power down');
  await window.locator('#send').click();

  // The process exits entirely (app.quit()) - Electron's own teardown takes every window
  // with it, main and secondary alike.
  await expect.poll(() => electronApp.process().exitCode, { timeout: 10_000 }).not.toBeNull();
  expect(electronApp.windows().length).toBe(0);
});

test('the isolated jarvis.log has real, readable startup lines after a session', async ({ jarvis }) => {
  const { electronApp, userData } = jarvis;
  await electronApp.close();
  const log = fs.readFileSync(path.join(userData, 'jarvis.log'), 'utf8');
  expect(log).toMatch(/JARVIS starting/);
});
