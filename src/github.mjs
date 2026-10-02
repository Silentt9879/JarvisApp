// GitHub - read-only GitHub data for Source Control (P-009 Phase 9).
//
// git.mjs is normal git; this module is everything GitHub-specific, and it only READS. The
// dependency runs one way: this file reads repository facts through git and `run()`, and
// git.mjs never imports it - so staging, commits, branches, stashes, history and fetch /
// pull / push work exactly as before when GitHub is offline, slow, rate-limited or refuses us.
//
// Rules this file enforces, rather than merely follows:
//  - Nothing here runs unless the user opened the GitHub view, pressed Refresh, Load more or
//    Check, or chose a pull request or a file. No timers, no prefetch, no polling.
//  - Authentication is the Git Credential Manager sign-in git already uses, read through
//    git's own credential protocol, non-interactively, and only when a request needs it. It
//    lives in this module's memory: never written, logged, put in an error or returned to
//    the window. A rejection drops it from memory and never erases it from GCM - that would
//    sign the user out of git itself.
//  - Read-only by construction. REST requests are GETs to a fixed table of routes. GraphQL
//    documents are fixed queries in this file, and the one sender refuses anything that is
//    not a query. The window names an operation; it never supplies a URL, a path or an owner.
//  - Structured data flows GitHub -> here -> window. No model is involved: zero tokens.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolveRepo, parseUnified } from './git.mjs';
import { run, killTree } from './workspace.mjs';

const API = 'https://api.github.com';
const WEB = 'https://github.com';
const API_VERSION = '2022-11-28';
const TIMEOUT_MS = 20000;
const PAGE_PULLS = 20;
const PAGE_FILES = 50;
const PAGE_RUNS = 20;

const SHA = /^[0-9a-f]{40}$/;
const CURSOR = /^[A-Za-z0-9+/=_-]{1,256}$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

// ---------------------------------------------------------------- which remotes are GitHub
/**
 * owner and repository from a remote URL, or null when the remote is not on github.com.
 *
 * Accepted: https://github.com/o/r(.git), with or without a credential in it (never kept);
 * git@github.com:o/r.git; ssh://git@github.com/o/r.git; and GitHub's SSH-over-443 host,
 * ssh://git@ssh.github.com:443/o/r.git. Everything else is "not GitHub" - another host, a
 * look-alike such as github.com.example, gist or api subdomains, a local path, file://, or
 * a URL with more than owner/repo in its path. Nothing here contacts anyone.
 */
export function parseGitHubRemote(url) {
  const s = String(url || '').trim();
  if (!s || s.length > 500 || /[\s\x00-\x1f\x7f]/.test(s)) return null;

  let host;
  let pathPart;
  let ssh = false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    let u;
    try { u = new URL(s); } catch { return null; }
    const scheme = u.protocol.toLowerCase();
    if (scheme === 'https:' || scheme === 'http:') {
      if (u.port && u.port !== '443' && u.port !== '80') return null;
    } else if (scheme === 'ssh:' || scheme === 'git+ssh:' || scheme === 'ssh+git:') {
      ssh = true;
    } else return null;
    host = u.hostname;
    try { pathPart = decodeURIComponent(u.pathname); } catch { return null; }
    if (u.search || u.hash) return null;
  } else {
    // scp-like: [user@]host:owner/repo.git - no scheme, and a colon that is not a drive letter
    const m = /^(?:[^@/:]+@)?([^/:]+):(?!\/)(.+)$/.exec(s);
    if (!m || m[1].length < 2) return null;
    host = m[1];
    pathPart = m[2];
    ssh = true;
  }

  host = host.toLowerCase();
  const isGitHub = host === 'github.com' || host === 'www.github.com' || (ssh && host === 'ssh.github.com');
  if (!isGitHub) return null;

  const parts = pathPart.replace(/^\/+/, '').replace(/\/+$/, '').split('/');
  if (parts.length !== 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === '.' || repo === '..') return null;
  return { owner, repo };
}

// ---------------------------------------------------------------- read-only guard
/**
 * True only for a GraphQL document that is purely a query. String literals and comments are
 * blanked first, so a word inside them neither sneaks a mutation through nor blocks a query.
 */
