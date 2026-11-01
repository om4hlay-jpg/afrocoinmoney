// Settings routes: update profile, change display currency and password.
const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { pool } = require('../db');
const { authRequired } = require('../middleware/auth');
const { normalizePhone } = require('../helpers');
const currencyLib = require('../lib/currency');
const names = require('../lib/names');

const router = express.Router();

// Change the display currency. Balances are stored in USD base, so switching
// is instant - every screen re-renders in the new currency.
router.put(
  '/currency',
  authRequired,
  [body('currency').trim().isLength({ min: 3, max: 8 }).withMessage('Please choose a valid currency.')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const code = String(req.body.currency || '').toUpperCase();
    if (!currencyLib.isSupported(code)) {
      return res.status(400).json({ error: 'That currency is not supported yet.' });
    }
    try {
      await pool.query('UPDATE users SET currency = $1 WHERE id = $2', [code, req.user.id]);
      return res.json({ success: true, currency: code });
    } catch (err) {
      console.error('Update currency error:', err);
      return res.status(500).json({ error: 'Something went wrong.' });
    }
  }
);

// Update the member's display name.
router.put(
  '/profile',
  authRequired,
  [body('name').trim().isLength({ max: 100 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    const name = (req.body.name || '').trim();
    try {
      await pool.query('UPDATE users SET name = $1 WHERE id = $2', [name || null, req.user.id]);
      const user = (await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id])).rows[0];
      return res.json({ success: true, name: user.name });
    } catch (err) {
      console.error('Update profile error:', err);
      return res.status(500).json({ error: 'Something went wrong.' });
    }
  }
);
// Change password. The current password must be correct.
router.put(
  '/password',
  authRequired,
  [
    body('current_password').notEmpty().withMessage('Please enter your current password.'),
    body('new_password').isLength({ min: 4, max: 100 }).withMessage('New password must be at least 4 characters.')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    try {
      const user = (await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id])).rows[0];
      const match = await bcrypt.compare(req.body.current_password, user.password_hash);
      if (!match) return res.status(400).json({ error: 'Current password is not correct.' });

      const hash = await bcrypt.hash(req.body.new_password, 10);
      await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
      return res.json({ success: true, message: 'Password updated successfully.' });
    } catch (err) {
      console.error('Change password error:', err);
      return res.status(500).json({ error: 'Something went wrong.' });
    }
  }
);

