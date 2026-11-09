'use strict';
// Deterministic financial simulation. No AI, no randomness, no invented inputs.
// Every number comes from the user's inputs or from a labelled assumption.

const FIELDS = {
  initialInvestment: { required: true, min: 0, label: 'Initial investment' },
  price: { required: true, min: 0, label: 'Selling price per unit' },
  unitsPerMonth: { required: true, min: 0, label: 'Expected units sold per month' },
  unitVariableCost: { required: true, min: 0, label: 'Variable cost per unit (COGS, landed)' },
  availableCapital: { required: false, min: 0, label: 'Available capital', default: null },
  marketingMonthly: { required: false, min: 0, label: 'Marketing budget per month', default: 0 },
  fixedMonthly: { required: false, min: 0, label: 'Fixed operating costs per month', default: 0 },
  taxRatePct: { required: false, min: 0, max: 100, label: 'Tax rate on operating profit (%)', default: 0 },
  feesPct: { required: false, min: 0, max: 100, label: 'Payment/platform fees (% of revenue)', default: 0 },
  growthPctMonthly: { required: false, min: -99.9, max: 1000, label: 'Monthly unit growth (%)', default: 0 },
  months: { required: false, min: 1, max: 120, integer: true, label: 'Horizon (months)', default: 12 },
};

// Default stress multipliers. These are ASSUMPTIONS, not evidence. Users can override them.
const DEFAULT_SCENARIOS = {
  optimistic: { units: 1.25, price: 1, varCost: 0.9, marketing: 1, fixed: 1, growthDeltaPct: 0 },
  expected: { units: 1, price: 1, varCost: 1, marketing: 1, fixed: 1, growthDeltaPct: 0 },
  pessimistic: { units: 0.6, price: 1, varCost: 1.2, marketing: 1, fixed: 1.1, growthDeltaPct: 0 },
};

const LIMITATIONS = [
  'No working-capital or inventory-timing model: stock bought before sales is not modelled, so early cash need is understated for product businesses.',
  'Tax is applied to positive monthly operating profit only; losses are not carried forward.',
  'Units grow at a constant monthly rate; no seasonality, no churn, no price changes over time.',
  'Currency conversion, shipping, duties and returns must already be inside the unit cost or fixed costs.',
];

const r2 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);

function validate(raw) {
  const errors = [];
  const assumptions = [];
  const v = {};
  for (const [k, spec] of Object.entries(FIELDS)) {
    let x = raw ? raw[k] : undefined;
    if (x === undefined || x === null || x === '') {
      if (spec.required) {
        errors.push(`${spec.label} (${k}) is required`);
        continue;
      }
      v[k] = spec.default;
      if (k !== 'availableCapital') assumptions.push(`${spec.label} not provided; assumed ${spec.default}`);
      else assumptions.push('Available capital not provided; capital sufficiency not checked');
      continue;
    }
    x = Number(x);
    if (!Number.isFinite(x)) {
      errors.push(`${spec.label} (${k}) must be a number`);
      continue;
    }
    if (spec.min != null && x < spec.min) errors.push(`${spec.label} (${k}) must be at least ${spec.min}`);
    if (spec.max != null && x > spec.max) errors.push(`${spec.label} (${k}) must be at most ${spec.max}`);
    if (spec.integer && !Number.isInteger(x)) errors.push(`${spec.label} (${k}) must be a whole number`);
    v[k] = x;
  }
  return { errors, assumptions, values: v };
}

function runScenario(v) {
  const g = v.growthPctMonthly / 100;
  const fee = v.feesPct / 100;
  const tax = v.taxRatePct / 100;
  const monthly = [];
  let cum = -v.initialInvestment; // cash position relative to start, month 0 = investment out
  let peakNeed = v.initialInvestment;
  let cumNet = 0;
  let payback = null;
  let firstNegativeCash = null;
  const T = { revenue: 0, cogs: 0, gross: 0, fees: 0, marketing: 0, fixed: 0, operating: 0, tax: 0, net: 0 };

  for (let m = 1; m <= v.months; m++) {
    const units = v.unitsPerMonth * Math.pow(1 + g, m - 1);
    const revenue = units * v.price;
    const cogs = units * v.unitVariableCost;
    const gross = revenue - cogs;
    const fees = revenue * fee;
    const operating = gross - fees - v.marketingMonthly - v.fixedMonthly;
    const taxes = Math.max(0, operating) * tax;
    const net = operating - taxes;
    cum += net;
    cumNet += net;
    if (-cum > peakNeed) peakNeed = -cum;
    if (payback === null && cumNet >= v.initialInvestment) payback = m;
    if (v.availableCapital != null && firstNegativeCash === null && v.availableCapital + cum < 0) firstNegativeCash = m;
    T.revenue += revenue; T.cogs += cogs; T.gross += gross; T.fees += fees;
    T.marketing += v.marketingMonthly; T.fixed += v.fixedMonthly; T.operating += operating; T.tax += taxes; T.net += net;
    monthly.push({ month: m, units: r2(units), revenue: r2(revenue), cogs: r2(cogs), grossProfit: r2(gross), operatingProfit: r2(operating), tax: r2(taxes), netProfit: r2(net), cumulativeCash: r2(cum) });
  }

  const contribution = v.price * (1 - fee) - v.unitVariableCost;
  const breakEvenUnits = contribution > 0 ? (v.fixedMonthly + v.marketingMonthly) / contribution : null;

  return {
    totals: Object.fromEntries(Object.entries(T).map(([k, x]) => [k, r2(x)])),
    metrics: {
      grossRevenue: r2(T.revenue),
      costOfGoodsSold: r2(T.cogs),
      grossProfit: r2(T.gross),
      operatingProfit: r2(T.operating),
      netProfit: r2(T.net),
      grossMarginPct: T.revenue > 0 ? r2((T.gross / T.revenue) * 100) : null,
      netMarginPct: T.revenue > 0 ? r2((T.net / T.revenue) * 100) : null,
      breakEvenUnitsPerMonth: r2(breakEvenUnits),
      roiPct: v.initialInvestment > 0 ? r2(((T.net - v.initialInvestment) / v.initialInvestment) * 100) : null,
      paybackMonth: payback,
      peakFundingNeed: r2(peakNeed),
      cashSufficient: v.availableCapital == null ? null : v.availableCapital >= peakNeed,
      firstNegativeCashMonth: firstNegativeCash,
    },
    monthly,
  };
}

