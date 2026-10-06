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

  // ------------------------------------------------------------- header: system status (honest, derived)
  function renderSysStatus() {
    const reasons = [];
    let level = 'ok';
    let word = 'All systems normal';
    if (state.status === 'closed' || state.status === 'offline') { level = 'bad'; word = 'Offline'; reasons.push('The Claude Code session is not running.'); }
    else if (state.status === 'starting') { level = 'info'; word = 'Connecting'; }
    else if (state.pendingPrompts > 0 || state.status === 'waiting') { level = 'warn'; word = 'Awaiting you'; reasons.push('JARVIS is waiting for your decision.'); }
    const bad = state.mcp.filter((m) => m.status === 'failed' || m.status === 'needs-auth');
    if (bad.length) reasons.push(`${bad.map((m) => m.name).join(', ')}: not connected.`);
    const k = state.workspace?.knowledge;
    if (k && k.state !== 'current') reasons.push(`Knowledge is ${k.state === 'stale' ? 'stale' : k.state}.`);
    if (level === 'ok' && reasons.length) { level = 'warn'; word = 'Needs attention'; }
    if (level === 'ok' && state.status === 'working') word = 'Working';
    const box = $('sysStatus');
    box.className = `sys-status l-${level}`;
    $('sysStatusText').textContent = word;
    box.title = reasons.length ? reasons.join('\n') : 'Session online, systems connected, knowledge current.';
  }

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
    const views = [['Chat', 'chat'], ['Overview', 'command'], ['Tasks', 'tasks'], ['GitHub Desktop', 'source'], ['Files', 'files'], ['Memory', 'memory'], ['Notes', 'notes'], ['Agents', 'agents'], ['Workspace', 'workspace'], ['Knowledge Base', 'knowledge'], ['Tools & Skills', 'tools'], ['Devices', 'devices'], ['AI Core', 'core']]
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
  const PRIMARY = ['chat', 'command', 'tasks', 'source', 'files', 'memory'];
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
  function openSettings() {
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
    if ($('settingsVeil').hidden) settingsReturn = document.activeElement;
    $('settingsVeil').hidden = false;
    $('settingsClose').focus();
  }
  function closeSettings() {
    if ($('settingsVeil').hidden) return;
    $('settingsVeil').hidden = true;
    $('wsConfirm').hidden = true;
    if (settingsReturn && document.contains(settingsReturn)) settingsReturn.focus();
    settingsReturn = null;
  }
  JV.openSettings = openSettings;

  // ------------------------------------------------------------- workspace folder
  // Picking a folder only proposes it; the switch happens on "Restart in this folder",
  // because the session, the file index and every git read are tied to the folder they
  // started in, so JARVIS restarts into the new one rather than half-switching.
  let wsPending = null;
  function renderWorkspace() {
    const info = state.info || {};
    $('wsPath').textContent = info.cwd || '–';
    $('wsPath').title = info.cwd || '';
    const missing = info.cwd && info.cwdExists === false;
    $('wsPath').parentElement.classList.toggle('missing', !!missing);
    $('wsPathNote').textContent = missing
      ? 'This folder does not exist on this machine - choose the right one.'
      : 'The folder JARVIS works in: its repos, CLAUDE.md and .claude settings.';
  }
  $('wsChange').onclick = async () => {
    const r = await window.jarvis.pickWorkspace();
    if (!r?.ok) return;
    if (r.path === state.info?.cwd) { $('wsConfirm').hidden = true; return; }
    wsPending = r.path;
    $('wsNew').textContent = r.path;
    $('wsConfirm').hidden = false;
    $('wsGo').focus();
  };
  $('wsCancel').onclick = () => { wsPending = null; $('wsConfirm').hidden = true; $('wsChange').focus(); };
  $('wsGo').onclick = async (e) => {
    if (!wsPending) return;
    e.currentTarget.disabled = true;
    const r = await window.jarvis.setWorkspace(wsPending);
    if (r?.ok && r.restarting) { $('wsGo').textContent = 'Restarting…'; return; }
    e.currentTarget.disabled = false;
    if (r?.unchanged) { $('wsConfirm').hidden = true; return; }
    JV.notify(r?.error || 'Could not switch to that folder.', { level: 'err', action: openSettings });
  };

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
  $('acctGo').onclick = async (e) => {
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = 'Signing out…';
    const r = await window.jarvis.authLogout();
    e.currentTarget.disabled = false;
    e.currentTarget.textContent = 'Sign out';
    $('acctConfirm').hidden = true;
    if (!r?.ok) { JV.notify(r?.error || 'Could not sign out.', { level: 'err', action: openSettings }); return; }
    state.account = { signedOut: true };
    renderOperator();
    await loadAccount();
    JV.notify('Signed out. Sign in again from Settings to carry on.', { level: 'warn', action: openSettings });
  };
  $('acctRestartGo').onclick = async (e) => {
    e.currentTarget.disabled = true;
    const r = await window.jarvis.restartApp();
    if (r?.restarting) e.currentTarget.textContent = 'Restarting…';
    else e.currentTarget.disabled = false;
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
    e.preventDefault();
    e.stopPropagation();
    if (!$('wsConfirm').hidden) { $('wsCancel').click(); return; }
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
