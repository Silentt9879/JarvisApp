// Unit test for read-only project discovery (src/project-discovery.mjs). Everything here
// runs inside a fresh temp folder - never against a real repository - and nothing discovery
// does should ever write, execute or install anything.
//   node scripts/project-discovery-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverProjects, EXCLUDED_DIRS, tagAttribute } from '../src/project-discovery.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${extra ? `\n     ${extra}` : ''}`); } };
const check = async (name, fn) => {
  try { await fn(); ok(true, name); } catch (e) { ok(false, name, String(e.message || e).slice(0, 400)); }
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-discovery-'));
let n = 0;
const freshDir = () => { const d = path.join(TMP, `ws-${n++}`); fs.mkdirSync(d, { recursive: true }); return d; };
const mkdirp = (p) => fs.mkdirSync(p, { recursive: true });
const write = (p, content = '') => { mkdirp(path.dirname(p)); fs.writeFileSync(p, content); };
const byPath = (res, rel) => res.projects.find((p) => p.relativePath === rel);

// ------------------------------------------------------------------ 1. Flutter + Git
await check('a pubspec.yaml with a flutter dependency is typed flutter + dart + git', async () => {
  const ws = freshDir();
  const app = path.join(ws, 'my_app');
  mkdirp(path.join(app, '.git'));
  write(path.join(app, 'pubspec.yaml'), 'name: my_app\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\ndependencies:\n  flutter:\n    sdk: flutter\n');
  const res = await discoverProjects(ws);
  const p = byPath(res, 'my_app');
  assert.ok(p, 'the Flutter app is found');
  assert.deepEqual(p.types, ['dart', 'flutter', 'git']);
  assert.ok(p.markers.includes('pubspec.yaml') && p.markers.includes('.git'));
  assert.equal(p.git.isRepo, true);
  assert.deepEqual(p.capabilities, {}, 'project capability fusion is a later phase - this stays empty');
});

// ------------------------------------------------------------------ 2. .NET + Git
await check('a .csproj and a .sln are both typed dotnet, alongside git', async () => {
  const ws = freshDir();
  const api = path.join(ws, 'Api');
  mkdirp(path.join(api, '.git'));
  write(path.join(api, 'Api.sln'), '');
  write(path.join(api, 'Api.csproj'), '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>');
  const res = await discoverProjects(ws);
  const p = byPath(res, 'Api');
  assert.ok(p);
  assert.deepEqual(p.types, ['dotnet', 'git']);
  assert.ok(p.markers.includes('Api.sln') && p.markers.includes('Api.csproj'));
});

// ------------------------------------------------------------------ 3. Node + Git
await check('a package.json is typed node', async () => {
  const ws = freshDir();
  const site = path.join(ws, 'site');
  mkdirp(path.join(site, '.git'));
  write(path.join(site, 'package.json'), JSON.stringify({ name: 'site', version: '1.0.0' }));
  const res = await discoverProjects(ws);
  const p = byPath(res, 'site');
  assert.ok(p);
  assert.deepEqual(p.types, ['git', 'node']);
});

// ------------------------------------------------------------------ 4. Python (no git)
await check('pyproject.toml, requirements.txt and setup.py each type a folder python, without git', async () => {
  const ws = freshDir();
  write(path.join(ws, 'pkg1', 'pyproject.toml'), '[project]\nname = "pkg1"\n');
  write(path.join(ws, 'pkg2', 'requirements.txt'), 'flask\n');
  write(path.join(ws, 'pkg3', 'setup.py'), 'from setuptools import setup\nsetup(name="pkg3")\n');
  const res = await discoverProjects(ws);
  for (const name of ['pkg1', 'pkg2', 'pkg3']) {
    const p = byPath(res, name);
    assert.ok(p, `${name} is found`);
    assert.deepEqual(p.types, ['python']);
    assert.equal(p.git.isRepo, false);
  }
});

// ------------------------------------------------------------------ 5. Gradle/Java
await check('Gradle markers (build.gradle.kts, settings.gradle, gradlew) type a folder gradle', async () => {
  const ws = freshDir();
  const app = path.join(ws, 'android-app');
  write(path.join(app, 'build.gradle.kts'), '');
  write(path.join(app, 'settings.gradle'), '');
  write(path.join(app, 'gradlew'), '#!/bin/sh\n');
  const res = await discoverProjects(ws);
  const p = byPath(res, 'android-app');
  assert.ok(p);
  assert.deepEqual(p.types, ['gradle']);
  assert.ok(p.markers.includes('build.gradle.kts') && p.markers.includes('settings.gradle') && p.markers.includes('gradlew'));
});

// ------------------------------------------------------------------ 6. Maven/Java
await check('a pom.xml types a folder maven', async () => {
  const ws = freshDir();
  write(path.join(ws, 'service', 'pom.xml'), '<project></project>');
  const res = await discoverProjects(ws);
  const p = byPath(res, 'service');
  assert.ok(p);
  assert.deepEqual(p.types, ['maven']);
});

// ------------------------------------------------------------------ 7. mixed workspace, several projects + a plain Dart package
await check('a mixed workspace finds every project and tells a plain Dart package from a Flutter app', async () => {
  const ws = freshDir();
  mkdirp(path.join(ws, 'flutter_app', '.git'));
  write(path.join(ws, 'flutter_app', 'pubspec.yaml'), 'name: flutter_app\ndependencies:\n  flutter:\n    sdk: flutter\n');
  write(path.join(ws, 'dart_pkg', 'pubspec.yaml'), 'name: dart_pkg\ndependencies:\n  lints: ^3.0.0\n');
  write(path.join(ws, 'web_api', 'Web.csproj'), '<Project></Project>');
  write(path.join(ws, 'frontend', 'package.json'), '{"name":"frontend"}');
  const res = await discoverProjects(ws);
  assert.equal(res.projects.length, 4);
  assert.deepEqual(byPath(res, 'flutter_app').types, ['dart', 'flutter', 'git']);
  assert.deepEqual(byPath(res, 'dart_pkg').types, ['dart'], 'no flutter dependency - a plain Dart package, not a Flutter app');
  assert.deepEqual(byPath(res, 'web_api').types, ['dotnet']);
  assert.deepEqual(byPath(res, 'frontend').types, ['node']);
});

// ------------------------------------------------------------------ 8. path containing spaces
await check('a project path containing spaces is discovered like any other', async () => {
  const ws = freshDir();
  const dir = path.join(ws, 'My Cool App', 'sub folder');
  write(path.join(dir, 'package.json'), '{"name":"spacey"}');
  const res = await discoverProjects(ws);
  const p = byPath(res, 'My Cool App/sub folder');
  assert.ok(p, 'found despite the spaces');
  assert.deepEqual(p.types, ['node']);
});

// ------------------------------------------------------------------ 9. malformed marker file
await check('a pubspec.yaml that is not valid YAML still marks the folder dart, just not flutter', async () => {
  const ws = freshDir();
  write(path.join(ws, 'broken', 'pubspec.yaml'), '{{{ not yaml at all :::: ???');
  const res = await discoverProjects(ws);
  const p = byPath(res, 'broken');
  assert.ok(p, 'discovery never throws on a malformed marker file');
  assert.deepEqual(p.types, ['dart']);
});

await check('an unreadable package.json (a directory where a file is expected) does not stop the scan', async () => {
  const ws = freshDir();
  // package.json as a directory, not a file - readFileSync-style parsing would throw; discovery
  // never reads it at all, just checks that the name exists.
  mkdirp(path.join(ws, 'odd', 'package.json'));
  write(path.join(ws, 'normal', 'package.json'), '{}');
  const res = await discoverProjects(ws);
  assert.ok(byPath(res, 'odd'), 'the odd folder is still reported');
  assert.ok(byPath(res, 'normal'), 'and scanning continued to the next one');
});

// ------------------------------------------------------------------ 10. inaccessible / vanished directory
await check('a directory that vanishes between listing and reading is skipped, not fatal', async () => {
  const ws = freshDir();
  write(path.join(ws, 'stays', 'package.json'), '{}');
  const ghost = path.join(ws, 'ghost');
  mkdirp(ghost);
  fs.rmSync(ghost, { recursive: true, force: true }); // listed by nothing now, but exercise the same path if it existed transiently
  const res = await discoverProjects(ws);
  assert.ok(byPath(res, 'stays'), 'the real project is still found');
  assert.equal(res.errors.length, 0, 'a folder that simply is not there is not an error - it is just not there');
});

await check('a workspace root that does not exist comes back as a plain error, not a throw', async () => {
  const res = await discoverProjects(path.join(TMP, 'does-not-exist-at-all'));
  assert.equal(res.projects.length, 0);
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0].error, /could not be read/i);
});