// Create a support ticket.
router.post('/tickets', authRequired, async (req, res) => {
  try {
    const { subject, message } = req.body;
    if (!subject || !message) return res.status(400).json({ error: 'Subject and message are required.' });
    const result = await pool.query(
      'INSERT INTO tickets (user_id, subject, message, status) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.user.id, subject, message, 'open']
    );
    // Record a notification for the user
    await pool.query(
      'INSERT INTO notifications (user_id, type, title, message, read, created_at) VALUES ($1, $2, $3, $4, FALSE, NOW())',
      [req.user.id, 'ticket', subject, message]
    );
    return res.json({ success: true, ticket: result.rows[0] });
  } catch (err) {
    console.error('Create ticket error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

// Get all tickets for the current user.
router.get('/tickets', authRequired, async (req, res) => {
  try {
    const tickets = await pool.query('SELECT * FROM tickets WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
    return res.json({ success: true, tickets: tickets.rows });
  } catch (err) {
    console.error('Get tickets error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

// Update ticket status (admin only - resolve/close)
router.put('/tickets/:id/status', authRequired, async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'Status is required.' });
    const result = await pool.query(
      'UPDATE tickets SET status = $1, resolved_at = NOW() WHERE id = $2 AND user_id = $3 RETURNING *',
      [status, req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Ticket not found.' });
    return res.json({ success: true, ticket: result.rows[0] });
  } catch (err) {
    console.error('Update ticket status error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

// Delete ticket (user can delete their own open tickets)
router.delete('/tickets/:id', authRequired, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM tickets WHERE id = $1 AND user_id = $2 RETURNING *', [req.params.id, req.user.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Ticket not found.' });
    return res.json({ success: true });
  } catch (err) {
    console.error('Delete ticket error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

// Delete the account. The member confirms by typing their phone or e-mail.
router.delete('/account', authRequired, [
  body('identifier').trim().notEmpty().withMessage('Please enter your phone number or e-mail to confirm.')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  const identifier = req.body.identifier.trim();
  const isEmail = identifier.includes('@');
  const norm = isEmail ? identifier.toLowerCase() : normalizePhone(identifier);

  try {
    const user = (await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id])).rows[0];
    if (!user) return res.status(404).json({ error: 'Account not found.' });

    const emailOk = user.email && norm === String(user.email).toLowerCase();
    const phoneOk = user.phone && normalizePhone(user.phone) === norm;
    if (!emailOk && !phoneOk) {
      return res.status(400).json({ error: 'The phone number or e-mail you entered does not match this account.' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE users SET referred_by = NULL WHERE referred_by = $1', [req.user.id]);
      // Free the in-app display name so a future investor can reuse it.
      if (user.display_name) names.releaseName(user.display_name);
      await client.query('DELETE FROM users WHERE id = $1', [req.user.id]);
      await client.query('COMMIT');
      return res.json({ success: true, message: 'Your account has been deleted.' });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Delete account error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

// --- Withdrawal address book ---------------------------------------------
// Members can save, update and delete the crypto addresses they withdraw to.
// Only one default per member at a time; the default is used when a member
// files a withdrawal without choosing an address.

async function listAddresses(userId) {
  const rows = (await pool.query(
    'SELECT id, coin, address, label, is_default, created_at FROM withdrawal_addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC',
    [userId]
  )).rows;
  return rows.map((r) => ({
    id: r.id,
    coin: r.coin,
    address: r.address,
    label: r.label,
    is_default: !!r.is_default,
    created_at: r.created_at
  }));
}

// GET /api/settings/addresses - the member's saved payout addresses.
router.get('/addresses', authRequired, async (req, res) => {
  try {
    return res.json({ addresses: await listAddresses(req.user.id) });
  } catch (err) {
    console.error('List addresses error:', err);
    return res.status(500).json({ error: 'Could not load addresses.' });
  }
});

// POST /api/settings/addresses - save a new payout address.
router.post('/addresses', authRequired, [
  body('coin').trim().isLength({ min: 2, max: 30 }).withMessage('Choose a cryptocurrency.'),
  body('address').trim().isLength({ min: 15, max: 120 }).withMessage('Enter a valid crypto wallet address.'),
  body('label').optional().trim().isLength({ max: 60 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  const coin = String(req.body.coin || '').trim().toLowerCase();
  const address = String(req.body.address || '').trim();
  const label = String(req.body.label || '').trim().slice(0, 60) || null;
  const makeDefault = !!req.body.is_default;

  if (!/^[A-Za-z0-9:_-]{15,120}$/.test(address)) {
    return res.status(400).json({ error: 'That does not look like a crypto wallet address.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (makeDefault) {
      await client.query('UPDATE withdrawal_addresses SET is_default = FALSE WHERE user_id = $1', [req.user.id]);
    }
    const ins = await client.query(
      'INSERT INTO withdrawal_addresses (user_id, coin, address, label, is_default) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [req.user.id, coin, address, label, makeDefault]
    );
    await client.query('COMMIT');
    return res.json({ success: true, address: ins.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') {
      return res.status(400).json({ error: 'You already saved that exact address.' });
    }
    console.error('Add address error:', e);
    return res.status(500).json({ error: 'Could not save that address.' });
  } finally {
    client.release();
  }
});

// PUT /api/settings/addresses/:id - update the label, coin or default flag.
router.put('/addresses/:id', authRequired, [
  body('coin').optional().trim().isLength({ min: 2, max: 30 }),
  body('label').optional().trim().isLength({ max: 60 }),
  body('is_default').optional().isBoolean()
], async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid address.' });
  const fields = [];
  const params = [];
  if (req.body.coin !== undefined) { params.push(String(req.body.coin).trim().toLowerCase()); fields.push('coin = $' + params.length); }
  if (req.body.label !== undefined) { params.push(String(req.body.label || '').trim().slice(0, 60) || null); fields.push('label = $' + params.length); }
  if (req.body.is_default !== undefined) { params.push(!!req.body.is_default); fields.push('is_default = $' + params.length); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (req.body.is_default) {
      await client.query('UPDATE withdrawal_addresses SET is_default = FALSE WHERE user_id = $1', [req.user.id]);
    }
    const upd = await client.query(
      'UPDATE withdrawal_addresses SET ' + fields.join(', ') + ' WHERE id = $1 AND user_id = $2 RETURNING *',
      params.concat([id, req.user.id])
    );
    if (!upd.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Address not found.' });
    }
    await client.query('COMMIT');
    return res.json({ success: true, address: upd.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Update address error:', e);
    return res.status(500).json({ error: 'Could not update that address.' });
  } finally {
    client.release();
  }
});

// DELETE /api/settings/addresses/:id - remove a saved payout address.
router.delete('/addresses/:id', authRequired, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid address.' });
  try {
    const del = await pool.query(
      'DELETE FROM withdrawal_addresses WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.user.id]
    );
    if (!del.rows.length) return res.status(404).json({ error: 'Address not found.' });
    // If the deleted row was the default, promote the most recent remaining one.
    await pool.query(
      `UPDATE withdrawal_addresses SET is_default = TRUE WHERE user_id = $1 AND id = (
         SELECT id FROM withdrawal_addresses WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1
       ) AND (SELECT COUNT(*) FROM withdrawal_addresses WHERE user_id = $1) > 0`,
      [req.user.id]
    );
    return res.json({ success: true, id: id });
  } catch (err) {
    console.error('Delete address error:', err);
    return res.status(500).json({ error: 'Could not delete that address.' });
  }
});

module.exports = router;