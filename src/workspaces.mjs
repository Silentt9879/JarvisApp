// Workspaces: the folders JARVIS can work in, one active at a time.
//
// In config.json (version 2):
//   workspaces        [{ id, name, path, addedAt, lastOpened, projects? }]
//   activeWorkspaceId the one JARVIS is working in now (null: none chosen yet)
//   cwd               the active workspace's path, mirrored - so a JARVIS older than v2 that
//                     reads this config still opens the right folder
//
// A config from before version 2 has only `cwd`. It is never dropped: it becomes the first
// workspace, with an id derived from its path so the same config always migrates the same
// way. A `cwd` that disagrees with the active workspace was set by something else (an older
// JARVIS, or a hand edit) and wins - it is adopted, not overwritten.
//
// Everything here is pure except the path checks (validateDir), and nothing here ever
// creates, moves or deletes a folder: removing a workspace only forgets it.
//
// TRUST. A workspace's .claude folder can define hooks and MCP servers - commands that run
// on this PC when Claude works there - and JARVIS can run a workspace's own knowledge script.
// So, as Claude Code itself does, a folder is only trusted when the person says so: a
// workspace added to the list starts RESTRICTED (Claude runs with the person's own user
// settings only, and no workspace script runs), until they choose to trust it. The single
// folder an older JARVIS was already using is migrated as trusted - it ran that way already.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export const NO_WORKSPACE = 'Choose a workspace first: the folder that holds your projects (Settings > Workspaces).';
const ID = /^ws_[a-z0-9]{6,32}$/;
const MAX_NAME = 60;
const MAX_WORKSPACES = 50;

export const isWorkspaceId = (s) => typeof s === 'string' && ID.test(s);
const samePath = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** The id a path gets when it is migrated from the old `cwd`: stable for the same folder. */
export function legacyId(dir) {
  return `ws_${createHash('sha256').update(path.resolve(dir).toLowerCase()).digest('hex').slice(0, 12)}`;
}
const newId = () => `ws_${randomBytes(6).toString('hex')}`;

/** A display name a person can read: trimmed, no control characters, at most 60. */
export function cleanName(name) {
  const n = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return n.slice(0, MAX_NAME);
}
const defaultName = (dir) => cleanName(path.basename(path.resolve(dir))) || cleanName(dir) || 'Workspace';

function sanitizeEntry(w) {
  if (!w || typeof w !== 'object' || typeof w.path !== 'string' || !w.path.trim() || !path.isAbsolute(w.path)) return null;
  const projects = w.projects && typeof w.projects === 'object' && !Array.isArray(w.projects) ? w.projects : undefined;
  return {
    ...w,
    id: isWorkspaceId(w.id) ? w.id : legacyId(w.path),
    name: (typeof w.name === 'string' && cleanName(w.name)) || defaultName(w.path),
    path: path.resolve(w.path),
    addedAt: Number.isFinite(w.addedAt) ? w.addedAt : 0,
    lastOpened: Number.isFinite(w.lastOpened) ? w.lastOpened : 0,
    trusted: w.trusted === true,
    ...(projects ? { projects } : {}),
  };
}

/**
 * The workspace model from a raw config, migrating an old one. Pure: no disk access.
 * `migrated` says the result differs from what is stored, and `patch` is what to save.
 */
export function normalizeWorkspaces(raw = {}, { now = Date.now() } = {}) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const list = [];
  const seen = new Set();
  let changed = false;
  for (const w of Array.isArray(cfg.workspaces) ? cfg.workspaces : []) {
    const e = sanitizeEntry(w);
    if (!e) { changed = true; continue; } // unusable (no absolute path): nothing to point at
    const key = e.path.toLowerCase();
    if (seen.has(key)) { changed = true; continue; } // the same folder twice: keep the first
    if (seen.size >= MAX_WORKSPACES) { changed = true; continue; }
    seen.add(key);
    if (e.id !== w.id || e.name !== w.name || e.path !== w.path || e.trusted !== (w.trusted === true)) changed = true;
    list.push(e);
  }
  // Ids must be unique; a clash (hand-edited config) gets a fresh id for the later entry.
  const ids = new Set();
  for (const e of list) { if (ids.has(e.id)) { e.id = newId(); changed = true; } ids.add(e.id); }

  let activeId = isWorkspaceId(cfg.activeWorkspaceId) && list.some((w) => w.id === cfg.activeWorkspaceId) ? cfg.activeWorkspaceId : null;
  if (cfg.activeWorkspaceId !== undefined && activeId !== cfg.activeWorkspaceId) changed = true;

  // The old single folder, or a cwd set behind version 2's back: it is the user's intent.
  const legacy = typeof cfg.cwd === 'string' && cfg.cwd.trim() && path.isAbsolute(cfg.cwd) ? path.resolve(cfg.cwd) : null;
  const active = list.find((w) => w.id === activeId) || null;
  if (legacy && !samePath(legacy, active?.path)) {
    let hit = list.find((w) => samePath(w.path, legacy));
    if (!hit) {
      // The folder JARVIS was already working in, with its full settings: trusted, as before.
      hit = { id: legacyId(legacy), name: defaultName(legacy), path: legacy, addedAt: now, lastOpened: now, trusted: true };
      if (ids.has(hit.id)) hit.id = newId();
      list.push(hit);
    }
    activeId = hit.id;
    changed = true;
  }
  // Something chosen before, but the pointer was lost: the most recently opened one.
  if (!activeId && list.length && cfg.activeWorkspaceId !== null) {
    activeId = [...list].sort((a, b) => b.lastOpened - a.lastOpened)[0].id;
    changed = true;
  }
  const activePath = list.find((w) => w.id === activeId)?.path || null;
  const mirror = activePath || undefined;
  if ((cfg.cwd || undefined) !== mirror) changed = true;
  return {
    workspaces: list,
    activeWorkspaceId: activeId,
    activePath,
    migrated: changed,
    patch: { workspaces: list, activeWorkspaceId: activeId, cwd: activePath },
  };
}

