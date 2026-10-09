// Source Control - the git layer behind the desktop app's own git interface.
//
// PHASE 1: discovery, selection and status. Nothing here mutates a repository.
//
// Three rules this module exists to keep:
//
//   1. NO AMBIGUOUS REPOSITORY. Nothing holds a "current repo". Every call names a repo by
//      key, and the key is resolved to an absolute directory from the live discovered list
//      on every single call. A key that does not resolve is refused, never guessed. That
//      is what makes it impossible for a click to land on the repository you just left.
//
//   2. NO DUPLICATED LOGIC. Discovery and status come from workspace.mjs - `listRepos`,
//      `repoStateAt` and `run`, the same code the Workspace view uses. If the two ever
//      disagreed about a branch or a count, one of them would be lying.
//
//   3. NO MODEL TOKENS. Everything here is `git` through execFile. Source Control shows a
//      status without Claude being involved at all, and keeps working if the AI backend is
//      offline. Intelligence arrives later, per action, by explicit request.
//
// Cancellation is not implemented: `run()` discards the child handle. Phase 1 issues only
// short local reads, so nothing yet needs it. The first long-running operation - a fetch
// or a push over a slow link, in Phase 5 - is where it has to be added, to run() rather
// than here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { listRepos, repoStateAt, run, killTree, repoFolderName, repoDisplayName } from './workspace.mjs';
import { classify } from './git-policy.mjs';
import { measure, budgetFor } from './gitai.mjs';

const APP_KEY = '@app';

const isRepo = (dir) => { try { return fs.existsSync(path.join(dir, '.git')); } catch { return false; } };

/**
 * The app's own repository root, found by walking up from this file.
 *
 * In development that is one step: `src/git.mjs` sits in the checkout. In a packaged
 * build this file lives inside `resources/app.asar`, several levels below the checkout -
 * so the naive two-dirname guess pointed at the asar and the app's repository silently
 * vanished from the list. Walking up until a `.git` appears handles both, and finds
 * nothing at all when the app is installed somewhere separate from its source, which is
 * the right answer there.
 */
function appRepoRoot() {
  let dir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  for (let i = 0; i < 6; i += 1) {
    if (isRepo(dir)) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * Every repository Source Control can act on, discovered, never hardcoded.
 *
 * `listRepos` finds them by looking for `.git`: the workspace itself (key "."), each child
 * folder, and repositories one level inside a plain grouping folder. A key is the path
 * relative to the workspace. The app's own repository may sit outside the workspace, so it
 * is discovered separately, by asking whether APP_ROOT is a repo (in a development run).
 */
export function sourceRepos(cwd) {
  const list = listRepos(cwd).map((rel) => {
    const name = repoFolderName(cwd, rel);
    return {
      key: rel,
      dir: rel === '.' ? path.resolve(cwd) : path.join(cwd, ...rel.split('/')),
      name,
      nickname: repoDisplayName(rel, name),
      scope: 'workspace',
    };
  });
  const appRoot = appRepoRoot();
  // Only if it is genuinely a separate repository - never a second entry for one the
  // workspace scan already found.
  if (appRoot && !list.some((r) => path.resolve(r.dir) === path.resolve(appRoot))) {
    list.push({
      key: APP_KEY,
      dir: appRoot,
      name: path.basename(appRoot),
      nickname: 'JARVIS App',
      scope: 'app',
    });
  }
  return list;
}

/**
 * Resolve a key to a real repository. Returns null rather than a guess.
 * Every operation goes through here first - this is rule 1.
 */
export function resolveRepo(cwd, key) {
  if (typeof key !== 'string' || !key) return null;
  const hit = sourceRepos(cwd).find((r) => r.key === key);
  if (!hit || !isRepo(hit.dir)) return null;
  return hit;
}

/**
 * Full status for one repository: branch, upstream, ahead/behind, staged, modified,
 * untracked, last commit - plus the remote, which the Workspace view does not need.
 * `repo` identifies the repository in the answer so the window can prove the reply it is
 * rendering belongs to the repository it asked about, and discard a late one.
 */
export async function repoDetail(cwd, key) {
  const repo = resolveRepo(cwd, key);
  if (!repo) return { ok: false, error: 'That repository is not one of the detected repositories.' };

  const [state, remote] = await Promise.all([
    repoStateAt(repo.dir, repo.name),
    run('git', ['--no-optional-locks', '-C', repo.dir, 'remote', '-v'], { timeout: 10000 }),
  ]);

  // `remote -v` lists fetch and push lines per remote; one entry each is enough here.
  const remotes = [];
  if (remote.ok) {
    for (const line of remote.out.split(/\r?\n/)) {
      const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
      if (m && m[3] === 'fetch') remotes.push({ name: m[1], url: scrub(m[2]) });
    }
  }

  // When this repository last heard from a remote: git touches FETCH_HEAD on every fetch and
  // pull. Read from disk, so showing "Last fetched 3 minutes ago" never contacts anything.
  let lastFetched = null;
  try { lastFetched = fs.statSync(path.join(repo.dir, '.git', 'FETCH_HEAD')).mtimeMs; } catch { /* never fetched */ }

  return {
    ok: true,
    repo: { key: repo.key, name: repo.name, nickname: repo.nickname, scope: repo.scope, dir: repo.dir },
    ...state,
    remotes,
    lastFetched,
    clean: state.ok && !state.staged && !state.modified && !state.untracked,
    checkedAt: Date.now(),
  };
}

/** Status for every repository at once, for the picker. */
export async function allRepoStates(cwd) {
  const repos = sourceRepos(cwd);
  const states = await Promise.all(repos.map((r) => repoStateAt(r.dir, r.name).catch(() => null)));
  return repos.map((r, i) => ({
    key: r.key,
    name: r.name,
    nickname: r.nickname,
    scope: r.scope,
    ...(states[i] || { ok: false, error: 'Could not read this repository.' }),
    clean: states[i] ? !states[i].staged && !states[i].modified && !states[i].untracked : false,
  }));
}

/**
 * A remote URL with any embedded credential removed. A URL of the form
 * https://user:token@github.com/... would otherwise put a token on screen and in the log.
 */
function scrub(url) {
  return String(url || '').replace(/\/\/[^@/]*@/, '//');
}

// ---------------------------------------------------------------- changed files
//
// `--porcelain=v1 -z` rather than the human format: NUL separation means a path with a
// space, a quote or a non-ASCII character arrives intact instead of being shell-quoted by
// git and un-quoted wrongly by us.

const LETTER = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'typechange' };
// Both sides unmerged, or one side 'U': a conflict, whatever the pair.
const CONFLICT = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

function parseStatusZ(out) {
  const files = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (!entry || entry.length < 3) continue;
    const x = entry[0];
    const y = entry[1];
    const p = entry.slice(3);
    const xy = x + y;

    // A rename or copy is followed by its source path as the next NUL-separated field.
    let renamedFrom = null;
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') { renamedFrom = parts[i + 1] || null; i += 1; }

    const conflicted = CONFLICT.has(xy);
    const untracked = xy === '??';
    const ignored = xy === '!!';
    if (ignored) continue;

    files.push({
      path: p,
      renamedFrom,
      x,
      y,
      conflicted,
      untracked,
      // Staged means the index differs from HEAD. Untracked is neither staged nor unstaged
      // in git's sense - it simply is not known to git yet.
      staged: !untracked && !conflicted && x !== ' ' && x !== '?',
      unstaged: !untracked && !conflicted && y !== ' ' && y !== '?',
      status: conflicted ? 'conflicted'
        : untracked ? 'untracked'
          : LETTER[x !== ' ' && x !== '?' ? x : y] || 'modified',
    });
  }
  return files;
}

/** Every changed file in one repository. Read-only; no remote is contacted. */
export async function changedFiles(cwd, key) {
  const repo = resolveRepo(cwd, key);
  if (!repo) return { ok: false, error: 'That repository is not one of the detected repositories.' };

  const r = await run('git', ['--no-optional-locks', '-C', repo.dir, 'status', '--porcelain=v1', '-z', '-uall'], { timeout: 20000 });
  if (!r.ok) return { ok: false, error: r.err.split('\n')[0].slice(0, 200), repo: { key: repo.key } };

  const files = parseStatusZ(r.out);
  return {
    ok: true,
    repo: { key: repo.key, name: repo.name, nickname: repo.nickname },
    files,
    counts: {
      total: files.length,
      staged: files.filter((f) => f.staged).length,
      unstaged: files.filter((f) => f.unstaged).length,
      untracked: files.filter((f) => f.untracked).length,
      conflicted: files.filter((f) => f.conflicted).length,
    },
  };
}

// ---------------------------------------------------------------- the diff
const MAX_DIFF_LINES = 4000;   // a guard on the IPC payload, not on the model
const MAX_UNTRACKED_BYTES = 512 * 1024;
const UNTRACKED_CAP = 128 * 1024;   // per new file, when a whole working set is gathered for review

/** Parse a unified diff into hunks the window can render without re-parsing text. */
export function parseUnified(text) {
  const hunks = [];
  let added = 0;
  let removed = 0;
  let cur = null;
  let oldNo = 0;
  let newNo = 0;
  let truncated = false;
  let seen = 0;

  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git') || raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ')
      || raw.startsWith('new file mode') || raw.startsWith('deleted file mode') || raw.startsWith('similarity index')
      || raw.startsWith('rename from') || raw.startsWith('rename to') || raw.startsWith('old mode') || raw.startsWith('new mode')) continue;

    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(raw);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[3]);
      // git puts the enclosing function or section after the @@ range, but often there is
      // none. Fall back to the range itself rather than showing an empty strip.
      const section = (h[5] || '').trim();
      cur = {
        header: section,
        range: `@@ -${h[1]}${h[2] ? `,${h[2]}` : ''} +${h[3]}${h[4] ? `,${h[4]}` : ''} @@`,
        lines: [],
      };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue;
    if (seen >= MAX_DIFF_LINES) { truncated = true; break; }
    seen += 1;

    if (raw.startsWith('+')) { cur.lines.push({ t: '+', n: newNo++, text: raw.slice(1) }); added += 1; }
    else if (raw.startsWith('-')) { cur.lines.push({ t: '-', o: oldNo++, text: raw.slice(1) }); removed += 1; }
    else if (raw.startsWith('\\')) { cur.lines.push({ t: '\\', text: raw.slice(1).trim() }); }
    else { cur.lines.push({ t: ' ', o: oldNo++, n: newNo++, text: raw.slice(1) }); }
  }
  return { hunks, added, removed, truncated };
}

/**
 * The diff for one file.
 *
 * `which` picks the comparison: 'worktree' is what you have not staged yet, 'index' is
 * what you have staged against HEAD, and 'auto' shows whichever actually has changes,
 * preferring the working tree because that is what you are editing.
 *
 * An untracked file has no diff at all as far as git is concerned, so it is rendered as
 * one all-added hunk by reading the file - which is what GitHub Desktop shows too.
 */
export async function fileDiff(cwd, key, filePath, { which = 'auto' } = {}) {
  const repo = resolveRepo(cwd, key);
  if (!repo) return { ok: false, error: 'That repository is not one of the detected repositories.' };
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) {
    return { ok: false, error: 'No file was named.' };
  }

  const listing = await changedFiles(cwd, key);
  if (!listing.ok) return listing;
  const entry = listing.files.find((f) => f.path === filePath);
  if (!entry) return { ok: false, error: 'That file is not among this repository\'s changes.' };

  if (entry.untracked) return untrackedDiff(repo, entry);

  const staged = which === 'index' || (which === 'auto' && !entry.unstaged && entry.staged);
  const args = ['--no-optional-locks', '-C', repo.dir, 'diff', '--no-color', '--no-ext-diff', '-M'];
  if (staged) args.push('--cached');
  args.push('--', filePath);

  const r = await run('git', args, { timeout: 20000 });
  if (!r.ok) return { ok: false, error: r.err.split('\n')[0].slice(0, 200) };
  if (/^Binary files /m.test(r.out)) {
    return { ok: true, repo: { key: repo.key }, path: filePath, entry, binary: true, hunks: [], added: 0, removed: 0, side: staged ? 'index' : 'worktree' };
  }

  return {
    ok: true,
    repo: { key: repo.key },
    path: filePath,
    entry,
    binary: false,
    side: staged ? 'index' : 'worktree',
    canToggle: entry.staged && entry.unstaged,
    ...parseUnified(r.out),
  };
}

