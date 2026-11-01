// Team routes: referral code/link, team list, and claiming referral earnings.
const express = require('express');
const { pool } = require('../db');
const { authRequired } = require('../middleware/auth');
const { toMoney } = require('../helpers');
const wolvpay = require('../lib/wolvpay');

const router = express.Router();

// Simple English rules, shared with the frontend so the copy always matches.
const RULES = {
  signup_bonus_usd: wolvpay.REFERRAL_PENDING_BONUS_USD,   // 0.01, not deposited yet
  confirmed_bonus_usd: wolvpay.REFERRAL_CONFIRMED_BONUS_USD, // 2, has deposited
  claim_min_usd: wolvpay.REFERRAL_CLAIM_MIN_USD           // 30, claim threshold
};

// GET /api/team - referral code/link, claimable balance and team summary.
router.get('/', authRequired, async (req, res) => {
  try {
    const user = (await pool.query(
      'SELECT referral_code, team_income, referral_pending FROM users WHERE id = $1',
      [req.user.id]
    )).rows[0];
    if (!user) return res.status(404).json({ error: 'Account not found.' });

    // All direct referrals, with the bonus each one has earned so far.
    const referrals = (
      await pool.query(
        `SELECT u.id, u.email, u.phone, u.joined_at, u.total_deposited,
                rb.amount AS bonus, rb.confirmed
           FROM users u
           LEFT JOIN referral_bonuses rb
             ON rb.referral_user_id = u.id AND rb.referrer_id = $1
          WHERE u.referred_by = $1
          ORDER BY u.joined_at DESC`,
        [req.user.id]
      )
    ).rows;

    let validCount = 0;
    let pendingCount = 0;
    const refined = referrals.map((r) => {
      const deposited = Number(r.total_deposited) > 0;
      if (deposited) validCount++; else pendingCount++;
      return {
        id: r.id,
        identifier: maskIdentifier(r.email || r.phone),
        joined_at: r.joined_at,
        total_deposited: Number(r.total_deposited),
        // A confirmed referral is one who has made a deposit.
        is_valid: deposited,
        // 0.01 until they deposit, 2 once they have.
        bonus: toMoney(deposited ? RULES.confirmed_bonus_usd : RULES.signup_bonus_usd)
      };
    });

    const claimable = toMoney(user.referral_pending);
    return res.json({
      team_income: toMoney(user.team_income),
      referral_code: user.referral_code,
      referral_count: refined.length,
      valid_referral_count: validCount,
      pending_referral_count: pendingCount,
      // Claimable referral money and how close it is to the threshold.
      claimable_usd: claimable,
      can_claim: claimable >= RULES.claim_min_usd,
      claim_progress: Math.min(100, Math.round((claimable / RULES.claim_min_usd) * 100)),
      rules: RULES,
      referrals: refined
    });
  } catch (err) {
    console.error('Team error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

// POST /api/team/claim - move claimable referral money into the wallet.
// Allowed only once the balance reaches the claim minimum.
router.post('/claim', authRequired, async (req, res) => {
  try {
    const result = await wolvpay.claimReferralEarnings(pool, req.user.id);
    if (result.claimed) {
      return res.json({
        success: true,
        claimed_usd: result.amount,
        message: 'Referral earnings added to your wallet.'
      });
    }
    if (result.reason === 'below_minimum') {
      return res.status(400).json({
        error: 'You need at least USD ' + toMoney(result.minimum) + ' in referral earnings before you can claim. You have USD ' + toMoney(result.pending) + '.'
      });
    }
    return res.status(404).json({ error: 'Account not found.' });
  } catch (err) {
    console.error('Claim referral error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});


// Mask a member's contact so team lists stay private.
function maskIdentifier(val) {
  if (!val) return 'Invitee';
  if (String(val).includes('@')) {
    const [name, domain] = val.split('@');
    return name.slice(0, 2) + '****@' + domain;
  }
  const p = String(val);
  if (p.length <= 4) return '****';
  return p.slice(0, 2) + '****' + p.slice(-2);
}

module.exports = router;
