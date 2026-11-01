// Authentication routes: register, login, and current user info.
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { pool } = require('../db');
const { authRequired } = require('../middleware/auth');
const guard = require('../lib/authGuard');
const { isValidEmail } = require('../helpers');
const { makeReferralCode, makeRef, processDailyEarnings, isValidPhone, normalizePhone, createNotification } = require('../helpers');
const currencyLib = require('../lib/currency');
const names = require('../lib/names');
const wolvpay = require('../lib/wolvpay');

const router = express.Router();
// Welcome bonus in USD base currency, granted to every new member.
const WELCOME_BONUS = 1;

// Shared guard responses.
function tooMany(res, retryAfter) {
  const mins = Math.max(1, Math.ceil(retryAfter / 60));
  return res.status(429).json({ error: 'Too many attempts. Please try again in ' + mins + ' minute' + (mins === 1 ? '' : 's') + '.' });
}

// Proof-of-work challenge for the login form (bot prevention).
router.get('/challenge', function (req, res) {
  return res.json(guard.issueChallenge());
});

// Claim the one-time welcome signup bonus.
router.post('/welcome-bonus', authRequired, async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const user = (await client.query('SELECT welcome_bonus_claimed, wallet_balance FROM users WHERE id = $1 FOR UPDATE', [req.user.id])).rows[0];
      if (!user) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Account not found.' });
      }
      if (user.welcome_bonus_claimed) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Welcome bonus already claimed.' });
      }
      await client.query(
        'UPDATE users SET welcome_bonus_claimed = TRUE, wallet_balance = wallet_balance + $1 WHERE id = $2',
        [WELCOME_BONUS, req.user.id]
      );
      await client.query(
        `INSERT INTO transactions (user_id, type, method, amount, fee, net_amount, status, reference)
         VALUES ($1, 'welcome_bonus', 'SIGNUP', $2, 0, $2, 'success', $3)`,
        [req.user.id, WELCOME_BONUS, makeRef()]
      );
      await client.query('COMMIT');
      // Record a notification for the welcome bonus.
      await createNotification(req.user.id, 'referral_bonus', 'Welcome Bonus', 'Welcome bonus of $' + WELCOME_BONUS + ' added to your wallet.');
      return res.json({ success: true, bonus: WELCOME_BONUS, message: 'Welcome bonus of $' + WELCOME_BONUS + ' added to your wallet.' });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Welcome bonus error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

