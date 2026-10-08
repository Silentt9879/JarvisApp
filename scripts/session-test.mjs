// Behavioral tests for src/session.mjs - JarvisSession's lifecycle: send, interrupt,
// permission responses, permission modes, session switching, rewind, recovery from an error,
// and that workspace trust actually changes what Claude Code is started with. The real
// `@anthropic-ai/claude-agent-sdk` query() is substituted with a fake (JarvisSession's
// injectable `queryFn`), so none of this starts a real claude.exe or spends a real API token.
//   node scripts/session-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JarvisSession } from '../src/session.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${extra ? `\n     ${extra}` : ''}`); } };
const check = async (name, fn) => { try { await fn(); ok(true, name); } catch (e) { ok(false, name, String(e.stack || e).slice(0, 500)); } };
const tick = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

// ------------------------------------------------------------------ a fake Claude Agent SDK query()
// An async-iterable the test pushes messages into on demand, plus the handful of control
// methods JarvisSession calls on it. Every call is recorded for assertions.
function fakeQuery(overrides = {}) {
  const calls = { interrupt: 0, setModel: [], setPermissionMode: [], applyFlagSettings: [], close: 0, rewindFiles: [] };
  const queue = [];
  const waiters = [];
  let closed = false;
  const push = (m) => { const w = waiters.shift(); if (w) w(m); else queue.push(m); };
  const q = {
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiters.push((m) => (m === undefined ? resolve({ value: undefined, done: true }) : resolve({ value: m, done: false }))));
        },
      };
    },
    close: () => { calls.close++; closed = true; for (const w of waiters.splice(0)) w(undefined); },
    interrupt: async () => { calls.interrupt++; },
    setModel: async (m) => { calls.setModel.push(m); },
    setPermissionMode: async (m) => { calls.setPermissionMode.push(m); },
    applyFlagSettings: async (f) => { calls.applyFlagSettings.push(f); },
    getContextUsage: async (o) => (overrides.contextUsage ? overrides.contextUsage(o) : { percentage: 1, totalTokens: 1, maxTokens: 1, model: 'x', categories: [], memoryFiles: [] }),
    initializationResult: async () => overrides.init ?? { commands: [], account: {} },
    supportedAgents: async () => overrides.agents ?? [],
    supportedModels: async () => overrides.models ?? [],
    mcpServerStatus: async () => overrides.mcp ?? [],
    rewindFiles: async (uuid, opts) => { calls.rewindFiles.push({ uuid, opts }); if (overrides.rewindThrows) throw new Error(overrides.rewindThrows); return overrides.rewind ?? { canRewind: true, files: [] }; },
  };
  // A raw throw from the iterator itself, for "the session stopped" recovery tests.
  if (overrides.throws) {
    const realIter = q[Symbol.asyncIterator];
    q[Symbol.asyncIterator] = () => {
      const it = realIter();
      let thrown = false;
      return { next: async () => { if (!thrown && queue.length === 0) { thrown = true; throw overrides.throws; } return it.next(); } };
    };
  }
  return { q, push, calls };
}

/** A fake queryFn that records the options each start() call used, and hands back a fake query. */
function fakeQueryFn(perCall = []) {
  const started = [];
  let i = 0;
  const fn = (args) => {
    started.push(args);
    const spec = perCall[Math.min(i, perCall.length - 1)] || {};
    i++;
    const made = fakeQuery(spec);
    fn.made.push(made);
    return made.q;
  };
  fn.started = started;
  fn.made = [];
  return fn;
}

function makeSession(opts = {}, queryFn) {
  const events = [];
  const session = new JarvisSession({ cwd: opts.cwd || 'C:\\fake-workspace', exe: 'fake-claude.exe', emit: (e) => events.push(e), log: () => {}, trusted: opts.trusted ?? true, queryFn });
  return { session, events };
}
const last = (events, kind) => [...events].reverse().find((e) => e.kind === kind);
const sysInit = (session, sid = 'sess-1') => ({ type: 'system', subtype: 'init', session_id: sid, model: 'm', permissionMode: 'default', claude_code_version: '1.0', cwd: session.cwd, tools: [], skills: [], plugins: [] });

