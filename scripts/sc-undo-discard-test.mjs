// GitHub Desktop page (formerly "Source Control"), 2026-10-05: Undo the last commit,
// Discard all changes and the "Last fetched" time, against throwaway repositories.
// Real git, no network and no model. The Recycle Bin is replaced by a folder this test owns.
// Run: node scripts/sc-undo-discard-test.mjs
//
// The rules: a workspace's own .claude/jarvis/git-risk-policy.json when it has one
// (src/git-policy.mjs). Set JARVIS_POLICY_FILE to a real one to run against it; without it,
// the throwaway workspace has no policy file and JARVIS's built-in default applies - which is
// what every new user's workspace gets.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  lastCommit, undoLastCommit, discardAll, changedFiles, stageFiles, stageAll, commit, repoDetail,
  deleteBranch, createStash,
} from '../src/git.mjs';
import { classify, policySource } from '../src/git-policy.mjs';

const POLICY = process.env.JARVIS_POLICY_FILE && fs.existsSync(process.env.JARVIS_POLICY_FILE) ? process.env.JARVIS_POLICY_FILE : null;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-sc-undo-'));
const ws = path.join(root, 'ws');
const bin = path.join(root, 'bin');
fs.mkdirSync(path.join(ws, '.claude', 'jarvis'), { recursive: true });
fs.mkdirSync(bin);
if (POLICY) fs.copyFileSync(POLICY, path.join(ws, '.claude', 'jarvis', 'git-risk-policy.json'));
console.log(`sc-undo-discard-test: using ${POLICY ? `the policy in ${POLICY}` : 'JARVIS\'s built-in default policy (no workspace policy file)'}`);

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

