#!/usr/bin/env node
'use strict';
// Recall Watch MCP server: one firm's FDA record (warning letters, Form 483 citations, recalls) as a tool.
// Model Context Protocol over stdio: newline-delimited JSON-RPC 2.0 on stdin/stdout, logs on stderr.
// No dependencies, like the rest of the repo. See mcp/README.md.

const readline = require('node:readline');
const { supplierHistory } = require('../lib/supplierHistory');
const { version } = require('../package.json');

const SITE = (process.env.SITE_URL || 'https://recall-watch.quentin.software').replace(/\/+$/, '');
// Newest first. The server answers with the client's version when it knows it, else its own newest.
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = 'Look up a food, supplement, drug or device firm\'s FDA enforcement record with supplier_history. Every record returned is FDA\'s own, with a link to the FDA source; quote it as FDA\'s, and check the link before relying on it. Matches are by company name only. A source marked "not checked" was not searched successfully: never report that as "no records".';

const TOOLS = [{
  name: 'supplier_history',
  title: 'FDA supplier history',
  description: 'One firm\'s FDA record on one page: warning letters addressed to it (with FDA\'s subject line), the regulations cited on its Form 483 inspection reports (grouped by how many inspections cited each), and its food, supplement, drug and device recalls since 2012. Built for checking a contract manufacturer, co-packer or ingredient supplier. Matching is by company name, so pass the legal name (for example "Nutratech, LLC"). Each source reports whether it was checked; "not_checked" or "not_configured" means unknown, not none.',
  inputSchema: {
    type: 'object',
    properties: {
      firm: { type: 'string', minLength: 2, maxLength: 80, description: 'Company name to look up, ideally the legal name of the manufacturing firm.' },
      max_items: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: 'How many letters and recalls to list in the text answer (structured content always has counts). Default 10.' },
    },
    required: ['firm'],
    additionalProperties: false,
  },
  annotations: { title: 'FDA supplier history', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}];

const STATUS_WORDS = { checked: 'checked', partial: 'partly checked', not_checked: 'NOT CHECKED', not_configured: 'NOT CONNECTED' };

// Plain text an assistant can quote. Every line about a firm is a field from an FDA record, with its link.
function renderText(h, max) {
  const { firm } = h.query;
  const lines = [];
  const page = `${SITE}/supplier?firm=${encodeURIComponent(firm)}`;
  lines.push(`FDA supplier history for firms named "${firm}" (name match only; checked ${h.checkedAt.slice(0, 16).replace('T', ' ')} UTC).`);
  lines.push(`Full page: ${page}`);
  lines.push('');

  const l = h.letters;
  lines.push(`WARNING LETTERS (${STATUS_WORDS[l.status]}): ${l.status === 'checked' ? `${l.total} addressed to a matching firm${l.mentions ? `; ${l.mentions} more only mention the name` : ''}` : l.error}`);
  if (l.stale) lines.push(`  Saved copy from ${l.fetchedAt}: FDA did not answer just now.`);
  for (const it of l.items.slice(0, max)) {
    lines.push(`- ${it.date || 'date not given'} | ${it.firm} | FDA subject: ${it.subject || 'not given'} | issued by ${it.office || 'FDA'}${it.closedOut ? ' | close-out letter posted' : it.hasResponse ? ' | response letter posted' : ''} | ${it.url}`);
  }
  if (l.items.length > max) lines.push(`  …${l.items.length - max} more on the full page.`);
  lines.push('');

  const c = h.citations;
  lines.push(`FORM 483 INSPECTION CITATIONS (${STATUS_WORDS[c.status]}): ${c.status === 'checked' ? `${c.total} citations across ${c.inspections} inspections` : c.error}`);
  for (const t of c.themes.slice(0, max)) lines.push(`- ${t.cfr || '(no regulation number)'} | FDA short description: ${t.short || 'not given'} | cited in ${t.inspections} inspection(s), latest ${t.latest || 'date not given'}`);
  for (const e of c.establishments.slice(0, 5)) lines.push(`  Establishment: ${e.firm}${e.location ? `, ${e.location}` : ''}${e.fei ? `, FEI ${e.fei}` : ''}${e.profileUrl ? ` | ${e.profileUrl}` : ''}`);
  if (c.status !== 'checked') lines.push(`  Source: ${c.sourceUrl}`);
  lines.push('');

  const r = h.recalls;
  lines.push(`RECALLS (${STATUS_WORDS[r.status]}): ${r.status === 'not_checked' ? r.error : `${r.total} by a matching firm since 2012 (Class I ${r.classes['Class I']}, Class II ${r.classes['Class II']}, Class III ${r.classes['Class III']})${r.status === 'partial' ? `; ${r.error}` : ''}`}`);
  for (const it of r.items.slice(0, max)) {
    lines.push(`- ${it.date || 'date not given'} | ${it.firm} | ${it.classification} | ${it.status || 'status not given'} | ${it.category} | product: ${truncate(it.product, 160)} | reason: ${truncate(it.reason, 200)} | recall ${it.recallNumber}${it.url ? ` | ${it.url}` : ''}`);
  }
  if (r.items.length > max) lines.push(`  …${r.items.length - max} more on the full page.`);
  lines.push('');

  lines.push(`Note: ${h.notice}`);
  return lines.join('\n');
}

