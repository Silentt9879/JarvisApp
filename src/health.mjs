// The health check: each thing JARVIS needs, whether it is in order, and the one button that
// fixes it. Pure: the caller gathers the facts (files, sign-ins, settings, the machine's
// tools, the workspace's projects) and this decides.
//
// A check is { id, group, title, state, detail, fix }, where fix is { label, action } for the
// window to carry out, or null when nothing can be done from here. States:
//   ok    ready
//   warn  something relevant to set up or look at
//   bad   JARVIS cannot do its job until this is fixed
//   off   optional and not in use - not installed, not configured, and nothing needs it.
//         Never counted as a problem: a missing Flutter on a PC with no Flutter projects is
//         simply a PC that does not do Flutter.
//   note  worth knowing, and nothing is wrong: the workspace's knowledge notes are behind the
//         code, say. Shown with what to do about it, and never counted as a problem either.
//
// The status pill at the top of the window shows THIS verdict (bad / warn / ok) and nothing of
// its own. It used to keep a second list - connected tools, knowledge - that Health did not
// show, so it could say "Needs attention" over a Health page with every row in order.
//
// Health is CONTEXTUAL: a machine capability alone decides nothing. A tool is a warning only
// when a project in the workspace needs it; an integration only when it was switched on.
import { capabilityRelevance, INSTALL_HINT, OPTIONAL_PURPOSE, TYPE_LABEL } from './project-providers.mjs';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function buildHealth(f = {}) {
  const checks = [];
  const add = (id, group, title, state, detail, fix = null) => checks.push({ id, group, title, state, detail, fix });

  // ------------------------------------------------------------ core: what JARVIS itself needs
  // A settings file that cannot be read is kept as it is (main.mjs, saveConfig) - and until it
  // reads again, nothing the person changes can be saved. That comes first.
  if (f.configProblem) {
    add('config', 'core', 'Settings file', 'bad', `Your settings file (%APPDATA%\\JARVIS\\${String(f.configProblem).slice(0, 160)}), so JARVIS is running on its defaults and saving nothing until it is fixed. Correct the file, or move it aside to start afresh - JARVIS never overwrites it.`, { label: 'Show the file', action: 'configFile' });
  }

  add(
    'claude', 'core',
    'Claude Code is inside JARVIS',
    f.claudeFound ? 'ok' : 'bad',
    f.claudeFound ? 'Found.' : 'It is missing from this copy of JARVIS. Reinstall JARVIS from the installer.',
    null,
  );

  if (f.signedIn === true) add('signin', 'core', 'Signed in to Claude', 'ok', `Signed in${f.account ? ` as ${f.account}` : ''}.`);
  else if (f.signedIn === false) add('signin', 'core', 'Signed in to Claude', 'bad', 'You are not signed in, so JARVIS cannot answer.', { label: 'Sign in', action: 'signin' });
  else add('signin', 'core', 'Signed in to Claude', 'warn', 'Could not check just now.', { label: 'Check again', action: 'recheck' });

  if (f.workspaceConfigured === false) {
    add('workspace', 'core', 'Workspace folder', 'bad', 'No workspace chosen yet. Pick the folder that holds your projects.', { label: 'Choose a folder', action: 'workspace' });
  } else {
    add(
      'workspace', 'core',
      'Workspace folder',
      f.workspaceFound ? 'ok' : 'bad',
      f.workspaceFound ? f.workspace || 'Found.' : 'The folder JARVIS works in is missing or was moved.',
      f.workspaceFound ? null : { label: 'Choose a folder', action: 'workspace' },
    );
  }

  // Trust is the person's choice either way, so restricted is information, not a problem.
  if (f.workspaceFound && f.workspaceTrusted === true) {
    add('trust', 'core', 'Workspace trust', 'ok', 'Trusted: its CLAUDE.md, .claude settings, agents, hooks and MCP servers are in use.');
  } else if (f.workspaceFound && f.workspaceTrusted === false) {
    add('trust', 'core', 'Workspace trust', 'off', 'Restricted: Claude works here with your own settings only - this folder\'s CLAUDE.md, .claude hooks, MCP servers, agents and permission rules are not loaded - and JARVIS runs nothing from it: no scripts, builds, tests, apps or Git. Trust it if it is your code or you have reviewed it.', { label: 'Trust this folder', action: 'trust' });
  }

  // Source Control's rules: the workspace's own file, or JARVIS's built-in default (git-policy.mjs).
  // A file that is there but cannot be read fails closed - every change asks - and is said so.
  const source = f.policySource || (f.policyFound ? 'workspace' : 'default');
  if (source === 'restricted') {
    add('policy', 'core', 'Source Control safety rules', 'off', 'Not in use: a restricted workspace runs no Git, so Source Control is off here until the folder is trusted.', null);
  } else if (source === 'unreadable') {
    add('policy', 'core', 'Source Control safety rules', 'warn', 'This workspace\'s .claude/jarvis/git-risk-policy.json could not be read, so Source Control treats every change as risky until it is fixed.', { label: 'Show the folder', action: 'policyFolder' });
  } else {
    add(
      'policy', 'core',
      'Source Control safety rules',
      source === 'workspace' ? 'ok' : 'off',
      source === 'workspace'
        ? 'This workspace\'s own rules (.claude/jarvis/git-risk-policy.json): undo, discard and the rest follow them.'
        : 'JARVIS\'s built-in rules: staging, committing, branching and an ordinary push run; discarding, a hard reset, a forced push and deletions always ask first. A workspace can set its own in .claude/jarvis/git-risk-policy.json.',
      source === 'workspace' ? null : { label: 'Show the folder', action: 'policyFolder' },
    );
  }

  // The workspace's knowledge notes (only a workspace that keeps them has this row). Behind the
  // code is a note, not a fault: Claude reads the code itself, and the notes only save it time.
  const k = f.knowledge;
  if (k && k.available) {
    if (k.state === 'current') {
      add('knowledge', 'core', 'Workspace knowledge', 'ok', 'Up to date with the code.');
    } else {
      const n = Array.isArray(k.stale) ? k.stale.length : 0;
      const what = k.state === 'stale' ? `Behind the code: ${n ? plural(n, 'knowledge file') : 'some knowledge files'} describe${n === 1 ? 's' : ''} code that has changed since the last scan.`
        : k.state === 'no-baseline' ? 'Not scanned yet, so there is no telling how current it is.'
          : `Could not be checked${k.error ? `: ${String(k.error).slice(0, 160)}` : '.'}`;
      add('knowledge', 'core', 'Workspace knowledge', 'note',
        `${what} Nothing is broken - Claude still reads the code itself.${k.relearn ? ' Run /relearn when it suits you.' : ''}`,
        k.relearn ? { label: 'Put /relearn in the chat', action: 'relearn' } : { label: 'Open Knowledge', action: 'knowledge' });
    }
  }

  if (f.updateAvailable) {
    add('update', 'core', 'JARVIS is up to date', 'warn', `Version ${f.updateAvailable} is ready to install.`, { label: 'Update', action: 'updates' });
  } else {
    add('update', 'core', 'JARVIS is up to date', 'ok', f.version ? `You have ${f.version}.` : 'No update is waiting.');
  }

  add(
    'voice', 'core',
    'Voice (speech to text)',
    'ok',
    f.voiceReady ? 'Ready, on this PC.' : 'Runs on this PC. The speech model downloads the first time you use voice.',
    null,
  );

  // ------------------------------------------------------------ integrations: opt-in only
  if (f.telegramOn) add('telegram', 'integrations', 'Phone alerts and Telegram', 'ok', 'Connected. JARVIS can message your phone.');
  else if (f.telegramWanted) add('telegram', 'integrations', 'Phone alerts and Telegram', 'warn', 'Switched on, but the bot or your chat is not set up yet, so nothing reaches your phone.', { label: 'Finish setting up', action: 'telegram' });
  else add('telegram', 'integrations', 'Phone alerts and Telegram', 'off', 'Not set up. Optional: message your phone when work stops, and drive JARVIS from Telegram.', { label: 'Set up', action: 'telegram' });

  add(
    'github', 'integrations',
    'Updates from GitHub',
    f.githubOn ? 'ok' : 'off',
    f.githubOn ? 'Signed in, so JARVIS can check for updates.' : 'Not connected. Optional: connect to let JARVIS check GitHub for its own updates.',
    f.githubOn ? null : { label: 'Connect', action: 'github' },
  );

  const cu = f.clickup || {};
  if (cu.error) add('clickup', 'integrations', 'ClickUp', 'warn', `The last sync did not work: ${String(cu.error).slice(0, 200)}`, { label: 'Open ClickUp', action: 'clickup' });
  else if (cu.used) add('clickup', 'integrations', 'ClickUp', 'ok', cu.member ? `Syncing tasks for ${cu.member}.` : 'Synced.');
  else add('clickup', 'integrations', 'ClickUp', 'off', 'Not set up. Optional: show your ClickUp tasks beside your work.', null);

  // The tools Claude is connected to in this session (MCP servers). One that FAILED is worth a
  // look. One that only needs signing in is optional, like any integration nobody set up.
  const tools = (Array.isArray(f.connectors) ? f.connectors : []).filter((c) => c && c.name);
  if (tools.length) {
    const nice = (c) => String(c.name).replace(/^plugin:[^:]+:/, '');
    const names = (list) => list.map(nice).join(', ');
    const failed = tools.filter((c) => c.status === 'failed');
    const unsigned = tools.filter((c) => c.status === 'needs-auth');
    const on = tools.filter((c) => c.status === 'connected').length;
    const signIn = unsigned.length ? `${names(unsigned)} ${unsigned.length === 1 ? 'is' : 'are'} installed but not signed in, so Claude does not use ${unsigned.length === 1 ? 'it' : 'them'}. Optional: sign in with /mcp in a Claude Code terminal.` : '';
    if (failed.length) {
      add('connectors', 'integrations', 'Connected tools', 'warn', `${names(failed)} could not connect, so Claude cannot use ${failed.length === 1 ? 'it' : 'them'} in this session.${signIn ? ` ${signIn}` : ''}`, { label: 'Show them', action: 'tools' });
    } else if (unsigned.length) {
      add('connectors', 'integrations', 'Connected tools', 'off', `${on ? `${on} connected. ` : ''}${signIn}`, { label: 'Show them', action: 'tools' });
    } else {
      add('connectors', 'integrations', 'Connected tools', 'ok', `${on} connected.`);
    }
  }

  // ------------------------------------------------------------ developer tools on this PC
  // Each one judged against what the workspace's projects need (project-providers.mjs).
  const projects = Array.isArray(f.projects) ? f.projects : [];
  const relevance = capabilityRelevance(projects, f.capabilities || []);
  for (const cap of f.capabilities || []) {
    const rel = relevance[cap.id] || { used: 0, unmet: 0, unmetProjects: [], types: new Set() };
    const usedBy = rel.used ? ` Used by ${plural(rel.used, 'project')} here.` : '';
    let state;
    let detail;
    if (cap.installed && cap.configured !== false) {
      state = 'ok';
      detail = `Ready${cap.version ? `, v${cap.version}` : ''}.${usedBy}`;
    } else if (!cap.installed && rel.unmet) {
      const kinds = [...rel.types].map((t) => TYPE_LABEL[t] || t).join(' / ') || cap.label;
      const names = rel.unmetProjects.slice(0, 3).join(', ') + (rel.unmetProjects.length > 3 ? ', …' : '');
      state = 'warn';
      detail = `${kinds} ${rel.unmet === 1 ? 'project' : 'projects'} detected (${names}), but ${cap.label} is not installed. ${INSTALL_HINT[cap.id] || ''}`.trim();
    } else if (!cap.installed) {
      state = 'off';
      detail = `Not installed. Optional - ${OPTIONAL_PURPOSE[cap.id] || 'not needed by anything here.'}`;
    } else {
      // Installed, but not configured (the GitHub CLI signed out). Nothing in JARVIS needs it.
      state = 'off';
      detail = `${cap.error || 'Installed, but not configured.'} Optional.`;
    }
    add(`cap:${cap.id}`, 'tools', cap.label, state, detail, null);
  }

  const bad = checks.filter((c) => c.state === 'bad').length;
  const warn = checks.filter((c) => c.state === 'warn').length;
  return {
    checks,
    bad,
    warn,
    summary: bad ? `${bad} thing${bad === 1 ? '' : 's'} need${bad === 1 ? 's' : ''} fixing` : warn ? `Working - ${plural(warn, 'thing')} to look at` : 'Everything is in order',
    level: bad ? 'bad' : warn ? 'warn' : 'ok',
  };
}
