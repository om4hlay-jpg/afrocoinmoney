// Tasks routes: simple tasks to earn crypto cash on the home screen.
const express = require('express');
const { pool } = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

// Minimum time a timed task (condition = 'telegram') must run before the
// reward can be paid. Keeps the "join and come back" flow honest.
const TELEGRAM_CLAIM_AFTER_MS = 15 * 1000;

// List tasks with the logged-in member's status. Completed tasks appear last.
router.get('/', authRequired, async (req, res) => {
  try {
    const tasks = (
      await pool.query(
        `SELECT t.*, ut.completed_at AS started_at, ut.claimed
         FROM tasks t
         LEFT JOIN user_tasks ut ON ut.task_id = t.id AND ut.user_id = $1
         ORDER BY (ut.claimed IS NOT TRUE) ASC, t.sort_order ASC`,
        [req.user.id]
      )
    ).rows;

    const hasDeposit = (await pool.query(
      "SELECT COUNT(*)::int AS c FROM transactions WHERE user_id = $1 AND type = 'deposit' AND status = 'success'",
      [req.user.id]
    )).rows[0].c > 0;
    const hasBot = (await pool.query(
      'SELECT COUNT(*)::int AS c FROM user_bots WHERE user_id = $1',
      [req.user.id]
    )).rows[0].c > 0;
    const hasReferral = (await pool.query(
      'SELECT COUNT(*)::int AS c FROM users WHERE referred_by = $1',
      [req.user.id]
    )).rows[0].c > 0;

    const user = (await pool.query(
      'SELECT name, currency FROM users WHERE id = $1', [req.user.id]
    )).rows[0] || {};

    const isDone = (t) => {
      if (t.condition === 'telegram') return t.claimed === true;
      return !!t.started_at;
    };

    const tasksWithStatus = tasks.map(function (t) {
      let conditionMet = true;
      if (t.condition === 'has_deposit') conditionMet = hasDeposit;
      else if (t.condition === 'has_bot') conditionMet = hasBot;
      else if (t.condition === 'has_referral') conditionMet = hasReferral;
      else if (t.condition === 'has_username') conditionMet = !!(user.name && user.name.trim());
      else if (t.condition === 'has_currency') conditionMet = user.currency && user.currency !== 'USD';
      // Timed telegram task is claimable once the 15s dwell has elapsed.
      let claimReady = false;
      if (t.condition === 'telegram') {
        conditionMet = false;
        if (t.started_at && t.claimed !== true) {
          claimReady = Date.now() - new Date(t.started_at).getTime() >= TELEGRAM_CLAIM_AFTER_MS;
        }
      }
      const out = Object.assign({}, t, { condition_met: conditionMet, done: isDone(t) });
      delete out.claimed;
      out.completed_at = t.claimed === true ? t.started_at : null;
      delete out.claimed_name;
      out.claim_ready = claimReady;
      return out;
    });

    return res.json({ tasks: tasksWithStatus });
  } catch (err) {
    console.error('List tasks error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

// POST /tasks/:id/start - begin a timed task (telegram join).
// The member gets sent to the channel now; the reward unlocks 15s later.
router.post('/:id/start', authRequired, async (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  if (!taskId) return res.status(400).json({ error: 'Invalid task.' });
  try {
    const task = (await pool.query('SELECT * FROM tasks WHERE id = $1', [taskId])).rows[0];
    if (!task) return res.status(400).json({ error: 'That task does not exist.' });
    if (task.condition !== 'telegram') return res.status(400).json({ error: 'This task does not need to be started.' });

    const existing = (await pool.query('SELECT * FROM user_tasks WHERE user_id = $1 AND task_id = $2', [req.user.id, taskId])).rows[0];
    if (existing && existing.claimed) return res.status(400).json({ error: 'You already completed this task.' });

    let startedAt;
    if (!existing) {
      const r = await pool.query(
        'INSERT INTO user_tasks (user_id, task_id, claimed) VALUES ($1, $2, FALSE) RETURNING completed_at',
        [req.user.id, taskId]
      );
      startedAt = r.rows[0].completed_at;
    } else {
      startedAt = existing.completed_at;
    }
    return res.json({
      success: true,
      started_at: startedAt,
      claim_after_ms: TELEGRAM_CLAIM_AFTER_MS,
      telegram_url: 'https://t.me/afrocoinmoney'
    });
  } catch (err) {
    console.error('Start task error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

// Claim a task's reward. The condition is verified on the server.
router.post('/:id/claim', authRequired, async (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  if (!taskId) return res.status(400).json({ error: 'Invalid task.' });

  try {
    const task = (await pool.query('SELECT * FROM tasks WHERE id = $1', [taskId])).rows[0];
    if (!task) return res.status(400).json({ error: 'That task does not exist.' });

    const started = (
      await pool.query('SELECT * FROM user_tasks WHERE user_id = $1 AND task_id = $2', [req.user.id, taskId])
    ).rows[0];
    if (started && started.claimed) return res.status(400).json({ error: 'You already completed this task.' });

    let conditionOk = true;
    if (task.condition === 'telegram') {
      if (!started) return res.status(400).json({ error: 'Open the channel first, then claim.' });
      const dwell = Date.now() - new Date(started.completed_at).getTime();
      if (dwell < TELEGRAM_CLAIM_AFTER_MS) {
        return res.status(400).json({ error: 'Your reward unlocks a few seconds after you join.' });
      }
    } else if (task.condition === 'has_deposit') {
      const d = (
        await pool.query(
          "SELECT COUNT(*)::int AS c FROM transactions WHERE user_id = $1 AND type = 'deposit' AND status = 'success'",
          [req.user.id]
        )
      ).rows[0];
      conditionOk = Number(d.c) > 0;
    } else if (task.condition === 'has_bot') {
      const b = (await pool.query('SELECT COUNT(*)::int AS c FROM user_bots WHERE user_id = $1', [req.user.id])).rows[0];
      conditionOk = Number(b.c) > 0;
    } else if (task.condition === 'has_referral') {
      const r = (await pool.query('SELECT COUNT(*)::int AS c FROM users WHERE referred_by = $1', [req.user.id])).rows[0];
      conditionOk = Number(r.c) > 0;
    } else if (task.condition === 'has_username') {
      const u = (await pool.query('SELECT name FROM users WHERE id = $1', [req.user.id])).rows[0] || {};
      conditionOk = !!(u.name && String(u.name).trim());
    } else if (task.condition === 'has_currency') {
      const u = (await pool.query('SELECT currency FROM users WHERE id = $1', [req.user.id])).rows[0] || {};
      conditionOk = u.currency && u.currency !== 'USD';
    }

    if (!conditionOk) {
      return res.status(400).json({ error: 'You have not met the condition for this task yet.' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (task.condition === 'telegram') {
        // The row already exists from /start - it marks the dwell start.
        await client.query('UPDATE user_tasks SET claimed = TRUE WHERE user_id = $1 AND task_id = $2', [req.user.id, taskId]);
      } else {
        await client.query(
          'INSERT INTO user_tasks (user_id, task_id, claimed) VALUES ($1, $2, TRUE) ON CONFLICT (user_id, task_id) DO NOTHING',
          [req.user.id, taskId]
        );
      }
      await client.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [task.reward, req.user.id]);
      // Record the reward in the member's transaction history.
      await client.query(
        "INSERT INTO transactions (user_id, type, method, amount, fee, net_amount, status, reference) VALUES ($1, 'task_reward', 'TASK', $2, 0, $2, 'success', $3)",
        [req.user.id, task.reward, 'TSK' + taskId + '-' + Date.now()]
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    return res.json({ success: true, reward: task.reward, message: 'Reward added to your wallet.' });
  } catch (err) {
    console.error('Claim task error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

module.exports = router;
