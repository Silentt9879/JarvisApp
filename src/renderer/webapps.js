/* JARVIS window - the ASP.NET sites and APIs: `dotnet watch run` with its console here,
   and the site itself in your own browser. A compact column beside the phones, because a
   web app belongs in a browser with its dev tools, not in a panel.

   Each card says, in plain words, what state the project is in and what to do next:
   its address before it starts, "running elsewhere" when a terminal or Visual Studio
   already has it (Run would only collide), and why it did not start when it fails. */
(() => {
  'use strict';
  const { $, el } = JV;

  const cards = new Map(); // key -> card
  const MAX_LOG_LINES = 600;
  let visible = false;

  const short = (url) => String(url || '').replace(/^https?:\/\//, '');
  const clock = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}:${String(s % 60).padStart(2, '0')}`;
  };

  function iconButton(cls, icon, text, title) {
    const b = el('button', `btn ${cls}`);
    b.type = 'button';
    b.appendChild(JV.icon(icon));
    b.appendChild(el('span', null, text));
    if (title) b.title = title;
    return b;
  }

  function makeCard(a) {
    const c = { key: a.key, name: a.name, info: a, run: null, logCount: 0, opened: false, failed: null, note: null };
    c.root = el('div', 'web-card');
    c.root.dataset.app = a.key;

    // --- who and where
    const head = el('div', 'web-head');
    const badge = el('span', 'app-badge');
    badge.title = a.kind === 'api' ? 'An API - no pages to look at' : 'A website';
    badge.appendChild(JV.icon(a.kind === 'api' ? 'server' : 'globe'));
    head.appendChild(badge);
    const id = el('div', 'web-id');
    id.appendChild(el('b', null, a.name));
    c.addr = el('small', 'web-addr');
    c.addr.title = a.dir;
    id.appendChild(c.addr);
    head.appendChild(id);
    c.state = el('span', 'pill');
    head.appendChild(c.state);
    c.root.appendChild(head);

    // --- what running it touches, and how it runs - before anything starts
    const meta = el('div', 'web-meta');
    if (a.warn) {
      const tag = el('span', 'web-tag warn');
      tag.appendChild(JV.icon('alert'));
      tag.appendChild(el('span', null, a.warn));
      tag.title = a.key === 'insurapi'
        ? 'On this machine it uses the shared database and starts its reminder jobs, which send real push notifications.'
        : 'On localhost this site reads and writes the live data through the deployed API.';
      meta.appendChild(tag);
    }
    c.watchBox = el('input');
    c.watchBox.type = 'checkbox';
    c.watchBox.checked = true;
    const watch = el('label', 'switch web-watch');
    watch.title = 'dotnet watch: rebuilds and reloads when you save a file. Off: plain dotnet run.';
    watch.appendChild(c.watchBox);
    watch.appendChild(el('span', 'track'));
    watch.appendChild(el('span', null, 'Hot reload'));
    meta.appendChild(watch);
    c.root.appendChild(meta);

    // --- the one sentence that says what is going on, or what went wrong
    c.noteEl = el('div', 'web-note');
    c.root.appendChild(c.noteEl);

    // --- actions
    const actions = el('div', 'web-actions');
    c.runBtn = iconButton('btn-primary web-run', 'play', 'Run');
    c.runBtn.id = `webRun-${a.key}`;
    c.runBtn.onclick = () => (active(c) ? stop(c) : start(c));
    actions.appendChild(c.runBtn);

    c.openBtn = iconButton('web-open', 'external', 'Open', 'Open in your browser');
    c.openBtn.id = `webOpen-${a.key}`;
    c.openBtn.onclick = () => { const u = c.run?.url || c.info.external?.url; if (u) window.jarvis.openUrl(u); };
    actions.appendChild(c.openBtn);

    c.logBtn = iconButton('btn-ghost web-logbtn', 'chevron', 'Log', 'Show the dotnet output');
    c.logBtn.id = `webLog-${a.key}`;
    c.logBtn.onclick = () => showLog(c, !c.root.classList.contains('show-log'));
    actions.appendChild(c.logBtn);
    c.root.appendChild(actions);

    c.log = el('pre', 'web-log');
    c.root.appendChild(c.log);
    render(c);
    return c;
  }

  const active = (c) => !!c.run && c.run.state !== 'exited';

  function showLog(c, on) {
    c.root.classList.toggle('show-log', on);
    c.logBtn.querySelector('span').textContent = on ? 'Hide log' : 'Log';
    if (on) c.log.scrollTop = c.log.scrollHeight;
  }

  function note(c, text, tone) {
    c.noteEl.textContent = text || '';
    c.noteEl.className = `web-note${tone ? ` ${tone}` : ''}`;
  }

  /** One place decides what the card shows, from the run (if any) and what was found. */
  function render(c) {
    const a = c.info;
    const r = c.run;
    const ext = !active(c) && a.external;
    let pill = 'Stopped';
    let tone = '';
    let state = 'idle';

    if (!a.found) { state = 'missing'; pill = 'Not found'; }
    else if (ext) { state = 'external'; pill = 'Running elsewhere'; tone = 'accent'; }
    else if (r?.state === 'building') { state = 'building'; pill = `Starting · ${clock(Date.now() - (r.started || r.since))}`; tone = 'busy'; }
    else if (r?.state === 'running') { state = 'running'; pill = r.watch ? 'Running · hot reload' : 'Running'; tone = 'ok'; }
    else if (r?.state === 'failed' || c.failed) { state = 'failed'; pill = "Didn't start"; tone = 'bad'; }

    c.root.dataset.state = state;
    c.state.textContent = pill;
    c.state.className = `pill ${tone}`;

    // The address: where it IS listening, or where it will.
    const where = r?.url || (ext && a.external.url) || a.planned?.url || '';
    c.addr.textContent = where ? `${short(where)} · ${a.dir}` : a.dir;

    // What to do next, in words.
    if (state === 'missing') note(c, `The project file is not in the workspace (${a.dir}).`, 'err');
    else if (state === 'external') {
      const o = a.external.owner;
      note(c, `Already running on ${short(a.external.url)}${o ? ` (${o.name}, PID ${o.pid})` : ''} - started outside JARVIS, in a terminal or Visual Studio. Open it here, or stop that copy to run it from JARVIS.`, 'info');
    } else if (state === 'building') note(c, r.watch ? 'Building with dotnet watch… the page opens in your browser when it is ready.' : 'Building with dotnet run…', '');
    else if (state === 'failed') note(c, (r?.state === 'failed' ? r.problem : c.failed) || 'It did not start - the reason is in the log.', 'err');
    else if (c.note) note(c, c.note.text, c.note.tone);
    else note(c, '', '');

    // Buttons follow the state.
    const running = active(c);
    c.runBtn.replaceChildren(JV.icon(running ? 'stop' : 'play'), el('span', null, running ? 'Stop' : 'Run'));
    c.runBtn.className = `btn web-run ${running ? 'btn-danger' : 'btn-primary'}`;
    c.runBtn.disabled = !a.found || (!running && !!ext);
    c.runBtn.title = ext ? 'It is already running somewhere else - stop that copy first.' : '';
    c.openBtn.disabled = !(r?.url || ext);
    c.watchBox.disabled = running;
    c.root.classList.toggle('running', state === 'running');
  }

  async function start(c) {
    c.log.replaceChildren();
    c.logCount = 0;
    c.opened = false;
    c.failed = null;
    c.note = null;
    showLog(c, false);
    c.state.textContent = 'Starting…';
    c.state.className = 'pill busy';
    c.runBtn.disabled = true;
    const r = await window.jarvis.webRun(c.key, c.watchBox.checked);
    if (!r?.ok) {
      if (r?.code === 'PORT_IN_USE') { await refresh(); return; }   // shows "running elsewhere"
      c.failed = r?.error || 'Could not start dotnet.';
      append(c, [{ level: 'error', text: c.failed }]);
      render(c);
      return;
    }
    c.run = r.run;
    render(c);
    tick();
  }

  async function stop(c) {
    const r = await window.jarvis.webStop(c.key);
    if (!r?.ok) append(c, [{ level: 'error', text: r?.error || 'Could not stop it.' }]);
  }

  function append(c, lines) {
    const atBottom = c.log.scrollHeight - c.log.scrollTop - c.log.clientHeight < 30;
    for (const l of lines) {
      c.log.appendChild(el('div', `l-${l.level || 'info'}`, l.text));
      c.logCount++;
    }
    while (c.logCount > MAX_LOG_LINES) { c.log.firstChild?.remove(); c.logCount--; }
    if (atBottom) c.log.scrollTop = c.log.scrollHeight;
  }

  /** Section header: how many JARVIS is running, and Stop all. */
  function renderHeader() {
    const mine = [...cards.values()].filter(active);
    const elsewhere = [...cards.values()].filter((c) => !active(c) && c.info.external);
    const parts = [];
    if (mine.length) parts.push(`${mine.length} running`);
    if (elsewhere.length) parts.push(`${elsewhere.length} elsewhere`);
    $('webCount').textContent = parts.join(' · ');
    $('webCount').hidden = !parts.length;
    $('webStopAll').hidden = !mine.length;
  }

  // A one-second clock only while something is starting and the view is on screen.
  let timer = null;
  function tick() {
    const starting = [...cards.values()].some((c) => c.run?.state === 'building');
    if (!starting || !visible || document.hidden) { clearInterval(timer); timer = null; return; }
    if (!timer) timer = setInterval(() => { for (const c of cards.values()) if (c.run?.state === 'building') render(c); tick(); }, 1000);
  }

  JV.on('web_state', (e) => {
    const c = cards.get(e.key);
    if (!c) return;
    c.run = { key: e.key, name: e.name, state: e.state, url: e.url, since: e.since, started: e.started, watch: e.watch, problem: e.problem };
    if (e.state === 'running') { c.failed = null; c.info.external = null; }
    if (e.state === 'failed') showLog(c, true);
    if (e.state === 'exited') {
      c.opened = false;
      if (e.failed) { c.failed = e.problem || 'It stopped before it started listening.'; showLog(c, true); }
      else { c.failed = null; c.note = { text: 'Stopped.', tone: '' }; }
    }
    render(c);
    renderHeader();
    tick();
    if (e.state === 'running' && e.url && !c.opened) {
      // The site opens in the real browser once, when it first starts listening - a restart
      // from hot reload does not throw another window at you.
      c.opened = true;
      window.jarvis.openUrl(e.url);
      JV.feed?.({ level: 'ok', title: `${e.name} is running`, sub: `${e.url} · opened in your browser`, action: 'devices' });
    }
    if (e.state === 'failed') JV.feed?.({ level: 'err', title: `${e.name} did not start`, sub: e.problem || '', action: 'devices' });
    if (e.state === 'exited') {
      JV.feed?.({ level: e.failed ? 'err' : 'info', title: e.failed ? `${e.name} did not start` : `${e.name} stopped`, sub: e.failed ? (e.problem || '') : '', action: 'devices' });
    }
  });
  JV.on('web_log', (e) => { const c = cards.get(e.key); if (c) append(c, e.lines); });

  /** Re-read what was found and what is running elsewhere; JARVIS's own runs stay as they are. */
  async function refresh() {
    let list = [];
    try { list = await window.jarvis.webApps(); } catch { return; }
    const grid = $('webGrid');
    for (const a of list) {
      let c = cards.get(a.key);
      if (!c) {
        c = makeCard(a);
        cards.set(a.key, c);
        grid.appendChild(c.root);
        if (a.run) { // still running from an earlier visit to this view
          c.run = a.run;
          c.opened = a.run.state === 'running';
          append(c, await window.jarvis.webLog(a.key));
        }
      }
      c.info = { ...c.info, found: a.found, planned: a.planned, external: a.external };
      render(c);
    }
    renderHeader();
    tick();
  }

  $('webStopAll').onclick = async () => {
    const r = await window.jarvis.webStopAll();
    if (r?.stopped) JV.feed?.({ level: 'info', title: `Stopping ${r.stopped} web app${r.stopped === 1 ? '' : 's'}`, action: 'devices' });
  };
  $('webRefresh').onclick = (e) => JV.spinWhile(e.currentTarget, refresh);

  // Whether something is serving a port can change at any time (a terminal started or
  // stopped), so it is re-checked on opening the view and every 15 s while it is open.
  // Local ports only - nothing leaves this machine.
  let poll = null;
  JV.on('view', (v) => {
    visible = v === 'devices';
    clearInterval(poll);
    poll = null;
    if (!visible) return;
    refresh();
    poll = setInterval(() => { if (!document.hidden) refresh(); }, 15000);
  });
})();
