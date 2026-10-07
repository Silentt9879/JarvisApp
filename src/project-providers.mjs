// Project providers: what a discovered project NEEDS from this machine, and - for the actions
// layer - what can safely be done with it.
//
// Three different facts meet here and stay distinct:
//   project type        "this folder has a pubspec.yaml"            (project-discovery.mjs)
//   machine capability  "Flutter is installed on this PC"            (capabilities.mjs)
//   project capability  "this project can use Flutter actions"       (this file: type + machine)
//
// A requirement is a list of groups; every group must be met, and a group is met by ANY one
// of its capabilities - a plain Dart package is happy with Dart or with Flutter (which ships
// Dart), a Gradle project with a wrapper needs only a JDK.
//
// Everything here only READS small project files (a csproj, a package.json). Nothing runs.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { tagAttribute } from './project-discovery.mjs';

const MAX_READ = 1024 * 1024;
async function readSmall(file) {
  try {
    const st = await fsp.stat(file);
    if (!st.isFile() || st.size > MAX_READ) return null;
    return (await fsp.readFile(file, 'utf8')).replace(/^﻿/, '');
  } catch { return null; }
}

/**
 * A project's folder on disk, but only while it is still inside the workspace - checked
 * again at the moment of use, through the real path, so a folder swapped for a junction
 * since the scan cannot point a Run anywhere else.
 */
export function projectDir(workspaceRoot, project) {
  if (!workspaceRoot || !project || typeof project.relativePath !== 'string') return null;
  if (project.relativePath.split('/').includes('..')) return null;
  const dir = path.resolve(workspaceRoot, project.relativePath === '.' ? '.' : project.relativePath);
  try {
    const real = fs.realpathSync(dir).toLowerCase();
    const root = fs.realpathSync(workspaceRoot).toLowerCase();
    if (real !== root && !real.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) return null;
    return fs.statSync(dir).isDirectory() ? dir : null;
  } catch { return null; }
}

// ------------------------------------------------------------------ Flutter / Dart

/**
 * Discovered Flutter projects that are apps (a lib/main.dart) - what Devices can Run. `warn`
 * is the person's own warning for that project (Settings), asked about before a run.
 */
export function flutterApps(projects = []) {
  return projects
    .filter((p) => p.types?.includes('flutter') && p.meta?.app && p.role !== 'platform')
    .map((p) => ({ key: p.id, name: p.displayName || p.name, dir: p.relativePath, found: true, warn: p.warning || null }));
}

/** Discovered Dart and Flutter projects, apps and packages alike - what Dart analysis covers. */
export function dartProjects(projects = []) {
  return projects
    .filter((p) => p.types?.includes('dart') && p.role !== 'platform')
    .map((p) => ({ key: p.id, name: p.displayName || p.name, dir: p.relativePath, found: true, app: !!p.meta?.app }));
}

// ------------------------------------------------------------------ .NET

/**
 * What a .NET project folder holds, from its own project file: a web app or API (the Web
 * SDK), a test project, or anything else. A folder with Views/, Pages/ or wwwroot/ serves
 * pages; without them a Web SDK project is an API.
 */
export async function dotnetFacts(absDir, markers = []) {
  const files = markers.filter((m) => /\.csproj$/i.test(m));
  let best = null;
  for (const f of files) {
    const text = await readSmall(path.join(absDir, f)) || '';
    // Tag by tag, never one pattern over the whole file: a crafted project file must not be
    // able to stall the main process (project-discovery.mjs, tagAttribute).
    const sdk = tagAttribute(text, 'Project', 'Sdk') || '';
    const web = /Microsoft\.NET\.Sdk\.(Web|Razor|BlazorWebAssembly)\b/i.test(sdk);
    const test = /Microsoft\.NET\.Test\.Sdk|<IsTestProject>\s*true\s*</i.test(text);
    const exe = /<OutputType>\s*(Win)?Exe\s*</i.test(text);
    const facts = { project: f, web: web && !test, test, exe: exe || web };
    if (!best || (facts.web && !best.web)) best = facts;
  }
  if (!best) return { project: null, web: false, test: false, exe: false, kind: 'solution' };
  let pages = false;
  if (best.web) {
    for (const d of ['Views', 'Pages', 'wwwroot']) {
      try { if (fs.statSync(path.join(absDir, d)).isDirectory()) { pages = true; break; } } catch { /* not there */ }
    }
  }
  return { ...best, kind: best.web ? (pages ? 'web' : 'api') : best.test ? 'test' : best.exe ? 'app' : 'library' };
}

