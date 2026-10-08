// Unit test for src/phone-token.mjs (the Telegram token's encrypted storage and the
// plain-text-to-encrypted migration), plus a wiring check that main.mjs actually routes every
// save of phone settings through it. Temp files only; no real safeStorage, no real config.json.
//   node scripts/phone-token-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveTelegramToken, telegramTokenField, migrateTelegramToken } from '../src/phone-token.mjs';
import { loadToken } from '../src/updates.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${extra ? `\n     ${extra}` : ''}`); } };
const check = (name, fn) => { try { fn(); ok(true, name); } catch (e) { ok(false, name, String(e.message || e).slice(0, 300)); } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-phone-token-'));
let n = 0;
const freshFile = () => path.join(TMP, `tg-${n++}.bin`);

// A fake safeStorage, same shape and same fake cipher scripts/updates-test.mjs already uses
// for the GitHub token - reversing the string is enough to prove round-tripping, and to prove
// nothing here ever writes the token in the clear.
const fakeSafe = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s).reverse(), decryptString: (b) => Buffer.from(b).reverse().toString() };
const noEncryption = { isEncryptionAvailable: () => false };
const TOKEN = '123456789:AAFakeTokenForTestingOnly-not-real';

// ------------------------------------------------------------------ resolveTelegramToken
check('no file, no legacy: null', () => {
  assert.equal(resolveTelegramToken(freshFile(), fakeSafe, null), null);
});
check('no file, a legacy plain-text token: that token', () => {
  assert.equal(resolveTelegramToken(freshFile(), fakeSafe, TOKEN), TOKEN);
});
check('no file, an invalid legacy value: null, never passed through unchecked', () => {
  assert.equal(resolveTelegramToken(freshFile(), fakeSafe, 'not a real token'), null);
});
check('an encrypted copy wins over a legacy plain-text one', () => {
  const file = freshFile();
  fs.writeFileSync(file, fakeSafe.encryptString(TOKEN));
  assert.equal(resolveTelegramToken(file, fakeSafe, '999:SomeOtherLegacyToken'), TOKEN);
});

