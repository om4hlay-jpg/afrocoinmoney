// Wallet routes: crypto deposits via WolvPay invoices, manual crypto
// withdrawals (10% fee), transaction history and the live market feed.
const express = require('express');
const { pool } = require('../db');
const { authRequired } = require('../middleware/auth');
const { toMoney, makeRef, processDailyEarnings, computeWithdrawFee, createNotification } = require('../helpers');
const currencyLib = require('../lib/currency');
const wolvpay = require('../lib/wolvpay');
const logger = require('../lib/logger');

const router = express.Router();

// Money rules (blueprint).
const MIN_DEPOSIT_USD = parseFloat(process.env.MIN_DEPOSIT_USD || '10');
const MIN_WITHDRAW_USD = parseFloat(process.env.MIN_WITHDRAW_USD || '30');

// In-memory WolvPay coin cache refreshed at most every 10 minutes.
// Coins are filtered down to the merchant's enabled wallets (from
// platform_settings, falling back to WOLVPAY_ENABLED_COINS) and each gets a
// friendly label.
let coinsCache = { at: 0, coins: [] };
async function getCoinsCached(force) {
  const age = Date.now() - coinsCache.at;
  if (!force && coinsCache.coins.length && age < 10 * 60 * 1000) return coinsCache.coins;
  const r = await wolvpay.getCoins();
  if (r.ok && r.coins.length) {
    const enabled = await wolvpay.enabledCoins(pool);
    coinsCache = { at: Date.now(), coins: wolvpay.applyCoinPolicy(r.coins, enabled) };
    return coinsCache.coins;
  }
  return coinsCache.coins;
}

