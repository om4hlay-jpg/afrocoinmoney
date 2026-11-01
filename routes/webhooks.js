// routes/webhooks.js
// Incoming-webhook endpoint for WolvPay (https://wolvpay.com/docs).
// Mounted in server.js with express.raw so the HMAC signature is verified
// against the exact bytes WolvPay signed.
'use strict';

const express = require('express');
const { pool } = require('../db');
const wolvpay = require('../lib/wolvpay');
const currencyLib = require('../lib/currency');
const { createNotification } = require('../helpers');

const router = express.Router();
const SECRET_HEADER = wolvpay.WEBHOOK_HEADER; // 'x-wolvpay-signature'

router.post('/wolvpay', async function (req, res) {
  try {
    const signature = req.headers[SECRET_HEADER];
    if (!signature) return res.status(200).send('ignored');

    let secret;
    try {
      secret = wolvpay.webhookSecret();
    } catch (configErr) {
      console.error('WolvPay webhook secret not configured:', configErr.message);
      return res.status(500).send('misconfigured');
    }

    if (!wolvpay.verifyWebhookSignature(req.body, signature, secret)) {
      console.warn('WolvPay webhook rejected: signature mismatch');
      return res.status(401).send('Invalid signature');
    }

    let body;
    try {
      body = wolvpay.normalizeWebhookBody(req.body);
    } catch (parseErr) {
      console.error('WolvPay webhook: invalid JSON body:', parseErr.message);
      return res.status(200).send('ignored');
    }

    const invoiceId = body.invoice_id;
    const invoiceStatus = body.status;
    if (!invoiceId || !invoiceStatus) return res.status(200).send('ignored');

    const txn = (await pool.query(
      "SELECT * FROM transactions WHERE reference = $1 AND type = 'deposit' LIMIT 1",
      [invoiceId]
    )).rows[0];
    if (!txn) return res.status(200).send('ignored');

    const action = wolvpay.webhookAction(txn.status, invoiceStatus);
    if (action === 'ignore') return res.status(200).send('ignored');
    if (action === 'sync') return res.status(200).send('synced');

    if (action === 'credit') {
      const result = await wolvpay.creditSuccessfulDeposit(pool, invoiceId);
      // Record a notification for the successful deposit.
      await createNotification(
        req.user?.id,
        'deposit',
        'Deposit',
        'Deposit of ' + currencyLib.formatLocal(invoiceId.amountUsd, req.user?.currency || 'USD') + ' via ' + invoiceId.method + ' is credited.'
      );
      return res.status(200).send(result.credited ? 'credited' : result.reason);
    }

    await wolvpay.markFailedDeposit(pool, invoiceId);
    return res.status(200).send('marked_failed');
  } catch (error) {
    console.error('WolvPay webhook error:', error);
    return res.status(500).send('error');
  }
});

module.exports = router;