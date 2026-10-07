// Smoke test for the SDK bridge, without Electron.
//   node scripts/smoke.mjs A  - one tiny isolated turn (proves the login works through the SDK)
//   node scripts/smoke.mjs B  - a session in the workspace, stopped right after "init"
//                               (proves CLAUDE.md, agents and MCP servers load; no model turn).
//                               A workspace JARVIS does not trust gets your user settings only.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { requireWorkspace, workspaceTrusted } from './workspace.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const exe = path.join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe');
const cwd = requireWorkspace();
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const which = (process.argv[2] || 'A').toUpperCase();

const abort = new AbortController();
setTimeout(() => { log('TIMEOUT - aborting'); abort.abort(); }, 120000).unref();

try {
  if (which === 'A') {
    log('A) isolated turn, exe exists?', exe);
    for await (const m of query({
      prompt: 'Reply with exactly: JARVIS online',
      options: { pathToClaudeCodeExecutable: exe, settingSources: [], maxTurns: 1, cwd, abortController: abort,
                 stderr: (d) => log('stderr:', String(d).trim()) },
    })) {
      log('msg', m.type, m.subtype || '');
      if (m.type === 'system' && m.subtype === 'init') log('init: model', m.model, '| apiKeySource', m.apiKeySource, '| version', m.claude_code_version);
      if (m.type === 'assistant') for (const b of m.message.content) if (b.type === 'text') log('assistant:', b.text);
      if (m.type === 'result') log('result:', m.subtype, '| is_error', m.is_error, '| turns', m.num_turns);
    }
  } else {
    const trusted = workspaceTrusted();
    log(`B) the workspace's settings (init only)${trusted ? '' : ' - not trusted in JARVIS, so your user settings only'}`);
    async function* never() { await new Promise(() => {}); }
    const q = query({
      prompt: never(),
      options: {
        pathToClaudeCodeExecutable: exe, cwd, abortController: abort,
        settingSources: trusted ? ['user', 'project', 'local'] : ['user'],
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        stderr: (d) => log('stderr:', String(d).trim()),
      },
    });
    // "init" only arrives with the first user message in streaming-input mode,
    // so ask the control API directly instead.
    const agents = await q.supportedAgents();
    log('agents:', agents.length, agents.map(a => a.name).join(', '));
    const mcp = await q.mcpServerStatus();
    log('mcp:', mcp.map(s => `${s.name}=${s.status}`).join(', '));
    const models = await q.supportedModels();
    log('models:', models.map(m => m.value).join(', '));
    q.close();
  }
} catch (e) {
  log('ERROR:', e?.message || e);
}
log('done');
process.exit(0);
