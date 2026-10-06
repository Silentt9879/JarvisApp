/* JARVIS window - the Activity view (what JARVIS did, newest first, with the secrets hidden),
   and the usage card on Overview (what the work has cost today and this week, as an estimate). */
(() => {
  'use strict';
  const { $, node, state } = JV;
  const api = window.jarvis;

  const KIND_LABEL = {
    '': 'Everything',
    approval: 'Approvals',
    command: 'Commands',
    edit: 'File changes',
    git: 'Git',
    phone: 'Phone',
    routine: 'Routines',
    system: 'JARVIS',
  };
  const KIND_CLASS = { approval: 'ok', command: 'info', edit: 'info', git: 'ok', phone: 'warn', routine: 'warn', system: '' };

  function when(t) {
    const d = new Date(t);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }

  let timer = 0;
  let kind = '';
  let query = '';

  async function load() {
    const list = $('activityList');
    if (!list) return;
    const entries = await api.activity({ kind: kind || null, query, limit: 300 }).catch(() => []);
    if (!entries.length) {
      list.replaceChildren(node('div', { class: 'act-empty' },
        node('b', null, query || kind ? 'Nothing matches that.' : 'Nothing yet.'),
        node('small', null, query || kind ? 'Try another word, or show everything.' : 'Approvals, commands, file changes, git commits and routine runs appear here as they happen.')));
      return;
    }
    list.replaceChildren(...entries.map((e) => node('li', { class: 'act-row' },
      node('time', { class: 'act-time', datetime: new Date(e.t).toISOString() }, when(e.t)),
      node('span', { class: `act-kind ${KIND_CLASS[e.kind] || ''}` }, KIND_LABEL[e.kind] || 'JARVIS'),
      node('div', { class: 'act-text' }, e.text, e.where ? node('small', null, ` · ${e.where}`) : null))));
  }

  function refreshSoon() {
    clearTimeout(timer);
    timer = setTimeout(() => { if (state.view === 'activity') load(); }, 250);
  }

  function build() {
    const host = $('view-activity');
    if (!host || host.dataset.built) return;
    host.dataset.built = '1';
    const search = node('input', { class: 'field act-search', id: 'activitySearch', placeholder: 'Search the log…', 'aria-label': 'Search the activity log', autocomplete: 'off' });
    search.addEventListener('input', () => { query = search.value.trim(); refreshSoon(); });
    const filter = node('select', { class: 'field act-kind', id: 'activityKind', 'aria-label': 'Show one kind of activity' },
      Object.entries(KIND_LABEL).map(([v, label]) => node('option', { value: v }, label)));
    filter.addEventListener('change', () => { kind = filter.value; load(); });
    const exportBtn = node('button', { class: 'btn', id: 'activityExport', onclick: async () => {
      const r = await api.activityExport().catch(() => null);
      if (r?.ok) JV.notify('The activity log is saved. Its folder is open.', { level: 'ok' });
      else if (r && !r.canceled) JV.notify(r.error || 'Could not save the log.', { level: 'err' });
    } }, JV.icon('file'), ' Export');
    const head = node('div', { class: 'view-head' },
      node('div', null,
        node('h2', null, 'Activity'),
        node('p', { class: 'view-sub' }, 'Everything JARVIS did, newest first. Anything that looks like a password or a token is hidden.')),
      exportBtn);
    const bar = node('div', { class: 'act-bar' }, search, filter);
    const list = node('ol', { class: 'act-list', id: 'activityList', 'aria-live': 'polite' });
    host.replaceChildren(node('div', { class: 'view-pad act-view' }, head, bar, list));
    load();
  }

  /** The usage card on Overview: a plain line for today and the week, marked as an estimate. */
  async function renderUsage() {
    const card = $('usageCard');
    if (!card) return;
    const u = await api.usage().catch(() => null);
    if (!u) { card.hidden = true; return; }
    card.hidden = false;
    const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;
    card.replaceChildren(
      node('div', { class: 'usage-head' },
        node('b', null, 'Usage'),
        node('small', null, 'Estimates, from Claude Code’s own cost figure')),
      node('div', { class: 'usage-grid' },
        node('div', null, node('span', null, 'Today'), node('b', null, money(u.today.costUsd)), node('small', null, `${u.today.replies} repl${u.today.replies === 1 ? 'y' : 'ies'}${u.today.runs ? ` · ${u.today.runs} routine${u.today.runs === 1 ? '' : 's'}` : ''}`)),
        node('div', null, node('span', null, 'Last 7 days'), node('b', null, money(u.week.costUsd)), node('small', null, `${u.week.replies} repl${u.week.replies === 1 ? 'y' : 'ies'}`)),
        node('div', null, node('span', null, 'Daily limit'), node('b', null, u.budgetUsd ? money(u.budgetUsd) : 'None'), node('small', null, u.budgetUsd ? (u.overBudget ? 'Reached today' : 'Set in Settings') : 'Set one in Settings')),
      ));
  }

  JV.initActivity = () => {
    build();
    JV.on('view', (v) => {
      if (v === 'activity') { build(); load(); }
      if (v === 'command') renderUsage();
    });
    // New approvals and commands show up while the log is open.
    for (const k of ['permission', 'tool_use', 'result', 'prompt_done']) JV.on(k, () => { if (state.view === 'activity') refreshSoon(); });
    JV.on('result', () => renderUsage());
    renderUsage();
  };
  JV.renderUsage = renderUsage;
})();