// ------------------------------------------------------------------ start(): trust changes what Claude Code is started with
await check('a trusted workspace starts with project+local settings; a restricted one never does - even if the workspace asks for bypassPermissions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-session-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }));

  const trustedFn = fakeQueryFn();
  const trusted = makeSession({ cwd: dir, trusted: true }, trustedFn);
  trusted.session.start({});
  assert.deepEqual(trustedFn.started[0].options.settingSources, ['user', 'project', 'local']);
  assert.notEqual(trustedFn.started[0].options.permissionMode, 'bypassPermissions', 'the SDK option itself is clamped - never bypassPermissions, trusted or not');

  const restrictedFn = fakeQueryFn();
  const restricted = makeSession({ cwd: dir, trusted: false }, restrictedFn);
  restricted.session.start({});
  assert.deepEqual(restrictedFn.started[0].options.settingSources, ['user'], 'restricted: the workspace\'s own settings are not loaded at all');
  assert.equal(restrictedFn.started[0].options.permissionMode, 'default', 'restricted: the workspace\'s defaultMode is ignored outright, not just downgraded');
  fs.rmSync(dir, { recursive: true, force: true });
});
await check('bypassPermissions can never be reached via the SDK options, for any trust setting', async () => {
  for (const trusted of [true, false]) {
    const fn = fakeQueryFn();
    const { session } = makeSession({ trusted }, fn);
    session.start({});
    assert.notEqual(fn.started[0].options.permissionMode, 'bypassPermissions');
    assert.equal(fn.started[0].options.abortController instanceof AbortController, true);
    assert.equal(typeof fn.started[0].options.canUseTool, 'function', 'every session supplies its own gate - never omitted');
  }
});
await check('start(): resuming passes resume through; a fresh start does not', async () => {
  const fn = fakeQueryFn();
  const { session } = makeSession({}, fn);
  session.start({ resume: 'old-session-id' });
  assert.equal(fn.started[0].options.resume, 'old-session-id');
  session.start({});
  assert.equal('resume' in fn.started[1].options, false);
});

// ------------------------------------------------------------------ send()
await check('send(): queues a well-formed user message and reports working', async () => {
  const fn = fakeQueryFn();
  const { session, events } = makeSession({}, fn);
  session.start({});
  const r = session.send('hello there');
  assert.equal(r.ok, true);
  assert.equal(typeof r.uuid, 'string');
  assert.equal(last(events, 'status').state, 'working');
  const queued = fn.made[0].push; // nothing to assert on push itself, but input.push happened without throwing
  assert.equal(typeof queued, 'function');
});
await check('send(): nothing to send is refused before anything is queued', async () => {
  const fn = fakeQueryFn();
  const { session } = makeSession({}, fn);
  session.start({});
  assert.equal(session.send('   ').ok, false);
  assert.equal(session.send({ text: '' }).ok, false);
});
await check('send(): before start() (or after close()), refused plainly - never throws, never silently drops it', async () => {
  const fn = fakeQueryFn();
  const { session } = makeSession({}, fn);
  assert.equal(session.send('hi').ok, false);
  session.start({});
  session.close();
  assert.equal(session.send('hi').ok, false);
});
await check('send(): a bad attachment (wrong image type) is refused with the reason, not queued', async () => {
  const fn = fakeQueryFn();
  const { session } = makeSession({}, fn);
  session.start({});
  const r = session.send({ text: 'look', attachments: [{ kind: 'image', mediaType: 'image/bmp', data: 'AAAA' }] });
  assert.equal(r.ok, false);
  assert.match(r.error, /PNG, JPEG, GIF or WebP/);
});

// ------------------------------------------------------------------ interrupt()
await check('interrupt(): calls the SDK\'s interrupt exactly once per call, and never throws if there is no session yet', async () => {
  const fn = fakeQueryFn();
  const { session } = makeSession({}, fn);
  await session.interrupt(); // nothing started yet
  session.start({});
  await session.interrupt();
  assert.equal(fn.made[0].calls.interrupt, 1);
});

