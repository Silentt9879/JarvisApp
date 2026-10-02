// Tasks - what is on the board in ClickUp, and what is still only in the workspace draft.
//
// ClickUp is a remote OAuth MCP server, so there is no key to copy: the sync borrows the
// connection Claude Code already has. It runs ONE short Claude Code query of its own, with
// only the read-only ClickUp tools allowed. The model only makes the calls; the tasks are
// read from the tool RESULTS, never retyped by the model. The answer is cached so the page
// opens instantly.
import fs from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

const DRAFT = ['.claude', 'jarvis', 'clickup-task-draft.md'];
const SYNC_MODEL = 'claude-haiku-4-5-20251001';
/** Only these may be called during a sync: reading ClickUp, nothing that writes. */
const READ_ONLY = /^mcp__clickup__clickup_(get|search|filter|find|resolve|list)/;

const PROMPT = `Fetch every ClickUp task assigned to the member "Jayvian". JARVIS reads the tasks
straight from the tool results, so do not write any task out yourself.

1. clickup_get_workspace_hierarchy.
2. clickup_find_member_by_name for "Jayvian", to get the member id.
3. clickup_filter_tasks with assignees: [that id], include_closed: true and page: 0, across
   every space (no space_ids, or every space id from step 1). Call it again with the next
   page until has_more is false.

Then reply with exactly: DONE
If a step fails, reply with one line: ERROR: <the reason>`;
/** A healthy sync takes about half a minute. This only bounds a remote that never answers. */
const SYNC_LIMIT_MS = 5 * 60 * 1000;

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

// ---------------------------------------------------------------- reading the tool results
/**
 * Collects the sync's answer from the ClickUp tool RESULTS.
 *
 * The first design had the model retype every task as one JSON reply. With 248 tasks that
 * reply outgrew a single response: it was cut off mid-task, the model carried on in a fresh
 * JSON block holding only the rest, and no single block was the whole list. Retyping also
 * took four minutes after the data had arrived in thirty seconds, and every `updated` date
 * it wrote was wrong. The pages themselves are exact, so they are the source.
 *
 * `complete()` is the guard against a silently shorter board: it is true only once a paging
 * run has gone from page 0 to `has_more: false` without a gap, with closed tasks included,
 * for Jayvian, across every space in the workspace.
 */
export function createCollector() {
  const calls = new Map();   // tool_use id -> { name, input }
  const runs = new Map();    // one filter, all its pages -> { input, pages, last }
  const found = new Map();   // task id -> the task as ClickUp returned it
  const lists = new Map();   // list id -> { space, folder }
  let spaces = null;         // every space id, once the hierarchy has been read
  let memberId = null;
  let broken = null;
  let brokenText = '';

  const short = (name) => String(name || '').replace(/^mcp__clickup__clickup_/, '');
  const signature = (input) => JSON.stringify(Object.keys(input || {}).filter((k) => k !== 'page').sort()
    .map((k) => [k, input[k]]));
  const nonEmpty = (v) => Array.isArray(v) && v.length > 0;

  function readHierarchy(root) {
    spaces = [];
    const walk = (node, space, folder) => {
      for (const c of node?.children || []) {
        if (c.type === 'space') { spaces.push(String(c.id)); walk(c, c.name, null); }
        else if (c.type === 'folder') walk(c, space, c.name);
        else if (c.type === 'list') lists.set(String(c.id), { space, folder });
        else walk(c, space, folder);
      }
    };
    walk(root, null, null);
  }

  return {
    call(id, name, input) { calls.set(id, { name: short(name), input: input || {} }); },

    result(id, text, isError = false) {
      const call = calls.get(id);
      // An error result is not a page: the model retries, and nothing is added or lost.
      if (!call || isError) return;
      let data;
      try { data = JSON.parse(text); } catch {
        // A page that cannot be read means the set cannot be trusted. Other calls failing
        // (an error message, a lookup) is the model's business, not the board's.
        if (call.name === 'filter_tasks') { broken = 'A page of ClickUp tasks came back unreadable.'; brokenText = String(text).slice(0, 160); }
        return;
      }
      if (data?.hierarchy?.root) readHierarchy(data.hierarchy.root);
      if (data?.member?.id != null && /^(find_member_by_name|resolve_assignees)$/.test(call.name)) memberId = String(data.member.id);
      if (call.name !== 'filter_tasks' || !Array.isArray(data?.tasks)) return;
      const key = signature(call.input);
      const run = runs.get(key) || { input: call.input, pages: new Set(), last: null };
      runs.set(key, run);
      const page = Number.isInteger(data.page) ? data.page : Number(call.input.page || 0);
      run.pages.add(page);
      if (data.has_more === false) run.last = page;
      for (const t of data.tasks) if (t?.id) found.set(String(t.id), t);
    },

    complete() {
      const done = [...runs.values()].filter((r) => r.last !== null
        && Array.from({ length: r.last + 1 }, (_, p) => p).every((p) => r.pages.has(p))
        && r.input.include_closed === true && nonEmpty(r.input.assignees));
      if (!done.length) return false;
      const scoped = (i) => nonEmpty(i.space_ids) || nonEmpty(i.folder_ids) || nonEmpty(i.list_ids);
      if (done.some((r) => !scoped(r.input))) return true;          // one workspace-wide run
      if (!spaces) return false;                                     // nothing to check coverage against
      const seen = new Set(done.filter((r) => !nonEmpty(r.input.folder_ids) && !nonEmpty(r.input.list_ids))
        .flatMap((r) => r.input.space_ids || []).map(String));
      return spaces.every((sp) => seen.has(sp));
    },

    get broken() { return broken; },
    get brokenText() { return brokenText; },

    /** Pages read so far, for the log: how far it got, without any task content. */
    summary() {
      return [...runs.values()].map((r) => `pages ${[...r.pages].sort((a, b) => a - b).join(',')}${r.last === null ? ' (more)' : ' (end)'}`).join('; ') || 'no task pages';
    },

    tasks() {
      const mine = [...found.values()].filter((t) => !memberId || !Array.isArray(t.assignees)
        || t.assignees.some((a) => String(a?.id) === memberId));
      return mine.map((t) => {
        const status = typeof t.status === 'string' ? t.status : t.status?.status;
        const where = lists.get(String(t.list?.id)) || {};
        const ms = Number(t.date_updated);
        return {
          id: t.id,
          code: t.custom_id || null,
          title: t.name,
          status,
          // ClickUp stamps date_closed when a task reaches a done or closed status.
          statusType: t.date_closed ? 'done' : /^(open|to do|todo|backlog)$/i.test(status || '') ? 'open' : 'custom',
          list: t.list?.name,
          folder: where.folder ?? null,
          space: where.space ?? null,
          url: t.url,
          updated: ms > 0 ? new Date(ms).toISOString() : null,
          priority: typeof t.priority === 'string' ? t.priority : t.priority?.priority ?? null,
        };
      });
    },
  };
}

