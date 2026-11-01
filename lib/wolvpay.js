// lib/wolvpay.js
// Server-side wrapper around the WolvPay cryptocurrency payment processor API.
// Docs: https://wolvpay.com/docs  (API v1, base https://wolvpay.com/api/v1)
//
// WolvPay is invoice-based: we create a crypto invoice for a fiat amount,
// the customer pays it on WolvPay's hosted page (BTC, LTC, USDT variants, ...),
// and WolvPay notifies us with a signed webhook. Deposits are ONLY credited
// from a verified signature or an authenticated invoice status check - never
// from the browser. All credit paths are idempotent.
//
// WolvPay exposes no payout API, so withdrawals are settled manually by the
// treasury to the customer's crypto wallet address (see payments.md).
'use strict';

const crypto = require('crypto');
const { toMoney, makeRef } = require('../helpers');

// Header WolvPay uses to deliver the webhook signature.
const WEBHOOK_HEADER = 'x-wolvpay-signature';

// Invoice status -> action for an open (unsettled) deposit transaction.
const STATUS_ACTION = {
  PAID: 'credit',
  UNDERPAID: 'mark_failed',
  EXPIRED: 'mark_failed',
  CONFIRMING_PAYMENT: 'sync',
  AWAITING_PAYMENT: 'sync',
  AWAITING_SELECTION: 'sync'
};

// Non-terminal invoice statuses mapped onto our 'pending' transaction state.
const SYNC_STATUS_TO_TXN_STATUS = {
  CONFIRMING_PAYMENT: 'pending',
  AWAITING_PAYMENT: 'pending',
  AWAITING_SELECTION: 'pending'
};

class WolvPayConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WolvPayConfigError';
    this.code = 'WP_CONFIG';
  }
}

// Load + validate WolvPay config from the environment (server-side only).
function loadConfig() {
  const apiKey = process.env.WOLVPAY_API_KEY;
  if (!apiKey) throw new WolvPayConfigError('WolvPay is not configured. Set WOLVPAY_API_KEY.');
  const baseUrlCfg = process.env.WOLVPAY_BASE_URL || 'https://wolvpay.com/api/v1';
  return { apiKey, baseUrl: baseUrlCfg };
}

// Signing secret for webhooks (dashboard > Webhooks).
function webhookSecret() {
  const secret = process.env.WOLVPAY_WEBHOOK_SECRET;
  if (!secret) throw new WolvPayConfigError('Webhook signing secret is missing. Set WOLVPAY_WEBHOOK_SECRET.');
  return secret;
}

function baseUrl() {
  return process.env.WOLVPAY_BASE_URL || 'https://wolvpay.com/api/v1';
}

// Low-level REST call with bearer auth, timeout and error categorisation.
// Uses node:https with an explicit IPv4 family because some hosts (Cloudflare
// AAAA + broken local IPv6) make undici's fetch hang; retries once on
// transient network failures (ECONNRESET / ETIMEDOUT / EAI_AGAIN).
const https = require('https');

function httpsOnce(method, urlStr, headers, bodyStr, cfg) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      {
        host: u.hostname,
        path: u.pathname + u.search,
        method: method,
        family: 4,
        timeout: 20000,
        headers: Object.assign(
          {
            Authorization: 'Bearer ' + cfg.apiKey,
            'Content-Type': 'application/json',
            'Content-Length': bodyStr === null ? 0 : Buffer.byteLength(bodyStr)
          },
          headers || {}
        )
      },
      (res) => resolve(res)
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('WolvPay request timed out.'), { category: 'timeout' })));
    req.on('error', reject);
    if (bodyStr !== null) req.write(bodyStr);
    req.end();
  });
}

