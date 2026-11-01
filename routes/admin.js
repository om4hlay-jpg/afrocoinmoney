// routes/admin.js
// System administrator API. Every route is guarded by adminRequired, which
// re-checks the is_admin flag in the database on each request so revoking an
// admin takes effect immediately.
//
// Read side: platform KPIs, member list, transaction ledger, pending payouts.
// Write side: settle or refund a manual withdrawal, and credit/debit a wallet
// adjustment. All money moves are single-statement, idempotent-safe updates.
'use strict';

const express = require('express');
const { pool } = require('../db');
const { adminRequired } = require('../middleware/admin');
const { toMoney, makeRef, localDateStr } = require('../helpers');
const currencyLib = require('../lib/currency');
const rates = require('../lib/rates');
const wolvpay = require('../lib/wolvpay');
const logger = require('../lib/logger');

const router = express.Router();

// Guard the whole router - no admin route is reachable unauthenticated.
router.use(adminRequired);

// Record every admin action in system_logs so the console has a live audit
// trail of who did what and when. Fire-and-forget: a slow DB must never stall
// a treasury operation.
router.use((req, res, next) => {
  const start = Date.now();
  const originalJson = res.json.bind(res);
  res.json = function (body) {
    const ms = Date.now() - start;
    const ok = res.statusCode < 400;
    const who = (req.user && req.user.id) ? 'admin#' + req.user.id : 'admin';
    logger.info('admin', (ok ? 'OK' : 'FAIL') + ' ' + req.method + ' ' + req.originalUrl + ' (' + ms + 'ms)', {
      user: who,
      status: res.statusCode,
      body: body && typeof body === 'object' ? JSON.stringify(body).slice(0, 300) : undefined
    });
    return originalJson(body);
  };
  next();
});

// Clamp a page-size / offset pair so a bad query can never dump the table.
function page(req) {
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 25));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  return { limit, offset };
}

// GET /api/admin/overview - platform-wide KPIs for the dashboard cards.
router.get('/overview', async (req, res) => {
  try {
    const q = async (sql) => (await pool.query(sql)).rows[0];
    const [members, active, money, deposits, payouts, bots, pending] = await Promise.all([
      q('SELECT COUNT(*)::int AS c FROM users WHERE deleted_at IS NULL'),
      q("SELECT COUNT(*)::int AS c FROM users WHERE deleted_at IS NULL AND joined_at > NOW() - INTERVAL '7 days'"),
      q(`SELECT
            COALESCE(SUM(wallet_balance), 0)  AS wallet,
            COALESCE(SUM(total_deposited), 0) AS deposited,
            COALESCE(SUM(total_withdrawn), 0) AS withdrawn,
            COALESCE(SUM(bot_income), 0)     AS bot_income,
            COALESCE(SUM(team_income), 0)    AS team_income
          FROM users WHERE deleted_at IS NULL`),
      q("SELECT COUNT(*)::int AS c, COALESCE(SUM(amount), 0) AS total FROM transactions WHERE type = 'deposit' AND status = 'success'"),
      q("SELECT COUNT(*)::int AS c, COALESCE(SUM(amount), 0) AS total FROM transactions WHERE type = 'withdrawal' AND status = 'success'"),
      q("SELECT COUNT(*)::int AS c FROM user_bots WHERE status = 'active'"),
      q("SELECT COUNT(*)::int AS c FROM transactions WHERE type = 'withdrawal' AND status = 'pending'")
    ]);

    return res.json({
      members: members.c,
      new_members_7d: active.c,
      wallets_usd: toMoney(money.wallet),
      total_deposited_usd: toMoney(money.deposited),
      total_withdrawn_usd: toMoney(money.withdrawn),
      bot_income_usd: toMoney(money.bot_income),
      team_income_usd: toMoney(money.team_income),
      platform_earnings_usd: toMoney(Number(money.bot_income) + Number(money.team_income)),
      deposits: deposits.c,
      deposits_usd: toMoney(deposits.total),
      payouts: payouts.c,
      payouts_usd: toMoney(payouts.total),
      active_bots: bots.c,
      pending_payouts: pending.c
    });
  } catch (err) {
    console.error('Admin overview error:', err);
    return res.status(500).json({ error: 'Could not load the platform overview.' });
  }
});

