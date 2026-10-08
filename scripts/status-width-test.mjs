// Two things from 2026-10-08:
//   1. The status pill said "Needs attention" over a Health page with every row in order. The pill
//      kept reasons of its own (a connected tool not signed in, knowledge behind the code) that
//      Health never listed. Now the pill shows Health's verdict, and Health lists those two.
//   2. The chat was a fixed 760 px column. Now it fits the window by default and can be set.
// The real Health rules, the real pill function (lifted out of app.js) and the real chat-width.js
// are run here; nothing is copied.   node scripts/status-width-test.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { buildHealth } from '../src/health.mjs';

let pass = 0; const fails = [];
const check = (n, c, extra) => {
  if (c) { pass += 1; console.log('PASS  ' + n); }
  else { fails.push(n); console.log('FAIL  ' + n + (extra ? '\n        ' + String(extra).slice(0, 320) : '')); }
};
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

// ------------------------------------------------------------------ 1a. Health knows what the pill knew
const FINE = { claudeFound: true, signedIn: true, account: 'a@b.c', workspaceConfigured: true, workspaceFound: true, workspace: 'C:/ws', workspaceTrusted: true, policySource: 'workspace', telegramOn: true, githubOn: true, clickup: { used: true }, version: '2.1.0', capabilities: [] };
const by = (h) => Object.fromEntries(h.checks.map((c) => [c.id, c]));
const STALE = { available: true, state: 'stale', stale: [{ file: 'auth.md' }, { file: 'database.md' }] };
const NEEDS_SIGN_IN = [{ name: 'clickup', status: 'connected' }, { name: 'plugin:context7:context7', status: 'needs-auth' }];

console.log('--- Health ---');
let h = buildHealth({ ...FINE, connectors: NEEDS_SIGN_IN, knowledge: STALE });
check('the reported case - a tool not signed in, knowledge behind the code, all else fine - is "Everything is in order"',
  h.level === 'ok' && h.summary === 'Everything is in order' && h.bad === 0 && h.warn === 0, `${h.level} / ${h.summary}`);
check('...and both are now LISTED in Health, each with what it is and a button',
  by(h).connectors?.state === 'off' && by(h).knowledge?.state === 'note' && by(h).connectors.fix?.action === 'tools' && !!by(h).knowledge.fix,
  JSON.stringify([by(h).connectors, by(h).knowledge]).slice(0, 300));
check('the tool is named plainly ("context7", not "plugin:context7:context7") and said to be optional',
  /^1 connected\. context7 is installed but not signed in/.test(by(h).connectors.detail) && /Optional/.test(by(h).connectors.detail) && !/plugin:/.test(by(h).connectors.detail), by(h).connectors.detail);
check('stale knowledge says how much, that nothing is broken, and counts as "Good to know"',
  /^Behind the code: 2 knowledge files describe code/.test(by(h).knowledge.detail) && /Nothing is broken/.test(by(h).knowledge.detail), by(h).knowledge.detail);

h = buildHealth({ ...FINE, connectors: [{ name: 'figma', status: 'failed' }, { name: 'x', status: 'needs-auth' }] });
check('a tool that FAILED to connect is something to look at - and Health says which',
  h.level === 'warn' && by(h).connectors.state === 'warn' && /^figma could not connect/.test(by(h).connectors.detail) && /x is installed but not signed in/.test(by(h).connectors.detail), by(h).connectors.detail);
h = buildHealth({ ...FINE, connectors: [{ name: 'a', status: 'connected' }, { name: 'b', status: 'connected' }] });
check('every tool connected is in order', by(h).connectors.state === 'ok' && by(h).connectors.detail === '2 connected.' && by(h).connectors.fix === null);
check('no session yet, so nothing reported: no row at all, not a guess', !('connectors' in by(buildHealth({ ...FINE }))) && !('connectors' in by(buildHealth({ ...FINE, connectors: [] }))));

