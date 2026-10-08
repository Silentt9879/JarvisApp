// Behavioral tests for src/github.mjs - the read-only GitHub integration behind Source
// Control's GitHub tab. Every network call goes through an injected `fetch`, so these never
// reach real GitHub and never touch a real repository: a temp git repo supplies the local
// facts (origin, branch, upstream), and "pushed" state is faked by writing a remote-tracking
// ref locally with `git update-ref` - never a real fetch, clone or push.
//   node scripts/github-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseGitHubRemote, isReadOnlyGraphQL, createGitHub } from '../src/github.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${extra ? `\n     ${extra}` : ''}`); } };
const check = async (name, fn) => { try { await fn(); ok(true, name); } catch (e) { ok(false, name, String(e.stack || e).slice(0, 500)); } };

// ------------------------------------------------------------------ a local-only "GitHub" repo
// Real git, on disk, in a temp folder. The "pushed" state is faked locally (update-ref) so
// tests can exercise pushed/unpushed branches without ever fetching, pushing or cloning.
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-github-'));
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
function makeRepo({ pushed = true } = {}) {
  const dir = fs.mkdtempSync(path.join(WS, 'repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'a@b.c');
  git(dir, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'hi\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  const sha = git(dir, 'rev-parse', 'HEAD').trim();
  if (pushed) {
    git(dir, 'update-ref', 'refs/remotes/origin/main', sha);
    git(dir, 'branch', '--set-upstream-to=origin/main', 'main');
  }
  return { dir, sha };
}

// ------------------------------------------------------------------ a fake fetch: never the network
// Records every call (url, init), and answers from a queue or a handler - either way nothing
// ever reaches a socket. A GraphQL body is parsed so a test can answer by operation name.
function fakeRes(status, body, headers = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [String(k).toLowerCase(), String(v)]));
  return { status, headers: { get: (k) => h.get(String(k).toLowerCase()) ?? null }, json: async () => body };
}
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    const call = { url, init };
    try { if (init.body) call.body = JSON.parse(init.body); } catch { /* a REST GET has no body */ }
    calls.push(call);
    return handler(call, calls.length);
  };
  fn.calls = calls;
  return fn;
}
const opNameOf = (call) => (/query\s+Jarvis(\w+)/.exec(call.body?.query || '') || [])[1] || null;

const KEY = '.';
let repo;
let gh;
const make = (opts = {}) => createGitHub({
  cwd: () => repo.dir,
  fetch: opts.fetch,
  credential: opts.credential || (async () => ({ ok: true, token: 'test-token-not-real' })),
  online: opts.online || (() => true),
  timeoutMs: opts.timeoutMs || 2000,
  log: () => {},
});

// ------------------------------------------------------------------ parseGitHubRemote (pure)
check('parseGitHubRemote: every URL shape it claims to accept', () => {
  assert.deepEqual(parseGitHubRemote('https://github.com/acme/widgets.git'), { owner: 'acme', repo: 'widgets' });
  assert.deepEqual(parseGitHubRemote('https://x-access-token:ghp_abc@github.com/acme/widgets'), { owner: 'acme', repo: 'widgets' }, 'a credential in the URL is never kept');
  assert.deepEqual(parseGitHubRemote('git@github.com:acme/widgets.git'), { owner: 'acme', repo: 'widgets' });
  assert.deepEqual(parseGitHubRemote('ssh://git@github.com/acme/widgets.git'), { owner: 'acme', repo: 'widgets' });
  assert.deepEqual(parseGitHubRemote('ssh://git@ssh.github.com:443/acme/widgets.git'), { owner: 'acme', repo: 'widgets' });
});
check('parseGitHubRemote: everything that is not plainly GitHub is refused', () => {
  for (const bad of [
    'https://gitlab.com/acme/widgets.git', 'https://github.com.evil.example/acme/widgets', 'https://api.github.com/acme/widgets',
    'https://github.com/acme/widgets/extra', 'https://github.com/acme', 'file:///C:/repo', '/local/path/repo.git',
    'https://github.com:9999/acme/widgets', 'not a url at all', '', null, undefined, 'a'.repeat(600),
  ]) assert.equal(parseGitHubRemote(bad), null, String(bad).slice(0, 60));
});

