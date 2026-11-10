'use strict';
// Executive verdict: transparent weighted criteria, hard caps, conditions and a reasoning trail.
// The result is a pure function of the session events, so it can be recomputed and audited.

const fs = require('fs');
const path = require('path');
const { computeRanking } = require('./scoring');

const CRITERIA_FILE = path.join(__dirname, '..', '.claude/skills/roast-room/criteria.json');
const RANK = ['Reject', 'Postpone', 'Proceed Conditionally', 'Proceed'];
const CONFIDENCE_NOTE = 'Subjective board confidence built from evidence quality, agreement and coverage. It is not a statistically calibrated probability of success.';

function loadConfig() {
  return JSON.parse(fs.readFileSync(CRITERIA_FILE, 'utf8'));
}

const stdev = (a) => {
  if (a.length < 2) return 0;
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length);
};
const r1 = (n) => Math.round(n * 10) / 10;
const cap = (rec, max) => (RANK.indexOf(rec) > RANK.indexOf(max) ? max : rec);

function baseRecommendation(score, t) {
  if (score >= t.proceed) return 'Proceed';
  if (score >= t.conditional) return 'Proceed Conditionally';
  if (score >= t.postpone) return 'Postpone';
  return 'Reject';
}

/**
 * events: session events
 * opts.weights: partial override { financial: 35, ... }
 * opts.financeOverride: replace the latest finance result (used by what-if)
 */
