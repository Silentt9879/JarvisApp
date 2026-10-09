/* The Agents floor's model: every agent run JARVIS starts, followed from dispatch to its real end.
   No DOM here, so scripts/crew-test.mjs can drive it with plain events.

   A run is keyed by the id of the Agent tool call that started it. Its steps are the tool calls
   made inside it (events whose `parent` is that id). A foreground run ends with its Agent call's
   result; a background run's Agent call returns "launched" at once, so it ends only when the
   SDK's task_notification arrives (forwarded by session.mjs as agent_task / phase 'done'). */
(function (root) {
  'use strict';

  const MAX_STEPS = 200;           // per run; the oldest drop off, the count stays right
  const KEEP_DONE_MS = 15 * 60e3;  // finished runs stay listed this long

  const clip = (s, n) => (s == null ? '' : String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
  const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');
  const host = (u) => { try { return new URL(u).host; } catch { return clip(u, 40); } };

  /** What a minion is doing, from the tool it is using: a kind (picks the prop) and a line. */
  function act(name, detail) {
    const d = String(detail || '');
    switch (name) {
      case 'Read': return { kind: 'read', text: `Reading ${base(d)}` };
      case 'Edit': case 'MultiEdit': case 'NotebookEdit': return { kind: 'edit', text: `Editing ${base(d)}` };
      case 'Write': return { kind: 'edit', text: `Writing ${base(d)}` };
      case 'Bash': case 'PowerShell': return { kind: 'run', text: `Running ${clip(d.split('\n')[0], 60)}` };
      case 'Grep': return { kind: 'search', text: `Searching for ${clip(d.split('  in ')[0], 44)}` };
      case 'Glob': return { kind: 'search', text: `Finding ${clip(d, 44)}` };
      case 'WebFetch': return { kind: 'web', text: `Reading ${host(d)}` };
      case 'WebSearch': return { kind: 'web', text: `Searching the web for ${clip(d, 36)}` };
      case 'Agent': case 'Task': return { kind: 'agent', text: `Briefing ${clip(d.split(':')[0], 30)}` };
      case 'TodoWrite': case 'TaskCreate': case 'TaskUpdate': return { kind: 'plan', text: 'Planning the next steps' };
      case 'Skill': return { kind: 'skill', text: `Using the ${clip(d, 30)} skill` };
      default: {
        const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name || '');
        if (mcp) return { kind: 'tool', text: `Using ${mcp[1].replace(/_/g, ' ')}` };
        return { kind: 'tool', text: `Using ${name || 'a tool'}` };
      }
    }
  }

  const LAUNCHED = /async agent launched|launched successfully|running in the background|working in the background/i;
  const ENDED = { completed: 'done', failed: 'failed', stopped: 'stopped', killed: 'stopped' };

  function createCrew(now = () => Date.now()) {
    const runs = new Map();   // Agent tool_use id -> run
    const byTask = new Map(); // SDK task id -> Agent tool_use id

    const newRun = (id, agent, task, parentRun) => {
      const r = {
        id, agent: agent || 'general-purpose', task: task || '', parentRun: parentRun || null,
        startedAt: now(), endedAt: null, status: 'working', background: false,
        steps: [], stepCount: 0, toolUses: 0, tokens: null, summary: '',
      };
      runs.set(id, r);
      return r;
    };
    const finish = (r, status, summary) => {
      if (!r || r.status !== 'working') return false;
      r.status = status;
      r.endedAt = now();
      if (summary) r.summary = clip(summary, 600);
      for (const s of r.steps) if (s.state === 'run') s.state = status === 'done' ? 'ok' : 'stop';
      return true;
    };
    const runFor = (e) => runs.get(e.toolUseId) || runs.get(byTask.get(e.taskId));

    /** Feed one session event; true when the floor needs redrawing. */
    function ingest(e) {
      if (!e || !e.kind) return false;
      switch (e.kind) {
        case 'tool_use': {
          let changed = false;
          if (e.parent && runs.has(e.parent)) {
            const r = runs.get(e.parent);
            r.steps.push({ id: e.id, name: e.name, detail: e.detail || '', act: act(e.name, e.detail), at: now(), state: 'run' });
            r.stepCount += 1;
            r.toolUses = Math.max(r.toolUses, r.stepCount);
            if (r.steps.length > MAX_STEPS) r.steps.splice(0, r.steps.length - MAX_STEPS);
            changed = true;
          }
          if (e.agent && !runs.has(e.id)) { newRun(e.id, e.agent, e.agentTask, e.parent || null); changed = true; }
          return changed;
        }
        case 'tool_result': {
          let changed = false;
          if (e.parent && runs.has(e.parent)) {
            const s = runs.get(e.parent).steps.find((x) => x.id === e.id);
            if (s && s.state === 'run') { s.state = e.isError ? 'err' : 'ok'; changed = true; }
          }
          // The Agent call's own result - for a helper an agent briefed, too.
          const r = runs.get(e.id);
          if (!r) return changed;
          // Only the opening words decide "launched": a finished report may mention the phrase.
          if (r.background || LAUNCHED.test(String(e.preview || '').slice(0, 160))) {
            if (!r.background) { r.background = true; changed = true; } // it works on until its notification
            return changed;
          }
          return finish(r, e.isError ? 'failed' : 'done', e.preview) || changed;
        }
        case 'agent_task': {
          if (e.taskId && e.toolUseId) byTask.set(e.taskId, e.toolUseId);
          let r = runFor(e);
          if (!r) {
            // A run we never saw dispatched (a resumed session): only agents get a desk.
            if (e.phase !== 'started' || !(e.agent || e.taskType === 'local_agent')) return false;
            r = newRun(e.toolUseId || `task:${e.taskId}`, e.agent, e.description, null);
            if (e.taskId) byTask.set(e.taskId, r.id);
          }
          if (e.background) r.background = true;
          if (e.toolUses != null) r.toolUses = Math.max(r.toolUses, e.toolUses);
          if (e.tokens != null) r.tokens = e.tokens;
          if (e.phase === 'done') return finish(r, ENDED[e.status] || 'done', e.summary) || true;
          if (e.phase === 'updated' && ENDED[e.status]) return finish(r, ENDED[e.status], e.summary) || true;
          return true;
        }
        case 'status': {
          let any = false;
          // The session process ended: whatever was still running ended with it. A session that
          // is starting has replaced the one before it (a reload after an agent was added, a
          // reconnect), so a run from the old process cannot still be going either - without
          // this, a background agent cut off by a restart sat at its desk "working" for ever.
          if (e.state === 'closed' || e.state === 'starting') for (const r of runs.values()) any = finish(r, 'stopped') || any;
          // Idle: every foreground run has answered by now, so one still "working" missed its
          // result. Background runs (and helpers inside one) legitimately outlive the turn.
          if (e.state === 'ready') {
            for (const r of runs.values()) {
              const parent = r.parentRun && runs.get(r.parentRun);
              if (r.status === 'working' && !r.background && !(parent && parent.status === 'working')) any = finish(r, 'done') || any;
            }
          }
          return any;
        }
        case 'session_reset':
          runs.clear(); byTask.clear();
          return true;
        default: return false;
      }
    }

    /** The step a run is on now, or null between steps (it is thinking). */
    const current = (r) => {
      for (let i = r.steps.length - 1; i >= 0; i--) if (r.steps[i].state === 'run') return r.steps[i];
      return null;
    };
    /** What the bubble says. */
    const doing = (r) => {
      if (r.status === 'done') return { kind: 'done', text: 'Done - reported back' };
      if (r.status === 'failed') return { kind: 'failed', text: 'Hit a problem' };
      if (r.status === 'stopped') return { kind: 'stopped', text: 'Stopped' };
      const s = current(r);
      return s ? s.act : { kind: 'think', text: r.stepCount ? 'Thinking about it' : 'Reading the brief' };
    };

    /** Working first (oldest first), then finished (newest first); old finished runs drop off. */
    function list() {
      const t = now();
      for (const [id, r] of runs) if (r.status !== 'working' && t - r.endedAt > KEEP_DONE_MS) runs.delete(id);
      const all = [...runs.values()];
      const working = all.filter((r) => r.status === 'working').sort((a, b) => a.startedAt - b.startedAt);
      const ended = all.filter((r) => r.status !== 'working').sort((a, b) => b.endedAt - a.endedAt);
      return { working, ended };
    }
    const workingCount = (agent) => [...runs.values()].filter((r) => r.status === 'working' && (!agent || r.agent === agent)).length;

    return { runs, ingest, list, current, doing, workingCount };
  }

  root.CrewModel = { createCrew, act };
})(typeof window !== 'undefined' ? window : globalThis);
