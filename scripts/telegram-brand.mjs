// Dress the Telegram bot as JARVIS: profile picture, description and command menu.
//   npm run brand-bot            (or: node scripts/telegram-brand.mjs)
//
// Run once after creating the bot, and again if any of this changes. Rotating the token does
// not undo it - these belong to the bot, not to the token. The token is read from
// %APPDATA%\JARVIS\config.json (what Settings -> Phone alerts -> Check token saved) and is
// never printed; telegram.mjs keeps it out of error text too.
//
// The picture is build/telegram-avatar.jpg: build/source.png cropped square around the HUD
// ring and scaled to 640 px, because Telegram shows profile pictures as circles - a crop of
// the whole rounded-square icon would have its corners sliced off. It is a JPEG because
// that is what a static profile photo must be (InputProfilePhotoStatic).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { call } from '../src/telegram.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const AVATAR = path.join(root, 'build', 'telegram-avatar.jpg');

// Shown in the empty chat before the first message ("What can this bot do?"). 512 max.
const DESCRIPTION = [
  'JARVIS runs on your PC. Message it here and it works there - in your workspace, with your files and repos.',
  '',
  'Approvals and questions come back as buttons. Only its owner’s chat is obeyed; anyone else gets silence.',
].join('\n');
// Shown on the bot's profile page. 120 max.
const SHORT = 'Your JARVIS, from anywhere: send a task, approve its steps, get the answer.';
// The menu behind the "/" button - the same commands remote.mjs answers.
const COMMANDS = [
  { command: 'status', description: 'What JARVIS is doing, and what waits on you' },
  { command: 'stop', description: 'Stop the current turn' },
  { command: 'new', description: 'Start a new session' },
  { command: 'sessions', description: 'Recent sessions - tap one to switch' },
  { command: 'switch', description: 'Carry on an earlier session' },
  { command: 'screen', description: 'A screenshot of the PC' },
  { command: 'diff', description: 'What has changed in the repos' },
  { command: 'brief', description: 'The morning brief, now' },
  { command: 'help', description: 'What JARVIS can do from here' },
];

let token;
try {
  token = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA || '', 'JARVIS', 'config.json'), 'utf8'))?.phone?.telegram?.token;
} catch { /* reported below */ }
if (!token) {
  console.error('No bot token yet. Set one in JARVIS: Settings -> Phone alerts -> Telegram -> Check token.');
  process.exit(1);
}

let failed = 0;
const report = (what, r) => {
  if (!r.ok) failed++;
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${what}${r.ok ? '' : ` - ${r.error}`}`);
};

const me = await call(token, 'getMe');
report(`bot ${me.ok ? `@${me.result.username}` : ''}`, me);
if (!me.ok) process.exit(1);

// The picture: multipart, the file under a name the InputProfilePhoto points at.
const form = new FormData();
form.append('photo', JSON.stringify({ type: 'static', photo: 'attach://avatar' }));
form.append('avatar', new Blob([fs.readFileSync(AVATAR)], { type: 'image/jpeg' }), 'avatar.jpg');
report('profile picture', await call(token, 'setMyProfilePhoto', form, { timeoutMs: 60000 }));

report('description', await call(token, 'setMyDescription', { description: DESCRIPTION }));
report('short description', await call(token, 'setMyShortDescription', { short_description: SHORT }));
report('command menu', await call(token, 'setMyCommands', { commands: COMMANDS }));

process.exit(failed ? 1 : 0);
