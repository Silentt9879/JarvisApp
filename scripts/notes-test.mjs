// Notes: the store on disk, the Telegram send, and the real renderer driven through the
// window's own notes.js. No network - telegram.mjs's transport is replaced.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

let pass = 0; const fails = [];
const check = (n, c, extra) => {
  if (c) { pass += 1; console.log('PASS  ' + n); }
  else { fails.push(n); console.log('FAIL  ' + n + (extra ? '\n        ' + String(extra).slice(0, 300) : '')); }
};
// The app folder is the one this test lives in (P9_APP overrides it), so it runs on any PC.
const APP = process.env.P9_APP || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/');
const read = (p) => fs.readFileSync(p, 'utf8');
const tick = async (n = 8) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };
const N = await import(`file:///${APP}/src/notes.mjs`);

// ------------------------------------------------------------------ the store
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-'));
const store = new N.NoteStore(DIR);
check('an empty folder reads as no notes, not an error', Array.isArray(store.list()) && store.list().length === 0);

const a = store.save({ text: 'Buy milk\nand bread' });
check('a new note is saved with an id and both timestamps',
  a.ok && a.note.id && a.note.created > 0 && a.note.updated === a.note.created && a.note.sentAt === null, JSON.stringify(a));
check('it is on disk as notes.json, in the folder it was given',
  fs.existsSync(path.join(DIR, 'notes.json')) && JSON.parse(read(path.join(DIR, 'notes.json'))).length === 1);
check('the title is the first non-empty line, with the markdown heading mark dropped',
  N.titleOf('Buy milk\nand bread') === 'Buy milk' && N.titleOf('\n\n# Shopping\nmilk') === 'Shopping' && N.titleOf('   ') === 'Untitled note');

const empty = store.save({ text: '   \n  ' });
check('an empty note is refused, and nothing is written', !empty.ok && /empty/i.test(empty.error) && store.list().length === 1);

const b = store.save({ text: 'Second' });
check('a second note is added, newest first', store.list().length === 2 && store.list()[0].id === b.note.id);

const edited = store.save({ id: a.note.id, text: 'Buy oat milk' });
check('saving with an existing id edits that note instead of adding one',
  edited.ok && store.list().length === 2 && edited.note.id === a.note.id && edited.note.created === a.note.created
  && edited.note.updated >= a.note.updated && store.list().find((n) => n.id === a.note.id).text === 'Buy oat milk');

store.markSent(a.note.id, 1700000000000);
check('a sent note carries the stamp, and only that note', store.list().find((n) => n.id === a.note.id).sentAt === 1700000000000
  && store.list().find((n) => n.id === b.note.id).sentAt === null);

check('a note longer than the cap is cut, not refused', store.save({ text: 'x'.repeat(N.MAX_TEXT + 500) }).note.text.length === N.MAX_TEXT);

const gone = store.remove(b.note.id);
check('delete removes one note and says so; deleting it twice is refused',
  gone.ok && !store.list().some((n) => n.id === b.note.id) && !store.remove(b.note.id).ok);

fs.writeFileSync(path.join(DIR, 'notes.json'), '{ this is not json');
check('a corrupt file reads as an empty store rather than throwing', store.list().length === 0);
fs.writeFileSync(path.join(DIR, 'notes.json'), JSON.stringify([{ id: 'x', text: 'ok' }, { nope: 1 }, 'junk']));
check('junk entries are dropped and the good one is kept, with missing times as 0',
  store.list().length === 1 && store.list()[0].id === 'x' && store.list()[0].created === 0);

// ------------------------------------------------------------------ Telegram
check('Telegram is "not ready" without a token or a chat id, and ready with both',
  !N.telegramReady(null) && !N.telegramReady({ token: '1:aaa', chatId: null })
  && !N.telegramReady({ token: null, chatId: '123' }) && N.telegramReady({ token: '1:aaa', chatId: '123' }));

const tgmod = await import(`file:///${APP}/src/telegram.mjs`);
const sentCalls = [];
// telegram.mjs talks through fetch; replace it so no request leaves this machine.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  sentCalls.push({ url: String(url), body: JSON.parse(opts.body) });
  return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
};
const note = { id: 'n1', text: '# Shopping\nmilk\nbread', updated: 1700000000000 };
const noTg = await N.sendNote({ token: null, chatId: null }, note);
check('without Telegram set up, sending is refused with a plain reason and no request', !noTg.ok && /Phone alerts/.test(noTg.error) && sentCalls.length === 0);

const ok = await N.sendNote({ token: '123456:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQ', chatId: '42' }, note);
check('a note is sent to the configured chat as plain text, with the title and the body',
  ok.ok && sentCalls.length === 1 && /\/sendMessage$/.test(sentCalls[0].url) && sentCalls[0].body.chat_id === '42'
  && /Note · Shopping/.test(sentCalls[0].body.text) && /milk\nbread/.test(sentCalls[0].body.text), JSON.stringify(sentCalls[0]).slice(0, 200));
