'use strict';
// Supplier history: one firm's FDA warning letters, inspection citations (Form 483) and recalls, on one page.
// Built for brands checking a contract manufacturer. Every record is FDA's own, matched by name only, and each
// source says whether it was checked: a source that failed or isn't configured is never shown as "nothing".

const openfda = require('./openfda');
const letters = require('./warningLetters');
const dashboard = require('./dashboard');
const { cleanTerm } = require('./query');
const M = require('./matcher');

const RECALL_CATS = ['food', 'drug', 'device'];
const NOTICE = 'Every record here is FDA\'s own, linked to its source on fda.gov or open.fda.gov. Matches are by company name only, so a record can belong to a different firm with a similar name: check the address and the FDA record before relying on it. A warning letter states FDA\'s position when it was issued and is not a court finding; a Form 483 records an investigator\'s observations, not a final agency decision. Not legal advice and not a consumer report.';

// Name-level matches only (exact, starts with, contains). Mentions in other firms' text are counted, not listed.
const named = (m) => m && m.rank >= 2 && m.level !== 'person';

function cleanError(e) {
  const m = String((e && e.message) || '');
  return /<[a-z!/][^>]*>/i.test(m) || m.length > 240 ? 'This source had a problem answering. Try again shortly.' : m;
}

async function lettersPart(typed, core, src) {
  try {
    const r = await src.letters.searchLetters(core, { scope: 'any', limit: 100 });
    const mapped = r.items.map((it) => ({ ...it, match: M.matchLetter(typed, it) }));
    const items = mapped.filter((it) => named(it.match));
    return {
      status: 'checked', total: items.length, mentions: mapped.length - items.length, items,
      stale: Boolean(r.stale), staleReason: r.staleReason || null, fetchedAt: r.fetchedAt || null,
      latest: items[0] ? items[0].date : null,
    };
  } catch (e) {
    return { status: 'not_checked', code: e.code || 'error', error: cleanError(e), retryAt: e.retryAt || null, total: 0, mentions: 0, items: [] };
  }
}

async function recallsPart(typed, core, src) {
  const byCategory = {};
  const items = [];
  await Promise.all(RECALL_CATS.map(async (cat) => {
    try {
      const r = await src.openfda.searchRecalls(cat, core, { scope: 'firm', limit: 100 });
      const mine = r.items.map((it) => ({ ...it, match: M.matchRecall(typed, it) })).filter((it) => named(it.match));
      byCategory[cat] = { ok: true, total: r.total, shown: mine.length };
      items.push(...mine);
    } catch (e) {
      byCategory[cat] = { ok: false, total: 0, shown: 0, error: cleanError(e) };
    }
  }));
  items.sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.id.localeCompare(b.id));
  const okCats = RECALL_CATS.filter((c) => byCategory[c].ok);
  const classes = { 'Class I': 0, 'Class II': 0, 'Class III': 0 };
  for (const it of items) if (classes[it.classification] !== undefined) classes[it.classification] += 1;
  return {
    status: okCats.length === RECALL_CATS.length ? 'checked' : okCats.length ? 'partial' : 'not_checked',
    error: okCats.length === RECALL_CATS.length ? null : RECALL_CATS.filter((c) => !byCategory[c].ok).map((c) => `${c}: ${byCategory[c].error}`).join(' '),
    byCategory, total: items.length, classes, items,
    latest: items[0] ? items[0].date : null,
  };
}

async function citationsPart(typed, core, src, env) {
  try {
    const r = await src.dashboard.citationsForFirm(core, { env });
    const rows = r.rows.map((row) => ({ ...row, match: M.gradeName(typed, row.firm) })).filter((row) => ['exact', 'close', 'partial'].includes(row.match));
    const establishments = new Map();
    for (const row of rows) {
      const k = row.fei || row.firm;
      if (!establishments.has(k)) establishments.set(k, { fei: row.fei, firm: row.firm, location: row.location, profileUrl: row.profileUrl, inspections: new Set(), latest: null, matchLabel: M.LEVELS[row.match].label });
      const e = establishments.get(k);
      e.inspections.add(row.inspectionId);
      if (row.date && (!e.latest || row.date > e.latest)) e.latest = row.date;
    }
    const inspections = new Set(rows.map((row) => row.inspectionId));
    return {
      status: 'checked', total: rows.length, inspections: inspections.size, capped: Boolean(r.capped),
      establishments: [...establishments.values()].map((e) => ({ ...e, inspections: e.inspections.size })).sort((a, b) => (b.latest || '').localeCompare(a.latest || '')),
      themes: src.dashboard.themes(rows),
      latest: rows.reduce((d, row) => (row.date && (!d || row.date > d) ? row.date : d), null),
    };
  } catch (e) {
    return { status: e.code === 'not_configured' ? 'not_configured' : 'not_checked', code: e.code || 'error', error: cleanError(e), total: 0, inspections: 0, establishments: [], themes: [] };
  }
}

async function supplierHistory({ firm, sources = {}, env = process.env } = {}) {
  const typed = cleanTerm(firm);
  if (typed.length < 2) throw Object.assign(new Error('Enter at least 2 letters or digits of the company name.'), { status: 400 });
  const core = M.coreName(typed);
  const src = { openfda, letters, dashboard, ...sources };
  const [l, r, c] = await Promise.all([lettersPart(typed, core, src), recallsPart(typed, core, src), citationsPart(typed, core, src, env)]);
  return {
    query: { firm: typed, core, broad: M.isBroad(typed) },
    checkedAt: new Date().toISOString(),
    letters: { ...l, label: 'FDA warning letters', limits: 'FDA\'s warning-letter listing (an undocumented feed behind its public page). The newest 100 letters mentioning the name are checked; only letters addressed to a matching firm are listed.', sourceUrl: letters.LISTING },
    citations: { ...c, label: 'Inspection citations (Form 483)', limits: dashboard.LIMITS, sourceUrl: dashboard.DASHBOARD },
    recalls: { ...r, label: 'FDA recalls', limits: 'openFDA enforcement reports for food (which includes dietary supplements), drugs and devices, 2012 on, searched by recalling firm. Newest 100 per category. openFDA calls the data unvalidated.', sourceUrl: 'https://open.fda.gov/apis/food/enforcement/' },
    notice: NOTICE,
  };
}

// True when every source answered live, so a shared cache may keep the page.
function allLive(h) {
  return h.letters.status === 'checked' && !h.letters.stale && h.recalls.status === 'checked' && ['checked', 'not_configured'].includes(h.citations.status);
}

module.exports = { supplierHistory, allLive, NOTICE, RECALL_CATS };