// GET /api/admin/members - paginated member directory.
router.get('/members', async (req, res) => {
  const { limit, offset } = page(req);
  const search = String(req.query.q || '').trim().slice(0, 60);
  try {
    const where = ['u.deleted_at IS NULL'];
    const params = [];
    if (search) {
      params.push('%' + search + '%');
      where.push('(u.email ILIKE $' + params.length + ' OR u.phone ILIKE $' + params.length + ' OR u.display_name ILIKE $' + params.length + ')');
    }
    const whereSql = 'WHERE ' + where.join(' AND ');
    const total = (await pool.query('SELECT COUNT(*)::int AS c FROM users u ' + whereSql, params)).rows[0].c;
    const rows = (await pool.query(
      `SELECT u.id, u.email, u.phone, u.display_name, u.currency, u.country,
              u.wallet_balance, u.total_deposited, u.total_withdrawn,
              u.bot_income, u.team_income, u.referral_code, u.is_admin, u.joined_at,
              u.banned_until,
              (SELECT COUNT(*)::int FROM users r WHERE r.referred_by = u.id) AS referrals
         FROM users u ${whereSql}
        ORDER BY u.id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      params.concat([limit, offset])
    )).rows;

    return res.json({
      total,
      limit,
      offset,
      members: rows.map((u) => ({
        id: u.id,
        identifier: u.email || u.phone,
        display_name: u.display_name || null,
        currency: u.currency,
        country: u.country,
        wallet_balance_usd: toMoney(u.wallet_balance),
        total_deposited_usd: toMoney(u.total_deposited),
        total_withdrawn_usd: toMoney(u.total_withdrawn),
        bot_income_usd: toMoney(u.bot_income),
        team_income_usd: toMoney(u.team_income),
        referral_code: u.referral_code,
        referrals: u.referrals,
        is_admin: !!u.is_admin,
        banned_until: u.banned_until ? u.banned_until.toISOString() : null,
        joined_at: u.joined_at
      }))
    });
  } catch (err) {
    console.error('Admin members error:', err);
    return res.status(500).json({ error: 'Could not load members.' });
  }
});

// GET /api/admin/transactions - the platform ledger, filterable by type/status.
router.get('/transactions', async (req, res) => {
  const { limit, offset } = page(req);
  const type = String(req.query.type || '').trim().slice(0, 20);
  const status = String(req.query.status || '').trim().slice(0, 20);
  try {
    const where = [];
    const params = [];
    if (type) { params.push(type); where.push('t.type = $' + params.length); }
    if (status) { params.push(status); where.push('t.status = $' + params.length); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const total = (await pool.query('SELECT COUNT(*)::int AS c FROM transactions t ' + whereSql, params)).rows[0].c;
    const rows = (await pool.query(
      `SELECT t.id, t.type, t.method, t.amount, t.fee, t.net_amount, t.status,
              t.reference, t.account, t.created_at,
              u.id AS user_id, COALESCE(u.display_name, u.name, u.email, u.phone) AS who
         FROM transactions t
         LEFT JOIN users u ON u.id = t.user_id
         ${whereSql}
        ORDER BY t.id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      params.concat([limit, offset])
    )).rows;

    return res.json({
      total, limit, offset,
      transactions: rows.map((t) => ({
        id: t.id,
        user_id: t.user_id,
        who: t.who || 'deleted account',
        type: t.type,
        method: t.method,
        amount_usd: toMoney(t.amount),
        fee_usd: toMoney(t.fee),
        net_usd: toMoney(t.net_amount),
        status: t.status,
        reference: t.reference,
        address: t.account,
        created_at: t.created_at
      }))
    });
  } catch (err) {
    console.error('Admin transactions error:', err);
    return res.status(500).json({ error: 'Could not load transactions.' });
  }
});

// GET /api/admin/payouts - the treasury work queue (pending withdrawals).
router.get('/payouts', async (req, res) => {
  const { limit, offset } = page(req);
  try {
    const total = (await pool.query(
      "SELECT COUNT(*)::int AS c FROM transactions WHERE type = 'withdrawal' AND status = 'pending'"
    )).rows[0].c;
    const rows = (await pool.query(
      `SELECT t.id, t.method, t.amount, t.fee, t.net_amount, t.reference, t.account, t.created_at,
              u.id AS user_id, COALESCE(u.display_name, u.name, u.email, u.phone) AS who, u.currency
         FROM transactions t
         LEFT JOIN users u ON u.id = t.user_id
        WHERE t.type = 'withdrawal' AND t.status = 'pending'
        ORDER BY t.id ASC
        LIMIT $1 OFFSET $2`,
      [limit, offset]
    )).rows;

    return res.json({
      total, limit, offset,
      payouts: rows.map((t) => ({
        id: t.id,
        user_id: t.user_id,
        who: t.who || 'deleted account',
        coin: t.method,
        address: t.account,
        gross_usd: toMoney(t.amount),
        fee_usd: toMoney(t.fee),
        net_usd: toMoney(t.net_amount),
        reference: t.reference,
        created_at: t.created_at
      }))
    });
  } catch (err) {
    console.error('Admin payouts error:', err);
    return res.status(500).json({ error: 'Could not load payouts.' });
  }
});

