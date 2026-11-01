// test/wolvpay.test.js
// Unit tests for the WolvPay crypto payment integration (lib/wolvpay.js).
// Mirrors test/unit.test.js conventions (node assert, PASS/FAIL prints,
// process.exit(0|1)) but supports async tests. Uses a mock pool so no env
// vars or network access are required.
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const wolvpay = require('../lib/wolvpay');

let pass = 0;
let fail = 0;

async function ok(name, fn) {
  try {
    await fn();
    pass++;
    console.log('PASS - ' + name);
  } catch (e) {
    fail++;
    console.error('FAIL - ' + name + ' :: ' + (e && e.message ? e.message : e));
  }
}

// Mock pg-style pool: `query` is dispatched by SQL-substring matching so tests
// can script exact sequences without a real database.
function mockPool(responses) {
  const client = {
    query: (sql, params) => {
      const key = Object.keys(responses).find((k) => String(sql).indexOf(k) !== -1);
      return Promise.resolve(responses[key] || { rowCount: 0, rows: [] });
    },
    release: () => {}
  };
  return { connect: () => Promise.resolve(client), query: client.query };
}

(async () => {
  // 1. Config validation
  await ok('loadConfig throws WolvPayConfigError without an API key', async () => {
    delete process.env.WOLVPAY_API_KEY;
    assert.throws(() => wolvpay.loadConfig(), (e) => e.name === 'WolvPayConfigError');
  });
  await ok('webhookSecret throws when missing', async () => {
    delete process.env.WOLVPAY_WEBHOOK_SECRET;
    assert.throws(() => wolvpay.webhookSecret(), (e) => e.name === 'WolvPayConfigError');
  });
  await ok('loadConfig + webhookSecret read from env', async () => {
    process.env.WOLVPAY_API_KEY = 'wpk_test_123';
    process.env.WOLVPAY_WEBHOOK_SECRET = 'whsec_abc';
    const cfg = wolvpay.loadConfig();
    assert.strictEqual(cfg.apiKey, 'wpk_test_123');
    assert.ok(cfg.baseUrl.indexOf('/api/v1') !== -1);
    assert.strictEqual(wolvpay.webhookSecret(), 'whsec_abc');
  });

  // 2. Webhook signature verification (HMAC-SHA256 hex of raw body)
  await ok('verifyWebhookSignature accepts a valid HMAC', async () => {
    const secret = 'whsec_test';
    const body = Buffer.from(JSON.stringify({ invoice_id: 'inv_1', status: 'PAID' }));
    const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
    assert.strictEqual(wolvpay.verifyWebhookSignature(body, sig, secret), true);
    assert.strictEqual(wolvpay.verifyWebhookSignature(body, 'sha256=' + sig, secret), true);
  });
  await ok('verifyWebhookSignature rejects tampered/missing inputs', async () => {
    const secret = 'whsec_test';
    const body = Buffer.from('{"a":1}');
    const goodSig = crypto.createHmac('sha256', secret).update(body).digest('hex');
    assert.strictEqual(wolvpay.verifyWebhookSignature(body, goodSig.slice(0, -2) + 'ff', secret), false);
    assert.strictEqual(wolvpay.verifyWebhookSignature(body, '', secret), false);
    assert.strictEqual(wolvpay.verifyWebhookSignature(null, goodSig, secret), false);
  });

  // 3. Invoice normalisation (defensive against response shape drift)
  await ok('normalizeInvoice extracts id/status and any payment URL field', async () => {
    const inv = wolvpay.normalizeInvoice({
      invoice_id: 'inv_4e5a',
      status: 'awaiting_payment',
      amount: '100.00',
      currency: 'USD',
      coin: 'LTC',
      checkout_url: 'https://wolvpay.com/pay/inv_4e5a'
    });
    assert.strictEqual(inv.id, 'inv_4e5a');
    assert.strictEqual(inv.status, 'AWAITING_PAYMENT');
    assert.strictEqual(inv.amount, 100);
    assert.strictEqual(inv.coin, 'ltc');
    assert.strictEqual(inv.payment_url, 'https://wolvpay.com/pay/inv_4e5a');
  });
  await ok('extractPaymentUrl tries every known field name', async () => {
    assert.strictEqual(wolvpay.extractPaymentUrl({ payment_url: 'u1' }), 'u1');
    assert.strictEqual(wolvpay.extractPaymentUrl({ url: 'u2' }), 'u2');
    assert.strictEqual(wolvpay.extractPaymentUrl({ link: 'u3' }), 'u3');
    assert.strictEqual(wolvpay.extractPaymentUrl({ hosted_url: 'u4' }), 'u4');
    assert.strictEqual(wolvpay.extractPaymentUrl({}), null);
  });

  // 4. Webhook action state machine (idempotency guarantees)
  await ok('webhookAction maps statuses for open transactions', async () => {
    assert.strictEqual(wolvpay.webhookAction('pending', 'PAID'), 'credit');
    assert.strictEqual(wolvpay.webhookAction('processing', 'PAID'), 'credit');
    assert.strictEqual(wolvpay.webhookAction('pending', 'EXPIRED'), 'mark_failed');
    assert.strictEqual(wolvpay.webhookAction('pending', 'UNDERPAID'), 'mark_failed');
    assert.strictEqual(wolvpay.webhookAction('pending', 'CONFIRMING_PAYMENT'), 'sync');
    assert.strictEqual(wolvpay.webhookAction('pending', 'AWAITING_SELECTION'), 'sync');
    assert.strictEqual(wolvpay.webhookAction('pending', 'SOMETHING_ELSE'), 'ignore');
  });
  await ok('webhookAction never re-processes settled transactions', async () => {
    assert.strictEqual(wolvpay.webhookAction('success', 'PAID'), 'ignore');
    assert.strictEqual(wolvpay.webhookAction('failed', 'EXPIRED'), 'ignore');
    assert.strictEqual(wolvpay.webhookAction('cancelled', 'PAID'), 'ignore');
  });
  await ok('syncTxnStatus maps non-terminal invoices onto pending', async () => {
    assert.strictEqual(wolvpay.syncTxnStatus('AWAITING_PAYMENT'), 'pending');
    assert.strictEqual(wolvpay.syncTxnStatus('CONFIRMING_PAYMENT'), 'pending');
    assert.strictEqual(wolvpay.syncTxnStatus('PAID'), null);
  });

  // 5. normalizeWebhookBody parses the documented payload
  await ok('normalizeWebhookBody parses the WolvPay snapshot', async () => {
    const raw = Buffer.from(JSON.stringify({
      invoice_id: 'inv_9f2c',
      amount: 35,
      status: 'PAID',
      coin: 'BTC',
      coin_amount: 0.00033
    }));
    const parsed = wolvpay.normalizeWebhookBody(raw);
    assert.strictEqual(parsed.invoice_id, 'inv_9f2c');
    assert.strictEqual(parsed.status, 'PAID');
    assert.strictEqual(parsed.event, 'invoice.paid');
    assert.strictEqual(parsed.invoice.coin, 'btc');
  });

  // 6. creditSuccessfulDeposit (idempotent wallet credit)
  await ok('creditSuccessfulDeposit credits a pending deposit once', async () => {
    const queries = [];
    const db = {
      connect: async () => ({
        query: async (sql) => {
          queries.push(String(sql));
          if (/BEGIN|COMMIT/.test(sql)) return { rowCount: 0, rows: [] };
          if (/SET status = 'success'/.test(sql)) {
            return { rowCount: 1, rows: [{ id: 11, user_id: 7, type: 'deposit', amount: 20 }] };
          }
          if (/SELECT COUNT\(\*\)/.test(sql)) return { rowCount: 0, rows: [{ c: 1 }] };
          if (/SELECT referred_by/.test(sql)) return { rowCount: 0, rows: [] };
          return { rowCount: 0, rows: [] };
        },
        release: () => {}
      })
    };
    const r = await wolvpay.creditSuccessfulDeposit(db, 'inv_credit');
    assert.strictEqual(r.credited, true);
    assert.strictEqual(r.user_id, 7);
    assert.ok(queries.some((q) => q.indexOf("status IN ('pending','processing')") !== -1),
      'guard must only flip pending/processing rows');
    assert.ok(queries.some((q) => q.indexOf('wallet_balance = wallet_balance +') !== -1),
      'wallet must be credited');
  });
  await ok('creditSuccessfulDeposit ignores already-settled deposits', async () => {
    const db = mockPool({
      'BEGIN': { rowCount: 0, rows: [] },
      "SET status = 'success'": { rowCount: 0, rows: [] }
    });
    const r = await wolvpay.creditSuccessfulDeposit(db, 'inv_dup');
    assert.strictEqual(r.credited, false);
    assert.strictEqual(r.reason, 'already_processed');
  });

  // 7. markFailedDeposit
  await ok('markFailedDeposit only fails still-open deposits', async () => {
    const open = mockPool({ "SET status = 'failed'": { rowCount: 1, rows: [] } });
    const r1 = await wolvpay.markFailedDeposit(open, 'inv_x');
    assert.strictEqual(r1.marked, true);

    const settled = mockPool({});
    const r2 = await wolvpay.markFailedDeposit(settled, 'inv_x');
    assert.strictEqual(r2.marked, false);
    assert.strictEqual(r2.reason, 'already_processed');
  });

  // 8. Manual withdrawal settlement / refund
  await ok('settleManualWithdrawal closes a pending payout exactly once', async () => {
    const db = mockPool({
      'BEGIN': { rowCount: 0, rows: [] },
      "SET status = 'success'": { rowCount: 1, rows: [{ id: 30, user_id: 9, amount: 90 }] },
      'COMMIT': { rowCount: 0, rows: [] }
    });
    const r = await wolvpay.settleManualWithdrawal(db, 'ACM1');
    assert.strictEqual(r.settled, true);
    assert.strictEqual(Number(r.amount), 90);

    const dup = mockPool({ 'BEGIN': { rowCount: 0, rows: [] } });
    const r2 = await wolvpay.settleManualWithdrawal(dup, 'ACM1');
    assert.strictEqual(r2.settled, false);
  });
  await ok('refundFailedWithdrawal restores the wallet and decrements total_withdrawn', async () => {
    const seen = [];
    const db = {
      connect: async () => ({
        query: async (sql, params) => {
          seen.push({ sql: String(sql), params: params || [] });
          if (/UPDATE transactions SET status = 'failed'/.test(sql)) {
            return { rowCount: 1, rows: [{ id: 40, user_id: 55, amount: 30 }] };
          }
          if (/UPDATE users SET wallet_balance/.test(sql)) return { rowCount: 1, rows: [] };
          return { rowCount: 0, rows: [] };
        },
        release: () => {}
      })
    };
    const r = await wolvpay.refundFailedWithdrawal(db, 'ACM_refund');
    assert.strictEqual(r.refunded, true);
    assert.strictEqual(r.user_id, 55);
    const upd = seen.find((q) => /UPDATE users SET wallet_balance/.test(q.sql));
    assert.ok(upd, 'expected a wallet restore update');
    assert.ok(/total_withdrawn = GREATEST/.test(upd.sql), 'must use GREATEST guard');
  });

  // 9. Referral bonuses: flat USD amounts ($0.01 at signup, $2 confirmed) and
  //    the USD 30 claim threshold - never a percentage tier.
  await ok('referral bonus is a flat USD amount, not a percentage tier', async () => {
    assert.strictEqual(wolvpay.computeReferralRate(0), wolvpay.REFERRAL_CONFIRMED_BONUS_USD);
    assert.strictEqual(wolvpay.computeReferralRate(99), wolvpay.REFERRAL_CONFIRMED_BONUS_USD);
    assert.strictEqual(wolvpay.computeReferralRate(100), wolvpay.REFERRAL_CONFIRMED_BONUS_USD);
    assert.strictEqual(wolvpay.REFERRAL_CONFIRMED_BONUS_USD, 2);
    assert.strictEqual(wolvpay.REFERRAL_PENDING_BONUS_USD, 0.01);
    assert.strictEqual(wolvpay.REFERRAL_CLAIM_MIN_USD, 30);
  });

  // Recording pool: logs every query so assertions can inspect the SQL used.
  function recordingPool(script) {
    const seen = [];
    const client = {
      query: (sql, params) => {
        const key = Object.keys(script).find((k) => String(sql).indexOf(k) !== -1);
        seen.push({ sql: String(sql), params: params || [] });
        return Promise.resolve(script[key] || { rowCount: 0, rows: [] });
      },
      release: () => {}
    };
    return { seen, connect: () => Promise.resolve(client), query: client.query };
  }

  await ok('grantSignupReferralBonus credits USD 0.01 as pending', async () => {
    const db = recordingPool({
      'SELECT referred_by FROM users': { rows: [{ referred_by: 7 }] },
      'SELECT id FROM referral_bonuses': { rows: [] },
      'INSERT INTO referral_bonuses': { rowCount: 1 },
      'UPDATE users SET referral_pending': { rowCount: 1 }
    });
    const client = await db.connect();
    const r = await wolvpay.grantSignupReferralBonus(client, 9);
    assert.strictEqual(r.referrerId, 7);
    assert.strictEqual(r.bonus, 0.01);
    assert.strictEqual(r.confirmed, false);
    const upd = db.seen.find((q) => /UPDATE users SET referral_pending/.test(q.sql));
    assert.ok(upd, 'must credit referral_pending');
    assert.strictEqual(upd.params[0], 0.01);
  });

  await ok('grantSignupReferralBonus is a no-op without a referrer', async () => {
    const db = recordingPool({ 'SELECT referred_by FROM users': { rows: [{ referred_by: null }] } });
    const client = await db.connect();
    assert.strictEqual(await wolvpay.grantSignupReferralBonus(client, 9), null);
    assert.strictEqual(db.seen.length, 1, 'must stop after reading referred_by');
  });

  await ok('grantSignupReferralBonus never pays the same referral twice', async () => {
    const db = recordingPool({
      'SELECT referred_by FROM users': { rows: [{ referred_by: 7 }] },
      'SELECT id FROM referral_bonuses': { rows: [{ id: 3 }] }
    });
    const client = await db.connect();
    assert.strictEqual(await wolvpay.grantSignupReferralBonus(client, 9), null);
    assert.ok(!db.seen.some((q) => /INSERT INTO referral_bonuses/.test(q.sql)), 'no second row');
  });

  await ok('grantFirstDepositReferralBonus tops the bonus up to USD 2', async () => {
    const db = recordingPool({
      'SELECT referred_by FROM users': { rows: [{ referred_by: 7 }] },
      'SELECT id, amount, confirmed FROM referral_bonuses': { rows: [{ id: 3, amount: 0.01, confirmed: false }] },
      'SELECT COUNT(*)::int AS c': { rows: [{ c: 0 }] },
      'UPDATE referral_bonuses SET confirmed': { rowCount: 1, rows: [{ id: 3 }] },
      'UPDATE users SET referral_pending': { rowCount: 1 }
    });
    const client = await db.connect();
    const r = await wolvpay.grantFirstDepositReferralBonus(client, { user_id: 9, id: 55 });
    assert.strictEqual(r.referrerId, 7);
    assert.strictEqual(r.topup, 1.99, '0.01 + 1.99 = 2');
    assert.strictEqual(r.bonus, 2);
    const upd = db.seen.find((q) => /UPDATE users SET referral_pending/.test(q.sql));
    assert.strictEqual(upd.params[0], 1.99);
  });

  await ok('grantFirstDepositReferralBonus skips an already-confirmed referral', async () => {
    const db = recordingPool({
      'SELECT referred_by FROM users': { rows: [{ referred_by: 7 }] },
      'SELECT id, amount, confirmed FROM referral_bonuses': { rows: [{ id: 3, amount: 2, confirmed: true }] }
    });
    const client = await db.connect();
    assert.strictEqual(await wolvpay.grantFirstDepositReferralBonus(client, { user_id: 9, id: 55 }), null);
    assert.ok(!db.seen.some((q) => /UPDATE users SET referral_pending/.test(q.sql)), 'no second credit');
  });

  await ok('claimReferralEarnings refuses below the USD 30 minimum', async () => {
    const db = recordingPool({ 'SELECT referral_pending FROM users': { rows: [{ referral_pending: 5 }] } });
    const r = await wolvpay.claimReferralEarnings(db, 7);
    assert.strictEqual(r.claimed, false);
    assert.strictEqual(r.reason, 'below_minimum');
    assert.strictEqual(r.pending, 5);
    assert.strictEqual(r.minimum, 30);
    assert.ok(!db.seen.some((q) => /UPDATE users SET referral_pending = 0/.test(q.sql)), 'wallet untouched');
    assert.ok(db.seen.some((q) => /ROLLBACK/.test(q.sql)), 'must roll back');
  });

  await ok('claimReferralEarnings moves the balance into the wallet at >= USD 30', async () => {
    const db = recordingPool({
      'SELECT referral_pending FROM users': { rows: [{ referral_pending: 30 }] },
      'UPDATE users SET referral_pending = 0': { rowCount: 1 },
      'INSERT INTO transactions': { rowCount: 1 }
    });
    const r = await wolvpay.claimReferralEarnings(db, 7);
    assert.strictEqual(r.claimed, true);
    assert.strictEqual(r.amount, 30);
    const txn = db.seen.find((q) => /INSERT INTO transactions/.test(q.sql));
    assert.ok(txn, 'claim must be recorded in transactions');
    assert.ok(/'referral_claim'/.test(txn.sql), 'logged as a referral_claim transaction');
    assert.ok(db.seen.some((q) => /COMMIT/.test(q.sql)), 'must commit');
  });

  await ok('claimReferralEarnings reports no_user for an unknown account', async () => {
    const db = recordingPool({ 'SELECT referral_pending FROM users': { rows: [] } });
    const r = await wolvpay.claimReferralEarnings(db, 404404);
    assert.strictEqual(r.claimed, false);
    assert.strictEqual(r.reason, 'no_user');
  });

  // 10. Coin whitelist policy (merchant's enabled wallets)
  const prevEnabled = process.env.WOLVPAY_ENABLED_COINS;
  const sampleCoins = [
    { coin: 'btc', name: 'Bitcoin' },
    { coin: 'eth', name: 'Ethereum' },
    { coin: 'erc20_usdc', name: 'USDC' },
    { coin: 'sol_usdc', name: 'USDC' },
    { coin: 'trc20_usdt', name: 'USDT' },
    { coin: 'ltc', name: 'Litecoin' },
    { coin: 'sol_sol', name: 'Solana' }
  ];
  try {
    delete process.env.WOLVPAY_ENABLED_COINS;
    await ok('enabledCoins is empty when unset → filter passes everything', async () => {
      assert.deepStrictEqual(await wolvpay.enabledCoins(), []);
      assert.strictEqual(wolvpay.filterEnabledCoins(sampleCoins).length, sampleCoins.length);
    });
    process.env.WOLVPAY_ENABLED_COINS = ' btc, ETH ,ERC20_USDC,trc20_usdt ';
    await ok('filterEnabledCoins keeps only the merchant whitelist', async () => {
      assert.deepStrictEqual(await wolvpay.enabledCoins(), ['btc', 'eth', 'erc20_usdc', 'trc20_usdt']);
      const keep = wolvpay.filterEnabledCoins(sampleCoins).map((c) => c.coin);
      assert.deepStrictEqual(keep, ['btc', 'eth', 'erc20_usdc', 'trc20_usdt']);
    });
    await ok('coinLabel includes the network for multi-chain tokens', async () => {
      assert.strictEqual(wolvpay.coinLabel('btc', 'Bitcoin'), 'Bitcoin');
      assert.strictEqual(wolvpay.coinLabel('eth', 'Ethereum'), 'Ethereum');
      assert.strictEqual(wolvpay.coinLabel('trc20_usdt'), 'USDT (TRC20)');
      assert.strictEqual(wolvpay.coinLabel('erc20_usdc'), 'USDC (ERC20)');
      assert.strictEqual(wolvpay.coinLabel('sol_usdc'), 'USDC (SOL)');
      assert.strictEqual(wolvpay.coinLabel('bep20_usdt'), 'USDT (BEP20)');
      assert.strictEqual(wolvpay.coinLabel('sol_sol', 'Solana'), 'Solana');
    });
    await ok('applyCoinPolicy filters and labels in one step', async () => {
      const out = wolvpay.applyCoinPolicy(sampleCoins);
      assert.strictEqual(out.length, 4);
      assert.ok(out.some((c) => c.coin === 'trc20_usdt' && c.label === 'USDT (TRC20)'));
      assert.ok(out.every((c) => c.label));
    });
  } finally {
    if (prevEnabled === undefined) delete process.env.WOLVPAY_ENABLED_COINS;
    else process.env.WOLVPAY_ENABLED_COINS = prevEnabled;
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed.');
  process.exit(fail === 0 ? 0 : 1);
})();