// Public list of the coins this merchant can actually receive, so the deposit
// AND withdrawal pickers only ever offer wallets that exist in the WolvPay
// dashboard (and honour WOLVPAY_ENABLED_COINS). Not sensitive data - it is the
// same list the deposit screen shows - so it needs no auth.
router.get('/coins', async (req, res) => {
  try {
    const coins = await getCoinsCached();
    return res.json({
      coins: coins.map((c) => ({ coin: c.coin, name: c.name, label: c.label || c.name || c.coin, logo: c.logo }))
    });
  } catch (err) {
    console.error('Coins error:', err);
    // Never a 5xx: the client falls back to its own shortlist so a WolvPay
    // outage degrades the picker instead of blocking the whole wallet screen.
    return res.json({ coins: [] });
  }
});
// POST /api/wallet/deposit - create a WolvPay crypto invoice.
router.post('/deposit', authRequired, async (req, res) => {
  try {
    const amountLocal = Number(req.body.amount);
    const coin = String(req.body.coin || '').trim().toLowerCase().slice(0, 20) || null;
    if (!amountLocal || amountLocal <= 0) {
      return res.status(400).json({ error: 'Enter the amount you want to deposit.' });
    }

    const user = (await pool.query('SELECT name, currency FROM users WHERE id = $1', [req.user.id])).rows[0];
    if (!user) return res.status(404).json({ error: 'Account not found.' });

    const usd = currencyLib.roundFor('USD', currencyLib.toUsd(amountLocal, user.currency));
    if (usd < MIN_DEPOSIT_USD) {
      return res.status(400).json({ error: 'The minimum deposit is ' + currencyLib.formatLocal(MIN_DEPOSIT_USD, user.currency) + '.' });
    }

    try {
      wolvpay.loadConfig();
    } catch (cfgErr) {
      console.error('WolvPay config error:', cfgErr.message);
      return res.status(503).json({ error: 'Crypto payments are temporarily unavailable. Please try again later.' });
    }

    const knownCoins = await getCoinsCached();
    if (coin && knownCoins.length && !knownCoins.some((c) => c.coin === coin)) {
      return res.status(400).json({ error: 'That cryptocurrency is not available right now.' });
    }

    const inv = currencyLib.invoiceAmount(usd, user.currency);
    const origin = process.env.APP_PUBLIC_URL || (req.protocol + '://' + req.get('host'));
    const created = await wolvpay.createInvoice({
      amount: inv.amount,
      currency: inv.currency,
      coin: coin,
      description: 'afrocoinmoney wallet deposit',
      redirectUrl: origin + '/index.html?deposit=complete'
    });
    if (!created.ok) {
      const category = (created.error && created.error.category) || '';
      if (category === 'validation') return res.status(400).json({ error: 'Invalid payment request. Please check your amount and coin.' });
      if (category === 'auth' || category === 'account' || category === 'limit') return res.status(503).json({ error: 'Crypto payments are temporarily unavailable. Please try again later.' });
      console.error('WolvPay createInvoice failed:', created.error);
      return res.status(502).json({ error: 'Could not start your deposit. Please try again.' });
    }
    const invoice = created.invoice;

    // Pretty method label, e.g. "BTC", "ETH", "USDT (TRC20)", "USDC (ERC20)".
    const method = wolvpay.coinLabel(invoice.coin || coin) || String(invoice.coin || coin || 'CRYPTO').toUpperCase();
    await pool.query(
      "INSERT INTO transactions (user_id, type, method, amount, fee, net_amount, status, reference) VALUES ($1, 'deposit', $2, $3, 0, $3, 'pending', $4)",
      [req.user.id, method, usd, invoice.id]
    );

    return res.json({
      success: true,
      status: 'pending',
      reference: invoice.id,
      payment_url: invoice.payment_url,
      invoice_status: invoice.status,
      coin: String(invoice.coin || coin || '').toUpperCase(),
      coin_amount: invoice.coin_amount,
      coin_address: invoice.coin_address,
      expires_at: invoice.expires_at,
      amount_usd: usd,
      message: invoice.payment_url
        ? 'Complete your crypto payment on the secure WolvPay page that just opened.'
        : 'Send the exact amount below from your own crypto wallet to the deposit address. Your wallet is credited automatically once the payment is confirmed.'
    });
  } catch (err) {
    console.error('Deposit error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});
// GET /api/wallet/deposit/:reference/status - polling fallback.
router.get('/deposit/:reference/status', authRequired, async (req, res) => {
  try {
    const reference = String(req.params.reference || '');
    const txn = (await pool.query(
      "SELECT * FROM transactions WHERE reference = $1 AND user_id = $2 AND type = 'deposit' LIMIT 1",
      [reference, req.user.id]
    )).rows[0];
    if (!txn) return res.status(404).json({ error: 'Deposit not found.' });

    let status = txn.status;
    if (status !== 'success' && status !== 'failed') {
      try {
        wolvpay.loadConfig();
        const g = await wolvpay.getInvoice(reference);
        if (g.ok && g.invoice) {
          const action = wolvpay.webhookAction(txn.status, g.invoice.status);
          if (action === 'credit') {
            await wolvpay.creditSuccessfulDeposit(pool, reference);
            status = 'success';
          } else if (action === 'mark_failed') {
            await wolvpay.markFailedDeposit(pool, reference);
            status = 'failed';
          }
        }
      } catch (pollErr) {
        console.error('Deposit poll error:', pollErr.message);
      }
    }

    return res.json({ success: true, reference: reference, status: status });
  } catch (err) {
    console.error('Deposit status error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});
// POST /api/wallet/withdraw - manual crypto payout request.
router.post('/withdraw', authRequired, async (req, res) => {
  const coin = String(req.body.coin || '').trim().toLowerCase().slice(0, 20);
  const address = String(req.body.address || '').trim();
  try {
    if (!coin) return res.status(400).json({ error: 'Choose the cryptocurrency for your withdrawal.' });
    if (!address || !/^[A-Za-z0-9:_-]{15,120}$/.test(address)) {
      return res.status(400).json({ error: 'Enter a valid crypto wallet address.' });
    }

    // The payout coin must be one the platform actually holds wallets for -
    // the same WolvPay list (filtered by WOLVPAY_ENABLED_COINS) that drives the
    // deposit picker. Treasury cannot pay out a coin it has no wallet for.
    // If the coin list cannot be fetched we still allow the request: the
    // treasury settles payouts manually, so a transient API outage must not
    // block a member from asking for their own money.
    let knownCoins = [];
    try {
      knownCoins = await getCoinsCached();
    } catch (coinErr) {
      console.error('Withdraw coin lookup failed:', coinErr.message);
    }
    if (knownCoins.length && !knownCoins.some((c) => c.coin === coin)) {
      return res.status(400).json({ error: 'That cryptocurrency cannot be paid out right now. Please choose another.' });
    }
    // Store the pretty label (e.g. "USDT (TRC20)") so history reads clearly.
    const known = knownCoins.find((c) => c.coin === coin);
    const method = known ? (known.label || known.name || coin) : coin.toUpperCase();

    await processDailyEarnings(req.user.id);

    const amountLocal = Number(req.body.amount);
    if (!amountLocal || amountLocal <= 0) {
      return res.status(400).json({ error: 'Enter the amount you want to withdraw.' });
    }

    const user = (await pool.query('SELECT currency FROM users WHERE id = $1', [req.user.id])).rows[0];
    if (!user) return res.status(404).json({ error: 'Account not found.' });

    const usd = currencyLib.roundFor('USD', currencyLib.toUsd(amountLocal, user.currency));
    if (usd < MIN_WITHDRAW_USD) {
      return res.status(400).json({ error: 'The minimum withdrawal is ' + currencyLib.formatLocal(MIN_WITHDRAW_USD, user.currency) + '.' });
    }

    const feeSplit = computeWithdrawFee(usd);

    const client = await pool.connect();
    let txn;
    try {
      await client.query('BEGIN');
      const row = (await client.query('SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE', [req.user.id])).rows[0];
      if (!row || Number(row.wallet_balance) < feeSplit.gross) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Not enough balance in your wallet for this withdrawal.' });
      }
      await client.query(
        'UPDATE users SET wallet_balance = wallet_balance - $1, total_withdrawn = total_withdrawn + $1 WHERE id = $2',
        [feeSplit.gross, req.user.id]
      );
      txn = (await client.query(
        "INSERT INTO transactions (user_id, type, method, amount, fee, net_amount, status, reference, account) VALUES ($1, 'withdrawal', $2, $3, $4, $5, 'pending', $6, $7) RETURNING *",
        [req.user.id, method, feeSplit.gross, feeSplit.fee, feeSplit.net, makeRef(), address]
      )).rows[0];
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    // Record a notification for the withdrawal request - before the response
    // is sent so the app actually surfaces the pending payout.
    await createNotification(req.user.id, 'withdrawal', 'Withdrawal request received',
      'Withdrawal request of ' + currencyLib.formatLocal(feeSplit.gross, user.currency) + ' is pending processing.');

    return res.json({
      success: true,
      status: 'pending',
      txn: txn,
      gross: feeSplit.gross,
      fee: feeSplit.fee,
      net: feeSplit.net,
      message: 'Withdrawal request submitted. Your crypto payout is being processed.'
    });
  } catch (err) {
    console.error('Withdraw error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

// GET /api/wallet/transactions - list the member's transaction history.
router.get('/transactions', authRequired, async (req, res) => {
  try {
    const txns = (await pool.query(
      'SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100',
      [req.user.id]
    )).rows;
    return res.json({ transactions: txns });
  } catch (err) {
    console.error('Transactions error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
});

// GET /api/marquee - recent public-like transactions for the marquee.
// Returns a mix of recent real transactions and dummy data if empty.
router.get('/', async (req, res) => {
  try {
    const rows = (await pool.query(
      `SELECT type, method, amount, status, created_at FROM transactions
       WHERE status = 'success'
       ORDER BY created_at DESC LIMIT 20`
    )).rows;
    return res.json({ transactions: rows });
  } catch (err) {
    console.error('Marquee error:', err);
    return res.json({ transactions: [] });
  }
});

module.exports = router;