// ------------------------------------------------------------------ telegramTokenField
check('clearing (null): the encrypted file goes, the config field comes back empty', () => {
  const file = freshFile();
  fs.writeFileSync(file, fakeSafe.encryptString(TOKEN));
  assert.equal(telegramTokenField(file, fakeSafe, null, null), undefined);
  assert.equal(fs.existsSync(file), false);
});
check('clearing when there was never a file: still fine, still empty', () => {
  assert.equal(telegramTokenField(freshFile(), fakeSafe, null, null), undefined);
});
check('a new token, encryption available: saved encrypted, config field left out', () => {
  const file = freshFile();
  const field = telegramTokenField(file, fakeSafe, TOKEN, null);
  assert.equal(field, undefined, 'omitted - JSON.stringify drops it, so config.json never holds it');
  assert.equal(loadToken(file, { safe: fakeSafe }), TOKEN, 'but it did get saved, encrypted');
  assert.notEqual(fs.readFileSync(file).toString('latin1'), TOKEN, 'never written in the clear');
});
check('a new token, encryption NOT available on this PC: the plain token is the only place left to keep it, and it is logged - never the token itself', () => {
  const file = freshFile();
  const logged = [];
  const field = telegramTokenField(file, noEncryption, TOKEN, null, { log: (...a) => logged.push(a.join(' ')) });
  assert.equal(field, TOKEN, 'config.json must still hold it - nowhere else to put it');
  assert.equal(fs.existsSync(file), false);
  assert.equal(logged.length, 1);
  assert.doesNotMatch(logged[0], new RegExp(TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the log line never contains the token');
});
check('no new value (undefined): a legacy plain-text token with no encrypted copy yet is carried forward, not dropped', () => {
  assert.equal(telegramTokenField(freshFile(), fakeSafe, undefined, TOKEN), TOKEN);
});
check('no new value: once there is an encrypted copy, the plain-text field is left out even on an unrelated save', () => {
  const file = freshFile();
  fs.writeFileSync(file, fakeSafe.encryptString(TOKEN));
  assert.equal(telegramTokenField(file, fakeSafe, undefined, TOKEN), undefined, 'not re-written - the encrypted copy already covers it');
});
check('no new value, nothing stored anywhere: still just omitted, never "undefined" as a string', () => {
  assert.equal(telegramTokenField(freshFile(), fakeSafe, undefined, null), undefined);
});

// ------------------------------------------------------------------ migrateTelegramToken
check('nothing to migrate: no legacy token at all', () => {
  const file = freshFile();
  assert.equal(migrateTelegramToken(file, fakeSafe, null), false);
  assert.equal(fs.existsSync(file), false);
});
check('already migrated (a file is already there): left alone, not re-encrypted from a stale legacy value', () => {
  const file = freshFile();
  fs.writeFileSync(file, fakeSafe.encryptString('already-here'));
  assert.equal(migrateTelegramToken(file, fakeSafe, 'a-different-legacy-value'), false);
  assert.equal(loadToken(file, { safe: fakeSafe }), 'already-here', 'untouched');
});
check('idempotent: calling migration twice in a row for the same install only ever migrates once, byte-identical file', () => {
  const file = freshFile();
  assert.equal(migrateTelegramToken(file, fakeSafe, TOKEN), true, 'first call: migrates');
  const firstBytes = fs.readFileSync(file);
  assert.equal(migrateTelegramToken(file, fakeSafe, TOKEN), false, 'second call: nothing left to do');
  assert.deepEqual(fs.readFileSync(file), firstBytes, 'the file was not touched again');
  // Simulating an app restart calling it a third time, as main.mjs does on every startup:
  assert.equal(migrateTelegramToken(file, fakeSafe, TOKEN), false, 'third call: still a no-op');
  assert.equal(loadToken(file, { safe: fakeSafe }), TOKEN, 'and the token is still exactly right');
});
check('a real migration: the plain-text value ends up encrypted, byte-for-byte unreadable without safeStorage', () => {
  const file = freshFile();
  assert.equal(migrateTelegramToken(file, fakeSafe, TOKEN), true);
  assert.equal(loadToken(file, { safe: fakeSafe }), TOKEN);
  assert.notEqual(fs.readFileSync(file).toString('latin1'), TOKEN);
});
check('encryption unavailable at migration time: nothing is written, the plain-text copy stays the only one, and the failure is logged without the token', () => {
  const file = freshFile();
  const logged = [];
  assert.equal(migrateTelegramToken(file, noEncryption, TOKEN, { log: (...a) => logged.push(a.join(' ')) }), false);
  assert.equal(fs.existsSync(file), false, 'never half-written');
  assert.equal(logged.length, 1);
  assert.doesNotMatch(logged[0], new RegExp(TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

// ------------------------------------------------------------------ end-to-end: migrate, then an unrelated save
check('end to end: migrate once, then an unrelated phone-settings save never re-writes the plain-text field', () => {
  const file = freshFile();
  const migrated = migrateTelegramToken(file, fakeSafe, TOKEN);
  assert.equal(migrated, true);
  // What savePhoneConfig() would compute for config.json on the very next save, having
  // changed nothing about the token itself:
  const fieldForNextSave = telegramTokenField(file, fakeSafe, undefined, TOKEN);
  assert.equal(fieldForNextSave, undefined, 'config.json keeps no copy of it from here on');
  assert.equal(resolveTelegramToken(file, fakeSafe, undefined), TOKEN, 'yet the app still resolves the right token to actually use');
});

// ------------------------------------------------------------------ wiring: main.mjs routes every phone-settings save through this
check('wiring: every saveConfig({ phone: ... }) in main.mjs goes through savePhoneConfig, which launders the token', () => {
  const main = fs.readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8');
  assert.match(main, /import \{ resolveTelegramToken, telegramTokenField, migrateTelegramToken \} from '\.\/phone-token\.mjs';/);
  assert.match(main, /const token = resolveTelegramToken\(TELEGRAM_TOKEN_FILE, safeStorage, t\.token\);/, 'phoneConfig() reads through it');
  assert.match(main, /function savePhoneConfig\(next, \{ setToken \} = \{\}\) \{[\s\S]{0,400}telegramTokenField\(TELEGRAM_TOKEN_FILE, safeStorage, setToken, legacy, \{ log \}\);[\s\S]{0,100}saveConfig\(\{ phone: \{ \.\.\.next, telegram: \{ \.\.\.t, token \} \} \}\);/);
  // Every OTHER saveConfig call in the file is for something other than `phone` - the one
  // place phone settings are saved is savePhoneConfig's own body, checked above.
  const outsideSavePhoneConfig = main.replace(/function savePhoneConfig[\s\S]*?\n\}/, '');
  assert.doesNotMatch(outsideSavePhoneConfig, /saveConfig\(\{\s*phone:/, 'no call site saves phone settings on its own, bypassing the laundering');
  assert.match(main, /runTelegramTokenMigration\(\);\s*\n\s*createWindow\(\);/, 'migration runs once at startup, before anything else needs the token');
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`phone-token-test: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
