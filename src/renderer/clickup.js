/* JARVIS window - the Tasks page: the ClickUp board for Jayvian (every sprint, every
   status), and the workspace's own draft of work not logged yet. The board is read from a
   cache so the page opens at once; Sync fetches a fresh copy through the ClickUp
   connection Claude Code already has. */
(() => {
  'use strict';
  const { $, el, state } = JV;

  let tasks = [];
  let fetchedAt = null;
  let syncing = false;
  const open = new Set(); // which sprints are expanded

  const sprintNo = (name) => { const m = /(\d+)\s*$/.exec(name || ''); return m ? Number(m[1]) : -1; };
  const tone = (t) => (t.statusType === 'done' ? 'ok' : t.statusType === 'open' ? 'accent' : 'busy');
  const isDone = (t) => t.statusType === 'done';

  // ------------------------------------------------------------- filters
  const filters = { q: '', sprint: 'all', openOnly: false };
  function visible() {
    const q = filters.q.toLowerCase();
    return tasks.filter((t) => {
      if (filters.openOnly && isDone(t)) return false;
      if (filters.sprint !== 'all' && t.list !== filters.sprint) return false;
      if (!q) return true;
      return `${t.code || ''} ${t.title} ${t.status}`.toLowerCase().includes(q);
    });
  }

  // ------------------------------------------------------------- summary strip
  function renderStats() {
    const box = $('cuStats');
    box.replaceChildren();
    if (!tasks.length) return;
    const unfinished = tasks.filter((t) => !isDone(t));
    const sprints = new Set(tasks.map((t) => t.list)).size;
    const cells = [
      ['Assigned to you', tasks.length, '', () => { filters.openOnly = false; $('cuOpenOnly').checked = false; filters.sprint = 'all'; $('cuSprint').value = 'all'; apply(); }],
      ['Unfinished', unfinished.length, unfinished.length ? 'busy' : '', () => { filters.openOnly = true; $('cuOpenOnly').checked = true; apply(); }],
      ['Done', tasks.length - unfinished.length, 'ok', null],
      ['Sprints', sprints, '', null],
    ];
    for (const [label, n, cls, onClick] of cells) {
      const c = el('div', `cu-stat ${cls}${onClick ? ' clickable' : ''}`);
      c.appendChild(el('b', null, String(n)));
      c.appendChild(el('span', null, label));
      if (onClick) { c.onclick = onClick; c.tabIndex = 0; c.onkeydown = (e) => { if (e.key === 'Enter') onClick(); }; }
      box.appendChild(c);
    }
    // The few that are not finished are the ones worth seeing first.
    if (unfinished.length) {
      const strip = el('div', 'cu-open-strip');
      strip.appendChild(el('span', 'cu-open-label', unfinished.length === 1 ? 'Still open:' : 'Still open:'));
      for (const t of unfinished.slice(0, 4)) {
        const chip = el('button', `chip-task ${tone(t)}`);
        if (t.code) chip.appendChild(el('b', null, t.code));
        chip.appendChild(el('span', null, JV.clip(t.title, 46)));
        chip.title = `${t.status} · ${t.list}`;
        chip.onclick = () => { if (t.url) window.open(t.url, '_blank'); }; // opens in the real browser
        strip.appendChild(chip);
      }
      box.appendChild(strip);
    }
  }

  // ------------------------------------------------------------- the board
  function renderGroups() {
    const box = $('cuGroups');
    box.replaceChildren();
    const list = visible();
    $('cuShowing').textContent = tasks.length ? `${list.length} shown of ${tasks.length}` : '';
    if (!tasks.length) {
      box.appendChild(emptyBox(
        'Nothing here yet',
        'Press Sync to read your ClickUp board. It takes a minute or two and nothing is written back - JARVIS only reads.',
      ));
      return;
    }
    if (!list.length) { box.appendChild(emptyBox('No match', 'Try a different search, sprint or filter.')); return; }

    const groups = new Map();
    for (const t of list) {
      if (!groups.has(t.list)) groups.set(t.list, []);
      groups.get(t.list).push(t);
    }
    const names = [...groups.keys()].sort((a, b) => sprintNo(b) - sprintNo(a) || a.localeCompare(b));
    names.forEach((name, i) => {
      const items = groups.get(name);
      // The newest sprint, anything the filters narrowed to, and sprints with open work
      // start expanded; the rest stay folded so 15 sprints do not bury the page.
      const wants = open.has(name) || (!open.size && (i === 0 || items.some((t) => !isDone(t))));
      box.appendChild(groupPanel(name, items, wants));
    });
  }

  function groupPanel(name, items, expanded) {
    const panel = el('div', `cu-group${expanded ? ' open' : ''}`);
    const head = el('button', 'cu-group-head');
    head.appendChild(JV.icon('chevron'));
    head.appendChild(el('b', null, name));
    head.appendChild(el('span', 'count', String(items.length)));
    const unfinished = items.filter((t) => !isDone(t)).length;
    if (unfinished) head.appendChild(el('span', 'pill busy', `${unfinished} open`));
    else head.appendChild(el('span', 'pill ok', 'all done'));
    head.onclick = () => {
      panel.classList.toggle('open');
      if (panel.classList.contains('open')) open.add(name); else open.delete(name);
    };
    panel.appendChild(head);

    const ul = el('ul', 'cu-list');
    for (const t of items.sort((a, b) => Number(isDone(a)) - Number(isDone(b)) || (a.code || '').localeCompare(b.code || ''))) {
      const li = el('li', 'cu-task');
      if (t.code) li.appendChild(el('span', 'cu-code', t.code));
      const main = el('div', 'cu-main');
      main.appendChild(el('span', 'cu-title', t.title));
      main.appendChild(el('span', `pill ${tone(t)}`, t.status));
      li.appendChild(main);
      if (t.url) {
        const go = el('button', 'icon-btn cu-open');
        go.title = 'Open in ClickUp';
        go.appendChild(JV.icon('external'));
        go.onclick = () => window.open(t.url, '_blank');
        li.appendChild(go);
      }
      ul.appendChild(li);
    }
    panel.appendChild(ul);
    return panel;
  }

  function emptyBox(title, sub) {
    const b = el('div', 'cu-empty');
    b.appendChild(el('b', null, title));
    b.appendChild(el('p', null, sub));
    return b;
  }

  function renderSprints() {
    const sel = $('cuSprint');
    const chosen = filters.sprint;
    sel.replaceChildren();
    const all = el('option', null, `All sprints (${new Set(tasks.map((t) => t.list)).size})`);
    all.value = 'all';
    sel.appendChild(all);
    const counts = new Map();
    for (const t of tasks) counts.set(t.list, (counts.get(t.list) || 0) + 1);
    for (const name of [...counts.keys()].sort((a, b) => sprintNo(b) - sprintNo(a) || a.localeCompare(b))) {
      const o = el('option', null, `${name} (${counts.get(name)})`);
      o.value = name;
      sel.appendChild(o);
    }
    sel.value = [...counts.keys()].includes(chosen) ? chosen : 'all';
    filters.sprint = sel.value;
  }

  function renderHeader() {
    $('cuCount').textContent = String(tasks.length);
    $('cuWho').textContent = tasks.length ? 'assigned to Jayvian' : '';
    const s = $('cuSynced');
    if (syncing) s.textContent = 'Syncing… this takes a minute or two';
    else s.textContent = fetchedAt ? `synced ${JV.ago(new Date(fetchedAt).getTime())}` : 'not synced yet';
    s.className = `h-note${syncing ? ' busy' : ''}`;
    const b = $('cuSync');
    b.disabled = syncing;
    b.replaceChildren(JV.icon('refresh'), el('span', null, syncing ? 'Syncing…' : 'Sync'));
    b.classList.toggle('spinning', syncing);
  }

  function apply() { renderStats(); renderGroups(); renderHeader(); }

  // ------------------------------------------------------------- the local draft
  async function loadDraft() {
    const d = await window.jarvis.draftTasks();
    const box = $('draftList');
    box.replaceChildren();
    const note = $('draftNote');
    if (!d.available) { note.textContent = ''; box.appendChild(emptyBox('No draft file', 'clickup-task-draft.md is not in this workspace.')); return; }
    note.textContent = d.path;
    const ready = d.sections.filter((s) => /ready to log|to do/i.test(s.name));
    const logged = d.sections.filter((s) => !/ready to log|to do/i.test(s.name));
    if (!ready.length) {
      box.appendChild(emptyBox('All caught up', 'Nothing is waiting to be logged to ClickUp.'));
    }
    for (const s of [...ready, ...logged]) {
      const h = el('div', 'draft-sec');
      h.appendChild(el('b', null, s.name));
      h.appendChild(el('span', 'count', String(s.items.length)));
      box.appendChild(h);
      const ul = el('ul', 'cu-list');
      for (const it of s.items.slice(0, 40)) {
        const li = el('li', 'cu-task');
        if (it.code) li.appendChild(el('span', 'cu-code', it.code));
        const main = el('div', 'cu-main');
        main.appendChild(el('span', 'cu-title', it.title));
        li.appendChild(main);
        if (it.url) {
          const go = el('button', 'icon-btn cu-open');
          go.title = 'Open in ClickUp';
          go.appendChild(JV.icon('external'));
          go.onclick = () => window.open(it.url, '_blank');
          li.appendChild(go);
        }
        ul.appendChild(li);
      }
      box.appendChild(ul);
    }
  }

  // ------------------------------------------------------------- wiring
  async function load() {
    const c = await window.jarvis.clickup();
    tasks = c.tasks || [];
    fetchedAt = c.fetchedAt || null;
    renderSprints();
    apply();
  }

  async function sync() {
    if (syncing) return;
    syncing = true;
    renderHeader();
    const r = await window.jarvis.clickupSync();
    syncing = false;
    if (r?.ok) {
      tasks = r.tasks;
      fetchedAt = r.fetchedAt;
      open.clear();
      renderSprints();
      JV.notify(`ClickUp: ${tasks.length} tasks for ${r.member}.`, { level: 'ok', action: 'tasks' });
    } else {
      JV.notify(r?.error || 'The ClickUp sync did not finish.', { level: 'err', action: 'tasks' });
      $('cuGroups').prepend(emptyBox('The sync did not finish', r?.error || 'Unknown error. Check that ClickUp is connected under Tools & Skills, then try again.'));
    }
    apply();
  }

  let booted = false;
  JV.on('view', (v) => {
    if (v !== 'tasks' || booted) return;
    booted = true;
    $('cuSync').onclick = sync;
    $('cuSearch').addEventListener('input', (e) => { filters.q = e.target.value.trim(); renderGroups(); });
    $('cuSprint').addEventListener('change', (e) => { filters.sprint = e.target.value; open.clear(); apply(); });
    $('cuOpenOnly').addEventListener('change', (e) => { filters.openOnly = e.target.checked; open.clear(); apply(); });
    load();
    loadDraft();
  });
})();