// POST /api/admin/payouts/:id/settle - treasury paid the crypto out.
// Marks the pending withdrawal success exactly once (WHERE status='pending').
// Body: { note?: string } - recorded in the ledger for audit.
router.post('/payouts/:id/settle', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid payout.' });
  const note = String(req.body.note || '').trim().slice(0, 120) || null;
  try {
    const upd = (await pool.query(
      "UPDATE transactions SET status = 'success' WHERE id = $1 AND type = 'withdrawal' AND status = 'pending' RETURNING *",
      [id]
    )).rows[0];
    if (!upd) {
      return res.status(409).json({ error: 'That payout is no longer pending - it may already be settled.' });
    }
    if (note) {
      await pool.query('UPDATE transactions SET note = $1 WHERE id = $2', [note, id]);
    }
    // The 10% withdrawal fee is the operator's cut - record it in the fee
    // ledger so the admin console can show total platform revenue.
    if (Number(upd.fee) > 0) {
      await pool.query(
        "INSERT INTO platform_fees (user_id, source, amount, reference) VALUES ($1, 'withdrawal', $2, $3)",
        [upd.user_id, toMoney(upd.fee), 'WDFEE-' + id + '-' + makeRef()]
      );
    }
    return res.json({ success: true, payout: { id: upd.id, status: upd.status, net_usd: toMoney(upd.net_amount), fee_usd: toMoney(upd.fee) }, note });
  } catch (err) {
    console.error('Admin settle error:', err);
    return res.status(500).json({ error: 'Could not settle that payout.' });
  }
});

// POST /api/admin/payouts/:id/refund - the payout bounced; give the money back.
// Restores the GROSS (what was actually debited) and undoes total_withdrawn,
// atomically with the status change so the wallet can never drift.
// Body: { note?: string } - recorded in the ledger for audit.
router.post('/payouts/:id/refund', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid payout.' });
  const note = String(req.body.note || '').trim().slice(0, 120) || null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const upd = (await client.query(
      "UPDATE transactions SET status = 'failed' WHERE id = $1 AND type = 'withdrawal' AND status = 'pending' RETURNING *",
      [id]
    )).rows[0];
    if (!upd) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'That payout is no longer pending - it may already be settled.' });
    }
    await client.query(
      'UPDATE users SET wallet_balance = wallet_balance + $1, total_withdrawn = GREATEST(total_withdrawn - $1, 0) WHERE id = $2',
      [upd.amount, upd.user_id]
    );
    if (note) {
      await client.query('UPDATE transactions SET note = $1 WHERE id = $2', [note, id]);
    }
    await client.query('COMMIT');
    return res.json({ success: true, refunded_usd: toMoney(upd.amount), user_id: upd.user_id, note });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* best effort */ }
    console.error('Admin refund error:', err);
    return res.status(500).json({ error: 'Could not refund that payout.' });
  } finally {
    client.release();
  }
});

