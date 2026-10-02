// JarvisSession - one live Claude Code conversation, driven through the official
// Claude Agent SDK. It turns SDK messages into small UI events (emit) and turns
// permission requests into prompts the window answers (respond).
//
// The SDK runs Claude Code itself, in the BantuApps folder, with the same
// CLAUDE.md, agents, skills, hooks and MCP servers as the terminal and VS Code.
import { query, listSessions, getSessionMessages, deleteSession, renameSession } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** An async-iterable queue: the SDK reads the user's messages from it. */
class InputQueue {
  constructor() { this.items = []; this.waiters = []; this.closed = false; }
  push(v) {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false }); else this.items.push(v);
  }
  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
      return: () => { this.close(); return Promise.resolve({ value: undefined, done: true }); },
    };
  }
}

const clip = (s, n) => (s == null ? '' : String(s).length > n ? String(s).slice(0, n) + '…' : String(s));

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
/** The API takes images up to 5 MB base64-encoded, which is about 3.75 MB of file. */
export const MAX_IMAGE_BYTES = 3.75 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;

/** One short line describing what a tool call will do - for activity rows and prompts. */
export function describeTool(name, input = {}) {
  switch (name) {
    case 'Bash':
    case 'PowerShell': return clip(input.command, 400);
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit': return clip(input.file_path || input.notebook_path, 300);
    case 'Grep': return clip(`${input.pattern}${input.path ? '  in ' + input.path : ''}`, 300);
    case 'Glob': return clip(input.pattern, 300);
    case 'WebFetch': return clip(input.url, 300);
    case 'WebSearch': return clip(input.query, 300);
    case 'Agent':
    case 'Task': return clip(`${input.subagent_type || 'agent'}: ${input.description || ''}`, 300);
    case 'Skill': return clip(input.skill, 200);
    case 'TodoWrite': return `${(input.todos || []).length} items`;
    case 'TaskCreate': return clip(input.subject, 200);
    case 'TaskUpdate': return clip(`#${input.taskId}${input.status ? ' -> ' + input.status : ''}${input.subject ? ' ' + input.subject : ''}`, 200);
    default: {
      try { return clip(JSON.stringify(input), 240); } catch { return ''; }
    }
  }
}

/** Text of a tool_result block, whatever its content shape. */
function resultText(block) {
  const c = block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (p && p.type === 'text' ? p.text : '')).filter(Boolean).join('\n');
  return '';
}

/** Strip the harness's own tags (system reminders etc.) from a user message for display. */
function cleanUserText(t) {
  return String(t || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<(command-[a-z-]+|local-command-[a-z-]+|ide_[a-z_]+)>[\s\S]*?<\/\1>/g, '')
    .trim();
}

/**
 * Build the message content from the window's text and attachments.
 * Images go to the model as image blocks; other files are named by path so
 * JARVIS reads them with its own (permission-checked) tools.
 */
export function buildContent(text, attachments = []) {
  const t = String(text || '').trim();
  const list = Array.isArray(attachments) ? attachments.slice(0, MAX_ATTACHMENTS) : [];
  const files = list.filter((a) => a && a.kind === 'file' && typeof a.path === 'string' && a.path.length < 1024);
  const images = list.filter((a) => a && a.kind === 'image');
  for (const img of images) {
    if (!IMAGE_TYPES.includes(img.mediaType)) throw new Error(`${img.name || 'An image'} is not a PNG, JPEG, GIF or WebP.`);
    if (typeof img.data !== 'string' || !/^[A-Za-z0-9+/=\r\n]+$/.test(img.data.slice(0, 200))) throw new Error(`${img.name || 'An image'} could not be read.`);
    if (img.data.length * 0.75 > MAX_IMAGE_BYTES) throw new Error(`${img.name || 'An image'} is larger than 3.75 MB.`);
  }
  let body = t;
  if (files.length) body += `${body ? '\n\n' : ''}Attached file${files.length > 1 ? 's' : ''}:\n${files.map((f) => `- ${f.path}`).join('\n')}`;
  if (!images.length) return body;
  const blocks = [];
  if (body) blocks.push({ type: 'text', text: body });
  for (const img of images) blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
  return blocks;
}

