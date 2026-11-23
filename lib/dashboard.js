'use strict';
// FDA Data Dashboard: inspection citations, the observations FDA investigators record on Form FDA 483.
// Docs: https://datadashboard.fda.gov/oii/api/index.htm (fields: api-definitions-citations.htm, checked 2026-11-12).
//
// The API answers 401 without an Authorization-User/Authorization-Key pair, which FDA emails to whoever
// registers through its OII Unified Logon. There is no keyless file (CitationsDataset.xlsx answers 404), so
// without both variables this source reports "not configured" and the rest of the page works as before.

const { postJSON } = require('./http');

const BASE = 'https://api-datadashboard.fda.gov/v1'; // fixed: the dashboard credentials only ever go to FDA
const DOCS = 'https://datadashboard.fda.gov/oii/api/index.htm';
const DASHBOARD = 'https://datadashboard.fda.gov/oii/cd/inspections.htm';
const COLUMNS = ['InspectionID', 'FEINumber', 'LegalName', 'City', 'State', 'CountryName', 'InspectionEndDate', 'ProgramArea', 'CitationID', 'ActCFRNumber', 'ShortDescription', 'LongDescription', 'FirmProfile'];
const ROWS = 500;
// FDA's own caveats on the citations data, shortened (datadashboard.fda.gov/oii/cd/inspections.htm).
const LIMITS = 'Citations from Form FDA 483 as published in FDA\'s Data Dashboard. FDA posts them only once an inspection\'s classifications are final, leaves out state contract inspections, and omits 483s that were prepared by hand, so a firm can have had a 483 that is not listed here. A 483 records an investigator\'s observations at the close of an inspection; it is not a final FDA decision.';

class DashboardError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function configured(env = process.env) {
  return Boolean(env.FDA_DASHBOARD_USER && env.FDA_DASHBOARD_KEY);
}

const cache = new Map(); // firm -> { value, at }
const TTL_MS = 6 * 60 * 60 * 1000; // FDA updates the dashboard weekly at most.
let pausedUntil = 0;
function reset() { cache.clear(); pausedUntil = 0; }

function classify(e) {
  if (e instanceof DashboardError) return e;
  if (e.status === 401 || e.status === 403) return new DashboardError('refused', 'FDA\'s Data Dashboard refused this server\'s API credentials, so inspection citations were not checked.');
  if (e.status === 429) {
    pausedUntil = Date.now() + (e.retryAfter ? e.retryAfter * 1000 : 15 * 60 * 1000);
    return new DashboardError('rate_limited', 'FDA\'s Data Dashboard asked this server to slow down, so inspection citations were not checked.');
  }
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return new DashboardError('timeout', 'FDA\'s Data Dashboard did not answer in time, so inspection citations were not checked.');
  if (e.status >= 500) return new DashboardError('upstream', `FDA's Data Dashboard is having trouble (HTTP ${e.status}), so inspection citations were not checked.`);
  return new DashboardError('error', 'Could not read FDA\'s Data Dashboard, so inspection citations were not checked.');
}

// Citations for establishments whose legal name contains `name` (the API's own partial match), newest first.
async function citationsForFirm(name, { env = process.env } = {}) {
  if (!configured(env)) throw new DashboardError('not_configured', 'Inspection citations need FDA Data Dashboard API credentials, which this site does not have yet, so they were not checked.');
  const key = String(name).toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  if (pausedUntil > Date.now()) throw new DashboardError('rate_limited', 'FDA\'s Data Dashboard asked this server to slow down, so inspection citations were not checked.');
  let data;
  try {
    data = await postJSON(`${BASE}/inspections_citations`, {
      start: 1,
      rows: ROWS,
      sort: 'InspectionEndDate',
      sortorder: 'DESC',
      returntotalcount: true,
      filters: { LegalName: [String(name)] },
      columns: COLUMNS,
    }, { headers: { 'Authorization-User': env.FDA_DASHBOARD_USER, 'Authorization-Key': env.FDA_DASHBOARD_KEY } });
  } catch (e) {
    throw classify(e);
  }
  // The API reports success inside the body ("message": "Success."), with the rows in `result`.
  if (!data || !Array.isArray(data.result)) throw new DashboardError('changed', 'FDA\'s Data Dashboard answered without citation rows, so inspection citations were not checked.');
  const rows = data.result.map(normalize).filter(Boolean);
  const value = { total: Number(data.totalrecordcount) || rows.length, rows, capped: (Number(data.totalrecordcount) || 0) > rows.length };
  cache.set(key, { value, at: Date.now() });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return value;
}

function normalize(r) {
  if (!r || !r.LegalName) return null;
  const s = (v) => (v == null ? '' : String(v).trim());
  return {
    inspectionId: s(r.InspectionID),
    fei: s(r.FEINumber),
    firm: s(r.LegalName),
    location: [s(r.City), s(r.State), s(r.CountryName) && s(r.CountryName) !== 'United States' ? s(r.CountryName) : ''].filter(Boolean).join(', '),
    date: s(r.InspectionEndDate).slice(0, 10) || null,
    programArea: s(r.ProgramArea),
    citationId: s(r.CitationID),
    cfr: s(r.ActCFRNumber),
    short: s(r.ShortDescription),
    long: s(r.LongDescription),
    profileUrl: /^https:\/\/[a-z0-9.-]*fda\.gov\//i.test(s(r.FirmProfile)) ? s(r.FirmProfile) : null,
  };
}

// Recurring citations: one theme per cited regulation, counted by inspection, most frequent first.
function themes(rows, limit = 10) {
  const by = new Map();
  for (const r of rows) {
    const k = r.cfr || r.short;
    if (!k) continue;
    if (!by.has(k)) by.set(k, { cfr: r.cfr, short: r.short, long: r.long, inspections: new Set(), latest: null });
    const t = by.get(k);
    t.inspections.add(r.inspectionId || `${r.fei}|${r.date}`);
    if (r.date && (!t.latest || r.date > t.latest)) t.latest = r.date;
  }
  return [...by.values()]
    .map((t) => ({ cfr: t.cfr, short: t.short, long: t.long, inspections: t.inspections.size, latest: t.latest }))
    .sort((a, b) => b.inspections - a.inspections || (b.latest || '').localeCompare(a.latest || '') || a.cfr.localeCompare(b.cfr))
    .slice(0, limit);
}

module.exports = { citationsForFirm, configured, themes, normalize, reset, DashboardError, LIMITS, DOCS, DASHBOARD, COLUMNS };
