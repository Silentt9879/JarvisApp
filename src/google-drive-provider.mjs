// JARVIS Knowledge - Phase 24C: the REAL Google Drive provider, implementing the exact
// five-method contract src/drive-backup.mjs already finalized and tested against a fake
// (scripts/fake-drive-provider.mjs). drive-backup.mjs does not change to use this - that was
// the whole point of Phase 24B's contract.
//
// `getAccessToken` is the only thing this file trusts for auth - always a function, always
// awaited fresh for every call, never a token cached here. That keeps refresh entirely
// drive-connection.mjs's job; this file only ever asks "give me something to call with right
// now" and reacts to what Drive says back.
//
// This file makes NO backup-policy decisions (what to back up, when, the manifest format -
// all of that stays in drive-backup.mjs) and is never imported by anything except whatever
// future IPC wiring constructs a real provider to hand to runBackup/listBackups/
// previewRestore/applyRestore. It is not imported by main.mjs yet in this phase - Part 4's
// Connection UI only calls drive-connection.mjs, never a backup/restore operation.
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export class DriveAuthError extends Error { constructor(msg) { super(msg); this.name = 'DriveAuthError'; } }
export class DriveNetworkError extends Error { constructor(msg) { super(msg); this.name = 'DriveNetworkError'; } }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function isRateLimited(status, body) {
  if (status === 429) return true;
  if (status !== 403) return false;
  const reason = body?.error?.errors?.[0]?.reason || '';
  return /rateLimitExceeded|userRateLimitExceeded/i.test(reason);
}

export function createGoogleDriveProvider({ getAccessToken, fetchImpl = fetch, log = () => {}, timeoutMs = 30_000, maxRetries = 4 } = {}) {
  /**
   * One authenticated Drive call, with: a bounded timeout, one retry on 401 (in case the
   * token was due for a refresh getAccessToken() hadn't yet noticed), and bounded exponential
   * backoff with jitter on a rate limit or a transient (5xx/network) failure - never an
   * unbounded retry loop, and never a retry on an ordinary 4xx (not found, bad request),
   * which is the caller's own mistake to fix, not a flake to wait out.
   */
  async function call(path, { method = 'GET', body, headers = {}, raw = false } = {}, { _triedAuthRetry = false } = {}) {
    const auth = await getAccessToken();
    if (!auth.ok) throw new DriveAuthError(auth.error || 'Not connected to Google Drive.');

    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      let res;
      try {
        res = await fetchImpl(path, {
          method,
          headers: { Authorization: `Bearer ${auth.accessToken}`, ...headers },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        lastErr = new DriveNetworkError(e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'Google Drive did not respond in time.' : String(e?.message || e));
        if (attempt === maxRetries) throw lastErr;
        await sleep(backoff(attempt));
        continue;
      }
      if (res.status === 401 && !_triedAuthRetry) return call(path, { method, body, headers, raw }, { _triedAuthRetry: true });
      if (res.status === 401) throw new DriveAuthError('Google Drive rejected the connection - reconnect to continue.');
      if (res.ok) return raw ? res : (await res.json().catch(() => ({})));

      const errBody = await res.json().catch(() => null);
      if (isRateLimited(res.status, errBody) || res.status >= 500) {
        lastErr = new DriveNetworkError(errBody?.error?.message || `Google Drive returned ${res.status}.`);
        if (attempt === maxRetries) throw lastErr;
        log(`drive: ${res.status}, retrying (attempt ${attempt + 1}/${maxRetries})`);
        await sleep(backoff(attempt));
        continue;
      }
      // An ordinary 4xx - the caller's request itself is wrong; retrying it changes nothing.
      throw new Error(errBody?.error?.message || `Google Drive returned ${res.status}.`);
    }
    throw lastErr;
  }

  function backoff(attempt) {
    const base = 500 * 2 ** attempt;
    return base + Math.floor(Math.random() * 250); // jitter, so concurrent calls don't retry in lockstep
  }

  async function findFolder(parentId, name) {
    const parent = parentId || 'root';
    const query = `name=${q(name)} and '${parent}' in parents and mimeType=${q(FOLDER_MIME)} and trashed=false`;
    const r = await call(`${API}/files?${new URLSearchParams({ q: query, fields: 'files(id,name)', pageSize: '1' })}`);
    const f = r.files?.[0];
    return f ? { id: f.id, name: f.name } : null;
  }

  async function ensureFolder(parentId, name) {
    const found = await findFolder(parentId, name);
    if (found) return { ...found, created: false };
    const metadata = { name, mimeType: FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}) };
    const r = await call(`${API}/files?fields=id,name`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(metadata) });
    return { id: r.id, name: r.name, created: true };
  }

  async function listChildren(folderId) {
    const query = `'${folderId}' in parents and trashed=false`;
    const r = await call(`${API}/files?${new URLSearchParams({ q: query, fields: 'files(id,name,mimeType,size)', pageSize: '1000' })}`);
    return (r.files || []).map((f) => ({ id: f.id, name: f.name, kind: f.mimeType === FOLDER_MIME ? 'folder' : 'file', size: Number(f.size) || 0 }));
  }

  /** Simple multipart upload - every file this engine sends is a small Markdown note or a
   *  JSON manifest (see docs/jarvis-google-drive-design.md §13.1), never large enough to need
   *  Drive's separate resumable-upload protocol. */
  async function uploadFile(folderId, name, bytes) {
    const boundary = `jarvis-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const metadata = JSON.stringify({ name, ...(folderId ? { parents: [folderId] } : {}) });
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
      Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes),
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    const r = await call(`${UPLOAD_API}?uploadType=multipart&fields=id,name,size`, {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
    });
    return { id: r.id, name: r.name, size: Number(r.size) || bytes.length };
  }

  async function downloadFile(id) {
    const res = await call(`${API}/files/${encodeURIComponent(id)}?alt=media`, { raw: true });
    const buf = Buffer.from(await res.arrayBuffer());
    return buf;
  }

  return { findFolder, ensureFolder, listChildren, uploadFile, downloadFile };
}
