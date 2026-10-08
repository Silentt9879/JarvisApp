// The remote button in GitHub Desktop that said "Stopping…" for ever (2026-10-08).
//
// What the log showed: a fetch finished ("git fetch bantupanduv2 ok"), and eleven seconds later
// Stop was pressed - with nothing running. The button had gone back to "Fetching…" by itself.
// Why: progress travels as events and the answer as the reply to the window's call, and the two
// can cross. A progress line that landed just after the answer switched the button busy again,
// the "idle" event behind it was ignored, and Stop then had nothing to stop and nothing to wait
// for. This drives the REAL window code (renderer/git.js, in a stand-in DOM) through exactly
// that order of arrival.   node scripts/remote-button-test.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

let pass = 0; const fails = [];
const check = (n, c, extra) => {
  if (c) { pass += 1; console.log('PASS  ' + n); }
  else { fails.push(n); console.log('FAIL  ' + n + (extra ? '\n        ' + String(extra).slice(0, 320) : '')); }
};
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const tick = async (n = 12) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };

class El {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.className = ''; this.children = []; this.text = ''; this.attrs = {}; this.dataset = {}; this.style = {}; this.hidden = false; this.disabled = false; this.value = ''; this.title = ''; }
  get classList() {
    const self = this;
    const list = () => self.className.split(/\s+/).filter(Boolean);
    return {
      add: (...c) => { self.className = [...new Set([...list(), ...c])].join(' '); },
      remove: (...c) => { self.className = list().filter((x) => !c.includes(x)).join(' '); },
      toggle: (c, on) => { const has = list().includes(c); const want = on === undefined ? !has : !!on; if (want !== has) self.classList[want ? 'add' : 'remove'](c); return want; },
      contains: (c) => list().includes(c),
    };
  }
  appendChild(c) { this.children.push(c); return c; }
  append(...cs) { for (const c of cs) this.appendChild(c); }
  prepend(c) { this.children.unshift(c); }
  replaceChildren(...cs) { this.children = cs; this.text = ''; }
  remove() {}
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  addEventListener() {}
  focus() {}
  scrollIntoView() {}
  closest() { return null; }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.text = String(v); this.children = []; }
}