async function apiRequest(method, path, body, cfgOverride) {
  const cfg = cfgOverride || loadConfig();
  const url = cfg.baseUrl.replace(/\/$/, '') + path;
  const bodyStr = body === undefined ? null : JSON.stringify(body);

  let res;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await httpsOnce(method, url, null, bodyStr, cfg);
      break;
    } catch (err) {
      const retriable = ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE'].indexOf(err.code) !== -1 ||
        err.category === 'timeout' ||
        /timed out/i.test(err.message || '');
      if (!retriable || attempt === 1) {
        const e = new Error(/timed out/i.test(err.message || '') ? 'WolvPay request timed out.' : 'Could not reach WolvPay.');
        e.category = /timed out/i.test(err.message || '') ? 'timeout' : 'network';
        throw e;
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
  }

  const raw = await new Promise((resolve, reject) => {
    let b = '';
    res.setEncoding('utf8');
    res.on('data', (c) => (b += c));
    res.on('end', () => resolve(b));
    res.on('error', reject);
  });

  let data = null;
  try { data = JSON.parse(raw); } catch (e) { data = null; }

  if (!(res.statusCode >= 200 && res.statusCode < 300)) {
    const apiMessage = data && data.error && data.error.message
      ? data.error.message
      : ((data && data.message) || ('HTTP ' + res.statusCode));
    const e = new Error(apiMessage);
    if (res.statusCode === 400 || res.statusCode === 402) e.category = 'validation';
    else if (res.statusCode === 401) e.category = 'auth';
    else if (res.statusCode === 404) e.category = 'not_found';
    else if (res.statusCode === 429) e.category = 'limit';
    else e.category = 'provider';
    e.status = res.statusCode;
    throw e;
  }
  return data;
}

// Extract the hosted payment page URL from whatever shape WolvPay returns.
function extractPaymentUrl(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const candidates = [
    raw.payment_url, raw.paymentUrl, raw.checkout_url, raw.checkoutUrl,
    raw.invoice_url, raw.invoiceUrl, raw.hosted_url, raw.hostedUrl,
    raw.url, raw.link
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c) return c;
  }
  return null;
}

// Normalise any invoice payload (create/get/list item, webhook snapshot).
function normalizeInvoice(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.invoice_id != null ? raw.invoice_id : (raw.id != null ? raw.id : null);
  return {
    id: id == null ? null : String(id),
    status: raw.status ? String(raw.status).toUpperCase() : null,
    amount: raw.amount != null ? Number(raw.amount) : null,
    currency: raw.currency ? String(raw.currency).toUpperCase() : null,
    coin: raw.coin ? String(raw.coin).toLowerCase() : null,
    coin_amount: raw.coin_amount != null ? Number(raw.coin_amount) : null,
    coin_received: raw.coin_received != null ? Number(raw.coin_received) : null,
    coin_address: raw.coin_address || null,
    expires_at: raw.expires_at || null,
    payment_url: extractPaymentUrl(raw),
    available_coins: Array.isArray(raw.available_coins) ? raw.available_coins : undefined,
    created_at: raw.created_at || null,
    raw: raw
  };
}

// Unwrap the standard { success, data } envelope (data may be an array).
function unwrapEnvelope(body) {
  if (!body || typeof body !== 'object') return body;
  if (body.data !== undefined) return body.data;
  return body;
}

// Optional merchant whitelist of coin identifiers the account can actually
// receive. Resolution order (first non-empty wins):
//   1. platform_settings.wolvpay_enabled_coins (set from the admin console)
//   2. WOLVPAY_ENABLED_COINS env var
//   3. empty = accept every coin WolvPay supports
//
// The DB override exists so the operator can fix a stale whitelist without a
// deploy: when the env list is narrower than what WolvPay actually returns,
// the admin console shows the mismatch and can sync in one click.
let _enabledCache = { at: 0, coins: null };

async function enabledCoins(db) {
  if (db && Date.now() - _enabledCache.at < 5 * 60 * 1000 && _enabledCache.coins !== null) {
    return _enabledCache.coins;
  }
  let list = [];
  if (db) {
    try {
      const r = (await db.query(
        "SELECT value FROM platform_settings WHERE key = 'wolvpay_enabled_coins'"
      )).rows[0];
      if (r && r.value) {
        list = String(r.value).split(',').map((s) => String(s).trim().toLowerCase()).filter(Boolean);
      }
    } catch (e) { /* table may not exist yet - fall through to env */ }
  }
  if (!list.length) {
    list = (process.env.WOLVPAY_ENABLED_COINS || '').split(',')
      .map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  }
  if (db) _enabledCache = { at: Date.now(), coins: list };
  return list;
}

function enabledCoinsSync() {
  return (process.env.WOLVPAY_ENABLED_COINS || '').split(',')
    .map((s) => String(s).trim().toLowerCase()).filter(Boolean);
}