// ---------------------------------------------------------------- mutations
//
// Everything below changes a repository, so three rules apply without exception.
//
//   The index is the truth. There is no selection state of our own kept beside git's -
//   what the window shows as staged IS `git status`, re-read after every mutation. A
//   checkbox that remembers its own idea of what will be committed is a checkbox that will
//   eventually lie.
//
//   Every path is validated against the current listing before it reaches git, so a path
//   can only ever be one git itself just reported as changed. Paths travel in argument
//   arrays; nothing is ever concatenated into a shell string.
//
//   Every mutation is classified by the shared policy first. Phase 3's operations are all
//   `mutate`, but the check is real: if a future edit to the policy marked one destructive,
//   this refuses it rather than quietly carrying on.

/** Refuse anything the shared policy does not consider safe for a UI action to run. */
function allowed(cwd, sub, args) {
  const v = classify(cwd, sub, args);
  if (v.level === 'read' || v.level === 'mutate') return null;
  return `The git risk policy classes \`git ${sub}\` as ${v.level}: ${v.reason || 'it needs confirmation.'}`;
}

/** Paths the caller may act on: exactly those git currently reports as changed. */
async function validPaths(cwd, key, paths) {
  const listing = await changedFiles(cwd, key);
  if (!listing.ok) return { error: listing.error };
  if (!Array.isArray(paths) || !paths.length) return { error: 'No files were named.' };

  const known = new Set();
  for (const f of listing.files) {
    known.add(f.path);
    if (f.renamedFrom) known.add(f.renamedFrom);
  }
  const bad = paths.filter((p) => typeof p !== 'string' || !known.has(p));
  if (bad.length) return { error: `Not among this repository's changes: ${bad.slice(0, 3).join(', ')}` };
  return { paths, listing };
}

/** Does this repository have any commit yet? An unborn HEAD needs different plumbing. */
async function hasHead(dir) {
  const r = await run('git', ['--no-optional-locks', '-C', dir, 'rev-parse', '--verify', 'HEAD'], { timeout: 8000 });
  return r.ok && /^[0-9a-f]{7,}/.test(r.out.trim());
}

/** Stage files. `git add` handles modified, untracked and deleted alike. */
export async function stageFiles(cwd, key, paths) {
  const repo = resolveRepo(cwd, key);
  if (!repo) return { ok: false, error: 'That repository is not one of the detected repositories.' };
  const refuse = allowed(cwd, 'add', []);
  if (refuse) return { ok: false, error: refuse };

  const v = await validPaths(cwd, key, paths);
  if (v.error) return { ok: false, error: v.error };

  const r = await run('git', ['-C', repo.dir, 'add', '--', ...v.paths], { timeout: 30000 });
  if (!r.ok) return { ok: false, error: r.err.split('\n')[0].slice(0, 300) };
  return changedFiles(cwd, key);
}

/**
 * Unstage files - index only, working tree untouched.
 *
 * `git restore --staged` is the modern form and the policy explicitly treats it as safe
 * *because* it lacks `--worktree`. With no commit yet there is no HEAD to restore from, so
 * an unborn repository falls back to `git rm --cached`, which also only touches the index.
 * Neither can discard an edit, which is the whole requirement.
 */
export async function unstageFiles(cwd, key, paths) {
  const repo = resolveRepo(cwd, key);
  if (!repo) return { ok: false, error: 'That repository is not one of the detected repositories.' };
  const refuse = allowed(cwd, 'restore', ['--staged']);
  if (refuse) return { ok: false, error: refuse };

  const v = await validPaths(cwd, key, paths);
  if (v.error) return { ok: false, error: v.error };

  const born = await hasHead(repo.dir);
  const r = born
    ? await run('git', ['-C', repo.dir, 'restore', '--staged', '--', ...v.paths], { timeout: 30000 })
    : await run('git', ['-C', repo.dir, 'rm', '--cached', '-q', '--', ...v.paths], { timeout: 30000 });
  if (!r.ok) return { ok: false, error: r.err.split('\n')[0].slice(0, 300) };
  return changedFiles(cwd, key);
}

/** Stage everything: modifications, new files and deletions. */
export async function stageAll(cwd, key) {
  const repo = resolveRepo(cwd, key);
  if (!repo) return { ok: false, error: 'That repository is not one of the detected repositories.' };
  const refuse = allowed(cwd, 'add', ['-A']);
  if (refuse) return { ok: false, error: refuse };

  const r = await run('git', ['-C', repo.dir, 'add', '-A', '--'], { timeout: 60000 });
  if (!r.ok) return { ok: false, error: r.err.split('\n')[0].slice(0, 300) };
  return changedFiles(cwd, key);
}

/** Empty the index back to HEAD. Working tree untouched - no `--hard` anywhere near this. */
export async function unstageAll(cwd, key) {
  const repo = resolveRepo(cwd, key);
  if (!repo) return { ok: false, error: 'That repository is not one of the detected repositories.' };
  const refuse = allowed(cwd, 'reset', []);
  if (refuse) return { ok: false, error: refuse };

  const born = await hasHead(repo.dir);
  const r = born
    ? await run('git', ['-C', repo.dir, 'reset', '-q', '--'], { timeout: 60000 })
    : await run('git', ['-C', repo.dir, 'rm', '-r', '--cached', '-q', '--', '.'], { timeout: 60000 });
  if (!r.ok) return { ok: false, error: r.err.split('\n')[0].slice(0, 300) };
  return changedFiles(cwd, key);
}

/**
 * Commit what is staged, and nothing else.
 *
 * Summary and description go as two separate `-m` arguments, which is how git joins them
 * with a blank line - no shell quoting, no concatenation, and a message containing quotes,
 * newlines or a `$` is just text.
 *
 * Success is never assumed. The HEAD sha before and after must differ, and the answer
 * reports the branch that received it and the files it contains, read back from git.
 */
export async function commit(cwd, key, { summary, description } = {}) {
  const repo = resolveRepo(cwd, key);
  if (!repo) return { ok: false, error: 'That repository is not one of the detected repositories.' };
  const refuse = allowed(cwd, 'commit', []);
  if (refuse) return { ok: false, error: refuse };

  const subject = String(summary || '').trim();
  if (!subject) return { ok: false, error: 'A commit needs a summary.' };

  const before = await changedFiles(cwd, key);
  if (!before.ok) return before;
  if (before.counts.conflicted) {
    return { ok: false, error: 'This repository has unresolved conflicts. Resolve them before committing.' };
  }
  if (!before.counts.staged) {
    return { ok: false, error: 'Nothing is staged. Stage the changes you want in this commit first.' };
  }

  const headBefore = (await run('git', ['--no-optional-locks', '-C', repo.dir, 'rev-parse', 'HEAD'], { timeout: 8000 })).out.trim();
  const staged = before.files.filter((f) => f.staged).map((f) => f.path);

  const args = ['-C', repo.dir, 'commit', '-m', subject];
  const body = String(description || '').trim();
  if (body) args.push('-m', body);

  const r = await run('git', args, { timeout: 60000 });

  // git, or one of its hooks, may refuse. Never report a commit that did not happen.
  const headAfter = (await run('git', ['--no-optional-locks', '-C', repo.dir, 'rev-parse', 'HEAD'], { timeout: 8000 })).out.trim();
  if (!headAfter || headAfter === headBefore) {
    const why = `${r.err || ''}\n${r.out || ''}`.split('\n').map((l) => l.trim()).filter(Boolean)[0] || 'git did not create a commit.';
    return { ok: false, error: why.slice(0, 300), refused: true };
  }

  const [show, branchOut] = await Promise.all([
    run('git', ['--no-optional-locks', '-C', repo.dir, 'show', '--name-only', '--format=%H%x1f%s%x1f%an%x1f%cI', headAfter], { timeout: 20000 }),
    run('git', ['--no-optional-locks', '-C', repo.dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 8000 }),
  ]);
  const [sha, subj, author, when] = (show.out.split('\n')[0] || '').split('\x1f');
  const committed = show.out.split('\n').slice(1).map((s) => s.trim()).filter(Boolean);

  return {
    ok: true,
    commit: {
      sha: (sha || headAfter).slice(0, 10),
      subject: subj || subject,
      author: author || '',
      at: when || '',
      branch: branchOut.out.trim() || '(detached HEAD)',
      files: committed.length ? committed : staged,
      count: (committed.length ? committed : staged).length,
    },
    after: await changedFiles(cwd, key),
  };
}

// ---------------------------------------------------------------- undo the last commit
//
// GitHub Desktop's "Undo" under the commit button: take the newest commit back off the
// branch, leaving its changes staged and its message ready to reuse. `git reset --soft
// HEAD~1` moves only the branch - the index and the working tree keep every change - so
// nothing can be lost, which is why the shared policy classes it `mutate`.
//
// Offered only for a commit that exists nowhere else. Once it is on a remote-tracking
// branch, taking it back would rewrite history someone else may already have. That is
// judged from the refs already on disk; nothing here contacts a remote.

/** The newest commit on the current branch, and whether Undo is offered for it. Read-only. */
export async function lastCommit(cwd, key) {
  const repo = resolveRepo(cwd, key);
  if (!repo) return { ok: false, error: 'That repository is not one of the detected repositories.' };
  if (!await hasHead(repo.dir)) return { ok: true, repo: { key: repo.key }, commit: null, undoable: false, reason: 'No commits yet.' };

  const [show, branchOut] = await Promise.all([
    run('git', ['--no-optional-locks', '-C', repo.dir, 'log', '-1', '--format=%H%x1f%P%x1f%cI%x1f%s%x1f%b'], { timeout: 8000 }),
    run('git', ['--no-optional-locks', '-C', repo.dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 8000 }),
  ]);
  if (!show.ok) return { ok: false, error: firstLine(show) };

  const [sha = '', parents = '', at = '', subject = '', ...rest] = show.out.split('\x1f');
  const branch = branchOut.out.trim();
  const commitInfo = {
    sha: sha.trim().slice(0, 10),
    fullSha: sha.trim(),
    subject,
    body: rest.join('\x1f').trim(),
    at,
    branch,
  };

  const parentCount = parents.trim() ? parents.trim().split(/\s+/).length : 0;
  let reason = null;
  if (!branch || branch === 'HEAD') reason = 'You are not on a branch.';
  else if (parentCount === 0) reason = 'This is the first commit in the repository, so there is nothing to go back to.';
  else if (parentCount > 1) reason = 'This is a merge commit. Undoing a merge is not offered here.';
  else {
    const state = await conflictState(cwd, key);
    if (state.ok && state.operation) reason = `A ${state.operation} is in progress. Finish or abort it first.`;
  }
  if (!reason) {
    const onRemote = await run('git', ['--no-optional-locks', '-C', repo.dir, 'branch', '-r', '--contains', commitInfo.fullSha], { timeout: 10000 });
    const where = onRemote.ok ? onRemote.out.split('\n').map((s) => s.trim()).filter((s) => s && !s.includes(' -> ')) : [];
    if (!onRemote.ok) reason = 'Could not tell whether this commit has been pushed, so Undo is not offered.';
    else if (where.length) reason = `It is already on ${where[0]}. Undoing it would rewrite history others may have.`;
  }

  return { ok: true, repo: { key: repo.key }, commit: commitInfo, undoable: !reason, reason };
}

/**
 * Undo the newest commit: the branch steps back one commit, and the commit's changes stay
 * staged. `sha` must still be the newest commit - a click on a panel that has gone stale
 * must not undo a different commit than the one it showed.
 */
export async function undoLastCommit(cwd, key, { sha = '' } = {}) {
  const repo = resolveRepo(cwd, key);
  if (!repo) return { ok: false, error: 'That repository is not one of the detected repositories.' };
  const refuse = allowed(cwd, 'reset', ['--soft', 'HEAD~1']);
  if (refuse) return { ok: false, error: refuse };

  const last = await lastCommit(cwd, key);
  if (!last.ok) return last;
  if (!last.commit) return { ok: false, error: 'There is no commit to undo.' };
  const wanted = String(sha || '');
  if (!wanted || !last.commit.fullSha.startsWith(wanted)) {
    return { ok: false, stale: true, error: 'The newest commit has changed since this was shown. Nothing was undone.' };
  }
  if (!last.undoable) return { ok: false, error: last.reason || 'This commit cannot be undone here.' };

  const parent = (await run('git', ['--no-optional-locks', '-C', repo.dir, 'rev-parse', `${last.commit.fullSha}~1`], { timeout: 8000 })).out.trim();
  const r = await run('git', ['-C', repo.dir, 'reset', '--soft', 'HEAD~1'], { timeout: 30000 });
  const headNow = (await run('git', ['--no-optional-locks', '-C', repo.dir, 'rev-parse', 'HEAD'], { timeout: 8000 })).out.trim();
  if (!r.ok || !parent || headNow !== parent) {
    return { ok: false, error: r.ok ? 'git did not move the branch back. Nothing was undone.' : firstLine(r) };
  }

  return {
    ok: true,
    undone: { sha: last.commit.sha, subject: last.commit.subject, body: last.commit.body, branch: last.commit.branch },
    after: await changedFiles(cwd, key),
  };
}

