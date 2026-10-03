/* JARVIS window - the Devices view: every phone on adb as a live, touchable screen, with
   its own `flutter run` (hot reload, hot restart, stop, log). Screens are H.264 from
   scrcpy, decoded here with WebCodecs and drawn on a canvas. */
(() => {
  'use strict';
  const { $, el, state } = JV;

  const cards = new Map(); // serial -> card
  let apps = [];
  const appsReady = window.jarvis.flutterApps().then((a) => { apps = a; }).catch(() => {});
  let pollTimer = null;
  const LABELS = 'jarvis.deviceLabels';
  const LAYOUT = 'jarvis.deviceLayout';
  const MAX_LOG_LINES = 600;

  const labels = () => { try { return JSON.parse(localStorage.getItem(LABELS) || '{}'); } catch { return {}; } };
  function saveLabel(serial, v) {
    try { const l = labels(); if (v) l[serial] = v; else delete l[serial]; localStorage.setItem(LABELS, JSON.stringify(l)); } catch { /* storage off */ }
  }

  // ------------------------------------------------------------- layout
  // Side by side: every phone in one row, each as tall as the window allows, with a
  // draggable divider between them. The shares are per phone and remembered.
  let sbs = false;
  let shares = {};
  let fullId = null;   // the card filling the window, phone or web app
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT) || '{}');
    sbs = !!saved.sbs;
    shares = saved.shares && typeof saved.shares === 'object' ? saved.shares : {};
  } catch { /* storage off */ }
  function saveLayout() {
    try { localStorage.setItem(LAYOUT, JSON.stringify({ sbs, shares })); } catch { /* storage off */ }
  }
  const share = (id) => (Number.isFinite(shares[id]) && shares[id] > 0 ? shares[id] : 1);
  /** Every card in the grid, phones and web apps, in the order they are shown. */
  const allCards = () => [...$('deviceGrid').children].filter((n) => n.classList.contains('dev-card')).map((n) => n.__card).filter(Boolean);
  const byId = (id) => allCards().find((c) => c.id === id);

  // ------------------------------------------------------------- H.264 -> canvas
  /** avc1.PPCCLL from the SPS in scrcpy's configuration packet (Annex B). */
  function h264Codec(b) {
    const hex = (v) => v.toString(16).padStart(2, '0');
    for (let i = 0; i + 6 < b.length; i++) {
      if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1 && (b[i + 3] & 0x1f) === 7) return `avc1.${hex(b[i + 4])}${hex(b[i + 5])}${hex(b[i + 6])}`;
    }
    return null;
  }
  function concat(a, b) { const out = new Uint8Array(a.length + b.length); out.set(a, 0); out.set(b, a.length); return out; }

  function makeScreen(serial, canvas, onFirstFrame) {
    const ctx = canvas.getContext('2d', { alpha: false });
    let decoder = null;
    let config = null;
    let needKey = true;
    let askedAt = 0;
    let shown = false;
    // Out of step (decoder error, or it fell behind): wait for a keyframe and ask for one.
    const resync = () => {
      needKey = true;
      if (Date.now() - askedAt > 1500) { askedAt = Date.now(); window.jarvis.resetVideo(serial); }
    };
    function configure(cfg) {
      const codec = h264Codec(cfg);
      if (!codec || typeof VideoDecoder === 'undefined') return;
      try { decoder?.close(); } catch { /* already closed */ }
      decoder = new VideoDecoder({
        output: (frame) => {
          if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
            canvas.width = frame.displayWidth;
            canvas.height = frame.displayHeight;
          }
          ctx.drawImage(frame, 0, 0);
          frame.close();
          if (!shown) { shown = true; onFirstFrame(); }
        },
        error: () => resync(),
      });
      decoder.configure({ codec, optimizeForLatency: true });
      config = cfg;
      needKey = true;
    }
    return {
      packet(p) {
        if (p.type === 'configuration') { configure(p.data); return; }
        if (!decoder || decoder.state !== 'configured') return;
        if (needKey && !p.keyframe) return;
        if (decoder.decodeQueueSize > 24) { resync(); return; }
        try {
          // Annex B without a description: the SPS/PPS travel in front of each keyframe.
          decoder.decode(new EncodedVideoChunk({ type: p.keyframe ? 'key' : 'delta', timestamp: p.pts || 0, data: p.keyframe && config ? concat(config, p.data) : p.data }));
          if (p.keyframe) needKey = false;
        } catch { resync(); }
      },
      close() { try { decoder?.close(); } catch { /* closed */ } decoder = null; shown = false; },
    };
  }

  window.jarvis.onVideo((p) => cards.get(p.serial)?.screen?.packet(p));

  // ------------------------------------------------------------- a phone's card
  function iconBtn(icon, title, onClick) {
    const b = el('button', 'icon-btn dev-btn');
    b.title = title;
    b.appendChild(JV.icon(icon));
    b.onclick = onClick;
    return b;
  }
  const input = (card, ev) => window.jarvis.deviceInput(card.serial, ev);

  function makeCard(d) {
    const c = { id: d.serial, serial: d.serial, live: false, starting: false, want: true, run: null, logCount: 0 };
    c.root = el('div', 'dev-card hud-panel');
    c.root.__card = c;

    const head = el('div', 'dev-head');
    c.label = el('input', 'dev-label');
    c.label.placeholder = 'Name it…';
    c.label.title = 'Give this phone a name, e.g. Referrer';
    c.label.maxLength = 24;
    c.label.value = labels()[d.serial] || '';
    c.label.onchange = () => saveLabel(d.serial, c.label.value.trim());
    const id = el('div', 'dev-id');
    c.model = el('b', null, d.model || d.serial);
    id.appendChild(c.model);
    id.appendChild(el('small', null, d.serial));
    c.status = el('span', 'pill');
    head.appendChild(c.label);
    head.appendChild(id);
    head.appendChild(c.status);
    // Double-click the title row for fullscreen - not the screen itself, which would
    // double-tap the phone.
    head.addEventListener('dblclick', (e) => {
      // In fullscreen this row is a real title bar, so Windows owns the double-click
      // (maximise / restore). Leave fullscreen with the button or Esc.
      if (e.target === c.label || fullId === c.id) return;
      toggleFull(c);
    });
    c.root.appendChild(head);

    const screen = el('div', 'dev-screen');
    c.canvas = el('canvas', 'dev-canvas');
    c.canvas.width = 360; c.canvas.height = 780;
    c.canvas.tabIndex = 0;
    c.canvas.title = 'Click to tap, drag to swipe, wheel to scroll. Type when selected; Esc is Back.';
    c.overlay = el('div', 'dev-overlay');
    c.ov = el('div', 'ov-card');
    c.overlay.appendChild(c.ov);
    setOverlay(c, 'phone', 'Connecting…', 'Waking the screen up.');
    screen.appendChild(c.canvas);
    screen.appendChild(c.overlay);
    c.root.appendChild(screen);
    wireInput(c);

    // One pill of phone keys, one of view controls - easier to aim at than a loose row.
    const bar = el('div', 'dev-bar');
    const keys = el('div', 'icon-row');
    const back = iconBtn('chevron', 'Back', () => input(c, { kind: 'key', key: 'back' }));
    back.classList.add('flip');
    keys.appendChild(back);
    keys.appendChild(iconBtn('focus', 'Home', () => input(c, { kind: 'key', key: 'home' })));
    keys.appendChild(iconBtn('layers', 'Recent apps', () => input(c, { kind: 'key', key: 'recents' })));
    bar.appendChild(keys);
    const views = el('div', 'icon-row');
    c.fullBtn = iconBtn('expand', 'Fullscreen - or double-click the name. Esc leaves it', () => toggleFull(c));
    c.fullBtn.classList.add('dev-full-btn');
    views.appendChild(c.fullBtn);
    views.appendChild(iconBtn('code', 'Show or hide the flutter output', () => c.root.classList.toggle('no-log')));
    bar.appendChild(views);
    c.screenBtn = el('button', 'btn btn-ghost dev-screen-btn', 'Hide screen');
    c.screenBtn.onclick = () => { c.want = !c.want; if (c.want) startScreen(c); else stopScreen(c); };
    bar.appendChild(c.screenBtn);
    c.root.appendChild(bar);

    const run = el('div', 'dev-run');
    c.app = el('select', 'field dev-app');
    for (const a of apps) {
      const o = el('option', null, a.found ? a.name : `${a.name} (not found)`);
      o.value = a.key;
      o.disabled = !a.found;
      c.app.appendChild(o);
    }
    c.runBtn = el('button', 'btn btn-primary', 'Run');
    c.runBtn.onclick = () => (c.run && c.run.state !== 'exited' ? flutterCmd(c, 'stop') : flutterRun(c));
    const cmds = el('div', 'icon-row');
    c.reloadBtn = iconBtn('bolt', 'Hot reload', () => flutterCmd(c, 'reload'));
    c.restartBtn = iconBtn('refresh', 'Hot restart', () => flutterCmd(c, 'restart'));
    cmds.appendChild(c.reloadBtn);
    cmds.appendChild(c.restartBtn);
    c.runState = el('span', 'dev-run-state pill', 'Not running');
    run.appendChild(c.app);
    run.appendChild(c.runBtn);
    run.appendChild(cmds);
    run.appendChild(c.runState);
    c.root.appendChild(run);

    c.log = el('pre', 'dev-log');
    c.root.appendChild(c.log);
    if (sbs) c.root.classList.add('no-log'); // side by side is for the screens
    renderRun(c);
    return c;
  }

  /** One phone fills the window. The nav row stays, so Back is always a click away. */
  function toggleFull(c, on = fullId !== c.id) {
    const prev = fullId && byId(fullId);
    if (prev && prev !== c) { prev.root.classList.remove('full'); prev.fullBtn.replaceChildren(JV.icon('expand')); }
    fullId = on ? c.id : null;
    c.root.classList.toggle('full', on);
    c.fullBtn.replaceChildren(JV.icon(on ? 'collapse' : 'expand'));
    c.fullBtn.title = on ? 'Leave fullscreen (Esc)' : 'Fullscreen (double-click the screen; Esc leaves)';
    document.body.classList.toggle('dev-full', !!fullId);
    if (on) c.canvas?.focus(); // a web-app card has no phone screen to select
  }

  /** Card grid, or one row with draggable dividers. */
  function applyLayout() {
    const grid = $('deviceGrid');
    grid.classList.toggle('sbs', sbs);
    document.body.classList.toggle('dev-sbs', sbs && state.view === 'devices');
    $('devSbs').classList.toggle('on', sbs);
    grid.querySelectorAll(':scope > .dev-divider').forEach((d) => d.remove());
    const list = allCards();
    for (const c of list) c.root.style.flexGrow = sbs ? String(share(c.id)) : '';
    if (!sbs) return;
    // A divider between each pair, dragged to give one phone more room than the other.
    for (let i = 1; i < list.length; i++) grid.insertBefore(makeDivider(list[i - 1], list[i]), list[i].root);
  }

  function makeDivider(a, b) {
    const d = el('div', 'dev-divider');
    d.title = 'Drag to resize · double-click to even them out';
    d.appendChild(el('span', 'grip'));
    d.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      d.setPointerCapture(e.pointerId);
      d.classList.add('dragging');
      const x0 = e.clientX;
      const wA = a.root.getBoundingClientRect().width;
      const wB = b.root.getBoundingClientRect().width;
      const total = wA + wB;
      const totalShare = share(a.id) + share(b.id);
      const move = (ev) => {
        const next = Math.min(Math.max(wA + (ev.clientX - x0), 220), total - 220);
        shares[a.id] = (totalShare * next) / total;
        shares[b.id] = totalShare - shares[a.id];
        a.root.style.flexGrow = String(shares[a.id]);
        b.root.style.flexGrow = String(shares[b.id]);
      };
      const end = (ev) => {
        d.releasePointerCapture(ev.pointerId);
        d.classList.remove('dragging');
        d.removeEventListener('pointermove', move);
        d.removeEventListener('pointerup', end);
        d.removeEventListener('pointercancel', end);
        saveLayout();
      };
      d.addEventListener('pointermove', move);
      d.addEventListener('pointerup', end);
      d.addEventListener('pointercancel', end);
    });
    d.addEventListener('dblclick', () => {
      delete shares[a.id];
      delete shares[b.id];
      a.root.style.flexGrow = '1';
      b.root.style.flexGrow = '1';
      saveLayout();
    });
    return d;
  }

  function wireInput(c) {
    const cv = c.canvas;
    const at = (e) => {
      const r = cv.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * cv.width, y: ((e.clientY - r.top) / r.height) * cv.height, w: cv.width, h: cv.height };
    };
    let down = false;
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !c.live) return;
      cv.focus();
      cv.setPointerCapture(e.pointerId);
      down = true;
      input(c, { kind: 'touch', action: 'down', ...at(e) });
      e.preventDefault();
    });
    cv.addEventListener('pointermove', (e) => { if (down) input(c, { kind: 'touch', action: 'move', ...at(e) }); });
    const up = (e) => { if (!down) return; down = false; input(c, { kind: 'touch', action: 'up', ...at(e) }); };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', (e) => {
      if (!c.live) return;
      e.preventDefault();
      input(c, { kind: 'scroll', ...at(e), dx: -Math.sign(e.deltaX), dy: -Math.sign(e.deltaY) });
    }, { passive: false });
    const KEYS = { Enter: 'enter', Backspace: 'backspace', Tab: 'tab', Delete: 'delete', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Escape: 'back' };
    cv.addEventListener('keydown', (e) => {
      if (!c.live) return;
      if (KEYS[e.key]) { e.preventDefault(); e.stopPropagation(); input(c, { kind: 'key', key: KEYS[e.key] }); return; }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); input(c, { kind: 'text', text: e.key }); }
    });
  }
  // Esc leaves fullscreen even when the screen itself is not selected.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !fullId) return;
    const c = byId(fullId);
    if (!c) return;
    e.preventDefault();
    e.stopPropagation();
    toggleFull(c, false);
  }, true);

  // Ctrl+V while a screen is selected types the PC's clipboard into the phone.
  document.addEventListener('paste', (e) => {
    const c = [...cards.values()].find((x) => x.canvas === document.activeElement);
    const t = e.clipboardData?.getData('text');
    if (c && c.live && t) { e.preventDefault(); input(c, { kind: 'text', text: t.slice(0, 2000) }); }
  });

  function setStatus(c, text, level = '') {
    c.status.textContent = text;
    c.status.className = `pill ${level}`;
    c.root.classList.toggle('live', level === 'ok');
  }

  /** The card over a screen that is not live: an icon, a line, and what to do next. */
  function setOverlay(c, icon, title, sub) {
    c.ov.replaceChildren();
    if (icon) c.ov.appendChild(JV.icon(icon));
    c.ov.appendChild(el('div', 'ov-title', title));
    if (sub) c.ov.appendChild(el('div', 'ov-sub', sub));
  }

  // ------------------------------------------------------------- screens
  async function startScreen(c) {
    if (c.live || c.starting || !c.want || c.state !== 'device') return;
    if (c.failedAt && Date.now() - c.failedAt < 15000) return; // do not hammer a phone that refused
    c.starting = true;
    c.screenBtn.textContent = 'Hide screen';
    c.overlay.hidden = false;
    c.root.classList.remove('live');
    setOverlay(c, 'phone', 'Connecting…', 'Starting the screen on this phone.');
    c.screen?.close();
    c.screen = makeScreen(c.serial, c.canvas, () => { c.overlay.hidden = true; });
    const r = await window.jarvis.mirror(c.serial, true);
    c.starting = false;
    c.failedAt = r?.ok ? 0 : Date.now();
    if (!r?.ok) {
      c.overlay.hidden = false;
      setOverlay(c, 'alert', 'The screen could not start', r?.error || 'Unknown error. Unplug and plug the phone back in, then press Refresh.');
    }
  }
  async function stopScreen(c) {
    c.want = false;
    c.screenBtn.textContent = 'Show screen';
    await window.jarvis.mirror(c.serial, false);
  }
  JV.on('mirror_start', (e) => { const c = cards.get(e.serial); if (c) { c.live = true; setStatus(c, 'Live', 'ok'); } });
  JV.on('mirror_end', (e) => {
    const c = cards.get(e.serial);
    if (!c) return;
    c.live = false;
    c.screen?.close();
    c.overlay.hidden = false;
    if (e.reason && e.reason !== 'stopped') setOverlay(c, 'alert', 'The screen stopped', e.reason);
    else setOverlay(c, 'eye', 'Screen hidden', 'Press Show screen to bring it back.');
    setStatus(c, c.state === 'device' ? 'Connected' : c.state);
    // It dropped on its own while wanted (e.g. the phone locked the encoder): try once more.
    if (c.want && state.view === 'devices' && e.reason !== 'stopped' && !c.retried) { c.retried = true; setTimeout(() => startScreen(c), 1500); }
  });

  // ------------------------------------------------------------- flutter run
  function renderRun(c) {
    const r = c.run;
    const active = r && r.state !== 'exited';
    c.runBtn.textContent = active ? 'Stop' : 'Run';
    c.runBtn.className = `btn ${active ? 'btn-danger' : 'btn-primary'}`;
    c.runBtn.disabled = c.state !== 'device';
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
  async function flutterRun(c) {
    c.log.replaceChildren();
    c.logCount = 0;
    const r = await window.jarvis.flutterRun(c.serial, c.app.value);
    if (!r?.ok) { appendLog(c, [{ level: 'error', text: r?.error || 'Could not start flutter run.' }]); return; }
    c.run = r.run;
    renderRun(c);
  }
  async function flutterCmd(c, cmd) {
    const r = await window.jarvis.flutterCmd(c.serial, cmd);
    if (!r?.ok) appendLog(c, [{ level: 'error', text: r?.error || `Could not ${cmd}.` }]);
    else if (cmd !== 'stop') appendLog(c, [{ level: 'progress', text: cmd === 'reload' ? 'Hot reload…' : 'Hot restart…' }]);
  }
  function appendLog(c, lines) {
    const atBottom = c.log.scrollHeight - c.log.scrollTop - c.log.clientHeight < 30;
    for (const l of lines) {
      c.log.appendChild(el('div', `l-${l.level || 'info'}`, l.text));
      c.logCount++;
    }
    while (c.logCount > MAX_LOG_LINES) { c.log.firstChild?.remove(); c.logCount--; }
    if (atBottom) c.log.scrollTop = c.log.scrollHeight;
  }
  JV.on('flutter_state', (e) => {
    const c = cards.get(e.serial);
    if (!c) return;
    c.run = { app: e.app, name: e.name, state: e.state, since: e.since };
    renderRun(c);
    if (e.state === 'running') JV.feed?.({ level: 'ok', title: `${e.name} running on ${c.label.value || c.model.textContent}`, action: 'devices' });
  });
  JV.on('flutter_log', (e) => { const c = cards.get(e.serial); if (c) appendLog(c, e.lines); });

  // ------------------------------------------------------------- phone alerts
  // A buzz in your pocket when work stops, by one of two routes.
  //
  //   This phone  adb posts straight into the tray. No app on the phone and nothing
  //               leaves this machine - but the phone has to be on the cable or the same
  //               Wi-Fi. "Over Wi-Fi" moves it to TCP/IP so the cable can come out.
  //   Telegram    a message from your own bot. Reaches the phone on mobile data anywhere,
  //               at the cost of the text passing through Telegram.
  //
  // The bot token is never held here: it is posted to the main process, which checks it
  // with Telegram and keeps it in config.json. The window only ever learns whether a token
  // is set and what the bot is called.
  let alerts = { enabled: false, route: 'adb', serial: null, address: null, phones: [], connected: false, telegram: { hasToken: false, chatId: null, name: null } };

  const ROUTES = [
    ['adb', 'This phone', 'Over USB or the same Wi-Fi. Nothing leaves this machine.'],
    ['telegram', 'Telegram', 'Anywhere, on mobile data. Needs a bot you make once.'],
  ];

  function renderRoute() {
    const host = $('paRoute');
    host.replaceChildren();
    for (const [value, label, why] of ROUTES) {
      // The r-<route> class is what a screenshot run clicks: the capture harness takes a
      // single-token selector only, so each button needs a class of its own.
      const b = el('button', `r-${value}${alerts.route === value ? ' on' : ''}`, label);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(alerts.route === value));
      b.title = why;
      b.onclick = () => { if (alerts.route !== value) setAlerts({ route: value }); };
      host.appendChild(b);
    }
    $('paAdbSetup').hidden = alerts.route !== 'adb';
    $('paTgSetup').hidden = alerts.route !== 'telegram';
  }

  /** What Telegram setup still needs, in the order it needs doing. */
  function telegramStep() {
    const t = alerts.telegram || {};
    if (!t.hasToken) return { ready: false, note: 'In Telegram, message @BotFather, send /newbot, then paste the token it gives you here.' };
    if (!t.chatId) return { ready: false, note: `${t.name || 'Your bot'} is good. Now open it in Telegram, send it anything, and press "Find my chat".` };
    return { ready: true, note: `Ready: ${t.name || 'your bot'} → chat ${t.chatId}.` };
  }

  function renderAlerts() {
    const sel = $('paPhone');
    const on = $('paOn');
    const usable = alerts.phones.filter((p) => p.state === 'device');
    const chosen = alerts.serial;
    const tg = alerts.route === 'telegram';

    sel.replaceChildren();
    for (const p of usable) {
      const o = el('option', null, `${p.model || p.serial}${p.wifi ? ' (Wi-Fi)' : ' (USB)'}`);
      o.value = p.serial;
      sel.appendChild(o);
    }
    if (chosen && !usable.some((p) => p.serial === chosen)) {
      const o = el('option', null, `${chosen} - not reachable`);
      o.value = chosen;
      sel.appendChild(o);
    }
    sel.value = chosen || (usable[0] ? usable[0].serial : '');
    sel.disabled = !usable.length && !chosen;

    renderRoute();
    const step = telegramStep();
    const note = $('paTgNote');
    note.textContent = step.note;
    note.className = `alert-note${step.ready ? ' ok' : ''}`;
    $('paTgFind').disabled = !alerts.telegram?.hasToken;

    // The toggle and the test are only live once the chosen route can actually carry an alert.
    const canSend = tg ? step.ready : !!sel.value;
    on.checked = alerts.enabled;
    on.disabled = !canSend;
    $('paTest').disabled = !canSend;
    $('paWifi').disabled = !sel.value || sel.value.includes(':');
    // Remote control: Telegram only, and only once the bot can reach your chat.
    $('paRemoteRow').hidden = !tg;
    const rem = $('paRemote');
    rem.checked = !!alerts.remote;
    rem.disabled = !step.ready;
    $('paRemoteSub').textContent = !step.ready ? 'Set up the bot above first.'
      : alerts.remote ? 'On. What you send your bot runs on this PC, and approvals and questions come to the chat as buttons. Only your chat is obeyed. Send /help there for the commands. While it is on, the PC is kept from sleeping and closing the window keeps JARVIS in the tray.'
        : 'Off. Turn it on to send JARVIS tasks from your phone and answer its approvals there.';

    // More than one PC: this one's name, and the group all their bots share (presence.mjs).
    $('paGroupRow').hidden = !tg;
    const t = alerts.telegram || {};
    const pcBox = $('paPcName');
    if (document.activeElement !== pcBox) pcBox.value = t.pcName || '';
    $('paGroupFind').disabled = !step.ready;
    $('paGroupLeave').hidden = !t.groupId;
    const gNote = $('paGroupNote');
    gNote.className = `alert-note${t.groupId ? ' ok' : ''}`;
    gNote.textContent = !step.ready ? 'More than one PC? Set up the bot above first.'
      : t.groupId ? `In ${t.groupName || 'your group'} as ${t.pcName}. "Wake up" and "Power down" there ask which PC when more than one could answer - or add the name: "Wake up ${t.pcName}".`
        : 'More than one PC with JARVIS? Give each its own bot and name, put all the bots in one Telegram group with you, make each an admin with "Change group info", send "hi" there, then press Find my group.';

    // The mirror rides on remote control: it uses the same chat, and only while that is on.
    $('paMirrorRow').hidden = !tg;
    const mir = $('paMirror');
    mir.checked = !!alerts.mirror;
    mir.disabled = !step.ready || !alerts.remote;
    $('paMirrorSub').textContent = !alerts.remote ? 'Needs remote control on.'
      : alerts.mirror ? 'On. What is typed here shows in the chat as "💻 PC: …", followed by my replies - so the chat holds the whole conversation. The text passes through Telegram.'
        : 'Off. Only conversations started from your phone show in the chat.';

    // Not while it is being typed into - a re-render must not snatch the value back.
    const min = $('paMin');
    if (document.activeElement !== min) min.value = String(Number.isFinite(alerts.minSeconds) ? alerts.minSeconds : 30);

    const sub = $('paSub');
    if (!canSend) sub.textContent = tg ? 'Telegram is not set up yet - follow the line below.' : 'Plug a phone in with USB debugging on, then reopen Settings.';
    else if (!alerts.enabled) sub.textContent = 'Off. Turn it on and you hear from me when a turn finishes or I need you.';
    else if (tg) sub.textContent = `On, through Telegram to ${alerts.telegram.name || 'your bot'}. Works wherever the phone has signal.`;
    else if (!alerts.connected) sub.textContent = 'On, but that phone is not reachable right now - reconnect it or pick another.';
    else if (String(sel.value).includes(':')) sub.textContent = `On, over Wi-Fi at ${sel.value}. The cable is not needed.`;
    else sub.textContent = 'On, over the USB cable. Use "Over Wi-Fi" to cut it loose.';
  }

  // The alert settings live in the Settings dialog, so it loads them each time it opens.
  JV.loadAlerts = () => loadAlerts();
  async function loadAlerts() {
    try {
      alerts = await window.jarvis.phoneState();
      renderAlerts();
    } catch { /* adb unreachable; the devices note already says so */ }
  }

  async function setAlerts(patch) {
    try {
      const next = await window.jarvis.phoneSet(patch);
      alerts = { ...alerts, ...next };
      renderAlerts();
    } catch { /* leave the UI as it was */ }
  }

  // ------------------------------------------------------------- the list
  async function refresh() {
    await appsReady;
    const r = await window.jarvis.devices();
    const note = $('devNote');
    note.textContent = r.ok ? '' : `adb is not reachable: ${r.error}`;
    $('phoneCount').textContent = r.list.length || '0';
    emptyState(r);
    const grid = $('deviceGrid');
    const seen = new Set();
    let changed = false;
    for (const d of r.list) {
      seen.add(d.serial);
      let c = cards.get(d.serial);
      if (!c) {
        c = makeCard(d);
        cards.set(d.serial, c);
        grid.appendChild(c.root);
        changed = true;
        if (d.flutter) {
          c.run = d.flutter;
          appendLog(c, await window.jarvis.flutterLog(d.serial));
        }
      }
      c.state = d.state;
      c.model.textContent = d.model || d.serial;
      if (d.state === 'unauthorized') {
        setStatus(c, 'Waiting for you', 'busy');
        c.overlay.hidden = false;
        setOverlay(c, 'phone', 'Allow USB debugging', 'Unlock the phone and tap Allow on the prompt, then press Refresh.');
      } else if (d.state !== 'device') setStatus(c, d.state, 'busy');
      else if (!c.live) setStatus(c, 'Connected');
      renderRun(c);
      if (d.state === 'device' && state.view === 'devices') startScreen(c);
    }
    for (const [serial, c] of cards) {
      if (seen.has(serial)) continue;
      if (fullId === c.id) toggleFull(c, false); // it was unplugged while fullscreen
      c.screen?.close();
      c.root.remove();
      cards.delete(serial);
      changed = true;
    }
    // Only when a phone came or went: rebuilding the dividers mid-drag would break it.
    if (changed) applyLayout();
    setBadge(r.list.filter((d) => d.state === 'device').length);
  }
  function setBadge(n) { const b = $('nbDevices'); b.textContent = n ? String(n) : ''; b.hidden = !n; }

  /** With no phone attached the grid says what to do rather than sitting empty. */
  function emptyState(r) {
    const grid = $('deviceGrid');
    let box = grid.querySelector(':scope > .dev-empty');
    if (r.ok && r.list.length) { box?.remove(); return; }
    if (!box) {
      box = el('div', 'dev-empty');
      box.appendChild(JV.icon('phone'));
      box.appendChild(el('b', null, ''));
      box.appendChild(el('p', null, ''));
      const again = el('button', 'btn', 'Look again');
      again.onclick = refresh;
      box.appendChild(again);
      grid.appendChild(box);
    }
    box.querySelector('b').textContent = r.ok ? 'No phone connected' : 'adb is not reachable';
    box.querySelector('p').textContent = r.ok
      ? 'Plug a phone in over USB with developer options and USB debugging switched on, then tap Allow on the prompt. A phone paired over wireless adb shows up here too.'
      : `${r.error}. Check that the Android SDK platform-tools are installed and that nothing else is holding port 5037.`;
  }

  async function runOnAll() {
    const app = $('devAllApp').value;
    for (const c of cards.values()) {
      if (c.state !== 'device' || (c.run && c.run.state !== 'exited')) continue;
      c.app.value = app;
      await flutterRun(c);
    }
  }

  JV.on('view', (v) => {
    clearInterval(pollTimer);
    pollTimer = null;
    if (v === 'devices') {
      for (const c of cards.values()) { c.retried = false; c.failedAt = 0; }
      applyLayout();
      refresh();
      pollTimer = setInterval(() => { if (!document.hidden) refresh(); }, 3000);
    } else {
      // Screens only stream while they are on screen; flutter runs carry on.
      const full = fullId && byId(fullId);
      if (full) toggleFull(full, false);
      fullId = null;
      document.body.classList.remove('dev-full', 'dev-sbs');
      for (const c of cards.values()) if (c.live || c.starting) window.jarvis.mirror(c.serial, false);
    }
  });

  (async () => {
    await appsReady;
    const sel = $('devAllApp');
    for (const a of apps.filter((x) => x.found)) { const o = el('option', null, a.name); o.value = a.key; sel.appendChild(o); }
    $('devRunAll').onclick = runOnAll;
    $('devRefresh').onclick = () => refresh();

    // Phone alerts
    $('paOn').onchange = (e) => setAlerts({ enabled: e.target.checked, serial: $('paPhone').value || null });
    $('paPhone').onchange = (e) => setAlerts({ serial: e.target.value || null, address: e.target.value.includes(':') ? e.target.value : null });
    $('paTest').onclick = async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      const r = await window.jarvis.phoneTest($('paPhone').value);
      b.disabled = false;
      if (r?.ok) JV.notify('Sent. Check your phone, sir.', { level: 'ok', action: () => JV.openSettings?.() });
      else JV.notify(`It did not go through: ${r?.error || 'no answer'}`, { level: 'err', action: () => JV.openSettings?.() });
      renderAlerts();
    };

    // Telegram setup. The token is handed straight to the main process and is never kept
    // in the window - the box is cleared the moment Telegram confirms it.
    $('paTgVerify').onclick = async (e) => {
      const b = e.currentTarget;
      const box = $('paTgToken');
      const note = $('paTgNote');
      b.disabled = true;
      note.textContent = 'Asking Telegram…';
      note.className = 'alert-note busy';
      const r = await window.jarvis.telegramVerify(box.value.trim());
      b.disabled = false;
      if (r?.ok) {
        box.value = '';
        await loadAlerts();
        JV.notify(`Token accepted: ${r.name}. Now send it a message and press "Find my chat".`, { level: 'ok', action: () => JV.openSettings?.() });
      } else {
        note.textContent = r?.error || 'Telegram would not confirm that token.';
        note.className = 'alert-note err';
      }
    };
    $('paTgToken').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('paTgVerify').click(); } };

    // Turning remote control on is asked once, in plain words: from then on a message in
    // that chat can make JARVIS act on this PC.
    $('paRemote').onchange = (e) => {
      if (e.target.checked && !confirm('Turn on remote control?\n\nAnything you send your Telegram bot will run on this PC, as if you had typed it here. Approvals still need approving - from the chat or from here.\n\nOnly your own chat is obeyed.')) {
        e.target.checked = false;
        return;
      }
      setAlerts({ remote: e.target.checked });
    };

    $('paMirror').onchange = (e) => setAlerts({ mirror: e.target.checked });

    // How long a turn must run before finishing it is worth a buzz. Saved on change (blur or
    // Enter), not per keystroke, and clamped to what the main process accepts anyway.
    $('paMin').onchange = (e) => {
      const n = Math.round(Number(e.target.value));
      if (!Number.isFinite(n)) { renderAlerts(); return; }
      setAlerts({ minSeconds: Math.max(0, Math.min(3600, n)) });
    };
    $('paTgFind').onclick = async (e) => {
      const b = e.currentTarget;
      const note = $('paTgNote');
      b.disabled = true;
      note.textContent = 'Reading your bot’s messages…';
      note.className = 'alert-note busy';
      const r = await window.jarvis.telegramFindChat();
      b.disabled = false;
      if (r?.ok) {
        await loadAlerts();
        JV.notify(`Found your chat (${r.name}). Press Test to prove it.`, { level: 'ok', action: () => JV.openSettings?.() });
      } else {
        note.textContent = r?.error || 'Could not find a chat.';
        note.className = 'alert-note err';
      }
    };
    $('paPcName').onchange = (e) => { if (e.target.value.trim()) setAlerts({ telegram: { pcName: e.target.value.trim() } }); else renderAlerts(); };
    $('paPcName').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } };
    $('paGroupFind').onclick = async (e) => {
      const b = e.currentTarget;
      const note = $('paGroupNote');
      b.disabled = true;
      note.textContent = 'Reading your bot’s messages…';
      note.className = 'alert-note busy';
      const r = await window.jarvis.telegramFindGroup();
      b.disabled = false;
      if (r?.ok) {
        await loadAlerts();
        if (r.admin) JV.notify(`Joined ${r.name}. Try "Wake up" or /status there.`, { level: 'ok', action: () => JV.openSettings?.() });
        else JV.notify(`Found ${r.name}, but the bot is not an admin with "Change group info" yet - it cannot see the group's messages or keep the status board until it is.`, { level: 'err', action: () => JV.openSettings?.() });
      } else {
        note.textContent = r?.error || 'Could not find a group.';
        note.className = 'alert-note err';
      }
    };
    $('paGroupLeave').onclick = () => setAlerts({ telegram: { groupId: null } });
    $('paWifi').onclick = async (e) => {
      const b = e.currentTarget;
      const serial = $('paPhone').value;
      b.disabled = true;
      $('paSub').textContent = 'Moving the phone onto Wi-Fi…';
      const r = await window.jarvis.phoneWifi(serial);
      b.disabled = false;
      if (r?.ok) {
        JV.notify(`That phone is on Wi-Fi at ${r.address}. You can unplug the cable.`, { level: 'ok', action: () => JV.openSettings?.() });
        await loadAlerts();
        await refresh();
      } else {
        JV.notify(r?.error || 'Could not move the phone onto Wi-Fi.', { level: 'err', action: () => JV.openSettings?.() });
        renderAlerts();
      }
    };
    $('devSbs').onclick = () => {
      sbs = !sbs;
      // Side by side trades the logs for screen height; the log button brings one back.
      for (const c of allCards()) c.root.classList.toggle('no-log', sbs);
      saveLayout();
      applyLayout();
    };
    // The nav badge: how many phones are connected, checked quietly in the background.
    const badge = async () => {
      if (document.hidden || state.view === 'devices') return;
      try { const r = await window.jarvis.devices(); setBadge(r.list.filter((d) => d.state === 'device').length); } catch { /* adb away */ }
    };
    badge();
    setInterval(badge, 15000);
  })();
})();
