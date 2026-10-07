// Unplug phone A, plug in phone B: the popped-out phone window used to sit forever on
// "device 'A' not found", because it only ever asked for the one serial from its URL. This
// drives the REAL renderer (phone.js) in a stand-in DOM, with a controllable device list and
// a recorded main-process bridge, through that exact sequence - and the source checks below
// confirm the main-process bookkeeping (wireDocking, the rebind IPC) that makes video and
// docking follow the window to its new phone.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

let pass = 0; const fails = [];
const check = (n, c, extra) => {
  if (c) { pass += 1; console.log('PASS  ' + n); }
  else { fails.push(n); console.log('FAIL  ' + n + (extra ? '\n        ' + String(extra).slice(0, 300) : '')); }
};
// JARVIS's own source, found from this file - not a path on any one machine. No workspace is
// involved at all: the phone window is driven against a stand-in DOM and a recorded bridge.
const APP = process.env.P9_APP || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(p, 'utf8');
const tick = async (n = 10) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };

// ------------------------------------------------------------------ the real renderer
class El {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.className = ''; this.children = []; this.text = ''; this.attrs = {}; this.dataset = {}; this.style = {}; this.hidden = false; this.disabled = false; this.value = ''; this.listeners = {}; }
  get classList() {
    const self = this;
    const list = () => self.className.split(/\s+/).filter(Boolean);
    return {
      add: (...c) => { self.className = [...new Set([...list(), ...c])].join(' '); },
      remove: (...c) => { self.className = list().filter((x) => !c.includes(x)).join(' '); },
      contains: (c) => list().includes(c),
      toggle: (c, on) => { const has = list().includes(c); const want = on === undefined ? !has : !!on; if (want !== has) self.classList[want ? 'add' : 'remove'](c); return want; },
    };
  }
  appendChild(c) { this.children.push(c); return c; }
  append(...cs) { for (const c of cs) this.appendChild(c); }
  replaceChildren(...cs) { this.children = cs; this.text = ''; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(k, fn) { (this.listeners[k] = this.listeners[k] || []).push(fn); }
  focus() {}
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.text = String(v); this.children = []; }
}
const find = (n, pred) => { if (!n) return null; if (pred(n)) return n; for (const c of n.children || []) { const r = find(c, pred); if (r) return r; } return null; };
const findAll = (n, pred, out = []) => { if (!n) return out; if (pred(n)) out.push(n); for (const c of n.children || []) findAll(c, pred, out); return out; };

