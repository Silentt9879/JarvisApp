// Behavioral tests for src/phone.mjs - Android phone alerts over adb - and its watcher
// (createPhoneWatcher). Every adb call goes through an injected `run`, a fake standing in
// for `execFile(adbExecutable(), ...)`, so these tests never invoke the real adb binary and
// never reach, post to, or connect a real phone.
//   node scripts/phone-mjs-test.mjs
import assert from 'node:assert/strict';
import { sh, pickLanAddress, postNotification, listPhones, enableWifi, connect, createPhoneWatcher } from '../src/phone.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${extra ? `\n     ${extra}` : ''}`); } };
const check = async (name, fn) => { try { await fn(); ok(true, name); } catch (e) { ok(false, name, String(e.stack || e).slice(0, 400)); } };

// A fake adb: a queue of canned answers, or a handler keyed by the subcommand. Every call is
// recorded so a test can assert exactly what was asked of "adb", without a real one existing.
function fakeAdb(handler) {
  const calls = [];
  const run = async (args, timeout) => {
    calls.push({ args, timeout });
    return handler(args, calls.length);
  };
  run.calls = calls;
  return run;
}
const SERIAL = 'EMULATOR01-fake';

// ------------------------------------------------------------------ sh() - pure quoting
check('sh(): single quotes are closed and escaped, control characters and newlines are stripped, length is capped', () => {
  assert.equal(sh("it's fine"), "'it'\\''s fine'");
  assert.equal(sh('line one\nline two'), "'line one line two'");
  assert.equal(sh('a\u0000b\u001fc'), "'a b c'");
  assert.equal(sh('x'.repeat(300), 10), `'${'x'.repeat(10)}'`);
  assert.equal(sh(null), "''");
  assert.equal(sh(undefined), "''");
  assert.equal(sh('  spaced out  '), "'spaced out'");
});
check('sh(): a value built entirely of shell metacharacters still comes out as one safely-quoted argument', () => {
  const evil = "'; rm -rf / #";
  const quoted = sh(evil);
  assert.ok(quoted.startsWith("'") && quoted.endsWith("'"));
  // Every quote in the original is closed-escaped-reopened; no unescaped ' remains inside.
  const inner = quoted.slice(1, -1);
  assert.doesNotMatch(inner.replace(/'\\''/g, ''), /'/);
});

// ------------------------------------------------------------------ pickLanAddress() - pure
check('pickLanAddress(): a wlan interface is preferred, mobile-data interfaces are never picked', () => {
  const out = [
    '1: lo    inet 127.0.0.1/8 scope host lo',
    '5: rmnet0 inet 10.81.0.5/30 scope global rmnet0', // carrier NAT, looks like a LAN address but is not usable
    '12: wlan0 inet 192.168.1.42/24 scope global wlan0',
  ].join('\n');
  assert.equal(pickLanAddress(out), '192.168.1.42');
});
check('pickLanAddress(): no usable interface at all is null, not a guess', () => {
  assert.equal(pickLanAddress('1: lo inet 127.0.0.1/8 scope host lo'), null);
  assert.equal(pickLanAddress(''), null);
  assert.equal(pickLanAddress(undefined), null);
});
check('pickLanAddress(): a 172.16-172.31 private range counts as LAN; 172.32 does not', () => {
  assert.equal(pickLanAddress('3: eth0 inet 172.20.5.1/24 scope global eth0'), '172.20.5.1');
  assert.equal(pickLanAddress('3: eth0 inet 172.32.5.1/24 scope global eth0'), null);
});

// ------------------------------------------------------------------ postNotification()
await check('postNotification(): a refused serial never reaches adb at all', async () => {
  const run = fakeAdb(() => { throw new Error('must not be called'); });
  const r = await postNotification('not a serial; rm -rf', { title: 'x', body: 'y' }, { run });
  assert.equal(r.ok, false);
  assert.equal(run.calls.length, 0);
});
await check('postNotification(): a successful post, verified landed - exactly the command adb actually understands', async () => {
  const run = fakeAdb((args, n) => {
    if (n === 1) {
      assert.deepEqual(args.slice(0, 3), ['-s', SERIAL, 'shell']);
      assert.match(args[3], /^cmd notification post -S bigtext -t '.*' 'jarvis' '.*'$/);
      return { ok: true, out: "posting:\nNotification(channel=jarvis ...)" };
    }
    return { ok: true, out: `0|com.android.shell|some_id|jarvis|0x40` };
  });
  const r = await postNotification(SERIAL, { title: 'JARVIS needs you', body: 'Approve a tool' }, { run, landedWaitMs: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.tag, 'jarvis');
});
await check('postNotification(): adb refuses the post - the first line of its own answer is the reason', async () => {
  const run = fakeAdb(() => ({ ok: false, out: 'adb: device offline\nmore detail' }));
  const r = await postNotification(SERIAL, { title: 'x', body: 'y' }, { run });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'adb: device offline');
});
await check('postNotification(): adb never answers at all (a disconnect) - plain words, not a crash', async () => {
  const run = fakeAdb(() => ({ ok: false, out: '' }));
  const r = await postNotification(SERIAL, { title: 'x', body: 'y' }, { run });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'adb did not answer.');
});
await check('postNotification(): posted, but never shown (notifications for Shell are off) - said plainly after real polling', async () => {
  const run = fakeAdb((args, n) => (n === 1 ? { ok: true, out: 'posting: Notification(...)' } : { ok: true, out: 'no matching lines here' }));
  const t0 = Date.now();
  const r = await postNotification(SERIAL, { title: 'x', body: 'y' }, { run, landedWaitMs: 5 });
  assert.equal(r.ok, false);
  assert.match(r.error, /did not show it/);
  assert.equal(run.calls.length, 5, 'posted once, then polled the tray four times before giving up');
  assert.ok(Date.now() - t0 >= 20, 'it really waited between polls, not a zero-delay loop');
});
await check('postNotification(): verify:false skips the tray check entirely - one adb call, not five', async () => {
  const run = fakeAdb(() => ({ ok: true, out: 'posting: Notification(...)' }));
  const r = await postNotification(SERIAL, { title: 'x', body: 'y', verify: false }, { run });
  assert.equal(r.ok, true);
  assert.equal(run.calls.length, 1);
});
await check('postNotification(): a tray read that itself fails to answer is not mistaken for "definitely absent"', async () => {
  const run = fakeAdb((args, n) => (n === 1 ? { ok: true, out: 'posting: Notification(...)' } : { ok: false, out: '' }));
  const r = await postNotification(SERIAL, { title: 'x', body: 'y' }, { run, landedWaitMs: 1 });
  assert.equal(r.ok, true, 'a read that cannot tell does not cry wolf');
  assert.equal(run.calls.length, 2, 'stopped polling as soon as the read itself was unreliable');
});