const truncate = (s, n) => { const t = String(s || 'not given'); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// Structured content: the same answer as data, trimmed to what a client needs.
function structured(h, max) {
  const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k] ?? null]));
  return {
    firm: h.query.firm,
    checkedAt: h.checkedAt,
    page: `${SITE}/supplier?firm=${encodeURIComponent(h.query.firm)}`,
    watchUrl: `${SITE}/company?q=${encodeURIComponent(h.query.firm)}`,
    letters: { ...pick(h.letters, ['status', 'error', 'total', 'mentions', 'stale', 'fetchedAt', 'latest', 'sourceUrl']), items: h.letters.items.slice(0, max).map((it) => pick(it, ['date', 'posted', 'firm', 'subject', 'office', 'hasResponse', 'closedOut', 'url'])) },
    citations: { ...pick(h.citations, ['status', 'error', 'total', 'inspections', 'latest', 'sourceUrl']), themes: h.citations.themes.slice(0, max), establishments: h.citations.establishments.slice(0, 5) },
    recalls: { ...pick(h.recalls, ['status', 'error', 'total', 'classes', 'latest', 'sourceUrl']), items: h.recalls.items.slice(0, max).map((it) => pick(it, ['date', 'firm', 'category', 'classification', 'status', 'product', 'reason', 'recallNumber', 'url'])) },
    notice: h.notice,
  };
}

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

function createHandler({ supplierFn = supplierHistory } = {}) {
  return async function handle(msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return msg && msg.id !== undefined ? rpcError(msg.id ?? null, -32600, 'Invalid request') : null;
    }
    const isNotification = msg.id === undefined;
    const { id, method, params = {} } = msg;
    if (isNotification) return null; // notifications/initialized, notifications/cancelled: nothing to answer

    switch (method) {
      case 'initialize': {
        const asked = params.protocolVersion;
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'recall-watch', title: 'Recall Watch', version, websiteUrl: SITE },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools: TOOLS });
      case 'tools/call': {
        if (params.name !== 'supplier_history') return rpcError(id, -32602, `Unknown tool: ${params.name}`);
        const args = params.arguments || {};
        const firm = typeof args.firm === 'string' ? args.firm : '';
        const max = Number.isInteger(args.max_items) ? Math.min(Math.max(args.max_items, 1), 50) : 10;
        try {
          const h = await supplierFn({ firm });
          return rpcResult(id, { content: [{ type: 'text', text: renderText(h, max) }], structuredContent: structured(h, max), isError: false });
        } catch (e) {
          // Tool errors go back to the model as a result it can read and act on, not as a protocol error.
          const text = e.status === 400 ? e.message : 'The lookup failed before any FDA source answered. Try again in a minute.';
          if (e.status !== 400) console.error(`[mcp] supplier_history failed: ${e.message}`);
          return rpcResult(id, { content: [{ type: 'text', text }], isError: true });
        }
      }
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  };
}

function serve({ input = process.stdin, output = process.stdout, handle = createHandler() } = {}) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const write = (obj) => output.write(`${JSON.stringify(obj)}\n`);
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return write(rpcError(null, -32700, 'Parse error')); }
    // Batches were dropped from MCP in 2025-06-18; answer each element anyway for older clients.
    const list = Array.isArray(msg) ? msg : [msg];
    for (const m of list) {
      const res = await handle(m);
      if (res) write(res);
    }
  });
  return rl;
}

if (require.main === module) {
  serve();
  console.error(`[mcp] Recall Watch MCP server ${version} on stdio`);
}

module.exports = { createHandler, serve, renderText, structured, TOOLS, PROTOCOL_VERSIONS };