function makeEnv(serial) {
  const phoneRoot = new El('div');
  const documentElement = { dataset: {} };
  const document_ = {
    documentElement,
    hidden: false,
    activeElement: null,
    title: '',
    createElement: (t) => new El(t),
    createTextNode: (t) => { const n = new El('#text'); n.textContent = t; return n; },
    getElementById: (id) => (id === 'phoneRoot' ? phoneRoot : null),
    addEventListener: () => {},
  };
  const handlers = {};
  const JV = {
    el: (tag, cls, text) => { const n = new El(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; },
    icon: () => new El('svg'),
    prefs: { theme: 'system' },
    phone: {
      makeScreen: () => ({ packet() {}, resync() {}, close() {} }),
      wireInput: () => {},
    },
    on: (k, fn) => { (handlers[k] = handlers[k] || []).push(fn); },
    emit: (k, e) => { for (const fn of handlers[k] || []) fn(e); },
  };
  // The test's view into the main process: a controllable device list, and every call the
  // renderer makes recorded for the checks below.
  const state = { devices: [], mirrorOk: false, rebindOk: true, apps: [] };
  const calls = { mirror: [], rebind: [], flutterRun: [], flutterCmd: [] };
  const jarvis = {
    deviceInput: () => {},
    mirror: async (s, on) => { calls.mirror.push({ serial: s, on }); return state.mirrorOk ? { ok: true } : { ok: false, error: `device '${s}' not found` }; },
    devices: async () => ({ ok: true, list: state.devices }),
    flutterApps: async () => state.apps,
    flutterRun: async (s, app) => { calls.flutterRun.push({ s, app }); return { ok: true, run: { app, name: app, state: 'starting', since: Date.now() } }; },
    flutterCmd: async (s, cmd) => { calls.flutterCmd.push({ s, cmd }); return { ok: true }; },
    flutterLog: async () => [],
    phoneWindow: async (was, action, extra) => {
      calls.rebind.push({ was, action, extra });
      if (action !== 'rebind') return { ok: true };
      return state.rebindOk ? { ok: true } : { ok: false, error: 'That phone already has its own window.' };
    },
    resetVideo: async () => {},
    titleBar: () => {},
    onVideo: () => {},
    onEvent: () => {},
  };
  const window_ = {
    jarvis,
    document: document_,
    location: { search: `?serial=${serial}` },
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
  };
  let nextId = 1;
  const intervals = new Map();
  const ctx = vm.createContext({
    JV, window: window_, document: document_, location: window_.location, console, Promise, URLSearchParams,
    localStorage: { store: {}, getItem(k) { return this.store[k] ?? null; }, setItem(k, v) { this.store[k] = v; } },
    setInterval: (fn) => { const id = nextId++; intervals.set(id, fn); return id; },
    clearInterval: (id) => intervals.delete(id),
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout() {},
  });
  window_.document = document_;
  return { ctx, JV, root: phoneRoot, state, calls, intervals, tickWatch: async () => { const fns = [...intervals.values()]; for (const fn of fns) await fn(); } };
}

// ------------------------------------------------------------------ scenario A: swap for one new phone
{
  const env = makeEnv('A');
  vm.runInContext(read(`${APP}/src/renderer/phone.js`), env.ctx, { filename: 'phone.js' });
  await tick();

  const root = env.root.children[0];
  const overlayTitle = () => find(root, (n) => n.className === 'ov-title')?.textContent;
  const serialEl = () => findAll(root, (n) => n.tagName === 'SMALL')[0];
  const modelEl = () => find(root, (n) => n.tagName === 'B');

  check('phone A is not connected at open: said plainly, and watching starts on its own',
    /not connected/i.test(overlayTitle()) && env.intervals.size === 1, overlayTitle());

  // Phone B appears. A is still nowhere to be found.
  env.state.devices = [{ serial: 'B', state: 'device', model: 'Phone B', popped: false }];
  await env.tickWatch();
  await tick();

  check('one new, unclaimed phone is adopted automatically - no choice to make',
    env.calls.rebind.length === 1 && env.calls.rebind[0].was === 'A' && env.calls.rebind[0].extra === 'B' && env.calls.rebind[0].action === 'rebind');
  check('the window now shows Phone B, not A', modelEl()?.textContent === 'Phone B' && serialEl()?.textContent === 'B');
  check('it then tries to start the screen on the NEW serial, not the old one',
    env.calls.mirror.at(-1)?.serial === 'B');
  check('the watch that found it stopped - it does not keep rebinding on every tick',
    env.intervals.size <= 1); // a fresh watch may have started after the (stubbed) mirror attempt failed again
}

// ------------------------------------------------------------------ scenario B: the same phone comes back
{
  const env = makeEnv('A');
  vm.runInContext(read(`${APP}/src/renderer/phone.js`), env.ctx, { filename: 'phone.js' });
  await tick();
  env.state.devices = [{ serial: 'A', state: 'device', model: 'Phone A', popped: false }];
  await env.tickWatch();
  await tick();
  check('phone A reappearing (replugged) is just retried - no rebind call at all',
    env.calls.rebind.length === 0 && env.calls.mirror.some((m) => m.serial === 'A'));
}

// ------------------------------------------------------------------ scenario C: two new phones - a choice, not a guess
{
  const env = makeEnv('A');
  vm.runInContext(read(`${APP}/src/renderer/phone.js`), env.ctx, { filename: 'phone.js' });
  await tick();
  env.state.devices = [
    { serial: 'B', state: 'device', model: 'Phone B', popped: false },
    { serial: 'C', state: 'device', model: 'Phone C', popped: false },
  ];
  await env.tickWatch();
  await tick();

  const root = env.root.children[0];
  const buttons = findAll(root, (n) => n.tagName === 'BUTTON' && n.className === 'btn small');
  check('two unclaimed phones: nothing is guessed - a button for each, and no rebind yet',
    env.calls.rebind.length === 0 && buttons.length === 2 && buttons.some((b) => b.textContent === 'Phone B') && buttons.some((b) => b.textContent === 'Phone C'),
    buttons.map((b) => b.textContent).join(','));
  check('watching paused while the choice is shown - it does not rewrite the buttons under the cursor',
    env.intervals.size === 0);

  buttons.find((b) => b.textContent === 'Phone C').onclick();
  await tick();
  check('picking one adopts exactly that one', env.calls.rebind.length === 1 && env.calls.rebind[0].extra === 'C');
}

// ------------------------------------------------------------------ scenario D: a device already in its own window is never taken
{
  const env = makeEnv('A');
  vm.runInContext(read(`${APP}/src/renderer/phone.js`), env.ctx, { filename: 'phone.js' });
  await tick();
  env.state.devices = [{ serial: 'B', state: 'device', model: 'Phone B', popped: true }];
  await env.tickWatch();
  await tick();
  check('a phone that already has its own window is not offered or adopted',
    env.calls.rebind.length === 0 && env.intervals.size === 1); // keeps watching - nothing usable yet
}

// ------------------------------------------------------------------ scenario E: the header button switches on purpose, not only on failure
{
  const env = makeEnv('A');
  env.state.mirrorOk = true; // A is connected and live - not a failure path
  env.state.devices = [{ serial: 'A', state: 'device', model: 'Phone A', popped: false }];
  vm.runInContext(read(`${APP}/src/renderer/phone.js`), env.ctx, { filename: 'phone.js' });
  await tick();
  const root = env.root.children[0];
  check('live and well: nothing is watching in the background', env.intervals.size === 0);

  env.state.devices = [
    { serial: 'A', state: 'device', model: 'Phone A', popped: false },
    { serial: 'B', state: 'device', model: 'Phone B', popped: false },
  ];
  const switchBtn = find(root, (n) => n.tagName === 'BUTTON' && n.title === 'Switch to a different phone');
  switchBtn.onclick();
  await tick();
  const choiceBtn = findAll(root, (n) => n.tagName === 'BUTTON' && n.className === 'btn small').find((b) => b.textContent === 'Phone B');
  check('the header button offers a switch any time, not only when the phone is missing', !!choiceBtn);
  choiceBtn.onclick();
  await tick();
  check('and switching by hand uses the same rebind path', env.calls.rebind.length === 1 && env.calls.rebind[0].extra === 'B');
}

// ------------------------------------------------------------------ scenario F: the person's own warning comes before a run
{
  const env = makeEnv('A');
  env.state.mirrorOk = true;
  env.state.devices = [{ serial: 'A', state: 'device', model: 'Phone A', popped: false }];
  env.state.apps = [
    { key: 'shop', name: 'Shop App', dir: 'shop', found: true, warn: 'Uses the live database' },
    { key: 'demo', name: 'Demo App', dir: 'demo', found: true, warn: null },
  ];
  vm.runInContext(read(`${APP}/src/renderer/phone.js`), env.ctx, { filename: 'phone.js' });
  await tick();
  const root = env.root.children[0];
  const select = find(root, (n) => n.tagName === 'SELECT');
  const runBtn = find(root, (n) => n.tagName === 'BUTTON' && n.textContent === 'Run');
  const overlayTitle = () => find(root, (n) => n.className === 'ov-title')?.textContent;
  const overlayButton = (label) => findAll(root, (n) => n.tagName === 'BUTTON' && n.className === 'btn small').find((b) => b.textContent === label);
  const before = overlayTitle();

  select.value = 'shop';
  runBtn.onclick();
  await tick();
  check('an app with a warning asks first, on the screen, in the person\'s own words',
    overlayTitle() === 'Run Shop App?' && /Uses the live database/.test(find(root, (n) => n.className === 'ov-sub')?.textContent || '') && env.calls.flutterRun.length === 0,
    overlayTitle());
  overlayButton('Cancel').onclick();
  await tick();
  check('Cancel runs nothing, and the screen shows what it showed before',
    env.calls.flutterRun.length === 0 && overlayTitle() === before, `${overlayTitle()} / ${before}`);
  runBtn.onclick();
  await tick();
  overlayButton('Run Shop App').onclick();
  await tick();
  check('confirming runs exactly that app on this phone',
    env.calls.flutterRun.length === 1 && env.calls.flutterRun[0].app === 'shop' && env.calls.flutterRun[0].s === 'A');

  const env2 = makeEnv('A');
  env2.state.mirrorOk = true;
  env2.state.devices = [{ serial: 'A', state: 'device', model: 'Phone A', popped: false }];
  env2.state.apps = env.state.apps;
  vm.runInContext(read(`${APP}/src/renderer/phone.js`), env2.ctx, { filename: 'phone.js' });
  await tick();
  const root2 = env2.root.children[0];
  find(root2, (n) => n.tagName === 'SELECT').value = 'demo';
  find(root2, (n) => n.tagName === 'BUTTON' && n.textContent === 'Run').onclick();
  await tick();
  check('an app with no warning runs at once - nothing is asked',
    env2.calls.flutterRun.length === 1 && env2.calls.flutterRun[0].app === 'demo');
}

console.log('\n--- devices.js: the same question on the Devices page ---');
const devices = read(`${APP}/src/renderer/devices.js`);
check('a run from a phone card asks first when the app has a warning, and Run on every phone asks once',
  /async function okToRun\(key\)[\s\S]{0,300}JV\.confirm\(/.test(devices)
  && /async function flutterRun\(c, \{ asked = false \} = \{\}\) \{\s*if \(!asked && !\(await okToRun\(c\.app\.value\)\)\) return;/.test(devices)
  && /if \(!app \|\| !\(await okToRun\(app\)\)\) return;[\s\S]{0,300}await flutterRun\(c, \{ asked: true \}\);/.test(devices));

// ------------------------------------------------------------------ what must not have changed, and the main-process bookkeeping
console.log('\n--- main.mjs: the window keeps working after a rebind, not just the renderer ---');
const main = read(`${APP}/src/main.mjs`);
check('every closure that can outlive a rebind reads the window\'s CURRENT phone, not the one it opened with',
  /function wireDocking\(pw\)/.test(main) && !/function wireDocking\(serial, pw\)/.test(main)
  && /pw\.currentSerial = serial;/.test(main) && (main.match(/pw\.currentSerial/g) || []).length >= 5);
check('the rebind action moves the phoneWindows entry and tells both cards what happened',
  /if \(action === 'rebind'\) \{[\s\S]{0,1200}phoneWindows\.delete\(serial\);[\s\S]{0,100}phoneWindows\.set\(extra, pw\);[\s\S]{0,100}pw\.currentSerial = extra;[\s\S]{0,300}toWindow\(\{ kind: 'phone_docked', serial \}\);[\s\S]{0,100}toWindow\(\{ kind: 'phone_popped', serial: extra \}\);/.test(main));
check('rebinding onto a phone that already has its own window is refused, not silently stolen',
  /if \(phoneWindows\.has\(extra\)\) return \{ ok: false, error:/.test(main));
check('a window that is not actually open cannot be rebound', /if \(!alive\) return \{ ok: false, error: 'That window is not open\.' \};/.test(main));
const preload = read(`${APP}/src/preload.cjs`);
check('the bridge passes the extra argument the rebind action needs',
  /phoneWindow: \(serial, action, extra\) => ipcRenderer\.invoke\('jarvis:phoneWindow', serial, action, extra\)/.test(preload));

console.log(`\n${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('  FAILED: ' + f);
process.exit(fails.length ? 1 : 0);
