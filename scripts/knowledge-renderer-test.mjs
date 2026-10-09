// JARVIS Knowledge - Phase 23D: the real renderer (src/renderer/knowledge.js), driven through
// a fake DOM exactly the way scripts/notes-test.mjs already drives notes.js - but backed by
// the REAL src/knowledge.mjs storage functions against a temp folder, not a mock store. So
// "Save", "Delete", "Restore" and "Import" here are the real engine, exercised through the
// real UI code: draft preservation, the two-step overwrite confirm, the stale-delete message,
// and the Import preview dialog are all proven end to end, not just asserted by wiring regex
// (scripts/knowledge-ipc-test.mjs does that part). No Electron, nothing under a real
// %APPDATA%\JARVIS - everything here is a temp directory.
//   node scripts/knowledge-renderer-test.mjs
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
const APP = process.env.P9_APP || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/');
const read = (p) => fs.readFileSync(p, 'utf8');
const tick = async (n = 10) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };
const K = await import(`file:///${APP}/src/knowledge.mjs`);

// ------------------------------------------------------------------ a tiny fake DOM (same shape as notes-test.mjs's)
class El {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.className = ''; this.children = []; this.text = ''; this.attrs = {}; this.dataset = {}; this.style = {}; this.hidden = false; this.disabled = false; this.readOnly = false; this.checked = false; this.value = ''; this.listeners = {}; }
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
  append(...cs) { for (const c of cs) { if (typeof c === 'string') this.children.push(Object.assign(new El('#text'), { text: c })); else this.appendChild(c); } }
  prepend(c) { this.children.unshift(c); return c; }
  replaceChildren(...cs) { this.children = cs; this.text = ''; }
  querySelector(sel) {
    const want = sel.replace('.', '');
    const walk = (n2) => { if (n2.className && n2.className.split(/\s+/).includes(want)) return n2; for (const c of n2.children || []) { const f = walk(c); if (f) return f; } return null; };
    return walk(this);
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(k, fn) { (this.listeners[k] = this.listeners[k] || []).push(fn); }
  fire(k, ev = {}) { for (const fn of this.listeners[k] || []) fn(ev); }
  focus() {}
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.text = String(v); this.children = []; }
}
class FakeStorage {
  constructor() { this.data = new Map(); }
  get length() { return this.data.size; }
  key(i) { return [...this.data.keys()][i]; }
  getItem(k) { return this.data.has(k) ? this.data.get(k) : null; }
  setItem(k, v) { this.data.set(k, String(v)); }
  removeItem(k) { this.data.delete(k); }
}

/** A real bridge to the real engine (src/knowledge.mjs) against one temp userDir - the same
 *  calls main.mjs's IPC handlers make, just without Electron in between. */