// Filter a coin list down to the merchant's enabled coins (when configured).
function filterEnabledCoins(coins, allowList) {
  const allow = Array.isArray(allowList) ? allowList : enabledCoinsSync();
  const list = Array.isArray(coins) ? coins : [];
  if (!allow.length) return list;
  const set = {};
  allow.forEach((c) => (set[c] = true));
  return list.filter((c) => set[String(c.coin || '').toLowerCase()] === true);
}

// Known network prefixes in WolvPay coin identifiers (<network>_<asset>).
const NETWORK_PREFIXES = { erc20: 'ERC20', bep20: 'BEP20', polygon: 'POLYGON', sol: 'SOL', trc20: 'TRC20' };

// Human-friendly label that includes the network, e.g. "USDT (TRC20)" for
// trc20_usdt, "Bitcoin" for btc, "USDC (ERC20)" for erc20_usdc.
function coinLabel(coin, name) {
  const c = String(coin || '').toLowerCase();
  const parts = c.split('_');
  const prefix = parts[0];
  const asset = parts.slice(1).join('_');
  if (asset && NETWORK_PREFIXES[prefix]) {
    // Native coin of a chain (sol_sol) - just use the display name.
    if (asset.toLowerCase() === prefix) {
      return (name && String(name).trim()) || asset.toUpperCase();
    }
    return asset.toUpperCase() + ' (' + NETWORK_PREFIXES[prefix] + ')';
  }
  return (name && String(name).trim()) || c.toUpperCase();
}

// Filter + label a coin list in one step (used by the wallet routes).
function applyCoinPolicy(coins, allowList) {
  return filterEnabledCoins(coins, allowList).map((c) =>
    Object.assign({}, c, { label: coinLabel(c.coin, c.name) })
  );
}

// --- Public API operations ------------------------------------------------

// List supported cryptocurrencies with live fiat prices.
async function getCoins() {
  try {
    const body = await apiRequest('GET', '/coins');
    const data = unwrapEnvelope(body) || [];
    const coins = (Array.isArray(data) ? data : []).map(function (c) {
      return {
        coin: String(c.coin || '').toLowerCase(),
        name: c.name || c.coin,
        logo: c.logo || null,
        minimum_transaction_coin: c.minimum_transaction_coin || null,
        prices: c.prices || {}
      };
    }).filter(function (c) { return !!c.coin; });
    return { ok: true, coins: coins };
  } catch (err) {
    return { ok: false, error: err };
  }
}

// Create a crypto invoice for a deposit.
async function createInvoice(input) {
  const payload = {
    amount: toMoney(input.amount),
    currency: input.currency || 'USD',
    white_label: true
  };
  if (input.coin) payload.coin = String(input.coin).toLowerCase();
  if (input.description) payload.description = String(input.description).slice(0, 255);
  if (input.redirectUrl) payload.redirect_url = String(input.redirectUrl);
  try {
    const body = await apiRequest('POST', '/invoices', payload);
    const invoice = normalizeInvoice(unwrapEnvelope(body));
    if (!invoice || !invoice.id) {
      return { ok: false, error: { category: 'provider', message: 'WolvPay returned no invoice id.' } };
    }
    return { ok: true, invoice: invoice };
  } catch (err) {
    return { ok: false, error: err };
  }
}

// Fetch one invoice by id (polling fallback when a webhook was missed).
async function getInvoice(invoiceId) {
  try {
    const body = await apiRequest('GET', '/invoices/' + encodeURIComponent(invoiceId));
    const invoice = normalizeInvoice(unwrapEnvelope(body));
    if (!invoice) return { ok: false, error: { category: 'not_found', message: 'Invoice not found.' } };
    return { ok: true, invoice: invoice };
  } catch (err) {
    return { ok: false, error: err };
  }
}