// ------------------------------------------------------------------ 11. empty workspace
await check('an empty workspace finds nothing, and no errors', async () => {
  const ws = freshDir();
  const res = await discoverProjects(ws);
  assert.deepEqual(res.projects, []);
  assert.deepEqual(res.errors, []);
  assert.equal(res.truncated, false);
});

// ------------------------------------------------------------------ 12. nested generated/dependency folders are ignored
await check('node_modules, .git internals, build/dist/.dart_tool/.gradle/bin/obj and friends are never descended into', async () => {
  const ws = freshDir();
  write(path.join(ws, 'app', 'package.json'), '{"name":"app"}');
  // A package.json buried inside node_modules must never be reported as a project of its own.
  write(path.join(ws, 'app', 'node_modules', 'some-dep', 'package.json'), '{"name":"some-dep"}');
  write(path.join(ws, 'app', 'build', 'package.json'), '{"name":"ghost-build"}');
  write(path.join(ws, 'app', '.git', 'package.json'), '{"name":"not-real"}'); // pretend a weird file landed in .git
  write(path.join(ws, 'app', 'bin', 'pom.xml'), '<project/>');
  write(path.join(ws, 'app', 'obj', 'pom.xml'), '<project/>');
  write(path.join(ws, 'app', '.dart_tool', 'pubspec.yaml'), 'name: ghost\n');
  write(path.join(ws, 'app', '.gradle', 'build.gradle'), '');
  const res = await discoverProjects(ws);
  assert.equal(res.projects.length, 1, `only the real project, got: ${JSON.stringify(res.projects.map((p) => p.relativePath))}`);
  assert.equal(res.projects[0].relativePath, 'app');
  assert.ok(['node_modules', 'build', '.git', 'bin', 'obj', '.dart_tool', '.gradle'].every((d) => EXCLUDED_DIRS.has(d)));
});

