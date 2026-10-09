// Source Control, resolving a conflict by taking one side: the file must come out exactly as
// that side has it. A temp repository only - nothing here touches a real one.
//
// Found on 2026-10-08: the chosen side's content went through a string, so "Accept theirs" on
// an image or a Latin-1 file wrote corrupted bytes and staged them; and a side larger than one
// read (8 MB) could not be read at all, was taken for "that side deleted the file", and the
// file was removed. Each time the window said it had worked.
//   node scripts/sc-conflict-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveConflict, conflictDetail, conflictState, sourceRepos } from '../src/git.mjs';

try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { console.log('sc-conflict-test: SKIPPED - git is not installed here'); process.exit(0); }

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${extra ? `\n     ${extra}` : ''}`); } };
const check = async (name, fn) => { try { await fn(); ok(true, name); } catch (e) { ok(false, name, String(e?.message || e).slice(0, 400)); } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-conflict-'));
const ws = path.join(TMP, 'ws');
const repo = path.join(ws, 'repo');
fs.mkdirSync(repo, { recursive: true });
const git = (...a) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'core.autocrlf=false', ...a], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const bytes = (seed, n) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + seed) % 256));
const BIG = 9 * 1024 * 1024; // more than run() reads from git in one go
const write = (name, data) => fs.writeFileSync(path.join(repo, name), data);
const sides = {
  base: { 'logo.bin': bytes(1, 4096), 'latin1.txt': Buffer.from('caf\xe9 base\n', 'latin1'), 'big.bin': bytes(2, BIG), 'plain.txt': Buffer.from('base\n'), 'gone-theirs.txt': Buffer.from('base\n'), 'keep.bin': bytes(3, 2048) },
  theirs: { 'logo.bin': bytes(7, 4096), 'latin1.txt': Buffer.from('caf\xe9 na\xefve THEIRS\n', 'latin1'), 'big.bin': bytes(9, BIG), 'plain.txt': Buffer.from('theirs\n'), 'keep.bin': bytes(8, 2048) },
  ours: { 'logo.bin': bytes(5, 4096), 'latin1.txt': Buffer.from('caf\xe9 na\xefve OURS\n', 'latin1'), 'big.bin': bytes(6, BIG), 'plain.txt': Buffer.from('ours\n'), 'gone-theirs.txt': Buffer.from('ours changed it\n'), 'keep.bin': bytes(4, 2048) },
};
git('init', '-q', '-b', 'main');
for (const [f, d] of Object.entries(sides.base)) write(f, d);
git('add', '.'); git('commit', '-q', '-m', 'base');
git('checkout', '-q', '-b', 'theirs');
for (const [f, d] of Object.entries(sides.theirs)) write(f, d);
git('rm', '-q', 'gone-theirs.txt');
git('commit', '-q', '-am', 'theirs');
git('checkout', '-q', 'main');
for (const [f, d] of Object.entries(sides.ours)) write(f, d);
git('commit', '-q', '-am', 'ours');
try { git('merge', 'theirs'); } catch { /* the conflict is the point */ }

const key = sourceRepos(ws).find((r) => r.key === 'repo')?.key;
const staged = (f) => git('status', '--porcelain', '--', f).trim();
const stagedBytes = (f) => execFileSync('git', ['cat-file', 'blob', `:${f}`], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });

await check('the merge left the conflicts this test is about', async () => {
  const s = await conflictState(ws, key);
  assert.equal(s.ok, true, s.error);
  assert.deepEqual(s.files.map((f) => f.path).sort(), ['big.bin', 'gone-theirs.txt', 'keep.bin', 'latin1.txt', 'logo.bin', 'plain.txt']);
});

for (const [file, what] of [['logo.bin', 'a binary file'], ['latin1.txt', 'a text file that is not UTF-8'], ['plain.txt', 'an ordinary text file']]) {
  await check(`accepting theirs writes ${what} byte for byte, and stages exactly that`, async () => {
    const r = await resolveConflict(ws, key, file, 'theirs');
    assert.equal(r.ok, true, r.error);
    assert.ok(fs.readFileSync(path.join(repo, file)).equals(sides.theirs[file]), 'the working file is theirs');
    assert.ok(stagedBytes(file).equals(sides.theirs[file]), 'and so is what was staged');
  });
}

await check('accepting ours works the same way', async () => {
  const r = await resolveConflict(ws, key, 'keep.bin', 'ours');
  assert.equal(r.ok, true, r.error);
  assert.ok(fs.readFileSync(path.join(repo, 'keep.bin')).equals(sides.ours['keep.bin']));
});

await check('a side too large to show is said to be there - never taken for a deleted one', async () => {
  const d = await conflictDetail(ws, key, 'big.bin');
  assert.equal(d.ok, true, d.error);
  assert.notEqual(d.theirs, null, 'null means "that side does not have the file"');
  assert.match(d.theirs.note, /too large to show/);
});
await check('accepting a file larger than one read keeps the whole file - it is not removed', async () => {
  const r = await resolveConflict(ws, key, 'big.bin', 'theirs');
  assert.equal(r.ok, true, r.error);
  assert.equal(fs.existsSync(path.join(repo, 'big.bin')), true, 'the file is still there');
  assert.ok(fs.readFileSync(path.join(repo, 'big.bin')).equals(sides.theirs['big.bin']), 'all 9 MB of it, as theirs has it');
  assert.equal(staged('big.bin'), 'M  big.bin', 'staged as changed, not as deleted');
});

await check('a side that really did delete the file still removes it when chosen', async () => {
  const d = await conflictDetail(ws, key, 'gone-theirs.txt');
  assert.equal(d.theirs, null);
  const r = await resolveConflict(ws, key, 'gone-theirs.txt', 'theirs');
  assert.equal(r.ok, true, r.error);
  assert.equal(fs.existsSync(path.join(repo, 'gone-theirs.txt')), false);
});

await check('nothing is left behind: no temp file beside a resolved one, and git agrees it is all resolved', async () => {
  assert.deepEqual(fs.readdirSync(repo).filter((f) => f.includes('.tmp')), []);
  assert.deepEqual((await conflictState(ws, key)).files, []);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`sc-conflict-test: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
