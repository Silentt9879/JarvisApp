// The health check: each thing JARVIS needs, whether it is in order, and the one button that
// fixes it. Pure: the caller gathers the facts (files, sign-ins, settings) and this decides.
//
// A check is { id, title, state: 'ok' | 'warn' | 'bad', detail, fix }, where fix is
// { label, action } for the window to carry out, or null when nothing can be done from here.

export function buildHealth(f = {}) {
  const checks = [];
  const add = (id, title, state, detail, fix = null) => checks.push({ id, title, state, detail, fix });

  add(
    'claude',
    'Claude Code is inside JARVIS',
    f.claudeFound ? 'ok' : 'bad',
    f.claudeFound ? 'Found.' : 'It is missing from this copy of JARVIS. Reinstall JARVIS from the installer.',
    null,
  );

  if (f.signedIn === true) add('signin', 'Signed in to Claude', 'ok', `Signed in${f.account ? ` as ${f.account}` : ''}.`);
  else if (f.signedIn === false) add('signin', 'Signed in to Claude', 'bad', 'You are not signed in, so JARVIS cannot answer.', { label: 'Sign in', action: 'signin' });
  else add('signin', 'Signed in to Claude', 'warn', 'Could not check just now.', { label: 'Check again', action: 'recheck' });

  add(
    'workspace',
    'Workspace folder',
    f.workspaceFound ? 'ok' : 'bad',
    f.workspaceFound ? f.workspace || 'Found.' : 'The folder JARVIS works in is missing or was moved.',
    f.workspaceFound ? null : { label: 'Choose a folder', action: 'workspace' },
  );

  add(
    'policy',
    'Source Control safety rules',
    f.policyFound ? 'ok' : 'warn',
    f.policyFound
      ? 'Found. Undo and discard follow your rules.'
      : 'The workspace has no git risk policy file. Source Control asks you to confirm every change until it is back.',
    f.policyFound ? null : { label: 'Show the folder', action: 'policyFolder' },
  );

  add(
    'telegram',
    'Phone alerts and Telegram',
    f.telegramOn ? 'ok' : 'warn',
    f.telegramOn ? 'Connected. JARVIS can message your phone.' : 'Not set up. Optional, but it is how your phone hears from JARVIS.',
    f.telegramOn ? null : { label: 'Set up', action: 'telegram' },
  );

  add(
    'github',
    'Updates from GitHub',
    f.githubOn ? 'ok' : 'warn',
    f.githubOn ? 'Signed in, so JARVIS can check for updates.' : 'Not signed in. JARVIS cannot check for updates yet.',
    f.githubOn ? null : { label: 'Sign in to GitHub', action: 'github' },
  );

  if (f.updateAvailable) {
    add('update', 'JARVIS is up to date', 'warn', `Version ${f.updateAvailable} is ready to install.`, { label: 'Update', action: 'updates' });
  } else {
    add('update', 'JARVIS is up to date', 'ok', f.version ? `You have ${f.version}.` : 'No update is waiting.');
  }

  add(
    'voice',
    'Voice (speech to text)',
    'ok',
    f.voiceReady ? 'Ready, on this PC.' : 'Runs on this PC. The speech model downloads the first time you use voice.',
    null,
  );

  const bad = checks.filter((c) => c.state === 'bad').length;
  const warn = checks.filter((c) => c.state === 'warn').length;
  return {
    checks,
    bad,
    warn,
    summary: bad ? `${bad} thing${bad === 1 ? '' : 's'} need${bad === 1 ? 's' : ''} fixing` : warn ? 'Working, with a few things to set up' : 'Everything is in order',
    level: bad ? 'bad' : warn ? 'warn' : 'ok',
  };
}
