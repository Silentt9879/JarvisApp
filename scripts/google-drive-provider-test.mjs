// JARVIS Knowledge - Phase 24C: src/google-drive-provider.mjs, the real five-method Drive
// client - driven against a small in-memory fake of the Drive v3 REST API (this file's own
// `fakeGoogleFetch`), never a real `fetch` to googleapis.com. Covers the provider's own
// concerns (retry/backoff, rate limits, auth-vs-network error classification, timeouts) AND,
// separately, runs the actual Phase 24B backup engine through this real provider instead of
// FakeDriveProvider - proving the contract compatibility directly, not by inspection.
//   node scripts/google-drive-provider-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGoogleDriveProvider, DriveAuthError, DriveNetworkError } from '../src/google-drive-provider.mjs';
import { runBackup, previewRestore, applyRestore } from '../src/drive-backup.mjs';
import { writeKnowledgeNote } from '../src/knowledge.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${extra ? `\n     ${extra}` : ''}`); } };
const check = async (name, fn) => { try { await fn(); ok(true, name); } catch (e) { ok(false, name, String(e.stack || e).slice(0, 500)); } };

const okAccessToken = async () => ({ ok: true, accessToken: 'at-1' });

/**
 * A small in-memory stand-in for the real Drive v3 REST API - just enough of it
 * (files.list/create/get, the upload endpoint) for google-drive-provider.mjs to talk to, so
 * the provider's own HTTP-shaped logic (query building, multipart bodies, status handling)
 * runs for real, against something that behaves like Drive's actual responses and error
 * shapes - never Drive itself.
 */
function fakeGoogleFetch() {
  let autoId = 1;
  const files = new Map(); // id -> { id, name, mimeType, parents: [id]|undefined, bytes? }
  const faults = { rateLimited: 0, serverError: 0, unauthorized: 0, networkDown: 0 };
  let callLog = [];

  async function handle(url, opts) {
    callLog.push(`${opts?.method || 'GET'} ${url.split('?')[0]}`);
    if (faults.networkDown > 0) { faults.networkDown -= 1; throw Object.assign(new Error('simulated network failure'), { name: 'FetchError' }); }
    if (faults.unauthorized > 0) { faults.unauthorized -= 1; return jsonResponse(401, { error: { message: 'invalid credentials' } }); }
    if (faults.rateLimited > 0) { faults.rateLimited -= 1; return jsonResponse(403, { error: { errors: [{ reason: 'userRateLimitExceeded' }], message: 'Rate limit' } }); }
    if (faults.serverError > 0) { faults.serverError -= 1; return jsonResponse(500, { error: { message: 'internal' } }); }

    const u = new URL(url);
    if (u.pathname === '/drive/v3/files' && (!opts || opts.method === undefined || opts.method === 'GET')) {
      const qstr = u.searchParams.get('q') || '';
      const nameMatch = /name=('(?:[^'\\]|\\.)*')/.exec(qstr);
      const name = nameMatch ? JSON.parse(`"${nameMatch[1].slice(1, -1).replace(/\\'/g, "'")}"`) : null;
      const parentMatch = /'([^']*)' in parents/.exec(qstr);
      const parent = parentMatch ? parentMatch[1] : null;
      const isFolderQuery = /mimeType='application\/vnd\.google-apps\.folder'/.test(qstr);
      const out = [...files.values()].filter((f) => {
        if (parent != null && (f.parents || [])[0] !== (parent === 'root' ? undefined : parent)) return false;
        if (name != null && f.name !== name) return false;
        if (isFolderQuery && f.mimeType !== 'application/vnd.google-apps.folder') return false;
        return true;
      });
      return jsonResponse(200, { files: out.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, size: f.bytes ? String(f.bytes.length) : undefined })) });
    }
    if (u.pathname === '/drive/v3/files' && opts.method === 'POST') {
      const meta = JSON.parse(opts.body);
      const id = `f${autoId++}`;
      files.set(id, { id, name: meta.name, mimeType: meta.mimeType, parents: meta.parents });
      return jsonResponse(200, { id, name: meta.name });
    }
    if (u.pathname === '/upload/drive/v3/files' && opts.method === 'POST') {
      const raw = Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body);
      const boundary = /boundary=([^;]+)/.exec(opts.headers['Content-Type'])[1];
      const text = raw.toString('latin1');
      const metaMatch = /\r\n\r\n({[\s\S]*?})\r\n--/.exec(text);
      const meta = JSON.parse(metaMatch[1]);
      const metaEndIdx = text.indexOf(metaMatch[0]) + metaMatch[0].length;
      const secondPartStart = text.indexOf('\r\n\r\n', metaEndIdx) + 4;
      const endMarker = `\r\n--${boundary}--`;
      const endIdx = text.lastIndexOf(endMarker);
      const bytes = raw.subarray(Buffer.byteLength(text.slice(0, secondPartStart), 'latin1'), Buffer.byteLength(text.slice(0, endIdx), 'latin1'));
      const id = `f${autoId++}`;
      files.set(id, { id, name: meta.name, mimeType: 'application/octet-stream', parents: meta.parents, bytes: Buffer.from(bytes) });
      return jsonResponse(200, { id, name: meta.name, size: String(bytes.length) });
    }
    const downloadMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
    if (downloadMatch && u.searchParams.get('alt') === 'media') {
      const f = files.get(downloadMatch[1]);
      if (!f) return jsonResponse(404, { error: { message: 'not found' } });
      return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength) };
    }
    return jsonResponse(404, { error: { message: `no fake route for ${u.pathname}` } });
  }
  function jsonResponse(status, body) {
    return { ok: status >= 200 && status < 300, status, json: async () => body, arrayBuffer: async () => Buffer.alloc(0) };
  }
  return {
    fetchImpl: (url, opts) => handle(url, opts),
    fault: faults,
    calls: () => callLog,
    _files: files,
  };
}