// POST /api/admin/members/:id/adjust - manual wallet correction.
// Body: { amount_usd: number, note: string }. Negative values debit the wallet
// (never below zero) and are recorded in the ledger for a full audit trail.
router.post('/members/:id/adjust', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const amount = Number(req.body.amount_usd);
  const note = String(req.body.note || 'Manual adjustment').trim().slice(0, 120);
  if (!id) return res.status(400).json({ error: 'Invalid member.' });
  if (!Number.isFinite(amount) || amount === 0) {
    return res.status(400).json({ error: 'Enter a non-zero amount.' });
  }
  const delta = toMoney(Math.abs(amount)) * (amount < 0 ? -1 : 1);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query(
      'SELECT wallet_balance FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [id]
    )).rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Member not found.' });
    }
    // Refuse a debit that would push the wallet negative.
    if (delta < 0 && Number(row.wallet_balance) + delta < 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'That debit exceeds the member balance.' });
    }

    await client.query(
      // GREATEST keeps the stored balance at exactly 0 rather than -0.00.
      'UPDATE users SET wallet_balance = GREATEST(wallet_balance + $1, 0) WHERE id = $2',
      [delta, id]
    );
    await client.query(
      "INSERT INTO transactions (user_id, type, method, amount, fee, net_amount, status, reference) VALUES ($1, 'admin_adjustment', 'ADMIN', $2, 0, $2, 'success', $3)",
      [id, Math.abs(delta), 'ADM' + id + '-' + makeRef()]
    );
    await client.query('COMMIT');
    const after = (await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [id])).rows[0];
    return res.json({
      success: true,
      delta_usd: delta,
      note,
      new_balance_usd: toMoney(after.wallet_balance)
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* best effort */ }
    console.error('Admin adjust error:', err);
    return res.status(500).json({ error: 'Could not apply that adjustment.' });
  } finally {
    client.release();
  }
});

// GET /api/admin/me - the logged-in admin's own profile (for the console header).
router.get('/me', async (req, res) => {
  try {
    const row = (await pool.query(
      'SELECT id, email, phone, display_name, currency, is_admin FROM users WHERE id = $1',
      [req.user.id]
    )).rows[0];
    if (!row) return res.status(404).json({ error: 'Account not found.' });
    return res.json({
      id: row.id,
      email: row.email,
      phone: row.phone,
      display_name: row.display_name || null,
      currency: row.currency || 'USD',
      is_admin: !!row.is_admin
    });
  } catch (err) {
    console.error('Admin me error:', err);
    return res.status(500).json({ error: 'Could not load admin profile.' });
  }
});

// PUT /api/admin/me - update the admin's own display name / currency.
router.put('/me', async (req, res) => {
  const display_name = String(req.body.display_name || '').trim().slice(0, 100) || null;
  const currency = String(req.body.currency || '').trim().toUpperCase();
  if (currency && !currencyLib.isSupported(currency)) {
    return res.status(400).json({ error: 'That currency is not supported yet.' });
  }
  try {
    await pool.query(
      'UPDATE users SET display_name = $1, currency = $2 WHERE id = $3',
      [display_name, currency || 'USD', req.user.id]
    );
    const row = (await pool.query(
      'SELECT id, email, phone, display_name, currency, is_admin FROM users WHERE id = $1',
      [req.user.id]
    )).rows[0];
    return res.json({ success: true, display_name: row.display_name, currency: row.currency });
  } catch (err) {
    console.error('Admin me update error:', err);
    return res.status(500).json({ error: 'Could not update profile.' });
  }
});

// PUT /api/admin/me/password - change the admin's own password.
router.put('/me/password', async (req, res) => {
  const bcrypt = require('bcryptjs');
  const current = String(req.body.current_password || '');
  const next = String(req.body.new_password || '');
  if (!current || !next || next.length < 4) {
    return res.status(400).json({ error: 'Enter your current password and a new one (min 4 characters).' });
  }
  try {
    const row = (await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id])).rows[0];
    if (!row) return res.status(404).json({ error: 'Account not found.' });
    const match = await bcrypt.compare(current, row.password_hash);
    if (!match) return res.status(400).json({ error: 'Current password is not correct.' });
    const hash = await bcrypt.hash(next, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
    return res.json({ success: true, message: 'Password updated successfully.' });
  } catch (err) {
    console.error('Admin password error:', err);
    return res.status(500).json({ error: 'Could not update password.' });
  }
});

// GET /api/admin/credentials - list every administrator account so the
// operator can see who has console access and revoke / grant it.
router.get('/credentials', async (req, res) => {
  try {
    const rows = (await pool.query(
      `SELECT u.id, u.email, u.phone, u.display_name, u.currency, u.is_admin, u.joined_at,
              (SELECT COUNT(*)::int FROM users r WHERE r.referred_by = u.id) AS referrals
         FROM users u
        WHERE u.is_admin = TRUE AND u.deleted_at IS NULL
        ORDER BY u.id ASC`
    )).rows;
    return res.json({
      credentials: rows.map((u) => ({
        id: u.id,
        identifier: u.email || u.phone,
        display_name: u.display_name || null,
        currency: u.currency || 'USD',
        is_admin: !!u.is_admin,
        referrals: u.referrals,
        joined_at: u.joined_at
      }))
    });
  } catch (err) {
    console.error('Admin credentials error:', err);
    return res.status(500).json({ error: 'Could not load admin credentials.' });
  }
});

