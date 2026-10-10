// JARVIS Notes - Phase 4 (AI Knowledge): src/notes-search.mjs - local keyword search and AI
// context retrieval over Notes. No network, no AI provider call anywhere in this file or the
// one it tests; this only proves the ranking, the aiExcluded gate, and the "never a silent
// context dump" rule.
//   node scripts/notes-search-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tokenize, scoreNote, searchNotes, notesForAiContext, buildContextPrompt, MAX_CHARS_PER_NOTE } from '../src/notes-search.mjs';
import { saveKnowledgeNote } from '../src/knowledge.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${extra ? `\n     ${extra}` : ''}`); } };
const check = (name, fn) => { try { fn(); ok(true, name); } catch (e) { ok(false, name, String(e?.stack || e).split('\n').slice(0, 6).join('\n     ')); } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-notes-search-'));
let n = 0;
const dir = () => { const d = path.join(TMP, `d${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };

check('tokenize lowercases, splits on non-letters, drops stopwords and 1-letter tokens', () => {
  assert.deepEqual(tokenize('What is the Recipe for Banana Bread?'), ['recipe', 'banana', 'bread']);
});

check('a note with no matching word at all scores 0', () => {
  const note = { title: 'Shopping list', tags: ['home'], body: 'milk, eggs, bread' };
  assert.equal(scoreNote(note, tokenize('quarterly tax deadline')), 0);
});
check('a title match outweighs a single body occurrence', () => {
  const titleMatch = { title: 'Banana bread recipe', tags: [], body: 'flour sugar eggs' };
  const bodyOnly = { title: 'Shopping', tags: [], body: 'need bananas and bread for the trip' };
  assert.ok(scoreNote(titleMatch, tokenize('banana bread')) > scoreNote(bodyOnly, tokenize('banana bread')));
});

console.log('\n--- search: ranking, exclusion, and never a default dump ---');
check('an empty or stopword-only query returns no results, not every note', () => {
  const d = dir();
  saveKnowledgeNote(d, 'n1', { title: 'T', body: 'anything', tags: [], favorite: false, folder: null }, {});
  assert.deepEqual(searchNotes(d, '').results, []);
  assert.deepEqual(searchNotes(d, 'the a of').results, []);
});
check('a query with no match anywhere returns zero results, never "everything, just in case"', () => {
  const d = dir();
  saveKnowledgeNote(d, 'n1', { title: 'Shopping list', body: 'milk, eggs', tags: [], favorite: false, folder: null }, {});
  const r = searchNotes(d, 'quarterly tax deadline');
  assert.equal(r.ok, true);
  assert.deepEqual(r.results, []);
});
check('a matching note is found, ranked, and returned with a real snippet - its own citation', () => {
  const d = dir();
  saveKnowledgeNote(d, 'n1', { title: 'Banana bread recipe', body: 'Mix flour, sugar, bananas and eggs. Bake for 50 minutes.', tags: ['baking'], favorite: false, folder: null }, {});
  const r = searchNotes(d, 'how do I make banana bread');
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].id, 'n1');
  assert.ok(r.results[0].score > 0);
  assert.match(r.results[0].snippet, /banana/i);
});
check('a note marked aiExcluded never appears in search results, no matter how well it matches', () => {
  const d = dir();
  saveKnowledgeNote(d, 'secret1', { title: 'Private banana bread recipe (family secret)', body: 'banana bread banana bread banana bread', tags: [], favorite: false, folder: null, aiExcluded: true }, {});
  saveKnowledgeNote(d, 'public1', { title: 'Public note', body: 'completely unrelated content about something else entirely', tags: [], favorite: false, folder: null }, {});
  const r = searchNotes(d, 'banana bread');
  assert.equal(r.results.some((x) => x.id === 'secret1'), false, 'the excluded note never appears, even though it is the far better textual match');
  assert.equal(r.results.some((x) => x.id === 'public1'), false, 'and the other note genuinely does not match either - this just proves exclusion, not a false positive');
});
check('a corrupt note is never surfaced either - search only ever returns something readable', () => {
  const d = dir();
  saveKnowledgeNote(d, 'n1', { title: 'Fine note about apples', body: 'apples apples', tags: [], favorite: false, folder: null }, {});
  fs.writeFileSync(path.join(d, 'knowledge', 'notes', 'bad.md'), 'not front matter at all, just apples apples apples');
  const r = searchNotes(d, 'apples');
  assert.ok(!r.results.some((x) => x.id === 'bad'));
});

console.log('\n--- AI context: bounded, cited, never a silent dump ---');
check('notesForAiContext refuses (ok:false) rather than silently falling back when nothing matches', () => {
  const d = dir();
  saveKnowledgeNote(d, 'n1', { title: 'Shopping list', body: 'milk, eggs', tags: [], favorite: false, folder: null }, {});
  const r = notesForAiContext(d, 'quarterly tax filing deadline');
  assert.equal(r.ok, false);
  assert.equal(r.sources, undefined);
});
check('a matching note\'s real content is returned, with its id/title for citation', () => {
  const d = dir();
  saveKnowledgeNote(d, 'n1', { title: 'Vet appointment notes', body: 'The vet said to switch food gradually over two weeks.', tags: [], favorite: false, folder: null }, {});
  const r = notesForAiContext(d, 'what did the vet say about food');
  assert.equal(r.ok, true);
  assert.equal(r.sources.length, 1);
  assert.equal(r.sources[0].id, 'n1');
  assert.match(r.sources[0].body, /gradually/);
});
check('context is capped at MAX_CONTEXT_NOTES, never every matching note in a large notebook', () => {
  const d = dir();
  for (let i = 0; i < 12; i += 1) saveKnowledgeNote(d, `note${i}`, { title: `Coffee note ${i}`, body: 'coffee coffee coffee', tags: [], favorite: false, folder: null }, {});
  const r = notesForAiContext(d, 'coffee');
  assert.equal(r.ok, true);
  assert.ok(r.sources.length <= 5, `expected at most 5, got ${r.sources.length}`);
});
check('an aiExcluded note is never included in AI context either, even as the only match', () => {
  const d = dir();
  saveKnowledgeNote(d, 'n1', { title: 'Private medical note', body: 'diagnosis details here', tags: [], favorite: false, folder: null, aiExcluded: true }, {});
  const r = notesForAiContext(d, 'diagnosis');
  assert.equal(r.ok, false, 'the only match is excluded, so there is nothing left to offer - never a fallback that includes it anyway');
});
check('a very long note is truncated before being handed to any AI context, never sent in full unbounded', () => {
  const d = dir();
  saveKnowledgeNote(d, 'n1', { title: 'Long note', body: `start marker ${'x'.repeat(10000)}`, tags: [], favorite: false, folder: null }, {});
  const r = notesForAiContext(d, 'marker');
  assert.equal(r.ok, true);
  assert.ok(r.sources[0].body.length <= MAX_CHARS_PER_NOTE + 1);
  assert.equal(r.sources[0].truncated, true);
});

console.log('\n--- the composed prompt: explicit, cited, never pretending to be the user\'s own words ---');
check('buildContextPrompt numbers and titles each source, and includes the question verbatim', () => {
  const prompt = buildContextPrompt('what did the vet say', [{ title: 'Vet notes', folder: null, body: 'switch food gradually' }]);
  assert.match(prompt, /what did the vet say/);
  assert.match(prompt, /\[1\] Vet notes/);
  assert.match(prompt, /switch food gradually/);
  assert.match(prompt, /cite which note/i);
});

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
