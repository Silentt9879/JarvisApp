// The git risk policy, as the desktop app sees it.
//
// THE RULES ARE NOT IN THIS FILE. They live in the workspace, at
// `.claude/jarvis/git-risk-policy.json`, and `.claude/hooks/git-guard.py` reads the very
// same file to guard Claude Code's own git commands. One copy, two consumers. Change the
// rules there; never hand-port them into here, or the two will drift and the guarantee
// that the app is as careful as the hook quietly stops being true.
//
// One deliberate difference from the hook. The hook fails OPEN: a broken guard must never
// block normal development, and Claude Code's own permission prompt still sits behind it.
// This fails CLOSED: it is the last thing between a button and the work, so an operation
// it cannot classify is treated as destructive and must be confirmed.
import fs from 'node:fs';
import path from 'node:path';

const REL = path.join('.claude', 'jarvis', 'git-risk-policy.json');

let cache = null; // { cwd, mtimeMs, policy } - reloaded when the file changes on disk

/** Load the policy for a workspace. Returns null if it cannot be read. */
function load(cwd) {
  const file = path.join(cwd, REL);
  try {
    const { mtimeMs } = fs.statSync(file);
    if (cache && cache.cwd === cwd && cache.mtimeMs === mtimeMs) return cache.policy;
    const policy = JSON.parse(fs.readFileSync(file, 'utf8'));
    cache = { cwd, mtimeMs, policy };
    return policy;
  } catch {
    cache = null;
    return null;
  }
}

/** Evaluate one rule's `when`. Returns null when it does not match, else the matched arg (or ''). */
function matches(when, { opts, plain, args, repo }) {
  if (!when || Object.keys(when).length === 0) return '';
  if (when.flagsAny && !when.flagsAny.some((f) => opts.has(f))) return null;
  if (when.notFlagsAny && when.notFlagsAny.some((f) => opts.has(f))) return null;
  if (when.hasPathSeparator !== undefined && !!when.hasPathSeparator !== args.includes('--')) return null;
  if (when.plainAny && !when.plainAny.some((v) => plain.includes(v))) return null;
  if (when.noPlain !== undefined && !!when.noPlain !== (plain.length === 0)) return null;
  if (when.firstPlainIn) {
    const first = plain[0];
    if (first === undefined || !when.firstPlainIn.includes(first)) return null;
    return first;
  }
  if (when.plainIsExistingPath) {
    for (const a of plain) {
      try { if (repo && fs.existsSync(path.join(repo, a))) return a; } catch { /* unreadable */ }
    }
    return null;
  }
  return '';
}

/**
 * Classify one git operation.
 *
 * @returns {{level:'read'|'mutate'|'destructive', gate:'dirty'|'always'|null,
 *            reason:string|null, policyMissing:boolean}}
 */
export function classify(cwd, sub, args = [], repo = null) {
  const policy = load(cwd);
  if (!policy) {
    // Fail closed. Reading is still allowed, because showing a status cannot hurt and a
    // Source Control view that cannot even read would simply be broken.
    const readOnly = new Set(['status', 'diff', 'log', 'show', 'branch', 'remote', 'rev-parse', 'ls-files', 'for-each-ref', 'symbolic-ref']);
    return {
      level: readOnly.has(sub) ? 'read' : 'destructive',
      gate: 'always',
      reason: readOnly.has(sub) ? null
        : `The git risk policy (${REL}) could not be read, so \`git ${sub}\` cannot be checked. Confirm only if you are certain.`,
      policyMissing: true,
    };
  }

  const op = (policy.operations || {})[sub];
  if (!op) {
    const fallback = (policy.unknownOperation || {}).ui || 'destructive';
    return {
      level: fallback,
      gate: fallback === 'destructive' ? 'always' : null,
      reason: fallback === 'destructive' ? `\`git ${sub}\` is not in the risk policy, so it is treated as destructive.` : null,
      policyMissing: false,
    };
  }

  const opts = new Set(args.filter((a) => a.startsWith('-')));
  const plain = args.filter((a) => !a.startsWith('-'));
  const ctx = { opts, plain, args, repo };

  for (const rule of op.rules || []) {
    const hit = matches(rule.when || {}, ctx);
    if (hit === null) continue;
    const level = rule.level || 'destructive';
    return {
      level,
      gate: level === 'destructive' ? (rule.gate || 'dirty') : null,
      reason: level === 'destructive' ? String(rule.reason || `\`git ${sub}\` can destroy work`).replace('{arg}', hit) : null,
      policyMissing: false,
    };
  }

  const level = op.level || 'mutate';
  return {
    level,
    gate: level === 'destructive' ? (op.gate || 'dirty') : null,
    reason: level === 'destructive' ? `\`git ${sub}\` can destroy work` : null,
    policyMissing: false,
  };
}

/**
 * The question the UI actually asks: may this run, and if it needs confirming, what does
 * the person need to be told? `dirtyCount` is how many uncommitted changes the repository
 * has; pass null when it is unknown, which is itself a reason to confirm.
 *
 * A `dirty`-gated operation on a clean repository needs no confirmation - that is the
 * hook's behaviour too, and it is deliberate: there is nothing to lose.
 */
export function check(cwd, sub, args, { repo = null, repoLabel = null, dirtyCount = null } = {}) {
  const v = classify(cwd, sub, args, repo);
  if (v.level !== 'destructive') return { allowed: true, confirm: false, ...v };

  if (v.gate === 'dirty') {
    if (dirtyCount === 0) return { allowed: true, confirm: false, ...v, reason: null };
    const where = repoLabel || (repo ? path.basename(repo) : 'this repository');
    const what = dirtyCount === null
      ? `${where}: its state could not be read, so this is being confirmed to be safe.`
      : `${where} has ${dirtyCount} uncommitted change${dirtyCount === 1 ? '' : 's'}, and this cannot be undone.`;
    return { allowed: true, confirm: true, ...v, reason: `${v.reason}. ${what}` };
  }

  const where = repoLabel || (repo ? path.basename(repo) : 'this repository');
  return { allowed: true, confirm: true, ...v, reason: `${v.reason} (${where}). This cannot be undone.` };
}

/** True when the operation may run with no confirmation at all. */
export const isFree = (cwd, sub, args = []) => classify(cwd, sub, args).level === 'read';
