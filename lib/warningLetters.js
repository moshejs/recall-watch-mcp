'use strict';
// FDA warning letters. FDA publishes no API or bulk file for these; the
// official listing page (fda.gov/.../warning-letters) is a Drupal DataTables
// view backed by a public JSON endpoint with full-text search over the letter
// text. We call that endpoint exactly as the page does. It is undocumented, so
// parsing is defensive and failures degrade to "letters not checked", never to "no letters".

const { getJSON, getText } = require('./http');

const FDA = 'https://www.fda.gov';
const AJAX = `${FDA}/datatables/views/ajax`;
const LISTING = `${FDA}/inspections-compliance-enforcement-and-criminal-investigations/compliance-actions-and-activities/warning-letters`;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };
function decode(s) {
  return String(s || '')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}
function text(html) {
  return decode(String(html || '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}
function timeAttr(html) {
  const m = /datetime="(\d{4}-\d{2}-\d{2})/.exec(html || '');
  return m ? m[1] : null;
}

// Row columns, as rendered by the view:
// 0 posted date, 1 letter issue date, 2 company (link), 3 issuing office,
// 4 subject, 5 response letter, 6 closeout letter, 7 search excerpt.
function parseRow(row) {
  if (!Array.isArray(row) || row.length < 5) return null;
  const href = /href="([^"]+)"/.exec(row[2] || '');
  const path = href ? decode(href[1]) : null;
  const company = text(row[2]);
  if (!company) return null;
  const slug = path ? path.split('/').filter(Boolean).pop() : company.toLowerCase().replace(/\W+/g, '-');
  return {
    id: `letter:${slug}`,
    kind: 'letter',
    category: 'letters',
    date: timeAttr(row[1]) || timeAttr(row[0]),
    posted: timeAttr(row[0]),
    firm: company,
    office: text(row[3]),
    subject: text(row[4]),
    hasResponse: !!text(row[5]),
    closedOut: !!text(row[6]),
    excerpt: text(row[7]).replace(/^…\s*|\s*…$/g, ''),
    url: path ? (path.startsWith('http') ? path : FDA + path) : LISTING,
  };
}

// What a failure means, in words the page can show as-is. Nothing from an upstream body reaches the page.
class LettersError extends Error {
  constructor(code, message, { retryAt = null } = {}) {
    super(message);
    this.code = code;
    this.retryAt = retryAt;
  }
}

// fda.gov sits behind Akamai. When its abuse protection objects, it answers 302 to
// /apology_objects/abuse-detection-apology.html (which itself 404s if followed). On 2026-11-12 that happened
// from Vercel's shared AWS addresses for some User-Agents and not others, so it looks like a per-address,
// per-client rate rule, not a ban on cloud hosts. Either way, after a refusal this client stays quiet for a
// while instead of retrying into it, and serves the last good answer (marked as saved) if it has one.
const REFUSED_PAUSE_MS = 15 * 60 * 1000;
const FRESH_MS = 30 * 60 * 1000; // FDA posts letters weekly (Tuesdays); half an hour of staleness is harmless.
const SAVED_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SAVED = 300;
const saved = new Map(); // url -> { value, fetchedAt }
let pausedUntil = 0;
function reset() { saved.clear(); pausedUntil = 0; }

const refusedMessage = (until) => `FDA's website turned away this server's request (its abuse protection answered instead of the letter search), so warning letters were not checked. This server will try again after ${new Date(until).toISOString().slice(11, 16)} UTC.`;

function classify(e) {
  if (e instanceof LettersError) return e;
  if (e.status >= 300 && e.status < 400 && /apology/i.test(e.location || '')) {
    pausedUntil = Date.now() + REFUSED_PAUSE_MS;
    return new LettersError('refused', refusedMessage(pausedUntil), { retryAt: new Date(pausedUntil).toISOString() });
  }
  if (e.status === 429) {
    pausedUntil = Date.now() + (e.retryAfter ? e.retryAfter * 1000 : REFUSED_PAUSE_MS);
    return new LettersError('rate_limited', `FDA's website asked this server to slow down, so warning letters were not checked. Trying again after ${new Date(pausedUntil).toISOString().slice(11, 16)} UTC.`, { retryAt: new Date(pausedUntil).toISOString() });
  }
  if (e.notJson || (e.status >= 300 && e.status < 400)) return new LettersError('changed', 'FDA\'s warning-letter search answered with something other than letters, so warning letters were not checked.');
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return new LettersError('timeout', 'FDA\'s warning-letter search did not answer in time, so warning letters were not checked.');
  if (e.status >= 500) return new LettersError('upstream', `FDA's warning-letter search is having trouble (HTTP ${e.status}), so warning letters were not checked.`);
  if (e.status) return new LettersError('error', `FDA's warning-letter search refused the request (HTTP ${e.status}), so warning letters were not checked.`);
  return new LettersError('error', 'Could not reach FDA\'s warning-letter search, so warning letters were not checked.');
}

// The same request the listing page makes for itself: its Accept, X-Requested-With and Referer, and an
// honest User-Agent (lib/http.js) that names this site.
const PAGE_HEADERS = { Accept: 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest', Referer: LISTING };

async function fetchFeed(url) {
  const now = Date.now();
  const hit = saved.get(url);
  if (hit && now - hit.fetchedAt < FRESH_MS) return { data: hit.value, fetchedAt: hit.fetchedAt, stale: false };
  const fallback = (err) => {
    if (hit && now - hit.fetchedAt < SAVED_MS) return { data: hit.value, fetchedAt: hit.fetchedAt, stale: true, staleReason: err.message };
    throw err;
  };
  if (pausedUntil > now) return fallback(new LettersError('refused', refusedMessage(pausedUntil), { retryAt: new Date(pausedUntil).toISOString() }));
  let data;
  try {
    data = await getJSON(url, { headers: PAGE_HEADERS, ttlMs: 0, redirect: 'manual' });
  } catch (e) {
    return fallback(classify(e));
  }
  if (!data || !Array.isArray(data.data)) return fallback(new LettersError('changed', 'FDA\'s warning-letter search answered with something other than letters, so warning letters were not checked.'));
  if (saved.size >= MAX_SAVED) saved.delete(saved.keys().next().value);
  saved.delete(url);
  saved.set(url, { value: data, fetchedAt: Date.now() });
  return { data, fetchedAt: Date.now(), stale: false };
}

// scope 'firm' keeps only letters whose company name contains the term; other
// scopes keep any letter whose text mentions it.
async function searchLetters(term, { scope = 'any', limit = 100 } = {}) {
  const params = new URLSearchParams({
    search_api_fulltext: term,
    start: '0',
    length: String(Math.min(limit, 200)),
    draw: '1',
    view_name: 'warning_letter_solr_index',
    view_display_id: 'warning_letter_solr_block',
    'order[0][column]': '1',
    'order[0][dir]': 'desc',
  });
  const { data, fetchedAt, stale, staleReason } = await fetchFeed(`${AJAX}?${params}`);
  let items = data.data.map(parseRow).filter(Boolean);
  let total = Number(data.recordsFiltered) || items.length;
  if (scope === 'firm') {
    const needle = term.toLowerCase();
    items = items.filter((l) => l.firm.toLowerCase().includes(needle));
    total = items.length;
  }
  return { total, items, fetchedAt: new Date(fetchedAt).toISOString(), stale, staleReason: staleReason || null };
}

// The newest letters by the date FDA posted them, whatever they mention (the weekly roundup). Same feed, same
// headers, same pause and saved copies as a search.
async function latestPosted({ limit = 100 } = {}) {
  const params = new URLSearchParams({
    search_api_fulltext: '',
    start: '0',
    length: String(Math.min(limit, 200)),
    draw: '1',
    view_name: 'warning_letter_solr_index',
    view_display_id: 'warning_letter_solr_block',
    'order[0][column]': '0',
    'order[0][dir]': 'desc',
  });
  const { data, fetchedAt, stale, staleReason } = await fetchFeed(`${AJAX}?${params}`);
  return { items: data.data.map(parseRow).filter(Boolean), fetchedAt: new Date(fetchedAt).toISOString(), stale, staleReason: staleReason || null };
}

// One letter's page on fda.gov, as HTML. Only fda.gov letter URLs; honours the same pause after a refusal.
const LETTER_PATH = /^https:\/\/www\.fda\.gov\/inspections-compliance-enforcement-and-criminal-investigations\/warning-letters\/[a-z0-9-]+$/;
async function letterPage(url) {
  if (!LETTER_PATH.test(String(url))) throw new LettersError('error', 'Not an FDA warning-letter address.');
  if (pausedUntil > Date.now()) throw new LettersError('refused', refusedMessage(pausedUntil), { retryAt: new Date(pausedUntil).toISOString() });
  try {
    return await getText(url, { headers: { Referer: LISTING } });
  } catch (e) {
    throw classify(e);
  }
}

module.exports = { searchLetters, latestPosted, letterPage, parseRow, decode, text, LISTING, LettersError, PAGE_HEADERS, reset };
