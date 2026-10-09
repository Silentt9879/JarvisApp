/* JARVIS window - the agent builder: make, edit and duplicate a Claude Code subagent, start from
   a template, and "Build my team" for the projects in this workspace.

   The window only fills in a form. What is valid, where a file may go, what may not be
   overwritten and which approvals a change needs are all decided in the main process
   (agents.mjs) - so every Save here is a question, and a refusal is shown as it was given.
   The Preview tab shows the exact file the main process would write, before anything is. */
(() => {
  'use strict';
  const { $, node, state } = JV;
  const api = window.jarvis;
  void $;

  /** The parts that are there. node() skips a missing child by itself; the DOM's append() does not. */
  const only = (...parts) => parts.filter((p) => p !== null && p !== undefined && p !== false);

  let options = null; // { templates, tools, readOnly, models } - fixed for the life of the window
  const loadOptions = async () => { if (!options) options = await api.agentOptions(); return options; };

  const GROUP_LABEL = {
    read: ['Looks only', ''],
    network: ['Uses the web', ''],
    write: ['Changes files', 'warn'],
    execute: ['Runs commands on this PC', 'warn'],
    delegate: ['Starts other agents', ''],
  };
  const MODEL_LABEL = { '': 'Claude Code\'s default', inherit: 'The same model as the chat', sonnet: 'Sonnet', opus: 'Opus', haiku: 'Haiku', fable: 'Fable' };
  const SCOPE_LABEL = {
    project: 'This workspace only (.claude/agents)',
    user: 'Every workspace (your own Claude folder)',
  };
  const USER_FOLDER = 'Your own Claude folder is read by every workspace, and by Claude Code in the terminal and VS Code too - not only by JARVIS.';

  /** "Read, Agent(a, b), mcp__x" -> its parts; a comma inside brackets does not split. */
  function splitTools(text) {
    const out = [];
    let cur = '';
    let depth = 0;
    for (const ch of String(text || '')) {
      if (ch === '(') depth += 1; else if (ch === ')') depth = Math.max(0, depth - 1);
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out.map((x) => x.trim()).filter(Boolean);
  }

  // ------------------------------------------------------------- small dialogs
  /** A yes/no question in a few short paragraphs. Resolves true only for the yes button. */
  JV.ask = ({ title, lines = [], yes = 'OK', no = 'Cancel', danger = false }) => JV.dialog({
    title,
    body: lines.filter(Boolean).map((t) => node('p', { class: 'dlg-text' }, t)),
    buttons: [{ label: no, value: false }, { label: yes, value: true, primary: !danger, danger }],
  }).then((v) => v === true);

  /**
   * A dialog whose content and buttons change as it goes (tabs, steps). `build(ui)` draws it;
   * `ui.close(value)` ends it. The buttons are drawn here, not passed to JV.dialog, because a
   * step's buttons differ and each one waits for the main process before anything closes.
   */
  function panel({ title, build }) {
    let result = null;
    return JV.dialog({
      title, wide: true, body: [], buttons: [],
      onOpen: (dlg) => {
        dlg.root.classList.add('dlg-xl');
        const ui = {
          root: dlg.root,
          body: dlg.root.querySelector('.dlg-body'),
          foot: dlg.root.querySelector('.dlg-foot'),
          close: (v) => { result = v === undefined ? null : v; dlg.close(); },
          buttons: (specs) => ui.foot.replaceChildren(...specs.filter(Boolean).map((b) => (b instanceof Node ? b : node('button', {
            class: `btn${b.primary ? ' btn-primary' : ''}${b.danger ? ' btn-danger' : ''}`, type: 'button', disabled: b.disabled, title: b.title, onclick: b.onClick,
          }, b.label)))),
        };
        build(ui);
      },
    }).then(() => result);
  }

  /** The person's yes to whatever a save still needs. Returns the approvals, or null when refused. */
  async function approve(needs, { paths = [], who = 'This agent', risks = [] } = {}) {
    const got = {};
    if (needs.includes('user-scope')) {
      const ok = await JV.ask({
        title: 'Write to your own Claude folder?',
        lines: [paths.length > 1 ? `${paths.length} files would be written:` : 'This file would be written:', ...paths.filter(Boolean).map((p) => node('code', null, p)), USER_FOLDER],
        yes: paths.length > 1 ? 'Write them' : 'Write it',
      });
      if (!ok) return null;
      got.approveUserScope = true;
    }
    if (needs.includes('risky-tools')) {
      const loud = [...new Set(risks)].filter((r) => JV.agentRiskLoud.includes(r) && JV.agentRisk[r]);
      const ok = await JV.ask({
        title: `Give ${who} these tools?`,
        lines: [
          ...loud.map((r) => JV.agentRisk[r][1]),
          'In Ask mode JARVIS still asks you before each of these. In Accept edits or Auto mode some go ahead without asking, exactly as they do in the chat.',
        ],
        yes: 'Allow these tools', danger: true,
      });
      if (!ok) return null;
      got.allowRisky = true;
    }
    return got;
  }

  /** Which places an agent can be written to right now, and why not the others. */
  function scopeChoices() {
    const s = JV.agentsData()?.scopes || {};
    return ['project', 'user'].map((k) => ({ key: k, label: SCOPE_LABEL[k], ok: !!s[k]?.writable, why: s[k]?.reason || (k === 'project' ? 'Choose a workspace first.' : 'Not available here.'), dir: s[k]?.dir || '' }));
  }

  // ------------------------------------------------------------- the editor
  /**
   * mode   'new' | 'edit' | 'duplicate' | 'draft'
   *        'draft' edits a proposal for Build my team and hands it back without saving.
   * start  the fields to begin with: { scope, file, hash, name, description, tools, model, body }
   */
  async function editor({ mode, start = {}, title, template = null }) {
    const opt = await loadOptions();
    const scopes = scopeChoices();
    const editing = mode === 'edit';
    const draftOnly = mode === 'draft';
    const usable = scopes.filter((s) => s.ok);
    if (!draftOnly && !editing && !usable.length) {
      JV.notify(scopes.map((s) => s.why).filter(Boolean)[0] || 'There is nowhere to save an agent right now.', { level: 'warn' });
      return null;
    }
    const known = new Set(opt.tools.map((t) => t.name));
    const readOnly = opt.readOnly;

    // ---- fields
    const nameI = node('input', { class: 'field ab-name', value: start.name || '', maxlength: '64', placeholder: 'code-reviewer', autocomplete: 'off', spellcheck: 'false' });
    const descI = node('textarea', { class: 'field dlg-area ab-desc', rows: '3', maxlength: '4000', placeholder: 'What it does and when Claude should hand it work. For example: "Reviews code for bugs and clarity. Use after writing or changing code."' }, start.description || '');
    const bodyI = node('textarea', { class: 'field dlg-area ab-body', rows: '12', spellcheck: 'false', placeholder: 'You are a ... When you are invoked: 1. ... Report back with ...' }, start.body || '');
    const scopeS = node('select', { class: 'field' }, scopes.map((s) => node('option', { value: s.key, disabled: !s.ok && !(editing && start.scope === s.key) }, s.ok ? s.label : `${s.label} - not available`)));
    scopeS.value = start.scope || usable[0]?.key || 'project';
    scopeS.disabled = editing || draftOnly; // an agent is moved by duplicating it into the other place
    const modelValues = ['', ...opt.models];
    if (start.model && !modelValues.includes(start.model)) modelValues.push(start.model);
    const modelS = node('select', { class: 'field' }, modelValues.map((m) => node('option', { value: m }, MODEL_LABEL[m] || m)));
    modelS.value = start.model || '';

    const startTools = start.tools === undefined ? readOnly : start.tools;
    const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
    const toolMode = node('select', { class: 'field' },
      node('option', { value: 'readonly' }, `Look only: ${readOnly.join(', ')} (recommended)`),
      node('option', { value: 'custom' }, 'Let me choose the tools'),
      node('option', { value: 'inherit' }, 'Everything the chat can use'));
    toolMode.value = startTools === null ? 'inherit' : sameSet(startTools, readOnly) ? 'readonly' : 'custom';
    const boxes = new Map();
    const grid = node('div', { class: 'ab-tools' });
    for (const g of Object.keys(GROUP_LABEL)) {
      const list = opt.tools.filter((t) => t.group === g);
      if (!list.length) continue;
      grid.append(node('div', { class: `ab-group${GROUP_LABEL[g][1] ? ` ${GROUP_LABEL[g][1]}` : ''}` },
        node('b', null, GROUP_LABEL[g][0]),
        list.map((t) => {
          const box = node('input', { type: 'checkbox', checked: Array.isArray(startTools) && startTools.includes(t.name) });
          boxes.set(t.name, box);
          return node('label', { class: 'ab-tool', title: t.label }, box, node('span', null, t.name), node('small', null, t.label));
        })));
    }
    const otherI = node('input', { class: 'field', value: Array.isArray(startTools) ? startTools.filter((t) => !known.has(t)).join(', ') : '', placeholder: 'mcp__server__tool, Agent(reviewer)', autocomplete: 'off', spellcheck: 'false' });
    const gridWrap = node('div', { class: 'ab-toolwrap' }, grid, JV.field('Other tools', otherI, 'Optional: tools from a connected system, comma-separated - or Agent(name) to limit which agents it may start.'));
    const toolNote = node('p', { class: 'ab-toolnote' });
    const tplNote = node('p', { class: 'ab-toolnote', hidden: true });

    const toolList = () => {
      if (toolMode.value === 'inherit') return null;
      if (toolMode.value === 'readonly') return [...readOnly];
      return [...[...boxes].filter(([, b]) => b.checked).map(([n]) => n), ...splitTools(otherI.value)];
    };
    const syncTools = () => {
      gridWrap.hidden = toolMode.value !== 'custom';
      toolNote.className = `ab-toolnote${toolMode.value === 'inherit' ? ' warn' : ''}`;
      toolNote.textContent = toolMode.value === 'inherit'
        ? 'No tools are listed in the file, so this agent gets every tool the chat has: running commands, changing files, the web and your connected systems. You will be asked to confirm that.'
        : toolMode.value === 'readonly' ? 'It can read and search the workspace, and nothing else. It cannot change a file or run a command.'
          : 'Tick only what the job needs. Anything that changes files or runs commands is confirmed before it is saved.';
    };
    toolMode.addEventListener('change', syncTools);
    syncTools();

    const applyTemplate = (t) => {
      nameI.value = t.name;
      descI.value = t.description;
      bodyI.value = t.body;
      modelS.value = t.model || '';
      const same = sameSet(t.tools, readOnly);
      toolMode.value = same ? 'readonly' : 'custom';
      for (const [n, b] of boxes) b.checked = t.tools.includes(n);
      syncTools();
      tplNote.hidden = !t.optional?.length;
      tplNote.textContent = t.optional?.length ? `This starter looks only. To let it do more, choose "Let me choose the tools" and tick ${t.optional.join(', ')}. ${t.optionalWhy || ''}` : '';
    };
    const tplS = mode === 'new' ? node('select', { class: 'field' },
      node('option', { value: '' }, 'A blank agent'),
      opt.templates.map((t) => node('option', { value: t.id }, t.title))) : null;
    if (tplS) tplS.addEventListener('change', () => {
      const t = opt.templates.find((x) => x.id === tplS.value);
      if (t) applyTemplate(t);
    });

    const draft = () => ({
      scope: scopeS.value, file: editing ? start.file : undefined, expect: editing ? start.hash : undefined,
      name: nameI.value.trim(), description: descI.value, model: modelS.value || null, tools: toolList(), body: bodyI.value,
    });

    return panel({
      title: title || (editing ? `Edit ${start.name}` : mode === 'duplicate' ? `Duplicate ${start.from || 'agent'}` : draftOnly ? `Customize ${start.title || start.name}` : 'New agent'),
      build(ui) {
        const error = node('div', { class: 'ab-error', role: 'alert', hidden: true });
        const FIELD = { name: nameI, description: descI, body: bodyI, tools: toolMode, model: modelS };
        const showError = (r) => {
          for (const f of Object.values(FIELD)) f.classList.remove('bad');
          const list = r?.errors?.length ? r.errors : [{ field: r?.conflict === 'name' || r?.conflict === 'file' ? 'name' : null, message: r?.error || 'That could not be saved.' }];
          error.replaceChildren(...list.map((e) => node('div', null, e.message)));
          error.hidden = false;
          for (const e of list) FIELD[e.field]?.classList.add('bad');
          (FIELD[list[0].field] || nameI).focus?.();
          ui.body.scrollTop = 0;
        };
        const clearError = () => { error.hidden = true; for (const f of Object.values(FIELD)) f.classList.remove('bad'); };

        const details = node('div', { class: 'ab-pane' },
          tplS ? JV.field('Start from', tplS, 'A starter fills in the fields below. Every one of them can be changed.') : null,
          node('div', { class: 'dlg-row' },
            JV.field('Name', nameI, 'Lowercase letters, digits and hyphens. It is how Claude and you refer to it.'),
            JV.field('Where it lives', scopeS, editing ? 'To move an agent, duplicate it into the other place.' : draftOnly ? 'Chosen for the whole team.' : (scopes.find((s) => !s.ok)?.why ? `Not available: ${scopes.find((s) => !s.ok).why}` : 'A workspace agent is used here only; one of your own, everywhere.'))),
          JV.field('When to use it', descI, 'Claude reads this to decide when to hand the agent work, so say what it is for.'),
          node('div', { class: 'dlg-row' },
            JV.field('Model', modelS),
            JV.field('What it may use', toolMode)),
          toolNote, tplNote, gridWrap,
          JV.field('Instructions', bodyI, 'The agent\'s whole system prompt. It starts with nothing else: say who it is, how to work and what to report back.'));

        const preview = node('div', { class: 'ab-pane ab-preview', hidden: true });
        const tabs = node('div', { class: 'tabs ab-tabs' });
        const tabDetails = node('button', { type: 'button', class: 'on', onclick: () => show('details') }, 'Details');
        const tabPreview = node('button', { type: 'button', onclick: () => show('preview') }, 'Preview the file');
        tabs.append(tabDetails, tabPreview);

        async function drawPreview() {
          preview.replaceChildren(node('p', { class: 'dlg-text' }, 'Checking…'));
          const r = await api.agentPreview(draft()).catch((e) => ({ ok: false, error: String(e?.message || e) }));
          preview.replaceChildren();
          if (!r.ok) {
            preview.append(node('div', { class: 'ab-error' }, (r.errors?.length ? r.errors.map((e) => e.message) : [r.error || 'This draft cannot be saved yet.']).map((t) => node('div', null, t))));
            return;
          }
          preview.append(node('p', { class: 'dlg-text' },
            r.creating ? 'This file would be created. Nothing is written until you press the button below.' : r.renamed ? 'This file would replace the current one, under its new name. The current version is kept as a backup.' : 'This would replace the current file. The current version is kept as a backup.'),
            node('div', { class: 'ab-path' }, JV.icon('file'), node('code', null, r.path)));
          const loud = r.risks.filter((x) => JV.agentRisk[x]);
          if (loud.length) preview.append(node('div', { class: 'ab-risks' }, loud.map((x) => node('span', { class: `aflag f-${JV.agentRiskLoud.includes(x) ? 'warn' : 'muted'}`, title: JV.agentRisk[x][1] }, JV.agentRisk[x][0]))));
          for (const w of r.warnings) preview.append(node('p', { class: 'ab-toolnote' }, w));
          preview.append(node('pre', { class: 'ab-file' }, r.text));
        }
        function show(which) {
          const p = which === 'preview';
          details.hidden = p;
          preview.hidden = !p;
          tabDetails.classList.toggle('on', !p);
          tabPreview.classList.toggle('on', p);
          if (p) drawPreview();
        }

        let saving = false;
        async function save() {
          if (saving) return;
          clearError();
          const d = draft();
          if (draftOnly) {
            // Checked the same way a save is, so a proposal cannot be handed back broken.
            const r = await api.agentPreview(d).catch((e) => ({ ok: false, error: String(e?.message || e) }));
            if (!r.ok && !r.conflict) { show('details'); showError(r); return; }
            ui.close({ name: d.name, description: d.description, model: d.model, tools: d.tools, body: d.body });
            return;
          }
          saving = true;
          let opts = {};
          try {
            for (let i = 0; i < 3; i++) {
              const r = await api.agentSave(d, opts).catch((e) => ({ ok: false, error: String(e?.message || e) }));
              if (r.ok) { ui.close(r); return; }
              if (r.needsApproval) {
                const got = await approve(r.needs || [], { paths: [r.path], who: d.name, risks: r.risks || [] });
                if (!got) return;
                opts = { ...opts, ...got };
                continue;
              }
              show('details');
              showError(r);
              return;
            }
          } finally { saving = false; }
        }

        ui.body.append(error, tabs, details, preview);
        ui.buttons([
          { label: 'Cancel', onClick: () => ui.close(null) },
          { label: draftOnly ? 'Use these settings' : editing ? 'Save changes' : 'Create agent', primary: true, onClick: save },
        ]);
        if (template) { tplS.value = template.id; applyTemplate(template); }
        nameI.focus();
      },
    });
  }

  async function afterSave(r, what) {
    if (!r?.ok) return;
    JV.notify(`${r.name} was ${what}. ${state.status === 'offline' || state.status === 'closed' ? 'It is read when the session next starts.' : 'Reload the session to use it in the chat.'}`, { level: 'ok', action: 'agents' });
    await JV.refreshAgents?.(`${r.scope}:${r.file}`);
  }

  async function create(template = null) {
    await JV.refreshAgents?.();
    const r = await editor({ mode: 'new', template });
    await afterSave(r, 'created');
  }

  async function loadForEdit(a) {
    const r = await api.agentRead(a.scope, a.file).catch(() => null);
    if (!r?.ok) { JV.notify(r?.error || 'That agent could not be opened.', { level: 'err' }); return null; }
    return r.agent;
  }

  async function edit(a) {
    const cur = await loadForEdit(a);
    if (!cur) return;
    const r = await editor({ mode: 'edit', start: { scope: a.scope, file: a.file, hash: cur.hash, name: cur.name, description: cur.description, tools: cur.tools, model: cur.model, body: cur.body } });
    await afterSave(r, 'saved');
  }

  /** A name for a copy that the rules accept: the same words, lowercased, with "-copy". */
  const copyName = (name) => `${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+|-+$/g, '').slice(0, 58) || 'agent'}-copy`;

  async function duplicate(a) {
    const cur = await loadForEdit(a);
    if (!cur) return;
    // Only what JARVIS manages is copied. Hooks, MCP servers and a permission mode in the
    // original are not carried into a new file by this app.
    if (cur.otherKeys?.length) JV.notify(`The copy starts without ${cur.otherKeys.join(', ')} - those stay with the original.`, { level: 'info' });
    const r = await editor({ mode: 'duplicate', start: { from: cur.name, name: copyName(cur.name), description: cur.description, tools: cur.tools, model: cur.model, body: cur.body } });
    await afterSave(r, 'created');
  }

  // ------------------------------------------------------------- Build my team
  async function team() {
    await loadOptions();
    await JV.refreshAgents?.();
    const scopes = scopeChoices();
    const s = { target: '', scope: scopes.find((x) => x.ok)?.key || 'project', plan: null, members: [], step: 'choose', error: '' };

    const result = await panel({
      title: 'Build my team',
      build(ui) {
        const chosen = () => s.members.filter((m) => m.selected);
        const toolsOf = (m) => (m.custom ? m.tools : [...m.tools, ...m.optional.filter((t) => m.extra.has(t))]);
        const draftOf = (m) => ({ scope: s.scope, name: m.name.trim(), description: m.description, model: m.model || null, tools: toolsOf(m), body: m.body });

        async function plan() {
          ui.body.replaceChildren(node('p', { class: 'dlg-text' }, 'Looking at the projects in this workspace…'));
          ui.buttons([{ label: 'Cancel', onClick: () => ui.close(null) }]);
          const r = await api.agentsTeamPlan(s.target || null).catch((e) => ({ ok: false, error: String(e?.message || e) }));
          if (!r.ok) {
            ui.body.replaceChildren(node('div', { class: 'ab-error' }, r.error || 'A team could not be suggested.'));
            return;
          }
          s.plan = r;
          s.members = r.members.map((m) => ({ ...m, extra: new Set(), custom: false }));
          choose();
        }

        function memberCard(m) {
          const tick = node('input', { type: 'checkbox', checked: m.selected, 'aria-label': `Add ${m.title}` });
          const nameI = node('input', { class: 'field slim tm-name', value: m.name, maxlength: '64', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Agent name' });
          const box = node('div', { class: `team-member${m.selected ? ' on' : ''}` });
          tick.addEventListener('change', () => { m.selected = tick.checked; box.classList.toggle('on', m.selected); footer(); });
          nameI.addEventListener('input', () => { m.name = nameI.value; });
          const tools = node('div', { class: 'tagcloud tm-tools' });
          const drawTools = () => {
            tools.replaceChildren();
            if (m.custom) {
              if (m.tools === null) tools.append(node('span', { class: 'tag warn' }, 'Every tool the chat has'));
              else for (const t of m.tools) tools.append(node('span', { class: 'tag' }, t));
              return;
            }
            for (const t of m.tools) tools.append(node('span', { class: 'tag ro' }, t));
            for (const t of m.optional) {
              const o = node('input', { type: 'checkbox', checked: m.extra.has(t) });
              o.addEventListener('change', () => { if (o.checked) m.extra.add(t); else m.extra.delete(t); });
              tools.append(node('label', { class: 'tm-opt', title: `${m.optionalWhy || ''} Off unless you tick it.`.trim() }, o, node('span', null, `+ ${t}`)));
            }
          };
          drawTools();
          const custom = node('button', { class: 'btn small', type: 'button', onclick: async () => {
            const d = await editor({ mode: 'draft', start: { scope: s.scope, title: m.title, name: m.name, description: m.description, tools: toolsOf(m), model: m.model, body: m.body } });
            if (!d) return;
            Object.assign(m, d, { custom: true });
            nameI.value = m.name;
            desc.textContent = m.description;
            drawTools();
          } }, 'Customize…');
          const desc = node('small', { class: 'tm-desc' }, m.description);
          // Through `only`: the DOM's own append() writes the word "null" for a part that is not there.
          box.append(...only(
            node('div', { class: 'tm-head' }, node('label', { class: 'tm-pick' }, tick, node('b', null, m.title)), nameI, custom),
            node('div', { class: 'tm-why' }, JV.icon('spark'), node('span', null, m.why)),
            desc, tools,
            m.optional.length && !m.custom ? node('small', { class: 'tm-note' }, `It starts read-only. ${m.optionalWhy}`) : null,
            m.existing ? node('small', { class: 'tm-note warn' }, `You already have "${m.existing}", which looks like it covers this, so it is left unticked.`) : null,
            m.conflict ? node('small', { class: 'tm-note warn' }, 'An agent with this name already exists. Give this one another name to add it.') : null));
          return box;
        }

        function footer() {
          const n = chosen().length;
          ui.buttons([
            { label: 'Cancel', onClick: () => ui.close(null) },
            { label: n ? `Preview ${n} file${n === 1 ? '' : 's'}` : 'Nothing chosen', primary: true, disabled: !n || !scopes.find((x) => x.key === s.scope)?.ok, onClick: review },
          ]);
        }

        function choose() {
          s.step = 'choose';
          const p = s.plan;
          const targetS = node('select', { class: 'field' },
            node('option', { value: '' }, `The whole workspace (${p.workspace.name})`),
            p.projects.map((x) => node('option', { value: x.id }, `${x.name}${x.path && x.path !== '.' && x.path !== x.name ? ` - ${x.path}` : ''}`)));
          targetS.value = s.target;
          targetS.addEventListener('change', () => { s.target = targetS.value; plan(); });
          const scopeS = node('select', { class: 'field' }, scopes.map((x) => node('option', { value: x.key, disabled: !x.ok }, x.ok ? x.label : `${x.label} - not available`)));
          scopeS.value = s.scope;
          scopeS.addEventListener('change', () => { s.scope = scopeS.value; footer(); });
          const blocked = scopes.find((x) => !x.ok);
          ui.body.replaceChildren(...only(
            node('p', { class: 'dlg-text' }, 'JARVIS looked at the kinds of project found here and suggests a small team. This is worked out by rule from what is already on disk: nothing was sent to Claude, it cost nothing, and nothing is created until you approve it.'),
            node('div', { class: 'dlg-row' },
              JV.field('Team for', targetS, p.scanned.truncated ? 'The workspace is large, so not every folder was looked at.' : ''),
              JV.field('Add the agents to', scopeS, blocked ? `${blocked.label}: ${blocked.why}` : 'A team for these projects belongs in this workspace.')),
            node('p', { class: 'tm-summary' }, p.summary),
            p.existing.length ? node('p', { class: 'ab-toolnote' }, `Already on your team: ${p.existing.map((a) => `${a.name}${a.enabled ? '' : ' (off)'}`).join(', ')}.`) : null,
            node('div', { class: 'team-list' }, s.members.map(memberCard))));
          footer();
        }

        async function review() {
          s.step = 'review';
          const picked = chosen();
          ui.body.replaceChildren(node('p', { class: 'dlg-text' }, 'Checking…'));
          ui.buttons([{ label: 'Back', onClick: choose }]);
          const previews = [];
          for (const m of picked) previews.push(await api.agentPreview(draftOf(m)).catch((e) => ({ ok: false, error: String(e?.message || e) })));
          const dup = new Set();
          picked.forEach((m, i) => { const k = m.name.trim().toLowerCase(); if (picked.findIndex((x) => x.name.trim().toLowerCase() === k) !== i) dup.add(i); });
          const bad = previews.filter((r, i) => !r.ok || dup.has(i)).length;
          ui.body.replaceChildren(
            node('p', { class: 'dlg-text' }, bad
              ? `${bad} of these cannot be created as they stand. Go back to fix or untick ${bad === 1 ? 'it' : 'them'} - nothing has been written.`
              : `${picked.length === 1 ? 'This file' : `These ${picked.length} files`} would be created, and nothing else is changed. No agent is run: a new agent only works when you or JARVIS hand it a task.`),
            node('div', { class: 'team-files' }, picked.map((m, i) => {
              const r = previews[i];
              const ok = r.ok && !dup.has(i);
              return node('div', { class: `team-file${ok ? '' : ' bad'}` },
                node('div', { class: 'tf-head' }, JV.icon(ok ? 'file' : 'alert'), node('b', null, m.title), node('code', null, ok ? r.path : m.name)),
                ok ? null : node('div', { class: 'tf-error' }, dup.has(i) ? `"${m.name}" is chosen twice.` : (r.errors?.[0]?.message || r.error || 'This one cannot be created.')),
                ok && r.risks.filter((x) => JV.agentRisk[x]).length ? node('div', { class: 'ab-risks' }, r.risks.filter((x) => JV.agentRisk[x]).map((x) => node('span', { class: `aflag f-${JV.agentRiskLoud.includes(x) ? 'warn' : 'muted'}`, title: JV.agentRisk[x][1] }, JV.agentRisk[x][0]))) : null,
                ok ? r.warnings.map((w) => node('small', { class: 'tm-note' }, w)) : null,
                ok ? node('details', { class: 'tf-more' }, node('summary', null, 'Show the file'), node('pre', { class: 'ab-file' }, r.text)) : null);
            })));
          ui.buttons([
            { label: 'Back', onClick: choose },
            { label: `Create ${picked.length} agent${picked.length === 1 ? '' : 's'}`, primary: true, disabled: !!bad, onClick: () => make(picked, previews) },
          ]);
        }

        let making = false;
        async function make(picked, previews) {
          if (making) return;
          making = true;
          try {
            let opts = {};
            for (let i = 0; i < 3; i++) {
              const r = await api.agentsCreate(picked.map(draftOf), opts).catch((e) => ({ ok: false, error: String(e?.message || e) }));
              if (r.needsApproval) {
                const got = await approve(r.needs || [], { paths: previews.map((p) => p.path), who: picked.length === 1 ? picked[0].name : 'these agents', risks: previews.flatMap((p) => p.risks || []) });
                if (!got) return;
                opts = { ...opts, ...got };
                continue;
              }
              done(r);
              return;
            }
          } finally { making = false; }
        }

        function done(r) {
          const made = (r.results || []).filter((x) => x.ok);
          const failed = (r.results || []).filter((x) => !x.ok);
          const live = state.status !== 'offline' && state.status !== 'closed';
          ui.body.replaceChildren(
            node('p', { class: 'dlg-text' }, made.length
              ? `${made.length} agent${made.length === 1 ? ' was' : 's were'} created. ${live ? 'The running session started before they existed, so reload it to use them - the conversation carries on.' : 'They are read when the session next starts.'}`
              : (r.error || 'Nothing was created.')),
            node('div', { class: 'team-files' },
              made.map((x) => node('div', { class: 'team-file' }, node('div', { class: 'tf-head' }, JV.icon('check'), node('b', null, x.name), node('code', null, x.path || '')))),
              failed.map((x) => node('div', { class: 'team-file bad' }, node('div', { class: 'tf-head' }, JV.icon('alert'), node('b', null, x.name)), node('div', { class: 'tf-error' }, x.error || 'Not created.')))));
          ui.buttons([
            made.length && live ? { label: 'Reload session', onClick: () => { ui.close({ made: made.length }); JV.reloadAgentSession?.(); } } : null,
            { label: 'Done', primary: true, onClick: () => ui.close({ made: made.length }) },
          ]);
          JV.refreshAgents?.();
        }

        plan();
      },
    });
    if (result?.made) JV.notify(`${result.made} agent${result.made === 1 ? '' : 's'} added to your team.`, { level: 'ok', action: 'agents' });
  }

  JV.agentBuilder = { create, edit, duplicate, team };
})();