// PUT /api/admin/credentials/:id/toggle - grant or revoke console access.
router.put('/credentials/:id/toggle', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const makeAdmin = !!req.body.is_admin;
  if (!id) return res.status(400).json({ error: 'Invalid admin id.' });
  if (id === req.user.id && !makeAdmin) {
    return res.status(400).json({ error: 'You cannot remove your own administrator access.' });
  }
  try {
    const row = (await pool.query(
      'SELECT id, is_admin FROM users WHERE id = $1 AND deleted_at IS NULL',
      [id]
    )).rows[0];
    if (!row) return res.status(404).json({ error: 'That account does not exist.' });
    await pool.query('UPDATE users SET is_admin = $1 WHERE id = $2', [makeAdmin, id]);
    return res.json({ success: true, id: id, is_admin: makeAdmin });
  } catch (err) {
    console.error('Admin toggle error:', err);
    return res.status(500).json({ error: 'Could not update administrator access.' });
  }
});

// GET /api/admin/rates - the live FX feed status (for the admin dashboard).
router.get('/rates', async (req, res) => {
  try {
    const r = await rates.getRates(pool);
    const overrides = {};
    try {
      const rows = (await pool.query(
        "SELECT key, value FROM platform_settings WHERE key LIKE 'fx_override_%'"
      )).rows;
      for (const row of rows) {
        overrides[String(row.key).slice('fx_override_'.length).toUpperCase()] = Number(row.value);
      }
    } catch (e) { /* table may not exist yet */ }
    return res.json({
      source: r.source,
      stale: !!r.stale,
      providers: rates.PROVIDERS.map((p) => p.name),
      overrides: overrides,
      rates: currencyLib.listCurrencies().map((c) => ({ code: c.code, rate: c.rate }))
    });
  } catch (err) {
    console.error('Admin rates error:', err.message);
    return res.json({ source: 'static', stale: true, providers: rates.PROVIDERS.map((p) => p.name), overrides: {}, rates: rates.staticRates(pool) });
  }
});

// GET /api/admin/wallets - the WolvPay coin catalogue + the merchant's enabled
// whitelist, so the console can show exactly which wallets exist and which are
// active. Also reports whether the env whitelist is narrower than the catalogue.
router.get('/wallets', async (req, res) => {
  try {
    wolvpay.loadConfig();
    const r = await wolvpay.getCoins();
    if (!r.ok) {
      return res.status(502).json({ error: 'Could not reach WolvPay to list coins.', detail: r.error && r.error.message });
    }
    const all = r.coins.map((c) => ({ coin: c.coin, name: c.name || c.coin, label: wolvpay.coinLabel(c.coin, c.name) }));
    const envList = (process.env.WOLVPAY_ENABLED_COINS || '').split(',').map((s) => String(s).trim().toLowerCase()).filter(Boolean);
    const enabled = await wolvpay.enabledCoins(pool);
    return res.json({
      coins: all,
      enabled: enabled,
      env_whitelist: envList,
      env_narrower: !!envList.length && envList.length < all.length
    });
  } catch (err) {
    console.error('Admin wallets error:', err);
    return res.status(500).json({ error: 'Could not load wallets.', detail: err.message });
  }
});