// ---------------------------------------------------------------- discard all changes
//
// GitHub Desktop's "Discard all changes...": every tracked file goes back to the last
// commit and every new file is removed. The shared policy classes both halves destructive
// (`git restore --worktree`, and what `git clean` would do), so it runs only with
// `confirmed`, and the window's confirmation names the repository and the files first.
//
// As in GitHub Desktop, the work is not simply thrown away: before anything is touched, a
// copy of every changed file that is on disk goes to the Recycle Bin, in one folder named
// after the repository and the time. If that copy cannot be made, nothing is discarded.
// `trash` moves a path to the Recycle Bin; the main process passes Electron's
// shell.trashItem, and tests pass their own.

/** Remove now-empty folders left by deleted files, never climbing above the repository. */
function pruneEmptyDirs(root, rel) {
  let dir = path.dirname(path.join(root, rel));
  const top = path.resolve(root);
  while (path.resolve(dir).startsWith(top + path.sep)) {
    try {
      if (fs.readdirSync(dir).length) break;
      fs.rmdirSync(dir);
    } catch { break; }
    dir = path.dirname(dir);
  }
}

export async function discardAll(cwd, key, { confirmed = false, trash = null, expect = null } = {}) {
  const repo = resolveRepo(cwd, key);
  if (!repo) return { ok: false, error: 'That repository is not one of the detected repositories.' };

  const before = await changedFiles(cwd, key);
  if (!before.ok) return before;
  if (!before.counts.total) return { ok: false, error: 'There are no changes to discard.' };
  // A confirmation covers the files it listed. If the set changed since - a file saved, a
  // new one created - the person has not agreed to lose that, so nothing is touched.
  if (confirmed && Array.isArray(expect)) {
    const now = before.files.map((f) => f.path).sort().join('\0');
    const shown = expect.map(String).sort().join('\0');
    if (now !== shown) {
      return { ok: false, stale: true, error: 'The changes are not the ones you confirmed - something changed since. Nothing was discarded.' };
    }
  }
  if (before.counts.conflicted) return { ok: false, error: 'This repository has unresolved conflicts. Resolve them before discarding.' };
  const state = await conflictState(cwd, key);
  if (state.ok && state.operation) return { ok: false, error: `A ${state.operation} is in progress. Finish or abort it first.` };
  if (!await hasHead(repo.dir)) return { ok: false, error: 'This repository has no commit yet, so there is nothing to go back to.' };

  const tracked = before.files.filter((f) => !f.untracked);
  const untracked = before.files.filter((f) => f.untracked);

  // The policy is asked about exactly what will run; it is not weakened here.
  const verdicts = [];
  if (tracked.length) verdicts.push(classify(cwd, 'restore', ['--source=HEAD', '--staged', '--worktree', '--', '.']));
  if (untracked.length) verdicts.push(classify(cwd, 'clean', ['-f']));
  const destructive = verdicts.filter((v) => v.level === 'destructive');
  if (destructive.length && !confirmed) {
    return {
      ok: false,
      needsConfirmation: true,
      reason: destructive.map((v) => v.reason).filter(Boolean).join('. ') || 'This discards uncommitted work.',
      repoLabel: repo.nickname,
      files: before.files.map((f) => ({ path: f.path, status: f.status })),
      counts: before.counts,
    };
  }
  if (typeof trash !== 'function') return { ok: false, error: 'The Recycle Bin is not available, so nothing was discarded.' };

  // 1. The copy, before anything is touched.
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const backup = path.join(os.tmpdir(), `JARVIS discarded changes - ${repo.name} - ${stamp}`);
  const saved = [];
  try {
    for (const f of before.files) {
      const src = path.join(repo.dir, f.path);
      let st;
      try { st = fs.statSync(src); } catch { continue; }   // deleted on disk: git still has it
      if (!st.isFile()) continue;
      const dst = path.resolve(backup, f.path);
      if (!dst.startsWith(path.resolve(backup) + path.sep)) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      saved.push(f.path);
    }
  } catch (e) {
    try { fs.rmSync(backup, { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: false, error: `Could not copy the changed files for safekeeping (${e?.message || e}). Nothing was discarded.` };
  }
  if (saved.length) {
    try { await trash(backup); } catch (e) {
      try { fs.rmSync(backup, { recursive: true, force: true }); } catch { /* best effort */ }
      return { ok: false, error: `Could not put a copy in the Recycle Bin (${e?.message || e}). Nothing was discarded.` };
    }
  } else {
    try { fs.rmSync(backup, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  const binName = saved.length ? path.basename(backup) : null;
  const kept = binName ? ` A copy of the changed files is in the Recycle Bin as "${binName}".` : '';

  // 2. Tracked files back to the last commit - index and working tree. A file that was
  //    added but never committed is tracked and absent from HEAD, so it is removed too.
  if (tracked.length) {
    const r = await run('git', ['-C', repo.dir, 'restore', '--source=HEAD', '--staged', '--worktree', '--', '.'], { timeout: 60000 });
    if (!r.ok) return { ok: false, error: `${firstLine(r)}.${kept}`, after: await changedFiles(cwd, key) };
  }

  // 3. New files: exactly the ones listed, nothing else (no `git clean` sweeping the tree).
  const failed = [];
  for (const f of untracked) {
    const target = path.resolve(repo.dir, f.path);
    if (!target.startsWith(path.resolve(repo.dir) + path.sep)) continue;
    try { fs.rmSync(target, { force: true }); pruneEmptyDirs(repo.dir, f.path); } catch { failed.push(f.path); }
  }

  const after = await changedFiles(cwd, key);
  const n = before.counts.total;
  return {
    ok: !failed.length,
    discarded: n - failed.length,
    backup: binName,
    after,
    error: failed.length ? `Could not remove ${failed.length} new file${failed.length === 1 ? '' : 's'} (${failed.slice(0, 3).join(', ')}).${kept}` : undefined,
    message: `Discarded ${n} change${n === 1 ? '' : 's'}.${kept}`,
  };
}

// ---------------------------------------------------------------- branches
//
// Everything here reads local refs only. `refs/remotes/...` entries are what the last
// fetch left on disk - they are NOT what the remote looks like now, and nothing in this
// phase contacts a network to find out. Opening the branch picker must never cause a fetch.

const UNIT = '\x1f';

/** Parse `[ahead 2, behind 1]`, `[gone]` or an empty string from %(upstream:track). */
function parseTrack(track) {
  const t = String(track || '');
  if (/\[gone\]/.test(t)) return { gone: true, ahead: 0, behind: 0 };
  const a = /ahead (\d+)/.exec(t);
  const b = /behind (\d+)/.exec(t);
  return { gone: false, ahead: a ? Number(a[1]) : 0, behind: b ? Number(b[1]) : 0 };
}

/**
 * Every branch this repository knows about, plus what HEAD is doing.
 *
 * A detached HEAD is reported as exactly that, never dressed up as a branch: operations
 * that need a branch name can then disable themselves honestly.
 */
export async function listBranches(cwd, key) {
  const repo = resolveRepo(cwd, key);
  if (!repo) return { ok: false, error: 'That repository is not one of the detected repositories.' };

  // %(refname) as well as the short form: `refs/remotes/origin/HEAD` shortens to plain
  // `origin`, so filtering the short name would let the remote's symbolic HEAD through as
  // if it were a branch called "origin". %(symref) catches any other symbolic ref too.
  const fmt = ['%(refname:short)', '%(upstream:short)', '%(upstream:track)', '%(objectname:short)',
    '%(HEAD)', '%(committerdate:relative)', '%(contents:subject)', '%(refname)', '%(symref)'].join(UNIT);

  // Two queries rather than one: asking refs/heads and refs/remotes separately means the
  // local/remote split comes from git, not from guessing at the shape of a name. A local
  // branch really can be called `origin/something`.
  const [heads, remotes, symbolic, head] = await Promise.all([
    run('git', ['--no-optional-locks', '-C', repo.dir, 'for-each-ref', `--format=${fmt}`, 'refs/heads'], { timeout: 20000 }),
    run('git', ['--no-optional-locks', '-C', repo.dir, 'for-each-ref', `--format=${fmt}`, 'refs/remotes'], { timeout: 20000 }),
    run('git', ['--no-optional-locks', '-C', repo.dir, 'symbolic-ref', '-q', '--short', 'HEAD'], { timeout: 8000 }),
    run('git', ['--no-optional-locks', '-C', repo.dir, 'rev-parse', '--short', 'HEAD'], { timeout: 8000 }),
  ]);
  if (!heads.ok) return { ok: false, error: heads.err.split('\n')[0].slice(0, 200) };

  const row = (line) => {
    const [name, upstream, track, sha, isHead, when, subject, full, symref] = line.split(UNIT);
    return { name, upstream, track, sha: sha || '', isHead, when: when || '',
      subject: (subject || '').slice(0, 120), full: full || '', symref: symref || '' };
  };
  const lines = (out) => String(out || '').split(/\r?\n/).filter((l) => l.trim());

  const local = lines(heads.out).map(row).filter((r) => r.name).map((r) => {
    const t = parseTrack(r.track);
    return {
      name: r.name,
      sha: r.sha,
      when: r.when,
      subject: r.subject,
      current: r.isHead === '*',
      remote: false,
      upstream: r.upstream || null,
      published: !!r.upstream && !t.gone,
      upstreamGone: t.gone,
      ahead: t.ahead,
      behind: t.behind,
    };
  });

  const remote = lines(remotes.out).map(row)
    .filter((r) => r.name && !r.full.endsWith('/HEAD') && !r.symref)   // a remote's HEAD is a pointer, not a branch
    .map((r) => ({ name: r.name, sha: r.sha, when: r.when, subject: r.subject, current: false, remote: true }));

  const detached = !symbolic.ok || !symbolic.out.trim();
  return {
    ok: true,
    repo: { key: repo.key, name: repo.name, nickname: repo.nickname },
    current: detached ? null : symbolic.out.trim(),
    detached,
    head: head.out.trim(),
    local: local.sort((a, b) => (b.current - a.current) || a.name.localeCompare(b.name)),
    remote: remote.sort((a, b) => a.name.localeCompare(b.name)),
  };
}


/** Ask git whether a branch name is legal. Never a weaker home-made validator. */
async function validName(dir, name) {
  if (typeof name !== 'string' || !name.trim()) return 'A branch needs a name.';
  if (name.length > 240) return 'That name is too long.';
  const r = await run('git', ['-C', dir, 'check-ref-format', '--branch', name], { timeout: 8000 });
  return r.ok ? null : `git rejects that branch name: ${(r.err || '').split('\n')[0].slice(0, 160) || 'not a valid ref name'}`;
}

/** Create a branch, optionally from another starting point, and switch to it. */
export async function createBranch(cwd, key, name, { from = null, switchTo = true } = {}) {
  const repo = resolveRepo(cwd, key);
  if (!repo) return { ok: false, error: 'That repository is not one of the detected repositories.' };
  const refuse = allowed(cwd, switchTo ? 'switch' : 'branch', []);
  if (refuse) return { ok: false, error: refuse };

  const bad = await validName(repo.dir, name);
  if (bad) return { ok: false, error: bad };

  let start = null;
  if (from) {
    const known = await listBranches(cwd, key);
    if (!known.ok) return known;
    const ok = known.local.some((b) => b.name === from) || known.remote.some((b) => b.name === from);
    if (!ok) return { ok: false, error: 'That starting point is not a branch this repository knows.' };
    start = from;
  }

  const args = switchTo
    ? ['-C', repo.dir, 'switch', '-c', name, ...(start ? [start] : [])]
    : ['-C', repo.dir, 'branch', name, ...(start ? [start] : [])];
  const r = await run('git', args, { timeout: 30000 });
  if (!r.ok) return { ok: false, error: firstLine(r) };

  // Never assume. Read back what git actually did.
  const after = await listBranches(cwd, key);
  if (!after.ok) return after;
  if (!after.local.some((b) => b.name === name)) {
    return { ok: false, error: 'git reported success but the branch is not there.' };
  }
  return { ok: true, created: name, switched: switchTo, branches: after, published: false };
}

/**
 * Switch branches without ever forcing it.
 *
 * A dirty tree is not by itself a reason to refuse - git carries most working changes
 * across branches quite happily, and inventing a stricter rule than git's would just get
 * in the way. When git does refuse, its reason is handed back verbatim and nothing is
 * stashed, committed, discarded or forced on the user's behalf.
 */
export async function switchBranch(cwd, key, name) {
  const repo = resolveRepo(cwd, key);
  if (!repo) return { ok: false, error: 'That repository is not one of the detected repositories.' };
  const refuse = allowed(cwd, 'switch', []);
  if (refuse) return { ok: false, error: refuse };

  const known = await listBranches(cwd, key);
  if (!known.ok) return known;
  const local = known.local.find((b) => b.name === name);
  const remote = known.remote.find((b) => b.name === name);
  if (!local && !remote) return { ok: false, error: 'That is not a branch this repository knows.' };

  // No -f, no --discard-changes: those are what the risk policy calls destructive.
  const r = await run('git', ['-C', repo.dir, 'switch', name], { timeout: 30000 });
  if (!r.ok) {
    return {
      ok: false,
      blocked: true,
      error: firstLine(r),
      detail: `${r.err || ''}`.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 6).join('\n'),
    };
  }

  const after = await listBranches(cwd, key);
  if (after.ok && after.current !== name && !after.detached) {
    return { ok: false, error: `git switched to ${after.current}, not ${name}.` };
  }
  return { ok: true, current: after.ok ? after.current : name, branches: after };
}

/** Rename a local branch. Local means local - no remote branch is touched. */
export async function renameBranch(cwd, key, from, to) {
  const repo = resolveRepo(cwd, key);
  if (!repo) return { ok: false, error: 'That repository is not one of the detected repositories.' };
  const refuse = allowed(cwd, 'branch', []);
  if (refuse) return { ok: false, error: refuse };

  const bad = await validName(repo.dir, to);
  if (bad) return { ok: false, error: bad };

  const known = await listBranches(cwd, key);
  if (!known.ok) return known;
  if (!known.local.some((b) => b.name === from)) return { ok: false, error: 'That is not a local branch here.' };
  if (known.local.some((b) => b.name === to)) return { ok: false, error: `There is already a branch called ${to}.` };

  const r = await run('git', ['-C', repo.dir, 'branch', '-m', from, to], { timeout: 20000 });
  if (!r.ok) return { ok: false, error: firstLine(r) };

  const after = await listBranches(cwd, key);
  if (!after.ok) return after;
  if (!after.local.some((b) => b.name === to)) return { ok: false, error: 'git reported success but the rename is not there.' };
  return { ok: true, from, to, branches: after, note: 'Renamed locally. No remote branch was changed.' };
}

/**
 * Delete a local branch.
 *
 * `-d` is git's safe form: it refuses an unmerged branch on its own, which is why the risk
 * policy leaves it alone. A refusal is reported as a refusal - it is NEVER retried with
 * `-D`. Force deletion is a separate, deliberate request that the policy classes as
 * destructive, and it needs `confirmed: true` from a human who was told what is at stake.
 */
export async function deleteBranch(cwd, key, name, { force = false, confirmed = false } = {}) {
  const repo = resolveRepo(cwd, key);
  if (!repo) return { ok: false, error: 'That repository is not one of the detected repositories.' };

  const verdict = classify(cwd, 'branch', force ? ['-D'] : ['-d']);
  if (verdict.level === 'destructive') {
    if (!confirmed) {
      return {
        ok: false,
        needsConfirmation: true,
        reason: verdict.reason || 'This can destroy commits.',
        repoLabel: repo.nickname,
        branch: name,
      };
    }
  } else if (verdict.level !== 'mutate' && verdict.level !== 'read') {
    return { ok: false, error: `The risk policy refuses this: ${verdict.reason || verdict.level}` };
  }

  const known = await listBranches(cwd, key);
  if (!known.ok) return known;
  if (!known.local.some((b) => b.name === name)) return { ok: false, error: 'That is not a local branch here.' };
  if (known.current === name) return { ok: false, error: 'That is the branch you are on. Switch somewhere else first.' };

  const r = await run('git', ['-C', repo.dir, 'branch', force ? '-D' : '-d', name], { timeout: 20000 });
  if (!r.ok) {
    const why = firstLine(r);
    // git refused because the branch is not merged. Say so; do not escalate.
    const unmerged = /not fully merged/i.test(`${r.err}${r.out}`);
    return { ok: false, error: why, unmerged, branch: name };
  }

  const after = await listBranches(cwd, key);
  if (after.ok && after.local.some((b) => b.name === name)) {
    return { ok: false, error: 'git reported success but the branch is still there.' };
  }
  return { ok: true, deleted: name, forced: force, branches: after };
}

const firstLine = (r) => `${r.err || ''}\n${r.out || ''}`.split('\n').map((l) => l.trim()).filter(Boolean)[0] || 'git did not say why it failed.';

// ---------------------------------------------------------------- assistance context
//
// These build the exact text an optional JARVIS action would send, and measure it, WITHOUT
// sending anything. The window calls this first to show "3 staged files - 91 lines" so the
// cost is visible before it is spent, and the same object is then handed to gitai.mjs so
// what was measured is precisely what is sent.
//
// Nothing here calls a model. Phases 1-7 never call these at all.

/** The diff that an action would look at, gathered once and measured locally. */
export async function assistContext(cwd, key, action, { scope = 'staged', path: filePath = null, sha = null } = {}) {
  const repo = resolveRepo(cwd, key);
  if (!repo) return { ok: false, error: 'That repository is not one of the detected repositories.' };
  const parts = [];
  const meta = [];

  const diffArgs = (extra) => ['--no-optional-locks', '-C', repo.dir, 'diff', '--no-color', '--no-ext-diff', '-M', ...extra];

  if (action === 'commitMessage') {
    const listing = await changedFiles(cwd, key);
    if (!listing.ok) return listing;
    const staged = listing.files.filter((f) => f.staged);
    if (!staged.length) return { ok: false, error: 'Nothing is staged. Stage the changes you want described first.' };
    const r = await run('git', diffArgs(['--cached']), { timeout: 30000 });
    parts.push({ file: null, text: r.out });
    for (const f of staged) parts.push({ file: f.path, text: '' });
    meta.push(`${staged.length} staged file${staged.length === 1 ? '' : 's'}`);
  } else if (action === 'explainDiff') {
    if (!filePath) return { ok: false, error: 'No file was named.' };
    const d = await fileDiff(cwd, key, filePath);
    if (!d.ok) return d;
    const text = d.binary ? '(binary file)' : rebuildDiff(d);
    parts.push({ file: filePath, text });
  } else if (action === 'explainCommit') {
    if (!sha) return { ok: false, error: 'No commit was named.' };
    const detail = await commitDetail(cwd, key, sha);
    if (!detail.ok) return detail;
    const r = await run('git', ['--no-optional-locks', '-C', repo.dir, 'diff-tree', '-p', '-M', '--no-color', '--no-commit-id',
      ...(detail.commit.merge ? [`${sha}^1`, sha] : ['--root', sha])], { timeout: 30000 });
    parts.push({ file: null, text: r.out });
    for (const f of detail.files) parts.push({ file: f.path, text: '' });
    meta.push(`${detail.commit.short} "${detail.commit.summary}" by ${detail.commit.author}`);
    if (detail.commit.merge) meta.push('This is a merge commit; the diff is against its first parent.');
  } else if (action === 'explainConflict' || action === 'suggestResolution' || action === 'reviewResolution') {
    if (!filePath) return { ok: false, error: 'No file was named.' };
    const c = await conflictDetail(cwd, key, filePath);
    if (!c.ok) {
      // Review Resolution is asked AFTER the conflict is gone, so rebuild the sides from
      // the merge heads rather than the index, which no longer has them.
      if (action !== 'reviewResolution') return c;
      const sides = await resolvedSides(repo.dir, filePath);
      if (!sides.ok) return sides;
      parts.push({ file: filePath, text: sides.text });
      meta.push(`${filePath} - already resolved; comparing the result against both sides.`);
    } else {
      meta.push(`${filePath} - ${c.conflict.label} during a ${c.operation || 'merge'}.`);
      meta.push(`Ours = ${c.sides.ours}. Theirs = ${c.sides.theirs}.`);
      if (c.sides.warning) meta.push(c.sides.warning);
      // A binary or oversized side is described, not sent: its bytes are no use as text.
      const section = (name, v) => `===== ${name} =====\n${v === null ? '(this side does not have the file)' : v.note ? `(${v.note})` : v.text}`;
      parts.push({
        file: filePath,
        text: [section('BASE (common ancestor)', c.base), section('OURS', c.ours), section('THEIRS', c.theirs),
          section('CURRENT WORKING COPY', c.working === null ? null : { text: c.working })].join('\n\n'),
      });
    }
  } else {
    // reviewChanges, suspicious, suggestCase: the working set, staged by default.
    const listing = await changedFiles(cwd, key);
    if (!listing.ok) return listing;
    if (!listing.counts.total) return { ok: false, error: 'There are no changes to look at.' };
    const useStaged = scope === 'staged' && listing.counts.staged > 0;
    const r = await run('git', diffArgs(useStaged ? ['--cached'] : []), { timeout: 60000 });
    let text = r.out;

    // An untracked file has NO diff as far as git is concerned, so naming it is not enough:
    // a whole new file is exactly what a review or a secret scan most needs to see, and a
    // brand-new file holding a credential would otherwise sail straight past. Its contents
    // are included as an all-added diff, bounded per file and skipping binaries.
    const untracked = listing.files.filter((f) => f.untracked);
    if (!useStaged && untracked.length) {
      for (const f of untracked) {
        let buf;
        try {
          const st = fs.statSync(path.join(repo.dir, f.path));
          if (st.isDirectory()) continue;
          if (st.size > UNTRACKED_CAP) { text += `\n\n===== new file ${f.path} =====\n(${Math.round(st.size / 1024)} KB - too large to include)\n`; continue; }
          buf = fs.readFileSync(path.join(repo.dir, f.path));
        } catch { continue; }
        if (buf.includes(0)) { text += `\n\n===== new file ${f.path} =====\n(binary)\n`; continue; }
        const body = buf.toString('utf8').replace(/\n$/, '').split('\n').map((l) => `+${l}`).join('\n');
        text += `\n\ndiff --git a/${f.path} b/${f.path}\nnew file\n--- /dev/null\n+++ b/${f.path}\n${body}\n`;
      }
    }
    parts.push({ file: null, text });
    for (const f of listing.files.filter((f) => (useStaged ? f.staged : true))) parts.push({ file: f.path, text: '' });
    meta.push(useStaged ? 'Reviewing: staged changes' : 'Reviewing: all current changes');
  }

  // Over the action's budget the diff is condensed (file list + shortened hunks) instead of
  // refused, so a large commit still gets a message.
  const m = measure(parts, { budget: budgetFor(action) });
  return {
    ok: true,
    repo: { key: repo.key, name: repo.name, nickname: repo.nickname },
    action,
    scope: useScopeLabel(action, scope),
    meta: meta.join('\n'),
    ...m,
  };
}

const useScopeLabel = (action, scope) => {
  if (action === 'commitMessage') return 'staged changes';
  if (action === 'explainDiff') return 'one file';
  if (action === 'explainCommit') return 'one commit';
  if (['explainConflict', 'suggestResolution', 'reviewResolution'].includes(action)) return 'one conflicted file';
  return scope === 'staged' ? 'staged changes' : 'all current changes';
};

/** Turn a parsed diff back into unified text, so the model sees what the window shows. */
function rebuildDiff(d) {
  const out = [`--- a/${d.path}`, `+++ b/${d.path}`];
  for (const h of d.hunks) {
    out.push(h.range + (h.header ? ` ${h.header}` : ''));
    for (const l of h.lines) out.push((l.t === ' ' ? ' ' : l.t) + l.text);
  }
  return out.join('\n');
}

/** For Review Resolution after the fact: the two sides from the merge heads, plus the file. */
async function resolvedSides(dir, filePath) {
  const merge = await run('git', ['--no-optional-locks', '-C', dir, 'rev-parse', '--verify', 'MERGE_HEAD'], { timeout: 8000 });
  const read = async (rev) => {
    const r = await run('git', ['--no-optional-locks', '-C', dir, 'show', `${rev}:${filePath}`], { timeout: 15000 });
    return r.ok ? r.out : null;
  };
  const [ours, theirs] = await Promise.all([read('HEAD'), merge.ok ? read('MERGE_HEAD') : Promise.resolve(null)]);
  let current = null;
  try { current = fs.readFileSync(path.join(dir, filePath), 'utf8'); } catch { /* gone */ }
  if (ours === null && theirs === null && current === null) return { ok: false, error: 'Nothing left to compare for that file.' };
  const section = (n, v) => `===== ${n} =====\n${v === null ? '(not present on this side)' : v}`;
  return {
    ok: true,
    text: [section('OURS (HEAD)', ours), section('THEIRS (MERGE_HEAD)', theirs), section('THE RESOLVED FILE', current)].join('\n\n'),
  };
}

// ---------------------------------------------------------------- stash
//
// A stash is identified here by its COMMIT SHA, never by `stash@{N}`.
//
// Those indices shift the moment anything else is stashed or dropped: drop `stash@{1}`
// and what was `stash@{2}` becomes `stash@{1}`. A UI that remembers an index and acts on
// it later will eventually delete the wrong piece of work, and a stash is often the only
// copy. So every mutation takes a sha, re-reads the list, and finds the index that sha
// occupies *now* - immediately before acting.

/** Every stash, newest first. Local only. */
export async function listStashes(cwd, key) {
  const repo = resolveRepo(cwd, key);
  if (!repo) return { ok: false, error: 'That repository is not one of the detected repositories.' };

  const fmt = ['%gd', '%H', '%gs', '%cI', '%P'].join(UNIT);
  const r = await run('git', ['--no-optional-locks', '-C', repo.dir, 'stash', 'list', `--format=${fmt}`], { timeout: 15000 });
  if (!r.ok) return { ok: false, error: r.err.split('\n')[0].slice(0, 200) };

  const stashes = [];
  for (const line of r.out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [ref, sha, subject, when, parents] = line.split(UNIT);
    if (!sha) continue;
    // `%gs` reads "On <branch>: <message>" or "WIP on <branch>: <sha> <subject>".
    const m = /^(?:WIP on|On) ([^:]+): (.*)$/.exec(subject || '');
    const parentList = (parents || '').trim().split(/\s+/).filter(Boolean);
    stashes.push({
      ref,
      sha,
      branch: m ? m[1] : null,
      message: m ? m[2] : (subject || ''),
      auto: /^WIP on /.test(subject || ''),
      when: when || '',
      base: parentList[0] || null,
      // A stash made with -u has a third parent holding the untracked files.
      hasUntracked: parentList.length >= 3,
    });
  }
  return { ok: true, repo: { key: repo.key }, stashes };
}

/** Find where a stash sits in the list *right now*. Never trust a remembered index. */
async function resolveStash(cwd, key, sha) {
  const list = await listStashes(cwd, key);
  if (!list.ok) return { error: list.error };
  if (!/^[0-9a-f]{7,40}$/i.test(String(sha || ''))) return { error: 'That is not a stash id.' };
  const hit = list.stashes.find((s) => s.sha === sha || s.sha.startsWith(sha));
  if (!hit) return { error: 'That stash is no longer in this repository\'s stash list.' };
  return { stash: hit, list };
}

/**
 * Stash the current work.
 *
 * `includeUntracked` is the caller's explicit choice and the UI says which it is doing -
 * untracked files are never swept in silently. Ignored files are never included: that
 * would need `-a`, which is not offered.
 */
export async function createStash(cwd, key, { message = '', includeUntracked = false, confirmed = false } = {}) {
  const repo = resolveRepo(cwd, key);
  if (!repo) return { ok: false, error: 'That repository is not one of the detected repositories.' };

  const before = await changedFiles(cwd, key);
  if (!before.ok) return before;
  if (!before.counts.total) return { ok: false, error: 'There is nothing to stash.' };
  if (before.counts.conflicted) return { ok: false, error: 'This repository has unresolved conflicts. Resolve them before stashing.' };

  // The shared policy calls `git stash` destructive, and rightly: it is the rule that stops
  // an agent quietly moving someone's work out of the tree to make another command succeed.
  // It is not weakened here. Instead the UI's stash form - which states exactly what will be
  // taken and whether untracked files are included - IS the confirmation, and passes
  // `confirmed`. A caller that has not confirmed gets told what would happen and nothing else.
  const verdict = classify(cwd, 'stash', ['push']);
  if (verdict.level === 'destructive' && !confirmed) {
    const willTake = before.files.filter((f) => (includeUntracked ? true : !f.untracked));
    return {
      ok: false,
      needsConfirmation: true,
      reason: verdict.reason || 'Stashing moves uncommitted work out of the tree.',
      repoLabel: repo.nickname,
      wouldStash: willTake.map((f) => f.path),
      includeUntracked,
    };
  }

  const args = ['-C', repo.dir, 'stash', 'push'];
  if (includeUntracked) args.push('--include-untracked');
  const msg = String(message || '').trim();
  if (msg) args.push('-m', msg);

  const r = await run('git', args, { timeout: 60000 });
  if (!r.ok) return { ok: false, error: firstLine(r) };

  const after = await listStashes(cwd, key);
  if (!after.ok) return after;
  return {
    ok: true,
    created: after.stashes[0] || null,
    includedUntracked: includeUntracked,
    stashes: after.stashes,
    files: await changedFiles(cwd, key),
    message: `Stashed ${before.counts.total} change${before.counts.total === 1 ? '' : 's'}${includeUntracked ? ', including untracked files' : ' (tracked only)'}.`,
  };
}

/** What a stash contains. Read-only; reuses the same name-status/numstat parsers. */
export async function stashDetail(cwd, key, sha) {
  const repo = resolveRepo(cwd, key);
  if (!repo) return { ok: false, error: 'That repository is not one of the detected repositories.' };
  const found = await resolveStash(cwd, key, sha);
  if (found.error) return { ok: false, error: found.error };
  const s = found.stash;

  const opts = s.hasUntracked ? ['--include-untracked'] : [];
  const [names, nums] = await Promise.all([
    run('git', ['--no-optional-locks', '-C', repo.dir, 'stash', 'show', ...opts, '--name-status', '-z', '-M', s.sha], { timeout: 30000 }),
    run('git', ['--no-optional-locks', '-C', repo.dir, 'stash', 'show', ...opts, '--numstat', '-z', '-M', s.sha], { timeout: 30000 }),
  ]);
  if (!names.ok) return { ok: false, error: names.err.split('\n')[0].slice(0, 200) };

  const counts = parseNumstatZ(nums.out);
  const files = parseNameStatusZ(names.out).map((f) => ({ ...f, ...(counts.get(f.path) || { added: null, removed: null, binary: false }) }));
  return {
    ok: true,
    repo: { key: repo.key },
    stash: s,
    files,
    totals: { files: files.length, added: files.reduce((a, f) => a + (f.added || 0), 0), removed: files.reduce((a, f) => a + (f.removed || 0), 0) },
  };
}

/** The diff of one file inside a stash. */
export async function stashFileDiff(cwd, key, sha, filePath) {
  const repo = resolveRepo(cwd, key);
  if (!repo) return { ok: false, error: 'That repository is not one of the detected repositories.' };
  const found = await resolveStash(cwd, key, sha);
  if (found.error) return { ok: false, error: found.error };
  if (typeof filePath !== 'string' || !filePath) return { ok: false, error: 'No file was named.' };

  const detail = await stashDetail(cwd, key, sha);
  if (!detail.ok) return detail;
  const entry = detail.files.find((f) => f.path === filePath);
  if (!entry) return { ok: false, error: 'That file is not in this stash.' };

  // `git stash show` takes no pathspec - it reports "Too many revisions specified" and
  // treats the path as another revision. diff-tree against the stash's own parents is the
  // form that accepts one. A stash made with -u keeps its untracked files in a THIRD
  // parent, which the tracked diff (^1 vs the stash) cannot see at all, so that case is
  // diffed against the empty tree instead.
  const s = found.stash;
  const inUntracked = s.hasUntracked
    && (await run('git', ['--no-optional-locks', '-C', repo.dir, 'cat-file', '-e', `${s.sha}^3:${filePath}`], { timeout: 10000 })).ok;

  const range = inUntracked ? [EMPTY_TREE, `${s.sha}^3`] : [`${s.sha}^1`, s.sha];
  const r = await run('git', ['--no-optional-locks', '-C', repo.dir, 'diff-tree', '-p', '-M', '--no-color', '--no-commit-id',
    ...range, '--', filePath], { timeout: 30000 });
  if (!r.ok) return { ok: false, error: r.err.split('\n')[0].slice(0, 200) };
  if (entry.binary || /^Binary files /m.test(r.out)) {
    return { ok: true, repo: { key: repo.key }, path: filePath, entry, binary: true, hunks: [], added: 0, removed: 0, side: 'stash' };
  }
  return { ok: true, repo: { key: repo.key }, path: filePath, entry, binary: false, side: 'stash', comparedAgainst: 'the commit it was made from', ...parseUnified(r.out) };
}

/**
 * Apply a stash, optionally removing it afterwards (pop).
 *
 * Apply and pop are not interchangeable and are not pretended to be. A pop only removes
 * the stash when git itself removed it - if the apply conflicts, git keeps the stash, and
 * so do we. Nothing is dropped to tidy up after a failure.
 */
export async function applyStash(cwd, key, sha, { pop = false } = {}) {
  const repo = resolveRepo(cwd, key);
  if (!repo) return { ok: false, error: 'That repository is not one of the detected repositories.' };
  const refuse = allowed(cwd, 'stash', [pop ? 'pop' : 'apply']);
  if (refuse) return { ok: false, error: refuse };

  const found = await resolveStash(cwd, key, sha);
  if (found.error) return { ok: false, error: found.error };
  const s = found.stash;

  const r = await run('git', ['-C', repo.dir, 'stash', pop ? 'pop' : 'apply', s.ref], { timeout: 60000 });

  // Read everything back rather than inferring from the exit code: a conflicted pop exits
  // non-zero but HAS applied the changes and HAS kept the stash.
  const [after, files, conflicts] = await Promise.all([
    listStashes(cwd, key),
    changedFiles(cwd, key),
    conflictState(cwd, key),
  ]);
  const stillThere = after.ok && after.stashes.some((x) => x.sha === s.sha);
  const conflicted = files.ok ? files.counts.conflicted : 0;

  if (!r.ok) {
    return {
      ok: false,
      conflicted: conflicted > 0,
      stashKept: stillThere,
      error: conflicted
        ? `Applying that stash produced ${conflicted} conflict${conflicted === 1 ? '' : 's'}. `
          + `${stillThere ? 'The stash has been kept.' : 'The stash is gone - git removed it.'} Nothing was discarded.`
        : firstLine(r),
      detail: `${r.err || ''}`.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 5).join('\n'),
      stashes: after.ok ? after.stashes : [],
      files,
      conflicts,
    };
  }

  return {
    ok: true,
    popped: pop,
    removed: pop && !stillThere,
    stashKept: stillThere,
    message: pop
      ? (stillThere ? 'Applied, but git kept the stash - check the result before dropping it.' : 'Popped: applied and removed from the stash list.')
      : 'Applied. The stash is still in the list.',
    stashes: after.ok ? after.stashes : [],
    files,
    conflicts,
  };
}

/**
 * Drop one stash. Destructive, so it goes through the shared policy and needs a
 * confirmation that names the exact stash - and the index is resolved from the sha at the
 * last possible moment.
 */
export async function dropStash(cwd, key, sha, { confirmed = false } = {}) {
  const repo = resolveRepo(cwd, key);
  if (!repo) return { ok: false, error: 'That repository is not one of the detected repositories.' };

  const verdict = classify(cwd, 'stash', ['drop']);
  const found = await resolveStash(cwd, key, sha);
  if (found.error) return { ok: false, error: found.error };
  const s = found.stash;

  if (verdict.level === 'destructive' && !confirmed) {
    return {
      ok: false,
      needsConfirmation: true,
      reason: verdict.reason || 'Dropping a stash permanently deletes the work in it.',
      repoLabel: repo.nickname,
      stash: s,
    };
  }

  const r = await run('git', ['-C', repo.dir, 'stash', 'drop', s.ref], { timeout: 20000 });
  if (!r.ok) return { ok: false, error: firstLine(r) };

  const after = await listStashes(cwd, key);
  if (after.ok && after.stashes.some((x) => x.sha === s.sha)) {
    return { ok: false, error: 'git reported success but that stash is still in the list.' };
  }
  return { ok: true, dropped: s, stashes: after.ok ? after.stashes : [], message: `Dropped ${s.ref} (${s.message || 'no message'}).` };
}

// ---------------------------------------------------------------- conflicts
//
// Conflict state comes from git's index, never from looking for `<<<<<<<` in a file.
// Markers can be absent from a file git still considers unresolved (someone deleted them
// without staging), and present in a file git considers resolved (they were committed
// deliberately, or the file is about diff syntax). The index is the only authority; markers
// are reported alongside as a warning, nothing more.

const CONFLICT_MEANING = {
  DD: { label: 'both deleted', ours: 'deleted', theirs: 'deleted' },
  AU: { label: 'added by us', ours: 'added', theirs: 'missing' },
  UD: { label: 'deleted by them', ours: 'modified', theirs: 'deleted' },
  UA: { label: 'added by them', ours: 'missing', theirs: 'added' },
  DU: { label: 'deleted by us', ours: 'deleted', theirs: 'modified' },
  AA: { label: 'both added', ours: 'added', theirs: 'added' },
  UU: { label: 'both modified', ours: 'modified', theirs: 'modified' },
};

/** Which git operation, if any, is half-finished. Read from the repository's own state. */
export async function conflictState(cwd, key) {
  const repo = resolveRepo(cwd, key);
  if (!repo) return { ok: false, error: 'That repository is not one of the detected repositories.' };
  const git = (p) => path.join(repo.dir, '.git', p);
  const has = (p) => { try { return fs.existsSync(git(p)); } catch { return false; } };

  let operation = null;
  if (has('MERGE_HEAD')) operation = 'merge';
  else if (has('rebase-merge') || has('rebase-apply')) operation = 'rebase';
  else if (has('CHERRY_PICK_HEAD')) operation = 'cherry-pick';
  else if (has('REVERT_HEAD')) operation = 'revert';

  const listing = await changedFiles(cwd, key);
  const conflicted = listing.ok ? listing.files.filter((f) => f.conflicted) : [];

  return {
    ok: true,
    repo: { key: repo.key },
    operation,
    // During a rebase or cherry-pick "ours" is the commit being replayed ONTO, which is the
    // opposite of what most people assume. Say so rather than printing a bare label.
    sides: sidesFor(operation),
    count: conflicted.length,
    files: conflicted.map((f) => ({
      path: f.path,
      code: f.x + f.y,
      ...(CONFLICT_MEANING[f.x + f.y] || { label: 'conflicted', ours: 'unknown', theirs: 'unknown' }),
    })),
  };
}

function sidesFor(operation) {
  if (operation === 'rebase') {
    return {
      ours: 'the branch you are rebasing ONTO (not your own commits)',
      theirs: 'the commit of yours being replayed',
      warning: 'During a rebase these are the reverse of what most people expect.',
    };
  }
  if (operation === 'cherry-pick' || operation === 'revert') {
    return {
      ours: 'the branch you are on',
      theirs: `the commit being ${operation === 'revert' ? 'reverted' : 'picked'}`,
      warning: null,
    };
  }
  return {
    ours: 'the branch you are on',
    theirs: 'the branch being merged in',
    warning: null,
  };
}

const MARKERS = /^(<{7}|={7}|>{7})/m;

/**
 * The three stages of a conflicted file, straight from the index.
 *
 * `git ls-files -u -z` is the machine-safe listing: mode, sha, stage, then the path.
 * A missing stage means that side does not have the file - which is exactly what a
 * delete/modify conflict is, and must not be rendered as an empty file.
 */
/** The index's entries for a conflicted file: { '1': base sha, '2': ours, '3': theirs }, each only if that side has it. */
async function conflictStages(repoDir, filePath) {
  const ls = await run('git', ['--no-optional-locks', '-C', repoDir, 'ls-files', '-u', '-z', '--', filePath], { timeout: 15000 });
  const stages = {};
  for (const row of (ls.out || '').split('\0')) {
    const m = /^(\d+) ([0-9a-f]{40,64}) ([123])\t([\s\S]*)$/.exec(row);
    if (m) stages[m[3]] = m[2];
  }
  return stages;
}

/**
 * Write one blob to a file exactly as git holds it: git's output goes straight to a temp file
 * beside the target, never through a string and never all in memory, and the temp file takes
 * the target's place only once git has finished cleanly. A failure leaves the file as it was.
 */
function writeBlob(repoDir, sha, full) {
  return new Promise((resolve) => {
    const tmp = `${full}.jarvis-${process.pid}-${Date.now()}.tmp`;
    let fd;
    try {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fd = fs.openSync(tmp, 'wx');
    } catch (e) { resolve({ ok: false, error: String(e?.message || e) }); return; }
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
    delete env.ELECTRON_RUN_AS_NODE;
    let err = '';
    let settled = false;
    const done = (ok, error) => {
      if (settled) return;
      settled = true;
      try { fs.closeSync(fd); } catch { /* already closed */ }
      if (ok) {
        try { fs.renameSync(tmp, full); resolve({ ok: true }); return; } catch (e) { error = String(e?.message || e); }
      }
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to remove */ }
      resolve({ ok: false, error: error || 'git could not read that version of the file.' });
    };
    let child;
    try { child = spawn('git', ['--no-optional-locks', '-C', repoDir, 'cat-file', 'blob', sha], { stdio: ['ignore', fd, 'pipe'], windowsHide: true, env }); }
    catch (e) { done(false, String(e?.message || e)); return; }
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('error', (e) => done(false, String(e?.message || e)));
    child.on('close', (code) => done(code === 0, code === 0 ? null : (err.trim().split('\n')[0] || `git ended with code ${code}`)));
  });
}

export async function conflictDetail(cwd, key, filePath) {
  const repo = resolveRepo(cwd, key);
  if (!repo) return { ok: false, error: 'That repository is not one of the detected repositories.' };
  if (typeof filePath !== 'string' || !filePath) return { ok: false, error: 'No file was named.' };

  const state = await conflictState(cwd, key);
  if (!state.ok) return state;
  const entry = state.files.find((f) => f.path === filePath);
  if (!entry) return { ok: false, error: 'That file is not conflicted according to git.' };

  const stages = await conflictStages(repo.dir, filePath);

  // For SHOWING only. null means that side does not have the file - and nothing else: a side
  // that is there but cannot be shown (larger than one read, or not text) must never be taken
  // for a deleted one. It once was, and "Accept theirs" then removed a 9 MB file.
  const read = async (sha) => {
    if (!sha) return null;
    const r = await run('git', ['--no-optional-locks', '-C', repo.dir, 'cat-file', 'blob', sha], { timeout: 20000 });
    if (!r.ok) return { text: '', lines: 0, binary: true, note: 'This side has the file, but it is too large to show here. Accepting it still takes the whole file, byte for byte.' };
    const text = r.out;
    const binary = text.includes('\0');
    return { text, lines: text.split('\n').length, binary, ...(binary ? { note: 'A binary file - not shown as text. Accepting it takes the file exactly as that side has it.' } : {}) };
  };
  const [base, ours, theirs] = await Promise.all([read(stages['1']), read(stages['2']), read(stages['3'])]);

  let working = null;
  try { working = fs.readFileSync(path.join(repo.dir, filePath), 'utf8'); } catch { /* deleted in the tree */ }

  return {
    ok: true,
    repo: { key: repo.key },
    path: filePath,
    conflict: entry,
    operation: state.operation,
    sides: state.sides,
    base,
    ours,
    theirs,
    working,
    // An extra signal only. Git's index decides whether this is resolved, not these.
    markersPresent: working ? MARKERS.test(working) : false,
  };
}

/**
 * Resolve a conflict the way the user chose.
 *
 * `ours` / `theirs` write that stage's content and stage it. Note this does NOT use
 * `git checkout --ours`, which the risk policy rightly classes as destructive because it
 * overwrites a working file from git; writing the chosen stage and staging it reaches the
 * same place without ever running a destructive command.
 *
 * `resolved` stages whatever is in the working tree. Nothing here decides for the user,
 * and nothing is marked resolved because its conflict markers happen to have gone.
 */
export async function resolveConflict(cwd, key, filePath, choice) {
  const repo = resolveRepo(cwd, key);
  if (!repo) return { ok: false, error: 'That repository is not one of the detected repositories.' };
  if (!['ours', 'theirs', 'resolved'].includes(choice)) return { ok: false, error: 'Unknown resolution.' };

  const detail = await conflictDetail(cwd, key, filePath);
  if (!detail.ok) return detail;

  const full = path.join(repo.dir, filePath);
  if (choice === 'ours' || choice === 'theirs') {
    // Decided from git's index, not from the text read for display: only a side with no
    // entry there deleted the file.
    const sha = (await conflictStages(repo.dir, filePath))[choice === 'ours' ? '2' : '3'];
    if (!sha) {
      // That side deleted the file; taking it means removing the file.
      const rm = await run('git', ['-C', repo.dir, 'rm', '-q', '--', filePath], { timeout: 20000 });
      if (!rm.ok) return { ok: false, error: firstLine(rm) };
    } else {
      // The bytes git holds, straight into the file. They used to pass through a string, which
      // rewrote every byte that is not UTF-8: an image, or a Latin-1 source file, came out
      // corrupted and was staged that way.
      const wrote = await writeBlob(repo.dir, sha, full);
      if (!wrote.ok) return { ok: false, error: `Could not write that file: ${wrote.error}` };
      const add = await run('git', ['-C', repo.dir, 'add', '--', filePath], { timeout: 20000 });
      if (!add.ok) return { ok: false, error: firstLine(add) };
    }
  } else {
    const add = await run('git', ['-C', repo.dir, 'add', '--', filePath], { timeout: 20000 });
    if (!add.ok) return { ok: false, error: firstLine(add) };
  }

  // Only git can say it is resolved.
  const after = await conflictState(cwd, key);
  const still = after.ok && after.files.some((f) => f.path === filePath);
  if (still) return { ok: false, error: 'git still reports that file as conflicted.', conflicts: after };
  return {
    ok: true,
    path: filePath,
    choice,
    message: `${filePath} marked resolved${choice === 'resolved' ? '' : ` by taking ${choice}`}. git confirms it.`,
    conflicts: after,
    files: await changedFiles(cwd, key),
  };
}

// ---------------------------------------------------------------- history
//
// Local refs and objects only; nothing here contacts a remote, and no model is involved.
//
// Lazily, in three steps, because a repository here can hold thousands of commits:
//   a page of summaries  ->  one commit's detail when it is selected  ->  one file's diff
//                            when that is selected.
// Nothing computes a diff for a commit nobody has opened.
//
// Every listing uses `-z` and %x1f field separators rather than git's human output.
// Parsing the readable format breaks on the first path containing a space, a quote or a
// newline, and a rename is two paths where everything else is one.

// git's empty tree. Diffing against it is how a root commit, or the untracked parent of a
// stash, is compared with "nothing" without inventing a special case for either.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const REC = '\x1e';    // between commits
const HISTORY_PAGE = 50;

/** One page of commit summaries. `search` is handed to git, never filtered in JavaScript. */
export async function commitHistory(cwd, key, { skip = 0, limit = HISTORY_PAGE, search = '' } = {}) {
  const repo = resolveRepo(cwd, key);
  if (!repo) return { ok: false, error: 'That repository is not one of the detected repositories.' };

  const n = Math.max(1, Math.min(200, Number(limit) || HISTORY_PAGE));
  const from = Math.max(0, Number(skip) || 0);
  const fmt = ['%H', '%h', '%s', '%an', '%ae', '%aI', '%P', '%D'].join(UNIT) + REC;
  const base = ['--no-optional-locks', '-C', repo.dir, 'log', `--format=${fmt}`, '--skip=' + from, '-n', String(n)];

  const q = String(search || '').trim();
  let out = '';
  let total = null;

  if (!q) {
    const r = await run('git', base, { timeout: 30000 });
    if (!r.ok) {
      // A repository with no commits is not an error, it is an empty history.
      if (/does not have any commits|unknown revision/i.test(r.err)) return { ok: true, repo: { key: repo.key }, commits: [], done: true, empty: true };
      return { ok: false, error: r.err.split('\n')[0].slice(0, 200) };
    }
    out = r.out;
  } else {
    // Let git do the searching. Summary/body and author are separate git options that it
    // ANDs together, so they are two queries merged here - still git-side filtering, never
    // "read the whole history into JavaScript and grep it".
    const looksSha = /^[0-9a-f]{4,40}$/i.test(q);
    const seen = new Map();
    const collect = (text) => {
      for (const block of text.split(REC)) {
        const line = block.replace(/^[\r\n]+/, '');
        if (!line.trim()) continue;
        const sha = line.split(UNIT)[0];
        if (sha && !seen.has(sha)) seen.set(sha, line);
      }
    };
    if (looksSha) {
      const one = await run('git', ['--no-optional-locks', '-C', repo.dir, 'log', `--format=${fmt}`, '-n', '1', q], { timeout: 15000 });
      if (one.ok) collect(one.out);
    }
    for (const opt of [`--grep=${q}`, `--author=${q}`]) {
      const r = await run('git', [...base, '--regexp-ignore-case', '--fixed-strings', opt], { timeout: 30000 });
      if (r.ok) collect(r.out);
    }
    out = [...seen.values()].join(REC) + REC;
    total = seen.size;
  }

  const commits = [];
  for (const block of out.split(REC)) {
    const line = block.replace(/^[\r\n]+/, '');
    if (!line.trim()) continue;
    const [sha, short, summary, author, email, when, parents, decorations] = line.split(UNIT);
    if (!sha) continue;
    const parentList = (parents || '').trim().split(/\s+/).filter(Boolean);
    commits.push({
      sha,
      short,
      summary: summary || '(no message)',
      author: author || '',
      email: email || '',
      when: when || '',
      parents: parentList,
      merge: parentList.length > 1,
      refs: parseDecorations(decorations),
    });
  }

  return {
    ok: true,
    repo: { key: repo.key },
    commits,
    skip: from,
    // Only a full page suggests there may be more; a short page is the end.
    done: q ? true : commits.length < n,
    searched: q || null,
    total,
  };
}

/** `%D` gives "HEAD -> main, origin/main, tag: v1.0". All local refs; nothing is fetched. */
function parseDecorations(d) {
  const refs = [];
  for (const raw of String(d || '').split(',')) {
    const t = raw.trim();
    if (!t) continue;
    if (t.startsWith('tag: ')) refs.push({ kind: 'tag', name: t.slice(5) });
    else if (t.startsWith('HEAD -> ')) refs.push({ kind: 'head', name: t.slice(8) });
    else if (t === 'HEAD') refs.push({ kind: 'head', name: 'HEAD' });
    else if (t.includes('/')) refs.push({ kind: 'remote', name: t });
    else refs.push({ kind: 'branch', name: t });
  }
  return refs;
}

/** Parse `--name-status -z`: a status field, then one path, or two for a rename/copy. */
function parseNameStatusZ(out) {
  const files = [];
  const parts = String(out || '').split('\0');
  for (let i = 0; i < parts.length; i += 1) {
    const code = parts[i];
    if (!code || !/^[A-Z]\d*$/.test(code)) continue;
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      const from = parts[i + 1];
      const to = parts[i + 2];
      i += 2;
      if (!to) continue;
      files.push({ path: to, renamedFrom: from || null, status: letter === 'R' ? 'renamed' : 'copied', score: Number(code.slice(1)) || null });
    } else {
      const p = parts[i + 1];
      i += 1;
      if (!p) continue;
      files.push({ path: p, renamedFrom: null, status: LETTER[letter] || 'modified' });
    }
  }
  return files;
}

/** Parse `--numstat -z`: additions, deletions, then path (or old+new for a rename). */
function parseNumstatZ(out) {
  const counts = new Map();
  const parts = String(out || '').split('\0');
  for (let i = 0; i < parts.length; i += 1) {
    const row = parts[i];
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(row || '');
    if (!m) continue;
    const added = m[1] === '-' ? null : Number(m[1]);
    const removed = m[2] === '-' ? null : Number(m[2]);
    let p = m[3];
    // A rename in -z numstat leaves the path empty and puts old and new in the next fields.
    if (p === '') { const to = parts[i + 2]; p = to || parts[i + 1] || ''; i += 2; }
    if (p) counts.set(p, { added, removed, binary: added === null });
  }
  return counts;
}

/**
 * One commit in full: metadata, parents, and the files it changed.
 *
 * `--root` lets a root commit be diffed against the empty tree, which is what it actually
 * is. A merge is NOT given a pretend single diff: it is reported as a merge, and what is
 * shown is explicitly the comparison against its FIRST parent, labelled as such.
 */
export async function commitDetail(cwd, key, sha) {
  const repo = resolveRepo(cwd, key);
  if (!repo) return { ok: false, error: 'That repository is not one of the detected repositories.' };
  if (!/^[0-9a-f]{4,40}$/i.test(String(sha || ''))) return { ok: false, error: 'That is not a commit id.' };

  const fmt = ['%H', '%h', '%s', '%b', '%an', '%ae', '%aI', '%cn', '%cI', '%P', '%D'].join(UNIT);
  const meta = await run('git', ['--no-optional-locks', '-C', repo.dir, 'show', '-s', `--format=${fmt}`, sha], { timeout: 15000 });
  if (!meta.ok) return { ok: false, error: meta.err.split('\n')[0].slice(0, 200) };

  const [full, short, summary, body, author, email, authored, committer, committed, parents, decorations] = meta.out.split(UNIT);
  const parentList = (parents || '').trim().split(/\s+/).filter(Boolean);
  const merge = parentList.length > 1;
  const root = parentList.length === 0;

  // diff-tree rather than `show`: it takes -z, and on a merge `show` prints nothing at all
  // by default, which would look like "this commit changed no files".
  const range = merge ? [`${sha}^1`, sha] : ['--root', sha];
  const [names, nums] = await Promise.all([
    run('git', ['--no-optional-locks', '-C', repo.dir, 'diff-tree', '-r', '-M', '-C', '--name-status', '-z', '--no-commit-id', ...range], { timeout: 30000 }),
    run('git', ['--no-optional-locks', '-C', repo.dir, 'diff-tree', '-r', '-M', '--numstat', '-z', '--no-commit-id', ...range], { timeout: 30000 }),
  ]);
  if (!names.ok) return { ok: false, error: names.err.split('\n')[0].slice(0, 200) };

  const counts = parseNumstatZ(nums.out);
  const files = parseNameStatusZ(names.out).map((f) => ({ ...f, ...(counts.get(f.path) || { added: null, removed: null, binary: false }) }));

  return {
    ok: true,
    repo: { key: repo.key },
    commit: {
      sha: full,
      short,
      summary: summary || '(no message)',
      body: (body || '').trim(),
      author,
      email,
      authored,
      committer,
      committed,
      parents: parentList,
      merge,
      root,
      refs: parseDecorations(decorations),
    },
    files,
    totals: {
      files: files.length,
      added: files.reduce((a, f) => a + (f.added || 0), 0),
      removed: files.reduce((a, f) => a + (f.removed || 0), 0),
    },
    // Said plainly rather than quietly assumed, so the window can label it.
    comparedAgainst: merge ? 'first parent' : (root ? 'the empty tree' : 'its parent'),
  };
}

/** The diff of one file in one commit. Reuses the Phase 2 unified-diff parser. */
export async function commitFileDiff(cwd, key, sha, filePath) {
  const repo = resolveRepo(cwd, key);
  if (!repo) return { ok: false, error: 'That repository is not one of the detected repositories.' };
  if (!/^[0-9a-f]{4,40}$/i.test(String(sha || ''))) return { ok: false, error: 'That is not a commit id.' };
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) return { ok: false, error: 'No file was named.' };

  const detail = await commitDetail(cwd, key, sha);
  if (!detail.ok) return detail;
  const entry = detail.files.find((f) => f.path === filePath);
  if (!entry) return { ok: false, error: 'That file is not among this commit\'s changes.' };

  const range = detail.commit.merge ? [`${sha}^1`, sha] : ['--root', sha];
  const r = await run('git', ['--no-optional-locks', '-C', repo.dir, 'diff-tree', '-p', '-M', '--no-color', '--no-commit-id',
    ...range, '--', ...(entry.renamedFrom ? [entry.renamedFrom, filePath] : [filePath])], { timeout: 30000 });
  if (!r.ok) return { ok: false, error: r.err.split('\n')[0].slice(0, 200) };

  if (entry.binary || /^Binary files /m.test(r.out)) {
    return { ok: true, repo: { key: repo.key }, sha, path: filePath, entry, binary: true, hunks: [], added: 0, removed: 0, side: 'commit' };
  }
  return {
    ok: true,
    repo: { key: repo.key },
    sha,
    path: filePath,
    entry,
    binary: false,
    side: 'commit',
    comparedAgainst: detail.comparedAgainst,
    ...parseUnified(r.out),
  };
}

