'use strict';
// Minimal zero-dependency PDF writer: Helvetica, word wrap, pagination.

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 52;

// Approximate Helvetica widths (per 1000 units) for wrapping.
const W = {};
'iltfjI.,;:!|\''.split('').forEach((c) => (W[c] = 260));
' '.split('').forEach((c) => (W[c] = 278));
'mwMW@%'.split('').forEach((c) => (W[c] = 833));
'ABCDEGHKNOPQRSUVXYZ0123456789#$&_'.split('').forEach((c) => (W[c] = 667));
function textWidth(str, size) {
  let w = 0;
  for (const ch of str) w += W[ch] || 530;
  return (w * size) / 1000;
}

function clean(s) {
  return String(s == null ? '' : s)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7e\n]/g, '?');
}
function esc(s) {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function wrap(text, size, maxW) {
  const lines = [];
  for (const para of clean(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const test = line ? line + ' ' + word : word;
      if (textWidth(test, size) > maxW && line) {
        lines.push(line);
        line = word;
      } else line = test;
    }
    lines.push(line);
  }
  return lines;
}

class Doc {
  constructor() {
    this.pages = [];
    this.newPage();
  }
  newPage() {
    this.cur = [];
    this.pages.push(this.cur);
    this.y = PAGE_H - MARGIN;
  }
  ensure(h) {
    if (this.y - h < MARGIN) this.newPage();
  }
  // rgb 0..1
  text(str, { size = 10.5, bold = false, color = [0.1, 0.1, 0.12], indent = 0, gap = 4 } = {}) {
    const lines = wrap(str, size, PAGE_W - MARGIN * 2 - indent);
    const lh = size * 1.35;
    for (const l of lines) {
      this.ensure(lh);
      this.y -= lh;
      this.cur.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${color.join(' ')} rg ${MARGIN + indent} ${this.y.toFixed(2)} Td (${esc(l)}) Tj ET`);
    }
    this.y -= gap;
  }
  rule(color = [0.85, 0.85, 0.88]) {
    this.ensure(8);
    this.y -= 4;
    this.cur.push(`${color.join(' ')} RG 0.6 w ${MARGIN} ${this.y.toFixed(2)} m ${PAGE_W - MARGIN} ${this.y.toFixed(2)} l S`);
    this.y -= 6;
  }
  bar(label, value, max = 10, color = [0.91, 0.4, 0.29]) {
    this.ensure(18);
    const bw = 190;
    this.y -= 14;
    this.cur.push(`BT /F1 9.5 Tf 0.1 0.1 0.12 rg ${MARGIN} ${this.y.toFixed(2)} Td (${esc(clean(label).slice(0, 46))}) Tj ET`);
    const x = MARGIN + 235;
    this.cur.push(`0.92 0.92 0.94 rg ${x} ${(this.y - 1).toFixed(2)} ${bw} 9 re f`);
    this.cur.push(`${color.join(' ')} rg ${x} ${(this.y - 1).toFixed(2)} ${((bw * Math.max(0, value)) / max).toFixed(2)} 9 re f`);
    this.cur.push(`BT /F2 9.5 Tf 0.1 0.1 0.12 rg ${x + bw + 8} ${this.y.toFixed(2)} Td (${value.toFixed(1)}) Tj ET`);
    this.y -= 4;
  }
  space(h) {
    this.y -= h;
  }
  build() {
    const objs = [];
    const add = (s) => (objs.push(s), objs.length);
    add('<< /Type /Catalog /Pages 2 0 R >>');
    add(''); // pages placeholder
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const kids = [];
    this.pages.forEach((ops, i) => {
      ops.push(`BT /F1 8 Tf 0.5 0.5 0.55 rg ${MARGIN} 28 Td (Roast Room  |  page ${i + 1} of ${this.pages.length}) Tj ET`);
      const stream = ops.join('\n');
      const cid = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
      const pid = add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${cid} 0 R >>`);
      kids.push(`${pid} 0 R`);
    });
    objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;
    let out = '%PDF-1.4\n';
    const offs = [];
    objs.forEach((o, i) => {
      offs.push(Buffer.byteLength(out));
      out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = Buffer.byteLength(out);
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    offs.forEach((o) => (out += String(o).padStart(10, '0') + ' 00000 n \n'));
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}

function buildReport(session, roster) {
  const { computeRanking } = require('./scoring');
  const evs = session.events || [];
  const start = evs.find((e) => e.type === 'start') || {};
  const verdict = evs.filter((e) => e.type === 'verdict').pop();
  const research = evs.filter((e) => e.type === 'research').pop();
  const finEv = evs.filter((e) => e.type === 'finance').pop();
  const fin = finEv && finEv.result && finEv.result.ok ? finEv.result : null;
  const objections = evs.filter((e) => e.type === 'objection');
  const whatifs = evs.filter((e) => e.type === 'whatif');
  const scoreEvs = evs.filter((e) => e.type === 'scores');
  const seatName = (id) => (roster.find((s) => s.id === id) || {}).name || id;
  const HOT = [0.91, 0.4, 0.29];
  const MUTE = [0.4, 0.4, 0.45];
  const money = (n) => (n == null ? 'n/a' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }));
  const h = (t) => { d.space(6); d.text(t, { size: 9, bold: true, color: HOT, gap: 3 }); };
  const list = (arr) => (arr || []).forEach((x, i) => d.text(`${i + 1}. ${x}`, { indent: 6 }));
  const d = new Doc();

  // 1. Executive summary
  d.text('THE ROAST ROOM  |  EXECUTIVE BOARD REPORT', { size: 9, bold: true, color: HOT, gap: 2 });
  d.text('Board verdict', { size: 24, bold: true, gap: 8 });
  d.text(start.decision || 'Decision', { size: 12, gap: 4 });
  d.text(`Session ${session.id}${start.mode ? '  |  Mode: ' + start.mode : ''}`, { size: 8.5, color: [0.5, 0.5, 0.55] });
  d.rule();
  h('EXECUTIVE SUMMARY');
  if (verdict) {
    d.text(verdict.recommendation || verdict.winner || 'n/a', { size: 18, bold: true, gap: 2 });
    if (typeof verdict.overall === 'number') d.text(`Weighted overall score ${verdict.overall}/10`, { size: 10.5, gap: 2 });
    if (verdict.confidence && typeof verdict.confidence === 'object') d.text(`Board confidence ${verdict.confidence.score}% (subjective, not a calibrated probability)`, { size: 10, color: MUTE, gap: 6 });
    if (verdict.summary) d.text(verdict.summary, { size: 11, gap: 8 });
  } else d.text('No verdict has been issued for this session yet.', { gap: 8 });

  // 2. Business proposal
  h('BUSINESS PROPOSAL');
  d.text(start.decision || 'n/a', { gap: 2 });
  if (start.options && start.options.length) d.text('Options considered: ' + start.options.join('  |  '), { size: 10, color: MUTE, gap: 6 });

  // 3. Research findings
  d.rule();
  h('RESEARCH FINDINGS');
  if (research) {
    if (research.summary) d.text(research.summary, { gap: 6 });
    (research.claims || []).forEach((c) => {
      d.text(`[${String(c.status || 'unclassified').toUpperCase()}] ${c.text}`, { size: 9.5, bold: false, indent: 6, gap: 0 });
      if (c.source || c.date) d.text(`${c.source || ''}${c.date ? '  |  ' + c.date : ''}`, { size: 8.5, color: MUTE, indent: 14, gap: 3 });
    });
    if (research.gaps && research.gaps.length) { d.text('Information not found:', { bold: true, size: 10, gap: 1 }); list(research.gaps); }
  } else d.text('No research brief was produced for this session. Findings below rest on user inputs and assumptions only.', { color: MUTE });

  // 4. Financial analysis
  d.rule();
  h('FINANCIAL ANALYSIS');
  if (fin) {
    const rows = [['Metric', 'Optimistic', 'Expected', 'Pessimistic']];
    const m = (n) => fin.scenarios[n].metrics;
    const row = (label, k, f = money) => rows.push([label, f(m('optimistic')[k]), f(m('expected')[k]), f(m('pessimistic')[k])]);
    const pct = (n) => (n == null ? 'n/a' : n + '%');
    const mo = (n) => (n == null ? 'never' : 'month ' + n);
    row('Gross revenue', 'grossRevenue'); row('Cost of goods sold', 'costOfGoodsSold'); row('Gross profit', 'grossProfit');
    row('Operating profit', 'operatingProfit'); row('Net profit', 'netProfit');
    row('Gross margin', 'grossMarginPct', pct); row('Net margin', 'netMarginPct', pct); row('ROI over horizon', 'roiPct', pct);
    row('Break-even units / month', 'breakEvenUnitsPerMonth'); row('Capital recovered', 'paybackMonth', mo); row('Peak funding need', 'peakFundingNeed');
    rows.forEach((r, i) => {
      d.ensure(14);
      d.y -= 13;
      const xs = [MARGIN, MARGIN + 175, MARGIN + 275, MARGIN + 375];
      r.forEach((cell, c) => d.cur.push(`BT /${i === 0 ? 'F2' : 'F1'} 9.5 Tf 0.1 0.1 0.12 rg ${xs[c]} ${d.y.toFixed(2)} Td (${esc(clean(cell))}) Tj ET`));
      d.y -= 2;
    });
    d.space(6);
    d.text(`Horizon ${fin.inputs.months} months. Amounts in the user's currency.`, { size: 9, color: MUTE, gap: 3 });
    d.text('Financial assumptions', { bold: true, size: 10, gap: 1 });
    list(fin.assumptions.length ? fin.assumptions : ['All optional inputs were supplied by the user.']);
    d.text(fin.scenarioNote, { size: 9, color: MUTE, gap: 3 });
    d.text('Model limitations', { bold: true, size: 10, gap: 1 });
    list(fin.limitations);
  } else d.text('No financial model was run for this session.', { color: MUTE });

  // 5. Risk matrix (criterion scores) and verdict reasoning
  d.rule();
  h('SCOREBOARD AND CRITERIA');
  if (verdict && Array.isArray(verdict.criteria)) {
    verdict.criteria.forEach((c) => (c.score == null ? d.text(`${c.label}: not assessed`, { size: 9.5, color: MUTE, gap: 2 }) : d.bar(`${c.label} (w${c.weight})`, c.score)));
    d.space(4);
  } else {
    const ranking = verdict && verdict.ranking && verdict.ranking.length ? verdict.ranking : computeRanking(start.options || [], scoreEvs);
    ranking.forEach((r) => d.bar(r.option + (r.capped ? ' (capped)' : ''), r.score));
  }
  if (verdict && verdict.ranking && verdict.ranking.length && Array.isArray(verdict.criteria)) { d.text('Option ranking', { bold: true, size: 10, gap: 1 }); verdict.ranking.forEach((r) => d.bar(r.option + (r.capped ? ' (capped)' : ''), r.score)); }

  if (verdict) {
    if (verdict.reasoning && verdict.reasoning.length) { h('HOW THE BOARD REACHED ITS CONCLUSION'); list(verdict.reasoning); }
    if (verdict.caps && verdict.caps.length) { d.text('Caps applied', { bold: true, size: 10, gap: 1 }); list(verdict.caps); }
    if (verdict.strengths && verdict.strengths.length) { h('MAIN COMPETITIVE ADVANTAGES'); list(verdict.strengths); }
    if (verdict.weaknesses && verdict.weaknesses.length) { h('CRITICAL WEAKNESSES'); list(verdict.weaknesses); }
    if (verdict.risks && verdict.risks.length) { h('TOP RISKS'); list(verdict.risks); }
    if (verdict.disagreements && verdict.disagreements.length) { h('MAIN DISAGREEMENTS BETWEEN ADVISORS'); list(verdict.disagreements); }
  }

  // 6. Devil's Advocate
  d.rule();
  h("DEVIL'S ADVOCATE");
  if (objections.length) {
    objections.forEach((o) => {
      d.text(`Formal objection (${o.severity || 'unrated'})`, { bold: true, size: 10.5, color: [0.75, 0.2, 0.2], gap: 1 });
      d.text(o.text, { gap: 3 });
      if (o.conditions && o.conditions.length) { d.text('To withdraw this objection:', { size: 9.5, bold: true, gap: 1 }); list(o.conditions); }
      if (o.alternatives && o.alternatives.length) { d.text('Alternatives suggested:', { size: 9.5, bold: true, gap: 1 }); list(o.alternatives); }
    });
  } else d.text('No formal objection was recorded.', { color: MUTE });
  if (verdict && verdict.alternatives && verdict.alternatives.length) { d.text('Alternative strategies', { bold: true, size: 10, gap: 1 }); list(verdict.alternatives); }

  // 7. Conditions and next steps
  if (verdict && verdict.conditions && verdict.conditions.length) { d.rule(); h('REQUIRED CONDITIONS BEFORE IMPLEMENTATION'); list(verdict.conditions); }
  if (verdict && verdict.next_steps && verdict.next_steps.length) { h('NEXT STEPS'); list(verdict.next_steps); }

  // 8. What-if scenarios
  if (whatifs.length) {
    d.rule();
    h('WHAT-IF SCENARIOS');
    whatifs.forEach((w) => {
      d.text(w.label || 'What-if', { bold: true, gap: 1 });
      d.text((w.applied || []).map((a) => `${a.field}: ${a.from} to ${a.to}`).join('; '), { size: 9, color: MUTE, gap: 1 });
      const np = w.delta && w.delta.netProfit;
      if (np) d.text(`Expected net profit ${money(np.base)} to ${money(np.changed)}. Recommendation: ${w.before.recommendation} (${w.before.overall}) to ${w.after.recommendation} (${w.after.overall}).`, { size: 10, gap: 5 });
    });
  }

  // 9. Seat evaluations
  d.rule();
  h('ADVISOR EVALUATIONS');
  scoreEvs.forEach((e) => {
    const cs = Object.entries(e.criteria || {}).map(([k, v]) => `${k}: ${v}`).join('  |  ');
    const os = Object.entries(e.scores || {}).map(([k, v]) => `${k}: ${v}`).join('  |  ');
    d.text(`${seatName(e.seat)}  (weight ${e.weight}${e.ruin ? ', RUIN FLAG' : ''})`, { bold: true, size: 10.5, gap: 1 });
    if (cs) d.text(cs, { size: 9.5, color: MUTE, gap: 1 });
    if (os) d.text(os, { size: 9.5, color: MUTE, gap: 1 });
    if (e.why) d.text(e.why, { size: 9.5, gap: 6 });
  });

  // 10. Debate summary / transcript
  d.newPage();
  h('DEBATE TRANSCRIPT');
  evs.forEach((e) => {
    if (e.type === 'round') { d.space(4); d.text(`Round ${e.n}: ${e.title || ''}`, { bold: true, size: 12, gap: 4 }); }
    else if (e.type === 'message') { d.text(seatName(e.seat), { bold: true, size: 10, gap: 1 }); d.text(e.text, { size: 10, gap: 6, indent: 8 }); }
  });

  // 11. Sources
  const srcs = (research && research.claims ? research.claims : []).filter((c) => c.source || c.url);
  d.rule();
  h('SOURCE REFERENCES');
  if (srcs.length) srcs.forEach((c, i) => d.text(`${i + 1}. ${c.source || 'Source'}${c.url ? ' - ' + c.url : ''}${c.date ? ' (' + c.date + ')' : ''}`, { size: 9, indent: 6, gap: 2 }));
  else d.text('No external sources were cited.', { color: MUTE, size: 9 });
  d.text('This report is general AI-assisted analysis, not financial, investment or qualified legal advice. Verify material facts independently.', { size: 8.5, color: MUTE });
  return d.build();
}

module.exports = { buildReport, Doc };
