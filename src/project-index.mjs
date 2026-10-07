// The active workspace's projects, discovered once and kept for a minute, so every view that
// asks (Health, Projects, Devices, Source Control) gets the same answer without each one
// walking the folder again. One scan at a time per workspace; a second ask joins it.
//
// The user's own per-project settings (a display name, a warning before Run - workspaces.mjs)
// are laid over the discovered facts here, on a copy: the cache itself stays what was found.
import { discoverProjects } from './project-discovery.mjs';
import { projectSettings, NO_WORKSPACE } from './workspaces.mjs';

export const PROJECT_TTL_MS = 60_000;

function decorate(result, ws) {
  return {
    ...result,
    projects: result.projects.map((p) => {
      const s = projectSettings(ws, p.relativePath);
      return {
        ...p,
        displayName: s.name || p.displayName || p.name,
        foundName: p.displayName || p.name,
        warning: s.warning || null,
      };
    }),
  };
}

export function createProjectIndex({ discover = discoverProjects, ttlMs = PROJECT_TTL_MS, now = () => Date.now(), log = () => {} } = {}) {
  let cache = null; // { wsId, root, at, result }
  let busy = null;  // { wsId, root, promise, abort }

  async function scan(ws) {
    const ac = new AbortController();
    const started = now();
    const promise = (async () => {
      const r = await discover(ws.path, { signal: ac.signal });
      const rootFailed = !r.projects.length && r.errors.some((e) => e.path === ws.path || e.path === r.root);
      const result = {
        ok: !rootFailed,
        error: rootFailed ? r.errors[0].error : null,
        workspaceId: ws.id,
        root: ws.path,
        scannedAt: now(),
        ms: now() - started,
        truncated: !!r.truncated,
        cancelled: !!r.cancelled,
        errors: r.errors.slice(0, 20),
        projects: r.projects,
      };
      if (!r.cancelled) cache = { wsId: ws.id, root: ws.path, at: result.scannedAt, result };
      log(`projects: ${r.projects.length} found in ${result.ms} ms${r.truncated ? ' (stopped at the folder limit)' : ''}${r.errors.length ? `, ${r.errors.length} folder(s) unreadable` : ''}`);
      return result;
    })();
    busy = { wsId: ws.id, root: ws.path, promise, abort: ac };
    try { return await promise; } finally { if (busy?.promise === promise) busy = null; }
  }

  /** The projects of `ws` (a workspaces.mjs entry). `refresh` scans again even if a fresh answer is kept. */
  async function get(ws, { refresh = false } = {}) {
    if (!ws) return { ok: false, error: NO_WORKSPACE, projects: [] };
    if (!refresh && cache && cache.wsId === ws.id && cache.root === ws.path && now() - cache.at < ttlMs) return decorate(cache.result, ws);
    if (busy && busy.wsId === ws.id && busy.root === ws.path) return decorate(await busy.promise, ws);
    if (busy) busy.abort.abort(); // a scan of some other folder: no longer wanted
    return decorate(await scan(ws), ws);
  }

  /** A project of the active workspace by id, from the kept answer (scanning only if there is none). */
  async function find(ws, id) {
    if (typeof id !== 'string' || !id) return null;
    const r = await get(ws);
    return r.projects?.find((p) => p.id === id) || null;
  }

  /** The kept answer for `ws`, without scanning - for callers that cannot wait (display names). */
  function peek(ws) {
    if (!ws || !cache || cache.wsId !== ws.id || cache.root !== ws.path) return null;
    return decorate(cache.result, ws);
  }

  function invalidate() { cache = null; }
  function stop() { busy?.abort.abort(); busy = null; }

  return { get, find, peek, invalidate, stop };
}