// Update an invoice (documented endpoint; kept for completeness).
async function updateInvoice(invoiceId, patch) {
  try {
    const body = await apiRequest('POST', '/invoices/' + encodeURIComponent(invoiceId), patch || {});
    return { ok: true, invoice: normalizeInvoice(unwrapEnvelope(body)) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

// List recent invoices (admin reconciliation helper).
async function listInvoices(params) {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  try {
    const body = await apiRequest('GET', '/invoices' + qs);
    const data = unwrapEnvelope(body) || [];
    const invoices = (Array.isArray(data) ? data : []).map(normalizeInvoice);
    return { ok: true, invoices: invoices };
  } catch (err) {
    return { ok: false, error: err };
  }
}

// --- Webhook verification --------------------------------------------------

// Verify the X-WolvPay-Signature header: HMAC-SHA256 hex digest of the RAW
// request body keyed with WOLVPAY_WEBHOOK_SECRET. Accepts an optional
// "sha256=" prefix. Constant-time comparison.
function verifyWebhookSignature(rawBody, signature, secret) {
  if (!rawBody || !signature || !secret) return false;
  let sig = String(signature).trim();
  if (sig.slice(0, 7).toLowerCase() === 'sha256=') sig = sig.slice(7);
  let expected;
  try {
    expected = crypto.createHmac('sha256', String(secret)).update(rawBody).digest('hex');
  } catch (e) {
    return false;
  }
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Parse the webhook JSON body into { event, invoice_id, status, invoice }.
function normalizeWebhookBody(rawBody) {
  const parsed = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody));
  if (!parsed || typeof parsed !== 'object') throw new Error('Webhook body is not an object.');
  const snap = parsed.payload && parsed.payload.invoice_id !== undefined ? parsed.payload : parsed;
  const invoice = normalizeInvoice(snap);
  return {
    event: parsed.event || (invoice && invoice.status ? 'invoice.' + String(invoice.status).toLowerCase() : ''),
    invoice_id: (invoice && invoice.id) || parsed.invoice_id || null,
    status: (invoice && invoice.status) || (parsed.status ? String(parsed.status).toUpperCase() : null),
    invoice: invoice,
    raw: parsed
  };
}

// Decide what a verified webhook means for an existing deposit transaction.
function webhookAction(txnStatus, webhookStatus) {
  const st = String(webhookStatus || '').toUpperCase();
  if (!STATUS_ACTION[st]) return 'ignore';
  if (txnStatus === 'success' || txnStatus === 'failed' || txnStatus === 'cancelled') return 'ignore';
  return STATUS_ACTION[st];
}

// Map a non-terminal invoice status onto our transaction vocabulary.
function syncTxnStatus(webhookStatus) {
  const st = String(webhookStatus || '').toUpperCase();
  return SYNC_STATUS_TO_TXN_STATUS[st] || null;
}

// Referral payouts (simple English rules):
//   - A referral who has NOT deposited yet pays the referrer USD 0.01.
//   - A referral who HAS deposited ("confirmed") pays the referrer USD 2 in
//     total, so confirming simply tops the referral up by USD 1.99.
//   - Referral money lands in users.referral_pending and is claimed into the
//     wallet once it reaches REFERRAL_CLAIM_MIN_USD.
const REFERRAL_PENDING_BONUS_USD = 0.01; // paid the moment someone signs up
const REFERRAL_CONFIRMED_BONUS_USD = 2;  // total once that referral deposits
const REFERRAL_CLAIM_MIN_USD = 30;       // minimum claimable referral balance

// The extra amount a confirmed referral adds on top of the signup bonus.
const REFERRAL_CONFIRM_TOPUP_USD =
  toMoney(REFERRAL_CONFIRMED_BONUS_USD - REFERRAL_PENDING_BONUS_USD);

// Kept for backwards compatibility with older callers and tests: the flat,
// fully-confirmed bonus per referral.
function computeReferralRate(validCount) {
  return REFERRAL_CONFIRMED_BONUS_USD;
}

// Credit the referrer when a new member joins with their code.
// Called from routes/auth.js inside the registration transaction so the bonus
// and the new account commit (or fail) together.
async function grantSignupReferralBonus(client, newUserId) {
  const owner = (await client.query('SELECT referred_by FROM users WHERE id = $1', [newUserId])).rows[0];
  if (!owner || !owner.referred_by) return null;
  const referrerId = owner.referred_by;
  if (referrerId === newUserId) return null; // never pay a self-referral

  // One signup bonus per referral, ever.
  const already = (await client.query(
    'SELECT id FROM referral_bonuses WHERE referrer_id = $1 AND referral_user_id = $2',
    [referrerId, newUserId]
  )).rows[0];
  if (already) return null;

  const bonus = toMoney(REFERRAL_PENDING_BONUS_USD);
  await client.query(
    'INSERT INTO referral_bonuses (referrer_id, referral_user_id, amount, confirmed) VALUES ($1, $2, $3, FALSE)',
    [referrerId, newUserId, bonus]
  );
  await client.query(
    'UPDATE users SET referral_pending = referral_pending + $1, team_income = team_income + $1 WHERE id = $2',
    [bonus, referrerId]
  );
  return { referrerId, bonus, confirmed: false };
}

// Top a referral's bonus up to the full amount once they deposit, and mark the
// bonus confirmed. Idempotent: only a row still marked unconfirmed is updated.
async function grantFirstDepositReferralBonus(client, txn) {
  const owner = (await client.query('SELECT referred_by FROM users WHERE id = $1', [txn.user_id])).rows[0];
  if (!owner || !owner.referred_by) return null;
  const referrerId = owner.referred_by;

  const row = (await client.query(
    'SELECT id, amount, confirmed FROM referral_bonuses WHERE referrer_id = $1 AND referral_user_id = $2',
    [referrerId, txn.user_id]
  )).rows[0];
  if (!row) return null; // no signup bonus recorded (legacy row) - nothing to top up
  if (row.confirmed) return null; // already paid in full

  // Guard: only the FIRST successful deposit confirms the referral.
  const prior = (await client.query(
    "SELECT COUNT(*)::int AS c FROM transactions WHERE user_id = $1 AND type = 'deposit' AND status = 'success' AND id != $2",
    [txn.user_id, txn.id]
  )).rows[0];
  if (Number(prior.c) > 0) return null;

  const paid = toMoney(row.amount);
  const topup = toMoney(Math.max(0, REFERRAL_CONFIRMED_BONUS_USD - paid));

  const upd = await client.query(
    'UPDATE referral_bonuses SET confirmed = TRUE, amount = $1 WHERE id = $2 AND confirmed = FALSE RETURNING *',
    [toMoney(REFERRAL_CONFIRMED_BONUS_USD), row.id]
  );
  if (upd.rowCount === 0) return null; // lost the race - another caller paid it

  if (topup > 0) {
    await client.query(
      'UPDATE users SET referral_pending = referral_pending + $1, team_income = team_income + $1 WHERE id = $2',
      [topup, referrerId]
    );
  }
  return { referrerId, topup, bonus: toMoney(REFERRAL_CONFIRMED_BONUS_USD) };
}

// Move claimable referral money into the wallet.
// Only allowed once the pending balance reaches the minimum, and the whole
// pending balance is claimed in one go (a partial claim would leave dust that
// can never reach the minimum again).
async function claimReferralEarnings(db, userId) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query(
      'SELECT referral_pending FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [userId]
    )).rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return { claimed: false, reason: 'no_user' };
    }
    const pending = toMoney(row.referral_pending);
    if (pending < REFERRAL_CLAIM_MIN_USD) {
      await client.query('ROLLBACK');
      return { claimed: false, reason: 'below_minimum', pending, minimum: REFERRAL_CLAIM_MIN_USD };
    }
    await client.query(
      'UPDATE users SET referral_pending = 0, wallet_balance = wallet_balance + $1 WHERE id = $2',
      [pending, userId]
    );
    await client.query(
      "INSERT INTO transactions (user_id, type, method, amount, fee, net_amount, status, reference) VALUES ($1, 'referral_claim', 'CRYPTO', $2, 0, $2, 'success', $3)",
      [userId, pending, makeRef()]
    );
    await client.query('COMMIT');
    return { claimed: true, amount: pending, user_id: userId };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (e) { /* best effort */ }
    throw error;
  } finally {
    client.release();
  }
}

