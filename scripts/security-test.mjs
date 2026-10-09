// Security checks for the generalized app: paths that try to leave the workspace, links that
// try to lead out of it, files that would run if "opened", the window boundary, and what the
// renderer is (not) given. Temp folders only.   node scripts/security-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readWorkspaceFile, inside, OPENABLE, openInVsCode } from '../src/files.mjs';
import { readDoc } from '../src/workspace.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${extra ? `\n     ${extra}` : ''}`); } };
const check = async (name, fn) => { try { await fn(); ok(true, name); } catch (e) { ok(false, name, String(e.message || e).slice(0, 300)); } };
const src = (f) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-security-'));
const ws = path.join(TMP, 'ws');
const outside = path.join(TMP, 'outside');
fs.mkdirSync(path.join(ws, 'app', 'lib'), { recursive: true });
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(ws, 'app', 'lib', 'main.dart'), 'void main() {}');
fs.writeFileSync(path.join(outside, 'secret.md'), '# not yours');
fs.writeFileSync(path.join(outside, 'id_rsa'), 'PRIVATE');
fs.symlinkSync(outside, path.join(ws, 'app', 'linked'), 'junction');
fs.mkdirSync(path.join(ws, '.claude', 'knowledge'), { recursive: true });
fs.writeFileSync(path.join(ws, '.claude', 'knowledge', 'ok.md'), '# fine');
fs.symlinkSync(outside, path.join(ws, '.claude', 'knowledge', 'escape'), 'junction');

// ------------------------------------------------------------------ the filesystem boundary
await check('a workspace file is read; traversal, absolute paths and a sibling folder are refused', async () => {
  assert.match((await readWorkspaceFile(ws, 'app/lib/main.dart')).text, /void main/);
  for (const bad of ['../outside/id_rsa', '..\\outside\\id_rsa', path.join(outside, 'id_rsa'), 'C:\\Windows\\win.ini', '']) {
    await assert.rejects(() => readWorkspaceFile(ws, bad), /outside the workspace/, bad);
  }
  fs.mkdirSync(`${ws}-other`, { recursive: true });
  fs.writeFileSync(path.join(`${ws}-other`, 'x.txt'), 'x');
  assert.equal(inside(ws, `../${path.basename(ws)}-other/x.txt`), null, '"ws-other" is not inside "ws"');
  assert.equal(inside(ws, 'APP/LIB/main.dart')?.toLowerCase(), path.join(ws, 'app', 'lib', 'main.dart').toLowerCase(), 'case does not matter on Windows');
  assert.equal(inside(null, 'x'), null, 'no workspace, nothing is inside it');
});

await check('a junction inside the workspace cannot be used to read outside it', async () => {
  await assert.rejects(() => readWorkspaceFile(ws, 'app/linked/id_rsa'), /outside the workspace/);
});

await check('documents: only .md, only inside their folder, and not through a link that leads out', async () => {
  assert.match((await readDoc(ws, 'knowledge', 'ok.md')).text, /fine/);
  await assert.rejects(() => readDoc(ws, 'knowledge', 'escape/secret.md'), /outside the allowed folders/);
  await assert.rejects(() => readDoc(ws, 'knowledge', '../../../outside/secret.md'), /outside the allowed folders/);
  await assert.rejects(() => readDoc(ws, 'knowledge', '../../app/lib/main.dart'), /outside the allowed folders/);
  await assert.rejects(() => readDoc(ws, 'nope', 'ok.md'), /Unknown document/);
});

await check('"open" without VS Code hands only plain documents and pictures to Windows - anything else is shown in Explorer', async () => {
  for (const f of ['README.md', 'notes.txt', 'app.json', 'data.csv', 'logo.png', 'spec.pdf', 'schema.sql', 'build.log']) assert.ok(OPENABLE.test(f), f);
  // Scripts and programs, including the ones a blocklist missed: .sh runs in Git Bash, .py in Python.
  for (const f of ['run.sh', 'tool.py', 'gui.pyw', 'setup.exe', 'run.bat', 'a.cmd', 'x.ps1', 'link.lnk', 'evil.js', 'p.msi', 'r.reg', 's.vbs', 'h.hta', 'w.scr', 'index.html', 'page.url', 'main.dart', 'noext']) {
    assert.ok(!OPENABLE.test(f), f);
  }
});

await check('VS Code is never handed a path that leads out of the workspace through a link', async () => {
  const r = await openInVsCode(ws, 'app/linked/id_rsa');
  assert.equal(r.ok, false);
  assert.equal(r.outside, true, 'refused before anything is started');
});

