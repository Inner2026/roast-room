'use strict';
// LLM provider layer: Anthropic Messages API over fetch (no SDK), with retries,
// fallback model, usage/cost tracking, optional web search, and a mock provider
// for tests and key-less demos.
const fs = require('fs');
const path = require('path');
const MODELS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'models.json'), 'utf8'));

const API = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function modelFor(kind) {
  if (kind === 'research') return process.env.MODEL_RESEARCH || MODELS.research;
  return process.env.MODEL_SEATS || MODELS.seats;
}

function cost(model, usage, searches) {
  const p = MODELS.pricingUsdPerMTok[model];
  const tok = p ? ((usage.input_tokens || 0) * p.in + (usage.output_tokens || 0) * p.out) / 1e6 : 0;
  return tok + (searches || 0) * MODELS.webSearchUsdPer1000 / 1000;
}

function extract(content) {
  let text = '';
  const sources = [];
  for (const b of content || []) {
    if (b.type === 'text') {
      text += b.text;
      for (const c of b.citations || []) if (c.url) sources.push({ url: c.url, title: c.title || '', date: '' });
    } else if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      for (const r of b.content) if (r.url) sources.push({ url: r.url, title: r.title || '', date: r.page_age || '' });
    }
  }
  const seen = new Set();
  return { text: text.trim(), sources: sources.filter((s) => !seen.has(s.url) && seen.add(s.url)) };
}

class Usage {
  constructor() { this.input = 0; this.output = 0; this.searches = 0; this.usd = 0; this.calls = 0; }
  add(model, u, searches) {
    this.input += u.input_tokens || 0; this.output += u.output_tokens || 0;
    this.searches += searches || 0; this.usd += cost(model, u, searches); this.calls++;
  }
}

// Real provider.
function anthropic(apiKey, usage) {
  async function once(body) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS) || 120000),
    });
    const txt = await res.text();
    let json; try { json = JSON.parse(txt); } catch { json = null; }
    if (!res.ok) {
      const e = new Error(`Anthropic ${res.status}: ${(json && json.error && json.error.message) || txt.slice(0, 200)}`);
      e.status = res.status; throw e;
    }
    return json;
  }
  return {
    name: 'anthropic',
    async ask({ system, prompt, kind = 'seat', maxTokens, webSearch = false }) {
      const body = {
        model: modelFor(kind), max_tokens: maxTokens || MODELS.maxTokens[kind] || 800,
        system, messages: [{ role: 'user', content: prompt }],
      };
      if (webSearch) body.tools = [{ type: MODELS.webSearchTool, name: 'web_search', max_uses: MODELS.webSearchMaxUses }];
      let lastErr;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          if (attempt === 3 && MODELS.fallback) body.model = MODELS.fallback;
          const j = await once(body);
          const n = (j.usage && j.usage.server_tool_use && j.usage.server_tool_use.web_search_requests) || 0;
          usage.add(body.model, j.usage || {}, n);
          return extract(j.content);
        } catch (e) {
          lastErr = e;
          const retry = !e.status || e.status === 429 || e.status >= 500;
          if (!retry) break;
          await sleep(800 * 2 ** attempt);
        }
      }
      throw lastErr;
    },
  };
}

// Mock provider: deterministic canned answers, clearly labelled. Never used in production.
function mock(usage) {
  return {
    name: 'mock',
    async ask({ kind, prompt }) {
      usage.calls++;
      if (/Return ONLY JSON.*weight/s.test(prompt)) {
        return { text: JSON.stringify({ weight: 3, criteria: { financial: 5, market: 5, operational: 5, risk: 5, strategic: 5, legal: 5 }, ruin: false, why: '[MOCK] placeholder score' }), sources: [] };
      }
      if (/formal objection/i.test(prompt)) {
        return { text: JSON.stringify({ severity: 'major', text: '[MOCK] placeholder objection.', conditions: ['Show real demand evidence'], alternatives: ['Pilot first'] }), sources: [] };
      }
      if (kind === 'research') {
        return { text: JSON.stringify({ summary: '[MOCK] no real research performed.', claims: [], gaps: ['Mock provider: no web access'], refresh_if: [] }), sources: [] };
      }
      return { text: '[MOCK] placeholder advisor message.', sources: [] };
    },
  };
}

function makeProvider(usage) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (process.env.LLM_PROVIDER === 'mock' || !key) return mock(usage);
  return anthropic(key, usage);
}

// Pull the first JSON object out of a model reply (tolerates fences / prose).
function parseJson(text) {
  if (!text) return null;
  const t = text.replace(/```(?:json)?/g, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

module.exports = { MODELS, Usage, makeProvider, anthropic, mock, parseJson, extract, cost };
