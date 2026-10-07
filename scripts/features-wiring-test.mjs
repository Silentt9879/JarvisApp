// Wiring test for the features of 2026-10-07: builds the real feature set (features.mjs) with
// fake Electron pieces and a real config file, then checks what the window would be told. Covers
// the bug where the config held only two keys - every setting a feature reads must come through.
//   node scripts/features-wiring-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFeatures } from '../src/features.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${extra ? `\n     ${extra}` : ''}`); } };
const check = async (name, fn) => {
  try { await fn(); ok(true, name); } catch (e) { ok(false, name, String(e.message || e).slice(0, 300)); }
};

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-wiring-'));
const configPath = path.join(T, 'config.json');
const srcDir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'src');

// The same loader as main.mjs: the whole file, with cwd and phone defaulted.
const loadConfig = () => {
  try {
    const c = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return { ...c, cwd: c.cwd || T, phone: c.phone || {} };
  } catch {
    return { cwd: T, phone: {} };
  }
};
const saveConfig = (patch) => {
  let current = {};
  try { current = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { /* first write */ }
  fs.writeFileSync(configPath, JSON.stringify({ ...current, ...patch }, null, 2));
};

const handlers = new Map();
const ipcMain = { handle: (name, fn) => handlers.set(name, fn) };
const call = (name, ...args) => handlers.get(name)({ sender: { setZoomFactor() {} } }, ...args);
// A stand-in for Electron's safeStorage: "encrypts" by reversing bytes.
const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s).reverse(), decryptString: (b) => Buffer.from(b).reverse().toString() };

const app = { getVersion: () => '1.7.0', getPath: () => path.join(T, 'docs') };
const shell = { openPath: async () => '', showItemInFolder() {} };
const dialog = { showSaveDialog: async () => ({ canceled: true }) };
const Notification = class { static isSupported() { return false; } };

function build({ firstRun = false, claudeFound = true, query = null } = {}) {
  handlers.clear();
  return createFeatures({
    app, ipcMain, shell, dialog, Notification, safeStorage,
    userDir: T, srcDir, configPath, firstRun,
    log: () => {}, loadConfig, saveConfig,
    query: query || (() => { throw new Error('not used here'); }),
    claudeExe: () => (claudeFound ? path.join(T, 'claude.exe') : path.join(T, 'missing.exe')),
    remote: { ready: false, announce: async () => null },
    voice: { ready: false, transcribe: async () => ({ ok: true, text: '' }) },
    getWin: () => null,
    isCapture: false,
    showWindow() {}, showView() {},
    respondAny() {}, interruptAll() {}, submitMessage: () => ({ ok: true }),
    startSignIn: () => ({ ok: true }),
    authState: async () => ({ ok: true, loggedIn: true, email: 'me@example.com', subscriptionType: 'max' }),
    githubOn: async () => true,
    telegramOn: () => false,
    updateInfo: () => null,
  });
}

// ------------------------------------------------------------------ the start-up answer
await check('a first run asks for setup, and a finished setup does not', async () => {
  fs.rmSync(configPath, { force: true });
  const f = build({ firstRun: true });
  f.registerIpc();
  assert.equal((await call('app:welcome')).setupNeeded, true);
  await call('app:welcomeDone', 'setup');
  assert.equal((await call('app:welcome')).setupNeeded, false);
});
await check('the update notes are shown once, after the new version starts', async () => {
  saveConfig({ whatsNewPending: { version: '1.7.0', notes: '## Fixed\n- a thing' }, lastSeenVersion: '1.6.2' });
  const f = build();
  f.registerIpc();
  const w = await call('app:welcome');
  assert.equal(w.whatsNew.version, '1.7.0');
  assert.match(w.whatsNew.notes, /Fixed/);
  await call('app:welcomeDone', 'whatsnew');
  assert.equal((await call('app:welcome')).whatsNew, null, 'not shown twice');
});
await check('a version change without notes still says JARVIS was updated', async () => {
  saveConfig({ whatsNewPending: null, lastSeenVersion: '1.6.0' });
  const f = build();
  f.registerIpc();
  const w = await call('app:welcome');
  assert.equal(w.whatsNew.notes, '');
});

// ------------------------------------------------------------------ budget
await check('the budget is read from the config, and saved through the window', async () => {
  saveConfig({ budgetUsd: 2.5 });
  const f = build();
  f.registerIpc();
  assert.equal((await call('usage:summary')).budgetUsd, 2.5, 'the saved limit is seen');
  assert.equal((await call('usage:budget', -1)).ok, false, 'a negative limit is refused');
  assert.equal((await call('usage:budget', 4)).budgetUsd, 4);
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).budgetUsd, 4, 'and written to the file');
});

// ------------------------------------------------------------------ health
await check('health reads the signed-in account, the folder, and the policy file', async () => {
  fs.mkdirSync(path.join(T, '.claude', 'jarvis'), { recursive: true });
  fs.writeFileSync(path.join(T, '.claude', 'jarvis', 'git-risk-policy.json'), '{}');
  const f = build();
  f.registerIpc();
  const h = await call('health:get');
  const by = Object.fromEntries(h.checks.map((c) => [c.id, c]));
  assert.equal(by.signin.state, 'ok');
  assert.equal(by.workspace.state, 'ok');
  assert.equal(by.policy.state, 'ok', 'the policy file was found in the workspace');
  fs.rmSync(path.join(T, '.claude'), { recursive: true, force: true });
  const h2 = await call('health:get');
  assert.equal(Object.fromEntries(h2.checks.map((c) => [c.id, c])).policy.state, 'off', 'missing: the safe confirm-everything default, shown as information');
});

