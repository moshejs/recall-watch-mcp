'use strict';
// openFDA enforcement reports (recalls) for food, drugs and devices.
// Docs: https://open.fda.gov/apis/food/enforcement/ (same shape for drug/device).

const { getJSON } = require('./http');
const { openFdaSearch } = require('./query');

const BASE = 'https://api.fda.gov';
const ENDPOINTS = { food: '/food/enforcement.json', drug: '/drug/enforcement.json', device: '/device/enforcement.json' };

function withKey(params) {
  if (process.env.OPENFDA_API_KEY) params.set('api_key', process.env.OPENFDA_API_KEY);
  return params;
}

// 20260923 -> 2026-09-23
function isoDate(yyyymmdd) {
  const s = String(yyyymmdd || '');
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
}

function normalizeRecall(r, category) {
  const clean = (v) => (v && v !== 'N/A' ? String(v).trim() : '');
  return {
    id: `recall:${r.recall_number}`,
    kind: 'recall',
    category,
    recallNumber: r.recall_number,
    eventId: r.event_id,
    date: isoDate(r.report_date),
    initiated: isoDate(r.recall_initiation_date),
    classified: isoDate(r.center_classification_date),
    terminated: isoDate(r.termination_date),
    classification: r.classification || 'Not yet classified',
    status: r.status || '',
    firm: clean(r.recalling_firm),
    location: [clean(r.city), clean(r.state), r.country && r.country !== 'United States' ? clean(r.country) : ''].filter(Boolean).join(', '),
    product: clean(r.product_description),
    reason: clean(r.reason_for_recall),
    quantity: clean(r.product_quantity),
    distribution: clean(r.distribution_pattern),
    codes: clean(r.code_info),
    voluntary: clean(r.voluntary_mandated),
    brands: (r.openfda && r.openfda.brand_name) || [],
    // FDA's own recall-enterprise page for the event.
    url: r.event_id ? `https://www.accessdata.fda.gov/scripts/ires/index.cfm?Event=${encodeURIComponent(r.event_id)}` : null,
  };
}

async function searchRecalls(category, term, { scope = 'any', limit = 100, classification } = {}) {
  const params = withKey(new URLSearchParams({
    search: openFdaSearch(term, scope, classification),
    sort: 'report_date:desc',
    limit: String(Math.min(Math.max(limit, 1), 1000)),
  }));
  const data = await getJSON(`${BASE}${ENDPOINTS[category]}?${params}`, { allow404: true });
  if (!data) return { total: 0, items: [] };
  return { total: data.meta.results.total, items: data.results.map((r) => normalizeRecall(r, category)) };
}

// Counts by year (all matches, not just the first page) for the timeline chart.
async function yearlyCounts(category, term, { scope = 'any' } = {}) {
  const params = withKey(new URLSearchParams({ search: openFdaSearch(term, scope), count: 'report_date' }));
  const data = await getJSON(`${BASE}${ENDPOINTS[category]}?${params}`, { allow404: true });
  const years = {};
  for (const row of (data && data.results) || []) {
    const y = String(row.time).slice(0, 4);
    years[y] = (years[y] || 0) + row.count;
  }
  return years;
}

// Counts by classification for the summary.
async function classCounts(category, term, { scope = 'any' } = {}) {
  const params = withKey(new URLSearchParams({ search: openFdaSearch(term, scope), count: 'classification.exact' }));
  const data = await getJSON(`${BASE}${ENDPOINTS[category]}?${params}`, { allow404: true });
  const out = {};
  for (const row of (data && data.results) || []) out[row.term] = row.count;
  return out;
}

async function lastUpdated() {
  const data = await getJSON(withKeyUrl(`${BASE}/food/enforcement.json?limit=1`), { ttlMs: 60 * 60 * 1000 });
  return data && data.meta && data.meta.last_updated;
}
function withKeyUrl(url) {
  return process.env.OPENFDA_API_KEY ? `${url}&api_key=${encodeURIComponent(process.env.OPENFDA_API_KEY)}` : url;
}

module.exports = { searchRecalls, yearlyCounts, classCounts, lastUpdated, normalizeRecall, isoDate, ENDPOINTS };
