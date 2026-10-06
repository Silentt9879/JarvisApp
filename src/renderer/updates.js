/* JARVIS window - Settings > Updates: JARVIS itself, VS Code and Claude Code. Checking only
   looks. An update starts from its own button; JARVIS asks once before it closes, then
   downloads, installs and opens itself again. */
(() => {
  'use strict';
  const { $, state } = JV;
  const api = window.jarvis;
  const TOOLS = ['jarvis', 'vscode', 'claude'];

  // Element ids (index.html) for each card.
  const CARD = {
    jarvis: { note: 'updNoteJarvis', go: 'updGoJarvis' },
    vscode: { note: 'updNoteVscode', go: 'updGoVscode' },
    claude: { note: 'updNoteClaude', go: 'updGoClaude' },
  };
  const LABEL = {
    jarvis: 'Update JARVIS',
    vscode: 'Update VS Code',
    claude: 'Update Claude Code',
    claudeInstall: 'Install Claude Code',
  };
  const busy = { jarvis: false, vscode: false, claude: false };
  const last = {}; // tool -> the last check's answer
  let jarvisNotes = '';

  const mb = (bytes) => (bytes / 1048576).toFixed(0);

  function note(tool, text, kind) {
    const n = $(CARD[tool].note);
    n.textContent = text;
    n.dataset.kind = kind || '';
  }

  function setBusy(tool, on) {
    busy[tool] = on;
    $(CARD[tool].go).disabled = on;
    $('updCheckAll').disabled = TOOLS.some((t) => busy[t]);
  }

  function setGo(tool, show, label) {
    const b = $(CARD[tool].go);
    b.hidden = !show;
    if (label) b.textContent = label;
  }

  function stampChecked() {
    const t = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    $('updLast').textContent = `Last checked at ${t}${state.info ? ` · JARVIS v${state.info.version}` : ''}`;
  }

  // ------------------------------------------------------------- what each card says, in plain words

  function describe(tool, s) {
    if (!s) return { text: 'Could not check right now. Try again in a moment.', kind: 'warn', go: false };
    if (s.error) return { text: s.error, kind: 'warn', go: false };
    if (tool === 'jarvis') {
      if (s.available) return { text: `Version ${s.latest} is ready to install. You have ${s.current}.`, kind: 'ok', go: true, label: LABEL.jarvis };
      return { text: `You have the newest version (${s.current}).`, kind: '', go: false };
    }
    if (tool === 'vscode') {
      if (s.available) return { text: `Version ${s.latest} is ready. You have ${s.installed}.`, kind: 'ok', go: true, label: LABEL.vscode };
      return { text: `You have the newest version (${s.installed}).`, kind: '', go: false };
    }
    // Claude Code: the command you use in a terminal, if it is there.
    const built = state.version ? ` JARVIS uses its own copy (v${state.version}), updated with JARVIS.` : '';
    if (!s.installed) return { text: `Not installed in your terminal yet. Install it to use Claude Code outside JARVIS.${built}`, kind: 'ok', go: true, label: LABEL.claudeInstall };
    if (s.available) return { text: `Version ${s.latest} is ready. You have ${s.installed}.${built}`, kind: 'ok', go: true, label: LABEL.claude };
    return { text: `You have the newest version (${s.installed}).${built}`, kind: '', go: false };
  }

  // ------------------------------------------------------------- check

  async function check(tool) {
    if (busy[tool]) return;
    setBusy(tool, true);
    note(tool, 'Checking…');
    try {
      const s = await api.updateCheck(tool);
      last[tool] = s;
      if (tool === 'jarvis') jarvisNotes = s?.notes || '';
      const d = describe(tool, s);
      note(tool, d.text, d.kind);
      setGo(tool, d.go, d.label);
    } catch (e) {
      note(tool, `Could not check: ${e.message}`, 'warn');
    } finally {
      setBusy(tool, false);
    }
  }

  async function checkAll() {
    await Promise.all(TOOLS.map(check));
    stampChecked();
  }

  // ------------------------------------------------------------- VS Code and Claude Code

  async function runTool(tool) {
    if (busy[tool]) return;
    setBusy(tool, true);
    note(tool, 'Updating. This can take a few minutes. You can keep working meanwhile.');
    const name = tool === 'vscode' ? 'VS Code' : 'Claude Code';
    try {
      const r = await api.updateRun(tool);
      if (!r?.ok) {
        note(tool, r?.error || 'The update did not finish. Try again in a moment.', 'warn');
        JV.notify(r?.error || `The ${name} update did not finish.`, { level: 'err', action: () => JV.openSettings?.() });
        return;
      }
      JV.notify(r.upToDate ? `${name} is already up to date.` : `${name} is updated.`, { level: 'ok' });
      setBusy(tool, false);
      await check(tool);
    } catch (e) {
      note(tool, `The update did not finish: ${e.message}`, 'warn');
    } finally {
      setBusy(tool, false);
    }
  }

  // ------------------------------------------------------------- JARVIS (asks once)

  function askJarvis() {
    const s = last.jarvis;
    if (!s?.available || busy.jarvis) return;
    $('updNewJarvis').textContent = `v${s.latest}`;
    const what = $('updWhatsNewJarvis');
    const clip = jarvisNotes.length > 400 ? `${jarvisNotes.slice(0, 400).trimEnd()}…` : jarvisNotes;
    what.textContent = clip ? `What's new: ${clip}` : '';
    what.hidden = !clip;
    $('updConfirmJarvis').hidden = false;
    $('updYesJarvis').focus();
  }

  function closeJarvisAsk() {
    $('updConfirmJarvis').hidden = true;
    $(CARD.jarvis.go).focus();
  }

  function showJarvisProgress(text, pct) {
    const box = $('updBarJarvis');
    box.hidden = false;
    const bar = box.querySelector('.upd-bar');
    bar.classList.toggle('indeterminate', pct == null);
    bar.firstElementChild.style.width = pct == null ? '' : `${pct}%`;
    $('updPctJarvis').textContent = text;
  }

  function hideJarvisProgress() {
    $('updBarJarvis').hidden = true;
  }

  async function runJarvis() {
    if (busy.jarvis) return;
    $('updConfirmJarvis').hidden = true;
    setBusy('jarvis', true);
    note('jarvis', 'Downloading the update…');
    showJarvisProgress('Starting…', null);
    try {
      const r = await api.updateRun('jarvis');
      if (!r?.ok) {
        hideJarvisProgress();
        setBusy('jarvis', false);
        note('jarvis', r?.error || 'The update did not finish. Try again in a moment.', 'warn');
        JV.notify(r?.error || 'The JARVIS update did not finish.', { level: 'err', action: () => JV.openSettings?.() });
        return;
      }
      if (r.upToDate) { hideJarvisProgress(); setBusy('jarvis', false); await check('jarvis'); return; }
      // JARVIS is closing now. The installer runs and JARVIS opens again on its own.
      showJarvisProgress('Installing. JARVIS will close and open again in about a minute.', 100);
      note('jarvis', `Installing version ${r.version}…`, 'ok');
    } catch (e) {
      hideJarvisProgress();
      setBusy('jarvis', false);
      note('jarvis', `The update did not finish: ${e.message}`, 'warn');
    }
  }

  // ------------------------------------------------------------- wiring

  function wire() {
    $('updCheckAll').onclick = checkAll;
    $(CARD.jarvis.go).onclick = askJarvis;
    $(CARD.vscode.go).onclick = () => runTool('vscode');
    $(CARD.claude.go).onclick = () => runTool('claude');
    $('updCancelJarvis').onclick = closeJarvisAsk;
    $('updYesJarvis').onclick = runJarvis;
    api.onUpdateProgress?.((p) => {
      if (p.tool !== 'jarvis' || !p.total) return;
      const pct = Math.min(100, Math.round((p.received / p.total) * 100));
      showJarvisProgress(`Downloading… ${pct}% (${mb(p.received)} of ${mb(p.total)} MB)`, pct);
    });
  }

  wire();

  // Each time Settings opens, look at all three. Checking never installs anything.
  JV.loadUpdates = () => {
    if (!$('updCheckAll')) return;
    $('updConfirmJarvis').hidden = true;
    hideJarvisProgress();
    checkAll();
  };
})();
