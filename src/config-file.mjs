// config.json on disk: read it the way JARVIS can use it, and merge a change into it.
//
// One rule above the rest: a settings file that is there but cannot be read - a hand edit gone
// wrong, a file held open by something else - is NEVER overwritten. Nothing is saved until it
// reads again; main.mjs reports why (Health). Replacing it would quietly throw away the
// person's Telegram bot, phone, budget and ClickUp settings to save one new choice.
import fs from 'node:fs';
import path from 'node:path';

/**
 * The file as JARVIS can use it: { value }, { missing: true } when there is none yet, or
 * { problem } when it is there but cannot be used. Never throws. A byte-order mark - what
 * Notepad and Windows PowerShell 5.1 put at the start of a hand edit - is not a problem.
 */
export function readConfigFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    return e?.code === 'ENOENT' ? { missing: true } : { problem: `could not be opened (${e?.code || 'error'})` };
  }
  try {
    const v = JSON.parse(text.replace(/^﻿/, ''));
    return v && typeof v === 'object' && !Array.isArray(v) ? { value: v } : { problem: 'does not hold settings' };
  } catch (e) {
    return { problem: `is not valid JSON (${String(e?.message || e).slice(0, 120)})` };
  }
}

/**
 * Merge `patch` into the file, through a temp file and a rename so a crash mid-write cannot
 * leave half a config. Returns { ok: true, value } or { ok: false, problem } - and in the
 * second case nothing was written. Throws only if the disk refuses the write itself.
 */
export function mergeConfigFile(file, patch) {
  const r = readConfigFile(file);
  if (r.problem) return { ok: false, problem: r.problem };
  const value = { ...(r.value || {}), ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return { ok: true, value };
}
