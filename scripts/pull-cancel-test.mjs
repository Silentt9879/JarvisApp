// Behavioral test for the "can a cancelled pull leave the repository incomplete?" safeguard
// in src/git.mjs: `git pull` is a fetch followed by a merge or rebase in the SAME process, so
// stopping it (power-down, or Stop pressed by hand) can land after the merge/rebase has
// already begun - leaving MERGE_HEAD (or a rebase) in progress, same as an ordinary
// conflicted pull. Nothing here resets, aborts or finishes that state; it is only reported.
//
// interruptedPullMessage() is pure and tested directly (no race needed for the wording).
// Separately, a REAL local git repo is pushed into a genuine mid-merge-with-conflicts state
// (a real conflicting `git merge`, not a race against a kill) to prove conflictState() - the
// primitive the safeguard depends on - correctly recognizes exactly that state. Nothing here
// touches a real remote or a real repository of the user's.
//   node scripts/pull-cancel-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { interruptedPullMessage, conflictState } from '../src/git.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${extra ? `\n     ${extra}` : ''}`); } };
const check = async (name, fn) => { try { await fn(); ok(true, name); } catch (e) { ok(false, name, String(e.stack || e).slice(0, 400)); } };

// ------------------------------------------------------------------ interruptedPullMessage() - pure
await check('nothing left mid-operation: null - an ordinary cancelled fetch, nothing to say beyond "stopped"', () => {
  assert.equal(interruptedPullMessage({ ok: true, operation: null }), null);
  assert.equal(interruptedPullMessage({ ok: false }), null, 'conflictState() itself failing is not treated as "something was left behind"');
  assert.equal(interruptedPullMessage(null), null);
  assert.equal(interruptedPullMessage(undefined), null);
});
await check('a merge left in progress: named as "merging", with the conflict count, pointed at Conflicts', () => {
  const msg = interruptedPullMessage({ ok: true, operation: 'merge', count: 2 });
  assert.match(msg, /started merging/);
  assert.doesNotMatch(msg, /mergeing/, 'no mangled verb');
  assert.match(msg, /unfinished merge with 2 conflicted files/);
  assert.match(msg, /Conflicts tab/);
  assert.match(msg, /will not do either of those on its own/);
});
await check('a rebase left in progress: named as "rebasing", singular wording for exactly one file', () => {
  const msg = interruptedPullMessage({ ok: true, operation: 'rebase', count: 1 });
  assert.match(msg, /started rebasing/);
  assert.doesNotMatch(msg, /rebasinging/, 'no double-suffixed verb');
  assert.match(msg, /unfinished rebase with 1 conflicted file\b/);
  assert.doesNotMatch(msg, /1 conflicted files/);
});
await check('no conflicted files counted (merge/rebase in progress but nothing currently conflicted): still said, without a stray "with 0"', () => {
  const msg = interruptedPullMessage({ ok: true, operation: 'merge', count: 0 });
  assert.match(msg, /unfinished merge\. /);
  assert.doesNotMatch(msg, /with 0/);
});
await check('cherry-pick and revert (not reachable from a plain pull today, but conflictState() can report them) still read correctly, not "operationing"', () => {
  assert.match(interruptedPullMessage({ ok: true, operation: 'cherry-pick', count: 1 }), /started cherry-picking/);
  assert.match(interruptedPullMessage({ ok: true, operation: 'revert', count: 1 }), /started reverting/);
});

// ------------------------------------------------------------------ conflictState(): the real primitive, on a genuine conflict
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-pull-cancel-'));
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

await check('conflictState(): a genuine conflicting merge in progress is recognized as "merge", with the conflicted file listed - exactly what a cancelled pull could leave behind', async () => {
  const dir = fs.mkdtempSync(path.join(WS, 'repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'a@b.c');
  git(dir, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'branch', 'other');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'main side\n');
  git(dir, 'commit', '-aq', '-m', 'main side');
  git(dir, 'checkout', '-q', 'other');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'other side\n');
  git(dir, 'commit', '-aq', '-m', 'other side');
  git(dir, 'checkout', '-q', 'main');
  // A real conflicting merge, left exactly where `git pull` would leave it if stopped right
  // after the merge step began and conflicted - not a race, the real thing.
  try { git(dir, 'merge', 'other'); } catch { /* exits non-zero on conflict - expected */ }
  assert.equal(fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD')), true, 'the fixture really is mid-merge');

  const state = await conflictState(dir, '.');
  assert.equal(state.ok, true);
  assert.equal(state.operation, 'merge');
  assert.equal(state.count, 1);
  assert.equal(state.files[0].path, 'f.txt');

  const msg = interruptedPullMessage(state);
  assert.match(msg, /started merging - this repository now has an unfinished merge with 1 conflicted file\b/);
});
await check('conflictState(): an ordinary repository with nothing in progress reports no operation at all', async () => {
  const dir = fs.mkdtempSync(path.join(WS, 'clean-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'a@b.c');
  git(dir, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'x\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  const state = await conflictState(dir, '.');
  assert.equal(state.operation, null);
  assert.equal(interruptedPullMessage(state), null, 'and so pullRemote would not add anything to an ordinary cancelled-fetch message');
});

// ------------------------------------------------------------------ wiring: pullRemote() actually uses both
await check('wiring: pullRemote() checks what was left behind only on a genuine cancellation, and uses the real primitives, not a re-implementation', () => {
  const src = fs.readFileSync(new URL('../src/git.mjs', import.meta.url), 'utf8');
  const start = src.indexOf('export async function pullRemote');
  const end = src.indexOf('export async function pushRemote');
  assert.ok(start > 0 && end > start, 'pullRemote() was found, before pushRemote()');
  const body = src.slice(start, end);
  assert.match(body, /if \(r\.cancelled\) \{[\s\S]{0,800}const left = await conflictState\(cwd, key\);[\s\S]{0,100}const msg = interruptedPullMessage\(left\);[\s\S]{0,100}if \(msg\) \{ f\.interruptedMerge = left\.operation; f\.error = msg; \}/);
  // Never resets, aborts, stashes or forces anything - only reads and reports.
  assert.doesNotMatch(body, /'reset'|'stash'|'--abort'|'--force'|'clean'/, 'no automatic git reset/stash/discard/force anywhere in pullRemote()');
});

fs.rmSync(WS, { recursive: true, force: true });
console.log(`pull-cancel-test: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