export class JarvisSession {
  /**
   * @param {{cwd:string, exe:string, emit:(e:object)=>void, log:(...a:any[])=>void}} deps
   */
  constructor({ cwd, exe, emit, log }) {
    this.cwd = cwd;
    this.exe = exe;
    this.emit = emit;
    this.log = log;
    this.q = null;
    this.input = null;
    this.abort = null;
    this.pending = new Map();
    this.sessionId = null;
    this.running = false;
    this.stateEvents = false; // Claude Code reports running / idle itself (session_state_changed)
    this.commandNames = new Set();
    this.generation = 0;
    this.tasks = new Map();     // task id -> { id, subject, status, activeForm }
    this.taskCalls = new Map(); // tool_use id -> { name, input } for the task tools
  }

  start({ resume } = {}) {
    this.close();
    const gen = ++this.generation;
    this.input = new InputQueue();
    this.abort = new AbortController();
    this.sessionId = resume || null;
    this.stateEvents = false;
    this.commandNames = new Set();
    this.tasks.clear();
    this.taskCalls.clear();
    this.emit({ kind: 'status', state: 'starting' });
    this.emit({ kind: 'tasks', list: [] });

    const options = {
      cwd: this.cwd,
      pathToClaudeCodeExecutable: this.exe,
      // Same configuration as the terminal: user + project + local settings,
      // which also brings in CLAUDE.md, .claude/agents, skills, hooks and MCP.
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      includePartialMessages: true,
      permissionMode: 'default',
      // Backups of every file Claude edits, so a message's changes can be undone (rewindFiles).
      enableFileCheckpointing: true,
      // session_state_changed: the reliable "turn over" signal when messages were queued.
      env: { ...process.env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' },
      abortController: this.abort,
      canUseTool: (toolName, input, opts) => this.#askPermission(gen, toolName, input, opts),
      stderr: (d) => this.log('[claude stderr]', String(d).trim()),
      ...(resume ? { resume } : {}),
    };

    let q;
    try {
      q = query({ prompt: this.input, options });
    } catch (e) {
      // Status first: the error card offers a restart only when the session is closed.
      this.emit({ kind: 'status', state: 'closed' });
      this.emit({ kind: 'error', message: `Could not start Claude Code: ${e?.message || e}` });
      return;
    }
    this.q = q;
    this.#consume(q, gen);
    this.#loadMeta(q, gen);
    this.emit({ kind: 'status', state: 'ready' });
  }

  /** Queue a user message. `payload` is text, or { text, attachments }. */
  send(payload) {
    const p = typeof payload === 'string' ? { text: payload } : (payload || {});
    let content;
    try { content = buildContent(p.text, p.attachments); } catch (e) { return { ok: false, error: e.message }; }
    if (!content || (Array.isArray(content) && !content.length)) return { ok: false, error: 'Nothing to send.' };
    if (!this.input) return { ok: false, error: 'The session is not running.' };
    // Our own id for the message: file checkpoints are keyed by it, so it is what rewindFiles takes.
    const uuid = randomUUID();
    this.input.push({
      type: 'user',
      uuid,
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: this.sessionId || '',
    });
    this.running = true;
    this.emit({ kind: 'status', state: 'working' });
    return { ok: true, uuid };
  }

  /** Put files back as they were before a user message. dryRun lists what would change. */
  async rewindFiles(uuid, dryRun) {
    if (!this.q) return { canRewind: false, error: 'The session is not running.' };
    try { return await this.q.rewindFiles(uuid, { dryRun: !!dryRun }); }
    catch (e) { this.log('rewindFiles failed', e?.message || e); return { canRewind: false, error: e?.message || String(e) }; }
  }

  /** Whether this session's Claude Code accepts /rename (it keeps the title in memory too). */
  get canRenameLive() { return !!this.q && this.commandNames.has('rename'); }

  async interrupt() {
    if (!this.q) return;
    try { await this.q.interrupt(); } catch (e) { this.log('interrupt failed', e?.message || e); }
  }

  async setModel(model) {
    if (!this.q) return;
    try {
      await this.q.setModel(model || undefined);
      this.emit({ kind: 'model', model });
      this.refreshContext();
    } catch (e) { this.emit({ kind: 'error', message: `Could not switch model: ${e?.message || e}` }); }
  }

  async setPermissionMode(mode) {
    if (!this.q) return;
    try { await this.q.setPermissionMode(mode); this.emit({ kind: 'mode', mode }); }
    catch (e) { this.emit({ kind: 'error', message: `Could not change mode: ${e?.message || e}` }); }
  }

  /** Effort for the following replies - session only, like /effort without saving. */
  async setEffort(level) {
    if (!this.q) return;
    const v = EFFORTS.includes(level) ? level : null; // null = the model's default
    try { await this.q.applyFlagSettings({ effortLevel: v }); this.emit({ kind: 'effort', level: v }); }
    catch (e) { this.emit({ kind: 'error', message: `Could not change effort: ${e?.message || e}` }); }
  }

  /** Extended thinking on or off for this session (session-scoped flag, not saved). */
  async setThinking(on) {
    if (!this.q) return;
    try { await this.q.applyFlagSettings({ alwaysThinkingEnabled: !!on }); this.emit({ kind: 'thinking', on: !!on }); }
    catch (e) { this.emit({ kind: 'error', message: `Could not change thinking: ${e?.message || e}` }); }
  }

  /** How full the context window is. 'summary' is local and cheap; 'full' counts precisely. */
  async refreshContext(detail = 'summary') {
    const q = this.q;
    if (!q) return;
    try {
      const u = await q.getContextUsage({ detail });
      if (q !== this.q) return;
      this.emit({
        kind: 'context',
        detail,
        percentage: u.percentage,
        totalTokens: u.totalTokens,
        maxTokens: u.maxTokens,
        model: u.model,
        categories: (u.categories || []).map((c) => ({ name: c.name, tokens: c.tokens, color: c.color, kind: c.kind })),
        memoryFiles: (u.memoryFiles || []).map((f) => ({ path: f.path, type: f.type, tokens: f.tokens })),
        agents: (u.agents || []).length,
        mcpTools: (u.mcpTools || []).length,
      });
    } catch (e) { this.log('getContextUsage failed', e?.message || e); }
  }

  /** The window's answer to a permission prompt or a question. */
  respond(id, decision) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    const d = decision || {};
    if (d.type === 'answer') {
      entry.resolve({ behavior: 'allow', updatedInput: { ...entry.input, answers: d.answers || {} } });
    } else if (d.type === 'allow' || d.type === 'allow_always') {
      // "Allow for this session" means this session. Claude Code's suggestions can point at
      // settings files (localSettings = .claude/settings.local.json), which would make the
      // rule permanent and apply to the terminal and VS Code as well - so keep them here.
      const updatedPermissions = d.type === 'allow_always' && entry.suggestions?.length
        ? entry.suggestions.map((s) => ({ ...s, destination: 'session' }))
        : null;
      entry.resolve({ behavior: 'allow', updatedInput: entry.input, ...(updatedPermissions ? { updatedPermissions } : {}) });
    } else {
      entry.resolve({ behavior: 'deny', message: d.message || 'The user declined this action.' });
    }
    this.emit({ kind: 'prompt_done', id });
    this.#afterPrompt();
  }

