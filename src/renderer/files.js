/* JARVIS window - the Files view: the workspace to look through, and the way into VS Code.
   Reading only. Every change belongs in the editor, which is one click from each file. */
(() => {
  'use strict';
  const { $, el, state } = JV;

  let all = [];
  let vscode = true;
  let current = null;
  let kind = 'all';
  let query = '';
  let sort = 'name'; // browsing wants a steady order; newest-first is one click away
  const MAX_ROWS = 400;
  /** These are mostly kilobytes, which JV.bytes would round away to "0 MB". */
  const size = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`);
  const MAX_LINES = 4000;

  /** The groups worth filtering by in this workspace. */
  const KINDS = [
    ['all', 'All', null],
    ['sql', 'SQL', ['.sql']],
    ['md', 'Notes', ['.md', '.txt']],
    ['cs', 'C#', ['.cs', '.cshtml', '.razor', '.csproj']],
    ['dart', 'Dart', ['.dart']],
    ['web', 'Web', ['.js', '.ts', '.jsx', '.tsx', '.css', '.scss', '.html']],
    ['cfg', 'Config', ['.json', '.yaml', '.yml', '.xml', '.props', '.gradle', '.env', '.config']],
  ];

  function matches(f) {
    const k = KINDS.find((x) => x[0] === kind);
    if (k && k[2] && !k[2].includes(f.ext)) return false;
    if (!query) return true;
    const hay = f.rel.toLowerCase().replace(/\\/g, '/');
    return query.split(/\s+/).every((t) => hay.includes(t));
  }

  function renderKinds() {
    const box = $('fileKinds');
    box.replaceChildren();
    for (const [key, label, exts] of KINDS) {
      const n = exts ? all.filter((f) => exts.includes(f.ext)).length : all.length;
      if (exts && !n) continue;
      const b = el('button', `kind${kind === key ? ' on' : ''}`);
      b.appendChild(el('span', null, label));
      b.appendChild(el('em', null, String(n)));
      b.onclick = () => { kind = key; renderKinds(); renderList(); };
      box.appendChild(b);
    }
    const collapse = el('button', 'kind sort');
    collapse.title = 'Close every folder';
    collapse.appendChild(JV.icon('collapse'));
    collapse.onclick = () => { expanded.clear(); renderList(); };
    box.appendChild(collapse);
    const order = el('button', 'kind');
    order.title = 'Change the order';
    order.appendChild(JV.icon(sort === 'recent' ? 'clock' : 'tasks'));
    order.appendChild(el('span', null, sort === 'recent' ? 'Recent' : 'A–Z'));
    order.onclick = () => { sort = sort === 'recent' ? 'name' : 'recent'; renderKinds(); renderList(); };
    box.appendChild(order);
  }

  // ------------------------------------------------------------- the tree
  // A folder per repo, the way the editor shows them. Only what is open is built, so three
  // thousand files cost nothing until you go looking.
  const expanded = new Set();
  let tree = null;

  function buildTree(files) {
    const root = { name: '', path: '', dirs: new Map(), files: [], count: 0 };
    for (const f of files) {
      const parts = f.rel.replace(/\\/g, '/').split('/');
      let node = root;
      node.count++;
      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i];
        if (!node.dirs.has(seg)) {
          node.dirs.set(seg, { name: seg, path: parts.slice(0, i + 1).join('/'), dirs: new Map(), files: [], count: 0 });
        }
        node = node.dirs.get(seg);
        node.count++;
      }
      node.files.push(f);
    }
    return root;
  }

  const byName = (a, b) => a.name.localeCompare(b.name);
  const fileOrder = (x, y) => (sort === 'recent' ? y.mtime - x.mtime : x.name.localeCompare(y.name));

  /** Repos with uncommitted work get a dot, the way the editor marks them. */
  function repoState(name) {
    const r = (state.workspace?.repos || []).find((x) => x.name === name);
    if (!r || !r.ok) return null;
    return r.modified + r.staged + r.untracked > 0 ? 'dirty' : null;
  }

  function folderRow(node, depth, open) {
    const li = el('li', `tree-row folder${open ? ' open' : ''}`);
    li.style.paddingLeft = `${8 + depth * 14}px`;
    li.appendChild(JV.icon('chevron'));
    li.appendChild(JV.icon('repo'));
    const b = el('b', null, node.name);
    if (depth === 0 && repoState(node.name)) b.classList.add('dirty');
    li.appendChild(b);
    li.appendChild(el('span', 'tree-count', String(node.count)));
    li.title = node.path;
    li.onclick = () => {
      if (expanded.has(node.path)) expanded.delete(node.path); else expanded.add(node.path);
      renderList();
    };
    return li;
  }

  function fileRow(f, depth) {
    const li = el('li', `tree-row file${current && current.rel === f.rel ? ' on' : ''}`);
    li.style.paddingLeft = `${8 + depth * 14}px`;
    li.appendChild(el('span', `ext e-${f.ext.slice(1)}`, f.ext.slice(1)));
    li.appendChild(el('b', null, f.name));
    li.title = f.rel;
    li.onclick = () => open(f);
    li.ondblclick = () => window.jarvis.openInCode(f.rel);
    return li;
  }

  function renderNode(node, depth, ul, budget, forceOpen) {
    for (const d of [...node.dirs.values()].sort(byName)) {
      if (budget.left <= 0) return;
      const open = forceOpen || expanded.has(d.path);
      ul.appendChild(folderRow(d, depth, open));
      budget.left--;
      if (open) renderNode(d, depth + 1, ul, budget, forceOpen);
    }
    for (const f of node.files.sort(fileOrder)) {
      if (budget.left <= 0) return;
      ul.appendChild(fileRow(f, depth));
      budget.left--;
    }
  }

  function renderList() {
    const ul = $('fileList');
    ul.replaceChildren();
    const filtering = !!query || kind !== 'all';
    const hits = all.filter(matches);
    $('fileNote').textContent = filtering ? `${hits.length} of ${all.length} files` : `${all.length} files`;
    if (!hits.length) { ul.appendChild(el('li', 'muted empty', 'Nothing matches that.')); return; }
    tree = buildTree(hits);
    // While a filter is on, the folders holding the matches are opened for you.
    const budget = { left: MAX_ROWS };
    renderNode(tree, 0, ul, budget, filtering);
    if (budget.left <= 0) ul.appendChild(el('li', 'muted empty', 'Too many to show at once - narrow the search.'));
  }

  function headButton(icon, label, onClick, primary) {
    const b = el('button', `btn ${primary ? 'btn-primary' : 'btn-ghost'} file-btn`);
    b.appendChild(JV.icon(icon));
    b.appendChild(el('span', null, label));
    b.onclick = onClick;
    return b;
  }

  async function open(f) {
    current = f;
    renderList();
    const head = $('fileHead');
    const body = $('fileBody');
    head.replaceChildren();
    body.replaceChildren(el('div', 'file-empty', 'Reading…'));

    const d = await window.jarvis.fileText(f.rel);
    if (!current || current.rel !== f.rel) return; // a later click won
    if (d.error) { body.replaceChildren(el('div', 'file-empty', d.error)); return; }

    const title = el('div', 'file-title');
    title.appendChild(el('b', null, f.name));
    title.appendChild(el('small', null, `${f.rel.replace(/\\/g, '/')} · ${size(d.size)} · ${JV.ago(d.modified)}`));
    head.appendChild(title);
    const acts = el('div', 'file-acts');
    acts.appendChild(headButton('code', vscode ? 'Open in VS Code' : 'Open', async () => {
      const r = await window.jarvis.openInCode(f.rel);
      if (!r?.ok) JV.notify(r?.error || 'Could not open it.', { level: 'err' });
    }, true));
    acts.appendChild(headButton('file', 'Copy', async () => {
      await navigator.clipboard.writeText(d.text).catch(() => {});
      JV.notify(`${f.name} copied${f.ext === '.sql' ? ' - ready to paste into Workbench' : ''}.`, { level: 'ok' });
    }));
    acts.appendChild(headButton('layers', 'Copy path', async () => {
      await navigator.clipboard.writeText(f.rel.replace(/\\/g, '/')).catch(() => {});
      JV.notify('Path copied.', { level: 'ok' });
    }));
    acts.appendChild(headButton('external', 'Show in folder', () => window.jarvis.revealFile(f.rel)));
    head.appendChild(acts);

    const lines = d.text.split('\n');
    const shown = lines.slice(0, MAX_LINES);
    const pre = el('pre', 'file-pre');
    const frag = document.createDocumentFragment();
    shown.forEach((text, i) => {
      const row = el('div', 'file-line');
      row.appendChild(el('span', 'ln', String(i + 1)));
      row.appendChild(el('span', 'lt', text || ' '));
      frag.appendChild(row);
    });
    pre.appendChild(frag);
    body.replaceChildren(pre);
    if (lines.length > MAX_LINES || d.clipped) {
      body.appendChild(el('div', 'file-more', `Showing the first ${shown.length.toLocaleString()} lines. Open it in VS Code for the rest.`));
    }
    body.scrollTop = 0;
  }

  function emptyRight() {
    $('fileHead').replaceChildren();
    $('fileBody').replaceChildren(el('div', 'file-empty', 'Pick a file to read it here. Double-click one to open it straight in VS Code.'));
  }

  async function load(force) {
    const r = await window.jarvis.files(force);
    all = r.files || [];
    vscode = r.vscode !== false;
    renderKinds();
    renderList();
    if (!current) emptyRight();
    if (r.truncated) $('fileNote').textContent += ' (list capped)';
  }

  let booted = false;
  JV.on('view', (v) => {
    if (v !== 'files') return;
    if (booted) return;
    booted = true;
    $('fileSearch').addEventListener('input', (e) => { query = e.target.value.trim().toLowerCase(); renderList(); });
    emptyRight();
    load();
  });

  // The git state arrives after the first paint, so redraw once it does - that is what
  // marks the repos with uncommitted work.
  JV.on('workspace', () => { if (booted && state.view === 'files') renderList(); });

  /** Other views use this to hand a path to VS Code. */
  JV.openInCode = (rel, line) => window.jarvis.openInCode(rel, line);
})();
