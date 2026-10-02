// Deploy-finished alerts: when a command JARVIS runs looks like a deploy, a release build or
// a publish, the phone hears when it ends - and whether it worked - whoever started it.
//
// It watches the same session events as the alert watcher: a Bash or PowerShell tool_use
// whose command matches DEPLOY is remembered, and its tool_result is the ending. No model,
// no polling. A command sent to the background ends at once with nothing to report, so it
// is left out rather than announced as finished.

// What counts as a deploy. Kept deliberately to commands that ship something - a plain
// `git push` or `dotnet build` would make every turn an "alert".
export const DEPLOY = new RegExp([
  String.raw`\bdeploy\b`,                                   // firebase/vercel/netlify/fly/gcloud/az ... deploy, npm run deploy
  String.raw`\bdotnet\s+publish\b`,
  String.raw`\bflutter\s+build\s+(apk|appbundle|ipa|ios|web|windows)\b`,
  String.raw`\beas\s+(build|submit|update)\b`,
  String.raw`\bfastlane\b`,
  String.raw`\bvercel\b(?=.*--prod)`,
  String.raw`\bnetlify\b(?=.*--prod)`,
  String.raw`\bwrangler\s+publish\b`,
  String.raw`\brailway\s+up\b`,
  String.raw`\bdocker\s+push\b`,
  String.raw`\baz\s+webapp\s+(up|deploy)\b`,
  String.raw`\bmsdeploy\b`,
  String.raw`\bgit\s+push\s+\S*(heroku|azure|production|prod|deploy)\b`,
].join('|'), 'i');

const BACKGROUND = /running in (the )?background|background (task|shell) (started|id)|run_in_background/i;
// "0 Error(s)" and "0 failed" are summaries of success, not failures.
const FAILED = /\bexit code[: ]+[1-9]\d*|(?<!\b0 )\bfailed\b|\berror\s*:|\b[1-9]\d*\s+error|\bunauthori[sz]ed\b/i;

const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
function took(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * @param o.notify   ({ title, body }) => void - send the alert
 * @param o.enabled  () => boolean - read on every ending
 * @param o.now      () => ms - injectable clock
 */
export function createDeployWatcher(o) {
  const now = o.now || (() => Date.now());
  const running = new Map(); // tool_use id -> { cmd, at }

  return {
    event(e) {
      if (!e || typeof e !== 'object') return;
      if (e.kind === 'tool_use' && (e.name === 'Bash' || e.name === 'PowerShell') && DEPLOY.test(e.detail || '')) {
        running.set(e.id, { cmd: String(e.detail || ''), at: now() });
        return;
      }
      if (e.kind === 'tool_result' && running.has(e.id)) {
        const d = running.get(e.id);
        running.delete(e.id);
        const out = String(e.preview || '');
        if (BACKGROUND.test(out) && now() - d.at < 5000) return;
        if (!o.enabled()) return;
        // A tool error is a failure for sure; otherwise the last lines decide, since many
        // deploy tools print an error and still exit 0.
        const tail = out.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-5);
        const failed = e.isError || FAILED.test(tail.join('\n'));
        o.notify({
          title: `${failed ? '❌ Deploy failed' : '🚀 Deploy finished'} after ${took(now() - d.at)}`,
          body: [`$ ${clip(d.cmd.split('\n')[0], 200)}`, tail.length ? `\n${clip(tail.join('\n'), 600)}` : ''].join(''),
        });
        return;
      }
      // A new session or a turn that ended mid-deploy: those commands will never report.
      if (e.kind === 'status' && e.state === 'closed') running.clear();
    },
    _running: () => running.size,
  };
}
