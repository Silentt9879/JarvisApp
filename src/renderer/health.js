/* JARVIS window - Health: one place that says what is in order and what is not, with the button
   that fixes each thing. The status pill at the top opens it. */
(() => {
  'use strict';
  const { $, node } = JV;
  const api = window.jarvis;

  const LABEL = { ok: 'In order', warn: 'To set up', bad: 'Needs fixing' };

  function row(check, onFix) {
    const chip = node('span', { class: `hc-chip ${check.state}` }, LABEL[check.state] || '');
    const fix = check.fix
      ? node('button', { class: check.state === 'bad' ? 'btn btn-primary small' : 'btn small', onclick: () => onFix(check) }, check.fix.label)
      : null;
    return node('li', { class: `hc-row ${check.state}`, 'data-check': check.id },
      node('span', { class: 'hc-mark', 'aria-hidden': 'true' }, JV.icon(check.state === 'ok' ? 'check' : 'alert')),
      node('div', { class: 'hc-main' },
        node('b', null, check.title),
        node('small', null, check.detail)),
      chip,
      fix);
  }

  /** What each fix button does. Some are in this window; some are done by the app. */
  async function fix(check, dlg, refresh) {
    const action = check.fix.action;
    if (action === 'recheck') { refresh(); return; }
    if (action === 'signin') {
      const r = await api.healthFix('signin').catch(() => null);
      JV.notify(r?.ok ? 'A sign-in window opened. Finish there, then press Check again.' : 'Could not open the sign-in window.', { level: r?.ok ? 'info' : 'err' });
      return;
    }
    if (action === 'workspace') {
      dlg.close();
      JV.openSettings?.('general');
      $('wsChange')?.click();
      return;
    }
    if (action === 'policyFolder') {
      const r = await api.healthFix('policyFolder').catch(() => null);
      if (!r?.ok) JV.notify(r?.error || 'Could not open the folder.', { level: 'err' });
      return;
    }
    if (action === 'telegram') { dlg.close(); JV.openSettings?.('phone'); return; }
    if (action === 'github') { dlg.close(); JV.openSettings?.('general', 'updSec'); return; }
    if (action === 'updates') { dlg.close(); JV.openSettings?.('general', 'updSec'); setTimeout(() => $('updCheckAll')?.click(), 300); return; }
  }

  async function open() {
    const list = node('ul', { class: 'hc-list' });
    const summary = node('p', { class: 'dlg-text hc-summary' }, 'Checking…');
    let dlg = null;
    const refresh = async () => {
      list.replaceChildren(node('li', { class: 'hc-row' }, node('small', null, 'Checking…')));
      const h = await api.health().catch(() => null);
      if (!h) { summary.textContent = 'Could not check just now. Try again in a moment.'; list.replaceChildren(); return; }
      summary.textContent = h.summary;
      summary.dataset.level = h.level;
      list.replaceChildren(...h.checks.map((c) => row(c, (check) => fix(check, dlg, refresh))));
    };
    const dialog = JV.dialog({
      title: 'Health',
      wide: true,
      body: [summary, list],
      buttons: [
        { label: 'Check again', role: 'again', onClick: () => { refresh(); return false; } },
        { label: 'Close', value: true, primary: true },
      ],
      onOpen: (d) => { dlg = d; refresh(); },
    });
    await dialog;
  }

  JV.openHealth = open;

  JV.initHealth = () => {
    const pill = $('sysStatus');
    if (!pill) return;
    pill.setAttribute('role', 'button');
    pill.tabIndex = 0;
    pill.title = 'Open Health: what is in order and what to set up';
    pill.addEventListener('click', () => open());
    pill.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  };
})();