check('knowledge up to date is in order', by(buildHealth({ ...FINE, knowledge: { available: true, state: 'current' } })).knowledge.state === 'ok');
check('a workspace that keeps no knowledge notes has no knowledge row',
  !('knowledge' in by(buildHealth({ ...FINE, knowledge: { available: false } }))) && !('knowledge' in by(buildHealth({ ...FINE, knowledge: null }))));
const withRelearn = by(buildHealth({ ...FINE, knowledge: { ...STALE, relearn: true } })).knowledge;
check('where the workspace has /relearn, the button puts it in the chat; elsewhere it opens Knowledge',
  withRelearn.fix.action === 'relearn' && /Run \/relearn when it suits you/.test(withRelearn.detail)
  && by(buildHealth({ ...FINE, knowledge: STALE })).knowledge.fix.action === 'knowledge' && !/relearn/.test(by(buildHealth({ ...FINE, knowledge: STALE })).knowledge.detail));
check('one stale file reads in the singular', /1 knowledge file describes code/.test(by(buildHealth({ ...FINE, knowledge: { available: true, state: 'stale', stale: [{}] } })).knowledge.detail));
check('never scanned, or could not be checked: said as such, still not a fault',
  /Not scanned yet/.test(by(buildHealth({ ...FINE, knowledge: { available: true, state: 'no-baseline' } })).knowledge.detail)
  && /Could not be checked: python missing/.test(by(buildHealth({ ...FINE, knowledge: { available: true, state: 'unknown', error: 'python missing' } })).knowledge.detail)
  && buildHealth({ ...FINE, knowledge: { available: true, state: 'unknown' } }).level === 'ok');
check('the rows stay grouped: knowledge with JARVIS\'s own, tools with the integrations',
  by(buildHealth({ ...FINE, connectors: NEEDS_SIGN_IN, knowledge: STALE })).knowledge.group === 'core' && by(buildHealth({ ...FINE, connectors: NEEDS_SIGN_IN })).connectors.group === 'integrations');

// ------------------------------------------------------------------ 1b. the pill, lifted out of app.js
console.log('\n--- the status pill ---');
const app = read('src/renderer/app.js');
const src = /  function renderSysStatus\(\) \{[\s\S]*?\n  \}\n/.exec(app)?.[0] || '';
check('the pill function is found in app.js', src.length > 200);
function pill(state) {
  const els = { sysStatus: { className: '', title: '' }, sysStatusText: { textContent: '' } };
  const fn = new Function('state', '$', `${src}; return renderSysStatus;`)(state, (id) => els[id]);
  fn();
  return { word: els.sysStatusText.textContent, level: /l-(\w+)/.exec(els.sysStatus.className)[1], title: els.sysStatus.title };
}
const SESSION = { info: { workspace: 'C:/ws' }, status: 'ready', pendingPrompts: 0, mcp: NEEDS_SIGN_IN, workspace: { knowledge: STALE } };
let p = pill({ ...SESSION, health: buildHealth({ ...FINE, connectors: NEEDS_SIGN_IN, knowledge: STALE }) });
check('THE BUG: tool not signed in + stale knowledge + Health in order -> the pill says "All systems normal"',
  p.word === 'All systems normal' && p.level === 'ok', JSON.stringify(p));
check('the pill no longer keeps reasons of its own: it reads neither the tool list nor the knowledge state',
  !/state\.mcp|state\.workspace|knowledge/.test(src));
p = pill({ ...SESSION, health: buildHealth({ ...FINE, connectors: [{ name: 'figma', status: 'failed' }] }) });
check('when Health has something to look at, the pill says so and its tooltip names the row',
  p.word === 'Needs attention' && p.level === 'warn' && /1 thing to look at: Connected tools\./.test(p.title) && /Click to open Health\./.test(p.title), p.title);
