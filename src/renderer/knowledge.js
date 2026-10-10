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
  let status = { storageDir: '', migrationComplete: false, legacyNoteCount: 0, historyCount: 0, historyBytes: 0, historyWarn: false, telegram: { ready: false, name: null } };
  let mode = 'notes';               // 'notes' | 'trash'
  let current = null;              // { id, title, created, updated, tags, favorite, folder, sentAt } or null = new note
  let baseRevision = null;         // the revision this edit started from; null means "believed not to exist yet"
  let query = '';
  // Phase 1 (Unified Notes): null = "All notes" (no folder filter); '' = "Unfiled" (no folder
  // set); any other string = that exact folder. Folders are purely the note's own `folder`
  // front-matter field (src/knowledge.mjs already models it end to end) - this is a client-side
  // grouping of notes already in hand, not a second IPC call or a real nested filesystem.
  let selectedFolder = null;
  let autoMigrateChecked = false;  // tried at most once per page boot - migrateFromLegacy itself stays safe to call any number of times
  const drafts = new Map();        // note id (or 'new') -> { title, body, tags, favorite, folder, baseRevision }
  let historyFor = null;           // { id, baseRevision } - the note Version History is open for
  let historySnapshots = [];
  let historySelected = null;      // the file name of the snapshot picked for compare/restore

  const key = () => (current ? current.id : 'new');
  const titleEl = () => $('kneTitle');
  const tagsEl = () => $('kneTags');
  const folderEl = () => $('kneFolder');
  const bodyEl = () => $('kneEdit');
  const favBtn = () => $('kneFavorite');
  const aiExcludeBtn = () => $('kneAiExclude');

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
    return {
      title: titleEl().value, body: bodyEl().value, tags: parseTags(tagsEl().value),
      favorite: favBtn().getAttribute('aria-pressed') === 'true', folder: folderEl().value.trim() || null,
      aiExcluded: aiExcludeBtn().getAttribute('aria-pressed') === 'true',
    };
  }
  function baseline() {
    return current
      ? { title: current.title || '', body: current.__body || '', tags: current.tags || [], favorite: !!current.favorite, folder: current.folder || null, aiExcluded: !!current.aiExcluded }
      : { title: '', body: '', tags: [], favorite: false, folder: null, aiExcluded: false };
  }
  function isDirty() {
    const f = fields();
    const b = baseline();
    return f.title !== (b.title || '') || f.body !== (b.body || '') || f.favorite !== b.favorite
      || joinTags(f.tags) !== joinTags(b.tags) || (f.folder || null) !== (b.folder || null) || f.aiExcluded !== b.aiExcluded;
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
    if (status.legacyNoteCount && !status.migrationComplete) bits.push(`Carrying over ${status.legacyNoteCount} note${status.legacyNoteCount === 1 ? '' : 's'} from Notes (Classic)…`);
    // Decision 4: a size/count WARNING only - nothing here prunes Version History automatically.
    if (status.historyCount) {
      const mb = status.historyBytes / 1_000_000;
      const size = mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(status.historyBytes / 1000)} KB`;
      bits.push(`Version History: ${status.historyCount} version${status.historyCount === 1 ? '' : 's'} (${size})${status.historyWarn ? ' - getting large; nothing is removed automatically' : ''}.`);
    }
    n.textContent = bits.join(' ');
  }

  /** A folder is just the note's own `folder` front-matter field - a `/`-separated path, the
   *  same convention the original Knowledge design doc describes (folder: "Personal/Errands").
   *  This builds a true nested tree for display (an ancestor with no notes of its own, like
   *  "Personal" when only "Personal/Errands" has any, is still shown - as a 0-count row - so
   *  the hierarchy reads correctly), while selecting a folder still means EXACTLY that folder
   *  (never "and everything under it") - the simpler, least-surprising rule, and the one this
   *  phase's own tests already lock in. Purely a grouping of data already in `notes`, not a
   *  second fetch or a real filesystem. */
  function folderTree() {
    const direct = new Map(); // full path -> count of notes with exactly that folder
    let unfiled = 0;
    for (const n of notes) {
      const f = (n.folder || '').trim();
      if (!f) { unfiled += 1; continue; }
      direct.set(f, (direct.get(f) || 0) + 1);
    }
    const allPaths = new Set(direct.keys());
    for (const f of direct.keys()) {
      const parts = f.split('/').filter(Boolean);
      for (let i = 1; i < parts.length; i += 1) allPaths.add(parts.slice(0, i).join('/'));
    }
    const rows = [...allPaths].sort((a, b) => a.localeCompare(b)).map((path) => {
      const parts = path.split('/').filter(Boolean);
      return { path, label: parts[parts.length - 1], depth: parts.length - 1, count: direct.get(path) || 0 };
    });
    return { unfiled, rows };
  }

  function renderFolders() {
    const ul = $('kneFolderList');
    if (mode !== 'notes') { ul.hidden = true; return; }
    const { unfiled, rows } = folderTree();
    ul.hidden = rows.length === 0 && unfiled === 0;
    ul.replaceChildren();
    const row = (label, value, count, icon, depth) => {
      const li = el('li');
      const btn = el('button', `kne-folder-row${selectedFolder === value ? ' on' : ''}`);
      btn.type = 'button';
      if (depth) btn.style.paddingLeft = `${6 + depth * 14}px`;
      btn.appendChild(JV.icon(icon || 'folder', 'kne-folder-ic'));
      btn.appendChild(el('span', null, label));
      btn.appendChild(el('em', 'count', String(count)));
      btn.onclick = () => { selectedFolder = selectedFolder === value ? null : value; renderFolders(); renderList(); };
      li.appendChild(btn);
      return li;
    };
    ul.appendChild(row('All notes', null, notes.length, 'layers', 0));
    if (unfiled) ul.appendChild(row('Unfiled', '', unfiled, 'file', 0));
    for (const r of rows) ul.appendChild(row(r.label, r.path, r.count, 'folder', r.depth));
  }

  function matches(n) {
    if (mode === 'notes' && selectedFolder !== null) {
      const f = (n.folder || '').trim();
      if (selectedFolder === '' ? f !== '' : f !== selectedFolder) return false;
    }
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
    // Pinned (favorite) notes always lead the list, newest-first within each group - a stable
    // re-sort of the already-newest-first list main.mjs hands back, never a second fetch.
    const shown = notes.filter(matches).slice().sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0));
    if (!shown.length) { ul.appendChild(el('li', 'muted empty', notes.length ? 'No note matches that filter.' : 'No notes yet, sir.')); return; }
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
    folderEl().value = f.folder || '';
    favBtn().setAttribute('aria-pressed', f.favorite ? 'true' : 'false');
    favBtn().classList.toggle('on', !!f.favorite);
    aiExcludeBtn().setAttribute('aria-pressed', f.aiExcluded ? 'true' : 'false');
    aiExcludeBtn().classList.toggle('on', !!f.aiExcluded);
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
    folderEl().disabled = trash;
    favBtn().disabled = trash;
    aiExcludeBtn().disabled = trash;
    $('kneSave').hidden = trash;
    $('kneDelete').hidden = trash || !current;
    $('kneHistory').hidden = trash || !current;
    $('kneRestore').hidden = !(trash && current);
    // Phase 1 hardening item 1: Telegram send is per-note, offered only once a note is actually
    // saved (there is nothing to send otherwise) and only when Telegram itself is set up -
    // the same "ready" gate notes.js already uses, reused rather than re-derived here.
    $('kneSendTelegram').hidden = trash || !current || !status.telegram?.ready;
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

  /** Phase 1: carry Notes (Classic) over automatically, once per page boot - never on a
   *  retry loop, and never destructive (migrateFromLegacy only ever adds; see src/knowledge.mjs
   *  and src/main.mjs's jarvis:knowledgeAutoMigrate). Silent when there is nothing to do;
   *  otherwise says plainly what happened, the same way Import's own confirm step does. */
  async function autoMigrateIfNeeded() {
    if (autoMigrateChecked) return;
    autoMigrateChecked = true;
    let r;
    try { r = await window.jarvis.knowledgeAutoMigrate(); } catch { return; }
    if (!r || r.already) return;
    if (r.migrated > 0) {
      JV.notify(`${r.migrated} note${r.migrated === 1 ? '' : 's'} carried over from Notes (Classic) - nothing there was changed.`, { level: 'ok' });
    }
    if (r.conflicts?.length) {
      JV.notify(`${r.conflicts.length} note${r.conflicts.length === 1 ? '' : 's'} from Notes (Classic) could not be carried over automatically (already edited here, or a duplicate id) - open Import from Notes (Classic) to review.`, { level: 'err' });
    }
  }

  async function load() {
    await autoMigrateIfNeeded();
    const r = await window.jarvis.knowledgeList();
    if (!r?.ok) { say(r?.error || 'Could not list knowledge notes.', 'err'); }
    notes = r?.notes || [];
    status = r?.status || status;
    renderStatus();
    if (mode === 'notes') { renderFolders(); renderList(); }
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
    renderFolders();
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

  // ------------------------------------------------------------- Send to Telegram (Phase 1 hardening item 1)
  // A deliberate, separate action from Save - a note is sent exactly when this is pressed,
  // never implicitly on every save, the same explicit-action discipline Notes (Classic) used
  // (a checkbox the person sets before saving) just expressed as its own button here instead,
  // since the unified editor's Save already has its own revision-check path to keep simple.
  async function sendToTelegram() {
    if (!current || mode !== 'notes') return;
    const btn = $('kneSendTelegram');
    btn.disabled = true;
    say('Sending to Telegram…', 'busy');
    let r;
    try { r = await window.jarvis.knowledgeSendTelegram(current.id); } catch (e) { r = { ok: false, error: String(e?.message || e) }; }
    btn.disabled = false;
    if (!r?.ok) { say(r?.error || 'Could not send this note to Telegram.', 'err'); return; }
    current = { ...current, sentAt: r.sentAt };
    renderEditor();
    say('Sent to Telegram.', 'ok');
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
    if (!historySnapshots.length) { ul.appendChild(el('li', 'muted empty', 'No earlier versions of this note yet - one is made automatically the first time a meaningful edit, an "Overwrite anyway," or a Version History restore actually replaces something.')); return; }
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
    row('Total notes in Notes (Classic)', p.total);
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

  // ------------------------------------------------------------- Ask about your notes (Phase 4, AI Knowledge)
  // Local keyword search only (window.jarvis.notesSearch) - nothing here calls an external AI
  // provider. "Ask in Chat" fetches the composed prompt (window.jarvis.notesAskContext, also
  // local) and hands it to JV.chat.insert - the SAME chat composer the person already uses,
  // pre-filled but never auto-sent, so pressing Send is always their own explicit action.
  let lastAskQuery = '';
  function sayAsk(msg, level) {
    const box = $('kneAskMsg');
    box.className = `note-msg ${level || 'ok'}`;
    box.textContent = msg || '';
    box.hidden = !msg;
  }
  function renderAskResults(results) {
    const ul = $('kneAskResults');
    ul.replaceChildren();
    $('kneAskGo').disabled = !results.length;
    if (!results.length) return;
    for (const r of results) {
      const li = el('li');
      li.appendChild(el('b', null, title(r.title)));
      li.appendChild(el('small', null, r.folder ? `in ${r.folder}` : 'unfiled'));
      li.appendChild(el('p', null, r.snippet || ''));
      ul.appendChild(li);
    }
  }
  async function runAskSearch() {
    const q = $('kneAskQuery').value.trim();
    lastAskQuery = q;
    if (!q) { renderAskResults([]); sayAsk(''); return; }
    sayAsk('Searching your notes…', 'busy');
    let r;
    try { r = await window.jarvis.notesSearch(q); } catch (e) { r = { ok: false, error: String(e?.message || e) }; }
    if (!r?.ok) { renderAskResults([]); sayAsk(r?.error || 'Could not search your notes.', 'err'); return; }
    renderAskResults(r.results || []);
    sayAsk(r.results?.length ? '' : 'Nothing in your notes matches that - try different words.', r.results?.length ? 'ok' : 'busy');
  }
  function openAsk() {
    $('kneAskVeil').hidden = false;
    $('kneAskQuery').value = '';
    renderAskResults([]);
    sayAsk('');
    $('kneAskQuery').focus();
  }
  function closeAsk() { $('kneAskVeil').hidden = true; }
  async function askInChat() {
    if (!lastAskQuery) return;
    $('kneAskGo').disabled = true;
    sayAsk('Preparing…', 'busy');
    let r;
    try { r = await window.jarvis.notesAskContext(lastAskQuery); } catch (e) { r = { ok: false, error: String(e?.message || e) }; }
    $('kneAskGo').disabled = false;
    if (!r?.ok) { sayAsk(r?.error || 'Could not prepare that for Chat.', 'err'); return; }
    closeAsk();
    JV.chat.insert(r.prompt); // switches to Chat and fills the composer - nothing is sent until the person presses Send themselves
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
  $('kneAiExclude').onclick = () => {
    const btn = aiExcludeBtn();
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
  $('kneSendTelegram').onclick = sendToTelegram;

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

  $('kneAskOpen').onclick = openAsk;
  $('kneAskCancel').onclick = closeAsk;
  $('kneAskQuery').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runAskSearch(); } });
  $('kneAskQuery').addEventListener('input', () => { clearTimeout($('kneAskQuery')._t); $('kneAskQuery')._t = setTimeout(runAskSearch, 350); });
  $('kneAskGo').onclick = askInChat;
  $('kneAskVeil').addEventListener('mousedown', (e) => { if (e.target === $('kneAskVeil')) closeAsk(); });
  $('kneAskVeil').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeAsk(); } });

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
  for (const input of [titleEl(), tagsEl(), folderEl()]) { input.addEventListener('input', onEdit); input.addEventListener('keydown', onSaveKey); }
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

  // -------------------------------------------------------------- Google Drive connection (Phase 24C) + backup/restore (Phase 24D)
  let driveOpTimer = null; // polls jarvis:driveOperationStatus while a backup/preview/restore is in flight
  let drivePreview = null; // { backupId, token } - the one currently open in the preview/confirm modal
  let driveShowByo = false; // Phase 2: once true, always show the BYO-client fields even if the app-owned path is available

  function fmtWhen(ms) { return ms ? new Date(ms).toLocaleString() : 'never'; }
  function fmtSize(n) {
    if (!n) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0; let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  async function renderDriveStatus() {
    let r;
    try { r = await window.jarvis.driveStatus(); } catch { r = { status: 'error', reason: 'Could not reach JARVIS.' }; }
    const word = { disconnected: 'Not connected', connected: 'Connected', expired: 'Authentication expired', error: 'Connection error' }[r.status] || 'Not connected';
    $('driveStatusWord').textContent = `Google Drive: ${word}`;
    $('driveDot').className = `dot st-${r.status}`;
    $('driveReason').textContent = (r.reason || '') + (r.status === 'connected' && r.appOwned ? ' Connected through JARVIS\'s own Google sign-in.' : '');

    // Phase 2 (Decision 1): the no-setup path is offered only while disconnected, no Client ID
    // is configured yet, this build actually has a real app-owned Client ID available, and the person has not already
    // asked to use their own Client ID instead - BYO-client (unchanged) is the fallback in
    // every other case, exactly as it has always been.
    let appOwned = { available: false };
    if (!r.clientConfigured && r.status === 'disconnected') {
      try { appOwned = await window.jarvis.driveAppOwnedStatus(); } catch { /* treated as unavailable */ }
    }
    const showAppOwned = appOwned.available && !r.clientConfigured && r.status === 'disconnected' && !driveShowByo;
    $('driveAppOwnedSection').hidden = !showAppOwned;

    $('driveClientFields').hidden = true;
    $('driveConfigureBtn').hidden = !!r.clientConfigured || showAppOwned;
    $('driveConnectBtn').hidden = !(r.clientConfigured && r.status === 'disconnected');
    $('driveReconnectBtn').hidden = !(r.clientConfigured && (r.status === 'expired' || r.status === 'error'));
    $('driveDisconnectBtn').hidden = !(r.status === 'connected' || r.status === 'expired');
    $('driveBackupSection').hidden = r.status !== 'connected';
    $('driveSyncSection').hidden = r.status !== 'connected';
    if (r.status === 'connected') { await renderDriveOpStatus(); await renderDriveSyncStatus(); }
  }

  /** Phase 3: a plain-language status line - never silent about a conflict, never silent
   *  about being offline/behind - reusing the controller's own four words (idle/syncing/
   *  offline/error/conflict) rather than inventing a second vocabulary for the same thing. */
  async function renderDriveSyncStatus() {
    let s;
    try { s = await window.jarvis.driveSyncStatus(); } catch { return; }
    const words = {
      idle: 'Synced', syncing: 'Syncing…', offline: 'Offline - will sync once reconnected',
      error: s.lastError || 'Sync error',
      // Phase 5 (Task 3): named, not just counted - "clearly visible" means the person can
      // tell which note(s) to open, not just that something somewhere needs attention.
      conflict: `${s.conflictCount} note${s.conflictCount === 1 ? '' : 's'} need attention: ${(s.conflictingNotes || []).map((n) => `"${n.title}"`).join(', ')} - open Version History on each to see both versions`,
      // Phase 6 (Task 5): corrupted/malformed remote data was refused, not silently applied -
      // the local note(s) it would have replaced are untouched; this is informational, not a
      // conflict to resolve, and clears on its own once the remote side is fixed and re-synced.
      quarantine: `${s.quarantinedCount} file${s.quarantinedCount === 1 ? '' : 's'} from Google Drive looked corrupted and were not applied - your local notes were not changed.`,
    };
    let text = words[s.state] || 'Not synced yet.';
    if (s.state === 'idle' && s.lastSyncAt) text = `Synced ${JV.ago(s.lastSyncAt)}`;
    if (s.syncing && s.progress?.total) text = `Syncing… ${s.progress.current}/${s.progress.total}`;
    $('driveSyncStatus').textContent = text;
    $('driveSyncNowBtn').disabled = !!s.syncing;
  }
  $('driveSyncNowBtn').onclick = async () => {
    $('driveSyncNowBtn').disabled = true;
    try { await window.jarvis.driveSyncNow(); } catch { /* status below reflects whatever actually happened */ }
    await renderDriveSyncStatus();
    await load(); // a pull may have changed the list - the same safe, draft-preserving refresh a Drive restore already uses
  };

  /** Polls main.mjs's one in-flight-operation record - real progress, read, never guessed. */
  async function renderDriveOpStatus() {
    let s;
    try { s = await window.jarvis.driveOperationStatus(); } catch { return; }
    if (s.lastBackup) {
      const when = fmtWhen(s.lastBackup.at);
      $('driveLastBackup').textContent = s.lastBackup.ok
        ? `Last successful backup: ${when} (${s.lastBackup.fileCount} file${s.lastBackup.fileCount === 1 ? '' : 's'})`
        : `Last backup attempt failed: ${when} - ${s.lastBackup.error || ''}`;
    }
    const op = s.operation;
    $('driveOpStatus').hidden = !op;
    $('driveBackupNowBtn').disabled = !!op;
    $('driveHistoryOpenBtn').disabled = !!op;
    if (op) {
      const label = { backup: 'Backing up', preview: 'Checking backup', restore: 'Restoring' }[op.kind] || 'Working';
      const p = op.progress;
      $('driveOpStatus').textContent = p && p.total ? `${label}… ${p.current}/${p.total}` : `${label}…`;
      if (!driveOpTimer) driveOpTimer = setInterval(renderDriveOpStatus, 700);
    } else if (driveOpTimer) {
      clearInterval(driveOpTimer); driveOpTimer = null;
    }
  }
  $('driveConfigureBtn').onclick = () => { $('driveClientFields').hidden = false; $('driveClientId').focus(); };
  $('driveShowByoBtn').onclick = () => { driveShowByo = true; renderDriveStatus(); };
  $('driveConnectAppOwnedBtn').onclick = async () => {
    $('driveConnectAppOwnedBtn').disabled = true;
    $('driveStatusWord').textContent = 'Google Drive: Connecting…';
    try {
      const r = await window.jarvis.driveConnectAppOwned();
      if (!r.ok) JV.notify(r.error || 'Could not connect to Google Drive.', { level: 'err' });
    } finally {
      $('driveConnectAppOwnedBtn').disabled = false;
      await renderDriveStatus();
    }
  };
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

  // ---------------------------------------------------------- Part 1: Back Up Now
  $('driveBackupNowBtn').onclick = async () => {
    $('driveBackupNowBtn').disabled = true;
    await renderDriveOpStatus(); // starts the progress poll immediately, before the call below even resolves
    try {
      const r = await window.jarvis.driveBackupNow();
      if (r.ok) JV.notify(`Backup complete - ${r.verified} file${r.verified === 1 ? '' : 's'} verified.`, { level: 'ok' });
      else JV.notify(r.error || 'Backup did not complete.', { level: 'err' });
    } catch (e) { JV.notify(String(e?.message || e), { level: 'err' }); }
    finally { await renderDriveStatus(); }
  };

  // ---------------------------------------------------------- Part 2: Backup History
  // "Incomplete" (no manifest at all - an interrupted or still-running backup) and "Corrupt"
  // (a manifest exists but failed to read or validate) are different problems with different
  // real-world causes - shown as what the engine actually reported, not folded into one
  // generic label, wherever that distinction is determinable from its error text.
  function driveStatusBadge(b) {
    if (b.complete) return 'Complete';
    if (b.error && /no manifest/i.test(b.error)) return 'Incomplete (interrupted or still running)';
    if (b.error) return `Corrupt (${b.error})`;
    return 'Incomplete';
  }
  async function renderDriveHistory() {
    const list = $('driveHistoryList');
    list.replaceChildren();
    $('driveHistoryMsg').hidden = true;
    let r;
    try { r = await window.jarvis.driveBackupHistory(); } catch (e) { r = { ok: false, error: String(e?.message || e) }; }
    if (!r.ok) { $('driveHistoryMsg').hidden = false; $('driveHistoryMsg').textContent = r.error || 'Could not list backups.'; return; }
    if (!r.backups.length) { list.appendChild(el('li', 'muted empty', 'No backups yet.')); return; }
    for (const b of r.backups) {
      const li = el('li', 'row');
      const t = el('div');
      t.appendChild(el('b', null, fmtWhen(b.createdAt)));
      t.appendChild(el('small', null, ` · ${b.backupId} · ${b.fileCount} file${b.fileCount === 1 ? '' : 's'} · ${fmtSize(b.sizeBytes)} · ${driveStatusBadge(b)}`));
      li.appendChild(t);
      if (b.complete) {
        const btn = el('button', 'btn small', 'Preview');
        btn.type = 'button';
        btn.onclick = () => openDrivePreview(b.backupId);
        li.appendChild(btn);
      }
      list.appendChild(li);
    }
  }
  $('driveHistoryOpenBtn').onclick = async () => { $('driveHistoryVeil').hidden = false; await renderDriveHistory(); };
  $('driveHistoryCloseBtn').onclick = () => { $('driveHistoryVeil').hidden = true; };

  // ---------------------------------------------------------- Part 3 + 4: Restore preview and confirmation
  function driveList(label, paths) {
    if (!paths.length) return null;
    const box = el('div');
    box.appendChild(el('b', null, `${label} (${paths.length})`));
    const ul = el('ul', 'tagcloud');
    for (const p of paths.slice(0, 50)) ul.appendChild(el('li', null, p));
    if (paths.length > 50) ul.appendChild(el('li', 'muted', `…and ${paths.length - 50} more`));
    box.appendChild(ul);
    return box;
  }
  async function openDrivePreview(backupId) {
    $('driveHistoryVeil').hidden = true;
    $('drivePreviewVeil').hidden = false;
    $('driveConfirmDetail').hidden = true;
    $('drivePreviewRestoreBtn').hidden = false;
    $('driveConfirmGoBtn').hidden = true;
    $('drivePreviewMsg').hidden = true;
    const detail = $('drivePreviewDetail');
    detail.replaceChildren(el('p', 'muted', 'Checking this backup…'));
    drivePreview = null;
    let r;
    try { r = await window.jarvis.driveRestorePreview(backupId); } catch (e) { r = { ok: false, error: String(e?.message || e) }; }
    detail.replaceChildren();
    if (!r.ok) {
      $('drivePreviewMsg').hidden = false;
      $('drivePreviewMsg').textContent = r.error || 'This backup could not be previewed.';
      $('drivePreviewRestoreBtn').hidden = true;
      return;
    }
    drivePreview = { backupId, token: r.token };
    detail.appendChild(el('p', null, `Backup from ${fmtWhen(r.createdAt)} - ${r.total} file(s) total.`));
    for (const [label, bucket] of [['Notes to add', r.added.notes], ['Notes to replace', r.replaced.notes], ['Notes already identical', r.unchanged.notes],
      ['Trash entries affected', [...r.added.trash, ...r.replaced.trash]], ['Version History entries affected', [...r.added.overwritten, ...r.replaced.overwritten]]]) {
      const node = driveList(label, bucket);
      if (node) detail.appendChild(node);
    }
    if (!r.added.notes.length && !r.replaced.notes.length && !r.added.trash.length && !r.replaced.trash.length && !r.added.overwritten.length && !r.replaced.overwritten.length) {
      detail.appendChild(el('p', 'muted', 'Nothing would change - everything already matches this backup.'));
    }
  }
  $('drivePreviewCancelBtn').onclick = () => { $('drivePreviewVeil').hidden = true; drivePreview = null; };
  $('drivePreviewRestoreBtn').onclick = () => {
    $('driveConfirmDetail').hidden = false;
    $('drivePreviewRestoreBtn').hidden = true;
    $('driveConfirmGoBtn').hidden = false;
  };
  $('driveConfirmGoBtn').onclick = async () => {
    if (!drivePreview) return;
    const { backupId, token } = drivePreview;
    $('driveConfirmGoBtn').disabled = true;
    $('drivePreviewVeil').hidden = true;
    await renderDriveOpStatus();
    try {
      const r = await window.jarvis.driveRestoreConfirm(backupId, token);
      if (r.ok) {
        JV.notify(`Restored ${r.written} file${r.written === 1 ? '' : 's'} (${r.unchanged} already matched).`, { level: 'ok' });
        // Refresh the Knowledge list/reader from disk - load() already preserves an unsaved
        // draft the same way switching notes or reopening JARVIS does (see this file's own
        // header comment), so an in-progress edit is never clobbered by this refresh.
        await load();
      } else {
        JV.notify(r.error || 'Restore did not complete.', { level: 'err' });
      }
    } catch (e) { JV.notify(String(e?.message || e), { level: 'err' }); }
    finally { $('driveConfirmGoBtn').disabled = false; drivePreview = null; await renderDriveStatus(); }
  };

  JV.on('drive_restored', () => { if (JV.state.view === 'kne') load(); });

  JV.on('view', (v) => { if (v === 'kne') { load(); renderDriveStatus(); setTimeout(() => (current ? bodyEl() : titleEl()).focus(), 30); } });
  load();
})();