  /** Once the last open prompt is answered, the status goes back from "waiting" to "working". */
  #afterPrompt() {
    if (this.pending.size === 0 && this.running) this.emit({ kind: 'status', state: 'working' });
  }

  close() {
    this.generation++;
    for (const [id, e] of this.pending) {
      e.resolve({ behavior: 'deny', message: 'Session closed.' });
      this.emit({ kind: 'prompt_done', id });
    }
    this.pending.clear();
    try { this.input?.close(); } catch { /* already closed */ }
    try { this.q?.close(); } catch { /* already closed */ }
    try { this.abort?.abort(); } catch { /* already aborted */ }
    this.q = null;
    this.input = null;
    this.running = false;
  }

  // ---------------------------------------------------------------- internals

  #askPermission(gen, toolName, input, opts = {}) {
    return new Promise((resolve) => {
      if (gen !== this.generation) { resolve({ behavior: 'deny', message: 'Session closed.' }); return; }
      const id = opts.toolUseID || randomUUID();
      this.pending.set(id, { resolve, input, suggestions: opts.suggestions });
      opts.signal?.addEventListener('abort', () => {
        if (this.pending.delete(id)) {
          resolve({ behavior: 'deny', message: 'Cancelled.' });
          this.emit({ kind: 'prompt_done', id });
          this.#afterPrompt();
        }
      }, { once: true });

      if (toolName === 'AskUserQuestion') {
        this.emit({ kind: 'question', id, questions: Array.isArray(input?.questions) ? input.questions : [] });
      } else {
        this.emit({
          kind: 'permission',
          id,
          toolName,
          title: opts.title || null,
          displayName: opts.displayName || null,
          description: opts.description || null,
          reason: opts.decisionReason || null,
          detail: describeTool(toolName, input),
          blockedPath: opts.blockedPath || null,
          canAlways: !!(opts.suggestions && opts.suggestions.length) && !opts.suppressAlwaysAllowRule,
          defaultToNo: !!opts.defaultToNo,
          fromAgent: !!opts.agentID,
        });
      }
      this.emit({ kind: 'status', state: 'waiting' });
    });
  }

  async #consume(q, gen) {
    try {
      for await (const m of q) {
        if (gen !== this.generation) break;
        this.#handle(m);
      }
      if (gen === this.generation) {
        this.running = false;
        this.emit({ kind: 'status', state: 'closed' });
      }
    } catch (e) {
      if (gen !== this.generation) return;
      this.running = false;
      // Status first: the error card offers a restart only when the session is closed.
      this.emit({ kind: 'status', state: 'closed' });
      if (!this.abort?.signal.aborted) {
        this.log('session error', e?.stack || e);
        this.emit({ kind: 'error', message: `The session stopped: ${e?.message || e}` });
      }
    }
  }

  async #loadMeta(q, gen) {
    const live = () => gen === this.generation;
    try {
      const init = await q.initializationResult();
      if (live()) {
        this.commandNames = new Set((init.commands || []).map((c) => c.name));
        const a = init.account || {};
        this.emit({ kind: 'account', email: a.email || null, organization: a.organization || null, subscriptionType: a.subscriptionType || null, apiProvider: a.apiProvider || null, apiKeySource: a.apiKeySource || null });
        this.emit({ kind: 'commands', list: (init.commands || []).map((c) => ({ name: c.name, description: c.description || '', argumentHint: c.argumentHint || '', builtin: !!c.builtin })) });
      }
    } catch (e) { if (live()) this.log('initializationResult failed', e?.message || e); }
    try {
      const agents = await q.supportedAgents();
      if (live()) this.emit({ kind: 'agents', list: agents.map((a) => ({ name: a.name, description: a.description })) });
    } catch (e) { if (live()) this.log('supportedAgents failed', e?.message || e); }
    try {
      const models = await q.supportedModels();
      if (live()) {
        this.emit({
          kind: 'models',
          list: models.map((m) => ({
            value: m.value,
            resolved: m.resolvedModel || null,
            name: m.displayName || m.value,
            description: m.description || '',
            efforts: m.supportsEffort ? (m.supportedEffortLevels || EFFORTS) : [],
            auto: !!m.supportsAutoMode,
          })),
        });
      }
    } catch (e) { if (live()) this.log('supportedModels failed', e?.message || e); }
    if (live()) this.refreshContext();

    // MCP servers connect in the background; poll until none is still pending.
    let tries = 0;
    const poll = async () => {
      if (!live()) return;
      try {
        const s = await q.mcpServerStatus();
        if (!live()) return;
        this.emit({
          kind: 'mcp',
          list: s.map((x) => ({
            name: x.name,
            status: x.status,
            error: x.error ? clip(x.error, 200) : null,
            version: x.serverInfo?.version || null,
            scope: x.scope || null,
            tools: (x.tools || []).map((t) => ({ name: t.name, description: clip(t.description || '', 200), readOnly: !!t.annotations?.readOnly, destructive: !!t.annotations?.destructive })),
          })),
        });
        if (s.some((x) => x.status === 'pending') && ++tries < 20) setTimeout(poll, 3000);
      } catch (e) { this.log('mcpServerStatus failed', e?.message || e); }
    };
    poll();
  }

  #emitTasks() {
    this.emit({ kind: 'tasks', list: [...this.tasks.values()] });
  }

  /** Track the task list from TodoWrite, or from TaskCreate / TaskUpdate / TaskList. */
  #taskUse(b) {
    if (b.name === 'TodoWrite' && Array.isArray(b.input?.todos)) {
      this.tasks.clear();
      b.input.todos.forEach((t, i) => this.tasks.set(`todo-${i}`, { id: `todo-${i}`, subject: t.content, status: t.status, activeForm: t.activeForm || '' }));
      this.#emitTasks();
    } else if (b.name === 'TaskCreate' || b.name === 'TaskUpdate' || b.name === 'TaskList') {
      this.taskCalls.set(b.id, { name: b.name, input: b.input || {} });
    }
  }

  #taskResult(b, structured) {
    const call = this.taskCalls.get(b.tool_use_id);
    if (!call) return;
    this.taskCalls.delete(b.tool_use_id);
    if (b.is_error) return;
    const s = structured && typeof structured === 'object' ? structured : {};
    if (call.name === 'TaskCreate') {
      const id = String(s.task?.id || (/#(\d+)/.exec(resultText(b)) || [])[1] || b.tool_use_id);
      this.tasks.set(id, { id, subject: s.task?.subject || call.input.subject || 'Task', status: 'pending', activeForm: call.input.activeForm || '' });
    } else if (call.name === 'TaskUpdate') {
      const id = String(call.input.taskId);
      const t = this.tasks.get(id) || { id, subject: call.input.subject || `Task ${id}`, status: 'pending', activeForm: '' };
      if (call.input.status === 'deleted') { this.tasks.delete(id); this.#emitTasks(); return; }
      if (call.input.status) t.status = call.input.status;
      if (call.input.subject) t.subject = call.input.subject;
      if (call.input.activeForm) t.activeForm = call.input.activeForm;
      this.tasks.set(id, t);
    } else if (call.name === 'TaskList' && Array.isArray(s.tasks)) {
      const old = this.tasks;
      this.tasks = new Map(s.tasks.map((t) => [String(t.id), { id: String(t.id), subject: t.subject, status: t.status, activeForm: old.get(String(t.id))?.activeForm || '' }]));
    }
    this.#emitTasks();
  }

  #handle(m) {
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          this.sessionId = m.session_id;
          this.emit({
            kind: 'init',
            sessionId: m.session_id,
            model: m.model,
            permissionMode: m.permissionMode,
            version: m.claude_code_version,
            cwd: m.cwd,
            effort: m.effort ?? null,
            tools: Array.isArray(m.tools) ? m.tools : [],
            skills: Array.isArray(m.skills) ? m.skills : [],
            plugins: (m.plugins || []).map((p) => p.name),
            outputStyle: m.output_style || null,
          });
        } else if (m.subtype === 'compact_boundary') {
          this.emit({ kind: 'notice', text: 'The conversation was compacted to free up context.' });
          this.refreshContext();
        } else if (m.subtype === 'local_command_output') {
          this.emit({ kind: 'command_output', text: String(m.content || '') });
        } else if (m.subtype === 'session_state_changed') {
          // Authoritative: 'idle' only once every queued message has been answered.
          this.stateEvents = true;
          if (m.state === 'idle') {
            this.running = false;
            this.emit({ kind: 'status', state: 'ready' });
          } else {
            this.running = true;
            this.emit({ kind: 'status', state: m.state === 'requires_action' || this.pending.size ? 'waiting' : 'working' });
          }
        }
        return;

      case 'stream_event': {
        if (m.parent_tool_use_id) return; // subagent streams are summarised, not streamed
        const ev = m.event || {};
        if (ev.type === 'content_block_start' && ev.content_block?.type === 'text') this.emit({ kind: 'text_start' });
        else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') this.emit({ kind: 'text_delta', text: ev.delta.text });
        return;
      }

      case 'assistant': {
        const parent = m.parent_tool_use_id || null;
        for (const b of m.message?.content || []) {
          if (b.type === 'text') {
            if (!parent) this.emit({ kind: 'text_final', text: b.text });
          } else if (b.type === 'tool_use') {
            const isAgent = b.name === 'Agent' || b.name === 'Task';
            if (!parent) this.#taskUse(b);
            this.emit({
              kind: 'tool_use',
              id: b.id,
              name: b.name,
              detail: describeTool(b.name, b.input),
              parent,
              agent: isAgent ? (b.input?.subagent_type || 'general-purpose') : null,
              agentTask: isAgent ? clip(b.input?.description || '', 160) : null,
            });
          }
        }
        return;
      }

      case 'user': {
        const content = m.message?.content;
        if (!Array.isArray(content)) return;
        for (const b of content) {
          if (b.type === 'tool_result') {
            if (!m.parent_tool_use_id) this.#taskResult(b, m.tool_use_result);
            this.emit({
              kind: 'tool_result',
              id: b.tool_use_id,
              isError: !!b.is_error,
              preview: clip(resultText(b), 4000),
              parent: m.parent_tool_use_id || null,
            });
          }
        }
        return;
      }

      case 'result':
        // Without state events (older Claude Code), a result is the best "turn over" signal.
        if (!this.stateEvents) this.running = false;
        this.emit({
          kind: 'result',
          ok: m.subtype === 'success' && !m.is_error,
          subtype: m.subtype,
          durationMs: m.duration_ms,
          costUsd: m.total_cost_usd,
          turns: m.num_turns,
          errors: m.errors || (m.is_error && m.result ? [m.result] : []),
        });
        if (!this.stateEvents) this.emit({ kind: 'status', state: 'ready' });
        this.refreshContext();
        return;

      default:
        return;
    }
  }
}

