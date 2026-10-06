/* JARVIS window - Automations: saved prompts (used from the chat, with blanks filled in each
   time) and routines (prompts JARVIS runs by itself at a set time). The chat has a prompt picker
   that reaches the saved prompts without leaving the conversation. */
(() => {
  'use strict';
  const { $, node, state } = JV;
  const api = window.jarvis;

  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // ------------------------------------------------------------- blanks in a prompt

  const BLANK = /\{([a-zA-Z][\w-]{0,30})\}/g;
  const blanksOf = (text) => [...new Set([...String(text).matchAll(BLANK)].map((m) => m[1]))];
  const fillIn = (text, values) => String(text).replace(BLANK, (m, k) => (Object.prototype.hasOwnProperty.call(values, k) ? values[k] : m));

  /** Ask for each blank in turn. Resolves the filled-in text, or null when cancelled. */
  async function fillPrompt(text) {
    const names = blanksOf(text);
    if (!names.length) return text;
    let values = null;
    const inputs = names.map((n) => JV.field(n.replace(/[-_]/g, ' '), node('input', { class: 'field', 'data-blank': n, autocomplete: 'off' })));
    const answer = await JV.dialog({
      title: 'Fill in the blanks',
      body: [node('p', { class: 'dlg-text' }, 'This prompt has a few blanks. Type what goes in each one.'), ...inputs],
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'Use prompt', primary: true, value: 'use', onClick: (e, dlg) => {
          const found = {};
          let ok = true;
          dlg.root.querySelectorAll('input[data-blank]').forEach((i) => {
            const v = i.value.trim();
            if (!v) { ok = false; i.classList.add('bad'); i.focus(); } else found[i.dataset.blank] = v;
          });
          if (!ok) return false;
          values = found;
          return true;
        } },
      ],
      onOpen: (dlg) => dlg.root.querySelector('input[data-blank]')?.focus(),
    });
    if (answer !== 'use' || !values) return null;
    return fillIn(text, values);
  }

  // ------------------------------------------------------------- saved prompts

  async function promptEditor(existing) {
    const title = node('input', { class: 'field', value: existing?.title || '', maxlength: '60', placeholder: 'For example: Review a file', autocomplete: 'off' });
    const text = node('textarea', { class: 'field dlg-area', rows: '6', placeholder: 'What should JARVIS do? Put a blank in curly braces, like {file}, to be asked each time.' }, existing?.text || '');
    const answer = await JV.dialog({
      title: existing ? 'Edit prompt' : 'New prompt',
      wide: true,
      body: [
        JV.field('Name', title, 'Shown in the list and the chat picker.'),
        JV.field('What to ask', text, 'Blanks like {file} are asked for each time you use the prompt.'),
      ],
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'Save', primary: true, value: 'save', onClick: async () => {
          const r = existing
            ? await api.updatePrompt(existing.id, { title: title.value, text: text.value })
            : await api.addPrompt({ title: title.value, text: text.value });
          if (!r?.ok) { JV.notify(r?.error || 'Could not save the prompt.', { level: 'err' }); return false; }
          return true;
        } },
      ],
      onOpen: () => title.focus(),
    });
    if (answer) renderPrompts();
  }

  async function renderPrompts() {
    const box = $('promptList');
    if (!box) return;
    const items = await api.prompts().catch(() => []);
    if (!items.length) {
      box.replaceChildren(node('p', { class: 'auto-empty' }, 'No saved prompts yet. Save the ones you ask often, and use them from the chat with the sparkle button.'));
      return;
    }
    box.replaceChildren(...items.map((p) => node('li', { class: 'auto-row' },
      node('div', { class: 'auto-main' },
        node('b', null, p.title),
        node('small', null, p.text.replace(/\s+/g, ' ').slice(0, 140))),
      node('div', { class: 'auto-acts' },
        node('button', { class: 'btn small', onclick: async () => {
          const filled = await fillPrompt(p.text);
          if (filled != null) JV.chat.insert(filled);
        } }, 'Use in chat'),
        node('button', { class: 'btn small', onclick: () => promptEditor(p) }, 'Edit'),
        node('button', { class: 'btn small btn-danger', onclick: async () => {
          if (!(await JV.confirm(`Delete "${p.title}"?`, { yes: 'Delete', danger: true }))) return;
          const r = await api.removePrompt(p.id);
          if (!r?.ok) JV.notify(r?.error || 'Could not delete it.', { level: 'err' });
          renderPrompts();
        } }, 'Delete')))));
  }

  // ------------------------------------------------------------- routines

  function dayText(days) {
    if (days.length === 7) return 'Every day';
    if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))) return 'Weekdays';
    return days.map((d) => DAYS[d]).join(', ');
  }

  function nextText(ms) {
    if (!ms) return 'Off';
    const d = new Date(ms);
    const now = new Date();
    const same = d.toDateString() === now.toDateString();
    const tomorrow = new Date(now.getTime() + 86400000).toDateString() === d.toDateString();
    const hm = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `Next: ${same ? `today at ${hm}` : tomorrow ? `tomorrow at ${hm}` : `${DAYS[d.getDay()]} at ${hm}`}`;
  }

  async function routineEditor(existing) {
    const name = node('input', { class: 'field', value: existing?.name || '', maxlength: '60', placeholder: 'For example: Morning check', autocomplete: 'off' });
    const what = node('textarea', { class: 'field dlg-area', rows: '5', placeholder: 'What should JARVIS check or do? For example: "Run the tests in the main repo and tell me what failed."' }, existing?.prompt || '');
    const time = node('input', { class: 'field', type: 'time', value: existing?.time || '09:00' });
    const dayMode = node('select', { class: 'field' },
      node('option', { value: 'daily', selected: !existing || existing.days?.length === 7 }, 'Every day'),
      node('option', { value: 'weekdays', selected: existing && existing.days?.length === 5 && existing.days.every((d) => d >= 1 && d <= 5) }, 'Weekdays'),
      node('option', { value: 'custom', selected: existing && !(existing.days?.length === 7 || (existing.days?.length === 5 && existing.days.every((d) => d >= 1 && d <= 5))) }, 'Pick days'));
    const dayBoxes = DAYS.map((label, i) => node('label', { class: 'day-pick' },
      node('input', { type: 'checkbox', 'data-day': String(i), checked: existing?.days?.includes(i) }), node('span', null, label)));
    const dayRow = node('div', { class: 'day-row', hidden: dayMode.value !== 'custom' }, dayBoxes);
    dayMode.addEventListener('change', () => { dayRow.hidden = dayMode.value !== 'custom'; });
    const mode = node('select', { class: 'field' },
      node('option', { value: 'plan', selected: existing?.mode !== 'acceptEdits' }, 'Read only: it looks and reports, and changes nothing (safest)'),
      node('option', { value: 'acceptEdits', selected: existing?.mode === 'acceptEdits' }, 'May edit files: it can change files, but still cannot run commands unasked'));
    const cwd = node('input', { class: 'field', value: existing?.cwd || '', placeholder: `Leave empty to use ${state.info?.cwd || 'the workspace'}`, autocomplete: 'off' });
    const toTg = node('input', { type: 'checkbox', checked: !!existing?.deliver?.telegram });
    const toToast = node('input', { type: 'checkbox', checked: existing ? existing.deliver?.toast !== false : true });

    const answer = await JV.dialog({
      title: existing ? 'Edit routine' : 'New routine',
      wide: true,
      body: [
        JV.field('Name', name),
        JV.field('What JARVIS should do', what, 'It runs on its own, so be specific. It cannot approve its own commands.'),
        node('div', { class: 'dlg-row' },
          JV.field('Time', time),
          JV.field('Days', dayMode)),
        dayRow,
        JV.field('Permissions', mode, 'Read only is the default. Commands that would need approval are not run.'),
        JV.field('Folder', cwd, 'Where it runs. Leave empty for the workspace.'),
        node('div', { class: 'dlg-checks' },
          node('label', { class: 'dlg-check' }, toTg, ' Send the result to my phone (Telegram)'),
          node('label', { class: 'dlg-check' }, toToast, ' Show a notification when it finishes')),
      ],
      buttons: [
        { label: 'Cancel', value: null },
        { label: existing ? 'Save' : 'Create routine', primary: true, value: 'save', onClick: async () => {
          let days = dayMode.value === 'daily' ? 'daily' : dayMode.value === 'weekdays' ? 'weekdays' : [...dayRow.querySelectorAll('input[data-day]')].filter((c) => c.checked).map((c) => Number(c.dataset.day));
          if (Array.isArray(days) && !days.length) { JV.notify('Pick at least one day.', { level: 'err' }); return false; }
          const input = { name: name.value, prompt: what.value, time: time.value, days, mode: mode.value, cwd: cwd.value, deliver: { telegram: toTg.checked, toast: toToast.checked }, on: existing ? existing.on !== false : true };
          const r = existing ? await api.updateRoutine(existing.id, input) : await api.addRoutine(input);
          if (!r?.ok) { JV.notify(r?.error || 'Could not save the routine.', { level: 'err' }); return false; }
          return true;
        } },
      ],
      onOpen: () => name.focus(),
    });
    if (answer) renderRoutines();
  }

  async function renderRoutines() {
    const box = $('routineList');
    if (!box) return;
    const items = await api.routines().catch(() => []);
    if (!items.length) {
      box.replaceChildren(node('p', { class: 'auto-empty' }, 'No routines yet. A routine is something JARVIS does on its own, such as running the tests every weekday morning and telling you how they went.'));
      return;
    }
    box.replaceChildren(...items.map((r) => {
      const ok = r.lastOk === true;
      const last = r.lastRunAt ? `Last run ${new Date(r.lastRunAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}: ${ok ? 'finished' : 'did not finish'}` : 'Not run yet';
      const toggle = node('input', { type: 'checkbox', checked: r.on, 'aria-label': `Routine ${r.name} is on` });
      toggle.addEventListener('change', async () => {
        const res = await api.updateRoutine(r.id, { name: r.name, prompt: r.prompt, time: r.time, days: r.days, mode: r.mode, cwd: r.cwd, deliver: r.deliver, on: toggle.checked });
        if (!res?.ok) JV.notify(res?.error || 'Could not change it.', { level: 'err' });
        renderRoutines();
      });
      return node('li', { class: `auto-row${r.on ? '' : ' off'}` },
        node('div', { class: 'auto-main' },
          node('b', null, `${r.name}`),
          node('small', null, `${r.time} · ${dayText(r.days)} · ${r.mode === 'acceptEdits' ? 'may edit files' : 'read only'}`),
          node('small', { class: 'auto-next' }, r.on ? nextText(r.nextRun) : 'Off'),
          node('small', { class: 'auto-last' }, last),
          r.lastSummary ? node('details', { class: 'auto-result' }, node('summary', null, 'What it said'), node('div', { class: 'auto-said' }, r.lastSummary)) : null),
        node('div', { class: 'auto-acts' },
          node('label', { class: 'switch' }, toggle, node('span', { 'aria-hidden': 'true' }, r.on ? 'On' : 'Off')),
          node('button', { class: 'btn small', onclick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            btn.textContent = 'Running…';
            const res = await api.runRoutine(r.id).catch((err) => ({ ok: false, error: err.message }));
            btn.disabled = false;
            btn.textContent = 'Run now';
            if (res?.ok) JV.notify(`"${r.name}" finished.`, { level: 'ok' });
            else JV.notify(res?.error || res?.summary || `"${r.name}" did not finish.`, { level: 'err' });
            renderRoutines();
          } }, 'Run now'),
          node('button', { class: 'btn small', onclick: () => routineEditor(r) }, 'Edit'),
          node('button', { class: 'btn small btn-danger', onclick: async () => {
            if (!(await JV.confirm(`Delete the routine "${r.name}"?`, { yes: 'Delete', danger: true }))) return;
            await api.removeRoutine(r.id);
            renderRoutines();
          } }, 'Delete')));
    }));
  }

  // ------------------------------------------------------------- the view

  function build() {
    const host = $('view-automations');
    if (!host || host.dataset.built) return;
    host.dataset.built = '1';
    host.replaceChildren(node('div', { class: 'view-pad auto-view' },
      node('div', { class: 'view-head' },
        node('div', null,
          node('h2', null, 'Automations'),
          node('p', { class: 'view-sub' }, 'Prompts you use again, and routines JARVIS runs by itself.')),
        null),
      node('section', { class: 'auto-card' },
        node('div', { class: 'auto-card-head' },
          node('h3', null, 'Saved prompts'),
          node('button', { class: 'btn btn-primary small', onclick: () => promptEditor(null) }, JV.icon('plus'), ' New prompt')),
        node('ul', { class: 'auto-list', id: 'promptList' })),
      node('section', { class: 'auto-card' },
        node('div', { class: 'auto-card-head' },
          node('h3', null, 'Routines'),
          node('button', { class: 'btn btn-primary small', onclick: () => routineEditor(null) }, JV.icon('plus'), ' New routine')),
        node('p', { class: 'auto-note' }, 'A routine runs at its time, on its days, while JARVIS is open. If JARVIS was closed at that time, it runs when JARVIS next starts that day.'),
        node('ul', { class: 'auto-list', id: 'routineList' }))));
    renderPrompts();
    renderRoutines();
  }

  /** The prompt picker in the chat composer: saved prompts, filtered as you type. */
  function openPicker() {
    const pop = $('promptsPop');
    if (!pop) return;
    if (!pop.hidden) { pop.hidden = true; return; }
    pop.hidden = false;
    const filter = $('promptsFilter');
    filter.value = '';
    const draw = async () => {
      const q = filter.value.trim().toLowerCase();
      const all = await api.prompts().catch(() => []);
      const items = all.filter((p) => !q || `${p.title} ${p.text}`.toLowerCase().includes(q));
      const list = $('promptsList');
      if (!items.length) { list.replaceChildren(node('li', { class: 'muted' }, all.length ? 'No prompt matches that.' : 'No saved prompts yet. Add some from Automations.')); return; }
      list.replaceChildren(...items.map((p) => node('li', null, node('button', { class: 'prompt-pick', onclick: async () => {
        pop.hidden = true;
        const filled = await fillPrompt(p.text);
        if (filled != null) JV.chat.insert(filled);
      } }, node('b', null, p.title), node('small', null, p.text.replace(/\s+/g, ' ').slice(0, 90))))));
    };
    filter.oninput = draw;
    draw();
    filter.focus();
  }

  JV.initAutomations = () => {
    build();
    JV.on('view', (v) => { if (v === 'automations') { build(); renderPrompts(); renderRoutines(); } });
    // The chat's picker: a button in the composer and a small popover.
    const btn = $('promptsBtn');
    if (btn) btn.onclick = (e) => { e.stopPropagation(); openPicker(); };
    document.addEventListener('click', (e) => {
      const pop = $('promptsPop');
      if (pop && !pop.hidden && !pop.contains(e.target) && e.target !== btn) pop.hidden = true;
    });
    document.addEventListener('keydown', (e) => {
      const pop = $('promptsPop');
      if (e.key === 'Escape' && pop && !pop.hidden) pop.hidden = true;
    });
  };
})();
