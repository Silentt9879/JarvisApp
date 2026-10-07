// Project discovery: what is in a workspace folder, read-only.
//
// This never runs project code, never installs anything, never runs a package script, and
// never writes a file - it only looks at directory listings and, for a few cheap facts (a
// Flutter app vs a plain Dart package, a display name), the text of small marker files. It
// does not even run `git`: a ".git" entry is a marker like any other.
//
// The walk is asynchronous and BOUNDED: at most `concurrency` directories are being read at
// once, so a huge workspace never turns into thousands of simultaneous filesystem calls, and
// the Electron main process is never blocked while it runs.
//
// A project's TYPE ("this folder has a pubspec.yaml") is deliberately kept apart from the
// Capability Registry's MACHINE capability ("Flutter is installed on this PC") - combining
// the two is project-providers.mjs's job. `capabilities` stays `{}` here.
import fsp from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_MAX_DEPTH = 6;
export const DEFAULT_MAX_DIRS = 20_000;
export const DEFAULT_CONCURRENCY = 8;
const MAX_MARKER_BYTES = 1024 * 1024; // a marker file bigger than this is not read, only noted

// Never descended into: generated, dependency and tool-cache folders no project marker is
// ever found under, which would otherwise make a scan slow or ever-growing.
export const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', 'build', 'dist', '.dart_tool', '.gradle', 'bin', 'obj',
  'venv', 'env', '__pycache__', 'target', '.idea', '.vscode', '.vs',
  'out', '.next', '.nuxt', '.pytest_cache', '.mypy_cache',
]);
const isExcluded = (name) => EXCLUDED_DIRS.has(name) || /^\.venv/i.test(name);

const GRADLE_MARKERS = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradlew', 'gradlew.bat'];
// Folders inside a Flutter project that hold its per-platform host projects.
const FLUTTER_PLATFORMS = new Set(['android', 'ios', 'macos', 'windows', 'linux', 'web']);

/** A small text file, or null - too big, unreadable or missing. Never throws. */
async function readSmall(file) {
  try {
    const st = await fsp.stat(file);
    if (!st.isFile() || st.size > MAX_MARKER_BYTES) return null;
    return (await fsp.readFile(file, 'utf8')).replace(/^﻿/, '');
  } catch {
    return null;
  }
}

const exists = async (p) => { try { await fsp.access(p); return true; } catch { return false; } };
const clipName = (s) => String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80);

// Every pattern below reads a file a project controls, on the main process, during a scan
// nobody asked for - so each must stay linear on ANY input. Line patterns use [ \t]*, never
// \s*: \s also matches line breaks, and a megabyte of blank lines would then make every line
// start rescan everything below it (minutes, measured). Tags are cut at their own ">" first.

/** A pubspec.yaml's own text says whether it is a Flutter project or a plain Dart package. */
const looksLikeFlutter = (text) => !!text && (/\bsdk:\s*flutter\b/.test(text) || /^[ \t]*flutter:[ \t]*\r?$/m.test(text));

/**
 * The value of `attr` on the first `<tag ...>` that carries it - read one tag at a time, each
 * cut at its own ">" (and at 8 KB), so a crafted file of "<Project <Project ..." with no ">"
 * costs a linear scan instead of minutes of backtracking. `tag` and `attr` are fixed words
 * from this code, never from a file.
 */
export function tagAttribute(text, tag, attr) {
  if (!text) return null;
  const open = new RegExp(`<${tag}\\b`, 'gi');
  const value = new RegExp(`\\b${attr}\\s*=\\s*"([^"]*)"`, 'i');
  for (let m, n = 0; n < 20 && (m = open.exec(text)); n++) {
    const end = text.indexOf('>', m.index);
    const one = text.slice(m.index, end < 0 ? m.index + 8192 : Math.min(end + 1, m.index + 8192));
    const v = value.exec(one);
    if (v) return v[1];
  }
  return null;
}

/**
 * A human name from the project's own files, where one is cheap and safe to read: a Flutter
 * app's Android label, a .NET project's file name, package.json / pyproject's name. Shown as
 * text only. Falls back to the folder name.
 */