function makeJarvis(userDir) {
  const status = () => ({ storageDir: K.knowledgePaths(userDir).notesDir, migrationComplete: K.migrationComplete(userDir), legacyNoteCount: 0 });
  return {
    knowledgeList: async () => {
      const r = K.listKnowledgeNotes(userDir);
      return { ok: r.ok, error: r.error, status: status(), notes: (r.notes || []).map((x) => ({ id: x.id, title: x.title, created: x.created, updated: x.updated, tags: x.tags, favorite: x.favorite, folder: x.folder, sentAt: x.sentAt, corrupt: x.corrupt })) };
    },
    knowledgeRead: async (id) => {
      const r = K.listKnowledgeNotes(userDir);
      const x = r.ok && r.notes.find((e) => e.id === id);
      if (!x) return { ok: false, error: 'not found' };
      return { ok: true, note: { id: x.id, title: x.title, created: x.created, updated: x.updated, tags: x.tags, favorite: x.favorite, folder: x.folder, sentAt: x.sentAt, body: x.body }, revision: K.noteRevision(userDir, id) };
    },
    knowledgeSave: async (input) => {
      const v = K.validateNoteInput(input);
      if (!v.ok) return { ok: false, error: v.error };
      const id = typeof input?.id === 'string' && input.id ? input.id : K.newId();
      const r = K.saveKnowledgeNote(userDir, id, v.value, { baseRevision: input?.baseRevision ?? null, force: input?.force === true });
      if (!r.ok) return r;
      return { ok: true, note: r.note, revision: r.revision, unchanged: r.unchanged, overwrote: r.overwrote };
    },
    knowledgeImportPreview: async () => K.previewMigration(userDir),
    knowledgeImport: async () => K.migrateFromLegacy(userDir),
    knowledgeTrash: async () => {
      const r = K.listTrash(userDir);
      return { ok: r.ok, error: r.error, notes: (r.notes || []).map((x) => ({ id: x.id, title: x.title, created: x.created, updated: x.updated, tags: x.tags, favorite: x.favorite, deletedAt: x.deletedAt, corrupt: x.corrupt })) };
    },
    knowledgeTrashRead: async (id) => {
      const r = K.listTrash(userDir);
      const x = r.ok && r.notes.find((e) => e.id === id);
      if (!x) return { ok: false, error: 'not found' };
      return { ok: true, note: { id: x.id, title: x.title, created: x.created, updated: x.updated, tags: x.tags, favorite: x.favorite, deletedAt: x.deletedAt, body: x.body } };
    },
    knowledgeDelete: async (id, baseRevision) => K.deleteKnowledgeNote(userDir, id, { baseRevision: baseRevision ?? null }),
    knowledgeRestore: async (id) => K.restoreKnowledgeNote(userDir, id),
    knowledgeSnapshots: async (id) => K.listSnapshots(userDir, id),
    knowledgeSnapshotRead: async (id, file) => K.readSnapshot(userDir, id, file),
    knowledgeSnapshotRestore: async (id, file, baseRevision) => K.restoreSnapshot(userDir, id, file, { baseRevision: baseRevision ?? null }),
  };
}

/** One fresh run of knowledge.js, as if the window had just opened (or re-opened) the
 *  Knowledge page - a new JS scope every time, but `storage` (localStorage) and `userDir`
 *  (the files on disk) can be the SAME object/folder across two calls, to prove a draft or a
 *  note really does survive "closing and reopening JARVIS", not just staying in one run's memory. */
