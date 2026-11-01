// Shared helpers for processing daily level earnings, dates, phone validation,
// referral codes and the withdrawal fee.
'use strict';

const { pool } = require('./db');

function toMoney(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

function localDateStr(d) {
  const x = d ? new Date(d) : new Date();
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const day = String(x.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function addDaysStr(str, n) {
  const d = new Date(String(str).slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromStr, toStr) {
  const a = new Date(String(fromStr).slice(0, 10) + 'T00:00:00Z').getTime();
  const b = new Date(String(toStr).slice(0, 10) + 'T00:00:00Z').getTime();
  return Math.round((b - a) / 86400000);
}


function toDateStr(v) {
  if (v instanceof Date) return localDateStr(v);
  return String(v == null ? '' : v).slice(0, 10);
}

// Validate an email address format.
function isValidEmail(v) {
  if (v == null) return false;
  var email = String(v).trim().toLowerCase();
  if (!email) return false;
  // Exactly one '@' is required - "user@@domain.com" and "user@x@y.com" are invalid.
  if (email.split('@').length !== 2) return false;
  var atIndex = email.indexOf('@');
  if (atIndex <= 0 || atIndex === email.length - 1) return false;
  var local = email.slice(0, atIndex);
  var domain = email.slice(atIndex + 1);
  if (email.length > 254) return false;
  if (local.length < 1 || local.length > 64) return false;
  if (local.indexOf(' ') !== -1) return false;
  if (local.startsWith('.') || local.endsWith('.')) return false;
  if (local.includes('..')) return false;
  if (domain.length < 3 || domain.length > 255) return false;
  if (domain.indexOf(' ') !== -1) return false;
  if (domain.startsWith('.') || domain.endsWith('.')) return false;
  if (domain.includes('..')) return false;
  if (domain.startsWith('-') || domain.endsWith('-')) return false;
  var tld = domain.split('.').pop();
  if (!/^[a-z]{2,}$/.test(tld)) return false;
  if (domain.split('.').length < 2) return false;
  return true;
}

// Validate an international phone number.
function isValidPhone(v) {
  return /^\+\d{8,15}$/.test(String(v || ''));
}

// Normalize a phone number.
function normalizePhone(value) {
  if (value == null) return '';
  var cleaned = String(value).replace(/[\s\-()]/g, '');
  if (!cleaned) return '';
  if (cleaned.startsWith('00')) cleaned = '+' + cleaned.slice(2);
  if (cleaned.startsWith('+')) return cleaned;
  return '+' + cleaned;
}

// Build a random referral code.
function makeReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// Generate a transaction reference.
function makeRef() {
  return 'ACM' + Date.now() + Math.random().toString(36).slice(2, 7).toUpperCase();
}

// Withdrawal fee.
const WITHDRAW_FEE_PERCENT = Math.max(0, parseFloat(process.env.WITHDRAW_FEE_PERCENT || '10'));

function computeWithdrawFee(grossAmount) {
  const gross = toMoney(grossAmount);
  const fee = toMoney(gross * (WITHDRAW_FEE_PERCENT / 100));
  const net = toMoney(gross - fee);
  return { percent: WITHDRAW_FEE_PERCENT, gross: gross, fee: fee, net: net };
}

// Process any bot daily earnings that came due.
// A user's bot earns its daily_percent of the invested amount every day
// while the lock period is still running and the bot is active.
// Once the lock period matures, all accrued earnings are released into the
// wallet and an 'earnings' transaction is recorded in the history.
async function processDailyEarnings(userId) {
  try {
    const todayStr = localDateStr();

    const res = await pool.query(
      `SELECT * FROM user_bots
       WHERE user_id = $1 AND status = 'active'
       ORDER BY id DESC`,
      [userId]
    );

    for (const bot of res.rows) {
      const nextStr = toDateStr(bot.next_earning_date);
      if (!nextStr) continue;

      // Days that have already come due (0 = today). Skip if not due yet.
      const due = daysBetween(nextStr, todayStr);
      if (due < 0) continue;

      const botDef = (await pool.query('SELECT * FROM bots WHERE id = $1', [bot.bot_id])).rows[0];
      if (!botDef) continue;

      const endStr = toDateStr(bot.ends_at);
      const matured = daysBetween(endStr, todayStr) >= 0; // lock period has ended

      // Credit only up to the lock period's end once matured, capped for safety.
      let daysToCredit = due + 1;
      if (matured) {
        const lockRemaining = daysBetween(nextStr, endStr) + 1;
        if (lockRemaining < daysToCredit) daysToCredit = lockRemaining;
      }
      daysToCredit = Math.max(1, Math.min(daysToCredit, 90));

      const daily = toMoney(Number(bot.amount) * (Number(botDef.daily_percent) / 100));
      const total = toMoney(daily * daysToCredit);
      const nextString = matured ? addDaysStr(endStr, 1) : addDaysStr(todayStr, 1);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Lock the user row and read the current accrual state.
        const userRow = (
          await client.query(
            'SELECT bot_income, pending_earnings, wallet_balance FROM users WHERE id = $1 FOR UPDATE',
            [userId]
          )
        ).rows[0];
        if (!userRow) {
          await client.query('ROLLBACK');
          continue;
        }

        // Earnings accrue to bot_income and stay locked in pending_earnings.
        const newPending = toMoney(Number(userRow.pending_earnings) + total);
        const newBotIncome = toMoney(Number(userRow.bot_income) + total);

        let releaseAmount = 0;
        if (matured) {
          // Once the lock period has matured, release everything accrued
          // into the wallet and mark the bot completed.
          releaseAmount = newPending;
          await client.query(
            'UPDATE users SET bot_income = $1, pending_earnings = 0, wallet_balance = wallet_balance + $2 WHERE id = $3',
            [newBotIncome, releaseAmount, userId]
          );
          await client.query(
            "UPDATE user_bots SET status = 'completed' WHERE id = $1",
            [bot.id]
          );
        } else {
          await client.query(
            'UPDATE users SET bot_income = $1, pending_earnings = $2 WHERE id = $3',
            [newBotIncome, newPending, userId]
          );
        }

        await client.query(
          'UPDATE user_bots SET next_earning_date = $1 WHERE id = $2',
          [nextString, bot.id]
        );

        // Log the earning so "Today's income" can be shown (idempotent per day).
        await client.query(
          `INSERT INTO daily_earnings (user_id, bot_id, amount, earned_on)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, bot_id, earned_on) DO NOTHING`,
          [userId, bot.bot_id, daily, todayStr]
        );

        // Record the payout in the transaction history on release.
        if (matured && releaseAmount > 0) {
          await client.query(
            `INSERT INTO transactions (user_id, type, method, amount, fee, net_amount, status, reference)
             VALUES ($1, 'earnings', $2, $3, 0, $3, 'success', $4)`,
            [userId, String(botDef.name), releaseAmount, makeRef()]
          );
        }

        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    }
  } catch (err) {
    console.error('processDailyEarnings error:', err);
  }
}

// Record a notification for a user (fire-and-forget safe).
async function createNotification(userId, type, title, message) {
  try {
    await pool.query(
      'INSERT INTO notifications (user_id, type, title, message, read, created_at) VALUES ($1, $2, $3, $4, FALSE, NOW())',
      [userId, type, title, message]
    );
  } catch (e) {
    // Notifications must never break the request path.
    console.error('createNotification error:', e.message);
  }
}

module.exports = {
  toMoney,
  localDateStr,
  addDaysStr,
  daysBetween,
  toDateStr,
  isValidEmail,
  isValidPhone,
  normalizePhone,
  makeReferralCode,
  makeRef,
  WITHDRAW_FEE_PERCENT,
  computeWithdrawFee,
  processDailyEarnings,
  createNotification
};
