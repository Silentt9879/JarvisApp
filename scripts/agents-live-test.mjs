// Does the bundled Claude Code agree with src/agents.mjs about agents? This starts the real
// claude.exe - in a throwaway workspace, with its own throwaway config folder - and asks it
// which agents it has. No message is ever sent, so no model is called and nothing is spent;
// nobody needs to be signed in. Skipped when claude.exe is not installed here.
//
// Not part of `npm test` (it starts a process and takes a few seconds):
//   npm run test:agents-live
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { saveAgent, setAgentEnabled, listAgents, BUILTIN_AGENTS, TEMPLATES } from '../src/agents.mjs';

const exe = fileURLToPath(new URL('../node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe', import.meta.url));
if (!fs.existsSync(exe)) { console.log('agents-live-test: SKIPPED - the bundled claude.exe is not installed here'); process.exit(0); }

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`  FAIL  ${name}${extra ? `\n        ${extra}` : ''}`); } };
const check = async (name, fn) => { try { await fn(); ok(true, name); } catch (e) { ok(false, name, String(e?.message || e).slice(0, 400)); } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-agents-live-'));
const home = path.join(TMP, 'claude-home');
const ws = path.join(TMP, 'ws');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(ws, { recursive: true });
const ctx = (trusted) => ({ cwd: ws, home, trusted, backupDir: path.join(TMP, 'backups') });

/** A message queue that never yields: the session starts, and is asked nothing. */
class Silent { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}), return: () => Promise.resolve({ done: true, value: undefined }) }; } }

/** What a fresh session reports, with the same options JarvisSession uses for a trusted or a restricted workspace. */
async function sessionAgents(trusted, during = null) {
  const abort = new AbortController();
  const q = query({
    prompt: new Silent(),
    options: {
      cwd: ws,
      pathToClaudeCodeExecutable: exe,
      settingSources: trusted ? ['user', 'project', 'local'] : ['user'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      env: { ...process.env, CLAUDE_CONFIG_DIR: home },
      abortController: abort,
      stderr: () => {},
    },
  });
  const list = async () => (await q.supportedAgents()).map((a) => ({ name: a.name, description: a.description, model: a.model || null }));
  try {
    const first = await list();
    const after = during ? (await during(), await list()) : null;
    return { first, after };
  } finally {
    try { q.close(); } catch { /* closed */ }
    try { abort.abort(); } catch { /* aborted */ }
  }
}
const timed = (p, ms = 90000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`no answer from claude.exe in ${ms / 1000} s`)), ms))]);

