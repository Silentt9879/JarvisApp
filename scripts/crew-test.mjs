// The Agents floor's model (src/renderer/crew-model.js): who is working, on what, until when.
// The renderer file is a plain script, so it is run here in a vm with a stand-in `window`.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../src/renderer/crew-model.js', import.meta.url), 'utf8');
const sandbox = { window: {}, URL };
vm.runInNewContext(src, sandbox);
const { createCrew, act } = sandbox.window.CrewModel;

let pass = 0;
let fail = 0;
const ok = (cond, what) => { if (cond) { pass++; console.log(`  ok  ${what}`); } else { fail++; console.log(`  FAIL  ${what}`); } };

let clock = 1_000_000;
const now = () => clock;
const make = () => createCrew(now);

// 1. A foreground agent: dispatched, works step by step, reports back.
{
  const c = make();
  c.ingest({ kind: 'tool_use', id: 'A', name: 'Agent', agent: 'sentry', agentTask: 'Approval pages', parent: null });
  const r = c.runs.get('A');
  ok(r && r.status === 'working' && r.agent === 'sentry', 'a dispatched agent takes a desk, working');
  c.ingest({ kind: 'tool_use', id: 's1', name: 'Read', detail: 'C:\\repo\\Controllers\\ApprovalController.cs', parent: 'A' });
  ok(c.doing(r).text === 'Reading ApprovalController.cs' && c.doing(r).kind === 'read', 'the bubble says what it is reading, by file name');
  c.ingest({ kind: 'tool_result', id: 's1', parent: 'A', isError: false });
  ok(r.steps[0].state === 'ok' && c.doing(r).kind === 'think', 'between steps it is thinking');
  c.ingest({ kind: 'tool_use', id: 's2', name: 'Bash', detail: 'dotnet build -c Release', parent: 'A' });
  c.ingest({ kind: 'tool_result', id: 's2', parent: 'A', isError: true });
  ok(r.steps[1].state === 'err' && r.toolUses === 2, 'a failed step is marked, and steps are counted');
  c.ingest({ kind: 'tool_result', id: 'A', parent: null, isError: false, preview: 'Completed: all three pages reworked.' });
  ok(r.status === 'done' && r.summary.startsWith('Completed') && r.endedAt === clock, 'its result ends the run with the report as summary');
}

// 2. A background agent: "launched" is not the end; its notification is.
{
  const c = make();
  c.ingest({ kind: 'tool_use', id: 'B', name: 'Agent', agent: 'scout', agentTask: 'Trace auth', parent: null });
  c.ingest({ kind: 'agent_task', phase: 'started', taskId: 't1', toolUseId: 'B', agent: 'scout', background: true });
  c.ingest({ kind: 'tool_result', id: 'B', parent: null, preview: 'Async agent launched successfully.\nagentId: x' });
  const r = c.runs.get('B');
  ok(r.status === 'working' && r.background, 'a launched background agent stays working');
  c.ingest({ kind: 'status', state: 'ready' });
  ok(r.status === 'working', 'the session going idle does not end a background agent');
  c.ingest({ kind: 'agent_task', phase: 'progress', taskId: 't1', toolUseId: 'B', toolUses: 41, tokens: 52300 });
  ok(r.toolUses === 41 && r.tokens === 52300, 'progress updates its tool and token counts');
  c.ingest({ kind: 'agent_task', phase: 'done', taskId: 't1', toolUseId: null, status: 'completed', summary: 'Bottom line: ...' });
  ok(r.status === 'done' && r.summary.startsWith('Bottom line'), 'its task notification (matched by task id) ends it');
}

// 3. Launched without a task_started event, and a failed notification.
{
  const c = make();
  c.ingest({ kind: 'tool_use', id: 'C', name: 'Agent', agent: 'verifier', parent: null });
  c.ingest({ kind: 'tool_result', id: 'C', parent: null, preview: 'Async agent launched successfully.' });
  ok(c.runs.get('C').background === true, 'the "launched" result alone marks it background');
  c.ingest({ kind: 'agent_task', phase: 'done', taskId: 't9', toolUseId: 'C', status: 'failed' });
  ok(c.runs.get('C').status === 'failed', 'a failed notification shows it failed');
}

