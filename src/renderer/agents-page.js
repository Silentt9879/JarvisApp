/* JARVIS window - the Agents page under the floor: every agent there is, where it comes from,
   and what can be done with it.

   The list is the two folders Claude Code takes agents from (this workspace's .claude/agents and
   your own agents folder), read by the main process, laid beside what the running session
   reports - so an agent made a moment ago shows at once, marked as not in the session yet,
   and never as working. Who is working is the floor's business (crew.js), from real events.

   Everything an agent's file says is shown as text; the brief is Markdown through the sanitizer. */
(() => {
  'use strict';
  const { $, el, state } = JV;
  const api = window.jarvis;

  // What a set of tools allows, in the words used on a card and in an approval.
  const RISK = {
    'all-tools': ['Every tool', 'It can use every tool the chat has - running commands, changing files and your connected systems included.'],
    'runs-commands': ['Runs commands', 'It can run commands on this PC.'],
    'edits-files': ['Changes files', 'It can create, change and replace files.'],
    delegates: ['Starts agents', 'It can hand work to other agents.'],
    network: ['Uses the web', 'It can search the web and read web pages.'],
    mcp: ['Connected systems', 'It can use tools from your connected systems (MCP servers).'],
    'bypass-permissions': ['Skips approvals', 'Its file asks to run without permission prompts. JARVIS did not write that and never will.'],
    hooks: ['Has hooks', 'Its file defines hooks: commands that run by themselves when it works.'],
    'mcp-servers': ['Own servers', 'Its file starts MCP servers of its own.'],
  };
  const LOUD = ['all-tools', 'runs-commands', 'edits-files', 'bypass-permissions', 'hooks'];
  // How a tool's tag is coloured: one that only looks, one that changes things, or neither.
  const LOOKS = /^(Read|Grep|Glob)$/;
  const CHANGES = /^(Edit|Write|NotebookEdit|MultiEdit|Bash|PowerShell)\b/;
  JV.agentRisk = RISK;
  JV.agentRiskLoud = LOUD;

  const GROUPS = [
    ['project', 'This workspace\'s agents', 'From .claude/agents in this workspace - used here only.'],
    ['user', 'Your agents', 'From your own Claude folder - used in every workspace, and by Claude Code in the terminal and VS Code.'],
    ['off', 'Switched off', 'Kept on disk and not loaded by Claude Code. Switch one on to use it again.'],
    ['other', 'From plugins and other sources', 'Reported by Claude Code from a plugin, a setting or a policy - managed there, not here.'],
  ];
  const SOURCE_WORD = { project: 'This workspace', user: 'Your own', builtin: 'Built into Claude Code', plugin: 'From a plugin', other: 'From another source' };
  const groupOf = (a) => (a.scope && !a.enabled ? 'off' : a.source === 'project' || a.source === 'user' ? a.source : a.source === 'builtin' ? 'builtin' : 'other');

  let data = null;        // the last agents:list answer
  let loadedAt = 0;
  let stale = true;
  let seq = 0;
  let openId = null;      // the agent whose drawer is open
  let builtinOpen = false; // the roster redraws while agents work; a fold you opened stays open

  /** Without the main process's list (an older build, an error): what the session reports, read-only. */
  const fromSession = () => ({
    ok: false, sessionLoaded: !!state.agentsLoaded, pending: 0, workspace: { available: !!state.info?.cwd, trusted: !!state.info?.workspace?.trusted },
    scopes: { project: { available: false, writable: false }, user: { available: false, writable: false } },
    agents: (state.agentList || []).map((a) => {
      const builtin = JV.agentInfo(a).builtin;
      return { id: `session:${a.name}`, name: a.name, description: a.description || '', source: builtin ? 'builtin' : 'other', scope: null, file: null, enabled: true, editable: false, loads: true, inSession: true, pending: null, risks: [], problems: [], lock: builtin ? 'Built into Claude Code.' : null };
    }),
  });

  let demo = false; // a capture run's scripted roster stays up (see the end of this file)
  async function load(force) {
    if (demo) return;
    if (!force && !stale && data && Date.now() - loadedAt < 1500) return;
    const r = await api.agentsList?.().catch(() => null);
    data = r && r.ok ? r : fromSession();
    loadedAt = Date.now();
    stale = false;
  }
  JV.agentsData = () => data;

  // ------------------------------------------------------------- cards
  function flagsFor(a) {
    const out = [];
    if (a.pending === 'add') out.push(['New - reload to use', 'info', 'The running session started before this agent existed. Reload the session to use it.']);
    else if (a.pending === 'change') out.push(['Changed - reload to apply', 'info', 'The running session still has the version from when it started.']);
    else if (a.pending === 'remove') out.push(['Still loaded until reload', 'info', 'The running session started while this agent was on, so it can still use it until it is reloaded.']);
    if (a.shadowedBy) out.push(['Hidden here', 'muted', 'This workspace has its own agent of the same name, which Claude Code uses instead.']);
    if (a.scope === 'project' && data?.workspace && !data.workspace.trusted && a.enabled) out.push(['Not loaded', 'muted', 'This workspace is restricted, so Claude does not load its agents.']);
    for (const r of (a.risks || []).filter((x) => LOUD.includes(x)).slice(0, 2)) out.push([RISK[r][0], 'warn', RISK[r][1]]);
    if (a.problems?.length) out.push(['Needs attention', 'warn', a.problems.join('\n')]);
    return out;
  }

  function card(a) {
    const c = JV.agentCard(a, { onClick: openDrawer });
    c.dataset.agentId = a.id;
    if (a.id === openId) c.classList.add('sel');
    if (a.scope && (!a.enabled || !a.loads)) c.classList.add('dim');
    // "Standby" says ready to work. An agent the session does not have is not that.
    const st = c.querySelector('.acard-state');
    if (st && a.scope && a.inSession === false && !a.enabled) { st.textContent = 'Off'; st.classList.remove('st-standby'); }
    const flags = flagsFor(a);
    if (flags.length) {
      const row = el('div', 'acard-flags');
      for (const [text, kind, why] of flags) { const f = el('span', `aflag f-${kind}`, text); f.title = why; row.appendChild(f); }
      c.querySelector('.acard-txt')?.appendChild(row);
    }
    return c;
  }

  // ------------------------------------------------------------- the notes above the roster
  function drawNotes() {
    const box = $('agentsNote');
    box.replaceChildren();
    const ws = data?.workspace || {};
    const lines = [];
    if (!ws.available) lines.push('No workspace is chosen, so there are no workspace agents. Your own agents still work everywhere.');
    else if (!ws.trusted) lines.push('This workspace is restricted: its agents are listed but Claude does not load them, and JARVIS changes nothing in it. Your own agents still work here.');
    if (data?.scopes?.project?.truncated || data?.scopes?.user?.truncated) lines.push('There are more agent files than JARVIS lists; the first few hundred are shown.');
    for (const t of lines) box.appendChild(el('p', null, t));
    box.hidden = !lines.length;

    const bar = $('agentsReload');
    bar.replaceChildren();
    const n = data?.pending || 0;
    bar.hidden = !n;
    if (!n) return;
    bar.appendChild(JV.icon('refresh'));
    bar.appendChild(el('span', null, `${n} change${n === 1 ? '' : 's'} here ${n === 1 ? 'is' : 'are'} not in the running session yet. Claude Code reads the agents folders when a session starts, so reload it to pick ${n === 1 ? 'it' : 'them'} up - the conversation carries on.`));
    const b = el('button', 'btn btn-primary small', 'Reload session');
    b.type = 'button';
    b.onclick = () => reloadSession(b);
    bar.appendChild(b);
  }

  async function reloadSession(btn) {
    // Asked here as well as in the main process: the floor knows who is still at a desk.
    const working = JV.crew?.workingCount?.() || 0;
    if (working || state.status === 'working' || state.status === 'waiting') {
      JV.notify(working ? `${working} specialist${working === 1 ? ' is' : 's are'} still working. Reload once ${working === 1 ? 'it has' : 'they have'} finished - a reload would stop ${working === 1 ? 'it' : 'them'}.`
        : 'JARVIS is still working. Reload once it has finished.', { level: 'warn' });
      return;
    }
    if (btn) btn.disabled = true;
    const r = await api.agentsReload().catch((e) => ({ ok: false, error: String(e?.message || e) }));
    if (btn) btn.disabled = false;
    if (r.ok) JV.notify('Session reloaded in the same conversation - it is reading the agents folders again.', { level: 'ok' });
    else JV.notify(r.error || 'The session could not be reloaded.', { level: r.busy || r.notRunning ? 'warn' : 'err' });
  }
  JV.reloadAgentSession = reloadSession;

  // ------------------------------------------------------------- the roster
  function draw() {
    drawNotes();
    const box = $('agentAll');
    box.replaceChildren();
    const all = (data?.agents || []).slice().sort((a, b) => a.name.localeCompare(b.name));
    const mine = all.filter((a) => a.scope);
    const canMake = !!(data?.scopes?.project?.writable || data?.scopes?.user?.writable);
    $('agentNew').disabled = !data?.ok;
    $('agentTeam').disabled = !data?.ok || !data.workspace?.available;
    $('agentTeam').title = data?.workspace?.available ? 'Suggest a few specialists for the projects in this workspace. Nothing is created until you approve it.' : 'Choose a workspace first.';

    // No agents of your own is a normal state, not a broken page: JARVIS works with Claude
    // Code's built-in ones, and the box says what a specialist is and how to get one.
    if (!mine.length && !all.some((a) => groupOf(a) === 'other')) {
      const empty = el('div', 'agents-empty');
      empty.appendChild(el('b', null, 'No agents of your own yet - and JARVIS works fine without them'));
      empty.appendChild(el('p', null, 'Claude Code\'s built-in agents (below) explore, plan and do general work. A specialist is a Claude Code subagent you define for work you repeat - a reviewer, a test writer, an expert in one of your projects. It is one Markdown file, kept in this workspace or in your own Claude folder.'));
      if (data?.ok) {
        const acts = el('div', 'agents-empty-acts');
        const mk = (label, primary, fn, off) => { const b = el('button', `btn small${primary ? ' btn-primary' : ''}`, label); b.type = 'button'; b.disabled = !!off; b.onclick = fn; acts.appendChild(b); };
        mk('New agent', true, () => JV.agentBuilder?.create(), !canMake);
        mk('Build my team', false, () => JV.agentBuilder?.team(), !data.workspace?.available);
        mk('Ask JARVIS to draft one', false, () => JV.chat.insert('Draft a Claude Code subagent for this workspace in .claude/agents/ that '));
        empty.appendChild(acts);
      }
      box.appendChild(empty);
    }
    for (const [key, label, why] of GROUPS) {
      const list = all.filter((a) => groupOf(a) === key);
      if (!list.length) continue;
      const head = el('div', 'roster-head', label);
      head.title = why;
      head.appendChild(el('em', null, String(list.length)));
      const grid = el('div', 'agent-grid roster');
      for (const a of list) grid.appendChild(card(a));
      box.append(head, grid);
    }
    const bi = all.filter((a) => groupOf(a) === 'builtin');
    if (bi.length) {
      const more = el('details', 'roster-more');
      const sum = el('summary');
      sum.append(JV.icon('chevron'), el('span', null, `Built-in Claude agents (${bi.length})`));
      const grid = el('div', 'agent-grid roster');
      for (const a of bi) grid.appendChild(card(a));
      more.append(sum, grid);
      more.open = builtinOpen;
      more.addEventListener('toggle', () => { builtinOpen = more.open; });
      box.appendChild(more);
    } else if (!data?.sessionLoaded) {
      box.appendChild(el('div', 'muted empty', 'Claude Code\'s built-in agents are listed once the session is connected.'));
    }
    // The drawer follows its agent through a redraw, and closes when the agent is gone.
    if (openId && !$('agentDoc').hidden) {
      const still = all.find((a) => a.id === openId);
      if (!still) { $('agentDoc').hidden = true; openId = null; }
    }
  }

  async function render(force) {
    const mySeq = ++seq;
    await load(force);
    if (mySeq !== seq) return; // a newer redraw is on its way
    draw();
  }
  JV.renderAgentsPage = () => render(false);
  /** After anything changed on disk: read the folders again, and redraw the drawer if it is open. */
  JV.refreshAgents = async (focusId) => {
    stale = true;
    await render(true);
    const id = focusId || openId;
    const a = id && data?.agents.find((x) => x.id === id);
    if (a && (focusId || !$('agentDoc').hidden)) openDrawer(a);
  };
  JV.on('agents', () => { stale = true; if (state.view === 'agents') render(true); });

  // ------------------------------------------------------------- the drawer
  const actBtn = (label, icon, fn, { danger = false, primary = false, off = false, title = '' } = {}) => {
    const b = el('button', `btn small${danger ? ' btn-danger' : ''}${primary ? ' btn-primary' : ''}`);
    b.type = 'button';
    if (icon) b.appendChild(JV.icon(icon));
    b.appendChild(el('span', null, label));
    b.disabled = off;
    if (title) b.title = title;
    b.onclick = fn;
    return b;
  };

  async function openDrawer(a) {
    openId = a.id;
    const drawer = $('agentDoc');
    drawer.hidden = false;
    drawer.replaceChildren();
    document.querySelectorAll('#agentAll .acard').forEach((c) => c.classList.toggle('sel', c.dataset.agentId === a.id));
    const info = JV.agentInfo(a);

    const head = el('div', 'drawer-head');
    head.appendChild(el('b', null, info.code));
    head.appendChild(el('small', null, `${a.name} · ${SOURCE_WORD[a.source] || a.source}${a.scope && !a.enabled ? ' · switched off' : ''}`));
    const usable = a.inSession === true;
    head.appendChild(actBtn(`Hand a task to ${JV.clip(info.code, 24)}`, null, () => JV.chat.insert(`Use the ${a.name} agent to `), {
      primary: true, off: !usable,
      title: usable ? '' : a.inSession === null ? 'Available once the session is connected.' : 'The running session does not have this agent. Reload the session first.',
    }));
    const close = el('button', 'icon-btn');
    close.type = 'button';
    close.title = 'Close';
    close.appendChild(JV.icon('x'));
    close.onclick = () => { drawer.hidden = true; openId = null; };
    head.appendChild(close);
    drawer.appendChild(head);

    // What can be done with it. A built-in, a plugin's or a linked agent is someone else's to
    // manage: the row says so instead of offering buttons that would be refused.
    const acts = el('div', 'drawer-acts');
    if (a.scope) {
      const why = a.editable ? '' : a.lock || 'This agent cannot be changed here.';
      acts.appendChild(actBtn('Edit', 'edit', () => JV.agentBuilder.edit(a), { off: !a.editable, title: why }));
      acts.appendChild(actBtn('Duplicate', 'columns', () => JV.agentBuilder.duplicate(a), { title: 'A new agent that starts as a copy of this one.' }));
      acts.appendChild(actBtn(a.enabled ? 'Switch off' : 'Switch on', a.enabled ? 'stop' : 'play', () => toggle(a), { off: !a.editable, title: why || (a.enabled ? 'Claude Code stops loading it. The file is kept, renamed to .md.disabled.' : 'Claude Code loads it again.') }));
      acts.appendChild(actBtn('Delete', 'trash', () => remove(a), { danger: true, off: !a.editable, title: why }));
      if (a.scope === 'project' && a.enabled) acts.appendChild(actBtn('Open in VS Code', 'code', () => api.openInCode(`.claude/agents/${a.file}`)));
      if (!a.editable) acts.appendChild(el('small', 'drawer-lock', why));
    } else {
      acts.appendChild(el('small', 'drawer-lock', `${a.lock || 'Managed outside JARVIS.'}${a.source === 'builtin' || a.source === 'plugin' ? ' Claude Code can be told not to use it with a deny rule - "Agent(' + a.name + ')" under permissions.deny in a settings file - which JARVIS leaves for you to add.' : ''}`));
    }
    drawer.appendChild(acts);

    const facts = el('dl', 'kv drawer-facts');
    const fact = (k, node) => { facts.appendChild(el('dt', null, k)); const dd = el('dd'); dd.append(node); facts.appendChild(dd); };
    if (a.path) fact('File', a.path);
    if (a.model) fact('Model', { inherit: 'The same as the chat', sonnet: 'Sonnet', opus: 'Opus', haiku: 'Haiku', fable: 'Fable' }[a.model] || JV.prettyModel(a.model));
    if (a.scope) {
      const tools = el('div', 'tagcloud');
      if (a.tools === null) tools.appendChild(el('span', 'tag warn', 'Every tool the chat has'));
      else for (const t of a.tools || []) tools.appendChild(el('span', `tag${LOOKS.test(t) ? ' ro' : CHANGES.test(t) ? ' warn' : ''}`, t));
      fact('Tools', tools);
    }
    const risks = (a.risks || []).filter((r) => RISK[r]);
    if (risks.length) fact('Allows', risks.map((r) => RISK[r][1]).join(' '));
    if (a.otherKeys?.length) fact('Also set', `${a.otherKeys.join(', ')} - kept exactly as written in the file.`);
    if (a.problems?.length) { const p = el('div', 'drawer-problems'); for (const t of a.problems) p.appendChild(el('div', null, t)); fact('Check', p); }
    if (facts.children.length) drawer.appendChild(facts);

    const body = el('div', 'content reader-body');
    drawer.appendChild(body);
    if (a.scope) {
      body.textContent = 'Loading…';
      const r = await api.agentRead(a.scope, a.file).catch(() => null);
      if (openId !== a.id) return;
      body.textContent = '';
      if (r?.ok) JV.renderMarkdown(body, `${a.description ? `> ${a.description.replace(/\n/g, '\n> ')}\n\n` : ''}${r.agent.body || '_This agent has no instructions._'}`);
      else body.appendChild(el('div', 'muted', r?.error || 'The agent file could not be read.'));
    } else {
      JV.renderMarkdown(body, a.description || 'A Claude Code agent.');
    }
    drawer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  const USER_FOLDER = 'This changes a file in your own Claude folder, which every workspace - and Claude Code in the terminal and VS Code - reads.';

  async function toggle(a) {
    const on = !a.enabled;
    if (a.scope === 'user' && !(await JV.ask({ title: on ? `Switch on ${a.name}?` : `Switch off ${a.name}?`, lines: [USER_FOLDER, `${a.path} is renamed so that Claude Code ${on ? 'loads it again' : 'no longer loads it'}.`], yes: on ? 'Switch on' : 'Switch off' }))) return;
    const r = await api.agentSetEnabled({ scope: a.scope, file: a.file }, on, { approveUserScope: a.scope === 'user' });
    if (!r.ok) { JV.notify(r.error || 'That could not be changed.', { level: 'err' }); return; }
    JV.notify(`${a.name} is switched ${on ? 'on' : 'off'}. Reload the session for the chat to notice.`, { level: 'ok' });
    await JV.refreshAgents(`${a.scope}:${r.file}`);
  }

  async function remove(a) {
    const yes = await JV.ask({
      title: `Delete ${a.name}?`,
      lines: [`${a.path} is removed${a.scope === 'user' ? ' from your own Claude folder, for every workspace' : ' from this workspace'}.`, 'JARVIS keeps a copy in its own data folder, in case it was a mistake.'],
      yes: 'Delete agent', danger: true,
    });
    if (!yes) return;
    const r = await api.agentDelete({ scope: a.scope, file: a.file, expect: a.hash }, { confirmed: true });
    if (!r.ok) { JV.notify(r.error || 'The agent could not be deleted.', { level: 'err' }); return; }
    JV.notify(`${a.name} was deleted.`, { level: 'ok' });
    $('agentDoc').hidden = true;
    openId = null;
    await JV.refreshAgents();
  }

  $('agentNew').onclick = () => JV.agentBuilder?.create();
  $('agentTeam').onclick = () => JV.agentBuilder?.team();

  // ------------------------------------------------------------- capture demo (JARVIS_DEMO=agents)
  // A made-up roster as a connected session would show it - one agent just created, one
  // edited, one switched off, the built-ins - for a screenshot without a signed-in session.
  const earlier = window.__jarvisDemo;
  window.__jarvisDemo = (what) => {
    if (what !== 'agents') { earlier?.(what); return; }
    const file = (scope, name, description, over = {}) => ({
      id: `${scope}:${name}.md`, name, description, model: null, tools: ['Read', 'Grep', 'Glob'], source: scope, scope, file: `${name}.md`,
      path: `${scope === 'user' ? '~/.claude/agents' : '.claude/agents'}/${name}.md`, enabled: true, editable: true, lock: null, loads: true,
      shadowedBy: null, inSession: true, pending: null, risks: [], problems: [], otherKeys: [], hash: 'demo', ...over,
    });
    const live = (name, description, source) => ({ id: `session:${name}`, name, description, source, scope: null, file: null, path: null, enabled: true, editable: false, lock: source === 'builtin' ? 'Built into Claude Code.' : 'Provided by a Claude Code plugin - managed by that plugin.', loads: true, inSession: true, pending: null, risks: [], problems: [], otherKeys: [] });
    demo = true;
    data = {
      ok: true, sessionLoaded: true, pending: 2, workspace: { available: true, trusted: true },
      scopes: { project: { available: true, writable: true, dir: '.claude/agents' }, user: { available: true, writable: true, dir: '~/.claude/agents' } },
      agents: [
        file('project', 'flutter-developer', 'Builds and changes Flutter and Dart code: widgets, state, navigation and packages.', { tools: ['Read', 'Grep', 'Glob', 'Edit', 'Bash'], risks: ['runs-commands', 'edits-files'] }),
        file('project', 'widget-tester', 'Writes and reviews Flutter widget, unit and integration tests.', { inSession: false, pending: 'add' }),
        file('project', 'api-tester', 'Designs and reviews tests for HTTP APIs: status codes, validation and authorization.', { pending: 'change' }),
        file('user', 'code-reviewer', 'Reviews code for correctness, clarity and maintainability. Use after writing or changing code.'),
        file('user', 'debugger', 'Finds the root cause of a bug, error message or failing test.', { enabled: false, loads: false, inSession: false, file: 'debugger.md.disabled' }),
        live('toolkit:release-notes', 'Drafts release notes from the commits since the last tag.', 'plugin'),
        ...['general-purpose', 'Explore', 'Plan', 'claude-code-guide', 'statusline-setup', 'claude'].map((n) => live(n, 'A built-in Claude Code agent.', 'builtin')),
      ],
    };
    state.agentList = data.agents.filter((a) => a.inSession).map((a) => ({ name: a.name, description: a.description }));
    state.agentsLoaded = true;
    builtinOpen = true;
    draw();
    if ($('crewBench')) { $('crewBench').dataset.sig = ''; JV.emit('view', state.view); }
  };
})();