const TRICKY = 'Reviews code: finds "bugs" & risks #1.\nUse after changes - it\'s thorough.';
try {
  // What JARVIS writes, through the same calls the window makes.
  const t = TEMPLATES[0];
  assert.equal((await saveAgent(ctx(true), { scope: 'project', name: 'code-reviewer', description: TRICKY, tools: t.tools, model: 'haiku', body: t.body })).ok, true);
  assert.equal((await saveAgent(ctx(true), { scope: 'user', name: 'my-helper', description: 'A helper of my own.', tools: ['Read'], model: null, body: 'Help.' }, { approveUserScope: true })).ok, true);
  assert.equal((await saveAgent(ctx(true), { scope: 'project', name: 'shared-name', description: 'The workspace copy.', tools: ['Read'], model: null, body: 'x' })).ok, true);
  assert.equal((await saveAgent(ctx(true), { scope: 'user', name: 'shared-name', description: 'The personal copy.', tools: ['Read'], model: null, body: 'x' }, { approveUserScope: true })).ok, true);
  assert.equal((await saveAgent(ctx(true), { scope: 'project', name: 'switched-off', description: 'Should not load.', tools: ['Read'], model: null, body: 'x' })).ok, true);
  assert.equal((await setAgentEnabled(ctx(true), { scope: 'project', file: 'switched-off.md' }, false)).ok, true);
  // And what a person might have written by hand, in a sub-folder.
  fs.mkdirSync(path.join(ws, '.claude', 'agents', 'team'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.claude', 'agents', 'team', 'file-name.md'), '---\nname: nested-agent\ndescription: In a sub-folder\n---\n\nBody.\n');

  let trusted;
  await check('a trusted workspace: Claude Code loads exactly the agents JARVIS says it will', async () => {
    trusted = await timed(sessionAgents(true, async () => {
      // Made while the session is running.
      assert.equal((await saveAgent(ctx(true), { scope: 'project', name: 'late-arrival', description: 'Created mid-session.', tools: ['Read'], model: null, body: 'x' })).ok, true);
    }));
    const names = trusted.first.map((a) => a.name).sort();
    const mine = (await listAgents(ctx(true), { session: trusted.first })).agents;
    // (late-arrival is on disk by now, but this list is the one from before it was made.)
    const expected = mine.filter((a) => a.loads && a.name !== 'late-arrival').map((a) => a.name).sort();
    assert.deepEqual(names, expected, `Claude Code: ${names.join(', ')}`);
    assert.equal(mine.filter((a) => a.pending && a.name !== 'late-arrival').length, 0, 'nothing is waiting for a reload that is already loaded');
  });
  await check('the built-in agents are the ones JARVIS calls built in', async () => {
    const fileNames = new Set(['code-reviewer', 'my-helper', 'shared-name', 'nested-agent']);
    const builtin = trusted.first.map((a) => a.name).filter((n) => !fileNames.has(n)).sort();
    assert.deepEqual(builtin, [...BUILTIN_AGENTS].sort(), `Claude Code reports: ${builtin.join(', ')}`);
  });
  await check('a description with quotes, a colon, a # and a line break arrives exactly as typed', async () => {
    const a = trusted.first.find((x) => x.name === 'code-reviewer');
    assert.equal(a.description, TRICKY);
    assert.equal(a.model, 'haiku');
  });
  await check('a workspace agent hides a personal one of the same name; a switched-off one is not loaded', async () => {
    assert.equal(trusted.first.filter((a) => a.name === 'shared-name').length, 1);
    assert.equal(trusted.first.find((a) => a.name === 'shared-name').description, 'The workspace copy.');
    assert.equal(trusted.first.some((a) => a.name === 'switched-off'), false);
  });
  await check('sub-folders are read, and the front matter\'s name is the agent\'s name', async () => {
    assert.ok(trusted.first.some((a) => a.name === 'nested-agent'));
    assert.equal(trusted.first.some((a) => a.name === 'file-name'), false);
  });
  await check('a running session does not notice a new agent - so JARVIS says "reload", and is right to', async () => {
    assert.equal(trusted.after.some((a) => a.name === 'late-arrival'), false, 'it was picked up without a restart: the reload notice is no longer needed');
    const late = (await listAgents(ctx(true), { session: trusted.after })).agents.find((a) => a.name === 'late-arrival');
    assert.deepEqual([late.loads, late.inSession, late.pending], [true, false, 'add']);
    const next = await timed(sessionAgents(true));
    assert.ok(next.first.some((a) => a.name === 'late-arrival'), 'and the next session has it');
    assert.equal((await listAgents(ctx(true), { session: next.first })).pending, 0);
  });
  await check('a restricted workspace: none of its agents load, the person\'s own still do', async () => {
    const r = await timed(sessionAgents(false));
    const names = r.first.map((a) => a.name);
    for (const n of ['code-reviewer', 'nested-agent', 'late-arrival']) assert.equal(names.includes(n), false, n);
    assert.ok(names.includes('my-helper'));
    assert.equal(r.first.find((a) => a.name === 'shared-name').description, 'The personal copy.', 'with the workspace copy out of the way, the personal one is used');
    const mine = (await listAgents(ctx(false), { session: r.first })).agents;
    assert.deepEqual(names.sort(), mine.filter((a) => a.loads).map((a) => a.name).sort());
    assert.equal(mine.filter((a) => a.pending).length, 0);
  });
} catch (e) {
  ok(false, 'setting up the folders', String(e?.stack || e).slice(0, 400));
}

// claude.exe lets go of its folder a moment after it is closed: wait, then retry the removal.
await new Promise((r) => setTimeout(r, 2000));
try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 }); }
catch (e) { console.log(`  (the temp folder could not be removed yet: ${TMP} - ${e?.code || e})`); }
console.log(`agents-live-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
