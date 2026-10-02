// End-to-end test of JarvisSession without the window: one message that needs a
// harmless shell command; every permission request is answered "allow once".
import { JarvisSession } from '../src/session.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const exe = path.join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe');
const t0 = Date.now();
const ts = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;

let s;
let done = false;
const emit = (e) => {
  if (e.kind === 'text_delta') return; // too noisy; text_final shows the text
  const short = { ...e };
  if (short.preview) short.preview = short.preview.slice(0, 120);
  if (short.list) short.list = short.list.map((x) => x.name || x.value).join(', ');
  console.log(ts(), JSON.stringify(short));
  if (e.kind === 'permission') setTimeout(() => s.respond(e.id, { type: 'allow' }), 50);
  if (e.kind === 'result') { done = true; setTimeout(() => { s.close(); process.exit(0); }, 300); }
};
s = new JarvisSession({ cwd: 'C:\\Users\\bantu\\Downloads\\BantuApps', exe, emit, log: (...a) => console.log(ts(), 'LOG', ...a.map(String).map((x) => x.slice(0, 200))) });
s.start({});
setTimeout(() => s.send('Bridge test from the JARVIS desktop app: run the shell command `echo jarvis-bridge-ok` and reply in one short sentence with its output.'), 500);
setTimeout(() => { if (!done) { console.log(ts(), 'TIMEOUT'); s.close(); process.exit(1); } }, 150000);
