// Phone alerts - a notification on your own Android phone when JARVIS finishes a long
// turn or is blocked waiting for you.
//
// Nothing is installed on the phone and nothing leaves this machine. Android's own
// `cmd notification post` runs as the shell user, so anything adb can reach can raise a
// notification in the tray. That gives two routes, both local:
//   - USB: works the moment the cable is in, with the debugging prompt already accepted.
//   - Wi-Fi: `adb tcpip 5555` once over the cable, then `adb connect <phone-ip>:5555`.
//     The phone keeps listening until it reboots; we re-connect on demand after that.
//
// It uses the same adb the Devices view uses, so there is never a second adb server
// fighting Flutter's.
import { execFile } from 'node:child_process';
import { adbExecutable, isSerial } from './devices.mjs';

const TAG = 'jarvis';
const CONNECT = /^[A-Za-z0-9.\-]{1,60}:\d{1,5}$/; // host:port for `adb connect`

/** Run adb and resolve { ok, out }. adb is never given user text as separate arguments. */
function adb(args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(adbExecutable(), args, { windowsHide: true, timeout, maxBuffer: 1 << 20 }, (err, out, errOut) => {
      const text = `${out || ''}${errOut || ''}`.trim();
      resolve({ ok: !err, out: text });
    });
  });
}

/**
 * One argument for the phone's /bin/sh, safely quoted.
 * Everything we send is text the model or a tool produced, so it is never trusted:
 * control characters go, and a single quote is closed, escaped and reopened.
 */
