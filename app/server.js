'use strict';
// Zero-dependency Node server for the Roast Room.
// The Chair (Claude Code) POSTs events; browsers watch via Server-Sent Events.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { buildReport } = require('./pdf');

const PORT = Number(process.env.PORT) || 4730;
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(__dirname, 'public');
const SESSIONS = path.join(ROOT, 'sessions');
const ROSTER = path.join(ROOT, '.claude/skills/roast-room/roster.json');

const sessions = new Map(); // id -> { id, events: [] }
const clients = new Set(); // SSE responses

function roster() {
  try {
    return JSON.parse(fs.readFileSync(ROSTER, 'utf8')).seats;
  } catch {
    return [];
  }
}

function safeId(id) {
  return /^[A-Za-z0-9._-]{1,80}$/.test(id || '') ? id : null;
}

function persist(s) {
  try {
    const dir = path.join(SESSIONS, s.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(s.events, null, 2));
  } catch (e) {
    console.error('persist failed:', e.message);
  }
}

function loadSessions() {
  if (!fs.existsSync(SESSIONS)) return;
  for (const id of fs.readdirSync(SESSIONS)) {
    const f = path.join(SESSIONS, id, 'session.json');
    if (!safeId(id) || !fs.existsSync(f)) continue;
    try {
      sessions.set(id, { id, events: JSON.parse(fs.readFileSync(f, 'utf8')) });
    } catch {}
  }
}

function broadcast(ev) {
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) res.write(data);
}

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
      if (b.length > limit) {
        reject(new Error('too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    if (p === '/api/health') return send(res, 200, { ok: true, sessions: sessions.size });
    if (p === '/api/roster') return send(res, 200, roster());

    if (p === '/api/sessions') {
      const list = [...sessions.values()].map((s) => {
        const st = s.events.find((e) => e.type === 'start') || {};
        return { id: s.id, decision: st.decision || '', done: s.events.some((e) => e.type === 'verdict'), events: s.events.length };
      });
      return send(res, 200, list.reverse());
    }

    const m = p.match(/^\/api\/sessions\/([^/]+)$/);
    if (m) {
      const s = sessions.get(m[1]);
      return s ? send(res, 200, s) : send(res, 404, { error: 'not found' });
    }

    if (p === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': connected\n\n');
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }

    if (p === '/api/events' && req.method === 'POST') {
      let ev;
      try {
        ev = JSON.parse(await readBody(req));
      } catch {
        return send(res, 400, { error: 'invalid json' });
      }
      const id = safeId(ev.session);
      if (!id || !ev.type) return send(res, 400, { error: 'session and type required' });
      ev.ts = Date.now();
      let s = sessions.get(id);
      if (!s) sessions.set(id, (s = { id, events: [] }));
      s.events.push(ev);
      persist(s);
      broadcast(ev);
      return send(res, 200, { ok: true, n: s.events.length });
    }

    const r = p.match(/^\/report\/([^/]+)\.pdf$/);
    if (r) {
      const s = sessions.get(r[1]);
      if (!s) return send(res, 404, { error: 'session not found' });
      const pdf = buildReport(s, roster());
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="roast-${s.id}.pdf"` });
      return res.end(pdf);
    }

    // static files
    let rel = p === '/' ? '/index.html' : p;
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'forbidden' });
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'server error' });
  }
});

if (require.main === module) {
  loadSessions();
  server.listen(PORT, '127.0.0.1', () => console.log(`Roast Room open at http://localhost:${PORT}`));
}

module.exports = { server, sessions };