/** Recent sessions in this folder - terminal, VS Code and app sessions alike. */
export async function listRecent(cwd) {
  const list = await listSessions({ dir: cwd, limit: 40 });
  return list.map((s) => ({ id: s.sessionId, title: clip(s.summary || 'Untitled session', 90), lastModified: s.lastModified }));
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isSessionId = (id) => typeof id === 'string' && SESSION_ID.test(id);

/**
 * Sessions open right now in any Claude Code process - terminal, VS Code or this app -
 * from Claude Code's live registry (~/.claude/sessions/<pid>.json). A registry file
 * whose process has gone is ignored. Any doubt counts as open.
 */
export function openSessionIds() {
  return new Set(openSessions().keys());
}

/** session id -> the clients holding it open ('sdk-ts' = an SDK app like this one, 'claude-vscode', 'cli', ...). */
function openSessions() {
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'sessions');
  const open = new Map();
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return open; }
  for (const n of names) {
    try {
      const reg = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (!reg.sessionId || !Number.isInteger(reg.pid)) continue;
      try { process.kill(reg.pid, 0); } catch (e) { if (e.code === 'ESRCH') continue; }
      const id = String(reg.sessionId);
      open.set(id, [...(open.get(id) || []), String(reg.entrypoint || 'unknown')]);
    } catch { /* unreadable entry */ }
  }
  return open;
}

