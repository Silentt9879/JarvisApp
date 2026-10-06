/* JARVIS window - Source Control: the GitHub tab (P-009 Phase 9). READ-ONLY.

   Pull requests and checks for the selected repository, and links to its GitHub pages,
   beside the git tabs rather than instead of them. git.js holds no GitHub logic: it
   announces a repository or tab change, shows this panel when its tab is chosen, and offers
   three places to add a link. Everything GitHub-specific is here and in main's github.mjs.

   The network rule. This file reaches GitHub ONLY from something the user did in it:
   opening the tab (which loads the pull request list), Open / Closed, Refresh, Load more,
   choosing a pull request, "Changed files", choosing a file, or a Check button. Choosing a
   repository or branch, switching tabs, committing and pushing never do - a push only
   OFFERS "Check workflow runs". Links are built in main from local refs, with no API call.

   Text from GitHub was written by other people. It goes in as text, and a pull request body
   as Markdown through JV.renderMarkdown (DOMPurify). Remote images stay blocked by the
   window's content policy, and each is replaced by a plain marker. No model is involved. */
(() => {
  'use strict';
  const { $, el } = JV;
  const sc = JV.sc;
  if (!sc) return;

  let key = null;          // the repository everything below belongs to
  let info = null;         // its GitHub identity (local), or null when it is not on GitHub
  let view = 'pulls';      // 'pulls' | 'checks'
  let prState = 'open';
  let list = null;         // the loaded pull request list
  let listBusy = false;
  let listErr = '';
  let openPr = null;       // the chosen pull request's number
  let pr = null;           // its detail, once loaded
  let prFiles = null;      // its changed files, once asked for
  let filesBusy = false;
  let openPrFile = null;
  let checkTarget = null;  // { sha, label } for a particular commit; null means this branch
  let checkRes = null;     // { runs, checks, at } from the last Check
  let checkBusy = false;
  let rate = null;
  let msg = { text: '', cls: '' };
  const seq = { info: 0, list: 0, pr: 0, files: 0, patch: 0, checks: 0 };

  // A reply is used only if it is the newest of its kind AND for the repository still shown.
  const current = (k) => !!k && k === key && k === sc.key();
  const reach = (p) => Promise.resolve(p).catch(() => ({ ok: false, error: 'Git could not be reached.' }));

  // ------------------------------------------------------------- wording
  const PR_STATE = { OPEN: ['Open', 'ok'], MERGED: ['Merged', 'merged'], CLOSED: ['Closed', 'err'] };
  const REVIEW = { APPROVED: ['Approved', 'ok'], CHANGES_REQUESTED: ['Changes requested', 'err'], REVIEW_REQUIRED: ['Review required', 'dirty'] };
  const ROLLUP = { SUCCESS: ['Checks passed', 'ok'], FAILURE: ['Checks failing', 'err'], ERROR: ['Checks errored', 'err'], PENDING: ['Checks running', 'new'], EXPECTED: ['Checks expected', 'new'] };
  const MERGE = { MERGEABLE: ['No conflicts', 'ok'], CONFLICTING: ['Has conflicts', 'err'], UNKNOWN: ['Mergeability not computed yet', 'muted'] };
  const REVIEWED = { APPROVED: 'approved', CHANGES_REQUESTED: 'requested changes', COMMENTED: 'commented', DISMISSED: 'dismissed', PENDING: 'pending' };
  const MARK = { added: ['A', 'added'], deleted: ['D', 'deleted'], modified: ['M', 'modified'], renamed: ['R', 'renamed'], copied: ['C', 'copied'] };

  const pill = (pair) => (pair ? el('em', `sc-pill ${pair[1]}`, pair[0]) : document.createTextNode(''));
  const ago = (iso) => (iso ? JV.ago(new Date(iso).getTime()) : '');
  const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const stamp = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };
  const duration = (a, b) => {
    const s = Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000);
    if (!Number.isFinite(s) || s < 0) return '';
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
  };

  /** One run or check, as a symbol, a colour and a word. */
  function runState(status, conclusion) {
    const s = String(status || '').toLowerCase();
    const c = String(conclusion || '').toLowerCase();
    if (s && s !== 'completed') {
      const words = { queued: 'Queued', in_progress: 'In progress', waiting: 'Waiting', pending: 'Pending', requested: 'Requested' };
      return { icon: '●', cls: 'live', text: words[s] || s.replace(/_/g, ' ') };
    }
    if (c === 'success') return { icon: '✓', cls: 'ok', text: 'Succeeded' };
    if (['failure', 'timed_out', 'startup_failure', 'error'].includes(c)) return { icon: '✕', cls: 'err', text: c === 'timed_out' ? 'Timed out' : 'Failed' };
    if (c === 'action_required') return { icon: '!', cls: 'warn', text: 'Action required' };
    if (['cancelled', 'skipped', 'neutral', 'stale'].includes(c)) return { icon: '○', cls: 'muted', text: c[0].toUpperCase() + c.slice(1) };
    return { icon: '○', cls: 'muted', text: c || s || 'Unknown' };
  }

  // ------------------------------------------------------------- repository and tab
  function reset(k) {
    key = k;
    info = null;
    view = 'pulls';
    prState = 'open';
    list = null; listBusy = false; listErr = '';
    openPr = null; pr = null; prFiles = null; filesBusy = false; openPrFile = null;
    checkTarget = null; checkRes = null; checkBusy = false;
    msg = { text: '', cls: '' };
    for (const n of Object.keys(seq)) seq[n] += 1;
    $('scTabGitHub').hidden = true;
    $('scGitHub').replaceChildren();
  }

  // A new repository: stop whatever was still asking GitHub for the old one, forget its
  // data, and find out - locally - whether this one is on GitHub at all.
  JV.on('sc_select', (k) => {
    if (key) reach(window.jarvis.ghCancel(key));
    reset(k);
    const s = ++seq.info;
    reach(window.jarvis.ghInfo(k)).then((r) => {
      if (s !== seq.info || !current(k)) return;
      info = r && r.ok && r.github ? r : null;
      $('scTabGitHub').hidden = !info;
    });
  });

  // Opening the tab is the request for the pull request list; coming back to it is not.
  JV.on('sc_tab', (which) => {
    if (which !== 'github') return;
    render();
    if (info && view === 'pulls' && !list && !listBusy) loadPulls();
  });

  // ------------------------------------------------------------- requests (explicit only)
  async function loadPulls({ more = false } = {}) {
    const k = key;
    if (!k || !info || listBusy) return;
    const s = ++seq.list;
    listBusy = true;
    listErr = '';
    renderSide();
    if (!openPr) renderRight();
    const r = await reach(window.jarvis.ghPulls(k, { state: prState, cursor: more && list ? list.cursor : null }));
    if (s !== seq.list || !current(k) || (r.key && r.key !== k)) return;
    listBusy = false;
    if (r.rate) rate = r.rate;
    if (!r.ok) listErr = r.cancelled ? '' : (r.error || 'GitHub did not answer.');
    else list = more && list ? { ...r, list: list.list.concat(r.list), branch: list.branch, viewer: list.viewer || r.viewer } : r;
    renderSide();
    if (!openPr) renderRight();
  }

  function setState(st) {
    if (st === prState) return;
    prState = st;
    list = null;
    listBusy = false;
    seq.list += 1;
    loadPulls();
  }

  async function selectPr(number) {
    const k = key;
    openPr = number;
    pr = null; prFiles = null; openPrFile = null; filesBusy = false;
    seq.files += 1; seq.patch += 1;
    const s = ++seq.pr;
    renderSide();
    renderRight();
    const r = await reach(window.jarvis.ghPull(k, number));
    if (s !== seq.pr || !current(k) || openPr !== number || (r.key && r.key !== k)) return;
    if (r.rate) rate = r.rate;
    pr = r;
    renderSide();
    renderRight();
  }

  async function loadPrFiles(page = 1) {
    const k = key;
    const number = openPr;
    if (!k || !number || filesBusy) return;
    const s = ++seq.files;
    filesBusy = true;
    renderRight();
    const r = await reach(window.jarvis.ghPullFiles(k, number, page));
    if (s !== seq.files || !current(k) || openPr !== number || (r.key && r.key !== k)) return;
    filesBusy = false;
    if (r.rate) rate = r.rate;
    if (!r.ok) prFiles = { page: prFiles?.page || 0, files: prFiles?.files || [], more: !!prFiles?.more, error: r.cancelled ? '' : r.error };
    else prFiles = page > 1 && prFiles ? { ...r, files: prFiles.files.concat(r.files) } : r;
    renderRight();
  }

  async function openPrFileDiff(filePath, { reveal = true } = {}) {
    const k = key;
    const number = openPr;
    openPrFile = filePath;
    const s = ++seq.patch;
    for (const b of $('scDiff').querySelectorAll('.gh-pfile')) b.classList.toggle('on', b.dataset.path === filePath);
    const slot = $('scDiff').querySelector('.gh-pr-diff');
    if (slot) slot.replaceChildren(el('div', 'sc-diff-empty', 'Reading the patch…'));
    const d = await reach(window.jarvis.ghPullPatch(k, number, filePath));
    if (s !== seq.patch || !current(k) || openPr !== number || openPrFile !== filePath) return;
    const target = $('scDiff').querySelector('.gh-pr-diff');
    if (!target) return;
    target.replaceChildren();
    const holder = el('div', 'sc-diff-inline');
    target.appendChild(holder);
    // The one diff renderer in this app - the same one Changes and History use.
    sc.renderDiffInto(holder, d, filePath, { pr: number });
    // The patch sits below the file list; bring it into view when a file was chosen, but
    // not when the panel is merely redrawn.
    if (reveal) holder.scrollIntoView({ block: 'start' });
  }

  /** Workflow runs and checks for one commit. `target` null means this branch's latest on GitHub. */
  async function runCheck(target) {
    const k = key;
    if (!k || !info) return;
    view = 'checks';
    checkTarget = target;
    checkBusy = true;
    checkRes = null;
    const s = ++seq.checks;
    render();
    const sha = target ? target.sha : null;
    const [runs, checks] = await Promise.all([reach(window.jarvis.ghRuns(k, sha)), reach(window.jarvis.ghChecks(k, sha))]);
    if (s !== seq.checks || !current(k)) return;
    checkBusy = false;
    for (const r of [runs, checks]) if (r && r.rate) rate = r.rate;
    checkRes = { runs, checks, at: Date.now() };
    render();
  }

  // ------------------------------------------------------------- links (local, no API)
  function say(text, cls, out) {
    if (out) { out.textContent = text || ''; out.className = 'gh-inline' + (cls ? ` ${cls}` : ''); return; }
    msg = { text: text || '', cls: cls || '' };
    const n = $('scGitHub').querySelector('.gh-msg');
    if (n) { n.textContent = msg.text; n.className = 'gh-msg' + (msg.cls ? ` ${msg.cls}` : ''); }
  }

  async function openLink(which, arg, out) {
    const k = key;
    const r = await reach(window.jarvis.ghOpen(k, which, arg));
    if (!current(k)) return;
    say(r.ok ? '' : (r.error || 'That page is not available.'), r.ok ? '' : 'warn', out);
  }

  async function copyLink(which, arg, out) {
    const k = key;
    const r = await reach(window.jarvis.ghLink(k, which, arg));
    if (!current(k)) return;
    if (!r.ok) { say(r.error || 'That link is not available.', 'warn', out); return; }
    try { await navigator.clipboard.writeText(r.url); say('Link copied.', 'ok', out); } catch { say(r.url, '', out); }
  }

  /** A failed load is retried only when this is pressed - never on its own. */
  function retryBtn(fn) {
    const b = el('button', 'link-btn gh-retry', 'Try again');
    b.type = 'button';
    b.onclick = fn;
    return b;
  }

  /** "Label ↗" opens the page in the browser; "Copy" copies its address. */
  function linkPair(label, which, arg = {}, out = null) {
    const wrap = el('span', `gh-link gh-link-${which}`);
    const open = el('button', 'gh-link-open');
    open.type = 'button';
    open.title = 'Open on GitHub, in your browser';
    open.append(el('span', null, label), JV.icon('external'));
    open.onclick = () => openLink(which, arg, out);
    const copy = el('button', 'gh-link-copy', 'Copy');
    copy.type = 'button';
    copy.title = 'Copy the GitHub link';
    copy.onclick = () => copyLink(which, arg, out);
    wrap.append(open, copy);
    return wrap;
  }

  // ------------------------------------------------------------- the side panel
  function render() {
    renderSide();
    renderRight();
  }

  function renderSide() {
    const box = $('scGitHub');
    box.replaceChildren();
    if (!info) { box.appendChild(el('div', 'sc-note', 'This repository is not on GitHub.')); return; }

    const nav = el('div', 'gh-nav');
    for (const [v, label] of [['pulls', 'Pull requests'], ['checks', 'Checks']]) {
      const b = el('button', `gh-nav-btn gh-nav-${v}` + (view === v ? ' on' : ''), label);
      b.type = 'button';
      b.onclick = () => {
        if (view === v) return;
        view = v;
        render();
        if (v === 'pulls' && !list && !listBusy) loadPulls();
      };
      nav.appendChild(b);
    }
    box.appendChild(nav);

    box.appendChild(el('div', 'gh-repo', `${info.owner}/${info.repo}`));
    const links = el('div', 'gh-links');
    links.append(linkPair('Repository', 'repo'), linkPair('Branch', 'branch'), linkPair('Commit', 'commit'));
    box.appendChild(links);
    box.appendChild(el('div', 'gh-msg' + (msg.cls ? ` ${msg.cls}` : ''), msg.text));

    if (view === 'pulls') sidePulls(box);
    else sideChecks(box);
    box.appendChild(foot());
  }

  function sidePulls(box) {
    const card = el('div', 'gh-card');
    card.appendChild(el('h4', null, 'This branch'));
    if (!list) card.appendChild(el('div', 'gh-note', listBusy ? 'Asking GitHub…' : '—'));
    else if (!list.branch) card.appendChild(el('div', 'gh-note', info.detached ? 'Detached HEAD - no branch.' : '—'));
    else if (list.branch.pulls.length) for (const p of list.branch.pulls) card.appendChild(prRow(p));
    else {
      card.appendChild(el('div', 'gh-note', `No pull request for ${list.branch.name}.`));
      const out = el('em', 'gh-inline');
      const open = el('button', 'btn btn-ghost small gh-new-pr');
      open.type = 'button';
      open.append(JV.icon('external'), el('span', null, 'Open a pull request on GitHub'));
      open.title = 'Opens GitHub\'s page in your browser. You create the pull request there; JARVIS does not.';
      open.onclick = () => openLink('newPull', {}, out);
      card.append(open, out);
    }
    box.appendChild(card);

    const seg = el('div', 'sc-scope gh-state');
    for (const [st, label] of [['open', 'Open'], ['closed', 'Closed']]) {
      const b = el('button', `sc-scope-opt gh-state-${st}` + (prState === st ? ' on' : ''), label);
      b.type = 'button';
      b.onclick = () => setState(st);
      seg.appendChild(b);
    }
    box.appendChild(seg);

    const lst = el('div', 'gh-list');
    if (list) {
      if (!list.list.length) lst.appendChild(el('div', 'sc-note', prState === 'open' ? 'No open pull requests.' : 'No closed pull requests.'));
      for (const p of list.list) lst.appendChild(prRow(p));
    } else if (listBusy) lst.appendChild(el('div', 'sc-note', 'Loading pull requests…'));
    if (listErr) {
      lst.appendChild(el('div', 'sc-note err', listErr));
      lst.appendChild(retryBtn(() => { listBusy = false; loadPulls({ more: !!list }); }));
    }
    if (list && list.more) {
      const more = el('button', 'btn btn-ghost small gh-more', listBusy ? 'Loading…' : 'Load more');
      more.type = 'button';
      more.disabled = listBusy;
      more.onclick = () => loadPulls({ more: true });
      lst.appendChild(more);
    }
    box.appendChild(lst);
  }

  function prRow(p) {
    const row = el('button', 'sc-commit-row gh-pr-row' + (p.number === openPr ? ' on' : ''));
    row.type = 'button';
    const top = el('span', 'sc-commit-top');
    top.appendChild(el('b', null, p.title));
    row.appendChild(top);
    const meta = el('span', 'sc-commit-meta');
    meta.appendChild(el('code', null, `#${p.number}`));
    meta.appendChild(el('small', null, p.author));
    meta.appendChild(el('small', 'gh-branches', `${p.base || '?'} ← ${p.head || '?'}`));
    meta.appendChild(el('small', 'sc-when', ago(p.updated)));
    row.appendChild(meta);
    const tags = el('span', 'gh-tags');
    if (p.state && p.state !== 'OPEN') tags.appendChild(pill(PR_STATE[p.state]));
    if (p.draft) tags.appendChild(el('em', 'sc-pill muted', 'Draft'));
    if (p.review) tags.appendChild(pill(REVIEW[p.review]));
    if (p.checks) tags.appendChild(pill(ROLLUP[p.checks]));
    if (tags.childNodes.length) row.appendChild(tags);
    row.onclick = () => selectPr(p.number);
    return row;
  }

  function sideChecks(box) {
    const card = el('div', 'gh-card');
    card.appendChild(el('h4', null, 'Workflow runs and checks'));
    card.appendChild(el('div', 'gh-target', checkTarget ? `For ${checkTarget.label}` : 'For this branch\'s latest commit on GitHub'));
    const btn = el('button', 'btn btn-primary small gh-check-btn');
    btn.type = 'button';
    btn.append(JV.icon('refresh'), el('span', null, checkBusy ? 'Asking GitHub…' : 'Check workflow runs'));
    btn.disabled = checkBusy;
    btn.classList.toggle('reloading', checkBusy); // the icon turns while GitHub is asked
    btn.onclick = () => runCheck(checkTarget);
    card.appendChild(btn);
    if (checkTarget) {
      const back = el('button', 'link-btn gh-use-branch', 'Use this branch instead');
      back.type = 'button';
      back.onclick = () => { checkTarget = null; checkRes = null; seq.checks += 1; checkBusy = false; render(); };
      card.appendChild(back);
    }
    card.appendChild(el('div', 'gh-note', 'GitHub is asked only when you press this - never after a push on its own, and never on a timer.'));
    box.appendChild(card);
  }

  function foot() {
    const f = el('div', 'gh-foot');
    if (view === 'pulls' && list) {
      const line = el('div', 'gh-foot-line');
      line.appendChild(el('span', null, `Loaded ${clock(list.loadedAt)}`));
      const rf = el('button', 'link-btn gh-refresh', 'Refresh');
      rf.type = 'button';
      rf.disabled = listBusy;
      rf.onclick = () => { list = null; listBusy = false; seq.list += 1; loadPulls(); };
      line.appendChild(rf);
      f.appendChild(line);
    }
    if (list && list.viewer) f.appendChild(el('div', null, `Signed in as ${list.viewer}, through Git Credential Manager`));
    if (rate && Number.isFinite(rate.remaining) && Number.isFinite(rate.limit)) {
      const low = rate.limit > 0 && rate.remaining < rate.limit * 0.1;
      f.appendChild(el('div', low ? 'warn' : null, `GitHub requests left this hour: ${rate.remaining.toLocaleString()} of ${rate.limit.toLocaleString()}`));
    }
    return f;
  }

  // ------------------------------------------------------------- the right-hand pane
  function renderRight() {
    if (sc.tab() !== 'github') return;
    const box = $('scDiff');
    box.replaceChildren();
    if (!info) return;
    if (view === 'checks') { renderChecks(box); return; }
    if (!openPr) {
      box.appendChild(el('div', 'sc-diff-empty', listBusy && !list ? 'Asking GitHub…'
        : list && (list.list.length || list.branch?.pulls?.length) ? 'Pick a pull request to see it.' : 'Pull requests for this repository appear here.'));
      return;
    }
    renderPr(box);
  }

  function renderPr(box) {
    if (!pr) { box.appendChild(el('div', 'sc-diff-empty', 'Reading the pull request…')); return; }
    if (!pr.ok) {
      const fail = el('div', 'sc-diff-empty err', pr.cancelled ? 'Stopped.' : (pr.error || 'GitHub did not answer.'));
      fail.appendChild(el('br'));
      fail.appendChild(retryBtn(() => selectPr(openPr)));
      box.appendChild(fail);
      return;
    }
    const p = pr.pull;

    const head = el('header', 'sc-commit-head gh-pr-head');
    const h = el('h3', null, p.title);
    h.appendChild(el('code', 'gh-num', ` #${p.number}`));
    head.appendChild(h);
    const tags = el('div', 'gh-pills');
    tags.appendChild(pill(PR_STATE[p.state]));
    if (p.draft) tags.appendChild(el('em', 'sc-pill muted', 'Draft'));
    if (p.review) tags.appendChild(pill(REVIEW[p.review]));
    if (p.checks) tags.appendChild(pill(ROLLUP[p.checks]));
    if (p.state === 'OPEN' && p.mergeable) tags.appendChild(pill(MERGE[p.mergeable]));
    head.appendChild(tags);

    const rows = el('div', 'sc-rows');
    const row = (label, value) => {
      const r = el('div', 'sc-row');
      r.appendChild(el('span', null, label));
      r.appendChild(el('b', null, value));
      rows.appendChild(r);
    };
    row('Author', p.author);
    row('Branches', `${p.base || '?'} ← ${p.head || '?'}`);
    row('Opened', stamp(p.created));
    row('Updated', stamp(p.updated));
    if (p.merged) row('Merged', stamp(p.merged));
    else if (p.closed) row('Closed', stamp(p.closed));
    const changes = [p.files != null ? `${p.files} file${p.files === 1 ? '' : 's'}` : null,
      p.additions != null ? `+${p.additions} −${p.deletions ?? 0}` : null,
      p.commits != null ? `${p.commits} commit${p.commits === 1 ? '' : 's'}` : null].filter(Boolean).join(', ');
    if (changes) row('Changes', changes);
    if (p.reviews.length) row('Reviews', p.reviews.map((v) => `${v.author} ${REVIEWED[v.state] || v.state.toLowerCase()}`).join(', '));
    if (p.requested.length) row('Requested', p.requested.join(', '));
    head.appendChild(rows);

    const acts = el('div', 'gh-actions');
    const out = el('em', 'gh-inline');
    acts.appendChild(linkPair('Open on GitHub', 'pull', { number: p.number }, out));
    if (p.headSha) {
      const c = el('button', 'btn btn-ghost small gh-pr-checks', 'Check this pull request');
      c.type = 'button';
      c.title = 'Ask GitHub for the workflow runs and checks on this pull request\'s latest commit';
      c.onclick = () => runCheck({ sha: p.headSha, label: `#${p.number} at ${p.headSha.slice(0, 7)}` });
      acts.appendChild(c);
    }
    acts.appendChild(out);
    head.appendChild(acts);
    box.appendChild(head);

    const body = el('div', 'gh-body');
    if (p.body && p.body.trim()) {
      JV.renderMarkdown(body, p.body);
      // The content policy has already refused to load them; say what was there instead.
      for (const img of body.querySelectorAll('img')) {
        const alt = (img.getAttribute('alt') || '').trim();
        img.replaceWith(el('span', 'gh-img', alt ? `[image: ${alt.slice(0, 80)}]` : '[image]'));
      }
    } else body.appendChild(el('div', 'gh-note', 'No description.'));
    box.appendChild(body);

    const filesBox = el('div', 'sc-commit-files gh-pr-files');
    if (!prFiles) {
      const b = el('button', 'btn btn-ghost small gh-files-btn', filesBusy ? 'Loading changed files…'
        : `Changed files${p.files != null ? ` (${p.files})` : ''}`);
      b.type = 'button';
      b.disabled = filesBusy;
      b.onclick = () => loadPrFiles(1);
      filesBox.appendChild(b);
    } else {
      for (const f of prFiles.files) {
        const [letter, cls] = MARK[f.status] || MARK.modified;
        const r = el('button', `sc-file sc-cfile gh-pfile ${cls}` + (f.path === openPrFile ? ' on' : ''));
        r.type = 'button';
        r.dataset.path = f.path;
        r.title = f.from ? `${f.from} → ${f.path}` : f.path;
        r.appendChild(el('i', 'sc-mark', letter));
        r.appendChild(JV.path.render(el('span', 'sc-file-name'), f.path));
        const n = el('span', 'sc-commit-counts');
        if (!f.hasPatch) n.appendChild(el('em', 'side', 'no patch'));
        if (f.added) n.appendChild(el('em', 'plus', `+${f.added}`));
        if (f.removed) n.appendChild(el('em', 'minus', `−${f.removed}`));
        r.appendChild(n);
        r.onclick = () => openPrFileDiff(f.path);
        filesBox.appendChild(r);
      }
      if (prFiles.error) {
        filesBox.appendChild(el('div', 'sc-note err', prFiles.error));
        filesBox.appendChild(retryBtn(() => loadPrFiles(prFiles.files.length ? (prFiles.page || 0) + 1 : 1)));
      }
      if (prFiles.more) {
        const more = el('button', 'btn btn-ghost small gh-files-more', filesBusy ? 'Loading…' : 'Load more files');
        more.type = 'button';
        more.disabled = filesBusy;
        more.onclick = () => loadPrFiles((prFiles.page || 1) + 1);
        filesBox.appendChild(more);
      }
    }
    box.appendChild(filesBox);
    box.appendChild(el('div', 'gh-pr-diff'));
    // The patch comes from main's copy of the listing, so re-showing it costs no request.
    if (openPrFile && prFiles) openPrFileDiff(openPrFile, { reveal: false });
  }

  function renderChecks(box) {
    const head = el('header', 'sc-commit-head');
    head.appendChild(el('h3', null, 'Workflow runs and checks'));
    if (!checkRes) {
      head.appendChild(el('p', 'gh-note', checkBusy ? 'Asking GitHub…'
        : 'Press "Check workflow runs" to ask GitHub. Nothing is asked until you do.'));
      box.appendChild(head);
      return;
    }
    const t = checkRes.runs?.target || checkRes.checks?.target;
    if (t) head.appendChild(el('div', 'gh-target', `Commit ${t.label}`));
    if (t && t.note) head.appendChild(el('div', 'gh-note', t.note));
    head.appendChild(el('div', 'gh-note', `Asked GitHub at ${clock(checkRes.at)}. Press Check again for newer results - JARVIS does not poll.`));
    const acts = el('div', 'gh-actions');
    const out = el('em', 'gh-inline');
    acts.append(linkPair('Actions on GitHub', 'actions', {}, out), out);
    head.appendChild(acts);
    box.appendChild(head);

    const R = checkRes.runs;
    const runsBox = el('section', 'gh-section');
    runsBox.appendChild(el('h4', null, 'Workflow runs'));
    if (!R.ok) runsBox.appendChild(el('div', 'sc-note err', R.cancelled ? 'Stopped.' : (R.error || 'GitHub did not answer.')));
    else if (!R.list.length) runsBox.appendChild(el('div', 'sc-note', 'No workflow runs for this commit.'));
    else {
      for (const x of R.list) runsBox.appendChild(runRow(x));
      if (R.list.some((x) => x.status === 'queued')) {
        runsBox.appendChild(el('div', 'gh-note warn', 'A run that stays queued on a self-hosted runner can mean the runner is offline.'));
      }
    }
    box.appendChild(runsBox);

    const C = checkRes.checks;
    const checksBox = el('section', 'gh-section');
    const h4 = el('h4', null, 'Checks ');
    if (C.ok && C.state) h4.appendChild(pill(ROLLUP[C.state]));
    checksBox.appendChild(h4);
    if (!C.ok) checksBox.appendChild(el('div', 'sc-note err', C.cancelled ? 'Stopped.' : (C.error || 'GitHub did not answer.')));
    else if (C.missing) checksBox.appendChild(el('div', 'sc-note', 'GitHub does not have this commit yet.'));
    else if (!C.list.length) checksBox.appendChild(el('div', 'sc-note', 'No checks reported for this commit.'));
    else for (const c of C.list) checksBox.appendChild(checkRow(c));
    box.appendChild(checksBox);
  }

  function runRow(x) {
    const st = runState(x.status, x.conclusion);
    const row = el('button', 'gh-run');
    row.type = 'button';
    row.title = 'Open this run on GitHub';
    row.appendChild(el('i', `gh-run-icon ${st.cls}`, st.icon));
    const main = el('span', 'gh-run-main');
    main.appendChild(el('b', null, x.workflow));
    if (x.title) main.appendChild(el('small', null, x.title));
    main.appendChild(el('small', null, [st.text, x.event, x.branch, x.sha ? x.sha.slice(0, 7) : null,
      x.number ? `run ${x.number}${x.attempt > 1 ? `, attempt ${x.attempt}` : ''}` : null].filter(Boolean).join(' · ')));
    row.appendChild(main);
    const tm = el('span', 'gh-run-time');
    tm.appendChild(el('span', null, `Started ${stamp(x.started || x.created)}`));
    if (x.status === 'completed') {
      const took = duration(x.started || x.created, x.updated);
      tm.appendChild(el('span', null, `Finished ${stamp(x.updated)}${took ? ` · ${took}` : ''}`));
    }
    row.appendChild(tm);
    const out = el('em', 'gh-inline');
    row.onclick = () => openLink('run', { id: x.id }, out);
    main.appendChild(out);
    return row;
  }

  function checkRow(c) {
    const st = runState(c.status, c.conclusion);
    const row = el(c.kind === 'check' && c.id ? 'button' : 'div', 'gh-run');
    if (row.tagName === 'BUTTON') { row.type = 'button'; row.title = 'Open this check on GitHub'; }
    row.appendChild(el('i', `gh-run-icon ${st.cls}`, st.icon));
    const main = el('span', 'gh-run-main');
    main.appendChild(el('b', null, c.name));
    main.appendChild(el('small', null, [st.text, c.workflow, c.description].filter(Boolean).join(' · ')));
    row.appendChild(main);
    const tm = el('span', 'gh-run-time');
    if (c.started) tm.appendChild(el('span', null, `Started ${stamp(c.started)}`));
    if (c.completed) {
      const took = duration(c.started, c.completed);
      tm.appendChild(el('span', null, `Finished ${stamp(c.completed)}${took ? ` · ${took}` : ''}`));
    }
    row.appendChild(tm);
    if (row.tagName === 'BUTTON') {
      const out = el('em', 'gh-inline');
      row.onclick = () => openLink('checkRun', { id: c.id }, out);
      main.appendChild(out);
    }
    return row;
  }

  // ------------------------------------------------------------- links in the git tabs
  // The places git.js offers. Each adds a link only for a repository on GitHub, and each link
  // is built in main from local refs when pressed - no API call, nothing loaded in advance.
  sc.decorateDiffHead = (meta, ctx) => {
    if (!info || !current(key) || !ctx) return;
    let which = null;
    let arg = null;
    if (ctx.side === 'pr' && ctx.pr) { which = 'pullFile'; arg = { number: ctx.pr, path: ctx.path }; }
    else if (ctx.side === 'commit' && ctx.sha) { which = 'file'; arg = { path: ctx.path, sha: ctx.sha }; }
    else if (ctx.side === 'index' || ctx.side === 'worktree') { which = 'file'; arg = { path: ctx.path }; }
    if (!which) return;
    const out = el('em', 'gh-inline');
    meta.append(linkPair('GitHub', which, arg, out), out);
  };

  sc.decorateCommit = (head, c) => {
    if (!info || !current(key) || !c || !c.sha) return;
    const rowEl = el('div', 'gh-commit-links');
    const out = el('em', 'gh-inline');
    rowEl.appendChild(linkPair('View on GitHub', 'commit', { sha: c.sha }, out));
    const chk = el('button', 'btn btn-ghost small gh-commit-check', 'Check workflow runs');
    chk.type = 'button';
    chk.title = 'Ask GitHub about this commit\'s workflow runs and checks';
    chk.onclick = () => { view = 'checks'; sc.setTab('github'); runCheck({ sha: c.sha, label: `commit ${c.sha.slice(0, 7)}` }); };
    rowEl.append(chk, out);
    head.appendChild(rowEl);
  };

  // After a push or publish: OFFER the check. Pressing it is the user's decision.
  sc.afterRemote = (op, k) => {
    if (!info || !current(k) || (op !== 'push' && op !== 'publish')) return;
    const n = $('scRemoteMsg');
    const b = el('button', 'link-btn gh-after-push', 'Check workflow runs');
    b.type = 'button';
    b.title = 'Ask GitHub now. JARVIS never checks on its own after a push.';
    b.onclick = () => { view = 'checks'; sc.setTab('github'); runCheck(null); };
    n.append(document.createTextNode(' '), b);
  };
})();
