// Saved prompts: reusable messages for the chat, with blanks in curly braces that are asked for
// each time, e.g. "Review {file} for bugs". Stored as JSON in the user data folder.
import crypto from 'node:crypto';
import { readJson, writeJson } from './store.mjs';

const BLANK = /\{([a-zA-Z][\w-]{0,30})\}/g;
const MAX_TITLE = 60;
const MAX_TEXT = 4000;
const MAX_PROMPTS = 200;

/** The blank names in a prompt, in order of first appearance, without repeats. */
export function variablesOf(text) {
  return [...new Set([...String(text ?? '').matchAll(BLANK)].map((m) => m[1]))];
}

/** The prompt with each blank filled from `values`; a blank with no value is left as it is. */
export function fillVariables(text, values = {}) {
  return String(text ?? '').replace(BLANK, (m, k) => (Object.prototype.hasOwnProperty.call(values, k) ? String(values[k]) : m));
}

export function checkPrompt({ title, text }) {
  const t = String(title ?? '').trim();
  const body = String(text ?? '').trim();
  if (!t) return { ok: false, error: 'Give the prompt a short name.' };
  if (t.length > MAX_TITLE) return { ok: false, error: `Keep the name under ${MAX_TITLE} characters.` };
  if (!body) return { ok: false, error: 'Write what JARVIS should be asked.' };
  if (body.length > MAX_TEXT) return { ok: false, error: `Keep the prompt under ${MAX_TEXT} characters.` };
  return { ok: true, value: { title: t, text: body } };
}

export class PromptLibrary {
  constructor(file, { now = () => Date.now(), makeId = () => crypto.randomUUID() } = {}) {
    this.file = file;
    this.now = now;
    this.makeId = makeId;
  }

  list() {
    const items = readJson(this.file, []);
    return Array.isArray(items) ? items : [];
  }

  add(input) {
    const c = checkPrompt(input);
    if (!c.ok) return c;
    const items = this.list();
    if (items.length >= MAX_PROMPTS) return { ok: false, error: `You can save up to ${MAX_PROMPTS} prompts. Remove one first.` };
    const item = { id: this.makeId(), ...c.value, created: this.now(), updated: this.now() };
    items.push(item);
    writeJson(this.file, items);
    return { ok: true, item };
  }

  update(id, input) {
    const c = checkPrompt(input);
    if (!c.ok) return c;
    const items = this.list();
    const it = items.find((p) => p.id === id);
    if (!it) return { ok: false, error: 'That prompt no longer exists.' };
    Object.assign(it, c.value, { updated: this.now() });
    writeJson(this.file, items);
    return { ok: true, item: it };
  }

  remove(id) {
    const items = this.list();
    const next = items.filter((p) => p.id !== id);
    if (next.length === items.length) return { ok: false, error: 'That prompt no longer exists.' };
    writeJson(this.file, next);
    return { ok: true };
  }
}
