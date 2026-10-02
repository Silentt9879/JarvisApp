// Diagnostic only - never runs during normal use.
//
// The smallest possible SDK query, instrumented, so the same call can be compared across
// plain node, Electron in development and the packaged app. It asks for one word, with every
// tool denied and no MCP servers, and needs no git and no ClickUp - so if this stalls, the
// cause is the runtime, not anything the features on top of it do.
//
// It records WHEN each lifecycle step happened and safe runtime facts. It never records a
// credential, a token or the content of a real prompt.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createRequire } from 'node:module';
import fs from 'node:fs';

export async function runDiag({ exe, cwd, mode = 'string', settingSources = ['user'], timeoutMs = 90000 }) {
  const t0 = Date.now();
  const events = [];
  const mark = (name, detail) => events.push({ at: Date.now() - t0, name, ...(detail ? { detail } : {}) });

  let sdkPath = null;
  try { sdkPath = import.meta.resolve('@anthropic-ai/claude-agent-sdk'); } catch { /* not resolvable this way */ }
  if (!sdkPath) { try { sdkPath = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk'); } catch { /* ignore */ } }

  const runtime = {
    node: process.versions.node,
    electron: process.versions.electron || null,
    execPath: process.execPath,
    resourcesPath: process.resourcesPath || null,
    cwd,
    exe,
    exeExists: (() => { try { return fs.existsSync(exe); } catch { return false; } })(),
    sdkPath,
    mode,
    settingSources,
    platform: process.platform,
    // Only the presence of variables that change how a child behaves - never their values.
    env: Object.fromEntries(['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_ENTRYPOINT']
      .map((k) => [k, k in process.env ? 'set' : 'unset'])),
  };

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const PROMPT = 'Reply exactly: OK';
  async function* streamPrompt() {
    yield { type: 'user', message: { role: 'user', content: PROMPT }, parent_tool_use_id: null, session_id: '' };
  }

  let text = '';
  let timedOut = false;
  mark('query-created');
  let q;
  try {
    q = query({
      prompt: mode === 'stream' ? streamPrompt() : PROMPT,
      options: {
        cwd,
        pathToClaudeCodeExecutable: exe,
        settingSources,
        mcpServers: {},
        allowedTools: [],
        systemPrompt: 'Answer with exactly what is asked and nothing else.',
        permissionMode: 'default',
        env,
        canUseTool: async () => ({ behavior: 'deny', message: 'no tools in a diagnostic' }),
        stderr: (d) => mark('stderr', String(d).trim().slice(0, 160)),
      },
    });
  } catch (e) {
    mark('error-constructing', String(e?.message || e).slice(0, 200));
    return { ok: false, runtime, events, text };
  }

  const timer = setTimeout(() => { timedOut = true; mark('timeout'); try { q.close(); } catch { /* done */ } }, timeoutMs);
  const seen = new Set();
  try {
    for await (const m of q) {
      const key = m.subtype ? `${m.type}:${m.subtype}` : m.type;
      if (!seen.has(key)) { seen.add(key); mark(`first-${key}`); }
      if (m.type === 'assistant') for (const b of m.message?.content || []) if (b.type === 'text') text += b.text;
      if (m.type === 'result') { mark('result', m.subtype); break; }
    }
  } catch (e) {
    mark('error', String(e?.message || e).slice(0, 200));
  } finally {
    clearTimeout(timer);
    try { q.close(); } catch { /* done */ }
    mark('closed');
  }
  return { ok: !timedOut && /OK/.test(text), timedOut, text: text.trim().slice(0, 40), runtime, events };
}