check('the token is in the URL only, never in the message body',
  !/123456:AA/.test(sentCalls[0].body.text) && /123456:AA/.test(sentCalls[0].url));
globalThis.fetch = realFetch;
void tgmod;

// ------------------------------------------------------------------ the real renderer
class El {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.className = ''; this.children = []; this.text = ''; this.attrs = {}; this.dataset = {}; this.style = {}; this.hidden = false; this.disabled = false; this.checked = false; this.value = ''; this.listeners = {}; }
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
  fire(k, ev = {}) { for (const fn of this.listeners[k] || []) fn(ev); }
  focus() {}
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.text = String(v); this.children = []; }
}
const byId = new Map();
const handlers = {};
const settingsOpened = [];
const JV = {
  $: (id) => { if (!byId.has(id)) byId.set(id, new El('div')); return byId.get(id); },
  el: (tag, cls, text) => { const n = new El(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; },
  icon: () => new El('svg'),
  ago: () => 'just now',
  state: { view: 'notes' },
  on: (k, fn) => { (handlers[k] = handlers[k] || []).push(fn); },
  emit() {},
  openSettings: (tab) => settingsOpened.push(tab),
};
// A store of its own, so the renderer run is independent of the checks above.
const RDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-ui-'));
const rstore = new N.NoteStore(RDIR);
let ready = true;
const sends = [];
const jarvis = {
  notes: async () => ({ ok: true, notes: rstore.list(), telegram: { ready, name: ready ? 'Atlas' : null } }),
  noteSave: async (n, o) => {
    const r = rstore.save({ id: n?.id, text: n?.text });
    if (!r.ok) return r;
    if (!(o && o.telegram)) return { ...r, telegram: { ready, name: ready ? 'Atlas' : null } };
    sends.push(r.note.text);
    const sent = ready ? { ok: true } : { ok: false, error: 'No Telegram chat set yet.' };
    if (sent.ok) rstore.markSent(r.note.id);
    return { ok: true, note: rstore.list().find((x) => x.id === r.note.id), sent, telegram: { ready, name: ready ? 'Atlas' : null } };
  },
  noteDelete: async (id) => rstore.remove(id),
};
const document_ = { hidden: false, createElement: (t) => new El(t), createTextNode: (t) => { const n = new El('#text'); n.textContent = t; return n; } };
const window_ = { JV, jarvis, document: document_ };
const ctx = vm.createContext({ JV, window: window_, document: document_, console, Promise, setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {} });
vm.runInContext(read(`${APP}/src/renderer/notes.js`), ctx, { filename: 'notes.js' });
await tick(20);

const txt = JV.$('noteText');
const msg = () => JV.$('noteMsg');
const rows = () => JV.$('noteList').children.map((li) => li.children[0]);

console.log('\n--- writing and saving ---');
check('an empty page offers a new note, with Save off and Delete hidden',
  JV.$('noteTitle').textContent === 'New note' && JV.$('noteSave').disabled === true && JV.$('noteDelete').hidden === true
  && /No notes yet/.test(JV.$('noteList').textContent));
check('Telegram being set up is named on the page, and the send switch is usable',
  /Atlas/.test(JV.$('noteTg').textContent) && JV.$('noteSend').disabled === false);

txt.value = 'Call the workshop\nabout the gearbox';
txt.fire('input');
check('typing turns Save on and shows the first line as the title',
  JV.$('noteSave').disabled === false && JV.$('noteTitle').textContent === 'Call the workshop');
await JV.$('noteSave').onclick(); await tick();
check('Save stores the note, says so, and lists it - without sending, as the switch is off',
  rstore.list().length === 1 && /^Saved\.$/.test(msg().textContent) && /\bok\b/.test(msg().className)
  && rows().length === 1 && /Call the workshop/.test(rows()[0].textContent) && sends.length === 0, msg().textContent);

console.log('\n--- sending to Telegram ---');
JV.$('noteSend').checked = true;
txt.value = 'Call the workshop about the gearbox, Monday';
txt.fire('input');
await JV.$('noteSave').onclick(); await tick();
check('with the switch on, saving also sends - one note, not two, and the row says "sent"',
  sends.length === 1 && rstore.list().length === 1 && /sent to your Telegram/.test(msg().textContent)
  && /sent/.test(rows()[0].textContent), `${msg().textContent} | ${rows()[0].textContent}`);

ready = false;   // the token goes stale, or the chat is cleared
await jarvis.notes();
txt.value = 'This one cannot go out';
txt.fire('input');
await JV.$('noteSave').onclick(); await tick();
check('when Telegram refuses, the note is still saved and the refusal is said plainly',
  rstore.list().some((n) => n.text === 'This one cannot go out') && /Saved/.test(msg().textContent)
  && /Telegram refused it/.test(msg().textContent) && /\berr\b/.test(msg().className), msg().textContent);
{
  const setupBtn = JV.$('noteTg').children.find((c) => c.tagName === 'BUTTON');
  check('with Telegram not set up, the page offers to set it up, not "on the Devices page"',
    /not set up/.test(JV.$('noteTg').textContent) && JV.$('noteSend').disabled === true && JV.$('noteSend').checked === false
    && !!setupBtn && !/devices/i.test(setupBtn.textContent), JV.$('noteTg').textContent);
  setupBtn.onclick();
  check('...and it actually opens Settings > Phone alerts, not the Devices page', settingsOpened.at(-1) === 'phone', JSON.stringify(settingsOpened));
}
ready = true;

console.log('\n--- switching notes keeps unsaved work ---');
// a second note, so there is somewhere to switch to
await JV.$('noteNew').onclick(); await tick();
txt.value = 'Order the brake pads';
txt.fire('input');
await JV.$('noteSave').onclick(); await tick();
check('New note starts a fresh one rather than editing the last - two notes now',
  rstore.list().length === 2 && rows().length === 2);
// a draft of a note that exists: parked on the way out, marked in the list, offered back
rows()[0].onclick(); await tick();
const saved0 = txt.value;
txt.value = `${saved0} - half an edit`;
txt.fire('input');
rows()[1].onclick(); await tick();
check('opening another note parks the half-done edit instead of asking or losing it',
  txt.value !== `${saved0} - half an edit` && rstore.list().every((n) => n.text !== `${saved0} - half an edit`), txt.value);
check('the note left part-edited is marked unsaved in the list, under its drafted title',
  rows().some((r) => /unsaved/.test(r.textContent) && /half an edit/.test(r.textContent)),
  rows().map((r) => r.textContent).join(' // '));
rows().find((r) => /half an edit/.test(r.textContent)).onclick(); await tick();
check('coming back to it brings the draft, and says it is a draft',
  txt.value === `${saved0} - half an edit` && /unsaved draft/.test(msg().textContent), `${txt.value} | ${msg().textContent}`);
// and the same for a new note that was never saved
await JV.$('noteNew').onclick(); await tick();
txt.value = 'A draft I have not saved';
txt.fire('input');
rows()[0].onclick(); await tick();
await JV.$('noteNew').onclick(); await tick();
check('a never-saved note keeps its draft too, for as long as the window is open',
  txt.value === 'A draft I have not saved' && rstore.list().every((n) => n.text !== 'A draft I have not saved'));

console.log('\n--- deleting asks first, in the button ---');
const first = rows()[0];
first.onclick(); await tick();
const before = rstore.list().length;
await JV.$('noteDelete').onclick(); await tick();
check('the first press arms the button and says what will happen - nothing is deleted yet',
  rstore.list().length === before && /Press Delete again/.test(msg().textContent)
  && /Delete for good\?/.test(JV.$('noteDelete').textContent) && JV.$('noteDelete').classList.contains('armed'), msg().textContent);
txt.fire('input');
check('typing disarms it, so a stray second press cannot delete anything',
  !JV.$('noteDelete').classList.contains('armed') && /^Delete$/.test(JV.$('noteDelete').textContent));
await JV.$('noteDelete').onclick();
await JV.$('noteDelete').onclick(); await tick();
check('two presses delete the note and the editor goes blank',
  rstore.list().length === before - 1 && txt.value === '' && /^Deleted\.$/.test(msg().textContent), msg().textContent);

console.log('\n--- wiring ---');
const html = read(`${APP}/src/renderer/index.html`);
const pre = read(`${APP}/src/preload.cjs`);
check('the sidebar has a Notes entry, and the view it points at exists',
  /id="navNotes" data-view="notes"/.test(html) && /id="view-notes"/.test(html));
check('notes.js is loaded by the window, before app.js',
  html.indexOf('notes.js') > 0 && html.indexOf('notes.js') < html.indexOf('app.js'));
check('the page\'s ids are each declared exactly once',
  ['noteList', 'noteText', 'noteSave', 'noteDelete', 'noteNew', 'noteSend', 'noteMsg', 'noteTg', 'noteTitle', 'noteWhen', 'nbNotes']
    .every((id) => html.split(`id="${id}"`).length === 2));
check('the bridge exposes exactly the three note calls', ['notes:', 'noteSave:', 'noteDelete:'].every((k) => pre.includes(k))
  && !/notesToken|telegramToken/.test(pre));
const main = read(`${APP}/src/main.mjs`);
check('main tells the window only whether Telegram is ready and what it is called - never the token',
  /function telegramStatus\(\)/.test(main) && /ready: telegramReady\(tg\), name: tg\.name \|\| null/.test(main)
  && !/token: tg\.token/.test(main));
check('the note is saved before anything is sent, so a Telegram failure cannot lose it',
  main.indexOf('const r = notes.save(') < main.indexOf('await sendNote('));
check('Notes (Classic) is reachable from the search box as a view', /\['Notes \(Classic\)', 'notes'\]/.test(read(`${APP}/src/renderer/app.js`)));

console.log(`\n${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('  FAILED: ' + f);
fs.rmSync(DIR, { recursive: true, force: true });
fs.rmSync(RDIR, { recursive: true, force: true });
process.exit(fails.length ? 1 : 0);
