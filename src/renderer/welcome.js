/* JARVIS window - the first-run walk-through, and "What's new" after an update. Both are
   optional and can be skipped; nothing here changes a setting without the person choosing it. */
(() => {
  'use strict';
  const { node, state } = JV;
  const api = window.jarvis;

  // ------------------------------------------------------------- What's new

  async function showWhatsNew(info) {
    const notes = String(info.notes || '').trim();
    const body = [];
    if (notes) {
      const box = node('div', { class: 'dlg-notes md' });
      JV.renderMarkdown(box, notes);
      body.push(box);
    } else {
      body.push(node('p', { class: 'dlg-text' }, 'JARVIS was updated. The notes for this version are not available here, but everything you had is still in place.'));
    }
    await JV.dialog({
      title: `What's new in v${info.version}`,
      body,
      wide: true,
      buttons: [{ label: 'Got it', primary: true, value: true }],
    });
    api.welcomeDone('whatsnew').catch(() => {});
  }

  // ------------------------------------------------------------- the walk-through

  function dotsFor(total, at) {
    return Array.from({ length: total }, (_, i) => node('span', { class: i === at ? 'on' : i < at ? 'done' : '' }));
  }

  async function showSetup() {
    const choice = { folder: state.info?.cwd || '', phone: false };
    const steps = [
      {
        title: 'Welcome to JARVIS',
        body: () => [
          node('p', { class: 'dlg-text' }, 'Good day, sir. This takes about two minutes, and you can skip any step. Everything can be changed later in Settings.'),
          node('ul', { class: 'wiz-list' },
            node('li', null, 'JARVIS works in one folder on this PC, with Claude Code.'),
            node('li', null, 'It asks before it changes anything, and it can message your phone.'),
            node('li', null, 'Your conversations and settings stay on this PC.')),
        ],
      },
      {
        title: 'Sign in to Claude',
        body: () => {
          const status = node('p', { class: 'dlg-text' }, 'Checking…');
          const check = async () => {
            status.textContent = 'Checking…';
            const a = await api.authStatus().catch(() => null);
            status.textContent = a?.loggedIn
              ? `You are signed in${a.email ? ` as ${a.email}` : ''}. Nothing more to do here.`
              : 'You are not signed in yet. Press Sign in, finish in the window that opens, then press Check again.';
          };
          const signIn = node('button', { class: 'btn btn-primary', onclick: async () => {
            const r = await api.authLogin().catch(() => ({ ok: false, error: 'Could not open the sign-in window.' }));
            status.textContent = r?.ok
              ? 'A sign-in window opened. When it says you are done, come back here and press Check again.'
              : (r?.error || 'Could not open the sign-in window.');
          } }, 'Sign in');
          const again = node('button', { class: 'btn', onclick: check }, 'Check again');
          setTimeout(check, 0);
          return [status, node('div', { class: 'wiz-actions' }, signIn, again)];
        },
      },
      {
        title: 'Pick your workspace',
        body: () => {
          const path = node('b', { class: 'wiz-path' }, choice.folder || 'No folder yet');
          const pick = node('button', { class: 'btn', onclick: async () => {
            const dir = await api.pickWorkspace().catch(() => null);
            if (dir) { choice.folder = dir; path.textContent = dir; }
          } }, 'Choose a different folder…');
          return [
            node('p', { class: 'dlg-text' }, 'This is the folder JARVIS works in: its repos, its CLAUDE.md and its .claude settings.'),
            path,
            node('div', { class: 'wiz-actions' }, pick),
            node('small', { class: 'dlg-hint' }, 'Changing the folder restarts JARVIS once, when you press Finish.'),
          ];
        },
      },
      {
        title: 'Your phone (optional)',
        body: () => [
          node('p', { class: 'dlg-text' }, 'JARVIS can message you on Telegram when work stops, and you can send it messages from your phone. It needs a bot token from @BotFather. It is fine to leave this for later.'),
          node('div', { class: 'wiz-actions' }, node('button', { class: 'btn', onclick: () => { choice.phone = true; } }, 'Open Phone settings when I finish')),
        ],
      },
      {
        title: 'All set',
        body: () => [
          node('p', { class: 'dlg-text' }, 'JARVIS is ready. Press Finish to start. The status pill at the top opens Health at any time and shows anything still to set up.'),
        ],
      },
    ];

    let at = 0;
    const dots = node('div', { class: 'wiz-dots', 'aria-hidden': 'true' });
    const title = node('h3', { class: 'wiz-title' });
    const bodyHost = node('div', { class: 'wiz-body' });
    let root = null;

    function go(i) {
      at = Math.max(0, Math.min(steps.length - 1, i));
      title.textContent = steps[at].title;
      bodyHost.replaceChildren(...[].concat(steps[at].body()));
      dots.replaceChildren(...dotsFor(steps.length, at));
      if (root) {
        root.querySelector('[data-role="back"]').hidden = at === 0;
        const next = root.querySelector('[data-role="next"]');
        next.textContent = at === steps.length - 1 ? 'Finish' : 'Next';
      }
    }

    const content = node('div', { class: 'wiz' }, dots, title, bodyHost);
    const answer = await JV.dialog({
      title: 'Set up JARVIS',
      body: [content],
      buttons: [
        { label: 'Skip for now', value: 'skip', role: 'skip' },
        { label: 'Back', role: 'back', onClick: () => { go(at - 1); return false; } },
        { label: 'Next', role: 'next', primary: true, value: 'done', onClick: () => {
          if (at < steps.length - 1) { go(at + 1); return false; }
          return true;
        } },
      ],
      onOpen: (dlg) => { root = dlg.root; go(0); },
    });
    if (answer === 'skip' || answer === null) {
      await api.welcomeDone('setup').catch(() => {});
      return;
    }
    await api.welcomeDone('setup').catch(() => {});
    if (choice.folder && choice.folder !== state.info?.cwd) {
      const ok = await JV.confirm(`Switch JARVIS to ${choice.folder}? It restarts once.`, { yes: 'Switch and restart' });
      if (ok) api.setWorkspace(choice.folder).catch(() => {});
    }
    if (choice.phone) JV.openSettings?.('phone');
  }

  JV.initWelcome = async () => {
    const info = await api.welcome().catch(() => null);
    if (!info) return;
    if (info.setupNeeded) { showSetup(); return; }
    if (info.whatsNew) showWhatsNew(info.whatsNew);
  };
})();
