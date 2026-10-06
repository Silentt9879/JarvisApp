/* Notes: a plain place to write something down, kept beside the config as notes.json,
   and - when asked - sent to the same Telegram chat the phone alerts use.

   Deliberately small. A note is text with an id and two timestamps; there are no
   folders, tags or sharing. The file is the whole store: written in one go, read back
   on demand, and a corrupt or missing file simply reads as "no notes yet".

   The Telegram token never comes through here from the window - the caller passes the
   config main already holds, and only a sent/failed result goes back. */
import fs from 'node:fs';
import path from 'node:path';

import { sendTelegram, isChatId } from './telegram.mjs';

export const MAX_TEXT = 8000;      // a note, not a document
export const MAX_NOTES = 500;      // the oldest are kept; the file stays small
const TITLE_MAX = 60;

/** The first non-empty line, shortened - what the list and the Telegram message show. */
export function titleOf(text) {
  const first = String(text || '').split(/\r?\n/).find((l) => l.trim()) || '';
  const t = first.trim().replace(/^#+\s*/, '').slice(0, TITLE_MAX);
  return t || 'Untitled note';
}

const clean = (text) => String(text ?? '').replace(/\r\n/g, '\n').slice(0, MAX_TEXT);

export class NoteStore {
  /** @param {string} dir where notes.json lives (the user data folder). */
  constructor(dir) { this.file = path.join(dir, 'notes.json'); }

  /** Every note, newest first. Never throws: an unreadable file is an empty store. */
  list() {
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return []; }
    const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.notes) ? raw.notes : [];
    return arr
      .filter((n) => n && typeof n.id === 'string' && typeof n.text === 'string')
      .map((n) => ({
        id: n.id,
        text: clean(n.text),
        created: Number(n.created) || 0,
        updated: Number(n.updated) || Number(n.created) || 0,
        sentAt: Number(n.sentAt) || null,
      }))
      .sort((a, b) => b.updated - a.updated);
  }

  write(notes) {
    const keep = notes.slice(0, MAX_NOTES);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, `${JSON.stringify(keep, null, 2)}\n`);
    return keep;
  }

  /** Create a note, or replace the text of one that exists. Returns the saved note. */
  save({ id, text } = {}) {
    const body = clean(text);
    if (!body.trim()) return { ok: false, error: 'Nothing to save, sir - the note is empty.' };
    const notes = this.list();
    const now = Date.now();
    const at = typeof id === 'string' ? notes.findIndex((n) => n.id === id) : -1;
    let note;
    if (at >= 0) { note = { ...notes[at], text: body, updated: now }; notes[at] = note; }
    else { note = { id: `n${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`, text: body, created: now, updated: now, sentAt: null }; notes.unshift(note); }
    try { this.write(notes.sort((a, b) => b.updated - a.updated)); }
    catch (e) { return { ok: false, error: `Could not write notes.json: ${String(e?.message || e)}` }; }
    return { ok: true, note };
  }

  remove(id) {
    const notes = this.list();
    const left = notes.filter((n) => n.id !== id);
    if (left.length === notes.length) return { ok: false, error: 'That note is already gone.' };
    try { this.write(left); } catch (e) { return { ok: false, error: `Could not write notes.json: ${String(e?.message || e)}` }; }
    return { ok: true };
  }

  /** Record that a note reached Telegram. A failure here is not worth failing the send. */
  markSent(id, at = Date.now()) {
    const notes = this.list();
    const n = notes.find((x) => x.id === id);
    if (!n) return;
    n.sentAt = at;
    try { this.write(notes); } catch { /* the note is saved and sent; the stamp is cosmetic */ }
  }
}

/** Is Telegram set up well enough to send a note? Says nothing about the token itself. */
export const telegramReady = (tg) => !!(tg && tg.token && isChatId(tg.chatId));

/**
 * Send one note to the configured Telegram chat, as plain text under a "Note" heading.
 * `tg` is main's telegram config; the token stays in the caller's hands, and only
 * {ok} or {ok:false,error} comes back - sendTelegram keeps the token out of errors.
 */
export async function sendNote(tg, note) {
  if (!telegramReady(tg)) return { ok: false, error: 'Telegram is not set up yet - do that on the Devices page.' };
  const when = new Date(note?.updated || Date.now()).toLocaleString('en-GB');
  return sendTelegram(tg, { title: `📝 Note · ${titleOf(note?.text)}`, body: `${when}\n\n${clean(note?.text)}` });
}
