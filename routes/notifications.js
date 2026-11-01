// Notifications routes: list, mark read, mark all read, and live feed.
const express = require('express');
const { pool } = require('../db');
const { authRequired } = require('../middleware/auth');
const currencyLib = require('../lib/currency');

const router = express.Router();

// Mask a name for the public feed (first initial + ***).
function maskName(name) {
  if (!name) return 'Investor';
  const parts = String(name).split(' ');
  const first = parts[0];
  if (first.length <= 3) return first + '***';
  return first.slice(0, 2) + '***' + first.slice(-1);
}

// List the member's notifications.
router.get('/', authRequired, async (req, res) => {
  try {
    const rows = (await pool.query(
      'SELECT id, type, title, message, read, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100',
      [req.user.id]
    )).rows;
    return res.json({ notifications: rows });
  } catch (err) {
    console.error('Notifications list error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

// Mark a single notification as read.
router.put('/:id/read', authRequired, async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE notifications SET read = TRUE WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Notification not found.' });
    return res.json({ success: true, id: req.params.id });
  } catch (err) {
    console.error('Mark read error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

// Mark all notifications as read.
router.put('/read-all', authRequired, async (req, res) => {
  try {
    await pool.query(
      'UPDATE notifications SET read = TRUE WHERE user_id = $1 AND read = FALSE',
      [req.user.id]
    );
    return res.json({ success: true });
  } catch (err) {
    console.error('Mark all read error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

// Get the unread count for a badge.
router.get('/unread-count', authRequired, async (req, res) => {
  try {
    const row = (await pool.query(
      'SELECT COUNT(*)::int AS c FROM notifications WHERE user_id = $1 AND read = FALSE',
      [req.user.id]
    )).rows[0];
    return res.json({ count: Number(row.c) });
  } catch (err) {
    console.error('Unread count error:', err);
    return res.json({ count: 0 });
  }
});

// Live feed: recent successful transactions across the whole platform,
// converted to the requesting user's display currency. Powers the scrolling
// ticker so members always see live activity.
router.get('/feed', authRequired, async (req, res) => {
  try {
    const userRow = (await pool.query('SELECT currency FROM users WHERE id = $1', [req.user.id])).rows[0];
    const userCurrency = (userRow && userRow.currency) || 'USD';

    const rows = (await pool.query(
      `SELECT t.type, t.method, t.amount, t.created_at,
              COALESCE(u.display_name, u.name, 'Investor') AS display_name,
              COALESCE(u.country, 'Uganda') AS country
       FROM transactions t
       JOIN users u ON u.id = t.user_id
       WHERE t.status = 'success'
         AND t.type IN ('deposit','withdrawal','earnings','referral_bonus','bonus','task_reward','terminal_rental','welcome_bonus')
       ORDER BY t.created_at DESC
       LIMIT 60`,
    )).rows;

    const feed = rows.map((r) => {
      const usd = Number(r.amount) || 0;
      const local = currencyLib.fromUsd(usd, userCurrency);
      const dp = currencyLib.ZERO_DECIMAL.has(userCurrency) ? 0 : 2;
      const formatted = local.toFixed(dp);
      return {
        name: maskName(r.display_name),
        country: r.country,
        type: r.type,
        method: r.method,
        amountUsd: usd,
        amountLocal: formatted,
        currency: userCurrency,
        ts: new Date(r.created_at).getTime()
      };
    });
    return res.json({ feed });
  } catch (err) {
    console.error('Feed error:', err);
    return res.json({ feed: [] });
  }
});

module.exports = router;