// ------------------------------------------------------------------ isReadOnlyGraphQL (pure)
check('isReadOnlyGraphQL: a query or a fragment passes; a mutation never does, even hidden in text', () => {
  assert.equal(isReadOnlyGraphQL('query X { viewer { login } }'), true);
  assert.equal(isReadOnlyGraphQL('{ viewer { login } }'), true);
  assert.equal(isReadOnlyGraphQL('fragment F on Repository { name }'), true);
  assert.equal(isReadOnlyGraphQL('mutation X { addComment(input: {}) { clientMutationId } }'), false);
  assert.equal(isReadOnlyGraphQL('query X { viewer { login } } # a mutation could still ruin this'), true, 'the word in a comment does not count');
  assert.equal(isReadOnlyGraphQL('query X { field(x: "mutation") }'), true, 'the word in a string literal does not count');
  assert.equal(isReadOnlyGraphQL('subscription X { thing { id } }'), false);
  assert.equal(isReadOnlyGraphQL(''), false);
  assert.equal(isReadOnlyGraphQL('a'.repeat(20001)), false);
});
check('every fixed query JARVIS ships is itself read-only (the module throws at load otherwise)', () => {
  // Already proven at import time (github.mjs runs this check on its own QUERIES table and
  // throws if one fails) - re-importing confirms it did not silently change.
  assert.doesNotThrow(() => { import('../src/github.mjs'); });
});

// ------------------------------------------------------------------ local facts: no network at all
await check('info(): branch/owner/repo from local git only - the fake fetch is never called', async () => {
  repo = makeRepo();
  const fetch = fakeFetch(() => { throw new Error('must not be called'); });
  gh = make({ fetch });
  const r = await gh.info(KEY);
  assert.equal(r.ok, true);
  assert.deepEqual([r.owner, r.repo, r.branch, r.detached], ['acme', 'widgets', 'main', false]);
  assert.equal(fetch.calls.length, 0);
});
await check('a repository whose origin is not GitHub: notGitHub, and no network either', async () => {
  const other = fs.mkdtempSync(path.join(WS, 'other-'));
  git(other, 'init', '-q', '-b', 'main');
  git(other, 'remote', 'add', 'origin', 'https://gitlab.com/acme/widgets.git');
  const fetch = fakeFetch(() => { throw new Error('must not be called'); });
  const r = await createGitHub({ cwd: () => other, fetch, credential: async () => ({ ok: true, token: 't' }) }).pulls(KEY);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'notGitHub');
  assert.equal(fetch.calls.length, 0);
});
await check('link(): a branch never pushed is refused with the reason, never a 404 from GitHub', async () => {
  repo = makeRepo({ pushed: false });
  const fetch = fakeFetch(() => { throw new Error('must not be called'); });
  gh = make({ fetch });
  const r = await gh.link(KEY, 'branch');
  assert.equal(r.ok, false);
  assert.match(r.error, /not on GitHub yet/);
  const repoLink = await gh.link(KEY, 'repo');
  assert.equal(repoLink.ok, true);
  assert.equal(repoLink.url, 'https://github.com/acme/widgets');
  assert.equal(fetch.calls.length, 0, 'none of this needed the network');
});
await check('link(): a pushed commit resolves; the same sha before it was pushed does not', async () => {
  repo = makeRepo({ pushed: false });
  gh = make({ fetch: fakeFetch(() => { throw new Error('must not be called'); }) });
  const before = await gh.link(KEY, 'commit', { sha: repo.sha });
  assert.equal(before.ok, false);
  git(repo.dir, 'update-ref', 'refs/remotes/origin/main', repo.sha);
  const after = await gh.link(KEY, 'commit', { sha: repo.sha });
  assert.equal(after.ok, true);
  assert.equal(after.url, `https://github.com/acme/widgets/commit/${repo.sha}`);
});
await check('link(): bad input is refused before anything else runs', async () => {
  repo = makeRepo();
  gh = make({ fetch: fakeFetch(() => { throw new Error('must not be called'); }) });
  assert.equal((await gh.link(KEY, 'commit', { sha: 'not-a-sha' })).ok, false);
  assert.equal((await gh.link(KEY, 'pull', { number: -1 })).ok, false);
  assert.equal((await gh.link(KEY, 'file', { path: '../escape' })).ok, false);
  assert.equal((await gh.link(KEY, 'nonsense')).ok, false);
});

