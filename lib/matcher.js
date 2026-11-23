'use strict';
// Name matching for Company Watch. Every source is searched by name, and no source shares an
// identifier with another, so a match only ever means "these names look alike". This module grades
// how alike and says so in words. It never claims two records are the same legal entity.

// Levels, strongest first. `alerts` decides whether a watch raises an alert for the level.
const LEVELS = {
  exact: { rank: 4, label: 'Exact name', alerts: true },
  close: { rank: 3, label: 'Name starts with your search', alerts: true },
  partial: { rank: 2, label: 'Name contains your search', alerts: true },
  similar: { rank: 1, label: 'Similar registry name', alerts: false },
  person: { rank: 1, label: 'Looks like a person', alerts: false },
  mention: { rank: 0, label: 'Mentioned only', alerts: false },
};

const SUFFIX_WORDS = new Set(['THE', 'LLC', 'INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LTD', 'LIMITED', 'LP', 'LLP', 'LLLP', 'PLLC', 'PC', 'PA', 'LC', 'PLC', 'NA', 'GMBH', 'AG', 'SA', 'NV', 'BV']);
// Also state codes or plain words, so one of these is a suffix only in the last place: "Tesla Co" is the
// company, but in "Tesla CO LLC" and "Medtronic PA LLC" the letters are part of the name.
const AMBIGUOUS_SUFFIX = new Set(['CO', 'PA', 'PC', 'LC', 'NA', 'SA', 'AG']);
const ALIASES = { LABS: 'LABORATORIES', LAB: 'LABORATORY', INTL: 'INTERNATIONAL', MFG: 'MANUFACTURING', BROS: 'BROTHERS' };
const ORG_WORDS = /\b(LLC|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|LP|LLP|PLC|BANK|GROUP|HOLDINGS|TRUST|FUND|PARTNERS|ASSOCIATES|ASSOCIATION|FOUNDATION|UNIVERSITY|COLLEGE|HOSPITAL|STATE|COUNTY|CITY|UNITED|DEPARTMENT|DEPT|BOARD|LABORATORIES|LABORATORY|LABS|INDUSTRIES|SERVICES|SYSTEMS|PRODUCTS|FOODS|PHARMA|PHARMACEUTICALS|MOTORS|ENERGY|INSURANCE|NATIONAL|INTERNATIONAL|AMERICA|AMERICAN|USA|US)\b/;

// A-Z tokens: accents folded, punctuation dropped, "L.L.C." and "N.A." closed up, "&" and "and" dropped
// so "Johnson & Johnson" and "Johnson and Johnson" compare equal.
function words(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/\b((?:[A-Z]\.){2,})/g, (m) => m.replace(/\./g, ''))
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w && w !== 'AND');
}

// Only a leading "The" and trailing legal suffixes are dropped: "PA Foods" keeps its "PA".
function tokens(s) {
  const all = words(s).map((w) => ALIASES[w] || w);
  let start = 0;
  let end = all.length;
  if (all[0] === 'THE') start = 1;
  while (end > start && SUFFIX_WORDS.has(all[end - 1])) {
    if (end < all.length && AMBIGUOUS_SUFFIX.has(all[end - 1])) break;
    end--;
  }
  const kept = all.slice(start, end);
  return kept.length ? kept : all; // A name that is only suffix words ("The Company") stays as typed.
}

// The search text to send upstream: the name as typed, minus trailing legal suffixes, so "Tesla, Inc."
// also finds "Tesla Motors". Falls back to the typed text when nothing would remain.
function coreName(q) {
  const raw = String(q || '').replace(/\s+/g, ' ').trim();
  let s = raw;
  for (let i = 0; i < 3; i++) {
    const next = s.replace(/[\s,]+(?:L\.?L\.?C\.?|Inc\.?|Incorporated|Corp\.?|Corporation|Co\.?|Company|Ltd\.?|Limited|L\.?P\.?|L\.?L\.?P\.?|PLLC|P\.?C\.?|PLC|N\.?A\.?|GmbH|AG|S\.?A\.?|N\.?V\.?|B\.?V\.?)$/i, '').replace(/[\s,]+$/, '');
    if (next === s) break;
    s = next;
  }
  s = s.replace(/^the\s+/i, '');
  return s.length >= 2 ? s : raw;
}

// Stable key for a company: dismissals made under "Tesla, Inc." also apply to "TESLA INC".
const companyKey = (q) => tokens(q).join(' ');

