'use strict';
// Tests: scoring, finance engine (hand-checked numbers), verdict engine, API, PDF, security basics.
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { server } = require('./server');
const { computeRanking } = require('./scoring');
const finance = require('./finance');
const { computeVerdict } = require('./verdict');

let passed = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { passed++; console.log('  ok  ' + name); });
const near = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

function call(method, p, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: p, method, headers: { 'content-type': 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString()); } catch {}
        resolve({ status: res.statusCode, type: res.headers['content-type'], body: buf, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// Hand-checked fixture: price 20, 400 units, cost 8 -> gross 4,800/mo; minus 1,500 marketing and 500 fixed = 2,800/mo.
// Test fixture only, not research evidence.
const BASE = { initialInvestment: 10000, availableCapital: 10000, price: 20, unitsPerMonth: 400, unitVariableCost: 8, marketingMonthly: 1500, fixedMonthly: 500, taxRatePct: 0, feesPct: 0, growthPctMonthly: 0, months: 12 };

(async () => {
  console.log('scoring');
  await ok('ruin cap drops an option below a safer one', () => {
    const r = computeRanking(['A', 'B'], [{ seat: 'x', weight: 2, scores: { A: 9, B: 5 }, ruin: false }, { seat: 'y', weight: 1, scores: { A: 8, B: 6 }, ruin: ['A'] }]);
    assert.strictEqual(r[0].option, 'B');
    assert.strictEqual(r.find((x) => x.option === 'A').score, 4);
  });

  console.log('finance engine');
  await ok('expected scenario matches hand calculation', () => {
    const s = finance.simulate(BASE);
    assert.ok(s.ok);
    const m = s.scenarios.expected.metrics;
    near(m.grossRevenue, 96000); near(m.costOfGoodsSold, 38400); near(m.grossProfit, 57600);
    near(m.operatingProfit, 33600); near(m.netProfit, 33600);
    near(m.grossMarginPct, 60); near(m.netMarginPct, 35);
    near(m.breakEvenUnitsPerMonth, 166.67);
    near(m.roiPct, 236); assert.strictEqual(m.paybackMonth, 4);
    near(m.peakFundingNeed, 10000); assert.strictEqual(m.cashSufficient, true);
  });
  await ok('pessimistic scenario never pays back and ROI is negative', () => {
    const m = finance.simulate(BASE).scenarios.pessimistic.metrics;
    // units 240, cost 9.6, fixed 550: 240*10.4=2496 - 1500 - 550 = 446/mo
    near(m.netProfit, 446 * 12); assert.strictEqual(m.paybackMonth, null); assert.ok(m.roiPct < 0);
  });
  await ok('tax and fees reduce profit correctly', () => {
    const m = finance.simulate({ ...BASE, taxRatePct: 20, feesPct: 5 }).scenarios.expected.metrics;
    // fees 400, operating 2400, tax 480, net 1920/mo
    near(m.netProfit, 1920 * 12);
  });
  await ok('growth compounds units monthly', () => {
    const s = finance.simulate({ ...BASE, growthPctMonthly: 10, months: 3 });
    const mo = s.scenarios.expected.monthly;
    near(mo[1].units, 440); near(mo[2].units, 484);
  });
  await ok('shortfall detected when capital is below peak need', () => {
    const m = finance.simulate({ ...BASE, availableCapital: 6000 }).scenarios.expected.metrics;
    assert.strictEqual(m.cashSufficient, false);
  });
  await ok('missing required inputs are rejected, optional ones become labelled assumptions', () => {
    const bad = finance.simulate({ price: 10 });
    assert.strictEqual(bad.ok, false); assert.ok(bad.errors.length >= 3);
    const good = finance.simulate({ initialInvestment: 1000, price: 10, unitsPerMonth: 100, unitVariableCost: 4 });
    assert.ok(good.ok && good.assumptions.some((a) => a.includes('Marketing')));
  });
  await ok('invalid inputs are rejected', () => {
    assert.strictEqual(finance.simulate({ ...BASE, price: -1 }).ok, false);
    assert.strictEqual(finance.simulate({ ...BASE, taxRatePct: 150 }).ok, false);
    assert.strictEqual(finance.simulate({ ...BASE, price: 'abc' }).ok, false);
    assert.strictEqual(finance.simulate({ ...BASE, months: 2.5 }).ok, false);
  });
  await ok('what-if recomputes and reports deltas', () => {
    const w = finance.whatIf(BASE, [{ field: 'unitsPerMonth', mode: 'pct', value: -40 }]);
    assert.ok(w.ok);
    near(w.changed.inputs.unitsPerMonth, 240);
    near(w.changed.scenarios.expected.metrics.netProfit, (240 * 12 - 2000) * 12);
    assert.ok(w.delta.netProfit.change < 0);
    assert.strictEqual(finance.whatIf(BASE, [{ field: 'nope', mode: 'set', value: 1 }]).ok, false);
  });
  await ok('compare gives side-by-side rows', () => {
    const c = finance.compare([{ label: 'A', inputs: BASE }, { label: 'B', inputs: { ...BASE, initialInvestment: 5000, availableCapital: 5000 } }]);
    assert.ok(c.ok); assert.strictEqual(c.rows.length, 2);
  });

  console.log('verdict engine');
  const start = { type: 'start', decision: 'Test', options: ['Go', 'No-go'] };
  const sc = (seat, w, crit, extra) => ({ type: 'scores', seat, weight: w, criteria: crit, ...extra });
  const strong = [start,
    sc('fin', 5, { financial: 8 }), sc('market', 4, { market: 8 }), sc('operator', 3, { operational: 7 }),
    sc('riskmgr', 4, { risk: 7 }), sc('strategist', 2, { strategic: 7 }), sc('legal', 3, { legal: 7, risk: 7 })];
  await ok('strong scores with no objection give Proceed and a reasoning trail', () => {
    const v = computeVerdict(strong);
    assert.strictEqual(v.recommendation, 'Proceed'); assert.ok(v.overall >= 7); assert.ok(v.reasoning.length >= 5);
    assert.ok(v.confidence.label.includes('not a statistically calibrated'));
  });
  await ok('blocking objection caps at Proceed Conditionally and adds conditions', () => {
    const v = computeVerdict([...strong, { type: 'objection', seat: 'devil', severity: 'blocking', text: 'x', conditions: ['Show 3 paying customers'] }]);
    assert.strictEqual(v.recommendation, 'Proceed Conditionally'); assert.ok(v.conditions.includes('Show 3 paying customers'));
  });
  await ok('ruin flag caps at Postpone', () => {
    const v = computeVerdict([...strong, sc('allocator', 4, { risk: 7 }, { ruin: true })]);
    assert.strictEqual(v.recommendation, 'Postpone');
  });
  await ok('low scores give Reject; no scores gives Postpone', () => {
    assert.strictEqual(computeVerdict([start, sc('fin', 5, { financial: 2 }), sc('market', 3, { market: 3 })]).recommendation, 'Reject');
    assert.strictEqual(computeVerdict([start]).recommendation, 'Postpone');
  });
  await ok('overall is a weighted average, not a plain average, and weights are configurable', () => {
    const evs = [start, sc('a', 1, { financial: 10 }), sc('b', 1, { market: 0 })];
    near(computeVerdict(evs, { weights: { financial: 25, market: 25 } }).overall, 5);
    near(computeVerdict(evs, { weights: { financial: 75, market: 25 } }).overall, 7.5);
  });
  await ok('finance failure caps the financial criterion; shortfall adds a condition', () => {
    const fin = finance.simulate({ ...BASE, price: 9, availableCapital: 3000 }); // costs exceed price
    const v = computeVerdict([...strong, { type: 'finance', inputs: fin.inputs, result: fin }]);
    assert.ok(v.criteria.find((c) => c.key === 'financial').score <= 4);
    assert.ok(v.conditions.some((c) => c.includes('Capital shortfall')));
  });
  await ok('research quality raises confidence over no research', () => {
    const none = computeVerdict(strong).confidence.score;
    const withR = computeVerdict([...strong, { type: 'research', claims: [{ text: 'a', status: 'verified' }, { text: 'b', status: 'verified' }] }]).confidence.score;
    assert.ok(withR > none);
  });

  console.log('api, pdf, security');
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const sid = 'test-' + Date.now();
  const post = (e) => call('POST', '/api/events', { session: sid, ...e });
  await ok('health and roster', async () => {
    assert.strictEqual((await call('GET', '/api/health')).status, 200);
    assert.ok((await call('GET', '/api/roster')).json.length >= 16);
  });
  await ok('full session: research, finance, objection, scores, finalize, whatif, pdf', async () => {
    await post({ type: 'start', decision: 'Invest $10,000 in a private-label brand (test fixture)', mode: 'startup', options: ['Proceed', 'Do nothing'], seats: ['fin', 'market', 'devil'] });
    await post({ type: 'research', summary: 'Fixture brief.', claims: [{ text: 'Example', status: 'verified', source: 'Example Source', url: 'https://example.com', date: '2026-01-01' }, { text: 'Unknown', status: 'unavailable' }], gaps: ['Competitor prices'] });
    const f = await call('POST', `/api/sessions/${sid}/finance`, { inputs: BASE });
    assert.strictEqual(f.status, 200); assert.strictEqual(f.json.scenarios.expected.metrics.paybackMonth, 4);
    await post({ type: 'round', n: 1, title: 'Opening positions' });
    await post({ type: 'message', seat: 'fin', round: 1, text: 'Payback in month 4 in the expected scenario, but the pessimistic scenario never repays.' });
    await post({ type: 'objection', seat: 'devil', severity: 'blocking', text: 'Demand is unproven.', conditions: ['Pre-sell 50 units'] });
    await post({ type: 'scores', seat: 'fin', weight: 5, criteria: { financial: 7 }, scores: { Proceed: 7, 'Do nothing': 4 }, ruin: false, why: 'Pays back in the expected case.' });
    await post({ type: 'scores', seat: 'market', weight: 4, criteria: { market: 6 }, scores: { Proceed: 6, 'Do nothing': 4 }, ruin: false, why: 'Demand plausible, unproven.' });
    const fin = await call('POST', `/api/sessions/${sid}/finalize`, { summary: 'Fixture verdict.', next_steps: ['Pre-sell'] });
    assert.strictEqual(fin.status, 200);
    assert.strictEqual(fin.json.recommendation, 'Proceed Conditionally'); // 6.6 maps to conditional; blocking objection also caps
    assert.strictEqual(fin.json.winner, 'Proceed');
    const w = await call('POST', `/api/sessions/${sid}/whatif`, { label: 'Sales 90% lower', changes: [{ field: 'unitsPerMonth', mode: 'pct', value: -90 }] });
    assert.strictEqual(w.status, 200); assert.ok(w.json.delta.netProfit.change < 0);
    assert.ok(w.json.after.overall <= w.json.before.overall);
    const pdf = await call('GET', `/report/${sid}.pdf`);
    assert.strictEqual(pdf.status, 200); assert.strictEqual(pdf.body.slice(0, 5).toString(), '%PDF-'); assert.ok(pdf.body.slice(-6).toString().includes('%%EOF'));
    assert.ok(pdf.body.length > 4000);
  });
  await ok('finance endpoint validates', async () => {
    assert.strictEqual((await call('POST', '/api/finance/simulate', { inputs: { price: 1 } })).status, 400);
    assert.strictEqual((await call('POST', '/api/finance/simulate', '{bad json')).status, 400);
    assert.strictEqual((await call('POST', `/api/sessions/nope/finance`, { inputs: BASE })).status, 404);
  });
  await ok('unsafe session ids and path traversal are rejected', async () => {
    assert.strictEqual((await post({ type: 'start', session: '../evil' })).status, 400);
    assert.strictEqual((await call('GET', '/../package.json')).status, 404);
    assert.strictEqual((await call('GET', '/..%2f..%2fpackage.json')).status, 404);
  });
  await ok('UI html and PDF text escape safely', async () => {
    const h = (await call('GET', '/')).body.toString();
    assert.ok(h.includes('The Roast') && h.includes('esc('));
  });

  fs.rmSync(path.join(__dirname, '..', 'sessions', sid), { recursive: true, force: true });
  server.close();
  console.log(`\n${passed} tests passed`);
})().catch((e) => {
  console.error('\nTEST FAILED:', e.message);
  process.exit(1);
});
