/* JARVIS window - voice. Replies can be read aloud with the voices Windows already has. Saying
   "JARVIS" can start a request hands-free. Listening happens on this PC only: the speech model is
   the one voice notes use, the sound is cut into short pieces and not kept, and nothing is sent
   anywhere. The microphone is only open while this switch is on. */
(() => {
  'use strict';
  const { $, state } = JV;
  const api = window.jarvis;
  const WC = window.WakeCore;

  // ------------------------------------------------------------- reading replies aloud

  const hasSpeech = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  let voices = [];
  function loadVoices() { voices = hasSpeech ? speechSynthesis.getVoices() : []; }
  if (hasSpeech) {
    loadVoices();
    speechSynthesis.addEventListener?.('voiceschanged', loadVoices);
  }

  /** Markdown and code read badly aloud: keep the words, drop the punctuation that is only layout. */
  function plain(text) {
    return String(text || '')
      .replace(/```[\s\S]*?```/g, ' (code) ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[*_#>~|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  JV.voices = () => voices.map((v) => ({ uri: v.voiceURI, name: v.name, lang: v.lang }));

  JV.speak = (text) => {
    if (!hasSpeech) return false;
    const t = plain(text).slice(0, 2000);
    if (!t) return false;
    const u = new SpeechSynthesisUtterance(t);
    const chosen = voices.find((v) => v.voiceURI === JV.prefs.voiceURI);
    if (chosen) { u.voice = chosen; u.lang = chosen.lang; }
    u.rate = 1;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
    return true;
  };
  JV.stopSpeaking = () => { if (hasSpeech) speechSynthesis.cancel(); };

  // The whole reply is read at the end of the turn, not in pieces between tool steps.
  let replyParts = [];
  JV.on('text_final', (e) => { if (!e.parent && e.text) replyParts.push(e.text); });
  JV.on('user_sent', () => { replyParts = []; JV.stopSpeaking(); });
  JV.on('result', () => {
    const said = replyParts.join('\n\n');
    replyParts = [];
    if (JV.prefs.speakReplies && said) JV.speak(said);
  });

  // ------------------------------------------------------------- the wake word

  const wake = {
    on: false,
    stream: null,
    ctx: null,
    proc: null,
    seg: null,
    ring: [],
    collecting: null,
    busy: false,
    armedUntil: 0,
  };
  const PRE_ROLL_MS = 400;
  const THRESHOLD = 0.02;

  function setHint(text) {
    const hint = $('hint');
    if (hint && (wake.on || hint.dataset.wake)) {
      hint.textContent = text;
      hint.dataset.wake = text ? '1' : '';
    }
  }

  function chip(stateName) {
    const text = {
      listening: 'Listening for “JARVIS”',
      armed: 'Go on, sir…',
      heard: 'Heard you',
      thinking: 'Understanding…',
    }[stateName] || '';
    setHint(text);
  }

  function concat(chunks) {
    const n = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Float32Array(n);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  }

  /** Linear resampling to the 16 kHz the speech model expects. */
  function to16k(data, rate) {
    if (rate === 16000) return data;
    const ratio = rate / 16000;
    const n = Math.floor(data.length / ratio);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, data.length - 1);
      const f = pos - i0;
      out[i] = data[i0] * (1 - f) + data[i1] * f;
    }
    return out;
  }

  function beep() {
    try {
      const c = new (window.AudioContext || window.webkitAudioContext)();
      const o = c.createOscillator();
      const g = c.createGain();
      o.frequency.value = 880;
      g.gain.value = 0.05;
      o.connect(g);
      g.connect(c.destination);
      o.start();
      o.stop(c.currentTime + 0.12);
      setTimeout(() => c.close(), 300);
    } catch { /* no sound is fine */ }
  }

  function trimRing(rate) {
    let total = wake.ring.reduce((s, c) => s + c.length, 0);
    while (wake.ring.length && total > rate * PRE_ROLL_MS / 1000) {
      total -= wake.ring.shift().length;
    }
  }

  async function handleUtterance(chunks, rate) {
    if (wake.busy || !wake.on) return;
    const total = chunks.reduce((n, c) => n + c.length, 0);
    if (total < rate * 0.4) return;
    wake.busy = true;
    chip('thinking');
    try {
      const pcm = to16k(concat(chunks), rate);
      const r = await api.transcribePcm(pcm);
      if (!r?.ok || !r.text) return;
      const text = r.text;
      if (WC.hasWakeWord(text)) {
        beep();
        const rest = WC.afterWakeWord(text);
        if (rest) { chip('heard'); JV.chat.submit(rest); }
        else { wake.armedUntil = Date.now() + 9000; chip('armed'); }
      } else if (Date.now() < wake.armedUntil) {
        wake.armedUntil = 0;
        chip('heard');
        JV.chat.submit(text);
      }
    } catch (e) {
      JV.notify(`Voice: ${e?.message || 'could not understand that'}`, { level: 'warn' });
    } finally {
      wake.busy = false;
      if (wake.on) chip(Date.now() < wake.armedUntil ? 'armed' : 'listening');
    }
  }

  async function startListening() {
    if (wake.on) return { ok: true };
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
      return { ok: false, error: 'This window cannot reach a microphone.' };
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      return { ok: false, error: e?.name === 'NotAllowedError' ? 'Windows is not letting JARVIS use the microphone. Allow it in Windows settings, then try again.' : 'The microphone could not be opened.' };
    }
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(1024, 1, 1);
    const frameMs = (1024 / ctx.sampleRate) * 1000;
    wake.seg = WC.createSegmenter({ threshold: THRESHOLD, minSpeechMs: 300, silenceMs: 900, maxMs: 9000, frameMs });
    proc.onaudioprocess = (ev) => {
      if (!wake.on) return;
      const input = ev.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
      const rms = Math.sqrt(sum / input.length);
      const copy = new Float32Array(input);
      if (wake.seg.state !== 'speaking') {
        wake.ring.push(copy);
        trimRing(ctx.sampleRate);
      } else {
        wake.collecting.push(copy);
      }
      const event = wake.seg.push(rms);
      if (event === 'start') {
        wake.collecting = [...wake.ring];
        wake.ring = [];
      } else if (event === 'end' || event === 'cut') {
        const chunks = wake.collecting || [];
        wake.collecting = null;
        handleUtterance(chunks, ctx.sampleRate);
      }
    };
    // The processor has to reach the speakers to run, but at zero volume, so nothing is played back.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(proc);
    proc.connect(mute);
    mute.connect(ctx.destination);
    Object.assign(wake, { stream, ctx, proc, on: true, ring: [], collecting: null, armedUntil: 0 });
    chip('listening');
    return { ok: true };
  }

  function stopListening() {
    if (!wake.on) return;
    wake.on = false;
    try { wake.proc?.disconnect(); } catch { /* already gone */ }
    try { wake.stream?.getTracks().forEach((t) => t.stop()); } catch { /* already gone */ }
    try { wake.ctx?.close(); } catch { /* already gone */ }
    wake.stream = null;
    wake.ctx = null;
    wake.proc = null;
    if ($('hint')?.dataset.wake) { $('hint').textContent = ''; $('hint').dataset.wake = ''; }
  }

  /** Switch hands-free listening on or off. Returns { ok, error } for the Settings switch to show. */
  JV.setWakeWord = async (on) => {
    if (!on) { stopListening(); return { ok: true }; }
    return startListening();
  };
  JV.wakeListening = () => wake.on;

  JV.initVoice = () => {
    if (JV.prefs.wakeWord) {
      JV.setWakeWord(true).then((r) => {
        if (!r.ok) { JV.prefs.wakeWord = false; JV.savePrefs(); JV.notify(r.error, { level: 'warn' }); }
      });
    }
    window.addEventListener('beforeunload', stopListening);
  };
})();