p = pill({ ...SESSION, health: buildHealth({ ...FINE, signedIn: false }) });
check('when Health has something broken, the pill says "Needs fixing"', p.word === 'Needs fixing' && p.level === 'bad' && /Signed in to Claude/.test(p.title), JSON.stringify(p));
check('before Health has answered, the pill does not invent a problem', pill({ ...SESSION, health: null }).word === 'All systems normal');
check('what the session itself is doing still comes first: offline, connecting, waiting for you',
  pill({ ...SESSION, status: 'closed', health: buildHealth(FINE) }).word === 'Offline'
  && pill({ ...SESSION, status: 'starting', health: buildHealth({ ...FINE, signedIn: false }) }).word === 'Connecting'
  && pill({ ...SESSION, status: 'waiting', health: buildHealth(FINE) }).word === 'Awaiting you'
  && pill({ ...SESSION, pendingPrompts: 1, health: buildHealth(FINE) }).word === 'Awaiting you');
check('working, with Health in order, reads "Working"; with no folder chosen, "Choose a workspace"',
  pill({ ...SESSION, status: 'working', health: buildHealth(FINE) }).word === 'Working'
  && pill({ ...SESSION, info: { workspace: null }, health: buildHealth(FINE) }).word === 'Choose a workspace');
// The point of the fix, checked wholesale: with the session ready, pill and Health are one verdict.
const combos = [];
for (const signedIn of [true, false, null]) for (const conn of [undefined, NEEDS_SIGN_IN, [{ name: 'f', status: 'failed' }]]) for (const kn of [null, STALE, { available: true, state: 'current' }]) for (const cu of [{ used: true }, { used: true, error: 'x' }]) {
  const hh = buildHealth({ ...FINE, signedIn, connectors: conn, knowledge: kn, clickup: cu });
  combos.push(pill({ ...SESSION, health: hh }).level === hh.level);
}
check(`pill and Health give the same verdict in all ${combos.length} combinations tried`, combos.every(Boolean), combos.filter((x) => !x).length + ' disagreed');

