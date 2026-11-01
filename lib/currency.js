// Currency catalogue and conversion helpers for afrocoinmoney.
//
// All monetary values are stored internally in USD (the base currency).
// Every user picks a display currency at signup and can change it any time in
// account settings - switching is instant because nothing but the display
// converts. Rates are fixed reference rates (units of currency per 1 USD);
// they are intentionally static so balances never shift behind the user.
'use strict';

const CURRENCIES = {
  UGX: { code: 'UGX', name: 'Ugandan Shilling', country: 'Uganda', rate: 3700 },
  KES: { code: 'KES', name: 'Kenyan Shilling', country: 'Kenya', rate: 129.5 },
  ZAR: { code: 'ZAR', name: 'South African Rand', country: 'South Africa', rate: 18.2 },
  GHS: { code: 'GHS', name: 'Ghanaian Cedi', country: 'Ghana', rate: 15.6 },
  NGN: { code: 'NGN', name: 'Nigerian Naira', country: 'Nigeria', rate: 1540 },
  RWF: { code: 'RWF', name: 'Rwandan Franc', country: 'Rwanda', rate: 1330 },
  TZS: { code: 'TZS', name: 'Tanzanian Shilling', country: 'Tanzania', rate: 2620 },
  ZMW: { code: 'ZMW', name: 'Zambian Kwacha', country: 'Zambia', rate: 26.5 },
  ZWD: { code: 'ZWD', name: 'Zimbabwe Gold (ZiG)', country: 'Zimbabwe', rate: 25.5 },
  SSP: { code: 'SSP', name: 'South Sudanese Pound', country: 'South Sudan', rate: 650 },
  USD: { code: 'USD', name: 'US Dollar', country: 'United States', rate: 1 },
  EUR: { code: 'EUR', name: 'Euro', country: 'Eurozone', rate: 0.92 },
  GBP: { code: 'GBP', name: 'British Pound', country: 'United Kingdom', rate: 0.79 },
  AUD: { code: 'AUD', name: 'Australian Dollar', country: 'Australia', rate: 1.52 },
  CAD: { code: 'CAD', name: 'Canadian Dollar', country: 'Canada', rate: 1.37 },
  CHF: { code: 'CHF', name: 'Swiss Franc', country: 'Switzerland', rate: 0.88 },
  CNY: { code: 'CNY', name: 'Chinese Yuan', country: 'China', rate: 7.25 },
  JPY: { code: 'JPY', name: 'Japanese Yen', country: 'Japan', rate: 149.5 },
  KRW: { code: 'KRW', name: 'South Korean Won', country: 'South Korea', rate: 1360 },
  PHP: { code: 'PHP', name: 'Philippine Peso', country: 'Philippines', rate: 57.5 },
  SGD: { code: 'SGD', name: 'Singapore Dollar', country: 'Singapore', rate: 1.34 },
  THB: { code: 'THB', name: 'Thai Baht', country: 'Thailand', rate: 36.2 },
  VND: { code: 'VND', name: 'Vietnamese Dong', country: 'Vietnam', rate: 25350 },
  MYR: { code: 'MYR', name: 'Malaysian Ringgit', country: 'Malaysia', rate: 4.7 },
  IDR: { code: 'IDR', name: 'Indonesian Rupiah', country: 'Indonesia', rate: 16100 },
  HKD: { code: 'HKD', name: 'Hong Kong Dollar', country: 'Hong Kong', rate: 7.8 },
  INR: { code: 'INR', name: 'Indian Rupee', country: 'India', rate: 83.8 }
};

CURRENCIES.BRL = { code: 'BRL', name: 'Brazilian Real', country: 'Brazil', rate: 5.45 };
CURRENCIES.MXN = { code: 'MXN', name: 'Mexican Peso', country: 'Mexico', rate: 19.9 };
CURRENCIES.COP = { code: 'COP', name: 'Colombian Peso', country: 'Colombia', rate: 4020 };
CURRENCIES.PEN = { code: 'PEN', name: 'Peruvian Sol', country: 'Peru', rate: 3.74 };
CURRENCIES.CLP = { code: 'CLP', name: 'Chilean Peso', country: 'Chile', rate: 945 };
CURRENCIES.ARS = { code: 'ARS', name: 'Argentine Peso', country: 'Argentina', rate: 920 };
CURRENCIES.UYU = { code: 'UYU', name: 'Uruguayan Peso', country: 'Uruguay', rate: 39.4 };
CURRENCIES.PYG = { code: 'PYG', name: 'Paraguayan Guarani', country: 'Paraguay', rate: 7650 };
CURRENCIES.NIO = { code: 'NIO', name: 'Nicaraguan Cordoba', country: 'Nicaragua', rate: 36.8 };
CURRENCIES.BOB = { code: 'BOB', name: 'Bolivian Boliviano', country: 'Bolivia', rate: 6.91 };
CURRENCIES.GTQ = { code: 'GTQ', name: 'Guatemalan Quetzal', country: 'Guatemala', rate: 7.77 };
CURRENCIES.CRC = { code: 'CRC', name: 'Costa Rican Colon', country: 'Costa Rica', rate: 512 };
CURRENCIES.HNL = { code: 'HNL', name: 'Honduran Lempira', country: 'Honduras', rate: 24.7 };
CURRENCIES.PAB = { code: 'PAB', name: 'Panamanian Balboa', country: 'Panama', rate: 1 };
CURRENCIES.LRD = { code: 'LRD', name: 'Liberian Dollar', country: 'Liberia', rate: 194 };

