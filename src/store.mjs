// Small JSON files for JARVIS's own data (usage, saved prompts, routines). Each one is written
// whole and atomically: a crash mid-write leaves the previous good copy, never half a file.
import fs from 'node:fs';
import path from 'node:path';

/** The parsed file, or `fallback` when it is missing or unreadable. Never throws. */
export function readJson(file, fallback) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

/** Local calendar day as YYYY-MM-DD (not UTC: "today" means the user's day). */
export function localDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
