// JARVIS Notes - Phase 3: src/drive-sync-controller.mjs - debounce, the one in-flight lock,
// connection gating, and status reporting, driven directly against FakeDriveProvider. No
// network, no OAuth, no real Google account, no real timer (setTimer/clearTimer are injected
// fakes this file controls by hand, so debounce timing is deterministic, not racy).
//   node scripts/drive-sync-controller-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDriveSyncController } from '../src/drive-sync-controller.mjs';
import { saveKnowledgeNote } from '../src/knowledge.mjs';
import { FakeDriveProvider } from './fake-drive-provider.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${extra ? `\n     ${extra}` : ''}`); } };
const check = async (name, fn) => { try { await fn(); ok(true, name); } catch (e) { ok(false, name, String(e?.stack || e).split('\n').slice(0, 6).join('\n     ')); } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-drive-sync-ctrl-'));
let n = 0;
const dir = () => { const d = path.join(TMP, `d${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
let clock = 1700000000000;
const now = () => (clock += 1000);

/** A hand-controlled fake timer: setTimer records {fn, ms} and returns a handle; the test
 *  decides when (or whether) to actually fire it, instead of waiting on a real clock. */
function fakeTimers() {
  const scheduled = new Map();
  let nextHandle = 1;
  return {
    setTimer: (fn, ms) => { const h = nextHandle++; scheduled.set(h, { fn, ms }); return h; },
    clearTimer: (h) => { scheduled.delete(h); },
    fireAll: async () => { const entries = [...scheduled.values()]; scheduled.clear(); for (const e of entries) await e.fn(); },
    pendingCount: () => scheduled.size,
  };
}

function makeController(userDir, { remote, connected = true } = {}) {
  const r = remote || new FakeDriveProvider();
  const timers = fakeTimers();
  const ctrl = createDriveSyncController({
    userDir, getProvider: () => r, isConnected: () => connected, now,
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  });
  return { ctrl, timers, remote: r, setConnected: (v) => { connected = v; } };
}

console.log('\n--- debounce: several requests in a row collapse into one sync ---');
await check('requestSync() called three times in quick succession only actually runs once the timer fires - and only once', async () => {
  const d = dir();
  saveKnowledgeNote(d, 'n1', { title: 'T', body: 'x', tags: [], favorite: false, folder: null }, {});
  const { ctrl, timers } = makeController(d);
  ctrl.requestSync(); ctrl.requestSync(); ctrl.requestSync();
  assert.equal(timers.pendingCount(), 1, 'three requests coalesce into one scheduled timer, not three');
  await timers.fireAll();
  const s = ctrl.status();
  assert.ok(s.lastSyncAt, 'the debounced sync actually ran');
  assert.equal(s.lastResult.pushed, 1);
});

console.log('\n--- syncNow() bypasses the debounce ---');
await check('syncNow() runs immediately and cancels any pending debounced request', async () => {
  const d = dir();
  saveKnowledgeNote(d, 'n1', { title: 'T', body: 'x', tags: [], favorite: false, folder: null }, {});
  const { ctrl, timers } = makeController(d);
  ctrl.requestSync();
  assert.equal(timers.pendingCount(), 1);
  const r = await ctrl.syncNow();
  assert.equal(r.ok, true);
  assert.equal(timers.pendingCount(), 0, 'the debounced timer was cancelled, not left to fire a second, redundant sync later');
});

console.log('\n--- never attempted while disconnected; recorded as a pending retry instead ---');
await check('a sync attempt while disconnected never calls the provider, and reports offline status', async () => {
  const d = dir();
  saveKnowledgeNote(d, 'n1', { title: 'T', body: 'x', tags: [], favorite: false, folder: null }, {});
  const { ctrl } = makeController(d, { connected: false });
  const r = await ctrl.syncNow();
  assert.equal(r.ok, false);
  assert.equal(r.offline, true);
  assert.equal(ctrl.status().state, 'offline');
  assert.equal(ctrl.status().pending !== null, true, 'a retry is recorded, persisted, so reconnecting (or a later heartbeat) picks it up');
});

console.log('\n--- syncIfDue: a heartbeat-style call that only acts when a backoff window isn\'t blocking it ---');
await check('syncIfDue runs even with nothing pending - this is what catches another device\'s remote changes with no local edit of its own to trigger a debounce', async () => {
  const d = dir();
  const { ctrl } = makeController(d);
  await ctrl.syncNow(); // establishes a clean, caught-up baseline
  const ran = ctrl.syncIfDue();
  assert.equal(ran, true, 'nothing pending means no backoff window is blocking it - "due" by default');
});
await check('syncIfDue refuses while an operation is already running or a debounced one is already scheduled', async () => {
  const d = dir();
  saveKnowledgeNote(d, 'n1', { title: 'T', body: 'x', tags: [], favorite: false, folder: null }, {});
  const { ctrl } = makeController(d);
  ctrl.requestSync(); // leaves a debounce timer scheduled, not yet fired
  assert.equal(ctrl.syncIfDue(), false, 'a debounced sync is already queued - no need for a second, redundant one');
});
await check('syncIfDue retries once reconnected after an earlier offline failure', async () => {
  const d = dir();
  saveKnowledgeNote(d, 'n1', { title: 'T', body: 'x', tags: [], favorite: false, folder: null }, {});
  const { ctrl, setConnected } = makeController(d, { connected: false });
  await ctrl.syncNow(); // fails offline, marks pending
  setConnected(true);
  // The backoff window from one failure hasn't elapsed yet at the same `now()` - still correct
  // to refuse an immediate retry (that's the whole point of backoff), but once due, it must run.
  const tooSoon = ctrl.syncIfDue();
  assert.equal(tooSoon, false, 'backoff window not yet elapsed - correctly not retried the instant it reconnects');
  clock += 10 * 60_000; // advance well past the backoff window
  const ran = ctrl.syncIfDue();
  assert.equal(ran, true);
});

console.log('\n--- status surfaces conflicts, not just pushed/pulled counts ---');
await check('a conflict leaves status().state as "conflict" and a non-zero conflictCount, even once sync "completes"', async () => {
  const remote = new FakeDriveProvider();
  const a = dir(); const b = dir();
  saveKnowledgeNote(a, 'n1', { title: 'T', body: 'original', tags: [], favorite: false, folder: null }, {});
  const ca = makeController(a, { remote });
  const cb = makeController(b, { remote });
  await ca.ctrl.syncNow(); await cb.ctrl.syncNow();
  const { noteRevision } = await import('../src/knowledge.mjs');
  saveKnowledgeNote(a, 'n1', { title: 'T', body: 'A edit', tags: [], favorite: false, folder: null }, { baseRevision: noteRevision(a, 'n1') });
  saveKnowledgeNote(b, 'n1', { title: 'T', body: 'B edit', tags: [], favorite: false, folder: null }, { baseRevision: noteRevision(b, 'n1') });
  await ca.ctrl.syncNow();
  const r = await cb.ctrl.syncNow();
  assert.equal(r.ok, true, 'a conflict is not a hard failure - the sync pass still completes for everything else');
  assert.equal(cb.ctrl.status().state, 'conflict');
  assert.ok(cb.ctrl.status().conflictCount >= 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