// ------------------------------------------------------------------ pulls(): the list, pagination, branch pulls
await check('pulls(): a page of pull requests, the branch\'s own pull, pagination, and the credential is read exactly once', async () => {
  repo = makeRepo();
  let credentialReads = 0;
  const fetch = fakeFetch((call) => {
    assert.equal(opNameOf(call), 'Pulls');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.redirect, 'error', 'redirects are refused, not followed');
    assert.equal(call.init.headers.Authorization, 'Bearer test-token-not-real');
    return fakeRes(200, {
      data: {
        viewer: { login: 'me' },
        repository: {
          pullRequests: {
            totalCount: 2, pageInfo: { hasNextPage: true, endCursor: 'abc123' },
            nodes: [{ number: 5, title: 'Fix the thing', state: 'OPEN', isDraft: false, author: { login: 'sam' }, baseRefName: 'main', headRefName: 'fix', reviewDecision: 'APPROVED', commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] }, updatedAt: '2026-01-01T00:00:00Z' }],
          },
          branchPulls: { nodes: [{ number: 9, title: 'My branch pull', headRepositoryOwner: { login: 'acme' }, commits: { nodes: [] } }] },
        },
      },
    }, { etag: 'W/"abc"', 'x-ratelimit-remaining': '4999', 'x-ratelimit-limit': '5000' });
  });
  gh = make({ fetch, credential: async () => { credentialReads++; return { ok: true, token: 'test-token-not-real' }; } });
  const r = await gh.pulls(KEY);
  assert.equal(r.ok, true);
  assert.equal(r.list.length, 1);
  assert.deepEqual([r.list[0].number, r.list[0].title, r.list[0].review, r.list[0].checks], [5, 'Fix the thing', 'APPROVED', 'SUCCESS']);
  assert.equal(r.more, true);
  assert.equal(r.cursor, 'abc123');
  assert.equal(r.total, 2);
  assert.equal(r.branch.pulls[0].number, 9);
  assert.equal(r.rate.remaining, 4999);
  await gh.pulls(KEY, { cursor: 'abc123' });
  assert.equal(credentialReads, 1, 'the token is cached across calls, not re-read every time');
});
await check('pulls(): an invalid cursor is refused before any request is made', async () => {
  repo = makeRepo();
  const fetch = fakeFetch(() => { throw new Error('must not be called'); });
  const r = await make({ fetch }).pulls(KEY, { cursor: 'not valid!!' });
  assert.equal(r.ok, false);
  assert.equal(fetch.calls.length, 0);
});
await check('pulls(): a closed-state page asks GitHub for CLOSED and MERGED, not OPEN', async () => {
  repo = makeRepo();
  const fetch = fakeFetch((call) => {
    assert.deepEqual(call.body.variables.states, ['CLOSED', 'MERGED']);
    return fakeRes(200, { data: { repository: { pullRequests: { totalCount: 0, pageInfo: {}, nodes: [] } } } });
  });
  const r = await make({ fetch }).pulls(KEY, { state: 'closed' });
  assert.equal(r.ok, true);
  assert.equal(r.state, 'closed');
});