// ------------------------------------------------------------------ 13. symlink / junction safety
await check('a junction inside the workspace pointing OUTSIDE it is not followed', async () => {
  const outside = freshDir();
  write(path.join(outside, 'package.json'), '{"name":"secret-outside"}');
  const ws = freshDir();
  write(path.join(ws, 'real', 'package.json'), '{"name":"real"}');
  fs.symlinkSync(outside, path.join(ws, 'escape'), 'junction');
  const res = await discoverProjects(ws);
  assert.equal(res.projects.length, 1, 'only the real, in-workspace project is reported');
  assert.equal(res.projects[0].relativePath, 'real');
  assert.ok(!res.projects.some((p) => p.name === 'secret-outside'));
});

await check('a junction pointing back into the workspace is followed once, never looped', async () => {
  const ws = freshDir();
  write(path.join(ws, 'real', 'package.json'), '{"name":"real"}');
  fs.symlinkSync(ws, path.join(ws, 'loop-to-root'), 'junction'); // points at the workspace root itself
  const t0 = Date.now();
  const res = await discoverProjects(ws, { maxDepth: 8 });
  assert.ok(Date.now() - t0 < 5000, 'a self-referencing junction must not hang the scan');
  assert.equal(res.projects.length, 1, 'the real project is reported exactly once, not once per loop iteration');
});

