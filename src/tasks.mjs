// Tasks - what is on the board in ClickUp, and what is still only in the workspace draft.
//
// ClickUp is a remote OAuth MCP server, so there is no key to copy: the sync borrows the
// connection Claude Code already has. It runs ONE short Claude Code query of its own, with
// only the read-only ClickUp tools allowed and nothing else, and asks for JSON. That keeps
// it out of your conversation, and the answer is cached so the page opens instantly.
import fs from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

const DRAFT = ['.claude', 'jarvis', 'clickup-task-draft.md'];
const SYNC_MODEL = 'claude-haiku-4-5-20251001';
/** Only these may be called during a sync: reading ClickUp, nothing that writes. */
const READ_ONLY = /^mcp__clickup__clickup_(get|search|filter|find|resolve|list)/;

const PROMPT = `Find every ClickUp task assigned to the member "Jayvian" and report them as JSON.

Steps:
1. clickup_get_workspace_hierarchy to learn the spaces, folders and lists (sprints).
2. clickup_find_member_by_name or clickup_resolve_assignees to get Jayvian's member id.
3. Fetch Jayvian's tasks across EVERY list and EVERY status, closed and archived included
   (clickup_filter_tasks, or clickup_get_operators then clickup_execute_operator if that
   covers more). Do not stop at the current sprint.

Reply with ONE json code block and no other text:
{"member":"<name>","tasks":[{"id":"<task id>","code":"<custom id such as BE333, else null>",
"title":"<name>","status":"<status as ClickUp shows it>","statusType":"<open|custom|closed|done>",
"list":"<list name>","folder":"<folder name or null>","space":"<space name>",
"url":"<task url>","updated":"<ISO date or null>","priority":"<urgent|high|normal|low|null>"}]}

Every task Jayvian is assigned goes in the list. If a step fails, say so inside the JSON as
{"error":"..."} instead of guessing.`;

// ---------------------------------------------------------------- the local draft
/** `- [BE333](https://app.clickup.com/t/x) - Title` or `- Title` under a `##` heading. */
export function readDraft(cwd) {
  const file = path.join(cwd, ...DRAFT);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { available: false, sections: [] }; }
  const sections = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(raw);
    if (h) { current = { name: h[1], items: [] }; sections.push(current); continue; }
    if (!current) continue;
    const line = raw.trim();
    if (!line.startsWith('- ')) continue;
    const body = line.slice(2);
    const linked = /^\[([^\]]+)\]\(([^)]+)\)\s*[-–]\s*(.+)$/.exec(body);
    if (linked) current.items.push({ code: linked[1], url: linked[2], title: linked[3] });
    else current.items.push({ code: null, url: null, title: body });
  }
  const none = /^\(none/i;
  for (const s of sections) s.items = s.items.filter((i) => !none.test(i.title));
  return {
    available: true,
    path: path.join(...DRAFT),
    // The interesting part is what is NOT in ClickUp yet, so those sections come first.
    sections: sections.filter((s) => s.items.length).sort((a, b) => rank(a.name) - rank(b.name)),
  };
}
const rank = (name) => (/ready to log|to do/i.test(name) ? 0 : /already logged/i.test(name) ? 2 : 1);

// ---------------------------------------------------------------- the ClickUp cache
const cacheFile = (userDir) => path.join(userDir, 'clickup-tasks.json');

export function readClickUp(userDir) {
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile(userDir), 'utf8'));
    if (Array.isArray(c.tasks)) return c;
  } catch { /* never synced */ }
  return { tasks: [], fetchedAt: null };
}

function writeClickUp(userDir, data) {
  try { fs.writeFileSync(cacheFile(userDir), JSON.stringify(data)); } catch { /* cache is optional */ }
}

/** The first JSON object in the model's reply, fenced or not. */
function extractJson(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [fenced && fenced[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf('{');
    if (start < 0) continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try { return JSON.parse(c.slice(start, i + 1)); } catch { break; }
      }
    }
  }
  return null;
}

const str = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : null);

/** Keep only the fields the page shows, and only from tasks that have a title. */
function clean(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const t of list.slice(0, 2000)) {
    if (!t || typeof t !== 'object') continue;
    let title = str(t.title) || str(t.name);
    if (!title) continue;
    // The house convention puts the code in the name ("BE331 - Fix ..."), so split it out
    // for its own chip and leave the title readable.
    let code = str(t.code, 30);
    // BE331, AWAC135, and the QA- variants the QA sprint uses.
    const inName = /^((?:QA-)?[A-Z]{2,6}\d{1,4})\s*[-–:]\s*(.+)$/.exec(title);
    if (inName) { code = code || inName[1]; title = inName[2]; }
    out.push({
      id: str(t.id, 60),
      code,
      title,
      status: str(t.status, 60) || 'Unknown',
      statusType: str(t.statusType, 20) || '',
      list: str(t.list, 80) || 'No list',
      folder: /^hidden$/i.test(t.folder || '') ? null : str(t.folder, 80), // ClickUp's word for "no folder"
      space: str(t.space, 80),
      url: /^https:\/\/app\.clickup\.com\//.test(t.url || '') ? t.url : null,
      updated: str(t.updated, 40),
      priority: str(t.priority, 20),
    });
  }
  return out;
}

/**
 * One short Claude Code query, outside the window's conversation, that reads ClickUp and
 * returns JSON. Resolves to { ok, tasks, fetchedAt } or { ok: false, error }.
 */
export async function syncClickUp({ cwd, exe, userDir, log }) {
  const started = Date.now();
  let text = '';
  let denied = null;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const q = query({
    prompt: PROMPT,
    options: {
      cwd,
      pathToClaudeCodeExecutable: exe,
      model: SYNC_MODEL,
      // 'user' brings the user-scope ClickUp server in; no project hooks or agents run.
      settingSources: ['user'],
      systemPrompt: 'You read ClickUp through its MCP tools and answer with JSON only.',
      permissionMode: 'default',
      env,
      canUseTool: async (name) => {
        if (READ_ONLY.test(name)) return { behavior: 'allow', updatedInput: {} };
        denied = denied || name;
        return { behavior: 'deny', message: 'Only read-only ClickUp tools are allowed here.' };
      },
      stderr: (d) => log?.('[clickup sync]', String(d).trim().slice(0, 300)),
    },
  });
  try {
    for await (const m of q) {
      if (m.type === 'assistant') {
        for (const b of m.message?.content || []) if (b.type === 'text') text += b.text;
      } else if (m.type === 'result') break;
    }
  } catch (e) {
    log?.('clickup sync failed', e?.message || e);
    return { ok: false, error: String(e?.message || e) };
  } finally {
    try { q.close(); } catch { /* already closed */ }
  }

  const data = extractJson(text);
  if (!data) {
    log?.('[clickup sync] no JSON in the reply:', (text || '(nothing)').slice(0, 600).replace(/\s+/g, ' '));
    return { ok: false, error: denied ? `The sync tried to use ${denied}, which is not allowed here.` : 'ClickUp did not answer with usable data. The details are in the log.' };
  }
  if (data.error) return { ok: false, error: String(data.error).slice(0, 300) };
  const tasks = clean(data.tasks);
  if (!tasks.length) return { ok: false, error: 'No tasks came back for Jayvian. Check that ClickUp is connected in Tools & Skills.' };
  const out = { tasks, member: str(data.member, 80) || 'Jayvian', fetchedAt: new Date().toISOString(), tookMs: Date.now() - started };
  writeClickUp(userDir, out);
  log?.(`clickup sync: ${tasks.length} tasks in ${Math.round(out.tookMs / 1000)}s`);
  return { ok: true, ...out };
}
