// Live smoke check of the referral flow against the running server.
'use strict';
const http = require('http');

function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ hostname: 'localhost', port: 3001, path, method, headers }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        let j; try { j = JSON.parse(b); } catch (e) { j = b; }
        resolve({ status: res.statusCode, body: j });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const stamp = Date.now().toString().slice(-7);

(async function () {
  // 1. Register a referrer.
  const ref = await req('POST', '/api/auth/register',
    { identifier: '+' + (256700000000 + Number(stamp)), password: 'smoketest12' });
  console.log('1. referrer register:', ref.status, ref.body.token ? 'token ok' : JSON.stringify(ref.body));
  const refToken = ref.body.token;
  console.log('   referral_pending at signup:', ref.body.user.referral_pending);

  // 2. Register a friend with that code.
  const friend = await req('POST', '/api/auth/register',
    { identifier: '+' + (256770000000 + Number(stamp)), password: 'smoketest12',
      referral_code: ref.body.user.referral_code });
  console.log('2. friend register:', friend.status, friend.body.token ? 'token ok' : JSON.stringify(friend.body));

  // 3. Team payload shape + the USD 0.01 pending bonus.
  const team = await req('GET', '/api/team', null, refToken);
  console.log('3. GET /api/team:', team.status);
  console.log('   rules:', JSON.stringify(team.body.rules));
  console.log('   claimable_usd:', team.body.claimable_usd, 'can_claim:', team.body.can_claim,
    'progress:', team.body.claim_progress);
  console.log('   referrals[0]:', JSON.stringify(team.body.referrals && team.body.referrals[0]));

  // 4. Claim below the USD 30 minimum must fail.
  const claimLow = await req('POST', '/api/team/claim', null, refToken);
  console.log('4. claim below minimum:', claimLow.status, JSON.stringify(claimLow.body));

  // 5. /api/home exposes referral_pending + the threshold.
  const home = await req('GET', '/api/home', null, refToken);
  console.log('5. GET /api/home:', home.status,
    'referral_pending:', home.body.user && home.body.user.referral_pending,
    'claim_min:', home.body.referral_claim_min);

  // 6. /api/auth/me carries referral_pending.
  const me = await req('GET', '/api/auth/me', null, refToken);
  console.log('6. GET /api/auth/me referral_pending:', me.body.user.referral_pending);

  // 7. Confirm a deposit for the friend -> referrer is topped up to USD 2.
  const dep = await req('POST', '/api/wallet/deposit', { amount: 50, coin: 'btc' }, friend.body.token);
  console.log('7. friend deposit:', dep.status, 'ref:', dep.body.reference);
  if (dep.body.reference) {
    const secret = require('dotenv').config().parsed.WOLVPAY_WEBHOOK_SECRET;
    const raw = Buffer.from(JSON.stringify({ event: 'invoice.paid', status: 'PAID', invoice_id: dep.body.reference }));
    const sig = require('crypto').createHmac('sha256', secret).update(raw).digest('hex');
    const wh = await new Promise((resolve, reject) => {
      const r = http.request({ hostname: 'localhost', port: 3001, method: 'POST',
        path: '/api/webhooks/wolvpay',
        headers: { 'Content-Type': 'application/json', 'x-wolvpay-signature': sig,
          'Content-Length': raw.length } }, (res) => {
        let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(res.statusCode + ' ' + b));
      });
      r.on('error', reject); r.write(raw); r.end();
    });
    console.log('   webhook:', wh);

    const team2 = await req('GET', '/api/team', null, refToken);
    console.log('   after confirm -> team_income:', team2.body.team_income,
      'claimable_usd:', team2.body.claimable_usd,
      'progress:', team2.body.claim_progress + '%',
      'can_claim:', team2.body.can_claim);
    console.log('   referrals[0]:', JSON.stringify(team2.body.referrals && team2.body.referrals[0]));

    const claim2 = await req('POST', '/api/team/claim', null, refToken);
    console.log('   claim at USD 2:', claim2.status, JSON.stringify(claim2.body));
  }

  // 8. Static copy has no third-party mentions.
  const about = await new Promise((resolve, reject) => {
    http.get('http://localhost:3001/about.html', (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(b));
    }).on('error', reject);
  });
  const leaks = ['wolvpay', 'telegram', 't.me/', 'supabase', 'tailadmin']
    .filter((w) => about.toLowerCase().indexOf(w) !== -1);
  console.log('8. about.html third-party leaks:', leaks.length ? leaks.join(',') : 'none');

  // 9. Claim at >= USD 30 moves the money into the wallet (real DB).
  const { pool } = require('../db');
  const refRow = (await pool.query(
    'SELECT id, referral_pending, wallet_balance FROM users WHERE id = $1',
    [ref.body.user.id])).rows[0];
  await pool.query('UPDATE users SET referral_pending = 35 WHERE id = $1', [ref.body.user.id]);
  const beforeWallet = Number(refRow.wallet_balance);
  const claimHigh = await req('POST', '/api/team/claim', null, refToken);
  console.log('9. claim at USD 35:', claimHigh.status, JSON.stringify(claimHigh.body));
  const after = (await pool.query(
    'SELECT referral_pending, wallet_balance FROM users WHERE id = $1',
    [ref.body.user.id])).rows[0];
  console.log('   wallet', beforeWallet, '->', Number(after.wallet_balance),
    '| pending now', Number(after.referral_pending));
  const claimTxn = (await pool.query(
    "SELECT type, amount FROM transactions WHERE user_id = $1 AND type = 'referral_claim'",
    [ref.body.user.id])).rows;
  console.log('   referral_claim txn:', JSON.stringify(claimTxn));
  const claimOk = claimHigh.status === 200 &&
    Number(after.wallet_balance) === beforeWallet + 35 &&
    Number(after.referral_pending) === 0 && claimTxn.length === 1;

  // 10. Clean up the smoke users (transactions/referral_bonuses cascade).
  const del = await pool.query('DELETE FROM users WHERE id = ANY($1::bigint[])',
    [[ref.body.user.id, friend.body.user.id]]);
  console.log('10. cleaned up smoke users:', del.rowCount);
  await pool.end();

  if (refToken && team.body.rules && team.body.rules.claim_min_usd === 30 &&
      claimLow.status === 400 && claimOk && leaks.length === 0) {
    console.log('\nSMOKE OK');
  } else {
    console.log('\nSMOKE FAILED');
    process.exitCode = 1;
  }
}()).catch((e) => { console.error('ERROR', e); process.exitCode = 1; });