await check('a junction to another in-workspace folder is followed safely (no escape, no duplicate)', async () => {
  const ws = freshDir();
  write(path.join(ws, 'actual', 'package.json'), '{"name":"actual"}');
  fs.symlinkSync(path.join(ws, 'actual'), path.join(ws, 'alias'), 'junction');
  const res = await discoverProjects(ws);
  // Reachable by two names, but the same real folder - discovery de-duplicates by real path.
  assert.equal(res.projects.length, 1);
});

// ------------------------------------------------------------------ async: bounded, cancellable, truncatable
const slowReaddir = (onCall) => {
  const orig = fsp.readdir;
  let inFlight = 0;
  let max = 0;
  let calls = 0;
  fsp.readdir = async (...a) => {
    calls += 1;
    inFlight += 1;
    max = Math.max(max, inFlight);
    try {
      onCall?.(calls);
      await new Promise((r) => setTimeout(r, 5));
      return await orig(...a);
    } finally { inFlight -= 1; }
  };
  return { restore: () => { fsp.readdir = orig; }, max: () => max, calls: () => calls };
};

await check('a big workspace never has more directory reads in flight than the concurrency limit', async () => {
  const ws = freshDir();
  for (let i = 0; i < 40; i += 1) write(path.join(ws, `p${i}`, 'sub', 'package.json'), '{}');
  const spy = slowReaddir();
  try {
    const res = await discoverProjects(ws, { concurrency: 4 });
    assert.equal(res.projects.length, 40);
    assert.ok(spy.max() <= 4, `at most 4 at once, saw ${spy.max()}`);
    assert.ok(spy.max() >= 2, 'and it does actually work in parallel');
  } finally { spy.restore(); }
});

await check('the result is the same whatever the concurrency - order and content', async () => {
  const ws = freshDir();
  mkdirp(path.join(ws, 'a', '.git'));
  write(path.join(ws, 'a', 'pubspec.yaml'), 'name: a\ndependencies:\n  flutter:\n    sdk: flutter\n');
  write(path.join(ws, 'a', 'android', 'build.gradle'), '');
  write(path.join(ws, 'b', 'B.csproj'), '<Project/>');
  write(path.join(ws, 'c', 'deep', 'er', 'package.json'), '{"name":"c"}');
  const strip = (r) => r.projects.map((p) => ({ ...p, path: undefined }));
  const one = await discoverProjects(ws, { concurrency: 1 });
  const many = await discoverProjects(ws, { concurrency: 16 });
  assert.deepEqual(strip(one), strip(many));
});

await check('an already-aborted signal scans nothing and says it was cancelled', async () => {
  const ws = freshDir();
  write(path.join(ws, 'x', 'package.json'), '{}');
  const ac = new AbortController();
  ac.abort();
  const res = await discoverProjects(ws, { signal: ac.signal });
  assert.equal(res.cancelled, true);
  assert.equal(res.projects.length, 0);
});

await check('aborting mid-scan stops it early, with what was found so far and cancelled: true', async () => {
  const ws = freshDir();
  for (let i = 0; i < 30; i += 1) write(path.join(ws, `p${i}`, 'package.json'), '{}');
  const ac = new AbortController();
  const spy = slowReaddir((n) => { if (n === 5) ac.abort(); });
  try {
    const res = await discoverProjects(ws, { signal: ac.signal, concurrency: 2 });
    assert.equal(res.cancelled, true);
    assert.ok(res.projects.length < 30, `stopped early, found ${res.projects.length}`);
    assert.ok(spy.calls() < 31, 'no new folders were read after the abort');
  } finally { spy.restore(); }
});

