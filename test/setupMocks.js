// Setup mocks for the integration test.
// This module MUST be required before any project route module, because it
// intercepts require('../db') and require('../lib/wolvpay') in the require cache.
'use strict';

process.env.JWT_SECRET = 'test_jwt_secret_1234567890';
process.env.WOLVPAY_API_KEY = 'wlov_test_123';
process.env.WOLVPAY_WEBHOOK_SECRET = 'whsec_test_secret';
process.env.MIN_DEPOSIT_USD = '10';
process.env.MIN_WITHDRAW_USD = '30';
process.env.WOLVPAY_ENABLED_COINS = 'btc,usdt';
process.env.WITHDRAW_FEE_PERCENT = '10';

var path = require('path');
var mockPoolModule = require('./mockPool');

// Investment levels (mirrors seed.js)
var LEVELS = [
  { name: 'Level 1', tier: 'Level 1', price: 20, daily_percent: 3, lock_days: 20, sort_order: 1 },
  { name: 'Level 2', tier: 'Level 2', price: 35, daily_percent: 10, lock_days: 20, sort_order: 2 },
  { name: 'Level 3', tier: 'Level 3', price: 65, daily_percent: 15, lock_days: 20, sort_order: 3 },
  { name: 'Level 4', tier: 'Level 4', price: 125, daily_percent: 20, lock_days: 20, sort_order: 4 },
  { name: 'Level 5', tier: 'Level 5', price: 300, daily_percent: 50, lock_days: 10, sort_order: 5 },
  { name: 'BOSS', tier: 'BOSS', price: 500, daily_percent: 80, lock_days: 10, sort_order: 6 },
  { name: 'VIP', tier: 'VIP', price: 1000, daily_percent: 150, lock_days: 7, sort_order: 7 },
  { name: 'VVIP', tier: 'VVIP', price: 2000, daily_percent: 300, lock_days: 7, sort_order: 8 },
  { name: 'GODFATHER', tier: 'GODFATHER', price: 5000, daily_percent: 500, lock_days: 7, sort_order: 9 }
];

var TASKS = [
  { title: 'Join our Telegram channel', description: 'Join @afrocoinmoney on Telegram for daily market wins.', reward: 0.3, condition: 'claim', sort_order: 1 },
  { title: 'Follow our official page', description: 'Follow afrocoinmoney on social media.', reward: 0.1, condition: 'claim', sort_order: 2 },
  { title: 'Complete your profile', description: 'Add your name in account settings.', reward: 0.01, condition: 'claim', sort_order: 3 },
  { title: 'Set your display name', description: 'Add your name in account settings.', reward: 0.1, condition: 'has_username', sort_order: 4 },
  { title: 'Select your display currency', description: 'Choose your preferred display currency.', reward: 0.05, condition: 'has_currency', sort_order: 5 },
  { title: 'Make your first deposit', description: 'Fund your wallet with crypto via WolvPay.', reward: 0.3, condition: 'has_deposit', sort_order: 6 },
  { title: 'Activate your first level', description: 'Start earning daily with any investment level.', reward: 0.3, condition: 'has_bot', sort_order: 7 },
  { title: 'Invite your first friend', description: 'Share your referral link with one friend.', reward: 0.25, condition: 'has_referral', sort_order: 8 }
];

var mockPool = mockPoolModule.createMockPool(LEVELS, TASKS);

// Seed 100 settled transactions so the platform stats feed has visible
// activity on first load (instead of an empty ticker).
(function seedActivity() {
  var coins = ['BTC', 'USDT'];
  var types = ['deposit', 'withdrawal'];
  var methods = ['BTC', 'USDT'];
  var now = Date.now();
  for (var i = 0; i < 100; i++) {
    var type = types[i % 2];
    var method = methods[i % 2];
    var amount = 10 + Math.random() * 990;
    var ref = 'ref_' + i;
    var sql =
      "INSERT INTO transactions (user_id, type, method, amount, fee, net_amount, status, reference, created_at) " +
      "VALUES (1, $1, $2, $3, 0, $3, 'success', $4, $5)";
    mockPool.query(sql, [type, method, amount, ref, new Date(now - i * 3600000).toISOString()]);
  }
})();

// Intercept require('../db') so every project module that needs the pool gets the mock.
var dbPath = require.resolve(path.resolve(__dirname, '..', 'db.js'));
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { pool: mockPool }
};

// Intercept require('../lib/wolvpay') — override network-bound methods only.
var wolvpayPath = require.resolve(path.resolve(__dirname, '..', 'lib', 'wolvpay.js'));
var realWolvpay = require(wolvpayPath);

var invoiceSeq = 1000;
var mockCoins = [
  { coin: 'btc', name: 'Bitcoin', logo: null, minimum_transaction_coin: 0.001, prices: {} },
  { coin: 'usdt', name: 'Tether', logo: null, minimum_transaction_coin: 5, prices: {} },
  { coin: 'ltc', name: 'Litecoin', logo: null, minimum_transaction_coin: 0.01, prices: {} }
];

function createMockInvoice(input) {
  var id = 'inv_' + (invoiceSeq++);
  return realWolvpay.normalizeInvoice({
    invoice_id: id,
    status: 'AWAITING_PAYMENT',
    amount: input.amount,
    currency: input.currency || 'USD',
    coin: (input.coin || 'btc').toLowerCase(),
    // Mirrors the real WolvPay response for this API key: there is NO hosted
    // checkout page - the customer pays the deposit address directly.
    coin_address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p8a5qw0x0s0s0',
    coin_amount: 0.0001293596476366349,
    expires_at: '2026-08-25 08:05:00'
  });
}

var mockWolvpay = Object.assign({}, realWolvpay, {
  loadConfig: function () {
    if (!process.env.WOLVPAY_API_KEY) throw new realWolvpay.WolvPayConfigError('no key');
    return { apiKey: process.env.WOLVPAY_API_KEY, baseUrl: process.env.WOLVPAY_BASE_URL || 'https://wolvpay.com/api/v1' };
  },
  webhookSecret: function () {
    if (!process.env.WOLVPAY_WEBHOOK_SECRET) throw new realWolvpay.WolvPayConfigError('no secret');
    return process.env.WOLVPAY_WEBHOOK_SECRET;
  },
  getCoins: function () { return Promise.resolve({ ok: true, coins: mockCoins }); },
  createInvoice: function (input) {
    return Promise.resolve({ ok: true, invoice: createMockInvoice(input) });
  },
  getInvoice: function (invoiceId) {
    return Promise.resolve({ ok: true, invoice: realWolvpay.normalizeInvoice({ invoice_id: invoiceId, status: 'PAID' }) });
  }
});

require.cache[wolvpayPath] = {
  id: wolvpayPath, filename: wolvpayPath, loaded: true,
  exports: mockWolvpay
};

module.exports.mockPool = mockPool;
module.exports.realWolvpay = mockWolvpay;
