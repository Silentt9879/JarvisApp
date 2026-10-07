// The features added on 2026-10-07, wired into the app. main.mjs owns the windows and the chat
// session; this file owns what gets recorded, what runs on a timer, and the answers the window
// and the phone web app ask for. Everything here is injected, so it can be tested with fakes.
import fs from 'node:fs';
import path from 'node:path';
import { ActivityLog, entryFor, redact } from './activity.mjs';
import { UsageTracker } from './usage.mjs';
import { PromptLibrary } from './prompts.mjs';
import { RoutineStore, isDue, nextRunAt, runRoutine } from './routines.mjs';
import { buildHealth } from './health.mjs';
import { CompanionServer, newAccessCode, lanAddresses } from './companion.mjs';
import { TEMPLATES, createProject } from './projects.mjs';
import { runCommand, saveToken, loadToken } from './updates.mjs';
import { getCapabilities } from './capabilities.mjs';
import { policySource } from './git-policy.mjs';
import { LimitsStore, windowsFromEvent, overageFromEvent, refreshUsage } from './limits.mjs';

const TRANSCRIPT_KEEP = 40;
const DEFAULT_PORT = 8787;
const TICK_MS = 60 * 1000;
const MAX_SPEECH_SAMPLES = 16000 * 30; // thirty seconds at 16 kHz is the most a voice request can be

const clip = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * @param d  injected pieces: app, ipcMain, shell, dialog, Notification, safeStorage, userDir, srcDir,
 *           configPath, firstRun, log, loadConfig, saveConfig, query, claudeExe, remote, voice,
 *           getWin, isCapture, showWindow, showView, respondAny, interruptAll, submitMessage,
 *           startSignIn, authState, githubOn, telegramOn, updateInfo,
 *           and, optional: telegramWanted, clickupState, projects ({ refresh }) => discovery
 */