// The full selectable catalogue (blueprint): the African markets we target plus
// the major world currencies, so a member anywhere can see their own currency.
// Pricing is always derived from the USD base price.
const SUPPORTED_CURRENCY_CODES = [
  'UGX', 'KES', 'ZAR', 'GHS', 'NGN', 'RWF', 'TZS', 'ZMW', 'ZWD', 'SSP',
  'USD', 'EUR', 'GBP', 'AUD', 'CAD', 'CHF', 'CNY', 'JPY', 'KRW', 'PHP',
  'SGD', 'THB', 'VND', 'MYR', 'IDR', 'HKD', 'INR', 'BRL', 'MXN', 'COP',
  'PEN', 'CLP', 'ARS', 'UYU', 'PYG', 'NIO', 'BOB', 'GTQ', 'CRC', 'HNL',
  'PAB', 'LRD'
];

// Fallback used when a member does not pick a currency (or sends an unknown one).
const DEFAULT_CURRENCY = 'USD';

// Map each currency to the country it belongs to (for the location picker).
// Derived from the catalogue so every selectable currency has a country.
const CURRENCY_COUNTRY = SUPPORTED_CURRENCY_CODES.reduce(function (acc, code) {
  acc[code] = CURRENCIES[code].country;
  return acc;
}, {});

// Currencies conventionally shown without decimals.
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP']);

// Only the blueprint's selectable currencies pass.
function isSupported(code) {
  return SUPPORTED_CURRENCY_CODES.includes(String(code || '').toUpperCase());
}

// Resolve any input to a catalogue entry (falls back to USD).
function getCurrency(code) {
  const key = String(code || '').toUpperCase();
  return CURRENCIES[key] || CURRENCIES.USD;
}

// Round a value appropriately for the currency (2dp, or 0dp for zero-decimal).
function roundFor(code, value) {
  const c = getCurrency(code);
  const dp = ZERO_DECIMAL.has(c.code) ? 0 : 2;
  const f = Math.pow(10, dp);
  return Math.round((Number(value) || 0) * f) / f;
}

// Convert an amount expressed in `code` into USD (base currency).
function toUsd(amount, code) {
  const c = getCurrency(code);
  return (Number(amount) || 0) / c.rate;
}

// Convert a USD (base) amount into `code`.
function fromUsd(usd, code) {
  const c = getCurrency(code);
  return (Number(usd) || 0) * c.rate;
}

// Currencies WolvPay can actually invoice in (see https://wolvpay.com/docs >
// Supported Currencies). Anything outside this list falls back to USD so the
// invoice is never rejected by the processor.
const WOLVPAY_FIAT = new Set([
  'AED', 'AUD', 'BGN', 'BRL', 'CAD', 'CHF', 'CNY', 'COP', 'CZK', 'DKK',
  'EUR', 'GBP', 'HKD', 'HUF', 'IDR', 'INR', 'JPY', 'LKR', 'MXN', 'MYR',
  'NGN', 'NOK', 'PHP', 'PLN', 'RON', 'RUB', 'SEK', 'SGD', 'THB', 'TRY',
  'TWD', 'UAH', 'UGX', 'USD', 'VND', 'ZAR'
]);

// Return the invoice { currency, amount } for a USD base amount: natively in the
// member's currency when WolvPay supports it, otherwise in USD.
function invoiceAmount(usd, code) {
  const c = getCurrency(code);
  const target = WOLVPAY_FIAT.has(c.code) ? c.code : DEFAULT_CURRENCY;
  return { currency: target, amount: roundFor(target, fromUsd(usd, target)) };
}

// Ordered list for the signup picker and settings page - the whole blueprint
// catalogue, alphabetical by code. USD is included for the base currency but is
// not forced first so the dropdown reads A-Z.
function listCurrencies() {
  return SUPPORTED_CURRENCY_CODES.slice().sort().map(function (code) {
    const c = CURRENCIES[code];
    return { code: c.code, name: c.name, country: c.country, rate: c.rate };
  });
}

// Ordered list of supported countries for the location picker.
function listCountries() {
  return SUPPORTED_CURRENCY_CODES.slice().sort().map(function (code) {
    return { country: CURRENCY_COUNTRY[code], currency: code };
  });
}

// Human minimum, e.g. "UGX 37,000" from a USD base minimum.
function formatLocal(usd, code) {
  const c = getCurrency(code);
  const v = roundFor(c.code, fromUsd(usd, c.code));
  return c.code + ' ' + v.toLocaleString('en-US', { maximumFractionDigits: ZERO_DECIMAL.has(c.code) ? 0 : 2 });
}

module.exports = {
  CURRENCIES, ZERO_DECIMAL, WOLVPAY_FIAT,
  SUPPORTED_CURRENCY_CODES, CURRENCY_COUNTRY, DEFAULT_CURRENCY,
  isSupported, getCurrency, roundFor, toUsd, fromUsd, invoiceAmount,
  listCurrencies, listCountries, formatLocal
};
