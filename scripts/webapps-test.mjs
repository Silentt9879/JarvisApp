// Web apps (Devices view): the checks made BEFORE `dotnet watch` starts - the address read
// from launchSettings.json, and "already running elsewhere" when something holds the port -
// plus how the list itself is DISCOVERED from a workspace (no fixed list of projects).
// No dotnet is started and nothing leaves this machine.
// Run: node scripts/webapps-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { listWebApps, webRun, plannedUrl, portBusy } from '../src/webapps.mjs';
import { discoverProjects } from '../src/project-discovery.mjs';
import { webAppsFrom, dotnetFacts } from '../src/project-providers.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-web-'));
// Any absolute path will do: none of these checks gets as far as starting dotnet.
const FAKE_DOTNET = path.join(os.tmpdir(), 'no-such-dotnet', 'dotnet.exe');
let passed = 0;
const step = async (name, fn) => { await fn(); passed += 1; console.log(`  ok  ${name}`); };

/** A free local port, found by letting the OS pick one. */
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

/** A .NET project folder: its csproj, and optionally launch settings and a Views/ folder. */
function project(rel, file, { sdk = 'Microsoft.NET.Sdk.Web', launch = null, views = false, extra = '' } = {}) {
  const dir = path.join(root, rel);
  fs.mkdirSync(path.join(dir, 'Properties'), { recursive: true });
  fs.writeFileSync(path.join(dir, file), `<Project Sdk="${sdk}">${extra}</Project>`);
  if (launch) fs.writeFileSync(path.join(dir, 'Properties', 'launchSettings.json'), launch);
  if (views) fs.mkdirSync(path.join(dir, 'Views'), { recursive: true });
  return dir;
}