function newRepo(name) {
  const dir = path.join(ws, name);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'core.autocrlf', 'false');
  write(dir, 'a.txt', 'one\n');
  write(dir, 'b.txt', 'bee\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

/** Moves a path into the test's own "Recycle Bin". */
const trash = async (p) => { fs.renameSync(p, path.join(bin, path.basename(p))); };

let passed = 0;
const step = async (name, fn) => { await fn(); passed += 1; console.log(`  ok  ${name}`); };

try {
  const dir = newRepo('demo');
  const KEY = 'demo';

  // ------------------------------------------------------------- undo
  await step('the first commit is not undoable', async () => {
    const last = await lastCommit(ws, KEY);
    assert.equal(last.ok, true);
    assert.equal(last.commit.subject, 'first');
    assert.equal(last.undoable, false);
    assert.match(last.reason, /first commit/);
  });

  await step('a second, local commit is undoable and reports its message', async () => {
    write(dir, 'a.txt', 'one\ntwo\n');
    write(dir, 'new/c.txt', 'sea\n');
    await stageAll(ws, KEY);
    const r = await commit(ws, KEY, { summary: 'Add two and c', description: 'Body line one\nBody line two' });
    assert.equal(r.ok, true, r.error);
    const last = await lastCommit(ws, KEY);
    assert.equal(last.undoable, true, last.reason);
    assert.equal(last.commit.subject, 'Add two and c');
    assert.equal(last.commit.body, 'Body line one\nBody line two');
    assert.equal(last.commit.branch, 'main');
    assert.ok(last.commit.at);
  });

  await step('undo refuses a stale panel (a different sha)', async () => {
    const r = await undoLastCommit(ws, KEY, { sha: '0000000' });
    assert.equal(r.ok, false);
    assert.equal(r.stale, true);
    assert.match(git(dir, 'log', '-1', '--format=%s'), /Add two and c/);
  });

  await step('undo moves the branch back and keeps every change staged', async () => {
    const last = await lastCommit(ws, KEY);
    const r = await undoLastCommit(ws, KEY, { sha: last.commit.sha });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.undone.subject, 'Add two and c');
    assert.equal(r.undone.body, 'Body line one\nBody line two');
    assert.equal(git(dir, 'log', '-1', '--format=%s'), 'first');
    assert.equal(read(dir, 'a.txt'), 'one\ntwo\n', 'working tree untouched');
    const staged = r.after.files.filter((f) => f.staged).map((f) => f.path).sort();
    assert.deepEqual(staged, ['a.txt', 'new/c.txt']);
  });

  await step('a pushed commit is not undoable', async () => {
    await commit(ws, KEY, { summary: 'Again' });
    const bare = path.join(root, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', bare]);
    git(dir, 'remote', 'add', 'origin', bare);
    git(dir, 'push', '-q', '-u', 'origin', 'main');
    const last = await lastCommit(ws, KEY);
    assert.equal(last.undoable, false);
    assert.match(last.reason, /already on origin\/main/);
    const r = await undoLastCommit(ws, KEY, { sha: last.commit.sha });
    assert.equal(r.ok, false);
    assert.match(git(dir, 'log', '-1', '--format=%s'), /Again/);
  });

  await step('a commit made after the push is undoable again', async () => {
    write(dir, 'b.txt', 'bee\nbuzz\n');
    await stageFiles(ws, KEY, ['b.txt']);
    await commit(ws, KEY, { summary: 'Local only' });
    const last = await lastCommit(ws, KEY);
    assert.equal(last.undoable, true, last.reason);
  });

  await step('a merge commit is not undoable', async () => {
    git(dir, 'checkout', '-q', '-b', 'side');
    write(dir, 'side.txt', 'side\n');
    git(dir, 'add', 'side.txt');
    git(dir, 'commit', '-q', '-m', 'side work');
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge side', 'side');
    const last = await lastCommit(ws, KEY);
    assert.equal(last.undoable, false);
    assert.match(last.reason, /merge commit/);
  });

  // ------------------------------------------------------------- last fetched
  await step('repoDetail reports when the repository last fetched', async () => {
    const before = await repoDetail(ws, KEY);
    assert.equal(before.ok, true);
    assert.equal(before.lastFetched, null, 'never fetched yet');
    git(dir, 'fetch', '-q', 'origin');
    const after = await repoDetail(ws, KEY);
    assert.equal(typeof after.lastFetched, 'number');
    assert.ok(Date.now() - after.lastFetched < 60000);
  });

  // ------------------------------------------------------------- discard all
  await step('discard on a clean repository says there is nothing to discard', async () => {
    const r = await discardAll(ws, KEY, { confirmed: true, trash });
    assert.equal(r.ok, false);
    assert.match(r.error, /no changes/);
  });

  // A working set with every kind of change: modified (unstaged), modified (staged),
  // a new file staged, and an untracked file in a new folder.
  const makeMess = () => {
    write(dir, 'a.txt', 'edited a\n');
    write(dir, 'b.txt', 'edited b\n');
    git(dir, 'add', 'b.txt');
    write(dir, 'added.txt', 'added and staged\n');
    git(dir, 'add', 'added.txt');
    write(dir, 'fresh/deep/u.txt', 'untracked\n');
  };

  await step('without confirmation, discard only says what it would do', async () => {
    makeMess();
    const r = await discardAll(ws, KEY, { trash });
    assert.equal(r.ok, false);
    assert.equal(r.needsConfirmation, true);
    assert.equal(r.repoLabel, 'demo');
    assert.deepEqual(r.files.map((f) => f.path).sort(), ['a.txt', 'added.txt', 'b.txt', 'fresh/deep/u.txt']);
    assert.match(r.reason, /restore/);
    assert.equal(read(dir, 'a.txt'), 'edited a\n', 'nothing touched');
  });

  await step('a confirmation for a different set of files is refused', async () => {
    const r = await discardAll(ws, KEY, { confirmed: true, trash, expect: ['a.txt'] });
    assert.equal(r.ok, false);
    assert.equal(r.stale, true);
    assert.equal(read(dir, 'a.txt'), 'edited a\n');
  });

  await step('if the Recycle Bin copy fails, nothing is discarded', async () => {
    const listed = (await changedFiles(ws, KEY)).files.map((f) => f.path);
    const r = await discardAll(ws, KEY, { confirmed: true, expect: listed, trash: async () => { throw new Error('bin full'); } });
    assert.equal(r.ok, false);
    assert.match(r.error, /Nothing was discarded/);
    assert.equal(read(dir, 'a.txt'), 'edited a\n');
    assert.ok(fs.existsSync(path.join(dir, 'fresh/deep/u.txt')));
  });

  await step('confirmed discard restores everything and keeps a copy in the bin', async () => {
    const listed = (await changedFiles(ws, KEY)).files.map((f) => f.path);
    const r = await discardAll(ws, KEY, { confirmed: true, expect: listed, trash });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.discarded, 4);
    assert.equal(r.after.counts.total, 0, 'working tree clean');
    assert.equal(read(dir, 'a.txt'), 'one\ntwo\n');
    assert.equal(read(dir, 'b.txt'), 'bee\nbuzz\n');
    assert.ok(!fs.existsSync(path.join(dir, 'added.txt')), 'the staged new file is gone');
    assert.ok(!fs.existsSync(path.join(dir, 'fresh')), 'the new folder is pruned');
    assert.ok(r.backup && r.backup.startsWith('JARVIS discarded changes - demo - '));
    const copy = path.join(bin, r.backup);
    assert.equal(read(copy, 'a.txt'), 'edited a\n');
    assert.equal(read(copy, 'b.txt'), 'edited b\n');
    assert.equal(read(copy, 'added.txt'), 'added and staged\n');
    assert.equal(read(copy, 'fresh/deep/u.txt'), 'untracked\n');
    assert.match(r.message, /Recycle Bin/);
  });

  await step('an unknown repository key is refused', async () => {
    assert.equal((await discardAll(ws, 'nope', { confirmed: true, trash })).ok, false);
    assert.equal((await lastCommit(ws, 'nope')).ok, false);
    assert.equal((await undoLastCommit(ws, 'nope', { sha: 'abc' })).ok, false);
  });

  // ------------------------------------------------------------- the rules themselves
  if (!POLICY) {
    await step('the built-in default: everyday work runs; anything that throws work away asks first', async () => {
      assert.equal(policySource(ws), 'default');
      for (const [sub, args] of [['add', []], ['commit', []], ['switch', []], ['branch', []], ['branch', ['-d']], ['fetch', []], ['pull', []], ['push', []], ['restore', ['--staged']], ['reset', []], ['reset', ['--soft', 'HEAD~1']], ['stash', ['pop']], ['stash', ['apply']]]) {
        assert.notEqual(classify(ws, sub, args).level, 'destructive', `${sub} ${args.join(' ')}`);
      }
      for (const [sub, args] of [['reset', ['--hard']], ['clean', ['-f']], ['restore', ['--worktree', '--', '.']], ['checkout', ['--', 'a.txt']], ['push', ['--force']], ['push', ['--force-with-lease']], ['push', ['--delete']], ['branch', ['-D']], ['stash', ['drop']], ['stash', ['push']], ['commit', ['--amend']], ['rebase', []], ['some-new-command', []]]) {
        assert.equal(classify(ws, sub, args).level, 'destructive', `${sub} ${args.join(' ')}`);
      }
    });
    await step('a forced branch delete and a stash still wait for a person to confirm', async () => {
      git(dir, 'branch', 'scrap');
      const del = await deleteBranch(ws, KEY, 'scrap', { force: true });
      assert.equal(del.needsConfirmation, true);
      write(dir, 'a.txt', 'stash me\n');
      const st = await createStash(ws, KEY, {});
      assert.equal(st.needsConfirmation, true);
      assert.equal(read(dir, 'a.txt'), 'stash me\n', 'nothing was moved');
    });
    await step('a workspace policy file that cannot be read fails closed - it is never swapped for the default', async () => {
      fs.writeFileSync(path.join(ws, '.claude', 'jarvis', 'git-risk-policy.json'), '{ not json');
      assert.equal(policySource(ws), 'unreadable');
      assert.equal(classify(ws, 'add', []).level, 'destructive');
      assert.equal(classify(ws, 'add', []).policyMissing, true);
      fs.rmSync(path.join(ws, '.claude', 'jarvis', 'git-risk-policy.json'));
      assert.equal(classify(ws, 'add', []).level, 'mutate', 'removed again: back to the default');
    });
  }

  console.log(`sc-undo-discard-test: all ${passed} checks passed`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