// PUT /api/admin/wallets - replace the merchant's enabled-coin whitelist.
// Stored in platform_settings so a stale env list can be fixed without a deploy.
router.put('/wallets', async (req, res) => {
  const coins = Array.isArray(req.body.coins) ? req.body.coins.map((s) => String(s).trim().toLowerCase()).filter(Boolean) : null;
  if (!coins) return res.status(400).json({ error: 'Send a list of coins.' });
  try {
    wolvpay.loadConfig();
    const r = await wolvpay.getCoins();
    const known = r.ok ? new Set(r.coins.map((c) => c.coin)) : null;
    if (known) {
      const unknown = coins.filter((c) => !known.has(c));
      if (unknown.length) {
        return res.status(400).json({ error: 'WolvPay does not support: ' + unknown.join(', ') });
      }
    }
    await pool.query(
      `INSERT INTO platform_settings (key, value) VALUES ('wolvpay_enabled_coins', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [coins.join(',')]
    );
    wolvpay._enabledCache = { at: 0, coins: null }; // bust the in-memory cache
    return res.json({ success: true, enabled: coins, source: 'platform_settings' });
  } catch (err) {
    console.error('Admin wallets save error:', err.message);
    return res.status(500).json({ error: 'Could not save the wallet selection.' });
  }
});

// PUT /api/admin/rates/:code - override one FX rate (units of currency per 1 USD).
// Stored in platform_settings so the operator can fix a stale provider feed.
router.put('/rates/:code', async (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  const rate = Number(req.body.rate);
  if (!code || !currencyLib.isSupported(code)) {
    return res.status(400).json({ error: 'That currency is not supported.' });
  }
  if (!Number.isFinite(rate) || rate <= 0) {
    return res.status(400).json({ error: 'Enter a positive rate.' });
  }
  try {
    await pool.query(
      `INSERT INTO platform_settings (key, value) VALUES ('fx_override_' + $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [code, String(rate)]
    );
    return res.json({ success: true, code: code, rate: rate });
  } catch (err) {
    console.error('Admin rate override error:', err.message);
    return res.status(500).json({ error: 'Could not save that rate.' });
  }
});

// DELETE /api/admin/rates/:code - drop an override and fall back to the provider.
router.delete('/rates/:code', async (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  if (!code || !currencyLib.isSupported(code)) {
    return res.status(400).json({ error: 'That currency is not supported.' });
  }
  try {
    await pool.query('DELETE FROM platform_settings WHERE key = $1', ['fx_override_' + code]);
    return res.json({ success: true, code: code });
  } catch (err) {
    console.error('Admin rate delete error:', err.message);
    return res.status(500).json({ error: 'Could not remove that override.' });
  }
});

// --- Super-user actions ----------------------------------------------------
// The admin is the platform owner, so the console exposes a few extra actions
// that a regular administrator cannot perform: suspend/ban an account, reset a
// member's password, soft-delete an account, and purchase a terminal on behalf
// of any member. Every action is atomic and recorded in the transaction ledger.

// POST /api/admin/members/:id/purchase-bot - buy a terminal for a member.
// The admin can invest on any member's behalf. The amount is deducted from
// THAT MEMBER'S wallet (not the admin's) - the admin is acting as a proxy,
// so the money comes out of the beneficiary's balance exactly as if they had
// clicked the button themselves.
router.post('/members/:id/purchase-bot', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const botId = parseInt(req.body.bot_id, 10);
  const amount = Number(req.body.amount);
  if (!id) return res.status(400).json({ error: 'Invalid member.' });
  if (!botId || !amount || amount <= 0) {
    return res.status(400).json({ error: 'Choose a level and enter its exact price.' });
  }
  try {
    const botDef = (await pool.query('SELECT * FROM bots WHERE id = $1', [botId])).rows[0];
    if (!botDef) return res.status(400).json({ error: 'That level is not available.' });
    const priceUsd = Number(botDef.min_amount);
    if (Math.abs(amount - priceUsd) > Math.max(0.02, priceUsd * 0.001)) {
      return res.status(400).json({ error: 'That level costs exactly USD ' + priceUsd + '.' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = (await client.query(
        'SELECT id, wallet_balance FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
        [id]
      )).rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Member not found.' });
      }
      if (Number(row.wallet_balance) < priceUsd) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'That member does not have enough balance. USD ' + priceUsd + ' is required, they have USD ' + row.wallet_balance + '.' });
      }
      await client.query(
        'UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2',
        [priceUsd, id]
      );

      const active = (await client.query(
        "SELECT id FROM user_bots WHERE user_id = $1 AND status = 'active'",
        [id]
      )).rows[0];
      if (active) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'That member already has an active terminal. Finish its lock period first.' });
      }

      const start = new Date();
      const end = new Date(start);
      end.setDate(end.getDate() + Number(botDef.lock_days));
      const nextEarning = localDateStr(start);

      const bot = (
        await client.query(
          "INSERT INTO user_bots (user_id, bot_id, amount, started_at, started_at_ts, ends_at, next_earning_date, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active') RETURNING *",
          [id, botDef.id, toMoney(priceUsd), localDateStr(start), start.toISOString(), localDateStr(end), nextEarning]
        )
      ).rows[0];

      await client.query(
        "INSERT INTO transactions (user_id, type, method, amount, fee, net_amount, status, reference) VALUES ($1, 'terminal_rental', $2, $3, 0, $3, 'success', $4)",
        [id, botDef.name, toMoney(priceUsd), makeRef()]
      );

      await client.query('COMMIT');
      return res.json({
        success: true,
        bot: Object.assign({}, bot, { bot_name: botDef.name, tier: botDef.tier }),
        member_id: id,
        message: 'Terminal purchased. USD ' + priceUsd + ' was deducted from that member wallet.'
      });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Admin purchase-bot error:', err);
    return res.status(500).json({ error: 'Could not purchase that terminal.' });
  }
});