// --- Database state transitions (idempotent) -------------------------------

// Credit a pending deposit exactly once.
async function creditSuccessfulDeposit(db, reference) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      "UPDATE transactions SET status = 'success' WHERE type = 'deposit' AND reference = $1 AND status IN ('pending','processing') RETURNING *",
      [reference]
    );
    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      return { credited: false, reason: 'already_processed' };
    }
    const txn = upd.rows[0];
    await client.query(
      'UPDATE users SET wallet_balance = wallet_balance + $1, total_deposited = total_deposited + $1 WHERE id = $2',
      [txn.amount, txn.user_id]
    );
    await grantFirstDepositReferralBonus(client, txn);
    await client.query('COMMIT');
    return { credited: true, amount: Number(txn.amount), user_id: txn.user_id, txn: txn };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (e) { /* best effort */ }
    throw error;
  } finally {
    client.release();
  }
}

// Mark a still-open deposit as failed/cancelled/expired/underpaid.
async function markFailedDeposit(db, reference) {
  const res = await db.query(
    "UPDATE transactions SET status = 'failed' WHERE type = 'deposit' AND reference = $1 AND status IN ('pending','processing')",
    [reference]
  );
  return { marked: res.rowCount > 0, reason: res.rowCount > 0 ? 'marked_failed' : 'already_processed' };
}

