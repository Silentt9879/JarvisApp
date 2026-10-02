// Markdown -> Telegram HTML, for replies sent to the phone.
//
// Telegram shows Markdown as raw text: a table arrives as rows of pipes and dashes, **bold**
// keeps its asterisks. Its own Markdown modes reject a message over one stray `_` or `*`,
// so replies go as parse_mode HTML, where only &, < and > need escaping - everything from
// the model is escaped first and only the tags made here are real.
//
// Tables become a monospace grid sized for a phone: the widest column wraps until the grid
// fits TABLE_WIDTH, so it reads as a table instead of wrapping into noise. A table too wide
// even then (too many columns) becomes one card per row. The grid is drawn in plain ASCII:
// a phone's monospace font may not have box-drawing characters, and the stand-ins it
// borrows are wider than a letter, which knocks every rule out of line.

const TABLE_WIDTH = 34;   // monospace characters across a phone screen, with a little to spare
const MIN_COL = 6;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Inline Markdown on one line of prose: `code`, **bold**, *italic*, ~~strike~~, [links](url). */
function inline(text) {
  const codes = [];
  // Code first, so nothing inside it is read as formatting.
  let s = String(text).replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s);
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u.replace(/"/g, '&quot;')}">${t}</a>`);
  s = s.replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, '<b>$1</b>');
  s = s.replace(/__(?=\S)([^\n]*?\S)__/g, '<b>$1</b>');
  // Single * only between word edges; a lone _ is left alone, it is usually snake_case.
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, '$1<i>$2</i>');
  s = s.replace(/~~(?=\S)([^\n]*?\S)~~/g, '<s>$1</s>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
}

/** Markdown markers off, for text that goes inside <pre> where tags would show. */
const plain = (s) => String(s)
  .replace(/`([^`]*)`/g, '$1')
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/__([^_]+)__/g, '$1')
  .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  .replace(/~~([^~]+)~~/g, '$1')
  .replace(/<br\s*\/?>/gi, ' ')
  .trim();

const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
const isRule = (l) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(l);
const cells = (l) => {
  const t = l.trim().replace(/^\|/, '').replace(/\|$/, '');
  return t.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
};

/** Word-wrap to width, breaking a word only when it is longer than the line. */
function wrap(text, width) {
  const out = [];
  let line = '';
  for (let word of String(text).split(/\s+/).filter(Boolean)) {
    while (word.length > width) {
      if (line) { out.push(line); line = ''; }
      out.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else { out.push(line); line = word; }
  }
  if (line || !out.length) out.push(line);
  return out;
}

function table(head, rows) {
  const n = head.length;
  const grid = [head, ...rows].map((r) => Array.from({ length: n }, (_, i) => plain(r[i] ?? '')));
  const widths = Array.from({ length: n }, (_, i) => Math.max(1, ...grid.map((r) => r[i].length)));
  const total = () => widths.reduce((a, b) => a + b, 0) + 3 * (n - 1);
  while (total() > TABLE_WIDTH) {
    const w = Math.max(...widths);
    if (w <= MIN_COL) break;
    widths[widths.indexOf(w)]--;
  }
  if (total() > TABLE_WIDTH) {
    // Too many columns for a phone: one card per row, the first cell as its title.
    return rows.map((r) => {
      const lines = [`<b>${inline(r[0] ?? '')}</b>`];
      for (let i = 1; i < n; i++) if ((r[i] ?? '').trim()) lines.push(`${inline(head[i] || '')}: ${inline(r[i])}`);
      return lines.join('\n');
    }).join('\n\n');
  }
  const render = (r) => {
    const wrapped = r.map((c, i) => wrap(c, widths[i]));
    const height = Math.max(...wrapped.map((w) => w.length));
    const lines = [];
    for (let k = 0; k < height; k++) lines.push(wrapped.map((w, i) => (w[k] || '').padEnd(widths[i])).join(' | ').trimEnd());
    return lines;
  };
  const rule = widths.map((w) => '-'.repeat(w)).join('-+-');
  const gap = widths.map((w) => ' '.repeat(w)).join(' | ').trimEnd();
  const body = grid.slice(1).map(render);
  // Rows that wrap get an empty line between them, or their lines run together.
  const tall = body.some((l) => l.length > 1);
  const out = [...render(grid[0]), rule];
  body.forEach((l, i) => { if (tall && i) out.push(gap); out.push(...l); });
  return `<pre>${esc(out.join('\n'))}</pre>`;
}

/** Convert a Markdown reply to Telegram HTML. */
export function toTelegramHtml(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const fence = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/.exec(l);
    if (fence) {
      const code = [];
      for (i++; i < lines.length && !new RegExp(`^\\s*${fence[1]}\\s*$`).test(lines[i]); i++) code.push(lines[i]);
      const lang = fence[2] ? ` class="language-${esc(fence[2])}"` : '';
      out.push(`<pre><code${lang}>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (isRow(l) && i + 1 < lines.length && isRule(lines[i + 1])) {
      const head = cells(l);
      const rows = [];
      for (i += 2; i < lines.length && isRow(lines[i]); i++) rows.push(cells(lines[i]));
      i--;
      out.push(table(head, rows));
      continue;
    }
    let m;
    if ((m = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(l))) { out.push(`<b>${inline(m[1])}</b>`); continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push('──────────'); continue; }
    if ((m = /^(\s*)[-*+]\s+\[( |x|X)\]\s+(.*)$/.exec(l))) { out.push(`${m[1]}${m[2] === ' ' ? '☐' : '☑'} ${inline(m[3])}`); continue; }
    if ((m = /^(\s*)[-*+]\s+(.*)$/.exec(l))) { out.push(`${m[1]}• ${inline(m[2])}`); continue; }
    if ((m = /^\s*>\s?(.*)$/.exec(l))) {
      const quote = [m[1]];
      while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1])) quote.push(lines[++i].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${quote.map(inline).join('\n')}</blockquote>`);
      continue;
    }
    out.push(inline(l));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Split Markdown into pieces for separate messages, keeping each code fence whole: a piece
 * that ends inside one closes it, and the next reopens it.
 */
export function balanceFences(parts) {
  const out = [];
  let open = null;
  for (let p of parts) {
    if (open != null) p = `${open}\n${p}`;
    open = null;
    for (const l of p.split('\n')) {
      const f = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/.exec(l);
      if (!f) continue;
      open = open == null ? `${f[1]}${f[2]}` : null;
    }
    out.push(open != null ? `${p}\n${open.slice(0, 3)}` : p);
  }
  return out;
}
