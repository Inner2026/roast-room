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
    const bw = 220;
    this.y -= 14;
    this.cur.push(`BT /F1 9.5 Tf 0.1 0.1 0.12 rg ${MARGIN} ${this.y.toFixed(2)} Td (${esc(clean(label).slice(0, 34))}) Tj ET`);
    const x = MARGIN + 200;
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
  const { computeRanking, computeConfidence } = require('./scoring');
  const evs = session.events || [];
  const start = evs.find((e) => e.type === 'start') || {};
  const verdict = evs.filter((e) => e.type === 'verdict').pop();
  const scoreEvs = evs.filter((e) => e.type === 'scores');
  const seatName = (id) => (roster.find((s) => s.id === id) || {}).name || id;
  const d = new Doc();

  d.text('THE ROAST ROOM', { size: 9, bold: true, color: [0.91, 0.4, 0.29], gap: 2 });
  d.text('Council verdict', { size: 24, bold: true, gap: 8 });
  d.text(start.decision || 'Decision', { size: 12, gap: 6 });
  d.text(`Session ${session.id}`, { size: 8.5, color: [0.5, 0.5, 0.55] });
  d.rule();

  const ranking = (verdict && verdict.ranking && verdict.ranking.length) ? verdict.ranking : computeRanking(start.options || [], scoreEvs);
  const winner = (verdict && verdict.winner) || (ranking[0] && ranking[0].option) || 'n/a';
  const conf = verdict && typeof verdict.confidence === 'number' ? verdict.confidence : computeConfidence(ranking, scoreEvs, false);

  d.text('VERDICT', { size: 9, bold: true, color: [0.91, 0.4, 0.29], gap: 2 });
  d.text(winner, { size: 18, bold: true, gap: 2 });
  d.text(`Confidence ${conf}%${verdict && verdict.capped ? '  |  an option was capped for ruin risk' : ''}`, { size: 10, color: [0.4, 0.4, 0.45], gap: 8 });
  if (verdict && verdict.summary) d.text(verdict.summary, { size: 11, gap: 8 });

  d.text('SCOREBOARD', { size: 9, bold: true, color: [0.91, 0.4, 0.29], gap: 4 });
  ranking.forEach((r) => d.bar(r.option + (r.capped ? ' (capped)' : ''), r.score));
  d.space(8);

  if (verdict && verdict.risks && verdict.risks.length) {
    d.text('TOP RISKS', { size: 9, bold: true, color: [0.91, 0.4, 0.29], gap: 3 });
    verdict.risks.forEach((r, i) => d.text(`${i + 1}. ${r}`, { indent: 6 }));
    d.space(4);
  }
  if (verdict && verdict.next_steps && verdict.next_steps.length) {
    d.text('NEXT STEPS', { size: 9, bold: true, color: [0.91, 0.4, 0.29], gap: 3 });
    verdict.next_steps.forEach((r, i) => d.text(`${i + 1}. ${r}`, { indent: 6 }));
    d.space(4);
  }

  d.rule();
  d.text('HOW EACH SEAT SCORED', { size: 9, bold: true, color: [0.91, 0.4, 0.29], gap: 4 });
  scoreEvs.forEach((e) => {
    const sc = Object.entries(e.scores || {}).map(([k, v]) => `${k}: ${v}`).join('  |  ');
    d.text(`${seatName(e.seat)}  (weight ${e.weight}${e.ruin ? ', RUIN FLAG' : ''})`, { bold: true, size: 10.5, gap: 1 });
    d.text(sc, { size: 9.5, color: [0.35, 0.35, 0.4], gap: 1 });
    if (e.why) d.text(e.why, { size: 9.5, gap: 6 });
  });

  d.newPage();
  d.text('FULL TRANSCRIPT', { size: 9, bold: true, color: [0.91, 0.4, 0.29], gap: 6 });
  evs.forEach((e) => {
    if (e.type === 'round') {
      d.space(4);
      d.text(`Round ${e.n}: ${e.title || ''}`, { bold: true, size: 12, gap: 4 });
    } else if (e.type === 'message') {
      d.text(seatName(e.seat), { bold: true, size: 10, gap: 1 });
      d.text(e.text, { size: 10, gap: 6, indent: 8 });
    }
  });
  return d.build();
}

module.exports = { buildReport, Doc };