await check('maxDirs bounds a runaway tree: truncated, not hung', async () => {
  const ws = freshDir();
  for (let i = 0; i < 25; i += 1) mkdirp(path.join(ws, `d${i}`, 'e'));
  const res = await discoverProjects(ws, { maxDirs: 10 });
  assert.equal(res.truncated, true);
});

// ------------------------------------------------------------------ relationships: one app, not three
await check('a Flutter app\'s android/ host projects are its platform children, not apps of their own', async () => {
  const ws = freshDir();
  const app = path.join(ws, 'shop');
  mkdirp(path.join(app, '.git'));
  write(path.join(app, 'pubspec.yaml'), 'name: shop\ndependencies:\n  flutter:\n    sdk: flutter\n');
  write(path.join(app, 'lib', 'main.dart'), 'void main() {}');
  write(path.join(app, 'android', 'settings.gradle'), '');
  write(path.join(app, 'android', 'app', 'build.gradle'), '');
  write(path.join(app, 'packages', 'widgets', 'pubspec.yaml'), 'name: widgets\ndependencies:\n  flutter:\n    sdk: flutter\n');
  const res = await discoverProjects(ws);
  const shop = byPath(res, 'shop');
  assert.equal(shop.parentId, null);
  assert.equal(shop.role, 'root');
  assert.equal(shop.meta.app, true, 'lib/main.dart: a runnable app');
  assert.equal(byPath(res, 'shop/android').parentId, 'shop');
  assert.equal(byPath(res, 'shop/android').role, 'platform');
  assert.equal(byPath(res, 'shop/android/app').parentId, 'shop/android');
  assert.equal(byPath(res, 'shop/android/app').role, 'platform');
  assert.equal(byPath(res, 'shop/packages/widgets').role, 'package');
  assert.equal(byPath(res, 'shop/packages/widgets').meta.app, false, 'no lib/main.dart: a package, not an app');
  assert.deepEqual(shop.children.sort(), ['shop/android', 'shop/packages/widgets']);
});

await check('a repository holding .NET projects: the projects are its modules, a *.Tests project is a test', async () => {
  const ws = freshDir();
  mkdirp(path.join(ws, 'gateway', '.git'));
  write(path.join(ws, 'gateway', 'Api', 'Api.csproj'), '<Project Sdk="Microsoft.NET.Sdk.Web"/>');
  write(path.join(ws, 'gateway', 'Api.Tests', 'Api.Tests.csproj'), '<Project Sdk="Microsoft.NET.Sdk"/>');
  const res = await discoverProjects(ws);
  assert.deepEqual(byPath(res, 'gateway').types, ['git']);
  assert.equal(byPath(res, 'gateway/Api').parentId, 'gateway');
  assert.equal(byPath(res, 'gateway/Api').role, 'module');
  assert.equal(byPath(res, 'gateway/Api.Tests').role, 'test');
});

await check('when the workspace itself is a project, every other project hangs off it', async () => {
  const ws = freshDir();
  mkdirp(path.join(ws, '.git'));
  write(path.join(ws, 'package.json'), '{"name":"mono"}');
  write(path.join(ws, 'packages', 'ui', 'package.json'), '{"name":"@mono/ui"}');
  const res = await discoverProjects(ws);
  const root = byPath(res, '.');
  assert.equal(root.parentId, null);
  assert.equal(byPath(res, 'packages/ui').parentId, '.');
  assert.equal(byPath(res, 'packages/ui').role, 'package');
});

