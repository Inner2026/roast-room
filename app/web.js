'use strict';
// Hosted website server. Accounts, saved runs, live streaming, PDF.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dbmod = require('./db');
const { Usage, makeProvider } = require('./llm');
const { runBoard } = require('./orchestrator');
const { buildReport } = require('./pdf');
const finance = require('./finance');
const { computeVerdict } = require('./verdict');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(__dirname, 'web');
const PLANS = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/plans.json'), 'utf8'));
const ROSTER = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/skills/roast-room/roster.json'), 'utf8')).seats;
const MODES = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/skills/roast-room/modes.json'), 'utf8')).modes;
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

function createApp(opts = {}) {
  const env = { ...process.env, ...opts.env };
  const prod = env.NODE_ENV === 'production';
  const db = dbmod.store(dbmod.open(opts.dbFile || env.DATABASE_FILE || path.join(ROOT, 'data', 'roastroom.db')));
  db.failInterrupted();
  const allowed = (env.ALLOWED_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const registrationOpen = env.REGISTRATION !== 'closed';
  const maxConcurrent = Number(env.MAX_CONCURRENT_RUNS) || 3;
  const providerFactory = opts.providerFactory || makeProvider;
  const live = new Map(); // runId -> { events, clients:Set, stop:boolean }
  const hits = new Map(); // rate limit buckets

  function limited(key, max, windowMs) {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    arr.push(now); hits.set(key, arr);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
    return arr.length > max;
  }
  const ip = (req) => (env.TRUST_PROXY === '1' && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';

  function headers(extra = {}) {
    return {
      'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
      ...(prod ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}), ...extra,
    };
  }
  const send = (res, code, body, type = 'application/json', extra = {}) => {
    res.writeHead(code, headers({ 'content-type': type, 'cache-control': 'no-store', ...extra }));
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const readBody = (req, limit = 64e3) => new Promise((resolve, reject) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > limit) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(b)); req.on('error', reject);
  });
  const cookies = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]));
  const setCookie = (token, maxAge) => `rr_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${prod ? '; Secure' : ''}`;
  function sameOrigin(req) {
    const o = req.headers.origin;
    if (!o) return false;
    try { return new URL(o).host === req.headers.host; } catch { return false; }
  }
  const user = (req) => db.sessionUser(cookies(req).rr_session);

  function limitsFor(u) { return PLANS[u.plan] || PLANS.free; }
  function checkQuota(u) {
    const lim = limitsFor(u), now = Date.now();
    if (db.countRunsSince(u.id, now - 86400000) >= lim.runsPerDay) return `Daily limit reached (${lim.runsPerDay} runs per 24 hours).`;
    if (db.countRunsSince(u.id, now - 30 * 86400000) >= lim.runsPerMonth) return `Monthly limit reached (${lim.runsPerMonth} runs).`;
    const g = db.globalSince(now - 86400000);
    const cap = Number(env.GLOBAL_DAILY_RUN_CAP) || PLANS.globalDailyRunCap, bud = Number(env.GLOBAL_DAILY_BUDGET_USD) || PLANS.globalDailyBudgetUsd;
    if (g.n >= cap || g.usd >= bud) return 'The service has reached its daily capacity. Try again later.';
    return null;
  }

  function cleanInput(b, u) {
    const lim = limitsFor(u);
    const decision = typeof b.decision === 'string' ? b.decision.trim() : '';
    if (decision.length < 15) return { error: 'Describe the decision in at least a sentence or two.' };
    if (decision.length > lim.maxDecisionChars) return { error: `Decision too long (max ${lim.maxDecisionChars} characters).` };
    const mode = b.mode && MODES[b.mode] ? b.mode : '';
    const options = Array.isArray(b.options) ? b.options.map((x) => String(x).trim().slice(0, 120)).filter(Boolean).slice(0, 5) : [];
    let financeInputs;
    if (b.finance && typeof b.finance === 'object') {
      financeInputs = {};
      for (const f of Object.keys(finance.FIELDS)) if (b.finance[f] !== '' && b.finance[f] != null && Number.isFinite(Number(b.finance[f]))) financeInputs[f] = Number(b.finance[f]);
      if (Object.keys(financeInputs).length) {
        const v = finance.simulate(financeInputs);
        if (!v.ok) return { error: 'Finance inputs: ' + v.errors.join('; ') };
      } else financeInputs = undefined;
    }
    return { decision, mode, options, financeInputs };
  }

  function startRun(u, input) {
    const id = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14) + '-' + crypto.randomBytes(3).toString('hex');
    db.createRun(id, u.id, input.decision, input.mode);
    const st = { events: [], clients: new Set(), stop: false };
    live.set(id, st);
    const usage = new Usage();
    const llm = providerFactory(usage);
    const emit = (ev) => {
      ev.ts = Date.now(); st.events.push(ev); db.saveEvents(id, st.events);
      const data = `data: ${JSON.stringify(ev)}\n\n`;
      for (const c of st.clients) c.write(data);
    };
    (async () => {
      let status = 'done', error = null;
      try { await runBoard({ llm, input, emit, shouldStop: () => st.stop }); }
      catch (e) { status = st.stop ? 'stopped' : 'failed'; error = e.message.slice(0, 300); console.error('run failed', id, e.message); }
      db.finishRun(id, status, usage.usd, error);
      const end = `event: end\ndata: ${JSON.stringify({ status, error })}\n\n`;
      for (const c of st.clients) { c.write(end); c.end(); }
      live.delete(id);
    })();
    return id;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      if (p === '/healthz') return send(res, 200, { ok: true });
      if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) return send(res, 403, { error: 'Bad origin' });
      if (req.method === 'POST' && !String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'JSON only' });

      if (p === '/api/config') return send(res, 200, { registrationOpen, provider: providerFactory(new Usage()).name, modes: Object.entries(MODES).map(([k, m]) => ({ id: k, label: m.label })), financeFields: Object.entries(finance.FIELDS).map(([k, f]) => ({ id: k, label: f.label, required: !!f.required })) });
      if (p === '/api/roster') return send(res, 200, ROSTER);

      // ---- auth ----
      if (p === '/api/auth/register' || p === '/api/auth/login') {
        if (limited('auth:' + ip(req), 10, 15 * 60000)) return send(res, 429, { error: 'Too many attempts. Wait 15 minutes.' });
        let b; try { b = JSON.parse((await readBody(req)) || '{}'); } catch { return send(res, 400, { error: 'invalid json' }); }
        const email = String(b.email || '').trim().toLowerCase(), pw = String(b.password || '');
        if (!/^[^@\s]{1,64}@[^@\s]{1,255}$/.test(email) || email.length > 254) return send(res, 400, { error: 'Enter a valid email.' });
        if (p.endsWith('register')) {
          if (!registrationOpen) return send(res, 403, { error: 'Registration is closed.' });
          if (allowed.length && !allowed.includes(email)) return send(res, 403, { error: 'This email is not on the invite list.' });
          if (pw.length < 10 || pw.length > 200) return send(res, 400, { error: 'Password must be 10 to 200 characters.' });
          if (db.userByEmail(email)) return send(res, 409, { error: 'An account with this email exists. Sign in instead.' });
          const id = db.createUser(email, pw);
          return send(res, 200, { ok: true, email }, 'application/json', { 'set-cookie': setCookie(db.newSession(id), 14 * 86400) });
        }
        const u = db.userByEmail(email);
        if (!u || !db.verifyPass(pw, u.pass)) return send(res, 401, { error: 'Wrong email or password.' });
        return send(res, 200, { ok: true, email }, 'application/json', { 'set-cookie': setCookie(db.newSession(u.id), 14 * 86400) });
      }
      if (p === '/api/auth/logout' && req.method === 'POST') {
        const t = cookies(req).rr_session; if (t) db.endSession(t);
        return send(res, 200, { ok: true }, 'application/json', { 'set-cookie': setCookie('', 0) });
      }

      const u = user(req);
      if (p === '/api/me') return u ? send(res, 200, { email: u.email, plan: u.plan, limits: limitsFor(u) }) : send(res, 401, { error: 'Not signed in' });
      if (p.startsWith('/api/') || p.startsWith('/report/')) {
        if (!u) return send(res, 401, { error: 'Sign in first' });
      }

      if (p === '/api/runs' && req.method === 'GET') return send(res, 200, db.listRuns(u.id));
      if (p === '/api/runs' && req.method === 'POST') {
        let b; try { b = JSON.parse((await readBody(req)) || '{}'); } catch { return send(res, 400, { error: 'invalid json' }); }
        if (limited('run:' + u.id, 5, 60000)) return send(res, 429, { error: 'Slow down.' });
        const input = cleanInput(b, u);
        if (input.error) return send(res, 400, { error: input.error });
        const quota = checkQuota(u);
        if (quota) return send(res, 429, { error: quota });
        if (live.size >= maxConcurrent) return send(res, 503, { error: 'The boardroom is busy. Try again in a minute.' });
        return send(res, 200, { id: startRun(u, input) });
      }

      const m = p.match(/^\/api\/runs\/([\w-]{1,40})(?:\/(stream|stop|whatif))?$/);
      if (m) {
        const run = db.getRun(m[1], u.id);
        if (!run) return send(res, 404, { error: 'not found' });
        if (!m[2] && req.method === 'GET') return send(res, 200, { id: run.id, status: run.status, error: run.error, events: run.events });
        if (!m[2] && req.method === 'DELETE') { db.deleteRun(run.id, u.id); return send(res, 200, { ok: true }); }
        if (m[2] === 'stop' && req.method === 'POST') { const st = live.get(run.id); if (st) st.stop = true; return send(res, 200, { ok: true }); }
        if (m[2] === 'stream') {
          res.writeHead(200, headers({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }));
          const st = live.get(run.id);
          for (const ev of (st ? st.events : run.events)) res.write(`data: ${JSON.stringify(ev)}\n\n`);
          if (!st) { res.write(`event: end\ndata: ${JSON.stringify({ status: run.status, error: run.error })}\n\n`); return res.end(); }
          st.clients.add(res);
          const ping = setInterval(() => res.write(': ping\n\n'), 20000);
          req.on('close', () => { clearInterval(ping); st.clients.delete(res); });
          return;
        }
        if (m[2] === 'whatif' && req.method === 'POST') {
          let b; try { b = JSON.parse((await readBody(req)) || '{}'); } catch { return send(res, 400, { error: 'invalid json' }); }
          const latest = run.events.filter((e) => e.type === 'finance').pop();
          if (!latest) return send(res, 400, { error: 'This run has no finance model. Run a new session with numbers to use what-if.' });
          if (!Array.isArray(b.changes) || b.changes.length > 5) return send(res, 400, { error: 'changes must be a list of up to 5' });
          const out = finance.whatIf(latest.inputs, b.changes);
          if (!out.ok) return send(res, 400, { error: out.errors.join('; ') });
          const st = run.events.find((e) => e.type === 'start') || {};
          const weights = st.mode && MODES[st.mode] ? MODES[st.mode].weights : undefined;
          const before = computeVerdict(run.events, { weights }), after = computeVerdict(run.events, { weights, financeOverride: { result: out.changed } });
          const ev = { type: 'whatif', label: String(b.label || 'What-if').slice(0, 80), applied: out.applied, delta: out.delta, before: { recommendation: before.recommendation, overall: before.overall }, after: { recommendation: after.recommendation, overall: after.overall, conditions: after.conditions, caps: after.caps }, changed: out.changed, ts: Date.now() };
          run.events.push(ev); db.saveEvents(run.id, run.events);
          return send(res, 200, ev);
        }
      }

      const r = p.match(/^\/report\/([\w-]{1,40})\.pdf$/);
      if (r) {
        const run = db.getRun(r[1], u.id);
        if (!run) return send(res, 404, { error: 'not found' });
        return send(res, 200, buildReport({ id: run.id, events: run.events }, ROSTER), 'application/pdf', { 'content-disposition': `inline; filename="board-${run.id}.pdf"` });
      }

      // static
      const rel = p === '/' ? '/index.html' : p;
      const file = path.normalize(path.join(WEB, rel));
      if (file.startsWith(WEB + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      console.error(e);
      if (!res.headersSent) send(res, 500, { error: 'server error' });
    }
  });
  return { server, db, live };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 8080;
  const app = createApp();
  app.server.listen(port, process.env.HOST || '0.0.0.0', () => {
    const key = !!process.env.ANTHROPIC_API_KEY && process.env.LLM_PROVIDER !== 'mock';
    console.log(`Executive Room web on :${port} | LLM: ${key ? 'anthropic' : 'MOCK (no ANTHROPIC_API_KEY)'}`);
  });
}
module.exports = { createApp };
