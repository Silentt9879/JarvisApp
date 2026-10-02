/* JARVIS window - boot, the event intake from the main process, the header (clock,
   system status, search, notifications, settings, operator), navigation, the bottom bar
   and Focus Mode. */
(() => {
  'use strict';
  const { $, el, state } = JV;

  // ------------------------------------------------------------- event intake: state first, then views
  const agentIds = new Map(); // Agent tool_use id -> agent name
  function ingest(e) {
    switch (e.kind) {
      case 'status':
        state.status = e.state;
        // Idle means every queued message has been answered: close any turn still open.
        if (e.state === 'ready' && state.turns.some((t) => !t.end)) {
          for (const t of state.turns) if (!t.end) { t.end = Date.now(); if (t.ok == null) t.ok = true; }
          JV.emit('turns');
        }
        break;
      case 'init':
        state.sessionId = e.sessionId;
        if (e.model) state.model = e.model;
        if (e.permissionMode) state.mode = e.permissionMode;
        if (e.version) state.version = e.version;
        if (e.effort) state.effort = e.effort;
        state.tools = e.tools || state.tools;
        state.skills = e.skills || state.skills;
        break;
      case 'account': state.account = e; break;
      case 'commands': state.commands = e.list; break;
      case 'agents': state.agentList = e.list; break;
      case 'models': state.models = e.list; break;
      case 'mcp': state.mcp = e.list; break;
      case 'context': state.context = e; break;
      case 'tasks': state.tasks = e.list; break;
      case 'model': state.modelChoice = e.model || null; break;
      case 'mode': state.mode = e.mode; break;
      case 'effort': state.effort = e.level; state.effortExplicit = true; break;
      case 'thinking': state.thinking = e.on; break;
      case 'tool_use':
        if (!e.parent) state.toolCalls++;
        if (e.agent && !e.parent) {
          agentIds.set(e.id, e.agent);
          state.agentRuns++;
          state.agentActive.set(e.agent, (state.agentActive.get(e.agent) || 0) + 1);
          state.agentUse.set(e.agent, (state.agentUse.get(e.agent) || 0) + 1);
        }
        break;
      case 'tool_result':
        if (!e.parent && e.isError) state.toolErrors++;
        if (agentIds.has(e.id)) {
          const name = agentIds.get(e.id);
          agentIds.delete(e.id);
          const left = (state.agentActive.get(name) || 1) - 1;
          if (left > 0) state.agentActive.set(name, left); else state.agentActive.delete(name);
        }
        break;
      case 'permission':
      case 'question': state.pendingPrompts++; break;
      case 'prompt_done': state.pendingPrompts = Math.max(0, state.pendingPrompts - 1); break;
      case 'result': {
        // Queued messages are answered in order, so a result belongs to the oldest open turn.
        const t = state.turns.find((x) => !x.end);
        if (t) { t.end = Date.now(); t.ok = e.ok; t.durationMs = e.durationMs; }
        break;
      }
      default: break;
    }
  }

  window.jarvis.onEvent((e) => {
    ingest(e);
    JV.emit(e.kind, e);
    react(e);
  });

  /** Feed items, notifications and badges that follow from events. */
  function react(e) {
    switch (e.kind) {
      case 'status':
        document.body.dataset.status = e.state;
        renderSysStatus();
        renderMini();
        if (e.state === 'closed') JV.feed({ key: 'session', level: 'err', title: 'Session offline', sub: 'Send a message to reconnect', action: 'chat' });
        break;
      case 'init':
        JV.feed({ key: 'session', level: 'live', title: `Session online · ${JV.prettyModel(e.model)}`, sub: `Claude Code v${e.version}`, action: 'core' });
        renderNavBadges();
        break;
      case 'account': renderOperator(); break;
      case 'tool_use':
        if (e.agent && !e.parent) {
          const info = JV.agentInfo({ name: e.agent, description: (state.agentList.find((a) => a.name === e.agent) || {}).description || '' });
          JV.feed({ level: 'live', title: `${info.code} dispatched`, sub: e.agentTask || info.role, action: 'agents' });
          JV.emit('agents_changed');
          renderMini();
        }
        break;
      case 'tool_result':
        if (e.isError && !e.parent) JV.feed({ level: 'err', title: 'A tool call failed', sub: JV.clip(e.preview, 80), action: 'chat' });
        if (!agentIds.has(e.id) && !e.parent) { JV.emit('agents_changed'); renderMini(); }
        break;
      case 'permission':
        JV.feed({ key: `p-${e.id}`, level: 'warn', title: `Approval needed: ${e.displayName || JV.prettyToolName(e.toolName)}`, sub: JV.clip(e.detail, 70), action: 'chat' });
        JV.notify(`JARVIS needs your approval to use ${e.displayName || JV.prettyToolName(e.toolName)}.`, { level: 'warn', action: 'chat', desktop: true });
        renderNavBadges();
        break;
      case 'question':
        JV.feed({ key: `p-${e.id}`, level: 'warn', title: 'JARVIS has a question for you', sub: JV.clip(e.questions?.[0]?.question, 70), action: 'chat' });
        JV.notify('JARVIS has a question for you, sir.', { level: 'warn', action: 'chat', desktop: true });
        renderNavBadges();
        break;
      case 'prompt_done': renderNavBadges(); break;
      case 'result': {
        const t = state.turns.slice().reverse().find((x) => x.end && x.durationMs === e.durationMs);
        const secs = e.durationMs ? `${(e.durationMs / 1000).toFixed(1)}s` : '';
        JV.feed({ level: e.ok ? 'ok' : 'err', title: e.ok ? `Reply complete${secs ? ` in ${secs}` : ''}` : `Turn stopped (${e.subtype})`, sub: t ? JV.clip(t.prompt, 60) : '', action: 'chat' });
        if (state.view !== 'chat' || !document.hasFocus()) JV.notify(e.ok ? 'JARVIS has finished, sir.' : `The turn stopped (${e.subtype}).`, { level: e.ok ? 'ok' : 'err', action: 'chat', desktop: true });
        JV.emit('turns');
        JV.emit('agents_changed');
        refreshWorkspaceSoon();
        renderMini();
        break;
      }
      case 'mcp':
        for (const s of e.list.filter((x) => x.status === 'failed' || x.status === 'needs-auth')) {
          JV.feed({ key: `mcp-${s.name}`, level: 'warn', title: `${s.name}: ${s.status === 'failed' ? 'connection failed' : 'needs sign-in'}`, sub: 'Connected systems', action: 'tools' });
        }
        renderSysStatus();
        break;
      case 'commands': renderNavBadges(); break;
      case 'agents': renderNavBadges(); break;
      case 'tasks': renderNavBadges(); break;
      case 'context': renderBottom(); resolveEffort(e.model); break;
      case 'error': JV.feed({ level: 'err', title: 'Error', sub: JV.clip(e.message, 90), action: 'chat' }); JV.notify(e.message, { level: 'err', action: 'chat' }); break;
      case 'notice': JV.feed({ level: 'info', title: e.text, action: 'chat' }); break;
      default: break;
    }
  }

  /** The session does not report a saved per-model effort, so read it from the settings files. */
  async function resolveEffort(model) {
    if (state.effortExplicit || !model || model === state.effortModel) return;
    state.effortModel = model;
    const level = await window.jarvis.savedEffort(model);
    if (state.effortExplicit) return;
    state.effort = level || null;
    JV.emit('effort', { level: state.effort });
  }

  // Turns are recorded when the user sends, so the timeline can show them running.
  JV.on('user_sent', (d) => {
    state.turns.push({ start: Date.now(), prompt: d.text, end: null });
    if (!state.sessionStart) state.sessionStart = Date.now();
    JV.emit('turns');
  });
  JV.on('send_failed', () => { const t = state.turns[state.turns.length - 1]; if (t && !t.end) { t.end = Date.now(); t.ok = false; } JV.emit('turns'); });
  JV.on('session_reset', () => {
    state.turns = [];
    state.tasks = [];
    state.toolCalls = 0; state.toolErrors = 0; state.agentRuns = 0;
    state.agentActive.clear(); agentIds.clear();
    state.pendingPrompts = 0;
    state.sessionStart = Date.now();
    state.modelChoice = null;
    state.effortExplicit = false;
    state.effortModel = null;
    // A new or resumed session starts in Ask mode with the model's own thinking setting
    // (a resumed one reports its real mode in init).
    state.mode = 'default';
    state.thinking = null;
    JV.emit('turns');
    JV.emit('agents_changed');
    JV.emit('mode', { mode: state.mode });
    JV.emit('thinking', { on: null });
    renderNavBadges();
  });

  // ------------------------------------------------------------- header: clock
  function tick() {
    const d = new Date();
    $('clockDate').textContent = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    $('clockTime').textContent = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: !JV.prefs.h24 });
  }
  setInterval(tick, 1000);
  tick();

  // ------------------------------------------------------------- header: system status (honest, derived)
  function renderSysStatus() {
    const reasons = [];
    let level = 'ok';
    let word = 'OPTIMAL';
    if (state.status === 'closed' || state.status === 'offline') { level = 'bad'; word = 'OFFLINE'; reasons.push('The Claude Code session is not running.'); }
    else if (state.status === 'starting') { level = 'info'; word = 'CONNECTING'; }
    else if (state.pendingPrompts > 0 || state.status === 'waiting') { level = 'warn'; word = 'AWAITING YOU'; reasons.push('JARVIS is waiting for your decision.'); }
    const bad = state.mcp.filter((m) => m.status === 'failed' || m.status === 'needs-auth');
    if (bad.length) reasons.push(`${bad.map((m) => m.name).join(', ')}: not connected.`);
    const k = state.workspace?.knowledge;
    if (k && k.state !== 'current') reasons.push(`Knowledge is ${k.state === 'stale' ? 'stale' : k.state}.`);
    if (level === 'ok' && reasons.length) { level = 'warn'; word = 'ATTENTION'; }
    if (level === 'ok' && state.status === 'working') word = 'OPTIMAL · WORKING';
    const box = $('sysStatus');
    box.className = `sys-status l-${level}`;
    $('sysStatusText').textContent = word;
    box.title = reasons.length ? reasons.join('\n') : 'Session online, systems connected, knowledge current.';
  }

  // ------------------------------------------------------------- header: operator
  function renderOperator() {
    const a = state.account || {};
    $('opName').textContent = a.email ? a.email.split('@')[0] : 'Operator';
    $('opPlan').textContent = JV.planName(a) || 'Signed in';
    $('operator').title = [a.email, a.organization].filter(Boolean).join('\n') || 'Signed-in account';
  }
  $('operator').onclick = () => JV.show('core');

  // ------------------------------------------------------------- header: notifications
  $('bellBtn').onclick = () => {
    const p = $('notifPanel');
    p.hidden = !p.hidden;
    if (!p.hidden) JV.markRead();
  };
  $('notifClear').onclick = () => JV.clearNotes();
  JV.registerPop($('notifPanel'), $('bellBtn'));

  // ------------------------------------------------------------- header: search
  const sIn = $('searchInput');
  const sRes = $('searchResults');
  let sTimer = null;
  let sSeq = 0;
  async function runSearch() {
    const q = sIn.value.trim();
    const seq = ++sSeq;
    if (q.length < 2) { sRes.hidden = true; return; }
    const ql = q.toLowerCase();
    const groups = [];
    const views = [['Command Center', 'command'], ['AI Core', 'core'], ['Agents', 'agents'], ['Tasks', 'tasks'], ['Memory', 'memory'], ['Conversations', 'chat'], ['Knowledge Base', 'knowledge'], ['Tools & Skills', 'tools'], ['Workspace', 'workspace'], ['Devices', 'devices'], ['Files', 'files']]
      .filter(([n]) => n.toLowerCase().includes(ql)).map(([n, v]) => ({ title: n, sub: 'Go to view', run: () => JV.show(v) }));
    if (views.length) groups.push(['VIEWS', views]);
    const sessions = state.sessions.filter((s) => s.title.toLowerCase().includes(ql)).slice(0, 6).map((s) => ({ title: s.title, sub: JV.ago(s.lastModified), run: () => JV.chat.resumeSession(s.id, s.title) }));
    if (sessions.length) groups.push(['SESSIONS', sessions]);
    const agents = state.agentList.filter((a) => (a.name + ' ' + a.description).toLowerCase().includes(ql)).slice(0, 4).map((a) => ({ title: JV.agentInfo(a).code, sub: JV.agentInfo(a).role, run: () => JV.show('agents') }));
    if (agents.length) groups.push(['AGENTS', agents]);
    const cmds = state.commands.filter((c) => c.name.toLowerCase().includes(ql)).slice(0, 5).map((c) => ({ title: `/${c.name}`, sub: JV.clip(c.description, 70), run: () => JV.chat.insert(`/${c.name} `) }));
    if (cmds.length) groups.push(['COMMANDS', cmds]);
    const repos = (state.workspace?.repos || []).filter((r) => (r.name + ' ' + r.nickname).toLowerCase().includes(ql)).map((r) => ({ title: r.nickname, sub: `${r.name} · ${r.branch}`, run: () => JV.show('workspace') }));
    if (repos.length) groups.push(['REPOS', repos]);
    renderResults(groups, true);
    const docs = await window.jarvis.search(q);
    if (seq !== sSeq) return;
    const d = docs.slice(0, 10).map((h) => ({
      title: `${h.name}`,
      sub: `${h.rootLabel}${h.snippet ? ' · ' + h.snippet : ''}`,
      run: () => {
        if (h.root === 'memory') { JV.show('memory'); JV.openMemory(h.path); }
        else { JV.show('knowledge'); JV.openDoc($('kReader'), h.root, h.path, h.name); }
      },
    }));
    if (d.length) groups.push(['DOCUMENTS', d]);
    renderResults(groups, false);
  }
  let sItems = [];
  let sSel = 0;
  function renderResults(groups, loading) {
    sRes.replaceChildren();
    sItems = [];
    for (const [label, items] of groups) {
      sRes.appendChild(el('div', 'pop-sec', label));
      for (const it of items) {
        const b = el('button', 'sr');
        b.appendChild(el('b', null, it.title));
        b.appendChild(el('small', null, it.sub || ''));
        b.onmousedown = (ev) => { ev.preventDefault(); pick(it); };
        sRes.appendChild(b);
        sItems.push({ it, b });
      }
    }
    if (loading) sRes.appendChild(el('div', 'muted sr-note', 'Searching documents…'));
    else if (!sItems.length) sRes.appendChild(el('div', 'muted sr-note', 'Nothing found, sir.'));
    sSel = 0;
    if (sItems[0]) sItems[0].b.classList.add('sel');
    sRes.hidden = false;
  }
  function pick(it) { sRes.hidden = true; sIn.value = ''; sIn.blur(); it.run(); }
  sIn.addEventListener('input', () => { clearTimeout(sTimer); sTimer = setTimeout(runSearch, 220); });
  sIn.addEventListener('focus', () => { if (sIn.value.trim().length >= 2) runSearch(); });
  sIn.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { sRes.hidden = true; sIn.blur(); return; }
    if (!sItems.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sItems[sSel]?.b.classList.remove('sel');
      sSel = (sSel + (e.key === 'ArrowDown' ? 1 : -1) + sItems.length) % sItems.length;
      sItems[sSel].b.classList.add('sel');
      sItems[sSel].b.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') { e.preventDefault(); pick(sItems[sSel].it); }
  });
  JV.registerPop(sRes, $('search'));
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'k') { e.preventDefault(); sIn.focus(); sIn.select(); }
  });

  // ------------------------------------------------------------- settings
  function openSettings() {
    const a = state.account || {};
    const dl = $('settingsInfo');
    dl.replaceChildren();
    const rows = [
      ['Account', a.email || '–'],
      ['Plan', a.subscriptionType || a.apiProvider || '–'],
      ['Workspace', state.info?.cwd || '–'],
      ['JARVIS app', state.info ? `v${state.info.version} · Electron ${state.info.electron}` : '–'],
      ['Claude Code', state.version ? `v${state.version}` : '–'],
    ];
    for (const [k, v] of rows) { dl.appendChild(el('dt', null, k)); dl.appendChild(el('dd', null, v)); }
    $('prefNotify').checked = !!JV.prefs.notify;
    $('prefMotion').checked = !!JV.prefs.reduceMotion;
    $('pref24h').checked = !!JV.prefs.h24;
    $('settingsVeil').hidden = false;
  }
  $('settingsBtn').onclick = openSettings;
  $('settingsClose').onclick = () => { $('settingsVeil').hidden = true; };
  $('settingsVeil').addEventListener('mousedown', (e) => { if (e.target === $('settingsVeil')) $('settingsVeil').hidden = true; });
  $('prefNotify').onchange = (e) => {
    JV.prefs.notify = e.target.checked;
    JV.savePrefs();
    if (e.target.checked && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  };
  $('prefMotion').onchange = (e) => { JV.prefs.reduceMotion = e.target.checked; JV.savePrefs(); applyMotion(); };
  $('pref24h').onchange = (e) => { JV.prefs.h24 = e.target.checked; JV.savePrefs(); tick(); };
  $('openLogs').onclick = () => window.jarvis.openLogs();
  function applyMotion() { document.body.classList.toggle('still', !!JV.prefs.reduceMotion); JV.startOrb(); }

  // ------------------------------------------------------------- navigation + focus mode
  $('navList').addEventListener('click', (e) => { const b = e.target.closest('button[data-view]'); if (b) JV.show(b.dataset.view); });
  document.addEventListener('click', (e) => { const g = e.target.closest('[data-goto]'); if (g) JV.show(g.dataset.goto); });
  JV.setFocus = (on) => {
    document.body.classList.toggle('focus', on);
    $('focusBtn').classList.toggle('on', on);
    if (on) JV.show('chat');
  };
  // ------------------------------------------------------------- sidebar width
  // Narrowed to icons, with the labels as tooltips. Remembered between runs.
  const NAV_KEY = 'jarvis.navCollapsed';
  function setNav(collapsed) {
    document.body.classList.toggle('nav-collapsed', collapsed);
    $('navToggle').title = collapsed ? 'Widen the sidebar' : 'Narrow the sidebar';
    try { localStorage.setItem(NAV_KEY, collapsed ? '1' : '0'); } catch { /* storage off */ }
  }
  for (const b of document.querySelectorAll('#navList button')) {
    if (!b.title) b.title = b.querySelector('span')?.textContent || '';
  }
  $('navToggle').onclick = () => setNav(!document.body.classList.contains('nav-collapsed'));
  try { if (localStorage.getItem(NAV_KEY) === '1') setNav(true); } catch { /* storage off */ }

  $('focusBtn').onclick = () => JV.setFocus(!document.body.classList.contains('focus'));
  // The sidebar is hidden in focus mode, so this is the way back that is always visible.
  $('focusExit').onclick = () => JV.setFocus(false);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('focus') && state.status !== 'working' && state.status !== 'waiting') JV.setFocus(false); });
  $('coreMini').onclick = () => JV.show('chat');

  function renderNavBadges() {
    const set = (id, v) => { const b = $(id); b.textContent = v ? String(v) : ''; b.hidden = !v; };
    const running = [...state.agentActive.values()].reduce((a, b) => a + b, 0);
    set('nbAgents', running || null);
    $('nbAgents').classList.toggle('live', !!running);
    set('nbTasks', state.tasks.filter((t) => t.status !== 'completed').length || null);
    set('nbChat', state.pendingPrompts || null);
    $('nbChat').classList.toggle('warn', !!state.pendingPrompts);
    set('nbTools', state.commands.length || null);
    const dirty = (state.workspace?.repos || []).filter((r) => r.modified + r.staged + r.untracked > 0).length;
    set('nbRepos', dirty || null);
    const k = state.workspace?.knowledge;
    set('nbKnowledge', k && k.state === 'stale' ? '!' : null);
    set('nbMemory', state.memory.filter((d) => d.path.toLowerCase() !== 'memory.md').length || null);
  }
  JV.on('agents_changed', renderNavBadges);
  JV.on('memory', renderNavBadges);

  // ------------------------------------------------------------- core mini panel (sidebar)
  function renderMini() {
    const word = { starting: 'Connecting…', ready: 'Standing by', working: 'Working…', waiting: 'Awaiting you', closed: 'Offline', offline: 'Offline' }[state.status] || state.status;
    $('miniState').textContent = word;
    const running = [...state.agentActive.keys()];
    $('miniSub').textContent = running.length ? `${running.map((n) => JV.agentInfo({ name: n, description: (state.agentList.find((a) => a.name === n) || {}).description || '' }).code).join(', ')} on task` : state.status === 'ready' ? 'Click to talk to JARVIS' : ' ';
    $('coreMini').className = `core-mini hud-panel s-${state.status}`;
  }

  // ------------------------------------------------------------- bottom bar
  async function renderNet() {
    let on = navigator.onLine;
    try { on = await window.jarvis.online(); } catch { /* use navigator */ }
    $('bNet').textContent = on ? 'Online' : 'Offline';
    $('bNet').className = on ? 'ok' : 'bad';
  }
  function renderBottom() {
    $('bSess').textContent = state.sessionStart ? JV.dur(Date.now() - state.sessionStart) : '–';
    const c = state.context;
    $('bCtx').textContent = c ? `${Math.round(c.percentage)}% · ${JV.num(c.totalTokens)}` : '–';
    JV.renderTimer();
  }
  window.addEventListener('online', renderNet);
  window.addEventListener('offline', renderNet);
  setInterval(renderNet, 30000);
  setInterval(renderBottom, 15000);
  $('briefBtn').onclick = () => JV.briefing();

  // ------------------------------------------------------------- workspace polling
  let wsTimer = null;
  JV.refreshWorkspace = async (force) => {
    try {
      state.workspace = await window.jarvis.workspace(force);
      JV.emit('workspace', state.workspace);
      JV.workspaceSignals(state.workspace);
      renderSysStatus();
      renderNavBadges();
    } catch (err) { console.error('workspace', err); }
  };
  // While the window is hidden nothing is polled; one refresh runs when it comes back.
  let wsDirty = false;
  function refreshWorkspaceSoon() {
    if (document.hidden) { wsDirty = true; return; }
    clearTimeout(wsTimer);
    wsTimer = setTimeout(() => JV.refreshWorkspace(true), 4000);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && wsDirty) { wsDirty = false; JV.refreshWorkspace(true); }
  });

  // ------------------------------------------------------------- boot
  (async () => {
    JV.fillIcons();
    applyMotion();
    JV.wave($('miniWave'), 34);
    JV.renderBell();
    renderSysStatus();
    renderMini();
    renderOperator();
    renderNet();
    JV.renderDashboard();
    JV.startOrb();

    state.info = await window.jarvis.info();
    window.jarvis.claudeVersion().then((v) => { if (v && !state.version) { state.version = v; JV.emit('init', {}); } });
    if (!state.info.exeFound) JV.chatError('Claude Code was not found inside the app. Reinstall JARVIS.', false);
    state.sessionStart = Date.now();
    await window.jarvis.start({});
    JV.chat.loadSessions();
    JV.loadMemory();
    JV.loadDocCounts();
    JV.refreshWorkspace(false);
    setInterval(() => { if (document.hidden) wsDirty = true; else JV.refreshWorkspace(false); }, 90000);
    setInterval(() => { if (state.view === 'memory') JV.loadMemory(); }, 300000);
    renderBottom();
  })();
})();