export function isReadOnlyGraphQL(doc) {
  if (typeof doc !== 'string' || !doc.trim() || doc.length > 20000) return false;
  const bare = doc
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/#[^\n\r]*/g, '');
  if (/\b(mutation|subscription)\b/i.test(bare)) return false;
  return /^\s*(query\b|fragment\b|\{)/.test(bare);
}

// ---------------------------------------------------------------- the credential
/**
 * The github.com credential git already uses, through git's standard credential protocol.
 *
 * Non-interactive on purpose: GCM_INTERACTIVE=never and credential.interactive=never stop
 * Git Credential Manager from opening a sign-in window, empty askpass variables stop git
 * from asking any other program, and GIT_TERMINAL_PROMPT=0 stops it asking on a terminal.
 * No credential means a plain "not signed in", never a prompt. Only `fill` is ever run -
 * never approve, reject or erase. Neither stdout (it holds the credential) nor stderr is
 * logged or returned.
 */
export function gcmCredential({ timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' };
    delete env.ELECTRON_RUN_AS_NODE;
    let child;
    try {
      child = spawn('git', ['-c', 'credential.interactive=never', 'credential', 'fill'],
        { windowsHide: true, env, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      resolve({ ok: false, reason: 'git' });
      return;
    }
    let out = '';
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      out = '';
      resolve(r);
    };
    const timer = setTimeout(() => { killTree(child); finish({ ok: false, reason: 'timeout' }); }, timeoutMs);
    child.on('error', () => finish({ ok: false, reason: 'git' }));
    child.stdout.on('data', (d) => {
      out += String(d);
      if (out.length > 64 * 1024) { killTree(child); finish({ ok: false, reason: 'git' }); }
    });
    child.on('close', (code) => {
      let token = '';
      if (code === 0) {
        for (const line of out.split(/\r?\n/)) if (line.startsWith('password=')) token = line.slice(9);
      }
      finish(token ? { ok: true, token } : { ok: false, reason: 'none' });
    });
    child.stdin.on('error', () => { /* git exited first; close reports it */ });
    child.stdin.end('protocol=https\nhost=github.com\n\n');
  });
}

// ---------------------------------------------------------------- the only API surface
// REST: a fixed table of GET routes and the query parameters each may carry. There is no
// way to name a route that is not here, and no way to choose a method at all.
const REST = Object.freeze({
  pullFiles: Object.freeze({
    path: ({ owner, repo, number }) => `/repos/${owner}/${repo}/pulls/${number}/files`,
    query: ['per_page', 'page'],
  }),
  workflowRuns: Object.freeze({
    path: ({ owner, repo }) => `/repos/${owner}/${repo}/actions/runs`,
    query: ['head_sha', 'per_page'],
  }),
});

// GraphQL: fixed documents, each a query, checked at load and again on every send.
const PR_FIELDS = `
  number title state isDraft updatedAt
  author { login }
  baseRefName headRefName reviewDecision
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;

const QUERIES = Object.freeze({
  pulls: `query JarvisPulls($owner: String!, $name: String!, $states: [PullRequestState!], $after: String, $branch: String!, $withBranch: Boolean!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequests(states: $states, first: ${PAGE_PULLS}, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes { ${PR_FIELDS} }
    }
    branchPulls: pullRequests(headRefName: $branch, first: 5, orderBy: {field: UPDATED_AT, direction: DESC}) @include(if: $withBranch) {
      nodes { ${PR_FIELDS} headRepositoryOwner { login } }
    }
  }
}`,
  pull: `query JarvisPull($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number title body state isDraft createdAt updatedAt mergedAt closedAt
      author { login }
      baseRefName headRefName headRefOid
      mergeable reviewDecision
      additions deletions changedFiles
      commits(last: 1) { totalCount nodes { commit { statusCheckRollup { state } } } }
      latestReviews(first: 20) { nodes { state submittedAt author { login } } }
      reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { name } } } }
    }
  }
}`,
  checks: `query JarvisChecks($owner: String!, $name: String!, $oid: GitObjectID!) {
  repository(owner: $owner, name: $name) {
    object(oid: $oid) {
      ... on Commit {
        oid
        statusCheckRollup {
          state
          contexts(first: 50) {
            totalCount
            nodes {
              __typename
              ... on CheckRun { databaseId name status conclusion startedAt completedAt checkSuite { workflowRun { databaseId workflow { name } } } }
              ... on StatusContext { context state createdAt description }
            }
          }
        }
      }
    }
  }
}`,
});
for (const [name, doc] of Object.entries(QUERIES)) {
  if (!isReadOnlyGraphQL(doc)) throw new Error(`GitHub query "${name}" is not a read-only query`);
}

// ---------------------------------------------------------------- messages
// Fixed text only. Nothing GitHub or the transport says is passed through, so no URL,
// header or credential can ride along in an error.
const SAFE = ' Nothing was changed, and local Source Control is unaffected.';
const MESSAGES = {
  notGitHub: 'This repository\'s origin is not on GitHub.',
  badRequest: 'That GitHub request was not valid.',
  offline: `This computer looks offline, so GitHub cannot be reached.${SAFE}`,
  network: `GitHub could not be reached. Check the connection and try again.${SAFE}`,
  timeout: `GitHub did not answer within ${TIMEOUT_MS / 1000} seconds.${SAFE}`,
  noCredential: 'Git has no GitHub sign-in on this computer. Fetch or push once in Git so Git Credential Manager can sign you in, then try again. JARVIS never asks for a password.',
  credentialTimeout: 'Git Credential Manager did not answer. Try again.',
  credentialGit: 'Git could not be run to read the GitHub sign-in.',
  auth: 'GitHub rejected the sign-in Git uses. Fetch or push once in Git so Git Credential Manager can renew it. JARVIS has not changed or removed it.',
  sso: 'This organisation requires single sign-on for Git Credential Manager\'s sign-in. Authorise it on GitHub, then try again.',
  forbidden: 'GitHub refused this request for this account.',
  notFound: 'GitHub says this does not exist, or this account cannot see it.',
  server: `GitHub had a problem answering. Try again shortly.${SAFE}`,
  malformed: `GitHub answered with data JARVIS could not read.${SAFE}`,
  tooLarge: 'GitHub\'s answer was too large to show here.',
  cancelled: 'Stopped.',
};
const rateLimited = (reset) => `GitHub's hourly request limit is used up${reset ? ` until ${new Date(reset * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}.${SAFE}`;
const slowDown = (s) => `GitHub asked JARVIS to slow down. Try again in ${s} seconds.`;