function applyScenario(v, s) {
  return {
    ...v,
    unitsPerMonth: v.unitsPerMonth * s.units,
    price: v.price * s.price,
    unitVariableCost: v.unitVariableCost * s.varCost,
    marketingMonthly: v.marketingMonthly * s.marketing,
    fixedMonthly: v.fixedMonthly * s.fixed,
    growthPctMonthly: v.growthPctMonthly + (s.growthDeltaPct || 0),
  };
}

function simulate(rawInputs, overrides) {
  const { errors, assumptions, values } = validate(rawInputs);
  if (errors.length) return { ok: false, errors };
  const defs = { ...DEFAULT_SCENARIOS };
  for (const k of Object.keys(overrides || {})) if (defs[k]) defs[k] = { ...defs[k], ...overrides[k] };
  const scenarios = {};
  for (const [name, s] of Object.entries(defs)) {
    const sv = applyScenario(values, s);
    if (sv.growthPctMonthly <= -100) sv.growthPctMonthly = -99.9;
    scenarios[name] = runScenario(sv);
  }
  return {
    ok: true,
    inputs: values,
    assumptions,
    scenarioAssumptions: defs,
    scenarioNote: 'Optimistic and pessimistic scenarios use default stress multipliers that are assumptions, not research findings.',
    limitations: LIMITATIONS,
    scenarios,
  };
}

// changes: [{ field, mode: 'set'|'pct'|'add', value }]
function applyChanges(raw, changes) {
  const out = { ...raw };
  const applied = [];
  for (const c of changes || []) {
    if (!c || !FIELDS[c.field]) return { error: `Unknown field: ${c && c.field}` };
    const cur = Number(out[c.field] != null ? out[c.field] : FIELDS[c.field].default || 0);
    const val = Number(c.value);
    if (!Number.isFinite(val)) return { error: `Change for ${c.field} needs a numeric value` };
    let next;
    if (c.mode === 'set') next = val;
    else if (c.mode === 'pct') next = cur * (1 + val / 100);
    else if (c.mode === 'add') next = cur + val;
    else return { error: `Change mode must be set, pct or add (got ${c.mode})` };
    out[c.field] = next;
    applied.push({ field: c.field, mode: c.mode, value: val, from: r2(cur), to: r2(next) });
  }
  return { inputs: out, applied };
}

const KEYS = ['grossRevenue', 'grossProfit', 'netProfit', 'netMarginPct', 'roiPct', 'paybackMonth', 'peakFundingNeed', 'breakEvenUnitsPerMonth'];

function whatIf(baseRaw, changes, overrides) {
  const base = simulate(baseRaw, overrides);
  if (!base.ok) return base;
  const ch = applyChanges(baseRaw, changes);
  if (ch.error) return { ok: false, errors: [ch.error] };
  const changed = simulate(ch.inputs, overrides);
  if (!changed.ok) return changed;
  const delta = {};
  for (const k of KEYS) {
    const a = base.scenarios.expected.metrics[k];
    const b = changed.scenarios.expected.metrics[k];
    delta[k] = { base: a, changed: b, change: a != null && b != null ? r2(b - a) : null };
  }
  return { ok: true, applied: ch.applied, base, changed, delta };
}

// items: [{ label, inputs }]  -> side-by-side expected-scenario metrics
function compare(items) {
  const rows = [];
  for (const it of items || []) {
    const s = simulate(it.inputs);
    if (!s.ok) return { ok: false, errors: [`${it.label}: ${s.errors.join('; ')}`] };
    const e = s.scenarios.expected.metrics;
    const p = s.scenarios.pessimistic.metrics;
    rows.push({ label: it.label, expected: e, pessimisticNetProfit: p.netProfit, pessimisticPaybackMonth: p.paybackMonth });
  }
  return { ok: true, rows };
}

module.exports = { FIELDS, DEFAULT_SCENARIOS, LIMITATIONS, simulate, whatIf, compare, applyChanges, validate };
