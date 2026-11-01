// Unit tests for pure business logic.
// Run with: node test/unit.test.js
'use strict';
const assert = require('assert');

const {
  toMoney, makeReferralCode, makeRef, localDateStr, addDaysStr,
  daysBetween, toDateStr, isValidPhone, normalizePhone, computeWithdrawFee
} = require('../helpers.js');
const currencyLib = require('../lib/currency.js');
const rates = require('../lib/rates.js');
let pass = 0;
function ok(name, fn) { fn(); pass++; console.log('PASS - ' + name); }

// --- Helpers ---
ok('toMoney rounds to two decimals', () => {
  assert.strictEqual(toMoney(100.006), 100.01);
  assert.strictEqual(toMoney('50'), 50);
  assert.strictEqual(toMoney(33.333), 33.33);
});

ok('makeReferralCode builds a fully random 8-character code', () => {
  const c = makeReferralCode();
  assert.strictEqual(c.length, 8);
  assert.ok(/^[A-Z2-9]{8}$/.test(c), 'code uses unambiguous alphanumerics only');
  const d = makeReferralCode();
  assert.notStrictEqual(c, d, 'codes differ between calls');
});

ok('makeRef uses the afrocoinmoney ACM prefix', () => {
  const r = makeRef();
  assert.ok(r.startsWith('ACM'), 'reference starts with ACM: ' + r);
});

ok('isValidPhone accepts international numbers from any country', () => {
  assert.strictEqual(isValidPhone('+254712345678'), true);   // Kenya
  assert.strictEqual(isValidPhone('+2348012345678'), true);  // Nigeria
  assert.strictEqual(isValidPhone('+256771234567'), true);   // Uganda
  assert.strictEqual(isValidPhone('+27821234567'), true);    // South Africa
  assert.strictEqual(isValidPhone('+12025550123'), true);    // US
  assert.strictEqual(isValidPhone('0771234567'), false);     // no country code
  assert.strictEqual(isValidPhone('+25612'), false);         // too short
  assert.strictEqual(isValidPhone(''), false);
});

ok('normalizePhone converts 00-prefixed and bare numbers to + format', () => {
  assert.strictEqual(normalizePhone('+254 712 345 678'), '+254712345678'); // spaced
  assert.strictEqual(normalizePhone('00254712345678'), '+254712345678');   // 00 prefix
  assert.strictEqual(normalizePhone('254712345678'), '+254712345678');     // bare country code
  assert.strictEqual(normalizePhone('+254712345678'), '+254712345678');    // already good
});

// --- Withdrawal fee (blueprint: flat 10% deducted from the amount) ---
ok('withdrawal fee takes 10% of the gross', () => {
  const f = computeWithdrawFee(100);
  assert.strictEqual(f.gross, 100);
  assert.strictEqual(f.fee, 10);
  assert.strictEqual(f.net, 90);
  const g = computeWithdrawFee(37.5);
  assert.strictEqual(g.fee, 3.75);
  assert.strictEqual(g.net, 33.75);
});

// --- Currency catalogue (USD base storage) ---
ok('currency catalogue contains every blueprint currency', () => {
  ['UGX', 'KES', 'ZAR', 'GHS', 'NGN', 'RWF', 'TZS', 'ZMW', 'ZWD', 'USD', 'EUR', 'GBP',
   'AUD', 'CAD', 'CHF', 'CNY', 'JPY', 'KRW', 'PHP', 'SGD', 'THB', 'VND', 'MYR', 'IDR',
   'HKD', 'INR', 'BRL', 'MXN', 'COP', 'PEN', 'CLP', 'ARS', 'UYU', 'PYG', 'NIO', 'BOB',
   'GTQ', 'CRC', 'HNL', 'PAB', 'LRD'].forEach((code) => {
    assert.ok(currencyLib.isSupported(code), code + ' must be supported');
  });
  assert.strictEqual(currencyLib.isSupported('XXX'), false);
});

ok('toUsd / fromUsd round-trip through the USD base', () => {
  const ugx = currencyLib.fromUsd(10, 'UGX'); // rate 3700
  assert.strictEqual(ugx, 37000);
  assert.strictEqual(currencyLib.toUsd(37000, 'UGX'), 10);
});

ok('invoiceAmount invoices natively in WolvPay fiat, else falls back to USD', () => {
  const ngn = currencyLib.invoiceAmount(20, 'NGN'); // supported by WolvPay (rate 1540)
  assert.strictEqual(ngn.currency, 'NGN');
  assert.strictEqual(ngn.amount, 30800);

  const kes = currencyLib.invoiceAmount(20, 'KES'); // NOT in WolvPay's fiat list
  assert.strictEqual(kes.currency, 'USD');
  assert.strictEqual(kes.amount, 20);

  const jpy = currencyLib.invoiceAmount(20, 'JPY'); // zero-decimal fiat
  assert.strictEqual(jpy.currency, 'JPY');
  assert.strictEqual(jpy.amount, Math.round(20 * 149.5));
});