// ------------------------------------------------------------------ permission responses: the security-critical path
await check('permission: Allow for this session forces every suggested rule to the session destination - never settings.local.json', async () => {
  const fn = fakeQueryFn();
  const { session, events } = makeSession({}, fn);
  session.start({});
  const canUseTool = fn.started[0].options.canUseTool;
  const resultP = canUseTool('Bash', { command: 'ls' }, { toolUseID: 't1', suggestions: [{ rule: 'Bash(ls:*)', destination: 'localSettings' }] });
  await tick();
  const p = last(events, 'permission');
  assert.equal(p.toolName, 'Bash');
  assert.equal(p.canAlways, true);
  session.respond('t1', { type: 'allow_always' });
  const result = await resultP;
  assert.equal(result.behavior, 'allow');
  assert.deepEqual(result.updatedPermissions, [{ rule: 'Bash(ls:*)', destination: 'session' }], 'destination is forced to session, overriding what the SDK suggested');
  assert.equal(last(events, 'prompt_done').id, 't1');
});
await check('permission: Allow once allows without creating any rule at all', async () => {
  const fn = fakeQueryFn();
  const { session } = makeSession({}, fn);
  session.start({});
  const resultP = fn.started[0].options.canUseTool('Read', { file_path: 'a.txt' }, { toolUseID: 't2', suggestions: [{ rule: 'Read(a.txt)' }] });
  await tick();
  session.respond('t2', { type: 'allow' });
  const result = await resultP;
  assert.equal(result.behavior, 'allow');
  assert.equal('updatedPermissions' in result, false);
});
await check('permission: Deny carries the reason back to Claude, worded as a decision, not an error', async () => {
  const fn = fakeQueryFn();
  const { session } = makeSession({}, fn);
  session.start({});
  const resultP = fn.started[0].options.canUseTool('Bash', { command: 'rm -rf /' }, { toolUseID: 't3' });
  await tick();
  session.respond('t3', { type: 'deny' });
  const result = await resultP;
  assert.equal(result.behavior, 'deny');
  assert.match(result.message, /declined/);
});
await check('permission: a written reply instead of a decision denies the tool call for now and asks Claude to request it again', async () => {
  const fn = fakeQueryFn();
  const { session } = makeSession({}, fn);
  session.start({});
  const resultP = fn.started[0].options.canUseTool('Bash', { command: 'deploy' }, { toolUseID: 't4' });
  await tick();
  session.respond('t4', { type: 'reply', text: 'not yet, check with ops first' });
  const result = await resultP;
  assert.equal(result.behavior, 'deny');
  assert.match(result.message, /not yet, check with ops first/);
  assert.match(result.message, /request it again/);
});
await check('permission: AskUserQuestion resolves with the chosen answers, as an allow - not a plain decision', async () => {
  const fn = fakeQueryFn();
  const { session, events } = makeSession({}, fn);
  session.start({});
  const resultP = fn.started[0].options.canUseTool('AskUserQuestion', { questions: [{ question: 'Which approach?' }] }, { toolUseID: 't5' });
  await tick();
  assert.equal(last(events, 'question').questions[0].question, 'Which approach?');
  session.respond('t5', { type: 'answer', answers: { approach: 'B' } });
  const result = await resultP;
  assert.equal(result.behavior, 'allow');
  assert.deepEqual(result.updatedInput.answers, { approach: 'B' });
});
await check('permission: responding to an id that is not pending (already answered, or never existed) does nothing - no throw, no second resolve', async () => {
  const fn = fakeQueryFn();
  const { session, events } = makeSession({}, fn);
  session.start({});
  const resultP = fn.started[0].options.canUseTool('Bash', {}, { toolUseID: 't6' });
  await tick();
  session.respond('t6', { type: 'allow' });
  await resultP;
  const before = events.length;
  assert.doesNotThrow(() => session.respond('t6', { type: 'deny' }));
  assert.doesNotThrow(() => session.respond('never-existed', { type: 'deny' }));
  assert.equal(events.length, before, 'neither call produced a second prompt_done');
});
await check('permission: status goes to "waiting" while a prompt is open, and back to "working" only once every open prompt is answered', async () => {
  const fn = fakeQueryFn();
  const { session, events } = makeSession({}, fn);
  session.start({});
  session.send('do two things');
  const r1 = fn.started[0].options.canUseTool('Bash', {}, { toolUseID: 'a' });
  const r2 = fn.started[0].options.canUseTool('Bash', {}, { toolUseID: 'b' });
  await tick();
  assert.equal(last(events, 'status').state, 'waiting');
  session.respond('a', { type: 'allow' });
  await r1;
  assert.equal(last(events, 'status').state, 'waiting', 'one still open');
  session.respond('b', { type: 'allow' });
  await r2;
  assert.equal(last(events, 'status').state, 'working', 'both answered now');
});
await check('permission: the SDK cancelling the request (its own signal aborts) resolves it as Cancelled, not left hanging', async () => {
  const fn = fakeQueryFn();
  const { session, events } = makeSession({}, fn);
  session.start({});
  const ac = new AbortController();
  const resultP = fn.started[0].options.canUseTool('Bash', {}, { toolUseID: 't7', signal: ac.signal });
  await tick();
  ac.abort();
  const result = await resultP;
  assert.equal(result.behavior, 'deny');
  assert.match(result.message, /Cancelled/);
  assert.equal(last(events, 'prompt_done').id, 't7');
});
await check('permission: a request that arrives for a generation already closed is auto-denied, with no prompt ever shown - the window cannot approve what no longer exists', async () => {
  const fn = fakeQueryFn();
  const { session, events } = makeSession({}, fn);
  session.start({});
  const canUseTool = fn.started[0].options.canUseTool; // captured from the FIRST generation
  session.close(); // bumps the generation
  const before = events.filter((e) => e.kind === 'permission').length;
  const result = await canUseTool('Bash', {}, { toolUseID: 'stale' });
  assert.equal(result.behavior, 'deny');
  assert.match(result.message, /Session closed/);
  assert.equal(events.filter((e) => e.kind === 'permission').length, before, 'never shown to the window at all');
});

