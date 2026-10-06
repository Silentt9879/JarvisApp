// The phone web app: a page on your own network (or over Tailscale) that shows JARVIS's chat,
// lets you send messages, and answers approvals. Off until you turn it on in Settings.
//
// Only the page shell is served without the access code. Everything that carries conversation
// needs the code, compared in constant time, and repeated wrong codes are refused for a while.
// The code travels in the address (or a header), so use it on networks you trust, or over
// Tailscale - the Settings screen says so.
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';

const MAX_BODY = 16 * 1024;
const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS = 240; // per address per minute
const MAX_FAILS = 8;      // wrong codes per address per minute before a short lock-out
const LOCK_MS = 5 * 60 * 1000;

export function newAccessCode() {
  return crypto.randomBytes(16).toString('base64url');
}

/** The addresses this PC has on the local network (IPv4), for the address shown in Settings. */
export function lanAddresses(ifaces = os.networkInterfaces()) {
  const out = [];
  for (const list of Object.values(ifaces || {})) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }
  return out;
}

function sameText(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** The few fields the phone shows - never raw tool output, file contents or the working folder. */
export function forPhone(evt) {
  if (!evt || typeof evt !== 'object') return null;
  const keep = {
    text_start: ['kind'],
    text_delta: ['kind', 'text'],
    text_final: ['kind', 'text'],
    status: ['kind', 'state'],
    permission: ['kind', 'id', 'toolName', 'displayName', 'detail'],
    question: ['kind', 'id'],
    prompt_done: ['kind', 'id'],
    tool_use: ['kind', 'name', 'detail', 'parent'],
    result: ['kind', 'ok'],
    error: ['kind', 'message'],
  };
  const fields = keep[evt.kind];
  if (!fields) return null;
  const out = {};
  for (const f of fields) if (evt[f] !== undefined) out[f] = typeof evt[f] === 'string' ? evt[f].slice(0, 4000) : evt[f];
  return out;
}

export class CompanionServer {
  /**
   * `html` is the page shell. `handlers` are the things the page can ask JARVIS to do:
   * state(), send(text), respond(id, decision), interrupt() - each returns plain data.
   */
  constructor({ html, code, handlers, log = () => {}, now = () => Date.now() }) {
    this.html = html;
    this.code = code;
    this.handlers = handlers;
    this.log = log;
    this.now = now;
    this.server = null;
    this.clients = new Set();
    this.hits = new Map();   // address -> { start, count }
    this.fails = new Map();  // address -> { start, count, lockedUntil }
    this.pingTimer = null;
  }

  get running() { return !!this.server; }

  start(port, host = '0.0.0.0') {
    if (this.server) return Promise.resolve(this.address());
    this.server = http.createServer((req, res) => this.#handle(req, res));
    this.server.keepAliveTimeout = 5000;
    return new Promise((resolve, reject) => {
      this.server.once('error', (e) => { this.server = null; reject(e); });
      this.server.listen(port, host, () => {
        this.pingTimer = setInterval(() => {
          for (const c of this.clients) c.write(': ping\n\n');
        }, 25000);
        this.pingTimer.unref?.();
        resolve(this.address());
      });
    });
  }

  address() {
    const a = this.server?.address();
    return a && typeof a === 'object' ? { port: a.port } : null;
  }

  stop() {
    clearInterval(this.pingTimer);
    for (const c of this.clients) { try { c.end(); } catch { /* gone */ } }
    this.clients.clear();
    const s = this.server;
    this.server = null;
    return new Promise((resolve) => (s ? s.close(() => resolve()) : resolve()));
  }

  /** Called with every session event: passes the phone's few fields to any open page. */
  event(evt) {
    const slim = forPhone(evt);
    if (!slim || !this.clients.size) return;
    const line = `data: ${JSON.stringify(slim)}\n\n`;
    for (const c of this.clients) { try { c.write(line); } catch { this.clients.delete(c); } }
  }

  #rateOk(addr) {
    const t = this.now();
    const h = this.hits.get(addr) || { start: t, count: 0 };
    if (t - h.start > WINDOW_MS) { h.start = t; h.count = 0; }
    h.count += 1;
    this.hits.set(addr, h);
    return h.count <= MAX_REQUESTS;
  }

  #locked(addr) {
    const f = this.fails.get(addr);
    return !!(f && f.lockedUntil && this.now() < f.lockedUntil);
  }

  #failed(addr) {
    const t = this.now();
    const f = this.fails.get(addr) || { start: t, count: 0, lockedUntil: 0 };
    if (t - f.start > WINDOW_MS) { f.start = t; f.count = 0; }
    f.count += 1;
    if (f.count >= MAX_FAILS) { f.lockedUntil = t + LOCK_MS; f.count = 0; this.log('companion: too many wrong codes - pausing that address for five minutes'); }
    this.fails.set(addr, f);
  }

  #send(res, status, body, type = 'application/json; charset=utf-8') {
    res.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
    });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  }

  #codeFrom(req, url) {
    const h = req.headers.authorization || '';
    if (h.startsWith('Bearer ')) return h.slice(7).trim();
    return req.headers['x-jarvis-code'] || url.searchParams.get('k') || '';
  }

  #readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('bad json')); }
      });
      req.on('error', reject);
    });
  }

  async #handle(req, res) {
    const addr = req.socket.remoteAddress || 'unknown';
    const url = new URL(req.url || '/', 'http://localhost');
    if (!this.#rateOk(addr)) { this.#send(res, 429, { ok: false, error: 'Too many requests. Wait a minute.' }); return; }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      this.#send(res, 200, this.html, 'text/html; charset=utf-8');
      return;
    }

    if (!url.pathname.startsWith('/api/')) { this.#send(res, 404, { ok: false, error: 'Not found.' }); return; }

    if (this.#locked(addr)) { this.#send(res, 429, { ok: false, error: 'Paused after too many wrong codes. Try again in a few minutes.' }); return; }
    if (!sameText(this.#codeFrom(req, url), this.code)) {
      this.#failed(addr);
      this.#send(res, 401, { ok: false, error: 'That access code is not right.' });
      return;
    }

    try {
      if (req.method === 'GET' && url.pathname === '/api/state') {
        this.#send(res, 200, await this.handlers.state());
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(': connected\n\n');
        this.clients.add(res);
        req.on('close', () => this.clients.delete(res));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/send') {
        const body = await this.#readBody(req);
        const text = String(body.text ?? '').trim();
        if (!text) { this.#send(res, 400, { ok: false, error: 'Type something first.' }); return; }
        this.#send(res, 200, await this.handlers.send(text.slice(0, 8000)));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/respond') {
        const body = await this.#readBody(req);
        this.#send(res, 200, await this.handlers.respond(String(body.id ?? ''), body.decision ?? {}));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/interrupt') {
        this.#send(res, 200, await this.handlers.interrupt());
        return;
      }
      this.#send(res, 404, { ok: false, error: 'Not found.' });
    } catch (e) {
      this.log('companion:', e?.message || e);
      this.#send(res, 400, { ok: false, error: 'That request could not be read.' });
    }
  }
}
