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
    const active = state.info?.workspace || null;
    // The workspace chosen here is ADDED to the list straight away (that is only a note in the
    // settings), and switched to when Finish is pressed - one restart, at the end.
    const choice = { ws: active ? { id: active.id, name: active.name, path: active.path } : null, phone: false, clickup: false, preview: null };
    const previewFor = async () => {
      if (!choice.ws) return null;
      if (choice.preview?.id !== choice.ws.id) choice.preview = { id: choice.ws.id, result: await api.workspacePreview(choice.ws.id).catch(() => null) };
      return choice.preview.result;
    };
    const steps = [
      {
        title: 'Welcome to JARVIS',
        body: () => [
          node('p', { class: 'dlg-text' }, 'Good day, sir. JARVIS is a command center for your code, built on Claude Code. This takes about two minutes, and you can skip any step - everything can be changed later in Settings.'),
          node('ul', { class: 'wiz-list' },
            node('li', null, 'You choose a workspace: the folder that holds your projects. JARVIS finds them by looking - Flutter, .NET, Node, Python, Java, Git.'),
            node('li', null, 'Claude works inside it, and asks before it changes anything.'),
            node('li', null, 'Your conversations and settings stay on this PC. Phone and Telegram features are optional.')),
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
        title: 'Choose your workspace',
        body: () => {
          const path = node('b', { class: 'wiz-path' }, choice.ws ? `${choice.ws.name} - ${choice.ws.path}` : 'No folder yet');
          const note = node('small', { class: 'dlg-hint' }, '');
          const pick = node('button', { class: `btn${choice.ws ? '' : ' btn-primary'}`, onclick: async () => {
            const r = await api.pickWorkspace().catch(() => null);
            if (!r?.ok || !r.path) return;
            const added = await api.workspaceAdd(r.path).catch((e) => ({ ok: false, error: e.message }));
            if (!added?.ok) { note.textContent = added?.error || 'That folder cannot be a workspace.'; return; }
            choice.ws = added.workspace;
            choice.preview = null;
            path.textContent = `${added.workspace.name} - ${added.workspace.path}`;
            note.textContent = added.duplicate ? 'It was already in your list.' : 'Added. JARVIS switches to it when you press Finish.';
          } }, choice.ws ? 'Choose a different folder…' : 'Choose a folder…');
          return [
            node('p', { class: 'dlg-text' }, 'The folder that holds your projects - for example C:\\Users\\you\\Projects. It can be one project, or many side by side. JARVIS only looks until you ask it to do something.'),
            path,
            node('div', { class: 'wiz-actions' }, pick),
            note,
          ];
        },
      },
      {
        title: 'What is in it',
        body: () => {
          const box = node('div', { class: 'wiz-scan' }, node('p', { class: 'dlg-text' }, choice.ws ? 'Looking through it…' : 'Choose a workspace first (Back), or skip - JARVIS asks again when it opens.'));
          if (choice.ws) previewFor().then((r) => {
            if (!r) { box.replaceChildren(node('p', { class: 'dlg-text' }, 'It could not be read just now. You can carry on - the Projects page looks again.')); return; }
            if (!r.ok) { box.replaceChildren(node('p', { class: 'dlg-text' }, `It could not be read: ${r.error || 'unknown reason'}.`)); return; }
            if (!r.count) { box.replaceChildren(node('p', { class: 'dlg-text' }, 'No projects found yet - JARVIS looks for .git, pubspec.yaml, *.csproj or *.sln, package.json, Python and Java project files. You can still chat about this folder, and add projects to it later.')); return; }
            const TYPE = { flutter: 'Flutter', dart: 'Dart', dotnet: '.NET', node: 'Node', python: 'Python', gradle: 'Gradle', maven: 'Maven', git: 'Git' };
            box.replaceChildren(
              node('p', { class: 'dlg-text' }, `Found ${r.count} project${r.count === 1 ? '' : 's'}${r.truncated ? ' (it is a big folder, so JARVIS stopped looking early)' : ''}:`),
              node('ul', { class: 'wiz-list wiz-projects' }, r.projects.slice(0, 14).map((p) => node('li', null, node('b', null, p.name), ` - ${p.types.map((t) => TYPE[t] || t).join(', ')}`))),
              r.projects.length > 14 ? node('small', { class: 'dlg-hint' }, `…and ${r.projects.length - 14} more on the Projects page.`) : null,
            );
          });
          return [box];
        },
      },
      {
        title: 'This PC',
        body: () => {
          const box = node('div', { class: 'wiz-env' }, node('p', { class: 'dlg-text' }, 'Checking the tools your projects use…'));
          (async () => {
            const r = await previewFor();
            const needs = r?.needs || [];
            if (!needs.length) { box.replaceChildren(node('p', { class: 'dlg-text' }, 'Nothing to install for these projects. Other tools (Flutter, .NET, Java…) only matter if you work with them - Health shows them any time.')); return; }
            box.replaceChildren(
              node('p', { class: 'dlg-text' }, 'What your projects use, and whether this PC has it:'),
              node('ul', { class: 'wiz-list wiz-needs' }, needs.map((n) => node('li', { class: n.installed ? 'ok' : 'missing' },
                node('b', null, n.label), n.installed ? ` - ready${n.version ? `, ${n.version}` : ''}` : ` - not installed. ${n.hint || ''}`))),
              node('small', { class: 'dlg-hint' }, needs.some((n) => !n.installed) ? 'You can install these later. Until then, the actions that need them say so instead of failing.' : 'All set. Tools nothing here uses are optional, and never counted as a problem.'),
            );
          })();
          return [box];
        },
      },
      {
        title: 'Optional extras',
        body: () => [
          node('p', { class: 'dlg-text' }, 'Each of these is optional - JARVIS works fully without them. Tick any you want to set up after this.'),
          node('label', { class: 'check' }, node('input', { type: 'checkbox', checked: choice.phone, onchange: (e) => { choice.phone = e.target.checked; } }), ' Telegram: alerts on your phone when work stops, and chatting with JARVIS from anywhere'),
          node('label', { class: 'check' }, node('input', { type: 'checkbox', checked: choice.clickup, onchange: (e) => { choice.clickup = e.target.checked; } }), ' ClickUp: your tasks beside your work (needs ClickUp connected to Claude Code)'),
          node('small', { class: 'dlg-hint' }, 'Android phones (mirroring, Flutter runs) and .NET web apps need nothing set up here - plug a phone in, or open Devices.'),
        ],
      },
      {
        title: 'All set',
        body: () => [
          node('p', { class: 'dlg-text' }, choice.ws && choice.ws.id !== active?.id
            ? `JARVIS restarts once in ${choice.ws.name} when you press Finish. The status pill at the top opens Health at any time.`
            : 'JARVIS is ready. Press Finish to start. The status pill at the top opens Health at any time and shows anything still to set up.'),
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
    if (choice.clickup) JV.show('tasks');
    if (choice.phone) JV.openSettings?.('phone');
    // Last, because it restarts JARVIS: the workspace chosen above, if it is a new one - after
    // the one question only the person can answer: whether to trust that folder.
    if (choice.ws && choice.ws.id !== active?.id) {
      const listed = (await api.workspaces().catch(() => null))?.workspaces.find((x) => x.id === choice.ws.id) || { ...choice.ws, trusted: false };
      const trust = listed.trusted ? undefined : await JV.askTrust(listed, `JARVIS restarts in ${listed.name} now.`);
      if (trust === null) { JV.notify(`${listed.name} is in your list - switch to it from Settings when you are ready.`, { level: 'info', action: () => JV.openSettings?.() }); return; }
      const r = await api.workspaceSelect(choice.ws.id, typeof trust === 'boolean' ? { trust } : {}).catch((e) => ({ ok: false, error: e.message }));
      if (r && !r.ok) JV.notify(r.error || 'Could not switch to that workspace.', { level: 'err', action: () => JV.openSettings?.() });
    }
  }

  JV.initWelcome = async () => {
    const info = await api.welcome().catch(() => null);
    if (!info) return;
    if (info.setupNeeded) { showSetup(); return; }
    if (info.whatsNew) showWhatsNew(info.whatsNew);
  };
})();