try {
  const port = await freePort();
  // A BOM and a trailing https entry, as Visual Studio writes them.
  project('Shop Admin', 'Shop Admin.csproj', { views: true, launch: `﻿${JSON.stringify({ profiles: {
    http: { commandName: 'Project', applicationUrl: `http://localhost:${port}` },
    https: { commandName: 'Project', applicationUrl: `https://localhost:7005;http://localhost:${port}` },
  } })}` });
  project('billing/Billing.Api', 'Billing.Api.csproj', { launch: JSON.stringify({ profiles: { http: { applicationUrl: 'http://0.0.0.0:5209' } } }) });
  project('billing/Billing.Api.Tests', 'Billing.Api.Tests.csproj', { sdk: 'Microsoft.NET.Sdk', extra: '<ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.0.0" /></ItemGroup>' });
  project('tools/Report', 'Report.csproj', { sdk: 'Microsoft.NET.Sdk', extra: '<PropertyGroup><OutputType>Exe</OutputType></PropertyGroup>' });
  fs.mkdirSync(path.join(root, 'billing', '.git'), { recursive: true });

  const found = await discoverProjects(root);
  // A person's own warning for one project, as the project index lays it over discovery.
  const projects = found.projects.map((p) => (p.relativePath === 'billing/Billing.Api' ? { ...p, warning: 'Live database - sends real reminders' } : p));
  const apps = await webAppsFrom(root, projects);
  const by = Object.fromEntries(apps.map((a) => [a.key, a]));

  await step('the web apps are DISCOVERED: every Web SDK project, and nothing else', async () => {
    assert.deepEqual(apps.map((a) => a.key).sort(), ['Shop Admin', 'billing/Billing.Api']);
    assert.equal(by['Shop Admin'].kind, 'web', 'Views/ means pages');
    assert.equal(by['billing/Billing.Api'].kind, 'api', 'no Views/, Pages/ or wwwroot/ means an API');
    assert.equal(by['Shop Admin'].project, path.join(root, 'Shop Admin', 'Shop Admin.csproj'));
  });

  await step('a test project and a console tool are known for what they are, not offered as web apps', async () => {
    assert.equal((await dotnetFacts(path.join(root, 'billing', 'Billing.Api.Tests'), ['Billing.Api.Tests.csproj'])).kind, 'test');
    assert.equal((await dotnetFacts(path.join(root, 'tools', 'Report'), ['Report.csproj'])).kind, 'app');
    assert.equal((await dotnetFacts(path.join(root, 'billing'), ['.git'])).kind, 'solution');
  });

  await step('a warning comes only from the person\'s own settings - never a built-in one', async () => {
    assert.equal(by['billing/Billing.Api'].warn, 'Live database - sends real reminders');
    assert.equal(by['Shop Admin'].warn, null);
  });

  await step('the address comes from the http launch profile', async () => {
    assert.deepEqual(plannedUrl(path.join(root, 'Shop Admin')), { url: `http://localhost:${port}`, port });
    assert.deepEqual(plannedUrl(path.join(root, 'billing', 'Billing.Api')), { url: 'http://localhost:5209', port: 5209 }, '0.0.0.0 shown as localhost');
    assert.equal(plannedUrl(path.join(root, 'tools', 'Report')), null, 'no launch settings, no address');
  });

  await step('a free port is reported free, and nothing is "elsewhere"', async () => {
    assert.equal(await portBusy(port), false);
    const list = await listWebApps(apps);
    const admin = list.find((x) => x.key === 'Shop Admin');
    assert.equal(admin.found, true);
    assert.equal(admin.external, null);
    assert.equal(list.find((x) => x.key === 'billing/Billing.Api').warn, 'Live database - sends real reminders');
  });

  const server = net.createServer().listen(port, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));

  await step('something on the port shows as running elsewhere, with who holds it', async () => {
    assert.equal(await portBusy(port), true);
    const admin = (await listWebApps(apps)).find((x) => x.key === 'Shop Admin');
    assert.equal(admin.external.port, port);
    assert.equal(admin.external.url, `http://localhost:${port}`);
    if (process.platform === 'win32') {
      assert.equal(admin.external.owner.pid, process.pid, 'this test holds the port');
      assert.match(admin.external.owner.name, /node/i);
    }
  });

  await step('Run refuses before building, and says why', async () => {
    let events = 0;
    await assert.rejects(
      () => webRun(by['Shop Admin'], { watch: true, dotnet: FAKE_DOTNET }, () => { events += 1; }),
      (e) => e.code === 'PORT_IN_USE' && /already running on http:\/\/localhost:\d+ - started outside JARVIS/.test(e.message),
    );
    assert.equal(events, 0, 'nothing was started');
  });

  server.close();
  await new Promise((r) => server.once('close', r));

  await step('once the port is free again, the card is back to stopped', async () => {
    const admin = (await listWebApps(apps)).find((x) => x.key === 'Shop Admin');
    assert.equal(admin.external, null);
  });

  await step('an unknown or tampered project, or a missing one, is refused', async () => {
    await assert.rejects(() => webRun(null, {}, () => {}), /Unknown project/);
    await assert.rejects(() => webRun({ key: 'x', absDir: 'relative', project: 'x.csproj' }, {}, () => {}), /Unknown project/);
    // A project file outside its own folder is not accepted - the folder and the file must agree.
    await assert.rejects(() => webRun({ ...by['Shop Admin'], project: path.join(root, 'billing', 'Billing.Api', 'Billing.Api.csproj') }, {}, () => {}), /Unknown project/);
    const gone = project('gone', 'Gone.csproj');
    const [g] = await webAppsFrom(root, (await discoverProjects(root)).projects.filter((p) => p.relativePath === 'gone'));
    fs.rmSync(path.join(gone, 'Gone.csproj'));
    await assert.rejects(() => webRun(g, { dotnet: FAKE_DOTNET }, () => {}), /Gone\.csproj\) was not found/);
    // dotnet is only ever started from a full path (the Capability Registry's) - never by name
    // with the project as the working directory, where a repository's own dotnet.exe would win.
    await assert.rejects(() => webRun(by['Shop Admin'], {}, () => {}), /dotnet was not found/);
    await assert.rejects(() => webRun(by['Shop Admin'], { dotnet: 'dotnet.exe' }, () => {}), /dotnet was not found/);
  });

  await step('a project outside the workspace (a junction pointing out) is never offered', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-web-outside-'));
    fs.writeFileSync(path.join(outside, 'Evil.csproj'), '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>');
    fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');
    // Even a hand-made project entry pointing through the junction is refused at use time.
    const forged = { id: 'linked', name: 'linked', relativePath: 'linked', types: ['dotnet'], markers: ['Evil.csproj'], role: 'root' };
    assert.deepEqual(await webAppsFrom(root, [forged]), []);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  console.log(`webapps-test: all ${passed} checks passed`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
