// Optional JARVIS assistance over Source Control.
//
// NOTHING HERE RUNS ON ITS OWN. Every function is reached from a button the user pressed.
// Opening Source Control, selecting a repository, viewing a diff, staging, committing,
// branching, fetching, pulling, pushing and stashing all still cost zero model tokens -
// Phases 1 to 7 do not import this file at all.
//
// Three rules shape the whole module:
//
//   The model sees ONLY what is handed to it. Every query runs with every tool denied, so
//   it cannot read the repository, wander into other files, or run a command. If the diff
//   is not in the prompt, the model does not have it. That is what keeps the context
//   budget honest rather than aspirational.
//
//   Nothing it says touches git. These functions return text. No staging, no commit, no
//   branch, no stash, no remote call happens as a result of anything the model replies -
//   a failure, a timeout or a cancellation leaves the repository exactly as it was.
//
//   The scope is measured before the question is asked, locally, so the window can say
//   "3 staged files, 91 changed lines" without spending anything to find out.
import { query } from '@anthropic-ai/claude-agent-sdk';

const MODEL = 'claude-sonnet-5-5';
const BIG_LINES = 1500;          // beyond this the user is asked before anything is sent
const BIG_BYTES = 180 * 1024;
const HARD_CAP = 400 * 1024;     // never sent, whatever the answer

/** Case-code prefixes per repository. A project without one gets NOTHING invented for it. */
const CASE_PREFIX = {
  'Bantu2U_Center-Module': 'AWAV',
  bantupanduv2: 'CV',
};

// ---------------------------------------------------------------- secrets
//
// SECURITY.md is not weakened to make an AI feature convenient. A diff that looks like it
// carries a credential is reported, and the value is masked before the text is sent.

