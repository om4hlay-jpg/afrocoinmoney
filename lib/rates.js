// lib/rates.js
// Live foreign-exchange rates for the display currencies.
//
// A free, key-less endpoint is used first (exchangerate-api.com's open tier via
// open.er-api.com). If that is unreachable we fall back to other free providers,
// and finally to the static rates baked into lib/currency.js so pricing NEVER
// hard-fails: a dead rate feed only means prices are slightly stale, never that
// the app breaks.
//
// Rates are USD -> currency (how many units of the currency one USD buys), which
// matches CURRENCIES[code].rate. Codes a provider omits keep their static rate.
'use strict';

const https = require('https');
const currencyLib = require('./currency');

// Free, no-API-key providers, tried in order. Each returns a USD-base rate map.
const PROVIDERS = [
  {
    name: 'open.er-api.com',
    url: 'https://open.er-api.com/v6/latest/USD',
    pick: (body) => (body && body.result === 'success' && body.rates) || null
  },
  {
    // ECB reference rates - free, no key, no rate limit.
    name: 'frankfurter.app',
    url: 'https://api.frankfurter.app/latest?from=USD',
    pick: (body) => (body && body.rates) || null
  },
  {
    name: 'currency-api',
    url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
    pick: (body) => (body && body.usd) || null
  }
];

// How long a fetched rate set stays fresh. The open endpoint refreshes about
// once a day, so polling more often than this is pure waste.
const FRESH_MS = 6 * 60 * 60 * 1000; // 6 hours

function httpsGet(urlStr, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      {
        host: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        family: 4, // explicit IPv4: broken local IPv6 makes requests hang
        timeout: timeoutMs || 8000,
        headers: { Accept: 'application/json', 'User-Agent': 'afrocoinmoney-rates/2.0' }
      },
      (res) => {
        // Follow one redirect (providers like to 301 to a versioned URL).
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(httpsGet(new URL(res.headers.location, u).toString(), timeoutMs));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(Object.assign(new Error('HTTP ' + res.statusCode), { code: 'HTTP_' + res.statusCode }));
        }
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          raw += c;
          if (raw.length > 4 * 1024 * 1024) req.destroy(new Error('Rate feed too large.'));
        });
        res.on('end', () => resolve(raw));
      }
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('Timed out.'), { category: 'timeout' })));
    req.on('error', reject);
    req.end();
  });
}

// Fetch one provider and normalise it into { CODE: usdToCodeRate }.
async function fetchProvider(provider) {
  const raw = await httpsGet(provider.url, provider.timeout);
  let body;
  try {
    body = JSON.parse(raw);
  } catch (e) {
    throw new Error(provider.name + ': invalid JSON');
  }
  const rates = provider.pick(body);
  if (!rates || typeof rates !== 'object') throw new Error(provider.name + ': no rates in response');

  const out = {};
  for (const key of Object.keys(rates)) {
    const code = String(key).toUpperCase();
    const val = Number(rates[key]);
    // Reject zero/negative/NaN - a bad rate would make pricing divide by zero.
    if (code.length === 3 && Number.isFinite(val) && val > 0) out[code] = val;
  }
  if (!Object.keys(out).length) throw new Error(provider.name + ': empty rate map');
  return out;
}

// Coerce a rate into something sane: positive, finite, and not absurdly far from
// the static reference (guards against a provider serving a corrupt feed).
function sanitise(code, incoming, reference) {
  const val = Number(incoming);
  if (!Number.isFinite(val) || val <= 0) return null;
  // The window is deliberately wide - it only rejects feed corruption, not real
  // market movement (a devaluing currency can legitimately double in a year).
  if (reference && (val > reference * 100 || val < reference / 100)) return null;
  // Six significant digits: plenty of precision, no float noise in the UI.
  return Number(val.toPrecision(6));
}

let cache = { at: 0, rates: null, source: null };
let inFlight = null;

// Merge a fetched rate map over the catalogue. Returns the codes actually applied.
function applyRates(incoming, source) {
  const applied = {};
  for (const code of currencyLib.SUPPORTED_CURRENCY_CODES) {
    const ref = currencyLib.CURRENCIES[code] ? currencyLib.CURRENCIES[code].rate : null;
    const next = sanitise(code, incoming[code], ref);
    if (next === null) continue; // provider lacked this code - keep the static rate
    currencyLib.CURRENCIES[code].rate = next;
    applied[code] = next;
  }
  if (source) applied._source = source;
  return applied;
}

// Fetch fresh rates and apply them to the catalogue. Safe to call concurrently:
// overlapping callers share a single in-flight request.
async function refreshRates() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    let failures = 0;
    for (const provider of PROVIDERS) {
      try {
        const fetched = await fetchProvider(provider);
        const applied = applyRates(fetched, provider.name);
        cache = { at: Date.now(), rates: applied, source: provider.name };
        console.log('[rates] ' + Object.keys(applied).length + ' rates updated from ' + provider.name + '.');
        return applied;
      } catch (err) {
        failures++;
        console.error('[rates] ' + provider.name + ' failed: ' + err.message);
      }
    }
    // Every provider failed - keep serving the static rates.
    console.error('[rates] all ' + failures + ' providers failed; keeping static rates.');
    return null;
  })().finally(() => { inFlight = null; });
  return inFlight;
}

// Snapshot of the (possibly live-updated) catalogue rates, honouring any
// fx_override_<CODE> rows in platform_settings so the operator can fix a stale
// provider feed without a deploy.
async function staticRates(db) {
  const out = {};
  for (const code of currencyLib.SUPPORTED_CURRENCY_CODES) {
    if (currencyLib.CURRENCIES[code]) out[code] = currencyLib.CURRENCIES[code].rate;
  }
  if (db) {
    try {
      const rows = (await db.query(
        "SELECT key, value FROM platform_settings WHERE key LIKE 'fx_override_%'"
      )).rows;
      for (const r of rows) {
        const code = String(r.key).slice('fx_override_'.length).toUpperCase();
        const val = Number(r.value);
        if (currencyLib.isSupported(code) && Number.isFinite(val) && val > 0) {
          out[code] = val;
          if (currencyLib.CURRENCIES[code]) currencyLib.CURRENCIES[code].rate = val;
        }
      }
    } catch (e) { /* table may not exist yet */ }
  }
  return out;
}

// Current rates, refreshing at most once per FRESH_MS window.
async function getRates(db) {
  if (cache.rates && Date.now() - cache.at < FRESH_MS) {
    return { rates: cache.rates, source: cache.source, stale: false };
  }
  const fresh = await refreshRates();
  if (db) {
    try {
      const rows = (await db.query(
        "SELECT key, value FROM platform_settings WHERE key LIKE 'fx_override_%'"
      )).rows;
      for (const r of rows) {
        const code = String(r.key).slice('fx_override_'.length).toUpperCase();
        const val = Number(r.value);
        if (currencyLib.isSupported(code) && Number.isFinite(val) && val > 0) {
          if (currencyLib.CURRENCIES[code]) currencyLib.CURRENCIES[code].rate = val;
          if (fresh) fresh[code] = val;
        }
      }
    } catch (e) { /* ignore */ }
  }
  return { rates: fresh || staticRates(db), source: cache.source || 'static', stale: !fresh };
}

module.exports = { refreshRates, getRates, staticRates, applyRates, sanitise, fetchProvider, PROVIDERS, FRESH_MS };
