/* JARVIS window - AI Core's usage section: the plan's session and weekly allowances as Claude Code
   reports them, what is using them, and when they reset. "Refresh" asks Claude Code for the latest
   figures, which costs nothing; the page refreshes itself when it opens and the reading is old. */
(() => {
  'use strict';
  const { $, node, state } = JV;
  const api = window.jarvis;
  const STALE_MS = 5 * 60 * 1000;
  let busy = false;

  const level = (p) => (p >= 90 ? 'bad' : p >= 70 ? 'warn' : 'ok');

  /** A plain reset time: today's time, or the day and time. */
  function resetText(w) {
    if (w.resetsAt) {
      const d = new Date(w.resetsAt);
      const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      if (d.toDateString() === new Date().toDateString()) return `Resets today at ${t}`;
      return `Resets ${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} at ${t}`;
    }
    if (w.resets) return `Resets ${w.resets.replace(/\s*\([^)]*\)\s*$/, '')}`;
    return '';
  }

  function order(a, b) {
    const rank = (w) => (w.key === 'session' ? 0 : w.key === 'week:all models' ? 1 : 2);
    return rank(a) - rank(b);
  }

  function limitRow(w) {
    const pct = Math.max(0, Math.min(100, Number(w.percent) || 0));
    const when = resetText(w);
    return node('div', { class: 'nt-limit' },
      node('div', { class: 'nt-limit-main' },
        node('b', null, w.label),
        node('small', { title: w.resets || '' }, when || 'Reset time not known yet')),
      node('div', { class: `nt-meter ${level(pct)}`, role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct)), 'aria-label': `${w.label}, ${Math.round(pct)} percent used` },
        node('span', { style: `width:${pct}%` })),
      node('div', { class: 'nt-pct' }, `${Math.round(pct)}%`));
  }

  function ago(t) {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
    return new Date(t).toLocaleDateString();
  }

  function render(reading, plan) {
    const r = reading || {};
    const wins = (r.windows || []).slice().sort(order);
    $('usageLimits').replaceChildren(...(wins.length
      ? wins.map(limitRow)
      : [node('p', { class: 'nt-hint' }, 'No reading yet. Press Refresh to ask Claude Code for your figures.')]));

    const pill = $('usagePlan');
    pill.textContent = plan ? `${plan} plan` : '';
    pill.hidden = !plan;

    const why = $('usageWhy');
    const c = (r.contributing || [])[0];
    if (c) {
      why.hidden = false;
      why.replaceChildren(
        JV.icon('bulb'),
        node('div', null,
          node('b', null, `${c.span}: ${c.requests} request${c.requests === 1 ? '' : 's'} in ${c.sessions} session${c.sessions === 1 ? '' : 's'}.`),
          ` ${c.longPercent}% of that usage came from chats with more than ${c.longOverK}k tokens of context. `,
          node('span', null, 'A new session when a chat gets long keeps your limit going further.')));
    } else {
      why.hidden = true;
      why.replaceChildren();
    }

    $('usageUpdated').textContent = r.updatedAt ? `Last updated ${ago(r.updatedAt)}` : 'Not updated yet';
    const o = r.overage;
    $('usageOverage').textContent = o
      ? (o.status === 'rejected'
        ? 'Usage credits are off on this account, so JARVIS stops at your plan limit.'
        : 'Usage credits are on for this account.')
      : '';
  }

  async function load() {
    const r = await api.usageLimits().catch(() => null);
    if (r) render(r, r.plan);
    return r;
  }

  async function refresh() {
    if (busy) return;
    busy = true;
    const btn = $('usageRefresh');
    btn.disabled = true;
    btn.textContent = 'Refreshing…';
    try {
      const r = await api.refreshUsageLimits();
      if (r?.reading) render(r.reading, r.plan);
      if (!r?.ok) JV.notify(r?.error || 'Could not refresh the usage. Try again in a moment.', { level: 'warn' });
    } catch (e) {
      JV.notify(`Could not refresh the usage: ${e?.message || 'unknown reason'}`, { level: 'warn' });
    } finally {
      busy = false;
      btn.disabled = false;
      btn.textContent = 'Refresh';
    }
  }

  /** Scroll to the usage section and let it catch the eye for a moment (used by /usage). */
  JV.focusUsage = () => {
    const block = $('usageBlock');
    if (!block) return;
    block.scrollIntoView({ behavior: 'smooth', block: 'start' });
    block.classList.add('nt-flash');
    setTimeout(() => block.classList.remove('nt-flash'), 1400);
  };
  JV.refreshUsageLimits = refresh;

  JV.initUsagePage = () => {
    $('usageRefresh').onclick = refresh;
    JV.on('view', (v) => {
      if (v !== 'core') return;
      load().then((r) => {
        if (!r || !r.updatedAt || Date.now() - r.updatedAt > STALE_MS) refresh();
      });
    });
    // Each request reports the limits as it goes: keep the page current while it is open.
    JV.on('rate_limit', () => { if (state.view === 'core') load(); });
  };
})();
