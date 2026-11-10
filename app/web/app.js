'use strict';
(function () {
  const $app = document.getElementById('app');
  let cfg = {}, me = null, es = null;

  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return e;
  }
  const api = async (path, opts = {}) => {
    const res = await fetch(path, { method: opts.method || 'GET', headers: opts.body ? { 'content-type': 'application/json' } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined, credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || 'Request failed'); e.status = res.status; throw e; }
    return data;
  };
  const list = (arr) => (Array.isArray(arr) && arr.length ? h('ul', {}, arr.map((x) => h('li', {}, typeof x === 'string' ? x : JSON.stringify(x)))) : null);
  const money = (n) => (n == null ? 'n/a' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }));

  function render(...nodes) { if (es) { es.close(); es = null; } $app.replaceChildren(...nodes); window.scrollTo(0, 0); }

  // ---------- auth ----------
  function authView(mode = 'login') {
    const err = h('div', { class: 'err' });
    const email = h('input', { type: 'email', autocomplete: 'email', required: true });
    const pw = h('input', { type: 'password', autocomplete: mode === 'login' ? 'current-password' : 'new-password', required: true });
    const form = h('form', { onsubmit: async (ev) => {
      ev.preventDefault(); err.textContent = '';
      try { await api('/api/auth/' + mode, { method: 'POST', body: { email: email.value, password: pw.value } }); await boot(); }
      catch (e) { err.textContent = e.message; }
    } },
      h('label', {}, 'Email'), email, h('label', {}, mode === 'login' ? 'Password' : 'Password (10+ characters)'), pw, err,
      h('div', { class: 'row' }, h('button', { type: 'submit' }, mode === 'login' ? 'Sign in' : 'Create account'),
        cfg.registrationOpen || mode === 'register' ? h('button', { type: 'button', class: 'ghost', onclick: () => authView(mode === 'login' ? 'register' : 'login') }, mode === 'login' ? 'Create an account' : 'I have an account') : null));
    render(h('h1', {}, 'Put your decision in front of the board.'),
      h('p', { class: 'sub' }, 'Researched, stress-tested by a Devil’s Advocate, scored by weighted criteria. You get a verdict and a PDF.'),
      h('div', { class: 'card' }, form));
  }

  // ---------- home: new session + history ----------
  async function home() {
    const runs = await api('/api/runs');
    const decision = h('textarea', { placeholder: 'Describe the decision: what, how much money, deadline, what you are unsure about. Example: Should I import 2,000 units of product X from supplier Y for $18,000 and sell them online?' });
    const mode = h('select', {}, h('option', { value: '' }, 'Default board'), ...cfg.modes.map((m) => h('option', { value: m.id }, m.label)));
    const options = h('input', { placeholder: 'Optional: options, separated by | (e.g. Buy now | Wait 3 months | Do nothing)' });
    const fin = {};
    const finBox = h('div', { class: 'grid' }, cfg.financeFields.map((f) => {
      const i = h('input', { type: 'number', step: 'any', min: '0' }); fin[f.id] = i;
      return h('div', {}, h('label', {}, f.label + (f.required ? ' *' : '')), i);
    }));
    const err = h('div', { class: 'err' });
    const go = h('button', { type: 'button', onclick: async () => {
      err.textContent = ''; go.disabled = true;
      try {
        const finance = {}; for (const [k, i] of Object.entries(fin)) if (i.value !== '') finance[k] = i.value;
        const r = await api('/api/runs', { method: 'POST', body: { decision: decision.value, mode: mode.value, options: options.value.split('|').map((s) => s.trim()).filter(Boolean), finance: Object.keys(finance).length ? finance : undefined } });
        room(r.id);
      } catch (e) { err.textContent = e.message; go.disabled = false; }
    } }, 'Convene the board');
    render(
      h('h1', {}, 'New decision'),
      h('p', { class: 'sub' }, 'Each session runs research, a debate, an objection round and a scored verdict. It takes a few minutes.'),
      h('div', { class: 'card' }, h('label', {}, 'Your decision'), decision, h('label', {}, 'Board'), mode, h('label', {}, 'Options'), options,
        h('details', { class: 'row' }, h('summary', {}, 'Add numbers for the financial model (recommended; never guessed for you)'), finBox,
          h('p', { class: 'mute' }, 'Fields marked * are required together. Leave all blank to skip the model.')), err, h('div', { class: 'row' }, go)),
      h('h2', {}, 'Past sessions'),
      h('div', { class: 'card' }, runs.length ? runs.map((r) => h('div', { class: 'hist' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); room(r.id); } }, r.decision.slice(0, 90)), h('span', { class: 'mute' }, r.status + ' · ' + new Date(r.created).toLocaleDateString()))) : h('p', { class: 'mute' }, 'Nothing yet.')));
  }

  // ---------- the room ----------
  function room(id) {
    const status = h('div', { class: 'status' }, 'Connecting…');
    const body = h('div', {});
    const actions = h('div', { class: 'row' });
    render(h('a', { href: '#', onclick: (e) => { e.preventDefault(); home(); } }, '← All sessions'), h('h1', {}, 'The room'), status, actions, body);
    const seen = { start: null, finance: null };
    const stop = h('button', { class: 'danger', onclick: () => api(`/api/runs/${id}/stop`, { method: 'POST', body: {} }) }, 'Stop');
    actions.append(stop);

    function add(ev) {
      if (ev.type === 'start') {
        seen.start = ev;
        body.append(h('div', { class: 'card' }, h('h2', {}, ev.modeLabel || 'Board'), h('div', { class: 'mute' }, 'Seats: ' + (ev.seats || []).join(', ')), h('p', {}, ev.decision)));
      } else if (ev.type === 'research') {
        const links = (ev.searched || []).filter((s) => /^https?:\/\//.test(s.url));
        body.append(h('div', { class: 'card' }, h('h2', {}, 'Research brief'), h('p', {}, ev.summary),
          (ev.claims || []).length ? h('ul', {}, ev.claims.map((c) => h('li', {}, `${c.text} [${c.status || 'unverified'}]`, c.url && /^https?:\/\//.test(c.url) ? h('a', { href: c.url, target: '_blank', rel: 'noopener noreferrer' }, ' source') : null))) : null,
          (ev.gaps || []).length ? h('p', { class: 'mute' }, 'Gaps: ' + ev.gaps.join('; ')) : null,
          links.length ? h('details', {}, h('summary', {}, 'Sources searched (' + links.length + ')'), h('ul', {}, links.map((s) => h('li', {}, h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.title || s.url))))) : null));
      } else if (ev.type === 'finance') {
        seen.finance = ev;
        const sc = ev.result.scenarios, names = Object.keys(sc);
        const rows = [['Net profit', 'netProfit'], ['ROI %', 'roiPct'], ['Payback month', 'paybackMonth'], ['Peak funding need', 'peakFundingNeed'], ['Break-even units/mo', 'breakEvenUnitsPerMonth']];
        body.append(h('div', { class: 'card' }, h('h2', {}, 'Financial model (deterministic)'),
          h('table', {}, h('tr', {}, h('th', {}, ''), names.map((n) => h('th', {}, n))), rows.map(([l, k]) => h('tr', {}, h('td', {}, l), names.map((n) => h('td', {}, sc[n].metrics && sc[n].metrics[k] != null ? money(sc[n].metrics[k]) : 'n/a'))))),
          h('p', { class: 'mute' }, 'Optimistic and pessimistic cases are stress assumptions, not forecasts.'), list(ev.result.assumptions), h('details', {}, h('summary', {}, 'Limitations'), list(ev.result.limitations))));
      } else if (ev.type === 'message') {
        body.append(h('div', { class: 'msg' }, h('b', {}, ev.name, ' ', h('small', {}, 'round ' + ev.round)), ev.text));
      } else if (ev.type === 'objection') {
        body.append(h('div', { class: 'card' }, h('h2', {}, 'Formal objection ', h('span', { class: 'pill ' + ev.severity }, ev.severity)), h('p', {}, ev.text), ev.conditions.length ? [h('b', {}, 'To withdraw it:'), list(ev.conditions)] : null, ev.alternatives.length ? [h('b', {}, 'Alternatives:'), list(ev.alternatives)] : null));
      } else if (ev.type === 'scores') {
        body.append(h('div', { class: 'mute' }, `Scored by ${ev.seat}: ` + Object.entries(ev.criteria).map(([k, v]) => `${k} ${v}`).join(', ') + (ev.ruin ? ' · RUIN FLAG' : '') + (ev.why ? ' — ' + ev.why : '')));
      } else if (ev.type === 'verdict') {
        body.append(verdictCard(ev));
      } else if (ev.type === 'whatif') {
        body.append(h('div', { class: 'card' }, h('h2', {}, 'What-if: ' + ev.label), h('p', {}, `${ev.before.recommendation} (${ev.before.overall}) → ${ev.after.recommendation} (${ev.after.overall})`), list(ev.after.conditions)));
      }
    }

    function verdictCard(v) {
      return h('div', { class: 'card verdict' }, h('div', { class: 'mute' }, 'BOARD VERDICT'), h('div', { class: 'big' }, v.recommendation), h('div', {}, `Weighted score ${v.overall}/10 · subjective board confidence ${v.confidence ? v.confidence.score + '%' : 'n/a'} (an opinion of the board, not a calibrated probability)`),
        v.summary ? h('p', {}, v.summary) : null,
        h('table', {}, (v.criteria || []).filter((c) => c.score != null).map((c) => h('tr', {}, h('td', {}, c.label), h('td', {}, `weight ${c.weight}`), h('td', {}, h('div', { class: 'bar' }, (() => { const i = h('i'); i.style.width = c.score * 10 + '%'; return i; })())), h('td', {}, c.score)))),
        (v.caps || []).length ? [h('b', {}, 'Caps applied:'), list(v.caps.map((c) => (typeof c === 'string' ? c : c.reason || c.text || JSON.stringify(c))))] : null,
        (v.conditions || []).length ? [h('b', {}, 'Conditions before proceeding:'), list(v.conditions)] : null,
        ...[['Strengths', v.strengths], ['Weaknesses', v.weaknesses], ['Where the board disagreed', v.disagreements], ['Alternatives', v.alternatives], ['Risks', v.risks], ['Next steps', v.next_steps]].map(([t, a]) => (Array.isArray(a) && a.length ? [h('b', {}, t + ':'), list(a)] : null)));
    }

    es = new EventSource(`/api/runs/${id}/stream`);
    es.onmessage = (e) => { add(JSON.parse(e.data)); status.textContent = 'Board in session…'; };
    es.addEventListener('end', (e) => {
      const d = JSON.parse(e.data); es.close(); es = null; stop.remove();
      status.textContent = d.status === 'done' ? 'Session complete.' : `Session ${d.status}.` + (d.error ? ' ' + d.error : '');
      actions.append(h('a', { href: `/report/${id}.pdf`, target: '_blank' }, h('button', { class: 'ghost', type: 'button' }, 'Open PDF report')));
      if (d.status === 'done' && seen.finance) body.after(whatIfForm(id, body, add));
      actions.append(h('button', { class: 'danger', onclick: async () => { if (confirm('Delete this session permanently?')) { await api('/api/runs/' + id, { method: 'DELETE' }); home(); } } }, 'Delete'));
    });
    es.onerror = () => { status.textContent = 'Connection lost. Reload to see the saved session.'; };
  }

  function whatIfForm(id, body, add) {
    const field = h('select', {}, ['unitsPerMonth', 'price', 'unitVariableCost', 'marketingMonthly', 'fixedMonthly', 'initialInvestment'].map((f) => h('option', { value: f }, f)));
    const mode = h('select', {}, [['pct', 'change by %'], ['set', 'set to'], ['add', 'add']].map(([v, l]) => h('option', { value: v }, l)));
    const val = h('input', { type: 'number', step: 'any', placeholder: 'e.g. -40' });
    const msg = h('span', { class: 'err' });
    return h('div', { class: 'card', style: null }, h('b', { class: 'mute' }, 'What if (re-runs the numbers and the verdict):'), h('div', { class: 'row' }, field, mode, val, h('button', { class: 'ghost', type: 'button', onclick: async () => {
      msg.textContent = '';
      try { const ev = await api(`/api/runs/${id}/whatif`, { method: 'POST', body: { label: `${field.value} ${mode.value} ${val.value}`, changes: [{ field: field.value, mode: mode.value, value: Number(val.value) }] } }); add(ev); }
      catch (e) { msg.textContent = e.message; }
    } }, 'Re-run'), msg));
  }

  async function boot() {
    cfg = await api('/api/config');
    try { me = await api('/api/me'); } catch { me = null; }
    const nav = document.getElementById('nav');
    if (!me) { nav.hidden = true; return authView(); }
    nav.hidden = false;
    document.getElementById('who').textContent = me.email;
    if (cfg.provider === 'mock') $app.dataset.mock = '1';
    await home();
    if (cfg.provider === 'mock') $app.prepend(h('div', { class: 'card err' }, 'Demo mode: no Anthropic API key is set on the server, so answers are placeholders.'));
  }
  document.getElementById('logout').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST', body: {} }); me = null; boot(); });
  document.getElementById('brand').addEventListener('click', (e) => { e.preventDefault(); if (me) home(); });
  boot().catch((e) => { $app.textContent = 'Could not load: ' + e.message; });
})();
