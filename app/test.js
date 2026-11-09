'use strict';
// Smoke test: boots the server, posts a full council, checks scoring, ruin cap and PDF output.
const assert = require('assert');
const http = require('http');
const { server } = require('./server');
const { computeRanking } = require('./scoring');

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method, headers: { 'content-type': 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
  // scoring unit checks
  const r = computeRanking(['A', 'B'], [
    { seat: 'x', weight: 2, scores: { A: 9, B: 5 }, ruin: false },
    { seat: 'y', weight: 1, scores: { A: 8, B: 6 }, ruin: ['A'] },
  ]);
  assert.strictEqual(r[0].option, 'B', 'ruin cap should drop A below B');
  assert.strictEqual(r.find((x) => x.option === 'A').score, 4);

  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const sid = 'test-' + Date.now();
  const post = (e) => call('POST', '/api/events', { session: sid, ...e });

  assert.strictEqual((await call('GET', '/api/health')).status, 200);
  assert.strictEqual((await post({ type: 'start', decision: 'Raise prices to $3,500?', options: ['Raise all', 'Raise new only', 'Keep'], seats: ['allocator', 'architect'] })).status, 200);
  await post({ type: 'round', n: 1, title: 'Opening positions' });
  await post({ type: 'message', seat: 'allocator', round: 1, text: 'Cash first. At 15 clients, losing 3 costs $6,000 a month.' });
  await post({ type: 'scores', seat: 'allocator', weight: 4, scores: { 'Raise all': 5, 'Raise new only': 8, Keep: 6 }, ruin: false, why: 'Staged rise limits downside.' });
  await post({ type: 'scores', seat: 'architect', weight: 5, scores: { 'Raise all': 9, 'Raise new only': 8, Keep: 3 }, ruin: false, why: 'Underpriced.' });
  await post({ type: 'verdict', winner: 'Raise new only', confidence: 72, summary: 'Test verdict.', risks: ['Churn'], next_steps: ['Announce by Friday'] });

  const pdf = await call('GET', `/report/${sid}.pdf`);
  assert.strictEqual(pdf.status, 200);
  assert.ok(pdf.body.slice(0, 5).toString() === '%PDF-', 'PDF header');
  assert.ok(pdf.body.slice(-6).toString().includes('%%EOF'), 'PDF trailer');

  assert.strictEqual((await post({ type: 'start' , session: '../evil' })).status, 400, 'unsafe session id rejected');
  assert.strictEqual((await call('GET', '/../package.json')).status, 404, 'no path traversal');

  console.log('all tests passed, session', sid);
  // clean up test session from disk
  require('fs').rmSync(require('path').join(__dirname, '..', 'sessions', sid), { recursive: true, force: true });
  server.close();
})().catch((e) => {
  console.error('TEST FAILED:', e.message);
  process.exit(1);
});
