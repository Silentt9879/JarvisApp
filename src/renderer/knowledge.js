/* JARVIS window - the Knowledge view: Markdown notes with a title, tags and a favorite flag,
   previewed with the same marked + DOMPurify pipeline the chat already uses (JV.renderMarkdown
   - see core.js: only a data: image can load, nothing remote, no script/style/form content).

   A second, separate store from Notes (notes.js/notes.json) - see src/knowledge.mjs. Nothing
   here reads, writes or migrates notes.json; nothing in notes.js knows this file exists.

   Three things worth knowing:
   - Every save carries the revision this edit started from. If the file changed on disk since
     then - another window, a save that landed first - the save is refused as stale rather than
     silently overwritten; the only way past that is the explicit "Overwrite anyway" this file
     shows when it happens, or "Reload latest" to see what changed first.
   - An unsaved edit is never silently lost: it is kept as a draft (same idea as Notes' own
     drafts) AND mirrored to localStorage, so switching notes, switching views, or JARVIS being
     closed and reopened all still show it back to you, marked as a draft, instead of losing it.
   - The list only ever carries metadata (title, tags, dates) - a note's body is fetched only
     when it is actually opened, so a large note never makes the sidebar itself slow. */
(() => {
  'use strict';
  const { $, el } = JV;

  const DRAFT_PREFIX = 'jarvis.kneDraft.';
  const PREVIEW_KEY = 'jarvis.knePreviewOpen';

  let notes = [];                  // sidebar metadata only - no body
  let trashNotes = [];             // Trash tab's own list - separate from notes above
  let status = { storageDir: '', migrationComplete: false, legacyNoteCount: 0 };
  let mode = 'notes';               // 'notes' | 'trash'
  let current = null;              // { id, title, created, updated, tags, favorite, folder, sentAt } or null = new note
  let baseRevision = null;         // the revision this edit started from; null means "believed not to exist yet"
  let query = '';
  const drafts = new Map();        // note id (or 'new') -> { title, body, tags, favorite, baseRevision }
  let historyFor = null;           // { id, baseRevision } - the note Version History is open for
  let historySnapshots = [];
  let historySelected = null;      // the file name of the snapshot picked for compare/restore

  const key = () => (current ? current.id : 'new');
  const titleEl = () => $('kneTitle');
  const tagsEl = () => $('kneTags');
  const bodyEl = () => $('kneEdit');
  const favBtn = () => $('kneFavorite');

  // ------------------------------------------------------------- drafts (memory + localStorage)
  function loadDraftsFromStorage() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(DRAFT_PREFIX)) continue;
        try { drafts.set(k.slice(DRAFT_PREFIX.length), JSON.parse(localStorage.getItem(k))); } catch { /* one bad entry: skip it, not fatal */ }
      }
    } catch { /* storage off: drafts only live in memory for this session */ }
  }
  function persistDraft(id, draft) {
    try { localStorage.setItem(DRAFT_PREFIX + id, JSON.stringify(draft)); } catch { /* storage off */ }
  }
  function forgetDraft(id) {
    drafts.delete(id);
    try { localStorage.removeItem(DRAFT_PREFIX + id); } catch { /* storage off */ }
  }

  const parseTags = (s) => String(s || '').split(',').map((t) => t.trim()).filter(Boolean);
  const joinTags = (arr) => (Array.isArray(arr) ? arr.join(', ') : '');

  function fields() {
    return { title: titleEl().value, body: bodyEl().value, tags: parseTags(tagsEl().value), favorite: favBtn().getAttribute('aria-pressed') === 'true' };
  }
  function baseline() {
    return current ? { title: current.title || '', body: current.__body || '', tags: current.tags || [], favorite: !!current.favorite } : { title: '', body: '', tags: [], favorite: false };
  }
  function isDirty() {
    const f = fields();
    const b = baseline();
    return f.title !== (b.title || '') || f.body !== (b.body || '') || f.favorite !== b.favorite || joinTags(f.tags) !== joinTags(b.tags);
  }
  /** Remember what is in the editor, so switching notes (or closing and reopening JARVIS) never loses it. */
  function keepDraft() {
    // Trash is read-only - its fields never hold a draft, so there is nothing here to compare
    // against a Notes-mode draft, and nothing to erase one by mistake either.
    if (mode === 'trash') return;
    if (isDirty()) { const d = { ...fields(), baseRevision }; drafts.set(key(), d); persistDraft(key(), d); }
    else forgetDraft(key());
  }

  function say(msg, level) {
    const box = $('kneMsg');
    box.className = `note-msg ${level || 'ok'}`;
    box.replaceChildren();
    box.appendChild(el('span', null, msg || ''));
    box.hidden = !msg;
  }
  function sayConflict(c) {
    const box = $('kneMsg');
    box.className = 'note-msg err';
    box.replaceChildren();
    box.appendChild(el('span', null, c.error));
    const reload = el('button', 'link-btn', 'Reload latest');
    reload.type = 'button';
    reload.onclick = () => reloadCurrent();
    // Overwriting a revision someone else just saved is destructive to their edit, so it takes
    // two presses - the first only arms it and says what is about to happen (the version being
    // replaced is backed up first; it is not lost, just not where it was).
    const overwrite = el('button', 'link-btn', 'Overwrite anyway');
    overwrite.type = 'button';
    let armed = false;
    overwrite.onclick = () => {
      if (!armed) { armed = true; overwrite.textContent = 'Click again to overwrite (the other version is backed up first)'; return; }
      save({ force: true });
    };
    box.append(' — ', reload, ' · ', overwrite);
    box.hidden = false;
  }
  /** A stale delete (someone else changed the note since it was opened) - no "overwrite
   *  anyway" here, since there is nothing to force past: reload and look again. */
  function sayStaleDelete(err) {
    const box = $('kneMsg');
    box.className = 'note-msg err';
    box.replaceChildren();
    box.appendChild(el('span', null, err));
    const reload = el('button', 'link-btn', 'Reload latest');
    reload.type = 'button';
    reload.onclick = () => reloadCurrent();
    box.append(' — ', reload);
    box.hidden = false;
  }

  function title(t) { return (t || '').trim() || 'Untitled note'; }

  function renderStatus() {
    const n = $('kneStorageNote');
    if (!n) return;
    const bits = [`Stored at ${status.storageDir || 'this PC'}.`];
    if (status.migrationComplete) bits.push('Notes has already been migrated into this store once.');
    else if (status.legacyNoteCount) bits.push(`${status.legacyNoteCount} note${status.legacyNoteCount === 1 ? '' : 's'} still only in Notes - nothing is migrated automatically.`);
    n.textContent = bits.join(' ');
  }

  function matches(n) {
    if (!query) return true;
    const q = query.toLowerCase();
    return title(n.title).toLowerCase().includes(q) || (n.tags || []).some((t) => t.toLowerCase().includes(q));
  }

  function renderList() {
    const ul = $('kneList');
    ul.replaceChildren();
    if (mode === 'trash') {
      const shown = trashNotes.filter(matches);
      if (!shown.length) { ul.appendChild(el('li', 'muted empty', trashNotes.length ? 'No note matches that filter.' : 'Trash is empty.')); return; }
      for (const n of shown) {
        const li = el('li');
        const row = el('button', `note-row${current && current.id === n.id ? ' on' : ''}`);
        row.appendChild(el('b', null, title(n.title)));
        const sub = el('small');
        sub.appendChild(el('span', null, n.deletedAt ? `deleted ${JV.ago(n.deletedAt)}` : 'deleted'));
        if (n.corrupt) sub.appendChild(el('span', 'draft', 'needs attention'));
        row.appendChild(sub);
        row.onclick = () => openTrash(n);
        li.appendChild(row);
        ul.appendChild(li);
      }
      return;
    }
    const shown = notes.filter(matches);
    if (!shown.length) { ul.appendChild(el('li', 'muted empty', notes.length ? 'No note matches that filter.' : 'No knowledge notes yet, sir.')); return; }
    for (const n of shown) {
      const li = el('li');
      const draft = drafts.get(n.id);
      const row = el('button', `note-row${current && current.id === n.id ? ' on' : ''}`);
      const head = el('b', null, draft ? title(draft.title) : title(n.title));
      if (n.favorite) head.prepend(JV.icon('star', 'kne-fav-mark'));
      row.appendChild(head);
      const sub = el('small');
      sub.appendChild(el('span', null, JV.ago(n.updated)));
      if (draft !== undefined) sub.appendChild(el('span', 'draft', 'unsaved'));
      if (n.corrupt) sub.appendChild(el('span', 'draft', 'needs attention'));
      for (const t of (n.tags || []).slice(0, 3)) sub.appendChild(el('span', null, `#${t}`));
      row.appendChild(sub);
      row.onclick = () => open(n);
      li.appendChild(row);
      ul.appendChild(li);
    }
  }

  function renderEditor() {
    const draft = mode === 'notes' ? drafts.get(key()) : null;
    const f = draft || baseline();
    titleEl().value = f.title || '';
    bodyEl().value = f.body || '';
    tagsEl().value = joinTags(f.tags);
    favBtn().setAttribute('aria-pressed', f.favorite ? 'true' : 'false');
    favBtn().classList.toggle('on', !!f.favorite);
    $('kneWhen').textContent = mode === 'trash'
      ? (current ? (current.deletedAt ? `Deleted ${JV.ago(current.deletedAt)}` : 'Deleted') : '')
      : current
        ? `Saved ${JV.ago(current.updated)}${current.sentAt ? ` · sent ${JV.ago(current.sentAt)}` : ''}`
        : 'Not saved yet';
    $('kneSave').disabled = !(f.title || '').trim() && !(f.body || '').trim();
    renderEditorMode();
    renderPreview();
  }

  /** Which controls make sense for what is open right now: a Trash entry is read-only with a
   *  Restore button; a note being edited offers Delete only once it has actually been saved. */
  function renderEditorMode() {
    const trash = mode === 'trash';
    titleEl().readOnly = trash;
    bodyEl().readOnly = trash;
    tagsEl().disabled = trash;
    favBtn().disabled = trash;
    $('kneSave').hidden = trash;
    $('kneDelete').hidden = trash || !current;
    $('kneHistory').hidden = trash || !current;
    $('kneRestore').hidden = !(trash && current);
  }

  function renderPreview() {
    JV.renderMarkdown($('knePreview'), bodyEl().value);
  }

  function setPreviewOpen(open) {
    $('kneBody').classList.toggle('kne-split', open);
    $('knePreviewToggle').setAttribute('aria-pressed', String(open));
    try { localStorage.setItem(PREVIEW_KEY, open ? '1' : '0'); } catch { /* storage off */ }
  }

  /** Switch the editor to a note (fetching its body fresh), or to a blank new note. Nothing asked, nothing lost - a draft is restored instead. */
  async function open(n) {
    keepDraft();
    say('');
    if (!n) {
      current = null;
      baseRevision = null;
      renderEditor();
      renderList();
      titleEl().focus();
      return;
    }
    say('Opening…', 'busy');
    const r = await window.jarvis.knowledgeRead(n.id);
    if (!r?.ok) { say(r?.error || 'Could not open that note.', 'err'); return; }
    current = { ...r.note, __body: r.note.body };
    baseRevision = r.revision;
    const draft = drafts.get(current.id);
    say(draft ? 'Restored your unsaved draft of this note.' : '', 'busy');
    renderEditor();
    renderList();
    bodyEl().focus();
  }

  /** Reload this note from disk, on purpose discarding whatever is unsaved in the editor -
   *  the explicit alternative to "Overwrite anyway" when a save comes back stale. */
  async function reloadCurrent() {
    if (!current) { say(''); renderEditor(); return; }
    const id = current.id;
    forgetDraft(id);
    say('Opening…', 'busy');
    const r = await window.jarvis.knowledgeRead(id);
    if (!r?.ok) { say(r?.error || 'Could not reload that note.', 'err'); return; }
    current = { ...r.note, __body: r.note.body };
    baseRevision = r.revision;
    renderEditor();
    renderList();
    say('Reloaded the latest version.', 'ok');
  }

  async function load() {
    const r = await window.jarvis.knowledgeList();
    if (!r?.ok) { say(r?.error || 'Could not list knowledge notes.', 'err'); }
    notes = r?.notes || [];
    status = r?.status || status;
    renderStatus();
    if (mode === 'notes') renderList();
    const badge = $('nbKne');
    if (badge) badge.textContent = notes.length ? String(notes.length) : '';
    loadTrash(); // keeps the Trash tab's count current without switching to it
  }

  // ------------------------------------------------------------- Trash (Phase 23D)
  async function loadTrash() {
    const r = await window.jarvis.knowledgeTrash();
    if (!r?.ok) say(r?.error || 'Could not list Trash.', 'err');
    trashNotes = r?.notes || [];
    const badge = $('kneTrashCount');
    if (badge) { badge.hidden = !trashNotes.length; badge.textContent = trashNotes.length ? String(trashNotes.length) : ''; }
    if (mode === 'trash') renderList();
  }

  async function openTrash(n) {
    say('Opening…', 'busy');
    const r = await window.jarvis.knowledgeTrashRead(n.id);
    if (!r?.ok) { say(r?.error || 'Could not open that note.', 'err'); return; }
    current = { ...r.note, __body: r.note.body };
    baseRevision = null; // read-only here: nothing is saved or deleted-from-Trash by revision
    say('');
    renderEditor();
    renderList();
  }

  /** Switch between the live list and Trash - whatever was unsaved in the editor is kept as a
   *  draft first, the same as switching to a different note does. */
  function setMode(m) {
    if (mode === m) return;
    keepDraft();
    mode = m;
    $('kneTabNotes').classList.toggle('on', m === 'notes');
    $('kneTabNotes').setAttribute('aria-selected', String(m === 'notes'));
    $('kneTabTrash').classList.toggle('on', m === 'trash');
    $('kneTabTrash').setAttribute('aria-selected', String(m === 'trash'));
    current = null;
    baseRevision = null;
    say('');
    renderEditor();
    if (m === 'trash') loadTrash(); else renderList();
  }

  async function restoreCurrent() {
    if (!current || mode !== 'trash') return;
    const id = current.id;
    const btn = $('kneRestore');
    btn.disabled = true;
    say('Restoring…', 'busy');
    const r = await window.jarvis.knowledgeRestore(id);
    btn.disabled = false;
    if (!r?.ok) { say(r?.error || 'Could not restore this note.', 'err'); return; }
    current = null;
    baseRevision = null;
    renderEditor();
    await loadTrash();
    say('Restored - it is back in your notes.', 'ok');
  }

  async function save(opts) {
    const force = !!(opts && opts.force);
    const f = fields();
    if (!f.title.trim() && !f.body.trim()) { say('Nothing to save - write a title or some text first.', 'err'); return; }
    const btn = $('kneSave');
    btn.disabled = true;
    say('Saving…', 'busy');
    const input = { id: current ? current.id : null, baseRevision, force, ...f };
    const r = await window.jarvis.knowledgeSave(input);
    btn.disabled = false;
    if (!r?.ok) {
      // The editor's own fields are left exactly as typed - only the message changes. Wiping
      // them here (as a reload would) would discard the very edit that just failed to save.
      // It is still captured as a draft, so it survives even if the window closes unresolved.
      keepDraft();
      if (r?.stale) sayConflict(r);
      else say(r?.error || 'Could not save this note.', 'err');
      return;
    }
    forgetDraft(key());
    current = { ...r.note, __body: r.note.body };
    baseRevision = r.revision;
    forgetDraft(current.id);
    await load();
    renderEditor();
    say(r.overwrote ? 'Saved - the version you replaced was backed up first.' : 'Saved.', 'ok');
  }

  // ------------------------------------------------------------- Delete (Phase 23D, Part 2)
  function openDeleteConfirm() {
    if (!current) return;
    $('kneDeleteName').textContent = title(current.title);
    $('kneDeleteVeil').hidden = false;
    $('kneDeleteCancel').focus();
  }
  function closeDeleteConfirm() { $('kneDeleteVeil').hidden = true; }
  async function confirmDelete() {
    if (!current) { closeDeleteConfirm(); return; }
    const id = current.id;
    const rev = baseRevision;
    closeDeleteConfirm();
    say('Deleting…', 'busy');
    const r = await window.jarvis.knowledgeDelete(id, rev);
    if (!r?.ok) {
      if (r?.stale) sayStaleDelete(r.error);
      else say(r?.error || 'Could not delete this note.', 'err');
      return;
    }
    forgetDraft(id);
    current = null;
    baseRevision = null;
    await load();
    renderEditor();
    say('Moved to Trash.', 'ok');
  }

  // ------------------------------------------------------------- Version History (Phase 23E)
  function whenText(ms) {
    try { return new Date(ms).toLocaleString(); } catch { return String(ms); }
  }
  function sayHistory(msg, level) {
    const box = $('kneHistoryMsg');
    box.className = `note-msg ${level || 'ok'}`;
    box.replaceChildren();
    if (typeof msg === 'string') box.appendChild(el('span', null, msg));
    else if (msg) box.appendChild(msg);
    box.hidden = !msg;
  }

  function renderHistoryList() {
    const ul = $('kneHistoryList');
    ul.replaceChildren();
    if (!historySnapshots.length) { ul.appendChild(el('li', 'muted empty', 'No earlier versions of this note yet - one is made automatically the first time an "Overwrite anyway" or a Version History restore actually replaces something.')); return; }
    for (const s of historySnapshots) {
      const li = el('li');
      const row = el('button', `kne-history-row${historySelected === s.file ? ' on' : ''}`);
      row.appendChild(el('b', null, s.readable ? title(s.title) : 'Unreadable version'));
      row.appendChild(el('small', null, whenText(s.when)));
      row.onclick = () => selectHistory(s.file);
      li.appendChild(row);
      ul.appendChild(li);
    }
  }

  function selectHistory(file) {
    historySelected = file;
    renderHistoryList();
    const s = historySnapshots.find((x) => x.file === file);
    $('kneHistoryWhen').textContent = s ? `${title(s.title)} · ${whenText(s.when)}` : 'Select a version to compare';
    $('kneHistoryRestore').disabled = !s || !s.readable;
    $('kneHistoryRestore').textContent = 'Restore this version';
    if (s && s.readable) JV.renderMarkdown($('kneHistorySelected'), s.body);
    else $('kneHistorySelected').replaceChildren(el('span', 'muted', s ? (s.error || 'This version could not be read.') : ''));
  }

  /** (Re)loads Version History's own data - the note (fresh from disk, never the editor's own
   *  in-memory copy) and its snapshot list - without touching whatever message is showing. */
  async function refreshHistory(id) {
    $('kneHistoryList').replaceChildren(el('li', 'muted', 'Loading…'));
    $('kneHistorySelected').replaceChildren();
    $('kneHistoryWhen').textContent = 'Select a version to compare';
    $('kneHistoryRestore').disabled = true;
    $('kneHistoryRestore').textContent = 'Restore this version';
    historySelected = null;

    const r = await window.jarvis.knowledgeRead(id);
    if (!r?.ok) { sayHistory(r?.error || 'Could not open this note.', 'err'); $('kneHistoryList').replaceChildren(); return; }
    historyFor = { id, baseRevision: r.revision };
    $('kneHistoryNote').textContent = `for "${title(r.note.title)}"`;
    JV.renderMarkdown($('kneHistoryCurrent'), r.note.body);

    const sr = await window.jarvis.knowledgeSnapshots(id);
    historySnapshots = sr?.ok ? (sr.snapshots || []) : [];
    if (!sr?.ok) sayHistory(sr?.error || 'Could not list earlier versions.', 'err');
    renderHistoryList();
  }

  async function openHistory() {
    if (!current || mode !== 'notes') return;
    $('kneHistoryVeil').hidden = false;
    sayHistory('');
    await refreshHistory(current.id);
    $('kneHistoryClose').focus();
  }
  function closeHistory() { $('kneHistoryVeil').hidden = true; historyFor = null; historySnapshots = []; historySelected = null; }

  async function restoreVersion() {
    if (!historyFor || !historySelected) return;
    const btn = $('kneHistoryRestore');
    if (btn.dataset.armed !== '1') {
      btn.dataset.armed = '1';
      btn.textContent = 'Click again to restore (the current version is backed up first)';
      return;
    }
    btn.disabled = true;
    sayHistory('Restoring…', 'busy');
    const r = await window.jarvis.knowledgeSnapshotRestore(historyFor.id, historySelected, historyFor.baseRevision);
    btn.disabled = false;
    btn.dataset.armed = '0';
    btn.textContent = 'Restore this version';
    if (!r?.ok) {
      if (r?.stale) {
        const reload = el('button', 'link-btn', 'Reload and look again');
        reload.type = 'button';
        reload.onclick = () => { sayHistory(''); refreshHistory(historyFor.id); };
        const span = el('span', null, `${r.error} `);
        span.appendChild(reload);
        sayHistory(span, 'err');
      } else {
        sayHistory(r?.error || 'Could not restore this version.', 'err');
      }
      return;
    }
    // The main editor, if it is this very note, reflects the restored content immediately.
    if (current && current.id === historyFor.id) {
      current = { ...r.note, __body: r.note.body };
      baseRevision = r.revision;
      renderEditor();
    }
    const id = historyFor.id;
    forgetDraft(id);
    await load();
    await refreshHistory(id); // the list now includes the version just backed up, and "Current" is the restored text
    sayHistory('Restored - the version you replaced is saved in Version History too.', 'ok');
  }

  // ------------------------------------------------------------- Import from Notes (Phase 23D, Part 1)
  function renderImportStats(p) {
    const ul = $('kneImportStats');
    ul.replaceChildren();
    const row = (label, value, bad) => {
      const li = el('li', bad ? 'bad' : null);
      li.appendChild(el('span', null, label));
      li.appendChild(el('b', null, String(value)));
      ul.appendChild(li);
    };
    row('Total notes in Notes', p.total);
    row('Eligible to import', p.eligible);
    row('Already imported', p.alreadyImported);
    row('Conflicts (left untouched)', p.conflicts.length, p.conflicts.length > 0);
    row('Invalid entries (skipped)', p.invalid, p.invalid > 0);
    $('kneImportDest').textContent = `Destination: ${p.destination}`;
    $('kneImportGo').disabled = !p.legacyExists || p.eligible === 0;
  }
  function sayImport(msg, level) {
    const box = $('kneImportMsg');
    box.className = `note-msg ${level || 'ok'}`;
    box.textContent = msg || '';
    box.hidden = !msg;
  }
  async function openImport() {
    if (mode !== 'notes') setMode('notes');
    $('kneImportVeil').hidden = false;
    $('kneImportGo').disabled = true;
    $('kneImportStats').replaceChildren(el('li', 'muted', 'Checking…'));
    sayImport('');
    const p = await window.jarvis.knowledgeImportPreview();
    renderImportStats(p);
    if (p.corrupted) sayImport('notes.json could not be read as valid data - nothing can be imported from it right now. It is left exactly as it is.', 'err');
    else if (!p.legacyExists) sayImport('There is no Notes data to import yet.', 'busy');
    $('kneImportCancel').focus();
  }
  function closeImport() { $('kneImportVeil').hidden = true; }
  async function confirmImport() {
    $('kneImportGo').disabled = true;
    sayImport('Importing…', 'busy');
    const r = await window.jarvis.knowledgeImport();
    if (r?.ok) {
      sayImport(`Imported ${r.migrated}, already had ${r.skipped}${r.conflicts.length ? `, left ${r.conflicts.length} as conflicts (not touched)` : ''}.`, 'ok');
    } else {
      sayImport(r?.reason || r?.errors?.[0] || 'The import could not complete.', 'err');
    }
    const p = await window.jarvis.knowledgeImportPreview();
    renderImportStats(p);
    await load();
  }

  $('kneNew').onclick = () => { if (mode !== 'notes') setMode('notes'); open(null); };
  $('kneSave').onclick = () => save();
  $('kneFavorite').onclick = () => {
    const btn = favBtn();
    const on = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', String(on));
    btn.classList.toggle('on', on);
    $('kneSave').disabled = !(titleEl().value.trim() || bodyEl().value.trim());
  };
  $('knePreviewToggle').onclick = () => setPreviewOpen($('knePreviewToggle').getAttribute('aria-pressed') !== 'true');
  $('kneSearch').addEventListener('input', (e) => { query = e.target.value; renderList(); });
  $('kneTabNotes').onclick = () => setMode('notes');
  $('kneTabTrash').onclick = () => setMode('trash');
  $('kneRestore').onclick = restoreCurrent;

  $('kneDelete').onclick = openDeleteConfirm;
  $('kneDeleteCancel').onclick = closeDeleteConfirm;
  $('kneDeleteGo').onclick = confirmDelete;
  $('kneDeleteVeil').addEventListener('mousedown', (e) => { if (e.target === $('kneDeleteVeil')) closeDeleteConfirm(); });
  $('kneDeleteVeil').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeDeleteConfirm(); return; }
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const order = [$('kneDeleteCancel'), $('kneDeleteGo')];
    const i = order.indexOf(document.activeElement);
    order[(i + (e.shiftKey ? -1 : 1) + order.length) % order.length].focus();
  });

  $('kneHistory').onclick = openHistory;
  $('kneHistoryClose').onclick = closeHistory;
  $('kneHistoryRestore').onclick = restoreVersion;
  $('kneHistoryVeil').addEventListener('mousedown', (e) => { if (e.target === $('kneHistoryVeil')) closeHistory(); });
  $('kneHistoryVeil').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeHistory(); return; }
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const order = [$('kneHistoryClose'), $('kneHistoryRestore')];
    const i = order.indexOf(document.activeElement);
    order[(i + (e.shiftKey ? -1 : 1) + order.length) % order.length].focus();
  });

  $('kneImportOpen').onclick = openImport;
  $('kneImportCancel').onclick = closeImport;
  $('kneImportGo').onclick = confirmImport;
  $('kneImportVeil').addEventListener('mousedown', (e) => { if (e.target === $('kneImportVeil')) closeImport(); });
  $('kneImportVeil').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeImport(); return; }
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const order = [$('kneImportCancel'), $('kneImportGo')];
    const i = order.indexOf(document.activeElement);
    order[(i + (e.shiftKey ? -1 : 1) + order.length) % order.length].focus();
  });
  // A conflict banner (with its Reload/Overwrite buttons) is left alone while typing - it is
  // only cleared by actually resolving it. Any other message (an error, "Saving…") clears as
  // soon as the editor changes again, the same as Notes does.
  const onEdit = () => { if (!$('kneMsg').querySelector('.link-btn')) say(''); $('kneSave').disabled = !(titleEl().value.trim() || bodyEl().value.trim()); };
  const onSaveKey = (e) => { if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); save(); } };
  for (const input of [titleEl(), tagsEl()]) { input.addEventListener('input', onEdit); input.addEventListener('keydown', onSaveKey); }
  bodyEl().addEventListener('input', () => { onEdit(); renderPreview(); });
  bodyEl().addEventListener('keydown', onSaveKey);

  loadDraftsFromStorage();
  let previewOpen = false;
  try { previewOpen = localStorage.getItem(PREVIEW_KEY) === '1'; } catch { /* storage off */ }
  setPreviewOpen(previewOpen);
  // Establishes Save/Delete/Restore's state from JS itself, not from the markup's own
  // defaults - and shows an unsaved "new note" draft left over from before JARVIS was last
  // closed immediately, the same as reopening an in-progress note would.
  renderEditor();

  // -------------------------------------------------------------- Google Drive connection (Phase 24C)
  // Connection management only - there is no Back Up Now or Restore button here; neither
  // operation is wired up yet (main.mjs exposes no jarvis:driveBackup/driveRestore call).
  async function renderDriveStatus() {
    let r;
    try { r = await window.jarvis.driveStatus(); } catch { r = { status: 'error', reason: 'Could not reach JARVIS.' }; }
    const word = { disconnected: 'Not connected', connected: 'Connected', expired: 'Authentication expired', error: 'Connection error' }[r.status] || 'Not connected';
    $('driveStatusWord').textContent = `Google Drive: ${word}`;
    $('driveDot').className = `dot st-${r.status}`;
    $('driveReason').textContent = r.reason || '';
    $('driveClientFields').hidden = true;
    $('driveConfigureBtn').hidden = !!r.clientConfigured;
    $('driveConnectBtn').hidden = !(r.clientConfigured && r.status === 'disconnected');
    $('driveReconnectBtn').hidden = !(r.clientConfigured && (r.status === 'expired' || r.status === 'error'));
    $('driveDisconnectBtn').hidden = !(r.status === 'connected' || r.status === 'expired');
  }
  $('driveConfigureBtn').onclick = () => { $('driveClientFields').hidden = false; $('driveClientId').focus(); };
  $('driveSaveClient').onclick = async () => {
    const clientId = $('driveClientId').value.trim();
    const clientSecret = $('driveClientSecret').value;
    if (!clientId) return;
    const r = await window.jarvis.driveConfigureClient(clientId, clientSecret);
    $('driveClientSecret').value = ''; // never left sitting in the DOM longer than needed
    if (!r.ok) { JV.notify(r.error || 'Could not save that Client ID.', { level: 'err' }); return; }
    await renderDriveStatus();
  };
  async function doConnect() {
    $('driveConnectBtn').disabled = true; $('driveReconnectBtn').disabled = true;
    $('driveStatusWord').textContent = 'Google Drive: Connecting…';
    try {
      const r = await window.jarvis.driveConnect();
      if (!r.ok) JV.notify(r.error || 'Could not connect to Google Drive.', { level: 'err' });
    } finally {
      $('driveConnectBtn').disabled = false; $('driveReconnectBtn').disabled = false;
      await renderDriveStatus();
    }
  }
  $('driveConnectBtn').onclick = doConnect;
  $('driveReconnectBtn').onclick = doConnect;
  $('driveDisconnectBtn').onclick = async () => { await window.jarvis.driveDisconnect(); await renderDriveStatus(); };

  JV.on('view', (v) => { if (v === 'kne') { load(); renderDriveStatus(); setTimeout(() => (current ? bodyEl() : titleEl()).focus(), 30); } });
  load();
})();