// ---------------------------------------------------------------- remote operations
//
// THE ONLY CODE IN THIS APPLICATION THAT TOUCHES A NETWORK.
//
// Nothing here runs on its own. There is no timer, no startup hook, no "refresh also
// fetches", and no push after a commit. Every function below runs because a person clicked
// the button or asked for it in words, and the rest of Source Control is built so that it
// never needs to.
//
// Force is not reachable from here. No function adds `--force`, `-f` or
// `--force-with-lease` under any circumstance, including as a retry after a rejection: a
// rejected push stays rejected and is handed back with git's reason.

/** What each repository is doing remotely. Keyed by directory, so two repos are independent. */
const remoteOps = new Map(); // dir -> { op, key, controller, child, startedAt }

export const REMOTE_IDLE = 'idle';

/** The remote state of one repository, for the window to render. */
export function remoteState(cwd, key) {
  const repo = resolveRepo(cwd, key);
  if (!repo) return { ok: false, error: 'That repository is not one of the detected repositories.' };
  const live = remoteOps.get(repo.dir);
  return {
    ok: true,
    repo: { key: repo.key },
    state: live ? live.op : REMOTE_IDLE,
    since: live ? live.startedAt : null,
    cancellable: !!live && live.op !== 'cancelling',
  };
}

/**
 * Stop every remote operation still running - on quit, or before a restart into another
 * workspace, so no fetch or push carries on against the folder JARVIS just left.
 */