/** The active workspace entry, or null. */
export function activeWorkspace(raw) {
  const n = normalizeWorkspaces(raw);
  return n.workspaces.find((w) => w.id === n.activeWorkspaceId) || null;
}

/**
 * Is this a folder a workspace can be? Absolute, existing, a directory. Resolves to the real
 * path (a junction or symlink is followed once, so two names for one folder are one folder).
 */
export async function validateDir(dir) {
  if (typeof dir !== 'string' || !dir.trim()) return { ok: false, error: 'No folder was given.' };
  if (!path.isAbsolute(dir)) return { ok: false, error: 'That is not a full folder path.' };
  let real;
  try {
    real = await fsp.realpath(path.resolve(dir));
    if (!(await fsp.stat(real)).isDirectory()) return { ok: false, error: 'That is a file, not a folder.' };
  } catch {
    return { ok: false, error: 'That folder does not exist.' };
  }
  // A drive root or the Windows folder is not a workspace: scanning it would mean everything.
  if (path.parse(real).root.toLowerCase() === real.toLowerCase()) return { ok: false, error: 'A whole drive cannot be a workspace. Pick the folder that holds your projects.' };
  const win = process.env.SystemRoot || process.env.windir;
  if (win && (samePath(real, win) || real.toLowerCase().startsWith(path.resolve(win).toLowerCase() + path.sep))) return { ok: false, error: 'The Windows folder cannot be a workspace.' };
  return { ok: true, path: path.resolve(dir), real };
}

const realOf = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/** Add a folder. Never switches to it. An already-listed folder (by real path) is returned as it is. */
export async function addWorkspace(raw, dir, { name, now = Date.now() } = {}) {
  const v = await validateDir(dir);
  if (!v.ok) return v;
  const n = normalizeWorkspaces(raw, { now });
  const dup = n.workspaces.find((w) => samePath(realOf(w.path), v.real) || samePath(w.path, v.path));
  if (dup) return { ok: true, duplicate: true, workspace: dup, patch: n.patch };
  if (n.workspaces.length >= MAX_WORKSPACES) return { ok: false, error: `That is ${MAX_WORKSPACES} workspaces already. Remove one first.` };
  const ws = { id: newId(), name: cleanName(name) || defaultName(v.path), path: v.path, addedAt: now, lastOpened: 0, trusted: false };
  const workspaces = [...n.workspaces, ws];
  return { ok: true, workspace: ws, patch: { ...n.patch, workspaces } };
}

export function renameWorkspace(raw, id, name) {
  const n = normalizeWorkspaces(raw);
  const clean = cleanName(name);
  if (!clean) return { ok: false, error: 'A name needs at least one letter.' };
  const hit = n.workspaces.find((w) => w.id === id);
  if (!hit) return { ok: false, error: 'That workspace is not in the list.' };
  const workspaces = n.workspaces.map((w) => (w.id === id ? { ...w, name: clean } : w));
  return { ok: true, workspace: { ...hit, name: clean }, patch: { ...n.patch, workspaces } };
}

/**
 * Make one active. The folder must still be there - a missing folder is never activated.
 * The caller restarts JARVIS afterwards: nothing is switched in place.
 */
export async function selectWorkspace(raw, id, { now = Date.now(), trust } = {}) {
  const n = normalizeWorkspaces(raw, { now });
  const hit = n.workspaces.find((w) => w.id === id);
  if (!hit) return { ok: false, error: 'That workspace is not in the list.' };
  const v = await validateDir(hit.path);
  if (!v.ok) return { ok: false, error: `${hit.name}: ${v.error}` };
  // `trust` is the person's answer, asked as they switch; absent, the folder keeps its trust.
  const trusted = typeof trust === 'boolean' ? trust : hit.trusted === true;
  const workspaces = n.workspaces.map((w) => (w.id === id ? { ...w, lastOpened: now, trusted } : w));
  return {
    ok: true,
    unchanged: n.activeWorkspaceId === id && trusted === (hit.trusted === true),
    workspace: { ...hit, lastOpened: now, trusted },
    patch: { workspaces, activeWorkspaceId: id, cwd: hit.path },
  };
}