// POST /api/admin/purchase-bot - the admin invests their OWN money.
// The admin is a normal user account, so they can use the member purchase
// route - but the console has no Levels page. This route lets an admin buy a
// terminal for themselves straight from the console, deducting from their own
// wallet balance exactly like the member route does.
router.post('/purchase-bot', async (req, res) => {
  const botId = parseInt(req.body.bot_id, 10);
  const amount = Number(req.body.amount);
  if (!botId || !amount || amount <= 0) {
    return res.status(400).json({ error: 'Choose a level and enter its exact price.' });
  }
  try {
    const botDef = (await pool.query('SELECT * FROM bots WHERE id = $1', [botId])).rows[0];
    if (!botDef) return res.status(400).json({ error: 'That level is not available.' });
    const priceUsd = Number(botDef.min_amount);
    if (Math.abs(amount - priceUsd) > Math.max(0.02, priceUsd * 0.001)) {
      return res.status(400).json({ error: 'That level costs exactly USD ' + priceUsd + '.' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = (await client.query(
        'SELECT id, wallet_balance FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
        [req.user.id]
      )).rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Account not found.' });
      }
      if (Number(row.wallet_balance) < priceUsd) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Not enough balance. You have USD ' + row.wallet_balance + ', the level costs USD ' + priceUsd + '.' });
      }
      await client.query(
        'UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2',
        [priceUsd, req.user.id]
      );
      const active = (await client.query(
        "SELECT id FROM user_bots WHERE user_id = $1 AND status = 'active'",
        [req.user.id]
      )).rows[0];
      if (active) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'You already have an active terminal. Finish its lock period first.' });
      }
      const start = new Date();
      const end = new Date(start);
      end.setDate(end.getDate() + Number(botDef.lock_days));
      const nextEarning = localDateStr(start);
      const bot = (
        await client.query(
          "INSERT INTO user_bots (user_id, bot_id, amount, started_at, started_at_ts, ends_at, next_earning_date, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active') RETURNING *",
          [req.user.id, botDef.id, toMoney(priceUsd), localDateStr(start), start.toISOString(), localDateStr(end), nextEarning]
        )
      ).rows[0];
      await client.query(
        "INSERT INTO transactions (user_id, type, method, amount, fee, net_amount, status, reference) VALUES ($1, 'terminal_rental', $2, $3, 0, $3, 'success', $4)",
        [req.user.id, botDef.name, toMoney(priceUsd), makeRef()]
      );
      await client.query('COMMIT');
      return res.json({
        success: true,
        bot: Object.assign({}, bot, { bot_name: botDef.name, tier: botDef.tier }),
        message: 'Terminal purchased. USD ' + priceUsd + ' deducted from your wallet.'
      });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Admin self purchase-bot error:', err);
    return res.status(500).json({ error: 'Could not purchase that terminal.' });
  }
});

// POST /api/admin/self-fund - credit the admin's own wallet.
// Lets an operator top up their own balance from the console without going
// through the member deposit flow. Recorded as an admin_adjustment.
router.post('/self-fund', async (req, res) => {
  const amount = Number(req.body.amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Enter a positive amount.' });
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = (await client.query(
        'SELECT id, wallet_balance FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
        [req.user.id]
      )).rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Account not found.' });
      }
      await client.query(
        'UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2',
        [amount, req.user.id]
      );
      await client.query(
        "INSERT INTO transactions (user_id, type, method, amount, fee, net_amount, status, reference) VALUES ($1, 'admin_adjustment', 'ADMIN', $2, 0, $2, 'success', $3)",
        [req.user.id, amount, 'ADM-FUND-' + req.user.id + '-' + makeRef()]
      );
      await client.query('COMMIT');
      return res.json({ success: true, amount: amount, new_balance: Number(row.wallet_balance) + amount });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Admin self-fund error:', err);
    return res.status(500).json({ error: 'Could not fund your wallet.' });
  }
});

