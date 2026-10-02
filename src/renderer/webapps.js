/* JARVIS window - the ASP.NET sites and APIs: `dotnet watch run` with its console here,
   and the site itself in your own browser. A compact strip under the phones, because a
   web app belongs in a browser with its dev tools, not in a panel. */
(() => {
  'use strict';
  const { $, el } = JV;

  const cards = new Map(); // key -> card
  const MAX_LOG_LINES = 600;

  function makeCard(a) {
    const c = { key: a.key, name: a.name, run: null, logCount: 0, opened: false };
    c.root = el('div', `web-card${a.found ? '' : ' missing'}`);
    c.root.dataset.app = a.key;

    const head = el('div', 'web-head');
    const badge = el('span', 'app-badge');
    badge.title = a.kind === 'api' ? 'An API - no pages to look at' : 'A website';
    badge.appendChild(JV.icon(a.kind === 'api' ? 'server' : 'globe'));
    head.appendChild(badge);
    const id = el('div', 'web-id');
    id.appendChild(el('b', null, a.name));
    id.appendChild(el('small', null, a.dir));
    head.appendChild(id);
    c.state = el('span', 'pill', a.found ? 'Not running' : 'Project not found');
    head.appendChild(c.state);
    c.root.appendChild(head);

    const urlRow = el('div', 'web-url-row');
    c.url = el('button', 'web-url');
    c.url.appendChild(JV.icon('external'));
    c.urlText = el('span', null, '');
    c.url.appendChild(c.urlText);
    c.url.title = 'Open in your browser';
    c.url.onclick = () => openInBrowser(c);
    c.copyBtn = el('button', 'btn btn-ghost web-mini', 'Copy');
    c.copyBtn.title = 'Copy the address';
    c.copyBtn.onclick = async () => {
      if (!c.run?.url) return;
      await navigator.clipboard.writeText(c.run.url).catch(() => {});
      c.copyBtn.textContent = 'Copied';
      setTimeout(() => (c.copyBtn.textContent = 'Copy'), 1200);
    };
    urlRow.appendChild(c.url);
    urlRow.appendChild(c.copyBtn);
    c.urlRow = urlRow;
    c.root.appendChild(urlRow);

    const actions = el('div', 'web-actions');
    c.runBtn = el('button', 'btn btn-primary', 'Run');
    c.runBtn.disabled = !a.found;
    c.runBtn.onclick = () => (active(c) ? stop(c) : start(c));
    actions.appendChild(c.runBtn);
    c.watchBox = el('input');
    c.watchBox.type = 'checkbox';
    c.watchBox.checked = true;
    const watch = el('label', 'switch');
    watch.title = 'dotnet watch: rebuilds and reloads the page when you save a file';
    watch.appendChild(c.watchBox);
    watch.appendChild(el('span', 'track'));
    watch.appendChild(el('span', null, 'Hot reload'));
    actions.appendChild(watch);
    c.logBtn = el('button', 'btn btn-ghost web-mini', 'Log');
    c.logBtn.title = 'Show more of the output';
    c.logBtn.onclick = () => {
      // Set outright rather than through a class: one rule, no cascade surprises.
      const tall = c.root.classList.toggle('tall');
      c.log.style.height = tall ? '320px' : '';
      c.logBtn.textContent = tall ? 'Less' : 'Log';
      c.log.scrollTop = c.log.scrollHeight;
    };
    actions.appendChild(c.logBtn);
    if (a.warn) {
      const warn = el('span', 'dev-warn');
      warn.appendChild(JV.icon('alert'));
      warn.appendChild(el('span', null, a.warn));
      warn.title = 'On localhost this project reads and writes the live database.';
      actions.appendChild(warn);
    }
    c.root.appendChild(actions);

    c.log = el('pre', 'web-log');
    c.root.appendChild(c.log);
    render(c);
    return c;
  }

  const active = (c) => c.run && c.run.state !== 'exited';

  function openInBrowser(c) {
    if (c.run?.url) window.jarvis.openUrl(c.run.url);
  }

  function render(c) {
    const r = c.run;
    c.runBtn.textContent = active(c) ? 'Stop' : 'Run';
    c.runBtn.className = `btn ${active(c) ? 'btn-danger' : 'btn-primary'}`;
    c.watchBox.disabled = !!active(c);
    const words = { building: 'Building…', running: 'Running', exited: 'Not running' };
    if (r) {
      c.state.textContent = `${words[r.state] || r.state}${r.watch && r.state !== 'exited' ? ' · hot reload' : ''}`;
      c.state.className = `pill ${{ running: 'ok', building: 'busy' }[r.state] || ''}`;
    }
    c.root.classList.toggle('running', !!r && r.state === 'running');
    c.urlText.textContent = r?.url || '';
    c.urlRow.hidden = !r?.url;
  }

  async function start(c) {
    c.log.replaceChildren();
    c.logCount = 0;
    c.opened = false;
    c.state.textContent = 'Starting…';
    c.state.className = 'pill busy';
    const r = await window.jarvis.webRun(c.key, c.watchBox.checked);
    if (!r?.ok) {
      append(c, [{ level: 'error', text: r?.error || 'Could not start dotnet.' }]);
      c.state.textContent = 'Could not start';
      c.state.className = 'pill bad';
      return;
    }
    c.run = r.run;
    render(c);
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

  JV.on('web_state', (e) => {
    const c = cards.get(e.key);
    if (!c) return;
    c.run = { key: e.key, name: e.name, state: e.state, url: e.url, since: e.since, watch: e.watch };
    render(c);
    if (e.state === 'running' && e.url && !c.opened) {
      // The site opens in the real browser once, when it first starts listening - a restart
      // from hot reload does not throw another window at you.
      c.opened = true;
      window.jarvis.openUrl(e.url);
      JV.feed?.({ level: 'ok', title: `${e.name} is running`, sub: `${e.url} · opened in your browser`, action: 'devices' });
    }
    if (e.state === 'exited') {
      c.opened = false;
      JV.feed?.({ level: /exit 0/.test(e.message || '') ? 'info' : 'err', title: `${e.name} stopped`, sub: e.message || '', action: 'devices' });
    }
  });
  JV.on('web_log', (e) => { const c = cards.get(e.key); if (c) append(c, e.lines); });

  async function build() {
    const list = await window.jarvis.webApps();
    const grid = $('webGrid');
    for (const a of list) {
      if (cards.has(a.key)) continue;
      const c = makeCard(a);
      cards.set(a.key, c);
      grid.appendChild(c.root);
      if (a.run) { // still running from an earlier visit to this view
        c.run = a.run;
        c.opened = a.run.state === 'running';
        append(c, await window.jarvis.webLog(a.key));
        render(c);
      }
    }
  }

  JV.on('view', (v) => { if (v === 'devices' && !cards.size) build(); });
})();
