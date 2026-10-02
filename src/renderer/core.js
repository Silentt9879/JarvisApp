/* JARVIS window - shared core: helpers, icons, state, event bus, router, notifications.
   The window talks to the app only through window.jarvis (preload.cjs). Everything the
   model or a tool produces is inserted as text, or as Markdown sanitized by DOMPurify -
   never as raw HTML. The only innerHTML below is for fixed icon markup defined here. */
(() => {
  'use strict';
  const JV = (window.JV = {});

  // ------------------------------------------------------------- DOM helpers
  JV.$ = (id) => document.getElementById(id);
  JV.el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const SVG_NS = 'http://www.w3.org/2000/svg';
  JV.svg = (tag, attrs = {}) => {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };

  // ------------------------------------------------------------- icons (fixed markup, stroke style)
  const ICONS = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    core: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
    agents: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4M9 4h6"/><circle cx="9" cy="14" r="1.3"/><circle cx="15" cy="14" r="1.3"/>',
    tasks: '<path d="M10 6h10M10 12h10M10 18h10"/><path d="M3.5 6l1.5 1.5L7.5 5M3.5 12l1.5 1.5L7.5 11"/><circle cx="5.2" cy="18" r="1.3"/>',
    memory: '<ellipse cx="12" cy="5.5" rx="7.5" ry="3"/><path d="M4.5 5.5v13c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-13"/><path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3"/>',
    chat: '<path d="M20 15a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z"/>',
    book: '<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2zM22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/>',
    tools: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-.5-.5-2.5z"/>',
    repo: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9a7 7 0 0 1-7 7H8"/>',
    focus: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    slash: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M15 7l-6 10"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    bulb: '<path d="M9 18h6M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V17h6v-.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z"/>',
    bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
    send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/>',
    x: '<path d="M18 6L6 18M6 6l12 12"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
    expand: '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>',
    collapse: '<path d="M15 9h6"/><path d="M15 9V3"/><path d="M9 15H3"/><path d="M9 15v6"/><path d="M21 3l-6 6"/><path d="M3 21l6-6"/>',
    columns: '<rect x="3" y="4" width="7" height="16" rx="1.5"/><rect x="14" y="4" width="7" height="16" rx="1.5"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>',
    wifi: '<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a15 15 0 0 1 20 0"/><circle cx="12" cy="19.5" r="1"/>',
    shield: '<path d="M12 2l8 3v6c0 5-3.5 9.5-8 11-4.5-1.5-8-6-8-11V5z"/><path d="M9 12l2 2 4-4"/>',
    layers: '<path d="M12 2l10 5-10 5L2 7z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/>',
    gauge: '<path d="M12 14l4-4"/><path d="M3.3 19a10 10 0 1 1 17.4 0"/>',
    play: '<path d="M7 4v16l13-8z"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
    briefing: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4M7 9h6M7 12h10"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    alert: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/>',
    chevron: '<path d="M9 18l6-6-6-6"/>',
    code: '<path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/>',
    bug: '<rect x="8" y="6" width="8" height="14" rx="4"/><path d="M12 20v-9M3 13h5M16 13h5M4 7l4 3M20 7l-4 3M4 19l4-3M20 19l-4-3"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    phone: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>',
    server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01"/>',
    compass: '<circle cx="12" cy="12" r="10"/><path d="M16.2 7.8l-2.1 6.3-6.3 2.1 2.1-6.3z"/>',
    verify: '<circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-6"/>',
    spark: '<path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z"/>',
  };
  JV.icon = (name, cls) => {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('class', `ic${cls ? ' ' + cls : ''}`);
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = ICONS[name] || ICONS.info; // fixed markup from the table above
    return s;
  };
  JV.fillIcons = (root = document) => {
    root.querySelectorAll('i[data-icon]').forEach((i) => { i.replaceWith(JV.icon(i.dataset.icon)); });
  };

  // ------------------------------------------------------------- formatting
  JV.clip = (s, n) => (s == null ? '' : String(s).length > n ? String(s).slice(0, n) + '…' : String(s));
  JV.num = (n) => (n == null ? '–' : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(n));
  JV.bytes = (b) => (b == null ? '–' : b >= 1024 ** 4 ? (b / 1024 ** 4).toFixed(1) + ' TB' : b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(1) + ' GB' : (b / 1024 ** 2).toFixed(0) + ' MB');
  JV.ago = (ms) => {
    const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return 'just now';
    const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60); if (h < 24) return `${h} h ago`;
    const d = Math.round(h / 24); return `${d} d ago`;
  };
  JV.dur = (ms) => {
    if (ms == null) return '–';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  };
  JV.time = (ms) => {
    const d = new Date(ms);
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: !JV.prefs.h24 });
  };
  /** claude-opus-5-5[1m] -> "Opus 5.5 · 1M" */
  JV.prettyModel = (id) => {
    if (!id) return 'Default';
    const m = /(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?!\d)/i.exec(id);
    const long = /\[1m\]/i.test(id) ? ' · 1M' : '';
    if (!m) return id;
    return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}${long}`;
  };
  /** "max" or "Claude Max" -> "Claude Max". */
  JV.planName = (a) => {
    const s = a?.subscriptionType;
    if (!s) return a?.apiProvider || null;
    const t = s[0].toUpperCase() + s.slice(1);
    return /^claude\b/i.test(t) ? t : `Claude ${t}`;
  };
  /** Same model, ignoring a context-size suffix such as [1m]. */
  JV.sameModel = (a, b) => !!a && !!b && a.replace(/\[.*?\]$/, '') === b.replace(/\[.*?\]$/, '');
  JV.EFFORT_LABEL = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
  JV.MODE_LABEL = { default: 'Ask', acceptEdits: 'Accept edits', plan: 'Plan', auto: 'Auto' };
  JV.MODE_INFO = {
    default: 'Ask before editing files or running commands that are not pre-allowed.',
    acceptEdits: 'File edits go ahead; commands still ask.',
    plan: 'Investigate and propose a plan only - nothing is changed.',
    auto: 'A safety classifier approves routine actions and still asks for risky ones.',
  };
  JV.MODE_ICON = { default: 'shield', acceptEdits: 'file', plan: 'tasks', auto: 'bolt' };

  // ------------------------------------------------------------- preferences (this window only)
  const PREF_KEY = 'jarvis.prefs';
  JV.prefs = { notify: true, reduceMotion: false, h24: false };
  try { Object.assign(JV.prefs, JSON.parse(localStorage.getItem(PREF_KEY) || '{}')); } catch { /* storage unavailable */ }
  JV.savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(JV.prefs)); } catch { /* not persisted */ } };

  // ------------------------------------------------------------- state + bus
  JV.state = {
    status: 'offline',
    sessionId: null,
    sessionStart: null,
    info: null,
    version: null,
    model: null,
    effort: null,
    thinking: null,      // null = not changed in this session (the model's default applies)
    mode: 'default',
    account: null,
    models: [],
    commands: [],
    agentList: [],
    mcp: [],
    tools: [],
    skills: [],
    context: null,
    tasks: [],
    turns: [],
    currentTurn: null,
    toolCalls: 0,
    toolErrors: 0,
    agentRuns: 0,
    agentUse: new Map(),
    agentActive: new Map(),
    pendingPrompts: 0,
    workspace: null,
    stats: null,
    memory: [],
    sessions: [],
    view: 'command',
  };

  const handlers = {};
  JV.on = (kind, fn) => { (handlers[kind] = handlers[kind] || []).push(fn); };
  JV.emit = (kind, data) => {
    for (const fn of handlers[kind] || []) {
      try { fn(data); } catch (err) { console.error(`[${kind}]`, err); }
    }
  };

  // ------------------------------------------------------------- markdown
  if (window.DOMPurify) {
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
    });
  }
  JV.renderMarkdown = (target, text) => {
    try {
      const html = window.marked ? window.marked.parse(String(text || ''), { gfm: true, breaks: false }) : null;
      if (html != null && window.DOMPurify) {
        // No style, class or form controls: text from the model or a tool (a web page, a
        // file) must not be able to draw its own overlay or a fake approval card.
        target.innerHTML = DOMPurify.sanitize(html, {
          FORBID_ATTR: ['style', 'class', 'id'],
          FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'option', 'dialog'],
        });
        target.querySelectorAll('pre').forEach((pre) => {
          const b = JV.el('button', 'copy', 'Copy');
          b.addEventListener('click', (e) => {
            e.stopPropagation();
            const code = pre.querySelector('code');
            navigator.clipboard.writeText(code ? code.innerText : pre.innerText).then(() => { b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1200); });
          });
          pre.appendChild(b);
        });
        return;
      }
    } catch { /* fall through to plain text */ }
    target.textContent = String(text || '');
  };

  // ------------------------------------------------------------- router
  JV.show = (view) => {
    const sec = JV.$(`view-${view}`);
    if (!sec) return;
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v === sec));
    document.querySelectorAll('#navList button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    JV.state.view = view;
    JV.emit('view', view);
  };
  window.__jarvisShow = (v) => JV.show(v);

  // ------------------------------------------------------------- notifications
  const notes = [];
  let unread = 0;
  /** level: info | ok | warn | err.  action: a view name or a function. */
  JV.notify = (text, { level = 'info', action = null, desktop = false, key = null } = {}) => {
    if (key) {
      const i = notes.findIndex((n) => n.key === key);
      if (i >= 0) notes.splice(i, 1);
    }
    notes.unshift({ t: Date.now(), text, level, action, key });
    notes.splice(50);
    unread++;
    renderBell();
    if (desktop && JV.prefs.notify && !document.hasFocus() && 'Notification' in window) {
      try {
        const n = new Notification('JARVIS', { body: String(text).slice(0, 180), silent: false });
        n.onclick = () => { window.focus(); if (typeof action === 'string') JV.show(action); };
      } catch { /* notifications unavailable */ }
    }
  };
  function renderBell() {
    const b = JV.$('bellBadge');
    b.hidden = unread === 0;
    b.textContent = unread > 9 ? '9+' : String(unread);
    const ul = JV.$('notifList');
    ul.replaceChildren();
    if (!notes.length) { ul.appendChild(JV.el('li', 'muted empty', 'Nothing yet, sir.')); return; }
    for (const n of notes) {
      const li = JV.el('li', `n-${n.level}`);
      li.appendChild(JV.icon(n.level === 'err' ? 'alert' : n.level === 'warn' ? 'alert' : n.level === 'ok' ? 'check' : 'info'));
      const d = JV.el('div');
      d.appendChild(JV.el('span', null, n.text));
      d.appendChild(JV.el('small', null, JV.time(n.t)));
      li.appendChild(d);
      if (n.action) {
        li.classList.add('clickable');
        li.onclick = () => { JV.$('notifPanel').hidden = true; if (typeof n.action === 'string') JV.show(n.action); else n.action(); };
      }
      ul.appendChild(li);
    }
  }
  JV.markRead = () => { unread = 0; renderBell(); };
  JV.clearNotes = () => { notes.length = 0; unread = 0; renderBell(); };
  JV.renderBell = renderBell;

  /** Close any open popover when clicking elsewhere. */
  JV.popovers = [];
  JV.registerPop = (pop, ...triggers) => { JV.popovers.push({ pop, triggers }); };
  document.addEventListener('mousedown', (e) => {
    for (const { pop, triggers } of JV.popovers) {
      if (pop.hidden) continue;
      if (pop.contains(e.target) || triggers.some((t) => t && t.contains(e.target))) continue;
      pop.hidden = true;
    }
  });

  /** A row of animated bars; animation is CSS, paused by the reduce-motion preference. */
  JV.wave = (container, bars = 28) => {
    container.replaceChildren();
    for (let i = 0; i < bars; i++) {
      const s = JV.el('span');
      s.style.animationDelay = `${((i * 137) % 1000) / 1000 - 1}s`;
      s.style.setProperty('--h', `${30 + ((i * 53) % 70)}%`);
      container.appendChild(s);
    }
  };

  /** Ring gauge (SVG): value 0-100 or null. */
  JV.gauge = (host, label, value, sub) => {
    host.replaceChildren();
    const r = 38;
    const c = 2 * Math.PI * r;
    const s = JV.svg('svg', { viewBox: '0 0 100 100' });
    s.appendChild(JV.svg('circle', { cx: 50, cy: 50, r: 46, class: 'g-outer' }));
    s.appendChild(JV.svg('circle', { cx: 50, cy: 50, r, class: 'g-track' }));
    const arc = JV.svg('circle', { cx: 50, cy: 50, r, class: 'g-arc', 'stroke-dasharray': `${c}`, 'stroke-dashoffset': `${c * (1 - (value == null ? 0 : value) / 100)}` });
    if (value != null && value >= 90) arc.classList.add('hot');
    else if (value != null && value >= 75) arc.classList.add('warm');
    s.appendChild(arc);
    host.appendChild(s);
    const t = JV.el('div', 'g-text');
    t.appendChild(JV.el('small', null, label));
    t.appendChild(JV.el('b', null, value == null ? '–' : `${value}%`));
    host.appendChild(t);
    if (sub != null) host.appendChild(JV.el('div', 'g-sub', sub));
  };
})();