function indexOfRun(hay, needle) {
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

// Reads as an individual's name when the search sits in the surname position: "John Abbott",
// "John Q. Abbott" or "Abbott, John". "Abbott Nutrition" does not: a two-word company and a two-word
// person look the same, and the word order is the only signal. Errs towards showing the record.
function looksLikePerson(name, want = []) {
  const w = words(name);
  if (w.length < 2 || w.length > 4 || w.some((t) => /\d/.test(t)) || ORG_WORDS.test(w.join(' '))) return false;
  const have = tokens(name);
  const at = indexOfRun(have, want);
  if (at < 0) return false;
  if (at > 0 && at + want.length === have.length) return true;
  return at === 0 && /^[\p{L}'-]+,\s/u.test(String(name).trim());
}

// Grade one candidate name against the search, or null when the search is not in the name.
function gradeName(q, name) {
  const want = tokens(q);
  const have = tokens(name);
  if (!want.length || !have.length) return null;
  const at = indexOfRun(have, want);
  if (at < 0) return null;
  if (have.length === want.length) return 'exact';
  if (looksLikePerson(name, want)) return 'person';
  return at === 0 ? 'close' : 'partial';
}

function result(level, basis, extra = {}) {
  return { level, label: LEVELS[level].label, rank: LEVELS[level].rank, alerts: LEVELS[level].alerts, basis, nameOnly: true, ...extra };
}

const WHY = {
  exact: 'same words after removing legal suffixes',
  close: 'begins with the words you searched',
  partial: 'contains the words you searched, later in the name',
  person: 'contains the words you searched, but reads as an individual\'s name',
};

function best(q, candidates) {
  let top = null;
  for (const c of candidates) {
    const level = gradeName(q, c.name);
    if (level && (!top || LEVELS[level].rank > LEVELS[top.level].rank)) top = { level, ...c };
  }
  return top;
}

// CourtListener: parties first, because they are the field the search ran on, then the case caption.
function matchDocket(q, d) {
  const parties = (d.parties || []).map((name) => ({ name, field: 'party' }));
  const caption = String(d.caseName || '').split(/\s+v\.?\s+/i).map((name) => ({ name, field: 'case name' }));
  const top = best(q, parties) || best(q, caption);
  if (!top) {
    return result('mention', 'CourtListener returned this case for your search, but the name is not in the parties or case name it sent. The party list can be partial.');
  }
  return result(top.level, `${top.field === 'party' ? 'Party' : 'Case name'} “${top.name}” ${WHY[top.level]}. The search result does not say which side this party is on.`, { matched: top.name, field: top.field });
}

function mentionIn(q, text) {
  const hay = tokens(text);
  const want = tokens(q);
  return want.length > 0 && indexOfRun(hay, want) >= 0;
}

function matchRecall(q, it) {
  const firm = gradeName(q, it.firm);
  if (firm) return result(firm, `Recalling firm “${it.firm}” ${WHY[firm]}.`, { matched: it.firm, field: 'recalling firm' });
  const where = [
    (it.brands || []).some((b) => mentionIn(q, b)) && 'brand name',
    mentionIn(q, it.product) && 'product description',
    mentionIn(q, it.reason) && 'recall reason',
    mentionIn(q, it.codes) && 'lot or code text',
  ].filter(Boolean);
  return result('mention', `The recalling firm is “${it.firm}”. Your search appears only in the ${where.length ? where.join(' and ') : 'record text'}, so this may be a supplier, a product name or unrelated.`, { field: 'text' });
}

function matchLetter(q, it) {
  const firm = gradeName(q, it.firm);
  if (firm) return result(firm, `Letter addressee “${it.firm}” ${WHY[firm]}.`, { matched: it.firm, field: 'addressee' });
  return result('mention', `The letter is addressed to “${it.firm}”. FDA's full-text search matched your search somewhere in its text, which can be a supplier, a product or a person's name.`, { field: 'text' });
}

function matchEntity(q, e) {
  const level = gradeName(q, e.name) || 'mention';
  if (level === 'mention') return result('mention', `The ${e.state} portal returned “${e.name}” because the letters you searched appear in it, inside a longer word or out of order.`, { field: 'registered name' });
  return result(level, `${e.state} registered name “${e.name}” ${WHY[level]}. A same-name record in another state can be a different company.`, { matched: e.name, field: 'registered name' });
}

// A registry says nothing about what a company does, so "JOHNSON & JOHNSON EGG FARM" and "JOHNSON & JOHNSON
// CONSUMER INC." look the same to it. A longer registered name therefore stays a strong match only when the
// same name also appears as a firm or party in the FDA or court results for this search. `knownNames` holds
// the companyKey of each of those names.
function gradeRegistryByEvidence(match, name, knownNames) {
  if (match.level !== 'close' && match.level !== 'partial') return match;
  if (knownNames.has(companyKey(name))) {
    return { ...match, basis: `${match.basis} The same name also appears in the FDA or court results here.` };
  }
  return result('similar', `Registered name “${name}” contains your search plus other words, and nothing in the FDA or court results here uses that name. Often an unrelated business.`, { matched: name, field: 'registered name' });
}

// One-word names ("Delta", "Apple") collect far more false positives, so the page warns about them.
const isBroad = (q) => tokens(q).length === 1;

module.exports = { LEVELS, tokens, words, coreName, companyKey, gradeName, looksLikePerson, matchDocket, matchRecall, matchLetter, matchEntity, gradeRegistryByEvidence, isBroad };
