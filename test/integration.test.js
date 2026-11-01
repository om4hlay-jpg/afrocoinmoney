// Integration tests for the afrocoinmoney Express application.
// Run with: node test/integration.test.js
'use strict';

require('./setupMocks');

var http = require('http');
var assert = require('assert');
var crypto = require('crypto');

var express = require('express');
var cors = require('cors');

var currencyLib = require('../lib/currency');
var authRouter = require('../routes/auth');
var walletRouter = require('../routes/wallet');
var botsRouter = require('../routes/bots');
var teamRouter = require('../routes/team');
var tasksRouter = require('../routes/tasks');
var homeRouter = require('../routes/home');
var statsRouter = require('../routes/stats');
var settingsRouter = require('../routes/settings');
var webhooksRouter = require('../routes/webhooks');
var adminRouter = require('../routes/admin');

// Build the Express app (mirrors server.js, without auto-start / DB check).
var app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(function (req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(cors());
app.use(function (req, res, next) {
  var orig = res.send.bind(res);
  res.send = function (b) {
    if (process.env.TRACE_SEND) console.log('[send]', req.method, req.url, '->', JSON.stringify(String(b)));
    return orig(b);
  };
  next();
});
app.use('/api/webhooks', express.raw({ type: 'application/json', limit: '1mb' }));
app.use('/api/webhooks', webhooksRouter);
app.use(express.json({ limit: '100kb' }));
app.use('/api/auth', authRouter);
app.use('/api/wallet', walletRouter);
app.use('/api/bots', botsRouter);
app.use('/api/team', teamRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/home', homeRouter);
app.use('/api/stats', statsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/admin', adminRouter);
app.get('/api/currencies', function (req, res) { res.json({ currencies: currencyLib.listCurrencies() }); });
app.get('/api/health', function (req, res) { res.json({ ok: true }); });

function httpRequest(server, method, urlPath, body, extraHeaders) {
  return new Promise(function (resolve, reject) {
    var port = server.address().port;
    var isRaw = body instanceof Buffer;
    var data = isRaw ? body : (body !== undefined && body !== null ? JSON.stringify(body) : undefined);
    var headers = extraHeaders || {};
    if (data !== undefined) {
      headers['Content-Type'] = isRaw ? 'application/json' : 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    var options = { hostname: '127.0.0.1', port: port, path: urlPath, method: method,
      headers: Object.assign({ Connection: 'close' }, headers) };
    var req = http.request(options, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var rawBody = Buffer.concat(chunks);
        var parsed;
        try { parsed = JSON.parse(rawBody.toString()); }
        catch (e) { parsed = rawBody.toString(); }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, rawBody: rawBody });
      });
    });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

var pass = 0;
var fail = 0;
var server;

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

async function registerPhoneUser(holder, password) {
  var phone = '+254712' + String(Math.floor(Math.random() * 9000000) + 1000000);
  var res = await httpRequest(server, 'POST', '/api/auth/register', {
    identifier: phone, password: password || 'pass1234'
  });
  assert.strictEqual(res.status, 200, 'register should succeed: ' + JSON.stringify(res.body));
  holder.token = res.body.token;
  holder.user = res.body.user;
  holder.phone = phone;
  return res.body;
}

// Fetch a PoW challenge and grind a solution (server-side mirror of app.js).
function solveChallenge() {
  return httpRequest(server, 'GET', '/api/auth/challenge').then(function (r) {
    var c = r.body;
    var pre = c.prefix + ':';
    for (var n = 0; ; n++) {
      if (crypto.createHash('sha256').update(pre + n).digest('hex').indexOf(c.difficulty) === 0) {
        return { challenge_id: c.challenge_id, pow: String(n) };
      }
    }
  });
}

// Login through the protected flow: challenge -> POST.
async function doLogin(identifier, password, extra) {
  var sol = await solveChallenge();
  var body = Object.assign({
    identifier: identifier,
    password: password,
    challenge_id: sol.challenge_id,
    pow: sol.pow
  }, extra || {});
  return httpRequest(server, 'POST', '/api/auth/login', body);
}

(async function () {
  await new Promise(function(resolve){ server = app.listen(0, '127.0.0.1', resolve); });


  // â”€â”€ Health & Public Endpoints â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  await ok('GET /api/health returns ok', async function () {
    var res = await httpRequest(server, 'GET', '/api/health');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
  });

  await ok('GET /api/currencies returns the full catalogue', async function () {
    var res = await httpRequest(server, 'GET', '/api/currencies');
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.currencies));
    assert.ok(res.body.currencies.length >= 30);
    var codes = res.body.currencies.map(function (c) { return c.code; });
    assert.ok(codes.indexOf('UGX') !== -1);
    assert.ok(codes.indexOf('NGN') !== -1);
    assert.ok(codes.indexOf('KES') !== -1);
  });

  await ok('GET /api/stats returns social proof counters', async function () {
    var res = await httpRequest(server, 'GET', '/api/stats');
    assert.strictEqual(res.status, 200);
    assert.ok(typeof res.body.trusted_users === 'number');
    assert.ok(typeof res.body.profits === 'number');
  });

  await ok('GET /api/stats/feed returns 100 shuffled entries', async function () {
    var res = await httpRequest(server, 'GET', '/api/stats/feed');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.feed.length, 100);
    res.body.feed.forEach(function (t) {
      assert.ok(t.type === 'deposit' || t.type === 'withdrawal');
      assert.ok(t.method === 'BTC' || t.method === 'USDT');
    });
  });

  await ok('GET /api/stats/bots returns level definitions', async function () {
    var res = await httpRequest(server, 'GET', '/api/stats/bots');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.bots.length >= 9);
    assert.strictEqual(res.body.bots[0].tier, 'Level 1');
  });

  // â”€â”€ Authentication: Registration â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  var phoneUser = {};
  await ok('POST /register with phone succeeds + USD 2 welcome bonus', async function () {
    await registerPhoneUser(phoneUser);
    assert.ok(phoneUser.token);
    assert.strictEqual(phoneUser.user.wallet_balance, 1);
    assert.strictEqual(phoneUser.user.welcome_bonus_claimed, true);
    assert.ok(/^[A-Z2-9]{8}$/.test(phoneUser.user.referral_code));
  });

  await ok('POST /register with e-mail and currency succeeds', async function () {
    var addr = 'user' + Date.now() + '@example.com';
    var res = await httpRequest(server, 'POST', '/api/auth/register', {
      identifier: addr, password: 'pass1234', currency: 'KES'
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.user.currency, 'KES');
    assert.strictEqual(res.body.user.email, addr);
  });

  await ok('POST /register rejects phone too short for E.164', async function () {
    var res = await httpRequest(server, 'POST', '/api/auth/register', {
      identifier: '12345', password: 'pass1234'
    });
    assert.strictEqual(res.status, 400);
  });

  await ok('POST /register rejects short password', async function () {
    var res = await httpRequest(server, 'POST', '/api/auth/register', {
      identifier: '+254777' + Math.floor(1000000 + Math.random() * 9000000), password: 'ab'
    });
    assert.strictEqual(res.status, 400);
  });

  await ok('POST /register rejects invalid referral code', async function () {
    var res = await httpRequest(server, 'POST', '/api/auth/register', {
      identifier: '+254788' + Math.floor(1000000 + Math.random() * 9000000),
      password: 'pass1234', referral_code: 'BADCODE99'
    });
    assert.strictEqual(res.status, 400);
    assert.ok(/not valid/i.test(res.body.error));
  });

  await ok('POST /register rejects duplicate phone', async function () {
    var res = await httpRequest(server, 'POST', '/api/auth/register', {
      identifier: phoneUser.phone, password: 'otherpass'
    });
    assert.strictEqual(res.status, 400);
    assert.ok(/already registered/i.test(res.body.error));
  });

  // â”€â”€ Authentication: Login â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  await ok('POST /login with correct phone + password returns token', async function () {
    var res = await doLogin(phoneUser.phone, 'pass1234');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.token);
  });

  await ok('POST /login fails on wrong password', async function () {
    var res = await doLogin(phoneUser.phone, 'wrongpass');
    assert.strictEqual(res.status, 400);
    assert.ok(/incorrect password/i.test(res.body.error));
  });

  await ok('POST /login fails on unknown account', async function () {
    var res = await doLogin('+254000000000', 'whatever');
    assert.strictEqual(res.status, 400);
  });

  // â”€â”€ Auth guard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  await ok('GET /me without token â†’ 401', async function () {
    var res = await httpRequest(server, 'GET', '/api/auth/me');
    assert.strictEqual(res.status, 401);
  });

  await ok('GET /me with garbage token â†’ 401', async function () {
    var res = await httpRequest(server, 'GET', '/api/auth/me', null, { Authorization: 'Bearer not.a.token' });
    assert.strictEqual(res.status, 401);
  });

  await ok('GET /me with valid token returns the profile', async function () {
    var res = await httpRequest(server, 'GET', '/api/auth/me', null, { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.user.id, phoneUser.user.id);
    assert.strictEqual(res.body.user.wallet_balance, 1);
  });

  await ok('welcome bonus appears in transaction history', async function () {
    var res = await httpRequest(server, 'GET', '/api/wallet/transactions', null,
      { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(res.status, 200);
    var bonus = res.body.transactions.find(function (t) { return t.type === 'bonus'; });
    assert.ok(bonus, 'bonus transaction recorded');
    assert.strictEqual(Number(bonus.amount), 1);
    assert.strictEqual(bonus.status, 'success');
    assert.strictEqual(Number(bonus.net_amount), 1);
  });

  // â”€â”€ Wallet: Deposit â†’ Webhook â†’ Credit (the money path) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  var depositRef;
  await ok('POST /wallet/deposit creates a pending WolvPay invoice', async function () {
    var res = await httpRequest(server, 'POST', '/api/wallet/deposit', {
      amount: 50, coin: 'btc'
    }, { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.status, 'pending');
    assert.ok(/^inv_\d+$/.test(res.body.reference), 'reference is invoice id');
    // The deposit flow completes by sending crypto to the returned address
    // (WolvPay returns no hosted checkout page for this API key).
    assert.ok(res.body.coin_address, 'returns the deposit address to pay');
    assert.ok(res.body.coin_amount, 'returns the exact crypto amount to send');
    assert.ok(res.body.coin, 'returns the coin symbol');
    depositRef = res.body.reference;
  });

  await ok('deposit below USD 10 minimum is rejected', async function () {
    var res = await httpRequest(server, 'POST', '/api/wallet/deposit', {
      amount: 5, coin: 'btc'
    }, { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(res.status, 400);
    assert.ok(/minimum/i.test(res.body.error));
  });

  await ok('deposit with unknown coin is rejected', async function () {
    var res = await httpRequest(server, 'POST', '/api/wallet/deposit', {
      amount: 50, coin: 'xrp'
    }, { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(res.status, 400);
  });

  await ok('wallet does NOT credit before the PAID webhook', async function () {
    var res = await httpRequest(server, 'GET', '/api/auth/me', null, { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.user.wallet_balance, 1, 'balance must still be welcome bonus only');
  });

  await ok('webhook with no signature header is silently ignored', async function () {
    var raw = Buffer.from(JSON.stringify({ event: 'invoice.paid', status: 'PAID', invoice_id: depositRef }));
    var res = await httpRequest(server, 'POST', '/api/webhooks/wolvpay', raw);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body, 'ignored');
  });

  await ok('webhook with tampered signature â†’ 401', async function () {
    var raw = Buffer.from(JSON.stringify({ event: 'invoice.paid', status: 'PAID', invoice_id: depositRef }));
    var res = await httpRequest(server, 'POST', '/api/webhooks/wolvpay', raw, {
      'x-wolvpay-signature': 'deadbeef'
    });
    assert.strictEqual(res.status, 401);
  });

  await ok('signed PAID webhook credits wallet (+USD 50)', async function () {
    var raw = Buffer.from(JSON.stringify({ event: 'invoice.paid', status: 'PAID', invoice_id: depositRef }));
    var sig = crypto.createHmac('sha256', process.env.WOLVPAY_WEBHOOK_SECRET).update(raw).digest('hex');
    var res = await httpRequest(server, 'POST', '/api/webhooks/wolvpay', raw, { 'x-wolvpay-signature': sig });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body, 'credited');

    var me = await httpRequest(server, 'GET', '/api/auth/me', null, { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(me.body.user.wallet_balance, 51, '1 bonus + 50 deposit');
    assert.strictEqual(me.body.user.total_deposited, 50);
  });

  await ok('duplicate PAID webhook leaves wallet untouched (idempotent)', async function () {
    var raw = Buffer.from(JSON.stringify({ event: 'invoice.paid', status: 'PAID', invoice_id: depositRef }));
    var sig = crypto.createHmac('sha256', process.env.WOLVPAY_WEBHOOK_SECRET).update(raw).digest('hex');
    var res = await httpRequest(server, 'POST', '/api/webhooks/wolvpay', raw, { 'x-wolvpay-signature': sig });
    assert.strictEqual(res.status, 200);
    // Settled invoices are ignored at the action gate; only a true concurrent
    // race reaches creditSuccessfulDeposit's own already_processed guard.
    assert.strictEqual(res.body, 'ignored');
    var me = await httpRequest(server, 'GET', '/api/auth/me', null,
      { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(me.body.user.wallet_balance, 51, 'no double credit');
    assert.strictEqual(me.body.user.total_deposited, 50, 'no double count');
  });

  await ok('EXPIRED webhook marks a second deposit as failed', async function () {
    var dep = await httpRequest(server, 'POST', '/api/wallet/deposit', {
      amount: 25, coin: 'usdt'
    }, { Authorization: 'Bearer ' + phoneUser.token });
    var ref2 = dep.body.reference;
    var raw = Buffer.from(JSON.stringify({ event: 'invoice.expired', status: 'EXPIRED', invoice_id: ref2 }));
    var sig = crypto.createHmac('sha256', process.env.WOLVPAY_WEBHOOK_SECRET).update(raw).digest('hex');
    var res = await httpRequest(server, 'POST', '/api/webhooks/wolvpay', raw, { 'x-wolvpay-signature': sig });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body, 'marked_failed');

    var st = await httpRequest(server, 'GET', '/api/wallet/deposit/' + ref2 + '/status', null,
      { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(st.body.status, 'failed');
  });

  await ok('deposit status polling confirms success after webhook', async function () {
    var res = await httpRequest(server, 'GET', '/api/wallet/deposit/' + depositRef + '/status', null,
      { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'success');
  });

  await ok('status polling for unknown reference â†’ 404', async function () {
    var res = await httpRequest(server, 'GET', '/api/wallet/deposit/inv_nope/status', null,
      { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(res.status, 404);
  });

  // â”€â”€ Wallet: Withdrawal (flat 10% fee) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Fund the wallet first so the 100 USD gross withdrawal can be approved.
  await ok('setup: fund wallet with a credited deposit for withdrawal', async function () {
    var dep = await httpRequest(server, 'POST', '/api/wallet/deposit', {
      amount: 200, coin: 'btc'
    }, { Authorization: 'Bearer ' + phoneUser.token });
    var raw = Buffer.from(JSON.stringify({ event: 'invoice.paid', status: 'PAID', invoice_id: dep.body.reference }));
    var sig = crypto.createHmac('sha256', process.env.WOLVPAY_WEBHOOK_SECRET).update(raw).digest('hex');
    var wh = await httpRequest(server, 'POST', '/api/webhooks/wolvpay', raw, { 'x-wolvpay-signature': sig });
    assert.strictEqual(wh.body, 'credited');
  });

  var withdrawRef;
  await ok('POST /wallet/withdraw deducts 10% fee, stores gross/fee/net', async function () {
    var res = await httpRequest(server, 'POST', '/api/wallet/withdraw', {
      amount: 100, coin: 'BTC', address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p8a5qw0x0s0s0'
    }, { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.gross, 100);
    assert.strictEqual(res.body.fee, 10);
    assert.strictEqual(res.body.net, 90);
    withdrawRef = res.body.txn.reference;
    var me = await httpRequest(server, 'GET', '/api/auth/me', null,
      { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(me.body.user.wallet_balance, 151, '51 + 200 - 100');
    assert.strictEqual(me.body.user.total_withdrawn, 100);
  });

  await ok('withdraw below USD 30 minimum is rejected', async function () {
    var res = await httpRequest(server, 'POST', '/api/wallet/withdraw', {
      amount: 20, coin: 'BTC', address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p8a5qw0x0s0s0'
    }, { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(res.status, 400);
    assert.ok(/minimum/i.test(res.body.error));
  });

  await ok('withdraw without auth â†’ 401', async function () {
    var res = await httpRequest(server, 'POST', '/api/wallet/withdraw', {
      amount: 100, coin: 'BTC', address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p8a5qw0x0s0s0'
    });
    assert.strictEqual(res.status, 401);
  });

  await ok('manual settlement closes the pending withdrawal exactly once', async function () {
    var setupMocks = require('./setupMocks');
    var r1 = await setupMocks.realWolvpay.settleManualWithdrawal(setupMocks.mockPool, withdrawRef);
    assert.strictEqual(r1.settled, true);
    var r2 = await setupMocks.realWolvpay.settleManualWithdrawal(setupMocks.mockPool, withdrawRef);
    assert.strictEqual(r2.settled, false);
  });

  await ok('GET /wallet/transactions returns deposit + withdrawal history', async function () {
    var res = await httpRequest(server, 'GET', '/api/wallet/transactions', null,
      { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(res.status, 200);
    var types = res.body.transactions.map(function (t) { return t.type; });
    assert.ok(types.indexOf('deposit') !== -1);
    assert.ok(types.indexOf('withdrawal') !== -1);
  });

  await ok('GET /wallet/coins returns only merchant-enabled cryptocurrencies', async function () {
    var res = await httpRequest(server, 'GET', '/api/wallet/coins', null,
      { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(res.status, 200);
    var coins = res.body.coins;
    var ids = coins.map(function (c) { return c.coin; });
    // Enabled by the test whitelist (WOLVPAY_ENABLED_COINS=btc,usdt).
    assert.ok(ids.indexOf('btc') !== -1);
    assert.ok(ids.indexOf('usdt') !== -1);
    // ltc is a WolvPay coin but NOT in the merchant whitelist.
    assert.ok(ids.indexOf('ltc') === -1, 'non-whitelisted coins are hidden');
    // Every coin carries a friendly display label.
    coins.forEach(function (c) {
      assert.ok(c.label, 'coin ' + c.coin + ' has a label');
    });
  });

  await ok('deposit with a non-enabled coin is rejected', async function () {
    var res = await httpRequest(server, 'POST', '/api/wallet/deposit', {
      amount: 50, coin: 'ltc'
    }, { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(res.status, 400);
  });

  // â”€â”€ Bots: list / active / purchase â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  await ok('GET /bots returns the 9 investment levels', async function () {
    var res = await httpRequest(server, 'GET', '/api/bots', null,
      { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.bots.length, 9);
    assert.strictEqual(res.body.bots[8].tier, 'GODFATHER');
  });

  await ok('GET /bots/active is null before any purchase', async function () {
    var res = await httpRequest(server, 'GET', '/api/bots/active', null,
      { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.active, null);
  });

  var botId1;
  await ok('GET /bots first level id is captured for purchase', async function () {
    var res = await httpRequest(server, 'GET', '/api/bots', null,
      { Authorization: 'Bearer ' + phoneUser.token });
    botId1 = res.body.bots[0].id;
    assert.ok(botId1 > 0);
  });

  // Give the user enough balance to buy Level 1 (USD 20).
  await ok('setup: fund user via a credited deposit', async function () {
    var dep = await httpRequest(server, 'POST', '/api/wallet/deposit', {
      amount: 100, coin: 'btc'
    }, { Authorization: 'Bearer ' + phoneUser.token });
    var raw = Buffer.from(JSON.stringify({ event: 'invoice.paid', status: 'PAID', invoice_id: dep.body.reference }));
    var sig = crypto.createHmac('sha256', process.env.WOLVPAY_WEBHOOK_SECRET).update(raw).digest('hex');
    var wh = await httpRequest(server, 'POST', '/api/webhooks/wolvpay', raw, { 'x-wolvpay-signature': sig });
    assert.strictEqual(wh.body, 'credited');
  });

  await ok('POST /bots/purchase buys Level 1 at exactly USD 20', async function () {
    var res = await httpRequest(server, 'POST', '/api/bots/purchase', {
      bot_id: botId1, amount: 20
    }, { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.bot.bot_name, 'Level 1');
    assert.strictEqual(res.body.bot.status, 'active');
  });

  await ok('POST /bots/purchase rejects a second active level', async function () {
    var res = await httpRequest(server, 'POST', '/api/bots/purchase', {
      bot_id: botId1, amount: 20
    }, { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(res.status, 400);
    assert.ok(/active level/i.test(res.body.error));
  });

  await ok('POST /bots/purchase rejects wrong amount', async function () {
    var res = await httpRequest(server, 'POST', '/api/bots/purchase', {
      bot_id: botId1 + 1, amount: 50
    }, { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(res.status, 400);
    assert.ok(/exactly/i.test(res.body.error));
  });

  await ok('GET /bots/active now returns the purchased level', async function () {
    var res = await httpRequest(server, 'GET', '/api/bots/active', null,
      { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.active);
    assert.strictEqual(res.body.active.bot_name, 'Level 1');
  });

  // â”€â”€ Matured level payout lands in transaction history â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  await ok('matured level releases earnings + records an earnings transaction', async function () {
    var setupMocks = require('./setupMocks');
    var tables = setupMocks.mockPool._tables;
    function dstr(offset) {
      var d = new Date();
      d.setDate(d.getDate() + offset);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    var urow = tables.users.find(function (u) { return u.id === phoneUser.user.id; });

    // Baseline wallet BEFORE the overdue bot exists or anything can release.
    // (This call also settles any day-credit for the real bot without
    // releasing - its lock period hasn't ended yet.)
    var before = await httpRequest(server, 'GET', '/api/auth/me', null,
      { Authorization: 'Bearer ' + phoneUser.token });
    var walletBefore = Number(before.body.user.wallet_balance);
    // Neutralise any pending accrual the baseline run made so the released
    // amount comes solely from the crafted overdue bot.
    if (urow) urow.pending_earnings = 0;

    // Craft an overdue second bot directly in the mock DB:
    // bought at USD 20 (3%/day), lock ended yesterday, last credited 2 days ago.
    var overdue = {
      id: tables.user_bots.length ? Math.max.apply(null, tables.user_bots.map(function (b) { return b.id; })) + 1 : 1,
      user_id: phoneUser.user.id,
      bot_id: botId1,
      amount: 20,
      started_at: dstr(-25),
      started_at_ts: new Date(Date.now() - 25 * 864e5).toISOString(),
      ends_at: dstr(-1),
      next_earning_date: dstr(-2),
      status: 'active'
    };
    tables.user_bots.push(overdue);

    // Any authenticated page load runs processDailyEarnings â†’ releases.
    var me = await httpRequest(server, 'GET', '/api/auth/me', null,
      { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(me.status, 200);
    var walletAfter = Number(me.body.user.wallet_balance);

    // Level 1: USD 20 * 3% = USD 0.60/day; 2 due days capped by lock end = 2 days.
    var expectedRelease = 1.2;
    assert.strictEqual(Math.round((walletAfter - walletBefore) * 100) / 100, expectedRelease,
      'wallet grows by exactly the released amount');

    var txns = await httpRequest(server, 'GET', '/api/wallet/transactions', null,
      { Authorization: 'Bearer ' + phoneUser.token });
    var payouts = txns.body.transactions.filter(function (t) { return t.type === 'earnings'; });
    assert.strictEqual(payouts.length, 1, 'exactly one earnings payout recorded');
    assert.strictEqual(Number(payouts[0].amount), expectedRelease);
    assert.strictEqual(payouts[0].method, 'Level 1', 'tagged with the level tier');
    assert.strictEqual(payouts[0].status, 'success');

    // The overdue bot is now completed; the real purchase remains active.
    var active = await httpRequest(server, 'GET', '/api/bots/active', null,
      { Authorization: 'Bearer ' + phoneUser.token });
    assert.ok(active.body.active);
    assert.notStrictEqual(active.body.active.id, overdue.id);
  });

  // â”€â”€ Tasks â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  await ok('GET /tasks returns all six tasks with condition flags', async function () {
    var res = await httpRequest(server, 'GET', '/api/tasks', null,
      { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.tasks.length >= 6);
  });

  await ok('claim has_deposit task succeeds (deposit exists)', async function () {
    var list = await httpRequest(server, 'GET', '/api/tasks', null,
      { Authorization: 'Bearer ' + phoneUser.token });
    var t = list.body.tasks.find(function (x) { return x.condition === 'has_deposit'; });
    var res = await httpRequest(server, 'POST', '/api/tasks/' + t.id + '/claim', null,
      { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.reward, 0.3);
  });

  await ok('claim duplicate task is rejected', async function () {
    var list = await httpRequest(server, 'GET', '/api/tasks', null,
      { Authorization: 'Bearer ' + phoneUser.token });
    var t = list.body.tasks.find(function (x) { return x.condition === 'has_deposit'; });
    var res = await httpRequest(server, 'POST', '/api/tasks/' + t.id + '/claim', null,
      { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(res.status, 400);
    assert.ok(/already completed/i.test(res.body.error));
  });

  await ok('claim simple (condition=claim) task succeeds', async function () {
    var list = await httpRequest(server, 'GET', '/api/tasks', null,
      { Authorization: 'Bearer ' + phoneUser.token });
    var t = list.body.tasks.find(function (x) { return x.condition === 'claim'; });
    var res = await httpRequest(server, 'POST', '/api/tasks/' + t.id + '/claim', null,
      { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(res.status, 200);
  });

  // â”€â”€ Settings â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  await ok('PUT /settings/currency switches display currency', async function () {
    var res = await httpRequest(server, 'PUT', '/api/settings/currency',
      { currency: 'NGN' }, { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.currency, 'NGN');
  });

  await ok('PUT /settings/currency rejects unsupported code', async function () {
    var res = await httpRequest(server, 'PUT', '/api/settings/currency',
      { currency: 'XYZ' }, { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(res.status, 400);
  });

  await ok('PUT /settings/profile updates display name', async function () {
    var res = await httpRequest(server, 'PUT', '/api/settings/profile',
      { name: 'Test Nairobi' }, { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.name, 'Test Nairobi');
  });

  await ok('PUT /settings/password changes password', async function () {
    var res = await httpRequest(server, 'PUT', '/api/settings/password', {
      current_password: 'pass1234', new_password: 'newpass5678'
    }, { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(res.status, 200);
  });

  await ok('login works with the new password after change', async function () {
    var res = await doLogin(phoneUser.phone, 'newpass5678');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.token);
  });

  // â”€â”€ Team & Referral flow â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  var refCode;
  await ok('GET /team returns referral code, rules and claimable balance', async function () {
    var res = await httpRequest(server, 'GET', '/api/team', null,
      { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(res.status, 200);
    refCode = res.body.referral_code;
    assert.ok(refCode);
    // Simple English rules the frontend renders from.
    assert.deepStrictEqual(res.body.rules,
      { signup_bonus_usd: 0.01, confirmed_bonus_usd: 2, claim_min_usd: 30 });
    assert.ok(typeof res.body.claimable_usd === 'number');
    assert.strictEqual(res.body.can_claim, false, 'nothing to claim yet');
    assert.strictEqual(res.body.claim_progress, 0);
  });

  var friendToken;
  await ok('second account registers with the referral code', async function () {
    var phone2 = '+256771' + String(Math.floor(Math.random() * 9000000) + 1000000);
    var res = await httpRequest(server, 'POST', '/api/auth/register', {
      identifier: phone2, password: 'friend12', referral_code: refCode
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    friendToken = res.body.token;
  });

  await ok('referrer now shows 1 referral (not yet valid)', async function () {
    var res = await httpRequest(server, 'GET', '/api/team', null,
      { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(res.body.referral_count, 1);
    assert.strictEqual(res.body.valid_referral_count, 0);
    // Signup bonus sits in referral_pending: USD 0.01, not claimable yet.
    assert.strictEqual(res.body.claimable_usd, 0.01, 'signup bonus is pending, not in the wallet');
    assert.strictEqual(res.body.can_claim, false);
    assert.strictEqual(res.body.claim_progress, 0);
    // Per-referral bonus reflects the member's state ($0.01 / $2).
    assert.strictEqual(res.body.referrals[0].bonus, 0.01);
    assert.strictEqual(res.body.referrals[0].is_valid, false);
  });

  await ok('friend deposits; referrer is topped up to the USD 2 confirmed bonus', async function () {
    var dep = await httpRequest(server, 'POST', '/api/wallet/deposit', {
      amount: 100, coin: 'btc'
    }, { Authorization: 'Bearer ' + friendToken });
    var raw = Buffer.from(JSON.stringify({ event: 'invoice.paid', status: 'PAID', invoice_id: dep.body.reference }));
    var sig = crypto.createHmac('sha256', process.env.WOLVPAY_WEBHOOK_SECRET).update(raw).digest('hex');
    var wh = await httpRequest(server, 'POST', '/api/webhooks/wolvpay', raw, { 'x-wolvpay-signature': sig });
    assert.strictEqual(wh.body, 'credited');

    // Referrer ends at USD 2 total (0.01 at signup + 1.99 top-up), NOT a
    // percentage of the deposit.
    var me = await httpRequest(server, 'GET', '/api/auth/me', null,
      { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(me.body.user.team_income, 2, 'flat USD 2 total');
    assert.strictEqual(me.body.user.referral_pending, 2, 'claimable once it reaches the minimum');

    var team = await httpRequest(server, 'GET', '/api/team', null,
      { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(team.body.valid_referral_count, 1);
    assert.strictEqual(team.body.claimable_usd, 2);
    assert.strictEqual(team.body.can_claim, false, 'USD 2 is still below the USD 30 minimum');
    assert.strictEqual(team.body.claim_progress, Math.round((2 / 30) * 100));
    assert.strictEqual(team.body.referrals[0].bonus, 2);
    assert.strictEqual(team.body.referrals[0].is_valid, true);
  });

  await ok('POST /team/claim is refused below the USD 30 minimum', async function () {
    var res = await httpRequest(server, 'POST', '/api/team/claim', null,
      { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(res.status, 400);
    assert.ok(/USD 30/.test(res.body.error), 'friendly threshold message: ' + JSON.stringify(res.body));
    // Nothing moved into the wallet.
    var me = await httpRequest(server, 'GET', '/api/auth/me', null,
      { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(me.body.user.referral_pending, 2, 'pending balance untouched');
  });

  await ok('POST /team/claim moves the balance to the wallet at >= USD 30', async function () {
    // Top the pending balance up past the threshold directly in the mock DB.
    var setupMocks = require('./setupMocks');
    var urow = setupMocks.mockPool._tables.users.find(function (u) { return u.id === phoneUser.user.id; });
    assert.ok(urow, 'referrer row exists');
    urow.referral_pending = 35;

    var before = await httpRequest(server, 'GET', '/api/auth/me', null,
      { Authorization: 'Bearer ' + phoneUser.token });
    var walletBefore = Number(before.body.user.wallet_balance);

    var res = await httpRequest(server, 'POST', '/api/team/claim', null,
      { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.claimed_usd, 35);

    var after = await httpRequest(server, 'GET', '/api/auth/me', null,
      { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(Number(after.body.user.wallet_balance), walletBefore + 35, 'money landed in the wallet');
    assert.strictEqual(Number(after.body.user.referral_pending), 0, 'pending balance cleared');

    // The claim shows up in history as a referral_claim transaction.
    var txn = setupMocks.mockPool._tables.transactions.find(function (t) {
      return t.user_id === phoneUser.user.id && t.type === 'referral_claim';
    });
    assert.ok(txn, 'referral_claim transaction recorded');
    assert.strictEqual(Number(txn.amount), 35);

    // A second claim right away has nothing left to move.
    var again = await httpRequest(server, 'POST', '/api/team/claim', null,
      { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(again.status, 400, 'no double claim');
  });

  // â”€â”€ Home dashboard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  await ok('GET /home returns user + active bot + valid referrals', async function () {
    var res = await httpRequest(server, 'GET', '/api/home', null,
      { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.user);
    assert.ok(res.body.active_bot, 'active level present');
    assert.strictEqual(res.body.valid_referrals, 1);
  });

  // â”€â”€ Account deletion â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  await ok('DELETE /settings/account with wrong identifier â†’ 400', async function () {
    var res = await httpRequest(server, 'DELETE', '/api/settings/account',
      { identifier: 'nobody@nowhere.com' }, { Authorization: 'Bearer ' + friendToken });
    assert.strictEqual(res.status, 400);
  });

  await ok('DELETE /settings/account deletes the account and revokes token', async function () {
    var phone3 = '+254799' + String(Math.floor(Math.random() * 9000000) + 1000000);
    var reg = await httpRequest(server, 'POST', '/api/auth/register', {
      identifier: phone3, password: 'deletepw'
    });
    var tok = reg.body.token;
    var res = await httpRequest(server, 'DELETE', '/api/settings/account',
      { identifier: phone3 }, { Authorization: 'Bearer ' + tok });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    var me = await httpRequest(server, 'GET', '/api/auth/me', null,
      { Authorization: 'Bearer ' + tok });
    assert.strictEqual(me.status, 404, 'deleted account lookup fails');
  });

  // â”€â”€ Security headers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  await ok('security headers present on responses', async function () {
    var res = await httpRequest(server, 'GET', '/api/health');
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(res.headers['x-frame-options'], 'DENY');
  });

  // â”€â”€ Brute force & bot prevention â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Reset guard state so these tests start with a clean slate, then verify
  // each protection layer in isolation. Must run LAST (consumes IP budget).
  var guardMod = require('../lib/authGuard');
  guardMod.resetAll();

  await ok('login without a challenge is rejected', async function () {
    var res = await httpRequest(server, 'POST', '/api/auth/login', {
      identifier: phoneUser.phone, password: 'pass1234'
    });
    assert.strictEqual(res.status, 400);
    assert.ok(/security check/i.test(res.body.error));
  });

  await ok('login with a bogus challenge id is rejected', async function () {
    var res = await httpRequest(server, 'POST', '/api/auth/login', {
      identifier: phoneUser.phone, password: 'pass1234',
      challenge_id: 'deadbeefdeadbeefdeadbeef', pow: '1'
    });
    assert.strictEqual(res.status, 400);
    assert.ok(/security check/i.test(res.body.error));
  });

  await ok('login with an unsolved proof-of-work nonce is rejected', async function () {
    var ch = await solveChallenge();
    var res = await httpRequest(server, 'POST', '/api/auth/login', {
      identifier: phoneUser.phone, password: 'pass1234',
      challenge_id: ch.challenge_id, pow: '999999999'
    });
    assert.strictEqual(res.status, 400);
    assert.ok(/security check/i.test(res.body.error));
  });

  await ok('honeypot field silently rejects bots like a wrong password', async function () {
    var res = await doLogin(phoneUser.phone, 'pass1234', { website: 'http://spam.example' });
    assert.strictEqual(res.status, 400);
    assert.ok(/incorrect password/i.test(res.body.error), 'must be indistinguishable from wrong password');
  });

  var lockUser = {};
  await ok('setup: fresh user for the lockout test', async function () {
    await registerPhoneUser(lockUser);
  });

  await ok('account locks after repeated wrong passwords', async function () {
    // Attempts 1-4 return "Incorrect password".
    for (var i = 1; i <= 4; i++) {
      var r = await doLogin(lockUser.phone, 'bad-pass-' + i);
      assert.strictEqual(r.status, 400, 'attempt ' + i);
      assert.ok(/incorrect password/i.test(r.body.error), 'attempt ' + i);
    }
    // Attempt 5 trips the lock immediately.
    var fifth = await doLogin(lockUser.phone, 'bad-pass-5');
    assert.strictEqual(fifth.status, 429, JSON.stringify(fifth.body));
    assert.ok(/too many attempts/i.test(fifth.body.error));

    // Even the CORRECT password is refused while locked.
    var locked = await doLogin(lockUser.phone, 'pass1234');
    assert.strictEqual(locked.status, 429);
  });

  await ok('successful login clears the failure counter', async function () {
    // phoneUser had 0 recorded failures; prove success resets by failing once,
    // succeeding, then failing once more without tripping the lock.
    var f = await doLogin(phoneUser.phone, 'nope');
    assert.strictEqual(f.status, 400);
    var s = await doLogin(phoneUser.phone, 'newpass5678');
    assert.strictEqual(s.status, 200);
    var f2 = await doLogin(phoneUser.phone, 'nope');
    assert.strictEqual(f2.status, 400, 'counter must have been reset, not accumulated');
  });

  await ok('per-IP rate limit caps rapid-fire login attempts', async function () {
    guardMod.resetAll(); // clean budget so this test controls its own counting
    var sawThrottle = false;
    for (var i = 0; i < 40; i++) {
      var r = await httpRequest(server, 'POST', '/api/auth/login', {
        identifier: '+2545' + String(1000000 + i) , password: 'x',
        challenge_id: 'flood', pow: '0'
      });
      if (r.status === 429) { sawThrottle = true; break; }
      assert.strictEqual(r.status, 400, 'unexpected status at attempt ' + i + ': ' + JSON.stringify(r.body));
    }
    assert.ok(sawThrottle, 'expected a 429 within the IP budget');
    // Once throttled, even a fully valid flow is refused.
    var sol = await solveChallenge();
    var still = await httpRequest(server, 'POST', '/api/auth/login', {
      identifier: phoneUser.phone, password: 'newpass5678',
      challenge_id: sol.challenge_id, pow: sol.pow
    });
    assert.strictEqual(still.status, 429);
  });

  // ── Public coin catalogue (deposit + withdrawal share one list) ──────────
  await ok('GET /wallet/coins is public and only lists enabled coins', async function () {
    // No Authorization header on purpose: the picker must work pre-auth.
    var res = await httpRequest(server, 'GET', '/api/wallet/coins');
    assert.strictEqual(res.status, 200);
    var codes = res.body.coins.map(function (c) { return c.coin; });
    assert.deepStrictEqual(codes.slice().sort(), ['btc', 'usdt']);
    // ltc exists at WolvPay but is NOT in WOLVPAY_ENABLED_COINS.
    assert.ok(codes.indexOf('ltc') === -1, 'disabled coin must be hidden');
    assert.ok(res.body.coins.every(function (c) { return !!c.label; }), 'every coin has a label');
  });

  await ok('withdraw rejects a coin the merchant cannot pay out', async function () {
    var res = await httpRequest(server, 'POST', '/api/wallet/withdraw', {
      amount: 100, coin: 'ltc', address: 'LTc9xValidLookingAddress123'
    }, { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.ok(/cannot be paid out/i.test(res.body.error));
  });

  await ok('withdraw accepts an enabled coin and stores its pretty label', async function () {
    // Earlier tests switch this account's display currency around, so pin it to
    // USD first: amounts are entered in the member's display currency and the
    // USD-30 minimum is checked after conversion.
    var sw = await httpRequest(server, 'PUT', '/api/settings/currency',
      { currency: 'USD' }, { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(sw.status, 200);

    var dep = await httpRequest(server, 'POST', '/api/wallet/deposit', {
      amount: 200, coin: 'btc'
    }, { Authorization: 'Bearer ' + phoneUser.token });
    var raw = Buffer.from(JSON.stringify({ event: 'invoice.paid', status: 'PAID', invoice_id: dep.body.reference }));
    var sig = crypto.createHmac('sha256', process.env.WOLVPAY_WEBHOOK_SECRET).update(raw).digest('hex');
    var wh = await httpRequest(server, 'POST', '/api/webhooks/wolvpay', raw, { 'x-wolvpay-signature': sig });
    assert.strictEqual(wh.body, 'credited');

    var res = await httpRequest(server, 'POST', '/api/wallet/withdraw', {
      amount: 100, coin: 'usdt', address: 'TXkQ9ValidLookingAddress987654'
    }, { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.txn.status, 'pending');
    assert.strictEqual(res.body.gross, 100);
    assert.strictEqual(res.body.net, 90);
  });

  // â”€â”€ Admin console: the API must be locked down â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  await ok('admin API rejects unauthenticated requests', async function () {
    for (const path of ['/api/admin/overview', '/api/admin/members', '/api/admin/payouts']) {
      var res = await httpRequest(server, 'GET', path);
      assert.strictEqual(res.status, 401, path + ' must require a token');
    }
  });

  await ok('admin API rejects a normal member token with 403', async function () {
    // phoneUser is an ordinary member (no is_admin), so every admin route
    // must refuse it even though the JWT itself is valid.
    var res = await httpRequest(server, 'GET', '/api/admin/overview', null,
      { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.ok(/administrator/i.test(res.body.error));

    var write = await httpRequest(server, 'POST', '/api/admin/members/1/adjust', {
      amount_usd: 500, note: 'escalation attempt'
    }, { Authorization: 'Bearer ' + phoneUser.token });
    assert.strictEqual(write.status, 403, 'write actions must be guarded too');
  });
  // ── No e-mail verification ───────────────────────────────────────────────
  // Registering with an e-mail must issue a working token immediately: there
  // is no confirmation step, and that token must authenticate straight away.
  await ok('e-mail registration returns a token and signs the member in', async function () {
    // Earlier tests deliberately exhaust the per-IP attempt budget, so clear
    // the guard's counters before exercising a fresh signup.
    require('../lib/authGuard').resetAll();
    var email = 'direct' + Date.now() + '@example.com';
    var reg = await httpRequest(server, 'POST', '/api/auth/register', {
      identifier: email, password: 'emailpass12', currency: 'USD'
    });
    assert.strictEqual(reg.status, 200, JSON.stringify(reg.body));
    assert.ok(reg.body.token, 'registration must return a token immediately');
    assert.strictEqual(reg.body.requires_verification, undefined, 'no verification flag');
    assert.strictEqual(reg.body.user.email, email);
    assert.strictEqual(reg.body.user.email_verified, undefined, 'email_verified is gone');

    // That token must work with no confirmation round-trip.
    var me = await httpRequest(server, 'GET', '/api/auth/me', null,
      { Authorization: 'Bearer ' + reg.body.token });
    assert.strictEqual(me.status, 200, JSON.stringify(me.body));

    // And the same credentials must log in on the first attempt (no challenge
    // round-trip, no confirmation step).
    require('../lib/authGuard').resetAll();
    var login = await doLogin(email, 'emailpass12');
    assert.ok(login.body.token, 'e-mail login must not be blocked by verification: ' + JSON.stringify(login.body));
  });

  await ok('the verify-email endpoint no longer exists', async function () {
    var res = await httpRequest(server, 'POST', '/api/auth/verify-email', { token: 'anything' });
    assert.strictEqual(res.status, 404, JSON.stringify(res.body));
  });

  console.log('\nAll ' + pass + ' integration tests passed.');
  server.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(function (e) {
  console.error('Integration harness error:', e && e.stack ? e.stack : e);
  if (server) server.close();
  process.exit(1);
});
