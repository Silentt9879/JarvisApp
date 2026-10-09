/* JARVIS window - .NET build diagnostics on the Devices page: what is wrong with a project, as
   Visual Studio's own Error List shows it after a build, so a failed build can be read instead
   of guessed at.

   The same shape as Dart analysis (problems.js) - one project at a time from the chips,
   problems grouped by file, worst first, a click opens the file at that line in VS Code,
   hints hidden by default. The one real difference: there is no "just analyse, don't build"
   mode for .NET the way `dart analyze` is - every run here is a real `dotnet build`, so it is
   slower, and a project already mid-build elsewhere (Visual Studio, `dotnet watch`) cannot be
   analysed at the same time without the two builds fighting over the same files - the
   existing port/lock-file messages webapps.mjs already gives cover that case; this reuses the
   result if the SDK says so. Reading only beyond that: nothing here fixes or formats a file. */
(() => {
  'use strict';
  const { $, el, state } = JV;

  const PICK = 'jarvis.dotnetProblemsApp';
  const OPEN = 'jarvis.dotnetProblemsOpen';
  const MAX_ROWS = 400;
  const SEV = [
    ['error', 'Errors', 'alert'],
    ['warning', 'Warnings', 'alert'],
    ['hint', 'Hints', 'info'],
  ];

  let apps = [];
  let app = null;
  const results = new Map();
  const busy = new Set();
  const show = { error: true, warning: true, hint: false };
  const closed = new Set();
  let query = '';
  let all = false;

  try { const p = localStorage.getItem(PICK); if (p) app = p; } catch { /* storage off */ }

  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const sentence = (c) => `${plural(c.error, 'error')}, ${plural(c.warning, 'warning')}, ${plural(c.hint, 'hint')}`;
  const secs = (ms) => (ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60000)} min`);

  // ------------------------------------------------------------- the bar
  function renderApps() {
    const host = $('dnpbApps');
    host.replaceChildren();
    for (const a of apps) {
      const r = results.get(a.key);
      const b = el('button', `kind pb-app${a.key === app ? ' on' : ''}${a.found ? '' : ' missing'}`);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(a.key === app));
      b.disabled = !a.found;
      b.title = a.found ? `${a.dir}` : `${a.dir} is not in this workspace`;
      b.appendChild(el('span', null, a.name));
      if (busy.has(a.key)) b.appendChild(el('i', 'pb-spin'));
      else if (r?.ok) {
        const n = r.counts.error;
        b.appendChild(el('em', n ? 'bad' : 'good', n ? String(n) : '✓'));
      }
      b.onclick = () => { if (app !== a.key) { app = a.key; all = false; try { localStorage.setItem(PICK, app); } catch { /* storage off */ } render(); } };
      host.appendChild(b);
    }
  }

  function renderFilters(r) {
    const host = $('dnpbFilters');
    host.replaceChildren();
    for (const [key, label] of SEV) {
      const b = el('button', `kind pb-f pb-${key}${show[key] ? ' on' : ''}`);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(show[key]));
      b.appendChild(el('span', null, label));
      if (r?.ok) b.appendChild(el('em', null, String(r.counts[key])));
      b.onclick = () => { show[key] = !show[key]; all = false; render(); };
      host.appendChild(b);
    }
  }

  // ------------------------------------------------------------- the list
  function emptyBox(icon, title, sub, action) {
    const box = el('div', 'pb-empty');
    box.appendChild(JV.icon(icon));
    box.appendChild(el('b', null, title));
    if (sub) box.appendChild(el('p', null, sub));
    if (action) {
      const b = el('button', 'btn small', action.label);
      b.type = 'button';
      b.onclick = action.run;
      box.appendChild(b);
    }
    return box;
  }

  const openAt = async (r, file, line) => {
    const res = await window.jarvis.openInCode(`${r.dir}/${file}`, line > 0 ? line : undefined);
    if (res && res.ok === false) JV.notify(res.error || 'Could not open that file.', { level: 'err' });
  };

  function renderBanners(r) {
    const host = $('dnpbBanners');
    host.replaceChildren();
    if (!r?.ok) return;
    for (const c of r.conflicts || []) {
      const n = r.problems.filter((p) => p.file === c.file && p.severity === 'error').length;
      const box = el('div', 'pb-banner');
      box.appendChild(JV.icon('branch'));
      const text = el('div', 'pb-banner-text');
      text.appendChild(el('b', null, 'Unresolved merge conflict'));
      text.appendChild(el('span', null, ` in ${c.file}, line ${c.line}. Git left its markers (<<<<<<<, =======, >>>>>>>) in the file, and ${n > 1 ? `${n} of these errors come` : 'the error there comes'} from them, not from the code. Keep one side, delete the markers, and they go together.`));
      box.appendChild(text);
      const b = el('button', 'btn small', `Open at line ${c.line}`);
      b.type = 'button';
      b.onclick = () => openAt(r, c.file, c.line);
      box.appendChild(b);
      host.appendChild(box);
    }
    if (r.truncated) host.appendChild(el('div', 'pb-banner quiet', `Showing the first ${r.problems.length} of ${r.total} problems - the worst come first, and the counts above are complete.`));
  }

  function renderList(r) {
    const host = $('dnpbList');
    host.replaceChildren();
    const name = apps.find((a) => a.key === app)?.name || 'this project';
    if (busy.has(app)) { host.appendChild(emptyBox('refresh', `Building ${name}…`, 'A real dotnet build - usually under a minute, longer the first time or after a package change. The list appears here when it is done; you can keep working.', { label: 'Stop', run: () => window.jarvis.dotnetAnalyzeCancel(app) })); host.firstChild.classList.add('busy'); return; }
    if (!r) { host.appendChild(emptyBox('bug', `${name} has not been checked yet`, 'Press Build to list its errors and warnings. When a run fails to start, this happens by itself.', { label: 'Build now', run: () => analyse(app) })); return; }
    if (!r.ok) { host.appendChild(emptyBox('alert', r.cancelled ? 'Stopped' : 'The build could not run', r.cancelled ? 'Nothing was checked.' : r.error, { label: 'Try again', run: () => analyse(app) })); return; }

    const q = query.trim().toLowerCase();
    const rows = r.problems.filter((p) => show[p.severity] && (!q || p.file.toLowerCase().includes(q) || p.message.toLowerCase().includes(q) || p.code.includes(q)));
    if (!rows.length) {
      const hidden = SEV.filter(([k]) => !show[k] && r.counts[k]).map(([k, label]) => `${r.counts[k]} ${label.toLowerCase()}`);
      if (!r.total) host.appendChild(emptyBox('check', `${name} is clean`, 'No errors, warnings or hints.')).classList.add('good');
      else if (q) host.appendChild(emptyBox('search', 'Nothing matches that filter', `Nothing in ${name} mentions "${query.trim()}".`, { label: 'Clear the filter', run: () => { query = ''; $('dnpbSearch').value = ''; render(); } }));
      else host.appendChild(emptyBox('check', r.counts.error ? 'Nothing to show' : `No errors in ${name}`, hidden.length ? `${hidden.join(' and ')} hidden - switch them on above to see them.` : '')).classList.add(r.counts.error ? 'plain' : 'good');
      return;
    }

    const limit = all ? rows.length : MAX_ROWS;
    const groups = new Map();
    for (const p of rows.slice(0, limit)) { if (!groups.has(p.file)) groups.set(p.file, []); groups.get(p.file).push(p); }
    const crowded = rows.length > 120;
    for (const [file, list] of groups) {
      const key = `${app}:${file}`;
      const hasError = list.some((p) => p.severity === 'error');
      const folded = closed.has(key) ? true : closed.has(`open:${key}`) ? false : (crowded && !hasError);
      const g = el('div', `pb-group${folded ? ' folded' : ''}`);
      const head = el('button', 'pb-file');
      head.type = 'button';
      head.setAttribute('aria-expanded', String(!folded));
      head.appendChild(JV.icon('chevron'));
      const slash = file.lastIndexOf('/');
      head.appendChild(el('b', null, slash < 0 ? file : file.slice(slash + 1)));
      if (slash >= 0) head.appendChild(el('small', null, file.slice(0, slash)));
      const tally = el('span', 'pb-tally');
      for (const [k] of SEV) { const n = list.filter((p) => p.severity === k).length; if (n) tally.appendChild(el('em', `pb-${k}`, String(n))); }
      head.appendChild(tally);
      head.onclick = () => {
        if (folded) { closed.delete(key); closed.add(`open:${key}`); } else { closed.delete(`open:${key}`); closed.add(key); }
        renderList(results.get(app));
      };
      g.appendChild(head);
      if (!folded) {
        for (const p of list) {
          const row = el('button', `pb-row pb-${p.severity}`);
          row.type = 'button';
          // A project-level diagnostic (a restored package, say) has no real line - line 0.
          row.title = p.line > 0 ? `${p.code} - open ${file}:${p.line} in VS Code` : `${p.code} - open ${file} in VS Code`;
          row.appendChild(JV.icon(p.severity === 'hint' ? 'info' : 'alert'));
          row.appendChild(el('span', 'pb-msg', p.message));
          if (p.line > 0) row.appendChild(el('span', 'pb-line', `:${p.line}`));
          row.onclick = () => openAt(r, file, p.line);
          g.appendChild(row);
        }
      }
      host.appendChild(g);
    }
    if (rows.length > limit) {
      const more = el('button', 'btn small pb-more', `Show all ${rows.length} (${rows.length - limit} more)`);
      more.type = 'button';
      more.onclick = () => { all = true; renderList(results.get(app)); };
      host.appendChild(more);
    }
  }

  function render() {
    if (!apps.length) return;
    if (!app || !apps.some((a) => a.key === app && a.found)) app = (apps.find((a) => a.found) || apps[0]).key;
    const r = results.get(app);
    renderApps();
    renderFilters(r);
    const sum = $('dnpbSummary');
    sum.hidden = !r?.ok;
    if (r?.ok) {
      sum.textContent = sentence(r.counts);
      sum.className = `pb-summary ${r.counts.error ? 'bad' : r.counts.warning ? 'warn' : 'good'}`;
      $('dnpbNote').textContent = `Checked ${JV.ago(r.at)}, in ${secs(r.ms)}. Click a problem to open it at that line in VS Code.`;
    } else $('dnpbNote').textContent = 'Why a build went wrong, file by file. Click a problem to open it at that line in VS Code.';
    const run = $('dnpbRun');
    run.disabled = busy.has(app);
    run.classList.toggle('spinning', busy.has(app));
    run.querySelector('span').textContent = busy.has(app) ? 'Building…' : r ? 'Build again' : 'Build';
    $('dnpbFix').hidden = !(r?.ok && (r.counts.error || r.counts.warning));
    renderBanners(r);
    renderList(r);
  }

  // ------------------------------------------------------------- running it
  async function analyse(key, { quiet = true } = {}) {
    if (!key || busy.has(key)) return null;
    busy.add(key);
    all = false;
    render();
    let r;
    try { r = await window.jarvis.dotnetAnalyze(key); } catch (e) { r = { ok: false, error: String(e?.message || e) }; }
    busy.delete(key);
    results.set(key, r);
    render();
    JV.emit('dotnet_analysis_done', { key, result: r });
    if (!quiet && r?.ok) {
      const name = r.name || key;
      if (r.counts.error) JV.notify(`${name} did not build: ${plural(r.counts.error, 'error')}${r.conflicts?.length ? ' - an unresolved merge conflict is behind them' : ''}. They are listed on the Devices page.`, { level: 'err', action: 'devices', desktop: true, key: `dnpb-${key}` });
      else JV.notify(`${name} did not build, but the build reported no errors - the reason is in the run's own output.`, { level: 'warn', action: 'devices', key: `dnpb-${key}` });
    }
    return r;
  }
  JV.analyseDotnet = analyse;
  JV.dotnetAnalysisFor = (key) => ({ result: results.get(key) || null, busy: busy.has(key) });
  JV.showDotnetAnalysis = (key) => { if (key) { app = key; try { localStorage.setItem(PICK, key); } catch { /* storage off */ } } render(); };

  /** The problems, as a message for the chat - put in the box, not sent. */
  function askToFix() {
    const r = results.get(app);
    if (!r?.ok) return;
    const sev = r.counts.error ? 'error' : 'warning';
    const list = r.problems.filter((p) => p.severity === sev);
    const lines = list.slice(0, 40).map((p) => `- ${r.dir}/${p.file}${p.line > 0 ? `:${p.line}` : ''} - ${p.message}`);
    const conflict = (r.conflicts || []).map((c) => `Note: ${r.dir}/${c.file} has unresolved git conflict markers from line ${c.line}; ask me which side to keep before changing it.`);
    const text = [
      `dotnet build reports ${plural(list.length, sev)} in ${r.name} (${r.dir}). Please fix ${list.length === 1 ? 'it' : 'them'}, with the smallest change that is correct, then build again to confirm.`,
      ...conflict,
      '',
      ...lines,
      ...(list.length > lines.length ? [`…and ${list.length - lines.length} more.`] : []),
    ].join('\n');
    JV.chat.insert(text);
  }

  // ------------------------------------------------------------- open/collapsed
  // Closed by default (and remembered) - opened by hand, or by itself when a build fails.
  let open = false;
  try { open = localStorage.getItem(OPEN) === '1'; } catch { /* storage off */ }
  function setOpen(v) {
    open = v;
    $('devDotnetProblems').classList.toggle('collapsed', !open);
    $('dnpbHead').setAttribute('aria-expanded', String(open));
    try { localStorage.setItem(OPEN, open ? '1' : '0'); } catch { /* storage off */ }
  }
  setOpen(open);
  $('dnpbHead').addEventListener('click', () => setOpen(!open));
  $('dnpbHead').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    setOpen(!open);
  });

  $('dnpbRun').onclick = () => analyse(app);
  $('dnpbFix').onclick = askToFix;
  let typing = null;
  $('dnpbSearch').addEventListener('input', (e) => { query = e.target.value; all = false; clearTimeout(typing); typing = setTimeout(() => renderList(results.get(app)), 140); });
  $('dnpbSearch').addEventListener('keydown', (e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); query = ''; e.target.value = ''; renderList(results.get(app)); } });

  // A dotnet watch/run that ended by itself before the site ever started listening: the build
  // failed. Say why - the same trigger Dart analysis has for a Flutter run that never started.
  JV.on('web_state', (e) => {
    if (e.state !== 'exited' || !e.failed || !e.key) return;
    if (!apps.some((a) => a.key === e.key && a.found)) return;
    app = e.key;
    try { localStorage.setItem(PICK, app); } catch { /* storage off */ }
    analyse(e.key, { quiet: false }).then(() => {
      setOpen(true);
      if (state.view === 'devices') $('devDotnetProblems').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
  // The workspace's .NET projects, discovered - sites, APIs, libraries and test projects alike.
  async function loadApps() {
    try { apps = (await window.jarvis.dotnetProjects()) || []; } catch { apps = []; }
    $('devDotnetProblems').hidden = !apps.length;
    render();
  }
  JV.on('view', (v) => { if (v === 'devices') loadApps(); });
  JV.on('projects_changed', () => loadApps());
  loadApps();
})();
