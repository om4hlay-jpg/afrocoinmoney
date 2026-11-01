// Home dashboard route.
const express = require('express');
const { pool } = require('../db');
const { authRequired } = require('../middleware/auth');
const { processDailyEarnings, localDateStr } = require('../helpers');
const wolvpay = require('../lib/wolvpay');

const router = express.Router();

router.get('/', authRequired, async (req, res) => {
  try {
    await processDailyEarnings(req.user.id);
    const user = (await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id])).rows[0];
    if (!user) return res.status(404).json({ error: 'Account not found.' });

    // Count valid referrals (referrals who have made a deposit).
    const referrals = (await pool.query('SELECT id FROM users WHERE referred_by = $1', [req.user.id])).rows;
    let validReferrals = 0;
    for (const r of referrals) {
      const d = (
        await pool.query(
          "SELECT COUNT(*)::int AS c FROM transactions WHERE user_id = $1 AND type = 'deposit' AND status = 'success'",
          [r.id]
        )
      ).rows[0];
      if (Number(d.c) > 0) validReferrals++;
    }

    const activeBot = (
      await pool.query(
        "SELECT ub.*, b.tier, b.name AS bot_name, b.daily_percent, b.lock_days FROM user_bots ub JOIN bots b ON b.id = ub.bot_id WHERE ub.user_id = $1 AND ub.status = 'active' ORDER BY ub.id DESC LIMIT 1",
        [req.user.id]
      )
    ).rows[0];

    const today = localDateStr();
    let todayBotIncome = 0;
    if (activeBot) {
      const todayEarnings = (
        await pool.query(
          'SELECT amount FROM daily_earnings WHERE user_id = $1 AND bot_id = $2 AND earned_on = $3',
          [req.user.id, activeBot.bot_id, today]
        )
      ).rows[0];
      todayBotIncome = todayEarnings ? Number(todayEarnings.amount) : 0;
    }

    // Signup bonus, claimed referral income and task rewards are "credits":
    // non-terminal money that should appear ON the earnings graph alongside
    // the projected terminal line.
    const credits = (await pool.query(
      "SELECT created_at, SUM(amount) AS amount FROM transactions WHERE user_id = $1 AND status = 'success' AND type IN ('bonus', 'referral_claim', 'task_reward') AND created_at > NOW() - INTERVAL '90 days' GROUP BY created_at ORDER BY created_at ASC",
      [req.user.id]
    )).rows;

    return res.json({
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        name: user.name,
        display_name: user.display_name || user.name || null,
        currency: user.currency || 'USD',
        referral_code: user.referral_code,
        wallet_balance: user.wallet_balance,
        total_deposited: user.total_deposited,
        total_withdrawn: user.total_withdrawn,
        bot_income: user.bot_income,
        team_income: user.team_income,
        pending_earnings: user.pending_earnings,
        referral_pending: user.referral_pending,
        today_income: todayBotIncome,
        joined_at: user.joined_at
      },
      active_bot: activeBot,
      valid_referrals: validReferrals,
      // Claim threshold for referral earnings, so the home page can show
      // progress toward it without a second request.
      referral_claim_min: wolvpay.REFERRAL_CLAIM_MIN_USD,
      // Credit history powering the "bonus & referral" series on the chart.
      bonus_credits: credits.map((c) => ({ ts: new Date(c.created_at).getTime(), amount: Number(c.amount) }))
    });
  } catch (err) {
    console.error('Home error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

module.exports = router;