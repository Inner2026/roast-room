'use strict';
const assert = require('assert');
const http = require('http');
const { createApp } = require('./web');
const { mock, Usage, parseJson } = require('./llm');
const { clampScores } = require('./orchestrator');

let pass = 0;
const t = async (n, f) => { try { await f(); pass++; console.log('ok  ', n); } catch (e) { console.log('FAIL', n, '\n   ', e.message); process.exitCode = 1; } };

(async () => {
  const app = createApp({ dbFile: ':memory:', env: { NODE_ENV: 'test' }, providerFactory: (u) => mock(u) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port, host = `127.0.0.1:${port}`;
  let cookie = '';
  const call = (method, path, body, o = {}) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...(o.origin === false ? {} : { origin: `http://${host}` }), cookie: o.noCookie ? '' : cookie } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { const sc = res.headers['set-cookie']; if (sc && !o.noSave) cookie = sc[0].split(';')[0]; let j; try { j = JSON.parse(b); } catch { j = b; } resolve({ status: res.statusCode, body: j, headers: res.headers }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
  const wait = async (id) => { for (let i = 0; i < 100; i++) { const r = await call('GET', '/api/runs/' + id); if (r.body.status !== 'running') return r.body; await new Promise((r) => setTimeout(r, 50)); } throw new Error('timeout'); };

  await t('security headers + health', async () => { const r = await call('GET', '/healthz'); assert.equal(r.status, 200); assert(/default-src 'self'/.test((await call('GET', '/')).headers['content-security-policy'])); });
  await t('api requires login', async () => assert.equal((await call('GET', '/api/runs', null, { noCookie: true })).status, 401));
  await t('register validates', async () => {
    assert.equal((await call('POST', '/api/auth/register', { email: 'bad', password: 'x'.repeat(12) })).status, 400);
    assert.equal((await call('POST', '/api/auth/register', { email: 'a@b.co', password: 'short' })).status, 400);
  });
  await t('register, session cookie is HttpOnly, duplicate rejected, wrong pw rejected', async () => {
    const r = await call('POST', '/api/auth/register', { email: 'a@b.co', password: 'correct horse battery' });
    assert.equal(r.status, 200); assert(/HttpOnly/.test(r.headers['set-cookie'][0]) && /SameSite=Lax/.test(r.headers['set-cookie'][0]));
    assert.equal((await call('POST', '/api/auth/register', { email: 'a@b.co', password: 'correct horse battery' }, { noSave: true })).status, 409);
    assert.equal((await call('POST', '/api/auth/login', { email: 'a@b.co', password: 'wrong wrong wrong' }, { noSave: true })).status, 401);
    assert.equal((await call('GET', '/api/me')).body.email, 'a@b.co');
  });
  await t('cross-origin POST blocked (CSRF)', async () => {
    assert.equal((await call('POST', '/api/runs', { decision: 'x'.repeat(30) }, { origin: false })).status, 403);
  });
  await t('input validation', async () => {
    assert.equal((await call('POST', '/api/runs', { decision: 'short' })).status, 400);
    assert.equal((await call('POST', '/api/runs', { decision: 'Should I import goods for resale?', finance: { price: 10 } })).status, 400);
  });
  let runId;
  await t('full mock run produces verdict + finance + saved events', async () => {
    const r = await call('POST', '/api/runs', { decision: 'Should I import 2000 units for resale online?', mode: 'startup', options: ['Buy', 'Wait'], finance: { initialInvestment: 10000, price: 20, unitsPerMonth: 400, unitVariableCost: 8, marketingMonthly: 1500 } });
    assert.equal(r.status, 200); runId = r.body.id;
    const run = await wait(runId);
    assert.equal(run.status, 'done', run.error);
    const types = new Set(run.events.map((e) => e.type));
    for (const k of ['start', 'research', 'finance', 'message', 'objection', 'scores', 'verdict']) assert(types.has(k), 'missing ' + k);
    assert(['Proceed', 'Proceed Conditionally', 'Postpone', 'Reject'].includes(run.events.find((e) => e.type === 'verdict').recommendation));
  });
  await t('what-if, PDF, delete', async () => {
    const w = await call('POST', `/api/runs/${runId}/whatif`, { changes: [{ field: 'unitsPerMonth', mode: 'pct', value: -40 }] });
    assert.equal(w.status, 200); assert(w.body.after);
    const pdf = await call('GET', `/report/${runId}.pdf`); assert.equal(pdf.status, 200); assert(pdf.headers['content-type'].includes('pdf'));
    assert.equal((await call('DELETE', '/api/runs/' + runId)).status, 200);
    assert.equal((await call('GET', '/api/runs/' + runId)).status, 404);
  });
  await t("users cannot read each other's runs", async () => {
    const r = await call('POST', '/api/runs', { decision: 'Should I open a second shop location this year?' });
    const id = r.body.id; await wait(id);
    await call('POST', '/api/auth/register', { email: 'c@d.co', password: 'another long password' });
    assert.equal((await call('GET', '/api/runs/' + id)).status, 404);
    assert.equal((await call('GET', `/report/${id}.pdf`)).status, 404);
  });
  await t('daily quota enforced', async () => {
    let last; for (let i = 0; i < 4; i++) { last = await call('POST', '/api/runs', { decision: 'Should I hire a salesperson now or wait?' }); if (last.status === 200) await wait(last.body.id); }
    assert.equal(last.status, 429);
  });
  await t('clampScores + parseJson', () => {
    assert.deepEqual(clampScores({ weight: 99, criteria: { financial: 50, bogus: 3 } }).criteria, { financial: 10 });
    assert.equal(clampScores({ criteria: {} }), null);
    assert.equal(parseJson('here: ```json\n{"a":1}\n```').a, 1);
    assert.equal(parseJson('nope'), null);
  });
  await t('static path traversal blocked', async () => assert.equal((await call('GET', '/..%2f..%2fpackage.json')).status, 404));
  app.server.close();
  console.log(`\n${pass} web tests passed`);
  process.exit(process.exitCode || 0);
})();