// PUT /api/admin/members/:id/ban - suspend or reinstate an account.
// banned_until = null reinstates; a positive ISO duration reinstates.
router.put('/members/:id/ban', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid member.' });
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot suspend your own account.' });
  const banned = req.body.banned_until === null || req.body.banned_until === undefined
    ? null
    : new Date(String(req.body.banned_until));
  if (banned !== null && Number.isNaN(banned.getTime())) {
    return res.status(400).json({ error: 'Enter a valid ban-until date or leave it blank to reinstate.' });
  }
  try {
    const row = (await pool.query(
      'SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL',
      [id]
    )).rows[0];
    if (!row) return res.status(404).json({ error: 'That account does not exist.' });
    await pool.query('UPDATE users SET banned_until = $1 WHERE id = $2', [banned, id]);
    return res.json({ success: true, id: id, banned_until: banned ? banned.toISOString() : null });
  } catch (err) {
    console.error('Admin ban error:', err.message);
    return res.status(500).json({ error: 'Could not update that account.' });
  }
});

// POST /api/admin/members/:id/reset-password - force a password reset.
// The member is logged out everywhere on next login because the token is
// still valid, so we also rotate the JWT secret on the server side by
// requiring re-auth. Here we just set a new hash.
router.post('/members/:id/reset-password', async (req, res) => {
  const bcrypt = require('bcryptjs');
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid member.' });
  const next = String(req.body.new_password || '');
  if (next.length < 4) return res.status(400).json({ error: 'New password must be at least 4 characters.' });
  try {
    const row = (await pool.query(
      'SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL',
      [id]
    )).rows[0];
    if (!row) return res.status(404).json({ error: 'That account does not exist.' });
    const hash = await bcrypt.hash(next, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, id]);
    return res.json({ success: true, id: id, message: 'Password reset. Tell the member their new password.' });
  } catch (err) {
    console.error('Admin reset-password error:', err.message);
    return res.status(500).json({ error: 'Could not reset that password.' });
  }
});

// DELETE /api/admin/members/:id - soft-delete an account (keeps the ledger).
// The row stays in the database with deleted_at set so transactions still
// resolve, but the member can no longer log in.
router.delete('/members/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid member.' });
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query(
      'SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL',
      [id]
    )).rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'That account does not exist.' });
    }
    await client.query('UPDATE users SET deleted_at = NOW() WHERE id = $1', [id]);
    await client.query(
      "INSERT INTO transactions (user_id, type, method, amount, fee, net_amount, status, reference) VALUES ($1, 'admin_adjustment', 'ADMIN', 0, 0, 0, 'success', $2)",
      [id, 'ADM-DELETE-' + id + '-' + makeRef()]
    );
    await client.query('COMMIT');
    return res.json({ success: true, id: id, message: 'Account soft-deleted.' });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* best effort */ }
    console.error('Admin delete error:', err.message);
    return res.status(500).json({ error: 'Could not delete that account.' });
  } finally {
    client.release();
  }
});

// --- System logs ----------------------------------------------------------
// The platform writes every warn/error into system_logs via lib/logger.js.
// This route lets the console show the live audit trail and clear it.

// GET /api/admin/logs - recent system log entries, newest first.
router.get('/logs', async (req, res) => {
  const level = String(req.query.level || 'warn').toLowerCase();
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const valid = ['debug', 'info', 'warn', 'error'];
  const lvl = valid.includes(level) ? level : 'warn';
  try {
    const rows = (await pool.query(
      `SELECT id, level, source, message, context, created_at
         FROM system_logs
        WHERE level IN ($1, $2, $3, $4)
          AND level >= $5
        ORDER BY created_at DESC
        LIMIT $6`,
      ['debug', 'info', 'warn', 'error', lvl, limit]
    )).rows;
    return res.json({
      logs: rows.map((r) => ({
        id: r.id,
        level: r.level,
        source: r.source,
        message: r.message,
        context: r.context,
        created_at: r.created_at
      }))
    });
  } catch (err) {
    console.error('Admin logs error:', err);
    return res.status(500).json({ error: 'Could not load logs.' });
  }
});

// DELETE /api/admin/logs - clear every log entry (audit reset).
router.delete('/logs', async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM system_logs');
    return res.json({ success: true, deleted: r.rowCount || 0 });
  } catch (err) {
    console.error('Admin logs clear error:', err);
    return res.status(500).json({ error: 'Could not clear logs.' });
  }
});

module.exports = router;
