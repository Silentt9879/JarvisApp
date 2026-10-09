/* JARVIS window - Source Control.
   GitHub Desktop's workflow and information architecture, in the JARVIS design language:
   repository and branch in the header with one state-dependent remote action, Changes
   beside a diff, the commit box beneath.

   Phase 1 gave repository detection and status. Phase 2 adds the changed-file list and the
   unified diff. Both are local git; nothing here costs a model token, and nothing here
   contacts a remote - the remote action is inert until Phase 5, and its label comes from
   remote-tracking refs we already have, never from reaching out to find out.

   The active repository is a KEY, never a path. Every request carries it, every reply is
   checked against it, and a reply for a repository you have since left is dropped. */
(() => {
  'use strict';
  const { $, el, state } = JV;

  const SELECTED = 'jarvis.sourceRepo';
  let repos = [];
  let active = null;
  let detail = null;
  let files = [];
  let openFile = null;
  let seqDetail = 0;
  let seqFiles = 0;
  let seqDiff = 0;

  const MARK = {
    added: ['A', 'added'], modified: ['M', 'modified'], deleted: ['D', 'deleted'],
    renamed: ['R', 'renamed'], copied: ['C', 'copied'], typechange: ['T', 'modified'],
    untracked: ['U', 'untracked'], conflicted: ['!', 'conflicted'],
  };

  // ------------------------------------------------------------- repository picker
  function renderPicker() {
    const pop = $('scRepoPop');
    pop.replaceChildren();
    for (const scope of ['workspace', 'app']) {
      const group = repos.filter((r) => r.scope === scope);
      if (!group.length) continue;
      pop.appendChild(el('h4', 'sc-group', scope === 'app' ? 'This app' : 'Workspace'));
      for (const r of group) {
        const row = el('button', 'sc-item' + (r.key === active ? ' on' : ''));
        row.type = 'button';
        const top = el('span', 'sc-item-top');
        top.appendChild(el('b', null, r.nickname));
        if (!r.ok) top.appendChild(el('em', 'sc-pill err', 'unreadable'));
        else if (r.clean) top.appendChild(el('em', 'sc-pill ok', 'clean'));
        else {
          const n = (r.staged || 0) + (r.modified || 0) + (r.untracked || 0);
          top.appendChild(el('em', 'sc-pill dirty', `${n} change${n === 1 ? '' : 's'}`));
        }
        row.appendChild(top);
        const sub = el('span', 'sc-item-sub');
        sub.appendChild(el('i', 'sc-sub-branch', r.branch || '—'));
        if (r.ahead) sub.appendChild(el('i', 'ahead', `↑${r.ahead}`));
        if (r.behind) sub.appendChild(el('i', 'behind', `↓${r.behind}`));
        row.appendChild(sub);
        row.onclick = () => { pop.hidden = true; select(r.key); };
        pop.appendChild(row);
      }
    }
  }

  /**
   * The remote action: one button whose label is the thing you would do next.
   *
   * The label is derived ONLY from refs already on disk. Working out what to call this
   * button must never itself be a reason to contact a remote, so "Push 2 commits" means
   * "two commits ahead of what we last heard", not "two commits ahead right now".
   */
  let remoteOp = 'idle';
  /**
   * True only between this window starting an operation and getting its answer.
   *
   * Progress arrives as events; the answer arrives as the reply to the window's own call. The
   * two travel separately and can cross - a progress line sent just before the answer often
   * lands just after it. That line used to switch the button back to "Fetching…" with nothing
   * running; the "idle" event behind it was ignored; and pressing Stop then showed "Stopping…"
   * for ever, because there was nothing to stop and so no answer left to clear it.
   * So a busy state is believed only while this is true.
   */
  let remoteLive = false;

  /** "just now", "3 minutes ago", "2 days ago" - for times read from disk. */
  function ago(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return 'just now';
    const unit = (n, word) => `${n} ${word}${n === 1 ? '' : 's'} ago`;
    const m = Math.round(s / 60);
    if (m < 60) return unit(m, 'minute');
    const h = Math.round(m / 60);
    if (h < 24) return unit(h, 'hour');
    return unit(Math.round(h / 24), 'day');
  }

  /**
   * GitHub Desktop's wording: "Pull origin" with the counts beside it and "Last fetched 3
   * minutes ago" beneath. The time is FETCH_HEAD's on disk, the counts are from the last
   * fetch - still no network call to work out a label.
   */
  function remoteAction(d) {
    if (!d || !d.ok) return null;
    if (d.detachedHead) return null;
    const remote = (d.upstream || '').split('/')[0] || d.remotes?.[0]?.name || 'origin';
    const fetched = d.lastFetched ? `Last fetched ${ago(d.lastFetched)}` : 'Never fetched';
    const count = [d.ahead ? `${d.ahead} ↑` : '', d.behind ? `${d.behind} ↓` : ''].filter(Boolean).join('  ');
    const stored = 'From the last fetch stored here, not a live check.';
    if (!d.upstream) return { op: 'publish', label: 'Publish branch', sub: `Publish this branch to ${remote}`, count: '', hint: 'Push this branch and set its upstream. Nothing is published until you press this.' };
    if (d.behind) return { op: 'pull', label: `Pull ${remote}`, sub: fetched, count, hint: `${d.behind} commit${d.behind === 1 ? '' : 's'} to pull. ${stored}` };
    if (d.ahead) return { op: 'push', label: `Push ${remote}`, sub: fetched, count, hint: `${d.ahead} commit${d.ahead === 1 ? '' : 's'} to push. ${stored}` };
    return { op: 'fetch', label: `Fetch ${remote}`, sub: fetched, count: '', hint: 'Ask the remote what has changed. This is the only thing here that uses the network.' };
  }

  function renderRemote(d) {
    const btn = $('scRemoteBtn');
    const label = $('scRemoteLabel');
    const sub = $('scRemoteSub');
    const stop = $('scRemoteStop');
    const showCount = (text) => {
      $('scRemoteCount').textContent = text || '';
      $('scRemoteCount').hidden = !text;
      btn.classList.toggle('has-count', !!text);
    };

    if (remoteOp !== 'idle') {
      const verb = { fetching: 'Fetching', pulling: 'Pulling', pushing: 'Pushing', publishing: 'Publishing', cancelling: 'Stopping' }[remoteOp] || 'Working';
      label.textContent = `${verb}…`;
      showCount('');
      btn.disabled = true;
      btn.classList.add('busy');
      stop.hidden = remoteOp === 'cancelling';
      return;
    }
    btn.classList.remove('busy');
    stop.hidden = true;

    const act = remoteAction(d);
    if (!act) {
      label.textContent = d?.detached ? 'No branch' : '—';
      sub.textContent = '';
      showCount('');
      btn.disabled = true;
      btn.title = d?.detached ? 'You are on a detached HEAD. Create or switch to a branch first.' : '';
      return;
    }
    label.textContent = act.label;
    sub.textContent = act.sub || '';
    showCount(act.count);
    btn.disabled = busy;
    btn.title = act.hint;
    btn.dataset.op = act.op;
  }

  const remoteSay = (text, cls) => {
    const n = $('scRemoteMsg');
    n.textContent = text || '';
    n.className = 'sc-remote-msg' + (cls ? ' ' + cls : '');
  };

  /** The one place a network operation can begin, and only from a click. */
  async function runRemote(op) {
    if (!active || remoteOp !== 'idle') return;
    const key = active;                       // captured once; the result is checked against it
    remoteOp = { fetch: 'fetching', pull: 'pulling', push: 'pushing', publish: 'publishing' }[op];
    remoteLive = true;
    renderRemote(detail);
    remoteSay(`${{ fetch: 'Fetching', pull: 'Pulling', push: 'Pushing', publish: 'Publishing' }[op]}…`, 'live');

    let r;
    try {
      r = await ({
        fetch: () => window.jarvis.gitFetch(key),
        pull: () => window.jarvis.gitPull(key),
        push: () => window.jarvis.gitPush(key),
        publish: () => window.jarvis.gitPublish(key),
      })[op]();
    } catch { r = { ok: false, key, error: 'Git could not be reached.' }; }

    // The answer is in: from here no event can make the button busy again (see remoteLive).
    remoteLive = false;
    remoteOp = 'idle';

    // The operation belongs to the repository it started for. If the window has moved on,
    // the result is reported nowhere rather than applied to whatever is selected now.
    if (r?.key && r.key !== active) { renderRemote(detail); return; }

    if (!r || !r.ok) {
      if (r?.cancelled) remoteSay(r.error, 'warn');
      else if (r?.busy) remoteSay(r.error, 'warn');
      else remoteSay(r?.error || 'That did not work.', 'err');
      renderRemote(detail);
      return;
    }

    remoteSay(r.message || 'Done.', 'ok');
    if (JV.sc.afterRemote) JV.sc.afterRemote(op, key);
    if (r.branches?.ok) branches = r.branches;
    renderBranches();
    await Promise.all([loadDetail(active), loadFiles(active)]);
    if (tab === 'history') loadHistory(active, { reset: true }); else history = [];
  }

  /** Back to rest, whatever the button was showing. */
  function settleRemote(text, cls) {
    remoteLive = false;
    remoteOp = 'idle';
    renderRemote(detail);
    if (text) remoteSay(text, cls);
  }

  /**
   * Ask the app what is really running for this repository, and stop showing work that is
   * not there. Local only: it reads the app's own record and contacts no remote.
   */
  async function reconcileRemote(key = active) {
    if (!key || remoteOp === 'idle') return;
    const was = remoteOp;
    let s = null;
    try { s = await window.jarvis.gitRemoteState(key); } catch { return; }
    if (key !== active || remoteOp === 'idle') return;
    if (s?.ok && s.state === 'idle') settleRemote(was === 'cancelling' ? 'Stopped.' : 'Nothing is running for this repository.', 'warn');
  }

  async function stopRemote() {
    if (!active || remoteOp === 'idle') return;
    const key = active;
    remoteOp = 'cancelling';
    renderRemote(detail);
    let r = null;
    try { r = await window.jarvis.gitRemoteCancel(key); } catch { /* it may have just finished */ }
    if (!remoteLive) {
      // Nothing of this window's is running, so no answer is on its way to clear "Stopping…".
      if (remoteOp === 'cancelling') settleRemote(r?.ok ? 'Stopped.' : 'Nothing was running, so there was nothing to stop.', 'warn');
      return;
    }
    // The operation's own answer normally follows at once and clears the button. If it does
    // not, ask what is really running rather than wait for ever.
    setTimeout(() => reconcileRemote(key), 6000);
  }

  // ------------------------------------------------------------- selection
  function select(key) {
    active = key;
    try { localStorage.setItem(SELECTED, key); } catch { /* storage off */ }
    JV.emit('sc_select', key);

    // Clear everything at once: no panel may show the previous repository's content.
    files = [];
    openFile = null;
    detail = null;
    $('scEmpty').hidden = true;
    $('scWork').hidden = false;
    $('scRepoName').textContent = repos.find((r) => r.key === key)?.nickname || key;
    $('scBranchName').textContent = '…';
    $('scRemoteLabel').textContent = '…';
    $('scRemoteSub').textContent = '';
    $('scRemoteCount').hidden = true;
    // The last commit, the right-click menu and a pending discard all belong to the
    // repository that was open.
    last = null;
    renderUndo();
    closeFilesMenu();
    closeDiscard();
    $('scFiles').replaceChildren(el('div', 'sc-note', 'Reading…'));
    $('scDiff').replaceChildren();
    $('scChangeCount').textContent = '';
    // The commit box belongs to the repository that was open; it does not follow you.
    $('scSummary').value = '';
    $('scDescription').value = '';
    say('');
    branches = null;
    filter = '';
    renaming = null;
    remoteSay('');
    // An assistance answer belongs to the repository it was asked about. Stop it, so it
    // spends nothing more, and remove its panel so nothing of it shows here.
    if (assistBusy) { window.jarvis.gitAssistCancel(String(assistId)); }
    assistId += 1;
    assistBusy = false;
    $('scAssist')?.remove();
    aiScope = 'staged';   // the scope choice belongs to the repository it was made in
    history = [];
    histDone = false;
    histSearch = '';
    stashes = [];
    openStash = null;
    openStashFile = null;
    conflicts = null;
    stashSay('');
    $('scStashList').replaceChildren();
    $('scStashCount').textContent = '';
    openCommit = null;
    openCommitFile = null;
    $('scHistSearch').value = '';
    $('scHistList').replaceChildren();
    setTab('changes');
    $('scBranchSearch').value = '';
    $('scBranchList').replaceChildren();
    branchSay('');
    openNewBranch(false);
    syncCommitButton();
    renderPicker();

    loadDetail(key);
    loadFiles(key);
    loadBranches(key);
    loadStashes(key);
    loadConflicts(key);
  }

  async function loadDetail(key) {
    const seq = ++seqDetail;
    let d;
    try { d = await window.jarvis.gitDetail(key); } catch { d = { ok: false, error: 'Git could not be reached.' }; }
    if (seq !== seqDetail || key !== active) return;
    if (d.ok && d.repo?.key !== key) return;
    detail = d;
    $('scBranchName').textContent = d.ok ? (d.branch || '(no branch)') : '—';
    renderRemote(d);
    syncCommitButton();
    loadLastCommit(key);
  }

  // ------------------------------------------------------------- changed files
  async function loadFiles(key) {
    const seq = ++seqFiles;
    let r;
    try { r = await window.jarvis.gitChanges(key); } catch { r = { ok: false, error: 'Git could not be reached.' }; }
    if (seq !== seqFiles || key !== active) return;
    if (r.ok && r.repo?.key !== key) return;

    if (!r.ok) {
      $('scFiles').replaceChildren(el('div', 'sc-note err', r.error || 'Could not read the changes.'));
      return;
    }
    files = r.files;
    $('scChangeCount').textContent = r.counts.total || '';
    renderFiles(r.counts);
    renderConflictBanner();
    syncCommitButton();

    // Open the first file so the panel is never blank when there is something to show.
    if (files.length) openDiff(files[0].path);
    else $('scDiff').replaceChildren(el('div', 'sc-diff-empty', 'No changes in this repository.'));
  }

  /**
   * The checkbox state IS git's index, re-read after every mutation - there is no
   * selection of our own kept alongside it. Checked means fully staged, indeterminate
   * means part of this file is staged and part is not, which is a real state git can be
   * in and must not be flattened into a lie either way.
   */
  function renderFiles(counts) {
    const box = $('scFiles');
    box.replaceChildren();

    if (!files.length) {
      box.appendChild(el('div', 'sc-note', 'No changed files.'));
      return;
    }

    const head = el('div', 'sc-files-head');

    const all = el('label', 'sc-check-all');
    const allBox = el('input');
    allBox.type = 'checkbox';
    allBox.checked = counts.staged > 0 && counts.staged === counts.total;
    allBox.indeterminate = counts.staged > 0 && counts.staged < counts.total;
    allBox.disabled = busy;
    allBox.onchange = () => (allBox.checked ? mutate('stageAll') : mutate('unstageAll'));
    all.appendChild(allBox);
    all.appendChild(el('b', null, `${counts.total} changed file${counts.total === 1 ? '' : 's'}`));
    head.appendChild(all);
    // Right-click, as in GitHub Desktop: Discard all changes… / Stash all changes. The
    // context-menu key (clientX/Y of 0) opens it at the header instead of the corner.
    head.title = 'Right-click for Discard all changes… or Stash all changes';
    head.oncontextmenu = (e) => {
      e.preventDefault();
      const r = head.getBoundingClientRect();
      const fromKey = !e.clientX && !e.clientY;
      openFilesMenu(fromKey ? r.left + 12 : e.clientX, fromKey ? r.bottom : e.clientY);
    };

    const tags = el('span', 'sc-files-tags');
    if (counts.staged) tags.appendChild(el('em', 'sc-pill ok', `${counts.staged} staged`));
    if (counts.untracked) tags.appendChild(el('em', 'sc-pill new', `${counts.untracked} new`));
    if (counts.conflicted) tags.appendChild(el('em', 'sc-pill err', `${counts.conflicted} conflicted`));
    head.appendChild(tags);
    box.appendChild(head);

    // JARVIS actions for the whole working set. Secondary styling, and nothing fires
    // unless one of them is pressed.
    //
    // When there are staged AND unstaged/untracked changes, the scope is a visible choice.
    // Staged is the default, but without the choice "Check for problems" could answer
    // "nothing suspicious" while an untracked file holding a secret sat in this very list.
    const mixedScope = counts.staged > 0 && counts.staged < counts.total;
    if (!mixedScope) aiScope = counts.staged ? 'staged' : 'all';
    if (mixedScope) {
      const seg = el('div', 'sc-scope');
      seg.appendChild(el('span', null, 'JARVIS looks at'));
      for (const [val, label] of [['staged', `staged (${counts.staged})`], ['all', `all changes (${counts.total})`]]) {
        const b = el('button', 'sc-scope-opt' + (aiScope === val ? ' on' : '') + ` sc-scope-${val}`);
        b.type = 'button';
        b.textContent = label;
        b.onclick = () => { aiScope = val; renderFiles(counts); };
        seg.appendChild(b);
      }
      box.appendChild(seg);
    }
    const ai = el('div', 'sc-ai-row');
    ai.appendChild(aiBtn('Review changes', 'reviewChanges', { scope: aiScope }));
    ai.appendChild(aiBtn('Check for problems', 'suspicious', { scope: aiScope }));
    ai.appendChild(aiBtn('Suggest case', 'suggestCase', { scope: aiScope }));
    box.appendChild(ai);

    for (const f of files) {
      const [letter, cls] = MARK[f.status] || ['M', 'modified'];
      const mixed = f.staged && f.unstaged;
      const row = el('div', `sc-file ${cls}` + (f.path === openFile ? ' on' : '') + (mixed ? ' mixed' : ''));
      row.title = f.renamedFrom ? `${f.renamedFrom} → ${f.path}` : f.path;

      const cb = el('input', 'sc-check');
      cb.type = 'checkbox';
      cb.checked = f.staged;
      cb.indeterminate = mixed;
      cb.disabled = busy || f.conflicted;
      cb.title = f.conflicted ? 'Resolve the conflict before staging this file'
        : mixed ? 'Part of this file is staged. Unchecking unstages all of it.'
          : f.staged ? 'Staged - will be included in the commit' : 'Not staged';
      cb.onclick = (e) => e.stopPropagation();
      cb.onchange = () => mutate(f.staged ? 'unstage' : 'stage', [f.path]);
      row.appendChild(cb);

      row.appendChild(el('i', 'sc-mark', letter));

      const name = el('button', 'sc-file-name');
      name.type = 'button';
      JV.path.render(name, f.path);
      name.onclick = () => (f.conflicted ? showConflict(f.path) : openDiff(f.path));
      row.appendChild(name);

      if (mixed) row.appendChild(el('em', 'sc-dot part', 'partly staged'));
      box.appendChild(row);
    }
  }

  // ------------------------------------------------------------- staging and committing
  let busy = false;

  const countsOf = () => ({
    total: files.length,
    staged: files.filter((f) => f.staged).length,
    unstaged: files.filter((f) => f.unstaged).length,
    untracked: files.filter((f) => f.untracked).length,
    conflicted: files.filter((f) => f.conflicted).length,
  });

  /** Every mutation goes through here, and every one is followed by re-reading git. */
  async function mutate(op, paths) {
    if (busy || !active) return;
    busy = true;
    renderFiles(countsOf());
    say('');

    const key = active;
    let r;
    try {
      if (op === 'stage') r = await window.jarvis.gitStage(key, paths);
      else if (op === 'unstage') r = await window.jarvis.gitUnstage(key, paths);
      else if (op === 'stageAll') r = await window.jarvis.gitStageAll(key);
      else if (op === 'unstageAll') r = await window.jarvis.gitUnstageAll(key);
    } catch { r = { ok: false, error: 'Git could not be reached.' }; }

    busy = false;
    if (key !== active) return;                       // the repository was switched meanwhile
    if (!r || !r.ok) { say(r?.error || 'That did not work.', true); await loadFiles(key); return; }

    files = r.files;
    $('scChangeCount').textContent = r.counts.total || '';
    renderFiles(r.counts);
    syncCommitButton();
    if (openFile && !files.some((f) => f.path === openFile)) {
      openFile = null;
      $('scDiff').replaceChildren(el('div', 'sc-diff-empty', 'That file has no remaining changes.'));
    } else if (openFile) openDiff(openFile);
  }

  const say = (text, bad) => {
    const n = $('scCommitMsg');
    n.textContent = text || '';
    n.className = 'sc-commit-msg' + (bad ? ' err' : text ? ' ok' : '');
  };

  function syncCommitButton() {
    const btn = $('scCommitBtn');
    const c = countsOf();
    const branch = detail?.ok ? (detail.branch || null) : null;
    const summary = $('scSummary').value.trim();

    btn.textContent = branch ? `Commit to ${branch}` : 'Commit';
    const why = c.conflicted ? 'Resolve the conflicts first'
      : !c.staged ? 'Stage something to commit'
        : !summary ? 'A summary is required'
          : !branch ? 'No branch - this repository is in a detached HEAD state' : '';
    btn.disabled = busy || !!why;
    btn.title = why || `Commit ${c.staged} staged file${c.staged === 1 ? '' : 's'} to ${branch}`;
  }

  async function doCommit(e) {
    e.preventDefault();
    if (busy || !active) return;
    const key = active;
    const summary = $('scSummary').value.trim();
    const description = $('scDescription').value.trim();
    if (!summary) { say('A commit needs a summary.', true); return; }

    busy = true;
    syncCommitButton();
    say('Committing…');

    let r;
    try { r = await window.jarvis.gitCommit(key, { summary, description }); }
    catch { r = { ok: false, error: 'Git could not be reached.' }; }

    busy = false;
    if (key !== active) return;
    if (!r || !r.ok) { say(r?.error || 'The commit did not happen.', true); syncCommitButton(); await loadFiles(key); return; }

    // Committed locally. Nothing is pushed, and nothing asks to be.
    $('scSummary').value = '';
    $('scDescription').value = '';
    say(`Committed ${r.commit.count} file${r.commit.count === 1 ? '' : 's'} to ${r.commit.branch} as ${r.commit.sha}. Nothing was pushed.`);

    files = r.after?.ok ? r.after.files : [];
    $('scChangeCount').textContent = (r.after?.counts?.total) || '';
    openFile = null;
    renderFiles(r.after?.counts || countsOf());
    $('scDiff').replaceChildren(el('div', 'sc-diff-empty', files.length ? 'Pick a file to see its diff.' : 'No changes left in this repository.'));
    loadDetail(key);
    syncCommitButton();
    if (tab === 'history') loadHistory(key, { reset: true }); else history = [];
  }

  // ------------------------------------------------------------- undo the last commit
  // GitHub Desktop's "Committed just now ... Undo" beneath the commit button. Shown for the
  // newest commit while it exists only here: once it is on a remote branch it is gone from
  // view, because taking it back would rewrite history someone else may have.
  let last = null;
  let seqLast = 0;

  async function loadLastCommit(key) {
    const seq = ++seqLast;
    let r;
    try { r = await window.jarvis.gitLastCommit(key); } catch { r = null; }
    if (seq !== seqLast || key !== active) return;
    last = r && r.ok && r.repo?.key === key ? r : null;
    renderUndo();
  }

  function renderUndo() {
    const show = !!(last && last.commit && last.undoable);
    $('scUndo').hidden = !show;
    if (!show) return;
    const at = Date.parse(last.commit.at);
    $('scUndoWhen').textContent = `Committed ${Number.isNaN(at) ? 'recently' : ago(at)}`;
    const subject = $('scUndoSubject');
    subject.textContent = last.commit.subject;
    subject.title = `${last.commit.subject}\n${last.commit.sha} on ${last.commit.branch}`;
    const btn = $('scUndoBtn');
    btn.disabled = busy;
    btn.title = 'Take this commit back. Its changes stay staged, and nothing on the remote changes.';
  }

  async function doUndo() {
    if (busy || !active || !last?.commit) return;
    const key = active;
    const sha = last.commit.sha;
    busy = true;
    renderUndo();
    syncCommitButton();
    say('Undoing the last commit…');

    let r;
    try { r = await window.jarvis.gitUndoCommit(key, sha); } catch { r = { ok: false, error: 'Git could not be reached.' }; }
    busy = false;
    if (key !== active) return;
    if (!r || !r.ok) { say(r?.error || 'The commit was not undone.', true); syncCommitButton(); loadDetail(key); return; }

    // Its message comes back into the boxes, as in GitHub Desktop - unless something has
    // already been typed there, which is never overwritten.
    const summary = $('scSummary');
    const description = $('scDescription');
    const empty = !summary.value.trim() && !description.value.trim();
    if (empty) { summary.value = r.undone.subject || ''; description.value = r.undone.body || ''; }
    say(`Undid "${r.undone.subject}". Its changes are staged again${empty ? ' and its message is back in the boxes' : ''}. Nothing on the remote changed.`);

    files = r.after?.ok ? r.after.files : files;
    $('scChangeCount').textContent = (r.after?.counts?.total) || '';
    renderFiles(r.after?.counts || countsOf());
    if (files.length) openDiff(files[0].path);
    loadDetail(key);
    syncCommitButton();
    if (tab === 'history') loadHistory(key, { reset: true }); else history = [];
  }

  // ------------------------------------------------------------- right-click: all changes
  function openFilesMenu(x, y) {
    const c = countsOf();
    const off = busy || !c.total || c.conflicted > 0;
    $('scCtxDiscard').disabled = off;
    $('scCtxStash').disabled = off;
    const why = c.conflicted ? 'Resolve the conflicts first' : '';
    $('scCtxDiscard').title = why;
    $('scCtxStash').title = why;
    const menu = $('scFilesMenu');
    menu.hidden = false;
    // Keep it on screen.
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
    (off ? menu : $('scCtxDiscard')).focus?.();
  }

  function closeFilesMenu() { $('scFilesMenu').hidden = true; }

  // ------------------------------------------------------------- discard all changes
  // Destructive, so two steps: the first call only asks git what would be lost, the dialog
  // names the repository and every file, and only "Discard changes" runs it - for exactly
  // those files. A copy goes to the Recycle Bin before anything is touched.
  let discardFor = null;   // { key, paths } the open confirmation was raised for

  async function discardAllNow() {
    if (busy || !active) return;
    const key = active;
    let r;
    try { r = await window.jarvis.gitDiscardAll(key, false); } catch { r = { ok: false, error: 'Git could not be reached.' }; }
    if (key !== active) return;
    if (r?.needsConfirmation) { showDiscardConfirm(key, r); return; }
    say(r?.error || 'Nothing was discarded.', true);
  }

  function showDiscardConfirm(key, r) {
    discardFor = { key, paths: r.files.map((f) => f.path) };
    const n = r.files.length;
    $('scDiscardWhat').textContent =
      `Discard all ${n} change${n === 1 ? '' : 's'} in ${r.repoLabel}? Every file goes back to the last commit, and new files are removed.`;
    const list = $('scDiscardFiles');
    list.replaceChildren();
    const SHOW = 12;
    for (const f of r.files.slice(0, SHOW)) {
      list.appendChild(el('li', null, f.path + (f.status === 'untracked' ? '  (new)' : f.status === 'added' ? '  (new, staged)' : '')));
    }
    if (n > SHOW) list.appendChild(el('li', null, `…and ${n - SHOW} more`));
    $('scDiscardRepo').textContent = r.repoLabel;
    $('scDiscardVeil').hidden = false;
    $('scDiscardCancel').focus();   // the safe choice is the default
  }

  function closeDiscard() {
    $('scDiscardVeil').hidden = true;
    discardFor = null;
  }

  async function confirmDiscard() {
    const pending = discardFor;
    closeDiscard();
    if (!pending || busy || pending.key !== active) return;   // the repository changed under the dialog
    const key = pending.key;
    busy = true;
    renderFiles(countsOf());
    say('Discarding…');

    let r;
    try { r = await window.jarvis.gitDiscardAll(key, true, pending.paths); } catch { r = { ok: false, error: 'Git could not be reached.' }; }
    busy = false;
    if (key !== active) return;
    if (!r || !r.ok) { say(r?.error || 'Nothing was discarded.', true); await loadFiles(key); loadDetail(key); return; }

    say(r.message);
    files = r.after?.ok ? r.after.files : [];
    $('scChangeCount').textContent = (r.after?.counts?.total) || '';
    openFile = null;
    renderFiles(r.after?.counts || countsOf());
    $('scDiff').replaceChildren(el('div', 'sc-diff-empty', files.length ? 'Pick a file to see its diff.' : 'No changes left in this repository.'));
    loadDetail(key);
    syncCommitButton();
  }

  // ------------------------------------------------------------- the diff
  async function openDiff(filePath, which) {
    openFile = filePath;
    renderFiles({
      total: files.length,
      staged: files.filter((f) => f.staged).length,
      untracked: files.filter((f) => f.untracked).length,
      conflicted: files.filter((f) => f.conflicted).length,
    });

    const key = active;
    const seq = ++seqDiff;
    $('scDiff').replaceChildren(el('div', 'sc-diff-empty', 'Reading the diff…'));

    let d;
    try { d = await window.jarvis.gitDiff(key, filePath, which); } catch { d = { ok: false, error: 'Git could not be reached.' }; }
    if (seq !== seqDiff || key !== active || filePath !== openFile) return;
    if (d.ok && d.repo?.key !== key) return;

    renderDiff(d, filePath);
  }

  function renderDiff(d, filePath) {
    const box = $('scDiff');
    box.replaceChildren();
    renderDiffInto(box, d, filePath);
  }

  /** The one diff renderer in this app. The Changes tab and History both call it. */
  function renderDiffInto(box, d, filePath, ctx = {}) {
    if (!d.ok) { box.appendChild(el('div', 'sc-diff-empty err', d.error || 'Could not read that diff.')); return; }

    const head = el('header', 'sc-diff-head');
    const id = el('div', 'sc-diff-id');
    JV.path.render(id, filePath, { dirTag: 'code' });
    if (d.entry?.renamedFrom) id.appendChild(el('code', 'sc-renamed', `renamed from ${d.entry.renamedFrom}`));
    head.appendChild(id);

    const meta = el('div', 'sc-diff-meta');
    if (d.added) meta.appendChild(el('em', 'plus', `+${d.added}`));
    if (d.removed) meta.appendChild(el('em', 'minus', `−${d.removed}`));
    // A stash's files are shown against the commit it was made from - its base. (An untracked
    // file in a -u stash is diffed against the empty tree, but it cannot exist in the base,
    // so for that path the two are the same diff.)
    meta.appendChild(el('em', 'side', d.side === 'commit' ? `vs ${d.comparedAgainst || 'parent'}`
      : d.side === 'stash' ? 'vs stash base'
        : d.side === 'pr' ? 'pull request' : d.side === 'index' ? 'staged' : 'working tree'));
    if (d.canToggle) {
      const t = el('button', 'link-btn', d.side === 'index' ? 'Show unstaged' : 'Show staged');
      t.onclick = () => openDiff(filePath, d.side === 'index' ? 'worktree' : 'index');
      meta.appendChild(t);
    }
    if (d.side !== 'commit' && d.side !== 'stash' && d.side !== 'pr') meta.appendChild(aiBtn('Explain', 'explainDiff', { path: filePath }));
    if (JV.sc.decorateDiffHead) JV.sc.decorateDiffHead(meta, { path: filePath, side: d.side, ...ctx });
    head.appendChild(meta);
    box.appendChild(head);

    // GitHub gives no patch for a binary file, a pure rename or a very large diff. Say so;
    // never draw one that was not provided.
    if (d.noPatch) { box.appendChild(el('div', 'sc-diff-empty', d.noPatch)); return; }

    if (d.binary) { box.appendChild(el('div', 'sc-diff-empty', 'Binary file — no text diff to show.')); return; }
    if (d.tooLarge) { box.appendChild(el('div', 'sc-diff-empty', 'That new file is too large to preview here.')); return; }
    if (!d.hunks.length) { box.appendChild(el('div', 'sc-diff-empty', 'No textual change — the difference may be in file mode or line endings.')); return; }

    const body = el('div', 'sc-hunks');
    for (const h of d.hunks) {
      const hd = el('div', 'sc-hunk-head');
      hd.appendChild(el('code', null, h.range || ''));
      if (h.header) hd.appendChild(el('span', null, h.header));
      body.appendChild(hd);
      for (const l of h.lines) {
        const row = el('div', `sc-line ${l.t === '+' ? 'add' : l.t === '-' ? 'del' : l.t === '\\' ? 'meta' : ''}`);
        row.appendChild(el('span', 'sc-ln', l.o ? String(l.o) : ''));
        row.appendChild(el('span', 'sc-ln', l.n ? String(l.n) : ''));
        row.appendChild(el('span', 'sc-sign', l.t === ' ' ? '' : l.t));
        row.appendChild(el('span', 'sc-code', l.text));
        body.appendChild(row);
      }
    }
    box.appendChild(body);
    if (d.truncated) box.appendChild(el('div', 'sc-note', 'This diff is long and has been cut short here.'));
  }

  // ------------------------------------------------------------- JARVIS assistance
  //
  // Everything below runs ONLY from one of these buttons. No other code path in this file
  // touches it, which is why the rest of Source Control costs nothing.
  //
  // The scope is measured locally first, so the button can say what it is about to send
  // before it sends it, and an unusually large scope asks rather than assumes.
  let assistId = 0;
  let assistBusy = false;
  let aiScope = 'staged';   // the user's choice when both staged and other changes exist

  const assistPanel = () => {
    let p = $('scAssist');
    if (!p) {
      p = el('div', 'sc-assist');
      p.id = 'scAssist';
      $('scWork').after(p);
    }
    return p;
  };

  function assistShow(title, body, cls) {
    const p = assistPanel();
    p.replaceChildren();
    p.className = 'sc-assist' + (cls ? ' ' + cls : '');
    const head = el('header', 'sc-assist-head');
    head.appendChild(el('b', null, title));
    const right = el('span', 'sc-assist-right');
    if (assistBusy) {
      const stop = el('button', 'btn btn-danger small sc-assist-stop');
      stop.type = 'button'; stop.textContent = 'Stop';
      stop.onclick = () => window.jarvis.gitAssistCancel(String(assistId));
      right.appendChild(stop);
    }
    const close = el('button', 'link-btn');
    close.textContent = 'Close';
    close.onclick = () => p.remove();
    right.appendChild(close);
    head.appendChild(right);
    p.appendChild(head);
    if (typeof body === 'string') p.appendChild(el('div', 'sc-assist-body', body));
    else if (body) p.appendChild(body);
    p.scrollIntoView({ block: 'nearest' });
  }

  // A change set over the action's budget is sent shortened (every file listed, long files
  // cut, binary/generated files named only) rather than refused. Say so next to the scope.
  function shortenedNote(c) {
    if (!c) return '';
    const kb = Math.round((c.fromBytes || 0) / 1024);
    return ` Shortened to fit from ${kb} KB: every file is listed, long files show their first changes`
      + (c.namedOnly ? `, ${c.namedOnly} binary or generated file${c.namedOnly === 1 ? '' : 's'} named only` : '') + '.';
  }

  /** Ask once, having shown what is being sent. Nothing here changes the repository. */
  async function runAssist(action, opts = {}, onText) {
    if (assistBusy || !active) return;
    const key = active;
    const myId = ++assistId;
    const id = String(myId);

    // Measure first - this costs nothing and is what the panel shows.
    let scope;
    try { scope = await window.jarvis.gitAssistScope(key, action, opts); }
    catch { scope = { ok: false, error: 'Git could not be reached.' }; }
    if (key !== active) return;
    if (!scope.ok) { assistShow(ASSIST_LABEL[action] || 'JARVIS', scope.error, 'err'); return; }

    if (scope.tooLarge && !opts.allowLarge) {
      const box = el('div', 'sc-assist-body');
      box.appendChild(el('p', null, `That is ${scope.lines} lines across ${scope.files} files — an unusually large amount to send.`));
      if (scope.secrets.length) box.appendChild(el('p', 'warn', `It also contains what look like ${scope.secrets.join(', ')}; those will be masked before anything is sent.`));
      const act = el('div', 'sc-force-act');
      const no = el('button', 'btn small'); no.type = 'button'; no.textContent = 'Cancel';
      no.onclick = () => $('scAssist')?.remove();
      const yes = el('button', 'btn btn-primary small'); yes.type = 'button'; yes.textContent = 'Send it anyway';
      yes.onclick = () => runAssist(action, { ...opts, allowLarge: true }, onText);
      act.appendChild(no); act.appendChild(yes);
      box.appendChild(act);
      assistShow(ASSIST_LABEL[action] || 'JARVIS', box, 'warn');
      return;
    }

    assistBusy = true;
    const waiting = el('div', 'sc-assist-body');
    waiting.appendChild(el('p', 'sc-assist-scope', `Sending ${scope.scope} — ${scope.files} file${scope.files === 1 ? '' : 's'} · ${scope.lines} lines.${shortenedNote(scope.condensed)}`));
    if (scope.secrets.length) waiting.appendChild(el('p', 'warn', `Possible ${scope.secrets.join(', ')} found and masked before sending.`));
    waiting.appendChild(el('p', null, 'Thinking…'));
    assistShow(ASSIST_LABEL[action] || 'JARVIS', waiting, 'live');

    let r;
    try { r = await window.jarvis.gitAssist(key, action, { ...opts, allowLarge: true }, id); }
    catch { r = { ok: false, error: 'Git could not be reached.' }; }
    // Superseded - by a repository switch, or a newer request. Drop it, and leave the
    // busy flag to whichever request is current.
    if (myId !== assistId) return;
    assistBusy = false;

    // A late answer belongs to the repository it was asked for, and nothing else.
    if (key !== active || (r.key && r.key !== active)) return;
    if (!r.ok) { assistShow(ASSIST_LABEL[action] || 'JARVIS', r.error || 'No answer came back.', 'err'); return; }

    const body = el('div', 'sc-assist-body');
    body.appendChild(el('p', 'sc-assist-scope',
      `Sent ${r.scopeInfo.label} — ${r.scopeInfo.files} file${r.scopeInfo.files === 1 ? '' : 's'} · ${r.scopeInfo.lines} lines.${shortenedNote(r.scopeInfo.condensed)}`));
    const text = el('div', 'sc-assist-text');
    text.textContent = r.text;
    body.appendChild(text);
    if (onText) {
      const act = el('div', 'sc-force-act');
      act.appendChild(onText(r.text));
      body.appendChild(act);
    }
    assistShow(ASSIST_LABEL[action] || 'JARVIS', body, 'ok');
  }

  const ASSIST_LABEL = {
    commitMessage: 'Suggested commit message',
    explainDiff: 'Explanation',
    reviewChanges: 'Review',
    explainCommit: 'Commit explained',
    explainConflict: 'Conflict explained',
    suggestResolution: 'Suggested resolution',
    reviewResolution: 'Resolution reviewed',
    suspicious: 'Suspicious changes',
    suggestCase: 'Suggested case',
  };

  /** A small JARVIS button. Deliberately secondary to the git controls beside it. */
  function aiBtn(label, action, opts, onText) {
    const b = el('button', `btn btn-ghost small sc-ai sc-ai-${action}`);
    b.type = 'button';
    b.appendChild(el('i', 'sc-ai-dot', '✦'));
    b.appendChild(el('span', null, label));
    b.title = 'Asks JARVIS. This is the only thing here that uses the model.';
    b.onclick = () => runAssist(action, opts, onText);
    return b;
  }

  // ------------------------------------------------------------- stashes
  //
  // A stash is addressed by its SHA throughout - never `stash@{N}`, whose index shifts as
  // soon as anything else is stashed or dropped. A confirmation carries the repository key
  // and the sha it was raised for, so it can never act on whatever is selected later.
  let stashes = [];
  let openStash = null;
  let openStashFile = null;
  let seqStash = 0;

  const stashSay = (text, cls) => {
    const n = $('scStashMsg');
    if (typeof text === 'string') n.textContent = text; else { n.replaceChildren(); if (text) n.appendChild(text); }
    n.className = 'sc-stash-msg' + (cls ? ' ' + cls : '');
  };

  async function loadStashes(key) {
    let r;
    try { r = await window.jarvis.gitStashes(key); } catch { r = { ok: false, error: 'Git could not be reached.' }; }
    if (key !== active) return;
    if (r.ok && r.repo?.key !== key) return;
    stashes = r.ok ? r.stashes : [];
    $('scStashCount').textContent = stashes.length || '';
    renderStashes();
  }

  function renderStashes() {
    const box = $('scStashList');
    box.replaceChildren();
    if (!stashes.length) { box.appendChild(el('div', 'sc-note', 'No stashes in this repository.')); return; }

    for (const s of stashes) {
      const row = el('div', 'sc-stash-row' + (s.sha === openStash ? ' on' : ''));
      const open = el('button', 'sc-stash-open');
      open.type = 'button';
      open.appendChild(el('b', null, s.message || '(no message)'));
      const meta = el('span', 'sc-stash-meta');
      meta.appendChild(el('code', null, s.ref));
      if (s.branch) meta.appendChild(el('small', null, `on ${s.branch}`));
      meta.appendChild(el('small', null, when(s.when)));
      if (s.hasUntracked) meta.appendChild(el('em', 'sc-pill new', 'with untracked'));
      open.appendChild(meta);
      open.onclick = () => showStash(s.sha);
      row.appendChild(open);

      // Restore is GitHub Desktop's Restore - git's pop: the changes come back and the stash
      // goes, but only if git applies it cleanly (a conflicted pop keeps it). It comes first:
      // with a plain "Apply" first, which keeps the stash, a finished restore looked unfinished
      // and invited pressing it again. Apply is still here for a saved copy, and says so.
      const acts = el('div', 'sc-stash-acts');
      const restore = el('button', 'btn btn-primary small sc-stash-restore');
      restore.type = 'button'; restore.textContent = 'Restore';
      restore.title = 'Bring these changes back and remove the stash - only if git applies it cleanly';
      restore.onclick = () => stashOp(s.sha, true);
      const apply = el('button', 'btn small sc-stash-apply');
      apply.type = 'button'; apply.textContent = 'Apply, keep stash';
      apply.title = 'Bring these changes back and keep the stash saved as well';
      apply.onclick = () => stashOp(s.sha, false);
      const drop = el('button', 'btn btn-danger small sc-stash-drop');
      drop.type = 'button'; drop.textContent = 'Drop'; drop.title = 'Delete this stash permanently';
      drop.onclick = () => dropStashNow(s.sha, false);
      acts.appendChild(restore); acts.appendChild(apply); acts.appendChild(drop);
      row.appendChild(acts);
      box.appendChild(row);
    }
  }

  async function showStash(sha) {
    openStash = sha;
    openStashFile = null;
    renderStashes();
    const key = active;
    const seq = ++seqStash;
    $('scDiff').replaceChildren(el('div', 'sc-diff-empty', 'Reading the stash…'));
    let d;
    try { d = await window.jarvis.gitStashDetail(key, sha); } catch { d = { ok: false, error: 'Git could not be reached.' }; }
    if (seq !== seqStash || key !== active || sha !== openStash) return;
    if (d.ok && d.repo?.key !== key) return;
    renderStashDetail(d);
  }

  function renderStashDetail(d) {
    const box = $('scDiff');
    box.replaceChildren();
    if (!d.ok) { box.appendChild(el('div', 'sc-diff-empty err', d.error || 'Could not read that stash.')); return; }

    const head = el('header', 'sc-commit-head');
    head.appendChild(el('h3', null, d.stash.message || '(no message)'));
    const rows = el('div', 'sc-rows');
    const row = (l, v) => { const r = el('div', 'sc-row'); r.appendChild(el('span', null, l)); r.appendChild(el('b', null, v)); rows.appendChild(r); };
    row('Stash', `${d.stash.ref}  ${d.stash.sha.slice(0, 10)}`);
    row('Made on', d.stash.branch || '—');
    row('When', d.stash.when ? new Date(d.stash.when).toLocaleString() : '—');
    row('Contains', `${d.totals.files} file${d.totals.files === 1 ? '' : 's'}, +${d.totals.added} −${d.totals.removed}`
      + (d.stash.hasUntracked ? ' (includes untracked files)' : ' (tracked only)'));
    head.appendChild(rows);
    box.appendChild(head);

    const fileBox = el('div', 'sc-commit-files');
    for (const f of d.files) {
      const [letter, cls] = MARK[f.status] || ['M', 'modified'];
      const r = el('button', `sc-file sc-sfile ${cls}` + (f.path === openStashFile ? ' on' : ''));
      r.type = 'button'; r.title = f.path;
      r.appendChild(el('i', 'sc-mark', letter));
      r.appendChild(JV.path.render(el('span', 'sc-file-name'), f.path));
      const n = el('span', 'sc-commit-counts');
      if (f.binary) n.appendChild(el('em', 'side', 'binary'));
      else { if (f.added) n.appendChild(el('em', 'plus', `+${f.added}`)); if (f.removed) n.appendChild(el('em', 'minus', `−${f.removed}`)); }
      r.appendChild(n);
      r.onclick = () => showStashFile(d.stash.sha, f.path);
      fileBox.appendChild(r);
    }
    box.appendChild(fileBox);
    box.appendChild(el('div', 'sc-commit-diff', ''));
  }

  async function showStashFile(sha, filePath) {
    openStashFile = filePath;
    const key = active;
    const seq = ++seqStash;
    const slot = $('scDiff').querySelector('.sc-commit-diff');
    if (slot) slot.replaceChildren(el('div', 'sc-diff-empty', 'Reading the diff…'));
    let d;
    try { d = await window.jarvis.gitStashDiff(key, sha, filePath); } catch { d = { ok: false, error: 'Git could not be reached.' }; }
    if (seq !== seqStash || key !== active || sha !== openStash || filePath !== openStashFile) return;
    if (d.ok && d.repo?.key !== key) return;
    for (const btn of $('scDiff').querySelectorAll('.sc-sfile')) btn.classList.toggle('on', btn.title === filePath);
    const target = $('scDiff').querySelector('.sc-commit-diff');
    if (!target) return;
    target.replaceChildren();
    const holder = el('div', 'sc-diff-inline');
    target.appendChild(holder);
    renderDiffInto(holder, d, filePath);
  }

  /**
   * git's refusal to apply a stash, in words. Its own text stops at a colon before the file
   * list, and the usual cause is that the stash's changes are already there - it was applied
   * before, and kept. Nothing was changed either way, and the stash is still saved.
   */
  function stashRefusal(r) {
    const lines = String(r.detail || r.error || '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (!/would be overwritten|already exists/i.test(lines.join(' '))) return r.error || 'That did not work.';
    const files = lines.filter((l) => !/^(error|hint|fatal|please|aborting)\b/i.test(l) && !/would be overwritten|already exists/i.test(l));
    const named = files.length ? ` (${files.slice(0, 3).join(', ')}${files.length > 3 ? ', …' : ''})` : '';
    return `Nothing was changed: git will not apply this stash over local changes to the same files${named}. `
      + 'If this stash was already applied, its changes are in your working tree - Drop it. '
      + 'Otherwise commit or stash your current changes first.';
  }

  async function stashOp(sha, pop) {
    if (busy || !active) return;
    const key = active;
    busy = true;
    stashSay(pop ? 'Restoring…' : 'Applying…');
    let r;
    try { r = await window.jarvis.gitStashApply(key, sha, pop); } catch { r = { ok: false, error: 'Git could not be reached.' }; }
    busy = false;
    if (key !== active) return;

    if (!r.ok) {
      // A conflicted apply or pop is NOT a success, and nothing of the user's was lost.
      stashSay(r.conflicted ? (r.error || 'That did not work.') : stashRefusal(r), r.conflicted ? 'warn' : 'err');
      await Promise.all([loadStashes(key), loadFiles(key), loadConflicts(key)]);
      if (r.conflicted) setTab('changes');
      return;
    }
    stashSay(!r.popped ? 'Applied, and the stash is kept as well. Drop it once you no longer need it - Restore does both at once.'
      : r.removed ? 'Restored: the changes are back, and the stash is gone.' : r.message, 'ok');
    stashes = r.stashes || [];
    $('scStashCount').textContent = stashes.length || '';
    renderStashes();
    await Promise.all([loadFiles(key), loadConflicts(key)]);
  }

  async function dropStashNow(sha, confirmed) {
    if (busy || !active) return;
    const key = active;
    busy = true;
    let r;
    try { r = await window.jarvis.gitStashDrop(key, sha, confirmed); } catch { r = { ok: false, error: 'Git could not be reached.' }; }
    busy = false;
    if (key !== active) return;

    if (r.needsConfirmation) {
      // The confirmation remembers the repository and the exact stash it was raised for.
      const box = el('div');
      box.appendChild(el('b', null, `Delete ${r.stash.ref} — "${r.stash.message || 'no message'}" from ${r.repoLabel}?`));
      box.appendChild(el('span', null, 'The work in a stash exists nowhere else. This cannot be undone.'));
      const act = el('div', 'sc-force-act');
      const no = el('button', 'btn small'); no.type = 'button'; no.textContent = 'Keep it';
      no.onclick = () => stashSay('');
      const yes = el('button', 'btn btn-danger small'); yes.type = 'button'; yes.textContent = 'Delete this stash';
      yes.onclick = () => dropStashNow(sha, true);
      act.appendChild(no); act.appendChild(yes);
      box.appendChild(act);
      stashSay(box, 'err');
      return;
    }
    if (!r.ok) { stashSay(r.error || 'That did not work.', 'err'); return; }
    stashSay(r.message, 'ok');
    stashes = r.stashes || [];
    openStash = null;
    $('scStashCount').textContent = stashes.length || '';
    renderStashes();
    $('scDiff').replaceChildren(el('div', 'sc-diff-empty', 'Pick a stash to inspect it.'));
  }

  /** `includeUntracked` pre-ticks the untracked box - "Stash all changes" from the right-click menu. */
  function openStashForm({ includeUntracked = false } = {}) {
    const c = countsOf();
    const form = el('form', 'sc-stash-form');
    const msg = el('input', 'field');
    msg.type = 'text'; msg.placeholder = 'Message (optional)'; msg.autocomplete = 'off';
    form.appendChild(msg);
    const lab = el('label');
    const cb = el('input'); cb.type = 'checkbox';
    cb.checked = includeUntracked && c.untracked > 0;
    lab.appendChild(cb);
    lab.appendChild(el('span', null, `Also stash the ${c.untracked} untracked file${c.untracked === 1 ? '' : 's'}`));
    if (!c.untracked) { cb.disabled = true; lab.style.opacity = '.5'; }
    form.appendChild(lab);
    form.appendChild(el('div', 'sc-stash-what',
      'Stashing moves this work out of the working tree and into the stash list. Ignored files are never included.'));
    const act = el('div', 'sc-force-act');
    const no = el('button', 'btn small'); no.type = 'button'; no.textContent = 'Cancel';
    no.onclick = () => stashSay('');
    const yes = el('button', 'btn btn-primary small sc-stash-go'); yes.type = 'submit'; yes.textContent = 'Stash changes';
    act.appendChild(no); act.appendChild(yes);
    form.appendChild(act);
    form.onsubmit = async (e) => {
      e.preventDefault();
      const key = active;
      busy = true;
      stashSay('Stashing…');
      let r;
      try { r = await window.jarvis.gitStashCreate(key, { message: msg.value, includeUntracked: cb.checked, confirmed: true }); }
      catch { r = { ok: false, error: 'Git could not be reached.' }; }
      busy = false;
      if (key !== active) return;
      if (!r.ok) { stashSay(r.error || 'That did not work.', 'err'); return; }
      stashSay(r.message, 'ok');
      stashes = r.stashes || [];
      $('scStashCount').textContent = stashes.length || '';
      renderStashes();
      await loadFiles(key);
      setTab('stash');
    };
    stashSay(form);
    setTab('stash');
  }

  // ------------------------------------------------------------- conflicts
  let conflicts = null;

  async function loadConflicts(key) {
    let r;
    try { r = await window.jarvis.gitConflicts(key); } catch { r = null; }
    if (!r || key !== active || (r.ok && r.repo?.key !== key)) return;
    conflicts = r.ok ? r : null;
    renderConflictBanner();
  }

  function renderConflictBanner() {
    const host = $('scFiles');
    const existing = host.querySelector('.sc-conflict-banner');
    if (existing) existing.remove();
    if (!conflicts || !conflicts.count) return;

    const b = el('div', 'sc-conflict-banner');
    b.appendChild(el('b', null, `${conflicts.count} conflict${conflicts.count === 1 ? '' : 's'}`));
    b.appendChild(el('small', null, conflicts.operation
      ? `A ${conflicts.operation} is in progress. Resolve these before committing.`
      : 'Resolve these before committing.'));
    host.insertBefore(b, host.firstChild);
  }

  async function showConflict(filePath) {
    const key = active;
    const seq = ++seqDiff;
    $('scDiff').replaceChildren(el('div', 'sc-diff-empty', 'Reading the conflict…'));
    let d;
    try { d = await window.jarvis.gitConflictDetail(key, filePath); } catch { d = { ok: false, error: 'Git could not be reached.' }; }
    if (seq !== seqDiff || key !== active) return;
    if (d.ok && d.repo?.key !== key) return;
    renderConflict(d);
  }

  function renderConflict(d) {
    const box = $('scDiff');
    box.replaceChildren();
    if (!d.ok) { box.appendChild(el('div', 'sc-diff-empty err', d.error || 'Could not read that conflict.')); return; }

    const head = el('header', 'sc-conflict-head');
    head.appendChild(el('h3', null, d.path));
    head.appendChild(el('div', 'sc-conflict-kind', `Conflict — ${d.conflict.label}${d.operation ? ` during a ${d.operation}` : ''}`));
    box.appendChild(head);

    // "Ours" and "theirs" mean different things in a merge, a rebase and a cherry-pick.
    // Say which commit each one is rather than printing a bare label.
    const ex = el('div', 'sc-side-explain');
    ex.appendChild(el('div', null, `Ours = ${d.sides.ours}. Theirs = ${d.sides.theirs}.`));
    if (d.sides.warning) ex.appendChild(el('div', 'warn', d.sides.warning));
    if (d.markersPresent) ex.appendChild(el('div', null, 'The working copy still contains conflict markers. Git decides whether this is resolved, not the markers.'));
    box.appendChild(ex);

    const sides = el('div', 'sc-sides');
    const sideBox = (title, note, content) => {
      const bx = el('div', 'sc-side-box' + (content === null ? ' missing' : ''));
      const h = el('h4');
      h.appendChild(el('span', null, title));
      if (note) h.appendChild(el('em', null, note));
      bx.appendChild(h);
      // A side that is binary or too large to show says so, instead of a pane of noise or an empty one.
      bx.appendChild(el('pre', null, content === null ? 'This side does not have the file.' : content.note || content.text.slice(0, 20000)));
      sides.appendChild(bx);
    };
    sideBox('Base', 'common ancestor', d.base);
    sideBox('Ours', d.conflict.ours, d.ours);
    sideBox('Theirs', d.conflict.theirs, d.theirs);
    sideBox('Working copy', 'what is on disk now', d.working === null ? null : { text: d.working });
    box.appendChild(sides);

    const act = el('div', 'sc-resolve');
    const mk = (label, choice, cls) => {
      const b = el('button', `btn small sc-res-${choice}${cls ? ' ' + cls : ''}`);
      b.type = 'button'; b.textContent = label;
      b.onclick = () => resolveNow(d.path, choice);
      return b;
    };
    act.appendChild(mk('Accept ours', 'ours'));
    act.appendChild(mk('Accept theirs', 'theirs'));
    act.appendChild(mk('Mark resolved (use the working copy)', 'resolved', 'btn-primary'));
    const open = el('button', 'btn small btn-ghost');
    open.type = 'button'; open.textContent = 'Edit in VS Code';
    // The repository's key is its path in the workspace ("." for the workspace itself).
    open.onclick = () => window.jarvis.openInCode(active === '.' ? d.path : `${active}/${d.path}`);
    act.appendChild(open);
    box.appendChild(act);

    const cai = el('div', 'sc-ai-row');
    cai.appendChild(aiBtn('Explain this conflict', 'explainConflict', { path: d.path }));
    cai.appendChild(aiBtn('Suggest a resolution', 'suggestResolution', { path: d.path }));
    cai.appendChild(aiBtn('Review my resolution', 'reviewResolution', { path: d.path }));
    box.appendChild(cai);
  }

  async function resolveNow(filePath, choice) {
    if (busy || !active) return;
    const key = active;
    busy = true;
    let r;
    try { r = await window.jarvis.gitResolveConflict(key, filePath, choice); } catch { r = { ok: false, error: 'Git could not be reached.' }; }
    busy = false;
    if (key !== active) return;
    if (!r.ok) { say(r.error || 'That did not work.', true); showConflict(filePath); return; }
    say(r.message);
    await Promise.all([loadFiles(key), loadConflicts(key)]);
    $('scDiff').replaceChildren(el('div', 'sc-diff-empty',
      (conflicts && conflicts.count) ? 'Pick the next conflicted file.' : 'All conflicts resolved. You can commit the merge now.'));
  }

  // ------------------------------------------------------------- history
  //
  // Lazy in three steps, because a repository here can hold thousands of commits: a page of
  // summaries, then one commit's detail when it is chosen, then one file's diff when that
  // is chosen. Nothing computes a diff for a commit nobody has opened, and searching is
  // handed to git rather than done by pulling the history into the window.
  let tab = 'changes';
  let history = [];
  let histDone = false;
  let histSearch = '';
  let openCommit = null;
  let openCommitFile = null;
  let seqHist = 0;
  let seqCommit = 0;

  function setTab(which) {
    tab = which;
    for (const [id, name] of [['scTabChanges', 'changes'], ['scTabHistory', 'history'], ['scTabStash', 'stash'], ['scTabGitHub', 'github']]) {
      const t = $(id);
      t.classList.toggle('on', which === name);
      t.setAttribute('role', 'tab');
      t.setAttribute('aria-selected', String(which === name));
    }
    $('scFiles').hidden = which !== 'changes';
    $('scCommit').hidden = which !== 'changes';
    $('scHistory').hidden = which !== 'history';
    $('scStashes').hidden = which !== 'stash';
    $('scGitHub').hidden = which !== 'github';
    JV.emit('sc_tab', which);
    if (which === 'github') return;
    if (which === 'stash') {
      if (openStash) showStash(openStash);
      else $('scDiff').replaceChildren(el('div', 'sc-diff-empty', stashes.length ? 'Pick a stash to inspect it.' : 'No stashes in this repository.'));
      return;
    }
    if (which === 'history') {
      if (!history.length) loadHistory(active, { reset: true });
      else if (openCommit) showCommit(openCommit);
      else $('scDiff').replaceChildren(el('div', 'sc-diff-empty', 'Pick a commit to inspect it.'));
    } else if (openFile) openDiff(openFile);
    else $('scDiff').replaceChildren(el('div', 'sc-diff-empty', files.length ? 'Pick a file to see its diff.' : 'No changes in this repository.'));
  }

  async function loadHistory(key, { reset = false } = {}) {
    if (!key) return;
    const seq = ++seqHist;
    if (reset) { history = []; histDone = false; openCommit = null; openCommitFile = null; }
    const list = $('scHistList');
    if (reset) list.replaceChildren(el('div', 'sc-note', 'Reading history…'));

    let r;
    try { r = await window.jarvis.gitHistory(key, { skip: history.length, search: histSearch }); }
    catch { r = { ok: false, error: 'Git could not be reached.' }; }
    if (seq !== seqHist || key !== active) return;
    if (r.ok && r.repo?.key !== key) return;

    if (!r.ok) { list.replaceChildren(el('div', 'sc-note err', r.error || 'Could not read the history.')); return; }
    history = reset ? r.commits : history.concat(r.commits);
    histDone = r.done;
    renderHistory(r.empty);
  }

  function renderHistory(empty) {
    const list = $('scHistList');
    list.replaceChildren();
    $('scHistMore').hidden = histDone || !history.length;

    if (!history.length) {
      list.appendChild(el('div', 'sc-note', empty ? 'This repository has no commits yet.'
        : histSearch ? 'No commit matches that.' : 'No history.'));
      return;
    }

    for (const c of history) {
      const row = el('button', 'sc-commit-row' + (c.sha === openCommit ? ' on' : ''));
      row.type = 'button';

      const top = el('span', 'sc-commit-top');
      top.appendChild(el('b', null, c.summary));
      row.appendChild(top);

      const meta = el('span', 'sc-commit-meta');
      meta.appendChild(el('code', null, c.short));
      meta.appendChild(el('small', 'sc-author', c.author));
      const at = el('small', 'sc-when', when(c.when));
      at.title = fullWhen(c.when);
      meta.appendChild(at);
      if (c.merge) meta.appendChild(el('em', 'sc-pill', 'merge'));
      row.appendChild(meta);

      if (c.refs.length) {
        const refs = el('span', 'sc-commit-refs');
        for (const r of c.refs.slice(0, 4)) refs.appendChild(el('em', `sc-ref ${r.kind}`, r.name));
        row.appendChild(refs);
      }

      row.onclick = () => showCommit(c.sha);
      list.appendChild(row);
    }
  }

  // By calendar day, not "the last 24 hours": yesterday 6 PM reads "Yesterday 6:07 PM",
  // never a bare "06:07 PM" that looks like today.
  const when = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((startOf(new Date()) - startOf(d)) / 86400000);
    if (days <= 0) return time;
    if (days === 1) return `Yesterday ${time}`;
    if (days < 7) return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString([], { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
  };
  const fullWhen = (iso) => {
    const d = new Date(iso || '');
    return Number.isNaN(d.getTime()) ? ''
      : d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  };

  async function showCommit(sha) {
    openCommit = sha;
    openCommitFile = null;
    renderHistory();
    const key = active;
    const seq = ++seqCommit;
    $('scDiff').replaceChildren(el('div', 'sc-diff-empty', 'Reading the commit…'));

    let d;
    try { d = await window.jarvis.gitCommitDetail(key, sha); }
    catch { d = { ok: false, error: 'Git could not be reached.' }; }
    if (seq !== seqCommit || key !== active || sha !== openCommit) return;
    if (d.ok && d.repo?.key !== key) return;
    renderCommit(d);
  }

  function renderCommit(d) {
    const box = $('scDiff');
    box.replaceChildren();
    if (!d.ok) { box.appendChild(el('div', 'sc-diff-empty err', d.error || 'Could not read that commit.')); return; }
    const c = d.commit;

    const head = el('header', 'sc-commit-head');
    head.appendChild(el('h3', null, c.summary));
    if (c.body) head.appendChild(el('p', 'sc-commit-body', c.body));

    const rows = el('div', 'sc-rows');
    const row = (label, value) => {
      const r = el('div', 'sc-row');
      r.appendChild(el('span', null, label));
      r.appendChild(el('b', null, value));
      rows.appendChild(r);
    };
    row('Commit', c.sha);
    row('Author', `${c.author}${c.email ? ` <${c.email}>` : ''}`);
    row('Date', c.authored ? new Date(c.authored).toLocaleString() : '—');
    row('Parent', c.parents.length ? c.parents.map((p) => p.slice(0, 10)).join(', ') : 'none (root commit)');
    row('Changed', `${d.totals.files} file${d.totals.files === 1 ? '' : 's'}, +${d.totals.added} −${d.totals.removed}`);
    head.appendChild(rows);

    const cai = el('div', 'sc-ai-row');
    cai.appendChild(aiBtn('Explain this commit', 'explainCommit', { sha: c.sha }));
    head.appendChild(cai);
    if (JV.sc.decorateCommit) JV.sc.decorateCommit(head, c);

    if (c.merge) {
      head.appendChild(el('div', 'sc-merge-note',
        'This is a merge commit. What follows is the comparison against its first parent, which is not the whole story of a merge.'));
    } else if (c.root) {
      head.appendChild(el('div', 'sc-merge-note', 'This is the first commit, compared against the empty tree.'));
    }
    box.appendChild(head);

    const fileBox = el('div', 'sc-commit-files');
    for (const f of d.files) {
      const [letter, cls] = MARK[f.status] || ['M', 'modified'];
      const r = el('button', `sc-file sc-cfile ${cls}` + (f.path === openCommitFile ? ' on' : ''));
      r.type = 'button';
      r.title = f.renamedFrom ? `${f.renamedFrom} → ${f.path}` : f.path;
      r.appendChild(el('i', 'sc-mark', letter));
      r.appendChild(JV.path.render(el('span', 'sc-file-name'), f.path));
      const n = el('span', 'sc-commit-counts');
      if (f.binary) n.appendChild(el('em', 'side', 'binary'));
      else {
        if (f.added) n.appendChild(el('em', 'plus', `+${f.added}`));
        if (f.removed) n.appendChild(el('em', 'minus', `−${f.removed}`));
      }
      r.appendChild(n);
      r.onclick = () => showCommitFile(d.commit.sha, f.path);
      fileBox.appendChild(r);
    }
    box.appendChild(fileBox);
    box.appendChild(el('div', 'sc-commit-diff', ''));
  }

  async function showCommitFile(sha, filePath) {
    openCommitFile = filePath;
    const key = active;
    const seq = ++seqCommit;
    const slot = $('scDiff').querySelector('.sc-commit-diff');
    if (slot) slot.replaceChildren(el('div', 'sc-diff-empty', 'Reading the diff…'));

    let d;
    try { d = await window.jarvis.gitCommitDiff(key, sha, filePath); }
    catch { d = { ok: false, error: 'Git could not be reached.' }; }
    if (seq !== seqCommit || key !== active || sha !== openCommit || filePath !== openCommitFile) return;
    if (d.ok && d.repo?.key !== key) return;

    // Mark the chosen file, then render the diff with the Phase 2 renderer - there is one
    // diff renderer in this app, not two.
    for (const btn of $('scDiff').querySelectorAll('.sc-cfile')) {
      btn.classList.toggle('on', btn.title.endsWith(filePath));
    }
    const target = $('scDiff').querySelector('.sc-commit-diff');
    if (!target) return;
    target.replaceChildren();
    const holder = el('div', 'sc-diff-inline');
    target.appendChild(holder);
    renderDiffInto(holder, d, filePath, { sha });
    // The diff renders below the commit's file list, which can run to dozens of files, so a
    // click could seem to do nothing. Bring it into view - 'nearest', so a diff already on
    // screen does not move and the page around the panel stays where it is.
    holder.scrollIntoView({ block: 'nearest' });
  }

  // ------------------------------------------------------------- branches
  //
  // Every list here comes from local refs. `origin/...` entries are what the last fetch
  // left behind, not what the remote looks like now, and opening this picker contacts
  // nothing - that is the whole point of Phase 5 being a separate, explicit action.
  let branches = null;
  let filter = '';
  let renaming = null;   // the branch currently being renamed in place

  const branchSay = (text, bad) => {
    const n = $('scBranchMsg');
    n.textContent = text || '';
    n.className = 'sc-branch-msg' + (bad ? ' err' : text ? ' ok' : '');
  };

  async function loadBranches(key) {
    let r;
    try { r = await window.jarvis.gitBranches(key); } catch { r = { ok: false, error: 'Git could not be reached.' }; }
    if (key !== active) return;
    if (r.ok && r.repo?.key !== key) return;
    branches = r.ok ? r : null;
    if (!r.ok) { $('scBranchList').replaceChildren(el('div', 'sc-note err', r.error || 'Could not read the branches.')); return; }
    renderBranches();
  }

  function branchRow(b, kind) {
    const row = el('div', 'sc-branch-row' + (b.current ? ' on' : ''));

    const go = el('button', 'sc-branch-go' + (b.current ? '' : ' switchable'));
    go.type = 'button';
    go.disabled = busy || b.current;
    const label = el('span', 'sc-branch-name');
    label.appendChild(el('b', null, b.name));
    if (b.current) label.appendChild(el('em', 'sc-branch-tick', '✓ current'));
    go.appendChild(label);

    const meta = el('span', 'sc-branch-meta');
    if (kind === 'local') {
      if (!b.published) meta.appendChild(el('em', 'sc-pill new', b.upstreamGone ? 'upstream gone' : 'unpublished'));
      else {
        if (b.ahead) meta.appendChild(el('em', 'ahead', `↑${b.ahead}`));
        if (b.behind) meta.appendChild(el('em', 'behind', `↓${b.behind}`));
        meta.appendChild(el('small', null, b.upstream));
      }
    } else meta.appendChild(el('small', null, b.sha));
    go.appendChild(meta);
    go.title = b.current ? 'You are on this branch' : `Switch to ${b.name}`;
    if (!b.current) go.onclick = () => doSwitch(b.name);
    row.appendChild(go);

    if (kind === 'local') {
      const acts = el('span', 'sc-branch-acts');
      const ren = el('button', 'sc-branch-act');
      ren.type = 'button'; ren.title = `Rename ${b.name} (locally only)`;
      ren.appendChild(el('i', null, 'rename'));
      ren.disabled = busy;
      ren.onclick = (e) => { e.stopPropagation(); doRename(b.name); };
      acts.appendChild(ren);

      const del = el('button', 'sc-branch-act danger');
      del.type = 'button'; del.title = b.current ? 'You cannot delete the branch you are on' : `Delete ${b.name}`;
      del.appendChild(el('i', null, 'delete'));
      del.disabled = busy || b.current;
      del.onclick = (e) => { e.stopPropagation(); doDelete(b.name, false); };
      acts.appendChild(del);
      row.appendChild(acts);
    }
    return row;
  }

  function renderBranches() {
    const box = $('scBranchList');
    box.replaceChildren();
    if (!branches) return;

    const q = filter.trim().toLowerCase();
    const hit = (b) => !q || b.name.toLowerCase().includes(q);

    if (branches.detached) {
      const d = el('div', 'sc-detached');
      d.appendChild(el('b', null, 'Detached HEAD'));
      d.appendChild(el('code', null, branches.head));
      d.appendChild(el('small', null, 'You are not on a branch. Create one here to keep this work.'));
      box.appendChild(d);
    }

    const locals = branches.local.filter(hit);
    const current = locals.filter((b) => b.current);
    const others = locals.filter((b) => !b.current);

    const localRow = (b) => (renaming === b.name ? renameRow(b) : branchRow(b, 'local'));
    if (current.length) {
      box.appendChild(el('h4', 'sc-group', 'Current branch'));
      for (const b of current) box.appendChild(localRow(b));
    }
    if (others.length) {
      box.appendChild(el('h4', 'sc-group', 'Your branches'));
      for (const b of others) box.appendChild(localRow(b));
    }
    const rem = branches.remote.filter(hit);
    if (rem.length) {
      const h = el('h4', 'sc-group', 'Remote branches');
      h.title = 'From the last fetch stored on this machine. Nothing was contacted to show this.';
      box.appendChild(h);
      for (const b of rem) box.appendChild(branchRow(b, 'remote'));
    }
    if (!locals.length && !rem.length) box.appendChild(el('div', 'sc-note', 'No branch matches that.'));
  }

  /** Any branch mutation: run it for the repository it was started for, then re-read git. */
  async function branchOp(fn, okMessage) {
    if (busy || !active) return null;
    const key = active;
    busy = true;
    renderBranches();
    branchSay('Working…');

    let r;
    try { r = await fn(key); } catch { r = { ok: false, error: 'Git could not be reached.' }; }
    busy = false;

    // The repository moved on under us: the result belongs to the old one, so drop it.
    if (key !== active) return null;

    if (!r || !r.ok) { branchSay(r?.error || 'That did not work.', true); return r; }
    branchSay(okMessage(r));
    branches = r.branches?.ok ? r.branches : branches;
    renderBranches();
    await Promise.all([loadDetail(key), loadFiles(key)]);
    // HEAD may have moved (switch, or a pull that fast-forwarded): history follows git.
    if (tab === 'history') loadHistory(key, { reset: true }); else history = [];
    return r;
  }

  const doSwitch = (name) => branchOp(
    (key) => window.jarvis.gitSwitchBranch(key, name),
    (r) => `Now on ${r.current}.`,
  );

  // Renaming happens in place in the list. Electron has no window.prompt, and an inline
  // field belongs in the design language anyway.
  function doRename(from) {
    renaming = from;
    branchSay('');
    renderBranches();
  }

  function renameRow(b) {
    const row = el('form', 'sc-rename-row');
    const input = el('input', 'field');
    input.type = 'text';
    input.value = b.name;
    input.autocomplete = 'off';
    row.appendChild(input);
    const act = el('div', 'sc-rename-act');
    const cancel = el('button', 'btn small');
    cancel.type = 'button'; cancel.textContent = 'Cancel';
    cancel.onclick = () => { renaming = null; renderBranches(); };
    const go = el('button', 'btn btn-primary small');
    go.type = 'submit'; go.textContent = 'Rename';
    act.appendChild(cancel); act.appendChild(go);
    row.appendChild(act);
    row.onsubmit = async (e) => {
      e.preventDefault();
      const to = input.value.trim();
      if (!to || to === b.name) { renaming = null; renderBranches(); return; }
      renaming = null;
      await branchOp((key) => window.jarvis.gitRenameBranch(key, b.name, to),
        (r) => `Renamed to ${r.to}. Nothing on the remote changed.`);
    };
    setTimeout(() => { input.focus(); input.select(); }, 0);
    return row;
  }

  async function doDelete(name, confirmed) {
    const r = await branchOp(
      (key) => window.jarvis.gitDeleteBranch(key, name, { force: confirmed, confirmed }),
      (res) => `Deleted ${res.deleted}${res.forced ? ' (forced)' : ''}.`,
    );
    if (!r || r.ok) return;

    // git refused because the branch holds work that is not merged anywhere. That is NOT
    // retried automatically - the force path is a separate decision, taken by a person who
    // has been told what it costs.
    if (r.unmerged) offerForce(name);
  }

  function offerForce(name) {
    const box = $('scBranchMsg');
    box.replaceChildren();
    box.className = 'sc-branch-msg err';
    box.appendChild(el('b', null, `${name} has commits that are not merged anywhere.`));
    box.appendChild(el('span', null, 'Deleting it anyway destroys those commits, and nothing else has a copy.'));
    const act = el('div', 'sc-force-act');
    const no = el('button', 'btn small');
    no.type = 'button'; no.textContent = 'Keep it';
    no.onclick = () => branchSay('');
    const yes = el('button', 'btn btn-danger small');
    yes.type = 'button'; yes.textContent = `Delete ${name} and lose those commits`;
    yes.onclick = () => doDelete(name, true);
    act.appendChild(no); act.appendChild(yes);
    box.appendChild(act);
  }

  function openNewBranch(open) {
    $('scNewBranch').hidden = !open;
    $('scNewBranchBtn').hidden = open;
    if (!open) return;
    const sel = $('scNewFrom');
    sel.replaceChildren();
    const here = el('option', null, branches?.detached ? `Current commit (${branches.head})` : `Current branch (${branches?.current || 'HEAD'})`);
    here.value = '';
    sel.appendChild(here);
    for (const b of (branches?.local || [])) {
      if (b.current) continue;
      const o = el('option', null, b.name); o.value = b.name; sel.appendChild(o);
    }
    $('scNewName').value = '';
    $('scNewName').focus();
  }

  async function doCreate(e) {
    e.preventDefault();
    const name = $('scNewName').value.trim();
    if (!name) { branchSay('A branch needs a name.', true); return; }
    const from = $('scNewFrom').value || null;
    const r = await branchOp(
      (key) => window.jarvis.gitCreateBranch(key, name, { from, switchTo: true }),
      (res) => `Created ${res.created} and switched to it. It is local only until you publish it.`,
    );
    if (r?.ok) openNewBranch(false);
  }

  // ------------------------------------------------------------- loading
  async function refresh() {
    let r;
    try { r = await window.jarvis.gitRepos(); } catch { r = { ok: false, error: 'Git could not be reached.', list: [] }; }
    // Restricted: the reason as it is, with the way out - not "git is not reachable".
    $('scNote').textContent = r.ok ? '' : r.restricted ? r.error : `git is not reachable: ${r.error}`;
    repos = r.list || [];

    if (active && !repos.some((x) => x.key === active)) active = null;
    if (!active) {
      let saved = null;
      try { saved = localStorage.getItem(SELECTED); } catch { /* storage off */ }
      if (saved && repos.some((x) => x.key === saved)) active = saved;
    }
    renderPicker();

    if (active) select(active);
    else { $('scWork').hidden = true; $('scEmpty').hidden = false; }
    // Refresh also puts the remote button right if it is showing work that is not running.
    if (!remoteLive) reconcileRemote();

    const dirty = repos.filter((x) => x.ok && !x.clean).length;
    const badge = $('nbSource');
    badge.textContent = dirty || '';
    badge.hidden = !dirty;
  }

  // ------------------------------------------------------------- hooks for the GitHub tab
  // github.js (Phase 9) builds on these. As in main, the dependency runs one way: this
  // file holds no GitHub logic and makes no GitHub call. It announces repository and tab
  // changes ('sc_select', 'sc_tab'), shows the GitHub panel when that tab is chosen, and
  // lets github.js add links in three places. With github.js absent, nothing changes.
  JV.sc = {
    key: () => active,
    tab: () => tab,
    setTab: (which) => setTab(which),
    // The Projects view's "Source Control" button: this repository, when the page next loads.
    open: (key) => { active = key; try { localStorage.setItem(SELECTED, key); } catch { /* storage off */ } },
    renderDiffInto: (box, d, filePath, ctx) => renderDiffInto(box, d, filePath, ctx),
    decorateDiffHead: null,
    decorateCommit: null,
    afterRemote: null,
  };

  JV.on('view', (v) => { if (v === 'source') refresh(); });
  $('scRefresh').onclick = (e) => JV.spinWhile(e.currentTarget, refresh);
  $('scTabChanges').onclick = () => setTab('changes');
  $('scTabStash').onclick = () => setTab('stash');
  $('scTabGitHub').onclick = () => setTab('github');
  $('scStashBtn').onclick = () => openStashForm();
  $('scUndoBtn').onclick = doUndo;

  // The right-click menu on "N changed files".
  JV.registerPop($('scFilesMenu'));
  $('scCtxDiscard').onclick = () => { closeFilesMenu(); discardAllNow(); };
  $('scCtxStash').onclick = () => { closeFilesMenu(); openStashForm({ includeUntracked: true }); };
  $('scFilesMenu').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeFilesMenu(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [$('scCtxDiscard'), $('scCtxStash')].filter((b) => !b.disabled);
    const i = items.indexOf(document.activeElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  });
  window.addEventListener('blur', closeFilesMenu);
  window.addEventListener('resize', closeFilesMenu);
  $('scFiles').addEventListener('scroll', closeFilesMenu);

  // The discard confirmation: Cancel is the default, Esc and a click outside cancel too.
  $('scDiscardCancel').onclick = closeDiscard;
  $('scDiscardGo').onclick = confirmDiscard;
  $('scDiscardVeil').addEventListener('mousedown', (e) => { if (e.target === $('scDiscardVeil')) closeDiscard(); });
  $('scDiscardVeil').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeDiscard(); return; }
    if (e.key !== 'Tab') return;
    // Keep focus inside the dialog.
    e.preventDefault();
    const order = [$('scDiscardCancel'), $('scDiscardGo')];
    const i = order.indexOf(document.activeElement);
    order[(i + (e.shiftKey ? -1 : 1) + order.length) % order.length].focus();
  });
  $('scGenMsg').onclick = () => runAssist('commitMessage', {}, (text) => {
    const use = el('button', 'btn btn-primary small');
    use.type = 'button';
    use.textContent = 'Use this message';
    // Fills the boxes only. Committing stays a separate, deliberate press.
    use.onclick = async () => {
      const parsed = await window.jarvis.gitParseMessage(text);
      if (!parsed.ok) return;
      $('scSummary').value = parsed.summary;
      $('scDescription').value = parsed.description;
      syncCommitButton();
      $('scAssist')?.remove();
      say('Message filled in. Nothing has been committed.');
    };
    return use;
  });
  $('scTabHistory').onclick = () => setTab('history');
  $('scHistMore').onclick = () => loadHistory(active);
  let histTimer = null;
  $('scHistSearch').oninput = (e) => {
    histSearch = e.target.value;
    clearTimeout(histTimer);
    histTimer = setTimeout(() => loadHistory(active, { reset: true }), 220);
  };

  $('scRemoteBtn').onclick = (e) => { const op = e.currentTarget.dataset.op; if (op) runRemote(op); };
  $('scRemoteStop').onclick = stopRemote;

  // Progress from the main process while a remote operation runs. Git reports progress on
  // stderr; this is how the window can always show that the network is in use.
  JV.on('git_remote', (e) => {
    if (!e || e.key !== active) return;
    if (!remoteLive) {
      // The operation was already answered (or was never this window's): a line that arrives
      // late must not turn the button busy again, and anything it still shows is put right.
      if (remoteOp !== 'idle') settleRemote();
      return;
    }
    if (e.state && e.state !== 'idle') {
      remoteOp = remoteOp === 'cancelling' ? 'cancelling' : e.state;
      renderRemote(detail);
      if (e.message) remoteSay(e.message, 'live');
    }
  });

  $('scBranchBtn').onclick = () => {
    const p = $('scBranchPop');
    p.hidden = !p.hidden;
    if (!p.hidden) { branchSay(''); openNewBranch(false); $('scBranchSearch').focus(); }
  };
  JV.registerPop($('scBranchPop'), $('scBranchBtn'));
  $('scBranchSearch').oninput = (e) => { filter = e.target.value; renderBranches(); };
  $('scNewBranchBtn').onclick = () => openNewBranch(true);
  $('scNewCancel').onclick = () => openNewBranch(false);
  $('scNewBranch').onsubmit = doCreate;
  $('scCommit').onsubmit = doCommit;
  $('scSummary').oninput = syncCommitButton;
  $('scRepoBtn').onclick = () => { const p = $('scRepoPop'); p.hidden = !p.hidden; };
  JV.registerPop($('scRepoPop'), $('scRepoBtn'));

  // The nav badge: how many repositories have uncommitted work. Local status only - this
  // never contacts a remote.
  const badge = async () => {
    if (document.hidden || state.view === 'source') return;
    try {
      const r = await window.jarvis.gitRepos();
      const n = (r.list || []).filter((x) => x.ok && !x.clean).length;
      const b = $('nbSource');
      b.textContent = n || '';
      b.hidden = !n;
    } catch { /* git away */ }
  };
  badge();
  setInterval(badge, 30000);
})();
