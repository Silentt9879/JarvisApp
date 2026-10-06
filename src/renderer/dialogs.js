/* JARVIS window - dialogs for the newer features (health, what's new, the setup walk-through,
   the editors for saved prompts and routines). One builder, the same look as Settings, and
   keyboard-friendly: Esc closes, Enter confirms where there is one clear answer. */
(() => {
  'use strict';
  const { $ } = JV;

  /** A DOM node from a tag, its attributes, and its children (text is escaped by the DOM). */
  function node(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'value') n.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected') n[k] = true;
      else if (k === 'hidden') n.hidden = true;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of kids.flat()) {
      if (c === undefined || c === null || c === false) continue;
      n.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return n;
  }
  JV.node = node;

  const stack = [];

  /**
   * Show a dialog. `body` is nodes; `buttons` are { label, primary, danger, value, onClick }.
   * A button resolves the dialog with its `value`; Esc and the close button resolve with null.
   * `onClick` may return false to keep the dialog open (for a form that did not validate).
   */
  JV.dialog = ({ title, body = [], buttons = [], wide = false, onOpen } = {}) => new Promise((resolve) => {
    const previous = document.activeElement;
    let done = false;
    const veil = node('div', { class: 'modal-veil dlg-veil' });
    const heading = node('h3', { id: `dlgTitle${stack.length}` }, title || '');
    const close = node('button', { class: 'icon-btn', title: 'Close (Esc)', 'aria-label': 'Close', onclick: () => finish(null) }, JV.icon('x'));
    heading.append(close);
    const bodyEl = node('div', { class: 'modal-body dlg-body' }, body);
    const foot = node('div', { class: 'modal-foot dlg-foot' });
    const panel = node('div', { class: `modal hud-panel dlg${wide ? ' dlg-wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': heading.id }, heading, bodyEl, foot);
    veil.append(panel);

    const finish = (value) => {
      if (done) return;
      done = true;
      veil.remove();
      const i = stack.indexOf(api);
      if (i >= 0) stack.splice(i, 1);
      if (previous && document.contains(previous)) previous.focus?.();
      resolve(value);
    };
    const api = { close: () => finish(null), root: panel };

    for (const b of buttons) {
      const cls = `btn${b.primary ? ' btn-primary' : ''}${b.danger ? ' btn-danger' : ''}`;
      foot.append(node('button', {
        class: cls,
        disabled: b.disabled,
        'data-role': b.role,
        onclick: (e) => {
          const keep = b.onClick ? b.onClick(e, api) : undefined;
          if (keep === false) return;
          finish(b.value === undefined ? true : b.value);
        },
      }, b.label));
    }

    veil.addEventListener('mousedown', (e) => { if (e.target === veil) finish(null); });
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
      if (e.key === 'Tab') {
        // Keep Tab inside the dialog while it is open.
        const items = [...panel.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled && !x.hidden);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });

    document.body.append(veil);
    stack.push(api);
    JV.fillIcons(veil);
    onOpen?.(api);
    const focusable = panel.querySelector('input, textarea, select') || foot.querySelector('.btn-primary') || foot.querySelector('button');
    focusable?.focus();
  });

  /** A yes or no question. Resolves true for the first button, false for the second. */
  JV.confirm = (message, { yes = 'OK', no = 'Cancel', danger = false, title = 'Are you sure?' } = {}) => JV.dialog({
    title,
    body: [node('p', { class: 'dlg-text' }, message)],
    buttons: [
      { label: no, value: false },
      { label: yes, value: true, primary: !danger, danger },
    ],
  }).then((v) => v === true);

  /** A labelled field for a form: a label, the control, and an optional hint. */
  JV.field = (label, control, hint = '') => node('label', { class: 'dlg-field' },
    node('span', { class: 'dlg-label' }, label), control, hint ? node('small', { class: 'dlg-hint' }, hint) : null);

  // The Escape key closes the topmost dialog, and nothing else (Settings has its own handler).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && stack.length) {
      const top = stack[stack.length - 1];
      if (top.root && top.root.isConnected) { e.stopPropagation(); top.close(); }
    }
  }, true);
  void $;
})();
