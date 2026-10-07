/* JARVIS window - Projects: the workspace's projects, found by looking (project-discovery.mjs),
   and one place to see and act on each.

   This page orchestrates; it does not reimplement. Git is Source Control, Run on a phone is
   Devices, a site is the Web apps panel, Analyse is the Dart analysis panel, a question is
   the chat. What it adds is the overview: what each project is, what it needs from this PC
   and whether that is here, its Git state, what is running, and the Build / Test / script
   actions its own files allow - started by id, worked out by the main process.

   A Flutter app's android/ and ios/ host projects are shown as its platforms, not as apps of
   their own; packages, modules and test projects sit under the project they belong to. */
(() => {
  'use strict';
  const { $, el, state } = JV;
  const node = (...a) => JV.node(...a);
  const api = window.jarvis;

  const PICK = 'jarvis.project';
  const TYPE = { flutter: 'Flutter', dart: 'Dart', dotnet: '.NET', node: 'Node', python: 'Python', gradle: 'Gradle', maven: 'Maven', git: 'Git' };
  const ROLE = { package: 'package', module: 'module', test: 'tests' };
  const PLATFORM = { android: 'Android', ios: 'iOS', macos: 'macOS', windows: 'Windows', linux: 'Linux', web: 'Web' };
  const ICON = (types) => (types.includes('flutter') ? 'phone'
    : types.includes('dotnet') ? 'server'
      : types.includes('node') ? 'globe'
        : types.includes('python') || types.includes('gradle') || types.includes('maven') ? 'code'
          : types.includes('dart') ? 'code' : 'repo');

  let scan = null;                 // { ok, projects, workspace, ms, truncated, errors }
  let selected = null;
  let detail = null;               // projectDetail() for the selected one
  let detailSeq = 0;
  const tasks = new Map();         // task id -> { state, label, command, ... }
  const logs = new Map();          // task id -> [lines]
  let filter = '';
  let loading = null;

  try { selected = localStorage.getItem(PICK); } catch { /* storage off */ }
  const byId = (id) => scan?.projects.find((p) => p.id === id) || null;
  const repoState = (key) => (state.workspace?.repos || []).find((r) => r.key === key) || null;
  const where = (p) => (p.relativePath === '.' ? 'the workspace folder' : p.relativePath);

  // ------------------------------------------------------------- loading
  async function load(refresh = false) {
    if (loading && !refresh) return loading;
    loading = (async () => {
      try { scan = await api.projects(refresh); } catch (e) { scan = { ok: false, error: String(e?.message || e), projects: [] }; }
      try { for (const t of await api.projectTasks()) tasks.set(t.id, t); } catch { /* none */ }
      if (!selected) { try { selected = localStorage.getItem(PICK); } catch { /* storage off */ } }
      if (selected && !byId(selected)) selected = null;
      if (!selected) selected = tops()[0]?.id || null;
      render();
      if (selected) openDetail(selected);
      if (refresh) JV.emit('projects_changed', scan);
    })();
    try { await loading; } finally { loading = null; }
  }
  JV.rescanProjects = () => load(true);

  /** Projects shown at the top level: those with no parent. */
  function tops() {
    return (scan?.projects || []).filter((p) => p.parentId === null)
      .sort((a, b) => (a.relativePath === '.' ? -1 : b.relativePath === '.' ? 1 : (a.displayName || a.name).localeCompare(b.displayName || b.name)));
  }
  const childrenOf = (p) => (scan?.projects || []).filter((c) => c.parentId === p.id);
  const platformsOf = (p) => childrenOf(p).filter((c) => c.role === 'platform').map((c) => PLATFORM[c.relativePath.split('/').pop().toLowerCase()] || c.name);

  // ------------------------------------------------------------- the list
  function chip(text, cls = '') { return el('span', `pj-chip${cls ? ` ${cls}` : ''}`, text); }

  function row(p, depth) {
    const li = el('li', `pj-row${p.id === selected ? ' on' : ''}${depth ? ' nested' : ''}`);
    li.style.setProperty('--depth', String(depth));
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.dataset.project = p.id;
    li.appendChild(JV.icon(ICON(p.types)));
    const main = el('div', 'pj-row-main');
    const title = el('b', null, p.displayName || p.name);
    main.appendChild(title);
    const sub = el('small');
    const kinds = p.types.filter((t) => t !== 'git').map((t) => TYPE[t] || t);
    if (depth && ROLE[p.role]) kinds.unshift(ROLE[p.role]);
    sub.textContent = kinds.join(' · ') || (p.types.includes('git') ? 'Repository' : '');
    main.appendChild(sub);
    li.appendChild(main);
    const marks = el('span', 'pj-marks');
    const r = repoState(p.relativePath);
    const dirty = r ? r.modified + r.staged + r.untracked : 0;
    if (dirty) { const m = chip(String(dirty), 'dirty'); m.title = `${dirty} uncommitted change${dirty === 1 ? '' : 's'}`; marks.appendChild(m); }
    if ([...tasks.values()].some((t) => t.projectKey === p.id && t.state === 'running')) { const m = chip('running', 'live'); marks.appendChild(m); }
    if (p.warning) { const m = el('span', 'pj-warn'); m.appendChild(JV.icon('alert')); m.title = p.warning; marks.appendChild(m); }
    li.appendChild(marks);
    li.onclick = () => select(p.id);
    li.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(p.id); } };
    return li;
  }

  function renderList() {
    const ul = $('pjList');
    ul.replaceChildren();
    const q = filter.trim().toLowerCase();
    const match = (p) => !q || `${p.displayName} ${p.name} ${p.relativePath} ${p.types.join(' ')}`.toLowerCase().includes(q);
    const add = (p, depth) => {
      const kids = childrenOf(p).filter((c) => c.role !== 'platform');
      const any = (x) => match(x) || childrenOf(x).some(any);
      if (!any(p)) return;
      ul.appendChild(row(p, depth));
      for (const c of kids.sort((a, b) => a.relativePath.localeCompare(b.relativePath))) add(c, depth + 1);
    };
    for (const p of tops()) add(p, 0);
    if (!ul.children.length && scan?.projects?.length) ul.appendChild(el('li', 'muted empty', 'Nothing matches that filter.'));
  }

  function renderHead() {
    const ws = scan?.workspace;
    $('pjWsName').textContent = ws ? `${ws.name} - ${ws.path}` : '';
    const n = scan?.projects?.length || 0;
    const notes = [];
    if (scan?.ok) notes.push(`${n} project${n === 1 ? '' : 's'}, found by looking - nothing was changed`);
    if (scan?.truncated) notes.push('the folder is very large, so the search stopped early');
    if (scan?.errors?.length) notes.push(`${scan.errors.length} folder${scan.errors.length === 1 ? '' : 's'} could not be read`);
    $('pjNote').textContent = notes.length ? `· ${notes.join(' · ')}` : '';
  }

  function render() {
    renderHead();
    const d = $('pjDetail');
    if (!state.info?.workspace) {
      $('pjList').replaceChildren();
      d.replaceChildren(empty('layers', 'No workspace yet', 'Choose the folder that holds your projects. JARVIS looks through it - Flutter, .NET, Node, Python, Java, Git - and lists what it finds here.', { label: 'Choose a workspace folder…', run: () => JV.addWorkspace({ switchNow: true }) }));
      return;
    }
    if (!scan) { d.replaceChildren(empty('refresh', 'Looking through the workspace…', '')); return; }
    if (!scan.ok) { $('pjList').replaceChildren(); d.replaceChildren(empty('alert', 'The workspace could not be read', scan.error || '', { label: 'Try again', run: () => load(true) })); return; }
    renderList();
    if (!scan.projects.length) {
      d.replaceChildren(empty('search', 'No projects found here', 'JARVIS looks for a .git folder, pubspec.yaml, *.csproj or *.sln, package.json, pyproject.toml / requirements.txt / setup.py, Gradle and Maven files - up to six folders deep, skipping dependencies and build output. You can still chat with JARVIS about this folder.', { label: 'Look again', run: () => load(true) }));
      return;
    }
    if (!selected) d.replaceChildren(empty('layers', 'Pick a project', 'Choose one on the left to see what it needs, its Git state and what you can do with it.'));
  }

  function empty(icon, title, sub, action) {
    const box = el('div', 'pj-empty');
    box.appendChild(JV.icon(icon));
    box.appendChild(el('b', null, title));
    if (sub) box.appendChild(el('p', null, sub));
    if (action) {
      const b = el('button', 'btn small', action.label);
      b.type = 'button';
      b.onclick = action.run;
      box.appendChild(b);
    }
    return box;
  }

  // ------------------------------------------------------------- one project
  function select(id) {
    selected = id;
    try { localStorage.setItem(PICK, id); } catch { /* storage off */ }
    renderList();
    openDetail(id);
  }

  async function openDetail(id) {
    const seq = ++detailSeq;
    const d = $('pjDetail');
    if (!detail || detail.project?.id !== id) d.replaceChildren(empty('refresh', 'Loading…', ''));
    let r;
    try { r = await api.projectDetail(id); } catch (e) { r = { ok: false, error: String(e?.message || e) }; }
    if (seq !== detailSeq) return; // another project was picked meanwhile
    if (!r?.ok) { d.replaceChildren(empty('alert', 'That project could not be read', r?.error || '', { label: 'Look again', run: () => load(true) })); return; }
    detail = r;
    renderDetail();
  }

  const taskIdOf = (actionId) => `${detail.project.id}::${actionId}`;

  function renderDetail() {
    const d = $('pjDetail');
    const p = detail.project;
    const found = byId(p.id) || p;
    d.replaceChildren();

    // --- who and what
    const head = el('div', 'pj-head');
    head.appendChild(JV.icon(ICON(p.types)));
    const id = el('div', 'pj-id');
    id.appendChild(el('h3', null, p.displayName || p.name));
    const sub = el('div', 'pj-sub');
    sub.appendChild(el('code', null, p.relativePath === '.' ? '(the workspace folder)' : p.relativePath));
    for (const t of p.types) sub.appendChild(chip(TYPE[t] || t, `t-${t}`));
    for (const pl of platformsOf(found)) sub.appendChild(chip(pl, 'platform'));
    if (p.parentId && ROLE[p.role]) sub.appendChild(chip(`${ROLE[p.role]} of ${byId(p.parentId)?.displayName || p.parentId}`, 'role'));
    id.appendChild(sub);
    head.appendChild(id);
    const set = el('button', 'btn btn-ghost small', 'Settings');
    set.type = 'button';
    set.title = 'Your own name for this project, a warning to show before it runs, and its case-code prefix';
    set.onclick = editSettings;
    head.appendChild(set);
    d.appendChild(head);
    if (p.warning) {
      const w = el('div', 'pj-warning');
      w.appendChild(JV.icon('alert'));
      w.appendChild(el('span', null, p.warning));
      w.title = 'Your warning for this project - shown before it runs.';
      d.appendChild(w);
    }

    // --- status: git, runtime, diagnostics
    const grid = el('div', 'pj-status');
    const cell = (label, value, cls = '') => { const c = el('div', `pj-cell ${cls}`); c.appendChild(el('small', null, label)); c.appendChild(typeof value === 'string' ? el('b', null, value) : value); grid.appendChild(c); };
    if (detail.repoKey) {
      const r = repoState(detail.repoKey);
      if (r?.ok) {
        const v = el('b', null, r.branch || '?');
        if (r.ahead) v.appendChild(el('em', 'ahead', ` ↑${r.ahead}`));
        if (r.behind) v.appendChild(el('em', 'behind', ` ↓${r.behind}`));
        cell('Git branch', v);
        const n = r.modified + r.staged + r.untracked;
        cell('Changes', n ? `${n} uncommitted` : 'Clean', n ? 'warn' : 'ok');
      } else cell('Git', detail.restricted ? 'Not read (restricted)' : r ? (r.error || 'Could not read') : 'Reading…');
    } else if (p.types.includes('git')) cell('Git', detail.restricted ? 'Not read (restricted)' : 'Repository');
    const running = [...tasks.values()].filter((t) => t.projectKey === p.id && t.state === 'running');
    cell('Running', running.length ? running.map((t) => t.label.split(' - ')[0]).join(', ') : 'Nothing', running.length ? 'live' : '');
    if (p.types.includes('dart')) {
      const a = JV.analysisFor?.(p.id);
      const res = a?.result;
      cell('Dart analysis', a?.busy ? 'Analysing…' : res?.ok ? `${res.counts.error} errors, ${res.counts.warning} warnings` : 'Not checked yet', res?.ok ? (res.counts.error ? 'bad' : 'ok') : '');
    }
    d.appendChild(grid);

    // --- what it needs from this PC
    if (detail.needs.length) {
      const box = el('div', 'pj-needs');
      box.appendChild(el('h4', null, 'Needs on this PC'));
      for (const n of detail.needs) {
        const li = el('div', `pj-need ${n.met ? 'ok' : 'missing'}`);
        li.appendChild(JV.icon(n.met ? 'check' : 'alert'));
        const t = el('span');
        t.textContent = n.met ? `${n.by.label}${n.by.version ? ` ${n.by.version}` : ''}` : `${n.label} - not installed. ${n.hint || ''}`;
        li.appendChild(t);
        box.appendChild(li);
      }
      d.appendChild(box);
    }

    // --- actions
    const acts = el('div', 'pj-actions');
    const btn = (label, icon, onClick, { primary = false, title = '', disabled = false } = {}) => {
      const b = el('button', `btn small${primary ? ' btn-primary' : ''}`);
      b.type = 'button';
      if (icon) b.appendChild(JV.icon(icon));
      b.appendChild(el('span', null, label));
      b.title = title;
      b.disabled = disabled;
      b.onclick = onClick;
      acts.appendChild(b);
      return b;
    };
    btn('Ask JARVIS', 'chat', () => JV.chat.insert(`In ${where(p)}: `), { primary: true, title: 'Start a message about this project in the chat' });
    btn('Open in VS Code', 'code', async () => {
      const r = await api.openInCode(p.relativePath === '.' ? '.' : p.relativePath);
      if (r && r.ok === false) JV.notify(r.error || 'Could not open it.', { level: 'err' });
    });
    for (const a of detail.actions) {
      if (a.kind === 'jump') {
        const icon = a.to === 'source' ? 'github' : a.to === 'devices' ? 'phone' : a.to === 'webapps' ? 'globe' : 'bug';
        btn(a.label, icon, () => jump(a), {
          title: !a.available ? a.reason || '' : a.needs ? `Needs ${a.needs}, which is not installed on this PC.` : '',
          disabled: !a.available,
        });
        continue;
      }
      const tid = taskIdOf(a.id);
      const t = tasks.get(tid);
      const live = t?.state === 'running';
      const b = btn(live ? `Stop ${a.label}` : a.label, live ? 'stop' : a.id === 'test' ? 'verify' : a.id === 'build' ? 'layers' : 'play', () => (live ? stopTask(tid) : runAction(a)), {
        title: a.available ? `${a.command}${a.script ? `  →  ${a.script}` : ''}` : a.reason,
        disabled: !a.available,
      });
      if (live) b.classList.add('btn-danger');
    }
    d.appendChild(acts);
    if (detail.restricted) {
      // One notice, not the same reason under every button: a restricted workspace is read,
      // and nothing from it runs - builds, tests, apps and Git alike - until it is trusted.
      const r = el('div', 'pj-warning');
      r.appendChild(JV.icon('alert'));
      r.appendChild(el('span', null, 'Restricted workspace: JARVIS reads it, but runs nothing from it - no builds, tests, apps or Git - until you trust it.'));
      const t = el('button', 'btn btn-ghost small', 'Trust this folder');
      t.type = 'button';
      t.onclick = () => JV.trustActiveWorkspace?.();
      r.appendChild(t);
      d.appendChild(r);
    } else {
      const unavailable = detail.actions.filter((a) => !a.available && a.reason);
      if (unavailable.length) d.appendChild(el('p', 'pj-hint', unavailable.map((a) => `${a.label}: ${a.reason}`).join(' ')));
    }

    // --- the last task's output
    const shown = [...tasks.values()].filter((t) => t.projectKey === p.id).sort((x, y) => (y.since || 0) - (x.since || 0))[0];
    if (shown) {
      const box = el('div', 'pj-task');
      const h = el('div', 'pj-task-head');
      h.appendChild(el('b', null, shown.label));
      h.appendChild(chip(shown.state, shown.state === 'passed' ? 'ok' : shown.state === 'failed' ? 'bad' : shown.state === 'running' ? 'live' : ''));
      h.appendChild(el('code', null, shown.command || ''));
      box.appendChild(h);
      const pre = el('pre', 'pj-log');
      for (const l of logs.get(shown.id) || []) pre.appendChild(el('div', `l-${l.level || 'info'}`, l.text));
      box.appendChild(pre);
      d.appendChild(box);
      requestAnimationFrame(() => { pre.scrollTop = pre.scrollHeight; });
      if (!logs.has(shown.id)) api.projectTaskLog(shown.id).then((lines) => { logs.set(shown.id, lines || []); if (detail?.project?.id === p.id) renderDetail(); }).catch(() => {});
    }

    // --- what is inside it
    const kids = childrenOf(found).filter((c) => c.role !== 'platform');
    if (kids.length) {
      const box = el('div', 'pj-inside');
      box.appendChild(el('h4', null, 'Inside this project'));
      for (const c of kids) {
        const b = el('button', 'pj-kid');
        b.type = 'button';
        b.appendChild(el('b', null, c.displayName || c.name));
        b.appendChild(el('small', null, `${ROLE[c.role] || c.role} · ${c.types.filter((t) => t !== 'git').map((t) => TYPE[t] || t).join(', ')}`));
        b.onclick = () => select(c.id);
        box.appendChild(b);
      }
      d.appendChild(box);
    }
  }

  // ------------------------------------------------------------- doing things
  function jump(a) {
    if (a.to === 'source') {
      if (a.repoKey) JV.sc?.open?.(a.repoKey);
      JV.show('source');
      return;
    }
    if (a.to === 'devices') {
      JV.show('devices');
      // Pick this app in "Run on every phone" once the page has its list.
      setTimeout(() => { const s = $('devAllApp'); if (s && [...s.options].some((o) => o.value === a.appKey)) s.value = a.appKey; }, 400);
      return;
    }
    if (a.to === 'webapps') {
      JV.show('devices');
      setTimeout(() => {
        const card = [...document.querySelectorAll('.web-card')].find((c) => c.dataset.app === a.appKey);
        (card || document.querySelector('.dev-section.web'))?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card?.classList.add('flash');
        setTimeout(() => card?.classList.remove('flash'), 1600);
      }, 500);
      return;
    }
    if (a.to === 'analysis') {
      JV.show('devices');
      JV.showAnalysis?.(a.appKey);
      JV.analyseApp?.(a.appKey);
      setTimeout(() => $('devProblems')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 300);
    }
  }

  async function runAction(a) {
    const p = detail.project;
    if (p.warning && !(await JV.confirm(`${p.warning}\n\nRun "${a.label}" for ${p.displayName || p.name} anyway?`, { title: 'Before it runs', yes: `Run ${a.label}` }))) return;
    const r = await api.projectRun(p.id, a.id).catch((e) => ({ ok: false, error: e.message }));
    if (!r?.ok) { JV.notify(r?.error || 'It did not start.', { level: 'err', action: 'workspace' }); return; }
    tasks.set(r.run.id, r.run);
    logs.set(r.run.id, []);
    renderList();
    renderDetail();
  }

  async function stopTask(id) {
    const r = await api.projectStop(id).catch(() => null);
    if (!r?.ok) JV.notify(r?.error || 'It could not be stopped.', { level: 'err' });
  }

  async function editSettings() {
    const p = detail.project;
    const s = detail.settings;
    const name = node('input', { class: 'field', value: s.name, placeholder: p.foundName || p.name, maxlength: '60', 'aria-label': 'Display name' });
    const warn = node('input', { class: 'field', value: s.warning, placeholder: 'For example: Uses the live database', maxlength: '160', 'aria-label': 'Warning before it runs' });
    const prefix = node('input', { class: 'field', value: s.casePrefix, placeholder: 'For example: AB', maxlength: '10', 'aria-label': 'Case-code prefix' });
    const body = [
      JV.field('Name', name, `Only how JARVIS shows it. Empty: "${p.foundName || p.name}", from the project's own files.`),
      JV.field('Warning before it runs', warn, 'Shown on its card and asked before Run, Build or Test - say what running it here touches (a live database, real notifications). Kept in your JARVIS settings, never in the project.'),
    ];
    if (detail.repoKey) body.push(JV.field('Case-code prefix', prefix, 'If your commits carry ticket codes like AB123, the letters - so a suggested commit message keeps them. Empty: none, and none is invented.'));
    const go = await JV.dialog({ title: `${p.displayName || p.name} - settings`, body, wide: true, buttons: [{ label: 'Cancel', value: null }, { label: 'Save', primary: true, value: 'go' }], onOpen: () => name.focus() });
    if (go !== 'go') return;
    const patch = { name: name.value, warning: warn.value };
    if (detail.repoKey) patch.casePrefix = prefix.value;
    const r = await api.projectSettings(p.relativePath, patch).catch((e) => ({ ok: false, error: e.message }));
    if (!r?.ok) { JV.notify(r?.error || 'Those settings could not be saved.', { level: 'err' }); return; }
    // The names and warnings are laid over the found projects as they are read: no rescan.
    await load(false);
    JV.emit('projects_changed', scan);
  }

  // ------------------------------------------------------------- events
  JV.on('task_state', (e) => {
    tasks.set(e.id, { ...(tasks.get(e.id) || {}), ...e });
    if (e.state !== 'running' && state.view !== 'workspace') {
      JV.notify(`${e.label}: ${e.state === 'passed' ? 'finished' : e.state}${e.timedOut ? ' (timed out)' : ''}.`, { level: e.state === 'passed' ? 'ok' : e.state === 'stopped' ? 'info' : 'err', action: 'workspace', desktop: e.state === 'failed' });
    }
    if (state.view === 'workspace') { renderList(); if (detail?.project?.id === e.projectKey) renderDetail(); }
  });
  JV.on('task_log', (e) => {
    const list = logs.get(e.id) || [];
    list.push(...e.lines);
    if (list.length > 600) list.splice(0, list.length - 600);
    logs.set(e.id, list);
    if (state.view === 'workspace' && detail && e.id.startsWith(`${detail.project.id}::`)) {
      const pre = document.querySelector('#pjDetail .pj-log');
      if (pre) { for (const l of e.lines) pre.appendChild(el('div', `l-${l.level || 'info'}`, l.text)); pre.scrollTop = pre.scrollHeight; }
    }
  });
  JV.on('analysis_done', () => { if (state.view === 'workspace' && detail) renderDetail(); });
  JV.on('workspace', () => { if (state.view === 'workspace') { renderList(); if (detail) renderDetail(); } });
  JV.on('view', (v) => { if (v === 'workspace') load(false); });
  $('pjFilter').addEventListener('input', (e) => { filter = e.target.value; renderList(); });
  $('pjFilter').addEventListener('keydown', (e) => { if (e.key === 'Escape' && filter) { e.stopPropagation(); filter = ''; e.target.value = ''; renderList(); } });

  JV.renderProjects = () => { if (state.view === 'workspace') render(); };
})();