// ------------------------------------------------------------------ listPhones()
await check('listPhones(): the real adb devices -l shape - device, unauthorized, offline, model, Wi-Fi vs USB', async () => {
  const run = fakeAdb(() => ({
    ok: true,
    out: [
      'List of devices attached',
      'ABCD1234       device usb:1-1 product:x model:Pixel_7 device:panther transport_id:3',
      '192.168.1.50:5555 device product:y model:Galaxy_S21 transport_id:5',
      'WXYZ0001       unauthorized usb:1-2 transport_id:4',
      'QRST9999       offline',
      '',
    ].join('\n'),
  }));
  const list = await listPhones({ run });
  assert.equal(list.length, 4);
  assert.deepEqual([list[0].serial, list[0].state, list[0].model, list[0].wifi], ['ABCD1234', 'device', 'Pixel 7', false]);
  assert.deepEqual([list[1].serial, list[1].wifi], ['192.168.1.50:5555', true]);
  assert.equal(list[2].state, 'unauthorized');
  assert.equal(list[3].state, 'offline');
});
await check('listPhones(): adb itself is unreachable - an empty list, never a throw', async () => {
  const run = fakeAdb(() => ({ ok: false, out: "'adb' is not recognized" }));
  assert.deepEqual(await listPhones({ run }), []);
});
await check('listPhones(): no phones at all is just an empty list', async () => {
  const run = fakeAdb(() => ({ ok: true, out: 'List of devices attached\n' }));
  assert.deepEqual(await listPhones({ run }), []);
});

// ------------------------------------------------------------------ connect()
await check('connect(): a malformed address is refused before adb is ever asked', async () => {
  const run = fakeAdb(() => { throw new Error('must not be called'); });
  for (const bad of ['', 'no-port', '192.168.1.1', 'host:', ':5555', 'a'.repeat(100) + ':1']) {
    assert.equal((await connect(bad, { run })).ok, false, bad);
  }
  assert.equal(run.calls.length, 0);
});
await check('connect(): "connected to" and "already connected" both count as success; anything else is the failure, verbatim', async () => {
  assert.equal((await connect('192.168.1.50:5555', { run: fakeAdb(() => ({ ok: true, out: 'connected to 192.168.1.50:5555' })) })).ok, true);
  assert.equal((await connect('192.168.1.50:5555', { run: fakeAdb(() => ({ ok: true, out: 'already connected to 192.168.1.50:5555' })) })).ok, true);
  const refused = await connect('192.168.1.50:5555', { run: fakeAdb(() => ({ ok: true, out: 'failed to connect to 192.168.1.50:5555: Connection refused' })) });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Connection refused/);
});

