// Web apps (Devices view), 2026-10-05: the checks made BEFORE `dotnet watch` starts - the
// address read from launchSettings.json, and "already running elsewhere" when something
// holds the port. No dotnet is started and nothing leaves this machine.
// Run: node scripts/webapps-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { listWebApps, webRun, plannedUrl, portBusy, WEB_APPS } from '../src/webapps.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-web-'));
let passed = 0;
const step = async (name, fn) => { await fn(); passed += 1; console.log(`  ok  ${name}`); };

/** A free local port, found by letting the OS pick one. */
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

function project(key, launch) {
  const a = WEB_APPS[key];
  const dir = path.join(root, a.dir);
  fs.mkdirSync(path.join(dir, 'Properties'), { recursive: true });
  fs.writeFileSync(path.join(dir, a.project), '<Project Sdk="Microsoft.NET.Sdk.Web" />');
  if (launch) fs.writeFileSync(path.join(dir, 'Properties', 'launchSettings.json'), launch);
}

try {
  const port = await freePort();
  // A BOM and a trailing https entry, as Visual Studio writes them.
  project('adminweb', `﻿${JSON.stringify({ profiles: {
    http: { commandName: 'Project', applicationUrl: `http://localhost:${port}` },
    https: { commandName: 'Project', applicationUrl: `https://localhost:7005;http://localhost:${port}` },
  } })}`);
  project('insurapi', JSON.stringify({ profiles: { http: { applicationUrl: 'http://0.0.0.0:5209' } } }));

  await step('the address comes from the http launch profile', async () => {
    assert.deepEqual(plannedUrl(root, WEB_APPS.adminweb), { url: `http://localhost:${port}`, port });
    assert.deepEqual(plannedUrl(root, WEB_APPS.insurapi), { url: 'http://localhost:5209', port: 5209 }, '0.0.0.0 shown as localhost');
    assert.equal(plannedUrl(root, WEB_APPS.gateway), null, 'no project, no address');
  });

  await step('a free port is reported free, and nothing is "elsewhere"', async () => {
    assert.equal(await portBusy(port), false);
    const list = await listWebApps(root);
    const admin = list.find((x) => x.key === 'adminweb');
    assert.equal(admin.found, true);
    assert.equal(admin.external, null);
    assert.equal(list.find((x) => x.key === 'gateway').found, false);
    assert.equal(list.find((x) => x.key === 'insurapi').warn, 'Live database · sends real reminder pushes');
  });

  const server = net.createServer().listen(port, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));

  await step('something on the port shows as running elsewhere, with who holds it', async () => {
    assert.equal(await portBusy(port), true);
    const admin = (await listWebApps(root)).find((x) => x.key === 'adminweb');
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
      () => webRun(root, 'adminweb', { watch: true }, () => { events += 1; }),
      (e) => e.code === 'PORT_IN_USE' && /already running on http:\/\/localhost:\d+ - started outside JARVIS/.test(e.message),
    );
    assert.equal(events, 0, 'nothing was started');
  });

  server.close();
  await new Promise((r) => server.once('close', r));

  await step('once the port is free again, the card is back to stopped', async () => {
    const admin = (await listWebApps(root)).find((x) => x.key === 'adminweb');
    assert.equal(admin.external, null);
  });

  await step('an unknown project or a missing one is refused', async () => {
    await assert.rejects(() => webRun(root, 'nope', {}, () => {}), /Unknown project/);
    await assert.rejects(() => webRun(root, 'gateway', {}, () => {}), /was not found/);
  });

  console.log(`webapps-test: all ${passed} checks passed`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