/**
 * The workspace's ASP.NET sites and APIs, from discovery - what the Web apps panel lists.
 * Each is a descriptor webapps.mjs runs as it is: { key, name, kind, dir, absDir, project, warn }.
 * `warn` is the person's own warning for that project (Settings), never a built-in one.
 */
export async function webAppsFrom(workspaceRoot, projects = []) {
  const out = [];
  for (const p of projects) {
    if (!p.types?.includes('dotnet') || p.role === 'platform') continue;
    const absDir = projectDir(workspaceRoot, p);
    if (!absDir) continue;
    const f = await dotnetFacts(absDir, p.markers || []);
    if (!f.web || !f.project) continue;
    out.push({ key: p.id, name: p.displayName || p.name, kind: f.kind, dir: p.relativePath, absDir, project: path.join(absDir, f.project), warn: p.warning || null });
  }
  return out;
}

// ------------------------------------------------------------------ actions
//
// What a person can DO with a project, worked out from its own files and this PC's tools.
// Each action is either a jump to an existing part of JARVIS (Source Control, Devices,
// Dart analysis - nothing duplicated), or a task for task-runner.mjs with the exact command.
// An action that cannot run here is still listed when it would make sense, with the reason -
// so "Test needs the .NET SDK" is visible instead of a missing button.
//
// Nothing is invented: a Node project offers only the scripts its package.json defines, and
// only the common ones; Python offers a test run only when pytest is already in the
// project's own environment; a build never deploys or publishes.

/** Package scripts offered as actions, in this order. Others are left to a terminal or JARVIS. */
export const NODE_SCRIPTS = ['dev', 'start', 'serve', 'test', 'build', 'lint', 'typecheck', 'check'];
const SCRIPT_NAME = /^[A-Za-z0-9_.:-]{1,60}$/;

const capOf = (capabilities, id) => (capabilities || []).find((c) => c.id === id) || null;
const hasCap = (capabilities, id) => !!capOf(capabilities, id)?.installed;
/** The full path of a tool, from where Windows found it for JARVIS - never the project folder. */
const toolPath = (capabilities, id, fallback) => {
  const w = capOf(capabilities, id)?.where;
  return w && path.isAbsolute(w) ? w : fallback;
};
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