// ------------------------------------------------------------------ enableWifi()
await check('enableWifi(): a phone already on Wi-Fi (its serial is an address) is accepted with no adb call at all', async () => {
  const run = fakeAdb(() => { throw new Error('must not be called'); });
  const r = await enableWifi('192.168.1.50:5555', { run });
  assert.deepEqual(r, { ok: true, address: '192.168.1.50:5555' });
  assert.equal(run.calls.length, 0);
});
await check('enableWifi(): an invalid serial is refused up front', async () => {
  const run = fakeAdb(() => { throw new Error('must not be called'); });
  assert.equal((await enableWifi('not valid; rm', { run })).ok, false);
});
await check('enableWifi(): Wi-Fi switched off on the phone - said in those words, not a generic failure', async () => {
  const run = fakeAdb((args) => (args.includes('ip -o -f inet addr show') ? { ok: true, out: '' } : { ok: true, out: 'Wifi is disabled' }));
  const r = await enableWifi(SERIAL, { run });
  assert.equal(r.ok, false);
  assert.match(r.error, /Wi-Fi is switched off/);
});
await check('enableWifi(): on mobile data with Wi-Fi on - told it cannot be reached, not told to turn on Wi-Fi', async () => {
  const run = fakeAdb((args) => (args.includes('ip -o -f inet addr show') ? { ok: true, out: '5: rmnet0 inet 10.1.2.3/30 scope global rmnet0' } : { ok: true, out: 'Wifi is enabled' }));
  const r = await enableWifi(SERIAL, { run });
  assert.equal(r.ok, false);
  assert.match(r.error, /mobile data cannot be reached/);
});
await check('enableWifi(): the full hand-off - find the address, switch to tcpip, then connect to it', async () => {
  const run = fakeAdb((args) => {
    if (args.includes('ip -o -f inet addr show')) return { ok: true, out: '12: wlan0 inet 192.168.1.77/24 scope global wlan0' };
    if (args[2] === 'tcpip') return { ok: true, out: 'restarting in TCP mode port: 5555' };
    if (args[0] === 'connect') return { ok: true, out: 'connected to 192.168.1.77:5555' };
    throw new Error(`unexpected adb call: ${JSON.stringify(args)}`);
  });
  const r = await enableWifi(SERIAL, { run, restartWaitMs: 1 });
  assert.deepEqual(r, { ok: true, address: '192.168.1.77:5555' });
});
await check('enableWifi(): tcpip mode itself refuses - the switch-over stops there, nothing is invented', async () => {
  const run = fakeAdb((args) => {
    if (args.includes('ip -o -f inet addr show')) return { ok: true, out: '12: wlan0 inet 192.168.1.77/24 scope global wlan0' };
    if (args[2] === 'tcpip') return { ok: false, out: 'error: no devices/emulators found' };
    throw new Error('connect must not be attempted after tcpip failed');
  });
  const r = await enableWifi(SERIAL, { run, restartWaitMs: 1 });
  assert.equal(r.ok, false);
  assert.match(r.error, /no devices/);
});

// ------------------------------------------------------------------ createPhoneWatcher(): what earns a buzz
function makeWatcher({ enabled = true, minSeconds = 30, atDesk = false } = {}) {
  const sent = [];
  const cfgState = { enabled, minSeconds, serial: 'x' };
  const w = createPhoneWatcher({
    cfg: () => cfgState,
    atDesk: () => atDesk,
    log: () => {},
    send: async (item) => { sent.push(item); return { ok: true }; },
  });
  return { w, sent, cfgState, setAtDesk: (v) => { atDesk = v; } };
}
const settle = (ms = 3100) => new Promise((r) => setTimeout(r, ms));

