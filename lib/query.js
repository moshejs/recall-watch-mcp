'use strict';
// Turning user input into safe search terms. Kept separate (and pure) so it is
// easy to test.

const CATEGORIES = ['food', 'drug', 'device', 'letters'];
const SCOPES = ['any', 'firm', 'product'];

// Keep letters (any script), digits and a few punctuation marks that appear in
// company names. Everything else becomes a space. Quotes and Lucene operators
// never reach openFDA.
function cleanTerm(raw) {
  return String(raw || '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}&.,'\- ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function parseCategories(raw) {
  if (!raw) return CATEGORIES.slice();
  const list = String(raw).split(',').map((s) => s.trim().toLowerCase()).filter((c) => CATEGORIES.includes(c));
  return list.length ? [...new Set(list)] : CATEGORIES.slice();
}

function parseScope(raw) {
  return SCOPES.includes(raw) ? raw : 'any';
}

// openFDA's search is Elasticsearch query-string. Commas and periods inside a
// quoted phrase are fine; we only drop characters that could break quoting.
function phrase(term) {
  return '"' + term.replace(/["\\]/g, ' ').trim() + '"';
}

// Build the `search` parameter. A space means OR in openFDA.
function openFdaSearch(term, scope = 'any', classification) {
  const p = phrase(term);
  let fields;
  if (scope === 'firm') fields = ['recalling_firm'];
  else if (scope === 'product') fields = ['product_description', 'reason_for_recall', 'code_info'];
  else fields = ['recalling_firm', 'product_description', 'reason_for_recall', 'code_info'];
  let q = '(' + fields.map((f) => `${f}:${p}`).join(' ') + ')';
  if (classification && /^Class (I|II|III)$/.test(classification)) q += ` AND classification:"${classification}"`;
  return q;
}

module.exports = { CATEGORIES, SCOPES, cleanTerm, parseCategories, parseScope, openFdaSearch };