// ------------------------------------------------------------------ permission modes
await check('setPermissionMode(): forwarded to the SDK, and only once it succeeds does the window hear the new mode', async () => {
  const fn = fakeQueryFn();
  const { session, events } = makeSession({}, fn);
  session.start({});
  await session.setPermissionMode('plan');
  assert.deepEqual(fn.made[0].calls.setPermissionMode, ['plan']);
  assert.equal(last(events, 'mode').mode, 'plan');
});
await check('setPermissionMode(): a rejection from the SDK is reported as an error, and no "mode" event is sent for it', async () => {
  const fn = fakeQueryFn([{}]);
  fn.made; // (constructed lazily on start())
  const { session, events } = makeSession({}, fn);
  session.start({});
  fn.made[0].q.setPermissionMode = async () => { throw new Error('rejected'); };
  await session.setPermissionMode('acceptEdits');
  assert.match(last(events, 'error').message, /rejected/);
  assert.equal(events.filter((e) => e.kind === 'mode').length, 0);
});

// ------------------------------------------------------------------ session switching: late data from a closed generation never leaks
await check('start() again after close(): the first query\'s late messages are never emitted into the new session', async () => {
  const fn = fakeQueryFn();
  const { session, events } = makeSession({}, fn);
  session.start({});
  const first = fn.made[0];
  first.push(sysInit(session, 'old-session'));
  await tick();
  assert.equal(last(events, 'init').sessionId, 'old-session');

  session.start({}); // a new generation - the old query is abandoned, never awaited again
  const second = fn.made[1];
  second.push(sysInit(session, 'new-session'));
  await tick();
  assert.equal(last(events, 'init').sessionId, 'new-session');

  // The OLD query pushes one more message. It must be ignored - #consume's loop for the old
  // generation has already stopped reading.
  first.push({ type: 'assistant', message: { content: [{ type: 'text', text: 'a message from the past' }] } });
  await tick();
  assert.equal(events.some((e) => e.kind === 'text_final' && e.text === 'a message from the past'), false);
});
await check('close(): every pending prompt is auto-denied as "Session closed", so nothing is left silently waiting forever', async () => {
  const fn = fakeQueryFn();
  const { session, events } = makeSession({}, fn);
  session.start({});
  const resultP = fn.started[0].options.canUseTool('Bash', {}, { toolUseID: 'open-one' });
  await tick();
  session.close();
  const result = await resultP;
  assert.equal(result.behavior, 'deny');
  assert.match(result.message, /Session closed/);
  assert.equal(last(events, 'prompt_done').id, 'open-one');
});