export function cancelAllRemotes() {
  let n = 0;
  for (const live of remoteOps.values()) {
    live.op = 'cancelling';
    try { live.controller.abort(); } catch { /* already finished */ }
    killTree(live.child);
    n += 1;
  }
  return n;
}

/** How many repositories have a fetch, pull or push in flight right now - for the "what would stop" warnings. */
export function runningRemotes() {
  return remoteOps.size;
}

/** Stop the remote operation running for one repository. Never reported as success. */
export function cancelRemote(cwd, key) {
  const repo = resolveRepo(cwd, key);
  if (!repo) return { ok: false, error: 'That repository is not one of the detected repositories.' };
  const live = remoteOps.get(repo.dir);
  if (!live) return { ok: false, error: 'Nothing is running for that repository.' };
  live.op = 'cancelling';
  try { live.controller.abort(); } catch { /* already finished */ }
  killTree(live.child);
  return { ok: true, cancelling: true };
}

/**
 * The shared shape of every remote operation.
 *
 * `key` is captured once, here, and every later step resolves it again rather than reading
 * whatever is selected now. A push started for one repository finishes as a push for that
 * repository even if the window has moved to another - the result carries the key it began with,
 * and the window drops a result that is not for the repository it is showing.
 */
async function remoteOp(cwd, key, op, build, { onProgress } = {}) {
  const repo = resolveRepo(cwd, key);
  if (!repo) return { ok: false, key, error: 'That repository is not one of the detected repositories.' };

  if (remoteOps.has(repo.dir)) {
    const live = remoteOps.get(repo.dir);
    return { ok: false, key: repo.key, busy: true, error: `That repository is already ${live.op}. Wait for it to finish, or stop it.` };
  }

  const controller = new AbortController();
  const entry = { op, key: repo.key, controller, child: null, startedAt: Date.now() };
  remoteOps.set(repo.dir, entry);
  const say = (message) => { try { onProgress?.({ key: repo.key, state: op, message }); } catch { /* reporting must not break it */ } };
  say(`${op} started`);

  try {
    const result = await build({
      repo,
      say,
      exec: (args, timeout = 180000) => run('git', ['-C', repo.dir, ...args], {
        timeout,
        signal: controller.signal,
        onChild: (c) => { entry.child = c; },
        onLine: (line) => { if (!/^(remote: )?$/.test(line)) say(line.slice(0, 160)); },
      }),
    });
    return { ...result, key: repo.key };
  } finally {
    remoteOps.delete(repo.dir);
    try { onProgress?.({ key: repo.key, state: REMOTE_IDLE, message: null }); } catch { /* ignore */ }
  }
}

