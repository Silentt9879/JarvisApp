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
      case 'agents': state.agentList = e.list; state.agentsLoaded = true; break;
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
        // state.agentActive (who is working now) is kept by crew.js from the agent floor's
        // model: a background agent's Agent call returns at once, but it works on until its
        // task notification, and a counter here would drop it the moment it was launched.
        if (e.agent && !e.parent) {
          agentIds.set(e.id, e.agent);
          state.agentRuns++;
          state.agentUse.set(e.agent, (state.agentUse.get(e.agent) || 0) + 1);
        }
        break;
      case 'tool_result':
        if (!e.parent && e.isError) state.toolErrors++;
        agentIds.delete(e.id);
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
    // The main process can ask the window to show a view (after a routine, or the budget alert).
    if (e.kind === 'navigate') { JV.show(e.view); return; }
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
        if (e.state === 'closed' && state.info?.workspace) JV.feed({ key: 'session', level: 'err', title: 'Session offline', sub: 'Send a message to reconnect', action: 'chat' });
        break;
      case 'init':
        JV.feed({ key: 'session', level: 'live', title: `Session online · ${JV.prettyModel(e.model)}`, sub: `Claude Code v${e.version}`, action: 'core' });
        renderNavBadges();
        break;
      case 'account': renderOperator(); break;
      case 'tool_use':
        if (e.agent && !e.parent) {
          const info = JV.agentInfo({ name: e.agent, description: (state.agentList.find((a) => a.name === e.agent) || {}).description || '' });
          JV.feed({ level: 'live', title: `${JV.minionName ? `${JV.minionName(e.agent)} (${info.code})` : info.code} dispatched`, sub: e.agentTask || info.role, action: 'agents' });
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
        // You stopped it yourself: a quiet line in the feed, and no notification - you know.
        const byYou = !e.ok && JV.stoppedByUser();
        JV.feed({
          level: e.ok ? 'ok' : byYou ? 'info' : 'err',
          title: e.ok ? `Reply complete${secs ? ` in ${secs}` : ''}` : byYou ? 'Stopped by you' : `Turn stopped (${e.subtype})`,
          sub: t ? JV.clip(t.prompt, 60) : '',
          action: 'chat',
        });
        if (!byYou && (state.view !== 'chat' || !document.hasFocus())) JV.notify(e.ok ? 'JARVIS has finished, sir.' : `The turn stopped (${e.subtype}).`, { level: e.ok ? 'ok' : 'err', action: 'chat', desktop: true });
        JV.emit('turns');
        JV.emit('agents_changed');
        refreshWorkspaceSoon();
        renderMini();
        break;
      }
      case 'mcp':
        for (const s of e.list.filter((x) => x.status === 'failed' || x.status === 'needs-auth')) {
          JV.feed({ key: `mcp-${s.name}`, level: s.status === 'failed' ? 'warn' : 'info', title: `${s.name}: ${s.status === 'failed' ? 'connection failed' : 'needs sign-in'}`, sub: 'Connected systems', action: 'tools' });
        }
        renderSysStatus();
        break;
      case 'commands': renderNavBadges(); break;
      case 'agents': renderNavBadges(); break;
      case 'tasks': renderNavBadges(); break;
      case 'context': renderBottom(); resolveEffort(e.model); break;
      case 'error': JV.feed({ level: 'err', title: 'Error', sub: JV.clip(e.message, 90), action: 'chat' }); JV.notify(e.message, { level: 'err', action: 'chat' }); break;
      case 'notice': JV.feed({ level: 'info', title: e.text, action: 'chat' }); break;
      case 'remote_prompt': JV.feed({ level: 'live', title: !e.attachments?.length ? 'Message from your phone' : e.attachments[0].kind === 'image' ? 'Photo from your phone' : 'File from your phone', sub: JV.clip(e.text || e.attachments?.[0]?.name || '', 80), action: 'chat' }); break;
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
    state.userStopAt = null; // a new message: whatever ends next was not stopped by you yet
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

  // ------------------------------------------------------------- header: system status
  // The pill says what the session itself is doing when that needs saying (choosing a folder,
  // offline, connecting, waiting for you). Otherwise it shows Health's verdict - the very one
  // the Health dialog opens on - so the two cannot disagree. It used to keep reasons of its
  // own (a connected tool not signed in, knowledge behind the code) that Health never listed:
  // "Needs attention" over a Health page with every row in order.
  function renderSysStatus() {
    const h = state.health;
    const reasons = [];
    let level = 'ok';
    let word = 'All systems normal';
    // No workspace yet is a first step to take, not a failure: no session runs without a folder.
    const noWorkspace = state.info && !state.info.workspace;
    if (noWorkspace) { level = 'info'; word = 'Choose a workspace'; reasons.push('JARVIS needs the folder that holds your projects before Claude can start.'); }
    else if (state.status === 'closed' || state.status === 'offline') { level = 'bad'; word = 'Offline'; reasons.push('The Claude Code session is not running.'); }
    else if (state.status === 'starting') { level = 'info'; word = 'Connecting'; }
    else if (state.pendingPrompts > 0 || state.status === 'waiting') { level = 'warn'; word = 'Awaiting you'; reasons.push('JARVIS is waiting for your decision.'); }
    else if (h && (h.level === 'bad' || h.level === 'warn')) {
      level = h.level;
      word = h.level === 'bad' ? 'Needs fixing' : 'Needs attention';
      const which = (h.checks || []).filter((c) => c.state === h.level).map((c) => c.title);
      reasons.push(`${h.summary}${which.length ? `: ${which.slice(0, 4).join(', ')}${which.length > 4 ? ', …' : ''}` : ''}.`);
    }
    if (level === 'ok' && state.status === 'working') word = 'Working';
    const box = $('sysStatus');
    box.className = `sys-status l-${level}`;
    $('sysStatusText').textContent = word;
    box.title = [...(reasons.length ? reasons : [h ? h.summary : 'Session online.']), 'Click to open Health.'].join('\n');
  }
  /** Ask Health again, a moment after whatever changed has settled, and redraw the pill. */
  let healthTimer = null;
  function refreshHealth(delay = 1500) {
    clearTimeout(healthTimer);
    healthTimer = setTimeout(async () => {
      try { state.health = await window.jarvis.health(false); } catch { return; }
      renderSysStatus();
    }, delay);
  }
  JV.refreshHealth = refreshHealth;
  JV.on('health', renderSysStatus);
  // What Health judges changes with these: the tools Claude connected to, the account signed
  // in, and a session coming up.
  for (const kind of ['mcp', 'account', 'init']) JV.on(kind, () => refreshHealth());
  // The workspace is re-read every 90 seconds, and asking Health starts a sign-in check each
  // time - so only when its knowledge has actually changed state, not on every reading.
  let knowledgeSeen = null;
  JV.on('workspace', (w) => {
    const k = w?.knowledge;
    const now = k?.available ? `${k.state}:${Array.isArray(k.stale) ? k.stale.length : 0}` : 'none';
    if (now !== knowledgeSeen) { knowledgeSeen = now; refreshHealth(); }
  });
  // The rest (an update arriving, a sync failing) has no event here: a slow look, while the
  // window is on screen, keeps the pill honest. Opening Health always asks afresh.
  setInterval(() => { if (!document.hidden) refreshHealth(0); }, 10 * 60 * 1000);

  // ------------------------------------------------------------- header: operator
  function renderOperator() {
    const a = state.account || {};
    $('opName').textContent = a.email ? a.email.split('@')[0] : 'Operator';
    $('opPlan').textContent = a.signedOut ? 'Not signed in' : (JV.planName(a) || 'Signed in');
    $('operator').title = a.signedOut
      ? 'Not signed in - sign in from Settings (Ctrl+,)'
      : ([a.email, a.organization].filter(Boolean).join('\n') || 'Signed-in account');
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
    const views = [['Chat', 'chat'], ['Overview', 'command'], ['Tasks', 'tasks'], ['GitHub Desktop', 'source'], ['Files', 'files'], ['Memory', 'memory'], ['Notes', 'notes'], ['Agents', 'agents'], ['Projects', 'workspace'], ['Knowledge Base', 'knowledge'], ['Tools & Skills', 'tools'], ['Devices', 'devices'], ['AI Core', 'core']]
      .filter(([n]) => n.toLowerCase().includes(ql)).map(([n, v]) => ({ title: n, sub: 'Go to view', run: () => JV.show(v) }));
    if (views.length) groups.push(['Views', views]);
    const sessions = state.sessions.filter((s) => s.title.toLowerCase().includes(ql)).slice(0, 6).map((s) => ({ title: s.title, sub: JV.ago(s.lastModified), run: () => JV.chat.resumeSession(s.id, s.title) }));
    if (sessions.length) groups.push(['Sessions', sessions]);
    const agents = state.agentList.filter((a) => (a.name + ' ' + a.description).toLowerCase().includes(ql)).slice(0, 4).map((a) => ({ title: JV.agentInfo(a).code, sub: JV.agentInfo(a).role, run: () => JV.show('agents') }));
    if (agents.length) groups.push(['Agents', agents]);
    const cmds = state.commands.filter((c) => c.name.toLowerCase().includes(ql)).slice(0, 5).map((c) => ({ title: `/${c.name}`, sub: JV.clip(c.description, 70), run: () => JV.chat.insert(`/${c.name} `) }));
    if (cmds.length) groups.push(['Commands', cmds]);
    const repos = (state.workspace?.repos || []).filter((r) => (r.name + ' ' + r.nickname).toLowerCase().includes(ql)).map((r) => ({ title: r.nickname, sub: `${r.name} · ${r.branch}`, run: () => JV.show('workspace') }));
    if (repos.length) groups.push(['Repos', repos]);
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
    if (d.length) groups.push(['Documents', d]);
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
    // stopPropagation: Esc here closes the results, and must not also reach the chat's
    // document-wide Esc, which would interrupt a running turn.
    if (e.key === 'Escape') { e.stopPropagation(); sRes.hidden = true; sIn.blur(); return; }
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
  // ------------------------------------------------------------- keyboard shortcuts
  //   Ctrl+K      search                Ctrl+1-6  the six views in the sidebar, in order
  //   Ctrl+N      new session           Ctrl+,    settings
  // Digits are read from e.code, not e.key, so they work on any keyboard layout. None of
  // these combinations does anything by default in this window (it has no menu), so taking
  // them costs nothing - including while typing in the composer.
  const PRIMARY = ['chat', 'command', 'source', 'notes', 'files', 'workspace'];
  document.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    const key = e.key.toLowerCase();
    // e.code first (layout-independent); e.key when a synthetic event leaves code empty.
    const digit = /^Digit([1-6])$/.exec(e.code) || (!e.code && /^([1-6])$/.exec(e.key));
    if (key === 'k') { e.preventDefault(); closeSettings(); sIn.focus(); sIn.select(); }
    else if (digit) { e.preventDefault(); closeSettings(); JV.show(PRIMARY[Number(digit[1]) - 1]); }
    else if (key === 'n') { e.preventDefault(); closeSettings(); JV.show('chat'); JV.chat.newSession(); }
    else if (key === ',') { e.preventDefault(); if ($('settingsVeil').hidden) openSettings(); else closeSettings(); }
  });
  // The shortcut is part of each entry's tooltip, so it can be discovered by hovering.
  PRIMARY.forEach((v, i) => {
    const b = document.querySelector(`#navList button[data-view="${v}"]`);
    if (b) b.dataset.key = `Ctrl+${i + 1}`;
  });
  $('newSession').title = 'New session (Ctrl+N)';
  $('settingsBtn').title = 'Settings (Ctrl+,)';

  // ------------------------------------------------------------- settings
  let settingsReturn = null; // where keyboard focus goes back to when Settings closes
  function openSettings(tab, anchor) {
    const a = state.account || {};
    const dl = $('settingsInfo');
    dl.replaceChildren();
    const rows = [
      // The account itself is the section above; this is what the running session is using.
      ['Session', a.email ? `${a.email}${JV.planName(a) ? ` · ${JV.planName(a)}` : ''}` : 'No session yet'],
      ['JARVIS app', state.info ? `v${state.info.version} · Electron ${state.info.electron}` : '–'],
      ['Claude Code', state.version ? `v${state.version}` : '–'],
    ];
    for (const [k, v] of rows) { dl.appendChild(el('dt', null, k)); dl.appendChild(el('dd', null, v)); }
    renderWorkspace();
    loadAccount();
    renderThemeSeg();
    JV.loadAlerts?.();
    $('prefNotify').checked = !!JV.prefs.notify;
    $('prefMotion').checked = !!JV.prefs.reduceMotion;
    $('pref24h').checked = !!JV.prefs.h24;
    loadStartup();
    JV.loadUpdates?.();
    if ($('settingsVeil').hidden) settingsReturn = document.activeElement;
    $('settingsVeil').hidden = false;
    JV.settingsRefresh?.();
    // Opened on a tab (from Health, say), optionally scrolled to one section. A click passes an event, not a tab.
    if (typeof tab === 'string') JV.settingsGo?.(tab, typeof anchor === 'string' ? anchor : null);
    $('settingsClose').focus();
  }
  function closeSettings() {
    if ($('settingsVeil').hidden) return;
    $('settingsVeil').hidden = true;
    if (settingsReturn && document.contains(settingsReturn)) settingsReturn.focus();
    settingsReturn = null;
  }
  JV.openSettings = openSettings;

  // ------------------------------------------------------------- workspaces
  // The session, the file index, every git read, flutter run and dotnet watch are tied to the
  // folder they started in - so a switch is never done in place: the choice is saved and
  // JARVIS restarts into it (main.mjs, restartJarvis). Removing only forgets the folder.
  async function renderWorkspace() {
    const host = $('wsList');
    let list = null;
    try { list = await window.jarvis.workspaces(); } catch { /* shown below */ }
    host.replaceChildren();
    if (!list) { host.appendChild(el('li', 'ws-item muted', 'Could not read the list. Try again in a moment.')); return; }
    if (!list.workspaces.length) {
      host.appendChild(el('li', 'ws-item muted', 'No workspace yet. Add the folder that holds your projects - JARVIS looks through it and lists what it finds.'));
    }
    for (const w of list.workspaces) {
      const li = el('li', `ws-item${w.active ? ' active' : ''}${w.exists ? '' : ' missing'}`);
      const text = el('div', 'ws-path');
      const title = el('b', null, w.name);
      if (w.active) title.appendChild(el('span', 'ws-badge', 'Active'));
      if (!w.trusted) { const b = el('span', 'ws-badge muted', 'Restricted'); b.title = 'Its .claude hooks, MCP servers and settings are not loaded, and JARVIS runs nothing from it - no scripts, builds, tests, apps or Git.'; title.appendChild(b); }
      if (!w.exists) title.appendChild(el('span', 'ws-badge bad', 'Folder missing'));
      text.appendChild(title);
      const p = el('small', null, w.path);
      p.title = w.path;
      text.appendChild(p);
      li.appendChild(text);
      const acts = el('div', 'ws-acts');
      if (!w.active) {
        const go = el('button', 'btn btn-primary small', 'Switch');
        go.type = 'button';
        go.disabled = !w.exists;
        go.title = w.exists ? `Restart JARVIS in ${w.name}` : 'The folder is not there - it cannot be opened.';
        go.onclick = () => switchTo(w, go);
        acts.appendChild(go);
      }
      const trust = el('button', 'btn small', w.trusted ? 'Restrict' : 'Trust…');
      trust.type = 'button';
      trust.title = w.trusted ? 'Stop loading this folder\'s own .claude hooks, MCP servers and settings' : 'Load this folder\'s own .claude hooks, MCP servers and settings';
      trust.onclick = () => setTrust(w, !w.trusted);
      acts.appendChild(trust);
      const ren = el('button', 'btn small', 'Rename');
      ren.type = 'button';
      ren.onclick = () => renameWs(w);
      acts.appendChild(ren);
      const rem = el('button', 'btn btn-ghost small', 'Remove');
      rem.type = 'button';
      rem.title = 'Take it off this list. The folder and its files stay where they are.';
      rem.onclick = () => removeWs(w, list);
      acts.appendChild(rem);
      li.appendChild(acts);
      host.appendChild(li);
    }
  }
  JV.renderWorkspaces = renderWorkspace;

  /** What a restart would stop, in words - asked fresh each time, so it is never stale. */
  async function stoppingNote() {
    const b = await window.jarvis.workspaceBusy().catch(() => null);
    if (!b) return '';
    const parts = [];
    if (b.chat) parts.push('the reply JARVIS is working on');
    if (b.flutter) parts.push(`${b.flutter} app${b.flutter === 1 ? '' : 's'} running on a phone`);
    if (b.web) parts.push(`${b.web} web app${b.web === 1 ? '' : 's'} or API${b.web === 1 ? '' : 's'}`);
    if (b.tasks) parts.push(`${b.tasks} build or test run${b.tasks === 1 ? '' : 's'}`);
    return parts.length ? ` This stops ${parts.join(', ')}.` : '';
  }

  /**
   * Trust a folder? Asked the first time JARVIS is to work in it, as Claude Code asks: a
   * folder's .claude settings can run hooks and MCP servers - commands on this PC. Resolves
   * true (trust), false (open it restricted) or null (do not switch).
   */
  async function askTrust(w, intro = '') {
    if (w.trusted) return true;
    const v = await JV.dialog({
      title: `Do you trust ${w.name}?`,
      wide: true,
      body: [
        intro ? JV.node('p', { class: 'dlg-text' }, intro) : null,
        JV.node('p', { class: 'dlg-text' }, `A folder's own CLAUDE.md and .claude settings can include hooks and MCP servers - commands that run on this PC while Claude works there - and permission rules that let tools run without asking. Its builds, tests and Git configuration can run commands too.`),
        JV.node('ul', { class: 'wiz-list' },
          JV.node('li', null, JV.node('b', null, 'Trust it'), ' if it is your own code, or code you have reviewed: Claude works with all of its settings, as in a terminal, and JARVIS can build, test, run and use Git there.'),
          JV.node('li', null, JV.node('b', null, 'Open restricted'), ' for anything else: Claude works with your own settings only, and JARVIS reads the folder but runs nothing from it - no scripts, builds, tests, apps or Git. You can trust it later in Settings.')),
        JV.node('small', { class: 'dlg-hint' }, w.path),
      ].filter(Boolean),
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'Open restricted', value: 'restricted' },
        { label: 'Trust it', primary: true, value: 'trust' },
      ],
    });
    return v === 'trust' ? true : v === 'restricted' ? false : null;
  }
  JV.askTrust = askTrust;

  async function switchTo(w, btn) {
    let trust;
    if (!w.trusted) {
      trust = await askTrust(w, `JARVIS restarts in ${w.name}.${await stoppingNote()}`);
      if (trust === null) return;
    } else {
      const ok = await JV.confirm(`JARVIS restarts in ${w.name} (${w.path}). Conversations are kept per folder, so you will see that workspace's sessions.${await stoppingNote()}`, { title: `Switch to ${w.name}?`, yes: 'Switch and restart' });
      if (!ok) return;
    }
    if (btn) btn.disabled = true;
    const r = await window.jarvis.workspaceSelect(w.id, typeof trust === 'boolean' ? { trust } : {}).catch((err) => ({ ok: false, error: err.message }));
    if (r?.restarting) { if (btn) btn.textContent = 'Restarting…'; return; }
    if (btn) btn.disabled = false;
    if (!r?.ok) JV.notify(r?.error || 'Could not switch. Try again in a moment.', { level: 'err', action: openSettings });
  }
  JV.switchWorkspace = switchTo;

  async function setTrust(w, trusted) {
    if (trusted && (await askTrust({ ...w, trusted: false }, w.active ? 'JARVIS restarts so the change applies everywhere.' : '')) !== true) return;
    if (!trusted && !(await JV.confirm(`Claude will work in ${w.name} with your own settings only - its .claude hooks, MCP servers, agents and permission rules stop loading - and JARVIS will run nothing from it: no builds, tests, apps or Git.${w.active ? ' JARVIS restarts.' : ''}`, { title: `Restrict ${w.name}?`, yes: w.active ? 'Restrict and restart' : 'Restrict' }))) return;
    const r = await window.jarvis.workspaceTrust(w.id, trusted).catch((err) => ({ ok: false, error: err.message }));
    if (!r?.ok) { JV.notify(r?.error || 'Could not change that.', { level: 'err', action: openSettings }); return; }
    if (!r.restarting) renderWorkspace();
  }
  JV.trustActiveWorkspace = async () => {
    const list = await window.jarvis.workspaces().catch(() => null);
    const w = list?.workspaces.find((x) => x.active);
    if (w) await setTrust(w, true);
  };

  async function renameWs(w) {
    const box = JV.node('input', { class: 'field', value: w.name, maxlength: '60', 'aria-label': 'Workspace name', autocomplete: 'off' });
    const name = await JV.dialog({
      title: 'Rename workspace',
      body: [JV.field('Name', box, 'Only how JARVIS shows it. The folder keeps its own name.')],
      buttons: [{ label: 'Cancel', value: null }, { label: 'Rename', primary: true, onClick: () => { if (!box.value.trim()) return false; return undefined; }, value: 'go' }],
      onOpen: () => { box.focus(); box.select(); },
    });
    if (name !== 'go') return;
    const r = await window.jarvis.workspaceRename(w.id, box.value).catch((err) => ({ ok: false, error: err.message }));
    if (!r?.ok) JV.notify(r?.error || 'Could not rename it.', { level: 'err', action: openSettings });
    renderWorkspace();
  }

  async function removeWs(w, list) {
    const others = list.workspaces.filter((x) => x.id !== w.id);
    const next = [...others].sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0))[0];
    const msg = w.active
      ? `${w.name} is the active workspace. JARVIS restarts ${next ? `in ${next.name}` : 'with no workspace, and asks for one'}.${await stoppingNote()} The folder and its files stay exactly where they are.`
      : `${w.name} comes off the list. The folder and its files stay exactly where they are, and you can add it again any time.`;
    if (!(await JV.confirm(msg, { title: `Remove ${w.name}?`, yes: w.active ? 'Remove and restart' : 'Remove', danger: true }))) return;
    const r = await window.jarvis.workspaceRemove(w.id).catch((err) => ({ ok: false, error: err.message }));
    if (!r?.ok) JV.notify(r?.error || 'Could not remove it.', { level: 'err', action: openSettings });
    if (!r?.restarting) renderWorkspace();
  }

  /** Pick a folder, add it, and offer to switch to it. Used by Settings, Health and onboarding. */
  async function addWorkspaceFlow({ switchNow = null } = {}) {
    const picked = await window.jarvis.pickWorkspace().catch(() => null);
    if (!picked?.ok) return null;
    const r = await window.jarvis.workspaceAdd(picked.path).catch((err) => ({ ok: false, error: err.message }));
    if (!r?.ok) { JV.notify(r?.error || 'That folder cannot be a workspace.', { level: 'err', action: openSettings }); return null; }
    await renderWorkspace();
    if (r.duplicate) JV.notify(`${r.workspace.name} is already in your list.`, { level: 'info' });
    const listed = (await window.jarvis.workspaces().catch(() => null))?.workspaces.find((x) => x.id === r.workspace.id) || { ...r.workspace, trusted: false };
    if (listed.active) return r.workspace;
    let trust;
    if (!listed.trusted) {
      // Switching now (or asked to): the trust question is the switch question.
      if (switchNow === false) return r.workspace;
      trust = await askTrust(listed, `Work in ${listed.name} now? JARVIS restarts there.${await stoppingNote()}`);
      if (trust === null) return r.workspace;
    } else {
      const go = switchNow ?? await JV.confirm(`Work in ${listed.name} now? JARVIS restarts there.${await stoppingNote()}`, { title: 'Switch to it?', yes: 'Switch and restart', no: 'Not now' });
      if (!go) return r.workspace;
    }
    const s = await window.jarvis.workspaceSelect(listed.id, typeof trust === 'boolean' ? { trust } : {}).catch(() => null);
    if (s && !s.ok && !s.unchanged) JV.notify(s.error || 'Could not switch.', { level: 'err' });
    return r.workspace;
  }
  JV.addWorkspace = addWorkspaceFlow;

  $('wsAdd').onclick = () => addWorkspaceFlow();
  $('wsRescan').onclick = (e) => JV.spinWhile(e.currentTarget, async () => {
    const note = $('wsScanNote');
    note.textContent = 'Looking…';
    const r = await window.jarvis.projects(true).catch(() => null);
    note.textContent = !r ? 'Could not look just now.'
      : !r.ok ? (r.error || 'Could not look just now.')
        : `Found ${r.projects.length} project${r.projects.length === 1 ? '' : 's'} in ${r.ms} ms${r.truncated ? ' (stopped at the folder limit)' : ''}.`;
    JV.emit('projects_changed', r);
  });

  // ------------------------------------------------------------- the account
  // Who JARVIS works as, with one button beside it - sign out when signed in, sign in when
  // not. Claude Code holds the credentials and runs both commands; the window only asks it
  // who is signed in. Signing in happens in a console window of its own (the CLI drives a
  // browser), so the answer is waited for by asking again every few seconds.
  let acct = null;
  let acctPolling = 0;
  function renderAccount() {
    const who = $('acctWho');
    const btn = $('acctBtn');
    const note = $('acctNote');
    btn.hidden = false;
    btn.disabled = false;
    btn.className = 'btn small';
    if (!acct) { who.textContent = 'Checking…'; btn.hidden = true; return; }
    if (acct.ok && acct.loggedIn) {
      who.textContent = acct.email || 'Signed in';
      note.textContent = [JV.planName(acct), acct.orgName].filter(Boolean).join(' · ')
        || 'The Anthropic account JARVIS works as.';
      btn.textContent = 'Sign out';
      return;
    }
    who.textContent = acctPolling ? 'Waiting for the sign-in window…' : 'Not signed in';
    note.textContent = acct.error
      ? acct.error
      : (acctPolling
        ? 'Finish signing in in the window that opened, and this will catch up on its own.'
        : 'JARVIS cannot work until an Anthropic account is signed in.');
    btn.className = 'btn btn-primary small';
    btn.textContent = acctPolling ? 'Waiting…' : 'Sign in';
    btn.disabled = !!acctPolling;
  }
  async function loadAccount() {
    acct = await window.jarvis.authStatus();
    renderAccount();
    return acct;
  }
  JV.loadAccount = loadAccount;
  $('acctBtn').onclick = async () => {
    if (acct?.loggedIn) {
      $('acctEmail').textContent = acct.email || 'this account';
      $('acctRestart').hidden = true;
      $('acctConfirm').hidden = false;
      $('acctGo').focus();
      return;
    }
    const r = await window.jarvis.authLogin();
    if (!r?.ok) { JV.notify(r?.error || 'Could not open the sign-in window.', { level: 'err' }); return; }
    // The CLI is asking its own questions now; watch for the answer for five minutes.
    const until = Date.now() + 300000;
    clearInterval(acctPolling);
    acctPolling = setInterval(async () => {
      const r2 = await loadAccount();
      if (r2?.loggedIn) {
        clearInterval(acctPolling); acctPolling = 0;
        $('acctNew').textContent = r2.email || 'your account';
        $('acctRestart').hidden = false;
        renderAccount();
        JV.notify(`Signed in as ${r2.email || 'your account'}. Restart JARVIS to use it.`, { level: 'ok', action: openSettings });
      } else if (Date.now() > until) { clearInterval(acctPolling); acctPolling = 0; renderAccount(); }
    }, 3000);
    renderAccount();
  };
  $('acctCancel').onclick = () => { $('acctConfirm').hidden = true; $('acctBtn').focus(); };
  // The button is read before the first await: after it, e.currentTarget is already null.
  $('acctGo').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Signing out…';
    let r = null;
    try { r = await window.jarvis.authLogout(); } catch (err) { r = { ok: false, error: err.message }; }
    btn.disabled = false;
    btn.textContent = 'Sign out';
    $('acctConfirm').hidden = true;
    if (!r?.ok) { JV.notify(r?.error || 'Could not sign out. Try again in a moment.', { level: 'err', action: openSettings }); return; }
    state.account = { signedOut: true };
    renderOperator();
    await loadAccount();
    JV.notify("You're signed out. Sign in from Settings to carry on.", { level: 'warn', action: openSettings });
  };
  $('acctRestartGo').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const r = await window.jarvis.restartApp().catch(() => null);
    if (r?.restarting) btn.textContent = 'Restarting…';
    else btn.disabled = false;
  };

  // ------------------------------------------------------------- appearance
  // "System" follows Windows; Light and Dark pin one, through data-theme on <html>,
  // which the stylesheet gives priority over the prefers-color-scheme query.
  const THEMES = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']];
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    const t = JV.prefs.theme === 'light' || JV.prefs.theme === 'dark' ? JV.prefs.theme : 'system';
    if (t === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    // The caption buttons are the system's, not the page's: tell it which theme is showing.
    const shown = t === 'system' ? (systemDark.matches ? 'dark' : 'light') : t;
    window.jarvis.titleBar?.(shown).catch?.(() => {});
  }
  // Following Windows: when it switches light/dark, so do the caption buttons.
  systemDark.addEventListener('change', () => { if ((JV.prefs.theme || 'system') === 'system') applyTheme(); });
  function renderThemeSeg() {
    const seg = $('themeSeg');
    seg.replaceChildren();
    for (const [value, label] of THEMES) {
      const on = (JV.prefs.theme || 'system') === value;
      const b = el('button', on ? 'on' : null, label);
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(on));
      b.onclick = () => { JV.prefs.theme = value; JV.savePrefs(); applyTheme(); renderThemeSeg(); seg.querySelector('.on')?.focus(); };
      seg.appendChild(b);
    }
  }
  $('settingsBtn').onclick = openSettings;
  $('settingsClose').onclick = closeSettings;
  $('settingsVeil').addEventListener('mousedown', (e) => { if (e.target === $('settingsVeil')) closeSettings(); });
  // Esc closes Settings - and only that. The chat listens for Esc on the whole document to
  // interrupt a running turn, so this runs first (capture phase, on window) and stops the
  // event there: dismissing a dialog must never stop JARVIS mid-task.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || $('settingsVeil').hidden) return;
    // A dialog opened from Settings (rename, confirm) closes first, on its own.
    if (document.querySelector('.dlg-veil')) return;
    e.preventDefault();
    e.stopPropagation();
    closeSettings();
  }, true);
  // Tab stays inside the dialog while it is open, as it would in a native one.
  $('settingsVeil').addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const items = [...$('settingsVeil').querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter((n) => !n.disabled && n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  $('prefNotify').onchange = (e) => {
    JV.prefs.notify = e.target.checked;
    JV.savePrefs();
    if (e.target.checked && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  };
  $('prefMotion').onchange = (e) => { JV.prefs.reduceMotion = e.target.checked; JV.savePrefs(); applyMotion(); };
  $('pref24h').onchange = (e) => { JV.prefs.h24 = e.target.checked; JV.savePrefs(); tick(); };
  // Start with Windows lives in the registry, not jarvis.prefs: it is read back each time.
  async function loadStartup() {
    const box = $('prefLogin');
    try {
      const s = await window.jarvis.startup();
      box.checked = !!s.atLogin;
      box.disabled = !s.available;
      $('prefLoginRow').title = s.available ? '' : 'Only the installed JARVIS.exe can start with Windows, not a development run.';
    } catch { box.disabled = true; }
  }
  $('prefLogin').onchange = async (e) => {
    const r = await window.jarvis.setStartup(e.target.checked);
    if (!r?.ok) JV.notify(r?.error || 'Windows did not take the change.', { level: 'err', action: openSettings });
    loadStartup();
  };
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
  for (const b of document.querySelectorAll('#navList button[data-view]')) {
    if (!b.title) b.title = `${b.querySelector('span')?.textContent || ''}${b.dataset.key ? ` (${b.dataset.key})` : ''}`;
  }
  $('navToggle').onclick = () => setNav(!document.body.classList.contains('nav-collapsed'));
  try { if (localStorage.getItem(NAV_KEY) === '1') setNav(true); } catch { /* storage off */ }

  // The "More" group: the six views that are not daily, folded away but remembered open.
  const MORE_KEY = 'jarvis.navMore';
  $('navMore').setAttribute('aria-controls', 'navGroup');
  function setMore(open) {
    $('navGroup').classList.toggle('open', open);
    $('navMore').classList.toggle('open', open);
    $('navMore').setAttribute('aria-expanded', String(open));
    try { localStorage.setItem(MORE_KEY, open ? '1' : '0'); } catch { /* storage off */ }
  }
  $('navMore').onclick = () => setMore(!$('navGroup').classList.contains('open'));
  try { if (localStorage.getItem(MORE_KEY) === '1') setMore(true); } catch { /* storage off */ }
  // Navigating to one of them from anywhere (search, a panel link) opens the group, so the
  // highlighted entry is never hidden.
  JV.on('view', (v) => {
    if ($('navGroup').querySelector(`button[data-view="${v}"]`)) setMore(true);
  });

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
  }
  JV.on('agents_changed', renderNavBadges);

  // ------------------------------------------------------------- core mini panel (sidebar)
  function renderMini() {
    if (state.info && !state.info.workspace) {
      $('miniState').textContent = 'No workspace yet';
      $('miniSub').textContent = 'Choose a folder to begin';
      $('coreMini').className = 'core-mini s-starting';
      return;
    }
    const word = { starting: 'Connecting…', ready: 'Standing by', working: 'Working…', waiting: 'Awaiting you', closed: 'Offline', offline: 'Offline' }[state.status] || state.status;
    $('miniState').textContent = word;
    const running = [...state.agentActive.keys()];
    $('miniSub').textContent = running.length ? `${running.map((n) => JV.agentInfo({ name: n, description: (state.agentList.find((a) => a.name === n) || {}).description || '' }).code).join(', ')} on task` : state.status === 'ready' ? 'Click to talk to JARVIS' : ' ';
    $('coreMini').className = `core-mini s-${state.status}`;
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

  /**
   * No workspace chosen yet: there is no default folder to fall back on, so the chat says what
   * JARVIS needs and offers the one button that gives it.
   */
  function showNoWorkspace() {
    const w = $('welcome');
    if (!w) return;
    const b = el('button', 'btn btn-primary', 'Choose a workspace folder…');
    b.type = 'button';
    b.onclick = () => JV.addWorkspace({ switchNow: true });
    const chips = el('div', 'suggestions');
    chips.appendChild(b);
    const img = el('img');
    img.src = '../../build/icon.png';
    img.alt = '';
    w.replaceChildren(img, el('h1', null, 'Welcome to JARVIS.'),
      el('p', null, 'Choose the folder that holds your projects. JARVIS looks through it, lists what it finds, and works with Claude Code inside it. Nothing in it is changed until you ask.'),
      chips);
    document.body.dataset.workspace = 'none';
  }
  JV.showNoWorkspace = showNoWorkspace;

  // ------------------------------------------------------------- boot
  (async () => {
    JV.fillIcons();
    applyTheme();
    applyMotion();
    JV.wave($('miniWave'));
    JV.renderBell();
    renderSysStatus();
    renderMini();
    renderOperator();
    renderNet();
    JV.renderDashboard();
    JV.startOrb();

    state.info = await window.jarvis.info();
    renderSysStatus();
    renderMini();
    // The features of 2026-10-07. Each one sets itself up from what it needs; see its file.
    JV.applyPrefs?.();
    JV.initSettingsExtra?.();
    JV.initActivity?.();
    JV.initAutomations?.();
    JV.initHealth?.();
    JV.initVoice?.();
    JV.initProjects?.();
    JV.initUsagePage?.();
    $('newWindow').onclick = () => window.jarvis.newChatWindow().catch(() => {});
    // A chat window opened beside the main one: no sidebar, just the conversation.
    if (new URLSearchParams(location.search).get('pane')) document.body.classList.add('pane');
    JV.initWelcome?.();
    window.jarvis.claudeVersion().then((v) => { if (v && !state.version) { state.version = v; JV.emit('init', {}); } });
    if (!state.info.exeFound) JV.chatError('Claude Code was not found inside the app. Reinstall JARVIS.', false);
    state.sessionStart = Date.now();
    if (state.info.workspace) {
      $('welcomeLine').textContent = `JARVIS is ready in ${state.info.workspace.name}.`;
      await window.jarvis.start({});
    } else showNoWorkspace();
    JV.chat.loadSessions();
    JV.loadMemory();
    JV.loadDocCounts();
    JV.refreshWorkspace(false);
    setInterval(() => { if (document.hidden) wsDirty = true; else JV.refreshWorkspace(false); }, 90000);
    setInterval(() => { if (state.view === 'memory') JV.loadMemory(); }, 300000);
    renderBottom();
  })();
})();
