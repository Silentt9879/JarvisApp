// Files - a read-only look at the workspace, and the way into VS Code.
//
// JARVIS does not try to be an editor: VS Code is one window away and far better at it.
// What is worth having here is the short path - find the file, read it without leaving the
// app, then open it where you will actually change it. Nothing in this file writes.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { repoDisplayName } from './workspace.mjs';

/**
 * Folders that hold build output or dependencies - never worth browsing. (`packages` is
 * not one: in a monorepo, or a Flutter app with local packages, it is real source.)
 */
const SKIP = new Set([
  'node_modules', '.git', 'build', 'obj', 'bin', '.dart_tool', '.vs', 'dist', '.gradle',
  'Pods', '.idea', 'coverage', '.next', '.nuget', 'TestResults', '.angular', 'target',
  '__pycache__', '.venv', 'venv',
]);
/** Text we can show. Anything else is left to VS Code. */
const EXT = new Set([
  '.sql', '.md', '.cs', '.dart', '.cshtml', '.razor', '.js', '.ts', '.jsx', '.tsx', '.css',
  '.scss', '.json', '.yaml', '.yml', '.xml', '.py', '.txt', '.html', '.gradle', '.props',
  '.csproj', '.sh', '.ps1', '.bat', '.cmd', '.env', '.config', '.kt', '.java', '.swift',
]);
const MAX_FILES = 12000;
const MAX_PREVIEW = 1024 * 1024; // 1 MB of text is far more than anyone reads in a panel

/** Which part of the workspace a path belongs to: its top folder, by the name shown for it. */
function areaOf(rel) {
  const top = rel.split(/[\\/]/)[0];
  if (top === '.claude') return 'JARVIS';
  return rel.includes(path.sep) ? repoDisplayName(top, top) : 'Workspace root';
}

function walk(dir, base, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP.has(e.name)) continue;
      // Hidden folders are skipped, except .claude - that is the workspace's own brain.
      if (e.name.startsWith('.') && e.name !== '.claude') continue;
      walk(full, base, out);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (!EXT.has(ext)) continue;
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      const rel = path.relative(base, full);
      out.push({ rel, name: e.name, ext, area: areaOf(rel), size: st.size, mtime: st.mtimeMs });
    }
  }
}

/** Every browsable file in the workspace, newest first within each area. */
export function listFiles(cwd) {
  const out = [];
  walk(cwd, cwd, out);
  out.sort((a, b) => b.mtime - a.mtime);
  return { files: out, truncated: out.length >= MAX_FILES };
}

/** A path inside the workspace, or null. Keeps every read and open within it. */
export function inside(cwd, rel) {
  if (typeof cwd !== 'string' || !cwd || typeof rel !== 'string' || !rel || rel.includes('\0')) return null;
  const base = path.resolve(cwd);
  const full = path.resolve(base, rel);
  const lower = full.toLowerCase();
  const b = base.toLowerCase();
  return lower === b || lower.startsWith(b.endsWith(path.sep) ? b : b + path.sep) ? full : null;
}

/**
 * What "Open" may hand to Windows' own app for the file when VS Code is not there: plain
 * documents and pictures, which their app shows and nothing more. An allowlist, not a list of
 * dangers - a .sh opens in Git Bash and runs, a .py in Python, and no blocklist keeps up with
 * every handler a PC has. Anything else is shown in Explorer instead, so a click on a
 * project's file never runs it.
 */
export const OPENABLE = /\.(txt|md|markdown|json|jsonc|yaml|yml|toml|ini|cfg|conf|xml|csv|tsv|log|sql|png|jpe?g|gif|webp|bmp|ico|pdf)$/i;

/** Through links too: a symlink or junction inside the workspace may not lead out of it. */
export async function reallyInside(cwd, full) {
  try {
    const real = (await fsp.realpath(full)).toLowerCase();
    const base = (await fsp.realpath(cwd)).toLowerCase();
    return real === base || real.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
  } catch { return false; }
}

export async function readWorkspaceFile(cwd, rel) {
  const full = inside(cwd, rel);
  if (!full || !(await reallyInside(cwd, full))) throw new Error('That file is outside the workspace.');
  const st = await fsp.stat(full);
  if (!st.isFile()) throw new Error('That is not a file.');
  const clipped = st.size > MAX_PREVIEW;
  const fd = await fsp.open(full, 'r');
  try {
    const buf = Buffer.alloc(Math.min(st.size, MAX_PREVIEW));
    await fd.read(buf, 0, buf.length, 0);
    return {
      rel,
      full,
      text: buf.toString('utf8').replace(/^﻿/, ''),
      size: st.size,
      modified: st.mtimeMs,
      clipped,
    };
  } finally { await fd.close(); }
}

// ---------------------------------------------------------------- VS Code
let codeExe;
/**
 * VS Code itself, not the `code.cmd` wrapper. The wrapper has to go through cmd.exe, and
 * cmd mangles a path containing spaces ("Microsoft VS Code") - it failed silently, which
 * is why the button appeared to do nothing. The exe takes the same arguments directly.
 */
function vscode() {
  if (codeExe !== undefined) return codeExe;
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft VS Code', 'Code.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft VS Code', 'Code.exe'),
  ].filter(Boolean);
  codeExe = candidates.find((p) => fs.existsSync(p)) || null;
  return codeExe;
}

export const hasVsCode = () => !!vscode() || process.platform !== 'win32';

/**
 * Open a workspace file or folder in VS Code. Resolves to { ok } or { ok: false, error } -
 * the caller falls back to the default handler.
 *
 * Just the path: measured against a running VS Code, `Code.exe <path>` opens the file in
 * the existing window, while `-g path:line` and the `code.cmd` wrapper both did nothing at
 * all. So there is no jump-to-line through this route; `line` is accepted and ignored.
 */
export async function openInVsCode(cwd, rel, line) {
  const full = inside(cwd, rel);
  if (!full) return { ok: false, error: 'That path is outside the workspace.' };
  if (!fs.existsSync(full)) return { ok: false, error: 'That file is no longer there.' };
  if (!(await reallyInside(cwd, full))) return { ok: false, outside: true, error: 'That path leads outside the workspace.' };
  const exe = vscode();
  if (!exe) return { ok: false, error: 'VS Code was not found on this machine.' };
  const args = [full];
  const env = { ...process.env };
  // Code.exe is an Electron binary: with this set it would run as plain Node and reject
  // every VS Code flag. Electron hosts set it for child processes, so it must go.
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    const child = spawn(exe, args, { windowsHide: true, detached: true, stdio: 'ignore', env });
    child.once('error', (e) => done({ ok: false, error: e.message }));
    child.once('spawn', () => { child.unref(); done({ ok: true }); });
    setTimeout(() => done({ ok: true }), 2000); // launched, just slow to report
  });
}