function boot(userDir, storage) {
  const byId = new Map();
  const JV = {
    $: (id) => { if (!byId.has(id)) byId.set(id, new El('div')); return byId.get(id); },
    el: (tag, cls, text) => { const n = new El(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; },
    icon: () => new El('svg'),
    ago: (t) => (t ? `${Date.now() - t}ms ago` : ''),
    state: { view: 'kne' },
    on: () => {},
    emit: () => {},
    renderMarkdown: (target, text) => { target.textContent = String(text || ''); },
  };
  const jarvis = makeJarvis(userDir);
  const document_ = { hidden: false, activeElement: null, createElement: (t) => new El(t), createTextNode: (t) => { const n = new El('#text'); n.textContent = t; return n; } };
  const window_ = { JV, jarvis, document: document_, localStorage: storage };
  const ctx = vm.createContext({ JV, window: window_, document: document_, localStorage: storage, console, Promise, setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {} });
  vm.runInContext(read(`${APP}/src/renderer/knowledge.js`), ctx, { filename: 'knowledge.js' });
  return JV;
}

const DIR = () => fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-ui-'));

console.log('\n--- basic editing and saving ---');
{
  const d = DIR();
  const JV = boot(d, new FakeStorage());
  await tick();
  check('an empty store offers a blank editor, Save off, Delete hidden', JV.$('kneSave').disabled === true && JV.$('kneDelete').hidden === true);

  JV.$('kneTitle').value = 'My first note';
  JV.$('kneTitle').fire('input');
  JV.$('kneEdit').value = 'Some content here.';
  JV.$('kneEdit').fire('input');
  check('typing turns Save on', JV.$('kneSave').disabled === false);
  await JV.$('kneSave').onclick(); await tick();
  check('Save stores it for real (listKnowledgeNotes sees it) and the page says so',
    K.listKnowledgeNotes(d).notes.some((n) => n.title === 'My first note') && /^Saved\.$/.test(JV.$('kneMsg').textContent), JV.$('kneMsg').textContent);
  check('Delete is offered once the note is actually saved', JV.$('kneDelete').hidden === false);
}

console.log('\n--- draft preservation (Part 3) ---');
{
  const d = DIR();
  const storage = new FakeStorage();
  let JV = boot(d, storage);
  await tick();
  JV.$('kneTitle').value = 'Unsaved draft';
  JV.$('kneTitle').fire('input');
  JV.$('kneEdit').value = 'Never saved.';
  JV.$('kneEdit').fire('input');
  // Switch to Trash and back without saving - the whole point of a draft.
  await JV.$('kneTabTrash').onclick(); await tick();
  check('switching to Trash clears the editor (nothing of the draft is shown there)', JV.$('kneTitle').value === '');
  await JV.$('kneTabNotes').onclick(); await tick();
  check('switching back to Notes shows the draft again straight away - Trash never touched it', JV.$('kneTitle').value === 'Unsaved draft' && JV.$('kneEdit').value === 'Never saved.');
  await JV.$('kneNew').onclick(); await tick();
  check('...and pressing New note still finds it too (it is parked under "new", not any particular note)', JV.$('kneTitle').value === 'Unsaved draft' && JV.$('kneEdit').value === 'Never saved.');
  check('the draft is mirrored to localStorage, not only kept in memory', storage.data.has('jarvis.kneDraft.new'));

  // Simulate closing and reopening JARVIS: a brand-new run, same localStorage, same disk.
  JV = boot(d, storage);
  await tick();
  await JV.$('kneNew').onclick(); await tick();
  check('a fresh run of the page, sharing the same localStorage, still has the draft after "reopening"',
    JV.$('kneTitle').value === 'Unsaved draft' && JV.$('kneEdit').value === 'Never saved.');
}

console.log('\n--- stale-save conflict: explicit reload or a two-step overwrite (Part 3) ---');
{
  const d = DIR();
  const JV = boot(d, new FakeStorage());
  await tick();
  JV.$('kneTitle').value = 'Race note';
  JV.$('kneTitle').fire('input');
  JV.$('kneEdit').value = 'version one';
  JV.$('kneEdit').fire('input');
  await JV.$('kneSave').onclick(); await tick();
  const id = K.listKnowledgeNotes(d).notes[0].id;

  // Another window/editor saves behind this one's back.
  const rev = K.noteRevision(d, id);
  K.saveKnowledgeNote(d, id, { title: 'Race note', body: 'version two, from elsewhere', tags: [], favorite: false, folder: null }, { baseRevision: rev });

  JV.$('kneEdit').value = 'version one point five, typed here';
  JV.$('kneEdit').fire('input');
  await JV.$('kneSave').onclick(); await tick();
  check('a stale save is refused, and says so', /changed elsewhere/.test(JV.$('kneMsg').textContent), JV.$('kneMsg').textContent);
  check('the on-disk note is still "version two" - not silently overwritten', K.listKnowledgeNotes(d).notes.find((n) => n.id === id).body === 'version two, from elsewhere');
  check('this editor\'s own unsaved text is still right there, untouched', JV.$('kneEdit').value === 'version one point five, typed here');

  const overwriteBtn = JV.$('kneMsg').children.find((c) => /Overwrite anyway/.test(c.textContent));
  check('an "Overwrite anyway" choice is offered', !!overwriteBtn);
  overwriteBtn.onclick(); // first press: only arms it
  check('one press only arms it - nothing is overwritten yet', K.listKnowledgeNotes(d).notes.find((n) => n.id === id).body === 'version two, from elsewhere');
  check('the armed button now says what pressing it again will do', /Click again/.test(overwriteBtn.textContent));
  overwriteBtn.onclick(); await tick(); // second press: actually overwrites
  check('the second press overwrites for real', K.listKnowledgeNotes(d).notes.find((n) => n.id === id).body === 'version one point five, typed here');
  check('the replaced version is recoverable - a backup now exists', fs.existsSync(K.knowledgePaths(d).overwrittenDir) && fs.readdirSync(K.knowledgePaths(d).overwrittenDir).length === 1);
  check('the page says the backup was made', /backed up first/.test(JV.$('kneMsg').textContent), JV.$('kneMsg').textContent);
}

console.log('\n--- stale delete: reload only, no overwrite option (Part 2) ---');
{
  const d = DIR();
  const JV = boot(d, new FakeStorage());
  await tick();
  JV.$('kneTitle').value = 'To be deleted';
  JV.$('kneTitle').fire('input');
  JV.$('kneEdit').value = 'v1';
  JV.$('kneEdit').fire('input');
  await JV.$('kneSave').onclick(); await tick();
  const id = K.listKnowledgeNotes(d).notes[0].id;
  const rev = K.noteRevision(d, id);
  K.saveKnowledgeNote(d, id, { title: 'To be deleted', body: 'changed elsewhere first', tags: [], favorite: false, folder: null }, { baseRevision: rev });

  await JV.$('kneDelete').onclick(); // opens the confirm dialog
  check('Delete opens a confirm dialog naming the note, rather than deleting immediately', JV.$('kneDeleteVeil').hidden === false && /To be deleted/.test(JV.$('kneDeleteName').textContent));
  await JV.$('kneDeleteGo').onclick(); await tick();
  check('a stale delete is refused', /changed elsewhere/.test(JV.$('kneMsg').textContent), JV.$('kneMsg').textContent);
  check('...and there is no "overwrite anyway" for a delete - only Reload', !JV.$('kneMsg').children.some((c) => /Overwrite/.test(c.textContent)));
  check('the note was never moved to Trash', K.listTrash(d).notes.length === 0);
}

console.log('\n--- delete, Trash and restore (Part 2) ---');
{
  const d = DIR();
  const JV = boot(d, new FakeStorage());
  await tick();
  JV.$('kneTitle').value = 'Trash me';
  JV.$('kneTitle').fire('input');
  JV.$('kneEdit').value = 'content to keep';
  JV.$('kneEdit').fire('input');
  await JV.$('kneSave').onclick(); await tick();

  await JV.$('kneDelete').onclick();
  await JV.$('kneDeleteCancel').onclick();
  check('Cancel in the delete dialog deletes nothing', JV.$('kneDeleteVeil').hidden === true && K.listKnowledgeNotes(d).notes.length === 1);

  await JV.$('kneDelete').onclick();
  await JV.$('kneDeleteGo').onclick(); await tick();
  check('confirming Delete moves the note to Trash, and the editor goes blank', K.listKnowledgeNotes(d).notes.length === 0 && /Moved to Trash/.test(JV.$('kneMsg').textContent));
  check('the Trash count badge reflects it', JV.$('kneTrashCount').textContent === '1' && JV.$('kneTrashCount').hidden === false);

  await JV.$('kneTabTrash').onclick(); await tick();
  check('switching to the Trash tab lists the deleted note', /Trash me/.test(JV.$('kneList').textContent));
  check('Restore is not offered until an actual Trash entry is open - merely being on the Trash tab is not enough', JV.$('kneRestore').hidden === true);
  const row = JV.$('kneList').children.find((li) => /Trash me/.test(li.textContent));
  row.children[0].onclick(); await tick();
  check('opening a Trash entry shows it read-only, with Restore offered instead of Save', JV.$('kneTitle').readOnly === true && JV.$('kneSave').hidden === true && JV.$('kneRestore').hidden === false);
  check('its content is exactly what was deleted', JV.$('kneEdit').value === 'content to keep');

  await JV.$('kneRestore').onclick(); await tick();
  check('Restore brings it back - listed live again, gone from Trash', K.listKnowledgeNotes(d).notes.some((n) => n.title === 'Trash me') && K.listTrash(d).notes.length === 0);
  check('the page says so', /back in your notes/.test(JV.$('kneMsg').textContent), JV.$('kneMsg').textContent);
}

console.log('\n--- Import from Notes: preview, then an explicit confirm (Part 1) ---');
{
  const d = DIR();
  fs.writeFileSync(path.join(d, 'notes.json'), JSON.stringify([
    { id: 'alpha', text: 'Alpha from Notes', created: 1000, updated: 1000 },
    { id: 'beta', text: 'Beta from Notes', created: 1000, updated: 1000 },
  ]));
  const JV = boot(d, new FakeStorage());
  await tick();

  await JV.$('kneImportOpen').onclick(); await tick();
  check('opening Import shows the dialog and a preview, before anything is imported',
    JV.$('kneImportVeil').hidden === false && /2/.test(JV.$('kneImportStats').children[0].textContent) && K.listKnowledgeNotes(d).notes.length === 0);
  check('the destination path is shown', new RegExp(K.knowledgePaths(d).notesDir.replace(/\\/g, '\\\\')).test(JV.$('kneImportDest').textContent));

  await JV.$('kneImportCancel').onclick();
  check('Cancel imports nothing', JV.$('kneImportVeil').hidden === true && K.listKnowledgeNotes(d).notes.length === 0);

  await JV.$('kneImportOpen').onclick(); await tick();
  await JV.$('kneImportGo').onclick(); await tick();
  check('confirming Import actually imports, through the real engine', K.listKnowledgeNotes(d).notes.length === 2);
  check('the result is reported with real counts', /Imported 2/.test(JV.$('kneImportMsg').textContent), JV.$('kneImportMsg').textContent);
  // Migrated notes have no title (notes.json never had one) - they show as "Untitled note",
  // same as any other note without one; the list having two rows is what proves the refresh.
  check('the live list behind the dialog is refreshed too', JV.$('kneList').children.length === 2 && /Untitled note/.test(JV.$('kneList').textContent));

  // Press Import again: nothing new, no duplicates, previewed and reported accurately.
  await JV.$('kneImportOpen').onclick(); await tick();
  check('a second preview shows nothing left eligible', /^0$/.test(JV.$('kneImportStats').children[1].children[1].textContent));
  await JV.$('kneImportGo').onclick(); await tick();
  check('a second import reports zero new, not an error, and creates no duplicates', /Imported 0/.test(JV.$('kneImportMsg').textContent) && K.listKnowledgeNotes(d).notes.length === 2, JV.$('kneImportMsg').textContent);
}

console.log('\n--- Version History: compare and restore (Phase 23E) ---');
{
  const d = DIR();
  const JV = boot(d, new FakeStorage());
  await tick();
  check('a brand-new, unsaved note has no Version History button', JV.$('kneHistory').hidden === true);

  JV.$('kneTitle').value = 'Historied note';
  JV.$('kneTitle').fire('input');
  JV.$('kneEdit').value = 'version one';
  JV.$('kneEdit').fire('input');
  await JV.$('kneSave').onclick(); await tick();
  const id = K.listKnowledgeNotes(d).notes[0].id;
  check('once saved, Version History is offered', JV.$('kneHistory').hidden === false);

  await JV.$('kneHistory').onclick(); await tick();
  check('opening History with no earlier overwrite yet says so plainly, not an empty blank list', /No earlier versions/.test(JV.$('kneHistoryList').textContent));
  check('"Current" shows the note as it is now', JV.$('kneHistoryCurrent').textContent === 'version one');
  await JV.$('kneHistoryClose').onclick();

  // Someone else overwrites this note's history-worthy past: force past a stale revision.
  const rev = K.noteRevision(d, id);
  K.saveKnowledgeNote(d, id, { title: 'Historied note', body: 'version two', tags: [], favorite: false, folder: null }, { baseRevision: rev });
  K.saveKnowledgeNote(d, id, { title: 'Historied note', body: 'version three', tags: [], favorite: false, folder: null }, { baseRevision: rev, force: true }); // snapshots "version two"

  await JV.$('kneHistory').onclick(); await tick();
  check('History now lists the one earlier version, freshly read from disk (not the editor\'s own stale copy)',
    JV.$('kneHistoryList').children.length === 1 && JV.$('kneHistoryCurrent').textContent === 'version three');
  check('nothing is selected yet, so Restore starts disabled', JV.$('kneHistoryRestore').disabled === true);

  const row = JV.$('kneHistoryList').children[0].children[0];
  row.onclick();
  check('selecting a version shows it for comparison next to Current', JV.$('kneHistorySelected').textContent === 'version two');
  check('Restore is enabled once a real version is selected', JV.$('kneHistoryRestore').disabled === false);

  JV.$('kneHistoryRestore').onclick();
  check('one press only arms Restore - nothing changes yet', K.listKnowledgeNotes(d).notes.find((n) => n.id === id).body === 'version three');
  check('the armed button explains what pressing it again will do', /Click again/.test(JV.$('kneHistoryRestore').textContent));
  JV.$('kneHistoryRestore').onclick(); await tick();
  check('the second press actually restores the selected version', K.listKnowledgeNotes(d).notes.find((n) => n.id === id).body === 'version two');
  check('the version just replaced ("version three") is itself preserved as a new snapshot - nothing here is a one-way trip',
    K.listSnapshots(d, id).snapshots.some((s) => s.body === 'version three'));
  check('the dialog says so', /Restored/.test(JV.$('kneHistoryMsg').textContent), JV.$('kneHistoryMsg').textContent);
  check('the main editor behind the dialog reflects the restored content immediately', JV.$('kneEdit').value === 'version two');

  await JV.$('kneHistoryClose').onclick();
  check('closing History does not touch anything further', K.listKnowledgeNotes(d).notes.find((n) => n.id === id).body === 'version two');
}

{
  console.log('\n--- Version History: stale restore and concurrent edits ---');
  const d = DIR();
  const JV = boot(d, new FakeStorage());
  await tick();
  JV.$('kneTitle').value = 'Race note';
  JV.$('kneTitle').fire('input');
  JV.$('kneEdit').value = 'version one';
  JV.$('kneEdit').fire('input');
  await JV.$('kneSave').onclick(); await tick();
  const id = K.listKnowledgeNotes(d).notes[0].id;
  const rev = K.noteRevision(d, id);
  K.saveKnowledgeNote(d, id, { title: 'Race note', body: 'version two', tags: [], favorite: false, folder: null }, { baseRevision: rev });
  K.saveKnowledgeNote(d, id, { title: 'Race note', body: 'version three', tags: [], favorite: false, folder: null }, { baseRevision: rev, force: true });

  await JV.$('kneHistory').onclick(); await tick();
  JV.$('kneHistoryList').children[0].children[0].onclick();

  // Behind History's back, another edit lands after it was opened.
  const openedRev = K.noteRevision(d, id);
  K.saveKnowledgeNote(d, id, { title: 'Race note', body: 'concurrent edit while History was open', tags: [], favorite: false, folder: null }, { baseRevision: openedRev });

  JV.$('kneHistoryRestore').onclick();
  JV.$('kneHistoryRestore').onclick(); await tick();
  check('a stale restore (something changed since History was opened) is refused', /changed elsewhere/.test(JV.$('kneHistoryMsg').textContent), JV.$('kneHistoryMsg').textContent);
  check('the concurrent edit is untouched', K.listKnowledgeNotes(d).notes.find((n) => n.id === id).body === 'concurrent edit while History was open');
  const reloadBtn = JV.$('kneHistoryMsg').children.find?.((c) => /Reload/.test(c.textContent)) || JV.$('kneHistoryMsg').querySelector('.link-btn');
  check('a "Reload and look again" choice is offered', !!reloadBtn);
}

console.log(`\n${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('  FAILED: ' + f);
process.exit(fails.length ? 1 : 0);