function computeVerdict(events, opts = {}) {
  const cfg = opts.config || loadConfig();
  const weights = {};
  for (const [k, c] of Object.entries(cfg.criteria)) weights[k] = opts.weights && opts.weights[k] != null ? Number(opts.weights[k]) : c.weight;

  const start = events.find((e) => e.type === 'start') || {};
  const scoreEvs = events.filter((e) => e.type === 'scores');
  const research = events.filter((e) => e.type === 'research').pop();
  const objections = events.filter((e) => e.type === 'objection');
  const financeEv = opts.financeOverride || events.filter((e) => e.type === 'finance').pop();
  const fin = financeEv && financeEv.result && financeEv.result.ok ? financeEv.result : null;

  const reasoning = [];
  const conditions = [];
  const capsApplied = [];

  // 1. criterion scores: seat-weighted mean of the seats that scored each criterion
  const criteria = Object.keys(cfg.criteria).map((key) => {
    const rows = scoreEvs.filter((e) => e.criteria && typeof e.criteria[key] === 'number');
    let num = 0, den = 0;
    for (const e of rows) {
      const w = Number(e.weight) || 1;
      num += w * e.criteria[key];
      den += w;
    }
    return { key, label: cfg.criteria[key].label, weight: weights[key], score: den ? r1(num / den) : null, seats: rows.map((e) => e.seat), spread: stdev(rows.map((e) => e.criteria[key])) };
  });

  // 2. deterministic finance check can cap the financial criterion
  const fc = criteria.find((c) => c.key === 'financial');
  if (fin) {
    const exp = fin.scenarios.expected.metrics;
    const pes = fin.scenarios.pessimistic.metrics;
    if (exp.paybackMonth === null && fc && fc.score !== null && fc.score > 4) {
      reasoning.push(`Financial score ${fc.score} capped at 4: the expected scenario never repays the investment within the horizon.`);
      fc.score = 4;
      capsApplied.push('Financial criterion capped at 4 (no payback in expected scenario)');
    }
    if (pes.netProfit < 0) conditions.push('Pessimistic scenario loses money: set a stop-loss and a review point before committing more capital.');
    if (exp.cashSufficient === false) conditions.push(`Capital shortfall: peak funding need is ${exp.peakFundingNeed} versus available capital ${fin.inputs.availableCapital}. Secure the gap first.`);
  }

  // 3. weighted overall over the criteria actually assessed
  const scored = criteria.filter((c) => c.score !== null);
  const totalW = criteria.reduce((a, c) => a + c.weight, 0);
  const coveredW = scored.reduce((a, c) => a + c.weight, 0);
  const coverage = totalW ? coveredW / totalW : 0;
  const overall = coveredW ? r1(scored.reduce((a, c) => a + c.weight * c.score, 0) / coveredW) : null;
  const missing = criteria.filter((c) => c.score === null).map((c) => c.label);

  if (overall === null) {
    return { recommendation: 'Postpone', overall: null, criteria, coverage: 0, caps: ['No criteria were scored'], conditions: ['Run the scoring round before reaching a verdict.'], reasoning: ['No seat returned criterion scores, so no recommendation can be justified.'], confidence: { score: 5, label: CONFIDENCE_NOTE, factors: ['no scores'] } };
  }

  reasoning.push(`Weighted overall ${overall}/10 across ${scored.length} of ${criteria.length} criteria (${Math.round(coverage * 100)}% of weight assessed)${missing.length ? '; not assessed: ' + missing.join(', ') : ''}.`);
  scored.forEach((c) => reasoning.push(`${c.label}: ${c.score}/10 at weight ${c.weight} (seats: ${c.seats.join(', ')}).`));

  let rec = baseRecommendation(overall, cfg.thresholds);
  reasoning.push(`Score ${overall} maps to "${rec}" using thresholds proceed>=${cfg.thresholds.proceed}, conditional>=${cfg.thresholds.conditional}, postpone>=${cfg.thresholds.postpone}.`);

  // 4. caps: these can only make the recommendation more cautious
  const ruinSeats = scoreEvs.filter((e) => e.ruin === true || (Array.isArray(e.ruin) && e.ruin.length)).map((e) => e.seat);
  if (ruinSeats.length) {
    const before = rec; rec = cap(rec, 'Postpone');
    if (rec !== before) capsApplied.push(`Ruin risk flagged by ${ruinSeats.join(', ')}: recommendation capped at Postpone`);
    conditions.push('A seat flagged a plausible path to ruin: remove or insure that exposure before proceeding.');
  }
  const blocking = objections.filter((o) => o.severity === 'blocking');
  if (blocking.length) {
    const before = rec; rec = cap(rec, 'Proceed Conditionally');
    if (rec !== before) capsApplied.push('Formal blocking objection from the Devil\'s Advocate: cannot be an unconditional Proceed');
    blocking.forEach((o) => (o.conditions || []).forEach((c) => conditions.push(c)));
    if (!blocking.some((o) => (o.conditions || []).length)) conditions.push('Answer the Devil\'s Advocate blocking objection with evidence.');
  }
  if (fin && fin.scenarios.expected.metrics.cashSufficient === false) {
    const before = rec; rec = cap(rec, 'Proceed Conditionally');
    if (rec !== before) capsApplied.push('Capital shortfall: cannot be an unconditional Proceed');
  }
  if (coverage < 0.5) {
    const before = rec; rec = cap(rec, 'Proceed Conditionally');
    if (rec !== before) capsApplied.push('Fewer than half the criteria (by weight) were assessed');
    conditions.push('Assess the missing criteria before relying on this verdict.');
  }
  capsApplied.forEach((c) => reasoning.push('Cap applied: ' + c + '.'));
  if (!capsApplied.length) reasoning.push('No caps applied.');

  // 5. confidence (subjective)
  let conf = 50;
  const factors = [];
  const claims = research && research.claims ? research.claims : [];
  if (claims.length) {
    const verified = claims.filter((c) => c.status === 'verified').length;
    const add = Math.round((verified / claims.length) * 20);
    conf += add;
    factors.push(`+${add} evidence: ${verified} of ${claims.length} research claims verified`);
  } else { conf -= 10; factors.push('-10 no research brief'); }
  const sp = scored.length ? scored.reduce((a, c) => a + c.spread, 0) / scored.length : 0;
  const agree = Math.max(0, Math.round(15 - sp * 5));
  conf += agree; factors.push(`+${agree} agreement between seats (avg spread ${r1(sp)})`);
  if (!fin) { conf -= 10; factors.push('-10 no financial model'); }
  if (blocking.length) { const d = Math.min(20, blocking.length * 10); conf -= d; factors.push(`-${d} unresolved blocking objection(s)`); }
  if (coverage < 0.7) { conf -= 10; factors.push('-10 low criteria coverage'); }
  conf = Math.max(5, Math.min(95, conf));
  reasoning.push(`Board confidence ${conf}% (subjective; see factors).`);

  // 6. optional ranking between named options
  const ranking = (start.options && start.options.length && scoreEvs.some((e) => e.scores)) ? computeRanking(start.options, scoreEvs.filter((e) => e.scores)) : [];

  return {
    recommendation: rec,
    overall,
    criteria,
    coverage: Math.round(coverage * 100) / 100,
    caps: capsApplied,
    conditions: [...new Set(conditions)],
    reasoning,
    confidence: { score: conf, label: CONFIDENCE_NOTE, factors },
    ranking,
    winner: ranking.length ? ranking[0].option : undefined,
    objections: objections.map((o) => ({ severity: o.severity, text: o.text, conditions: o.conditions || [] })),
  };
}

module.exports = { computeVerdict, loadConfig, RANK, CONFIDENCE_NOTE };
