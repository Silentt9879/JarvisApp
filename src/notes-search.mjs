// JARVIS Notes - Phase 4 (AI Knowledge): local, pure-JS search and retrieval over Notes - no
// network call, no external AI provider, no new dependency. Reuses listKnowledgeNotes
// unchanged; this file only ranks and snippets what that already returns.
//
// WHAT THIS FILE NEVER DOES: send a note's content anywhere by itself (it only returns data
// to its caller - main.mjs decides what, if anything, reaches an AI provider); include a note
// whose own `aiExcluded` front-matter field is true, in a search result OR in AI context, no
// matter how well it matches; or hand back "the whole notes database" as context - only the
// few, explicitly top-ranked notes for a given question, and only when at least one of them
// actually matches something in the query (never a default dump of recent notes).
//
// THE SCORING is intentionally simple keyword matching, not an embedding/semantic search -
// consistent with this codebase's existing choice (docs/jarvis-knowledge-design.md §9) to
// prefer a small, dependency-free approach at this corpus size (a personal notebook, not a
// document corpus) over pulling in a real search library. "Natural language" input still
// works reasonably well because the question's own content words are exactly what a personal
// note about that topic would also contain.
import fs from 'node:fs';
import { listKnowledgeNotes } from './knowledge.mjs';

export const MAX_CONTEXT_NOTES = 5;
export const MAX_CHARS_PER_NOTE = 4000;
const STOPWORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'what', 'when', 'where', 'how', 'do', 'does', 'did', 'my', 'me', 'i', 'about', 'with', 'this', 'that']);

/** Lowercased word tokens, stopwords and anything under 2 characters dropped - short, common
 *  words would otherwise dominate the score of every note without actually meaning anything. */
export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** How well one note matches a (already-tokenized) query - title and tag matches weighted
 *  higher than a body occurrence, the same "title/tag beats body text" instinct a person
 *  skimming their own notes would use. Returns 0 for no match at all - a 0-scoring note is
 *  never returned by searchNotes or included as AI context (see below), so an unrelated note
 *  can never show up just because the corpus happens to be small. */
export function scoreNote(note, queryTokens) {
  if (!queryTokens.length) return 0;
  const titleTokens = tokenize(note.title);
  const tagTokens = (note.tags || []).flatMap((t) => tokenize(t));
  const bodyTokens = tokenize(note.body);
  let score = 0;
  for (const q of queryTokens) {
    if (titleTokens.includes(q)) score += 5;
    if (tagTokens.includes(q)) score += 3;
    const occurrences = bodyTokens.filter((t) => t === q).length;
    score += Math.min(occurrences, 5); // capped - a note that repeats one word 50 times should not crowd out everything else
  }
  return score;
}

/** A short window of the body around the first matching query word - the same idea
 *  searchDocs() in workspace.mjs already uses for its own snippets, independently arrived at
 *  here since notes-search.mjs has no dependency on workspace.mjs (notes are not
 *  workspace-scoped; see this file's own header and docs/phase4-ai-knowledge.md). */
export function snippetFor(body, queryTokens, { radius = 70 } = {}) {
  const text = String(body || '');
  const lower = text.toLowerCase();
  let at = -1;
  for (const q of queryTokens) { const i = lower.indexOf(q); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at < 0) return text.slice(0, radius * 2).replace(/\s+/g, ' ').trim();
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}

/**
 * Every non-excluded, non-corrupt note, ranked by how well it matches `query` - a 0-scoring
 * note is never included, so this is never "every note, sorted," only "notes that actually
 * matched something." Used for the Notes page's own search/results UI; `notesForAiContext`
 * below builds on the exact same ranking for what reaches an AI provider.
 */
export function searchNotes(userDir, query, { fsImpl = fs, limit = 20 } = {}) {
  const queryTokens = tokenize(query);
  if (!queryTokens.length) return { ok: true, query: String(query || ''), results: [] };
  const r = listKnowledgeNotes(userDir, { fsImpl });
  if (!r.ok) return { ok: false, error: r.error, results: [] };
  const scored = r.notes
    .filter((n) => !n.aiExcluded && !n.corrupt)
    .map((n) => ({ note: n, score: scoreNote(n, queryTokens) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return {
    ok: true,
    query: String(query || ''),
    results: scored.map(({ note, score }) => ({
      id: note.id, title: note.title || 'Untitled note', folder: note.folder, tags: note.tags,
      score, snippet: snippetFor(note.body, queryTokens), updated: note.updated,
    })),
  };
}

/**
 * The top-ranked notes' own content (truncated, never the whole note store), for composing
 * into an AI prompt - "retrieve relevant note content" and the source list "cite or link back
 * to source notes" both come from this one function's result. Returns `ok:false` (not an
 * empty success) when nothing actually matches, so a caller can never mistake "found nothing
 * relevant" for "here is some context anyway" - there is no silent fallback to recent/random
 * notes.
 */
export function notesForAiContext(userDir, query, { fsImpl = fs, limit = MAX_CONTEXT_NOTES } = {}) {
  const r = searchNotes(userDir, query, { fsImpl, limit });
  if (!r.ok) return r;
  if (!r.results.length) return { ok: false, error: 'Nothing in your notes matches that - try different words.', results: [] };
  const full = listKnowledgeNotes(userDir, { fsImpl });
  const byId = new Map((full.ok ? full.notes : []).map((n) => [n.id, n]));
  const sources = r.results.map((res) => {
    const n = byId.get(res.id);
    const body = String(n?.body || '');
    return {
      id: res.id, title: res.title, folder: res.folder,
      body: body.length > MAX_CHARS_PER_NOTE ? `${body.slice(0, MAX_CHARS_PER_NOTE)}…` : body,
      truncated: body.length > MAX_CHARS_PER_NOTE,
    };
  });
  return { ok: true, query: r.query, sources };
}

/**
 * Composes the actual text to put in front of the person before it reaches any AI - numbered,
 * explicitly labeled as their own notes (so the model - and the person reviewing before they
 * press Send - can tell this is retrieved content, not instructions), each source cited by
 * title so an answer can reference "note 2" and the person can verify it against the original.
 * Pure string building - this never calls an AI provider itself; see docs/phase4-ai-knowledge.md
 * for why that call happens through the EXISTING chat session instead of a second AI path.
 */
export function buildContextPrompt(query, sources) {
  const lines = [
    `Using only the following notes of mine, answer this question: ${query}`,
    '',
    ...sources.flatMap((s, i) => [`[${i + 1}] ${s.title}${s.folder ? ` (${s.folder})` : ''}`, s.body, '']),
    'Please cite which note number(s) you used, and say plainly if the notes don\'t actually answer the question.',
  ];
  return lines.join('\n').trim();
}
