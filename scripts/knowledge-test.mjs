// JARVIS Knowledge - Phase 23B (the storage engine, src/knowledge.mjs, and migration from the
// legacy notes.json) and Phase 23C (the editor IPC surface: validateNoteInput, saveKnowledgeNote,
// noteRevision - still part of this same file, still electron-free). Temp folders only - nothing
// here reads or writes a real user's data, and this file never imports or touches anything
// under %APPDATA%\JARVIS. The editor's own wiring (main.mjs, preload.cjs, index.html,
// knowledge.js) is covered separately by scripts/knowledge-ipc-test.mjs.
//   node scripts/knowledge-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SCHEMA_VERSION, newId, parseNoteFile, renderNoteFile, knowledgePaths,
  listKnowledgeNotes, readKnowledgeNote, writeKnowledgeNote, migrateFromLegacy, migrationComplete,
} from '../src/knowledge.mjs';
import { NoteStore } from '../src/notes.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${extra ? `\n     ${extra}` : ''}`); } };
const check = async (name, fn) => { try { await fn(); ok(true, name); } catch (e) { ok(false, name, String(e?.stack || e).split('\n').slice(0, 5).join('\n     ')); } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-knowledge-'));
let n = 0;
const dir = () => { const d = path.join(TMP, `d${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
const note = (over = {}) => ({ id: newId(), title: null, created: 1000, updated: 2000, tags: [], favorite: false, folder: null, project: null, session: null, branch: null, sentAt: null, body: 'Hello.', ...over });

// ------------------------------------------------------------------ never touches a real user's data
await check('src/knowledge.mjs itself is still electron-free - every path still comes from the caller\'s userDir, never app.getPath(\'userData\') or the home directory, even now that main.mjs wires it in', async () => {
  const src = (f) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
  assert.doesNotMatch(src('knowledge.mjs'), /app\.getPath|os\.homedir|require\('electron'\)|from 'electron'/);
});

// ------------------------------------------------------------------ front matter: parse and render
await check('a note renders with a stable, deterministic shape and parses back to the same fields', async () => {
  const n1 = note({ title: 'Shopping list', tags: ['home', 'errands'], favorite: true, folder: 'Personal/Errands', body: '- [ ] Milk\n- [ ] Bread' });
  const text = renderNoteFile(n1);
  assert.match(text, /^---\nid: /);
  assert.match(text, /title: Shopping list/);
  assert.match(text, /tags: \[home, errands\]/);
  assert.match(text, /favorite: true/);
  assert.match(text, /folder: Personal\/Errands/);
  assert.ok(text.endsWith('- [ ] Milk\n- [ ] Bread\n'));
  const p = parseNoteFile(text);
  assert.equal(p.fields.id, n1.id);
  assert.equal(p.fields.title, 'Shopping list');
  assert.deepEqual(p.fields.tags, ['home', 'errands']);
  assert.equal(p.fields.favorite, true);
  assert.equal(p.fields.folder, 'Personal/Errands');
  assert.equal(p.body, '- [ ] Milk\n- [ ] Bread');
  assert.deepEqual(p.problems, []);
  // Rendering twice from the same fields produces byte-identical output - this is what lets
  // migration tell "already done, matches exactly" apart from "something else is here" later.
  assert.equal(renderNoteFile(n1), text);
});

await check('titles, tags and bodies with quotes, colons and unicode round-trip exactly', async () => {
  const n1 = note({ title: 'Say "hi": a café note', tags: ['a,b', 'needs: care'], body: 'Line one — "quoted" and colons: like this.\n\nCafé ☕ 日本語.' });
  const text = renderNoteFile(n1);
  const p = parseNoteFile(text);
  assert.equal(p.fields.title, n1.title);
  assert.deepEqual(p.fields.tags, n1.tags, 'a tag containing a literal comma is quoted, so it still round-trips as one tag');
  assert.equal(p.body, n1.body);
});

await check('empty/absent optional fields are left out of the file entirely, not written as blanks', async () => {
  const text = renderNoteFile(note({ title: null, tags: [], favorite: false, folder: null, project: null, session: null, branch: null, sentAt: null }));
  for (const k of ['title', 'tags', 'favorite', 'folder', 'project', 'session', 'branch', 'sentAt']) assert.doesNotMatch(text, new RegExp(`^${k}:`, 'm'), k);
  assert.match(text, /^id: /m);
  assert.match(text, /^created: 1000$/m);
  assert.match(text, /^updated: 2000$/m);
});

await check('a file with no front matter is still readable: the whole file becomes the body, flagged, never thrown', async () => {
  const p = parseNoteFile('Just some text\nI wrote by hand.\n', { fallbackId: 'hand-written' });
  assert.equal(p.hasFrontMatter, false);
  assert.equal(p.fields.id, 'hand-written');
  assert.equal(p.body, 'Just some text\nI wrote by hand.\n');
  assert.match(p.problems[0], /No front matter/);
});

await check('front matter that never closes is recovered the same safe way, not thrown', async () => {
  const p = parseNoteFile('---\nid: x\ntitle: Oops, no closing marker\nmore text\n', { fallbackId: 'x' });
  assert.equal(p.hasFrontMatter, false);
  assert.match(p.problems[0], /never closed/);
  assert.ok(p.body.length > 0);
});

await check('an id in the body cannot inject a second front-matter block or a key JARVIS does not manage', async () => {
  const text = renderNoteFile(note({ title: 'x\n---\nfavorite: true', body: 'y' }));
  const p = parseNoteFile(text);
  assert.equal(p.fields.title, 'x\n---\nfavorite: true');
  assert.deepEqual(p.otherKeys, []);
});

await check('unknown front-matter keys survive a rewrite byte-for-byte, in their original position - nothing JARVIS does not manage is ever discarded', async () => {
  const original = '---\r\nid: keep-me\r\ntitle: Old title\r\n# a note to self\r\nsource: imported-from-elsewhere\r\ncustomField:\r\n  nested: true\r\n---\r\n\r\nOriginal body.\r\n';
  const p = parseNoteFile(original);
  assert.deepEqual(p.otherKeys, ['source', 'customField']);
  const after = renderNoteFile({ ...note(), id: 'keep-me', title: 'New title', body: 'New body.' }, p);
  for (const kept of ['source: imported-from-elsewhere', 'customField:\r\n  nested: true']) assert.ok(after.includes(kept), kept);
  assert.ok(after.includes('title: New title') && !after.includes('Old title') && after.endsWith('\r\n\r\nNew body.\r\n'));
  const reparsed = parseNoteFile(after);
  assert.deepEqual(reparsed.otherKeys, ['source', 'customField']);
});

await check('CRLF files stay CRLF, LF files stay LF', async () => {
  assert.equal(parseNoteFile('---\r\nid: a\r\n---\r\n\r\nx\r\n').eol, '\r\n');
  assert.equal(parseNoteFile('---\nid: a\n---\n\nx\n').eol, '\n');
  assert.ok(renderNoteFile(note({ id: 'a' })).includes('\n') && !renderNoteFile(note({ id: 'a' })).includes('\r\n'));
});

// ------------------------------------------------------------------ listing: resilience
await check('a folder that does not exist yet reads as zero notes, not an error - a fresh install has nothing to list', async () => {
  const r = listKnowledgeNotes(path.join(dir(), 'never-created'));
  assert.deepEqual(r, { ok: true, notes: [], error: null });
});

await check('valid notes are listed, newest updated first', async () => {
  const d = dir();
  assert.equal(writeKnowledgeNote(d, note({ id: 'older', updated: 1000 })).ok, true);
  assert.equal(writeKnowledgeNote(d, note({ id: 'newer', updated: 9000 })).ok, true);
  const r = listKnowledgeNotes(d);
  assert.equal(r.ok, true);
  assert.deepEqual(r.notes.map((x) => x.id), ['newer', 'older']);
});

await check('one corrupted note cannot make any other note inaccessible', async () => {
  const d = dir();
  const { notesDir } = knowledgePaths(d);
  fs.mkdirSync(notesDir, { recursive: true });
  assert.equal(writeKnowledgeNote(d, note({ id: 'good-one', body: 'I am fine.' })).ok, true);
  fs.writeFileSync(path.join(notesDir, 'bad-one.md'), '---\nid: bad-one\ntitle: [unterminated\n---\n\nstill has a body though\n');
  fs.writeFileSync(path.join(notesDir, 'no-front-matter.md'), 'just raw text, never touched by this module\n');
  const r = listKnowledgeNotes(d);
  assert.equal(r.ok, true);
  const good = r.notes.find((x) => x.id === 'good-one');
  assert.ok(good && !good.corrupt && good.body === 'I am fine.');
  const raw = r.notes.find((x) => x.id === 'no-front-matter');
  assert.ok(raw && raw.corrupt && raw.body.includes('just raw text'), 'still readable, just flagged');
  assert.equal(r.notes.length, 3, 'every file is listed - nothing silently dropped');
});

await check('a permission failure reading one file does not stop the others from listing', async () => {
  const d = dir();
  assert.equal(writeKnowledgeNote(d, note({ id: 'readable' })).ok, true);
  assert.equal(writeKnowledgeNote(d, note({ id: 'unreadable' })).ok, true);
  const real = fs;
  const fsImpl = { ...real, readFileSync: (p, enc) => { if (String(p).includes('unreadable')) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; } return real.readFileSync(p, enc); } };
  const r = listKnowledgeNotes(d, { fsImpl });
  assert.equal(r.ok, true);
  assert.equal(r.notes.find((x) => x.id === 'readable').readable, true);
  const broken = r.notes.find((x) => x.file === 'unreadable.md');
  assert.equal(broken.readable, false);
  assert.match(broken.error, /EACCES/);
});

await check('a filename that disagrees with the declared id is flagged, and the declared id - not the filename - is the identity', async () => {
  const d = dir();
  const { notesDir } = knowledgePaths(d);
  fs.mkdirSync(notesDir, { recursive: true });
  fs.writeFileSync(path.join(notesDir, 'filename-says-a.md'), '---\nid: actually-b\ntitle: Moved or renamed by hand\n---\n\nbody\n');
  const r = listKnowledgeNotes(d);
  const n1 = r.notes[0];
  assert.equal(n1.id, 'actually-b', 'identity comes from the front matter, never the filename');
  assert.equal(n1.idMismatch, true);
  const byId = readKnowledgeNote(d, 'actually-b');
  assert.ok(byId && byId.title === 'Moved or renamed by hand');
});

// ------------------------------------------------------------------ writing: atomicity and no silent overwrite
await check('writing is atomic: no temp file is left behind, and the file either has the old content or the new, never half of either', async () => {
  const d = dir();
  const r1 = writeKnowledgeNote(d, note({ id: 'x', body: 'first' }));
  assert.equal(r1.ok, true);
  const r2 = writeKnowledgeNote(d, { ...note({ id: 'x', body: 'second' }) }, { force: true });
  assert.equal(r2.ok, true);
  const { notesDir } = knowledgePaths(d);
  assert.deepEqual(fs.readdirSync(notesDir), ['x.md'], 'no .tmp file left behind');
  assert.match(fs.readFileSync(path.join(notesDir, 'x.md'), 'utf8'), /second/);
});

await check('writing the same content twice is a no-op - reported as unchanged, not rewritten', async () => {
  const d = dir();
  const n1 = note({ id: 'same' });
  assert.equal(writeKnowledgeNote(d, n1).ok, true);
  const before = fs.statSync(path.join(knowledgePaths(d).notesDir, 'same.md')).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  const r2 = writeKnowledgeNote(d, n1);
  assert.deepEqual(r2, { ok: true, unchanged: true, file: 'same.md' });
  assert.equal(fs.statSync(path.join(knowledgePaths(d).notesDir, 'same.md')).mtimeMs, before, 'the file was not touched again');
});

await check('a file that already exists with DIFFERENT content is never silently overwritten', async () => {
  const d = dir();
  const { notesDir } = knowledgePaths(d);
  fs.mkdirSync(notesDir, { recursive: true });
  fs.writeFileSync(path.join(notesDir, 'taken.md'), '---\nid: taken\ntitle: Someone else wrote this\n---\n\noriginal\n');
  const r = writeKnowledgeNote(d, note({ id: 'taken', body: 'overwrite attempt' }));
  assert.equal(r.ok, false);
  assert.equal(r.conflict, true);
  assert.match(fs.readFileSync(path.join(notesDir, 'taken.md'), 'utf8'), /original/, 'untouched');
  // force: true is the only way past it, and it is never used by migrateFromLegacy.
  const r2 = writeKnowledgeNote(d, note({ id: 'taken', body: 'overwrite attempt' }), { force: true });
  assert.equal(r2.ok, true);
});

await check('an id that is not a safe filename, or tries to escape the notes folder, is refused', async () => {
  const d = dir();
  for (const bad of ['../escape', 'a/b', 'a\\b', '', '.', '..', 'con', 'a'.repeat(100)]) {
    const r = writeKnowledgeNote(d, note({ id: bad }));
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
});

await check('a write that fails partway (permission denied) leaves nothing behind and is reported plainly', async () => {
  const d = dir();
  const real = fs;
  const fsImpl = { ...real, writeFileSync: (p, data) => { if (String(p).endsWith('.tmp')) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; } return real.writeFileSync(p, data); } };
  const r = writeKnowledgeNote(d, note({ id: 'blocked' }), { fsImpl });
  assert.equal(r.ok, false);
  assert.match(r.error, /EACCES/);
  assert.equal(fs.existsSync(path.join(knowledgePaths(d).notesDir, 'blocked.md')), false);
  assert.deepEqual(fs.readdirSync(knowledgePaths(d).notesDir).filter((f) => f.includes('.tmp')), [], 'no leftover temp file');
});

// ------------------------------------------------------------------ migration: the legacy store is never touched
function legacyWorld() {
  const d = dir();
  return { d, legacyFile: path.join(d, 'notes.json') };
}
const putLegacy = (d, notes) => fs.writeFileSync(path.join(d, 'notes.json'), JSON.stringify(notes, null, 2));

await check('no notes.json at all: migration succeeds, creates nothing destructive, marks itself done', async () => {
  const { d } = legacyWorld();
  const r = migrateFromLegacy(d);
  assert.deepEqual(r, { ok: true, reason: 'no-legacy-file', migrated: 0, skipped: 0, conflicts: [], errors: [], total: 0, warning: null });
  assert.equal(fs.existsSync(path.join(d, 'notes.json')), false);
  assert.equal(migrationComplete(d), true);
});

await check('an empty legacy store (zero notes) migrates cleanly to zero files, and is backed up anyway', async () => {
  const { d } = legacyWorld();
  putLegacy(d, []);
  const r = migrateFromLegacy(d);
  assert.equal(r.ok, true);
  assert.equal(r.total, 0);
  assert.equal(fs.existsSync(knowledgePaths(d).backupFile), true);
  assert.deepEqual(listKnowledgeNotes(d).notes, []);
});

await check('valid notes: every one migrates, content and identity preserved exactly, legacy file untouched', async () => {
  const { d } = legacyWorld();
  const store = new NoteStore(d);
  const a = store.save({ text: '# Shopping\nmilk\nbread — "fresh"\ncafé ☕' });
  const b = store.save({ text: 'Second note\nwith multiple\nlines' });
  store.markSent(a.note.id, 1700000000000);
  const beforeBytes = fs.readFileSync(path.join(d, 'notes.json'));

  const r = migrateFromLegacy(d);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.total, 2);
  assert.equal(r.migrated, 2);
  assert.equal(r.skipped, 0);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.errors, []);

  // The legacy file itself: byte-identical to before. Never moved, renamed or edited.
  assert.ok(Buffer.compare(fs.readFileSync(path.join(d, 'notes.json')), beforeBytes) === 0);
  // The backup: also byte-identical.
  assert.ok(Buffer.compare(fs.readFileSync(knowledgePaths(d).backupFile), beforeBytes) === 0);

  const migrated = listKnowledgeNotes(d).notes;
  assert.equal(migrated.length, 2);
  const ma = migrated.find((x) => x.id === a.note.id);
  assert.equal(ma.body, a.note.text);
  assert.equal(ma.created, a.note.created);
  assert.equal(ma.updated, a.note.updated);
  assert.equal(ma.sentAt, 1700000000000);
  const mb = migrated.find((x) => x.id === b.note.id);
  assert.equal(mb.body, b.note.text);
  assert.equal(mb.sentAt, null);
  assert.equal(migrationComplete(d), true);
});

await check('a corrupt notes.json is still backed up faithfully, migrates to zero notes, and says why - never treated as "nothing to worry about" silently', async () => {
  const { d } = legacyWorld();
  fs.writeFileSync(path.join(d, 'notes.json'), '{ this is not valid json at all');
  const r = migrateFromLegacy(d);
  assert.equal(r.ok, true, 'a source with nothing parseable in it is a safe, complete (empty) migration');
  assert.equal(r.total, 0);
  assert.match(r.warning, /not valid JSON/);
  assert.equal(fs.readFileSync(knowledgePaths(d).backupFile, 'utf8'), '{ this is not valid json at all', 'backed up exactly as it was, corrupt or not');
});

await check('junk entries mixed with good ones: the good ones migrate, nothing throws', async () => {
  const { d } = legacyWorld();
  fs.writeFileSync(path.join(d, 'notes.json'), JSON.stringify([{ id: 'good', text: 'kept', created: 1, updated: 1 }, { nope: 1 }, 'junk', null]));
  const r = migrateFromLegacy(d);
  assert.equal(r.ok, true);
  assert.equal(r.total, 1);
  assert.equal(r.migrated, 1);
  assert.equal(readKnowledgeNote(d, 'good').body, 'kept');
});

await check('duplicate ids inside notes.json are reported as a conflict, not silently merged or overwritten', async () => {
  const { d } = legacyWorld();
  fs.writeFileSync(path.join(d, 'notes.json'), JSON.stringify([{ id: 'dupe', text: 'first copy', created: 1, updated: 2 }, { id: 'dupe', text: 'second copy', created: 1, updated: 1 }]));
  const r = migrateFromLegacy(d);
  assert.equal(r.ok, false);
  assert.equal(r.conflicts.length, 1);
  assert.match(r.conflicts[0].reason, /duplicate/);
  assert.equal(migrationComplete(d), false);
});

await check('a target file that already exists with different content is a conflict, reported, and does not stop the rest of the migration', async () => {
  const { d } = legacyWorld();
  const store = new NoteStore(d);
  const clash = store.save({ text: 'the legacy version' });
  const fine = store.save({ text: 'this one is new' });
  const { notesDir } = knowledgePaths(d);
  fs.mkdirSync(notesDir, { recursive: true });
  fs.writeFileSync(path.join(notesDir, `${clash.note.id}.md`), '---\nid: ' + clash.note.id + '\ntitle: Already here, written by someone else\n---\n\nnot the legacy text\n');

  const r = migrateFromLegacy(d);
  assert.equal(r.ok, false);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].id, clash.note.id);
  assert.equal(r.migrated, 1, 'the other note still migrated');
  assert.match(fs.readFileSync(path.join(notesDir, `${clash.note.id}.md`), 'utf8'), /Already here/, 'the pre-existing file was never touched');
  assert.equal(readKnowledgeNote(d, fine.note.id).body, 'this one is new');
  assert.equal(migrationComplete(d), false, 'not marked complete while a conflict remains');
});

await check('an interrupted migration (a write fails partway) can be safely resumed: nothing is lost, nothing is duplicated', async () => {
  const { d } = legacyWorld();
  const store = new NoteStore(d);
  const notes = [store.save({ text: 'alpha' }), store.save({ text: 'beta' }), store.save({ text: 'gamma' })];
  const beforeBytes = fs.readFileSync(path.join(d, 'notes.json'));

  const real = fs;
  let calls = 0;
  const failing = { ...real, renameSync: (from, to) => { if (String(to).includes(notes[1].note.id)) { calls += 1; const e = new Error('simulated crash mid-write'); e.code = 'EIO'; throw e; } return real.renameSync(from, to); } };
  const r1 = migrateFromLegacy(d, { fsImpl: failing });
  assert.equal(r1.ok, false);
  assert.equal(r1.migrated, 2, 'alpha and gamma got through');
  assert.equal(r1.errors.length, 1);
  assert.match(r1.errors[0], new RegExp(notes[1].note.id));
  assert.equal(migrationComplete(d), false);
  assert.ok(Buffer.compare(fs.readFileSync(path.join(d, 'notes.json')), beforeBytes) === 0, 'legacy file untouched by the failure');

  // Resume with a working filesystem: only the missing one is (re)written; the other two are
  // recognised as already done and are not rewritten.
  const beforeAlpha = fs.statSync(path.join(knowledgePaths(d).notesDir, `${notes[0].note.id}.md`)).mtimeMs;
  await new Promise((res) => setTimeout(res, 20));
  const r2 = migrateFromLegacy(d);
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(r2.migrated, 1, 'only beta, which had failed');
  assert.equal(r2.skipped, 2, 'alpha and gamma recognised as already migrated, not rewritten');
  assert.equal(fs.statSync(path.join(knowledgePaths(d).notesDir, `${notes[0].note.id}.md`)).mtimeMs, beforeAlpha, 'alpha really was left alone');
  assert.equal(migrationComplete(d), true);
  for (const x of notes) assert.equal(readKnowledgeNote(d, x.note.id).body, x.note.text);
});

await check('running a fully successful migration again is a true no-op: idempotent, not just non-destructive', async () => {
  const { d } = legacyWorld();
  const store = new NoteStore(d);
  store.save({ text: 'one' });
  store.save({ text: 'two' });
  const r1 = migrateFromLegacy(d);
  assert.equal(r1.ok, true);
  const snapshotBefore = listKnowledgeNotes(d).notes.map((x) => ({ id: x.id, modified: x.modified }));
  await new Promise((r) => setTimeout(r, 20));
  const r2 = migrateFromLegacy(d);
  assert.equal(r2.ok, true);
  assert.equal(r2.migrated, 0);
  assert.equal(r2.skipped, 2);
  const snapshotAfter = listKnowledgeNotes(d).notes.map((x) => ({ id: x.id, modified: x.modified }));
  assert.deepEqual(snapshotAfter, snapshotBefore, 'not one file was rewritten the second time');
});

await check('a backup that cannot be made (permission denied) stops migration before anything else happens, and says why', async () => {
  const { d } = legacyWorld();
  putLegacy(d, [{ id: 'a', text: 'x', created: 1, updated: 1 }]);
  const real = fs;
  const fsImpl = { ...real, writeFileSync: (p, data) => { if (String(p).endsWith('pre-knowledge-backup')) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; } return real.writeFileSync(p, data); } };
  const r = migrateFromLegacy(d, { fsImpl });
  assert.equal(r.ok, false);
  assert.match(r.reason, /verified backup of notes\.json could not be made/);
  assert.equal(fs.existsSync(knowledgePaths(d).backupFile), false);
  assert.equal(fs.existsSync(knowledgePaths(d).notesDir), false, 'migration never got as far as writing any note');
  assert.equal(migrationComplete(d), false);
});

await check('an existing backup is never overwritten by a later migration run, even if notes.json changes afterward', async () => {
  const { d } = legacyWorld();
  const store = new NoteStore(d);
  store.save({ text: 'original' });
  migrateFromLegacy(d);
  const backupBefore = fs.readFileSync(knowledgePaths(d).backupFile, 'utf8');
  store.save({ text: 'added after the first migration' });
  migrateFromLegacy(d);
  assert.equal(fs.readFileSync(knowledgePaths(d).backupFile, 'utf8'), backupBefore, 'the backup is a snapshot of the FIRST migration, intentionally never refreshed silently');
});

await check('legacy notes remain fully recoverable from the backup alone, independent of the new store', async () => {
  const { d } = legacyWorld();
  const store = new NoteStore(d);
  const a = store.save({ text: 'recoverable note' });
  migrateFromLegacy(d);
  // Prove the backup alone (not notes.json, not the new store) can restore the original data.
  const restored = new NoteStore(path.join(d, 'restored-from-backup'));
  fs.mkdirSync(path.dirname(restored.file), { recursive: true });
  fs.copyFileSync(knowledgePaths(d).backupFile, restored.file);
  assert.equal(restored.list().find((n1) => n1.id === a.note.id)?.text, 'recoverable note');
});

// ------------------------------------------------------------------ existing Notes feature: untouched
// Phase 23B kept main.mjs/preload.cjs/index.html at zero diff too, because nothing was wired in
// yet. Phase 23C's whole point is to wire the Knowledge editor into exactly those three files -
// so the guarantee that matters now is narrower, but just as real: notes.mjs and notes.js (the
// legacy store and its own editor) are still byte-for-byte untouched, and - checked separately,
// by text rather than by diff, since these files now legitimately differ from main - nothing
// Notes' own wiring already had in those three files was removed or changed along the way.
await check('src/notes.mjs and src/renderer/notes.js (the legacy store and its own editor) are byte-for-byte unchanged by this phase', async () => {
  const { execFileSync } = await import('node:child_process');
  const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const diff = execFileSync('git', ['diff', 'main', '--', 'src/notes.mjs', 'src/renderer/notes.js'], { cwd: root, encoding: 'utf8' });
  assert.equal(diff.trim(), '', `these files must have zero diff from main in this phase:\n${diff.slice(0, 500)}`);
});
await check('Notes\' own wiring in main.mjs, preload.cjs and index.html is still exactly there, alongside Knowledge\'s new, additive wiring', async () => {
  const src = (f) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
  const main = src('main.mjs');
  const pre = src('preload.cjs');
  const html = src('renderer/index.html');
  assert.match(main, /const notes = new NoteStore\(userDir\);/);
  assert.match(main, /ipcMain\.handle\('jarvis:notes', \(\) => \{/);
  assert.match(main, /ipcMain\.handle\('jarvis:noteSave', async \(_e, note, opts\) => \{/);
  assert.match(main, /ipcMain\.handle\('jarvis:noteDelete', \(_e, id\) => notes\.remove/);
  assert.ok(pre.includes("notes: () => ipcRenderer.invoke('jarvis:notes')"));
  assert.ok(pre.includes("noteSave: (note, opts) => ipcRenderer.invoke('jarvis:noteSave', note, opts)"));
  assert.ok(pre.includes("noteDelete: (id) => ipcRenderer.invoke('jarvis:noteDelete', id)"));
  assert.match(html, /id="navNotes" data-view="notes"/);
  assert.match(html, /id="view-notes"/);
  assert.match(html, /<script src="notes\.js"><\/script>/);
});

await check('the existing Notes regression suite still passes, unmodified, proving nothing about the live feature regressed', async () => {
  const { execFileSync } = await import('node:child_process');
  const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const out = execFileSync('node', ['scripts/notes-test.mjs'], { cwd: root, encoding: 'utf8' });
  assert.match(out, /passed, 0 failed/);
});

ok(SCHEMA_VERSION === 1, 'schema version is tracked, for a future migration to reason about');

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nknowledge-test: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