/** Turn a finished `run()` into a failure the window can show honestly. */
function remoteFailure(r, what) {
  if (r.cancelled) return { ok: false, cancelled: true, error: `${what} was stopped before it finished.` };
  if (r.timedOut) return { ok: false, timedOut: true, error: `${what} took too long and was stopped. Nothing was completed.` };
  const lines = `${r.err || ''}\n${r.out || ''}`.split('\n').map((l) => l.trim()).filter(Boolean);
  const auth = lines.find((l) => /authentication|could not read Username|Permission denied|403|terminal prompts disabled|Invalid username or password/i.test(l));
  if (auth) {
    return {
      ok: false,
      auth: true,
      error: 'The remote refused the credentials. Git Credential Manager handles sign-in; re-authenticate there and try again.',
      detail: lines.slice(0, 5).join('\n'),
    };
  }
  return { ok: false, error: lines[0] || `${what} failed without saying why.`, detail: lines.slice(0, 6).join('\n') };
}

/** The remote-tracking refs as they stand on disk, for before/after comparison. */
async function trackingRefs(dir) {
  const r = await run('git', ['--no-optional-locks', '-C', dir, 'for-each-ref', '--format=%(refname)%1f%(objectname)', 'refs/remotes'], { timeout: 15000 });
  const map = new Map();
  if (r.ok) for (const line of r.out.split(/\r?\n/)) { const [n, o] = line.split('\x1f'); if (n) map.set(n, o); }
  return map;
}