// Register with a phone number or e-mail. Referral code and display currency
// are optional (currency defaults to USD).
router.post('/register', [
  body('identifier').trim().isLength({ min: 3, max: 255 }).withMessage('Please enter a valid phone number or e-mail.'),
  body('password').isLength({ min: 4, max: 100 }).withMessage('Password must be at least 4 characters.'),
  body('referral_code').optional().trim().isLength({ max: 30 }),
  body('currency').optional().trim().isLength({ max: 8 }),
  body('country').optional().trim().isLength({ max: 60 })
], async (req, res) => {
  const ipGate = guard.ipAllowed(req.ip);
  if (!ipGate.ok) return tooMany(res, ipGate.retryAfter);

  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  const identifier = req.body.identifier.trim();
  const password = req.body.password;
  const referralCode = (req.body.referral_code || '').trim();
  const currency = req.body.currency || 'USD';
  const country = 'United States';
  const isEmail = isValidEmail(identifier);
  // Anything containing '@' must be a properly formatted e-mail; otherwise it
  // is treated as a phone number and validated as such.
  if (!isEmail && identifier.includes('@')) {
    return res.status(400).json({ error: 'Please enter a valid e-mail address.' });
  }
  const phone = isEmail ? null : normalizePhone(identifier);
  if (!isEmail && !isValidPhone(phone)) {
    return res.status(400).json({ error: 'Please enter a valid phone number (with country code) or e-mail.' });
  }
  try {
    // Validate referral code before creating the account.
    let referrer = null;
    if (referralCode) {
      referrer = (await pool.query('SELECT id FROM users WHERE referral_code = $1', [referralCode])).rows[0];
      if (!referrer) return res.status(400).json({ error: 'That referral code is not valid.' });
    }

    const existing = isEmail
      ? (await pool.query('SELECT id FROM users WHERE email = $1', [identifier])).rows[0]
      : (await pool.query('SELECT id FROM users WHERE phone = $1', [phone])).rows[0];
    if (existing) return res.status(400).json({ error: 'That phone number or e-mail is already registered.' });

    const passwordHash = await bcrypt.hash(password, 10);
    const code = makeReferralCode();
    // Assign a unique in-app display name so the user appears in feeds with
    // a fun identity even before they set a personal name.
    const displayName = names.assignName();
    // No e-mail verification step: both phone and e-mail accounts are
    // active the moment they are created, so registration always logs in.
    const isAdmin = false;

    const client = await pool.connect();
    let user;
    try {
      await client.query('BEGIN');
      const insertRes = await client.query(
        'INSERT INTO users (email, phone, password_hash, currency, country, display_name, referral_code, referred_by, is_admin) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *',
        [isEmail ? identifier : null, isEmail ? null : phone, passwordHash, currency, country, displayName, code, referrer ? referrer.id : null, isAdmin]
      );
      user = insertRes.rows[0];
      await client.query('UPDATE users SET wallet_balance = wallet_balance + $1, welcome_bonus_claimed = TRUE WHERE id = $2', [WELCOME_BONUS, user.id]);
      // Record the bonus in the member's transaction history.
      await client.query(
        "INSERT INTO transactions (user_id, type, method, amount, fee, net_amount, status, reference) VALUES ($1, 'bonus', 'SYSTEM', $2, 0, $2, 'success', $3)",
        [user.id, WELCOME_BONUS, makeRef()]
      );
      user = (await client.query('SELECT * FROM users WHERE id = $1', [user.id])).rows[0];
      // Pay the referrer their signup bonus (USD 0.01) inside the same
      // transaction, so the new account and the bonus commit together.
      await wolvpay.grantSignupReferralBonus(client, user.id);
      // Record a notification for the referral bonus.
      await createNotification(user.id, 'referral_bonus', 'Referral Bonus', 'Referral bonus of $' + WELCOME_BONUS + ' added to your wallet.');
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      // The assigned name is no longer in use if the insert failed.
      names.releaseName(displayName);
      throw e;
    } finally {
      client.release();
    }

    // No confirmation step: sign the member straight in.
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    return res.json({ token: token, user: publicUser(user) });
  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});
// Login with phone or e-mail and password.
// Protected by: per-IP rate limit, proof-of-work challenge, honeypot field,
// and a per-account lockout after repeated wrong passwords.
router.post('/login', [
  body('identifier').trim().notEmpty().withMessage('Please enter your phone number or e-mail.'),
  body('password').notEmpty().withMessage('Please enter your password.')
], async (req, res) => {
  // 1. Per-IP budget (counted before anything else).
  const ipGate = guard.ipAllowed(req.ip);
  if (!ipGate.ok) return tooMany(res, ipGate.retryAfter);

  // 2. Honeypot - hidden field real users never fill. Respond with the same
  //    message as a wrong password so bots cannot fingerprint the trap.
  if (String(req.body.website || '').length > 0) {
    return res.status(400).json({ error: 'Incorrect password. Please try again.' });
  }

  // 3. Proof-of-work - required, single-use, short-lived.
  if (!guard.verifyChallenge(req.body.challenge_id, req.body.pow)) {
    return res.status(400).json({ error: 'Security check failed. Please refresh the page and try again.' });
  }

  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  const identifier = req.body.identifier.trim();
  // Same rule as registration: '@' means e-mail, and it must be well-formed.
  const isEmail = isValidEmail(identifier);
  if (!isEmail && identifier.includes('@')) {
    return res.status(400).json({ error: 'Please enter a valid e-mail address.' });
  }
  const phone = isEmail ? null : normalizePhone(identifier);

  // 4. Per-account lockout (checked after validation, before any DB hit).
  const lock = guard.lockState(identifier);
  if (lock.locked) return tooMany(res, lock.retryAfter);

  try {
    const user = isEmail
      ? (await pool.query('SELECT * FROM users WHERE email = $1', [identifier])).rows[0]
      : (await pool.query('SELECT * FROM users WHERE phone = $1', [phone])).rows[0];
    if (!user) {
      // Count unknown accounts too - credential-stuffing bots probe them.
      guard.recordFailure(identifier);
      return res.status(400).json({ error: 'No account found with that phone number or e-mail.' });
    }

    const match = await bcrypt.compare(req.body.password, user.password_hash);
    if (!match) {
      const rec = guard.recordFailure(identifier);
      if (rec.lockUntil > Date.now()) return tooMany(res, Math.ceil((rec.lockUntil - Date.now()) / 1000));
      return res.status(400).json({ error: 'Incorrect password. Please try again.' });
    }

    guard.recordSuccess(identifier);
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    return res.json({ token: token, user: publicUser(user) });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

// Current user profile.
router.get('/me', authRequired, async (req, res) => {
  try {
    await processDailyEarnings(req.user.id);
    const user = (await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id])).rows[0];
    if (!user) return res.status(404).json({ error: 'Account not found.' });
    return res.json({ user: publicUser(user) });
  } catch (err) {
    console.error('Me error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

// Remove sensitive fields before returning a user to the client.
function publicUser(u) {
  return {
    id: u.id, email: u.email, phone: u.phone, name: u.name,
    display_name: u.display_name || u.name || null,
    currency: u.currency || 'USD',
    country: u.country || null,
    is_admin: Boolean(u.is_admin),
    referral_code: u.referral_code,
    wallet_balance: u.wallet_balance, total_deposited: u.total_deposited,
    total_withdrawn: u.total_withdrawn, bot_income: u.bot_income,
    team_income: u.team_income, pending_earnings: u.pending_earnings,
    referral_pending: u.referral_pending,
    welcome_bonus_claimed: u.welcome_bonus_claimed, joined_at: u.joined_at
  };
}

module.exports = router;
module.exports.publicUser = publicUser;