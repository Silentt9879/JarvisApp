/* The wake word, as pure logic: spotting "JARVIS" in a transcript, and cutting the microphone's
   sound into utterances by loudness. No audio or model in here, so it runs in the window and in
   the tests alike. Loaded as a classic script (window.WakeCore) and as a module (tests). */
(function (root) {
  'use strict';

  // The whole word only: "jarvis", "Jarvis," "hey jarvis" - not "jarvisation".
  const WORD = /(^|[^a-z])jarvis(?![a-z])/i;

  /** Does a transcript contain the wake word? */
  function hasWakeWord(text) {
    return WORD.test(String(text || ''));
  }

  /** What was said after the wake word ("hey JARVIS, open the repo" -> "open the repo"). */
  function afterWakeWord(text) {
    const s = String(text || '');
    const m = WORD.exec(s);
    if (!m) return '';
    return s.slice(m.index + m[0].length).replace(/^[\s,.:;!?-]+/, '').trim();
  }

  /**
   * Cut the sound into utterances. Feed it one loudness value (RMS, 0..1) per frame; it answers
   * 'start' when speech has gone on long enough to count, 'end' when it stops, and 'cut' when
   * someone has talked for too long to be a command (the caller then ends it).
   *
   * Quiet frames shorter than `silenceMs` do not end an utterance, so a pause to think does not
   * split a command in two.
   */
  function createSegmenter({ threshold = 0.02, minSpeechMs = 300, silenceMs = 800, maxMs = 8000, frameMs = 32 } = {}) {
    let state = 'idle';
    let speechMs = 0;
    let silentMs = 0;
    let totalMs = 0;
    return {
      get state() { return state; },
      push(rms) {
        const loud = Number(rms) >= threshold;
        if (state === 'idle') {
          speechMs = loud ? speechMs + frameMs : 0;
          if (speechMs >= minSpeechMs) {
            state = 'speaking';
            silentMs = 0;
            totalMs = speechMs;
            return 'start';
          }
          return null;
        }
        totalMs += frameMs;
        if (loud) silentMs = 0;
        else silentMs += frameMs;
        if (silentMs >= silenceMs) {
          state = 'idle';
          speechMs = 0;
          silentMs = 0;
          return 'end';
        }
        if (totalMs >= maxMs) {
          state = 'idle';
          speechMs = 0;
          silentMs = 0;
          return 'cut';
        }
        return null;
      },
      reset() { state = 'idle'; speechMs = 0; silentMs = 0; totalMs = 0; },
    };
  }

  const api = { hasWakeWord, afterWakeWord, createSegmenter };
  root.WakeCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