/** Which package manager a Node project uses, from its lock file. */
export function nodeManager(absDir) {
  if (exists(path.join(absDir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (exists(path.join(absDir, 'yarn.lock'))) return 'yarn';
  if (exists(path.join(absDir, 'bun.lockb')) || exists(path.join(absDir, 'bun.lock'))) return 'bun';
  return 'npm';
}

/** A Python project's own virtual environment, if it has one (never created here). */
export function pythonEnv(absDir) {
  for (const name of ['.venv', 'venv', 'env']) {
    const dir = path.join(absDir, name);
    const python = path.join(dir, 'Scripts', 'python.exe');
    const posix = path.join(dir, 'bin', 'python');
    if (exists(path.join(dir, 'pyvenv.cfg')) && (exists(python) || exists(posix))) {
      const py = exists(python) ? python : posix;
      const pytest = exists(path.join(dir, 'Scripts', 'pytest.exe')) || exists(path.join(dir, 'bin', 'pytest'));
      return { dir: name, python: py, pytest };
    }
  }
  return null;
}

const task = (id, label, spec, extra = {}) => ({ id, label, kind: 'task', available: true, spec, ...extra });
const jump = (id, label, to, extra = {}) => ({ id, label, kind: 'jump', to, available: true, ...extra });
const missing = (id, label, reason) => ({ id, label, kind: 'task', available: false, reason });

/**
 * Every action for one project. `absDir` is its checked folder (projectDir); `capabilities`
 * is capabilities.mjs's list. Pure apart from reading small files in the project folder.
 */
export async function projectActions(project, absDir, capabilities = []) {
  if (!project || !absDir || project.role === 'platform') return [];
  const t = new Set(project.types || []);
  const out = [];
  const meta = project.meta || {};

  // Git: the existing Source Control, opened on this repository.
  if (t.has('git')) out.push(jump('git', 'Source Control', 'source', { repoKey: project.relativePath }));

  // Flutter and Dart: Run is the Devices page (it needs a phone), Analyse the existing panel.
  if (t.has('flutter') && meta.app) out.push(jump('run', 'Run on a phone', 'devices', { appKey: project.id, needs: hasCap(capabilities, 'flutter') ? null : 'Flutter' }));
  if (t.has('dart')) out.push(jump('analyse', 'Analyse', 'analysis', { appKey: project.id }));
  if (t.has('dart') && exists(path.join(absDir, 'test'))) {
    const flutter = t.has('flutter');
    const tool = flutter ? 'flutter' : (hasCap(capabilities, 'dart') ? 'dart' : 'flutter');
    if (!hasCap(capabilities, tool)) out.push(missing('test', 'Test', `${flutter ? 'Flutter' : 'Dart'} is not installed on this PC.`));
    else out.push(task('test', 'Test', { file: tool, args: ['test'], via: 'cmd' }));
  }

  // .NET: Run is the Web apps panel for a site or API; Build and Test with the SDK.
  if (t.has('dotnet')) {
    const f = await dotnetFacts(absDir, project.markers || []);
    const target = f.project || (project.markers || []).find((m) => /\.sln$/i.test(m)) || null;
    const dotnet = toolPath(capabilities, 'dotnet', null);
    if (f.web) out.push(jump('run', 'Run', 'webapps', { appKey: project.id, needs: hasCap(capabilities, 'dotnet') ? null : '.NET SDK' }));
    if (target) {
      if (!dotnet) out.push(missing('build', 'Build', 'The .NET SDK is not installed on this PC.'));
      else out.push(task('build', 'Build', { file: dotnet, args: ['build', target, '--nologo'], via: null }));
      // Test only where there are tests: a test project, or a solution (which runs its test projects).
      if (f.test || /\.sln$/i.test(target)) {
        if (!dotnet) out.push(missing('test', 'Test', 'The .NET SDK is not installed on this PC.'));
        else out.push(task('test', 'Test', { file: dotnet, args: ['test', target, '--nologo'], via: null }));
      }
    }
  }

  // Node: only the common scripts the project itself defines, through its package manager.
  if (t.has('node')) {
    let scripts = {};
    try { scripts = JSON.parse((await readSmall(path.join(absDir, 'package.json'))) || '{}').scripts || {}; } catch { scripts = {}; }
    const manager = nodeManager(absDir);
    const managerCap = manager === 'npm' ? 'npm' : null; // pnpm / yarn / bun are not in the registry: found on PATH by cmd
    for (const name of NODE_SCRIPTS) {
      if (typeof scripts[name] !== 'string' || !SCRIPT_NAME.test(name)) continue;
      const label = name === 'test' ? 'Test' : name === 'build' ? 'Build' : name === 'dev' || name === 'start' || name === 'serve' ? `Run (${name})` : name[0].toUpperCase() + name.slice(1);
      const id = name === 'test' ? 'test' : name === 'build' ? 'build' : `script:${name}`;
      if (!hasCap(capabilities, 'node') || (managerCap && !hasCap(capabilities, managerCap))) out.push(missing(id, label, 'Node.js is not installed on this PC.'));
      else out.push(task(id, label, { file: manager, args: ['run', name], via: 'cmd' }, { script: scripts[name].slice(0, 200) }));
    }
  }

  // Python: only a test run, and only when pytest is already in the project's own environment.
  // Nothing is installed, created or changed - no environment, no requirements.
  if (t.has('python')) {
    const env = pythonEnv(absDir);
    if (env?.pytest) out.push(task('test', 'Test (pytest)', { file: env.python, args: ['-m', 'pytest'], via: null }, { env: env.dir }));
  }

  // Gradle: the project's own wrapper first; a build that assembles, a test that tests.
  if (t.has('gradle')) {
    const wrapper = exists(path.join(absDir, 'gradlew.bat')) ? '.\\gradlew.bat' : null;
    const runner = wrapper ? { file: wrapper, via: 'cmd' } : hasCap(capabilities, 'gradle') ? { file: 'gradle', via: 'cmd' } : null;
    if (!hasCap(capabilities, 'java')) {
      out.push(missing('build', 'Build', 'Gradle needs a JDK, which is not installed on this PC.'));
    } else if (!runner) {
      out.push(missing('build', 'Build', 'No Gradle wrapper in the project, and Gradle is not installed.'));
    } else {
      out.push(task('build', 'Build', { ...runner, args: ['assemble', '--console=plain'] }));
      out.push(task('test', 'Test', { ...runner, args: ['test', '--console=plain'] }));
    }
  }

  // Maven: the wrapper first; compile and test - never install or deploy.
  if (t.has('maven')) {
    const wrapper = exists(path.join(absDir, 'mvnw.cmd')) ? '.\\mvnw.cmd' : null;
    const runner = wrapper ? { file: wrapper, via: 'cmd' } : hasCap(capabilities, 'maven') ? { file: 'mvn', via: 'cmd' } : null;
    if (!hasCap(capabilities, 'java')) {
      out.push(missing('build', 'Build', 'Maven needs a JDK, which is not installed on this PC.'));
    } else if (!runner) {
      out.push(missing('build', 'Build', 'No Maven wrapper in the project, and Maven is not installed.'));
    } else {
      out.push(task('build', 'Build', { ...runner, args: ['-B', 'compile'] }));
      out.push(task('test', 'Test', { ...runner, args: ['-B', 'test'] }));
    }
  }

  // One action per id: the first wins (a Flutter project's Dart test, not a second one).
  const seen = new Set();
  return out.filter((a) => (seen.has(a.id) ? false : seen.add(a.id)));
}

/** What the window may see of an action: never more than it shows. */
export function actionForWindow(a) {
  const shown = { id: a.id, label: a.label, kind: a.kind, available: a.available !== false };
  if (a.reason) shown.reason = a.reason;
  if (a.to) shown.to = a.to;
  if (a.appKey) shown.appKey = a.appKey;
  if (a.repoKey) shown.repoKey = a.repoKey;
  if (a.needs) shown.needs = a.needs;
  if (a.spec) shown.command = [a.spec.file.replace(/^.*[\\/]/, '').replace(/\.exe$/i, ''), ...a.spec.args].join(' ');
  if (a.script) shown.script = a.script;
  return shown;
}

export const TYPE_LABEL = {
  git: 'Git', flutter: 'Flutter', dart: 'Dart', dotnet: '.NET', node: 'Node',
  python: 'Python', gradle: 'Gradle', maven: 'Maven',
};

/** How to get a missing tool - plain words, no links to click from here. */
export const INSTALL_HINT = {
  git: 'Install Git for Windows (git-scm.com).',
  flutter: 'Install the Flutter SDK (flutter.dev) and add it to PATH.',
  dart: 'Install the Dart SDK or Flutter (which includes Dart).',
  dotnet: 'Install the .NET SDK (dotnet.microsoft.com).',
  node: 'Install Node.js (nodejs.org), which includes npm.',
  npm: 'npm comes with Node.js (nodejs.org).',
  python: 'Install Python (python.org) and tick "Add to PATH".',
  java: 'Install a JDK, for example Eclipse Temurin.',
  gradle: 'Use the project\'s Gradle wrapper (gradlew), or install Gradle.',
  maven: 'Use the project\'s Maven wrapper (mvnw), or install Maven.',
  adb: 'Install the Android SDK platform-tools (with Android Studio or on their own).',
  vscode: 'Install Visual Studio Code and its "code" command.',
  gh: 'Install the GitHub CLI (cli.github.com), then run gh auth login.',
  claude: 'Install Claude Code for the terminal with npm install -g @anthropic-ai/claude-code.',
};

/** What a capability is for, said when it is absent and nothing needs it. */
export const OPTIONAL_PURPOSE = {
  claude: 'JARVIS has its own copy; this is the claude command for your terminal.',
  git: 'Needed for Source Control.',
  gh: 'Not used by JARVIS itself; handy beside it.',
  node: 'Only needed for Node projects.',
  npm: 'Only needed for Node projects.',
  flutter: 'Only needed for Flutter projects.',
  dart: 'Only needed for Dart and Flutter projects.',
  dotnet: 'Only needed for .NET projects.',
  adb: 'Only needed to show and run apps on an Android phone (Devices).',
  vscode: 'Open in VS Code falls back to Windows\' own app for the file.',
  python: 'Only needed for Python projects.',
  java: 'Only needed for Gradle and Maven projects.',
  gradle: 'Only needed for Gradle projects without a wrapper.',
  maven: 'Only needed for Maven projects without a wrapper.',
};

/**
 * The capability groups one project needs. Platform host projects (a Flutter app's android/)
 * need nothing of their own - Flutter drives them - so they never make a tool "required".
 */
export function requirementsFor(project) {
  if (!project || project.role === 'platform') return [];
  const t = new Set(project.types || []);
  const meta = project.meta || {};
  const groups = [];
  if (t.has('git')) groups.push(['git']);
  if (t.has('flutter')) groups.push(['flutter']);
  else if (t.has('dart')) groups.push(['dart', 'flutter']);
  if (t.has('dotnet')) groups.push(['dotnet']);
  if (t.has('node')) groups.push(['node']);
  if (t.has('python')) groups.push(['python']);
  if (t.has('gradle')) {
    if (!meta.gradleWrapper) groups.push(['gradle']);
    groups.push(['java']);
  }
  if (t.has('maven')) {
    if (!meta.mavenWrapper) groups.push(['maven']);
    if (!t.has('gradle')) groups.push(['java']);
  }
  return groups;
}

/** The project types a capability serves, for "Flutter project detected" style messages. */
const SERVES = {
  git: ['git'], flutter: ['flutter'], dart: ['dart'], dotnet: ['dotnet'], node: ['node'],
  python: ['python'], gradle: ['gradle'], maven: ['maven'], java: ['gradle', 'maven'],
};

/**
 * For every capability: how many discovered projects use it, and how many have a need that
 * nothing installed meets (attributed to the group's first capability - the one to install).
 * `capabilities` is capabilities.mjs's list; `projects` is discovery's list.
 */
export function capabilityRelevance(projects = [], capabilities = []) {
  const installed = new Set(capabilities.filter((c) => c.installed).map((c) => c.id));
  const out = {};
  const bump = (id, key, project) => {
    out[id] = out[id] || { used: 0, unmet: 0, unmetProjects: [], types: new Set() };
    out[id][key] += 1;
    if (key === 'unmet') out[id].unmetProjects.push(project.displayName || project.name || project.id);
  };
  for (const p of projects) {
    for (const group of requirementsFor(p)) {
      for (const id of group) {
        bump(id, 'used', p);
        for (const ty of SERVES[id] || []) if ((p.types || []).includes(ty)) out[id].types.add(ty);
      }
      if (!group.some((id) => installed.has(id))) bump(group[0], 'unmet', p);
    }
  }
  return out;
}