// ------------------------------------------------------------------ 2. chat width
console.log('\n--- chat width ---');
class El {
  constructor() { this.className = ''; this.children = []; this.dataset = {}; this.attrs = {}; this.listeners = {}; this.hidden = true; this.value = ''; this.textContent = ''; this.title = ''; this.props = {}; const self = this;
    this.style = { setProperty: (k, v) => { self.props[k] = v; }, removeProperty: (k) => { delete self.props[k]; } }; }
  get classList() { const s = this; const list = () => s.className.split(/\s+/).filter(Boolean);
    return { toggle: (c, on) => { const has = list().includes(c); if (on && !has) s.className = [...list(), c].join(' '); if (!on && has) s.className = list().filter((x) => x !== c).join(' '); }, contains: (c) => list().includes(c) }; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(k, fn) { (this.listeners[k] = this.listeners[k] || []).push(fn); }
  fire(k, ev) { for (const fn of this.listeners[k] || []) fn(ev); }
  closest() { return this; }
}
function chatWidth(saved) {
  const ids = {};
  for (const id of ['chatMain', 'widthPop', 'widthBtn', 'widthSeg', 'widthOwn', 'widthOwnOut', 'widthNote']) ids[id] = new El();
  ids.widthSeg.children = ['fit', 'wide', 'reading'].map((w) => { const b = new El(); b.dataset.width = w; return b; });
  const store = {};
  const pops = [];
  const JV = { $: (id) => ids[id] || null, prefs: saved === undefined ? {} : { chatWidth: saved }, savePrefs: () => { store.saved = JSON.parse(JSON.stringify(JV.prefs)); }, registerPop: (...a) => pops.push(a) };
  vm.runInContext(read('src/renderer/chat-width.js'), vm.createContext({ JV, console }), { filename: 'chat-width.js' });
  return { JV, ids, store, pops, main: ids.chatMain };
}
let w = chatWidth(undefined);
const N = w.JV.chatWidth.normalise;
check('a JARVIS that never chose a width FITS the window - the new default, with no setting needed',
  w.main.dataset.width === 'fit' && !('--chat-w' in w.main.props) && w.ids.widthSeg.children[0].classList.contains('on') && /Fills the window/.test(w.ids.widthNote.textContent));
check('whatever was saved comes back as Fit, Wide, Reading or a share from 50 to 100 - anything else is Fit',
  N('fit') === 'fit' && N('wide') === 'wide' && N('reading') === 'reading' && N(70) === 70 && N('85') === 85 && N(12) === 50 && N(400) === 100 && N(73) === 75
  && [undefined, null, '', 'huge', NaN, true, {}, 'own'].every((v) => N(v) === 'fit'));
w.ids.widthSeg.fire('click', { target: w.ids.widthSeg.children[2] });
check('choosing Reading sets it on the chat, marks it, and saves it',
  w.main.dataset.width === 'reading' && w.store.saved.chatWidth === 'reading' && w.ids.widthSeg.children[2].attrs['aria-checked'] === 'true' && w.ids.widthSeg.children[0].attrs['aria-checked'] === 'false' && /Reading/.test(w.ids.widthBtn.title));
w.ids.widthOwn.fire('input', { target: { value: '70' } });
check('"Your own" is a SHARE of the chat area, so it still follows the window: 70% is stored and set as 70%',
  w.main.dataset.width === 'own' && w.main.props['--chat-w'] === '70%' && w.store.saved.chatWidth === 70 && w.ids.widthOwnOut.textContent === '70%' && /70% of the chat area/.test(w.ids.widthNote.textContent)
  && w.ids.widthSeg.children.every((b) => b.attrs['aria-checked'] === 'false'));
w.ids.widthSeg.fire('click', { target: w.ids.widthSeg.children[0] });
check('going back to Fit clears the share, so nothing is left pinned', w.main.dataset.width === 'fit' && !('--chat-w' in w.main.props) && w.store.saved.chatWidth === 'fit');
check('a saved share is put back when JARVIS opens', chatWidth(80).main.props['--chat-w'] === '80%' && chatWidth('wide').main.dataset.width === 'wide');
w.ids.widthBtn.onclick();
const opened = !w.ids.widthPop.hidden;
w.ids.widthBtn.onclick();
check('the width button opens and closes its panel, and the panel closes with the other menus', opened && w.ids.widthPop.hidden && w.pops.length === 1 && w.pops[0][0] === w.ids.widthPop);
const bare = { $: () => null, prefs: {}, savePrefs() {}, registerPop() {} };
vm.runInContext(read('src/renderer/chat-width.js'), vm.createContext({ JV: bare, console }));
check('a window with no chat in it (the phone window) loads the file without error', typeof bare.chatWidth.normalise === 'function');

const css = read('src/renderer/styles.css');
const rule = (sel) => (new RegExp(`^${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{[^}]*\\}`, 'm').exec(css) || [''])[0];
check('Fit is what the stylesheet does with no setting: the full width, margins that grow with the chat area between 28 and 80 px',
  css.includes('\n.chat-main { --chat-w: 100%; --chat-gut: clamp(28px, 4%, 80px); }'));
check('Reading is the old column exactly (760 px, 28 px margins); Wide is 1100 px',
  /--chat-w: 760px; --chat-gut: 28px;/.test(rule('.chat-main[data-width="reading"]')) && /--chat-w: 1100px;/.test(rule('.chat-main[data-width="wide"]')));
check('the messages, the message box and the hint under it all follow that one width',
  /max-width: var\(--chat-w\);[^}]*padding: 0 var\(--chat-gut\)/.test(rule('.transcript > *')) && /padding: 10px var\(--chat-gut\) 18px/.test(rule('.composer'))
  && /max-width: var\(--chat-w\)/.test(/\.composer-box \{[^}]*\}/.exec(css)[0]) && /max-width: var\(--chat-w\)/.test(rule('.composer-hint')));
check('no fixed 760 px is left on the chat column',
  !/\.transcript > \*[^}]*760px/.test(css) && !/\.composer-box \{[^}]*760px/.test(css) && !/\.composer-hint \{[^}]*760px/.test(css) && !/\.transcript > \.prompt[^}]*704px/.test(css));
