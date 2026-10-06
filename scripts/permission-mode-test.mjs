// Unit test for the chat's starting permission mode (user, 2026-10-06: chats opened in ask
// mode although the user's own settings say "defaultMode": "auto").
// Temp folders only - the real settings files are never read or written. Run:
//   node scripts/permission-mode-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startingMode, WINDOW_MODES } from '../src/permission-mode.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-mode-'));
const home = path.join(root, 'home');
const cwd = path.join(root, 'workspace');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
const write = (file, mode) => fs.writeFileSync(file, JSON.stringify({ permissions: { defaultMode: mode } }));
const userFile = path.join(home, 'settings.json');
const projectFile = path.join(cwd, '.claude', 'settings.json');
const localFile = path.join(cwd, '.claude', 'settings.local.json');

try {
  // Nothing set anywhere: ask mode, as before.
  assert.deepEqual(startingMode(cwd, { home }), { mode: 'default', asked: null, from: null });

  // The user's own setting is honoured - the bug: this used to be ignored.
  write(userFile, 'auto');
  assert.equal(startingMode(cwd, { home }).mode, 'auto');
  assert.equal(startingMode(cwd, { home }).from, userFile);

  // Same order as Claude Code: project over user, local over project.
  write(projectFile, 'acceptEdits');
  assert.equal(startingMode(cwd, { home }).mode, 'acceptEdits');
  write(localFile, 'plan');
  assert.equal(startingMode(cwd, { home }).mode, 'plan');

  // A settings file asking for bypassPermissions never gets it in the window.
  write(localFile, 'bypassPermissions');
  const bypass = startingMode(cwd, { home });
  assert.equal(bypass.mode, 'default');
  assert.equal(bypass.asked, 'bypassPermissions');
  assert.ok(!WINDOW_MODES.includes('bypassPermissions'));

  // An unknown value also falls back to ask, rather than guessing.
  write(localFile, 'yolo');
  assert.equal(startingMode(cwd, { home }).mode, 'default');

  // A broken or settings-less file is skipped, and the next one decides.
  fs.writeFileSync(localFile, '{ not json');
  fs.writeFileSync(projectFile, JSON.stringify({ env: { A: '1' } }));
  assert.equal(startingMode(cwd, { home }).mode, 'auto', 'falls through to the user file');

  // No workspace folder: the user setting still applies.
  assert.equal(startingMode(null, { home }).mode, 'auto');

  console.log('permission-mode-test: all assertions passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