// ---------------------------------------------------------------- small helpers
const str = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : null);
const int = (v) => (Number.isInteger(v) ? v : null);
const when = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);
const oneOf = (v, set) => (set.includes(v) ? v : null);
const isNumber = (n) => Number.isInteger(n) && n > 0 && n < 2 ** 31;
const encRef = (ref) => ref.split('/').map(encodeURIComponent).join('/');
const ROLLUP = ['SUCCESS', 'FAILURE', 'PENDING', 'ERROR', 'EXPECTED'];
const PR_STATES = ['OPEN', 'CLOSED', 'MERGED'];
const REVIEW = ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'];

/** A repository-relative path that can go into a github.com URL without escaping its place. */
function safePath(p) {
  return typeof p === 'string' && p.length > 0 && p.length <= 1024
    && !/[\x00-\x1f\x7f\\]/.test(p) && !p.startsWith('/')
    && !p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
}

const fail = (code, extra = {}) => ({ ok: false, code, error: MESSAGES[code] || MESSAGES.badRequest, ...extra });

function rollupOf(node) {
  return oneOf(node?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state, ROLLUP);
}

function prSummary(n) {
  return {
    number: int(n?.number),
    title: str(n?.title, 300) || '(untitled)',
    state: oneOf(n?.state, PR_STATES),
    draft: n?.isDraft === true,
    author: str(n?.author?.login, 60) || 'ghost',
    base: str(n?.baseRefName, 255),
    head: str(n?.headRefName, 255),
    review: oneOf(n?.reviewDecision, REVIEW),
    checks: rollupOf(n),
    updated: when(n?.updatedAt),
  };
}

const FILE_STATUS = { added: 'added', removed: 'deleted', modified: 'modified', renamed: 'renamed', copied: 'copied', changed: 'modified', unchanged: 'modified' };

// ---------------------------------------------------------------- the service
/**
 * @param cwd       () => the workspace folder (asked afresh each call, as git.mjs does)
 * @param fetch     the transport - Electron's net.fetch in the app, a fake in tests
 * @param credential  () => Promise<{ ok, token } | { ok: false, reason }>
 * @param online    () => boolean, checked before any request
 * @param log       (...parts) => void; given operation names and statuses, never data
 */
