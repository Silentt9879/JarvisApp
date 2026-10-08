// Workspace trust, launched without JARVIS_CAPTURE - confirmed Phase 10 defect: the shared
// `jarvis` fixture (fixtures.mjs) always sets JARVIS_CAPTURE + JARVIS_CAPTURE_CWD, and
// workspaceTrusted() in main.mjs has an explicit, deliberate carve-out for exactly that
// combination: `if (process.env.JARVIS_CAPTURE && process.env.JARVIS_CAPTURE_CWD) return true;`
// (it exists so a screenshot/demo run never shows the restricted-workspace gate). Under the
// shared fixture, the workspace is therefore ALWAYS reported trusted, and the original test
// written against it could never have shown the "Restricted workspace" warning it asserted -
// it would have failed on a correct app, for a harness reason having nothing to do with trust.
// This file launches independently with only JARVIS_USERDATA isolated, a real (untrusted)
// workspace entry pre-seeded in config.json, and no capture mode - the same shape a real
// upgrading install's config would have.
import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveLaunch } from './fixtures.mjs';

test('an untrusted workspace shows the real warning, and trusting it clears the real warning', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-gui-wstrust-ud-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-gui-wstrust-ws-'));
  fs.writeFileSync(
    path.join(userData, 'config.json'),
    JSON.stringify({
      workspaces: [{ id: 'ws1', name: 'gui-test', path: workspace }],
      activeWorkspaceId: 'ws1',
    }, null, 2),
  );

  const { executablePath, args } = resolveLaunch();
  const electronApp = await electron.launch({ executablePath, args, env: { ...process.env, JARVIS_USERDATA: userData } });
  try {
    const window = await electronApp.firstWindow();
    await window.locator('button[data-view="workspace"]').click();
    await expect(window.getByText(/Restricted workspace/i)).toBeVisible({ timeout: 10_000 });

    await window.getByRole('button', { name: 'Trust this folder' }).click();
    await expect(window.getByText(/Restricted workspace/i)).toHaveCount(0);
  } finally {
    await electronApp.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
