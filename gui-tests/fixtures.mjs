// Shared launch/teardown helper for the GUI specs. Not runnable in this environment (see
// README.md) - written so it's ready the moment this is run on a machine with a real
// interactive desktop.
import { test as base, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GUI_TESTS_DIR = fileURLToPath(new URL('.', import.meta.url));
const APP_ROOT = path.resolve(GUI_TESTS_DIR, '..');

/**
 * Where to launch JARVIS from: the already-built release candidate's unpacked exe if one is
 * present (the most realistic "packaged app" test), falling back to running the source
 * directly through the local `electron` binary for a plain dev-mode check.
 */
export function resolveLaunch() {
  const rcDirs = fs.readdirSync(APP_ROOT).filter((d) => /^dist-rc-/.test(d));
  for (const d of rcDirs) {
    const exe = path.join(APP_ROOT, d, 'win-unpacked', 'JARVIS.exe');
    if (fs.existsSync(exe)) return { executablePath: exe, args: [] };
  }
  const electronBin = path.join(APP_ROOT, 'node_modules', '.bin', 'electron.cmd');
  return { executablePath: electronBin, args: [APP_ROOT] };
}

/**
 * A fresh, disposable userData + workspace for one test - never the real %APPDATA%\JARVIS,
 * never a real project. JARVIS_CAPTURE is the app's own existing screenshot/demo-run mode
 * (src/main.mjs): it skips Telegram/remote control, real updates and real workspace-switch
 * side effects, so a GUI test can never reach a real network call or a real install action
 * just by exercising the window.
 */
export function isolatedEnv(label) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), `jarvis-gui-${label}-ud-`));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `jarvis-gui-${label}-ws-`));
  fs.writeFileSync(path.join(workspace, 'README.md'), 'disposable GUI-test workspace\n');
  return {
    userData,
    workspace,
    env: {
      ...process.env,
      JARVIS_USERDATA: userData,
      JARVIS_CAPTURE: '1',
      JARVIS_CAPTURE_CWD: workspace,
    },
  };
}

export const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  jarvis: async ({}, use, testInfo) => {
    const { userData, workspace, env } = isolatedEnv(testInfo.title.replace(/[^a-z0-9]+/gi, '-').slice(0, 40));
    const { executablePath, args } = resolveLaunch();
    const electronApp = await electron.launch({ executablePath, args, env });
    const window = await electronApp.firstWindow();
    await use({ electronApp, window, userData, workspace });
    // Screenshot + log capture on failure, before closing anything.
    if (testInfo.status !== testInfo.expectedStatus) {
      try {
        await window.screenshot({ path: testInfo.outputPath('failure.png') });
      } catch { /* window may already be gone */ }
      try {
        fs.copyFileSync(path.join(userData, 'jarvis.log'), testInfo.outputPath('jarvis.log'));
      } catch { /* nothing logged yet */ }
    }
    try { await electronApp.close(); } catch { /* already closed by the test */ }
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  },
});

export { expect } from '@playwright/test';
