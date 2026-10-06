/* JARVIS window - the Conversations view: transcript, permission and question cards,
   the composer (attachments, / commands, context ring, timer, thinking, model + effort,
   mode) and the sessions list. */
(() => {
  'use strict';
  const { $, el, state } = JV;

  const transcript = $('transcript');
  const input = $('input');
  const sendBtn = $('send');
  const stopBtn = $('stop');
  const hint = $('hint');

  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  const MAX_IMAGE_BYTES = 3.75 * 1024 * 1024;

  const ui = {
    turn: null,          // current assistant turn element (.msg.assistant .body)
    live: null,          // streaming text element
    tools: new Map(),    // tool_use id -> { row, out, st }
    agents: new Map(),   // Agent tool_use id -> { card, steps, st, name }
    prompts: new Map(),  // prompt id -> card
    attachments: [],
  };

  // ------------------------------------------------------------- scrolling
  const nearBottom = () => transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 140;
  function stick(fn) {
    const atBottom = nearBottom();
    fn();
    if (atBottom) transcript.scrollTop = transcript.scrollHeight;
  }

  // ------------------------------------------------------------- status
  const busy = () => state.status === 'working' || state.status === 'waiting';
  function statusHint() {
    stopBtn.hidden = !busy();
    hint.textContent = state.status === 'waiting' ? 'JARVIS is waiting for your answer above.' : busy() ? 'Esc to stop. You can keep typing - messages queue.' : '';
  }
  JV.on('status', statusHint);

  // ------------------------------------------------------------- transcript building
  function hideWelcome() { const w = $('welcome'); if (w) w.remove(); }

  /** Messages kept in the window; older ones are dropped so a long session stays fast. */
  const MAX_MESSAGES = 400;
  function trimTranscript() {
    if (transcript.childElementCount <= MAX_MESSAGES) return;
    let note = transcript.querySelector(':scope > .trimmed-note');
    if (!note) {
      note = el('div', 'notice trimmed-note', 'Earlier messages are hidden to keep the window fast. Resume the session to see them.');
      transcript.prepend(note);
    }
    while (transcript.childElementCount > MAX_MESSAGES + 1) {
      const old = note.nextElementSibling;
      if (!old || old.querySelector('.prompt:not(.done)')) break; // never drop an unanswered prompt
      old.remove();
    }
    for (const [id, t] of ui.tools) if (!t.row.isConnected) ui.tools.delete(id);
    for (const [id, a] of ui.agents) if (!a.card.isConnected) ui.agents.delete(id);
  }

  /** The undo button on a user message: files go back to how they were before it. */
  function attachRewind(m, uuid) {
    if (!m || !uuid || m.querySelector('.rewind')) return;
    const b = el('button', 'icon-btn rewind');
    b.title = 'Undo the file changes made since this message';
    b.appendChild(JV.icon('undo'));
    b.onclick = () => rewindTo(uuid);
    m.prepend(b);
  }

  function addUser(text, attachments = [], images = 0, uuid = null, via = null) {
    hideWelcome();
    if (ui.live) flushText(); else pendingText = '';
    trimTranscript();
    let m = null;
    stick(() => {
      m = el('div', 'msg user');
      const b = el('div', 'bubble');
      // A message that came from your phone says so, so the desk never wonders who typed it.
      if (via === 'telegram') {
        const tag = el('div', 'via');
        tag.appendChild(JV.icon('phone'));
        tag.appendChild(el('span', null, 'via Telegram'));
        b.appendChild(tag);
      }
      if (text) b.appendChild(el('div', null, text));
      if (attachments.length || images) {
        const row = el('div', 'bubble-att');
        for (const a of attachments) {
          // A picture is shown as itself, and opens full size; a file opens (or is shown in Explorer).
          if (a.kind === 'image' && a.data) {
            const img = el('img', 'bubble-img');
            img.src = `data:${a.mediaType};base64,${a.data}`;
            img.alt = a.name || 'image';
            img.title = 'Click to view full size';
            img.onclick = () => viewImage(img.src, a);
            row.appendChild(img);
            continue;
          }
          const chip = el('span', 'achip small');
          chip.appendChild(JV.icon('file'));
          chip.appendChild(el('span', null, a.name));
          if (a.path) {
            chip.classList.add('clickable');
            chip.title = `${a.path}\nClick to open`;
            chip.onclick = async () => { const r = await window.jarvis.openAttachment(a.path); if (!r?.ok) flashHint(r?.error || 'Could not open that file.'); };
          }
          row.appendChild(chip);
        }
        if (images) { const chip = el('span', 'achip small'); chip.appendChild(JV.icon('image')); chip.appendChild(el('span', null, `${images} image${images > 1 ? 's' : ''}`)); row.appendChild(chip); }
        b.appendChild(row);
      }
      m.appendChild(b);
      attachRewind(m, uuid);
      transcript.appendChild(m);
    });
    ui.turn = null;
    ui.live = null;
    return m;
  }

  /** A picture from a message, full size over the window. Click or Esc closes it. */
  function viewImage(src, a) {
    const veil = el('div', 'img-view');
    const img = el('img');
    img.src = src;
    veil.appendChild(img);
    const bar = el('div', 'img-view-bar');
    bar.appendChild(el('span', null, a.name || ''));
    if (a.path) {
      const open = el('button', 'btn', 'Open file');
      open.onclick = (e) => { e.stopPropagation(); window.jarvis.openAttachment(a.path); };
      bar.appendChild(open);
    }
    veil.appendChild(bar);
    const close = () => { veil.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    veil.onclick = close;
    document.addEventListener('keydown', onKey);
    document.body.appendChild(veil);
  }

  function turnBody() {
    if (ui.turn) return ui.turn;
    hideWelcome();
    const m = el('div', 'msg assistant');
    const av = el('div', 'avatar');
    av.appendChild(el('span', null, 'J'));
    m.appendChild(av);
    const body = el('div', 'body');
    m.appendChild(body);
    transcript.appendChild(m);
    ui.turn = body;
    return body;
  }

  function textStart() {
    flushText();
    stick(() => {
      const c = el('div', 'content live');
      turnBody().appendChild(c);
      ui.live = c;
    });
  }
  // Streamed text is written once per frame, not once per chunk: each write forces a layout.
  let pendingText = '';
  let textFrame = 0;
  function flushText() {
    if (textFrame) { cancelAnimationFrame(textFrame); textFrame = 0; }
    if (!pendingText) return;
    const t = pendingText;
    pendingText = '';
    if (!ui.live) textStart();
    stick(() => { ui.live.textContent += t; });
  }
  function textDelta(t) {
    pendingText += t;
    if (!textFrame) textFrame = requestAnimationFrame(() => { textFrame = 0; flushText(); });
  }
  function textFinal(t) {
    // The final text replaces the streamed copy, so anything still buffered is moot.
    pendingText = '';
    if (textFrame) { cancelAnimationFrame(textFrame); textFrame = 0; }
    stick(() => {
      let c = ui.live;
      if (!c) { c = el('div', 'content'); turnBody().appendChild(c); }
      c.classList.remove('live');
      JV.renderMarkdown(c, t);
      ui.live = null;
    });
  }

  const TOOL_ICONS = { Bash: 'code', PowerShell: 'code', Read: 'file', Write: 'file', Edit: 'file', NotebookEdit: 'file', Grep: 'search', Glob: 'search', WebFetch: 'globe', WebSearch: 'globe', Skill: 'spark', TodoWrite: 'tasks', TaskCreate: 'tasks', TaskUpdate: 'tasks', AskUserQuestion: 'info' };
  JV.prettyToolName = (name) => {
    if (name.startsWith('mcp__')) {
      const parts = name.split('__');
      return `${parts[1] || 'mcp'} · ${parts.slice(2).join('__') || ''}`;
    }
    return name;
  };
  const toolIcon = (name) => JV.icon(TOOL_ICONS[name] || (name.startsWith('mcp__') ? 'layers' : 'tools'));

  function toolRow(name, detail) {
    const row = el('div', 'tool');
    const ico = el('span', 'ico');
    ico.appendChild(toolIcon(name));
    row.appendChild(ico);
    row.appendChild(el('span', 'tname', JV.prettyToolName(name)));
    row.appendChild(el('span', 'tdetail', detail || ''));
    return row;
  }

  function toolUse(e) {
    if (e.agent && !e.parent) return agentStart(e);
    if (e.parent) {
      const a = ui.agents.get(e.parent);
      if (a) stick(() => { a.steps.appendChild(el('div', null, `${JV.prettyToolName(e.name)}  ${e.detail || ''}`)); a.steps.scrollTop = a.steps.scrollHeight; });
      return;
    }
    stick(() => {
      const row = toolRow(e.name, e.detail);
      const st = el('span', 'tstate run', 'running');
      row.appendChild(st);
      const out = el('div', 'tool-output');
      row.addEventListener('click', () => out.classList.toggle('open'));
      const body = turnBody();
      body.appendChild(row);
      body.appendChild(out);
      ui.tools.set(e.id, { row, out, st });
    });
  }

  function toolResult(e) {
    if (e.parent) return; // inside a subagent - its card shows the steps
    const a = ui.agents.get(e.id);
    if (a) return agentDone(e, a);
    const t = ui.tools.get(e.id);
    if (!t) return;
    t.st.className = `tstate ${e.isError ? 'err' : 'ok'}`;
    t.st.textContent = e.isError ? '✗ failed' : '✓';
    t.out.replaceChildren(el('pre', null, e.preview || '(no output)'));
  }

  function agentStart(e) {
    stick(() => {
      const card = el('div', 'agent-card running');
      const head = el('div', 'head');
      head.appendChild(el('span', 'badge', JV.minionName ? `${JV.minionName(e.agent)} · ${e.agent}` : e.agent));
      head.appendChild(el('span', 'task', e.agentTask || 'Working…'));
      const st = el('span', 'tstate run', 'working');
      head.appendChild(st);
      const steps = el('div', 'steps');
      card.appendChild(head);
      card.appendChild(steps);
      turnBody().appendChild(card);
      ui.agents.set(e.id, { card, steps, st, name: e.agent });
    });
  }

  function agentDone(e, a) {
    // A background agent's call answers "launched" at once; it is done only when its task
    // notification arrives (agent_task, below) - the agent floor follows the same rule.
    if (!e.isError && /async agent launched|running in the background/i.test(String(e.preview || '').slice(0, 160))) {
      a.st.textContent = 'working in the background';
      return;
    }
    a.card.classList.remove('running');
    a.st.className = `tstate ${e.isError ? 'err' : 'ok'}`;
    a.st.textContent = e.isError ? '✗ failed' : '✓ reported';
  }
  JV.on('agent_task', (e) => {
    if (e.phase !== 'done') return;
    const a = ui.agents.get(e.toolUseId);
    if (!a || !a.card.classList.contains('running')) return;
    agentDone({ isError: e.status !== 'completed', preview: '' }, a);
    if (e.status === 'stopped') a.st.textContent = '■ stopped';
  });

  // ------------------------------------------------------------- prompts
  function permissionCard(e) {
    stick(() => {
      const card = el('div', 'prompt');
      card.appendChild(el('div', 'ptitle', e.title || `JARVIS wants to use ${e.displayName || JV.prettyToolName(e.toolName)}${e.fromAgent ? ' (from a specialist)' : ''}`));
      const desc = e.description || e.reason;
      if (desc) card.appendChild(el('div', 'pdesc', desc));
      if (e.detail) card.appendChild(el('pre', null, e.detail));
      if (e.blockedPath) card.appendChild(el('div', 'pdesc', `Path: ${e.blockedPath}`));
      const btns = el('div', 'pbtns');
      const deny = el('button', 'btn btn-danger', 'Deny');
      const once = el('button', 'btn btn-primary', 'Allow once');
      btns.appendChild(deny);
      btns.appendChild(once);
      let always = null;
      if (e.canAlways) { always = el('button', 'btn', 'Allow for this session'); btns.appendChild(always); }
      // Neither yes nor no: say something instead, and JARVIS asks again afterwards.
      const reply = el('input', 'preply');
      reply.placeholder = 'Or type a reply instead - JARVIS will ask again after…';
      const replyBtn = el('button', 'btn btn-ghost', 'Reply');
      btns.appendChild(reply);
      btns.appendChild(replyBtn);
      card.appendChild(btns);
      const finish = (label) => { btns.replaceWith(el('div', 'pstate', label)); card.classList.add('done'); };
      deny.onclick = () => { window.jarvis.respond(e.id, { type: 'deny' }); finish('✗ Denied'); };
      once.onclick = () => { window.jarvis.respond(e.id, { type: 'allow' }); finish('✓ Allowed'); };
      if (always) always.onclick = () => { window.jarvis.respond(e.id, { type: 'allow_always' }); finish('✓ Allowed for this session'); };
      const sendReply = () => {
        const text = reply.value.trim();
        if (!text) { reply.focus(); return; }
        window.jarvis.respond(e.id, { type: 'reply', text });
        finish(`💬 Replied instead: ${text.length > 120 ? `${text.slice(0, 119)}…` : text}`);
      };
      replyBtn.onclick = sendReply;
      reply.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); sendReply(); } });
      turnBody().appendChild(card);
      ui.prompts.set(e.id, card);
      // Never put focus on an Allow button: a prompt can appear mid-sentence, and the next
      // Space or Enter would approve it. Deny gets focus only when nobody is typing.
      if (state.view === 'chat' && !typing()) deny.focus();
    });
  }
  function typing() {
    const a = document.activeElement;
    return !!a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' || a.isContentEditable);
  }

  function questionCard(e) {
    stick(() => {
      const card = el('div', 'prompt question');
      card.appendChild(el('div', 'ptitle', 'JARVIS has a question'));
      const picks = [];
      for (const q of e.questions || []) {
        const box = el('div', 'q');
        if (q.header) box.appendChild(el('div', 'qh', q.header));
        box.appendChild(el('div', 'qt', q.question));
        const opts = el('div', 'opts');
        const chosen = new Set();
        const other = el('input', 'other');
        other.placeholder = 'Other… (type your own answer)';
        const buttons = [];
        for (const o of q.options || []) {
          const b = el('button', 'opt');
          b.appendChild(el('span', null, o.label));
          if (o.description) b.appendChild(el('small', null, o.description));
          b.onclick = () => {
            if (!q.multiSelect) { chosen.clear(); buttons.forEach((x) => x.classList.remove('sel')); }
            if (chosen.has(o.label)) { chosen.delete(o.label); b.classList.remove('sel'); }
            else { chosen.add(o.label); b.classList.add('sel'); }
            if (!q.multiSelect) other.value = '';
          };
          buttons.push(b);
          opts.appendChild(b);
        }
        opts.appendChild(other);
        box.appendChild(opts);
        card.appendChild(box);
        picks.push({ q, chosen, other });
      }
      const btns = el('div', 'pbtns');
      const submitBtn = el('button', 'btn btn-primary', 'Answer');
      const skip = el('button', 'btn btn-ghost', 'Skip');
      btns.appendChild(submitBtn);
      btns.appendChild(skip);
      card.appendChild(btns);
      const finish = (label) => { btns.replaceWith(el('div', 'pstate', label)); card.classList.add('done'); card.querySelectorAll('button, input').forEach((x) => (x.disabled = true)); };
      submitBtn.onclick = () => {
        const answers = {};
        for (const p of picks) {
          const typed = p.other.value.trim();
          const val = typed || [...p.chosen].join(', ');
          if (val) answers[p.q.question] = val;
        }
        if (Object.keys(answers).length < picks.length) { submitBtn.textContent = 'Answer every question'; setTimeout(() => (submitBtn.textContent = 'Answer'), 1500); return; }
        window.jarvis.respond(e.id, { type: 'answer', answers });
        finish('✓ Answered');
      };
      skip.onclick = () => { window.jarvis.respond(e.id, { type: 'deny', message: 'The user skipped the question.' }); finish('Skipped'); };
      turnBody().appendChild(card);
      ui.prompts.set(e.id, card);
    });
  }

  function promptDone(id) {
    const card = ui.prompts.get(id);
    ui.prompts.delete(id);
    if (card && !card.classList.contains('done')) {
      const btns = card.querySelector('.pbtns');
      if (btns) btns.replaceWith(el('div', 'pstate', 'No longer needed.'));
      card.classList.add('done');
    }
  }

  // ------------------------------------------------------------- misc cards
  function notice(text) { stick(() => transcript.appendChild(el('div', 'notice', text))); }

  function errorCard(message, offerRestart) {
    stick(() => {
      const c = el('div', 'error-card', message);
      if (offerRestart) {
        const b = el('button', 'btn', 'Start a new session');
        b.onclick = () => newSession();
        c.appendChild(document.createElement('br'));
        c.appendChild(b);
      }
      (ui.turn || transcript).appendChild(c);
    });
  }
  JV.chatError = errorCard;

  function commandOutput(text) {
    stick(() => {
      const c = el('div', 'content cmd-out');
      JV.renderMarkdown(c, text.replace(/\x1b\[[0-9;]*m/g, ''));
      turnBody().appendChild(c);
    });
  }

  function turnFoot(e) {
    if (!ui.turn) return;
    const secs = e.durationMs ? (e.durationMs / 1000).toFixed(1) + 's' : '';
    // A stop you asked for is not a failure. Claude Code reports an interrupt as
    // error_during_execution with a diagnostic string, which used to be drawn as a red error
    // card - alarming, for something you just did on purpose.
    const byYou = !e.ok && JV.stoppedByUser();
    const text = e.ok ? `Completed${secs ? ' in ' + secs : ''}`
      : byYou ? `Stopped by you${secs ? ' after ' + secs : ''}`
        : `Stopped (${e.subtype})${secs ? ' after ' + secs : ''}`;
    stick(() => ui.turn.appendChild(el('div', 'turn-foot', text)));
    if (!e.ok && !byYou && e.errors && e.errors.length) errorCard(e.errors.join('\n'));
    ui.turn = null;
    ui.live = null;
  }

  // ------------------------------------------------------------- sessions
  // Bumped by every session switch, so a history that arrives late is dropped, not merged.
  let switchSeq = 0;

  function resetTranscript() {
    transcript.replaceChildren();
    ui.turn = null; ui.live = null;
    pendingText = '';
    ui.tools.clear(); ui.agents.clear(); ui.prompts.clear();
  }

  async function newSession() {
    if (busy() && !confirm('JARVIS is still working. Start a new session anyway?')) return;
    await startFresh();
  }

  async function startFresh() {
    // The new id only arrives with the first reply; until then there is no current session.
    state.sessionId = null;
    switchSeq++;
    resetTranscript();
    const w = el('div', 'welcome');
    w.id = 'welcome';
    w.appendChild(el('h1', null, 'New session, sir.'));
    w.appendChild(el('p', null, 'Standing by.'));
    transcript.appendChild(w);
    JV.emit('session_reset', { resumed: false });
    await window.jarvis.start({});
    loadSessions();
    input.focus();
  }

  // fromPhone: /switch from Telegram. remote.mjs only sends it while idle, so there is no
  // question to ask, and the view you are on at the desk is left alone.
  async function resumeSession(id, title, { fromPhone = false } = {}) {
    if (id === state.sessionId) { if (!fromPhone) JV.show('chat'); return; }
    if (!fromPhone && busy() && !confirm('JARVIS is still working. Switch sessions anyway?')) return;
    const seq = ++switchSeq;
    state.sessionId = id; // a second click on the same session is now a no-op
    if (!fromPhone) JV.show('chat');
    resetTranscript();
    JV.emit('session_reset', { resumed: true, id });
    // Stop the old session before anything is drawn, so none of its output or prompts
    // can land in this transcript while the history loads.
    await window.jarvis.start({ resume: id });
    if (seq !== switchSeq) return;
    notice(`Resuming: ${title}`);
    const history = await window.jarvis.history(id);
    if (seq !== switchSeq) return;
    for (const h of history) {
      if (h.role === 'user') addUser(h.text, h.attachments || [], h.images || 0, h.uuid || null);
      else if (h.role === 'assistant') { const c = el('div', 'content'); JV.renderMarkdown(c, h.text); turnBody().appendChild(c); }
      else if (h.role === 'tool') turnBody().appendChild(toolRow(h.name, h.detail));
      else if (h.role === 'notice') notice(h.text);
    }
    ui.turn = null;
    transcript.scrollTop = transcript.scrollHeight;
    loadSessions();
    input.focus();
  }

  async function loadSessions() {
    state.sessions = await window.jarvis.sessions();
    renderSessions();
    JV.emit('sessions', state.sessions);
  }
  let sessionsTimer = null;
  JV.refreshSessionsSoon = () => { clearTimeout(sessionsTimer); sessionsTimer = setTimeout(loadSessions, 1200); };

  let editingTitle = false; // a rename box is open: a list refresh would throw it away
  function renderSessions() {
    if (editingTitle) return;
    const ul = $('sessions');
    const f = $('sessionFilter').value.trim().toLowerCase();
    const list = state.sessions.filter((s) => !f || s.title.toLowerCase().includes(f));
    ul.replaceChildren();
    if (!list.length) { ul.appendChild(el('li', 'muted', f ? 'No match' : 'No sessions yet')); return; }
    for (const s of list) {
      const li = el('li');
      li.appendChild(el('span', null, s.title));
      li.appendChild(el('small', null, JV.ago(s.lastModified)));
      li.title = s.title;
      if (s.id === state.sessionId) li.classList.add('current');
      li.onclick = () => resumeSession(s.id, s.title);
      const acts = el('span', 'acts');
      const ren = el('button', 'icon-btn');
      ren.title = 'Rename this session';
      ren.appendChild(JV.icon('edit'));
      ren.onclick = (e) => { e.stopPropagation(); editTitle(li, s); };
      const del = el('button', 'icon-btn');
      del.title = 'Delete this session';
      del.appendChild(JV.icon('trash'));
      del.onclick = (e) => { e.stopPropagation(); confirmDeleteInRow(li, s); };
      acts.appendChild(ren);
      acts.appendChild(del);
      li.appendChild(acts);
      ul.appendChild(li);
    }
  }

  /** Rename in place: Enter saves, Esc or clicking away cancels. */
  function editTitle(li, s) {
    editingTitle = true;
    const box = el('input', 'field title-edit');
    box.value = s.title;
    box.maxLength = 100;
    box.setAttribute('aria-label', 'Session title');
    li.onclick = null;
    li.replaceChildren(box);
    box.focus();
    box.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      editingTitle = false;
      const t = box.value.replace(/\s+/g, ' ').trim();
      if (save && t && t !== s.title) await renameSession(s, t);
      else renderSessions();
    };
    box.onclick = (e) => e.stopPropagation();
    box.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') finish(false);
    };
    box.onblur = () => finish(false);
  }

  /**
   * Delete from the sidebar asks right there in the row. It used to put a card in the
   * conversation, so a few deletes filled whatever session you had open.
   */
  function confirmDeleteInRow(li, s) {
    editingTitle = true; // hold off list refreshes while the question is open
    const warn = s.id === state.sessionId && busy() ? ' JARVIS is still working.' : '';
    li.onclick = (e) => e.stopPropagation();
    li.classList.add('confirming');
    li.title = '';
    const q = el('span', 'del-q', `Delete "${s.title}" permanently?${warn}`);
    q.title = s.title;
    const btns = el('div', 'del-btns');
    const yes = el('button', 'btn btn-danger', 'Delete');
    const no = el('button', 'btn', 'Keep it');
    btns.appendChild(yes);
    btns.appendChild(no);
    li.replaceChildren(q, btns);
    let done = false;
    const finish = async (ok) => {
      if (done) return;
      done = true;
      editingTitle = false;
      if (ok) await deleteSession(s, { force: true, quiet: true });
      else renderSessions();
    };
    yes.onclick = (e) => { e.stopPropagation(); finish(true); };
    no.onclick = (e) => { e.stopPropagation(); finish(false); };
    li.onkeydown = (e) => { if (e.key === 'Escape') { e.stopPropagation(); finish(false); } };
    // Clicking anywhere else counts as "keep it".
    btns.addEventListener('focusout', (e) => { if (!li.contains(e.relatedTarget)) setTimeout(() => finish(false), 0); });
    no.focus();
  }

  async function renameSession(s, title) {
    const r = await window.jarvis.renameSession(s.id, title);
    if (!r || !r.ok) {
      errorCard(`Could not rename "${s.title}": ${r?.error || 'unknown error'}`);
      renderSessions();
      return false;
    }
    const hit = state.sessions.find((x) => x.id === s.id);
    if (hit) hit.title = r.title;
    renderSessions();
    JV.emit('sessions', state.sessions);
    JV.refreshSessionsSoon();
    flashHint(`Renamed: ${r.title}`);
    return true;
  }

  /** Undo the file changes made since a user message (SDK file checkpoints). The conversation is kept. */
  async function rewindTo(uuid) {
    if (busy()) { flashHint('Stop JARVIS first (Esc) - it may still be changing files.'); return; }
    const dry = await window.jarvis.rewind(uuid, true);
    if (!dry || !dry.canRewind) { notice(`Nothing to undo from that message: ${dry?.error || 'no checkpoint was recorded for it.'}`); return; }
    const files = dry.filesChanged || [];
    if (!files.length) { notice('No files have changed since that message.'); return; }
    const cwd = (state.info?.cwd || '').toLowerCase();
    const rel = (f) => (cwd && f.toLowerCase().startsWith(cwd) ? f.slice(cwd.length).replace(/^[\\/]/, '') : f);
    const list = files.slice(0, 12).map(rel).join('\n') + (files.length > 12 ? `\n…and ${files.length - 12} more` : '');
    const n = `${files.length} file${files.length > 1 ? 's' : ''}`;
    const ok = await confirmCard(
      `Undo the changes to ${n}?`,
      `They go back to how they were before that message (+${dry.insertions || 0} / −${dry.deletions || 0} lines). The conversation stays as it is. Any later edits to these files, including your own, are undone too.`,
      'Undo changes',
      list,
    );
    if (!ok) return;
    const r = await window.jarvis.rewind(uuid, false);
    if (!r || !r.canRewind) { errorCard(`The undo failed: ${r?.error || 'unknown error'}`); return; }
    notice(`Restored ${n}${r.skippedLinks ? ` - ${r.skippedLinks} skipped (a link, or an unreadable backup)` : ''}.`);
    JV.refreshWorkspace?.(true);
  }

  /**
   * A yes/no card in the conversation. Resolves true only on a click of the danger button -
   * unlike window.confirm, which came back true when the window closed under it.
   */
  function confirmCard(title, desc, yesLabel, detail = '') {
    JV.show('chat');
    return new Promise((resolve) => {
      stick(() => {
        const card = el('div', 'prompt confirm-card');
        card.appendChild(el('div', 'ptitle', title));
        if (desc) card.appendChild(el('div', 'pdesc', desc));
        if (detail) card.appendChild(el('pre', null, detail));
        const btns = el('div', 'pbtns');
        const yes = el('button', 'btn btn-danger', yesLabel);
        const no = el('button', 'btn', 'Keep it');
        btns.appendChild(yes);
        btns.appendChild(no);
        card.appendChild(btns);
        const finish = (ok) => { btns.replaceWith(el('div', 'pstate', ok ? '✓ Confirmed' : 'Kept')); card.classList.add('done'); resolve(ok); };
        yes.onclick = () => finish(true);
        no.onclick = () => finish(false);
        transcript.appendChild(card);
        no.focus();
      });
    });
  }

  /** Permanently delete a session (anthropics/claude-code#25304). The current one ends and a new one starts. */
  // quiet: asked from the sidebar, so the result goes in the hint line, not the conversation.
  async function deleteSession(s, { force = false, quiet = false } = {}) {
    const current = s.id === state.sessionId;
    const warn = current && busy() ? ' JARVIS is still working - this stops it.' : '';
    if (!force && !(await confirmCard(`Delete "${s.title}"?`, `The conversation is deleted permanently and cannot be recovered.${warn}`, 'Delete'))) return false;
    const r = await window.jarvis.deleteSession(s.id);
    if (!r || !r.ok) {
      errorCard(`Could not delete "${s.title}": ${r?.error || 'unknown error'}`, !!r?.own);
      loadSessions();
      return false;
    }
    if (r.own) await startFresh();
    if (quiet) flashHint(`Deleted: ${s.title}`);
    else notice(`Deleted: ${s.title}`);
    loadSessions();
    return true;
  }

  /** `/delete` = this session, `/delete <name or id>` = that one; `-f` skips the confirmation. */
  async function deleteCommand(args) {
    const force = args.some((a) => a === '-f' || a === '--force');
    const text = args.filter((a) => a !== '-f' && a !== '--force').join(' ').trim();
    if (!text || /^(current|this)$/i.test(text)) {
      if (!state.sessionId) { flashHint('There is no session to delete yet, sir.'); return; }
      const s = state.sessions.find((x) => x.id === state.sessionId) || { id: state.sessionId, title: 'this session' };
      return deleteSession(s, { force });
    }
    const hits = await window.jarvis.findSessions(text);
    if (!hits.length) { notice(`No session found matching "${text}"`); return; }
    if (hits.length === 1) return deleteSession(hits[0], { force });
    stick(() => {
      const card = el('div', 'prompt question pick-delete');
      card.appendChild(el('div', 'ptitle', `${hits.length} sessions match "${text}" - which one?`));
      const list = el('div', 'opts');
      for (const s of hits.slice(0, 15)) {
        const b = el('button', 'opt');
        b.appendChild(el('span', null, s.title));
        b.appendChild(el('small', null, `${JV.ago(s.lastModified)} · ${s.id.slice(0, 8)}`));
        b.onclick = async () => { if (await deleteSession(s, { force })) b.remove(); };
        list.appendChild(b);
      }
      if (hits.length > 15) list.appendChild(el('small', 'muted', `…and ${hits.length - 15} more - narrow it down.`));
      card.appendChild(list);
      transcript.appendChild(card);
    });
  }

  // ------------------------------------------------------------- attachments
  function renderAttach() {
    const row = $('attachRow');
    row.replaceChildren();
    row.hidden = !ui.attachments.length;
    ui.attachments.forEach((a, i) => {
      const chip = el('span', 'achip');
      if (a.kind === 'image') {
        const img = el('img');
        img.src = `data:${a.mediaType};base64,${a.data}`;
        chip.appendChild(img);
      } else chip.appendChild(JV.icon('file'));
      chip.appendChild(el('span', null, a.name));
      chip.title = a.path || a.name;
      const x = el('button', 'achip-x');
      x.title = 'Remove';
      x.appendChild(JV.icon('x'));
      x.onclick = () => { ui.attachments.splice(i, 1); renderAttach(); };
      chip.appendChild(x);
      row.appendChild(chip);
    });
  }
  function addAttachment(a) {
    if (!a) return;
    if (ui.attachments.length >= 10) { flashHint('Ten attachments at most, sir.'); return; }
    if (a.kind === 'file' && ui.attachments.some((x) => x.kind === 'file' && x.path === a.path)) return;
    ui.attachments.push(a);
    renderAttach();
  }
  function flashHint(t) { hint.textContent = t; hint.classList.add('flash'); setTimeout(() => { hint.classList.remove('flash'); statusHint(); }, 3500); }

  function attachFile(file) {
    const p = window.jarvis.pathForFile(file);
    if (IMAGE_TYPES.includes(file.type) && file.size <= MAX_IMAGE_BYTES) {
      const r = new FileReader();
      r.onload = () => {
        const data = String(r.result).split(',')[1] || '';
        addAttachment({ kind: 'image', name: file.name || 'pasted-image.png', mediaType: file.type, data });
      };
      r.readAsDataURL(file);
    } else if (p) {
      addAttachment({ kind: 'file', name: file.name, path: p });
    } else if (file.type.startsWith('image/')) {
      flashHint('That image is too large to paste (3.75 MB at most). Save it and attach the file instead.');
    }
  }

  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    files.forEach(attachFile);
  });
  const chatMain = $('chatMain');
  const veil = $('dropVeil');
  let dragDepth = 0;
  chatMain.addEventListener('dragenter', (e) => { if ([...e.dataTransfer.types].includes('Files')) { dragDepth++; veil.hidden = false; } });
  chatMain.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; veil.hidden = true; } });
  chatMain.addEventListener('dragover', (e) => { e.preventDefault(); });
  chatMain.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    veil.hidden = true;
    [...(e.dataTransfer?.files || [])].forEach(attachFile);
  });
  $('attachBtn').onclick = async () => { (await window.jarvis.pickFiles()).forEach(addAttachment); input.focus(); };

  // ------------------------------------------------------------- sending
  async function submit(text, { fromComposer = true, origin = 'desk', attachments = [] } = {}) {
    const t = (text != null ? text : input.value).trim();
    const atts = fromComposer ? ui.attachments.slice() : attachments.slice();
    if (!t && !atts.length) return;
    // /delete runs here in the window, not in Claude Code: the app owns its session list.
    const del = /^\/delete(?:\s+([\s\S]*))?$/i.exec(t);
    if (del && !atts.length) {
      if (fromComposer) { input.value = ''; autosize(); }
      closeSlash();
      return deleteCommand((del[1] || '').split(/\s+/).filter(Boolean));
    }
    if (state.status === 'closed' || state.status === 'offline') await window.jarvis.start(state.sessionId ? { resume: state.sessionId } : {});
    const bubble = addUser(t, atts, 0, null, origin);
    if (fromComposer) {
      input.value = '';
      ui.attachments = [];
      renderAttach();
      autosize();
    }
    closeSlash();
    JV.emit('user_sent', { text: t || `(${atts.length} attachment${atts.length > 1 ? 's' : ''})` });
    const r = await window.jarvis.send({ text: t, attachments: atts, origin });
    if (r && r.ok) attachRewind(bubble, r.uuid);
    else {
      // Give the draft back unless something new has been typed meanwhile.
      if (fromComposer && !input.value.trim() && !ui.attachments.length) {
        input.value = t;
        ui.attachments = atts;
        renderAttach();
        autosize();
      }
      errorCard(r?.error || 'That message did not go through. Try again in a moment.', !r?.error);
      JV.emit('send_failed', {});
    }
  }

  /** Other views send through here: shows the conversation and sends the text. */
  JV.chat = {
    submit: (text) => { JV.show('chat'); return submit(text, { fromComposer: false }); },
    insert: (text) => { JV.show('chat'); input.value = text; autosize(); input.focus(); input.setSelectionRange(text.length, text.length); },
    newSession,
    resumeSession,
    loadSessions,
  };
  window.__jarvisAutoprompt = (t) => JV.chat.submit(t);

  function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 220) + 'px'; }

  // ------------------------------------------------------------- slash commands
  const slashPop = $('slashPop');
  const slashFilter = $('slashFilter');
  let slashItems = [];
  let slashSel = 0;
  let slashFromInput = false;

  function openSlash(fromInput, filter = '') {
    slashFromInput = fromInput;
    slashPop.hidden = false;
    slashFilter.hidden = fromInput;
    slashFilter.value = fromInput ? '' : filter;
    renderSlash(filter);
    if (!fromInput) slashFilter.focus();
  }
  function closeSlash() { slashPop.hidden = true; }
  function renderSlash(filter) {
    const f = (filter || '').toLowerCase();
    const all = state.commands || [];
    slashItems = all
      .filter((c) => !f || c.name.toLowerCase().includes(f) || (c.description || '').toLowerCase().includes(f))
      .sort((a, b) => (b.name.toLowerCase().startsWith(f) - a.name.toLowerCase().startsWith(f)) || (a.builtin - b.builtin) || a.name.localeCompare(b.name))
      .slice(0, 60);
    slashSel = 0;
    const ul = $('slashList');
    ul.replaceChildren();
    if (!all.length) { ul.appendChild(el('li', 'muted', 'Commands load once the session is connected.')); return; }
    if (!slashItems.length) { ul.appendChild(el('li', 'muted', 'No matching command')); return; }
    slashItems.forEach((c, i) => {
      const li = el('li', i === 0 ? 'sel' : '');
      const top = el('div', 'cmd-top');
      top.appendChild(el('b', null, `/${c.name}`));
      if (c.argumentHint) top.appendChild(el('code', null, c.argumentHint));
      top.appendChild(el('span', `cmd-src ${c.builtin ? '' : 'custom'}`, c.builtin ? 'built-in' : 'workspace'));
      li.appendChild(top);
      if (c.description) li.appendChild(el('small', null, JV.clip(c.description, 140)));
      li.onmousedown = (e) => { e.preventDefault(); pickSlash(i); };
      ul.appendChild(li);
    });
  }
  function moveSlash(d) {
    if (!slashItems.length) return;
    slashSel = (slashSel + d + slashItems.length) % slashItems.length;
    const lis = $('slashList').children;
    [...lis].forEach((li, i) => li.classList.toggle('sel', i === slashSel));
    lis[slashSel]?.scrollIntoView({ block: 'nearest' });
  }
  function pickSlash(i) {
    const c = slashItems[i];
    if (!c) return;
    input.value = `/${c.name} `;
    closeSlash();
    autosize();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
  function slashKeys(e) {
    if (slashPop.hidden) return false;
    if (e.key === 'ArrowDown') { moveSlash(1); return true; }
    if (e.key === 'ArrowUp') { moveSlash(-1); return true; }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { pickSlash(slashSel); return true; }
    if (e.key === 'Escape') { closeSlash(); input.focus(); return true; }
    return false;
  }
  $('slashBtn').onclick = () => (slashPop.hidden ? openSlash(false) : closeSlash());
  slashFilter.addEventListener('input', () => renderSlash(slashFilter.value));
  slashFilter.addEventListener('keydown', (e) => { if (slashKeys(e)) e.preventDefault(); });
  JV.registerPop(slashPop, $('slashBtn'), input);

  input.addEventListener('input', () => {
    autosize();
    const v = input.value;
    if (/^\/[^\s]*$/.test(v)) openSlash(true, v.slice(1));
    else if (slashFromInput && !slashPop.hidden) closeSlash();
  });
  input.addEventListener('keydown', (e) => {
    if (slashKeys(e)) { e.preventDefault(); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });

  // ------------------------------------------------------------- model + effort
  const modelPop = $('modelPop');
  function currentModelEntry() {
    const ms = state.models || [];
    if (state.modelChoice) return ms.find((m) => m.value === state.modelChoice) || null;
    const id = state.context?.model || state.model || '';
    return ms.find((m) => JV.sameModel(m.resolved, id)) || ms.find((m) => m.value === 'default') || null;
  }
  function renderModelPill() {
    const id = state.context?.model || state.model;
    $('modelName').textContent = id ? JV.prettyModel(id) : (currentModelEntry()?.name || 'Model');
    $('effortName').textContent = state.effort ? JV.EFFORT_LABEL[state.effort] || state.effort : '';
    $('modelBtn').title = `Model: ${id || 'default'}${state.effort ? ` · effort ${JV.EFFORT_LABEL[state.effort]}` : ''}`;
  }
  function renderModelPop() {
    const ul = $('modelList');
    ul.replaceChildren();
    const cur = currentModelEntry();
    for (const m of state.models || []) {
      const li = el('li', m === cur ? 'sel' : '');
      const top = el('div', 'cmd-top');
      top.appendChild(el('b', null, m.name));
      if (m === cur) top.appendChild(JV.icon('check'));
      li.appendChild(top);
      if (m.description) li.appendChild(el('small', null, JV.clip(m.description, 120)));
      li.onclick = async () => {
        await window.jarvis.setModel(m.value === 'default' ? '' : m.value);
        state.modelChoice = m.value === 'default' ? null : m.value;
        renderModelPop();
        renderModelPill();
      };
      ul.appendChild(li);
    }
    if (!(state.models || []).length) ul.appendChild(el('li', 'muted', 'Models load once the session is connected.'));
    const seg = $('effortSeg');
    seg.replaceChildren();
    const levels = cur?.efforts?.length ? cur.efforts : (cur ? [] : ['low', 'medium', 'high', 'xhigh', 'max']);
    const opts = [[null, 'Default'], ...levels.map((l) => [l, JV.EFFORT_LABEL[l] || l])];
    for (const [v, label] of opts) {
      const b = el('button', (state.effort || null) === v ? 'on' : '', label);
      b.onclick = async () => { await window.jarvis.setEffort(v); };
      seg.appendChild(b);
    }
    $('effortNote').textContent = cur && !cur.efforts?.length ? 'This model has no effort setting.' : 'Higher effort thinks longer; it applies to this session only.';
  }
  $('modelBtn').onclick = () => { modelPop.hidden = !modelPop.hidden; if (!modelPop.hidden) renderModelPop(); };
  JV.registerPop(modelPop, $('modelBtn'));

  // ------------------------------------------------------------- mode
  const modePop = $('modePop');
  function renderModePill() {
    const b = $('modeBtn');
    b.replaceChildren(JV.icon(JV.MODE_ICON[state.mode] || 'shield'), el('b', null, JV.MODE_LABEL[state.mode] || state.mode));
    b.className = `pill mode m-${state.mode}`;
    b.title = JV.MODE_INFO[state.mode] || '';
  }
  function renderModePop() {
    const ul = $('modeList');
    ul.replaceChildren();
    const cur = currentModelEntry();
    for (const m of ['default', 'acceptEdits', 'plan', 'auto']) {
      const li = el('li', state.mode === m ? 'sel' : '');
      const top = el('div', 'cmd-top');
      top.appendChild(JV.icon(JV.MODE_ICON[m]));
      top.appendChild(el('b', null, JV.MODE_LABEL[m]));
      li.appendChild(top);
      let info = JV.MODE_INFO[m];
      if (m === 'auto' && cur && !cur.auto) info += ' (This model may not support it.)';
      li.appendChild(el('small', null, info));
      li.onclick = async () => { modePop.hidden = true; await window.jarvis.setMode(m); };
      ul.appendChild(li);
    }
  }
  $('modeBtn').onclick = () => { modePop.hidden = !modePop.hidden; if (!modePop.hidden) renderModePop(); };
  JV.registerPop(modePop, $('modeBtn'));

  // ------------------------------------------------------------- thinking, context, timer
  function renderThinking() {
    const b = $('thinkBtn');
    const on = state.thinking !== false;
    b.classList.toggle('on', on);
    b.title = state.thinking == null
      ? 'Extended thinking: the model default - click to turn it off for this session'
      : `Extended thinking: ${on ? 'on' : 'off'} - click to turn it ${on ? 'off' : 'on'} for this session`;
  }
  $('thinkBtn').onclick = () => window.jarvis.setThinking(state.thinking === false);

  function renderContext() {
    const c = state.context;
    const arc = $('ctxArc');
    const r = 14;
    const len = 2 * Math.PI * r;
    const pct = c ? Math.round(c.percentage) : null;
    arc.setAttribute('stroke-dasharray', `${len}`);
    arc.setAttribute('stroke-dashoffset', `${len * (1 - (pct || 0) / 100)}`);
    const ctx = $('ctx');
    ctx.classList.toggle('warm', pct != null && pct >= 70);
    ctx.classList.toggle('hot', pct != null && pct >= 90);
    $('ctxPct').textContent = pct == null ? '–' : `${pct}%`;
    ctx.title = c ? `Context: ${JV.num(c.totalTokens)} of ${JV.num(c.maxTokens)} tokens (${pct}%)` : 'Context window used';
  }
  $('ctx').onclick = () => JV.show('core');

  JV.renderTimer = () => {
    const t = state.sessionStart ? JV.dur(Date.now() - state.sessionStart) : '0m';
    $('sessTimer').querySelector('em').textContent = t;
  };

  // ------------------------------------------------------------- wiring
  /** Esc and the Stop button both come here, so the result can be told apart from a crash. */
  function stopTurn() {
    state.userStopAt = Date.now();
    window.jarvis.interrupt();
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && busy() && slashPop.hidden && modelPop.hidden && modePop.hidden && $('agentsPop').hidden) { e.preventDefault(); stopTurn(); }
  });
  sendBtn.onclick = () => submit();
  stopBtn.onclick = () => stopTurn();
  $('newSession').onclick = () => newSession();
  $('refreshSessions').onclick = (e) => JV.spinWhile(e.currentTarget, loadSessions);
  $('sessionFilter').addEventListener('input', renderSessions);
  transcript.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip[data-prompt]');
    if (chip) submit(chip.dataset.prompt, { fromComposer: false });
  });

  JV.on('text_start', textStart);
  JV.on('text_delta', (e) => textDelta(e.text));
  JV.on('text_final', (e) => textFinal(e.text));
  JV.on('tool_use', toolUse);
  JV.on('tool_result', toolResult);
  JV.on('permission', permissionCard);
  JV.on('question', questionCard);
  JV.on('prompt_done', (e) => promptDone(e.id));

  // ------------------------------------------------------------- remote control (Telegram)
  // A message from your phone goes through submit() like a typed one - same bubble, same
  // turn, same restart if the session was closed - but without touching the composer, so
  // a draft you left there is still there. The view is not switched: whatever you were
  // looking at stays put, and the conversation catches up when you open it.
  JV.on('remote_prompt', (e) => {
    const atts = Array.isArray(e?.attachments) ? e.attachments : [];
    if (e?.text || atts.length) submit(e.text || '', { fromComposer: false, origin: 'telegram', attachments: atts });
  });
  // /new from the phone. remote.mjs only sends this while JARVIS is idle, so there is no
  // "still working" question to ask - and nobody at the desk to answer it.
  JV.on('remote_new', () => startFresh());
  // /switch (or a tap on /sessions) from the phone.
  JV.on('remote_switch', (e) => { if (e?.id) resumeSession(e.id, e.title || 'a session', { fromPhone: true }); });
  // /stop from the phone: the ending reads "Stopped by you", as it does for Esc.
  JV.on('remote_stop', () => { state.userStopAt = Date.now(); });
  // Answered on the phone: the desk's card says so instead of "No longer needed".
  JV.on('prompt_remote', (e) => {
    const card = ui.prompts.get(e.id);
    if (!card || card.classList.contains('done')) return;
    const btns = card.querySelector('.pbtns');
    if (btns) btns.replaceWith(el('div', 'pstate', e.verdict || 'Answered from your phone'));
    card.querySelectorAll('button, input').forEach((x) => (x.disabled = true));
    card.classList.add('done');
  });
  JV.on('result', (e) => { turnFoot(e); JV.refreshSessionsSoon(); });
  JV.on('notice', (e) => notice(e.text));
  JV.on('command_output', (e) => commandOutput(e.text));
  JV.on('error', (e) => errorCard(e.message, state.status === 'closed'));
  JV.on('init', () => { renderModelPill(); renderModePill(); renderSessions(); JV.refreshSessionsSoon(); });
  JV.on('models', () => { renderModelPill(); if (!modelPop.hidden) renderModelPop(); });
  JV.on('model', () => { renderModelPill(); });
  JV.on('effort', () => { renderModelPill(); if (!modelPop.hidden) renderModelPop(); });
  JV.on('mode', () => { renderModePill(); });
  JV.on('thinking', renderThinking);
  JV.on('context', () => { renderContext(); renderModelPill(); });
  JV.on('commands', () => { if (!slashPop.hidden) renderSlash(slashFromInput ? input.value.slice(1) : slashFilter.value); });
  JV.on('view', (v) => { if (v === 'chat') setTimeout(() => input.focus(), 30); });

  renderThinking();
  renderModePill();
  renderContext();
  input.addEventListener('input', autosize);
})();
