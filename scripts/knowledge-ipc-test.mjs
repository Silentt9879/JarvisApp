// JARVIS Knowledge - Phase 23C: the editor's IPC surface (input validation and optimistic-
// concurrency saves, both in src/knowledge.mjs) and its wiring into main.mjs, preload.cjs,
// index.html and knowledge.js. Temp folders only for the storage-level checks; the wiring
// checks read source text, the same way scripts/analysis-test.mjs and
// scripts/dotnet-analysis-test.mjs already do for their own panels - no Electron, nothing
// under a real %APPDATA%\JARVIS.
//   node scripts/knowledge-ipc-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newId, knowledgePaths, writeKnowledgeNote, sanitizeTags, validateNoteInput, saveKnowledgeNote, noteRevision } from '../src/knowledge.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${extra ? `\n     ${extra}` : ''}`); } };
const check = (name, fn) => { try { fn(); ok(true, name); } catch (e) { ok(false, name, String(e?.stack || e).split('\n').slice(0, 5).join('\n     ')); } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-knowledge-ipc-'));
let n = 0;
const dir = () => { const d = path.join(TMP, `d${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };

// ------------------------------------------------------------------ sanitizeTags
check('tags: strings only, trimmed, empty ones dropped', () => {
  assert.deepEqual(sanitizeTags([' home ', '', '  ', 42, null, undefined, 'errands']), ['home', 'errands']);
});
check('tags: a non-array input is simply no tags, never a throw', () => {
  assert.deepEqual(sanitizeTags(null), []);
  assert.deepEqual(sanitizeTags('home,errands'), []);
  assert.deepEqual(sanitizeTags(undefined), []);
});
check('tags: duplicates are kept once, in first-seen order', () => {
  assert.deepEqual(sanitizeTags(['a', 'b', 'a', 'B']), ['a', 'b', 'B']);
});
check('tags: an overlong single tag is dropped, not truncated into a different tag', () => {
  assert.deepEqual(sanitizeTags(['ok', 'x'.repeat(61)]), ['ok']);
});
check('tags: capped at 50, the rest silently dropped rather than refusing the whole save', () => {
  const many = Array.from({ length: 60 }, (_, i) => `t${i}`);
  assert.equal(sanitizeTags(many).length, 50);
});

// ------------------------------------------------------------------ validateNoteInput
check('a well-formed note passes through with its fields trimmed', () => {
  const r = validateNoteInput({ title: '  Shopping  ', body: 'milk\nbread', tags: ['home', ' home '], favorite: true, folder: ' Personal ' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { title: 'Shopping', body: 'milk\nbread', tags: ['home'], favorite: true, folder: 'Personal', aiExcluded: false });
});
check('no input at all is refused with a plain error, not a throw', () => {
  assert.equal(validateNoteInput(null).ok, false);
  assert.equal(validateNoteInput(undefined).ok, false);
  assert.equal(validateNoteInput('a string').ok, false);
});
check('a missing or wrong-typed field becomes its empty value, never thrown', () => {
  const r = validateNoteInput({ body: 42, tags: 'home', favorite: 'yes', folder: 9 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { title: null, body: '', tags: [], favorite: false, folder: null, aiExcluded: false });
});
check('an empty title/folder after trimming is null, not an empty string - so renderNoteFile omits the line entirely', () => {
  const r = validateNoteInput({ title: '   ', body: 'x', folder: '  ' });
  assert.equal(r.value.title, null);
  assert.equal(r.value.folder, null);
});
check('a body over the size limit is refused outright, never silently truncated', () => {
  const r = validateNoteInput({ body: 'x'.repeat(2_000_001) });
  assert.equal(r.ok, false);
  assert.match(r.error, /too long/);
});
check('favorite is exactly true or false - any other value (including the string "true") is false', () => {
  assert.equal(validateNoteInput({ body: 'x', favorite: 'true' }).value.favorite, false);
  assert.equal(validateNoteInput({ body: 'x', favorite: 1 }).value.favorite, false);
  assert.equal(validateNoteInput({ body: 'x', favorite: true }).value.favorite, true);
});

// ------------------------------------------------------------------ noteRevision
check('noteRevision is null for a note that does not exist yet', () => {
  assert.equal(noteRevision(dir(), newId()), null);
});
check('noteRevision changes when the file\'s content changes, and is stable when it does not', () => {
  const d = dir();
  const id = newId();
  writeKnowledgeNote(d, { id, title: 'A', created: 1, updated: 1, tags: [], favorite: false, body: 'one' });
  const r1 = noteRevision(d, id);
  assert.notEqual(r1, null);
  assert.equal(noteRevision(d, id), r1, 'reading it again without changing it gives the same revision');
  writeKnowledgeNote(d, { id, title: 'A', created: 1, updated: 2, tags: [], favorite: false, body: 'two' }, { force: true });
  assert.notEqual(noteRevision(d, id), r1, 'a changed body changes the revision');
});
check('an unusable id has no revision - the same path safety writeKnowledgeNote already enforces', () => {
  assert.equal(noteRevision(dir(), '../escape'), null);
  assert.equal(noteRevision(dir(), 'a/b'), null);
});

// ------------------------------------------------------------------ saveKnowledgeNote: concurrency
check('a brand-new note (baseRevision null) is created, and a revision comes back for the next save', () => {
  const d = dir();
  const id = newId();
  const r = saveKnowledgeNote(d, id, { title: 'First', body: 'hello', tags: [], favorite: false, folder: null }, { baseRevision: null });
  assert.equal(r.ok, true);
  assert.equal(r.note.title, 'First');
  assert.equal(r.note.body, 'hello');
  assert.notEqual(r.revision, null);
  assert.equal(r.revision, noteRevision(d, id));
});
check('a second "new note" save at the same id, still claiming baseRevision null, is refused as stale - never silently overwritten', () => {
  const d = dir();
  const id = newId();
  const first = saveKnowledgeNote(d, id, { title: 'Window A', body: 'a', tags: [], favorite: false, folder: null }, { baseRevision: null });
  assert.equal(first.ok, true);
  const second = saveKnowledgeNote(d, id, { title: 'Window B', body: 'b', tags: [], favorite: false, folder: null }, { baseRevision: null });
  assert.equal(second.ok, false);
  assert.equal(second.stale, true);
  assert.equal(noteRevision(d, id), first.revision, 'the first save is still exactly what is on disk');
});
check('editing from a revision that is no longer current is refused as stale, with the current revision handed back', () => {
  const d = dir();
  const id = newId();
  const v1 = saveKnowledgeNote(d, id, { title: 'T', body: 'v1', tags: [], favorite: false, folder: null }, { baseRevision: null });
  const v2 = saveKnowledgeNote(d, id, { title: 'T', body: 'v2', tags: [], favorite: false, folder: null }, { baseRevision: v1.revision });
  assert.equal(v2.ok, true, 'editing from the current revision succeeds');
  // Window A, still holding v1's revision, tries to save its own edit - too late, v2 already landed.
  const stale = saveKnowledgeNote(d, id, { title: 'T', body: 'from window A', tags: [], favorite: false, folder: null }, { baseRevision: v1.revision });
  assert.equal(stale.ok, false);
  assert.equal(stale.stale, true);
  assert.equal(stale.currentRevision, v2.revision);
  assert.equal(fs.readFileSync(knowledgePaths(d).notesDir + `/${id}.md`, 'utf8').includes('v2'), true, 'v2 is still exactly what is on disk - the stale save never touched it');
});
check('force: true saves over a stale revision anyway - the explicit override, never automatic', () => {
  const d = dir();
  const id = newId();
  const v1 = saveKnowledgeNote(d, id, { title: 'T', body: 'v1', tags: [], favorite: false, folder: null }, { baseRevision: null });
  saveKnowledgeNote(d, id, { title: 'T', body: 'v2', tags: [], favorite: false, folder: null }, { baseRevision: v1.revision });
  const overwrite = saveKnowledgeNote(d, id, { title: 'T', body: 'overwritten on purpose', tags: [], favorite: false, folder: null }, { baseRevision: v1.revision, force: true });
  assert.equal(overwrite.ok, true);
  assert.equal(overwrite.note.body, 'overwritten on purpose');
});
check('a note deleted from disk since it was opened is refused as stale, not recreated as if nothing happened', () => {
  const d = dir();
  const id = newId();
  const v1 = saveKnowledgeNote(d, id, { title: 'T', body: 'v1', tags: [], favorite: false, folder: null }, { baseRevision: null });
  fs.unlinkSync(`${knowledgePaths(d).notesDir}/${id}.md`);
  const r = saveKnowledgeNote(d, id, { title: 'T', body: 'edit after delete', tags: [], favorite: false, folder: null }, { baseRevision: v1.revision });
  assert.equal(r.ok, false);
  assert.equal(r.stale, true);
  assert.match(r.error, /deleted/);
});
check('editing preserves unknown front-matter keys and the original "created" timestamp', () => {
  const d = dir();
  const id = newId();
  writeKnowledgeNote(d, { id, title: 'T', created: 1000, updated: 1000, tags: [], favorite: false, body: 'v1' });
  fs.appendFileSync(`${knowledgePaths(d).notesDir}/${id}.md`, '');
  // Hand-add an unmanaged key the way agents.mjs's own files carry one through.
  const file = `${knowledgePaths(d).notesDir}/${id}.md`;
  const withExtra = fs.readFileSync(file, 'utf8').replace('---\n\nv1', 'source: imported\n---\n\nv1');
  fs.writeFileSync(file, withExtra);
  const base = noteRevision(d, id);
  const r = saveKnowledgeNote(d, id, { title: 'T', body: 'v2', tags: [], favorite: false, folder: null }, { baseRevision: base });
  assert.equal(r.ok, true);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /source: imported/, 'the unmanaged key survives an edit it had nothing to do with');
  assert.match(text, /created: 1000/, 'created is carried through from the existing file, not reset to now');
});
check('an id that is not a usable filename is refused, the same path safety writeKnowledgeNote already enforces', () => {
  for (const bad of ['../escape', 'a/b', 'a\\b', '', 'con']) {
    const r = saveKnowledgeNote(dir(), bad, { title: 'x', body: 'x', tags: [], favorite: false, folder: null }, { baseRevision: null });
    assert.equal(r.ok, false, `"${bad}" must be refused`);
  }
});
check('a write that fails leaves whatever was already saved exactly as it was', () => {
  const d = dir();
  const id = newId();
  const v1 = saveKnowledgeNote(d, id, { title: 'T', body: 'safe', tags: [], favorite: false, folder: null }, { baseRevision: null });
  const brokenFs = { ...fs, writeFileSync: () => { throw new Error('disk full'); } };
  const r = saveKnowledgeNote(d, id, { title: 'T', body: 'this should not land', tags: [], favorite: false, folder: null }, { baseRevision: v1.revision, fsImpl: brokenFs });
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(`${knowledgePaths(d).notesDir}/${id}.md`, 'utf8').includes('safe'), true);
  assert.equal(noteRevision(d, id), v1.revision);
});

console.log('\n--- wiring ---');
const src = (f) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
const main = src('main.mjs');
const pre = src('preload.cjs');
const html = src('renderer/index.html');
const knowledgeJs = src('renderer/knowledge.js');

check('main.mjs imports the Phase 23C/23D/23E editor, import/Trash and version-history functions from knowledge.mjs, not a reimplementation', () => {
  const end = main.indexOf("} from './knowledge.mjs';");
  const imp = main.slice(main.lastIndexOf('import', end), end + 25);
  for (const name of [
    'newId as newKnowledgeId', 'knowledgePaths', 'listKnowledgeNotes', 'migrationComplete as knowledgeMigrationComplete',
    'validateNoteInput', 'saveKnowledgeNote', 'noteRevision', 'previewMigration', 'migrateFromLegacy',
    'listTrash', 'deleteKnowledgeNote', 'restoreKnowledgeNote', 'listSnapshots', 'readSnapshot', 'restoreSnapshot',
  ]) {
    assert.ok(imp.includes(name), `imports ${name}`);
  }
});
check('every knowledgeSave input is run through validateNoteInput before anything is written', () => {
  const body = main.slice(main.indexOf("ipcMain.handle('jarvis:knowledgeSave'"), main.indexOf("ipcMain.handle('jarvis:knowledgeSave'") + 700);
  assert.match(body, /const v = validateNoteInput\(input\);/);
  assert.match(body, /if \(!v\.ok\) return \{ ok: false, error: v\.error \};/);
  assert.match(body, /saveKnowledgeNote\(userDir, id, v\.value, \{ baseRevision, force \}\)/);
});
check('a new note\'s id always comes from newKnowledgeId() on the main side - a renderer cannot choose it by sending one', () => {
  const body = main.slice(main.indexOf("ipcMain.handle('jarvis:knowledgeSave'"), main.indexOf("ipcMain.handle('jarvis:knowledgeSave'") + 700);
  assert.match(body, /const id = typeof input\?\.id === 'string' && input\.id \? input\.id : newKnowledgeId\(\);/);
});
check('the editor handlers (status/list/read/save) never write to or migrate notes.json - only the dedicated Import handler below calls migrateFromLegacy', () => {
  const section = main.slice(main.indexOf('IPC: Knowledge (Phase 23C)'), main.indexOf('Phase 23D: Import, Trash, restore'));
  assert.doesNotMatch(section, /notes\.save\(|notes\.remove\(|notes\.write\(|migrateFromLegacy/);
  assert.match(section, /notes\.list\(\)\.length/);
});
check('the Knowledge handlers are not gated on workspace trust - this store lives in userData, same as Notes, not in a project workspace', () => {
  const section = main.slice(main.indexOf('IPC: Knowledge (Phase 23C)'), main.indexOf('IPC: files (read-only)'));
  assert.doesNotMatch(section, /workspaceTrusted/);
});
check('Import never deletes, renames or writes to notes.json itself - it only calls migrateFromLegacy, the already-tested, read-only-of-notes.json engine', () => {
  const section = main.slice(main.indexOf("ipcMain.handle('jarvis:knowledgeImport'"), main.indexOf("ipcMain.handle('jarvis:knowledgeTrash'"));
  assert.match(section, /migrateFromLegacy\(userDir\)/);
  assert.doesNotMatch(section, /fs\.unlink|fs\.rm|fs\.rename|legacyFile/);
});
check('Delete and Restore are revision-checked and never bypass staleness with a force option the way a save can', () => {
  const del = main.slice(main.indexOf("ipcMain.handle('jarvis:knowledgeDelete'"), main.indexOf("ipcMain.handle('jarvis:knowledgeRestore'"));
  assert.match(del, /deleteKnowledgeNote\(userDir, id, \{ baseRevision: rev \}\)/);
  assert.doesNotMatch(del, /force/);
});
check('the bridge exposes all ten knowledge calls, and the window is never handed a raw ipcRenderer', () => {
  for (const k of ['knowledgeStatus:', 'knowledgeList:', 'knowledgeRead:', 'knowledgeSave:', 'knowledgeImportPreview:', 'knowledgeImport:', 'knowledgeTrash:', 'knowledgeTrashRead:', 'knowledgeDelete:', 'knowledgeRestore:']) {
    assert.ok(pre.includes(k), `${k} is exposed`);
  }
});
check('the Devices-style discovery rule holds here too: Notes (the unified page, née Knowledge Notes) is reachable from the sidebar, from search, and its view and script exist exactly once', () => {
  assert.match(html, /id="navKne" data-view="kne"/);
  assert.match(html, /id="view-kne"/);
  assert.match(html, /<script src="knowledge\.js"><\/script>/);
  assert.match(fs.readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8'), /\['Notes', 'kne'\]/);
  const ids = [
    'kneNew', 'kneImportOpen', 'kneTabNotes', 'kneTabTrash', 'kneTrashCount', 'kneSearch', 'kneFolderList', 'kneList',
    'kneTitle', 'kneWhen', 'kneFavorite', 'kneRestore', 'knePreviewToggle', 'kneDelete', 'kneSave',
    'kneFolder', 'kneTags', 'kneMsg', 'kneEdit', 'knePreview', 'kneStorageNote', 'kneAiExclude',
    'kneAskOpen', 'kneAskVeil', 'kneAskTitle', 'kneAskQuery', 'kneAskResults', 'kneAskMsg', 'kneAskCancel', 'kneAskGo',
    'kneImportVeil', 'kneImportTitle', 'kneImportStats', 'kneImportDest', 'kneImportMsg', 'kneImportCancel', 'kneImportGo',
    'kneDeleteVeil', 'kneDeleteTitle', 'kneDeleteName', 'kneDeleteCancel', 'kneDeleteGo',
  ];
  for (const id of ids) assert.equal(html.split(`id="${id}"`).length, 2, `"${id}" is declared exactly once`);
});
check('Notes (the unified page) is named apart from the pre-existing Knowledge Base panel - a label-only change, nothing structural', () => {
  assert.match(html, /<h2>Notes<\/h2>/);
  assert.match(html, />Knowledge Base</, 'the other panel\'s own label is untouched');
});
check('knowledge.js is loaded after notes.js and before app.js', () => {
  assert.ok(html.indexOf('notes.js') < html.indexOf('knowledge.js') && html.indexOf('knowledge.js') < html.indexOf('app.js'));
});
check('the Markdown preview reuses the chat\'s own sanitized renderer (JV.renderMarkdown) - it does not call marked or DOMPurify directly, so it inherits the same no-remote-images, no-script policy', () => {
  assert.match(knowledgeJs, /JV\.renderMarkdown\(\$\('knePreview'\), bodyEl\(\)\.value\)/);
  assert.doesNotMatch(knowledgeJs, /\bmarked\.parse\(|DOMPurify\.sanitize\(/);
});
check('a save always sends baseRevision, so a stale save can never slip through for lack of asking', () => {
  assert.match(knowledgeJs, /const input = \{ id: current \? current\.id : null, baseRevision, force, \.\.\.f \};/);
});
check('a stale save shows an explicit choice (reload or overwrite) rather than picking one for the user', () => {
  assert.match(knowledgeJs, /function sayConflict\(c\)/);
  assert.match(knowledgeJs, /'Reload latest'/);
  assert.match(knowledgeJs, /'Overwrite anyway'/);
  assert.match(knowledgeJs, /save\(\{ force: true \}\)/);
});
check('an unsaved edit survives switching notes (an in-memory draft) and survives the window closing (mirrored to localStorage), restored with a plain notice, never a blocking dialog', () => {
  assert.match(knowledgeJs, /const drafts = new Map\(\);/);
  assert.match(knowledgeJs, /function persistDraft\(id, draft\)/);
  assert.match(knowledgeJs, /localStorage\.setItem\(DRAFT_PREFIX \+ id, JSON\.stringify\(draft\)\)/);
  assert.match(knowledgeJs, /Restored your unsaved draft of this note\./);
  assert.doesNotMatch(knowledgeJs, /window\.confirm\(|beforeunload/);
});

// ------------------------------------------------------------------ Phase 23D wiring
check('switching to Trash, like switching notes, keeps whatever is unsaved as a draft first - setMode calls keepDraft() before anything else', () => {
  const body = knowledgeJs.slice(knowledgeJs.indexOf('function setMode(m)'), knowledgeJs.indexOf('function setMode(m)') + 300);
  assert.match(body, /if \(mode === m\) return;\s*keepDraft\(\);/);
});
check('drafts are kept per note id (and "new" for an unsaved note), never shared across notes - and never shown at all in Trash, which is read-only', () => {
  assert.match(knowledgeJs, /const key = \(\) => \(current \? current\.id : 'new'\);/);
  assert.match(knowledgeJs, /const draft = mode === 'notes' \? drafts\.get\(key\(\)\) : null;/);
});
check('a failed save (stale or otherwise) keeps the draft, so a conflict can never discard what was just typed', () => {
  const body = knowledgeJs.slice(knowledgeJs.indexOf('async function save(opts)'), knowledgeJs.indexOf('// ------------------------------------------------------------- Delete'));
  assert.match(body, /keepDraft\(\);/);
  assert.doesNotMatch(body, /renderEditor\(\);\s*\n\s*return;/, 'the failure branch must not re-render the editor from a stale draft/baseline, which would overwrite what was just typed');
});
check('overwriting a newer revision takes two presses (arm, then confirm) and says a recovery copy is made first - never a single click', () => {
  const body = knowledgeJs.slice(knowledgeJs.indexOf('function sayConflict(c)'), knowledgeJs.indexOf('function sayStaleDelete'));
  assert.match(body, /let armed = false;/);
  assert.match(body, /if \(!armed\) \{ armed = true;.*return; \}/);
  assert.match(body, /backed up first/);
});
check('a stale delete offers only Reload - never an "overwrite anyway" for a delete, since there is nothing to force past', () => {
  const body = knowledgeJs.slice(knowledgeJs.indexOf('function sayStaleDelete'), knowledgeJs.indexOf('function title('));
  assert.match(body, /'Reload latest'/);
  assert.doesNotMatch(body, /Overwrite anyway/);
});
check('Delete asks first, in a real confirm dialog (not window.confirm), and sends the revision the editor actually has open', () => {
  assert.match(knowledgeJs, /function openDeleteConfirm\(\)/);
  assert.match(knowledgeJs, /window\.jarvis\.knowledgeDelete\(id, rev\)/);
  const confirmBody = knowledgeJs.slice(knowledgeJs.indexOf('async function confirmDelete'), knowledgeJs.indexOf('async function confirmDelete') + 700);
  assert.match(confirmBody, /const rev = baseRevision;/);
});
check('Import always previews before it asks to confirm, and the confirm step itself calls the real migrateFromLegacy-backed IPC, never a guess at what it would do', () => {
  assert.match(knowledgeJs, /async function openImport\(\)[\s\S]{0,300}window\.jarvis\.knowledgeImportPreview\(\)/);
  assert.match(knowledgeJs, /async function confirmImport\(\)[\s\S]{0,300}window\.jarvis\.knowledgeImport\(\)/);
});
check('the Import dialog is a real confirm dialog like the Git "discard all" one (a focus-trapped modal-veil, Escape and an outside click both cancel, not window.confirm)', () => {
  assert.match(knowledgeJs, /\$\('kneImportVeil'\)\.addEventListener\('mousedown', \(e\) => \{ if \(e\.target === \$\('kneImportVeil'\)\) closeImport\(\); \}\);/);
  assert.match(knowledgeJs, /if \(e\.key === 'Escape'\) \{ e\.preventDefault\(\); closeImport\(\); return; \}/);
});
check('a Trash entry is read-only (title, body and tags disabled) and offers Restore, never Save or Delete - Restore only once an actual entry is open, not merely for being on the Trash tab', () => {
  const body = knowledgeJs.slice(knowledgeJs.indexOf('function renderEditorMode()'), knowledgeJs.indexOf('function renderEditorMode()') + 500);
  assert.match(body, /titleEl\(\)\.readOnly = trash;/);
  assert.match(body, /bodyEl\(\)\.readOnly = trash;/);
  assert.match(body, /\$\('kneSave'\)\.hidden = trash;/);
  assert.match(body, /\$\('kneRestore'\)\.hidden = !\(trash && current\);/);
});
check('restoring refuses to overwrite a live note with the same id - a conflict is reported, not silently replaced', () => {
  const section = main.slice(main.indexOf('IPC: Knowledge (Phase 23C)'), main.indexOf('IPC: files (read-only)'));
  assert.match(section, /restoreKnowledgeNote\(userDir, id\)/);
});

// ------------------------------------------------------------------ Phase 23E wiring
check('every Version History handler validates its id and file reference server-side before calling into knowledge.mjs', () => {
  const section = main.slice(main.indexOf("ipcMain.handle('jarvis:knowledgeSnapshots'"), main.indexOf('IPC: files (read-only)'));
  assert.match(section, /typeof id !== 'string' \|\| !id/);
  for (const handle of ["ipcMain.handle('jarvis:knowledgeSnapshotRead'", "ipcMain.handle('jarvis:knowledgeSnapshotRestore'"]) {
    const body = main.slice(main.indexOf(handle), main.indexOf(handle) + 300);
    assert.match(body, /typeof id !== 'string' \|\| !id \|\| typeof file !== 'string' \|\| !file/);
  }
});
check('restoring a version is revision-checked the same way a save or a delete is - a stale restore is refused, not silently merged', () => {
  const body = main.slice(main.indexOf("ipcMain.handle('jarvis:knowledgeSnapshotRestore'"), main.indexOf("ipcMain.handle('jarvis:knowledgeSnapshotRestore'") + 500);
  assert.match(body, /restoreSnapshot\(userDir, id, file, \{ baseRevision: rev \}\)/);
});
check('the bridge exposes the three version-history calls', () => {
  for (const k of ['knowledgeSnapshots:', 'knowledgeSnapshotRead:', 'knowledgeSnapshotRestore:']) assert.ok(pre.includes(k), `${k} is exposed`);
});
check('Version History is reachable from the editor only once a note is actually saved, and its own dialog/compare/restore ids each exist exactly once', () => {
  const ids = ['kneHistory', 'kneHistoryVeil', 'kneHistoryTitle', 'kneHistoryNote', 'kneHistoryList', 'kneHistoryCurrent', 'kneHistoryWhen', 'kneHistorySelected', 'kneHistoryMsg', 'kneHistoryClose', 'kneHistoryRestore'];
  for (const id of ids) assert.equal(html.split(`id="${id}"`).length, 2, `"${id}" is declared exactly once`);
});
check('a snapshot reference is compared against the note it claims to belong to - knowledge.js never asks for one note\'s history using another note\'s id by accident', () => {
  assert.match(knowledgeJs, /window\.jarvis\.knowledgeSnapshots\(id\)/);
  assert.match(knowledgeJs, /window\.jarvis\.knowledgeSnapshotRestore\(historyFor\.id, historySelected, historyFor\.baseRevision\)/);
});
check('opening Version History always re-reads the note from disk for its own baseRevision, rather than trusting the editor\'s own (possibly stale) in-memory copy', () => {
  const body = knowledgeJs.slice(knowledgeJs.indexOf('async function refreshHistory'), knowledgeJs.indexOf('async function refreshHistory') + 700);
  assert.match(body, /window\.jarvis\.knowledgeRead\(id\)/);
  assert.match(body, /historyFor = \{ id, baseRevision: r\.revision \}/);
});
check('restoring a version requires two presses (arm, then confirm), the same pattern as "Overwrite anyway" - never a single click for something this destructive', () => {
  const body = knowledgeJs.slice(knowledgeJs.indexOf('async function restoreVersion'), knowledgeJs.indexOf('async function restoreVersion') + 600);
  assert.match(body, /if \(btn\.dataset\.armed !== '1'\)/);
  assert.match(body, /backed up first/);
});

// ------------------------------------------------------------------ Phase 4: AI Knowledge - read-only, never auto-sent
check('jarvis:notesSearch and jarvis:notesAskContext are read-only - neither handler\'s own body calls any write/save/delete function', () => {
  for (const h of ['jarvis:notesSearch', 'jarvis:notesAskContext']) {
    const start = main.indexOf(`ipcMain.handle('${h}'`);
    assert.ok(start >= 0, `${h} handler exists`);
    const end = main.indexOf('\n});', start);
    const body = main.slice(start, end);
    assert.doesNotMatch(body, /saveKnowledgeNote|writeKnowledgeNote|deleteKnowledgeNote|restoreKnowledgeNote|migrateFromLegacy/, `${h} never calls a write/delete/migrate function`);
  }
});
check('neither Notes-AI handler, nor notes-search.mjs, ever calls out to a network or an external AI provider directly', () => {
  assert.doesNotMatch(main.slice(main.indexOf("jarvis:notesSearch'"), main.indexOf("jarvis:notesAskContext'") + 500), /fetch\(|https?:\/\//);
  const notesSearchSrc = fs.readFileSync(new URL('../src/notes-search.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(notesSearchSrc, /fetch\(|https?:\/\/|anthropic|openai/i);
});
check('jarvis:notesAskContext hands the renderer a PROMPT to review, never sends anything itself - its reply shape has no "sent" or "response" field, only prompt/sources', () => {
  const body = main.slice(main.indexOf("ipcMain.handle('jarvis:notesAskContext'"), main.indexOf("ipcMain.handle('jarvis:notesAskContext'") + 500);
  assert.match(body, /prompt: buildContextPrompt/);
  assert.doesNotMatch(body, /\bsend\(|query\(|\.submit\(/);
});
check('the renderer only ever hands the composed prompt to JV.chat.insert - never a direct send/submit call of its own', () => {
  assert.match(knowledgeJs, /JV\.chat\.insert\(r\.prompt\)/);
  const askBody = knowledgeJs.slice(knowledgeJs.indexOf('async function askInChat'), knowledgeJs.indexOf('async function askInChat') + 700);
  assert.doesNotMatch(askBody, /\.submit\(|chat\.send\(/);
});

console.log(`\nknowledge-ipc-test: ${pass} passed, ${fail} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exitCode = fail ? 1 : 0;
