/* JARVIS window - one phone's live screen: H.264 from scrcpy, decoded with WebCodecs onto a
   canvas, and the canvas turned into touches, scrolls, keys and typing on the phone.

   Shared by the Devices view and the pop-out phone window (phone.html), so a phone behaves
   the same wherever it is shown. Loaded after core.js; exposes JV.phone. */
(() => {
  'use strict';

  /** avc1.PPCCLL from the SPS in scrcpy's configuration packet (Annex B). */
  function h264Codec(b) {
    const hex = (v) => v.toString(16).padStart(2, '0');
    for (let i = 0; i + 6 < b.length; i++) {
      if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1 && (b[i + 3] & 0x1f) === 7) return `avc1.${hex(b[i + 4])}${hex(b[i + 5])}${hex(b[i + 6])}`;
    }
    return null;
  }
  function concat(a, b) { const out = new Uint8Array(a.length + b.length); out.set(a, 0); out.set(b, a.length); return out; }

  /**
   * A decoder for one phone's packets. `onFirstFrame` runs when a picture first appears.
   * A screen joining a stream that is already running has no configuration packet yet: it
   * asks the phone for a fresh one (resetVideo), so it never waits on the next natural keyframe.
   */
  function makeScreen(serial, canvas, onFirstFrame) {
    const ctx = canvas.getContext('2d', { alpha: false });
    let decoder = null;
    let config = null;
    let needKey = true;
    let askedAt = 0;
    let shown = false;
    // Out of step (decoder error, or it fell behind): wait for a keyframe and ask for one.
    const resync = () => {
      needKey = true;
      if (Date.now() - askedAt > 1500) { askedAt = Date.now(); window.jarvis.resetVideo(serial); }
    };
    function configure(cfg) {
      const codec = h264Codec(cfg);
      if (!codec || typeof VideoDecoder === 'undefined') return;
      try { decoder?.close(); } catch { /* already closed */ }
      decoder = new VideoDecoder({
        output: (frame) => {
          if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
            canvas.width = frame.displayWidth;
            canvas.height = frame.displayHeight;
          }
          ctx.drawImage(frame, 0, 0);
          frame.close();
          if (!shown) { shown = true; onFirstFrame(); }
        },
        error: () => resync(),
      });
      decoder.configure({ codec, optimizeForLatency: true });
      config = cfg;
      needKey = true;
    }
    return {
      packet(p) {
        if (p.type === 'configuration') { configure(p.data); return; }
        if (!decoder || decoder.state !== 'configured') return;
        if (needKey && !p.keyframe) return;
        if (decoder.decodeQueueSize > 24) { resync(); return; }
        try {
          // Annex B without a description: the SPS/PPS travel in front of each keyframe.
          decoder.decode(new EncodedVideoChunk({ type: p.keyframe ? 'key' : 'delta', timestamp: p.pts || 0, data: p.keyframe && config ? concat(config, p.data) : p.data }));
          if (p.keyframe) needKey = false;
        } catch { resync(); }
      },
      /** Ask for a fresh configuration + keyframe - for a screen joining a running stream. */
      resync() { askedAt = 0; resync(); },
      close() { try { decoder?.close(); } catch { /* closed */ } decoder = null; shown = false; },
    };
  }

  /**
   * Click to tap, drag to swipe, wheel to scroll, keys and typing while the canvas is
   * selected (Esc is Back). `live()` says whether the phone is streaming; `send(ev)` delivers.
   */
  function wireInput(canvas, { live, send }) {
    const cv = canvas;
    const at = (e) => {
      const r = cv.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * cv.width, y: ((e.clientY - r.top) / r.height) * cv.height, w: cv.width, h: cv.height };
    };
    let down = false;
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !live()) return;
      cv.focus();
      cv.setPointerCapture(e.pointerId);
      down = true;
      send({ kind: 'touch', action: 'down', ...at(e) });
      e.preventDefault();
    });
    cv.addEventListener('pointermove', (e) => { if (down) send({ kind: 'touch', action: 'move', ...at(e) }); });
    const up = (e) => { if (!down) return; down = false; send({ kind: 'touch', action: 'up', ...at(e) }); };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', (e) => {
      if (!live()) return;
      e.preventDefault();
      send({ kind: 'scroll', ...at(e), dx: -Math.sign(e.deltaX), dy: -Math.sign(e.deltaY) });
    }, { passive: false });
    const KEYS = { Enter: 'enter', Backspace: 'backspace', Tab: 'tab', Delete: 'delete', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Escape: 'back' };
    cv.addEventListener('keydown', (e) => {
      if (!live()) return;
      if (KEYS[e.key]) { e.preventDefault(); e.stopPropagation(); send({ kind: 'key', key: KEYS[e.key] }); return; }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); send({ kind: 'text', text: e.key }); }
    });
  }

  JV.phone = { makeScreen, wireInput, h264Codec };
})();
