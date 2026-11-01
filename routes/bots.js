// Bots routes: list investment levels, view the active level, and purchase.
// Levels have a FIXED price (min_amount == max_amount == price in USD base).
const express = require('express');
const { pool } = require('../db');
const { authRequired } = require('../middleware/auth');
const { toMoney, processDailyEarnings, localDateStr, makeRef } = require('../helpers');
const currencyLib = require('../lib/currency');

const router = express.Router();

router.get('/', authRequired, async (req, res) => {
  try {
    const bots = (await pool.query('SELECT * FROM bots ORDER BY sort_order ASC')).rows;
    return res.json({ bots: bots });
  } catch (err) {
    console.error('List bots error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

router.get('/active', authRequired, async (req, res) => {
  try {
    await processDailyEarnings(req.user.id);
    const bot = (
      await pool.query(
        "SELECT ub.*, b.tier, b.name AS bot_name, b.daily_percent, b.lock_days FROM user_bots ub JOIN bots b ON b.id = ub.bot_id WHERE ub.user_id = $1 AND ub.status = 'active' ORDER BY ub.id DESC",
        [req.user.id]
      )
    ).rows[0];
    return res.json({ active: bot || null });
  } catch (err) {
    console.error('Active bot error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

// Purchase a level at its exact fixed price. One active level per member.
router.post('/purchase', authRequired, async (req, res) => {
  const botId = parseInt(req.body.bot_id, 10);
  const amountLocal = parseFloat(req.body.amount);
  if (!botId || !amountLocal || amountLocal <= 0) {
    return res.status(400).json({ error: 'Choose a level first.' });
  }
  try {
    await processDailyEarnings(req.user.id);
    const botDef = (await pool.query('SELECT * FROM bots WHERE id = $1', [botId])).rows[0];
    if (!botDef) return res.status(400).json({ error: 'That level is not available.' });
    const user = (await pool.query('SELECT currency FROM users WHERE id = $1', [req.user.id])).rows[0];
    if (!user) return res.status(404).json({ error: 'Account not found.' });

    const priceUsd = Number(botDef.min_amount);
    const usd = currencyLib.roundFor('USD', currencyLib.toUsd(amountLocal, user.currency));
    if (Math.abs(usd - priceUsd) > Math.max(0.02, priceUsd * 0.001)) {
      return res.status(400).json({ error: 'This level costs exactly ' + currencyLib.formatLocal(priceUsd, user.currency) + '. Enter that amount to continue.' });
    }

    const active = (await pool.query("SELECT id FROM user_bots WHERE user_id = $1 AND status = 'active'", [req.user.id])).rows[0];
    if (active) return res.status(400).json({ error: 'You already have an active level. Finish its lock period first.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = (await client.query('SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE', [req.user.id])).rows[0];
      if (!row || Number(row.wallet_balance) < priceUsd) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Not enough balance in your wallet for this level. Deposit first.' });
      }
      await client.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2', [priceUsd, req.user.id]);

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

      // 10% platform fee on every terminal rental - the operator's cut.
      const PLATFORM_FEE_RATE = 0.10;
      const feeUsd = toMoney(priceUsd * PLATFORM_FEE_RATE);

      // Record the terminal rental in the member's transaction history.
      await client.query(
        "INSERT INTO transactions (user_id, type, method, amount, fee, net_amount, status, reference) VALUES ($1, 'terminal_rental', $2, $3, $4, $5, 'success', $6)",
        [req.user.id, botDef.name, toMoney(priceUsd), feeUsd, toMoney(priceUsd - feeUsd), makeRef()]
      );

      // The 10% operator fee is kept separate from the member's ledger so the
      // admin console can show exactly what the platform has earned to date.
      await client.query(
        "INSERT INTO platform_fees (user_id, source, amount, reference) VALUES ($1, 'terminal_rental', $2, $3)",
        [req.user.id, feeUsd, makeRef()]
      );

      await client.query('COMMIT');
      return res.json({ success: true, platform_fee_usd: feeUsd, bot: Object.assign({}, bot, { bot_name: botDef.name, tier: botDef.tier }) });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Purchase bot error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

module.exports = router;