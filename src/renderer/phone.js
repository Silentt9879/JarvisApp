/* JARVIS - one phone in its own window (phone.html), opened from its card in the Devices
   view. The same screen, keys and flutter run controls as a phone shown fullscreen there,
   so it looks and behaves the same; the decoder and touch handling are phone-screen.js.

   While this window is open the main process sends this phone's video here and nowhere
   else. Closing it - or "Back into JARVIS" - returns the phone to its card.

   The phone itself can change under this window: unplugged and a different one plugged
   into the same cable, say for testing. `serial` is therefore `let`, not `const` - every
   function below reads it live, so a switch (see `adopt`) takes effect everywhere at once
   without re-wiring a thing. */
(() => {
  'use strict';
  const { el } = JV;
  let serial = new URLSearchParams(location.search).get('serial') || '';
  const LABELS = 'jarvis.deviceLabels';

  // The theme Settings pinned, as in the main window (data-theme on <html>), and the window
  // buttons in matching colours.
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    const t = JV.prefs.theme === 'light' || JV.prefs.theme === 'dark' ? JV.prefs.theme : 'system';
    if (t === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    const dark = t === 'dark' || (t === 'system' && systemDark.matches);
    window.jarvis.titleBar?.(dark ? 'dark' : 'light');
  }
  applyTheme();
  systemDark.addEventListener('change', applyTheme);

  const labels = () => { try { return JSON.parse(localStorage.getItem(LABELS) || '{}'); } catch { return {}; } };
  function saveLabel(v) {
    try { const l = labels(); if (v) l[serial] = v; else delete l[serial]; localStorage.setItem(LABELS, JSON.stringify(l)); } catch { /* storage off */ }
  }

  const c = { live: false, starting: false, run: null, state: 'device', screen: null };
  const appInfo = new Map(); // app key -> { name, warn }, from the workspace's Flutter apps

  function iconBtn(icon, title, onClick) {
    const b = el('button', 'icon-btn dev-btn');
    b.type = 'button';
    b.title = title;
    b.appendChild(JV.icon(icon));
    b.onclick = onClick;
    return b;
  }
  const input = (ev) => window.jarvis.deviceInput(serial, ev);

  // ------------------------------------------------------------- the window's contents
  // A fullscreen phone card: its head is this window's title bar, under the caption buttons.
  const root = el('div', 'dev-card full hud-panel live-window');
  const head = el('div', 'dev-head');
  c.label = el('input', 'dev-label');
  c.label.placeholder = 'Name it…';
  c.label.title = 'Give this phone a name, e.g. Referrer';
  c.label.maxLength = 24;
  c.label.value = labels()[serial] || '';
  c.label.onchange = () => { saveLabel(c.label.value.trim()); setTitle(); };
  const id = el('div', 'dev-id');
  c.model = el('b', null, serial);
  c.serialEl = el('small', null, serial);
  id.appendChild(c.model);
  id.appendChild(c.serialEl);
  c.status = el('span', 'pill', 'Connecting…');
  // Its own icon-row (not a lone icon-btn): that class floats right with margin-left:auto,
  // which is right for a single trailing button but would shove the status pill after it
  // out of place here.
  const headActs = el('div', 'icon-row');
  c.switchBtn = iconBtn('swap', 'Switch to a different phone', () => openSwitcher());
  headActs.appendChild(c.switchBtn);
  head.appendChild(c.label);
  head.appendChild(id);
  head.appendChild(headActs);
  head.appendChild(c.status);
  root.appendChild(head);

  const screen = el('div', 'dev-screen');
  c.canvas = el('canvas', 'dev-canvas');
  c.canvas.width = 360; c.canvas.height = 780;
  c.canvas.tabIndex = 0;
  c.canvas.title = 'Click to tap, drag to swipe, wheel to scroll. Type when selected; Esc is Back.';
  c.overlay = el('div', 'dev-overlay');
  c.ov = el('div', 'ov-card');
  c.overlay.appendChild(c.ov);
  screen.appendChild(c.canvas);
  screen.appendChild(c.overlay);
  root.appendChild(screen);
  JV.phone.wireInput(c.canvas, { live: () => c.live, send: input });

  const bar = el('div', 'dev-bar');
  const keys = el('div', 'icon-row');
  const back = iconBtn('chevron', 'Back', () => input({ kind: 'key', key: 'back' }));
  back.classList.add('flip');
  keys.appendChild(back);
  keys.appendChild(iconBtn('focus', 'Home', () => input({ kind: 'key', key: 'home' })));
  keys.appendChild(iconBtn('layers', 'Recent apps', () => input({ kind: 'key', key: 'recents' })));
  bar.appendChild(keys);
  const views = el('div', 'icon-row');
  const dock = iconBtn('collapse', 'Back into JARVIS - closes this window and shows the phone on its card', () => window.jarvis.phoneWindow(serial, 'dock'));
  dock.id = 'pwDock';
  views.appendChild(dock);
  bar.appendChild(views);
  root.appendChild(bar);

  const run = el('div', 'dev-run');
  c.app = el('select', 'field dev-app');
  c.runBtn = el('button', 'btn btn-primary', 'Run');
  c.runBtn.type = 'button';
  c.runBtn.onclick = () => (c.run && c.run.state !== 'exited' ? flutterCmd('stop') : flutterRun());
  const cmds = el('div', 'icon-row');
  c.reloadBtn = iconBtn('bolt', 'Hot reload', () => flutterCmd('reload'));
  c.restartBtn = iconBtn('refresh', 'Hot restart', () => flutterCmd('restart'));
  cmds.appendChild(c.reloadBtn);
  cmds.appendChild(c.restartBtn);
  c.runState = el('span', 'dev-run-state pill', 'Nothing running on this phone');
  run.appendChild(c.app);
  run.appendChild(c.runBtn);
  run.appendChild(cmds);
  run.appendChild(c.runState);
  root.appendChild(run);
  document.getElementById('phoneRoot').appendChild(root);

  // ------------------------------------------------------------- state
  function setTitle() { document.title = `${c.label.value.trim() || c.model.textContent} - JARVIS`; }

  function setStatus(text, level = '') {
    c.status.textContent = text;
    c.status.className = `pill ${level}`;
    root.classList.toggle('live', level === 'ok');
  }

  /** `actions` is one {label, run} or a list of them - a picker needs more than one. */
  function setOverlay(icon, title, sub, actions) {
    c.overlay.hidden = false;
    c.ov.replaceChildren();
    if (icon) c.ov.appendChild(JV.icon(icon));
    c.ov.appendChild(el('div', 'ov-title', title));
    if (sub) c.ov.appendChild(el('div', 'ov-sub', sub));
    const list = Array.isArray(actions) ? actions : actions ? [actions] : [];
    if (list.length) {
      const row = el('div', 'ov-acts');
      for (const a of list) {
        const b = el('button', 'btn small', a.label);
        b.type = 'button';
        b.onclick = a.run;
        row.appendChild(b);
      }
      c.ov.appendChild(row);
    }
  }

  function renderRun() {
    const r = c.run;
    const active = r && r.state !== 'exited';
    c.runBtn.textContent = active ? 'Stop' : 'Run';
    c.runBtn.className = `btn ${active ? 'btn-danger' : 'btn-primary'}`;
    c.runBtn.disabled = c.state !== 'device' || (!active && !c.app.value);
    c.app.disabled = !!active;
    const ready = active && r.state === 'running';
    c.reloadBtn.disabled = !ready;
    c.restartBtn.disabled = !ready;
    const words = { building: 'Building…', starting: 'Starting…', running: 'Running', stopped: 'Stopped', exited: 'Not running' };
    c.runState.textContent = r ? `${r.name} · ${words[r.state] || r.state}` : 'Nothing running on this phone';
    const tone = { running: 'ok', building: 'busy', starting: 'busy' }[r && r.state] || '';
    c.runState.className = `dev-run-state pill ${tone}`;
    if (r && active) c.app.value = r.app;
  }

  /**
   * The person's own warning for an app (Projects > the project > Settings), asked on the
   * screen before it runs. What the screen showed before comes back either way.
   */
  function askFirst(app) {
    return new Promise((resolve) => {
      const was = { hidden: c.overlay.hidden, kids: [...c.ov.children] };
      const done = (yes) => { c.ov.replaceChildren(...was.kids); c.overlay.hidden = was.hidden; resolve(yes); };
      setOverlay('alert', `Run ${app.name}?`, app.warn, [{ label: `Run ${app.name}`, run: () => done(true) }, { label: 'Cancel', run: () => done(false) }]);
    });
  }

  async function flutterRun() {
    const app = appInfo.get(c.app.value);
    if (app?.warn && !(await askFirst(app))) return;
    const r = await window.jarvis.flutterRun(serial, c.app.value);
    if (!r?.ok) { c.runState.textContent = r?.error || 'Could not start flutter run.'; c.runState.className = 'dev-run-state pill bad'; return; }
    c.run = r.run;
    renderRun();
  }
  async function flutterCmd(cmd) {
    const r = await window.jarvis.flutterCmd(serial, cmd);
    if (!r?.ok) { c.runState.textContent = r?.error || `Could not ${cmd}.`; c.runState.className = 'dev-run-state pill bad'; }
  }

  // ------------------------------------------------------------- the screen
  async function startScreen() {
    if (c.starting) return;
    c.starting = true;
    setOverlay('phone', 'Connecting…', 'Starting the screen on this phone.');
    c.screen?.close();
    c.screen = JV.phone.makeScreen(serial, c.canvas, () => { c.overlay.hidden = true; c.canvas.focus(); });
    const r = await window.jarvis.mirror(serial, true);
    c.starting = false;
    if (!r?.ok) {
      setStatus('Not live', 'bad');
      setOverlay('alert', 'The screen could not start', r?.error || 'Unplug and plug the phone back in, then try again.',
        { label: 'Try again', run: startScreen });
      watchForReplacement(); // it may have been swapped for a different phone, not just reseated
      return;
    }
    // The stream may already have been running for the card in JARVIS: no fresh start
    // event comes then, and the picture needs a new keyframe to begin from.
    c.live = true;
    setStatus('Live', 'ok');
    c.screen.resync();
  }

  // ------------------------------------------------------------- a replacement phone
  // Unplugging phone A and plugging in phone B used to leave this window stuck - it only
  // ever asked for the one serial from its URL, forever, however many times "Try again" was
  // pressed. Now, whenever the screen cannot come up, it watches adb's device list: the same
  // phone reappearing is retried as before; a single new, unclaimed phone is adopted
  // automatically; more than one is offered as a choice rather than guessed at.
  let watchTimer = null;
  function stopWatch() { clearInterval(watchTimer); watchTimer = null; }

  async function candidates() {
    let list = [];
    try { ({ list = [] } = await window.jarvis.devices()); } catch { return { mine: null, others: [] }; }
    return {
      mine: list.find((d) => d.serial === serial && d.state === 'device') || null,
      others: list.filter((d) => d.serial !== serial && d.state === 'device' && !d.popped),
    };
  }

  function watchForReplacement() {
    if (watchTimer || c.live) return;
    watchTimer = setInterval(async () => {
      if (c.live) { stopWatch(); return; }
      const { mine, others } = await candidates();
      if (watchTimer == null) return; // stopped (or switched by hand) while that call was out
      if (mine) { stopWatch(); startScreen(); return; }
      if (others.length === 1) { stopWatch(); adopt(others[0]); }
      else if (others.length > 1) { stopWatch(); offerChoice(others); }
    }, 2000);
  }

  /** Point this window at a different phone - a detected replacement, or one picked by hand. */
  async function adopt(d) {
    const was = serial;
    const r = await window.jarvis.phoneWindow(was, 'rebind', d.serial);
    if (!r?.ok) { setOverlay('alert', 'Could not switch phones', r?.error || '', { label: 'Try again', run: () => adopt(d) }); return; }
    serial = d.serial;
    saveLabel(c.label.value.trim()); // keep any name already typed, now filed under the new serial
    c.label.value = labels()[serial] || '';
    c.model.textContent = d.model || serial;
    c.serialEl.textContent = serial;
    c.state = d.state;
    c.run = d.flutter || null;
    setTitle();
    renderRun();
    setOverlay('phone', 'Switched phones', `Was ${was}. Now ${d.model || d.serial}.`);
    startScreen();
  }

  function offerChoice(list) {
    setOverlay('phone', 'More than one new phone', 'Pick the one this window should show.',
      list.map((d) => ({ label: d.model || d.serial, run: () => adopt(d) })));
  }

  /** The header button: switch on purpose, any time, not only when the old phone is gone. */
  async function openSwitcher() {
    const { others } = await candidates();
    if (!others.length) { setOverlay('phone', 'No other phone to switch to', 'Plug another one in, or wait for it to be noticed.', { label: 'Back', run: () => (c.live ? (c.overlay.hidden = true) : startScreen()) }); return; }
    stopWatch();
    offerChoice(others);
  }

  window.jarvis.onVideo((p) => { if (p.serial === serial) c.screen?.packet(p); });
  window.jarvis.onEvent((e) => { if (e && (!e.serial || e.serial === serial)) JV.emit(e.kind, e); });

  JV.on('mirror_start', () => { stopWatch(); c.live = true; setStatus('Live', 'ok'); });
  JV.on('mirror_end', (e) => {
    c.live = false;
    c.screen?.close();
    setStatus('Not live', e.reason && e.reason !== 'stopped' ? 'bad' : '');
    setOverlay('alert', 'The screen stopped', e.reason && e.reason !== 'stopped' ? e.reason : 'It was stopped.', { label: 'Start it again', run: startScreen });
    if (e.reason && e.reason !== 'stopped') watchForReplacement(); // it may have been unplugged, not just dropped
  });
  JV.on('flutter_state', (e) => { c.run = { app: e.app, name: e.name, state: e.state, since: e.since }; renderRun(); });

  // Ctrl+V while the screen is selected types the PC's clipboard into the phone.
  document.addEventListener('paste', (e) => {
    const t = e.clipboardData?.getData('text');
    if (document.activeElement === c.canvas && c.live && t) { e.preventDefault(); input({ kind: 'text', text: t.slice(0, 2000) }); }
  });

  (async () => {
    setOverlay('phone', 'Connecting…', 'Looking for the phone.');
    let apps = [];
    let list = [];
    try { [apps, { list = [] } = {}] = await Promise.all([window.jarvis.flutterApps(), window.jarvis.devices()]); } catch { /* shown below */ }
    // The workspace's Flutter apps, discovered - never a fixed list.
    for (const a of apps) {
      const o = el('option', null, a.name === a.dir ? a.name : `${a.name}  ·  ${a.dir}`);
      o.value = a.key;
      c.app.appendChild(o);
      appInfo.set(a.key, { name: a.name, warn: a.warn || null });
    }
    if (!apps.length) {
      const o = el('option', null, 'No Flutter app in this workspace');
      o.value = '';
      o.disabled = true;
      c.app.appendChild(o);
      c.runBtn.disabled = true;
    }
    const d = list.find((x) => x.serial === serial);
    if (d) {
      c.model.textContent = d.model || serial;
      c.state = d.state;
      if (d.flutter) c.run = d.flutter;
    } else c.state = 'missing';
    setTitle();
    renderRun();
    if (!d) {
      setStatus('Not connected', 'bad');
      setOverlay('phone', 'This phone is not connected', 'Plug it back in, or plug a different one in and it will be picked up.', { label: 'Look again', run: startScreen });
      watchForReplacement();
      return;
    }
    if (d.state !== 'device') {
      setStatus(d.state, 'busy');
      setOverlay('phone', 'Allow USB debugging', 'Unlock the phone and tap Allow, then try again.', { label: 'Try again', run: startScreen });
      watchForReplacement();
      return;
    }
    startScreen();
  })();
})();
