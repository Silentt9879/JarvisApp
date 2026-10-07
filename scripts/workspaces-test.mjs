// Unit test for the workspace model (src/workspaces.mjs). Every folder is a fresh temp folder;
// nothing here reads or writes a real workspace or the real JARVIS config.
//   node scripts/workspaces-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeWorkspaces, activeWorkspace, addWorkspace, renameWorkspace, selectWorkspace, removeWorkspace,
  validateDir, legacyId, isWorkspaceId, setProjectSettings, projectSettings, workspacesForWindow, cleanName,
} from '../src/workspaces.mjs';
import { discoverProjects } from '../src/project-discovery.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${extra ? `\n     ${extra}` : ''}`); } };
const check = async (name, fn) => {
  try { await fn(); ok(true, name); } catch (e) { ok(false, name, String(e.message || e).slice(0, 400)); }
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-workspaces-'));
const mk = (...p) => { const d = path.join(TMP, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const apply = (cfg, r) => ({ ...cfg, ...r.patch });

// ------------------------------------------------------------------ 1. old `cwd` config migration
await check('an old config with only cwd becomes the first, active workspace - and cwd is kept', async () => {
  const dir = mk('Old Workspace');
  const raw = { cwd: dir, budgetUsd: 3, phone: { enabled: true } };
  const n = normalizeWorkspaces(raw);
  assert.equal(n.migrated, true);
  assert.equal(n.workspaces.length, 1);
  assert.equal(n.workspaces[0].path, path.resolve(dir));
  assert.equal(n.workspaces[0].name, 'Old Workspace');
  assert.equal(n.activeWorkspaceId, n.workspaces[0].id);
  assert.equal(n.activePath, path.resolve(dir));
  assert.equal(n.patch.cwd, path.resolve(dir), 'cwd is mirrored, so an older JARVIS still opens the same folder');
  assert.equal(n.workspaces[0].id, legacyId(dir), 'the id is derived from the path: the same config always migrates the same way');
  const again = normalizeWorkspaces({ ...raw, ...n.patch });
  assert.equal(again.migrated, false, 'a migrated config is stable - nothing to migrate the second time');
});

await check('an old cwd whose folder is gone is still kept, not dropped', async () => {
  const gone = path.join(TMP, 'was-here-once');
  const n = normalizeWorkspaces({ cwd: gone });
  assert.equal(n.workspaces.length, 1);
  assert.equal(n.activePath, path.resolve(gone));
  const view = workspacesForWindow({ ...n.patch });
  assert.equal(view.workspaces[0].exists, false, 'the window is told it is missing, so it can say so');
});

// ------------------------------------------------------------------ 2/3. new config, multiple workspaces
await check('a version-2 config with several workspaces resolves the active one', async () => {
  const a = mk('A');
  const b = mk('B');
  const raw = {
    workspaces: [{ id: 'ws_aaaaaaaa', name: 'A', path: a, lastOpened: 1 }, { id: 'ws_bbbbbbbb', name: 'B', path: b, lastOpened: 2 }],
    activeWorkspaceId: 'ws_bbbbbbbb',
    cwd: b,
  };
  const n = normalizeWorkspaces(raw);
  assert.equal(n.migrated, false);
  assert.equal(n.activePath, path.resolve(b));
  assert.equal(activeWorkspace(raw).name, 'B');
});

await check('a cwd changed behind version 2\'s back (an older JARVIS, a hand edit) is adopted, not overwritten', async () => {
  const a = mk('C1');
  const b = mk('C2');
  const raw = { workspaces: [{ id: 'ws_cccccccc', name: 'C1', path: a }], activeWorkspaceId: 'ws_cccccccc', cwd: b };
  const n = normalizeWorkspaces(raw);
  assert.equal(n.workspaces.length, 2, 'the new folder is added, the old one kept');
  assert.equal(n.activePath, path.resolve(b));
});

// ------------------------------------------------------------------ 4/5/6. active resolution, add, duplicates
await check('no configured workspace means none - no default folder is invented', async () => {
  const n = normalizeWorkspaces({});
  assert.equal(n.activeWorkspaceId, null);
  assert.equal(n.activePath, null);
  assert.equal(n.workspaces.length, 0);
  assert.equal(activeWorkspace({}), null);
  assert.equal(normalizeWorkspaces({ budgetUsd: 1 }).activePath, null);
});

await check('adding a folder lists it without switching to it; a stable random id, not the name', async () => {
  const a = mk('Add A');
  const b = mk('Add B');
  let cfg = { cwd: a };
  const r = await addWorkspace(cfg, b);
  assert.equal(r.ok, true, r.error);
  cfg = apply(cfg, r);
  const n = normalizeWorkspaces(cfg);
  assert.equal(n.workspaces.length, 2);
  assert.equal(n.activePath, path.resolve(a), 'adding never switches');
  assert.ok(isWorkspaceId(r.workspace.id));
  const r2 = await addWorkspace(cfg, mk('Add C'), { name: 'Add B' });
  assert.notEqual(r2.workspace.id, r.workspace.id, 'two workspaces with the same name still get different ids');
});

await check('the same folder twice - by another spelling or through a junction - is one workspace', async () => {
  const a = mk('Dup');
  let cfg = {};
  cfg = apply(cfg, await addWorkspace(cfg, a));
  const again = await addWorkspace(cfg, a.toUpperCase());
  assert.equal(again.duplicate, true);
  const link = path.join(TMP, 'dup-link');
  fs.symlinkSync(a, link, 'junction');
  const viaLink = await addWorkspace(cfg, link);
  assert.equal(viaLink.duplicate, true, 'a junction to a listed folder is the same folder');
  assert.equal(normalizeWorkspaces(cfg).workspaces.length, 1);
});

// ------------------------------------------------------------------ 7/8/9. rename, remove inactive, remove active
await check('rename changes the display name only; the id and path stay', async () => {
  const a = mk('Rename Me');
  let cfg = { cwd: a };
  const id = normalizeWorkspaces(cfg).activeWorkspaceId;
  const r = renameWorkspace(cfg, id, '  Client  Work  ');
  assert.equal(r.ok, true);
  cfg = apply(cfg, r);
  const w = normalizeWorkspaces(cfg).workspaces[0];
  assert.equal(w.name, 'Client Work');
  assert.equal(w.id, id);
  assert.equal(renameWorkspace(cfg, id, '   ').ok, false, 'an empty name is refused');
  assert.equal(renameWorkspace(cfg, 'ws_nothere1', 'x').ok, false);
});

await check('removing an inactive workspace forgets it, touches no folder, and switches nothing', async () => {
  const a = mk('Keep');
  const b = mk('Forget');
  let cfg = { cwd: a };
  const added = await addWorkspace(cfg, b);
  cfg = apply(cfg, added);
  const r = removeWorkspace(cfg, added.workspace.id);
  assert.equal(r.ok, true);
  assert.equal(r.switched, false);
  cfg = apply(cfg, r);
  assert.equal(normalizeWorkspaces(cfg).workspaces.length, 1);
  assert.ok(fs.existsSync(b), 'the folder itself is untouched');
});

await check('removing the active workspace moves to the most recent other one, and asks for a restart', async () => {
  const a = mk('Active One');
  const b = mk('Other One');
  let cfg = { cwd: a };
  const added = await addWorkspace(cfg, b);
  cfg = apply(cfg, added);
  cfg = apply(cfg, await selectWorkspace(cfg, added.workspace.id, { now: 50 }));
  const activeId = normalizeWorkspaces(cfg).activeWorkspaceId;
  const r = removeWorkspace(cfg, activeId);
  assert.equal(r.switched, true);
  assert.equal(r.next.path, path.resolve(a));
  cfg = apply(cfg, r);
  assert.equal(normalizeWorkspaces(cfg).activePath, path.resolve(a));
});

await check('removing the last workspace leaves none active - and stays that way', async () => {
  const a = mk('Only One');
  let cfg = { cwd: a };
  const r = removeWorkspace(cfg, normalizeWorkspaces(cfg).activeWorkspaceId);
  cfg = apply(cfg, r);
  assert.equal(r.next, null);
  const n = normalizeWorkspaces(cfg);
  assert.equal(n.activePath, null);
  assert.equal(n.workspaces.length, 0);
  assert.equal(cfg.cwd, null, 'the old cwd is cleared too, so it is not re-adopted next start');
  assert.equal(n.migrated, false);
});

// ------------------------------------------------------------------ 10/11. invalid paths, spaces
await check('invalid folders are refused before anything is saved', async () => {
  assert.equal((await validateDir('relative/path')).ok, false);
  assert.equal((await validateDir(path.join(TMP, 'nope'))).ok, false);
  const file = path.join(TMP, 'a-file.txt');
  fs.writeFileSync(file, 'x');
  assert.match((await validateDir(file)).error, /file, not a folder/);
  assert.equal((await validateDir(path.parse(TMP).root)).ok, false, 'a whole drive is not a workspace');
  if (process.env.SystemRoot) assert.equal((await validateDir(process.env.SystemRoot)).ok, false, 'nor is the Windows folder');
  assert.equal((await addWorkspace({}, path.join(TMP, 'nope'))).ok, false);
  assert.equal((await validateDir('')).ok, false);
  assert.equal((await validateDir(null)).ok, false);
});

await check('paths with spaces work everywhere', async () => {
  const d = mk('My Projects', 'Client A');
  let cfg = {};
  const r = await addWorkspace(cfg, d);
  assert.equal(r.ok, true, r.error);
  cfg = apply(cfg, r);
  const s = await selectWorkspace(cfg, r.workspace.id);
  assert.equal(s.ok, true, s.error);
  cfg = apply(cfg, s);
  assert.equal(normalizeWorkspaces(cfg).activePath, path.resolve(d));
});

// ------------------------------------------------------------------ 12. switching
await check('selecting a workspace makes it active, records when, and mirrors cwd', async () => {
  const a = mk('Switch A');
  const b = mk('Switch B');
  let cfg = { cwd: a };
  const added = await addWorkspace(cfg, b);
  cfg = apply(cfg, added);
  const s = await selectWorkspace(cfg, added.workspace.id, { now: 1234 });
  assert.equal(s.ok, true);
  assert.equal(s.unchanged, false);
  cfg = apply(cfg, s);
  const n = normalizeWorkspaces(cfg);
  assert.equal(n.activePath, path.resolve(b));
  assert.equal(cfg.cwd, path.resolve(b));
  assert.equal(n.workspaces.find((w) => w.id === added.workspace.id).lastOpened, 1234);
  assert.equal((await selectWorkspace(cfg, added.workspace.id)).unchanged, true, 'selecting the active one is a no-op');
});

await check('a workspace whose folder has gone cannot be selected', async () => {
  const a = mk('Stay');
  const b = mk('Vanish');
  let cfg = { cwd: a };
  const added = await addWorkspace(cfg, b);
  cfg = apply(cfg, added);
  fs.rmSync(b, { recursive: true, force: true });
  const s = await selectWorkspace(cfg, added.workspace.id);
  assert.equal(s.ok, false);
  assert.match(s.error, /does not exist/);
});

// ------------------------------------------------------------------ 13. discovery per workspace
await check('discovery against workspace A finds A\'s projects; against B, only B\'s', async () => {
  const a = mk('Disc A');
  const b = mk('Disc B');
  fs.mkdirSync(path.join(a, 'shop'), { recursive: true });
  fs.writeFileSync(path.join(a, 'shop', 'package.json'), '{"name":"shop"}');
  fs.mkdirSync(path.join(b, 'api'), { recursive: true });
  fs.writeFileSync(path.join(b, 'api', 'Api.csproj'), '<Project/>');
  let cfg = { cwd: a };
  const added = await addWorkspace(cfg, b);
  cfg = apply(cfg, added);
  const inA = await discoverProjects(normalizeWorkspaces(cfg).activePath);
  assert.deepEqual(inA.projects.map((p) => p.relativePath), ['shop']);
  cfg = apply(cfg, await selectWorkspace(cfg, added.workspace.id));
  const inB = await discoverProjects(normalizeWorkspaces(cfg).activePath);
  assert.deepEqual(inB.projects.map((p) => p.relativePath), ['api']);
});

// ------------------------------------------------------------------ malformed configs
await check('a malformed workspaces list is cleaned, never fatal, and never invents an active one from junk', async () => {
  const a = mk('Good');
  const n = normalizeWorkspaces({
    workspaces: [null, 7, { path: 'relative' }, { id: 'nonsense', path: a, name: 123 }, { id: 'ws_dupdupdup', path: a }],
    activeWorkspaceId: 'ws_missing00',
  });
  assert.equal(n.workspaces.length, 1, 'one real folder, listed once');
  assert.ok(isWorkspaceId(n.workspaces[0].id), 'a bad id is replaced');
  assert.equal(n.workspaces[0].name, 'Good');
  assert.equal(n.migrated, true);
});

// ------------------------------------------------------------------ per-project settings
await check('per-project names and warnings are stored per workspace, and can be cleared', async () => {
  const a = mk('Settings WS');
  let cfg = { cwd: a };
  const id = normalizeWorkspaces(cfg).activeWorkspaceId;
  const r = setProjectSettings(cfg, id, 'admin-web', { name: 'Admin', warning: 'Talks to the PRODUCTION database' });
  assert.equal(r.ok, true);
  cfg = apply(cfg, r);
  assert.deepEqual(projectSettings(activeWorkspace(cfg), 'admin-web'), { name: 'Admin', warning: 'Talks to the PRODUCTION database' });
  cfg = apply(cfg, setProjectSettings(cfg, id, 'admin-web', { warning: '' }));
  assert.deepEqual(projectSettings(activeWorkspace(cfg), 'admin-web'), { name: 'Admin' });
  assert.equal(setProjectSettings(cfg, id, '../escape', { name: 'x' }).ok, false, 'a path leaving the workspace is not a project');
  assert.equal(cleanName('a\u0007b'), 'ab');
});
await check('a project folder named constructor, toString or __proto__ is a project like any other', async () => {
  const a = mk('Odd Names WS');
  let cfg = { cwd: a };
  const id = normalizeWorkspaces(cfg).activeWorkspaceId;
  for (const rel of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    assert.deepEqual(projectSettings(activeWorkspace(cfg), rel), {}, `${rel}: nothing inherited is taken for settings`);
  }
  for (const rel of ['__proto__', 'constructor']) cfg = apply(cfg, setProjectSettings(cfg, id, rel, { name: `N ${rel}`, warning: 'careful' }));
  const saved = JSON.parse(JSON.stringify(cfg)); // as config.json holds it
  assert.deepEqual(projectSettings(activeWorkspace(saved), '__proto__'), { name: 'N __proto__', warning: 'careful' }, 'kept through a save');
  assert.deepEqual(projectSettings(activeWorkspace(saved), 'constructor'), { name: 'N constructor', warning: 'careful' });
  assert.deepEqual(projectSettings(activeWorkspace(saved), 'billing'), {}, 'and nothing leaks to other projects');
  assert.equal(Object.getPrototypeOf(activeWorkspace(saved).projects), Object.prototype);
  cfg = apply(saved, setProjectSettings(saved, id, '__proto__', { name: '', warning: '' }));
  assert.deepEqual(Object.keys(activeWorkspace(cfg).projects), ['constructor'], 'clearing one removes just that one');
});

// ------------------------------------------------------------------ trust
await check('trust: the folder an older JARVIS already used stays trusted; a newly added one starts restricted', async () => {
  const { setWorkspaceTrust } = await import('../src/workspaces.mjs');
  const old = mk('Trust Old');
  let cfg = { cwd: old };
  assert.equal(normalizeWorkspaces(cfg).workspaces[0].trusted, true, 'it ran with its full settings before - nothing changes for it');
  cfg = apply(cfg, normalizeWorkspaces(cfg));
  const added = await addWorkspace(cfg, mk('Trust New'));
  assert.equal(added.workspace.trusted, false, 'a folder JARVIS has not been told to trust is restricted');
  cfg = apply(cfg, added);
  const keep = await selectWorkspace(cfg, added.workspace.id);
  assert.equal(keep.workspace.trusted, false, 'switching without an answer keeps it restricted');
  const yes = await selectWorkspace(cfg, added.workspace.id, { trust: true });
  assert.equal(yes.workspace.trusted, true, 'the answer given while switching is kept');
  cfg = apply(cfg, yes);
  const back = setWorkspaceTrust(cfg, added.workspace.id, false);
  assert.equal(back.changed, true);
  assert.equal(back.active, true, 'the caller is told it is the active one, so it restarts');
  cfg = apply(cfg, back);
  assert.equal(workspacesForWindow(cfg).workspaces.find((w) => w.id === added.workspace.id).trusted, false);
  assert.equal(normalizeWorkspaces({ workspaces: [{ id: 'ws_handmade', path: old }] }).workspaces[0].trusted, false, 'a hand-written entry without the flag is not trusted');
});

await check('trust wiring: a restricted workspace runs Claude with user settings only, and none of its scripts', async () => {
  const read = (f) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
  const session = read('session.mjs');
  assert.match(session, /settingSources: this\.trusted \? \['user', 'project', 'local'\] : \['user'\]/);
  assert.match(session, /startingMode\(this\.trusted \? this\.cwd : null\)/, 'a restricted folder cannot set the permission mode either');
  const main = read('main.mjs');
  assert.equal((main.match(/new JarvisSession\(\{[\s\S]{0,260}?trusted: workspaceTrusted\(\)/g) || []).length, 2, 'both the main chat and side chats are given the trust');
  assert.match(main, /workspaceTrusted\(\)\s*\n?\s*\? knowledgeStatus\(cwd\)/, 'the workspace\'s knowledge script only runs when it is trusted');
  assert.match(read('routines.mjs'), /settingSources: trusted \? \['user', 'project', 'local'\] : \['user'\]/);
});

await check('restricted means JARVIS runs nothing from the folder: no tasks, phone or web runs, analysis or Git', async () => {
  const read = (f) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
  const main = read('main.mjs');
  for (const h of ['jarvis:analyze', 'jarvis:flutterRun', 'jarvis:webRun']) {
    assert.match(main, new RegExp(`ipcMain\\.handle\\('${h}'[\\s\\S]{0,260}if \\(!workspaceTrusted\\(\\)\\) return \\{ ok: false, restricted: true, error: RESTRICTED_RUN \\};`), h);
  }
  assert.match(main, /if \(!trusted\) return \{ \.\.\.a, available: false, reason: RESTRICTED_RUN \};/, 'every project action is unavailable, with the reason');
  assert.match(main, /if \(!a\.available\) return \{ ok: false, error: a\.reason/, 'and projects:run refuses one that is');
  assert.match(main, /setGitTrust\(\(\) => \{[\s\S]{0,160}workspaceTrusted\(\)/, 'git asks the same question');
  // The gate itself: no git process at all while restricted; anything else unaffected.
  const { run, setGitTrust, GIT_RESTRICTED } = await import('../src/workspace.mjs');
  setGitTrust(() => false);
  try {
    const g = await run('git', ['--version']);
    assert.equal(g.ok, false);
    assert.equal(g.restricted, true);
    assert.equal(g.err, GIT_RESTRICTED);
    const n = await run(process.execPath, ['-e', 'process.stdout.write("ran")']);
    assert.equal(n.out, 'ran', 'other commands still run');
  } finally { setGitTrust(() => true); }
  assert.equal((await run('git', ['--version'])).restricted, undefined, 'trusted again: git runs');
});

await check('Telegram\'s /diff and the brief never call an unread repository clean - restricted or broken', async () => {
  const { execFileSync } = await import('node:child_process');
  const { diffReport, morningBrief } = await import('../src/reports.mjs');
  const { setGitTrust, GIT_RESTRICTED } = await import('../src/workspace.mjs');
  const ws = mk('Reports WS');
  for (const n of ['alpha', 'beta']) { fs.mkdirSync(path.join(ws, n)); execFileSync('git', ['-C', path.join(ws, n), 'init', '-q']); }
  setGitTrust(() => false);
  try {
    assert.equal((await diffReport(ws, '')).text, GIT_RESTRICTED, 'restricted: said so, not "all clean"');
    assert.match(await morningBrief({ cwd: ws, userDir: ws }), /Repositories not read: this workspace is restricted/);
  } finally { setGitTrust(() => true); }
  fs.rmSync(path.join(ws, 'beta', '.git', 'HEAD')); // a repository git cannot read
  const text = (await diffReport(ws, '')).text;
  assert.match(text, /Could not read beta\./);
  assert.doesNotMatch(text, /^All \d+ repositories are clean/);
});

await check('config.json: a byte-order mark reads, a broken file is never overwritten, a merge keeps every other setting', async () => {
  const { readConfigFile, mergeConfigFile } = await import('../src/config-file.mjs');
  const file = path.join(mk('Config File'), 'config.json');
  assert.deepEqual(readConfigFile(file), { missing: true });
  assert.equal(mergeConfigFile(file, { setupDone: true }).ok, true, 'a first save creates it');
  // As Notepad or Windows PowerShell 5.1 saves a hand edit.
  fs.writeFileSync(file, `\uFEFF${JSON.stringify({ phone: { telegram: { chatId: '1' } }, cwd: 'C:\\A' })}`);
  assert.equal(readConfigFile(file).value?.cwd, 'C:\\A', 'a byte-order mark is not a problem');
  assert.equal(mergeConfigFile(file, { clickup: { member: 'Sam' } }).ok, true);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).sort(), ['clickup', 'cwd', 'phone'], 'nothing else is lost');
  const broken = '{ "phone": { "telegram": { "chatId": "1" } }, oops }';
  fs.writeFileSync(file, broken);
  const r = mergeConfigFile(file, { workspaces: [] });
  assert.equal(r.ok, false);
  assert.match(r.problem, /not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), broken, 'the broken file is left exactly as it was');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['config.json'], 'and no temp file is left beside it');
  fs.rmSync(file);
  fs.mkdirSync(file); // something that cannot be read where the file should be
  assert.match(readConfigFile(file).problem, /could not be opened/);
  assert.equal(mergeConfigFile(file, { a: 1 }).ok, false, 'an unreadable file is not replaced either');
  const main = fs.readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8');
  assert.match(main, /const r = mergeConfigFile\(configPath, patch\);/, 'main saves through it');
  assert.doesNotMatch(main, /fs\.writeFileSync\(configPath|JSON\.parse\(fs\.readFileSync\(configPath/, 'and nowhere around it');
});

// ------------------------------------------------------------------ the project index (one scan, shared)
await check('the project index scans once, shares a scan in flight, and keeps workspaces apart', async () => {
  const { createProjectIndex } = await import('../src/project-index.mjs');
  let scans = 0;
  let t = 1000;
  const fake = async (root) => { scans += 1; await new Promise((r) => setTimeout(r, 10)); return { root, projects: [{ id: 'x', name: path.basename(root), displayName: path.basename(root), relativePath: 'x', types: ['node'], role: 'root', meta: {} }], errors: [], truncated: false, cancelled: false }; };
  const idx = createProjectIndex({ discover: fake, now: () => t, ttlMs: 60000 });
  const a = { id: 'ws_aaaaaaaa', name: 'A', path: mk('Index A') };
  const b = { id: 'ws_bbbbbbbb', name: 'B', path: mk('Index B'), projects: { x: { name: 'Shop', warning: 'Live data' } } };
  const [r1, r2] = await Promise.all([idx.get(a), idx.get(a)]);
  assert.equal(scans, 1, 'two asks at once share one scan');
  assert.equal(r1.projects[0].name, 'Index A');
  assert.equal(r2.workspaceId, 'ws_aaaaaaaa');
  await idx.get(a);
  assert.equal(scans, 1, 'a fresh answer is reused');
  t += 61000;
  await idx.get(a);
  assert.equal(scans, 2, 'an old answer is replaced');
  await idx.get(a, { refresh: true });
  assert.equal(scans, 3, 'refresh always scans');
  const rb = await idx.get(b);
  assert.equal(rb.workspaceId, 'ws_bbbbbbbb', 'another workspace gets its own answer');
  assert.equal(rb.projects[0].displayName, 'Shop', 'the person\'s own name is laid over the found one');
  assert.equal(rb.projects[0].foundName, 'Index B', 'without losing what was found');
  assert.equal(rb.projects[0].warning, 'Live data');
  assert.equal((await idx.find(b, 'x')).displayName, 'Shop');
  assert.equal(await idx.find(b, 'nope'), null);
  const none = await idx.get(null);
  assert.equal(none.ok, false);
  assert.match(none.error, /Choose a workspace/);
});

// ------------------------------------------------------------------ Source Control finds any layout
await check('Source Control finds repositories in any common layout, named by the person or the folder', async () => {
  const { listRepos, setRepoNames } = await import('../src/workspace.mjs');
  const { sourceRepos, resolveRepo } = await import('../src/git.mjs');
  // A workspace that IS a repository.
  const single = mk('Single Repo');
  fs.mkdirSync(path.join(single, '.git'));
  assert.deepEqual(listRepos(single), ['.']);
  // Repositories side by side, and two inside a plain grouping folder; dependencies ignored.
  const many = mk('Many');
  for (const r of ['alpha', 'work/beta', 'work/gamma', 'node_modules/dep']) fs.mkdirSync(path.join(many, ...r.split('/'), '.git'), { recursive: true });
  assert.deepEqual(listRepos(many), ['alpha', 'work/beta', 'work/gamma']);
  setRepoNames((rel) => (rel === 'work/beta' ? 'Beta Service' : null));
  const repos = sourceRepos(many).filter((r) => r.scope === 'workspace');
  assert.deepEqual(repos.map((r) => [r.key, r.name, r.nickname]), [['alpha', 'alpha', 'alpha'], ['work/beta', 'beta', 'Beta Service'], ['work/gamma', 'gamma', 'gamma']]);
  assert.equal(resolveRepo(many, 'work/beta').dir, path.join(many, 'work', 'beta'));
  assert.equal(resolveRepo(many, '../outside'), null, 'a key that is not a discovered repository is refused');
  assert.equal(resolveRepo(single, '.').dir, path.resolve(single));
  setRepoNames(null);
  assert.deepEqual(listRepos(null), [], 'no workspace: no repositories, never a guess');
});

// ------------------------------------------------------------------ wiring (main.mjs, the bridge, the dev scripts)
await check('wiring: there is no default folder anywhere - not in the app, not in the dev scripts', async () => {
  const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const main = read('src/main.mjs');
  assert.ok(!/DEFAULT_CWD/.test(main), 'main.mjs has no DEFAULT_CWD');
  assert.ok(!/Users[\\/]+bantu/i.test(main), 'and no machine-specific path');
  const scripts = read('scripts/workspace.mjs');
  assert.ok(!/DEFAULT_CWD|Users[\\/]+bantu/i.test(scripts), 'the dev scripts resolve the folder the app\'s way, with no default');
  assert.ok(!/Users[\\/]+bantu/i.test(read('scripts/phone-switch-test.mjs')), 'and the phone test finds the app from where it is');
});

await check('wiring: one central resolver; no session, no message, no conversation list without a workspace', async () => {
  const main = fs.readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8');
  assert.match(main, /const ws = normalizeWorkspaces\(c\);[\s\S]{0,200}cwd: ws\.activePath/, 'loadConfig takes cwd from the active workspace');
  assert.match(main, /ipcMain\.handle\('jarvis:start'[\s\S]{0,200}if \(!loadConfig\(\)\.cwd\)[\s\S]{0,120}NO_WORKSPACE/, 'start refuses plainly');
  assert.match(main, /function submitMessage[\s\S]{0,250}!loadConfig\(\)\.cwd \? \{ ok: false, error: NO_WORKSPACE \}/, 'every message path (desk, Telegram, phone) refuses');
  assert.match(main, /ipcMain\.handle\('jarvis:sessions'[\s\S]{0,120}if \(!cwd\) return \[\];/, 'no other folder\'s conversations are listed');
});

await check('wiring: switching is restart-based, through the one shutdown that stops everything', async () => {
  const main = fs.readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8');
  assert.match(main, /ipcMain\.handle\('workspaces:select'[\s\S]{0,400}saveConfig\(r\.patch\);[\s\S]{0,40}return restartJarvis\(/, 'select saves first, then restarts');
  assert.match(main, /ipcMain\.handle\('workspaces:remove'[\s\S]{0,500}if \(!r\.switched\) return \{ ok: true \};[\s\S]{0,40}return restartJarvis\(/, 'removing the active one restarts; removing another does not');
  assert.match(main, /function restartJarvis[\s\S]{0,600}await shutdownChildren\(\);[\s\S]{0,500}app\.relaunch/, 'a restart always runs the shutdown first');
  assert.match(main, /filter\(\(a\) => !\['--restarted', '--hidden', '--updated'\]\.includes\(a\)\)/, 'and comes back with a window, without announcing an update again');
  assert.match(main, /async function shutdownChildren[\s\S]{0,400}for \(const s of paneSessions\.values\(\)\) \{ try \{ s\.close\(\); \}/, 'side chats are closed too, so no claude.exe is left behind');
  assert.equal((main.match(/app\.relaunch\(/g) || []).length, 1, 'exactly one relaunch in the app - no second restart path');
  const configFile = fs.readFileSync(new URL('../src/config-file.mjs', import.meta.url), 'utf8');
  assert.ok(/fs\.renameSync\(tmp, file\)/.test(configFile) && /mergeConfigFile\(configPath, patch\)/.test(main), 'the config is written atomically');
  assert.match(main, /config\.before-v2\.json/, 'the old config is kept beside the migrated one');
});

await check('wiring: the bridge offers named workspace operations only', async () => {
  const pre = fs.readFileSync(new URL('../src/preload.cjs', import.meta.url), 'utf8');
  for (const [fn, ch] of [['workspaces', 'workspaces:list'], ['workspaceAdd', 'workspaces:add'], ['workspaceRename', 'workspaces:rename'], ['workspaceSelect', 'workspaces:select'], ['workspaceRemove', 'workspaces:remove'], ['projects', 'workspaces:projects']]) {
    assert.ok(pre.includes(`${fn}: (`) && pre.includes(`'${ch}'`), `${fn} -> ${ch}`);
  }
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`workspaces-test: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
