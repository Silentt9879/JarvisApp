// Signing in and out: the three CLI commands JARVIS drives, and the Settings UI around
// them. The CLI itself is replaced throughout - no real sign-in or sign-out is performed,
// and no credential is read, in this test or anywhere in the code it checks.
import fs from 'node:fs';

let pass = 0; const fails = [];
const check = (n, c, extra) => {
  if (c) { pass += 1; console.log('PASS  ' + n); }
  else { fails.push(n); console.log('FAIL  ' + n + (extra ? '\n        ' + String(extra).slice(0, 300) : '')); }
};
const APP = process.env.P9_APP || 'C:/Users/bantu/Downloads/JarvisApp';
const read = (p) => fs.readFileSync(p, 'utf8');
const A = await import(`file:///${APP}/src/auth.mjs`);

// ---------------------------------------------------------------- reading the status
const REAL = JSON.stringify({
  loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'someone@example.com',
  orgId: '7f3126fe', orgName: "someone's Organization", subscriptionType: 'max',
});
const calls = [];
const runner = (out, ok = true) => async (exe, args) => { calls.push({ exe, args }); return ok ? { ok: true, stdout: out, stderr: '' } : { ok: false, error: out }; };

const st = await A.authStatus('claude.exe', { run: runner(REAL) });
check('the status is read from `auth status --json`, and says who is signed in',
  st.ok && st.loggedIn && st.email === 'someone@example.com' && st.subscriptionType === 'max'
  && st.orgName === "someone's Organization" && calls[0].args.join(' ') === 'status --json', JSON.stringify({ st, c: calls[0] }));
check('nothing but those few fields is passed on - no org id, no token, no raw output',
  Object.keys(st).sort().join(',') === 'apiProvider,authMethod,email,loggedIn,ok,orgName,subscriptionType');

const out = await A.authStatus('claude.exe', { run: runner(JSON.stringify({ loggedIn: false })) });
check('a signed-out CLI reads as signed out, with no email', out.ok && !out.loggedIn && out.email === null);
check('output that is not JSON reads as signed out rather than throwing',
  A.parseStatus('claude: command not found').loggedIn === false && A.parseStatus('').unreadable === true
  && A.parseStatus('null').unreadable === true);
const broke = await A.authStatus('claude.exe', { run: runner('the CLI exploded', false) });
check('a failed command comes back as an error, not as "signed out" with no explanation',
  !broke.ok && broke.loggedIn === false && /exploded/.test(broke.error));

// ---------------------------------------------------------------- signing out
calls.length = 0;
const bye = await A.authLogout('claude.exe', { run: runner('') });
check('signing out runs `auth logout`, and nothing else', bye.ok && calls.length === 1 && calls[0].args.join(' ') === 'logout');
const noBye = await A.authLogout('claude.exe', { run: runner('refused', false) });
check('a refusal to sign out is reported rather than claimed as done', !noBye.ok && /refused/.test(noBye.error));

// ---------------------------------------------------------------- signing in
let spawned = null;
const fakeSpawn = (cmd, args, opts) => { spawned = { cmd, args, opts }; return { unref() {} }; };
const started = A.startLogin('C:\\path with space\\claude.exe', { spawnFn: fakeSpawn });
check('signing in opens a console window of its own, detached, running `auth login`',
  started.ok && spawned.cmd === 'cmd.exe' && spawned.opts.detached === true && spawned.opts.stdio === 'ignore'
  && /auth login/.test(spawned.args.join(' ')), JSON.stringify(spawned));
check('the exe path is quoted, so a folder with a space in it still starts',
  spawned.args.join(' ').includes('"C:\\path with space\\claude.exe"') && spawned.opts.windowsVerbatimArguments === true, spawned.args.join(' '));
check('a spawn that throws is reported, not swallowed',
  A.startLogin('x', { spawnFn: () => { throw new Error('no shell'); } }).ok === false);