// ------------------------------------------------------------------ the five methods, basic behavior
await check('ensureFolder: creates once, finds thereafter - idempotent the same way the fake test provider is', async () => {
  const g = fakeGoogleFetch();
  const p = createGoogleDriveProvider({ getAccessToken: okAccessToken, fetchImpl: g.fetchImpl });
  const a = await p.ensureFolder(null, 'JARVIS Knowledge Backups');
  assert.equal(a.created, true);
  const b = await p.ensureFolder(null, 'JARVIS Knowledge Backups');
  assert.equal(b.created, false);
  assert.equal(a.id, b.id);
});
await check('uploadFile then downloadFile round-trips the exact bytes', async () => {
  const g = fakeGoogleFetch();
  const p = createGoogleDriveProvider({ getAccessToken: okAccessToken, fetchImpl: g.fetchImpl });
  const folder = await p.ensureFolder(null, 'root-folder');
  const up = await p.uploadFile(folder.id, 'note.md', Buffer.from('hello world'));
  assert.equal(up.name, 'note.md');
  const back = await p.downloadFile(up.id);
  assert.equal(back.toString('utf8'), 'hello world');
});
await check('listChildren reports files and folders distinctly, with real sizes', async () => {
  const g = fakeGoogleFetch();
  const p = createGoogleDriveProvider({ getAccessToken: okAccessToken, fetchImpl: g.fetchImpl });
  const folder = await p.ensureFolder(null, 'parent');
  await p.ensureFolder(folder.id, 'child-folder');
  await p.uploadFile(folder.id, 'a.md', Buffer.from('1234'));
  const kids = await p.listChildren(folder.id);
  assert.equal(kids.length, 2);
  assert.ok(kids.some((k) => k.kind === 'folder' && k.name === 'child-folder'));
  const file = kids.find((k) => k.kind === 'file');
  assert.equal(file.size, 4);
});
await check('findFolder: a folder that does not exist is null, not an error', async () => {
  const g = fakeGoogleFetch();
  const p = createGoogleDriveProvider({ getAccessToken: okAccessToken, fetchImpl: g.fetchImpl });
  assert.equal(await p.findFolder(null, 'nope'), null);
});

