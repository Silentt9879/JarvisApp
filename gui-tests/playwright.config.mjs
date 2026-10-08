// Config for the GUI specs only - never picked up by `npm test`. Run with:
//   npx playwright test --config gui-tests/playwright.config.mjs
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 30_000,
  retries: 0,
  // Electron tests don't run in parallel well (each owns real OS windows/processes).
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: 'report', open: 'never' }]],
  outputDir: 'test-results',
});