async function displayNameFor(dir, types, markers) {
  if (types.has('flutter')) {
    const manifest = await readSmall(path.join(dir, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'));
    const label = tagAttribute(manifest, 'application', 'android:label');
    // "@string/app_name" is a reference to look up, not a name.
    if (label && !label.startsWith('@')) return clipName(label);
  }
  if (types.has('dotnet')) {
    const proj = markers.find((m) => /\.csproj$/i.test(m)) || markers.find((m) => /\.sln$/i.test(m));
    if (proj) return clipName(proj.replace(/\.(csproj|sln)$/i, ''));
  }
  if (types.has('node')) {
    const text = await readSmall(path.join(dir, 'package.json'));
    try { const n = JSON.parse(text || 'null')?.name; if (typeof n === 'string' && n.trim()) return clipName(n); } catch { /* malformed - fall through */ }
  }
  if (types.has('python')) {
    const text = await readSmall(path.join(dir, 'pyproject.toml'));
    const m = text && /^[ \t]*name[ \t]*=[ \t]*["']([^"'\r\n]{1,80})["']/m.exec(text);
    if (m) return clipName(m[1]);
  }
  return null;
}

/** Case-insensitive: Windows paths are, and a scan must not be fooled by a symlink's case. */
function withinRoot(real, rootReal) {
  const a = real.toLowerCase();
  const b = rootReal.toLowerCase();
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

async function inspect(dir, entries) {
  const names = new Set(entries.map((e) => e.name));
  const has = (n) => names.has(n);
  const markers = [];
  const types = new Set();
  let pubspecText = null;
  if (has('.git')) { markers.push('.git'); types.add('git'); }
  if (has('pubspec.yaml')) {
    markers.push('pubspec.yaml');
    types.add('dart');
    pubspecText = await readSmall(path.join(dir, 'pubspec.yaml'));
    if (looksLikeFlutter(pubspecText)) types.add('flutter');
  }
  if (has('package.json')) { markers.push('package.json'); types.add('node'); }
  if (has('pyproject.toml')) { markers.push('pyproject.toml'); types.add('python'); }
  if (has('requirements.txt')) { markers.push('requirements.txt'); types.add('python'); }
  if (has('setup.py')) { markers.push('setup.py'); types.add('python'); }
  if (has('pom.xml')) { markers.push('pom.xml'); types.add('maven'); }
  for (const n of GRADLE_MARKERS) if (has(n)) { markers.push(n); types.add('gradle'); }
  for (const e of entries) {
    if (e.isFile() && (/\.sln$/i.test(e.name) || /\.csproj$/i.test(e.name))) { markers.push(e.name); types.add('dotnet'); }
  }
  if (!markers.length) return null;
  const meta = {};
  if (types.has('flutter')) meta.app = await exists(path.join(dir, 'lib', 'main.dart'));
  if (types.has('gradle')) meta.gradleWrapper = has('gradlew') || has('gradlew.bat');
  if (types.has('maven')) meta.mavenWrapper = has('mvnw') || has('mvnw.cmd');
  const displayName = await displayNameFor(dir, types, markers);
  return { markers, types, meta, displayName };
}

/**
 * How a nested project relates to the project it sits in - groundwork so a later UI can show
 * "a Flutter app with an Android host project" as one thing, not two unrelated apps.
 *   platform  a Flutter project's android/, ios/, ... host project
 *   test      a test project beside the code it tests
 *   package   a nested Dart, Flutter, Node or Python package
 *   module    anything else nested: a solution member, a Gradle/Maven module, a sub-folder app
 */
function roleOf(project, parent) {
  if (!parent) return 'root';
  const rel = parent.relativePath === '.' ? project.relativePath : project.relativePath.slice(parent.relativePath.length + 1);
  const first = rel.split('/')[0].toLowerCase();
  if (parent.types.includes('flutter') && FLUTTER_PLATFORMS.has(first)) return 'platform';
  // A host project's own sub-modules (android/app) belong to the same platform.
  if (parent.role === 'platform') return 'platform';
  if (/(^|[._-])tests?$/i.test(project.name)) return 'test';
  if (project.types.some((t) => t === 'dart' || t === 'flutter' || t === 'node' || t === 'python')) return 'package';
  return 'module';
}

/** parentId / role / children for every project, from the relative paths alone. */
export function relateProjects(projects) {
  const byRel = new Map(projects.map((p) => [p.relativePath, p]));
  // Parents before children: the root first, then by depth.
  const depth = (p) => (p.relativePath === '.' ? 0 : p.relativePath.split('/').length);
  const sorted = [...projects].sort((a, b) => depth(a) - depth(b) || a.relativePath.localeCompare(b.relativePath));
  for (const p of sorted) {
    let parent = null;
    if (p.relativePath !== '.') {
      const parts = p.relativePath.split('/');
      for (let i = parts.length - 1; i >= 0 && !parent; i -= 1) {
        const up = i === 0 ? '.' : parts.slice(0, i).join('/');
        if (up !== p.relativePath) parent = byRel.get(up) || null;
      }
    }
    p.parentId = parent ? parent.id : null;
    p.role = roleOf(p, parent);
  }
  for (const p of projects) p.children = projects.filter((c) => c.parentId === p.id).map((c) => c.id);
  return projects;
}

/**
 * Scan `root` for projects: any folder (the root itself included) holding one of the marker
 * files/folders above, at any depth up to `maxDepth`, skipping EXCLUDED_DIRS. Never throws -
 * a root that cannot be read comes back as `{ projects: [], errors: [...] }`. An aborted
 * `signal` stops the walk; what was found so far comes back with `cancelled: true`.
 */
export async function discoverProjects(root, {
  maxDepth = DEFAULT_MAX_DEPTH,
  maxDirs = DEFAULT_MAX_DIRS,
  concurrency = DEFAULT_CONCURRENCY,
  signal = null,
} = {}) {
  const fail = (error) => ({ root, projects: [], truncated: false, cancelled: false, errors: [{ path: root, error }] });
  let rootReal;
  try {
    rootReal = await fsp.realpath(root);
    if (!(await fsp.stat(rootReal)).isDirectory()) return fail('That path is not a folder.');
  } catch (e) {
    return fail(`Workspace folder could not be read: ${e.message}`);
  }

  const ctx = { seenReal: new Set(), visited: 0, projects: [], errors: [], truncated: false, cancelled: false };
  const queue = [{ dir: root, depth: 0 }];
  const width = Math.max(1, Math.min(32, Math.floor(concurrency) || 1));

  async function visit({ dir, depth }) {
    let real;
    let st;
    try {
      real = await fsp.realpath(dir);
      st = await fsp.stat(real);
    } catch { return; } // broken link, vanished, or no permission to resolve it
    if (!st.isDirectory()) return; // a symlink/junction to a file, not a folder
    if (!withinRoot(real, rootReal)) return; // would escape the workspace
    const key = real.toLowerCase();
    if (ctx.seenReal.has(key)) return; // a symlink cycle, or two paths landing on the same folder
    ctx.seenReal.add(key);

    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      ctx.errors.push({ path: dir, error: `Could not read this folder: ${e.message}` });
      return;
    }

    const found = await inspect(dir, entries);
    if (found) {
      const relativePath = (path.relative(rootReal, real) || '.').split(path.sep).join('/');
      const name = path.basename(real);
      ctx.projects.push({
        id: relativePath,
        name,
        displayName: found.displayName || name,
        path: dir,
        relativePath,
        types: [...found.types].sort(),
        markers: [...new Set(found.markers)].sort(),
        meta: found.meta,
        capabilities: {},
        git: { isRepo: found.types.has('git') },
      });
    }

    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      if (isExcluded(e.name)) continue;
      queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
    }
  }

  await new Promise((resolve) => {
    let active = 0;
    const pump = () => {
      if (signal?.aborted) { ctx.cancelled = true; queue.length = 0; }
      while (active < width && queue.length) {
        if (ctx.visited >= maxDirs) { ctx.truncated = true; queue.length = 0; break; }
        ctx.visited += 1;
        active += 1;
        visit(queue.shift())
          .catch((e) => { ctx.errors.push({ path: root, error: String(e?.message || e) }); })
          .finally(() => { active -= 1; pump(); });
      }
      if (!active && !queue.length) resolve();
    };
    pump();
  });

  ctx.projects.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  relateProjects(ctx.projects);
  return { root, projects: ctx.projects, truncated: ctx.truncated, cancelled: ctx.cancelled, errors: ctx.errors };
}
