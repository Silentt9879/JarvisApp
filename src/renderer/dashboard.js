/* JARVIS window - the Command Center dashboard. Every panel shows real data: the live
   session's events, the machine, the repos (read-only git), knowledge, memory files. */
(() => {
  'use strict';
  const { $, el, state } = JV;

  // ------------------------------------------------------------- agents (shared with the Agents page)
  const BUILTIN = new Set(['general-purpose', 'Explore', 'Plan', 'statusline-setup', 'claude-code-guide', 'claude']);
  const AGENT_ICON = {
    friday: 'phone', roadrunner: 'phone', commander: 'phone', edith: 'phone', sentry: 'globe', control: 'globe',
    gatekeeper: 'server', underwriter: 'server', diagnostic: 'bug', auditor: 'eye', scout: 'compass',
    'codebase-learner': 'book', verifier: 'verify', 'general-purpose': 'core', claude: 'core', Explore: 'search',
    // The three that work a page of this app wear that page's own icon.
    archivist: 'github', taskmaster: 'clickup', scribe: 'edit',
    Plan: 'tasks', 'claude-code-guide': 'info', 'statusline-setup': 'settings',
  };
  const AGENT_HUE = ['#39c6ff', '#7c8cff', '#b77dff', '#ffb347', '#3ddc97', '#ff7aa8', '#5eead4', '#f5d76e'];
  JV.agentInfo = (a) => {
    const d = a.description || '';
    // The specialists' convention is "CODENAME — role". Only a short head counts as a
    // codename: a built-in's description can hold a dash mid-sentence, and splitting there
    // made half a sentence the agent's title.
    const raw = /^([^—–-]+?)\s+[—–-]\s+(.+)$/s.exec(d);
    const m = raw && raw[1].trim().length <= 28 ? raw : null;
    const code = m ? m[1].trim() : a.name;
    const role = JV.clip((m ? m[2] : d).split(/\.\s/)[0].replace(/\.$/, ''), 52);
    let h = 0;
    for (const ch of a.name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return { name: a.name, code, role, icon: AGENT_ICON[a.name] || 'agents', builtin: BUILTIN.has(a.name), hue: AGENT_HUE[h % AGENT_HUE.length], description: d };
  };
  JV.customAgents = () => (state.agentList || []).filter((a) => !BUILTIN.has(a.name));
  JV.builtinAgents = () => (state.agentList || []).filter((a) => BUILTIN.has(a.name));
  /**
   * What to say when there are no specialists. Two different situations used to share
   * one sentence: before the session reports its agents, "they load once connected" is
   * true; after it has reported none, the same sentence is a promise that never comes true.
   */
  JV.noSpecialistsText = () => (state.agentsLoaded
    ? 'No specialists in this workspace. They are defined in .claude/agents, and this folder has none.'
    : 'Specialists load once the session is connected.');

  /** One agent card; `big` adds the description. Clicking runs onClick. */
  JV.agentCard = (a, { big = false, onClick = null } = {}) => {
    const info = JV.agentInfo(a);
    const active = state.agentActive.get(a.name) || 0;
    const used = state.agentUse.get(a.name) || 0;
    const card = el('div', `acard${active ? ' active' : ''}${used ? ' used' : ''}`);
    card.style.setProperty('--hue', info.hue);
    const ib = el('div', 'acard-ico');
    ib.appendChild(JV.icon(info.icon));
    card.appendChild(ib);
    const txt = el('div', 'acard-txt');
    txt.appendChild(el('b', null, info.code));
    txt.appendChild(el('small', 'acard-role', info.role));
    const st = el('span', `acard-state${!active && !used ? ' st-standby' : ''}`,
      active ? `Working${active > 1 ? ` ×${active}` : ''}` : used ? `Used ×${used}` : 'Standby');
    txt.appendChild(st);
    card.appendChild(txt);
    const w = el('div', 'wave mini');
    JV.wave(w, big ? 22 : 16);
    card.appendChild(w);
    if (big) card.appendChild(el('p', 'acard-desc', JV.clip(info.description, 260)));
    card.title = info.description;
    if (onClick) { card.classList.add('clickable'); card.onclick = () => onClick(a); }
    return card;
  };

  function renderAgentGrid() {
    const g = $('agentGrid');
    const list = JV.customAgents().slice().sort((x, y) =>
      ((state.agentActive.get(y.name) || 0) - (state.agentActive.get(x.name) || 0)) ||
      ((state.agentUse.get(y.name) || 0) - (state.agentUse.get(x.name) || 0)) ||
      x.name.localeCompare(y.name));
    g.replaceChildren();
    if (!list.length) { g.appendChild(el('div', 'muted empty', JV.noSpecialistsText())); return; }
    // Four fills the panel in two neat rows; the rest are a click away on the Agents page.
    for (const a of list.slice(0, 4)) g.appendChild(JV.agentCard(a, { onClick: () => JV.show('agents') }));
  }

  // ------------------------------------------------------------- the core orb (canvas)
  const orbCanvas = $('orb');
  const octx = orbCanvas.getContext('2d');
  const PTS = [];
  (() => {
    const N = 950;
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const th = i * 2.399963229728653;
      PTS.push([Math.cos(th) * r, y, Math.sin(th) * r]);
    }
  })();
  let rot = 0;
  let lastT = 0;
  let raf = null;
  let pulse = 0;
  const TILT = 0.38;

  function orbColour() {
    if (state.status === 'waiting') return [255, 190, 90];
    if (state.status === 'offline' || state.status === 'closed') return [110, 140, 170];
    return [70, 200, 255];
  }

  function drawOrb(t) {
    const dpr = window.devicePixelRatio || 1;
    const W = orbCanvas.clientWidth;
    const H = orbCanvas.clientHeight;
    if (!W || !H) return;
    if (orbCanvas.width !== Math.round(W * dpr) || orbCanvas.height !== Math.round(H * dpr)) {
      orbCanvas.width = Math.round(W * dpr);
      orbCanvas.height = Math.round(H * dpr);
    }
    const dt = lastT ? Math.min(100, t - lastT) : 16;
    lastT = t;
    const working = state.status === 'working';
    const speed = working ? 0.75 : state.status === 'waiting' ? 0.3 : state.status === 'ready' ? 0.22 : 0.06;
    rot += (dt / 1000) * speed;
    pulse += dt / 1000;
    const [cr, cg, cb] = orbColour();
    const c = (a) => `rgba(${cr},${cg},${cb},${a})`;

    const ctx = octx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const cx = W / 2;
    const cy = H * 0.46;
    const R = Math.min(W * 0.26, H * 0.36);
    const beat = working ? 1 + 0.025 * Math.sin(pulse * 6) : 1;

    // glow
    const g = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R * 1.9);
    g.addColorStop(0, c(working ? 0.30 : 0.2));
    g.addColorStop(0.45, c(0.08));
    g.addColorStop(1, c(0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // platform rings
    const py = cy + R * 1.18;
    for (let i = 0; i < 5; i++) {
      ctx.beginPath();
      ctx.ellipse(cx, py, R * (1.25 - i * 0.18), R * (0.16 - i * 0.022), 0, 0, Math.PI * 2);
      ctx.strokeStyle = c(0.12 + i * 0.07);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    // platform ticks
    ctx.save();
    ctx.translate(cx, py);
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2 + rot * 0.4;
      const x = Math.cos(a) * R * 1.05;
      const y = Math.sin(a) * R * 0.135;
      ctx.fillStyle = c(0.18 + 0.25 * ((Math.sin(a) + 1) / 2));
      ctx.fillRect(x, y, 1.4, 1.4);
    }
    ctx.restore();

    // orbit rings with travelling sparks
    const rings = [[1.42, 0.33, 0.25], [1.6, 0.2, -0.45], [1.25, 0.5, 1.1]];
    rings.forEach(([rx, ry, ang], k) => {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(ang + Math.sin(pulse * 0.1 + k) * 0.05);
      ctx.beginPath();
      ctx.ellipse(0, 0, R * rx, R * ry, 0, 0, Math.PI * 2);
      ctx.strokeStyle = c(0.22);
      ctx.lineWidth = 1;
      ctx.stroke();
      const sa = rot * (1.2 + k * 0.35) + k * 2;
      const sx = Math.cos(sa) * R * rx;
      const sy = Math.sin(sa) * R * ry;
      const sg = ctx.createRadialGradient(sx, sy, 0, sx, sy, 7);
      sg.addColorStop(0, 'rgba(255,255,255,.95)');
      sg.addColorStop(0.3, c(0.8));
      sg.addColorStop(1, c(0));
      ctx.fillStyle = sg;
      ctx.fillRect(sx - 7, sy - 7, 14, 14);
      ctx.restore();
    });

    // sphere points
    const cosR = Math.cos(rot);
    const sinR = Math.sin(rot);
    const cosT = Math.cos(TILT);
    const sinT = Math.sin(TILT);
    for (const [x, y, z] of PTS) {
      const x1 = x * cosR - z * sinR;
      const z1 = x * sinR + z * cosR;
      const y2 = y * cosT - z1 * sinT;
      const z2 = y * sinT + z1 * cosT;
      const depth = (z2 + 1) / 2;
      const s = 0.5 + 1.5 * depth;
      ctx.fillStyle = c(0.1 + 0.85 * depth * depth);
      ctx.fillRect(cx + x1 * R * beat - s / 2, cy + y2 * R * beat - s / 2, s, s);
    }

    // meridians
    ctx.lineWidth = 0.7;
    for (let m = 0; m < 6; m++) {
      const lon = (m / 6) * Math.PI + rot;
      ctx.beginPath();
      for (let i = 0; i <= 40; i++) {
        const lat = -Math.PI / 2 + (i / 40) * Math.PI;
        const x = Math.cos(lat) * Math.cos(lon);
        const z = Math.cos(lat) * Math.sin(lon);
        const y = Math.sin(lat);
        const y2 = y * cosT - z * sinT;
        const px = cx + x * R * beat;
        const pyy = cy + y2 * R * beat;
        if (i === 0) ctx.moveTo(px, pyy); else ctx.lineTo(px, pyy);
      }
      ctx.strokeStyle = c(0.1);
      ctx.stroke();
    }
    // core highlight
    const hg = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.55);
    hg.addColorStop(0, c(working ? 0.35 : 0.18));
    hg.addColorStop(1, c(0));
    ctx.fillStyle = hg;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.55, 0, Math.PI * 2);
    ctx.fill();
  }

  // The orb is no longer drawn: the Overview states the session's condition in words, with
  // a dot beside it, and that is the whole of what the canvas was saying. The code is kept
  // because the canvas is still in the page - if it is ever given a size again, it draws.
  function orbLoop(t) {
    raf = null;
    if (state.view !== 'command' || document.hidden) return;
    if (!orbCanvas.clientWidth || !orbCanvas.clientHeight) return; // hidden: nothing to draw, and no next frame
    if (t - lastT >= 30 || !lastT) drawOrb(t);
    if (!JV.prefs.reduceMotion) raf = requestAnimationFrame(orbLoop);
  }
  JV.startOrb = () => { if (!raf) raf = requestAnimationFrame(orbLoop); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) JV.startOrb(); });
  window.addEventListener('resize', () => { lastT = 0; JV.startOrb(); });

  function renderOrbText() {
    $('orbVer').textContent = state.version ? `Claude Code v${state.version}` : '';
    const s = { starting: 'Connecting', ready: 'Standing by', working: 'Working', waiting: 'Awaiting your decision', closed: 'Offline', offline: 'Offline' }[state.status] || '';
    $('orbState').textContent = s;
    $('orbPanel').className = `p-orb s-${state.status}`;
  }

  // ------------------------------------------------------------- live feed
  const feedItems = [];
  const FEED_TAG = { info: 'INFO', warn: 'WARN', live: 'LIVE', tip: 'FOCUS', err: 'ERROR', ok: 'DONE' };
  const FEED_ICON = { info: 'info', warn: 'alert', live: 'spark', tip: 'tasks', err: 'alert', ok: 'check' };
  /** Add a feed item. A keyed item (a standing signal) is updated in place while its
      title is unchanged, so periodic refreshes do not push live events down. */
  JV.feed = (item) => {
    if (item.key) {
      const i = feedItems.findIndex((f) => f.key === item.key);
      if (i >= 0 && feedItems[i].title === item.title) { Object.assign(feedItems[i], item); renderFeed(); return; }
      if (i >= 0) feedItems.splice(i, 1);
    }
    feedItems.unshift({ t: Date.now(), ...item });
    feedItems.splice(40);
    renderFeed();
  };
  function renderFeed() {
    const ul = $('feed');
    ul.replaceChildren();
    if (!feedItems.length) { ul.appendChild(el('li', 'muted empty', 'Gathering intelligence…')); return; }
    for (const f of feedItems.slice(0, 14)) {
      const li = el('li', `fi l-${f.level}`);
      const ib = el('span', 'fi-ico');
      ib.appendChild(JV.icon(FEED_ICON[f.level] || 'info'));
      li.appendChild(ib);
      const d = el('div', 'fi-txt');
      d.appendChild(el('b', null, f.title));
      d.appendChild(el('small', null, f.sub ? `${f.sub} · ${JV.time(f.t)}` : JV.time(f.t)));
      li.appendChild(d);
      li.appendChild(el('span', 'fi-tag', FEED_TAG[f.level] || 'INFO'));
      if (f.action) { li.classList.add('clickable'); li.onclick = () => (typeof f.action === 'string' ? JV.show(f.action) : f.action()); }
      ul.appendChild(li);
    }
  }

  // ------------------------------------------------------------- mission timeline
  const TASK_WORD = { in_progress: 'In progress', pending: 'Pending', completed: 'Done' };
  JV.timelineRows = (ul, { limit = 8, tasks = true } = {}) => {
    ul.replaceChildren();
    const rows = [];
    const cur = state.turns.filter((t) => !t.end);
    for (const t of cur) rows.push({ kind: 'turn', t });
    if (tasks) {
      const order = { in_progress: 0, pending: 1, completed: 2 };
      for (const k of state.tasks.slice().sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3))) rows.push({ kind: 'task', k });
    }
    for (const t of state.turns.filter((x) => x.end).slice().reverse()) rows.push({ kind: 'turn', t });
    if (!rows.length) { ul.appendChild(el('li', 'muted empty', 'Nothing yet this session, sir. Tasks and turns appear here as JARVIS works.')); return; }
    for (const r of rows.slice(0, limit)) {
      const li = el('li', 'tl');
      if (r.kind === 'task') {
        const k = r.k;
        li.classList.add(`s-${k.status}`);
        li.appendChild(el('span', 'tl-time', 'Task'));
        const d = el('div', 'tl-main');
        d.appendChild(el('b', null, k.status === 'in_progress' && k.activeForm ? k.activeForm : k.subject));
        const bar = el('div', 'tl-bar');
        bar.appendChild(el('i'));
        d.appendChild(bar);
        li.appendChild(d);
        li.appendChild(el('span', 'tl-state', TASK_WORD[k.status] || k.status));
      } else {
        const t = r.t;
        li.classList.add(t.end ? (t.ok ? 's-completed' : 's-failed') : 's-in_progress');
        li.appendChild(el('span', 'tl-time', JV.time(t.start)));
        const d = el('div', 'tl-main');
        d.appendChild(el('b', null, JV.clip(t.prompt, 90)));
        const bar = el('div', 'tl-bar');
        bar.appendChild(el('i'));
        d.appendChild(bar);
        li.appendChild(d);
        li.appendChild(el('span', 'tl-state', t.end ? `${t.ok ? 'Done' : 'Stopped'} · ${JV.dur(t.end - t.start)}` : `Running · ${JV.dur(Date.now() - t.start)}`));
      }
      ul.appendChild(li);
    }
  };

  // ------------------------------------------------------------- quick commands
  JV.PROMPTS = {
    briefing: 'Executive briefing, please. From the handoff and the live workspace: current focus and in-flight work, pending deploys, uncommitted work across the repos, knowledge freshness, and the open issues that matter. Short and visual - tables, not paragraphs.',
    status: "What's the current status of the workspace? The git state of each repo and anything uncommitted I should know about.",
    issues: 'Summarise the open issues in .claude/knowledge/open-issues.md by severity, and tell me which one you would tackle first and why.',
  };
  JV.briefing = () => JV.chat.submit(JV.PROMPTS.briefing);
  // ------------------------------------------------------------- system monitor
  function renderMonitor() {
    const s = state.stats;
    JV.gauge($('gCpu'), 'CPU', s?.cpu ?? null, s ? `${s.cores} cores` : '');
    JV.gauge($('gRam'), 'RAM', s?.ram?.pct ?? null, s ? `${JV.bytes(s.ram.used)} / ${JV.bytes(s.ram.total)}` : '');
    JV.gauge($('gDisk'), `Disk ${s?.disk?.root?.replace('\\', '') || ''}`.trim(), s?.disk?.pct ?? null, s?.disk ? `${JV.bytes(s.disk.total - s.disk.used)} free` : '');
    $('hostName').textContent = s ? s.host : '';
  }
  async function pollStats() {
    try { state.stats = await window.jarvis.stats(); } catch { /* keep the last value */ }
    if (state.view === 'command') renderMonitor();
  }

  // ------------------------------------------------------------- memory constellation
  const TYPE_COLOUR = { user: '#ffd36b', feedback: '#ff8fb1', project: '#5fd0ff', reference: '#8dffb0' };
  /** Draw memory documents as a star map: nodes are memories, lines are their [[links]]. */
  JV.constellation = (svgEl, docs, { labels = false, onPick = null, selected = null } = {}) => {
    svgEl.replaceChildren();
    const vb = svgEl.viewBox.baseVal;
    const W = vb.width;
    const H = vb.height;
    const nodes = docs.filter((d) => d.path.toLowerCase() !== 'memory.md').map((d) => ({ d, x: 0, y: 0, vx: 0, vy: 0, deg: 0 }));
    if (!nodes.length) {
      const t = JV.svg('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'c-empty' });
      t.textContent = 'No memories yet';
      svgEl.appendChild(t);
      return;
    }
    const byName = new Map();
    for (const n of nodes) { byName.set(n.d.name, n); byName.set(n.d.path.replace(/\.md$/i, ''), n); }
    const edges = [];
    for (const n of nodes) for (const l of n.d.links) { const m = byName.get(l); if (m && m !== n) { edges.push([n, m]); n.deg++; m.deg++; } }
    // deterministic start, then a short force layout
    nodes.forEach((n, i) => {
      let h = 0;
      for (const ch of n.d.name) h = (h * 33 + ch.charCodeAt(0)) >>> 0;
      const a = (i / nodes.length) * Math.PI * 2 + (h % 100) / 100;
      n.x = W / 2 + Math.cos(a) * W * 0.3;
      n.y = H / 2 + Math.sin(a) * H * 0.3;
    });
    const k = Math.sqrt((W * H) / nodes.length) * 0.55;
    for (let it = 0; it < 220; it++) {
      for (const a of nodes) { a.vx = 0; a.vy = 0; }
      for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]; const b = nodes[j];
        let dx = a.x - b.x; let dy = a.y - b.y;
        const d2 = Math.max(dx * dx + dy * dy, 1);
        const f = (k * k) / d2;
        dx *= f; dy *= f;
        a.vx += dx; a.vy += dy; b.vx -= dx; b.vy -= dy;
      }
      for (const [a, b] of edges) {
        const dx = a.x - b.x; const dy = a.y - b.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = (d - k) * 0.05;
        a.vx -= (dx / d) * f * d * 0.1; a.vy -= (dy / d) * f * d * 0.1;
        b.vx += (dx / d) * f * d * 0.1; b.vy += (dy / d) * f * d * 0.1;
      }
      const cool = 1 - it / 220;
      for (const a of nodes) {
        a.vx += (W / 2 - a.x) * 0.02; a.vy += (H / 2 - a.y) * 0.02;
        const v = Math.sqrt(a.vx * a.vx + a.vy * a.vy) || 1;
        const lim = Math.min(v, 12 * cool + 0.5);
        a.x = Math.min(W - (labels ? 150 : 16), Math.max(16, a.x + (a.vx / v) * lim));
        a.y = Math.min(H - 14, Math.max(12, a.y + (a.vy / v) * lim));
      }
    }
    // faint background stars
    for (let i = 0; i < 40; i++) {
      svgEl.appendChild(JV.svg('circle', { cx: (i * 97.3) % W, cy: (i * 53.7) % H, r: 0.6, class: 'c-star' }));
    }
    for (const [a, b] of edges) svgEl.appendChild(JV.svg('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'c-edge' }));
    for (const n of nodes) {
      const g = JV.svg('g', { class: `c-node${selected === n.d.path ? ' sel' : ''}`, transform: `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})` });
      const col = TYPE_COLOUR[n.d.type] || '#9fb2c8';
      g.appendChild(JV.svg('circle', { r: 7 + n.deg, class: 'c-halo', fill: col }));
      g.appendChild(JV.svg('circle', { r: 2.6 + Math.min(n.deg, 4) * 0.6, fill: col, class: 'c-dot' }));
      const title = JV.svg('title');
      title.textContent = `${n.d.name}${n.d.type ? ` (${n.d.type})` : ''}\n${n.d.description}`;
      g.appendChild(title);
      if (labels) {
        const t = JV.svg('text', { x: 9, y: 3.5, class: 'c-label' });
        t.textContent = n.d.name;
        g.appendChild(t);
      }
      if (onPick) { g.classList.add('clickable'); g.addEventListener('click', () => onPick(n.d)); }
      svgEl.appendChild(g);
    }
  };
  JV.TYPE_COLOUR = TYPE_COLOUR;

  // ------------------------------------------------------------- models & systems
  function renderLlm() {
    const g = $('llmGrid');
    g.replaceChildren();
    const curId = state.context?.model || state.model || '';
    const models = (state.models || []).filter((m) => m.value !== 'default');
    for (const m of models) {
      const active = state.modelChoice ? state.modelChoice === m.value : JV.sameModel(m.resolved, curId);
      const tile = el('div', `ltile${active ? ' on' : ''}`);
      const ib = el('span', 'l-ico');
      ib.appendChild(JV.icon('spark'));
      tile.appendChild(ib);
      const d = el('div');
      d.appendChild(el('b', null, m.name));
      d.appendChild(el('small', active ? 'ok' : '', active ? 'Active' : 'Available'));
      tile.appendChild(d);
      tile.title = m.description || m.value;
      g.appendChild(tile);
    }
    for (const s of state.mcp) {
      const tile = el('div', `ltile mcp st-${s.status}`);
      const ib = el('span', 'l-ico');
      ib.appendChild(JV.icon('layers'));
      tile.appendChild(ib);
      const d = el('div');
      d.appendChild(el('b', null, s.name.replace(/^claude\.ai /, '')));
      d.appendChild(el('small', null, { connected: 'Connected', pending: 'Connecting…', failed: 'Failed', 'needs-auth': 'Needs sign-in', disabled: 'Disabled' }[s.status] || s.status));
      tile.appendChild(d);
      tile.title = s.error || `${s.name}${s.tools?.length ? ` · ${s.tools.length} tools` : ''}`;
      g.appendChild(tile);
    }
    if (!g.children.length) g.appendChild(el('div', 'muted empty', 'Connecting…'));
    const n = state.mcp.filter((m) => m.status === 'connected').length;
    $('llmCount').textContent = state.mcp.length ? `${n} connected` : '';
  }

  // ------------------------------------------------------------- workspace signals -> feed
  let lastKnowledge = null;
  JV.workspaceSignals = (ws) => {
    const k = ws.knowledge;
    if (k?.state === 'stale') {
      JV.feed({ key: 'knowledge', level: 'warn', title: `Knowledge is stale: ${k.stale.map((s) => s.file).join(', ')}`, sub: 'Run /relearn before relying on it', action: 'knowledge' });
      if (lastKnowledge !== 'stale') JV.notify(`Knowledge is stale (${k.stale.length} file${k.stale.length > 1 ? 's' : ''}). Run /relearn before relying on it.`, { level: 'warn', action: 'knowledge', key: 'knowledge' });
    } else if (k?.state === 'current') {
      JV.feed({ key: 'knowledge', level: 'ok', title: 'Knowledge is current', sub: k.lastScan ? `baseline ${k.lastScan.slice(0, 10)}` : '', action: 'knowledge' });
    } else if (k?.state === 'no-baseline') {
      JV.feed({ key: 'knowledge', level: 'warn', title: 'Knowledge has no baseline', sub: 'Run /relearn', action: 'knowledge' });
    }
    lastKnowledge = k?.state || null;
    if (k?.unmapped) JV.feed({ key: 'unmapped', level: 'info', title: `${k.unmapped} changed file${k.unmapped > 1 ? 's' : ''} outside mapped knowledge`, sub: 'Coverage gap', action: 'knowledge' });

    const iss = ws.issues;
    if (iss?.available) {
      const crit = iss.list.filter((i) => i.open && i.severity === 'critical').length;
      JV.feed({ key: 'issues', level: crit ? 'warn' : 'info', title: `${iss.open} open issue${iss.open === 1 ? '' : 's'}${crit ? ` · ${crit} critical` : ''}`, sub: 'open-issues.md', action: 'workspace' });
    }
    const dirty = (ws.repos || []).filter((r) => r.modified + r.staged + r.untracked > 0);
    if (dirty.length) JV.feed({ key: 'dirty', level: 'info', title: `${dirty.length} repo${dirty.length > 1 ? 's have' : ' has'} uncommitted changes`, sub: dirty.map((r) => r.nickname).join(', '), action: 'workspace' });
    else JV.feed({ key: 'dirty', level: 'ok', title: 'All repos are clean', sub: 'git status', action: 'workspace' });
    const behind = (ws.repos || []).filter((r) => r.behind > 0);
    if (behind.length) JV.feed({ key: 'behind', level: 'info', title: `${behind.length} repo${behind.length > 1 ? 's are' : ' is'} behind origin`, sub: behind.map((r) => `${r.nickname} −${r.behind}`).join(', '), action: 'workspace' });

    const dated = (ws.focus?.items || [])
      .map((i) => ({ i, d: (/(\d{4}-\d{2}-\d{2})/.exec(i.title) || [])[1] }))
      .filter((x) => x.d)
      .sort((a, b) => b.d.localeCompare(a.d))
      .slice(0, 2)
      .reverse();
    dated.forEach((x, n) => JV.feed({ key: `focus${n}`, level: 'tip', title: x.i.title.replace(/\s*\(.*?\d{4}-\d{2}-\d{2}.*?\)\s*/, ' ').trim(), sub: `Current focus · ${x.d}`, action: 'tasks' }));
  };

  // ------------------------------------------------------------- render + subscriptions
  JV.renderDashboard = () => {
    renderOrbText();
    renderAgentGrid();
    JV.timelineRows($('timeline'));
    renderMonitor();
    renderLlm();
    renderFeed();
  };

  JV.on('status', () => { renderOrbText(); JV.startOrb(); });
  JV.on('init', () => { renderOrbText(); renderLlm(); });
  JV.on('agents', renderAgentGrid);
  JV.on('agents_changed', renderAgentGrid);
  JV.on('models', renderLlm);
  JV.on('model', renderLlm);
  JV.on('context', renderLlm);
  JV.on('mcp', renderLlm);
  JV.on('tasks', () => JV.timelineRows($('timeline')));
  JV.on('turns', () => JV.timelineRows($('timeline')));
  JV.on('view', (v) => { if (v === 'command') { JV.renderDashboard(); lastT = 0; JV.startOrb(); pollStats(); } });

  // The gauges exist only on the Command Center: no polling for them anywhere else.
  setInterval(() => { if (!document.hidden && state.view === 'command') pollStats(); }, 2500);
  setInterval(() => { if (state.view === 'command' && state.turns.some((t) => !t.end)) JV.timelineRows($('timeline')); }, 5000);
  pollStats();
})();
