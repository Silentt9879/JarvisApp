// JARVIS Knowledge - Phase 24B: an in-memory stand-in for Google Drive, implementing exactly
// the five-method provider contract src/drive-backup.mjs documents at its own top. Used only
// by tests - no network, no Google account, nothing real. Also exposes small, explicit fault
// hooks (`corruptNextUpload`, `failNextDownload`, `failNextUpload`) so a test can simulate a
// bad network or a corrupted transfer without needing a real flaky connection to reproduce it.
//
// One deliberate simplification versus real Drive: Drive itself allows several files with the
// same name in one folder (names are not unique); this fake overwrites by name within a
// folder instead, so "upload this name again" always has one unambiguous, current answer. The
// backup engine never relies on that simplification for its own correctness - it always
// verifies by content hash, never by assuming a name is unique - so this only makes the fake
// easier to reason about in a test, never papers over a bug the engine itself would have
// against the real Drive API.
import { createHash, randomUUID } from 'node:crypto';

const hashOf = (buf) => createHash('sha256').update(buf).digest('hex');

export class FakeDriveProvider {
  constructor() {
    this.folders = new Map();           // id -> { id, name, parentId }
    this.files = new Map();             // id -> { id, name, parentId, bytes }
    this._corruptNextUpload = false;
    this._failNextDownload = 0;         // how many subsequent downloads to fail
    this._failNextUpload = 0;           // how many subsequent uploads to fail
  }

  /** The next upload succeeds, but the bytes read back by downloadFile are silently altered - a "bad transfer." */
  corruptNextUpload() { this._corruptNextUpload = true; }
  /** The next N downloadFile calls reject, as if the network dropped mid-transfer. */
  failNextDownload(n = 1) { this._failNextDownload = n; }
  /** downloadFile(fileId) rejects exactly N times for this ONE file id - everything else
   *  (the manifest, every other file) is unaffected, unlike failNextDownload's sequential
   *  count, which doesn't distinguish which call it lands on. */
  failDownloadFor(fileId, n = 1) { this._failForId = this._failForId || new Map(); this._failForId.set(fileId, n); }
  /** The next N uploadFile calls reject outright. */
  failNextUpload(n = 1) { this._failNextUpload = n; }

  async findFolder(parentId, name) {
    for (const f of this.folders.values()) if (f.parentId === parentId && f.name === name) return { id: f.id, name: f.name };
    return null;
  }

  async ensureFolder(parentId, name) {
    const found = await this.findFolder(parentId, name);
    if (found) return { ...found, created: false };
    const id = randomUUID();
    this.folders.set(id, { id, name, parentId });
    return { id, name, created: true };
  }

  async listChildren(folderId) {
    const out = [];
    for (const f of this.folders.values()) if (f.parentId === folderId) out.push({ id: f.id, name: f.name, kind: 'folder' });
    for (const f of this.files.values()) if (f.parentId === folderId) out.push({ id: f.id, name: f.name, kind: 'file', size: f.bytes.length });
    return out;
  }

  async uploadFile(folderId, name, bytes) {
    if (this._failNextUpload > 0) { this._failNextUpload -= 1; throw new Error('simulated upload failure'); }
    // Overwrite-by-name within this folder (see the file header for why).
    let existing = null;
    for (const f of this.files.values()) if (f.parentId === folderId && f.name === name) { existing = f; break; }
    const id = existing?.id || randomUUID();
    const stored = this._corruptNextUpload ? Buffer.concat([Buffer.from(bytes), Buffer.from([0])]) : Buffer.from(bytes);
    this._corruptNextUpload = false;
    this.files.set(id, { id, name, parentId: folderId, bytes: stored });
    return { id, name, size: bytes.length };
  }

  async downloadFile(id) {
    if (this._failNextDownload > 0) { this._failNextDownload -= 1; throw new Error('simulated download failure'); }
    const targeted = this._failForId?.get(id);
    if (targeted > 0) { this._failForId.set(id, targeted - 1); throw new Error('simulated download failure for this file'); }
    const f = this.files.get(id);
    if (!f) { const e = new Error('file not found'); e.code = 'ENOENT'; throw e; }
    return Buffer.from(f.bytes);
  }

  /** Test-only convenience, not part of the provider contract: the real bytes currently stored for a file id, for asserting against directly. */
  _rawBytes(id) { return this.files.get(id)?.bytes ?? null; }
  _hashOf(id) { const b = this._rawBytes(id); return b ? hashOf(b) : null; }
}
