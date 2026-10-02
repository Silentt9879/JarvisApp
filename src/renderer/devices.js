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
  // A notification in your pocket when work stops, posted through adb - no app on the
  // phone, nothing off this machine. USB works immediately; "Over Wi-Fi" moves the phone
  // to TCP/IP so the cable can come out.
  let alerts = { enabled: false, serial: null, address: null, phones: [], connected: false };

  function renderAlerts() {
    const sel = $('paPhone');
    const on = $('paOn');
    const usable = alerts.phones.filter((p) => p.state === 'device');
    const chosen = alerts.serial;

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

    on.checked = alerts.enabled;
    on.disabled = !sel.value;
    $('paWifi').disabled = !sel.value || sel.value.includes(':');
    $('paTest').disabled = !sel.value;

    const sub = $('paSub');
    if (!sel.value) sub.textContent = 'Plug a phone in with USB debugging on, then press Refresh.';
    else if (!alerts.enabled) sub.textContent = 'Off. Turn it on and your phone buzzes when a turn finishes or I need you.';
    else if (!alerts.connected) sub.textContent = 'On, but that phone is not reachable right now - reconnect it or pick another.';
    else if (String(sel.value).includes(':')) sub.textContent = `On, over Wi-Fi at ${sel.value}. The cable is not needed.`;
    else sub.textContent = 'On, over the USB cable. Use "Over Wi-Fi" to cut it loose.';
  }

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
      loadAlerts();
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
    $('devRefresh').onclick = () => { refresh(); loadAlerts(); };

    // Phone alerts
    $('paOn').onchange = (e) => setAlerts({ enabled: e.target.checked, serial: $('paPhone').value || null });
    $('paPhone').onchange = (e) => setAlerts({ serial: e.target.value || null, address: e.target.value.includes(':') ? e.target.value : null });
    $('paTest').onclick = async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      const r = await window.jarvis.phoneTest($('paPhone').value);
      b.disabled = false;
      if (r?.ok) JV.notify('Sent. Check your phone, sir.', { level: 'ok', action: 'devices' });
      else JV.notify(`The phone refused it: ${r?.error || 'no answer from adb'}`, { level: 'err', action: 'devices' });
    };
    $('paWifi').onclick = async (e) => {
      const b = e.currentTarget;
      const serial = $('paPhone').value;
      b.disabled = true;
      $('paSub').textContent = 'Moving the phone onto Wi-Fi…';
      const r = await window.jarvis.phoneWifi(serial);
      b.disabled = false;
      if (r?.ok) {
        JV.notify(`That phone is on Wi-Fi at ${r.address}. You can unplug the cable.`, { level: 'ok', action: 'devices' });
        await loadAlerts();
        await refresh();
      } else {
        JV.notify(r?.error || 'Could not move the phone onto Wi-Fi.', { level: 'err', action: 'devices' });
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