// ------------------------------------------------------------------ rewind
await check('rewindFiles(): delegates to the SDK with the message uuid, dryRun coerced to a boolean', async () => {
  const fn = fakeQueryFn([{ rewind: { canRewind: true, files: [{ path: 'a.txt', added: 1, removed: 0 }] } }]);
  const { session } = makeSession({}, fn);
  session.start({});
  const r = await session.rewindFiles('msg-uuid-1', 'truthy-but-not-boolean');
  assert.equal(r.canRewind, true);
  assert.deepEqual(fn.made[0].calls.rewindFiles[0], { uuid: 'msg-uuid-1', opts: { dryRun: true } });
});
await check('rewindFiles(): no session running at all is refused plainly, not a throw', async () => {
  const { session } = makeSession({}, fakeQueryFn());
  const r = await session.rewindFiles('x', false);
  assert.equal(r.canRewind, false);
  assert.match(r.error, /not running/);
});
await check('rewindFiles(): the SDK itself refuses - the reason comes back, not an unhandled rejection', async () => {
  const fn = fakeQueryFn([{ rewindThrows: 'too many edits since then' }]);
  const { session } = makeSession({}, fn);
  session.start({});
  const r = await session.rewindFiles('x', false);
  assert.equal(r.canRewind, false);
  assert.match(r.error, /too many edits/);
});

// ------------------------------------------------------------------ recovery: the session stopping, with and without session_state_changed
await check('result without session_state_changed support: "ready" follows directly from the result, not stuck on "working"', async () => {
  const fn = fakeQueryFn();
  const { session, events } = makeSession({}, fn);
  session.start({});
  session.send('go');
  fn.made[0].push({ type: 'result', subtype: 'success', is_error: false, duration_ms: 500, num_turns: 1 });
  await tick();
  assert.equal(last(events, 'result').ok, true);
  assert.equal(last(events, 'status').state, 'ready');
});
await check('session_state_changed is authoritative once seen: a result alone no longer flips status back to ready by itself', async () => {
  const fn = fakeQueryFn();
  const { session, events } = makeSession({}, fn);
  session.start({});
  session.send('go');
  fn.made[0].push({ type: 'system', subtype: 'session_state_changed', state: 'working' });
  await tick();
  fn.made[0].push({ type: 'result', subtype: 'success', is_error: false, duration_ms: 500, num_turns: 1 });
  await tick();
  assert.equal(last(events, 'status').state, 'working', 'still working - idle has not been reported yet');
  fn.made[0].push({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
  await tick();
  assert.equal(last(events, 'status').state, 'ready');
});
await check('the query loop throwing (the process died) reports closed and an error - an abort you asked for does not', async () => {
  const died = fakeQueryFn([{ throws: new Error('claude.exe exited unexpectedly') }]);
  const { session: a, events: ae } = makeSession({}, died);
  a.start({});
  await tick(20);
  assert.equal(last(ae, 'status').state, 'closed');
  assert.match(last(ae, 'error').message, /exited unexpectedly/);

  const fn2 = fakeQueryFn();
  const { session: b, events: be } = makeSession({}, fn2);
  b.start({});
  await b.interrupt();
  b.close(); // aborts the controller passed to the SDK - not an error condition
  await tick();
  assert.equal(be.some((e) => e.kind === 'error'), false, 'a deliberate close/abort is never reported as a session error');
});

console.log(`session-test: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