// Admin completed a manual crypto payout: close the pending withdrawal.
async function settleManualWithdrawal(db, reference) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      "UPDATE transactions SET status = 'success' WHERE type = 'withdrawal' AND reference = $1 AND status IN ('pending','processing') RETURNING *",
      [reference]
    );
    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      return { settled: false, reason: 'already_processed' };
    }
    await client.query('COMMIT');
    const txn = upd.rows[0];
    return { settled: true, amount: Number(txn.amount), user_id: txn.user_id };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (e) { /* best effort */ }
    throw error;
  } finally {
    client.release();
  }
}

// A rejected manual payout restores the wallet and undoes total_withdrawn.
async function refundFailedWithdrawal(db, reference) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      "UPDATE transactions SET status = 'failed' WHERE type = 'withdrawal' AND status IN ('pending','processing') AND reference = $1 RETURNING *",
      [reference]
    );
    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      return { refunded: false, reason: 'already_processed' };
    }
    const txn = upd.rows[0];
    await client.query(
      'UPDATE users SET wallet_balance = wallet_balance + $1, total_withdrawn = GREATEST(total_withdrawn - $1, 0) WHERE id = $2',
      [txn.amount, txn.user_id]
    );
    await client.query('COMMIT');
    return { refunded: true, amount: Number(txn.amount), user_id: txn.user_id };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (e) { /* best effort */ }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  WEBHOOK_HEADER: WEBHOOK_HEADER,
  STATUS_ACTION: STATUS_ACTION,
  WolvPayConfigError: WolvPayConfigError,
  loadConfig: loadConfig,
  webhookSecret: webhookSecret,
  baseUrl: baseUrl,
  apiRequest: apiRequest,
  extractPaymentUrl: extractPaymentUrl,
  normalizeInvoice: normalizeInvoice,
  unwrapEnvelope: unwrapEnvelope,
  getCoins: getCoins,
  enabledCoins: enabledCoins,
  filterEnabledCoins: filterEnabledCoins,
  coinLabel: coinLabel,
  applyCoinPolicy: applyCoinPolicy,
  createInvoice: createInvoice,
  getInvoice: getInvoice,
  updateInvoice: updateInvoice,
  listInvoices: listInvoices,
  verifyWebhookSignature: verifyWebhookSignature,
  normalizeWebhookBody: normalizeWebhookBody,
  webhookAction: webhookAction,
  syncTxnStatus: syncTxnStatus,
  computeReferralRate: computeReferralRate,
  grantSignupReferralBonus: grantSignupReferralBonus,
  grantFirstDepositReferralBonus: grantFirstDepositReferralBonus,
  claimReferralEarnings: claimReferralEarnings,
  REFERRAL_PENDING_BONUS_USD: REFERRAL_PENDING_BONUS_USD,
  REFERRAL_CONFIRMED_BONUS_USD: REFERRAL_CONFIRMED_BONUS_USD,
  REFERRAL_CLAIM_MIN_USD: REFERRAL_CLAIM_MIN_USD,
  creditSuccessfulDeposit: creditSuccessfulDeposit,
  markFailedDeposit: markFailedDeposit,
  settleManualWithdrawal: settleManualWithdrawal,
  refundFailedWithdrawal: refundFailedWithdrawal
};
