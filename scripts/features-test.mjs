// Tests for the 2026-10-07 features: the activity log, usage, saved prompts, routines, the health
// check, the phone web app server, the wake word, and project starters. No network except the
// local test server, no model, no real agent. Run: node scripts/features-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readJson, writeJson, localDay } from '../src/store.mjs';
import { ActivityLog, redact, entryFor, KINDS } from '../src/activity.mjs';
import { UsageTracker } from '../src/usage.mjs';
import { PromptLibrary, variablesOf, fillVariables, checkPrompt } from '../src/prompts.mjs';
import { daysOf, validateRoutine, isDue, nextRunAt, RoutineStore, runRoutine } from '../src/routines.mjs';
import { buildHealth } from '../src/health.mjs';
import { CompanionServer, newAccessCode, forPhone, lanAddresses } from '../src/companion.mjs';
import { checkName, identifierOf, filesFor, createProject } from '../src/projects.mjs';

// The wake-word file is a classic script for the window: it sets window.WakeCore, which here is globalThis.
const require = createRequire(import.meta.url);
require('../src/renderer/wakeword-core.js');
const WakeCore = globalThis.WakeCore;

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass += 1; } else { fail += 1; console.log(`FAIL ${name}${extra ? `\n     ${extra}` : ''}`); }
};
const check = (name, fn) => {
  try { fn(); ok(true, name); } catch (e) { ok(false, name, String(e.message || e).slice(0, 300)); }
};
const checkAsync = async (name, fn) => {
  try { await fn(); ok(true, name); } catch (e) { ok(false, name, String(e.message || e).slice(0, 300)); }
};

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-features-'));
const file = (n) => path.join(T, n);

// ------------------------------------------------------------------ store
check('a missing file gives the fallback', () => assert.deepEqual(readJson(file('none.json'), { a: 1 }), { a: 1 }));
check('a damaged file gives the fallback, never throws', () => { fs.writeFileSync(file('bad.json'), '{not json'); assert.equal(readJson(file('bad.json'), 7), 7); });
check('writeJson then readJson round-trips', () => { writeJson(file('ok.json'), { x: [1, 2] }); assert.deepEqual(readJson(file('ok.json'), null), { x: [1, 2] }); });
check('writeJson leaves no temp file behind', () => { writeJson(file('clean.json'), { y: 1 }); assert.deepEqual(fs.readdirSync(T).filter((f) => f.includes('clean') && f.endsWith('.tmp')), []); });
check('localDay is the local calendar date', () => assert.equal(localDay(new Date(2026, 9, 7, 23, 59)), '2026-10-07'));

// ------------------------------------------------------------------ activity log
check('redact hides keys, bearer tokens and token prefixes', () => {
  assert.equal(redact('curl -H "Authorization: Bearer abcdefghijklmnop"'), 'curl -H "Authorization: Bearer [hidden]"');
  assert.match(redact('export API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwx'), /API_KEY=\[hidden\]/);
  assert.equal(redact('token ghp_abcdefghijklmnopqrstuvwxyz0123'), 'token [hidden]');
  assert.equal(redact('password: hunter2'), 'password: [hidden]');
  assert.equal(redact('git status'), 'git status', 'ordinary text is left alone');
});
check('the activity log adds, filters and finds entries', () => {
  const log = new ActivityLog(file('act.jsonl'), { now: () => 1000 });
  log.add('command', 'npm test');
  log.add('approval', 'Allowed Edit: src/a.js', { where: 'Home-PC' });
  log.add('git', 'Committed "fix"');
  assert.equal(log.recent({ kind: 'approval' }).length, 1);
  assert.equal(log.recent({ query: 'npm' })[0].text, 'npm test');
  assert.equal(log.recent({})[0].kind, 'git', 'newest first');
  assert.equal(log.recent({ query: 'home-pc' }).length, 1, 'search includes the place');
});
check('the activity log survives a reload and skips damaged lines', () => {
  const f = file('reload.jsonl');
  const a = new ActivityLog(f, { now: () => 5 });
  a.add('system', 'started');
  fs.appendFileSync(f, 'this is not json\n');
  const b = new ActivityLog(f);
  assert.equal(b.recent({}).length, 1);
});
check('the activity log keeps only the newest entries', () => {
  const log = new ActivityLog(file('cap.jsonl'), { max: 3, now: () => 1 });
  for (let i = 0; i < 5; i++) log.add('system', `entry ${i}`);
  assert.deepEqual(log.recent({}).map((e) => e.text), ['entry 4', 'entry 3', 'entry 2']);
  assert.equal(fs.readFileSync(file('cap.jsonl'), 'utf8').trim().split('\n').length, 3, 'the file was trimmed too');
});
check('the export is plain text with the kind and the time', () => {
  const log = new ActivityLog(file('exp.jsonl'), { now: () => Date.UTC(2026, 9, 7) });
  log.add('routine', 'Ran the tests');
  const text = log.exportText();
  assert.match(text, /^JARVIS activity log/);
  assert.match(text, /\[Routine\]  Ran the tests/);
});
check('an unknown kind is filed under JARVIS, not dropped', () => {
  const log = new ActivityLog(file('kind.jsonl'));
  assert.equal(log.add('nonsense', 'x').kind, 'system');
  assert.ok(KINDS.approval);
});
check('entryFor turns session events into log entries', () => {
  assert.equal(entryFor({ kind: 'permission', toolName: 'Bash', detail: 'npm test' }).kind, 'approval');
  assert.equal(entryFor({ kind: 'tool_use', name: 'Bash', detail: 'npm test', parent: null }).kind, 'command');
  assert.equal(entryFor({ kind: 'tool_use', name: 'Edit', detail: 'a.js', parent: null }).kind, 'edit');
  assert.equal(entryFor({ kind: 'tool_use', name: 'Bash', detail: 'x', parent: 'agent-1' }), null, 'a sub-agent step is not logged twice');
  assert.equal(entryFor({ kind: 'text_delta', text: 'hi' }), null);
});

