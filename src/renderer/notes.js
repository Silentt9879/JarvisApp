/* JARVIS window - the Notes view: write something down, save it, and send it to Telegram.

   Kept simple on purpose. The list on the left, one note in the editor on the right, and
   three buttons. Everything is stored by main in notes.json; this file only draws it.
   The Telegram token is never here - the window is told whether a chat is set up, and
   what it is called, and nothing more.

   Two small decisions worth knowing: switching notes never asks anything, because an
   unsaved note is kept as a draft and marked as such (no modal to lose work behind); and
   Delete asks in the button itself, not in window.confirm, which answers "yes" if the
   window closes under it. */
(() => {
  'use strict';
  const { $, el } = JV;

  let notes = [];
  let current = null;              // the note being edited; null means a new one
  let tg = { ready: false, name: null };
  const drafts = new Map();        // note id (or 'new') -> text not yet saved
  let confirming = false;          // Delete pressed once, waiting for the second press

  const text = () => $('noteText');
  const key = () => (current ? current.id : 'new');
  const title = (t) => {
    const first = String(t || '').split('\n').find((l) => l.trim()) || '';
    return first.trim().replace(/^#+\s*/, '').slice(0, 60) || 'Untitled note';
  };

  function say(msg, level) {
    const box = $('noteMsg');
    box.className = `note-msg ${level || 'ok'}`;
    box.textContent = msg || '';
    box.hidden = !msg;
  }

  /** Delete goes back to being Delete whenever anything else happens. */
  function resetConfirm() {
    if (!confirming) return;
    confirming = false;
    const b = $('noteDelete');
    b.classList.remove('armed');
    b.replaceChildren(JV.icon('trash'), el('span', null, 'Delete'));
  }

  function renderTelegram() {
    const note = $('noteTg');
    const send = $('noteSend');
    if (tg.ready) {
      note.textContent = tg.name ? `Telegram: ${tg.name}.` : 'Telegram is set up.';
      send.disabled = false;
      $('noteSendWrap').title = 'Also send this note to your Telegram';
    } else {
      note.replaceChildren(document.createTextNode('Telegram is not set up yet — '));
      const b = el('button', 'link-btn', 'set it up in Settings');
      b.type = 'button';
      b.onclick = () => JV.openSettings?.('phone');
      note.appendChild(b);
      send.checked = false;
      send.disabled = true;
      $('noteSendWrap').title = 'Set Telegram up in Settings > Phone alerts first';
    }
  }

  function renderList() {
    const ul = $('noteList');
    ul.replaceChildren();
    if (!notes.length) { ul.appendChild(el('li', 'muted empty', 'No notes yet, sir.')); return; }
    for (const n of notes) {
      const li = el('li');
      const draft = drafts.get(n.id);
      const row = el('button', `note-row${current && current.id === n.id ? ' on' : ''}`);
      row.appendChild(el('b', null, title(draft ?? n.text)));
      const sub = el('small');
      sub.appendChild(el('span', null, JV.ago(n.updated)));
      if (draft !== undefined) sub.appendChild(el('span', 'draft', 'unsaved'));
      else if (n.sentAt) sub.appendChild(el('span', 'sent', 'sent'));
      row.appendChild(sub);
      row.onclick = () => open(n);
      li.appendChild(row);
      ul.appendChild(li);
    }
  }

  function renderHead() {
    const body = text().value;
    $('noteTitle').textContent = body.trim() ? title(body) : (current ? title(current.text) : 'New note');
    $('noteWhen').textContent = current
      ? `Saved ${JV.ago(current.updated)}${current.sentAt ? ` · sent to Telegram ${JV.ago(current.sentAt)}` : ''}`
      : 'Not saved yet';
    $('noteDelete').hidden = !current;
    $('noteSave').disabled = !body.trim();
  }

  /** Remember what is in the editor, so switching away never loses it. */
  function keepDraft() {
    const body = text().value;
    if (current ? body !== current.text : body.trim() !== '') drafts.set(key(), body);
    else drafts.delete(key());
  }

  /** Switch the editor to a note, or to a blank one. Nothing is asked and nothing is lost. */
  function open(n) {
    keepDraft();
    resetConfirm();
    current = n || null;
    const draft = drafts.get(key());
    text().value = draft !== undefined ? draft : (n ? n.text : '');
    say(draft !== undefined ? 'Showing your unsaved draft of this note.' : '', 'busy');
    renderHead();
    renderList();
    text().focus();
  }

  async function load() {
    const r = await window.jarvis.notes();
    notes = r?.notes || [];
    tg = r?.telegram || { ready: false, name: null };
    if (current) {
      const fresh = notes.find((n) => n.id === current.id);
      if (fresh) { current = fresh; if (!drafts.has(current.id)) text().value = fresh.text; }
      else { current = null; }   // deleted elsewhere; whatever is typed stays in the editor
    }
    if (r && !r.ok && r.error) say(r.error, 'err');
    renderTelegram();
    renderList();
    renderHead();
    const badge = $('nbNotes');
    if (badge) badge.textContent = notes.length ? String(notes.length) : '';
  }

  async function save() {
    resetConfirm();
    const body = text().value;
    if (!body.trim()) { say('Nothing to save, sir — the note is empty.', 'err'); return; }
    const send = $('noteSend').checked && tg.ready;
    const btn = $('noteSave');
    btn.disabled = true;
    say(send ? 'Saving and sending…' : 'Saving…', 'busy');
    const r = await window.jarvis.noteSave({ id: current?.id, text: body }, { telegram: send });
    btn.disabled = false;
    if (!r?.ok) { say(r?.error || 'Could not save the note.', 'err'); return; }
    drafts.delete(key());
    current = r.note;
    drafts.delete(current.id);
    if (r.telegram) tg = r.telegram;
    await load();
    // The note is saved either way; a Telegram refusal is said plainly, not hidden.
    if (send && r.sent && !r.sent.ok) say(`Saved — but Telegram refused it: ${r.sent.error}`, 'err');
    else if (send) say('Saved, and sent to your Telegram.', 'ok');
    else say('Saved.', 'ok');
  }

  /** First press arms the button, second press deletes - no dialog over the window. */
  async function remove() {
    if (!current) return;
    if (!confirming) {
      confirming = true;
      const b = $('noteDelete');
      b.classList.add('armed');
      b.replaceChildren(JV.icon('trash'), el('span', null, 'Delete for good?'));
      say('Press Delete again to remove this note. It cannot be undone.', 'err');
      return;
    }
    resetConfirm();
    const r = await window.jarvis.noteDelete(current.id);
    if (!r?.ok) { say(r?.error || 'Could not delete the note.', 'err'); return; }
    drafts.delete(current.id);
    current = null;
    text().value = '';
    await load();
    say('Deleted.', 'ok');
  }

  $('noteNew').onclick = () => open(null);
  $('noteSave').onclick = save;
  $('noteDelete').onclick = remove;
  text().addEventListener('input', () => { resetConfirm(); say(''); renderHead(); });
  // Ctrl+S saves, as it would anywhere else; the window has no menu to take it.
  text().addEventListener('keydown', (e) => {
    if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
  });

  JV.on('view', (v) => { if (v === 'notes') { load(); setTimeout(() => text().focus(), 30); } });
  // The sidebar count is worth having from the start, without opening the page.
  load();
})();
