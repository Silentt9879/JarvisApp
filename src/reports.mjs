// Plain-text reports for the Telegram chat: /diff and the morning brief.
//
// Both are read-only and cost no model tokens - git through execFile and the same workspace
// readers the dashboard uses. They return text (and, for a diff, a file to attach); sending
// it is remote.mjs's job.
import { sourceRepos, allRepoStates } from './git.mjs';
import { run, systemStats, openIssues, handoffFocus, GIT_RESTRICTED } from './workspace.mjs';
import { readClickUp } from './tasks.mjs';

const MAX_PATCH_BYTES = 8 * 1024 * 1024;

function counts(r) {
  const bits = [];
  if (r.staged) bits.push(`${r.staged} staged`);
  if (r.modified) bits.push(`${r.modified} modified`);
  if (r.untracked) bits.push(`${r.untracked} new`);
  if (r.ahead) bits.push(`↑${r.ahead} to push`);
  if (r.behind) bits.push(`↓${r.behind} to pull`);
  return bits.join(', ');
}
const dirty = (r) => r.ok && (r.staged || r.modified || r.untracked || r.ahead || r.behind);
const label = (r) => `${r.nickname}${r.nickname !== r.name ? ` (${r.name})` : ''}`;
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** Every repository's state, with the nickname Source Control uses ("JARVIS App", not the folder). */
async function states(cwd) {
  const nick = new Map(sourceRepos(cwd).map((r) => [r.key, r.nickname]));
  return (await allRepoStates(cwd)).map((r) => ({ ...r, nickname: nick.get(r.key) || r.nickname }));
}

/** A repository by key, folder name or nickname: exact first, then the only partial match. */
export function findRepo(cwd, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { ok: false };
  const repos = sourceRepos(cwd);
  const exact = repos.find((r) => [r.key, r.name, r.nickname].some((s) => s.toLowerCase() === q));
  if (exact) return { ok: true, repo: exact };
  const part = repos.filter((r) => [r.key, r.name, r.nickname].some((s) => s.toLowerCase().includes(q)));
  if (part.length === 1) return { ok: true, repo: part[0] };
  return { ok: false, matches: part.map((r) => r.nickname), all: repos.map((r) => r.nickname) };
}

/**
 * `/diff` - what has changed, across every repository.
 * `/diff <repo>` - that repository's changes: a summary, and the full patch as a file.
 * Resolves { text, file? } where file is { name, data: Buffer, type }.
 */