// ------------------------------------------------------------------ display names from the project's own files
await check('display names come from the project itself, never from a list in JARVIS', async () => {
  const ws = freshDir();
  write(path.join(ws, 'app1', 'pubspec.yaml'), 'name: app1\ndependencies:\n  flutter:\n    sdk: flutter\n');
  write(path.join(ws, 'app1', 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), '<manifest><application android:label="Corner Shop" android:icon="@mipmap/x"></application></manifest>');
  write(path.join(ws, 'app2', 'pubspec.yaml'), 'name: app2\ndependencies:\n  flutter:\n    sdk: flutter\n');
  write(path.join(ws, 'app2', 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), '<manifest><application android:label="@string/app_name"></application></manifest>');
  write(path.join(ws, 'svc', 'Billing Service.csproj'), '<Project/>');
  write(path.join(ws, 'web', 'package.json'), '{"name":"storefront"}');
  write(path.join(ws, 'bad', 'package.json'), '{ not json');
  write(path.join(ws, 'py', 'pyproject.toml'), '[project]\nname = "ledger"\n');
  const res = await discoverProjects(ws);
  assert.equal(byPath(res, 'app1').displayName, 'Corner Shop');
  assert.equal(byPath(res, 'app2').displayName, 'app2', 'a resource reference is not a name - the folder is used');
  assert.equal(byPath(res, 'svc').displayName, 'Billing Service');
  assert.equal(byPath(res, 'web').displayName, 'storefront');
  assert.equal(byPath(res, 'bad').displayName, 'bad', 'malformed package.json falls back to the folder name');
  assert.equal(byPath(res, 'py').displayName, 'ledger');
});

await check('crafted marker files cannot stall a scan: a megabyte of blank lines or open tags reads in moments', async () => {
  // Each of these took minutes with the earlier patterns (every line start rescanning the
  // rest of the file). Just under the 1 MB read limit, so they are really read.
  const ws = freshDir();
  const MB = 1024 * 1024 - 64;
  write(path.join(ws, 'blank', 'pubspec.yaml'), '\n'.repeat(MB));
  write(path.join(ws, 'spaced', 'pubspec.yaml'), ' \n'.repeat(MB / 2));
  write(path.join(ws, 'py', 'pyproject.toml'), '\n'.repeat(MB));
  write(path.join(ws, 'app', 'pubspec.yaml'), 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n');
  write(path.join(ws, 'app', 'lib', 'main.dart'), 'void main() {}');
  write(path.join(ws, 'app', 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), '<application '.repeat(Math.floor(MB / 13)));
  const t = Date.now();
  const res = await discoverProjects(ws);
  const ms = Date.now() - t;
  assert.ok(ms < 3000, `scanned in ${ms} ms`);
  assert.deepEqual(byPath(res, 'blank').types, ['dart'], 'still a Dart package, just not Flutter');
  assert.equal(byPath(res, 'py').displayName, 'py', 'no name found: the folder name');
  assert.equal(byPath(res, 'app').displayName, 'app', 'no label found: the folder name');
});

await check('tagAttribute reads a tag\'s own attribute, skipping a tag without it, and stays fast on a crafted file', async () => {
  assert.equal(tagAttribute('<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup/></Project>', 'Project', 'Sdk'), 'Microsoft.NET.Sdk.Web');
  assert.equal(tagAttribute('<!-- <Project> --><Project\n  Sdk = "Microsoft.NET.Sdk">', 'Project', 'Sdk'), 'Microsoft.NET.Sdk', 'the first tag WITH it');
  assert.equal(tagAttribute('<Project><Sdk Name="x"/></Project>', 'Project', 'Sdk'), null, 'an attribute of another tag is not this one\'s');
  assert.equal(tagAttribute('<manifest><application android:icon="@mipmap/x" android:label="Shop"></application>', 'application', 'android:label'), 'Shop');
  assert.equal(tagAttribute('', 'Project', 'Sdk'), null);
  const t = Date.now();
  assert.equal(tagAttribute('<Project '.repeat(116000), 'Project', 'Sdk'), null);
  assert.ok(Date.now() - t < 500, `${Date.now() - t} ms`);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`project-discovery-test: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