// ------------------------------------------------------------------ usage
check('usage adds replies and cost for the day, and reports today and the week', () => {
  let now = new Date(2026, 9, 7, 10);
  const u = new UsageTracker(file('usage.json'), { now: () => now });
  u.record({ costUsd: 0.5, turns: 3 });
  u.record({ costUsd: 0.25, turns: 1 });
  const s = u.summary(1);
  assert.equal(s.today.replies, 2);
  assert.equal(s.today.costUsd, 0.75);
  assert.equal(s.overBudget, false);
  u.record({ costUsd: 0.5 });
  assert.equal(u.summary(1).overBudget, true, 'at or over the budget');
  now = new Date(2026, 9, 1, 10);
  const u2 = new UsageTracker(file('usage.json'), { now: () => now });
  assert.equal(u2.summary(0).today.costUsd, 0, 'a different day starts at zero');
});
check('the week covers the last seven days only', () => {
  const now = new Date(2026, 9, 7, 10);
  const u = new UsageTracker(file('week.json'), { now: () => now });
  u.record({ costUsd: 1 });
  const old = new UsageTracker(file('week.json'), { now: () => new Date(2026, 8, 20, 10) });
  old.record({ costUsd: 5 });
  assert.equal(new UsageTracker(file('week.json'), { now: () => now }).summary(0).week.costUsd, 1);
});
check('a budget alert is marked once a day', () => {
  const u = new UsageTracker(file('alert.json'), { now: () => new Date(2026, 9, 7, 12) });
  u.record({ costUsd: 2 });
  assert.equal(u.summary(1).alertedToday, false);
  u.markAlerted();
  assert.equal(u.summary(1).alertedToday, true);
});
check('a negative or non-numeric cost is ignored', () => {
  const u = new UsageTracker(file('bad-cost.json'), { now: () => new Date(2026, 9, 7) });
  u.record({ costUsd: -4 });
  u.record({ costUsd: 'lots' });
  assert.equal(u.summary(0).today.replies, 0);
});

// ------------------------------------------------------------------ saved prompts
check('blanks are found and filled in, and an unfilled blank stays', () => {
  assert.deepEqual(variablesOf('Review {file} and {file} for {issue}'), ['file', 'issue']);
  assert.equal(fillVariables('Review {file} for {issue}', { file: 'a.js' }), 'Review a.js for {issue}');
  assert.equal(fillVariables('Hi {constructor}', {}), 'Hi {constructor}', 'no prototype leakage');
});
check('a prompt needs a name and some text', () => {
  assert.equal(checkPrompt({ title: '', text: 'x' }).ok, false);
  assert.equal(checkPrompt({ title: 'T', text: '   ' }).ok, false);
  assert.equal(checkPrompt({ title: 'T', text: 'x'.repeat(4001) }).ok, false);
  assert.equal(checkPrompt({ title: 'Review', text: 'Look at {file}' }).ok, true);
});
check('the prompt library adds, updates and removes', () => {
  const lib = new PromptLibrary(file('prompts.json'), { makeId: () => 'p1', now: () => 7 });
  assert.equal(lib.add({ title: 'Review', text: 'Review {file}' }).ok, true);
  assert.equal(lib.update('p1', { title: 'Review file', text: 'Review {file} carefully' }).item.title, 'Review file');
  assert.equal(lib.list().length, 1);
  assert.equal(lib.remove('p1').ok, true);
  assert.equal(lib.remove('p1').ok, false, 'removing twice says so');
  assert.equal(lib.update('nope', { title: 'a', text: 'b' }).ok, false);
});