export async function diffReport(cwd, query) {
  if (!String(query || '').trim()) {
    const all = await states(cwd);
    // A restricted workspace runs no Git (workspace.mjs): say that - never "all clean".
    if (all.length && all.every((r) => r.restricted)) return { text: GIT_RESTRICTED };
    const busy = all.filter(dirty);
    // A repository git could not read is not clean, just unknown.
    const unread = all.filter((r) => !r.ok);
    const clean = all.length - busy.length - unread.length;
    if (!busy.length && !unread.length) return { text: `All ${all.length} repositories are clean - nothing to commit, push or pull.` };
    const lines = [];
    if (busy.length) {
      lines.push(`📝 ${busy.length} of ${all.length} repositories have changes:`, '');
      for (const r of busy) lines.push(`• ${label(r)} on ${r.branch || '?'} - ${counts(r)}`);
      if (clean) lines.push('', `${clean} other${clean > 1 ? 's are' : ' is'} clean.`);
    } else if (clean) lines.push(`${clean} of ${all.length} repositories are clean.`);
    if (unread.length) lines.push(...(lines.length ? [''] : []), `Could not read ${unread.map(label).join(', ')}.`);
    if (busy.length) lines.push('', `Send /diff <name> for the full diff, e.g. /diff ${busy[0].nickname.split(' ')[0].toLowerCase()}`);
    return { text: lines.join('\n') };
  }

  const found = findRepo(cwd, query);
  if (!found.ok) {
    return {
      text: found.matches?.length
        ? `"${query}" matches more than one: ${found.matches.join(', ')}. Be more specific.`
        : `No repository called "${query}". The repositories are: ${(found.all || []).join(', ')}.`,
    };
  }
  const repo = found.repo;
  const git = (...args) => run('git', ['--no-optional-locks', '-C', repo.dir, ...args], { timeout: 30000 });
  const hasHead = (await git('rev-parse', '--verify', '-q', 'HEAD')).ok;
  const base = hasHead ? ['HEAD'] : ['--cached'];
  const [st, stat, patch, untracked] = await Promise.all([
    git('status', '--porcelain=v1', '-b'),
    git('diff', '--no-color', '--no-ext-diff', '-M', '--stat=80', ...base),
    git('diff', '--no-color', '--no-ext-diff', '-M', ...base),
    git('ls-files', '--others', '--exclude-standard'),
  ]);
  if (!st.ok) return { text: `Could not read ${repo.nickname}: ${st.err.split('\n')[0].slice(0, 200)}` };
  const branch = (/^## (\S+?)(?:\.\.\.|\s|$)/.exec(st.out) || [])[1] || '?';
  const news = untracked.out.split(/\r?\n/).filter(Boolean);
  const statText = stat.out.trim();
  if (!statText && !news.length) return { text: `${repo.nickname} on ${branch} has no uncommitted changes.` };

  const lines = [`📝 ${repo.nickname} on ${branch}`, ''];
  if (statText) lines.push(statText);
  if (news.length) {
    lines.push('', `${news.length} new file${news.length > 1 ? 's' : ''} (not in the diff):`);
    for (const f of news.slice(0, 15)) lines.push(`  + ${f}`);
    if (news.length > 15) lines.push(`  … and ${news.length - 15} more`);
  }
  const data = Buffer.from(patch.out || '', 'utf8');
  if (!data.length) return { text: lines.join('\n') };
  lines.push('', 'The full patch is attached.');
  return {
    text: lines.join('\n'),
    file: {
      name: `${repo.name}-${today()}.diff`,
      data: data.length > MAX_PATCH_BYTES ? data.subarray(0, MAX_PATCH_BYTES) : data,
      type: 'text/x-diff',
    },
  };
}

function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 60) return `${Math.max(1, m)} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/**
 * The morning brief: the machine, the repositories, open issues, the handoff's focus and
 * ClickUp - one message, no model involved. Every part is optional; a part that cannot be
 * read is left out rather than failing the brief.
 */
export async function morningBrief({ cwd, userDir, lastSession = null, now = new Date() }) {
  const safe = (p) => Promise.resolve().then(p).catch(() => null);
  const [repos, issues, focus] = await Promise.all([safe(() => states(cwd)), safe(() => openIssues(cwd)), safe(() => handoffFocus(cwd))]);
  const day = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const hour = now.getHours();
  const hello = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const lines = [`☀️ ${hello} - ${day}`];

  const sys = (() => { try { return systemStats(cwd); } catch { return null; } })();
  if (sys) {
    const up = Math.floor(sys.uptime / 86400);
    lines.push('', `💻 PC: ${up ? `up ${up} day${up > 1 ? 's' : ''}` : 'restarted today'} · RAM ${sys.ram.pct}%${sys.disk ? ` · disk ${sys.disk.pct}% full` : ''}`);
  }

  if (repos?.length && repos.every((r) => r.restricted)) {
    lines.push('', '🗂 Repositories not read: this workspace is restricted, so JARVIS runs no Git in it.');
  } else if (repos?.length) {
    const busy = repos.filter(dirty);
    const unread = repos.filter((r) => !r.ok).length;
    lines.push('', busy.length ? `🗂 ${busy.length} of ${repos.length} repositories have work in progress:`
      : unread ? `🗂 Nothing in progress in the ${repos.length - unread} repositories read; ${unread} could not be read.`
        : `🗂 All ${repos.length} repositories are clean.`);
    for (const r of busy.slice(0, 8)) lines.push(`• ${r.nickname} (${r.branch || '?'}) - ${counts(r)}`);
  }

  if (issues?.available) {
    const open = issues.list.filter((i) => i.open);
    if (open.length) {
      lines.push('', `🐞 ${open.length} open issue${open.length > 1 ? 's' : ''}:`);
      const order = { critical: 0, high: 1, medium: 2, low: 3 };
      open.sort((a, b) => (order[a.severity] ?? 4) - (order[b.severity] ?? 4));
      for (const i of open.slice(0, 4)) lines.push(`• ${i.id}${i.severity ? ` [${i.severity}]` : ''} ${i.title}`);
      if (open.length > 4) lines.push(`  … and ${open.length - 4} more`);
    }
  }

  if (focus?.items?.length) {
    lines.push('', `🎯 Current focus${focus.asOf ? ` (handoff, ${focus.asOf})` : ''}:`);
    for (const f of focus.items.slice(0, 5)) lines.push(`${f.n}. ${f.title}`);
  }

  const cu = (() => { try { return readClickUp(userDir); } catch { return null; } })();
  if (cu?.tasks?.length) {
    const open = cu.tasks.filter((t) => !/closed|done/i.test(t.statusType || '') && !/^(closed|done|complete)/i.test(t.status || ''));
    const doing = open.filter((t) => /progress|doing|review|testing/i.test(t.status || ''));
    lines.push('', `✅ ClickUp: ${open.length} open${doing.length ? `, ${doing.length} in progress` : ''}${cu.fetchedAt ? ` (synced ${ago(new Date(cu.fetchedAt).getTime())})` : ''}`);
    for (const t of doing.slice(0, 5)) lines.push(`• ${t.code ? `${t.code} ` : ''}${t.title} - ${t.status}`);
  }

  if (lastSession?.title) lines.push('', `💬 Last session: ${lastSession.title} (${ago(lastSession.lastModified)})`);
  lines.push('', 'Send /diff, /sessions, /screen or just a task to get going.');
  return lines.join('\n');
}