const SECRET_PATTERNS = [
  [/(['"]?(?:password|passwd|pwd|secret|api[_-]?key|apikey|token|client[_-]?secret|access[_-]?key)['"]?\s*[:=]\s*['"])([^'"]{6,})(['"])/gi, 'credential assignment'],
  [/(Authorization\s*:\s*Bearer\s+)([A-Za-z0-9._\-]{16,})/gi, 'bearer token'],
  [/((?:Server|Data Source)=[^;]+;[^]*?(?:Password|Pwd)=)([^;"']+)/gi, 'connection string'],
  [/(-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----)([^]*?)(-----END)/g, 'private key'],
  [/(gh[pousr]_)([A-Za-z0-9]{20,})/g, 'GitHub token'],
  [/(xox[baprs]-)([A-Za-z0-9-]{10,})/g, 'Slack token'],
  [/(AKIA)([0-9A-Z]{16})/g, 'AWS access key id'],
];

/** Mask anything that looks like a secret, and say what was found. */
export function redactSecrets(text) {
  let out = String(text || '');
  const found = [];
  for (const [re, what] of SECRET_PATTERNS) {
    out = out.replace(re, (m, a, b, c) => {
      found.push(what);
      return `${a}<redacted by JARVIS>${c || ''}`;
    });
  }
  return { text: out, secrets: [...new Set(found)] };
}

// ---------------------------------------------------------------- scope
const countLines = (s) => (s ? s.split('\n').length : 0);

/**
 * What an action would send, measured locally. Zero tokens; this is the number the window
 * shows before anything is spent.
 */
export function measure(parts) {
  const text = parts.map((p) => p.text || '').join('\n');
  const { text: safe, secrets } = redactSecrets(text);
  const bytes = Buffer.byteLength(safe, 'utf8');
  const lines = countLines(safe);
  return {
    files: parts.filter((p) => p.file).length,
    lines,
    bytes,
    text: safe,
    secrets,
    tooLarge: lines > BIG_LINES || bytes > BIG_BYTES,
    refuses: bytes > HARD_CAP,
    summary: `${parts.filter((p) => p.file).length || 1} ${parts.filter((p) => p.file).length === 1 ? 'file' : 'files'} · ${lines} lines`,
  };
}

// ---------------------------------------------------------------- the query
const live = new Map(); // id -> { close }

/**
 * One short query, with every tool denied. It answers in about four seconds, packaged or not.
 *
 * The timeout is a safety net for a request that genuinely hangs, not a tuning knob: nothing
 * in the repository depends on the answer, so giving up is always safe.
 */
async function ask({ cwd, exe, log, id, system, prompt, signal, timeoutMs = 120000 }) {
  let text = '';
  let blocked = null;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const q = query({
    prompt,
    options: {
      cwd,
      pathToClaudeCodeExecutable: exe,
      // User settings only: the project's hooks, agents and skills stay out of a single
      // question about a diff.
      settingSources: ['user'],
      // No MCP servers and no tools at all. This is the context boundary: the model answers
      // from the text in the prompt and cannot read, run or fetch anything to widen it.
      mcpServers: {},
      allowedTools: [],
      model: MODEL,
      systemPrompt: system,
      permissionMode: 'default',
      env,
      // The model is given the diff and nothing else. It cannot read a file, run a command
      // or reach a remote, so it cannot quietly widen its own context.
      canUseTool: async (name) => {
        blocked = blocked || name;
        return { behavior: 'deny', message: 'This assistant answers from the text it was given; it has no tools.' };
      },
      stderr: (d) => log?.('[git ai]', String(d).trim().slice(0, 200)),
    },
  });
  const entry = { q, cancelled: false };
  if (id) live.set(id, entry);

  // A question that never comes back must not leave the window saying "Thinking..." for
  // ever. Nothing of the repository depends on the answer, so giving up is always safe.
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { q.close(); } catch { /* already done */ } }, timeoutMs);

  try {
    for await (const m of q) {
      if (signal?.aborted) return { ok: false, cancelled: true, error: 'Stopped before it finished.' };
      if (m.type === 'assistant') {
        for (const b of m.message?.content || []) if (b.type === 'text') text += b.text;
      } else if (m.type === 'result') break;
    }
    if (entry.cancelled) return { ok: false, cancelled: true, error: 'Stopped. Nothing in the repository was touched.' };
    if (timedOut) return { ok: false, timedOut: true, error: `No answer after ${Math.round(timeoutMs / 1000)} seconds. Nothing in the repository was touched.` };
  } catch (e) {
    if (entry.cancelled) return { ok: false, cancelled: true, error: 'Stopped. Nothing in the repository was touched.' };
    if (timedOut) return { ok: false, timedOut: true, error: `No answer after ${Math.round(timeoutMs / 1000)} seconds. Nothing in the repository was touched.` };
    const msg = String(e?.message || e);
    log?.('git ai failed', msg);
    return { ok: false, error: /abort/i.test(msg) ? 'Stopped before it finished.' : msg, cancelled: /abort/i.test(msg) };
  } finally {
    clearTimeout(timer);
    try { q.close(); } catch { /* already closed */ }
    if (id) live.delete(id);
  }

  if (!text.trim()) {
    return { ok: false, error: blocked ? `The assistant tried to use ${blocked}, which is not available here.` : 'No answer came back.' };
  }
  return { ok: true, text: text.trim() };
}

/** Stop an assistance request. Git is untouched either way - there is nothing to undo. */
export function cancelAssist(id) {
  const entry = live.get(id);
  if (!entry) return { ok: false, error: 'That request is not running.' };
  entry.cancelled = true;
  // close() ends the SDK query and the claude.exe child it started.
  try { entry.q.close(); } catch { /* already finished */ }
  live.delete(id);
  return { ok: true };
}

// ---------------------------------------------------------------- the actions
const SYSTEM = `You are JARVIS assisting with git in the BantuApps workspace: Flutter apps,
ASP.NET Core MVC web apps and APIs, and a shared MySQL backend.

You are given a diff and nothing else. You have no tools and cannot read the repository, so
never claim to have looked at a file you were not given; if something cannot be judged from
the diff, say which file would settle it.

Be direct and brief. Lead with what matters. Do not praise ordinary code, do not restate the
diff line by line, and do not pad.`;

/**
 * Every action: what it sends, and what it asks. The caller supplies the already-measured
 * context so that nothing is gathered twice and the window's scope line is the truth.
 */
export const ACTIONS = {
  commitMessage: {
    label: 'Generate commit message',
    needs: 'staged',
    prompt: (ctx) => `Write a commit message for these STAGED changes.

${ctx.caseNote}

Reply with exactly this, and nothing else:
SUMMARY: <one line, imperative, under 72 characters>
DESCRIPTION:
<optional short body, or leave empty>

House format for the summary is "<Type>: <short description>" - Fix, Add, Refactor, UI.
If the diff plainly belongs to a case code already visible in the changes, keep it.
Never invent a case number.

${ctx.diff}`,
  },
  explainDiff: {
    label: 'Explain this diff',
    needs: 'file',
    prompt: (ctx) => `Explain this change to ${ctx.path}.

Cover what changed, why it was probably done, and anything it affects at runtime. Mention a
side effect only where the diff shows one.

${ctx.diff}`,
  },
  reviewChanges: {
    label: 'Review changes',
    needs: 'scope',
    prompt: (ctx) => `Review these changes and report problems worth acting on.

Look for bugs, regressions, security issues, data-loss risks, broken assumptions, missing
error handling, and mismatches with the other BantuApps projects (an API change the apps or
the Gateway would need too).

List findings strongest first as "- <file>: <problem> -> <what to do>". If there is nothing
worth raising, say exactly "Nothing worth raising." and stop.

${ctx.diff}`,
  },
  explainCommit: {
    label: 'Explain this commit',
    needs: 'commit',
    prompt: (ctx) => `Explain what this commit actually changed.

${ctx.meta}

${ctx.diff}`,
  },
  explainConflict: {
    label: 'Explain this conflict',
    needs: 'conflict',
    prompt: (ctx) => `Explain this merge conflict.

${ctx.meta}

Say why the two sides collide, what each one was trying to do, and what decision the person
has to make. Do NOT choose for them and do not output a resolved file.

${ctx.diff}`,
  },
  suggestResolution: {
    label: 'Suggest a resolution',
    needs: 'conflict',
    prompt: (ctx) => `Propose a resolution for this conflict.

${ctx.meta}

Say which approach you would take - ours, theirs, or a combination - and why. If a
combination, show the resolved region in a code block so it can be read before anything is
applied. This is a proposal only: it will not be written to any file.

${ctx.diff}`,
  },
  reviewResolution: {
    label: 'Review this resolution',
    needs: 'conflict',
    prompt: (ctx) => `This conflict has been resolved by hand. Check the result.

${ctx.meta}

Compare the final file against both sides and report anything from either side that has been
lost, duplicated or half-applied. If it looks correct, say so in one line.

${ctx.diff}`,
  },
  suspicious: {
    label: 'Check for suspicious changes',
    needs: 'scope',
    prompt: (ctx) => `Scan these changes for things that should probably not be committed.

Look for credentials or secrets, debug code, temporary logging, generated or build output,
environment-specific paths, commented-out production code, unexpected dependency or config
changes, and anything destructive to data.

List each as "- <file>: <what> -> <why it matters>". If nothing stands out, say exactly
"Nothing suspicious." and stop.

${ctx.diff}`,
  },
  suggestCase: {
    label: 'Suggest a case',
    needs: 'scope',
    prompt: (ctx) => `Draft a task case for these changes.

${ctx.caseNote}

Reply as:
TITLE: <one line>
WAS: <what the behaviour was>
NOW: <what it is after this change>
FILES: <the main files, comma separated>

${ctx.diff}`,
  },
};

/** The note about case codes, which never invents a prefix for a project without one. */
export function caseNote(repoName) {
  const prefix = CASE_PREFIX[repoName];
  if (!prefix) {
    return 'This project has no case-code prefix. Do not invent one and do not add a code to the summary.';
  }
  return `This project uses the "${prefix}" case prefix (for example ${prefix}123). Only use a code that already appears in the changes - do not invent or guess the next number.`;
}

/**
 * Run one assistance action.
 *
 * `context` is what the caller measured: its `text` is the only repository content that
 * leaves this machine, and it has already been scanned for secrets.
 */
export async function assist({ cwd, exe, log, id, action, context, extra = {}, signal, timeoutMs }) {
  const spec = ACTIONS[action];
  if (!spec) return { ok: false, error: 'Unknown assistance action.' };
  if (!context || !context.text || !context.text.trim()) {
    return { ok: false, error: 'There is nothing to look at.' };
  }
  if (context.refuses) {
    return { ok: false, error: `That is ${Math.round(context.bytes / 1024)} KB of diff - too much to send. Narrow it to a file or a commit.` };
  }

  const ctx = { diff: context.text, caseNote: caseNote(extra.repoName), ...extra };
  const r = await ask({ cwd, exe, log, id, system: SYSTEM, prompt: spec.prompt(ctx), signal, ...(timeoutMs ? { timeoutMs } : {}) });
  if (!r.ok) return { ...r, action };
  return { ok: true, action, text: r.text, scope: { files: context.files, lines: context.lines, secrets: context.secrets } };
}

/** Split a generated commit message into the two fields the panel has. */
export function parseCommitMessage(text) {
  const s = String(text || '');
  const sum = /SUMMARY:\s*(.+)/i.exec(s);
  const desc = /DESCRIPTION:\s*([\s\S]*)$/i.exec(s);
  return {
    summary: (sum ? sum[1] : s.split('\n')[0] || '').trim().slice(0, 120),
    description: (desc ? desc[1] : '').trim().slice(0, 2000),
  };
}