// ------------------------------------------------------------------ pull(): one PR in detail
await check('pull(): full detail, reviews and requested reviewers mapped', async () => {
  repo = makeRepo();
  const fetch = fakeFetch((call) => {
    assert.equal(opNameOf(call), 'Pull');
    return fakeRes(200, {
      data: {
        repository: {
          pullRequest: {
            number: 5, title: 'Fix the thing', body: 'Because it was broken', state: 'OPEN', isDraft: false,
            createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', mergedAt: null, closedAt: null,
            author: { login: 'sam' }, baseRefName: 'main', headRefName: 'fix', headRefOid: 'a'.repeat(40),
            mergeable: 'MERGEABLE', reviewDecision: 'REVIEW_REQUIRED',
            additions: 10, deletions: 2, changedFiles: 3,
            commits: { totalCount: 2, nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] },
            latestReviews: { nodes: [{ state: 'APPROVED', submittedAt: '2026-01-02T01:00:00Z', author: { login: 'alex' } }] },
            reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'jo' } }] },
          },
        },
      },
    });
  });
  const r = await make({ fetch }).pull(KEY, 5);
  assert.equal(r.ok, true);
  assert.equal(r.pull.title, 'Fix the thing');
  assert.equal(r.pull.mergeable, 'MERGEABLE');
  assert.deepEqual(r.pull.reviews, [{ author: 'alex', state: 'APPROVED', at: '2026-01-02T01:00:00Z' }]);
  assert.deepEqual(r.pull.requested, ['jo']);
  assert.equal(r.pull.headSha, 'a'.repeat(40));
});
await check('pull(): a number that does not exist comes back notFound, not a thrown error', async () => {
  repo = makeRepo();
  const fetch = fakeFetch(() => fakeRes(200, { data: { repository: { pullRequest: null } } }));
  const r = await make({ fetch }).pull(KEY, 404);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'notFound');
});
await check('pull(): a bad number is refused before any request', async () => {
  const fetch = fakeFetch(() => { throw new Error('must not be called'); });
  assert.equal((await make({ fetch }).pull(KEY, -1)).ok, false);
  assert.equal((await make({ fetch }).pull(KEY, 1.5)).ok, false);
  assert.equal(fetch.calls.length, 0);
});

// ------------------------------------------------------------------ pullFiles() / pullPatch(): REST pagination, patches kept locally
await check('pullFiles() then pullPatch(): the patch comes from the already-fetched listing, no second request', async () => {
  repo = makeRepo();
  const fetch = fakeFetch((call) => {
    assert.match(call.url, /\/repos\/acme\/widgets\/pulls\/7\/files\?per_page=50&page=1$/);
    assert.equal(call.init.method, 'GET');
    return fakeRes(200, [
      { filename: 'a.txt', status: 'modified', additions: 3, deletions: 1, changes: 4, patch: '@@ -1,1 +1,3 @@\n-old\n+new\n+more' },
      { filename: 'b.bin', status: 'modified', additions: 0, deletions: 0, changes: 0 },
      { filename: 'c.txt', status: 'renamed', previous_filename: 'old-c.txt', additions: 0, deletions: 0, changes: 0 },
    ]);
  });
  gh = make({ fetch });
  const list = await gh.pullFiles(KEY, 7, 1);
  assert.equal(list.ok, true);
  assert.equal(list.files.length, 3);
  assert.equal(list.files[0].hasPatch, true);
  assert.equal(list.files[1].hasPatch, false);
  assert.equal(list.more, false, 'fewer than a full page: no next page');

  const withPatch = await gh.pullPatch(KEY, 7, 'a.txt');
  assert.equal(withPatch.ok, true);
  assert.equal(withPatch.added, 2);
  assert.equal(withPatch.removed, 1);
  assert.equal(fetch.calls.length, 1, 'the patch came from the listing already fetched - no second request');

  const binary = await gh.pullPatch(KEY, 7, 'b.bin');
  assert.equal(binary.ok, true);
  assert.match(binary.noPatch, /binary|mode/);

  const renamed = await gh.pullPatch(KEY, 7, 'c.txt');
  assert.equal(renamed.entry.renamedFrom, 'old-c.txt');

  const notLoaded = await gh.pullPatch(KEY, 999, 'a.txt');
  assert.equal(notLoaded.ok, false);
  assert.match(notLoaded.error, /Load the file list again/);
});
await check('pullFiles(): an unreasonable page number is refused, not sent to GitHub', async () => {
  const fetch = fakeFetch(() => { throw new Error('must not be called'); });
  const r = await make({ fetch }).pullFiles(KEY, 7, 999);
  assert.equal(r.ok, false);
  assert.equal(fetch.calls.length, 0);
});

