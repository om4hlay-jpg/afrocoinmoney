// afrocoinmoney shared frontend helpers.
(function () {
  'use strict';

  // Escape text before inserting it into the HTML to prevent XSS.
  function escapeHTML(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Read and save the login token (legacy optima_token keys are migrated).
  function getToken() {
    var t = localStorage.getItem('afrocoin_token');
    if (!t) {
      t = localStorage.getItem('optima_token');
      if (t) {
        localStorage.setItem('afrocoin_token', t);
        localStorage.removeItem('optima_token');
      }
    }
    return t;
  }
  function setToken(t) { localStorage.setItem('afrocoin_token', t); }
  function clearToken() { localStorage.removeItem('afrocoin_token'); }

  // Tiny promise-based fetch wrapper that attaches the token and parses JSON.
  // A 12-second timeout guarantees a hung request never leaves a spinner forever.
  async function api(path, options) {
    options = options || {};
    const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    const token = getToken();
    if (token) headers.Authorization = 'Bearer ' + token;

    // The admin console calls the same wrapper but passes the full path
    // (/api/admin/...). Normalise so both /api/foo and /foo work.
    let p = String(path || '');
    if (p.startsWith('/api')) p = p.slice(4);
    if (!p.startsWith('/')) p = '/' + p;

    let body = options.body;
    if (body && typeof body !== 'string') body = JSON.stringify(body);

    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, 12000);

    let res;
    try {
      res = await fetch('/api' + p, {
        method: options.method || 'GET',
        headers: headers,
        body: body,
        signal: controller.signal
      });
    } catch (e) {
      if (e && e.name === 'AbortError') {
        throw new Error('The server is taking too long. Please try again.');
      }
      // Distinguish "no network" from "server is down" - on a phone with patchy
      // data the member can fix the first one themselves.
      throw new Error(
        navigator.onLine
          ? 'Could not reach the server. Please try again in a moment.'
          : 'You are offline. Reconnect to load the latest balances.'
      );
    } finally {
      clearTimeout(timer);
    }

    let data = null;
    try { data = await res.json(); } catch (e) { data = {}; }

    if (res.status === 401 && !path.startsWith('/auth/')) {
      clearToken();
      if (!window.location.pathname.includes('login.html') && !window.location.pathname.endsWith('/')) {
        window.location.href = 'login.html';
      }
      throw new Error(data.error || 'Not logged in.');
    }

    if (!res.ok) {
      throw new Error(data.error || 'Something went wrong. Please try again.');
    }
    return data;
  }

  // --- Currency engine -------------------------------------------------------
  // All amounts from the API are USD base values; they are rendered in the
  // member's chosen currency. The catalogue is fetched once and cached.
  var FALLBACK_CURRENCIES = [
    { code: 'USD', name: 'US Dollar', rate: 1 }
  ];
  var currencyCache = null;
  // Versioned cache key: bump when the catalogue changes so every browser
  // refetches once instead of rendering a stale list forever.
  var CURRENCIES_CACHE_KEY = 'afrocoin_currencies_v2';

  function listHasCode(list, code) {
    if (!Array.isArray(list)) return false;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].code === code) return true;
    }
    return false;
  }

  async function getCurrencies(force) {
    if (currencyCache && !force) return currencyCache;
    try {
      var cached = localStorage.getItem(CURRENCIES_CACHE_KEY);
      if (cached && !force) {
        var parsed = JSON.parse(cached);
        // Reject stale/incomplete caches (e.g. lists saved before USD existed).
        if (listHasCode(parsed, 'USD') && listHasCode(parsed, 'UGX')) {
          currencyCache = parsed;
          return currencyCache;
        }
      }
    } catch (e) { /* ignore cache errors */ }
    try {
      var data = await api('/currencies');
      if (data.currencies && data.currencies.length && listHasCode(data.currencies, 'USD')) {
        currencyCache = data.currencies;
        try { localStorage.setItem(CURRENCIES_CACHE_KEY, JSON.stringify(data.currencies)); } catch (e) {}
        return currencyCache;
      }
    } catch (e) { /* fall through to embedded defaults */ }
    currencyCache = FALLBACK_CURRENCIES;
    return currencyCache;
  }

  function getCurrency() {
    var code = (localStorage.getItem('afrocoin_currency') || 'USD').toUpperCase();
    var list = currencyCache || FALLBACK_CURRENCIES;
    for (var i = 0; i < list.length; i++) {
      if (list[i].code === code) return list[i];
    }
    return list[0];
  }

  function setCurrency(code) {
    localStorage.setItem('afrocoin_currency', String(code || 'USD').toUpperCase());
  }

  // Solve a login proof-of-work challenge (bot prevention).
  // Fetches GET /auth/challenge then grinds sha256(prefix:nonce) until it
  // starts with the required zeros. ~65k hashes on 16 bits - instant for a
  // phone, expensive at bot-farm scale. Needs WebCrypto (HTTPS / localhost).
  async function solveChallenge() {
    var c = await api('/auth/challenge');
    if (!(window.crypto && window.crypto.subtle)) {
      // Very old browser without WebCrypto - surface a clear error.
      throw new Error('Your browser is too old to log in securely. Please update it.');
    }
    var enc = new TextEncoder();
    var pre = c.prefix + ':';
    for (var nonce = 0; ; nonce++) {
      var buf = await window.crypto.subtle.digest('SHA-256', enc.encode(pre + nonce));
      var bytes = new Uint8Array(buf);
      var hex = '';
      for (var i = 0; i < bytes.length; i++) hex += (bytes[i] >> 4).toString(16) + (bytes[i] & 0xF).toString(16);
      if (hex.indexOf(c.difficulty) === 0) return { challenge_id: c.challenge_id, pow: String(nonce) };
    }
  }

  // Format a USD base value in the active currency, e.g. "UGX 74,000".
  function money(usdValue) {
    var c = getCurrency();
    var v = (Number(usdValue) || 0) * c.rate;
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: c.code, currencyDisplay: 'narrowSymbol' }).format(v);
    } catch (e) {
      return c.code + ' ' + v.toLocaleString('en-US', { maximumFractionDigits: 2 });
    }
  }

  // Show a toast message at the top of the screen.
  let toastTimer = null;
  function toast(message, type) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.className = 'toast show ' + (type === 'error' ? 'error' : type === 'success' ? 'success' : '');
    el.textContent = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 3200);
  }

  // Show/hide a page loading spinner (used while content renders).
  function showLoader(show) {
    var el = document.getElementById('pageLoader');
    if (!el) return;
    el.style.display = show ? 'flex' : 'none';
  }

  // Live transaction monitor: preset entries generated by the backend,
  // rendered as "CASH DEPOSIT 35.0 USDT" / "CASH WITHDRAWAL 12400.0 BTC".
  async function loadTicker(containerId) {
    var el = document.getElementById(containerId);
    if (!el) return;
    try {
      var data = await api('/stats/feed');
      var items = (data.feed || []).slice(0, 14);
      var html = items.map(function (t) {
        var kind = t.type === 'deposit' ? 'CASH DEPOSIT' : 'CASH WITHDRAWAL';
        return '<span>' + escapeHTML(kind) + ' <b>' + Number(t.amount).toFixed(1) + ' ' + escapeHTML(t.method) + '</b></span>';
      }).join('');
      el.innerHTML = '<div class="ticker-track">' + html + html + '</div>';
    } catch (e) { /* ignore ticker errors */ }
  }

  // Show a simple inline loading placeholder inside an element.
  function spinnerHTML() {
    return '<div class="spinner-wrap"><div class="spinner"></div><span>Loading...</span></div>';
  }

  // Normalize a phone number or e-mail identifier for submission.
  // Phone numbers must carry their country code (+254..., +234...); a leading
  // 00 international prefix is converted automatically.
  function normalizeIdentifier(value) {
    value = (value || '').trim();
    if (value.includes('@')) return value.toLowerCase();
    var cleaned = value.replace(/[\s\-()]/g, '');
    if (!cleaned) return '';
    if (cleaned.startsWith('+')) return cleaned;
    if (cleaned.startsWith('00')) return '+' + cleaned.slice(2);
    return '+' + cleaned;
  }

  window.App = {
    api: api,
    getToken: getToken,
    setToken: setToken,
    clearToken: clearToken,
    getCurrencies: getCurrencies,
    getCurrency: getCurrency,
    setCurrency: setCurrency,
    solveChallenge: solveChallenge,
    money: money,
    toast: toast,
    showLoader: showLoader,
    loadTicker: loadTicker,
    spinnerHTML: spinnerHTML,
    escapeHTML: escapeHTML,
    normalizeIdentifier: normalizeIdentifier
  };
})();