export function createGitHub({ cwd, fetch, credential = gcmCredential, online = () => true, log = () => {}, timeoutMs = TIMEOUT_MS } = {}) {
  let token = null;          // the session's credential: memory only
  let reading = null;        // one credential read at a time
  const inflight = new Map(); // key -> Set<AbortController>
  // Cancelling a repository advances its generation. A request that has not been sent yet
  // - still reading git, or waiting for the credential - checks it and stops, so leaving a
  // repository early cancels as surely as leaving it mid-request.
  const gens = new Map();
  const genOf = (key) => gens.get(key) || 0;
  const etags = new Map();    // REST URL -> { etag, data }; a 304 costs no rate limit
  const files = new Map();    // `${key}#${number}` -> Map(path -> file, with its patch)
  let lastRate = null;

  // ---- local facts: git only, no network, no credential
  async function facts(key) {
    const repo = resolveRepo(cwd(), key);
    if (!repo) return { ok: false, error: 'That repository is not one of the detected repositories.' };
    const g = (args) => run('git', ['--no-optional-locks', '-C', repo.dir, ...args], { timeout: 10000 });
    const [url, head, sym, up] = await Promise.all([
      g(['remote', 'get-url', 'origin']),
      g(['rev-parse', '--verify', '-q', 'HEAD']),
      g(['symbolic-ref', '-q', '--short', 'HEAD']),
      g(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
    ]);
    const id = url.ok ? parseGitHubRemote(url.out.trim()) : null;
    const upstream = up.ok ? up.out.trim() : null;
    const branch = sym.ok ? sym.out.trim() : null;
    return {
      ok: true,
      key: repo.key,
      dir: repo.dir,
      github: !!id,
      owner: id?.owner || null,
      repo: id?.repo || null,
      branch,
      detached: !branch,
      upstream,
      // Only a branch tracking origin has a known name on GitHub.
      remoteBranch: upstream && upstream.startsWith('origin/') ? upstream.slice('origin/'.length) : null,
      head: head.ok && SHA.test(head.out.trim()) ? head.out.trim() : null,
      g,
    };
  }

  /** Is this commit on a remote-tracking ref of origin? Known from the last fetch or push. */
  async function pushed(f, sha) {
    const r = await f.g(['for-each-ref', '--count=1', '--format=%(refname)', '--contains', sha, 'refs/remotes/origin']);
    return r.ok && !!r.out.trim();
  }
  const exists = async (f, rev, p) => (await f.g(['cat-file', '-e', `${rev}:${p}`])).ok;

  const web = (f) => `${WEB}/${f.owner}/${f.repo}`;

  // ---- the credential, read only when a request needs it
  async function getToken() {
    if (token) return { ok: true };
    if (!reading) {
      reading = Promise.resolve()
        .then(() => credential())
        .catch(() => ({ ok: false, reason: 'git' }))
        .then((r) => {
          if (r && r.ok && typeof r.token === 'string' && r.token) {
            token = r.token;
            log('github credential: read from Git Credential Manager');
            return { ok: true };
          }
          log('github credential: none available', r?.reason || '');
          return { ok: false, reason: r?.reason || 'none' };
        })
        .finally(() => { reading = null; });
    }
    return reading;
  }

  function noteRate(h, kind) {
    const remaining = Number(h.get('x-ratelimit-remaining'));
    const limit = Number(h.get('x-ratelimit-limit'));
    const reset = Number(h.get('x-ratelimit-reset'));
    if (!Number.isFinite(remaining) || !Number.isFinite(limit)) return null;
    lastRate = { resource: str(h.get('x-ratelimit-resource'), 40) || kind, remaining, limit, reset: Number.isFinite(reset) ? reset : null };
    return lastRate;
  }

  /**
   * THE network call. Everything that reaches GitHub comes through here: a GET to a route
   * from REST, or a POST of a checked query to /graphql. The credential goes in one header,
   * to one host, and redirects are refused rather than followed anywhere.
   */
  async function send(key, op, { path, query, graphql }, gen) {
    const dropped = () => gen !== undefined && genOf(key) !== gen;
    let url;
    let init;
    if (graphql) {
      if (!isReadOnlyGraphQL(graphql.query)) return fail('badRequest', { refused: true });
      url = `${API}/graphql`;
      init = { method: 'POST', body: JSON.stringify({ query: graphql.query, variables: graphql.variables || {} }) };
    } else {
      const qs = query && [...query.keys()].length ? `?${query}` : '';
      url = `${API}${path}${qs}`;
      init = { method: 'GET' };
    }
    if (!url.startsWith(`${API}/`)) return fail('badRequest', { refused: true });
    if (!online()) { log('github', op, key, 'skipped: offline'); return fail('offline'); }

    if (dropped()) return fail('cancelled', { cancelled: true });
    const cred = await getToken();
    if (!cred.ok) return fail(cred.reason === 'timeout' ? 'credentialTimeout' : cred.reason === 'git' ? 'credentialGit' : 'noCredential');
    if (dropped()) return fail('cancelled', { cancelled: true });

    const cached = !graphql ? etags.get(url) : null;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'JARVIS-desktop',
    };
    if (graphql) headers['Content-Type'] = 'application/json';
    if (cached?.etag) headers['If-None-Match'] = cached.etag;

    const ac = new AbortController();
    if (!inflight.has(key)) inflight.set(key, new Set());
    inflight.get(key).add(ac);
    const TIMED_OUT = 'timeout';
    const timer = setTimeout(() => ac.abort(TIMED_OUT), timeoutMs);
    // Cancellation must not depend on the transport honouring the signal: the race settles
    // the moment it aborts, whatever the request underneath is still doing.
    const aborted = new Promise((_, reject) => ac.signal.addEventListener('abort', () => reject(ac.signal.reason), { once: true }));
    aborted.catch(() => {});
    const stopped = () => (ac.signal.reason === TIMED_OUT ? fail('timeout') : fail('cancelled', { cancelled: true }));

    try {
      let res;
      try {
        res = await Promise.race([fetch(url, { ...init, headers, signal: ac.signal, redirect: 'error' }), aborted]);
      } catch {
        if (ac.signal.aborted) return stopped();
        log('github', op, key, 'failed: network');
        return fail(online() ? 'network' : 'offline');
      }

      const rate = noteRate(res.headers, graphql ? 'graphql' : 'core');
      const left = rate ? ` (${rate.resource} ${rate.remaining}/${rate.limit})` : '';
      log('github', op, key, res.status, left);

      if (res.status === 304 && cached) return { ok: true, data: cached.data, rate };
      if (res.status === 401) {
        token = null;   // forget it here; GCM keeps it - never `git credential reject`
        return fail('auth', { rate });
      }
      if (res.status === 403 || res.status === 429) {
        const retry = Number(res.headers.get('retry-after'));
        if (rate && rate.remaining === 0) return fail('rateLimited', { error: rateLimited(rate.reset), rate });
        if (Number.isFinite(retry) && retry > 0) return fail('slowDown', { error: slowDown(retry), rate });
        if (res.headers.get('x-github-sso')) return fail('sso', { rate });
        return fail('forbidden', { rate });
      }
      if (res.status === 404 || res.status === 410) return fail('notFound', { rate });
      if (res.status >= 500) return fail('server', { rate });
      if (res.status < 200 || res.status >= 300) return fail('badRequest', { status: res.status, rate });
      if (Number(res.headers.get('content-length')) > 25 * 1024 * 1024) return fail('tooLarge', { rate });

      let data;
      try { data = await Promise.race([res.json(), aborted]); }
      catch {
        if (ac.signal.aborted) return stopped();
        return fail('malformed', { rate });
      }
      if (graphql) {
        const errs = Array.isArray(data?.errors) ? data.errors : [];
        if (errs.length && !data?.data) {
          const type = String(errs[0]?.type || '');
          if (type === 'RATE_LIMITED') return fail('rateLimited', { error: rateLimited(rate?.reset), rate });
          if (type === 'NOT_FOUND') return fail('notFound', { rate });
          if (type === 'FORBIDDEN') return fail('forbidden', { rate });
          return fail('malformed', { rate });
        }
        return { ok: true, data: data?.data ?? null, rate };
      }
      const etag = res.headers.get('etag');
      if (etag) {
        etags.set(url, { etag, data });
        if (etags.size > 100) etags.delete(etags.keys().next().value);
      }
      return { ok: true, data, rate };
    } finally {
      clearTimeout(timer);
      inflight.get(key)?.delete(ac);
    }
  }

  /** A GET to a named route. Unknown names and parameters are refused before anything is sent. */
  function restGet(key, op, params, query = {}, gen) {
    const route = Object.prototype.hasOwnProperty.call(REST, op) ? REST[op] : null;
    if (!route) return Promise.resolve(fail('badRequest', { refused: true }));
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (!route.query.includes(k)) return Promise.resolve(fail('badRequest', { refused: true }));
      if (v != null) qs.set(k, String(v));
    }
    const p = {};
    for (const [k, v] of Object.entries(params)) p[k] = encodeURIComponent(String(v));
    return send(key, op, { path: route.path(p), query: qs }, gen);
  }

  const graphql = (key, op, name, variables, gen) => send(key, op, { graphql: { query: QUERIES[name], variables } }, gen);

  /** Every API operation starts here: a real repository, on GitHub, named by key. */
  async function githubFacts(key) {
    const f = await facts(key);
    if (!f.ok) return f;
    if (!f.github) return { ...fail('notGitHub'), key: f.key };
    return f;
  }

  /** Which commit "Check" means when no commit was named: what GitHub has from this branch. */
  async function target(f, sha) {
    if (sha != null) {
      if (typeof sha !== 'string' || !SHA.test(sha)) return fail('badRequest');
      return { ok: true, sha, label: sha.slice(0, 7), kind: 'commit' };
    }
    if (f.head && await pushed(f, f.head)) {
      return { ok: true, sha: f.head, label: `${f.branch || 'HEAD'} @ ${f.head.slice(0, 7)}`, kind: 'branch' };
    }
    if (f.remoteBranch) {
      const r = await f.g(['rev-parse', '--verify', '-q', `refs/remotes/origin/${f.remoteBranch}`]);
      const tip = r.ok ? r.out.trim() : '';
      if (SHA.test(tip)) {
        return {
          ok: true, sha: tip, kind: 'branch',
          label: `origin/${f.remoteBranch} @ ${tip.slice(0, 7)}`,
          note: 'Your newest commits are not pushed, so this is the last commit GitHub has from this branch, as of the last fetch or push.',
        };
      }
    }
    return { ok: false, code: 'notPushed', error: 'This branch is not on GitHub yet, so GitHub has nothing to check for it.' };
  }

  function guard(fn) {
    return async (...args) => {
      try { return await fn(...args); }
      catch (e) {
        log('github failed', String(e?.message || e).slice(0, 120));
        return fail('malformed');
      }
    };
  }

  // ---------------------------------------------------------------- public: local only
  /** GitHub identity and branch facts for the tab. Git only - never the network or the credential. */
  const info = guard(async (key) => {
    const f = await facts(key);
    if (!f.ok) return f;
    return {
      ok: true, key: f.key, github: f.github, owner: f.owner, repo: f.repo,
      branch: f.branch, detached: f.detached, upstream: f.upstream, remoteBranch: f.remoteBranch, head: f.head,
    };
  });

  /**
   * A github.com page for this repository, built from local refs - no API call. A link that
   * would 404 because something is not pushed yet is refused with the reason instead.
   */
  const link = guard(async (key, which, arg = {}) => {
    const f = await githubFacts(key);
    if (!f.ok) return f;
    const a = arg && typeof arg === 'object' ? arg : {};
    const base = web(f);
    const ok = (url) => ({ ok: true, key: f.key, url });
    const no = (error) => ({ ok: false, key: f.key, error });

    switch (which) {
      case 'repo': return ok(base);
      case 'actions': return ok(`${base}/actions`);
      case 'branch':
        if (f.detached) return no('You are on a detached HEAD, which is not a branch on GitHub.');
        if (!f.remoteBranch) return no('This branch is not on GitHub yet. Publish it first - JARVIS never does that on its own.');
        return ok(`${base}/tree/${encRef(f.remoteBranch)}`);
      case 'newPull':
        if (f.detached) return no('Switch to a branch first.');
        if (!f.remoteBranch) return no('Publish this branch first. JARVIS opens GitHub\'s page; it never pushes or creates the pull request itself.');
        return ok(`${base}/pull/new/${encRef(f.remoteBranch)}`);
      case 'commit': {
        const sha = a.sha == null ? f.head : a.sha;
        if (typeof sha !== 'string' || !SHA.test(sha)) return no('There is no commit here yet.');
        if (!await pushed(f, sha)) return no('That commit is not on GitHub yet (not pushed, as of the last fetch or push), so GitHub would show a 404.');
        return ok(`${base}/commit/${sha}`);
      }
      case 'file': {
        if (!safePath(a.path)) return fail('badRequest');
        if (a.sha != null) {
          if (typeof a.sha !== 'string' || !SHA.test(a.sha)) return fail('badRequest');
          if (!await pushed(f, a.sha)) return no('That commit is not on GitHub yet, so the file cannot be shown there.');
          if (!await exists(f, a.sha, a.path)) return no('That file does not exist in this commit (it was deleted here).');
          return ok(`${base}/blob/${a.sha}/${encRef(a.path)}`);
        }
        if (!f.remoteBranch) return no('This branch is not on GitHub yet, so neither is this file.');
        if (!await exists(f, `refs/remotes/origin/${f.remoteBranch}`, a.path)) {
          return no(`This file is not on GitHub at ${f.remoteBranch} yet - it is new, or renamed, and not pushed.`);
        }
        return ok(`${base}/blob/${encRef(f.remoteBranch)}/${encRef(a.path)}`);
      }
      case 'pull':
        if (!isNumber(a.number)) return fail('badRequest');
        return ok(`${base}/pull/${a.number}`);
      case 'pullFile':
        if (!isNumber(a.number) || !safePath(a.path)) return fail('badRequest');
        // GitHub anchors a file in a pull request by the SHA-256 of its path.
        return ok(`${base}/pull/${a.number}/files#diff-${createHash('sha256').update(a.path).digest('hex')}`);
      case 'run':
        // Run and check-run ids long since passed 2^31, so any positive safe integer.
        if (!(Number.isSafeInteger(a.id) && a.id > 0)) return fail('badRequest');
        return ok(`${base}/actions/runs/${a.id}`);
      case 'checkRun':
        if (!(Number.isSafeInteger(a.id) && a.id > 0)) return fail('badRequest');
        return ok(`${base}/runs/${a.id}`);
      default:
        return fail('badRequest');
    }
  });

  // ---------------------------------------------------------------- public: GitHub API
  /** One page of pull requests, and on the first page the current branch's own. */
  const pulls = guard(async (key, opts = {}) => {
    const o = opts && typeof opts === 'object' ? opts : {};
    const state = o.state === 'closed' ? 'closed' : 'open';
    const cursor = o.cursor == null ? null : o.cursor;
    if (cursor !== null && (typeof cursor !== 'string' || !CURSOR.test(cursor))) return fail('badRequest');
    const gen = genOf(key);
    const f = await githubFacts(key);
    if (!f.ok) return f;

    const branchName = f.remoteBranch || f.branch || '';
    const withBranch = !cursor && !!branchName;
    const r = await graphql(f.key, 'pulls', 'pulls', {
      owner: f.owner, name: f.repo,
      states: state === 'open' ? ['OPEN'] : ['CLOSED', 'MERGED'],
      after: cursor, branch: branchName, withBranch,
    }, gen);
    if (!r.ok) return { ...r, key: f.key };
    const conn = r.data?.repository?.pullRequests;
    if (!r.data?.repository) return { ...fail('notFound'), key: f.key, rate: r.rate };
    if (!conn || !Array.isArray(conn.nodes)) return { ...fail('malformed'), key: f.key, rate: r.rate };

    let branch = null;
    if (withBranch) {
      const nodes = Array.isArray(r.data.repository.branchPulls?.nodes) ? r.data.repository.branchPulls.nodes : [];
      // A pull request from a fork with the same branch name is not this branch's.
      const own = nodes.filter((n) => String(n?.headRepositoryOwner?.login || '').toLowerCase() === f.owner.toLowerCase());
      branch = { name: branchName, onGitHub: !!f.remoteBranch, pulls: own.map(prSummary).filter((p) => p.number) };
    }
    return {
      ok: true, key: f.key, state,
      list: conn.nodes.map(prSummary).filter((p) => p.number),
      total: int(conn.totalCount),
      cursor: str(conn.pageInfo?.endCursor, 256),
      more: conn.pageInfo?.hasNextPage === true,
      branch,
      viewer: str(r.data.viewer?.login, 60),
      repoName: `${f.owner}/${f.repo}`,
      rate: r.rate, loadedAt: Date.now(),
    };
  });

  /** One pull request in detail. Loaded when it is chosen, not with the list. */
  const pull = guard(async (key, number) => {
    if (!isNumber(number)) return fail('badRequest');
    const gen = genOf(key);
    const f = await githubFacts(key);
    if (!f.ok) return f;
    const r = await graphql(f.key, 'pull', 'pull', { owner: f.owner, name: f.repo, number }, gen);
    if (!r.ok) return { ...r, key: f.key, number };
    const p = r.data?.repository?.pullRequest;
    if (!p) return { ...fail('notFound'), key: f.key, number, rate: r.rate };
    const reviews = (Array.isArray(p.latestReviews?.nodes) ? p.latestReviews.nodes : []).map((v) => ({
      author: str(v?.author?.login, 60) || 'ghost',
      state: oneOf(v?.state, ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING']),
      at: when(v?.submittedAt),
    })).filter((v) => v.state);
    const requested = (Array.isArray(p.reviewRequests?.nodes) ? p.reviewRequests.nodes : [])
      .map((x) => str(x?.requestedReviewer?.login, 60) || str(x?.requestedReviewer?.name, 80)).filter(Boolean);
    const headSha = typeof p.headRefOid === 'string' && SHA.test(p.headRefOid) ? p.headRefOid : null;
    return {
      ok: true, key: f.key,
      pull: {
        number: int(p.number) || number,
        title: str(p.title, 300) || '(untitled)',
        body: str(p.body, 65536) || '',
        state: oneOf(p.state, PR_STATES),
        draft: p.isDraft === true,
        author: str(p.author?.login, 60) || 'ghost',
        base: str(p.baseRefName, 255),
        head: str(p.headRefName, 255),
        headSha,
        created: when(p.createdAt), updated: when(p.updatedAt), merged: when(p.mergedAt), closed: when(p.closedAt),
        mergeable: oneOf(p.mergeable, ['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
        review: oneOf(p.reviewDecision, REVIEW),
        reviews, requested,
        files: int(p.changedFiles), additions: int(p.additions), deletions: int(p.deletions),
        commits: int(p.commits?.totalCount),
        checks: rollupOf(p),
      },
      rate: r.rate, loadedAt: Date.now(),
    };
  });

  /**
   * One page of a pull request's changed files, loaded only when asked for. GitHub sends each
   * file's patch with the listing; the patches stay here, in main, and one goes to the window
   * only when that file is opened.
   */
  const pullFiles = guard(async (key, number, page = 1) => {
    if (!isNumber(number) || !isNumber(page) || page > 60) return fail('badRequest');
    const gen = genOf(key);
    const f = await githubFacts(key);
    if (!f.ok) return f;
    const r = await restGet(f.key, 'pullFiles', { owner: f.owner, repo: f.repo, number }, { per_page: PAGE_FILES, page }, gen);
    if (!r.ok) return { ...r, key: f.key, number };
    if (!Array.isArray(r.data)) return { ...fail('malformed'), key: f.key, number, rate: r.rate };

    const id = `${f.key}#${number}`;
    if (!files.has(id)) {
      files.set(id, new Map());
      if (files.size > 12) files.delete(files.keys().next().value);
    }
    const store = files.get(id);
    const list = [];
    for (const x of r.data) {
      const p = str(x?.filename, 1024);
      if (!p) continue;
      const entry = {
        path: p,
        status: FILE_STATUS[x?.status] || 'modified',
        from: str(x?.previous_filename, 1024),
        added: int(x?.additions) ?? 0,
        removed: int(x?.deletions) ?? 0,
        changes: int(x?.changes) ?? 0,
        hasPatch: typeof x?.patch === 'string',
      };
      store.set(p, { ...entry, patch: typeof x?.patch === 'string' ? x.patch : null });
      list.push(entry);
    }
    return { ok: true, key: f.key, number, page, files: list, more: r.data.length === PAGE_FILES, rate: r.rate };
  });

  /**
   * One file's patch, from the listing already fetched - no request. Shaped for the existing
   * diff renderer. When GitHub gave no patch (a binary file, a pure rename, or a diff too
   * large for its API) that is said plainly; no patch is invented.
   */
  const pullPatch = guard(async (key, number, filePath) => {
    if (!isNumber(number) || typeof filePath !== 'string' || !filePath || filePath.length > 1024) return fail('badRequest');
    const repo = resolveRepo(cwd(), key);
    if (!repo) return { ok: false, error: 'That repository is not one of the detected repositories.' };
    const hit = files.get(`${repo.key}#${number}`)?.get(filePath);
    if (!hit) return { ok: false, key: repo.key, error: 'Load the file list again to see this file.' };
    const base = {
      ok: true, key: repo.key, repo: { key: repo.key }, number, path: filePath, side: 'pr',
      entry: { renamedFrom: hit.from }, binary: false, status: hit.status,
    };
    if (hit.patch == null) {
      const why = hit.status === 'renamed' && !hit.changes ? 'Renamed without changes - there is no patch to show.'
        : !hit.changes ? 'GitHub shows no patch for this file - it is binary, or only its mode changed.'
          : 'GitHub does not provide a patch for this file - its diff is too large for the API. Open it on GitHub to see it.';
      return { ...base, noPatch: why, hunks: [], added: hit.added, removed: hit.removed, truncated: false };
    }
    return { ...base, ...parseUnified(hit.patch) };
  });

  /** The checks on one commit: check runs and commit statuses, from GitHub's rollup. */
  const checks = guard(async (key, sha = null) => {
    const gen = genOf(key);
    const f = await githubFacts(key);
    if (!f.ok) return f;
    const t = await target(f, sha);
    if (!t.ok) return { ...t, key: f.key };
    const r = await graphql(f.key, 'checks', 'checks', { owner: f.owner, name: f.repo, oid: t.sha }, gen);
    if (!r.ok) return { ...r, key: f.key, target: t };
    if (!r.data?.repository) return { ...fail('notFound'), key: f.key, target: t, rate: r.rate };
    const obj = r.data.repository.object;
    if (!obj) return { ok: true, key: f.key, target: t, state: null, total: 0, list: [], missing: true, rate: r.rate, loadedAt: Date.now() };
    const roll = obj.statusCheckRollup;
    const nodes = Array.isArray(roll?.contexts?.nodes) ? roll.contexts.nodes : [];
    const list = nodes.map((n) => (n?.__typename === 'CheckRun' ? {
      kind: 'check',
      id: Number.isSafeInteger(n.databaseId) ? n.databaseId : null,
      name: str(n.name, 200) || 'check',
      workflow: str(n.checkSuite?.workflowRun?.workflow?.name, 200),
      runId: Number.isSafeInteger(n.checkSuite?.workflowRun?.databaseId) ? n.checkSuite.workflowRun.databaseId : null,
      status: str(n.status, 30),
      conclusion: str(n.conclusion, 30),
      started: when(n.startedAt), completed: when(n.completedAt),
    } : n?.__typename === 'StatusContext' ? {
      kind: 'status',
      name: str(n.context, 200) || 'status',
      status: n.state === 'PENDING' || n.state === 'EXPECTED' ? 'PENDING' : 'COMPLETED',
      conclusion: str(n.state, 30),
      description: str(n.description, 300),
      started: when(n.createdAt), completed: null,
    } : null)).filter(Boolean);
    return {
      ok: true, key: f.key, target: t,
      state: oneOf(roll?.state, ROLLUP), total: int(roll?.contexts?.totalCount) ?? list.length, list,
      rate: r.rate, loadedAt: Date.now(),
    };
  });

  /** GitHub Actions workflow runs for one commit - "did my push deploy?". */
  const runs = guard(async (key, sha = null) => {
    const gen = genOf(key);
    const f = await githubFacts(key);
    if (!f.ok) return f;
    const t = await target(f, sha);
    if (!t.ok) return { ...t, key: f.key };
    const r = await restGet(f.key, 'workflowRuns', { owner: f.owner, repo: f.repo }, { head_sha: t.sha, per_page: PAGE_RUNS }, gen);
    if (!r.ok) return { ...r, key: f.key, target: t };
    const arr = Array.isArray(r.data?.workflow_runs) ? r.data.workflow_runs : null;
    if (!arr) return { ...fail('malformed'), key: f.key, target: t, rate: r.rate };
    const list = arr.map((x) => ({
      id: Number.isSafeInteger(x?.id) ? x.id : null,
      workflow: str(x?.name, 200) || 'workflow',
      title: str(x?.display_title, 300),
      status: str(x?.status, 30),
      conclusion: str(x?.conclusion, 30),
      event: str(x?.event, 40),
      branch: str(x?.head_branch, 255),
      sha: typeof x?.head_sha === 'string' && SHA.test(x.head_sha) ? x.head_sha : null,
      number: int(x?.run_number),
      attempt: int(x?.run_attempt),
      created: when(x?.created_at), started: when(x?.run_started_at), updated: when(x?.updated_at),
    })).filter((x) => x.id);
    return { ok: true, key: f.key, target: t, total: int(r.data.total_count) ?? list.length, list, rate: r.rate, loadedAt: Date.now() };
  });

  /** Stop everything still running for a repository. Its replies come back `cancelled`. */
  function cancel(key) {
    gens.set(key, genOf(key) + 1);
    const set = inflight.get(key);
    let n = 0;
    if (set) for (const ac of set) { ac.abort('cancelled'); n += 1; }
    if (n) log('github cancelled', key, `${n} request(s)`);
    return { ok: true, key, cancelled: n };
  }

  return {
    info, link, pulls, pull, pullFiles, pullPatch, checks, runs, cancel,
    rate: () => lastRate,
    // For the test suite only, and never wired to IPC: the two senders, so the tests can
    // prove a mutation or an unknown route is refused at the one place requests leave.
    internals: { graphqlRaw: (key, doc, variables) => send(key, 'raw', { graphql: { query: doc, variables } }), restGet },
  };
}
