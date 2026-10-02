// Voice notes from Telegram, turned into text on this PC.
//
// Claude does not take audio, so a voice note has to become words first, and the words
// should not leave this machine on the way: they are a prompt like any other. So it is all
// local - the Ogg/Opus note is decoded by a WebAssembly Opus decoder, and Whisper runs on
// the CPU through onnxruntime. The only network use is the one-time download of the model
// (about 250 MB, from Hugging Face) into %APPDATA%\JARVIS\models, on the first voice note.
//
// Loaded lazily: nothing here is imported until a voice note arrives, so a JARVIS that never
// gets one never pays for it.

const MODEL = 'onnx-community/whisper-small';
const RATE = 16000; // what Whisper listens at

/**
 * Down to one 16 kHz channel. Opus always decodes at 48 kHz, an exact 3:1, so each output
 * sample is the mean of three - a cheap low-pass as well as a decimation. Any other rate
 * falls back to linear interpolation.
 */
export function toMono16k(channels, rate) {
  const n = channels[0]?.length || 0;
  const mono = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) mono[i] += ch[i] / channels.length;
  if (rate === RATE) return mono;
  if (rate === RATE * 3) {
    const out = new Float32Array(Math.floor(n / 3));
    for (let i = 0; i < out.length; i++) out[i] = (mono[3 * i] + mono[3 * i + 1] + mono[3 * i + 2]) / 3;
    return out;
  }
  const ratio = rate / RATE;
  const out = new Float32Array(Math.floor(n / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio;
    const j = Math.floor(x);
    out[i] = mono[j] + ((mono[j + 1] ?? mono[j]) - mono[j]) * (x - j);
  }
  return out;
}

/**
 * @param o.cacheDir  where the model is kept
 * @param o.log       (...parts) => void
 */
export function createTranscriber({ cacheDir, log = () => {} }) {
  let asr = null;
  let loading = null;

  function load() {
    if (asr) return Promise.resolve(asr);
    if (!loading) {
      loading = (async () => {
        const t0 = Date.now();
        const { pipeline, env } = await import('@huggingface/transformers');
        env.cacheDir = cacheDir;
        env.allowLocalModels = false;
        asr = await pipeline('automatic-speech-recognition', MODEL, { dtype: 'q8', device: 'cpu' });
        log(`voice: speech model ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        return asr;
      })().catch((e) => { loading = null; throw e; });
    }
    return loading;
  }

  async function decodeOgg(buf) {
    const { OggOpusDecoder } = await import('ogg-opus-decoder');
    const d = new OggOpusDecoder();
    await d.ready;
    try {
      const r = await d.decodeFile(new Uint8Array(buf));
      return toMono16k(r.channelData, r.sampleRate);
    } finally { d.free(); }
  }

  return {
    /** The model is loaded - a voice note now takes seconds, not a download. */
    get ready() { return !!asr; },
    /**
     * An Ogg/Opus voice note (or 16 kHz mono samples, for tests) to text.
     * Resolves { ok, text } or { ok: false, error } - never throws.
     */
    async transcribe(input) {
      try {
        const audio = input instanceof Float32Array ? input : await decodeOgg(input);
        if (!audio.length) return { ok: false, error: 'The voice note was empty.' };
        const model = await load();
        const t0 = Date.now();
        const out = await model(audio, { chunk_length_s: 30, stride_length_s: 5, task: 'transcribe', return_timestamps: false });
        const text = String((Array.isArray(out) ? out.map((x) => x.text).join(' ') : out?.text) || '').replace(/\s+/g, ' ').trim();
        // Length and time only - never the words, which are a prompt.
        log(`voice: ${(audio.length / RATE).toFixed(1)}s of audio transcribed in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${text.length} chars`);
        return { ok: true, text };
      } catch (e) {
        log('voice: transcription failed:', e?.message || e);
        return { ok: false, error: String(e?.message || e).slice(0, 200) };
      }
    },
  };
}
