/* JARVIS window - Dart analysis on the Devices page: what is wrong with an app, as the IDE's
   own "Dart Analysis" tab shows it, so a run that went wrong can be read instead of guessed.

   One app at a time, picked from the chips. Problems are grouped by file, worst first, and
   a click opens the file at that line in VS Code. Hints are hidden until asked for - there
   are usually hundreds, and they are never why a build failed. When a run fails to build,
   the analysis starts by itself for that app. Reading only: nothing here changes a file. */
(() => {
  'use strict';
  const { $, el, state } = JV;

  const PICK = 'jarvis.problemsApp';
  const MAX_ROWS = 400;
  const SEV = [
    ['error', 'Errors', 'alert'],
    ['warning', 'Warnings', 'alert'],
    ['hint', 'Hints', 'info'],
  ];

  let apps = [];
  let app = null;                         // the app whose problems are shown
  const results = new Map();              // app key -> last result
  const busy = new Set();                 // app keys being analysed
  const show = { error: true, warning: true, hint: false };
  const closed = new Set();               // `${app}:${file}` groups folded by hand
  let query = '';
  let all = false;                        // "show every row" pressed for this result

  try { const p = localStorage.getItem(PICK); if (p) app = p; } catch { /* storage off */ }

  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const sentence = (c) => `${plural(c.error, 'error')}, ${plural(c.warning, 'warning')}, ${plural(c.hint, 'hint')}`;
  const secs = (ms) => (ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60000)} min`);

  // ------------------------------------------------------------- the bar
  function renderApps() {
    const host = $('pbApps');
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
    const host = $('pbFilters');
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
    const res = await window.jarvis.openInCode(`${r.dir}/${file}`, line);
    if (res && res.ok === false) JV.notify(res.error || 'Could not open that file.', { level: 'err' });
  };

  function renderBanners(r) {
    const host = $('pbBanners');
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
    const host = $('pbList');
    host.replaceChildren();
    const name = apps.find((a) => a.key === app)?.name || 'this app';
    if (busy.has(app)) { host.appendChild(emptyBox('refresh', `Analysing ${name}…`, 'Usually under a minute. The list appears here when it is done; you can keep working.', { label: 'Stop', run: () => window.jarvis.analyzeCancel(app) })); host.firstChild.classList.add('busy'); return; }
    if (!r) { host.appendChild(emptyBox('bug', `${name} has not been checked yet`, 'Press Analyse to list its errors and warnings. When a run fails to build, this happens by itself.', { label: 'Analyse now', run: () => analyse(app) })); return; }
    if (!r.ok) { host.appendChild(emptyBox('alert', r.cancelled ? 'Stopped' : 'The analysis could not run', r.cancelled ? 'Nothing was checked.' : r.error, { label: 'Try again', run: () => analyse(app) })); return; }

    const q = query.trim().toLowerCase();
    const rows = r.problems.filter((p) => show[p.severity] && (!q || p.file.toLowerCase().includes(q) || p.message.toLowerCase().includes(q) || p.code.includes(q)));
    if (!rows.length) {
      const hidden = SEV.filter(([k]) => !show[k] && r.counts[k]).map(([k, label]) => `${r.counts[k]} ${label.toLowerCase()}`);
      if (!r.total) host.appendChild(emptyBox('check', `${name} is clean`, 'No errors, warnings or hints.')).classList.add('good');
      else if (q) host.appendChild(emptyBox('search', 'Nothing matches that filter', `Nothing in ${name} mentions "${query.trim()}".`, { label: 'Clear the filter', run: () => { query = ''; $('pbSearch').value = ''; render(); } }));
      else host.appendChild(emptyBox('check', r.counts.error ? 'Nothing to show' : `No errors in ${name}`, hidden.length ? `${hidden.join(' and ')} hidden - switch them on above to see them.` : '')).classList.add(r.counts.error ? 'plain' : 'good');
      return;
    }

    const limit = all ? rows.length : MAX_ROWS;
    const groups = new Map();
    for (const p of rows.slice(0, limit)) { if (!groups.has(p.file)) groups.set(p.file, []); groups.get(p.file).push(p); }
    // Many files at once: the ones without an error start folded, so the errors are on screen.
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
          row.title = `${p.code} - open ${file}:${p.line} in VS Code`;
          row.appendChild(JV.icon(p.severity === 'hint' ? 'info' : 'alert'));
          row.appendChild(el('span', 'pb-msg', p.message));
          row.appendChild(el('span', 'pb-line', `:${p.line}`));
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
    const sum = $('pbSummary');
    sum.hidden = !r?.ok;
    if (r?.ok) {
      sum.textContent = sentence(r.counts);
      sum.className = `pb-summary ${r.counts.error ? 'bad' : r.counts.warning ? 'warn' : 'good'}`;
      $('pbNote').textContent = `Checked ${JV.ago(r.at)}, in ${secs(r.ms)}. Click a problem to open it at that line in VS Code.`;
    } else $('pbNote').textContent = 'Why a run went wrong, file by file. Click a problem to open it at that line in VS Code.';
    const run = $('pbRun');
    run.disabled = busy.has(app);
    run.classList.toggle('spinning', busy.has(app));
    run.querySelector('span').textContent = busy.has(app) ? 'Analysing…' : r ? 'Analyse again' : 'Analyse';
    $('pbFix').hidden = !(r?.ok && (r.counts.error || r.counts.warning));
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
    try { r = await window.jarvis.analyze(key); } catch (e) { r = { ok: false, error: String(e?.message || e) }; }
    busy.delete(key);
    results.set(key, r);
    render();
    JV.emit('analysis_done', { key, result: r });
    if (!quiet && r?.ok) {
      const name = r.name || key;
      if (r.counts.error) JV.notify(`${name} did not build: ${plural(r.counts.error, 'error')}${r.conflicts?.length ? ' - an unresolved merge conflict is behind them' : ''}. They are listed on the Devices page.`, { level: 'err', action: 'devices', desktop: true, key: `pb-${key}` });
      else JV.notify(`${name} did not build, but the analyser found no errors - the reason is in the run's own output.`, { level: 'warn', action: 'devices', key: `pb-${key}` });
    }
    return r;
  }
  JV.analyseApp = analyse;
  // The Projects view shows the last analysis of a project, and whether one is running.
  JV.analysisFor = (key) => ({ result: results.get(key) || null, busy: busy.has(key) });
  JV.showAnalysis = (key) => { if (key) { app = key; try { localStorage.setItem(PICK, key); } catch { /* storage off */ } } render(); };

  /** The problems, as a message for the chat - put in the box, not sent. */
  function askToFix() {
    const r = results.get(app);
    if (!r?.ok) return;
    const sev = r.counts.error ? 'error' : 'warning';
    const list = r.problems.filter((p) => p.severity === sev);
    const lines = list.slice(0, 40).map((p) => `- ${r.dir}/${p.file}:${p.line} - ${p.message}`);
    const conflict = (r.conflicts || []).map((c) => `Note: ${r.dir}/${c.file} has unresolved git conflict markers from line ${c.line}; ask me which side to keep before changing it.`);
    const text = [
      `dart analyze reports ${plural(list.length, sev)} in ${r.name} (${r.dir}). Please fix ${list.length === 1 ? 'it' : 'them'}, with the smallest change that is correct, then run dart analyze again to confirm.`,
      ...conflict,
      '',
      ...lines,
      ...(list.length > lines.length ? [`…and ${list.length - lines.length} more.`] : []),
    ].join('\n');
    JV.chat.insert(text);
  }

  $('pbRun').onclick = () => analyse(app);
  $('pbFix').onclick = askToFix;
  let typing = null;
  $('pbSearch').addEventListener('input', (e) => { query = e.target.value; all = false; clearTimeout(typing); typing = setTimeout(() => renderList(results.get(app)), 140); });
  $('pbSearch').addEventListener('keydown', (e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); query = ''; e.target.value = ''; renderList(results.get(app)); } });

  // A run that ended by itself before the app ever started: the build failed. Say why.
  JV.on('flutter_state', (e) => {
    if (e.state !== 'exited' || !e.failed || e.built || !e.app) return;
    if (!apps.some((a) => a.key === e.app && a.found)) return;
    app = e.app;
    try { localStorage.setItem(PICK, app); } catch { /* storage off */ }
    analyse(e.app, { quiet: false }).then(() => {
      if (state.view === 'devices') $('devProblems').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
  // The workspace's Dart and Flutter projects, discovered - apps and packages alike. Looked
  // up again whenever the Devices page opens or the workspace is scanned again.
  async function loadApps() {
    try { apps = (await window.jarvis.dartProjects()) || []; } catch { apps = []; }
    $('devProblems').hidden = !apps.length;
    render();
  }
  JV.on('view', (v) => { if (v === 'devices') loadApps(); });
  JV.on('projects_changed', () => loadApps());
  loadApps();

  // ------------------------------------------------------------- capture demo (JARVIS_DEMO=problems)
  // A made-up result, for a screenshot without waiting on a real analysis.
  const earlier = window.__jarvisDemo;
  window.__jarvisDemo = (what) => {
    if (what !== 'problems') { earlier?.(what); return; }
    const demo = apps[0] || { key: 'shop_app', name: 'Shop App', dir: 'shop_app', found: true };
    if (!apps.length) { apps = [demo]; $('devProblems').hidden = false; }
    const key = demo.key;
    const f = 'lib/screens/orders_screen.dart';
    const errs = [[212, 'Expected an identifier.'], [212, "Expected to find ','."], [212, "The name 'Updated' isn't a type, so it can't be used as a type argument."], [212, "The name 'upstream' isn't a type, so it can't be used as a type argument."], [214, "The '===' operator is not supported."], [215, "Undefined name 'onTap'."]]
      .map(([line, message]) => ({ severity: 'error', code: 'syntax', file: f, line, col: 1, message }));
    const warns = [['lib/models/app_version.dart', 1, "Unused import: 'dart:io'."], ['lib/models/user.dart', 77, "The left operand can't be null, so the right operand is never executed."], ['lib/models/user.dart', 82, "The left operand can't be null, so the right operand is never executed."]]
      .map(([file, line, message]) => ({ severity: 'warning', code: 'lint', file, line, col: 1, message }));
    app = key;
    results.set(key, { ok: true, app: key, name: demo.name, dir: demo.dir, at: Date.now() - 40000, ms: 38000, counts: { error: 18, warning: 88, hint: 487 }, conflicts: [{ file: f, line: 212, lines: [212, 214, 216] }], total: 593, truncated: false, problems: [...errs, ...warns] });
    render();
    $('devProblems').scrollIntoView({ block: 'start' });
  };
})();
