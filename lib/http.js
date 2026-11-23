'use strict';
// Small fetch wrapper with a timeout and an in-memory TTL cache, so repeated
// searches (and the poller) don't hammer the FDA's servers.

const cache = new Map();
const MAX_ENTRIES = 500;

// Says who is asking and where to find out more. It names the site rather than a library, so FDA's traffic
// tools can tell this site's few requests apart from everything else leaving the same shared cloud address.
const USER_AGENT = `RecallWatch/1.1 (+${process.env.CONTACT_URL || 'https://recall-watch.quentin.software'}; FDA public-records search)`;

let fetchImpl = (...args) => fetch(...args);
function setFetch(fn) { fetchImpl = fn || ((...args) => fetch(...args)); }

// redirect: 'manual' hands a 3xx back as an error with its Location, instead of quietly following it to some
// other page (fda.gov's abuse protection answers with a redirect to an apology page that then 404s).
async function getJSON(url, { headers = {}, ttlMs = 10 * 60 * 1000, timeoutMs = 20000, allow404 = false, redirect = 'follow' } = {}) {
  const hit = cache.get(url);
  if (hit && hit.expires > Date.now()) return hit.value;

  const res = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
    redirect,
  });
  let value;
  if (res.status === 404 && allow404) {
    value = null;
  } else if (res.status >= 300 && res.status < 400) {
    const err = new Error(`HTTP ${res.status} from ${new URL(url).host}: redirected to ${res.headers.get('location') || 'nowhere'}`);
    err.status = res.status;
    err.location = res.headers.get('location') || '';
    err.server = res.headers.get('server') || '';
    throw err;
  } else if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status} from ${new URL(url).host}: ${body.slice(0, 200)}`);
    err.status = res.status;
    err.retryAfter = Number(res.headers.get('retry-after')) || null;
    throw err;
  } else {
    const body = await res.text();
    try { value = JSON.parse(body); } catch {
      const err = new Error(`Not JSON from ${new URL(url).host} (${(res.headers.get('content-type') || 'no content type')})`);
      err.status = res.status;
      err.notJson = true;
      throw err;
    }
  }
  if (ttlMs > 0) {
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(url, { value, expires: Date.now() + ttlMs });
  }
  return value;
}

// A JSON POST with the same User-Agent and timeout (FDA's Data Dashboard API takes POST bodies only). No cache
// here: the caller keys its own. Errors carry status and Retry-After, never a full upstream body.
async function postJSON(url, body, { headers = {}, timeoutMs = 20000 } = {}) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'manual',
  });
  const text = await res.text().catch(() => '');
  let value = null;
  try { value = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok || value === null) {
    const err = new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    err.status = res.status;
    err.retryAfter = Number(res.headers.get('retry-after')) || null;
    err.notJson = res.ok && value === null;
    throw err;
  }
  return value;
}

// An HTML page (FDA's letter pages), with the same User-Agent, timeout and redirect handling. No cache.
async function getText(url, { headers = {}, timeoutMs = 20000 } = {}) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'manual',
  });
  if (res.status >= 300 && res.status < 400) {
    const err = new Error(`HTTP ${res.status} from ${new URL(url).host}: redirected to ${res.headers.get('location') || 'nowhere'}`);
    err.status = res.status;
    err.location = res.headers.get('location') || '';
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    err.status = res.status;
    err.retryAfter = Number(res.headers.get('retry-after')) || null;
    throw err;
  }
  return res.text();
}

function clearCache() { cache.clear(); }

module.exports = { getJSON, getText, postJSON, clearCache, setFetch, USER_AGENT };