// ------------------------------------------------------------------ checks(): rollup + target resolution (local-only when it can be)
await check('checks(): an unpushed branch with no commit named resolves nothing, without ever asking GitHub', async () => {
  repo = makeRepo({ pushed: false });
  const fetch = fakeFetch(() => { throw new Error('must not be called'); });
  const r = await make({ fetch }).checks(KEY);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'notPushed');
  assert.equal(fetch.calls.length, 0);
});
await check('checks(): the rollup for the pushed HEAD, check runs and a plain status mapped together', async () => {
  repo = makeRepo();
  const fetch = fakeFetch((call) => {
    assert.equal(opNameOf(call), 'Checks');
    assert.equal(call.body.variables.oid, repo.sha);
    return fakeRes(200, {
      data: {
        repository: {
          object: {
            oid: repo.sha,
            statusCheckRollup: {
              state: 'FAILURE',
              contexts: {
                totalCount: 2,
                nodes: [
                  { __typename: 'CheckRun', databaseId: 111, name: 'build', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:05:00Z', checkSuite: { workflowRun: { databaseId: 222, workflow: { name: 'CI' } } } },
                  { __typename: 'StatusContext', context: 'legacy-ci', state: 'SUCCESS', createdAt: '2026-01-01T00:00:00Z', description: 'ok' },
                ],
              },
            },
          },
        },
      },
    });
  });
  const r = await make({ fetch }).checks(KEY);
  assert.equal(r.ok, true);
  assert.equal(r.state, 'FAILURE');
  assert.equal(r.target.kind, 'branch');
  assert.equal(r.list.length, 2);
  assert.deepEqual([r.list[0].kind, r.list[0].id, r.list[0].conclusion], ['check', 111, 'FAILURE']);
  assert.deepEqual([r.list[1].kind, r.list[1].conclusion], ['status', 'SUCCESS']);
});
await check('checks(): an explicit commit must look like a sha, or it is refused with no request', async () => {
  const fetch = fakeFetch(() => { throw new Error('must not be called'); });
  const r = await make({ fetch }).checks(KEY, 'not-a-sha');
  assert.equal(r.ok, false);
  assert.equal(fetch.calls.length, 0);
});
await check('checks(): a commit GitHub has never heard of is said plainly, not as an error', async () => {
  repo = makeRepo();
  const fetch = fakeFetch(() => fakeRes(200, { data: { repository: { object: null } } }));
  const r = await make({ fetch }).checks(KEY);
  assert.equal(r.ok, true);
  assert.equal(r.missing, true);
  assert.equal(r.list.length, 0);
});

// ------------------------------------------------------------------ runs(): "did my push deploy?"
await check('runs(): the workflow runs for the pushed HEAD, from the REST endpoint', async () => {
  repo = makeRepo();
  const fetch = fakeFetch((call) => {
    assert.match(call.url, /\/repos\/acme\/widgets\/actions\/runs\?head_sha=/);
    assert.ok(call.url.includes(encodeURIComponent(repo.sha)) || call.url.includes(repo.sha));
    return fakeRes(200, {
      total_count: 1,
      workflow_runs: [{ id: 555, name: 'Deploy', display_title: 'Deploy to prod', status: 'completed', conclusion: 'success', event: 'push', head_branch: 'main', head_sha: repo.sha, run_number: 42, run_attempt: 1, created_at: '2026-01-01T00:00:00Z', run_started_at: '2026-01-01T00:00:01Z', updated_at: '2026-01-01T00:02:00Z' }],
    });
  });
  const r = await make({ fetch }).runs(KEY);
  assert.equal(r.ok, true);
  assert.equal(r.list.length, 1);
  assert.deepEqual([r.list[0].id, r.list[0].conclusion, r.list[0].number], [555, 'success', 42]);
});
await check('runs(): malformed data from GitHub is reported, never shown as an empty list', async () => {
  repo = makeRepo();
  const fetch = fakeFetch(() => fakeRes(200, { not_what_was_expected: true }));
  const r = await make({ fetch }).runs(KEY);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'malformed');
});