// --- Date helpers (guards against the timezone infinite-loop bug) ---
ok('addDaysStr advances a date string by one day', () => {
  assert.strictEqual(addDaysStr('2026-08-12', 1), '2026-08-13');
  assert.strictEqual(addDaysStr('2026-12-31', 1), '2027-01-01');
});

ok('daysBetween is timezone-safe and correct', () => {
  assert.strictEqual(daysBetween('2026-08-12', '2026-08-12'), 0);
  assert.strictEqual(daysBetween('2026-08-11', '2026-08-12'), 1);
  assert.strictEqual(daysBetween('2026-08-13', '2026-08-12'), -1);
});

ok('toDateStr round-trips a local Date to its own date', () => {
  const d = new Date(2026, 7, 12, 15, 0, 0);
  assert.strictEqual(toDateStr(d), '2026-08-12');
  assert.strictEqual(toDateStr('2026-08-12T00:00:00.000Z'), '2026-08-12');
});

ok('localDateStr uses the local calendar date', () => {
  assert.strictEqual(localDateStr(new Date(2026, 7, 12)), '2026-08-12');
});

// --- FX rate feed (lib/rates.js) ------------------------------------------
// applyRates() mutates the shared catalogue, so snapshot and restore the
// original rates to keep this suite isolated from the others.
const RATE_ORIGINAL = {};
currencyLib.SUPPORTED_CURRENCY_CODES.forEach((code) => { RATE_ORIGINAL[code] = currencyLib.CURRENCIES[code].rate; });
function restoreRates() {
  currencyLib.SUPPORTED_CURRENCY_CODES.forEach((code) => { currencyLib.CURRENCIES[code].rate = RATE_ORIGINAL[code]; });
}

// `ok` above is sync-only; these need to await, so use an async runner.
const ASYNC_TESTS = [];

ASYNC_TESTS.push(async () => {
  assert.strictEqual(rates.sanitise('UGX', 0, 3700), null, 'zero rejected');
  assert.strictEqual(rates.sanitise('UGX', -5, 3700), null, 'negative rejected');
  assert.strictEqual(rates.sanitise('UGX', 'abc', 3700), null, 'NaN rejected');
  assert.strictEqual(rates.sanitise('UGX', null, 3700), null, 'null rejected');
  assert.strictEqual(rates.sanitise('UGX', 3700 * 101, 3700), null, '100x spike = corruption');
  assert.strictEqual(rates.sanitise('UGX', 3700 / 101, 3700), null, '100x crash = corruption');
  assert.strictEqual(rates.sanitise('UGX', 4070, 3700), 4070, 'a real 10% move is accepted');
  console.log('PASS - sanitise rejects zero/negative/NaN/absurd rates');
});

ASYNC_TESTS.push(async () => {
  const applied = rates.applyRates({ UGX: 4000, USD: 1, XYZ: 9, KES: 0 }, 'test');
  assert.strictEqual(applied.UGX, 4000);
  assert.strictEqual(applied._source, 'test');
  assert.strictEqual('XYZ' in applied, false, 'unknown code ignored');
  assert.strictEqual('KES' in applied, false, 'zero rate ignored');
  assert.strictEqual(currencyLib.CURRENCIES.UGX.rate, 4000, 'catalogue updated in place');
  restoreRates();
  console.log('PASS - applyRates applies only validated codes and keeps the rest static');
});

ASYNC_TESTS.push(async () => {
  const saved = rates.PROVIDERS.slice();
  try {
    // Force every provider to fail: an unreachable local port.
    rates.PROVIDERS.length = 0;
    rates.PROVIDERS.push({ name: 'dead', url: 'https://127.0.0.1:1/nope', pick: (b) => b && b.rates, timeout: 1500 });
    const out = await rates.refreshRates();
    assert.strictEqual(out, null, 'all providers failing returns null, not a throw');
    const snap = await rates.staticRates();
    assert.ok(snap.USD === 1 && snap.UGX > 0, 'static rates still available as the fallback');
  } finally {
    rates.PROVIDERS.length = 0;
    saved.forEach((p) => rates.PROVIDERS.push(p));
    restoreRates();
  }
  console.log('PASS - a dead rate feed falls back to static rates instead of throwing');
});

(async () => {
  for (const t of ASYNC_TESTS) { await t(); pass++; }
  restoreRates();
  console.log('\nAll ' + pass + ' unit tests passed.');
  process.exit(0);
})();