/**
 * `/delete <name>`: sessions whose id starts with the text, else whose /rename title is
 * exactly it, else whose title or first prompt contains it. Searches every session.
 */
export async function findSessions(cwd, text) {
  const q = String(text || '').trim().toLowerCase();
  if (!q) return [];
  const all = await listSessions({ dir: cwd });
  const out = (list) => list.map((s) => ({ id: s.sessionId, title: clip(s.summary || 'Untitled session', 90), lastModified: s.lastModified }));
  if (/^[0-9a-f][0-9a-f-]{7,35}$/.test(q)) {
    const byId = all.filter((s) => s.sessionId.startsWith(q));
    if (byId.length) return out(byId);
  }
  const exact = all.filter((s) => (s.customTitle || '').toLowerCase() === q);
  if (exact.length) return out(exact);
  return out(all.filter((s) => [s.customTitle, s.summary, s.firstPrompt].some((t) => (t || '').toLowerCase().includes(q))));
}

/**
 * Delete a session: its transcript and its subagent folder (the SDK's deleteSession).
 * Never one that is still open - Claude Code would keep writing and bring it back as a
 * fragment. `waitMs` gives this app's own session, just closed, time to shut down.
 */
export async function removeSession(cwd, id, { waitMs = 0 } = {}) {
  if (!isSessionId(id)) throw new Error('That is not a session id.');
  const until = Date.now() + waitMs;
  for (;;) {
    const holders = openSessions().get(id);
    if (!holders) break;
    // Only an SDK client (this app's own, just-closed session) is worth waiting for;
    // a terminal or VS Code window will not let go by itself.
    const elsewhere = !waitMs || holders.some((h) => h !== 'sdk-ts');
    if (elsewhere) throw new Error('That session is open in another window (terminal or VS Code). Close it there first, or run /delete inside it.');
    if (Date.now() >= until) throw new Error('The session is still shutting down. Try again in a moment.');
    await new Promise((r) => setTimeout(r, 250));
  }
  await deleteSession(id, { dir: cwd });
}

