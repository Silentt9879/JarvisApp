/* JARVIS window - how wide the conversation is.

   The chat used to be a fixed 760 px column, which on a wide window left most of the screen
   empty. Now it FITS the window by default, whatever its size, and can be set from the
   width button in the message box:

     Fit       fills the chat area, with side margins that grow a little on wide screens
     Wide      up to 1100 px
     Reading   the old 760 px column - easiest on the eye for long answers
     Your own  a share of the chat area, 50-100% - a share, not pixels, so it still follows
               the window when it is resized or moved to another screen

   The choice is kept with the other preferences of this window. The sizes themselves are in
   styles.css (.chat-main[data-width]); this file only says which one is on. */
(() => {
  'use strict';
  const { $ } = JV;

  const PRESETS = ['fit', 'wide', 'reading'];
  const NOTE = {
    fit: 'Fills the window, whatever its size.',
    wide: 'Up to 1100 px across.',
    reading: 'A narrower column, easiest for long answers.',
  };

  /** Whatever was saved -> 'fit' | 'wide' | 'reading' | a whole share from 50 to 100. Anything else is Fit. */
  function normalise(v) {
    if (PRESETS.includes(v)) return v;
    const n = Number(v);
    if (v !== null && v !== '' && typeof v !== 'boolean' && Number.isFinite(n)) return Math.round(Math.min(100, Math.max(50, n)) / 5) * 5;
    return 'fit';
  }
  const describe = (v) => (typeof v === 'number' ? `${v}% of the chat area. It follows the window as you resize it.` : NOTE[v]);

  /** Put the choice on the chat area. Presets are a data attribute; a share is one custom property. */
  function apply(main, value) {
    const v = normalise(value);
    if (!main) return v;
    if (typeof v === 'number') { main.dataset.width = 'own'; main.style.setProperty('--chat-w', `${v}%`); }
    else { main.dataset.width = v; main.style.removeProperty('--chat-w'); }
    return v;
  }

  JV.chatWidth = { normalise, describe, apply, PRESETS };

  // ------------------------------------------------------------- the button and its panel
  const main = $('chatMain');
  const pop = $('widthPop');
  const btn = $('widthBtn');
  if (!main || !pop || !btn) return; // a page without the chat (the phone window)

  function render() {
    const v = apply(main, JV.prefs.chatWidth);
    for (const b of $('widthSeg').children) {
      const on = b.dataset.width === v;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
    const own = typeof v === 'number';
    $('widthOwn').value = own ? v : 100;
    $('widthOwnOut').textContent = own ? `${v}%` : 'off';
    $('widthNote').textContent = describe(v);
    btn.title = `Chat width: ${own ? `${v}%` : v[0].toUpperCase() + v.slice(1)}`;
    btn.classList.toggle('on', v !== 'fit');
  }
  function set(v) {
    JV.prefs.chatWidth = normalise(v);
    JV.savePrefs();
    render();
  }

  $('widthSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-width]'); if (b) set(b.dataset.width); });
  $('widthOwn').addEventListener('input', (e) => set(Number(e.target.value)));
  btn.onclick = () => { pop.hidden = !pop.hidden; if (!pop.hidden) render(); };
  JV.registerPop(pop, btn);

  render();
})();