/** Fetch. Explicit only. Updates what we know about the remote; changes no working file. */
export async function fetchRemote(cwd, key, { remote = 'origin', onProgress } = {}) {
  const refuse = allowed(cwd, 'fetch', []);
  if (refuse) return { ok: false, error: refuse };

  return remoteOp(cwd, key, 'fetching', async ({ repo, say, exec }) => {
    const before = await trackingRefs(repo.dir);
    say(`Fetching ${remote}…`);
    const r = await exec(['fetch', '--prune', remote]);
    if (!r.ok) return remoteFailure(r, 'The fetch');

    // Verify by looking, not by trusting the exit code.
    const after = await trackingRefs(repo.dir);
    const changed = [];
    for (const [name, sha] of after) if (before.get(name) !== sha) changed.push(name.replace('refs/remotes/', ''));
    for (const name of before.keys()) if (!after.has(name)) changed.push(`${name.replace('refs/remotes/', '')} (gone)`);

    return {
      ok: true,
      op: 'fetch',
      remote,
      changed,
      message: changed.length ? `Fetched ${remote}. Updated: ${changed.slice(0, 6).join(', ')}` : `Fetched ${remote}. Nothing new.`,
      branches: await listBranches(cwd, key),
    };
  }, { onProgress });
}

/**
 * The message for a pull that was stopped after it had already started merging or rebasing -
 * `conflict` is conflictState()'s result, read right after the cancellation. `git pull` is a
 * fetch followed by a merge or rebase in the SAME process, so stopping it (power-down, or
 * Stop pressed by hand) can land between the two, leaving the repository exactly as an
 * ordinary conflicted pull would: MERGE_HEAD or a rebase in progress, maybe conflict markers.
 * Pure, so the wording can be checked without racing a real cancellation against a real
 * merge. Returns null when nothing was left mid-operation - an ordinary cancelled fetch.
 */