await check('createPhoneWatcher(): a permission request away from the desk always buzzes, however short the wait', async () => {
  const { w, sent } = makeWatcher({ atDesk: false });
  w.event({ kind: 'permission', toolName: 'Bash' });
  await settle();
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /needs you/);
});
await check('createPhoneWatcher(): at the desk, nothing is sent at all - you are already looking at it', async () => {
  const { w, sent } = makeWatcher({ atDesk: true });
  w.event({ kind: 'permission', toolName: 'Bash' });
  w.event({ kind: 'result', ok: true, durationMs: 120000 });
  await settle();
  assert.equal(sent.length, 0);
});
await check('createPhoneWatcher(): a turn shorter than minSeconds finishing is not worth a buzz; longer, it is, with the time taken', async () => {
  const { w, sent } = makeWatcher({ minSeconds: 30 });
  w.event({ kind: 'text_final', text: 'All done.' });
  w.event({ kind: 'result', ok: true, durationMs: 5000 });
  await settle();
  assert.equal(sent.length, 0, 'too quick to matter');
  const { w: w2, sent: sent2 } = makeWatcher({ minSeconds: 30 });
  w2.event({ kind: 'text_final', text: 'All done.' });
  w2.event({ kind: 'result', ok: true, durationMs: 65000 });
  await settle();
  assert.equal(sent2.length, 1);
  assert.match(sent2[0].body, /All done\./);
  assert.match(sent2[0].body, /1m 5s/);
});
await check('createPhoneWatcher(): a turn that stopped (not Stop) is worded differently from one that finished', async () => {
  const { w, sent } = makeWatcher();
  w.event({ kind: 'result', ok: false, subtype: 'error_during_execution', durationMs: 40000 });
  await settle();
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /stopped/);
  assert.match(sent[0].body, /error_during_execution/);
});
await check('createPhoneWatcher(): claimed events (remote control already told the phone) never also buzz', async () => {
  const { w, sent } = makeWatcher();
  w.event({ kind: 'permission', toolName: 'Bash' }, { claimed: true });
  w.event({ kind: 'result', ok: true, durationMs: 90000 }, { claimed: true });
  await settle();
  assert.equal(sent.length, 0);
});
await check('createPhoneWatcher(): disabled means nothing is ever queued, let alone sent', async () => {
  const { w, sent } = makeWatcher({ enabled: false, atDesk: false });
  w.event({ kind: 'permission', toolName: 'Bash' });
  await settle();
  assert.equal(sent.length, 0);
});
await check('createPhoneWatcher(): two things close together coalesce - the newest replaces the queued one, not a pile of buzzes', async () => {
  const sent = [];
  const w = createPhoneWatcher({ cfg: () => ({ enabled: true, minSeconds: 30 }), atDesk: () => false, log: () => {}, send: async (item) => { sent.push(item); return { ok: true }; } });
  // The very first post in a fresh watcher has no gap to wait out (lastPost starts at 0), so
  // warm it up first - a real "nothing queued yet" buzz - to get a genuine 3s window to test
  // coalescing within. Only a SHORT wait here: long enough for that immediate flush to land,
  // not long enough for the 3s gap to have already fully elapsed by the next step.
  w.event({ kind: 'permission', toolName: 'warm-up' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 1);
  w.event({ kind: 'question', questions: [{ question: 'Pick one?' }] });
  await new Promise((r) => setTimeout(r, 50));
  w.event({ kind: 'permission', toolName: 'Bash' }); // arrives on the heels of the question, inside the same window
  await settle();
  assert.equal(sent.length, 2, 'the warm-up, plus exactly one more - not a pile of buzzes');
  assert.match(sent[1].body, /Approval needed/, 'the newest one wins, not the first of the pair');
});
await check('createPhoneWatcher(): a route that keeps failing is given up on after three, and reset() tries it again', async () => {
  const sent = [];
  let fail = true;
  const w = createPhoneWatcher({
    cfg: () => ({ enabled: true, minSeconds: 0 }), atDesk: () => false, log: () => {},
    send: async (item) => { sent.push(item); return fail ? { ok: false, error: 'not set up' } : { ok: true }; },
  });
  for (let i = 0; i < 5; i++) { w.event({ kind: 'permission', toolName: `t${i}` }); await settle(); }
  assert.equal(sent.length, 3, 'stopped trying after three refusals, not five');
  fail = false;
  w.reset();
  w.event({ kind: 'permission', toolName: 'retry' });
  await settle();
  assert.equal(sent.length, 4, 'reset() lets it try again');
});
await check('createPhoneWatcher(): a route that reports "skip" (not set up) never counts as a failure at all', async () => {
  const sent = [];
  const w = createPhoneWatcher({ cfg: () => ({ enabled: true, minSeconds: 0 }), atDesk: () => false, log: () => {}, send: async (item) => { sent.push(item); return { ok: false, skip: true }; } });
  for (let i = 0; i < 6; i++) { w.event({ kind: 'permission', toolName: `t${i}` }); await settle(); }
  assert.equal(sent.length, 6, 'skip never trips the give-up-after-three counter');
});

console.log(`phone-mjs-test: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
