// JARVIS Google Drive - Phase 2/5 (Decision 1): src/drive-app-client.mjs's Client ID
// resolution (build-time config file, with an env override for dev/test) and the
// force-disable kill switch. Pure, Electron-free logic - no real Google Cloud project, no
// network. Writes and restores a temp copy of the real config file so these checks never
// leave the committed drive-app-client-config.json changed on disk.
//   node scripts/drive-app-client-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${extra ? `\n     ${extra}` : ''}`); } };
const check = (name, fn) => { try { fn(); ok(true, name); } catch (e) { ok(false, name, String(e?.stack || e).split('\n').slice(0, 6).join('\n     ')); } };

const ENV_CLIENT = 'JARVIS_GOOGLE_CLIENT_ID';
const ENV_FLAG = 'JARVIS_DRIVE_APP_OWNED';
const savedClient = process.env[ENV_CLIENT];
const savedFlag = process.env[ENV_FLAG];
const resetEnv = () => { delete process.env[ENV_CLIENT]; delete process.env[ENV_FLAG]; };
const restoreEnv = () => {
  if (savedClient === undefined) delete process.env[ENV_CLIENT]; else process.env[ENV_CLIENT] = savedClient;
  if (savedFlag === undefined) delete process.env[ENV_FLAG]; else process.env[ENV_FLAG] = savedFlag;
};

const CONFIG_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'drive-app-client-config.json');
const originalConfigBytes = fs.readFileSync(CONFIG_FILE);
const setConfig = (obj) => fs.writeFileSync(CONFIG_FILE, JSON.stringify(obj));
const restoreConfig = () => fs.writeFileSync(CONFIG_FILE, originalConfigBytes);

// Each module import reads process.env and the config file live (functions, not cached
// top-level constants), so a fresh import isn't needed between checks.
const M = await import('../src/drive-app-client.mjs');

check('the checked-in default config has an empty Client ID - every build today is unaffected', () => {
  const raw = JSON.parse(originalConfigBytes.toString('utf8'));
  assert.equal(raw.googleDriveClientId, '');
});

check('with the real (empty) config and no env override: unavailable, the real default state of every build', () => {
  resetEnv();
  assert.equal(M.appOwnedClientId(), null);
  assert.equal(M.appOwnedLoginAvailable(), false);
});

check('a real Client ID baked into the build-time config file makes the path available with NO environment variable set - Task 2\'s own requirement', () => {
  resetEnv();
  setConfig({ googleDriveClientId: 'built-in-client-id.apps.googleusercontent.com' });
  assert.equal(M.appOwnedClientId(), 'built-in-client-id.apps.googleusercontent.com');
  assert.equal(M.appOwnedLoginAvailable(), true);
  restoreConfig();
});

check('the dev env override (JARVIS_GOOGLE_CLIENT_ID) takes priority over the build-time config, for local testing without touching the committed file', () => {
  resetEnv();
  setConfig({ googleDriveClientId: 'built-in-client-id.apps.googleusercontent.com' });
  process.env[ENV_CLIENT] = 'dev-override-id.apps.googleusercontent.com';
  assert.equal(M.appOwnedClientId(), 'dev-override-id.apps.googleusercontent.com');
  restoreConfig();
});

check('JARVIS_DRIVE_APP_OWNED=0 force-disables the path even with a real Client ID configured - the QA/BYO-only kill switch', () => {
  resetEnv();
  setConfig({ googleDriveClientId: 'built-in-client-id.apps.googleusercontent.com' });
  process.env[ENV_FLAG] = '0';
  assert.equal(M.appOwnedLoginFlag(), false);
  assert.equal(M.appOwnedLoginAvailable(), false, 'force-disabled even though a real id resolved');
  restoreConfig();
});

check('the old "JARVIS_DRIVE_APP_OWNED=1" convention still works (and is simply unnecessary now) - no regression for anyone who already set it', () => {
  resetEnv();
  setConfig({ googleDriveClientId: 'built-in-client-id.apps.googleusercontent.com' });
  process.env[ENV_FLAG] = '1';
  assert.equal(M.appOwnedLoginFlag(), true);
  assert.equal(M.appOwnedLoginAvailable(), true);
  restoreConfig();
});

check('a missing or corrupt config file is treated as "no id configured," never thrown', () => {
  resetEnv();
  fs.writeFileSync(CONFIG_FILE, '{not valid json');
  assert.equal(M.appOwnedClientId(), null);
  assert.equal(M.appOwnedLoginAvailable(), false);
  restoreConfig();
});

check('an empty or whitespace-only Client ID in the config counts as "not set"', () => {
  resetEnv();
  setConfig({ googleDriveClientId: '   ' });
  assert.equal(M.appOwnedClientId(), null);
  restoreConfig();
});

restoreConfig();
restoreEnv();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