/**
 * /rename for a session that is not running in this app: the SDK appends a custom-title
 * entry. Refused while another window has it open - that process keeps its own title in
 * memory and would write it back.
 */
export async function renameStoredSession(cwd, id, title) {
  if (!isSessionId(id)) throw new Error('That is not a session id.');
  if (openSessionIds().has(id)) throw new Error('That session is open in another window. Rename it there with /rename, or close it first.');
  await renameSession(id, title, { dir: cwd });
}

/** Sessions larger than this are shown from their end only: parsing 300 MB would stall the app. */
const HISTORY_FULL_LIMIT = 16 * 1024 * 1024;
const HISTORY_TAIL_BYTES = 6 * 1024 * 1024;

function transcriptPath(cwd, sessionId) {
  const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(home, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`);
}

/** The last few MB of a large transcript, as main-thread messages (same shape as getSessionMessages). */
function readTail(file, size) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(HISTORY_TAIL_BYTES);
    const n = fs.readSync(fd, buf, 0, HISTORY_TAIL_BYTES, size - HISTORY_TAIL_BYTES);
    const lines = buf.subarray(0, n).toString('utf8').split('\n').slice(1); // first line is cut
    const out = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if ((e.type === 'user' || e.type === 'assistant') && !e.isSidechain && !e.isMeta) {
        out.push({ type: e.type, uuid: e.uuid, message: e.message, parent_tool_use_id: null });
      }
    }
    return out;
  } finally { fs.closeSync(fd); }
}

/** A past session's main-thread conversation, simplified for display. */
export async function loadHistory(cwd, sessionId) {
  const out = [];
  let msgs = null;
  try {
    const file = transcriptPath(cwd, sessionId);
    const { size } = fs.statSync(file);
    if (size > HISTORY_FULL_LIMIT) {
      msgs = readTail(file, size);
      out.push({ role: 'notice', text: `A long session (${Math.round(size / 1048576)} MB) - showing its most recent part.` });
    }
  } catch { /* not found locally: let the SDK find it */ }
  if (!msgs) msgs = await getSessionMessages(sessionId, { dir: cwd });
  for (const m of msgs) {
    if (m.parent_tool_use_id) continue;
    const msg = m.message || {};
    const content = msg.content;
    if (m.type === 'user') {
      // uuid: the message's id, which file checkpoints (rewind) are keyed by.
      if (typeof content === 'string') {
        const t = cleanUserText(content);
        if (t) out.push({ role: 'user', text: t, uuid: m.uuid || null });
      } else if (Array.isArray(content)) {
        const t = cleanUserText(content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
        const images = content.filter((b) => b.type === 'image').length;
        if (t || images) out.push({ role: 'user', text: t, images, uuid: m.uuid || null });
      }
    } else if (m.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (b.type === 'text' && b.text?.trim()) out.push({ role: 'assistant', text: b.text });
        else if (b.type === 'tool_use') out.push({ role: 'tool', name: b.name, detail: describeTool(b.name, b.input) });
      }
    }
  }
  const note = out[0]?.role === 'notice' ? out.shift() : null;
  const recent = out.slice(-300);
  return note ? [note, ...recent] : recent;
}