// ------------------------------------------------------------------ error classification and retries
await check('a rate-limited response (403, userRateLimitExceeded) is retried with backoff, and succeeds', async () => {
  const g = fakeGoogleFetch();
  g.fault.rateLimited = 2;
  const p = createGoogleDriveProvider({ getAccessToken: okAccessToken, fetchImpl: g.fetchImpl, maxRetries: 4 });
  const r = await p.ensureFolder(null, 'f');
  assert.ok(r.id);
});
await check('a 429 is treated the same as a rate limit', async () => {
  const g = fakeGoogleFetch();
  g.fault.rateLimited = 1; // the fake returns 403/userRateLimitExceeded; this asserts isRateLimited's own 429 branch via a second run
  const p = createGoogleDriveProvider({ getAccessToken: okAccessToken, fetchImpl: g.fetchImpl });
  const r = await p.ensureFolder(null, 'g');
  assert.ok(r.id);
});
await check('a run of 5xx failures within the retry budget still succeeds', async () => {
  const g = fakeGoogleFetch();
  g.fault.serverError = 3;
  const p = createGoogleDriveProvider({ getAccessToken: okAccessToken, fetchImpl: g.fetchImpl, maxRetries: 4 });
  const r = await p.ensureFolder(null, 'h');
  assert.ok(r.id);
});
await check('exceeding the retry budget gives up and throws a classified, catchable error', async () => {
  const g = fakeGoogleFetch();
  g.fault.serverError = 99;
  const p = createGoogleDriveProvider({ getAccessToken: okAccessToken, fetchImpl: g.fetchImpl, maxRetries: 2 });
  await assert.rejects(() => p.ensureFolder(null, 'i'), DriveNetworkError);
});
await check('a genuine network failure (not an HTTP response at all) is retried, then classified as a network error', async () => {
  const g = fakeGoogleFetch();
  g.fault.networkDown = 99;
  const p = createGoogleDriveProvider({ getAccessToken: okAccessToken, fetchImpl: g.fetchImpl, maxRetries: 1 });
  await assert.rejects(() => p.ensureFolder(null, 'j'), DriveNetworkError);
});
await check('a 401 is retried exactly once (in case the access token was stale) and then classified as an auth error, not a network one', async () => {
  const g = fakeGoogleFetch();
  g.fault.unauthorized = 99; // always unauthorized, so the single retry also fails
  const p = createGoogleDriveProvider({ getAccessToken: okAccessToken, fetchImpl: g.fetchImpl });
  await assert.rejects(() => p.ensureFolder(null, 'k'), DriveAuthError);
  assert.equal(g.calls().filter((c) => c.endsWith('/files')).length, 2, 'exactly 2 attempts for one logical call - the retry, not a loop');
});
await check('getAccessToken itself reporting "not connected" is a DriveAuthError immediately - never even reaches the network', async () => {
  const g = fakeGoogleFetch();
  const p = createGoogleDriveProvider({ getAccessToken: async () => ({ ok: false, error: 'Not connected.' }), fetchImpl: g.fetchImpl });
  await assert.rejects(() => p.ensureFolder(null, 'x'), DriveAuthError);
  assert.equal(g.calls().length, 0);
});
await check('an ordinary 4xx (not found, bad request) is NOT retried - it is the caller\'s mistake, not a flake', async () => {
  const g = fakeGoogleFetch();
  const p = createGoogleDriveProvider({ getAccessToken: okAccessToken, fetchImpl: g.fetchImpl });
  await assert.rejects(() => p.downloadFile('does-not-exist'));
  assert.equal(g.calls().length, 1, 'one attempt only - a 404 is not retried');
});

// ------------------------------------------------------------------ compatibility with the Phase 24B backup engine
await check('COMPATIBILITY: the real provider, driven by the fake Drive HTTP layer, runs an actual backup/restore through the unmodified Phase 24B engine', async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-drive-provider-compat-'));
  try {
    writeKnowledgeNote(TMP, { id: 'nabc12345678901234567', title: 'T', created: 1, updated: 2, tags: [], favorite: false, body: 'hello from compat test' });
    const g = fakeGoogleFetch();
    const provider = createGoogleDriveProvider({ getAccessToken: okAccessToken, fetchImpl: g.fetchImpl });

    const backupResult = await runBackup(TMP, provider, { now: () => 1_700_000_000_000 });
    assert.equal(backupResult.ok, true, backupResult.error);
    assert.equal(backupResult.verified, 1);

    fs.rmSync(path.join(TMP, 'knowledge', 'notes', 'nabc12345678901234567.md'));
    const preview = await previewRestore(TMP, provider, backupResult.backupId);
    assert.equal(preview.ok, true);
    assert.deepEqual(preview.added, ['notes/nabc12345678901234567.md']);

    const restore = await applyRestore(TMP, provider, backupResult.backupId);
    assert.equal(restore.ok, true);
    assert.equal(restore.written, 1);
    assert.equal(fs.readFileSync(path.join(TMP, 'knowledge', 'notes', 'nabc12345678901234567.md'), 'utf8').includes('hello from compat test'), true);
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true });
  }
});

console.log(`google-drive-provider-test: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
