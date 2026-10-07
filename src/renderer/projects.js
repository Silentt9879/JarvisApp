/* JARVIS window - New project: a starter for a new folder (a README, a CLAUDE.md that tells Claude
   Code what the project is for, and a git repository when git is installed). Built into the
   Workspace view. Flutter and .NET starters use their own tools when those are on this PC. */
(() => {
  'use strict';
  const { $, node, state } = JV;
  const api = window.jarvis;

  async function openNewProject() {
    const templates = await api.projectTemplates().catch(() => []);
    if (!templates.length) { JV.notify('The starters could not be loaded. Try again in a moment.', { level: 'err' }); return; }
    const name = node('input', { class: 'field', placeholder: 'For example: Shop app', maxlength: '60', autocomplete: 'off', 'aria-label': 'Project name' });
    const starter = node('select', { class: 'field', 'aria-label': 'Starter' },
      templates.map((t) => node('option', { value: t.id }, t.label)));
    const blurb = node('small', { class: 'dlg-hint' }, templates[0].blurb);
    starter.addEventListener('change', () => { blurb.textContent = templates.find((t) => t.id === starter.value)?.blurb || ''; });
    let parent = state.info?.cwd || '';
    const where = node('b', { class: 'wiz-path' }, parent || 'Choose a folder');
    const pick = node('button', { class: 'btn small', type: 'button', onclick: async () => {
      const r = await api.pickWorkspace().catch(() => null);
      if (r?.ok && r.path) { parent = r.path; where.textContent = r.path; }
    } }, 'Choose a different folder…');
    const result = node('div', { class: 'proj-result', 'aria-live': 'polite' });

    await JV.dialog({
      title: 'New project',
      wide: true,
      body: [
        JV.field('Name', name, 'Letters, numbers, spaces, dashes and underscores.'),
        JV.field('Starter', starter),
        blurb,
        node('div', { class: 'field-row' }, node('span', null, 'Folder'), where, pick),
        result,
      ],
      buttons: [
        { label: 'Close', value: null },
        { label: 'Create project', primary: true, role: 'create', onClick: async () => {
          result.textContent = 'Creating…';
          result.dataset.level = '';
          const r = await api.createProject({ parent, name: name.value, template: starter.value }).catch((e) => ({ ok: false, error: e.message }));
          if (!r?.ok) {
            result.dataset.level = 'err';
            result.textContent = r?.error || 'Could not create the project.';
            return false;
          }
          result.dataset.level = 'ok';
          result.replaceChildren(
            node('p', { class: 'dlg-text' }, `Created ${r.name}, in ${parent}.`),
            ...(r.notes || []).map((n) => node('small', { class: 'dlg-hint' }, n)),
            node('div', { class: 'wiz-actions' },
              node('button', { class: 'btn small', onclick: () => api.openProject(r.path) }, 'Open the folder'),
              node('button', { class: 'btn small btn-primary', onclick: async () => {
                // Added to the list, then the usual switch: it asks about trust, then restarts.
                const added = await api.workspaceAdd(r.path).catch((e) => ({ ok: false, error: e.message }));
                if (!added?.ok) { JV.notify(added?.error || 'It could not be added as a workspace.', { level: 'err' }); return; }
                const listed = (await api.workspaces().catch(() => null))?.workspaces.find((x) => x.id === added.workspace.id) || { ...added.workspace, trusted: false };
                JV.switchWorkspace?.(listed);
              } }, 'Use it as the workspace')));
          return false;
        } },
      ],
      onOpen: () => name.focus(),
    });
  }

  JV.initProjects = () => {
    const host = $('view-workspace');
    if (!host || host.dataset.projects) return;
    host.dataset.projects = '1';
    host.prepend(node('div', { class: 'proj-bar' },
      node('button', { class: 'btn btn-primary small', onclick: openNewProject }, JV.icon('plus'), ' New project'),
      node('small', { class: 'dlg-hint' }, 'Start a new folder with a README, a CLAUDE.md and git.')));
  };
})();
