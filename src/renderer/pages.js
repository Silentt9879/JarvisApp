/* JARVIS window - the detail pages: AI Core, Agents, Tasks, Memory, Knowledge Base,
   Tools & Skills and Workspace. All read-only views of real data. */
(() => {
  'use strict';
  const { $, el, state } = JV;

  const kv = (dl, rows) => {
    dl.replaceChildren();
    for (const [k, v, cls] of rows) {
      dl.appendChild(el('dt', null, k));
      dl.appendChild(el('dd', cls || null, v == null || v === '' ? '–' : String(v)));
    }
  };

  // ------------------------------------------------------------- document reader (shared)
  async function openDoc(reader, root, rel, title) {
    reader.replaceChildren(el('div', 'reader-empty', 'Loading…'));
    const d = await window.jarvis.doc(root, rel);
    reader.replaceChildren();
    if (d.error) { reader.appendChild(el('div', 'reader-empty', d.error)); return; }
    const head = el('div', 'reader-head');
    const t = el('div');
    t.appendChild(el('b', null, title || rel));
    t.appendChild(el('small', null, `${rel} · updated ${JV.ago(d.modified)}`));
    head.appendChild(t);
    const open = el('button', 'btn btn-ghost small');
    open.appendChild(JV.icon('code'));
    open.appendChild(el('span', null, 'Edit in VS Code'));
    // d.full is the real path, so the editor opens the file itself, not a copy of the text.
    open.onclick = async () => {
      const r = d.wsRel ? await window.jarvis.openInCode(d.wsRel) : null;
      if (!r || !r.ok) window.jarvis.openDoc(root, rel);
    };
    head.appendChild(open);
    reader.appendChild(head);
    const body = el('div', 'content reader-body');
    JV.renderMarkdown(body, d.text);
    reader.appendChild(body);
    reader.scrollTop = 0;
  }
  JV.openDoc = openDoc;

  function docRow(d, onClick, selected) {
    const b = el('button', `doc${selected ? ' sel' : ''}`);
    if (d.type) {
      const dot = el('span', 'type-dot');
      dot.style.background = JV.TYPE_COLOUR[d.type] || '#9fb2c8';
      b.appendChild(dot);
    }
    const t = el('div');
    t.appendChild(el('b', null, d.name === d.title || !d.title ? d.name : d.title));
    t.appendChild(el('small', null, d.description || d.path));
    b.appendChild(t);
    b.appendChild(el('span', 'doc-age', JV.ago(d.modified)));
    b.onclick = onClick;
    return b;
  }

  // ------------------------------------------------------------- AI Core
  /** Workspace files relative to it; files in the user's profile as ~\...; others as the last three parts. */
  function shortPath(p) {
    const cwd = state.info?.cwd || '';
    if (cwd && p.toLowerCase().startsWith(cwd.toLowerCase() + '\\')) return p.slice(cwd.length + 1);
    const home = /^[A-Za-z]:\\Users\\[^\\]+\\/.exec(p);
    if (home) return `~\\${p.slice(home[0].length)}`;
    return p.split(/[\\/]/).slice(-3).join('\\');
  }
  const PALETTE = ['#39c6ff', '#7c8cff', '#b77dff', '#ffb347', '#3ddc97', '#ff7aa8', '#5eead4', '#f5d76e', '#8fa3ff', '#ff9f6b'];
  function renderCore() {
    const a = state.account || {};
    kv($('coreSession'), [
      ['Status', { ready: 'Online', working: 'Working', waiting: 'Awaiting you', starting: 'Connecting', closed: 'Offline', offline: 'Offline' }[state.status] || state.status],
      ['Model', state.context?.model || state.model],
      ['Effort', state.effort ? JV.EFFORT_LABEL[state.effort] : 'Model default'],
      ['Thinking', state.thinking == null ? 'Model default' : state.thinking ? 'On (this session)' : 'Off (this session)'],
      ['Permission mode', `${JV.MODE_LABEL[state.mode] || state.mode} - ${JV.MODE_INFO[state.mode] || ''}`],
      ['Claude Code', state.version ? `v${state.version}` : null],
      ['Session', state.sessionId || 'Assigned with your first message'],
      ['Started', state.sessionStart ? `${JV.time(state.sessionStart)} (${JV.dur(Date.now() - state.sessionStart)} ago)` : null],
      ['Account', a.email],
      ['Plan', JV.planName(a)],
      ['Workspace', state.info?.cwd],
    ]);
    const c = state.context;
    JV.gauge($('gCtx'), 'Context', c ? Math.round(c.percentage) : null, c ? `${JV.num(c.totalTokens)} / ${JV.num(c.maxTokens)} tokens` : 'Loads after the first reply');
    const legend = $('ctxLegend');
    const bar = $('ctxBar');
    legend.replaceChildren();
    bar.replaceChildren();
    if (c) {
      const used = c.categories.filter((x) => x.kind === 'used' && x.tokens > 0).sort((x, y) => y.tokens - x.tokens);
      used.forEach((x, i) => { x._c = PALETTE[i % PALETTE.length]; });
      for (const x of used) {
        const row = el('div', 'lg');
        const sw = el('span', 'sw');
        sw.style.background = x._c;
        row.appendChild(sw);
        row.appendChild(el('span', null, x.name));
        row.appendChild(el('b', null, JV.num(x.tokens)));
        legend.appendChild(row);
      }
      const total = c.maxTokens || 1;
      for (const x of c.categories.filter((y) => y.tokens > 0)) {
        const seg = el('i', `k-${x.kind}`);
        seg.style.width = `${(100 * x.tokens) / total}%`;
        if (x._c) seg.style.background = x._c;
        seg.title = `${x.name}: ${JV.num(x.tokens)} tokens`;
        bar.appendChild(seg);
      }
      $('ctxPrecise').textContent = c.detail === 'full' ? 'Precise count ✓ · recount ›' : 'Precise count ›';
    }
    kv($('coreStats'), [
      ['Turns', state.turns.length],
      ['Tool calls', state.toolCalls],
      ['Tool failures', state.toolErrors],
      ['Specialists dispatched', state.agentRuns],
      ['Tasks', state.tasks.length ? `${state.tasks.filter((t) => t.status === 'completed').length} of ${state.tasks.length} done` : 'None yet'],
      ['Tools available', state.tools.length || 'Listed after the first reply'],
      ['Commands & skills', state.commands.length || null],
      ['Connected systems', state.mcp.length ? `${state.mcp.filter((m) => m.status === 'connected').length} of ${state.mcp.length}` : null],
    ]);
    const ul = $('ctxMemory');
    ul.replaceChildren();
    for (const f of c?.memoryFiles || []) {
      const li = el('li', 'row');
      li.appendChild(el('span', null, shortPath(f.path)));
      li.appendChild(el('small', null, f.type));
      li.appendChild(el('b', null, JV.num(f.tokens)));
      li.title = f.path;
      ul.appendChild(li);
    }
    if (!ul.children.length) ul.appendChild(el('li', 'muted empty', c ? 'None reported.' : 'Loads after the session connects.'));
  }
  $('ctxPrecise').onclick = () => { $('ctxPrecise').textContent = 'Counting…'; window.jarvis.context('full'); };

  // ------------------------------------------------------------- Agents
  let agentDocs = null;
  async function agentDoc(a) {
    const drawer = $('agentDoc');
    drawer.hidden = false;
    if (!agentDocs) agentDocs = await window.jarvis.docs('agents');
    const d = agentDocs.find((x) => x.name === a.name);
    const info = JV.agentInfo(a);
    drawer.replaceChildren();
    const head = el('div', 'drawer-head');
    head.appendChild(el('b', null, info.code));
    head.appendChild(el('small', null, a.name));
    const task = el('button', 'btn btn-primary small', `Hand a task to ${info.code}`);
    task.onclick = () => JV.chat.insert(`Use the ${a.name} agent to `);
    head.appendChild(task);
    const close = el('button', 'icon-btn');
    close.appendChild(JV.icon('x'));
    close.onclick = () => { drawer.hidden = true; };
    head.appendChild(close);
    drawer.appendChild(head);
    const body = el('div', 'reader');
    drawer.appendChild(body);
    if (d) openDoc(body, 'agents', d.path, `${info.code} brief`);
    else { const p = el('div', 'content'); JV.renderMarkdown(p, a.description || 'A built-in Claude Code agent.'); body.appendChild(p); }
    drawer.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  // The roster: compact cards (name, one-line role, status) grouped by what each specialist
  // covers. The full brief is a hover (tooltip) or a click (the drawer) away, not on every card.
  // A group is one icon, or several: git, ClickUp and notes each keep their page's icon.
  const ROSTER = [['phone', 'Mobile apps'], ['globe', 'Web apps'], ['server', 'APIs'], ['github clickup edit', 'Git, tasks & notes']];
  let builtinOpen = false; // the roster redraws while agents work; a fold you opened stays open
  function renderAgents() {
    const box = $('agentAll');
    box.replaceChildren();
    const custom = JV.customAgents().slice().sort((a, b) => a.name.localeCompare(b.name));
    // No specialists is no reason to hide the built-in agents: they are there either way.
    if (!custom.length) box.appendChild(el('div', 'muted empty', JV.noSpecialistsText()));
    const groups = new Map([...ROSTER.map(([, label]) => [label, []]), ['Support crew', []]]);
    for (const a of custom) {
      const g = ROSTER.find(([icons]) => icons.split(' ').includes(JV.agentInfo(a).icon));
      groups.get(g ? g[1] : 'Support crew').push(a);
    }
    for (const [label, list] of groups) {
      if (!list.length) continue;
      const head = el('div', 'roster-head', label);
      head.appendChild(el('em', null, String(list.length)));
      const grid = el('div', 'agent-grid roster');
      for (const a of list) grid.appendChild(JV.agentCard(a, { onClick: agentDoc }));
      box.append(head, grid);
    }
    const bi = JV.builtinAgents();
    if (bi.length) {
      const more = el('details', 'roster-more');
      const sum = el('summary');
      sum.append(JV.icon('chevron'), el('span', null, `Built-in Claude agents (${bi.length})`));
      const grid = el('div', 'agent-grid roster');
      for (const a of bi) grid.appendChild(JV.agentCard(a, { onClick: agentDoc }));
      more.append(sum, grid);
      more.open = builtinOpen;
      more.addEventListener('toggle', () => { builtinOpen = more.open; });
      box.appendChild(more);
    }
  }

  // ------------------------------------------------------------- Tasks
  function renderTasks() {
    const k = $('kanban');
    k.replaceChildren();
    const cols = [['in_progress', 'In progress'], ['pending', 'Pending'], ['completed', 'Done']];
    for (const [st, label] of cols) {
      const col = el('div', `hud-panel kcol s-${st}`);
      const items = state.tasks.filter((t) => t.status === st);
      col.appendChild(el('h3', null, `${label} · ${items.length}`));
      const ul = el('ul', 'rows');
      for (const t of items) {
        const li = el('li', 'kcard');
        li.appendChild(el('b', null, t.subject));
        if (st === 'in_progress' && t.activeForm) li.appendChild(el('small', null, t.activeForm));
        ul.appendChild(li);
      }
      if (!items.length) ul.appendChild(el('li', 'muted empty', st === 'in_progress' ? 'JARVIS lists its steps here while it works.' : '–'));
      col.appendChild(ul);
      k.appendChild(col);
    }
    JV.timelineRows($('turnList'), { limit: 200, tasks: false });
    const f = state.workspace?.focus;
    $('focusAsOf').textContent = f?.asOf ? `handoff, as of ${f.asOf}` : '';
    const ul = $('focusList');
    ul.replaceChildren();
    for (const i of f?.items || []) {
      const li = el('li', 'row focus');
      li.appendChild(el('span', 'fnum', i.n));
      const d = el('div');
      d.appendChild(el('b', null, i.title));
      if (i.rest) d.appendChild(el('small', null, JV.clip(i.rest, 160)));
      li.appendChild(d);
      ul.appendChild(li);
    }
    if (!ul.children.length) ul.appendChild(el('li', 'muted empty', f ? 'No focus items found in the handoff.' : 'Loading…'));
  }

  // ------------------------------------------------------------- Memory
  let memSel = null;
  JV.loadMemory = async () => {
    state.memory = await window.jarvis.docs('memory');
    JV.emit('memory', state.memory);
  };
  JV.openMemory = (rel) => {
    memSel = rel;
    const d = state.memory.find((x) => x.path === rel);
    openDoc($('memReader'), 'memory', rel, d?.name);
    renderMemory();
  };
  function renderMemory() {
    JV.constellation($('memMap'), state.memory, { labels: true, selected: memSel, onPick: (d) => JV.openMemory(d.path) });
    const list = $('memList');
    list.replaceChildren();
    const groups = {};
    for (const d of state.memory) (groups[d.type || 'index'] = groups[d.type || 'index'] || []).push(d);
    const order = ['user', 'feedback', 'project', 'reference', 'index'];
    for (const g of Object.keys(groups).sort((a, b) => order.indexOf(a) - order.indexOf(b))) {
      list.appendChild(el('div', 'grp', g.toUpperCase()));
      for (const d of groups[g]) list.appendChild(docRow(d, () => JV.openMemory(d.path), d.path === memSel));
    }
    if (!state.memory.length) list.appendChild(el('div', 'muted empty', 'No memory files found.'));
  }

  // ------------------------------------------------------------- Knowledge
  const KTABS = [['knowledge', 'Knowledge'], ['rules', 'Rules'], ['agents', 'Agents'], ['skills', 'Skills'], ['commands', 'Commands']];
  let kTab = 'knowledge';
  let kSel = null;
  const kCache = {};
  JV.docCounts = {};
  JV.loadDocCounts = async () => {
    kCache.knowledge = await window.jarvis.docs('knowledge');
    JV.docCounts.knowledge = kCache.knowledge.length;
    JV.emit('memory', state.memory);
  };
  async function renderKnowledge(force) {
    const tabs = $('kTabs');
    tabs.replaceChildren();
    for (const [key, label] of KTABS) {
      const b = el('button', key === kTab ? 'on' : '', label);
      b.onclick = () => { kTab = key; renderKnowledge(); };
      tabs.appendChild(b);
    }
    renderKStatus();
    const list = $('kList');
    if (force || !kCache[kTab]) { list.replaceChildren(el('div', 'muted empty', 'Loading…')); kCache[kTab] = await window.jarvis.docs(kTab); }
    list.replaceChildren();
    for (const d of kCache[kTab]) {
      list.appendChild(docRow(d, () => { kSel = `${kTab}:${d.path}`; openDoc($('kReader'), kTab, d.path, d.title); renderKnowledge(); }, kSel === `${kTab}:${d.path}`));
    }
    if (!kCache[kTab].length) list.appendChild(el('div', 'muted empty', 'No documents here.'));
  }
  function knowledgeBlock(host, compact) {
    host.replaceChildren();
    const k = state.workspace?.knowledge;
    if (!k) { host.appendChild(el('div', 'muted', 'Checking…')); return; }
    // A workspace with no .claude knowledge folder reports no state at all. That used to
    // draw an empty box: a warning icon, a button, and nothing said.
    const st = k.state || 'unknown';
    const box = el('div', `kbox s-${st}`);
    const word = { current: 'Knowledge is current', stale: 'Knowledge is stale', 'no-baseline': 'No knowledge baseline', unknown: 'Status unknown' }[st] || st;
    const top = el('div', 'kbox-top');
    top.appendChild(JV.icon(st === 'current' ? 'check' : 'alert'));
    top.appendChild(el('b', null, word));
    if (k.lastScan) top.appendChild(el('small', null, `baseline ${k.lastScan.replace('T', ' ').replace('Z', ' UTC')}`));
    box.appendChild(top);
    if (k.stale?.length) {
      const ul = el('ul', 'rows');
      for (const s of k.stale) {
        const li = el('li', 'row');
        li.appendChild(el('b', null, s.file));
        li.appendChild(el('small', null, `← ${s.sources.join(', ')}`));
        ul.appendChild(li);
      }
      box.appendChild(ul);
    }
    if (k.unmapped) box.appendChild(el('small', 'kbox-note', `${k.unmapped} changed file${k.unmapped > 1 ? 's' : ''} in areas no knowledge file covers yet.`));
    if (k.error) box.appendChild(el('small', 'kbox-note', k.error));
    if (st !== 'current') {
      const b = el('button', 'btn btn-primary small', 'Run /relearn');
      b.onclick = () => JV.chat.submit('/relearn');
      box.appendChild(b);
    }
    host.appendChild(box);
  }
  function renderKStatus() { knowledgeBlock($('kStatus'), true); }

  // ------------------------------------------------------------- Tools & Skills
  function renderTools() {
    const f = $('cmdFilter').value.trim().toLowerCase();
    const cmds = (state.commands || []).filter((c) => !f || c.name.toLowerCase().includes(f) || c.description.toLowerCase().includes(f))
      .sort((a, b) => (a.builtin - b.builtin) || a.name.localeCompare(b.name));
    $('cmdCount').textContent = state.commands.length ? `${state.commands.length}` : '';
    const ul = $('cmdList');
    ul.replaceChildren();
    for (const c of cmds) {
      const li = el('li', 'row clickable');
      const t = el('div');
      const top = el('div', 'cmd-top');
      top.appendChild(el('b', null, `/${c.name}`));
      if (c.argumentHint) top.appendChild(el('code', null, c.argumentHint));
      top.appendChild(el('span', `cmd-src ${c.builtin ? '' : 'custom'}`, c.builtin ? 'built-in' : 'workspace'));
      t.appendChild(top);
      if (c.description) t.appendChild(el('small', null, JV.clip(c.description, 180)));
      li.appendChild(t);
      li.onclick = () => JV.chat.insert(`/${c.name} `);
      ul.appendChild(li);
    }
    if (!ul.children.length) ul.appendChild(el('li', 'muted empty', state.commands.length ? 'No match.' : 'Loads once the session is connected.'));

    const m = $('mcpList');
    m.replaceChildren();
    for (const s of state.mcp) {
      const d = el('details', `mcp-row st-${s.status}`);
      const sum = el('summary');
      sum.appendChild(el('span', 'dot'));
      sum.appendChild(el('b', null, s.name));
      sum.appendChild(el('small', null, `${s.status}${s.tools?.length ? ` · ${s.tools.length} tools` : ''}${s.version ? ` · v${s.version}` : ''}`));
      d.appendChild(sum);
      if (s.error) d.appendChild(el('div', 'mcp-err', s.error));
      const tl = el('div', 'tagcloud');
      for (const t of s.tools || []) {
        const tag = el('span', `tag${t.destructive ? ' warn' : t.readOnly ? ' ro' : ''}`, t.name);
        tag.title = `${t.description}${t.readOnly ? '\n(read-only)' : ''}${t.destructive ? '\n(can change or delete data)' : ''}`;
        tl.appendChild(tag);
      }
      d.appendChild(tl);
      m.appendChild(d);
    }
    if (!state.mcp.length) m.appendChild(el('div', 'muted empty', 'Checking…'));

    const builtins = state.tools.filter((t) => !t.startsWith('mcp__')).sort();
    $('toolCount').textContent = builtins.length ? String(builtins.length) : '';
    const tc = $('toolList');
    tc.replaceChildren();
    for (const t of builtins) tc.appendChild(el('span', 'tag', t));
    if (!builtins.length) tc.appendChild(el('div', 'muted empty', 'Listed after the first reply of the session.'));
  }
  $('cmdFilter').addEventListener('input', renderTools);

  // ------------------------------------------------------------- Workspace
  function renderWorkspace() {
    const ws = state.workspace;
    const g = $('repoGrid');
    g.replaceChildren();
    if (!ws) { g.appendChild(el('div', 'muted empty', 'Reading the repos…')); return; }
    for (const r of ws.repos) {
      const dirty = r.modified + r.staged + r.untracked;
      const card = el('div', `hud-panel repo${dirty ? ' dirty' : ''}${r.ok ? '' : ' err'}`);
      const head = el('div', 'repo-head');
      head.appendChild(JV.icon(/App$/.test(r.nickname) ? 'phone' : /Web$/.test(r.nickname) ? 'globe' : 'server'));
      const t = el('div');
      t.appendChild(el('b', null, r.nickname));
      t.appendChild(el('small', null, r.name));
      head.appendChild(t);
      const code = el('button', 'icon-btn repo-code');
      code.title = `Open ${r.name} in VS Code`;
      code.appendChild(JV.icon('code'));
      code.onclick = (e) => { e.stopPropagation(); window.jarvis.openInCode(r.name); };
      head.appendChild(code);
      card.appendChild(head);
      if (!r.ok) { card.appendChild(el('div', 'mcp-err', r.error || 'git failed')); g.appendChild(card); continue; }
      const br = el('div', 'repo-branch');
      br.appendChild(JV.icon('repo'));
      br.appendChild(el('span', null, r.branch || '?'));
      if (r.ahead) br.appendChild(el('em', 'ahead', `↑${r.ahead}`));
      if (r.behind) br.appendChild(el('em', 'behind', `↓${r.behind}`));
      card.appendChild(br);
      const counts = el('div', 'repo-counts');
      const c = (n, label, cls) => { const s = el('span', n ? cls : 'zero'); s.appendChild(el('b', null, String(n))); s.appendChild(el('small', null, label)); counts.appendChild(s); };
      c(r.modified, 'modified', 'm');
      c(r.staged, 'staged', 's');
      c(r.untracked, 'untracked', 'u');
      card.appendChild(counts);
      if (r.lastCommit) {
        const lc = el('div', 'repo-commit');
        lc.appendChild(el('small', null, r.lastCommit.ago));
        lc.appendChild(el('span', null, r.lastCommit.subject));
        lc.title = r.lastCommit.subject;
        card.appendChild(lc);
      }
      g.appendChild(card);
    }
    const iss = ws.issues;
    $('issueCount').textContent = iss?.available ? `${iss.open} open of ${iss.list.length}` : '';
    const ul = $('issueList');
    ul.replaceChildren();
    for (const i of (iss?.list || []).slice().sort((a, b) => (b.open - a.open))) {
      const li = el('li', `row issue${i.open ? '' : ' closed'}`);
      li.appendChild(el('span', `sev sev-${i.severity || 'na'}`, (i.severity || '–').toUpperCase()));
      const d = el('div');
      d.appendChild(el('b', null, `${i.id} · ${i.title}`));
      d.appendChild(el('small', null, JV.clip(i.status, 120)));
      li.appendChild(d);
      ul.appendChild(li);
    }
    if (!ul.children.length) ul.appendChild(el('li', 'muted empty', 'No open-issues file found.'));
    knowledgeBlock($('wsKnowledge'));
  }
  $('wsRefresh').onclick = (e) => JV.spinWhile(e.currentTarget, () => JV.refreshWorkspace(true));

  // ------------------------------------------------------------- routing + subscriptions
  const RENDER = { core: renderCore, agents: renderAgents, tasks: renderTasks, memory: renderMemory, knowledge: () => renderKnowledge(), tools: renderTools, workspace: renderWorkspace };
  const rerender = (...views) => () => { if (views.includes(state.view)) RENDER[state.view](); };
  JV.on('view', (v) => {
    if (v === 'memory') JV.loadMemory();
    if (v === 'knowledge') { for (const k of Object.keys(kCache)) delete kCache[k]; }
    RENDER[v]?.();
  });
  JV.on('memory', rerender('memory'));
  JV.on('context', rerender('core'));
  JV.on('status', rerender('core'));
  JV.on('init', rerender('core', 'tools'));
  JV.on('account', rerender('core'));
  JV.on('effort', rerender('core'));
  JV.on('thinking', rerender('core'));
  JV.on('mode', rerender('core'));
  JV.on('turns', rerender('core', 'tasks'));
  JV.on('tasks', rerender('core', 'tasks'));
  JV.on('agents', rerender('agents'));
  JV.on('agents_changed', rerender('agents', 'core'));
  JV.on('commands', rerender('tools', 'core'));
  JV.on('mcp', rerender('tools', 'core'));
  JV.on('workspace', rerender('workspace', 'tasks', 'knowledge'));
})();
