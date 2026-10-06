/* JARVIS window - Settings, made easier to move through: sections in tabs with a search box, plus
   the controls for text size, high contrast, voice, the phone web app and the daily budget. */
(() => {
  'use strict';
  const { $, state } = JV;
  const api = window.jarvis;

  // Which tab each section belongs to, by its heading. A new section only needs a line here.
  const TAB_OF = {
    'Updates': 'general',
    'Workspace': 'general',
    'Appearance': 'general',
    'Text and contrast': 'general',
    'Preferences': 'general',
    'Phone alerts': 'phone',
    'Voice': 'voice',
    'Phone web app': 'voice',
    'Account': 'account',
    'Usage and budget': 'account',
    'About': 'about',
  };
  const ZOOM_LABEL = { '0.9': 'Smaller', '1': 'Standard', '1.15': 'Larger', '1.3': 'Largest' };

  // Defaults for the window's own preferences (kept in this window's storage, as the others are).
  for (const [k, v] of Object.entries({ speakReplies: false, wakeWord: false, zoom: 1, contrast: false, voiceURI: '' })) {
    if (JV.prefs[k] === undefined) JV.prefs[k] = v;
  }

  // ------------------------------------------------------------- applying preferences

  function applyZoom(f) {
    const factor = Number(f) || 1;
    api.zoom(factor).catch(() => {});
    markZoom(factor);
  }
  function applyContrast(on) {
    if (on) document.documentElement.dataset.contrast = 'high';
    else delete document.documentElement.dataset.contrast;
  }
  function markZoom(f) {
    document.querySelectorAll('#zoomSeg [data-zoom]').forEach((b) => {
      const on = Number(b.dataset.zoom) === Number(f);
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }
  JV.applyPrefs = () => {
    applyZoom(JV.prefs.zoom);
    applyContrast(JV.prefs.contrast);
  };

  // ------------------------------------------------------------- tabs and search

  let tab = 'general';
  function sections() { return [...document.querySelectorAll('#settingsVeil .set-sec')]; }
  function headingOf(sec) { return sec.querySelector('.pop-sec')?.textContent.trim() || ''; }

  function tagSections() {
    for (const sec of sections()) {
      const title = headingOf(sec);
      sec.dataset.tab = TAB_OF[title] || 'general';
    }
  }

  function showTab(t) {
    tab = t;
    document.querySelectorAll('#settingsVeil .set-tabs [data-tab]').forEach((b) => {
      const on = b.dataset.tab === t;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.classList.toggle('on', on);
    });
    applyFilter();
  }

  function applyFilter() {
    const q = ($('setSearch')?.value || '').trim().toLowerCase();
    let shown = 0;
    for (const sec of sections()) {
      const match = q ? sec.textContent.toLowerCase().includes(q) : sec.dataset.tab === tab;
      sec.hidden = !match;
      if (match) shown++;
    }
    let none = $('settingsNone');
    if (!shown) {
      if (!none) {
        none = JV.node('p', { class: 'set-note', id: 'settingsNone' }, 'Nothing matches that. Try another word.');
        $('settingsBody').append(none);
      }
    } else if (none) none.remove();
  }

  /** Open Settings on a tab, optionally scrolled to one section (used by Health and the new-window links). */
  JV.settingsGo = (t, anchor) => {
    if (t && ['general', 'phone', 'voice', 'account', 'about'].includes(t)) showTab(t);
    if (anchor) {
      const el = document.getElementById(anchor);
      if (el) { el.hidden = false; el.scrollIntoView({ block: 'start' }); }
    }
  };

  // ------------------------------------------------------------- the phone web app

  async function refreshCompanion() {
    const s = await api.companion().catch(() => null);
    if (!s) return;
    $('compOn').checked = !!s.on;
    $('compPort').value = String(s.port);
    const addr = $('compAddr');
    addr.hidden = !(s.on && s.running);
    const host = s.addresses?.[0] || 'this-PC-address';
    $('compUrl').textContent = `http://${host}:${s.port}/`;
    $('compStatus').textContent = s.on
      ? (s.running ? 'It is on. Keep this window open while you use it from the phone.' : 'Turned on, but it is not running yet. Press Apply.')
      : 'Off. Nothing on this PC is reachable from the network.';
    if (!s.on) { $('compCodeBox').hidden = true; }
  }

  async function applyCompanion() {
    const on = $('compOn').checked;
    const port = Number($('compPort').value);
    const r = await api.setCompanion({ on, port }).catch((e) => ({ ok: false, error: e.message }));
    $('compStatus').textContent = r?.ok
      ? (on ? 'It is on. Keep this window open while you use it from the phone.' : 'Off. Nothing on this PC is reachable from the network.')
      : (r?.error || 'Could not change it.');
    refreshCompanion();
  }

  // ------------------------------------------------------------- budget

  async function refreshBudget() {
    const u = await api.usage().catch(() => null);
    if (!u) return;
    $('budgetIn').value = String(u.budgetUsd || 0);
    const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;
    $('budgetNow').textContent = `Today about ${money(u.today.costUsd)} over ${u.today.replies} repl${u.today.replies === 1 ? 'y' : 'ies'}. The last seven days about ${money(u.week.costUsd)}.${u.overBudget ? ' Today is past your limit.' : ''}`;
  }

  // ------------------------------------------------------------- voice

  function fillVoices() {
    const sel = $('prefVoice');
    if (!sel) return;
    const list = JV.voices ? JV.voices() : [];
    sel.replaceChildren(JV.node('option', { value: '' }, 'The default voice'),
      ...list.map((v) => JV.node('option', { value: v.uri, selected: v.uri === JV.prefs.voiceURI }, `${v.name} (${v.lang})`)));
    sel.value = JV.prefs.voiceURI || '';
  }

  async function setWake(on) {
    const r = await JV.setWakeWord(on);
    if (!r.ok) {
      $('prefWake').checked = false;
      $('wakeNote').textContent = r.error;
      JV.prefs.wakeWord = false;
    } else {
      JV.prefs.wakeWord = !!on;
      $('wakeNote').textContent = on ? 'Listening on this PC. Say “JARVIS”, then your request.' : 'The first time, JARVIS downloads the speech model once. Sound is cut into short pieces and not kept.';
    }
    JV.savePrefs();
  }

  // ------------------------------------------------------------- wiring

  function wire() {
    document.querySelectorAll('#settingsVeil .set-tabs [data-tab]').forEach((b) => b.addEventListener('click', () => { $('setSearch').value = ''; showTab(b.dataset.tab); }));
    $('setSearch')?.addEventListener('input', applyFilter);
    $('setSearch')?.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('setSearch').value) { e.stopPropagation(); $('setSearch').value = ''; applyFilter(); } });

    document.querySelectorAll('#zoomSeg [data-zoom]').forEach((b) => b.addEventListener('click', () => {
      JV.prefs.zoom = Number(b.dataset.zoom);
      JV.savePrefs();
      applyZoom(JV.prefs.zoom);
      JV.notify(`Text is now ${ZOOM_LABEL[String(JV.prefs.zoom)] || 'changed'}.`, { level: 'info' });
    }));
    $('prefContrast')?.addEventListener('change', (e) => {
      JV.prefs.contrast = e.target.checked;
      JV.savePrefs();
      applyContrast(JV.prefs.contrast);
    });
    $('prefSpeak')?.addEventListener('change', (e) => { JV.prefs.speakReplies = e.target.checked; JV.savePrefs(); if (!e.target.checked) JV.stopSpeaking(); });
    $('prefVoice')?.addEventListener('change', (e) => { JV.prefs.voiceURI = e.target.value; JV.savePrefs(); });
    $('prefVoiceTest')?.addEventListener('click', () => { JV.speak('Good day, sir. JARVIS is ready when you are.'); });
    $('prefWake')?.addEventListener('change', (e) => setWake(e.target.checked));

    $('compApply')?.addEventListener('click', applyCompanion);
    $('compOn')?.addEventListener('change', applyCompanion);
    $('compReveal')?.addEventListener('click', async () => {
      const r = await api.revealCompanionCode().catch(() => null);
      if (!r?.code) { $('compStatus').textContent = 'Could not read the access code.'; return; }
      $('compCode').textContent = r.code;
      $('compCodeBox').hidden = false;
    });
    $('compCopy')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText($('compCode').textContent); JV.notify('The access code is copied.', { level: 'ok' }); }
      catch { JV.notify('Could not copy it. Select the code and copy it yourself.', { level: 'warn' }); }
    });
    $('compNew')?.addEventListener('click', async () => {
      if (!(await JV.confirm('Make a new access code? Your phone will need the new one, and the old one stops working at once.', { yes: 'Make a new code', danger: true }))) return;
      const r = await api.newCompanionCode().catch(() => null);
      $('compCodeBox').hidden = true;
      $('compStatus').textContent = r?.ok ? 'There is a new access code. Show it again to copy it.' : 'Could not make a new code.';
      refreshCompanion();
    });

    $('budgetSave')?.addEventListener('click', async () => {
      const r = await api.setBudget(Number($('budgetIn').value)).catch((e) => ({ ok: false, error: e.message }));
      $('budgetNote').textContent = r?.ok
        ? (r.budgetUsd ? `The daily limit is $${r.budgetUsd.toFixed(2)}.` : 'No daily limit.')
        : (r?.error || 'Could not save the limit.');
      refreshBudget();
    });
  }

  JV.initSettingsExtra = () => {
    tagSections();
    wire();
    markZoom(JV.prefs.zoom);
    if ($('prefContrast')) $('prefContrast').checked = !!JV.prefs.contrast;
    if ($('prefSpeak')) $('prefSpeak').checked = !!JV.prefs.speakReplies;
    if ($('prefWake')) $('prefWake').checked = !!JV.prefs.wakeWord;
    fillVoices();
    if (JV.voices && window.speechSynthesis) speechSynthesis.addEventListener?.('voiceschanged', fillVoices);
    // Each time Settings opens, the live values come from the app, not from memory.
    JV.settingsRefresh = () => {
      tagSections();
      fillVoices();
      refreshCompanion();
      refreshBudget();
      if ($('prefWake')) $('prefWake').checked = !!JV.prefs.wakeWord;
      if ($('prefContrast')) $('prefContrast').checked = !!JV.prefs.contrast;
      if ($('prefSpeak')) $('prefSpeak').checked = !!JV.prefs.speakReplies;
      markZoom(JV.prefs.zoom);
      showTab(tab);
    };
    void state;
  };
})();