// ------------------------------------------------------------------ the window boundary (main.mjs)
const main = src('main.mjs');
await check('one app-wide guard: no new windows, no navigation away, no <webview> - for every window', async () => {
  assert.match(main, /app\.on\('web-contents-created', \(_e, contents\) => \{[\s\S]{0,200}contents\.setWindowOpenHandler\(\(\{ url \}\) => \{ openOutside\(url\); return \{ action: 'deny' \}; \}\);/);
  assert.match(main, /contents\.on\('will-navigate', \(e, url\) => \{[\s\S]{0,120}e\.preventDefault\(\);/);
  assert.match(main, /contents\.on\('will-attach-webview', \(e\) => e\.preventDefault\(\)\);/);
  assert.match(main, /const openOutside = \(url\) => \{\s*if \(!\/\^https\?:\\\/\\\/\/i\.test\(String\(url\)\)\)/, 'only http(s) links ever leave for the browser');
});
await check('every window is isolated: context isolation, a sandbox, and no Node in the page', async () => {
  const windows = main.match(/new BrowserWindow\(\{[\s\S]*?webPreferences: \{[\s\S]*?\}/g) || [];
  assert.ok(windows.length >= 3, `found ${windows.length}`);
  for (const w of windows) {
    assert.match(w, /contextIsolation: true/);
    assert.match(w, /nodeIntegration: false/);
    assert.match(w, /sandbox: true/);
    assert.doesNotMatch(w, /webviewTag: true|nodeIntegrationInSubFrames: true|webSecurity: false/);
  }
});
await check('the bridge exposes named calls only - never ipcRenderer itself, a generic invoke, or Node', async () => {
  const pre = src('preload.cjs');
  assert.doesNotMatch(pre, /exposeInMainWorld\([^)]*ipcRenderer\s*[,)]/);
  assert.doesNotMatch(pre, /\binvoke: \(channel|\(channel, \.\.\.args\) => ipcRenderer|ipcRenderer\.invoke\(channel/);
  assert.doesNotMatch(pre, /require\('(fs|child_process|path|os)'\)/);
});
await check('opening things from the window: folders only, documents only, never a program', async () => {
  assert.match(src('features.mjs'), /ipcMain\.handle\('project:open'[\s\S]{0,300}!st\.isDirectory\(\)\) return \{ ok: false/);
  assert.match(main, /if \(!isDir && !OPENABLE\.test\(full\)\) \{ shell\.showItemInFolder\(full\);/);
  assert.match(main, /const full = insideDir\(cwd, String\(rel \|\| ''\)\);\s*if \(!full \|\| !fs\.existsSync\(full\) \|\| !\(await reallyInside\(cwd, full\)\)\) return r;/, 'checked through the real path too');
  assert.match(main, /if \(r\.ok \|\| r\.outside\) return r;/, 'a path VS Code refused as outside is not opened some other way');
  // The conflict view opens the file by the repository's own path - "." is the workspace itself.
  assert.match(fs.readFileSync(new URL('../src/renderer/git.js', import.meta.url), 'utf8'), /openInCode\(active === '\.' \? d\.path : `\$\{active\}\/\$\{d\.path\}`\)/);
});

await check('rendered text fetches nothing: a picture only from its own data, never a file path or a network share', async () => {
  // The page is a file, so its policy's 'self' covers every file path - "//host/share/a.png"
  // included, which Windows fetches by signing in to that host. Measured on 2026-10-08: the
  // sanitizer kept such an <img>, and a picture outside the app loaded. So the sanitizer's
  // hook strips every attribute that fetches, from every element, except a data: picture.
  const core = src('renderer/core.js');
  assert.ok(core.includes("const FETCHES = ['src', 'srcset', 'poster', 'background', 'data'];"));
  assert.ok(core.includes("if (v !== null && !(attr === 'src' && node.tagName === 'IMG' && /^data:image\\/(png|jpeg|gif|webp);/i.test(v.trim()))) node.removeAttribute(attr);"));
  assert.ok(core.includes("if (node.tagName !== 'A') { node.removeAttribute('href'); node.removeAttribute('xlink:href'); }"));
  // The rule itself, run on what the hook would be handed.
  const keeps = (tag, attr, v) => attr === 'src' && tag === 'IMG' && /^data:image\/(png|jpeg|gif|webp);/i.test(v.trim());
  for (const v of ['//attacker-host/share/a.png', '\\\\attacker-host\\share\\a.png', 'file://attacker-host/share/a.png', '/C:/Users/me/secret.png', 'C:\\Users\\me\\secret.png', '../../build/icon.png', 'https://example.com/a.png', 'data:text/html;base64,PGI+', 'data:image/svg+xml;base64,PHN2Zz4=', ' javascript:alert(1)']) {
    assert.equal(keeps('IMG', 'src', v), false, v);
  }
  assert.equal(keeps('IMG', 'src', 'data:image/png;base64,iVBORw0KGgo='), true);
  assert.equal(keeps('VIDEO', 'src', 'data:image/png;base64,iVBORw0KGgo='), false, 'only a picture');
  assert.equal(keeps('IMG', 'srcset', 'data:image/png;base64,iVBORw0KGgo='), false);
  // And every Markdown path in the window goes through that one sanitizer.
  for (const f of ['chat.js', 'pages.js', 'github.js', 'welcome.js', 'agents-page.js', 'agent-builder.js']) {
    assert.doesNotMatch(fs.readFileSync(new URL(`../src/renderer/${f}`, import.meta.url), 'utf8'), /marked\.parse|DOMPurify\.sanitize|\.innerHTML\s*=/, f);
  }
});

// ------------------------------------------------------------------ Claude, Git and secrets
await check('no route to bypassPermissions: the window cannot ask for it, settings cannot start in it', async () => {
  const { WINDOW_MODES, startingMode } = await import('../src/permission-mode.mjs');
  assert.ok(!WINDOW_MODES.includes('bypassPermissions'));
  const dir = path.join(TMP, 'mode');
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }));
  assert.equal(startingMode(dir, { home: path.join(TMP, 'nohome') }).mode, 'default');
  assert.match(main, /if \(!WINDOW_MODES\.includes\(mode\)\) return false;/);
});
await check('what reaches the window: no tool paths, no commands to run, no tokens', async () => {
  assert.match(main, /ipcMain\.handle\('capabilities:list'[\s\S]{0,300}\.map\(\(c\) => \(\{ id: c\.id, label: c\.label, installed: c\.installed, version: c\.version, configured: c\.configured \}\)\)/);
  assert.match(main, /actions: r\.actions\.map\(actionForWindow\)/);
  assert.match(main, /telegram: \{ hasToken: !!c\.telegram\.token,/);
  assert.doesNotMatch(src('capabilities.mjs'), /auth\.output|output: auth/, 'gh auth status output is never kept');
});
await check('with no workspace, no other folder\'s conversations: not on Telegram, in the brief, or by id', async () => {
  // The SDK reads a missing folder as "every project", so each of these must stop first.
  assert.match(main, /sessions: async \(\) => \{ const \{ cwd \} = loadConfig\(\); return cwd \? listRecent\(cwd\) : \[\]; \}/);
  assert.match(main, /const recent = cwd \? await listRecent\(cwd\)/);
  for (const h of ['jarvis:deleteSession', 'jarvis:renameSession']) {
    assert.match(main, new RegExp(`ipcMain\\.handle\\('${h}'[\\s\\S]{0,400}if \\(!loadConfig\\(\\)\\.cwd\\) return \\{ ok: false, error: NO_WORKSPACE \\}`), h);
  }
});
await check('a repository Source Control does not list is not offered as a jump into it', async () => {
  assert.match(main, /if \(a\.id === 'git' && !inSourceControl\.has\(a\.repoKey\)\) \{\s*return \{ \.\.\.a, available: false,/);
  assert.match(fs.readFileSync(new URL('../src/renderer/projects-view.js', import.meta.url), 'utf8'), /disabled: !a\.available,\s*\}\);\s*continue;/, 'and the button says why instead of opening an empty page');
});
await check('a switch or a quit stops everything this app started, remote git included', async () => {
  const body = /async function shutdownChildren\(\) \{([\s\S]*?)\n\}/.exec(main)?.[1] || '';
  for (const s of ['remote.stop()', 'features.stop()', 'session?.close()', 'closeAllPanes()', 'shutdownWebApps()', 'shutdownAnalysis()', 'shutdownTasks()', 'cancelAllRemotes()', 'shutdownDevices()']) {
    assert.ok(body.includes(s), s);
  }
});

fs.rmSync(TMP, { recursive: true, force: true });
fs.rmSync(`${ws}-other`, { recursive: true, force: true });
console.log(`security-test: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