export function createFeatures(d) {
  const { app, ipcMain, shell, dialog, Notification, safeStorage, userDir, srcDir, log, loadConfig, saveConfig } = d;
  const activity = new ActivityLog(path.join(userDir, 'activity.jsonl'));
  const usage = new UsageTracker(path.join(userDir, 'usage.json'));
  const prompts = new PromptLibrary(path.join(userDir, 'prompts.json'));
  const routines = new RoutineStore(path.join(userDir, 'routines.json'));
  const codeFile = path.join(userDir, 'companion-code.bin');
  const limits = new LimitsStore(path.join(userDir, 'limits.json'));
  let planCache = { at: 0, label: null };

  const transcript = []; // what the phone shows first: the last few messages, plain text
  const waiting = new Map(); // permission id -> what it is for, until it is answered
  let lastStatus = 'ready';
  let busyRoutine = null;
  let timer = null;
  let companion = null;

  const budget = () => Math.max(0, Number(loadConfig().budgetUsd) || 0);
  const isCapture = () => !!d.isCapture;

  function pushTranscript(role, text) {
    const t = clip(redact(text), 4000);
    if (!t.trim()) return;
    transcript.push({ role, text: t });
    if (transcript.length > TRANSCRIPT_KEEP) transcript.splice(0, transcript.length - TRANSCRIPT_KEEP);
  }

  function toast(title, body, onClick) {
    if (isCapture() || !Notification?.isSupported?.()) return;
    try {
      const n = new Notification({ title, body: clip(body, 220), silent: false });
      if (onClick) n.on('click', () => onClick());
      n.show();
    } catch { /* notifications are a nicety */ }
  }

  // A permission request with Allow and Deny buttons, when the window is not in front.
  function permissionToast(evt) {
    if (isCapture() || !Notification?.isSupported?.()) return;
    const w = d.getWin?.();
    if (w && !w.isDestroyed() && w.isFocused()) return;
    try {
      const n = new Notification({
        title: 'JARVIS needs you',
        body: clip(`${evt.displayName || evt.toolName || 'A tool'}: ${evt.detail || ''}`, 200),
        actions: [{ type: 'button', text: 'Allow' }, { type: 'button', text: 'Deny' }],
        closeButtonText: 'Later',
      });
      n.on('action', (_e, index) => {
        const allow = index === 0;
        d.respondAny(evt.id, { type: allow ? 'allow' : 'deny' });
        activity.add('approval', `${allow ? 'Allowed' : 'Denied'} from the notification: ${evt.displayName || evt.toolName || 'a tool'}`);
        waiting.delete(evt.id);
      });
      n.on('click', () => d.showWindow?.());
      n.show();
    } catch { /* falls back to the window's own prompt */ }
  }

  function checkBudget() {
    const limit = budget();
    if (!limit) return;
    const s = usage.summary(limit);
    if (!s.overBudget || s.alertedToday) return;
    usage.markAlerted();
    const msg = `Today's estimated cost is about $${s.today.costUsd.toFixed(2)}, past your $${limit.toFixed(2)} limit.`;
    activity.add('system', msg);
    toast('JARVIS budget reached', msg, () => d.showView?.('automations'));
    d.remote?.announce?.(`💸 ${msg}`)?.catch?.(() => {});
  }

  /** Every session event goes through here. Pane windows pass pane: true; the phone only hears the main chat. */
  function onEvent(evt, { pane = false } = {}) {
    if (!evt || typeof evt !== 'object') return;
    try {
      const e = entryFor(evt);
      if (e) activity.add(e.kind, e.text);
      if (evt.kind === 'status' && !pane) lastStatus = evt.state || lastStatus;
      if (evt.kind === 'text_final' && !pane) pushTranscript('assistant', evt.text);
      if (evt.kind === 'permission') {
        waiting.set(evt.id, { toolName: evt.displayName || evt.toolName || 'A tool', detail: clip(evt.detail || '', 200) });
        permissionToast(evt);
      }
      if (evt.kind === 'rate_limit' && evt.info) {
        // Each request says how much of the session and the week is used; keep the latest reading.
        limits.mergeWindows(windowsFromEvent(evt.info), { source: 'event', overage: overageFromEvent(evt.info) ?? undefined });
      }
      if (evt.kind === 'prompt_done') waiting.delete(evt.id);
      if (evt.kind === 'result') {
        usage.record({ costUsd: Number(evt.costUsd) || 0, turns: Number(evt.turns) || 1 });
        checkBudget();
      }
      if (!pane) companion?.event(evt);
    } catch (e) {
      log('features:', e?.message || e);
    }
  }

  /** A message that went to the chat, from the desk, Telegram or the phone web app. */
  function noteUser(text, origin = 'desk') {
    try {
      if (origin !== 'desk') activity.add('phone', `Message from ${origin === 'telegram' ? 'Telegram' : 'the phone'}: ${clip(redact(text), 120)}`);
      pushTranscript('user', text);
    } catch { /* never block a message */ }
  }

  /** An answer to a permission request, from anywhere: logged in the activity log. */
  function noteDecision(id, decision, from = 'desk') {
    const p = waiting.get(id);
    const what = p ? p.toolName : 'a request';
    const type = decision?.type;
    const word = type === 'deny' ? 'Denied' : type === 'allow' || type === 'allow_always' ? 'Allowed' : 'Answered';
    activity.add('approval', `${word} ${what}${from === 'desk' ? '' : ` (from ${from})`}`);
    waiting.delete(id);
  }

  // -------------------------------------------------------------- routines

  async function runRoutineNow(r) {
    if (busyRoutine) return { ok: false, error: 'Another routine is running. Wait for it to finish, then try again.' };
    // A routine runs IN a folder: its own, or the active workspace. Never a guessed one.
    if (!r.cwd && !loadConfig().cwd) return { ok: false, error: 'Choose a workspace first - a routine without its own folder runs in the active workspace.' };
    busyRoutine = r.id;
    activity.add('routine', `Started "${r.name}"`);
    try {
      const out = await runRoutine(r, { query: d.query, exe: d.claudeExe(), defaultCwd: loadConfig().cwd, trusted: !!d.folderTrusted?.(r.cwd || loadConfig().cwd) });
      const summary = out.ok ? (out.text || 'Finished.') : `Did not finish: ${out.error || 'unknown reason'}`;
      routines.markRun(r.id, { ok: out.ok, summary });
      usage.recordRun(out.costUsd);
      activity.add('routine', `${out.ok ? 'Finished' : 'Stopped'} "${r.name}": ${clip(summary, 160)}`);
      if (r.deliver?.toast) toast(`Routine: ${r.name}`, summary, () => d.showView?.('automations'));
      if (r.deliver?.telegram && d.remote?.ready) d.remote.announce(`⏰ Routine: ${r.name}\n${clip(summary, 3000)}`)?.catch?.(() => {});
      return { ok: out.ok, summary };
    } catch (e) {
      const msg = String(e?.message || e);
      routines.markRun(r.id, { ok: false, summary: msg });
      activity.add('routine', `Stopped "${r.name}": ${clip(msg, 160)}`);
      return { ok: false, summary: msg };
    } finally {
      busyRoutine = null;
    }
  }

  function routineTick() {
    if (isCapture() || busyRoutine) return;
    const now = new Date();
    for (const r of routines.list()) {
      if (isDue(r, now)) { runRoutineNow(r).catch(() => {}); return; }
    }
  }

  // -------------------------------------------------------------- the phone web app

  function currentCode(create) {
    let code = loadToken(codeFile, { safe: safeStorage });
    if (!code && create) {
      code = newAccessCode();
      saveToken(codeFile, code, { safe: safeStorage });
    }
    return code;
  }

  const companionHandlers = {
    state: async () => ({
      ok: true,
      status: lastStatus,
      transcript: transcript.slice(-30),
      waiting: [...waiting.entries()].map(([id, p]) => ({ id, tool: p.toolName, detail: p.detail })),
    }),
    send: async (text) => d.submitMessage({ text, attachments: [], origin: 'phone' }),
    respond: async (id, decision) => {
      const allowed = ['allow', 'allow_always', 'deny', 'reply', 'answer'];
      if (!id || !allowed.includes(decision?.type)) return { ok: false, error: 'That answer is not understood.' };
      noteDecision(id, decision, 'phone');
      d.respondAny(id, decision);
      return { ok: true };
    },
    interrupt: async () => { d.interruptAll(); return { ok: true }; },
  };

  function companionSettings() {
    const c = loadConfig();
    return { on: !!c.companionOn, port: Number(c.companionPort) || DEFAULT_PORT };
  }

  async function startCompanion() {
    const { on, port } = companionSettings();
    if (!on || isCapture()) return { ok: true, running: false };
    try {
      const code = currentCode(true);
      const html = fs.readFileSync(path.join(srcDir, 'companion', 'index.html'), 'utf8');
      if (!companion) companion = new CompanionServer({ html, code, handlers: companionHandlers, log });
      else companion.code = code;
      if (companion.running) return { ok: true, running: true, port };
      const a = await companion.start(port, '0.0.0.0');
      log(`companion: phone web app listening on port ${a.port}`);
      return { ok: true, running: true, port: a.port };
    } catch (e) {
      const busy = e?.code === 'EADDRINUSE';
      return { ok: false, running: false, error: busy ? `Port ${port} is already in use. Pick another port in Settings.` : `The phone web app could not start: ${e?.message || e}` };
    }
  }

  async function stopCompanion() {
    if (companion?.running) await companion.stop();
  }

  function companionStatus() {
    const { on, port } = companionSettings();
    return { on, port, running: !!companion?.running, addresses: lanAddresses(), hasCode: !!currentCode(false) };
  }

  // -------------------------------------------------------------- health

  /**
   * What Health judges from. `refresh` asks the developer tools afresh (a just-installed SDK
   * shows up) and scans the workspace again; otherwise the last few minutes' answers are used.
   */
  async function healthFacts({ refresh = false } = {}) {
    const cfg = loadConfig();
    const cwd = cfg.cwd || '';
    const [auth, capabilities, scanned, githubOn] = await Promise.all([
      Promise.resolve(d.authState()).catch(() => ({ ok: false })),
      getCapabilities({ force: !!refresh }).catch(() => []),
      // The workspace's projects decide which tools matter (project-providers.mjs).
      cwd && d.projects ? Promise.resolve(d.projects({ refresh })).catch(() => null) : null,
      Promise.resolve(d.githubOn()).catch(() => false),
    ]);
    const trusted = d.workspaceTrusted ? !!d.workspaceTrusted() : null;
    return {
      configProblem: d.configProblem?.() || null,
      claudeFound: fs.existsSync(d.claudeExe()),
      signedIn: auth.ok ? !!auth.loggedIn : null,
      account: auth.email || null,
      workspaceConfigured: !!cwd,
      workspace: cwd,
      workspaceFound: !!cwd && fs.existsSync(cwd),
      workspaceTrusted: trusted,
      policyFound: !!cwd && fs.existsSync(path.join(cwd, '.claude', 'jarvis', 'git-risk-policy.json')),
      // A restricted workspace runs no Git, so its own rules are not in use either.
      policySource: !cwd ? null : trusted === false ? 'restricted' : policySource(cwd),
      telegramOn: !!d.telegramOn(),
      telegramWanted: !!d.telegramWanted?.(),
      githubOn,
      clickup: d.clickupState?.() || null,
      updateAvailable: d.updateInfo()?.available || null,
      version: app.getVersion(),
      voiceReady: !!d.voice?.ready,
      capabilities,
      projects: scanned?.projects || [],
    };
  }

  /** The plan's name from the sign-in ("Max", "Pro", ...), cached for a few minutes. Null when unknown. */
  async function planLabel() {
    if (Date.now() - planCache.at < 5 * 60 * 1000) return planCache.label;
    const auth = await Promise.resolve(d.authState()).catch(() => null);
    const names = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise' };
    const raw = String(auth?.subscriptionType || '').toLowerCase();
    planCache = { at: Date.now(), label: names[raw] || (raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : null) };
    return planCache.label;
  }

  // -------------------------------------------------------------- what's new, welcome

  function welcome() {
    const cfg = loadConfig();
    const version = app.getVersion();
    const pending = cfg.whatsNewPending && cfg.whatsNewPending.version === version ? cfg.whatsNewPending : null;
    const changed = !!cfg.lastSeenVersion && cfg.lastSeenVersion !== version;
    return {
      version,
      setupNeeded: !cfg.setupDone && !!d.firstRun,
      // No folder to work in: the window asks for one, set-up done or not.
      workspaceNeeded: !cfg.cwd,
      whatsNew: pending ? { version, notes: String(pending.notes || '') } : changed ? { version, notes: '' } : null,
    };
  }

  // -------------------------------------------------------------- IPC

  function registerIpc() {
    ipcMain.handle('app:welcome', () => welcome());
    ipcMain.handle('app:welcomeDone', (_e, what) => {
      const version = app.getVersion();
      if (what === 'setup') saveConfig({ setupDone: true, lastSeenVersion: version });
      if (what === 'whatsnew') saveConfig({ whatsNewPending: null, lastSeenVersion: version });
      return { ok: true };
    });
    ipcMain.handle('ui:zoom', (e, factor) => {
      const f = Math.min(1.5, Math.max(0.8, Number(factor) || 1));
      e.sender.setZoomFactor(f);
      return { ok: true, factor: f };
    });

    ipcMain.handle('health:get', async (_e, refresh) => buildHealth(await healthFacts({ refresh: refresh === true })));
    ipcMain.handle('health:fix', async (_e, action) => {
      if (action === 'signin') return { ok: true, started: await Promise.resolve(d.startSignIn()) };
      if (action === 'policyFolder') {
        const cwd = loadConfig().cwd || '';
        const dir = path.join(cwd, '.claude', 'jarvis');
        const target = fs.existsSync(dir) ? dir : cwd;
        if (!target || !fs.existsSync(target)) return { ok: false, error: 'The workspace folder is not there.' };
        await shell.openPath(target);
        return { ok: true };
      }
      // A settings file that cannot be read: Explorer, with config.json selected.
      if (action === 'configFile') {
        if (!d.configPath || !fs.existsSync(d.configPath)) return { ok: false, error: 'The settings file is not there.' };
        shell.showItemInFolder(d.configPath);
        return { ok: true };
      }
      return { ok: true, handled: 'window' };
    });

    ipcMain.handle('activity:list', (_e, opts = {}) => activity.recent({
      kind: opts.kind || null,
      query: String(opts.query || ''),
      limit: Math.min(500, Number(opts.limit) || 300),
    }));
    ipcMain.handle('activity:export', async () => {
      const options = {
        title: 'Export the activity log',
        defaultPath: path.join(app.getPath('documents'), 'JARVIS activity.txt'),
        filters: [{ name: 'Text', extensions: ['txt'] }],
      };
      const w = d.getWin?.();
      const r = w && !w.isDestroyed() ? await dialog.showSaveDialog(w, options) : await dialog.showSaveDialog(options);
      if (r.canceled || !r.filePath) return { ok: false, canceled: true };
      fs.writeFileSync(r.filePath, activity.exportText());
      shell.showItemInFolder(r.filePath);
      return { ok: true, path: r.filePath };
    });

    ipcMain.handle('usage:summary', () => usage.summary(budget()));
    // The plan's limits (AI Core). The reading is kept; "refresh" runs /usage, which costs nothing.
    ipcMain.handle('usage:limits', async () => ({ ...limits.get(), plan: await planLabel() }));
    ipcMain.handle('usage:refreshLimits', async () => {
      const r = await refreshUsage(limits, { query: d.query, exe: d.claudeExe(), cwd: loadConfig().cwd || undefined });
      return { ...r, plan: await planLabel() };
    });
    ipcMain.handle('usage:budget', (_e, n) => {
      const v = Number(n);
      if (!Number.isFinite(v) || v < 0 || v > 1000) return { ok: false, error: 'Pick a number between 0 and 1000 dollars. Use 0 for no limit.' };
      saveConfig({ budgetUsd: Math.round(v * 100) / 100 });
      return { ok: true, budgetUsd: Math.round(v * 100) / 100 };
    });

    ipcMain.handle('prompts:list', () => prompts.list());
    ipcMain.handle('prompts:add', (_e, input) => prompts.add(input || {}));
    ipcMain.handle('prompts:update', (_e, id, input) => prompts.update(String(id || ''), input || {}));
    ipcMain.handle('prompts:remove', (_e, id) => prompts.remove(String(id || '')));

    const withNext = (r) => ({ ...r, nextRun: (() => { const n = nextRunAt(r, new Date()); return n ? n.getTime() : null; })() });
    ipcMain.handle('routines:list', () => routines.list().map(withNext));
    ipcMain.handle('routines:add', (_e, input) => { const r = routines.add(input || {}); return r.ok ? { ...r, item: withNext(r.item) } : r; });
    ipcMain.handle('routines:update', (_e, id, input) => { const r = routines.update(String(id || ''), input || {}); return r.ok ? { ...r, item: withNext(r.item) } : r; });
    ipcMain.handle('routines:remove', (_e, id) => routines.remove(String(id || '')));
    ipcMain.handle('routines:runNow', async (_e, id) => {
      const r = routines.list().find((x) => x.id === String(id || ''));
      if (!r) return { ok: false, error: 'That routine no longer exists.' };
      return runRoutineNow(r);
    });

    ipcMain.handle('companion:status', () => companionStatus());
    ipcMain.handle('companion:set', async (_e, input = {}) => {
      const port = Math.round(Number(input.port) || DEFAULT_PORT);
      if (port < 1024 || port > 65535) return { ok: false, error: 'Pick a port between 1024 and 65535.' };
      saveConfig({ companionOn: !!input.on, companionPort: port });
      if (!input.on) { await stopCompanion(); return { ok: true, ...companionStatus() }; }
      const r = await startCompanion();
      return { ...(r.ok ? { ok: true } : { ok: false, error: r.error }), ...companionStatus() };
    });
    ipcMain.handle('companion:reveal', () => ({ ok: true, code: currentCode(true) }));
    ipcMain.handle('companion:newCode', async () => {
      saveToken(codeFile, newAccessCode(), { safe: safeStorage });
      if (companion?.running) { await stopCompanion(); await startCompanion(); }
      return { ok: true, ...companionStatus() };
    });

    ipcMain.handle('voice:transcribe', async (_e, samples) => {
      if (!(samples instanceof Float32Array) || samples.length < 1600) return { ok: false, error: 'Too short to understand.' };
      if (samples.length > MAX_SPEECH_SAMPLES) return { ok: false, error: 'That was too long for one request.' };
      return d.voice.transcribe(samples);
    });

    ipcMain.handle('project:templates', () => Object.entries(TEMPLATES).map(([id, t]) => ({ id, label: t.label, blurb: t.blurb, tool: t.tool })));
    ipcMain.handle('project:create', async (_e, input = {}) => createProject({
      parent: String(input.parent || ''),
      name: String(input.name || ''),
      template: String(input.template || ''),
      run: runCommand,
      hasTool: async (t) => (await runCommand(process.platform === 'win32' ? 'where' : 'which', [t], { timeoutMs: 15000 })).ok,
    }));
    // A FOLDER, in Explorer. Never a file: opening a path "with its default app" would run a
    // program, and the path comes from the window.
    ipcMain.handle('project:open', async (_e, p) => {
      let st = null;
      try { st = typeof p === 'string' && path.isAbsolute(p) ? fs.statSync(p) : null; } catch { /* reported below */ }
      if (!st || !st.isDirectory()) return { ok: false, error: 'That folder is not there.' };
      await shell.openPath(p);
      return { ok: true };
    });
  }

  function start() {
    if (!timer && !isCapture()) timer = setInterval(routineTick, TICK_MS);
    timer?.unref?.();
    return startCompanion();
  }

  async function stop() {
    clearInterval(timer);
    timer = null;
    await stopCompanion();
  }

  return { onEvent, noteUser, noteDecision, registerIpc, start, stop, welcome, runRoutineNow, companionStatus, activity, usage, prompts, routines };
}
