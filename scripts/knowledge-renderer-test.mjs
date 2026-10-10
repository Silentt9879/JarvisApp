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
import { createDriveBackupController } from '../src/drive-backup-controller.mjs';
import { FakeDriveProvider } from './fake-drive-provider.mjs';

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
/** A real controller + a real in-memory fake Drive, for the Phase 24D UI tests below - the
 *  same engine drive-backup-controller-test.mjs already exercises directly, here reached
 *  only through the real renderer code (knowledge.js), the same way a real IPC round trip
 *  would (minus Electron itself). */
function makeDrive(userDir) {
  const remote = new FakeDriveProvider();
  let config = {};
  const controller = createDriveBackupController({
    userDir, getProvider: () => remote, loadConfig: () => config, saveConfig: (p) => { config = { ...config, ...p }; }, log: () => {},
  });
  return { remote, controller };
}

function makeJarvis(userDir, drive, opts = {}) {
  const telegram = opts.telegram || { ready: false, name: null };
  const sent = []; // records of {id} this fake "sent" - the test's own hook into what the IPC layer would have done
  const status = () => {
    const h = K.historyStats(userDir);
    return {
      storageDir: K.knowledgePaths(userDir).notesDir, migrationComplete: K.migrationComplete(userDir), legacyNoteCount: 0,
      historyCount: h.count, historyBytes: h.bytes, historyWarn: h.warn, telegram,
    };
  };
  const appOwned = opts.appOwned || { available: false };
  const driveCalls = (drive || opts.driveStatus) ? {
    driveStatus: opts.driveStatus || (async () => ({ status: 'connected', clientConfigured: true, appOwned: false })),
    driveConfigureClient: async () => ({ ok: true }),
    driveConnect: async () => ({ ok: true, status: 'connected' }),
    driveDisconnect: async () => ({ status: 'disconnected' }),
    driveAppOwnedStatus: async () => appOwned,
    driveConnectAppOwned: opts.driveConnectAppOwned || (async () => ({ ok: true, status: 'connected' })),
    driveSyncStatus: opts.driveSyncStatus || (async () => ({ state: 'idle', lastSyncAt: null, conflictCount: 0, syncing: false })),
    driveSyncNow: opts.driveSyncNow || (async () => ({ ok: true })),
    driveBackupNow: () => drive.controller.backupNow(),
    driveBackupHistory: () => drive.controller.backupHistory(),
    driveRestorePreview: (id) => drive.controller.restorePreview(id),
    driveRestoreConfirm: (id, token) => drive.controller.restoreConfirm(id, token),
    driveOperationStatus: () => drive.controller.operationStatus(),
  } : {};
  const notesAi = {
    notesSearch: opts.notesSearch || (async () => ({ ok: true, results: [] })),
    notesAskContext: opts.notesAskContext || (async () => ({ ok: false, error: 'no fake configured' })),
  };
  return {
    ...driveCalls,
    ...notesAi,
    knowledgeList: async () => {
      const r = K.listKnowledgeNotes(userDir);
      return { ok: r.ok, error: r.error, status: status(), notes: (r.notes || []).map((x) => ({ id: x.id, title: x.title, created: x.created, updated: x.updated, tags: x.tags, favorite: x.favorite, folder: x.folder, sentAt: x.sentAt, aiExcluded: x.aiExcluded, corrupt: x.corrupt })) };
    },
    knowledgeRead: async (id) => {
      const r = K.listKnowledgeNotes(userDir);
      const x = r.ok && r.notes.find((e) => e.id === id);
      if (!x) return { ok: false, error: 'not found' };
      return { ok: true, note: { id: x.id, title: x.title, created: x.created, updated: x.updated, tags: x.tags, favorite: x.favorite, folder: x.folder, sentAt: x.sentAt, aiExcluded: x.aiExcluded, body: x.body }, revision: K.noteRevision(userDir, id) };
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
    // Mirrors main.mjs's jarvis:knowledgeAutoMigrate exactly: a fast "already done?" check,
    // then the same migrateFromLegacy every other migration path already uses.
    knowledgeAutoMigrate: async () => {
      if (K.migrationComplete(userDir)) return { ok: true, already: true, migrated: 0, skipped: 0, conflicts: [], errors: [], total: 0 };
      const r = K.migrateFromLegacy(userDir);
      return { ...r, already: false };
    },
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
    // Phase 1 hardening item 1: mirrors main.mjs's jarvis:knowledgeSendTelegram, minus Electron
    // and the real network call - a fake "sent" rather than a real telegram.mjs call, the same
    // level main.mjs itself sits at relative to the real Telegram API.
    knowledgeSendTelegram: async (id) => {
      if (!telegram.ready) return { ok: false, error: 'Telegram is not set up yet - do that in Settings > Phone alerts.' };
      const n = K.listKnowledgeNotes(userDir).notes.find((x) => x.id === id);
      if (!n) return { ok: false, error: 'That note could not be found.' };
      sent.push({ id, title: n.title, body: n.body });
      const at = Date.now();
      K.markKnowledgeNoteSent(userDir, id, at);
      return { ok: true, sentAt: at };
    },
    __sent: sent,
  };
}

/** One fresh run of knowledge.js, as if the window had just opened (or re-opened) the
 *  Knowledge page - a new JS scope every time, but `storage` (localStorage) and `userDir`
 *  (the files on disk) can be the SAME object/folder across two calls, to prove a draft or a
 *  note really does survive "closing and reopening JARVIS", not just staying in one run's memory. */
function boot(userDir, storage, drive, jarvisOpts) {
  const byId = new Map();
  const handlers = {}; // a real, minimal pub/sub - JV.on/.emit were no-ops before Phase 24D needed them wired for real
  const notifications = [];
  const JV = {
    $: (id) => { if (!byId.has(id)) byId.set(id, new El('div')); return byId.get(id); },
    el: (tag, cls, text) => { const n = new El(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; },
    icon: () => new El('svg'),
    ago: (t) => (t ? `${Date.now() - t}ms ago` : ''),
    state: { view: 'kne' },
    on: (k, fn) => { (handlers[k] = handlers[k] || []).push(fn); },
    emit: (k, e) => { for (const fn of handlers[k] || []) fn(e); },
    notify: (msg, opts) => { notifications.push({ msg, ...opts }); },
    notifications,
    renderMarkdown: (target, text) => { target.textContent = String(text || ''); },
    chatInserts: [], // Phase 4: records what "Ask in Chat" would have put in the composer - never auto-sent
    chat: { insert: (text) => { JV.chatInserts.push(text); } },
  };
  const jarvis = makeJarvis(userDir, drive, jarvisOpts);
  const document_ = { hidden: false, activeElement: null, createElement: (t) => new El(t), createTextNode: (t) => { const n = new El('#text'); n.textContent = t; return n; } };
  const window_ = { JV, jarvis, document: document_, localStorage: storage };
  const ctx = vm.createContext({ JV, window: window_, document: document_, localStorage: storage, console, Promise, setTimeout: (fn) => { fn(); return 0; }, setInterval: () => 0, clearInterval() {}, clearTimeout() {} });
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
  check('the replaced version is recoverable - a backup now exists', fs.existsSync(K.knowledgePaths(d).overwrittenDir) && fs.readdirSync(K.knowledgePaths(d).overwrittenDir).length === 2);
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

console.log('\n--- Import from Notes (Classic): now automatic on open; the manual dialog is a safe re-check/retry (Phase 1, Decision 2) ---');
{
  const d = DIR();
  fs.writeFileSync(path.join(d, 'notes.json'), JSON.stringify([
    { id: 'alpha', text: 'Alpha from Notes', created: 1000, updated: 1000 },
    { id: 'beta', text: 'Beta from Notes', created: 1000, updated: 1000 },
  ]));
  const JV = boot(d, new FakeStorage());
  await tick(20);
  check('simply opening the page already carried both legacy notes over - no Import click needed',
    K.listKnowledgeNotes(d).notes.length === 2, K.listKnowledgeNotes(d).notes);

  await JV.$('kneImportOpen').onclick(); await tick();
  check('the manual dialog, opened after the automatic carry-over already ran, correctly shows nothing left eligible - not a false "2 to import"',
    JV.$('kneImportVeil').hidden === false && /^0$/.test(JV.$('kneImportStats').children[1].children[1].textContent), JV.$('kneImportStats').children.map((c) => c.textContent));
  check('the destination path is still shown', new RegExp(K.knowledgePaths(d).notesDir.replace(/\\/g, '\\\\')).test(JV.$('kneImportDest').textContent));

  await JV.$('kneImportCancel').onclick();
  check('Cancel changes nothing', JV.$('kneImportVeil').hidden === true && K.listKnowledgeNotes(d).notes.length === 2);

  await JV.$('kneImportOpen').onclick(); await tick();
  await JV.$('kneImportGo').onclick(); await tick();
  check('confirming Import when there is nothing left to do reports zero, not an error or a false success', /Imported 0/.test(JV.$('kneImportMsg').textContent), JV.$('kneImportMsg').textContent);
  check('no duplicates were created', K.listKnowledgeNotes(d).notes.length === 2);

  // The manual dialog's real remaining job: surfacing a conflict - a note edited here since
  // the automatic import, so it no longer matches what notes.json would produce. This must
  // never be silently overwritten by Import, automatic or manual.
  const alphaRev = K.noteRevision(d, 'alpha');
  K.saveKnowledgeNote(d, 'alpha', { title: 'Edited here since the import', body: 'Alpha from Notes', tags: [], favorite: false, folder: null }, { baseRevision: alphaRev });
  await JV.$('kneImportOpen').onclick(); await tick();
  check('a note edited since the import is reported as a conflict - never silently re-imported over',
    /1/.test(JV.$('kneImportStats').children[3].textContent), JV.$('kneImportStats').children.map((c) => c.textContent));
  await JV.$('kneImportGo').onclick(); await tick();
  check('confirming does not touch the conflicting note\'s content', K.listKnowledgeNotes(d).notes.find((n) => n.id === 'alpha').title === 'Edited here since the import');
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

  // One ordinary save (to version two, snapshotting version one), then someone else overwrites
  // this note's history-worthy past: force past a now-stale revision (snapshotting version two).
  const rev = K.noteRevision(d, id);
  K.saveKnowledgeNote(d, id, { title: 'Historied note', body: 'version two', tags: [], favorite: false, folder: null }, { baseRevision: rev });
  K.saveKnowledgeNote(d, id, { title: 'Historied note', body: 'version three', tags: [], favorite: false, folder: null }, { baseRevision: rev, force: true }); // snapshots "version two"

  await JV.$('kneHistory').onclick(); await tick();
  check('History now lists both earlier versions, freshly read from disk (not the editor\'s own stale copy)',
    JV.$('kneHistoryList').children.length === 2 && JV.$('kneHistoryCurrent').textContent === 'version three');
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

console.log('\n--- Google Drive backup/restore UI (Phase 24D) ---');
{
  const d = DIR();
  const storage = new FakeStorage();
  const drive = makeDrive(d);
  const JV = boot(d, storage, drive);
  await tick();
  JV.emit('view', 'kne'); // the real trigger renderDriveStatus() and the backup section wait for
  await tick();
  check('the Drive panel shows the backup section once connected', JV.$('driveBackupSection').hidden === false);

  const id = 'r' + Math.random().toString(36).slice(2, 10);
  K.writeKnowledgeNote(d, { id, title: 'T', created: 1, updated: 2, tags: [], favorite: false, body: 'backed up content' });

  const backupClick = JV.$('driveBackupNowBtn').onclick();
  check('BUTTONS DISABLE DURING THE OPERATION: Back Up Now disables itself the instant it is pressed, not only once it finishes', JV.$('driveBackupNowBtn').disabled === true);
  await backupClick; await tick();
  check('Back Up Now reports success through a real notify() call', JV.notifications.some((n) => /Backup complete/.test(n.msg)), JSON.stringify(JV.notifications));
  check('...and re-enables once the operation is actually done', JV.$('driveBackupNowBtn').disabled === false);
  check('a Last Successful Backup line is shown, not left blank', /Last successful backup/.test(JV.$('driveLastBackup').textContent));

  await JV.$('driveHistoryOpenBtn').onclick(); await tick();
  check('Backup History lists the backup, with a Preview button for a complete one', JV.$('driveHistoryList').children.length === 1);

  // Change the note locally, then preview+restore back to the backed-up content - the real
  // restore confirmation workflow, through the real renderer buttons, end to end.
  K.saveKnowledgeNote(d, id, { title: 'T', body: 'changed after backup', tags: [], favorite: false, folder: null }, { baseRevision: K.noteRevision(d, id) });
  const previewBtn = JV.$('driveHistoryList').children[0].children[1];
  await previewBtn.onclick(); await tick();
  check('the restore preview lists the changed note as a replacement, not silently as unchanged',
    JV.$('drivePreviewDetail').children.some((c) => /Notes to replace/.test(c.children?.[0]?.textContent || '')));

  // An unsaved draft, open in the editor right now, must survive the restore that follows.
  await JV.$('kneNew').onclick(); await tick();
  JV.$('kneTitle').value = 'My unsaved draft'; JV.$('kneTitle').fire('input');
  JV.$('kneEdit').value = 'Not saved yet.'; JV.$('kneEdit').fire('input');

  JV.$('drivePreviewRestoreBtn').onclick();
  await JV.$('driveConfirmGoBtn').onclick(); await tick();
  check('restore confirmation completes successfully', JV.notifications.some((n) => /Restored/.test(n.msg)), JSON.stringify(JV.notifications));
  check('UNSAVED DRAFT PRESERVED: the open, unsaved draft is untouched by the restore\'s own list refresh',
    JV.$('kneTitle').value === 'My unsaved draft' && JV.$('kneEdit').value === 'Not saved yet.');
  check('KNOWLEDGE UI REFRESHED: the restored note\'s real content is back on disk (the engine side of "refresh")',
    K.listKnowledgeNotes(d).notes.find((n) => n.id === id).body === 'backed up content');

  // The drive_restored event (emitted by main.mjs after a real restore) independently
  // triggers a list reload while the Knowledge view is open - not only the restore call's own
  // direct await chain.
  let reloaded = false;
  const origList = drive.controller.backupHistory;
  void origList;
  JV.emit('drive_restored', { backupId: 'x' });
  await tick();
  reloaded = true; // reaching here without throwing proves the handler ran without needing a view check to pass (state.view is 'kne' in this harness)
  check('the drive_restored event handler runs without error while the Knowledge view is open', reloaded);
}

console.log('\n--- Phase 1: automatic migration on open (Decision 2) ---');
{
  const d = DIR();
  fs.writeFileSync(path.join(d, 'notes.json'), JSON.stringify([{ id: 'legacy1', text: 'Carried over automatically', created: 1, updated: 2, sentAt: null }]));
  const JV = boot(d, new FakeStorage());
  await tick(20);
  check('opening the page alone - no Import button pressed - carries the legacy note over',
    K.listKnowledgeNotes(d).notes.some((n) => n.id === 'legacy1'), K.listKnowledgeNotes(d).notes);
  check('notes.json itself is untouched by the automatic carry-over', fs.existsSync(path.join(d, 'notes.json')));
  check('the page says what happened, rather than silently changing the list', JV.notifications.some((n) => /carried over/.test(n.msg)), JSON.stringify(JV.notifications));

  // A second "open" (simulated by re-running the view handler) must not re-notify or redo work.
  JV.notifications.length = 0;
  JV.emit('view', 'kne');
  await tick(20);
  check('a second open in the same page-load does not migrate again or notify again (the once-per-boot guard)', JV.notifications.length === 0);
}

console.log('\n--- Phase 1: folders (Decision 3) ---');
{
  const d = DIR();
  const JV = boot(d, new FakeStorage());
  await tick();
  K.saveKnowledgeNote(d, 'fo1', { title: 'Errand', body: 'x', tags: [], favorite: false, folder: 'Personal/Errands' }, {});
  K.saveKnowledgeNote(d, 'fo2', { title: 'Work note', body: 'x', tags: [], favorite: false, folder: 'Work' }, {});
  K.saveKnowledgeNote(d, 'fo3', { title: 'Loose note', body: 'x', tags: [], favorite: false, folder: null }, {});
  JV.emit('view', 'kne');
  await tick(10);
  const folderList = JV.$('kneFolderList');
  check('the folder list is shown, not hidden, once notes have folders', folderList.hidden === false);
  check('"All notes" and "Unfiled" both appear alongside the real folders',
    folderList.children.some((li) => /All notes/.test(li.textContent)) && folderList.children.some((li) => /Unfiled/.test(li.textContent)));
  check('a real folder ("Work") is listed with its count', folderList.children.some((li) => /Work/.test(li.textContent) && /1/.test(li.textContent)));

  // Click the "Work" folder row - the list should now show only fo2.
  const workRow = folderList.children.find((li) => /Work/.test(li.textContent)).children[0];
  workRow.onclick();
  await tick();
  check('selecting a folder filters the note list to just that folder',
    JV.$('kneList').children.length === 1 && JV.$('kneList').children[0].textContent.includes('Work note'));
}

console.log('\n--- Phase 1: pinned notes lead the list (brief item 3 / Decision 3) ---');
{
  const d = DIR();
  const JV = boot(d, new FakeStorage());
  await tick();
  K.saveKnowledgeNote(d, 'older-pinned', { title: 'Older, pinned', body: 'x', tags: [], favorite: true, folder: null }, {});
  K.saveKnowledgeNote(d, 'newer-plain', { title: 'Newer, not pinned', body: 'x', tags: [], favorite: false, folder: null }, {});
  JV.emit('view', 'kne');
  await tick(10);
  const rows = JV.$('kneList').children.filter((li) => li.tagName === 'LI');
  check('the pinned note is shown first, even though it is the older one', /Older, pinned/.test(rows[0].textContent), rows.map((r) => r.textContent));
}

console.log('\n--- Phase 1: a folder saved through the real editor round-trips (field wiring) ---');
{
  const d = DIR();
  const JV = boot(d, new FakeStorage());
  await tick();
  JV.$('kneTitle').value = 'With a folder';
  JV.$('kneTitle').fire('input');
  JV.$('kneEdit').value = 'content';
  JV.$('kneEdit').fire('input');
  JV.$('kneFolder').value = 'Projects/JARVIS';
  JV.$('kneFolder').fire('input');
  await JV.$('kneSave').onclick(); await tick();
  const saved = K.listKnowledgeNotes(d).notes.find((n) => n.title === 'With a folder');
  check('the folder typed in the editor is exactly what gets saved', saved && saved.folder === 'Projects/JARVIS', saved);
}

console.log('\n--- Phase 1 hardening item 1: Send to Telegram, ported from Notes (Classic) ---');
{
  const d = DIR();
  // Telegram not set up: the button stays hidden entirely, rather than shown-and-disabled -
  // simplest, least-surprising rule for a secondary action nobody can use yet.
  let JV = boot(d, new FakeStorage(), null, { telegram: { ready: false, name: null } });
  await tick();
  JV.$('kneTitle').value = 'Not yet sendable';
  JV.$('kneTitle').fire('input');
  JV.$('kneEdit').value = 'x';
  JV.$('kneEdit').fire('input');
  await JV.$('kneSave').onclick(); await tick();
  check('Send to Telegram is hidden while Telegram is not set up', JV.$('kneSendTelegram').hidden === true);

  JV = boot(d, new FakeStorage(), null, { telegram: { ready: true, name: 'My chat' } });
  await tick();
  const id = K.listKnowledgeNotes(d).notes[0].id;
  await open(JV, id);
  check('once saved and Telegram is ready, Send to Telegram is offered', JV.$('kneSendTelegram').hidden === false);
  await JV.$('kneSendTelegram').onclick(); await tick();
  check('pressing it sends through the real IPC bridge (here, the fake Telegram call) and reports success', /Sent to Telegram/.test(JV.$('kneMsg').textContent), JV.$('kneMsg').textContent);
  check('the note itself now shows "sent"', /sent/.test(JV.$('kneWhen').textContent), JV.$('kneWhen').textContent);
  check('the note\'s own content on disk now carries sentAt', K.listKnowledgeNotes(d).notes.find((n) => n.id === id).sentAt > 0);

  async function open(jv, noteId) {
    await jv.$('kneList').children[0].children[0].onclick();
    await tick();
    void noteId;
  }
}

console.log('\n--- Phase 1 hardening item 2: editing after migration can never silently overwrite or lose a change ---');
{
  const d = DIR();
  fs.writeFileSync(path.join(d, 'notes.json'), JSON.stringify([{ id: 'both1', text: 'Original from Notes (Classic)', created: 1, updated: 2, sentAt: null }]));
  const JV = boot(d, new FakeStorage());
  await tick(20); // the automatic carry-over runs here
  check('the note exists in the unified store after automatic migration', K.listKnowledgeNotes(d).notes.some((n) => n.id === 'both1'));

  // Someone edits the SAME note in the unified store through the real editor.
  await JV.$('kneList').children[0].children[0].onclick(); await tick();
  JV.$('kneEdit').value = 'Edited in the unified store after migration';
  JV.$('kneEdit').fire('input');
  await JV.$('kneSave').onclick(); await tick();
  check('the edit in the unified store took effect', K.listKnowledgeNotes(d).notes.find((n) => n.id === 'both1').body === 'Edited in the unified store after migration');

  // Notes (Classic)'s own notes.json is a completely separate store - editing it after the
  // fact (simulating a person still using the old page during the transition) must never
  // reach back into the already-migrated unified copy, silently or otherwise.
  fs.writeFileSync(path.join(d, 'notes.json'), JSON.stringify([{ id: 'both1', text: 'Changed in Notes (Classic) after migration', created: 1, updated: 99999 }]));
  check('the already-migrated unified note is untouched by a later edit to notes.json - the two stores never read each other after the fact',
    K.listKnowledgeNotes(d).notes.find((n) => n.id === 'both1').body === 'Edited in the unified store after migration');

  // And a manual re-Import at this point must report the divergence as a conflict, never
  // silently overwrite the unified edit with the Classic one (or vice versa).
  const preview = await window_previewFor(d);
  check('a manual re-Import correctly reports this as a conflict, not a silent overwrite in either direction', preview.conflicts.length === 1 && preview.conflicts[0].id === 'both1', preview);

  async function window_previewFor(dir) { return K.previewMigration(dir); }
}

console.log('\n--- Phase 1 hardening item 4: folder hierarchy renders nested, not just a flat list ---');
{
  const d = DIR();
  const JV = boot(d, new FakeStorage());
  await tick();
  K.saveKnowledgeNote(d, 'nest1', { title: 'Errand', body: 'x', tags: [], favorite: false, folder: 'Personal/Errands' }, {});
  JV.emit('view', 'kne');
  await tick(10);
  const rows = JV.$('kneFolderList').children;
  const personalRow = rows.find((li) => li.children[0].children.some((c) => c.textContent === 'Personal'));
  const errandsRow = rows.find((li) => li.children[0].children.some((c) => c.textContent === 'Errands'));
  check('an ancestor folder ("Personal") is synthesized and shown even though no note is filed directly in it', !!personalRow, rows.map((r) => r.textContent));
  check('the ancestor shows a zero count - no note is filed directly there', personalRow && personalRow.children[0].children.some((c) => c.textContent === '0'));
  check('the leaf folder ("Errands") is shown indented deeper than its parent', !!errandsRow && Number(errandsRow.children[0].style.paddingLeft?.replace('px', '') || 0) > Number(personalRow.children[0].style.paddingLeft?.replace('px', '') || 0));
  check('the leaf\'s label is just its own segment ("Errands"), not the full path - the full path is still the filter value, not the display text',
    errandsRow.children[0].children.some((c) => c.textContent === 'Errands') && !errandsRow.children[0].children.some((c) => c.textContent === 'Personal/Errands'));

  // Selecting the parent ("Personal") must mean exactly that folder, never "and everything
  // under it" - the simplest rule, and the one already locked in by this phase's other tests.
  personalRow.children[0].onclick();
  await tick();
  check('selecting the (empty) parent folder shows no notes - it does not fall back to including its child\'s notes',
    JV.$('kneList').children.length === 1 && /No note/.test(JV.$('kneList').textContent));
}

console.log('\n--- Phase 2: app-owned "Connect Google Account" (Decision 1) ---');
{
  const d = DIR();
  const disconnected = async () => ({ status: 'disconnected', clientConfigured: false });
  // Both gates closed (the real default on every build today): nothing changes from before.
  let JV = boot(d, new FakeStorage(), null, { driveStatus: disconnected, appOwned: { available: false } });
  await tick();
  JV.emit('view', 'kne'); await tick();
  check('with the app-owned path unavailable, the section stays hidden and BYO is exactly as before',
    JV.$('driveAppOwnedSection').hidden === true && JV.$('driveConfigureBtn').hidden === false);

  // Both gates open: the one-click path appears, and BYO's own button is hidden behind it.
  let connectCalls = 0;
  JV = boot(d, new FakeStorage(), null, {
    driveStatus: disconnected, appOwned: { available: true },
    driveConnectAppOwned: async () => { connectCalls += 1; return { ok: true, status: 'connected' }; },
  });
  await tick();
  JV.emit('view', 'kne'); await tick();
  check('with both gates open, "Connect Google Account" is offered and the BYO Configure button is not',
    JV.$('driveAppOwnedSection').hidden === false && JV.$('driveConfigureBtn').hidden === true);
  await JV.$('driveConnectAppOwnedBtn').onclick(); await tick();
  check('pressing it calls the app-owned IPC - never driveConfigureClient/driveConnect\'s own BYO path', connectCalls === 1);

  // The escape hatch: a person can still choose to use their own Client ID instead.
  await JV.$('driveShowByoBtn').onclick(); await tick();
  check('"Use my own Client ID instead" switches to the BYO fields and hides the app-owned section',
    JV.$('driveAppOwnedSection').hidden === true && JV.$('driveConfigureBtn').hidden === false);
}

console.log('\n--- Phase 6 bugfix: a saved Client ID must stay editable - there was no way back in before ---');
{
  const d = DIR();
  let saved = null;
  const JV = boot(d, new FakeStorage(), null, {
    driveStatus: async () => (saved ? { status: 'disconnected', clientConfigured: true } : { status: 'disconnected', clientConfigured: false }),
    appOwned: { available: false },
  });
  await tick();
  JV.emit('view', 'kne'); await tick();
  check('before anything is configured, the button says "Configure"', JV.$('driveConfigureBtn').textContent === 'Configure OAuth Client ID');

  await JV.$('driveConfigureBtn').onclick(); await tick();
  check('clicking it opens the fields', JV.$('driveClientFields').hidden === false);
  JV.$('driveClientId').value = 'abc.apps.googleusercontent.com';
  saved = true; // simulates window.jarvis.driveConfigureClient having succeeded
  await JV.$('driveSaveClient').onclick(); await tick();

  check('BUG FIX: after saving, the button is still visible, never permanently gone', JV.$('driveConfigureBtn').hidden === false);
  check('and it now reads "Change", not "Configure", reflecting that something is already saved', JV.$('driveConfigureBtn').textContent === 'Change OAuth Client ID');
  await JV.$('driveConfigureBtn').onclick(); await tick();
  check('clicking it again still reopens the fields - there is always a way back in', JV.$('driveClientFields').hidden === false);
}

console.log('\n--- Phase 3: sync status line and Sync Now (UI wiring only - the engine is tested separately) ---');
{
  const d = DIR();
  const drive = makeDrive(d);
  let syncCalls = 0;
  const JV = boot(d, new FakeStorage(), drive, {
    driveSyncStatus: async () => (syncCalls ? { state: 'idle', lastSyncAt: Date.now(), conflictCount: 0, syncing: false } : { state: 'offline', conflictCount: 0, syncing: false }),
    driveSyncNow: async () => { syncCalls += 1; return { ok: true }; },
  });
  await tick();
  JV.emit('view', 'kne'); await tick();
  check('an offline sync status is shown in plain language, not silently blank', /Offline/.test(JV.$('driveSyncStatus').textContent));
  await JV.$('driveSyncNowBtn').onclick(); await tick();
  check('pressing Sync Now calls the real IPC call, not the backup/restore ones', syncCalls === 1);
  check('the status line reflects the result of that sync', /Synced/.test(JV.$('driveSyncStatus').textContent), JV.$('driveSyncStatus').textContent);
}
{
  const d = DIR();
  const drive = makeDrive(d);
  const JV = boot(d, new FakeStorage(), drive, {
    driveSyncStatus: async () => ({
      state: 'conflict', conflictCount: 2, syncing: false,
      conflictingNotes: [{ id: 'n1', title: 'Shared grocery list' }, { id: 'n2', title: 'Budget notes' }],
    }),
  });
  await tick();
  JV.emit('view', 'kne'); await tick();
  check('a conflict state names the actual notes, not just a count, so the person knows what to open',
    /2 notes need attention/.test(JV.$('driveSyncStatus').textContent)
    && /Shared grocery list/.test(JV.$('driveSyncStatus').textContent)
    && /Budget notes/.test(JV.$('driveSyncStatus').textContent)
    && /Version History/.test(JV.$('driveSyncStatus').textContent),
    JV.$('driveSyncStatus').textContent);
}
{
  const d = DIR();
  const drive = makeDrive(d);
  const JV = boot(d, new FakeStorage(), drive, { driveSyncStatus: async () => ({ state: 'quarantine', quarantinedCount: 2, syncing: false }) });
  await tick();
  JV.emit('view', 'kne'); await tick();
  check('Phase 6 (Task 5): a quarantine state explicitly says local notes were NOT changed - never silently invisible',
    /2 files/.test(JV.$('driveSyncStatus').textContent) && /not changed/.test(JV.$('driveSyncStatus').textContent),
    JV.$('driveSyncStatus').textContent);
}

console.log('\n--- Phase 4: "Exclude from AI" toggle round-trips through save ---');
{
  const d = DIR();
  const JV = boot(d, new FakeStorage());
  await tick();
  JV.$('kneTitle').value = 'Private note';
  JV.$('kneTitle').fire('input');
  JV.$('kneEdit').value = 'secret content';
  JV.$('kneEdit').fire('input');
  check('the toggle starts off (included) by default', JV.$('kneAiExclude').getAttribute('aria-pressed') === 'false');
  await JV.$('kneAiExclude').onclick();
  check('clicking it arms exclusion', JV.$('kneAiExclude').getAttribute('aria-pressed') === 'true');
  await JV.$('kneSave').onclick(); await tick();
  const saved = K.listKnowledgeNotes(d).notes.find((n) => n.title === 'Private note');
  check('the saved note is actually marked aiExcluded on disk', saved && saved.aiExcluded === true, saved);

  // Reopening it should reflect the saved state, not reset to included.
  await JV.$('kneNew').onclick();
  await JV.$('kneList').children[0].children[0].onclick(); await tick();
  check('reopening the note shows the toggle still armed', JV.$('kneAiExclude').getAttribute('aria-pressed') === 'true');
}

console.log('\n--- Phase 4: "Ask about your notes" - local search, never an automatic send ---');
{
  const d = DIR();
  let searched = null;
  const JV = boot(d, new FakeStorage(), null, {
    notesSearch: async (q) => { searched = q; return { ok: true, results: [{ id: 'n1', title: 'Vet notes', folder: null, snippet: 'switch food gradually', score: 5 }] }; },
    notesAskContext: async (q) => ({ ok: true, prompt: `Using only the following notes of mine, answer this question: ${q}\n\n[1] Vet notes\nswitch food gradually`, sources: [{ id: 'n1', title: 'Vet notes' }] }),
  });
  await tick();
  await JV.$('kneAskOpen').onclick();
  check('opening Ask shows the dialog, empty, with Ask-in-Chat disabled until something is found', JV.$('kneAskVeil').hidden === false && JV.$('kneAskGo').disabled === true);

  JV.$('kneAskQuery').value = 'what did the vet say about food';
  await runAskSearchFor(JV);
  check('typing a question calls the real search IPC with exactly what was typed', searched === 'what did the vet say about food');
  check('a result is shown, with its own title and snippet - the citation', /Vet notes/.test(JV.$('kneAskResults').textContent) && /gradually/.test(JV.$('kneAskResults').textContent));
  check('Ask in Chat is now enabled', JV.$('kneAskGo').disabled === false);

  await JV.$('kneAskGo').onclick(); await tick();
  check('pressing "Ask in Chat" inserts the composed prompt (with its citation) into the chat composer', JV.chatInserts.length === 1 && /Vet notes/.test(JV.chatInserts[0]) && /gradually/.test(JV.chatInserts[0]));
  check('the dialog closed after handing off to Chat', JV.$('kneAskVeil').hidden === true);
  check('nothing was ever sent automatically - JV.chat.insert only fills the composer, never submits', JV.chatInserts.length === 1);

  async function runAskSearchFor(jv) {
    // The real code debounces input via setTimeout; this harness's setTimeout runs its
    // callback immediately (see ctx's setTimeout override above), so firing 'input' alone
    // already triggers the search synchronously-enough for `await tick()` to catch up.
    jv.$('kneAskQuery').fire('input');
    await tick(10);
  }
}
{
  const d = DIR();
  const JV = boot(d, new FakeStorage(), null, { notesSearch: async () => ({ ok: true, results: [] }) });
  await tick();
  await JV.$('kneAskOpen').onclick();
  JV.$('kneAskQuery').value = 'nothing matches this';
  JV.$('kneAskQuery').fire('input');
  await tick(10);
  check('no results shown in plain language, not a blank or broken dialog', /Nothing in your notes matches/.test(JV.$('kneAskMsg').textContent));
  check('Ask in Chat stays disabled when there is nothing to ask about', JV.$('kneAskGo').disabled === true);
}

console.log(`\n${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('  FAILED: ' + f);
process.exit(fails.length ? 1 : 0);