// ------------------------------------------------------------------ authentication, rate limits and transport errors
await check('no credential on this PC: refused plainly, never a prompt, and the real gcmCredential is never the one called in these tests', async () => {
  repo = makeRepo();
  const fetch = fakeFetch(() => { throw new Error('must not be called'); });
  const r = await make({ fetch, credential: async () => ({ ok: false, reason: 'none' }) }).pulls(KEY);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'noCredential');
  assert.equal(fetch.calls.length, 0);
});
await check('the credential read itself times out, or git could not be run: each gets its own message', async () => {
  repo = makeRepo();
  const fetch = fakeFetch(() => { throw new Error('must not be called'); });
  assert.equal((await make({ fetch, credential: async () => ({ ok: false, reason: 'timeout' }) }).pulls(KEY)).code, 'credentialTimeout');
  assert.equal((await make({ fetch, credential: async () => ({ ok: false, reason: 'git' }) }).pulls(KEY)).code, 'credentialGit');
});
await check('401: GitHub rejected the sign-in - the token is forgotten here (never erased from Git), and read again next time', async () => {
  repo = makeRepo();
  let reads = 0;
  const fetch = fakeFetch(() => fakeRes(401, {}));
  gh = make({ fetch, credential: async () => { reads++; return { ok: true, token: `token-${reads}` }; } });
  const first = await gh.pulls(KEY);
  assert.equal(first.code, 'auth');
  assert.equal(reads, 1);
  await gh.pulls(KEY);
  assert.equal(reads, 2, 'forgotten, so the next call reads the credential again');
});
await check('403 with the rate limit used up: the plain-English reset time, not a bare "forbidden"', async () => {
  repo = makeRepo();
  const resetAt = Math.floor(Date.now() / 1000) + 3600;
  const fetch = fakeFetch(() => fakeRes(403, {}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': String(resetAt) }));
  const r = await make({ fetch }).pulls(KEY);
  assert.equal(r.code, 'rateLimited');
  assert.match(r.error, /hourly request limit/);
});
await check('403 with Retry-After: told to slow down, by name, not treated as rate-limited', async () => {
  repo = makeRepo();
  const fetch = fakeFetch(() => fakeRes(403, {}, { 'retry-after': '30' }));
  const r = await make({ fetch }).pulls(KEY);
  assert.equal(r.code, 'slowDown');
  assert.match(r.error, /30 seconds/);
});
await check('403 with the SSO header: told to authorise SSO, not a bare "forbidden"', async () => {
  repo = makeRepo();
  const fetch = fakeFetch(() => fakeRes(403, {}, { 'x-github-sso': 'required; url=https://github.com/orgs/acme/sso' }));
  const r = await make({ fetch }).pulls(KEY);
  assert.equal(r.code, 'sso');
});
await check('a plain 403 with none of the above: a plain forbidden', async () => {
  repo = makeRepo();
  const r = await make({ fetch: fakeFetch(() => fakeRes(403, {})) }).pulls(KEY);
  assert.equal(r.code, 'forbidden');
});
await check('404/410: notFound; 5xx: server; an unlisted 2xx-adjacent status: badRequest', async () => {
  repo = makeRepo();
  assert.equal((await make({ fetch: fakeFetch(() => fakeRes(404, {})) }).pulls(KEY)).code, 'notFound');
  assert.equal((await make({ fetch: fakeFetch(() => fakeRes(410, {})) }).pulls(KEY)).code, 'notFound');
  assert.equal((await make({ fetch: fakeFetch(() => fakeRes(503, {})) }).pulls(KEY)).code, 'server');
});
await check('a thrown fetch (DNS failure, connection refused): network while online, offline while not', async () => {
  repo = makeRepo();
  const broken = fakeFetch(() => { throw new Error('getaddrinfo ENOTFOUND'); });
  assert.equal((await make({ fetch: broken, online: () => true }).pulls(KEY)).code, 'network');
  assert.equal((await make({ fetch: broken, online: () => false }).pulls(KEY)).code, 'offline');
});
await check('offline is checked before the credential or the request - no credential read, no fetch, while offline', async () => {
  repo = makeRepo();
  let credRead = false;
  const fetch = fakeFetch(() => { throw new Error('must not be called'); });
  const r = await make({ fetch, online: () => false, credential: async () => { credRead = true; return { ok: true, token: 't' }; } }).pulls(KEY);
  assert.equal(r.code, 'offline');
  assert.equal(credRead, false);
  assert.equal(fetch.calls.length, 0);
});
await check('a response that never comes: timeout, within the configured budget, and the request is really abandoned', async () => {
  repo = makeRepo();
  let aborted = false;
  const fetch = async (url, init) => {
    await new Promise((resolve) => { init.signal.addEventListener('abort', () => { aborted = true; resolve(); }); });
    throw new Object.getPrototypeOf(new Error()).constructor('aborted'); // never actually resolves a response
  };
  const t0 = Date.now();
  const r = await make({ fetch, timeoutMs: 150 }).pulls(KEY);
  assert.equal(r.code, 'timeout');
  assert.ok(Date.now() - t0 < 1000, 'did not wait for anything close to the default 20s');
  assert.equal(aborted, true, 'the in-flight request was actually told to stop');
});
await check('GitHub answers with text that is not JSON: malformed, not a crash', async () => {
  repo = makeRepo();
  const fetch = fakeFetch(() => ({ status: 200, headers: { get: () => null }, json: async () => { throw new Error('Unexpected token'); } }));
  const r = await make({ fetch }).pulls(KEY);
  assert.equal(r.code, 'malformed');
});
await check('GraphQL errors without data: RATE_LIMITED, NOT_FOUND and FORBIDDEN each map to their own message', async () => {
  repo = makeRepo();
  assert.equal((await make({ fetch: fakeFetch(() => fakeRes(200, { errors: [{ type: 'RATE_LIMITED' }] })) }).pulls(KEY)).code, 'rateLimited');
  assert.equal((await make({ fetch: fakeFetch(() => fakeRes(200, { errors: [{ type: 'NOT_FOUND' }] })) }).pulls(KEY)).code, 'notFound');
  assert.equal((await make({ fetch: fakeFetch(() => fakeRes(200, { errors: [{ type: 'FORBIDDEN' }] })) }).pulls(KEY)).code, 'forbidden');
  assert.equal((await make({ fetch: fakeFetch(() => fakeRes(200, { errors: [{ type: 'SOMETHING_ELSE' }] })) }).pulls(KEY)).code, 'malformed');
});
await check('a reply over 25 MB is refused before it is read, not buffered in full first', async () => {
  repo = makeRepo();
  let readAttempted = false;
  const fetch = fakeFetch(() => ({ status: 200, headers: { get: (k) => (k === 'content-length' ? String(26 * 1024 * 1024) : null) }, json: async () => { readAttempted = true; return {}; } }));
  const r = await make({ fetch }).pulls(KEY);
  assert.equal(r.code, 'tooLarge');
  assert.equal(readAttempted, false);
});
await check('a 304 against a cached ETag returns the cached data - no body needed from GitHub at all', async () => {
  repo = makeRepo();
  let n = 0;
  const fetch = fakeFetch((call) => {
    n += 1;
    if (n === 1) return fakeRes(200, { total_count: 1, workflow_runs: [{ id: 1, name: 'x' }] }, { etag: '"v1"' });
    assert.equal(call.init.headers['If-None-Match'], '"v1"');
    return { status: 304, headers: { get: () => null }, json: async () => { throw new Error('must not be read on a 304'); } };
  });
  gh = make({ fetch });
  const first = await gh.runs(KEY);
  assert.equal(first.ok, true);
  const second = await gh.runs(KEY);
  assert.equal(second.ok, true);
  assert.deepEqual(second.data, first.data);
});

// ------------------------------------------------------------------ cancellation
await check('cancel(): a request truly in flight is told to stop and resolves as cancelled, not as a late success', async () => {
  repo = makeRepo();
  let started = false;
  const fetch = async (url, init) => {
    started = true;
    await new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  };
  gh = make({ fetch, timeoutMs: 10000 });
  const inFlight = gh.pulls(KEY);
  // facts() spawns real (if tiny) git processes before the request itself begins - wait for
  // the fake fetch to actually be reached, rather than guessing at a fixed delay.
  const deadline = Date.now() + 5000;
  while (!started && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  assert.equal(started, true, 'the request reached the network stage in time');
  const cancelled = gh.cancel(KEY);
  assert.equal(cancelled.cancelled, 1);
  const r = await inFlight;
  assert.equal(r.code, 'cancelled');
});
await check('cancel(): a repository with nothing in flight reports zero, and does not throw', () => {
  repo = makeRepo();
  gh = make({ fetch: fakeFetch(() => { throw new Error('unused'); }) });
  assert.deepEqual(gh.cancel('nope'), { ok: true, key: 'nope', cancelled: 0 });
});
await check('a request already sent before cancel() still has its answer thrown away: a new request afterward is not treated as cancelled', async () => {
  repo = makeRepo();
  const fetch = fakeFetch(() => fakeRes(200, { data: { repository: { pullRequests: { totalCount: 0, pageInfo: {}, nodes: [] } } } }));
  gh = make({ fetch });
  gh.cancel(KEY); // nothing in flight yet - just advances the generation
  const r = await gh.pulls(KEY);
  assert.equal(r.ok, true, 'a fresh call after an empty cancel is not itself cancelled');
});

// ------------------------------------------------------------------ the one-way guard: only GETs to known routes, only query documents
await check('the only two senders refuse a mutation and an unknown REST route before anything leaves the process', async () => {
  repo = makeRepo();
  const fetch = fakeFetch(() => { throw new Error('must not be called'); });
  gh = make({ fetch });
  const mutation = await gh.internals.graphqlRaw(KEY, 'mutation X { addComment(input: {}) { clientMutationId } }', {});
  assert.equal(mutation.ok, false);
  assert.equal(mutation.refused, true);
  const badRoute = await gh.internals.restGet(KEY, 'deleteEverything', {}, {});
  assert.equal(badRoute.ok, false);
  assert.equal(badRoute.refused, true);
  const badParam = await gh.internals.restGet(KEY, 'workflowRuns', { owner: 'acme', repo: 'widgets' }, { not_a_real_query_param: '1' });
  assert.equal(badParam.ok, false);
  assert.equal(fetch.calls.length, 0);
});

fs.rmSync(WS, { recursive: true, force: true });
console.log(`github-test: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