const textOf = (content) => (Array.isArray(content)
  ? content.filter((p) => p?.type === 'text').map((p) => p.text).join('')
  : String(content ?? ''));

/**
 * One short Claude Code query, outside the window's conversation, that reads ClickUp.
 * Resolves to { ok, tasks, fetchedAt } or { ok: false, error }. The cache is only replaced
 * by a list proven complete; anything less leaves the board as it was.
 */
export async function syncClickUp({ cwd, exe, userDir, log }) {
  const started = Date.now();
  const col = createCollector();
  let reply = '';
  let denied = null;
  let timedOut = false;
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
      systemPrompt: 'You fetch ClickUp data through its read-only MCP tools.',
      permissionMode: 'default',
      env,
      canUseTool: async (name, input) => {
        if (READ_ONLY.test(name)) return { behavior: 'allow', updatedInput: input };
        denied = denied || name;
        return { behavior: 'deny', message: 'Only read-only ClickUp tools are allowed here.' };
      },
      stderr: (d) => log?.('[clickup sync]', String(d).trim().slice(0, 300)),
    },
  });
  const timer = setTimeout(() => { timedOut = true; try { q.close(); } catch { /* already closed */ } }, SYNC_LIMIT_MS);
  let early = false;
  try {
    for await (const m of q) {
      if (m.type === 'assistant') {
        for (const b of m.message?.content || []) {
          if (b.type === 'tool_use') col.call(b.id, b.name, b.input);
          else if (b.type === 'text') reply += b.text;
        }
      } else if (m.type === 'user' && Array.isArray(m.message?.content)) {
        for (const b of m.message.content) if (b.type === 'tool_result') col.result(b.tool_use_id, textOf(b.content), b.is_error === true);
        // Everything is in hand. Stop here, before the model spends minutes repeating it.
        if (col.complete()) { early = true; break; }
      } else if (m.type === 'result') break;
    }
  } catch (e) {
    if (!timedOut) {
      log?.('clickup sync failed', e?.message || e);
      return { ok: false, error: String(e?.message || e) };
    }
  } finally {
    clearTimeout(timer);
    try { q.close(); } catch { /* already closed */ }
  }

  if (col.broken) {
    log?.(`[clickup sync] unreadable task page: ${col.brokenText.replace(/\s+/g, ' ')}`);
    return { ok: false, error: `${col.broken} The board was left as it was.` };
  }
  if (!col.complete()) {
    log?.(`[clickup sync] incomplete after ${Math.round((Date.now() - started) / 1000)}s: ${col.summary()}`);
    const said = /ERROR:\s*(.+)/.exec(reply)?.[1]?.trim().slice(0, 300);
    const error = timedOut ? `ClickUp did not finish within ${SYNC_LIMIT_MS / 60000} minutes. The board was left as it was.`
      : said ? `ClickUp: ${said}`
      : denied ? `The sync tried to use ${denied}, which is not allowed here.`
      : 'ClickUp did not return the full task list, so the board was left as it was. The details are in the log.';
    return { ok: false, error };
  }
  const tasks = clean(col.tasks());
  if (!tasks.length) log?.(`[clickup sync] complete but no tasks kept: ${col.summary()}`);
  if (!tasks.length) return { ok: false, error: 'No tasks came back for Jayvian. Check that ClickUp is connected in Tools & Skills.' };
  const out = { tasks, member: 'Jayvian', fetchedAt: new Date().toISOString(), tookMs: Date.now() - started };
  writeClickUp(userDir, out);
  log?.(`clickup sync: ${tasks.length} tasks in ${Math.round(out.tookMs / 1000)}s (${col.summary()}${early ? ', stopped once complete' : ''})`);
  return { ok: true, ...out };
}
