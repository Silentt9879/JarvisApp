/* The Agents floor: every specialist JARVIS sends out appears as a little minion at a desk while
   it works - a speech bubble says what it is doing right now (reading a file, running a build),
   with a live timer, its tool count and its last few steps. Finished ones stay a while, idle
   ones doze on the bench. The model is crew-model.js; this file only draws it.

   Desks are built once per run and updated in place, so a busy agent's dozens of events cost a
   few text changes, not a redraw. All text goes in through textContent; the SVG is fixed markup. */
(() => {
  'use strict';
  const { $, el, state } = JV;
  const crew = window.CrewModel.createCrew();
  JV.crew = crew;

  // ------------------------------------------------------------- the minion (fixed markup)
  // Yellow like a minion; the overalls take the agent's own colour (--hue).
  const MINION = `
    <g class="mn-body">
      <rect class="mn-leg" x="30" y="61" width="7" height="11" rx="3"/>
      <rect class="mn-leg" x="43" y="61" width="7" height="11" rx="3"/>
      <path class="mn-arm mn-arm-l" d="M24 44 q-9 5 -5 13"/>
      <path class="mn-arm mn-arm-r" d="M56 44 q9 5 5 13"/>
      <rect class="mn-skin" x="22" y="8" width="36" height="57" rx="18"/>
      <path class="mn-suit" d="M22 45 H58 V47 a18 18 0 0 1 -36 0 Z"/>
      <rect class="mn-pocket" x="34" y="50" width="12" height="7" rx="2"/>
      <path class="mn-hair" d="M37 9 l-2 -5 M40 8 V2 M43 9 l2 -5"/>
      <rect class="mn-strap" x="21" y="24" width="38" height="6" rx="2"/>
      <circle class="mn-rim" cx="40" cy="27" r="11"/>
      <circle class="mn-eye" cx="40" cy="27" r="8"/>
      <g class="mn-pupil"><circle class="mn-iris" cx="40" cy="28" r="3.6"/><circle class="mn-glint" cx="41.4" cy="26.6" r="1.1"/></g>
      <rect class="mn-lid" x="31" y="18.5" width="18" height="17" rx="8"/>
      <path class="mn-mouth" d="M34 41 q6 4.5 12 0"/>
      <g class="mn-zz"><text x="58" y="12">z</text><text x="64" y="6">z</text></g>
      <circle class="mn-done" cx="58" cy="12" r="7"/><path class="mn-tick" d="M54.6 12.2 l2.3 2.3 4.4 -4.6"/>
    </g>`;
  const LAPTOP = `
    <rect class="lp-desk" x="2" y="22" width="76" height="6" rx="3"/>
    <path class="lp-lid" d="M20 3 h40 l-3 18 h-34 z"/>
    <circle class="lp-logo" cx="40" cy="12" r="2.2"/>
    <rect class="lp-base" x="14" y="20" width="52" height="3" rx="1.5"/>`;
  const svg = (cls, viewBox, markup) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('class', cls);
    s.setAttribute('viewBox', viewBox);
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = markup; // fixed markup above, never data
    return s;
  };
  const minion = (cls = '') => svg(`mn ${cls}`.trim(), '0 0 80 76', MINION);

  // The bubble's icon for what the minion is doing.
  const ACT_ICON = {
    read: 'file', edit: 'edit', run: 'code', search: 'search', web: 'globe', agent: 'agents',
    plan: 'tasks', skill: 'spark', tool: 'tools', think: 'bulb', done: 'check', failed: 'alert', stopped: 'stop',
  };

  // ------------------------------------------------------------- minion names
  // Every specialist is a minion with a name of its own (the specialist code stays beside it).
  // Fixed, so Otto is always the Admin Web one; an agent added later gets one from the pool.
  const MINION_NAMES = {
    commander: 'Kevin', scout: 'Stuart', friday: 'Bob', diagnostic: 'Dave', verifier: 'Jerry',
    gatekeeper: 'Carl', control: 'Phil', underwriter: 'Tim', roadrunner: 'Mark', edith: 'Jorge',
    'codebase-learner': 'Tom', auditor: 'Mel', sentry: 'Otto',
    archivist: 'Josh', taskmaster: 'Tony', scribe: 'Eric',
    'general-purpose': 'Norbert', Explore: 'Lance', Plan: 'Ken', claude: 'Mike',
    'statusline-setup': 'Paul', 'claude-code-guide': 'Donnie',
  };
  const NAME_POOL = ['Steve', 'Larry', 'Chris', 'Jon', 'Henry', 'Walter', 'Herb', 'Bernard', 'Pete', 'Frank', 'Gus', 'Ned'];
  JV.minionName = (agent) => {
    if (MINION_NAMES[agent]) return MINION_NAMES[agent];
    let h = 0;
    for (const ch of String(agent || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return NAME_POOL[h % NAME_POOL.length];
  };

  // ------------------------------------------------------------- helpers
  const info = (name) => JV.agentInfo({ name, description: (state.agentList || []).find((a) => a.name === name)?.description || '' });
  const mmss = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return s >= 3600 ? `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
      : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const ago = (t) => {
    const m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? 'just now' : m === 1 ? '1 min ago' : `${m} min ago`;
  };
  const kTokens = (n) => (n == null ? '' : n >= 1000 ? `${Math.round(n / 1000)}k tokens` : `${n} tokens`);

  // ------------------------------------------------------------- one desk
  const desks = new Map(); // run id -> { root, refs }

  function makeDesk(r) {
    const i = info(r.agent);
    const root = el('div', 'desk');
    root.style.setProperty('--hue', i.hue);
    root.tabIndex = 0;
    root.setAttribute('role', 'button');
    root.title = 'Show every step';

    const stage = el('div', 'desk-stage');
    const bubble = el('div', 'desk-bubble');
    const bIco = el('span', 'desk-bubble-ico');
    const bText = el('span', 'desk-bubble-text');
    bubble.append(bIco, bText);
    const think = el('div', 'desk-think');
    think.append(el('i'), el('i'), el('i'));
    stage.append(bubble, think, minion(), svg('lp', '0 0 80 30', LAPTOP));

    const infoBox = el('div', 'desk-info');
    const nameRow = el('div', 'desk-name');
    nameRow.appendChild(el('b', null, JV.minionName(r.agent)));
    nameRow.appendChild(el('span', 'desk-code', i.code));
    const bg = el('em', 'desk-tag', 'background');
    nameRow.appendChild(bg);
    const task = el('div', 'desk-task', r.task || i.role || '');
    task.title = r.task || '';
    const meta = el('div', 'desk-meta');
    const timer = el('span', 'desk-timer');
    const tools = el('span');
    const tokens = el('span');
    meta.append(timer, tools, tokens);
    infoBox.append(nameRow, task, meta);

    const trail = el('ol', 'desk-trail');
    const summary = el('div', 'desk-summary');
    root.append(stage, infoBox, trail, summary);

    const toggle = () => { root.classList.toggle('open'); paint(r.id); };
    root.onclick = toggle;
    root.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } };

    const d = { root, bIco, bText, bg, timer, tools, tokens, trail, summary, lastAct: null, stepsShown: -1 };
    desks.set(r.id, d);
    return d;
  }

  function stepRow(s) {
    const li = el('li', `st-${s.state}`);
    li.appendChild(JV.icon(ACT_ICON[s.act.kind] || 'tools'));
    const t = el('span', null, s.act.text);
    t.title = `${s.name}  ${s.detail}`;
    li.appendChild(t);
    return li;
  }

  /** Update one desk from its run. */
  function paint(id) {
    const r = crew.runs.get(id);
    const d = desks.get(id);
    if (!r || !d) return;
    const now = crew.doing(r);
    d.root.dataset.state = r.status;
    d.root.dataset.act = now.kind;
    if (d.lastAct !== `${now.kind}|${now.text}`) {
      d.lastAct = `${now.kind}|${now.text}`;
      d.bIco.replaceChildren(JV.icon(ACT_ICON[now.kind] || 'tools'));
      d.bText.textContent = now.text;
      d.bText.title = now.text;
    }
    d.bg.hidden = !r.background;
    d.tools.textContent = r.toolUses ? `${r.toolUses} tool${r.toolUses === 1 ? '' : 's'}` : '';
    d.tokens.textContent = kTokens(r.tokens);
    tick(r, d);

    // The trail: the last four steps, or every kept step when the desk is open.
    const open = d.root.classList.contains('open');
    const want = open ? r.steps : r.steps.slice(-4);
    const sig = `${open}|${r.stepCount}|${want.map((s) => s.state).join('')}`;
    if (sig !== d.stepsShown) {
      d.stepsShown = sig;
      d.trail.replaceChildren(...want.map(stepRow));
      if (!want.length) d.trail.appendChild(el('li', 'st-none', r.status === 'working' ? 'Reading the brief…' : 'No steps recorded.'));
      if (open && r.stepCount > r.steps.length) d.trail.prepend(el('li', 'st-none', `${r.stepCount - r.steps.length} earlier steps not kept`));
      if (open) d.trail.scrollTop = d.trail.scrollHeight;
    }
    d.summary.textContent = r.status !== 'working' && r.summary ? JV.clip(r.summary.replace(/\s+/g, ' '), 220) : '';
  }

  function tick(r, d) {
    d.timer.textContent = r.status === 'working'
      ? `${mmss(Date.now() - r.startedAt)}`
      : `${mmss(r.endedAt - r.startedAt)} · ${ago(r.endedAt)}`;
  }

  // ------------------------------------------------------------- the floor
  function render() {
    const box = $('crew');
    if (!box) return;
    const { working, ended } = crew.list();
    const shown = [...working, ...ended.slice(0, 6)];
    const keep = new Set(shown.map((r) => r.id));
    for (const [id, d] of desks) if (!keep.has(id)) { d.root.remove(); desks.delete(id); }

    $('crewCount').textContent = working.length
      ? `${working.length} working${ended.length ? ` · ${ended.length} finished recently` : ''}`
      : ended.length ? `${ended.length} finished recently` : 'Nobody is working right now';
    box.classList.toggle('busy', working.length > 0);

    const floor = $('crewFloor');
    shown.forEach((r, idx) => {
      const d = desks.get(r.id) || makeDesk(r);
      if (floor.children[idx] !== d.root) floor.insertBefore(d.root, floor.children[idx] || null);
      paint(r.id);
    });
    $('crewEmpty').hidden = shown.length > 0;
    renderBench(working);
  }

  /** Idle specialists doze on the bench; the ones out working are not on it. */
  function renderBench(working) {
    const bench = $('crewBench');
    const busy = new Set(working.map((r) => r.agent));
    const idle = JV.customAgents().filter((a) => !busy.has(a.name)).sort((a, b) => a.name.localeCompare(b.name));
    const sig = idle.map((a) => a.name).join(',');
    if (bench.dataset.sig === sig) return;
    bench.dataset.sig = sig;
    bench.replaceChildren();
    for (const a of idle) {
      const i = info(a.name);
      const seat = el('div', 'bench-seat');
      seat.style.setProperty('--hue', i.hue);
      seat.title = `${JV.minionName(a.name)} - ${i.code}, ${i.role}. Resting.`;
      const label = el('span', 'bench-name');
      label.append(el('b', null, JV.minionName(a.name)), el('small', null, i.code));
      seat.append(minion('mn-sleep'), label);
      bench.appendChild(seat);
    }
    bench.hidden = !idle.length;
  }

  // Keep "who is working" in state for the cards, the nav badge and the Overview.
  function syncActive() {
    const before = JSON.stringify([...state.agentActive]);
    state.agentActive.clear();
    for (const r of crew.runs.values()) if (r.status === 'working') state.agentActive.set(r.agent, (state.agentActive.get(r.agent) || 0) + 1);
    return before !== JSON.stringify([...state.agentActive]);
  }

  // ------------------------------------------------------------- the chat bar's agents pill
  // "N agents" beside the model pill; its panel lists who is working and on what, without
  // leaving the chat. A row opens that agent's desk on the floor.
  function renderPill() {
    const btn = $('agentsBtn');
    if (!btn) return;
    const n = crew.workingCount();
    $('agentsCount').textContent = `${n} agent${n === 1 ? '' : 's'}`;
    btn.classList.toggle('live', n > 0);
    btn.title = n ? `${n} specialist${n === 1 ? '' : 's'} working - click to watch` : 'No specialists working right now';
  }

  function popRow(r) {
    const i = info(r.agent);
    const now = crew.doing(r);
    const row = el('button', 'ap-row');
    row.type = 'button';
    row.dataset.state = r.status;
    row.dataset.act = now.kind;
    row.style.setProperty('--hue', i.hue);
    const txt = el('span', 'ap-txt');
    const who = el('b', null, JV.minionName(r.agent));
    who.appendChild(el('em', null, i.code));
    txt.append(who, el('small', null, now.text));
    const time = el('span', 'ap-time', r.status === 'working' ? mmss(Date.now() - r.startedAt)
      : r.status === 'done' ? `done ${ago(r.endedAt)}` : r.status);
    row.append(minion(), txt, time);
    row.title = r.task ? `${i.code}: ${r.task}` : i.code;
    row.onclick = () => {
      $('agentsPop').hidden = true;
      JV.show('agents');
      requestAnimationFrame(() => {
        const d = desks.get(r.id);
        if (!d) return;
        d.root.classList.add('open');
        paint(r.id);
        d.root.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    };
    return row;
  }

  function renderPop() {
    const pop = $('agentsPop');
    if (!pop || pop.hidden) return;
    const { working, ended } = crew.list();
    const list = $('agentsPopList');
    list.replaceChildren();
    if (!working.length && !ended.length) {
      list.appendChild(el('div', 'pop-note', 'No specialists working right now. When JARVIS hands one a task, it shows up here.'));
      return;
    }
    for (const r of working) list.appendChild(popRow(r));
    if (ended.length) {
      list.appendChild(el('div', 'pop-sec', 'Finished recently'));
      for (const r of ended.slice(0, 3)) list.appendChild(popRow(r));
    }
  }

  $('agentsBtn').onclick = () => { const p = $('agentsPop'); p.hidden = !p.hidden; renderPop(); };
  $('agentsOpenFloor').onclick = () => { $('agentsPop').hidden = true; JV.show('agents'); };
  JV.registerPop($('agentsPop'), $('agentsBtn'));
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !$('agentsPop').hidden) $('agentsPop').hidden = true; });

  let frame = 0;
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      renderPill();
      renderPop();
      if (state.view === 'agents') render();
    });
  };

  // Announce a background agent's end: its Agent call said "launched" long ago, so nothing else will.
  function announce(e) {
    if (e.kind !== 'agent_task' || e.phase !== 'done') return;
    const r = crew.runs.get(e.toolUseId) || [...crew.runs.values()].find((x) => x.id === `task:${e.taskId}`);
    if (!r || !r.background) return;
    const i = info(r.agent);
    const ok = r.status === 'done';
    JV.feed?.({ level: ok ? 'ok' : 'err', title: `${JV.minionName(r.agent)} (${i.code}) ${ok ? 'finished' : r.status === 'stopped' ? 'was stopped' : 'hit a problem'}`, sub: JV.clip(r.task, 70), action: 'agents' });
  }

  for (const kind of ['tool_use', 'tool_result', 'agent_task', 'status', 'session_reset']) {
    JV.on(kind, (e) => {
      if (!crew.ingest(kind === 'session_reset' ? { kind } : e)) return;
      announce(e || {});
      if (syncActive()) JV.emit('agents_changed');
      schedule();
    });
  }
  JV.on('view', (v) => { if (v === 'agents') render(); });
  JV.on('agents', () => { if (state.view === 'agents') { $('crewBench').dataset.sig = ''; render(); } });

  // Timers: once a second, only for what is on screen - the floor, or the pill's open panel.
  setInterval(() => {
    if (document.hidden) return;
    if (!$('agentsPop').hidden) renderPop();
    if (state.view !== 'agents') return;
    for (const [id, d] of desks) { const r = crew.runs.get(id); if (r) tick(r, d); }
  }, 1000);
  renderPill();

  // ------------------------------------------------------------- capture demo (JARVIS_DEMO=crew)
  // A scripted few seconds of three specialists at work, for screenshots without a real run.
  window.__jarvisDemo = (what) => {
    if (what !== 'crew') return;
    const feed = (e) => { JV.emit(e.kind, e); };
    const t0 = Date.now();
    const agentsOf = (state.agentList || []).map((a) => a.name);
    const pick = (n, alt) => (agentsOf.includes(n) ? n : alt);
    feed({ kind: 'tool_use', id: 'demo-a', name: 'Agent', agent: pick('sentry', 'general-purpose'), agentTask: 'Approval pages: tabs and UX', parent: null });
    feed({ kind: 'agent_task', phase: 'started', taskId: 'ta', toolUseId: 'demo-a', background: true });
    feed({ kind: 'tool_result', id: 'demo-a', preview: 'Async agent launched successfully.', parent: null });
    feed({ kind: 'tool_use', id: 'demo-b', name: 'Agent', agent: pick('friday', 'Explore'), agentTask: 'Hunt bugs: account and money', parent: null });
    feed({ kind: 'tool_use', id: 'demo-c', name: 'Agent', agent: pick('verifier', 'Plan'), agentTask: 'Build and test the Panel App change', parent: null });
    // Background, so the session's own startup "ready" cannot close them mid-capture.
    feed({ kind: 'agent_task', phase: 'started', taskId: 'tb', toolUseId: 'demo-b', background: true });
    feed({ kind: 'agent_task', phase: 'started', taskId: 'tc', toolUseId: 'demo-c', background: true });
    const steps = [
      ['demo-a', 'Read', 'C:\\repo\\Controllers\\ApprovalController.cs'], ['demo-b', 'Grep', 'loginByPhoneMail  in lib'],
      ['demo-c', 'Bash', 'dotnet build -c Release'], ['demo-a', 'Edit', 'C:\\repo\\Views\\Approval\\ApprovalWorkshop.cshtml'],
      ['demo-b', 'Read', 'C:\\repo\\lib\\Services\\HttpService.dart'], ['demo-c', 'Bash', 'flutter test test/insurance_panel_request_test.dart'],
    ];
    steps.forEach(([parent, name, detail], k) => {
      feed({ kind: 'tool_use', id: `s${k}`, name, detail, parent });
      if (k < 3) feed({ kind: 'tool_result', id: `s${k}`, parent, isError: false });
    });
    feed({ kind: 'agent_task', phase: 'progress', taskId: 'ta', toolUseId: 'demo-a', toolUses: 41, tokens: 52300 });
    // Back-date the runs so the timers read like a real afternoon.
    for (const [id, mins] of [['demo-a', 7.5], ['demo-b', 3.2], ['demo-c', 1.1]]) { const r = crew.runs.get(id); if (r) r.startedAt = t0 - mins * 60e3; }
    feed({ kind: 'tool_use', id: 'demo-d', name: 'Agent', agent: pick('scout', 'general-purpose'), agentTask: 'Trace backend auth and authorization', parent: null });
    feed({ kind: 'tool_use', id: 's9', name: 'Grep', detail: 'getByUserID', parent: 'demo-d' });
    feed({ kind: 'tool_result', id: 's9', parent: 'demo-d' });
    feed({ kind: 'tool_result', id: 'demo-d', preview: 'Bottom line: the server does not tie a customer session to a person.', parent: null });
    const d = crew.runs.get('demo-d'); if (d) { d.startedAt = t0 - 6.7 * 60e3; d.endedAt = t0 - 60e3; d.toolUses = 109; }
    render();
    renderPill();
  };
})();
