'use strict';
// Weighted scoring with the ruin cap, shared by the server, the PDF and the tests.

function computeRanking(options, scoreEvents) {
  const ranking = options.map((option) => {
    let num = 0;
    let den = 0;
    let ruinBy = [];
    for (const ev of scoreEvents) {
      const s = ev.scores && ev.scores[option];
      if (typeof s !== 'number') continue;
      const w = Number(ev.weight) || 1;
      num += w * s;
      den += w;
      if (ev.ruin === true || (Array.isArray(ev.ruin) && ev.ruin.includes(option))) ruinBy.push(ev.seat);
    }
    let score = den ? num / den : 0;
    let capped = false;
    if (ruinBy.length && score > 4) {
      score = 4;
      capped = true;
    }
    return { option, score: Math.round(score * 10) / 10, capped, ruinBy };
  });
  ranking.sort((a, b) => b.score - a.score);
  return ranking;
}

function computeConfidence(ranking, scoreEvents, thinData) {
  if (ranking.length < 2) return 50;
  const lead = ranking[0].score - ranking[1].score;
  let c = 50 + Math.min(25, lead * 5);
  const top = ranking[0].option;
  const vals = scoreEvents.map((e) => e.scores && e.scores[top]).filter((v) => typeof v === 'number');
  if (vals.length > 1) {
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
    c += Math.max(0, 15 - sd * 5);
  }
  if (thinData) c -= 15;
  return Math.max(5, Math.min(95, Math.round(c)));
}

module.exports = { computeRanking, computeConfidence };
