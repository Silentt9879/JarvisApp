// JARVIS Notes - Phase 5 Task 4: AI Knowledge security boundary audit. Every check here calls
// the SERVICE/STORAGE functions directly (knowledge.mjs, notes-search.mjs, drive-sync.mjs) -
// never the renderer, never a UI assertion - because the requirement is specifically that
// aiExcluded is enforced at the boundary, not merely hidden by the UI. No network, no AI
// provider, no real Google account.
//   node scripts/ai-security-boundary-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  saveKnowledgeNote, deleteKnowledgeNote, restoreKnowledgeNote, noteRevision,
  listKnowledgeNotes, migrateFromLegacy, markKnowledgeNoteSent, knowledgePaths,
} from '../src/knowledge.mjs';
import { searchNotes, notesForAiContext } from '../src/notes-search.mjs';
import { planSync, applySync } from '../src/drive-sync.mjs';
import { FakeDriveProvider } from './fake-drive-provider.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${extra ? `\n     ${extra}` : ''}`); } };
const check = async (name, fn) => { try { await fn(); ok(true, name); } catch (e) { ok(false, name, String(e?.stack || e).split('\n').slice(0, 6).join('\n     ')); } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ai-security-'));
let n = 0;
const dir = () => { const d = path.join(TMP, `d${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };

const EXCLUDED_TITLE = 'Confidential salary review notes';
const EXCLUDED_BODY = 'Base pay 142000, bonus target 15 percent, confidential until announced.';

// ================================================================== 1. Search queries

console.log('\n--- 1. search queries can never surface an excluded note ---');
await check('an excluded note never appears, even for a query matching it exactly and nothing else', () => {
  const d = dir();
  saveKnowledgeNote(d, 'secret1', { title: EXCLUDED_TITLE, body: EXCLUDED_BODY, tags: ['hr'], favorite: false, folder: null, aiExcluded: true }, {});
  const r = searchNotes(d, 'confidential salary bonus');
  assert.equal(r.results.length, 0, 'the only matching note is excluded, so there must be zero results, not a fallback');
});
await check('searching by the excluded note\'s own tag does not surface it either', () => {
  const d = dir();
  saveKnowledgeNote(d, 'secret1', { title: EXCLUDED_TITLE, body: EXCLUDED_BODY, tags: ['hr-confidential'], favorite: false, folder: null, aiExcluded: true }, {});
  const r = searchNotes(d, 'hr-confidential');
  assert.equal(r.results.length, 0);
});

// ================================================================== 2. Direct note identifiers

console.log('\n--- 2. a note\'s own id cannot be used to pull it into AI context ---');
await check('notesForAiContext has no id-based entry point at all - only a free-text query, which still goes through the same filter', () => {
  const d = dir();
  saveKnowledgeNote(d, 'secret1', { title: EXCLUDED_TITLE, body: EXCLUDED_BODY, tags: [], favorite: false, folder: null, aiExcluded: true }, {});
  // The only thing resembling "ask for this note directly" available to notesForAiContext is
  // passing its own id or title as the query text - even that must not succeed.
  const byId = notesForAiContext(d, 'secret1');
  const byTitle = notesForAiContext(d, EXCLUDED_TITLE);
  assert.equal(byId.ok, false, 'the id string matches nothing (it is not indexed as a token) and finds nothing to offer');
  assert.equal(byTitle.ok, false, 'even quoting the excluded note\'s own title back at it finds nothing usable - it is the only match, and it is excluded');
});

// ================================================================== 3. Chat context generation

console.log('\n--- 3. chat context generation never includes an excluded note\'s content ---');
await check('notesForAiContext\'s sources never contain the excluded note, even mixed in with real matches', () => {
  const d = dir();
  saveKnowledgeNote(d, 'secret1', { title: EXCLUDED_TITLE, body: `${EXCLUDED_BODY} project phoenix`, tags: [], favorite: false, folder: null, aiExcluded: true }, {});
  saveKnowledgeNote(d, 'public1', { title: 'Project Phoenix kickoff notes', body: 'project phoenix kickoff is Monday', tags: [], favorite: false, folder: null }, {});
  const r = notesForAiContext(d, 'project phoenix');
  assert.equal(r.ok, true);
  assert.equal(r.sources.some((s) => s.id === 'secret1'), false, 'the excluded note never enters the source list');
  assert.ok(r.sources.some((s) => s.id === 'public1'), 'the real, non-excluded match still comes through - this is exclusion, not a search engine failure');
});

// ================================================================== 4. Restored or migrated notes

console.log('\n--- 4. exclusion survives Trash, restore, and legacy migration ---');
await check('a note excluded before being trashed is still excluded after being restored - the flag is not reset by the round trip', () => {
  const d = dir();
  saveKnowledgeNote(d, 'secret1', { title: EXCLUDED_TITLE, body: EXCLUDED_BODY, tags: [], favorite: false, folder: null, aiExcluded: true }, {});
  const rev = noteRevision(d, 'secret1');
  const del = deleteKnowledgeNote(d, 'secret1', { baseRevision: rev });
  assert.equal(del.ok, true);
  const res = restoreKnowledgeNote(d, 'secret1');
  assert.equal(res.ok, true);
  assert.equal(res.note.aiExcluded, true, 'the restore IPC itself reports it still excluded');
  const r = searchNotes(d, 'confidential salary bonus');
  assert.equal(r.results.length, 0, 'and the storage layer agrees - still invisible to search after the round trip');
});
await check('marking a note sent to Telegram does not silently clear its exclusion (the bug this phase found and fixed)', () => {
  const d = dir();
  saveKnowledgeNote(d, 'secret1', { title: EXCLUDED_TITLE, body: EXCLUDED_BODY, tags: [], favorite: false, folder: null, aiExcluded: true }, {});
  markKnowledgeNoteSent(d, 'secret1', Date.now());
  const r = searchNotes(d, 'confidential salary bonus');
  assert.equal(r.results.length, 0);
});
await check('a legacy note migrated from Notes (Classic) defaults to INCLUDED (matching favorite\'s own default), never auto-excluded or auto-exempted from the rule either way', () => {
  const d = dir();
  fs.writeFileSync(path.join(d, 'notes.json'), JSON.stringify([{ id: 'legacy1', text: 'Ordinary migrated note about groceries', created: 1, updated: 2, sentAt: null }]));
  migrateFromLegacy(d);
  const r = searchNotes(d, 'groceries');
  assert.equal(r.results.length, 1, 'a migrated note is searchable by default - exclusion is opt-in, not retroactively applied by migration');
});

// ================================================================== 5. IPC-shaped inputs (query text, not a trusted field)

console.log('\n--- 5. no crafted query string can bypass the filter at the service boundary ---');
await check('unusual/adversarial query strings (long, special characters, SQL/NoSQL-flavored, the literal word "aiExcluded") never surface the excluded note', () => {
  const d = dir();
  saveKnowledgeNote(d, 'secret1', { title: EXCLUDED_TITLE, body: `${EXCLUDED_BODY} aiExcluded true`, tags: [], favorite: false, folder: null, aiExcluded: true }, {});
  const attempts = [
    'aiExcluded', 'aiExcluded:false', '{"aiExcluded":false}', 'confidential'.repeat(200),
    "' OR 1=1 --", '<script>confidential</script>', 'confidential salary bonus\u0000',
  ];
  for (const q of attempts) {
    const r = searchNotes(d, q);
    assert.equal(r.results.some((x) => x.id === 'secret1'), false, `query "${q.slice(0, 40)}" must not surface the excluded note`);
  }
});
await check('notesForAiContext never accepts anything other than a plain query string - passing an object/array where a string is expected finds nothing, never throws, never bypasses the filter', () => {
  const d = dir();
  saveKnowledgeNote(d, 'secret1', { title: EXCLUDED_TITLE, body: EXCLUDED_BODY, tags: [], favorite: false, folder: null, aiExcluded: true }, {});
  for (const weird of [{ id: 'secret1' }, ['secret1'], null, undefined, 42]) {
    const r = notesForAiContext(d, weird);
    assert.equal(r.ok, false);
  }
});

// ================================================================== 6. Any other retrieval pathway: sync

console.log('\n--- 6. the AI-exclusion flag itself travels with sync, so a pulled copy is excluded too ---');
await check('a note excluded on device A is still excluded on device B after a normal sync pull', async () => {
  const remote = new FakeDriveProvider();
  const a = dir(); const b = dir();
  saveKnowledgeNote(a, 'secret1', { title: EXCLUDED_TITLE, body: EXCLUDED_BODY, tags: [], favorite: false, folder: null, aiExcluded: true }, {});
  const planA = await planSync(a, remote, {});
  await applySync(a, remote, planA, {});
  const planB = await planSync(b, remote, {});
  await applySync(b, remote, planB, {});
  assert.ok(listKnowledgeNotes(b).notes.some((n) => n.id === 'secret1'), 'the note itself did sync over');
  const r = searchNotes(b, 'confidential salary bonus');
  assert.equal(r.results.length, 0, 'but it is still excluded on the device that just received it - the permission is part of the note\'s own content, not a per-device setting');
});

// ================================================================== 7. The other direction: the user's OWN view of their note is never blocked by this flag

console.log('\n--- 7. aiExcluded only gates AI - it must never hide a note from its own owner ---');
await check('an excluded note still appears in the normal note list and is fully readable - this flag is not a second Trash', () => {
  const d = dir();
  saveKnowledgeNote(d, 'secret1', { title: EXCLUDED_TITLE, body: EXCLUDED_BODY, tags: [], favorite: false, folder: null, aiExcluded: true }, {});
  const list = listKnowledgeNotes(d).notes;
  assert.ok(list.some((n) => n.id === 'secret1' && n.title === EXCLUDED_TITLE && n.body === EXCLUDED_BODY), 'the owner can still see and read their own note in full');
});

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