check('.chat-main is not made a query container, which would re-anchor the menus that open from the message box', !/\.chat-main[^{]*\{[^}]*container-type/.test(css));

// ------------------------------------------------------------------ wiring
console.log('\n--- wiring ---');
const html = read('src/renderer/index.html');
const features = read('src/features.mjs');
const main = read('src/main.mjs');
const healthJs = read('src/renderer/health.js');
check('the width button sits in the message box\'s bar, with its panel; each id declared once',
  ['widthBtn', 'widthPop', 'widthSeg', 'widthOwn', 'widthOwnOut', 'widthNote'].every((id) => html.split(`id="${id}"`).length === 2)
  && html.indexOf('id="widthBtn"') > html.indexOf('class="cbar"') && html.indexOf('id="widthBtn"') < html.indexOf('id="modeBtn"'));
check('chat-width.js loads after the chat and before the app starts',
  html.indexOf('"chat.js"') < html.indexOf('"chat-width.js"') && html.indexOf('"chat-width.js"') < html.indexOf('"app.js"'));
check('the width icon exists', /\n    width: '<path/.test(read('src/renderer/core.js')));
check('main keeps the tools Claude last reported, forgets them when a session restarts, and hands them to Health',
  /if \(evt\.kind === 'mcp' && !pane && Array\.isArray\(evt\.list\)\) connectors = /.test(features) && /evt\.state === 'starting'\) connectors = \[\];/.test(features)
  && /\n      connectors,\n      knowledge: d\.knowledge\?\.\(\) \|\| null,/.test(features));
check('main hands Health the knowledge check it already ran, and whether this workspace has /relearn',
  /knowledge: \(\) => \{\s*if \(!wsCache\?\.knowledge\) return null;/.test(main) && /'\.claude', 'commands', 'relearn\.md'/.test(main));
check('the window asks Health again when the tools, the account or the session change',
  /for \(const kind of \['mcp', 'account', 'init'\]\) JV\.on\(kind, \(\) => refreshHealth\(\)\);/.test(app) && /JV\.on\('health', renderSysStatus\);/.test(app));
// The workspace is re-read every 90 s; Health must be asked only when its knowledge changed.
{
  const block = /  let knowledgeSeen = null;\n  JV\.on\('workspace', \(w\) => \{[\s\S]*?\n  \}\);\n/.exec(app)?.[0] || '';
  let asked = 0;
  let handler = null;
  new Function('JV', 'refreshHealth', block)({ on: (_k, fn) => { handler = fn; } }, () => { asked += 1; });
  const stale2 = { knowledge: { available: true, state: 'stale', stale: [1, 2] } };
  handler(stale2); handler(stale2); handler({ knowledge: { available: true, state: 'stale', stale: [1, 2] } });
  const afterSame = asked;
  handler({ knowledge: { available: true, state: 'stale', stale: [1, 2, 3] } });
  handler({ knowledge: { available: true, state: 'current' } });
  handler({ knowledge: { available: false } }); handler({}); handler(null);
  check('...and for the workspace, only when its knowledge really changed - not on each 90-second reading',
    !!handler && afterSame === 1 && asked === 4, `after three identical readings: ${afterSame}; in all: ${asked}`);
}
check('a slow look every ten minutes, only while the window is on screen, covers what has no event',
  /setInterval\(\(\) => \{ if \(!document\.hidden\) refreshHealth\(0\); \}, 10 \* 60 \* 1000\);/.test(app));
check('"Check again" in Health updates the pill too', /JV\.state\.health = h;\s*JV\.emit\('health', h\);/.test(healthJs));
check('Health can carry out the new buttons: show the tools, open Knowledge, put /relearn in the box (not send it)',
  /action === 'tools'\) \{ dlg\.close\(\); JV\.show\('tools'\)/.test(healthJs) && /action === 'knowledge'\) \{ dlg\.close\(\); JV\.show\('knowledge'\)/.test(healthJs)
  && /action === 'relearn'\) \{ dlg\.close\(\); JV\.chat\?\.insert\?\.\('\/relearn'\)/.test(healthJs) && /note: 'Good to know'/.test(healthJs));
check('a tool that only needs signing in is no longer raised as a warning in the feed', /level: s\.status === 'failed' \? 'warn' : 'info'/.test(app));

console.log(`\n${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('  FAILED: ' + f);
process.exit(fails.length ? 1 : 0);
