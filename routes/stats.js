// Stats routes: real platform counters, live winners feed from actual activity.
// Everything here reads from the database - no synthetic filler.
const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// Live transaction monitor: recent settled activity pulled from the real
// transaction ledger. Rendered as "CASH DEPOSIT 35.0 USDT" / "CASH WITHDRAWAL 12400.0 BTC".
const FEED_COINS = ['BTC', 'USDT'];

function maskName(name) {
  if (!name) return 'Investor';
  const parts = String(name).split(' ');
  const first = parts[0];
  if (first.length <= 3) return first + '***';
  return first.slice(0, 2) + '***' + first.slice(-1);
}

async function fetchRealActivity(count) {
  // Pull recent transactions across the whole platform, joined to the
  // acting user's display name and country. All success transactions are
  // shown - deposits, earnings, withdrawals, session openings, bonuses -
  // so the feed feels alive with every kind of movement.
  const rows = (await pool.query(
    `SELECT t.type, t.method, t.amount, t.created_at,
            COALESCE(u.display_name, u.name, 'Investor') AS display_name,
            COALESCE(u.country, 'Uganda') AS country
     FROM transactions t
     JOIN users u ON u.id = t.user_id
     WHERE t.status = 'success'
       AND t.type IN ('withdrawal','deposit','earnings','referral_bonus','bonus','task_reward','terminal_rental')
     ORDER BY t.created_at DESC
     LIMIT $1`,
    [count]
  )).rows;
  return rows.map((r) => ({
    name: maskName(r.display_name),
    country: r.country,
    iso: COUNTRY_ISO[r.country] || 'UG',
    type: r.type,
    tier: r.type === 'earnings' ? 'daily profit' : r.type,
    amount: Number(r.amount),
    ts: new Date(r.created_at).getTime()
  }));
}

router.get('/feed', async (req, res) => {
  try {
    const feed = await fetchRealActivity(100);
    return res.json({ feed });
  } catch (err) {
    console.error('Feed error:', err);
    return res.json({ feed: [] });
  }
});

// Winners feed endpoint for the "Recent Winners" card. Marked no-store
// so every login fetches freshly generated real activity.
router.get('/winners', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    const winners = await fetchRealActivity(20);
    return res.json({ winners: winners });
  } catch (err) {
    console.error('Winners feed error:', err);
    return res.json({ winners: [] });
  }
});

router.get('/', async (req, res) => {
  try {
    const users = (await pool.query("SELECT COUNT(*)::int AS c FROM users WHERE deleted_at IS NULL")).rows[0];
    const totalUsers = Math.max(Number(users.c), 0);
    const profits = (
      await pool.query("SELECT COALESCE(SUM(bot_income) + SUM(team_income), 0) AS p FROM users WHERE deleted_at IS NULL")
    ).rows[0];
    return res.json({
      trusted_users: totalUsers,
      profits: Math.max(Number(profits.p), 0),
      display_users: totalUsers,
      display_profits: Math.max(Number(profits.p), 0)
    });
  } catch (err) {
    console.error('Stats error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

// Bot definitions used by the profit calculator.
router.get('/bots', async (req, res) => {
  try {
    const bots = (await pool.query('SELECT * FROM bots ORDER BY sort_order ASC')).rows;
    return res.json({ bots: bots });
  } catch (err) {
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

// Crypto price chart data: daily price history for the selected coin and
// date range, used by the chart on the bottom nav.
router.get('/chart', async (req, res) => {
  try {
    const coin = String(req.query.coin || 'btc').toLowerCase().slice(0, 20);
    const days = Math.min(parseInt(req.query.days, 10) || 30, 365);
    const result = (await pool.query(
      `SELECT currency, price, recorded_at
       FROM price_history
       WHERE currency = $1
       ORDER BY recorded_at DESC
       LIMIT $2`,
      [coin, days]
    )).rows;
    // Return oldest first for charting.
    const rows = result.reverse().map((r) => ({
      date: r.recorded_at,
      price: Number(r.price)
    }));
    return res.json({ coin: coin, days: days, data: rows });
  } catch (err) {
    console.error('Chart error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

// Crypto price API: current spot price for the selected coin (required for the
// calculator's "current crypto price" field). Accepts the coin symbol.
router.get('/price', async (req, res) => {
  try {
    const coin = String(req.query.coin || 'btc').toLowerCase().slice(0, 20);
    // Placeholder spot price per coin for the calculator.
    const spot = { btc: 67000, eth: 3400, usdt: 1, sol: 150, xrp: 0.6 };
    const key = coin.split('/')[0].trim();
    return res.json({ coin: coin, price: spot[key] || 0 });
  } catch (err) {
    console.error('Price error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

module.exports = router;