export function interruptedPullMessage(conflict) {
  if (!conflict?.ok || !conflict.operation) return null;
  const VERBING = { merge: 'merging', rebase: 'rebasing', 'cherry-pick': 'cherry-picking', revert: 'reverting' };
  const verb = VERBING[conflict.operation] || conflict.operation;
  const files = conflict.count ? ` with ${conflict.count} conflicted file${conflict.count === 1 ? '' : 's'}` : '';
  return `The pull was stopped, but not before it started ${verb} - this repository now has an unfinished ${conflict.operation}${files}. `
    + `Resolve it in Source Control's Conflicts tab, or finish or abort the ${conflict.operation} in git yourself. JARVIS will not do either of those on its own.`;
}

/**
 * Pull. Explicit only.
 *
 * Nothing is stashed, committed, discarded, reset or forced to make it work, and no merge
 * strategy is chosen on the user's behalf - whatever the repository is configured to do is
 * what happens. When git stops to ask which it should be, that question is passed on
 * rather than answered here.
 */
export async function pullRemote(cwd, key, { onProgress } = {}) {
  const refuse = allowed(cwd, 'pull', []);
  if (refuse) return { ok: false, error: refuse };

  return remoteOp(cwd, key, 'pulling', async ({ repo, say, exec }) => {
    const branches = await listBranches(cwd, key);
    if (!branches.ok) return branches;
    if (branches.detached) return { ok: false, error: 'You are on a detached HEAD. Switch to a branch before pulling.' };
    const here = branches.local.find((b) => b.name === branches.current);
    if (!here?.upstream) return { ok: false, error: `${branches.current} has no upstream to pull from. Publish it first.` };

    const headBefore = (await run('git', ['--no-optional-locks', '-C', repo.dir, 'rev-parse', 'HEAD'], { timeout: 8000 })).out.trim();
    say(`Pulling ${here.upstream}…`);
    const r = await exec(['pull']);

    if (!r.ok) {
      const f = remoteFailure(r, 'The pull');
      if (r.cancelled) {
        // `git pull` is a fetch followed by a merge or rebase IN THE SAME PROCESS - stopping
        // it (power-down, or Stop pressed by hand) can land between the two, after the merge
        // or rebase has already begun. That leaves the repository exactly as an ordinary
        // conflicted pull would: MERGE_HEAD or a rebase in progress, maybe conflict markers.
        // Nothing here resets, aborts or finishes it - that stays the person's call, same as
        // any other conflict - this only says plainly that it happened.
        const left = await conflictState(cwd, key);
        const msg = interruptedPullMessage(left);
        if (msg) { f.interruptedMerge = left.operation; f.error = msg; }
        return f;
      }
      const text = `${r.err}${r.out}`;
      // git asks for a strategy when the branches have diverged and none is configured.
      if (/need to specify how to reconcile|divergent branches|pull\.rebase/i.test(text)) {
        f.needsStrategy = true;
        f.error = 'The branches have diverged and this repository has no pull strategy configured. '
          + 'Choose merge or rebase in git config yourself - JARVIS will not pick one for you.';
      }
      return f;
    }

    const headAfter = (await run('git', ['--no-optional-locks', '-C', repo.dir, 'rev-parse', 'HEAD'], { timeout: 8000 })).out.trim();
    const after = await listBranches(cwd, key);
    const moved = headBefore !== headAfter;
    return {
      ok: true,
      op: 'pull',
      moved,
      from: headBefore.slice(0, 10),
      to: headAfter.slice(0, 10),
      message: moved ? `Pulled ${here.upstream}. Now at ${headAfter.slice(0, 10)}.` : 'Already up to date.',
      branches: after,
      files: await changedFiles(cwd, key),
    };
  }, { onProgress });
}

/**
 * Push. Explicit only, and never forced.
 *
 * A non-fast-forward rejection is a result, not a problem to solve: this does not pull,
 * rebase, merge or re-run with a force flag to make it succeed.
 */
export async function pushRemote(cwd, key, { onProgress } = {}) {
  const refuse = allowed(cwd, 'push', []);
  if (refuse) return { ok: false, error: refuse };

  return remoteOp(cwd, key, 'pushing', async ({ repo, say, exec }) => {
    const branches = await listBranches(cwd, key);
    if (!branches.ok) return branches;
    if (branches.detached) return { ok: false, error: 'You are on a detached HEAD. Switch to a branch before pushing.' };
    const here = branches.local.find((b) => b.name === branches.current);
    if (!here?.upstream) return { ok: false, error: `${branches.current} has no upstream. Use Publish branch instead.`, needsPublish: true };
    if (!here.ahead) return { ok: true, op: 'push', nothingToDo: true, message: 'Nothing to push.', branches };

    const localSha = (await run('git', ['--no-optional-locks', '-C', repo.dir, 'rev-parse', 'HEAD'], { timeout: 8000 })).out.trim();
    say(`Pushing ${here.ahead} commit${here.ahead === 1 ? '' : 's'}…`);
    const r = await exec(['push']);

    if (!r.ok) {
      const f = remoteFailure(r, 'The push');
      if (/non-fast-forward|fetch first|rejected/i.test(`${r.err}${r.out}`)) {
        f.rejected = true;
        f.error = 'The remote rejected this push because it has commits you do not have. '
          + 'Fetch and pull, decide how to reconcile, then push again. Nothing was forced.';
      }
      return f;
    }

    // Confirm from git: the upstream must now point at what we just pushed.
    const upstreamSha = (await run('git', ['--no-optional-locks', '-C', repo.dir, 'rev-parse', `${here.upstream}`], { timeout: 8000 })).out.trim();
    const after = await listBranches(cwd, key);
    const nowAhead = after.ok ? (after.local.find((b) => b.name === after.current)?.ahead ?? null) : null;
    if (upstreamSha && localSha && upstreamSha !== localSha) {
      return { ok: false, error: `git reported a successful push, but ${here.upstream} is not at your commit. Treat this as unverified.` };
    }
    return {
      ok: true,
      op: 'push',
      pushed: here.ahead,
      message: `Pushed ${here.ahead} commit${here.ahead === 1 ? '' : 's'} to ${here.upstream}.`,
      verifiedAhead: nowAhead,
      branches: after,
    };
  }, { onProgress });
}

/**
 * Publish the current branch: push it and set its upstream, in one explicit act.
 * Never triggered by creating a branch, switching to one, or committing.
 */
export async function publishBranch(cwd, key, { remote = 'origin', onProgress } = {}) {
  const refuse = allowed(cwd, 'push', []);
  if (refuse) return { ok: false, error: refuse };

  return remoteOp(cwd, key, 'publishing', async ({ repo, say, exec }) => {
    const branches = await listBranches(cwd, key);
    if (!branches.ok) return branches;
    if (branches.detached) return { ok: false, error: 'You are on a detached HEAD. Create a branch before publishing.' };
    const name = branches.current;
    const here = branches.local.find((b) => b.name === name);
    if (here?.upstream && !here.upstreamGone) {
      return { ok: false, error: `${name} is already published to ${here.upstream}. Use Push instead.` };
    }

    say(`Publishing ${name} to ${remote}…`);
    const r = await exec(['push', '--set-upstream', remote, name]);
    if (!r.ok) return remoteFailure(r, 'Publishing the branch');

    // Confirm the upstream really exists now; never infer it from the exit code.
    const up = await run('git', ['--no-optional-locks', '-C', repo.dir, 'rev-parse', '--abbrev-ref', `${name}@{upstream}`], { timeout: 8000 });
    if (!up.ok || !up.out.trim()) {
      return { ok: false, error: 'git reported success but the branch still has no upstream. Treat this as unverified.' };
    }
    return {
      ok: true,
      op: 'publish',
      branch: name,
      upstream: up.out.trim(),
      message: `Published ${name}. It now tracks ${up.out.trim()}.`,
      branches: await listBranches(cwd, key),
    };
  }, { onProgress });
}

/** An untracked file, shown as entirely new. */
function untrackedDiff(repo, entry) {
  const full = path.join(repo.dir, entry.path);
  let buf;
  try {
    const st = fs.statSync(full);
    if (st.isDirectory()) return { ok: false, error: 'That is a directory, not a file.' };
    if (st.size > MAX_UNTRACKED_BYTES) {
      return { ok: true, repo: { key: repo.key }, path: entry.path, entry, binary: false, tooLarge: true, hunks: [], added: 0, removed: 0, side: 'worktree' };
    }
    buf = fs.readFileSync(full);
  } catch (e) {
    return { ok: false, error: `Could not read that file: ${e?.message || e}` };
  }
  if (buf.includes(0)) {
    return { ok: true, repo: { key: repo.key }, path: entry.path, entry, binary: true, hunks: [], added: 0, removed: 0, side: 'worktree' };
  }

  const text = buf.toString('utf8').replace(/\n$/, '');
  const all = text.split('\n');
  const lines = all.slice(0, MAX_DIFF_LINES).map((t, i) => ({ t: '+', n: i + 1, text: t }));
  return {
    ok: true,
    repo: { key: repo.key },
    path: entry.path,
    entry,
    binary: false,
    side: 'worktree',
    hunks: [{ header: 'new file', lines }],
    added: lines.length,
    removed: 0,
    truncated: all.length > MAX_DIFF_LINES,
  };
}