// ------------------------------------------------------------------ routines
check('days are read as daily, weekdays, or a list', () => {
  assert.deepEqual(daysOf('daily'), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(daysOf('weekdays'), [1, 2, 3, 4, 5]);
  assert.deepEqual(daysOf([5, 1, 1, 9]), [1, 5]);
  assert.equal(daysOf([]), null);
});
check('a routine is validated with a plain message', () => {
  assert.match(validateRoutine({ name: '', prompt: 'x', time: '09:00', days: 'daily' }).error, /name/);
  assert.match(validateRoutine({ name: 'a', prompt: 'x', time: '9am', days: 'daily' }).error, /time/);
  assert.match(validateRoutine({ name: 'a', prompt: 'x', time: '09:00', days: [] }).error, /day/);
  const v = validateRoutine({ name: 'Tests', prompt: 'Run tests', time: '09:00', days: 'weekdays', mode: 'anything' });
  assert.equal(v.ok, true);
  assert.equal(v.value.mode, 'plan', 'anything but acceptEdits stays read-only');
  assert.equal(v.value.deliver.toast, true, 'results show as a notification by default');
});
check('a routine is due once a day at its time or later', () => {
  const r = validateRoutine({ name: 'a', prompt: 'x', time: '09:00', days: 'daily' }).value;
  r.lastRunDay = null;
  assert.equal(isDue(r, new Date(2026, 9, 7, 8, 59)), false);
  assert.equal(isDue(r, new Date(2026, 9, 7, 9, 0)), true);
  assert.equal(isDue(r, new Date(2026, 9, 7, 17, 0)), true, 'a run missed while JARVIS was closed still happens');
  r.lastRunDay = '2026-10-07';
  assert.equal(isDue(r, new Date(2026, 9, 7, 17, 0)), false, 'not twice in one day');
  const weekday = validateRoutine({ name: 'a', prompt: 'x', time: '09:00', days: 'weekdays' }).value;
  assert.equal(isDue(weekday, new Date(2026, 9, 10, 9, 30)), false, 'Saturday is not a weekday');
});
check('the next run is the next matching day and time', () => {
  const r = validateRoutine({ name: 'a', prompt: 'x', time: '09:00', days: 'weekdays' }).value;
  const next = nextRunAt(r, new Date(2026, 9, 9, 10, 0));
  assert.equal(next.getDay(), 1, 'Friday 10:00 -> Monday');
  assert.equal(next.getHours(), 9);
  assert.equal(nextRunAt({ ...r, on: false }, new Date()), null);
});
check('the routine store adds, marks a run and removes', () => {
  const store = new RoutineStore(file('routines.json'), { now: () => new Date(2026, 9, 7, 9, 5), makeId: () => 'r1' });
  assert.equal(store.add({ name: 'Tests', prompt: 'Run tests', time: '09:00', days: 'daily' }).ok, true);
  store.markRun('r1', { ok: true, summary: 'All green' });
  const it = store.list()[0];
  assert.equal(it.lastRunDay, '2026-10-07');
  assert.equal(it.lastOk, true);
  assert.equal(store.remove('r1').ok, true);
});
await checkAsync('a routine run reads the reply and the cost', async () => {
  async function* fake() {
    yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Looking' }] } };
    yield { type: 'result', subtype: 'success', is_error: false, result: 'All 12 tests pass.', total_cost_usd: 0.04, num_turns: 3 };
  }
  let opts = null;
  const out = await runRoutine({ prompt: 'Run tests', mode: 'plan', cwd: '' }, { query: (a) => { opts = a.options; return fake(); }, exe: 'claude.exe', defaultCwd: 'C:/work', trusted: true });
  assert.equal(out.ok, true);
  assert.equal(out.text, 'All 12 tests pass.');
  assert.equal(out.costUsd, 0.04);
  assert.equal(opts.permissionMode, 'plan', 'read-only unless allowed');
  assert.equal(opts.cwd, 'C:/work');
  assert.deepEqual(opts.settingSources, ['user', 'project', 'local'], 'a trusted folder: the same settings as the chat there');
  await runRoutine({ prompt: 'Run tests', mode: 'plan' }, { query: (a) => { opts = a.options; return fake(); }, exe: 'claude.exe', defaultCwd: 'C:/cloned' });
  assert.deepEqual(opts.settingSources, ['user'], 'a folder not trusted: the person\'s own settings only - none of its hooks or MCP');
});
await checkAsync('a routine that fails says so, never throws', async () => {
  async function* boom() { throw new Error('the agent could not start'); }
  const out = await runRoutine({ prompt: 'x', mode: 'acceptEdits' }, { query: () => boom(), exe: 'x', defaultCwd: 'y' });
  assert.equal(out.ok, false);
  assert.match(out.error, /could not start/);
  const bad = await runRoutine({ prompt: 'x', mode: 'plan' }, { query: () => { throw new Error('no sdk'); }, exe: 'x', defaultCwd: 'y' });
  assert.equal(bad.ok, false);
});

// ------------------------------------------------------------------ health
check('the health check flags what is missing, with the fix to offer', () => {
  const h = buildHealth({ claudeFound: true, signedIn: false, workspaceFound: true, policyFound: false, telegramOn: false, githubOn: false, version: '1.7.0' });
  const by = Object.fromEntries(h.checks.map((c) => [c.id, c]));
  assert.equal(by.signin.state, 'bad');
  assert.equal(by.signin.fix.action, 'signin');
  assert.equal(by.policy.state, 'off', 'a missing policy is the safe confirm-everything default - information, not a problem');
  assert.equal(by.policy.fix.action, 'policyFolder');
  assert.equal(by.telegram.fix.action, 'telegram');
  assert.equal(h.level, 'bad');
});
check('optional tools and integrations nobody uses never make JARVIS look unhealthy', () => {
  const caps = ['flutter', 'dart', 'maven', 'gradle', 'adb', 'python', 'java', 'gh', 'vscode']
    .map((id) => ({ id, label: id, installed: false, version: null, configured: null, error: 'Not installed on this PC.' }));
  caps.push({ id: 'git', label: 'Git', installed: true, version: '2.45.1', configured: null });
  const h = buildHealth({
    claudeFound: true, signedIn: true, workspaceFound: true, workspace: 'C:/w', policyFound: false,
    telegramOn: false, telegramWanted: false, githubOn: false, version: '2.0.0',
    capabilities: caps,
    projects: [{ id: 'site', name: 'site', types: ['git', 'node'], role: 'root', meta: {} }],
  });
  assert.equal(h.level, 'ok', h.checks.filter((c) => c.state !== 'ok' && c.state !== 'off').map((c) => `${c.id}:${c.state}`).join(', '));
  assert.equal(h.summary, 'Everything is in order');
  const by = Object.fromEntries(h.checks.map((c) => [c.id, c]));
  assert.equal(by['cap:flutter'].state, 'off');
  assert.equal(by['cap:maven'].state, 'off');
  assert.equal(by.telegram.state, 'off', 'never switched on: optional, not a warning');
  assert.equal(by.github.state, 'off');
  assert.equal(by['cap:git'].state, 'ok');
});
check('a tool a discovered project needs, but which is missing, becomes an actionable warning', () => {
  const caps = [
    { id: 'flutter', label: 'Flutter', installed: false, version: null, configured: null },
    { id: 'dart', label: 'Dart', installed: false, version: null, configured: null },
    { id: 'java', label: 'Java', installed: false, version: null, configured: null },
    { id: 'gradle', label: 'Gradle', installed: false, version: null, configured: null },
  ];
  const projects = [
    { id: 'shop', name: 'shop', displayName: 'Corner Shop', types: ['dart', 'flutter', 'git'], role: 'root', meta: { app: true } },
    // Flutter's own android/ host project needs nothing of its own: no Gradle/Java warning from it.
    { id: 'shop/android', name: 'android', types: ['gradle'], role: 'platform', meta: { gradleWrapper: false } },
  ];
  const h = buildHealth({ claudeFound: true, signedIn: true, workspaceFound: true, policyFound: true, githubOn: true, capabilities: caps, projects });
  const by = Object.fromEntries(h.checks.map((c) => [c.id, c]));
  assert.equal(by['cap:flutter'].state, 'warn');
  assert.match(by['cap:flutter'].detail, /Flutter project detected \(Corner Shop\), but Flutter is not installed/);
  assert.match(by['cap:flutter'].detail, /flutter\.dev/, 'it says how to get it');
  assert.equal(by['cap:gradle'].state, 'off', 'a Flutter app\'s android/ folder does not make Gradle required');
  assert.equal(by['cap:java'].state, 'off');
  assert.equal(h.level, 'warn');
});
check('a Gradle project with its wrapper needs a JDK, not Gradle itself', () => {
  const caps = ['gradle', 'java'].map((id) => ({ id, label: id === 'java' ? 'Java' : 'Gradle', installed: false }));
  const projects = [{ id: 'svc', name: 'svc', types: ['gradle'], role: 'root', meta: { gradleWrapper: true } }];
  const by = Object.fromEntries(buildHealth({ capabilities: caps, projects }).checks.map((c) => [c.id, c]));
  assert.equal(by['cap:java'].state, 'warn');
  assert.equal(by['cap:gradle'].state, 'off');
});
check('an integration switched on but not finished is a warning; one never switched on is not', () => {
  const on = Object.fromEntries(buildHealth({ telegramOn: false, telegramWanted: true }).checks.map((c) => [c.id, c]));
  assert.equal(on.telegram.state, 'warn');
  const cu = Object.fromEntries(buildHealth({ clickup: { used: true, error: 'ClickUp is not connected' } }).checks.map((c) => [c.id, c]));
  assert.equal(cu.clickup.state, 'warn');
  const never = Object.fromEntries(buildHealth({}).checks.map((c) => [c.id, c]));
  assert.equal(never.clickup.state, 'off');
});
check('no workspace chosen at all is a problem with a fix, not a fake folder', () => {
  const by = Object.fromEntries(buildHealth({ workspaceConfigured: false }).checks.map((c) => [c.id, c]));
  assert.equal(by.workspace.state, 'bad');
  assert.equal(by.workspace.fix.action, 'workspace');
});
check('a fully set-up JARVIS reads as in order', () => {
  const h = buildHealth({ claudeFound: true, signedIn: true, account: 'me@example.com', workspaceFound: true, workspace: 'C:/w', policyFound: true, telegramOn: true, githubOn: true, version: '1.7.0' });
  assert.equal(h.level, 'ok');
  assert.equal(h.summary, 'Everything is in order');
  assert.ok(h.checks.every((c) => c.state === 'ok' || c.fix === null));
});
check('an update waiting shows as a warning with an Update button', () => {
  const h = buildHealth({ claudeFound: true, signedIn: true, workspaceFound: true, policyFound: true, telegramOn: true, githubOn: true, updateAvailable: '1.8.0' });
  const up = h.checks.find((c) => c.id === 'update');
  assert.equal(up.state, 'warn');
  assert.equal(up.fix.action, 'updates');
});
check('a settings file that cannot be read comes first, as a problem, with the file to look at', () => {
  const h = buildHealth({ configProblem: 'config.json is not valid JSON (Unexpected token o)', claudeFound: true, signedIn: true, workspaceFound: true });
  assert.equal(h.checks[0].id, 'config');
  assert.equal(h.checks[0].state, 'bad');
  assert.match(h.checks[0].detail, /not valid JSON[\s\S]*saving nothing until it is fixed[\s\S]*never overwrites it/);
  assert.equal(h.checks[0].fix.action, 'configFile');
  assert.equal(buildHealth({}).checks.some((c) => c.id === 'config'), false, 'a readable one is not mentioned');
});
check('a restricted workspace: trust is offered, and Source Control\'s rules are not in use - nothing runs Git there', () => {
  const by = Object.fromEntries(buildHealth({ workspaceFound: true, workspaceTrusted: false, policySource: 'restricted' }).checks.map((c) => [c.id, c]));
  assert.equal(by.trust.state, 'off');
  assert.match(by.trust.detail, /no scripts, builds, tests, apps or Git/);
  assert.equal(by.trust.fix.action, 'trust');
  assert.equal(by.policy.state, 'off');
  assert.match(by.policy.detail, /restricted workspace runs no Git/);
});

// ------------------------------------------------------------------ phone web app
check('only the few fields the phone shows are passed on', () => {
  assert.deepEqual(forPhone({ kind: 'text_delta', text: 'hi', extra: 'x' }), { kind: 'text_delta', text: 'hi' });
  assert.equal(forPhone({ kind: 'tasks', list: [] }), null, 'tasks are not sent');
  assert.equal(forPhone({ kind: 'tool_use', name: 'Bash', detail: 'npm test', id: 'secret-id' }).id, undefined);
});
check('an access code is long and random', () => {
  const a = newAccessCode();
  assert.ok(a.length >= 20);
  assert.notEqual(a, newAccessCode());
  assert.ok(Array.isArray(lanAddresses()));
});
await checkAsync('the phone web app serves its page, and needs the code for anything else', async () => {
  const code = newAccessCode();
  const sent = [];
  const srv = new CompanionServer({
    html: '<!doctype html><title>JARVIS</title>',
    code,
    handlers: {
      state: async () => ({ ok: true, status: 'ready' }),
      send: async (t) => { sent.push(t); return { ok: true }; },
      respond: async () => ({ ok: true }),
      interrupt: async () => ({ ok: true }),
    },
  });
  const { port } = await srv.start(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /JARVIS/);
    assert.equal((await fetch(`${base}/api/state`)).status, 401, 'no code, no state');
    assert.equal((await fetch(`${base}/api/state`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    const st = await fetch(`${base}/api/state?k=${code}`);
    assert.equal(st.status, 200);
    assert.equal((await st.json()).status, 'ready');
    const bearer = await fetch(`${base}/api/send`, { method: 'POST', headers: { Authorization: `Bearer ${code}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hello' }) });
    assert.equal((await bearer.json()).ok, true);
    assert.deepEqual(sent, ['hello']);
    const empty = await fetch(`${base}/api/send`, { method: 'POST', headers: { 'x-jarvis-code': code, 'Content-Type': 'application/json' }, body: '{"text":"  "}' });
    assert.equal(empty.status, 400);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  } finally {
    await srv.stop();
  }
});
await checkAsync('the phone web app pauses an address after repeated wrong codes', async () => {
  const srv = new CompanionServer({ html: 'x', code: 'right-code-123456789', handlers: { state: async () => ({}) } });
  const { port } = await srv.start(0, '127.0.0.1');
  try {
    let last = 0;
    for (let i = 0; i < 9; i++) last = (await fetch(`http://127.0.0.1:${port}/api/state?k=wrong`)).status;
    assert.equal(last, 429, 'refused after repeated wrong codes');
  } finally {
    await srv.stop();
  }
});
await checkAsync('the phone web app pushes events to an open page', async () => {
  const code = newAccessCode();
  const srv = new CompanionServer({ html: 'x', code, handlers: { state: async () => ({}) } });
  const { port } = await srv.start(0, '127.0.0.1');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/events?k=${code}`);
    const reader = res.body.getReader();
    srv.event({ kind: 'text_delta', text: 'pushed' });
    let got = '';
    const deadline = Date.now() + 3000;
    while (!got.includes('pushed') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      got += Buffer.from(value).toString('utf8');
    }
    assert.match(got, /"text":"pushed"/);
    await reader.cancel();
  } finally {
    await srv.stop();
  }
});

// ------------------------------------------------------------------ wake word
check('the wake word is spotted as a whole word', () => {
  assert.equal(WakeCore.hasWakeWord('Jarvis, open the repo'), true);
  assert.equal(WakeCore.hasWakeWord('hey JARVIS'), true);
  assert.equal(WakeCore.hasWakeWord('jarvisation of the economy'), false);
  assert.equal(WakeCore.hasWakeWord('nothing here'), false);
  assert.equal(WakeCore.hasWakeWord(''), false);
});
check('what follows the wake word is the request', () => {
  assert.equal(WakeCore.afterWakeWord('hey JARVIS, open the repo'), 'open the repo');
  assert.equal(WakeCore.afterWakeWord('Jarvis.'), '');
  assert.equal(WakeCore.afterWakeWord('no name here'), '');
});
check('the segmenter starts on speech, ends after a real pause, and ignores a blip', () => {
  const seg = WakeCore.createSegmenter({ threshold: 0.05, minSpeechMs: 96, silenceMs: 96, maxMs: 10000, frameMs: 32 });
  assert.equal(seg.push(0.2), null, 'one loud frame is not yet speech');
  assert.equal(seg.push(0.2), null);
  assert.equal(seg.push(0.2), 'start', 'three frames of speech start an utterance');
  assert.equal(seg.push(0.01), null, 'a short pause does not end it');
  assert.equal(seg.push(0.2), null);
  assert.equal(seg.push(0.01), null);
  assert.equal(seg.push(0.01), null);
  assert.equal(seg.push(0.01), 'end', 'a real pause ends it');
  const blip = WakeCore.createSegmenter({ threshold: 0.05, minSpeechMs: 96, silenceMs: 96, maxMs: 10000, frameMs: 32 });
  assert.equal(blip.push(0.3), null);
  assert.equal(blip.push(0.01), null);
  assert.equal(blip.push(0.01), null);
  assert.equal(blip.state, 'idle', 'a click is not speech');
});
check('a long utterance is cut, so the window never waits forever', () => {
  const seg = WakeCore.createSegmenter({ threshold: 0.05, minSpeechMs: 32, silenceMs: 800, maxMs: 200, frameMs: 32 });
  let out = null;
  for (let i = 0; i < 20 && out !== 'cut'; i++) out = seg.push(0.3) || out;
  assert.equal(out, 'cut');
});

// ------------------------------------------------------------------ project starters
check('a project name is checked in plain words', () => {
  assert.equal(checkName('').ok, false);
  assert.equal(checkName('bad/name').ok, false);
  assert.equal(checkName('CON').ok, false, 'Windows reserves some names');
  assert.equal(checkName('My App 2').ok, true);
  assert.equal(identifierOf('My App-2!'), 'my_app_2');
  assert.equal(identifierOf('2fast'), 'app_2fast');
});
check('a node starter writes a runnable server and a CLAUDE.md', () => {
  const files = filesFor('node', 'Shop');
  assert.ok(files['server.mjs'].includes('/api/health'));
  assert.ok(files['CLAUDE.md'].startsWith('# Shop'));
  assert.equal(JSON.parse(files['package.json']).scripts.start, 'node server.mjs');
});
await checkAsync('creating a project makes the folder, and says what a missing tool means', async () => {
  const parent = fs.mkdtempSync(path.join(T, 'parent-'));
  const calls = [];
  const opts = [];
  const run = async (file, args, o) => { calls.push(file); opts.push(o); return { ok: true, output: '' }; };
  const hasTool = async (t) => t === 'git';
  const r = await createProject({ parent, name: 'Shop', template: 'flutter', run, hasTool });
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(path.join(parent, 'Shop', 'CLAUDE.md')));
  assert.ok(r.notes.some((n) => /Flutter is not installed/.test(n)), 'a missing tool is said plainly');
  assert.deepEqual(calls, ['git'], 'only git was run');
  // `run` here is updates.mjs's runCommand in the real wiring (features.mjs's project:create),
  // whose options are { timeoutMs, cwd } - not workspace.mjs's run(), which takes `timeout`.
  // git init gets its own longer budget; passing the wrong key would silently fall back to
  // runCommand's 2-minute default instead.
  assert.equal(opts[0].timeoutMs, 60000, 'git init is given 60s, not silently the default');
  assert.equal(opts[0].cwd, path.join(parent, 'Shop'));
  const again = await createProject({ parent, name: 'Shop', template: 'empty', run, hasTool });
  assert.equal(again.ok, false, 'an existing folder is never overwritten');
});
await checkAsync('a node starter in a real folder', async () => {
  const parent = fs.mkdtempSync(path.join(T, 'node-'));
  const r = await createProject({ parent, name: 'Web Tool', template: 'node', run: async () => ({ ok: true, output: '' }), hasTool: async () => false });
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(path.join(parent, 'Web Tool', 'server.mjs')));
});

// ------------------------------------------------------------------ usage limits (AI Core)
// The text is exactly what Claude Code's /usage prints (checked on 2026-10-07).
const USAGE_TEXT = [
  'You are currently using your subscription to power your Claude Code usage',
  '',
  'Current session: 41% used · resets Oct 7, 3:29am (Asia/Kuala_Lumpur)',
  'Current week (all models): 4% used · resets Oct 8, 3:59pm (Asia/Kuala_Lumpur)',
  'Current week (Fable): 0% used · resets Oct 8, 4pm (Asia/Kuala_Lumpur)',
  '',
  "What's contributing to your limits usage?",
  'Approximate, based on local sessions on this machine — does not include other devices or claude.ai. Behaviors are independent characteristics, not a breakdown.',
  '',
  'Last 24h · 371 requests · 5 sessions',
  '  92% of your usage was at >150k context',
  '',
  'Last 7d · 1031 requests · 11 sessions',
  '  88% of your usage was at >150k context',
].join('\n');
const limitsMod = await import('../src/limits.mjs');
check('the /usage text gives the session, the week and the Fable week', () => {
  const p = limitsMod.parseUsageText(USAGE_TEXT);
  assert.equal(p.windows.length, 3);
  assert.deepEqual(p.windows.map((w) => [w.key, w.percent]), [['session', 41], ['week:all models', 4], ['week:fable', 0]]);
  assert.equal(p.windows[0].label, 'Current session');
  assert.match(p.windows[1].resets, /^Oct 8, 3:59pm/, 'the reset time is kept as the CLI words it');
});
check('the /usage text gives what is using the limit, over both spans', () => {
  const p = limitsMod.parseUsageText(USAGE_TEXT);
  assert.equal(p.contributing.length, 2);
  assert.deepEqual({ ...p.contributing[0] }, { span: 'Last 24 hours', requests: 371, sessions: 5, longPercent: 92, longOverK: 150 });
  assert.equal(p.contributing[1].span, 'Last 7 days');
});
check('text that is not /usage gives nothing rather than an error', () => {
  const p = limitsMod.parseUsageText('hello there');
  assert.deepEqual(p, { windows: [], contributing: [] });
  assert.deepEqual(limitsMod.parseUsageText(null), { windows: [], contributing: [] });
});
check('a live rate-limit event becomes the same windows, as percentages', () => {
  const ws = limitsMod.windowsFromEvent({
    status: 'allowed',
    unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: 1791315000 }, seven_day: { utilization: 0.03, resetsAt: 1791446400 }, seven_day_opus: { utilization: 0.5, resetsAt: 1791446400 } },
  });
  const byKey = Object.fromEntries(ws.map((w) => [w.key, w]));
  assert.equal(byKey.session.percent, 40);
  assert.equal(byKey['week:all models'].percent, 3);
  assert.equal(byKey['week:opus'].label, 'This week (Opus)');
  assert.equal(byKey.session.resetsAt, 1791315000 * 1000);
});
check('the overage (usage credits) state is read from the event', () => {
  assert.deepEqual(limitsMod.overageFromEvent({ overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled', isUsingOverage: false }),
    { status: 'rejected', reason: 'org_level_disabled', inUse: false });
  assert.equal(limitsMod.overageFromEvent({}), null);
});
check('the reading merges by window, and keeps the rest', () => {
  const file = path.join(T, 'limits.json');
  const store = new limitsMod.LimitsStore(file, { now: () => 1000 });
  store.mergeWindows([{ key: 'session', label: 'Current session', percent: 10, resets: '', resetsAt: null }], { source: 'usage', contributing: [{ span: 'Last 24 hours' }] });
  store.mergeWindows([{ key: 'session', label: 'Current session', percent: 55, resets: '', resetsAt: null }], { source: 'event' });
  const again = new limitsMod.LimitsStore(file, { now: () => 2000 }).get();
  assert.equal(again.windows.length, 1);
  assert.equal(again.windows[0].percent, 55, 'the newer reading wins');
  assert.equal(again.contributing.length, 1, 'what the event did not say is kept');
  assert.equal(again.source, 'event');
});
await checkAsync('refreshing runs /usage with no model reply, and keeps what it reads', async () => {
  let asked = null;
  async function* fake(prompt, options) {
    asked = { prompt, permissionMode: options.permissionMode, settingSources: options.settingSources };
    yield { type: 'system', subtype: 'init' };
    yield { type: 'result', subtype: 'success', is_error: false, result: USAGE_TEXT, total_cost_usd: 0 };
  }
  const store = new limitsMod.LimitsStore(path.join(T, 'refresh.json'));
  const r = await limitsMod.refreshUsage(store, { query: ({ prompt, options }) => fake(prompt, options), exe: 'claude.exe', cwd: T, timeoutMs: 5000 });
  assert.equal(r.ok, true);
  assert.equal(asked.prompt, '/usage');
  assert.equal(asked.permissionMode, 'plan');
  assert.equal(r.reading.windows.length, 3);
  assert.equal(store.get().source, 'usage');
});
await checkAsync('a refresh that fails says so and keeps the old reading', async () => {
  const store = new limitsMod.LimitsStore(path.join(T, 'fail.json'));
  store.mergeWindows([{ key: 'session', label: 'Current session', percent: 12, resets: '', resetsAt: null }], { source: 'usage' });
  const r = await limitsMod.refreshUsage(store, { query: () => { throw new Error('no claude here'); }, exe: 'x', cwd: T, timeoutMs: 2000 });
  assert.equal(r.ok, false);
  assert.match(r.error, /no claude here/);
  assert.equal(store.get().windows[0].percent, 12);
});

fs.rmSync(T, { recursive: true, force: true });
console.log(`features-test: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
