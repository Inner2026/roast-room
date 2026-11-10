'use strict';
// Verifies the Anthropic adapter against a local fake API (request shape, web-search parsing, retry, cost).
const assert = require('assert');
const http = require('http');
let seen = [], fail = 1;
const fake = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const body = JSON.parse(b); seen.push({ headers: req.headers, body });
    if (fail-- > 0) { res.writeHead(529, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"overloaded"}}'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'server_tool_use', name: 'web_search', input: {} }, { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://a.example/x', title: 'A', page_age: 'May 1' }] }, { type: 'text', text: '{"summary":"s"}', citations: [{ url: 'https://b.example', title: 'B' }] }], usage: { input_tokens: 1000000, output_tokens: 100000, server_tool_use: { web_search_requests: 2 } } }));
  });
});
fake.listen(0, '127.0.0.1', async () => {
  process.env.ANTHROPIC_API_URL = `http://127.0.0.1:${fake.address().port}/v1/messages`;
  const { anthropic, Usage } = require('./llm');
  const u = new Usage(); const llm = anthropic('sk-test', u);
  const r = await llm.ask({ system: 'S', prompt: 'P', kind: 'research', webSearch: true });
  assert.equal(seen.length, 2, 'retried once after 529');
  const s = seen[1];
  assert.equal(s.headers['x-api-key'], 'sk-test'); assert.equal(s.headers['anthropic-version'], '2023-06-01');
  assert.equal(s.body.model, 'claude-sonnet-5-5'); assert.equal(s.body.tools[0].name, 'web_search'); assert(/^web_search_/.test(s.body.tools[0].type));
  assert.equal(r.text, '{"summary":"s"}'); assert.deepEqual(r.sources.map((x) => x.url).sort(), ['https://a.example/x', 'https://b.example']);
  // 1M in * $2 + 0.1M out * $10 + 2 searches * $0.01 = 2 + 1 + 0.02
  assert(Math.abs(u.usd - 3.02) < 1e-9, 'cost ' + u.usd); assert.equal(u.searches, 2);
  console.log('ok   anthropic adapter: request shape, retry, search parsing, cost'); fake.close();
});
