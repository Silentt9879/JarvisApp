// The Telegram token migration, launched for real - but never through the "Check token"
// button, since that makes a real call to Telegram's API to verify it (telegramVerify() in
// main.mjs). A dummy token would correctly fail that call and never get saved, which would
// test nothing. Migration itself needs no UI at all: it runs once at startup
// (runTelegramTokenMigration(), main.mjs) against whatever is already in config.json - so
// this seeds a plain-text token before launch and checks the real files after, the same way
// an upgrading install's first run would behave.
import { test as base, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { resolveLaunch, isolatedEnv } from './fixtures.mjs';

const DUMMY_TOKEN = '123456789:DummyTokenNeverSentAnywhere-not-real';

base('an existing plain-text Telegram token is encrypted on first launch, and the plain-text copy is gone', async () => {
  const { userData, workspace, env } = isolatedEnv('telegram-migration');
  fs.writeFileSync(
    path.join(userData, 'config.json'),
    JSON.stringify({ phone: { enabled: true, route: 'telegram', telegram: { token: DUMMY_TOKEN } } }, null, 2),
  );

  const { executablePath, args } = resolveLaunch();
  const electronApp = await electron.launch({ executablePath, args, env });
  try {
    await electronApp.firstWindow();
    // Migration runs once in app.whenReady(), before the window is even created - give it a
    // moment to finish its own file write.
    await new Promise((r) => setTimeout(r, 1000));
    await electronApp.close();

    const configAfter = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));
    expect(configAfter.phone?.telegram?.token).toBeUndefined();
    expect(fs.existsSync(path.join(userData, 'telegram-token.bin'))).toBe(true);
    const raw = fs.readFileSync(path.join(userData, 'telegram-token.bin'));
    expect(raw.toString('latin1')).not.toContain(DUMMY_TOKEN);
  } finally {
    await electronApp.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