export function sh(value, max = 220) {
  const clean = String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ') // newlines and control codes confuse adb shell
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
  return `'${clean.replace(/'/g, `'\\''`)}'`;
}

/**
 * Is a notification with this tag in the tray? The post command returns before Android
 * has finished registering it, so the first look is reliably too early - give it a few
 * tries before believing it is absent.
 */
async function landed(serial, tag, run, waitMs) {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((r) => setTimeout(r, waitMs));
    const list = await run(['-s', serial, 'shell', 'cmd notification list']);
    if (!list.ok) return true; // cannot tell; do not cry wolf on a bad read
    if (list.out.split('\n').some((line) => line.split('|')[3] === tag)) return true;
  }
  return false;
}

/**
 * Post a notification to one phone. Every alert carries the same tag, so the newest
 * replaces the last rather than stacking a pile of them up.
 *
 * `cmd notification post` reports success as soon as it has built the notification, which
 * says nothing about whether the phone showed it - a phone whose owner has turned off
 * notifications for "Shell" accepts every one of these in silence. So the tray is checked
 * afterwards, and a buzz that never arrived is reported as the failure it is.
 */
export async function postNotification(serial, { title, body, tag = TAG, verify = true }, { run = adb, landedWaitMs = 400 } = {}) {
  if (!isSerial(serial)) return { ok: false, error: 'Not a device serial.' };
  const cmd = `cmd notification post -S bigtext -t ${sh(title, 60)} ${sh(tag, 40)} ${sh(body, 220)}`;
  const r = await run(['-s', serial, 'shell', cmd]);
  // The command prints the Notification it built; anything else is a refusal.
  if (!r.ok || !/posting:|Notification\(/i.test(r.out)) {
    return { ok: false, error: r.out ? r.out.split('\n')[0].slice(0, 200) : 'adb did not answer.' };
  }
  if (verify && !(await landed(serial, tag, run, landedWaitMs))) {
    return { ok: false, error: 'The phone took the notification but did not show it. Allow notifications from "Shell" on the phone.' };
  }
  return { ok: true, tag };
}

/** The phones adb can see right now, newest-style `adb devices -l` output. */
export async function listPhones({ run = adb } = {}) {
  const r = await run(['devices', '-l']);
  if (!r.ok) return [];
  return r.out.split('\n').slice(1).map((line) => {
    const m = /^(\S+)\s+(device|unauthorized|offline)\b(.*)$/.exec(line.trim());
    if (!m) return null;
    const model = /model:(\S+)/.exec(m[3]);
    return {
      serial: m[1],
      state: m[2],
      model: (model ? model[1] : '').replace(/_/g, ' '),
      wifi: m[1].includes(':'),
    };
  }).filter(Boolean);
}

/** A phone's address on the local network - never the mobile one. */
const LAN = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/;
const MOBILE = /^(rmnet|ccmni|rndis|dummy|tun|p2p)/;

/**
 * The address this PC could actually reach the phone on. A phone on mobile data has a
 * perfectly valid-looking address too, but it sits behind the carrier's NAT and is
 * unreachable from here, so only a private LAN address will do.
 */
export function pickLanAddress(ipOutput) {
  const found = [];
  for (const line of String(ipOutput || '').split('\n')) {
    const m = /^\d+:\s+(\S+)\s+inet (\d{1,3}(?:\.\d{1,3}){3})/.exec(line.trim());
    if (!m) continue;
    const [, iface, ip] = m;
    if (iface === 'lo' || MOBILE.test(iface) || !LAN.test(ip)) continue;
    found.push({ iface, ip });
  }
  const pick = found.find((f) => /^wlan/.test(f.iface)) || found[0];
  return pick ? pick.ip : null;
}

async function lanAddress(serial, run) {
  const out = await run(['-s', serial, 'shell', 'ip -o -f inet addr show']);
  const pick = pickLanAddress(out.out);
  if (pick) return { ok: true, address: pick };

  const wifi = await run(['-s', serial, 'shell', 'cmd wifi status']);
  return {
    ok: false,
    error: /wifi is disabled/i.test(wifi.out || '')
      ? 'Wi-Fi is switched off on the phone. Turn it on, join the same network as this PC, then try again.'
      : 'The phone has no address on this network - mobile data cannot be reached from here. Join it to the same Wi-Fi as this PC, then try again.',
  };
}

/**
 * Switch a USB-connected phone to Wi-Fi and connect to it, so the cable can come out.
 * Returns the address to store; it stays valid until the phone reboots or changes network.
 */
export async function enableWifi(serial, { run = adb, restartWaitMs = 2000 } = {}) {
  if (!isSerial(serial)) return { ok: false, error: 'Not a device serial.' };
  if (serial.includes(':')) return { ok: true, address: serial }; // already a Wi-Fi device

  const ip = await lanAddress(serial, run);
  if (!ip.ok) return ip;

  const tcp = await run(['-s', serial, 'tcpip', '5555'], 20000);
  if (!tcp.ok) return { ok: false, error: tcp.out || 'adb tcpip failed.' };
  await new Promise((r) => setTimeout(r, restartWaitMs)); // the phone restarts adbd on the new port

  const address = `${ip.address}:5555`;
  const conn = await connect(address, { run });
  if (!conn.ok) return { ok: false, error: conn.error };
  return { ok: true, address };
}

/** Re-attach to a phone over Wi-Fi (after a reboot, or when the app starts). */
export async function connect(address, { run = adb } = {}) {
  if (!CONNECT.test(String(address || ''))) return { ok: false, error: 'Not a host:port address.' };
  const r = await run(['connect', address], 20000);
  if (/^connected to|already connected/i.test(r.out)) return { ok: true, address };
  return { ok: false, error: r.out || 'Could not connect.' };
}

// ---------------------------------------------------------------- the watcher
//
// Fed every session event. It decides what is worth a buzz in your pocket, which is far
// less than what is worth a line on screen: only work stopping, and only while you are
// not sitting at the window.

const MIN_SECONDS = 30; // a turn shorter than this finished while you were still watching

/**
 * @param cfg    () => { enabled, serial, minSeconds }  - read fresh, so a settings change applies at once
 * @param atDesk () => boolean - true when the JARVIS window has focus
 * @param log    (...parts) => void
 * @param send   (item) => { ok, error?, skip? } - how the alert actually travels. The
 *               watcher decides WHEN to buzz; the caller decides by what route, because
 *               there is more than one (adb over USB or Wi-Fi, a Telegram bot over the
 *               internet) and only main.mjs knows which is configured. `skip: true` means
 *               "that route is not set up" - not a failure, so it does not count towards
 *               giving up, and it is not worth a line in the log every time.
 */
export function createPhoneWatcher({ cfg, atDesk, log, send }) {
  let lastText = '';     // the most recent thing JARVIS said, for the body of a "finished"
  let lastPost = 0;      // the phone is not a log file
  let failures = 0;      // after a few refusals, stop trying until something changes
  let queued = null;     // the next thing to say, newest wins
  let timer = null;

  async function flush() {
    timer = null;
    const item = queued;
    queued = null;
    const c = cfg();
    if (!item || !c.enabled || failures >= 3) return;
    lastPost = Date.now();
    const r = await send(item);
    if (r.ok) { failures = 0; log('phone alert sent:', item.title); return; }
    if (r.skip) return;
    failures += 1;
    log('phone alert failed:', r.error || '', failures >= 3 ? '(giving up until alerts are set up again)' : '');
  }

  /**
   * Hold a buzz back if one just went out, but never throw it away: an approval request
   * arriving on the heels of something else is the one that most needs to be heard. The
   * notification carries a single tag, so the newest simply replaces the last in the tray.
   */
  function post(title, body) {
    if (!cfg().enabled) return;
    queued = { title, body };
    if (timer) return;
    timer = setTimeout(flush, Math.max(0, 3000 - (Date.now() - lastPost)));
  }

  return {
    /** Call when the phone setting or device changes, so a fixed phone is tried again. */
    reset() { failures = 0; },

    /**
     * Every session event passes through here. `claimed` means remote control has already
     * put this on the phone - an approval as buttons, a reply in the chat - so an alert
     * about the same thing would only be a second buzz.
     */
    event(e, { claimed = false } = {}) {
      if (!e || typeof e !== 'object') return;
      if (claimed) { if (e.kind === 'result') lastText = ''; return; }
      switch (e.kind) {
        case 'text_final':
          lastText = e.text || '';
          break;
        case 'permission':
          // Work has stopped dead until you answer - always worth the buzz.
          if (!atDesk()) post('JARVIS needs you', `Approval needed: ${e.displayName || e.toolName || 'a tool'}.`);
          break;
        case 'question':
          if (!atDesk()) post('JARVIS needs you', e.questions?.[0]?.question || 'JARVIS has a question for you.');
          break;
        case 'result': {
          const secs = Math.round((e.durationMs || 0) / 1000);
          const floor = Number(cfg().minSeconds ?? MIN_SECONDS);
          if (atDesk()) { lastText = ''; break; }
          if (e.ok && secs < floor) { lastText = ''; break; }
          const took = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
          if (e.ok) post('JARVIS has finished', `${lastText || 'The turn is complete.'} (${took})`);
          else post('JARVIS stopped', `The turn stopped: ${e.subtype || 'unknown'}. (${took})`);
          lastText = '';
          break;
        }
        default: break;
      }
    },
  };
}
