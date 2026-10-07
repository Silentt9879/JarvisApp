// The Capability Registry: what developer tools exist on this PC, and - for the few where
// "installed" and "ready to use" are different questions - whether they are configured.
//
// Three things this is NOT:
//   - a project scanner (see project-discovery.mjs: "Flutter is on this PC" here says
//     nothing about whether any open project is a Flutter project)
//   - continuous: every check here costs a process spawn, so results are cached and only
//     re-probed after CACHE_MS or an explicit invalidateCapabilities()/force
//   - a place that can fail loudly: a missing tool resolves to { installed: false }, never
//     a thrown error - "not installed" is a normal, common, expected state
import { runCommand } from './updates.mjs';
import { adbExecutable } from './devices.mjs';

const TIMEOUT_MS = 15_000;
const CACHE_MS = 5 * 60 * 1000;

export const CAPABILITY_IDS = [
  'claude', 'git', 'gh', 'node', 'npm', 'flutter', 'dart', 'dotnet',
  'adb', 'vscode', 'python', 'java', 'gradle', 'maven',
];

const probe = (run, cmd, args) => run(cmd, args, { timeoutMs: TIMEOUT_MS });

/** The first line of `where <cmd>` - a local file path, never a secret. Null if not found. */
async function resolveWhere(run, cmd) {
  if (!cmd || /[\\/]/.test(cmd)) return cmd || null; // already a path (e.g. adb's SDK-resolved exe)
  const r = await probe(run, 'where', [cmd]);
  if (!r.ok) return null;
  return r.output.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || null;
}

/** Most tools: run `cmd args`, pull a version out of the combined stdout+stderr with `versionRe`. */
async function detectGeneric(run, id, label, cmd, args, versionRe) {
  const r = await probe(run, cmd, args);
  const installed = !!r.ok;
  const m = installed ? versionRe.exec(r.output) : null;
  return {
    id, label, installed,
    version: m ? m[1] : null,
    where: installed ? (await resolveWhere(run, cmd)) || cmd : null,
    configured: null,
    error: installed ? null : 'Not installed on this PC.',
  };
}

/** The GitHub CLI: installed is `gh --version`; configured is `gh auth status` (signed in to a host). */
async function detectGh(run) {
  const base = await detectGeneric(run, 'gh', 'GitHub CLI', 'gh', ['--version'], /(\d+\.\d+\.\d+)/);
  if (!base.installed) return base;
  const auth = await probe(run, 'gh', ['auth', 'status']);
  return {
    ...base,
    configured: auth.ok,
    error: auth.ok ? null : 'Installed, but not signed in to any GitHub host (gh auth login).',
  };
}

/** Python: `python`, falling back to the Windows launcher `py` (mirrors workspace.mjs's knowledge-script fallback). */
async function detectPython(run) {
  let r = await probe(run, 'python', ['--version']);
  let cmd = 'python';
  if (!r.ok) {
    const alt = await probe(run, 'py', ['--version']);
    if (alt.ok) { r = alt; cmd = 'py'; }
  }
  const installed = !!r.ok;
  const m = installed ? /(\d+\.\d+\.\d+)/.exec(r.output) : null;
  return {
    id: 'python', label: 'Python', installed,
    version: m ? m[1] : null,
    where: installed ? (await resolveWhere(run, cmd)) || cmd : null,
    configured: null,
    error: installed ? null : 'Not installed on this PC.',
  };
}

/** ADB: the Android SDK's own adb when devices.mjs can find one, else whatever "adb" resolves to on PATH. */
async function detectAdb(run) {
  const exe = adbExecutable();
  const r = await probe(run, exe, ['version']);
  const installed = !!r.ok;
  const m = installed ? /version (\d+\.\d+\.\d+)/i.exec(r.output) : null;
  return {
    id: 'adb', label: 'ADB', installed,
    version: m ? m[1] : null,
    where: installed ? (await resolveWhere(run, exe)) || exe : null,
    configured: null,
    error: installed ? null : 'Not installed on this PC (needs the Android SDK platform-tools).',
  };
}

let cache = { at: 0, byId: null };

/** Forget the cached results, so the next getCapabilities() call probes again. */
export function invalidateCapabilities() {
  cache = { at: 0, byId: null };
}

/**
 * Every capability's current state. Cached for CACHE_MS; pass `force: true` (or call
 * invalidateCapabilities() first) to probe again right away - e.g. after installing a tool.
 * `run` is injectable for tests: (file, args, opts) => Promise<{ ok, code, output }>, the
 * same shape as updates.mjs's runCommand, which is the default.
 */
export async function getCapabilities({ run = runCommand, force = false } = {}) {
  if (!force && cache.byId && Date.now() - cache.at < CACHE_MS) {
    return CAPABILITY_IDS.map((id) => cache.byId.get(id));
  }
  const results = await Promise.all([
    detectGeneric(run, 'claude', 'Claude Code', 'claude', ['--version'], /(\d+\.\d+\.\d+)/),
    detectGeneric(run, 'git', 'Git', 'git', ['--version'], /(\d+\.\d+\.\d+)/),
    detectGh(run),
    detectGeneric(run, 'node', 'Node', 'node', ['--version'], /(\d+\.\d+\.\d+)/),
    detectGeneric(run, 'npm', 'npm', 'npm', ['--version'], /(\d+\.\d+\.\d+)/),
    detectGeneric(run, 'flutter', 'Flutter', 'flutter', ['--version'], /Flutter (\d+\.\d+\.\d+)/),
    detectGeneric(run, 'dart', 'Dart', 'dart', ['--version'], /version:?\s*(\d+\.\d+\.\d+)/i),
    detectGeneric(run, 'dotnet', '.NET', 'dotnet', ['--version'], /(\d+\.\d+\.\d+)/),
    detectAdb(run),
    detectGeneric(run, 'vscode', 'VS Code', 'code', ['--version'], /(\d+\.\d+\.\d+)/),
    detectPython(run),
    detectGeneric(run, 'java', 'Java', 'java', ['-version'], /version "?(\d+(?:\.\d+)*)/),
    detectGeneric(run, 'gradle', 'Gradle', 'gradle', ['--version'], /Gradle (\d+\.\d+(?:\.\d+)?)/),
    detectGeneric(run, 'maven', 'Maven', 'mvn', ['--version'], /Apache Maven (\d+\.\d+\.\d+)/),
  ]);
  cache = { at: Date.now(), byId: new Map(results.map((r) => [r.id, r])) };
  return results;
}