/** A window with one repository, level with its remote, and a main process the test controls. */
async function open() {
  const byId = new Map();
  const handlers = {};
  const JV = {
    $: (id) => { if (!byId.has(id)) byId.set(id, new El('div')); return byId.get(id); },
    el: (tag, cls, text) => { const n = new El(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; },
    state: { view: 'source' }, on: (k, fn) => { (handlers[k] = handlers[k] || []).push(fn); }, emit() {}, registerPop() {}, icon: () => new El('svg'), notify() {}, feed() {},
  };
  const main = { fetches: [], cancels: [], stateAsked: 0, running: false, cancelAnswer: null };
  const jarvis = {
    gitRepos: async () => ({ ok: true, list: [{ key: 'r', name: 'r', nickname: 'r', ok: true, clean: true }] }),
    gitDetail: async () => ({ ok: true, repo: { key: 'r' }, branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, remotes: [{ name: 'origin' }], lastFetched: Date.now() }),
    gitChanges: async () => ({ ok: true, repo: { key: 'r' }, files: [], counts: { total: 0, staged: 0, untracked: 0, conflicted: 0 } }),
    // The answer to a fetch is given by the test, when it chooses.
    gitFetch: (key) => new Promise((resolve) => { main.running = true; main.fetches.push({ key, answer: (r) => { main.running = false; resolve(r); } }); }),
    gitRemoteCancel: async (key) => { main.cancels.push(key); return main.cancelAnswer || (main.running ? { ok: true, cancelling: true } : { ok: false, error: 'Nothing is running for that repository.' }); },
    gitRemoteState: async () => { main.stateAsked += 1; return { ok: true, repo: { key: 'r' }, state: main.running ? 'fetching' : 'idle' }; },
  };
  const timers = [];
  const window = { JV, jarvis: new Proxy(jarvis, { get: (t, k) => t[k] || (async () => ({ ok: false })) }), addEventListener() {}, removeEventListener() {}, innerWidth: 1280, innerHeight: 800 };
  const document = { hidden: false, createElement: (t) => new El(t), createTextNode: (t) => { const n = new El('#text'); n.textContent = t; return n; }, addEventListener() {}, body: new El('body'), documentElement: new El('html') };
  window.document = document;
  const ctx = vm.createContext({
    JV, window, document, console, Promise,
    localStorage: { getItem: () => 'r', setItem() {} },
    setInterval: () => 0, clearInterval() {}, clearTimeout() {},
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    requestAnimationFrame: (fn) => { fn(); return 0; },
  });
  vm.runInContext(read('src/renderer/paths.js'), ctx, { filename: 'paths.js' });
  vm.runInContext(read('src/renderer/git.js'), ctx, { filename: 'git.js' });
  for (const fn of handlers.view || []) fn('source');
  await tick(30);
  const $ = JV.$;
  return {
    main, timers,
    label: () => $('scRemoteLabel').textContent,
    busy: () => $('scRemoteBtn').classList.contains('busy'),
    disabled: () => $('scRemoteBtn').disabled,
    stopShown: () => !$('scRemoteStop').hidden,
    said: () => $('scRemoteMsg').textContent,
    press: () => { const b = $('scRemoteBtn'); b.onclick({ currentTarget: b }); },
    stop: () => $('scRemoteStop').onclick(),
    refresh: () => { for (const fn of handlers.view || []) fn('source'); },
    event: (e) => { for (const fn of handlers.git_remote || []) fn({ key: 'r', ...e }); },
    /** Run the timers of at least `ms` (the 6-second look after Stop), as if that time had passed. */
    after: async (ms) => { for (const t of timers.splice(0)) if (t.ms >= ms) t.fn(); await tick(); },
  };
}
const FETCHED = { ok: true, key: 'r', op: 'fetch', message: 'Fetched origin. Nothing new.' };

// ------------------------------------------------------------------ the ordinary run, in the ordinary order
let w = await open();
check('at rest the button offers the next thing to do, and Stop is hidden', w.label() === 'Fetch origin' && !w.busy() && !w.stopShown(), w.label());
w.press(); await tick();
w.event({ state: 'fetching', message: 'remote: Counting objects' });
check('while a fetch runs it says "Fetching…", shows progress, and offers Stop',
  w.label() === 'Fetching…' && w.busy() && w.disabled() && w.stopShown() && /Counting objects/.test(w.said()), `${w.label()} | ${w.said()}`);
w.event({ state: 'idle', message: null });
w.main.fetches[0].answer(FETCHED); await tick(30);
check('when the answer comes it goes back to rest and says what happened',
  w.label() === 'Fetch origin' && !w.busy() && !w.stopShown() && /Fetched origin/.test(w.said()), `${w.label()} | ${w.said()}`);

// ------------------------------------------------------------------ THE BUG: the answer overtakes the progress
console.log('\n--- the order of arrival that stranded the button ---');
w = await open();
w.press(); await tick();
w.main.fetches[0].answer(FETCHED); await tick(30);                    // the answer lands first...
w.event({ state: 'fetching', message: 'From github.com:acme/app' });   // ...then a progress line sent before it
w.event({ state: 'idle', message: null });                             // ...then the "finished" that used to be ignored
check('a progress line that lands after the answer does NOT switch the button back to "Fetching…"',
  w.label() === 'Fetch origin' && !w.busy() && !w.disabled() && !w.stopShown(), `${w.label()} busy=${w.busy()} stop=${w.stopShown()}`);
check('...and does not overwrite the result with a stale progress line', /Fetched origin/.test(w.said()) && !/From github/.test(w.said()), w.said());
check('the button still works afterwards: pressing it starts a new fetch', (() => { w.press(); return w.main.fetches.length === 2; })());
w.main.fetches[1].answer(FETCHED); await tick(30);

// ------------------------------------------------------------------ Stop with nothing running can no longer hang
console.log('\n--- Stop ---');
w = await open();
w.press(); await tick();
w.stop(); await tick();
check('Stop while a fetch really runs says "Stopping…" and asks the app to stop it', w.label() === 'Stopping…' && w.main.cancels.length === 1 && !w.stopShown(), w.label());
w.main.fetches[0].answer({ ok: false, key: 'r', cancelled: true, error: 'The fetch was stopped before it finished.' }); await tick(30);
check('...and the stopped operation\'s own answer clears it, saying it was stopped', w.label() === 'Fetch origin' && !w.busy() && /stopped before it finished/.test(w.said()), `${w.label()} | ${w.said()}`);

// The state the user was in: the app has nothing running, yet the window is asked to stop.
// (Reached here through the one moment the window can still be busy with nothing live: the
// answer has arrived while Stop's own request is on its way.)
w = await open();
w.press(); await tick();
w.main.cancelAnswer = { ok: false, error: 'Nothing is running for that repository.' };
w.stop();                                                             // "Stopping…", request sent
w.main.fetches[0].answer(FETCHED);                                    // the fetch had in fact just finished
await tick(30);
check('Stop pressed as the operation finishes: the button ends at rest, never on "Stopping…"',
  w.label() === 'Fetch origin' && !w.busy() && !w.disabled() && !w.stopShown(), `${w.label()} busy=${w.busy()}`);

// The stop is accepted, but the operation's answer never arrives (a helper process that would
// not die, say). Six seconds on, the window asks what is really running and believes it.
w = await open();
w.press(); await tick();
w.stop(); await tick();
const hung = w.label();
w.main.running = false;                                               // the app has nothing running any more
await w.after(6000);
check('if no answer ever comes after Stop, the window asks what is really running and stops waiting',
  hung === 'Stopping…' && w.main.stateAsked === 1 && w.label() === 'Fetch origin' && !w.busy() && /Stopped\./.test(w.said()), `${hung} -> ${w.label()} | ${w.said()} | asked ${w.main.stateAsked}`);

w = await open();
w.press(); await tick();
w.stop(); await tick();
await w.after(6000);                                                  // still running in the app
check('...but while the app says it is still stopping, the window keeps saying so', w.label() === 'Stopping…' && w.main.stateAsked === 1);
w.main.fetches[0].answer({ ok: false, key: 'r', cancelled: true, error: 'The fetch was stopped before it finished.' }); await tick(30);
check('...until the answer arrives', w.label() === 'Fetch origin');

// ------------------------------------------------------------------ what must not have changed
console.log('\n--- unchanged ---');
w = await open();
w.event({ state: 'fetching', message: 'not ours' });
check('an event with no operation of this window\'s behind it changes nothing', w.label() === 'Fetch origin' && !w.busy() && w.said() === '');
w.press(); await tick(); w.press(); await tick();
check('a second press while one is running starts nothing more', w.main.fetches.length === 1);
w.main.fetches[0].answer({ ok: false, key: 'r', error: 'The remote refused the credentials.' }); await tick(30);
check('a failure is still shown as a failure', w.label() === 'Fetch origin' && /refused the credentials/.test(w.said()));
const src = read('src/renderer/git.js');
check('nothing here contacts a remote to find out: the look after Stop reads the app\'s own record',
  /async function reconcileRemote[\s\S]{0,400}window\.jarvis\.gitRemoteState\(key\)/.test(src) && !/reconcileRemote[\s\S]{0,600}gitFetch/.test(src.slice(src.indexOf('async function reconcileRemote'), src.indexOf('async function stopRemote'))));
check('Refresh also puts a button right that is showing work that is not running', /if \(!remoteLive\) reconcileRemote\(\);/.test(src));
check('the one place an operation can begin is still a click on the button',
  (src.match(/runRemote\(/g) || []).length === 2 && /\$\('scRemoteBtn'\)\.onclick = \(e\) => \{ const op = e\.currentTarget\.dataset\.op; if \(op\) runRemote\(op\); \};/.test(src));

console.log(`\n${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('  FAILED: ' + f);
process.exit(fails.length ? 1 : 0);
