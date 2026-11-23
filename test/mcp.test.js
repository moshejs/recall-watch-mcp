'use strict';
// The MCP server: protocol handshake, the supplier_history tool and its honesty about unchecked sources.
// Offline: the tool's lookup is faked, and the stdio test makes no tool call.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHandler, TOOLS } = require('../mcp/server');
const { supplierHistory } = require('../lib/supplierHistory');
const dashboard = require('../lib/dashboard');
const letters = require('../lib/warningLetters');

const FEED = require('./fixtures/warning-letters.json');
const letterRows = FEED.data.map(letters.parseRow);
const recall = { id: 'recall:F-1', kind: 'recall', category: 'food', recallNumber: 'F-1', date: '2025-01-01', classification: 'Class I', status: 'Ongoing', firm: 'Abbott Diabetes Care, Inc.', product: 'Capsules', reason: 'Undeclared milk', url: 'https://www.accessdata.fda.gov/scripts/ires/index.cfm?Event=1' };
const sources = {
  letters: { searchLetters: async () => ({ total: 2, items: letterRows, fetchedAt: '2026-11-12T00:00:00Z', stale: false }) },
  openfda: { searchRecalls: async (cat) => (cat === 'food' ? { total: 1, items: [recall] } : { total: 0, items: [] }) },
  dashboard: { citationsForFirm: async () => { throw new dashboard.DashboardError('not_configured', 'Inspection citations need FDA Data Dashboard API credentials, which this site does not have yet, so they were not checked.'); }, themes: dashboard.themes },
};
const handle = createHandler({ supplierFn: ({ firm }) => supplierHistory({ firm, sources }) });

test('initialize negotiates the protocol version and declares tools', async () => {
  const r = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal(r.result.protocolVersion, '2025-06-18');
  assert.deepEqual(r.result.capabilities, { tools: { listChanged: false } });
  assert.equal(r.result.serverInfo.name, 'recall-watch');
  const unknown = await handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(unknown.result.protocolVersion, '2025-11-25');
});

test('notifications get no answer; unknown methods get -32601; ping answers', async () => {
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal((await handle({ jsonrpc: '2.0', id: 3, method: 'resources/list' })).error.code, -32601);
  assert.deepEqual((await handle({ jsonrpc: '2.0', id: 4, method: 'ping' })).result, {});
});

test('tools/list offers supplier_history as a read-only tool with a schema', async () => {
  const r = await handle({ jsonrpc: '2.0', id: 5, method: 'tools/list' });
  assert.deepEqual(r.result.tools.map((t) => t.name), ['supplier_history']);
  const t = r.result.tools[0];
  assert.deepEqual(t.inputSchema.required, ['firm']);
  assert.equal(t.annotations.readOnlyHint, true);
  assert.equal(TOOLS[0], t);
});

test('supplier_history: FDA records with their links, and an unconnected source said plainly', async () => {
  const r = await handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'supplier_history', arguments: { firm: 'Abbott Diabetes Care' } } });
  assert.equal(r.result.isError, false);
  const text = r.result.content[0].text;
  assert.match(text, /WARNING LETTERS \(checked\): 1 addressed to a matching firm; 1 more only mention the name/);
  assert.match(text, /FDA subject: CGMP\/QSR\/Medical Devices\/Adulterated .*https:\/\/www\.fda\.gov\/inspections-compliance-enforcement-and-criminal-investigations\/warning-letters\/abbott-diabetes-care-inc-722046-01232026/);
  assert.match(text, /FORM 483 INSPECTION CITATIONS \(NOT CONNECTED\): Inspection citations need FDA Data Dashboard API credentials/);
  assert.match(text, /RECALLS \(checked\): 1 by a matching firm since 2012 \(Class I 1, Class II 0, Class III 0\)/);
  assert.doesNotMatch(text, /Watch this name|#pricing|\/company\?q=/, 'no watchlist or pricing line until watchlists are live');
  assert.match(text, /Full page: https:\/\/recall-watch\.quentin\.software\/supplier\?firm=Abbott%20Diabetes%20Care/);
  const s = r.result.structuredContent;
  assert.equal(s.letters.items.length, 1);
  assert.equal(s.citations.status, 'not_configured');
  assert.equal(s.recalls.items[0].recallNumber, 'F-1');
});

test('supplier_history: a refused source is NOT CHECKED, never "0"', async () => {
  const refusing = createHandler({ supplierFn: ({ firm }) => supplierHistory({ firm, sources: { ...sources, letters: { searchLetters: async () => { throw new letters.LettersError('refused', 'FDA\'s website turned away this server\'s request, so warning letters were not checked.'); } } } }) });
  const r = await refusing({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'supplier_history', arguments: { firm: 'Nutratech' } } });
  assert.match(r.result.content[0].text, /WARNING LETTERS \(NOT CHECKED\): FDA's website turned away/);
  assert.equal(r.result.structuredContent.letters.status, 'not_checked');
});

test('supplier_history: bad input is a tool error the model can read; unknown tools are protocol errors', async () => {
  const r = await handle({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'supplier_history', arguments: { firm: 'a' } } });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /at least 2 letters/);
  const u = await handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  assert.equal(u.error.code, -32602);
});

test('over stdio: newline-delimited JSON-RPC, nothing but JSON on stdout', async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'mcp', 'server.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const lines = () => out.split('\n').filter(Boolean);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  child.stdin.write('not json\n');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  const deadline = Date.now() + 5000;
  while (lines().length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  child.kill();
  const msgs = lines().map((l) => JSON.parse(l));
  assert.equal(msgs.length, 3);
  assert.equal(msgs.find((m) => m.id === 1).result.protocolVersion, '2025-11-25');
  assert.equal(msgs.find((m) => m.error && m.error.code === -32700).id, null);
  assert.equal(msgs.find((m) => m.id === 2).result.tools[0].name, 'supplier_history');
});

test('FDA hosts are fixed: base-URL environment variables are ignored, so credentials only go to FDA', async () => {
  const http = require('../lib/http');
  const names = ['OPENFDA_BASE', 'FDA_DASHBOARD_BASE', 'FDA_FEED_BASE'];
  const before = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  for (const k of names) process.env[k] = 'https://stub.example.invalid';
  const fresh = ['openfda', 'dashboard', 'warningLetters'].map((m) => require.resolve(`../lib/${m}`));
  for (const f of fresh) delete require.cache[f];
  const hosts = [];
  http.setFetch(async (url) => {
    hosts.push(new URL(url).host);
    const body = url.includes('inspections_citations') ? { result: [], totalrecordcount: 0 } : url.includes('datatables') ? { data: [] } : { meta: { results: { total: 0 } }, results: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  try {
    const [openfda, dash, wl] = fresh.map((f) => require(f));
    await openfda.searchRecalls('food', 'Env Check Foods', { scope: 'firm' });
    await dash.citationsForFirm('Env Check Foods', { env: { FDA_DASHBOARD_USER: 'u', FDA_DASHBOARD_KEY: 'k' } });
    await wl.searchLetters('Env Check Foods');
    assert.deepEqual(hosts, ['api.fda.gov', 'api-datadashboard.fda.gov', 'www.fda.gov']);
  } finally {
    http.setFetch(null);
    http.clearCache();
    for (const k of names) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; }
    for (const f of fresh) delete require.cache[f];
  }
});