// ---------------------------------------------------------------- nothing secret anywhere
check('a token in an error is scrubbed before it can reach the window or the log',
  !/sk-ant-oat01-REAL/.test(A.scrub('failed with key sk-ant-oat01-REALSECRET123 - retry'))
  && /sk-ant-\*\*\*/.test(A.scrub('failed with key sk-ant-oat01-REALSECRET123 - retry'))
  && A.scrub(`bearer ${'a'.repeat(80)}`) === 'bearer ***');
const auth = read(`${APP}/src/auth.mjs`);
const authCode = auth.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('auth.mjs only ever runs the three auth commands - it reads no file and no environment',
  /\['status', '--json'\]/.test(auth) && /\['logout'\]/.test(auth) && /auth login/.test(auth)
  && !/node:fs|readFileSync|process\.env|credentials/i.test(authCode), authCode.match(/node:fs|readFileSync|process\.env|credentials/i));

// ---------------------------------------------------------------- the wiring
const main = read(`${APP}/src/main.mjs`);
const pre = read(`${APP}/src/preload.cjs`);
const html = read(`${APP}/src/renderer/index.html`);
const app = read(`${APP}/src/renderer/app.js`);
check('main exposes the three account calls plus the restart, and no token with them',
  ["ipcMain.handle('jarvis:authStatus'", "ipcMain.handle('jarvis:authLogin'", "ipcMain.handle('jarvis:authLogout'", "ipcMain.handle('jarvis:restartApp'"]
    .every((h) => main.includes(h)));
check('signing out also stops the running session, which holds the old credentials',
  /authLogout\(claudeExe\(\)\)[\s\S]{0,400}session\?\.close\(\)[\s\S]{0,80}session = null/.test(main));
check('a screenshot run can neither sign in nor sign out',
  /JARVIS_CAPTURE[\s\S]{0,120}would open the sign-in window/.test(main)
  && /JARVIS_CAPTURE[\s\S]{0,120}disabled during a screenshot run/.test(main));
check('the bridge passes the four calls and nothing more', ['authStatus:', 'authLogin:', 'authLogout:', 'restartApp:'].every((k) => pre.includes(k)));
check('Settings has an Account section with one button, a sign-out confirmation and a restart row',
  /id="acctWho"/.test(html) && /id="acctBtn"/.test(html) && /id="acctConfirm"/.test(html)
  && /id="acctGo"/.test(html) && /id="acctCancel"/.test(html) && /id="acctRestart"/.test(html));
check('its ids are each declared exactly once',
  ['acctWho', 'acctNote', 'acctBtn', 'acctConfirm', 'acctEmail', 'acctCancel', 'acctGo', 'acctRestart', 'acctNew', 'acctRestartGo']
    .every((id) => html.split(`id="${id}"`).length === 2));
// the button's own handler, up to the next handler: it must only ever open the confirmation
const btnHandler = app.slice(app.indexOf("$('acctBtn').onclick"), app.indexOf("$('acctCancel').onclick"));
check('signing out is never one press: the button opens a confirmation, and only that confirms',
  /acctConfirm'\)\.hidden = false/.test(btnHandler) && !/authLogout/.test(btnHandler)
  && /\$\('acctGo'\)\.onclick[\s\S]{0,300}window\.jarvis\.authLogout\(\)/.test(app), btnHandler.slice(0, 200));
check('opening Settings asks who is signed in, so a change made elsewhere shows up',
  /renderWorkspace\(\);\s*\r?\n\s*loadAccount\(\);/.test(app));
check('the header says "Not signed in" plainly after signing out', /signedOut \? 'Not signed in'/.test(app));
check('the window asks for status, login and logout - and never for a token',
  /window\.jarvis\.authStatus\(\)/.test(app) && /window\.jarvis\.authLogin\(\)/.test(app)
  && !/token/i.test(app.slice(app.indexOf('the account'), app.indexOf('appearance'))));

console.log(`\n${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('  FAILED: ' + f);
process.exit(fails.length ? 1 : 0);