// ------------------------------------------------------------------ the phone web app
await check('the phone web app starts from the setting, and its code works', async () => {
  saveConfig({ companionOn: false, companionPort: 0 });
  const f = build();
  f.registerIpc();
  const off = await call('companion:status');
  assert.equal(off.on, false);
  assert.equal(off.running, false);
  const port = 18000 + Math.floor(Math.random() * 2000);
  const turned = await call('companion:set', { on: true, port });
  assert.equal(turned.ok, true, turned.error);
  assert.equal(turned.running, true, 'it is running after being switched on');
  const code = (await call('companion:reveal')).code;
  assert.ok(code && code.length >= 20, 'a code exists');
  const reply = await fetch(`http://127.0.0.1:${port}/api/state?k=${code}`);
  assert.equal(reply.status, 200);
  const body = await reply.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.transcript, []);
  const refused = await fetch(`http://127.0.0.1:${port}/api/state?k=wrong`);
  assert.equal(refused.status, 401);
  await f.stop();
});
await check('a new code replaces the old one', async () => {
  const f = build();
  f.registerIpc();
  const before = (await call('companion:reveal')).code;
  await call('companion:newCode');
  const after = (await call('companion:reveal')).code;
  assert.notEqual(before, after);
});
await check('a port in use is reported in plain words', async () => {
  const net = await import('node:net');
  const blocker = net.createServer();
  // The same address the phone web app listens on, so this is a real conflict.
  await new Promise((r) => blocker.listen(0, '0.0.0.0', r));
  const busy = blocker.address().port;
  const f = build();
  f.registerIpc();
  const r = await call('companion:set', { on: true, port: busy });
  assert.equal(r.ok, false);
  assert.match(r.error, /already in use/);
  blocker.close();
  await f.stop();
});

// ------------------------------------------------------------------ activity and prompts
await check('activity and saved prompts work through their window calls', async () => {
  const f = build();
  f.registerIpc();
  f.activity.add('command', 'npm test');
  const list = await call('activity:list', { query: 'npm' });
  assert.equal(list[0].text, 'npm test');
  const p = await call('prompts:add', { title: 'Review', text: 'Review {file}' });
  assert.equal(p.ok, true);
  assert.equal((await call('prompts:list')).length, 1);
});

// ------------------------------------------------------------------ routines through the window
await check('routines can be made, listed with a next run, and removed', async () => {
  const f = build();
  f.registerIpc();
  const added = await call('routines:add', { name: 'Tests', prompt: 'Run the tests', time: '09:00', days: 'weekdays' });
  assert.equal(added.ok, true);
  const listed = await call('routines:list');
  assert.equal(listed.length, 1);
  assert.ok(listed[0].nextRun > Date.now(), 'the next run is in the future');
  assert.equal((await call('routines:remove', added.item.id)).ok, true);
});

// ------------------------------------------------------------------ project starters through the window
await check('the project starters are listed for the window', async () => {
  const f = build();
  f.registerIpc();
  const t = await call('project:templates');
  assert.ok(t.some((x) => x.id === 'node'));
  assert.ok(t.every((x) => x.label && x.blurb));
});

// ------------------------------------------------------------------ usage limits through the window
await check('the window can refresh the limits from /usage, and reads them back with the plan', async () => {
  const text = [
    'Current session: 41% used · resets Oct 7, 3:29am (Asia/Kuala_Lumpur)',
    'Current week (all models): 4% used · resets Oct 8, 3:59pm (Asia/Kuala_Lumpur)',
    '',
    'Last 24h · 371 requests · 5 sessions',
    '  92% of your usage was at >150k context',
  ].join('\n');
  async function* fakeUsage() { yield { type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0 }; }
  const seenPrompts = [];
  const f = build({ query: ({ prompt }) => { seenPrompts.push(prompt); return fakeUsage(); } });
  f.registerIpc();
  const before = await call('usage:limits');
  assert.equal(before.windows.length, 0, 'nothing read before the first refresh');
  const r = await call('usage:refreshLimits');
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(seenPrompts, ['/usage'], 'the refresh asks for /usage only');
  assert.equal(r.reading.windows.length, 2);
  assert.equal(r.reading.contributing[0].longPercent, 92);
  const after = await call('usage:limits');
  assert.equal(after.windows.length, 2, 'the reading is kept for the next time the page opens');
  assert.equal(after.plan, 'Max', 'the plan name comes from the sign-in (fake: max)');
});
await check('a live rate-limit event updates the reading the page shows', async () => {
  const f = build();
  f.registerIpc();
  f.onEvent({ kind: 'rate_limit', info: { unifiedWindows: { five_hour: { utilization: 0.62, resetsAt: 1791315000 } }, overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled' } });
  const now = await call('usage:limits');
  const session = now.windows.find((w) => w.key === 'session');
  assert.equal(session.percent, 62);
  assert.equal(now.overage.status, 'rejected');
});

fs.rmSync(T, { recursive: true, force: true });
console.log(`features-wiring-test: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