// 4. A finished report that only mentions the phrase later is still finished.
{
  const c = make();
  c.ingest({ kind: 'tool_use', id: 'D', name: 'Agent', agent: 'auditor', parent: null });
  c.ingest({ kind: 'tool_result', id: 'D', parent: null, preview: `${'Findings. '.repeat(30)}The poller keeps running in the background.` });
  ok(c.runs.get('D').status === 'done', 'only the opening words can say "launched"');
}

// 5. A foreground run that missed its result is closed when the session goes idle.
{
  const c = make();
  c.ingest({ kind: 'tool_use', id: 'E', name: 'Agent', agent: 'friday', parent: null });
  c.ingest({ kind: 'status', state: 'ready' });
  ok(c.runs.get('E').status === 'done', 'idle closes a foreground run left "working"');
}

// 6. The session process ends: everyone still working stops.
{
  const c = make();
  c.ingest({ kind: 'tool_use', id: 'F', name: 'Agent', agent: 'scout', parent: null });
  c.ingest({ kind: 'tool_result', id: 'F', parent: null, preview: 'Async agent launched successfully.' });
  c.ingest({ kind: 'tool_use', id: 'f1', name: 'Grep', detail: 'getByUserID  in src', parent: 'F' });
  c.ingest({ kind: 'status', state: 'closed' });
  const r = c.runs.get('F');
  ok(r.status === 'stopped' && r.steps[0].state === 'stop', 'a closed session stops its agents and their open steps');
}

// 7. A helper briefed by a background agent gets its own desk and ends on its own result.
{
  const c = make();
  c.ingest({ kind: 'tool_use', id: 'G', name: 'Agent', agent: 'sentry', parent: null });
  c.ingest({ kind: 'tool_result', id: 'G', parent: null, preview: 'Async agent launched successfully.' });
  c.ingest({ kind: 'tool_use', id: 'H', name: 'Agent', agent: 'Explore', agentTask: 'find modals', detail: 'Explore: find modals', parent: 'G' });
  const g = c.runs.get('G');
  const h = c.runs.get('H');
  ok(h && h.parentRun === 'G' && c.doing(g).text === 'Briefing Explore', 'the helper takes a desk; its parent is shown briefing it');
  c.ingest({ kind: 'status', state: 'ready' });
  ok(h.status === 'working', 'a helper inside a background agent outlives the idle turn');
  c.ingest({ kind: 'tool_result', id: 'H', parent: 'G', isError: false, preview: 'Found 3 modals.' });
  ok(h.status === 'done' && g.steps[0].state === 'ok' && g.status === 'working', 'its result ends the helper and ticks the parent step');
}

// 8. Listing, counting, pruning and reset.
{
  const c = make();
  c.ingest({ kind: 'tool_use', id: 'P', name: 'Agent', agent: 'scout', parent: null });
  c.ingest({ kind: 'tool_result', id: 'P', parent: null, preview: 'done' });
  clock += 1000;
  c.ingest({ kind: 'tool_use', id: 'Q', name: 'Agent', agent: 'scout', parent: null });
  c.ingest({ kind: 'tool_use', id: 'R', name: 'Agent', agent: 'friday', parent: null });
  let { working, ended } = c.list();
  ok(working.map((r) => r.id).join() === 'Q,R' && ended.map((r) => r.id).join() === 'P', 'working first (oldest first), then finished');
  ok(c.workingCount('scout') === 1 && c.workingCount() === 2, 'counts who is working, per agent and in all');
  clock += 16 * 60e3;
  ({ ended } = c.list());
  ok(!ended.length && c.runs.size === 2, 'finished runs drop off after a while; working ones never do');
  c.ingest({ kind: 'session_reset' });
  ok(c.runs.size === 0, 'a new session clears the floor');
}

// 9. What each tool looks like on the floor.
{
  ok(act('Grep', 'loginByPhoneMail  in lib').text === 'Searching for loginByPhoneMail', 'Grep: the pattern, not the path');
  ok(act('Edit', '/repo/a/b.dart').kind === 'edit' && act('Write', 'x/y.cs').text === 'Writing y.cs', 'Edit and Write: editing, by file name');
  ok(act('PowerShell', 'npm test\nnext line').text === 'Running npm test', 'commands: their first line');
  ok(act('WebFetch', 'https://docs.example.com/a').text === 'Reading docs.example.com', 'web reads: the site');
  ok(act('mcp__clickup__clickup_search', '{}').text === 'Using clickup', 'MCP tools: the server');
  ok(act('Skill', 'diagnose').kind === 'skill', 'skills');
}

console.log(`crew-test: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