/** Trust a workspace, or take trust back. The caller restarts if it is the active one. */
export function setWorkspaceTrust(raw, id, trusted) {
  const n = normalizeWorkspaces(raw);
  const hit = n.workspaces.find((w) => w.id === id);
  if (!hit) return { ok: false, error: 'That workspace is not in the list.' };
  const workspaces = n.workspaces.map((w) => (w.id === id ? { ...w, trusted: trusted === true } : w));
  return { ok: true, changed: (hit.trusted === true) !== (trusted === true), active: n.activeWorkspaceId === id, workspace: { ...hit, trusted: trusted === true }, patch: { ...n.patch, workspaces } };
}

/**
 * Forget a workspace (the folder itself is not touched). Removing the active one moves to the
 * most recently opened of the rest, or to none - `switched` tells the caller to restart.
 */
export function removeWorkspace(raw, id) {
  const n = normalizeWorkspaces(raw);
  const hit = n.workspaces.find((w) => w.id === id);
  if (!hit) return { ok: false, error: 'That workspace is not in the list.' };
  const workspaces = n.workspaces.filter((w) => w.id !== id);
  if (n.activeWorkspaceId !== id) return { ok: true, removed: hit, switched: false, patch: { ...n.patch, workspaces } };
  const next = [...workspaces].sort((a, b) => b.lastOpened - a.lastOpened)[0] || null;
  return {
    ok: true,
    removed: hit,
    switched: true,
    next,
    // null, not undefined: "nothing is active" is a decision, and must not be re-guessed.
    patch: { workspaces, activeWorkspaceId: next ? next.id : null, cwd: next ? next.path : null },
  };
}

/** Per-project settings a person chose (a display name, a warning before Run), by relative path. */
export function projectSettings(ws, relPath) {
  // Own entries only: a folder called "constructor" or "toString" is a project like any other,
  // not a way into what every JavaScript object inherits.
  const all = ws?.projects;
  const p = all && typeof all === 'object' && typeof relPath === 'string' && Object.hasOwn(all, relPath) ? all[relPath] : null;
  return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
}

const MAX_WARNING = 160;
const CASE_PREFIX = /^[A-Z][A-Z0-9]{0,9}$/;
/**
 * Change one project's settings - { name }, { warning } (shown before it runs), { casePrefix }
 * (its case-code convention, for commit messages) - an empty value removes one.
 */
export function setProjectSettings(raw, id, relPath, patch = {}) {
  const n = normalizeWorkspaces(raw);
  const hit = n.workspaces.find((w) => w.id === id);
  if (!hit) return { ok: false, error: 'That workspace is not in the list.' };
  if (typeof relPath !== 'string' || !relPath || relPath.length > 400 || relPath.split('/').includes('..')) return { ok: false, error: 'That is not a project in this workspace.' };
  const cur = { ...projectSettings(hit, relPath) };
  if ('name' in patch) { const v = cleanName(patch.name); if (v) cur.name = v; else delete cur.name; }
  if ('warning' in patch) {
    const v = String(patch.warning ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_WARNING);
    if (v) cur.warning = v; else delete cur.warning;
  }
  if ('casePrefix' in patch) {
    const v = String(patch.casePrefix ?? '').trim().toUpperCase();
    if (!v) delete cur.casePrefix;
    else if (CASE_PREFIX.test(v)) cur.casePrefix = v;
    else return { ok: false, error: 'A case prefix is 1 to 10 letters or digits, starting with a letter.' };
  }
  // Built as data, never by assignment: settings for a folder named "__proto__" are stored and
  // saved like any other, instead of quietly becoming the object's prototype.
  const entries = Object.entries(hit.projects || {}).filter(([k]) => k !== relPath);
  if (Object.keys(cur).length) entries.push([relPath, cur]);
  const projects = Object.fromEntries(entries);
  const workspaces = n.workspaces.map((w) => (w.id === id ? { ...w, projects } : w));
  return { ok: true, settings: cur, patch: { ...n.patch, workspaces } };
}

/** What the window may see of the list: no more than it needs. */
export function workspacesForWindow(raw) {
  const n = normalizeWorkspaces(raw);
  return {
    activeWorkspaceId: n.activeWorkspaceId,
    workspaces: n.workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      path: w.path,
      lastOpened: w.lastOpened || null,
      active: w.id === n.activeWorkspaceId,
      trusted: w.trusted === true,
      exists: (() => { try { return fs.statSync(w.path).isDirectory(); } catch { return false; } })(),
    })),
  };
}
