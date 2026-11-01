# Payments (WolvPay - cryptocurrency)

afrocoinmoney is a **strictly-cryptocurrency** platform. All wallet funding is done
through [WolvPay](https://wolvpay.com/docs) - an invoice-based crypto payment processor.
There is **no mobile money (MTN / Airtel) anywhere**. Members pay a wallet deposit by
paying a crypto invoice in BTC / LTC / USDT (and WolvPay's supported coins), then the
wallet is credited only after WolvPay confirms the payment.

The provider keys are **server-side only** and never sent to the browser.

## How a deposit works

1. The customer opens Profile → Deposit, picks their coin (**BTC**, **LTC**, **USDT**,
   etc.) and an amount. The minimum deposit is **USD 10** (checked in the member's
   local currency equivalent).
2. `POST /api/wallet/deposit` (authenticated) validates the amount, then calls
   `lib/wolvpay.js#createInvoice(...)` to create a WolvPay **crypto invoice** for the
   USD-equivalent amount. `lib/currency.js#invoiceAmount` invoices natively in a
   fiat WolvPay supports, otherwise in USD.
3. The invoice row is recorded in `transactions` with `status='pending'` and the
   WolvPay invoice id as `reference`. **The wallet is NOT credited here** - that only
   happens on a verified confirmation.
4. The customer is redirected to WolvPay's hosted payment page (or shown the crypto
   address / QR to pay manually).
5. WolvPay POSTs a signed webhook to `/api/webhooks/wolvpay` when the status changes.
6. The webhook verifies the `x-wolvpay-signature` HMAC against the raw body, looks up
   the pending transaction by invoice id, and - idempotently - credits the wallet via
   `creditSuccessfulDeposit()` only when the invoice is `PAID`. `UNDERPAID` /
   `EXPIRED` mark the deposit `failed`.

The frontend polls `GET /api/wallet/deposit/:reference/status` as a fallback so the
wallet updates even if a webhook is delayed.

> Deposits were previously faked (instant success + instant credit). They are now real,
> **asynchronous** collections: success only comes after WolvPay confirms `PAID`.

## How a withdrawal works

WolvPay exposes **no automated payout API**, so withdrawals to a customer's crypto
wallet are settled manually by the treasury to the address they provide. The request
itself is enforced on the server:

1. The customer opens **Profile → Withdraw**, picks the **coin** and a **crypto wallet
   address** (15-120 alphanumeric/`_`/`-` chars). The minimum withdrawal is **USD 30**,
   mentioned only if a lower amount is attempted.
2. The wallet is **debited immediately** inside a transaction (`FOR UPDATE` to stop
   double-spend) for the gross amount, and a `withdrawal` transaction row is inserted
   as `pending`.
3. The gross amount is reduced by the flat **10% withdrawal fee**: requesting USD 100
   debits USD 100 but processes USD 90 (`net_amount = amount − fee`, both stored on the
   row).
4. The team then pays out the `net_amount` in the chosen coin to the address. Full
   user-facing credit happens when Treasury marks the row `success`; a cancelled/failed
   payout refunds the gross back to the wallet.

## Idempotency (no double crediting)

Two independent guards prevent double crediting:

1. `webhookAction(txnStatus, status)` returns `'ignore'` once a deposit is terminal
   (`success` + `PAID`, `failed` + `UNDERPAID`/`EXPIRED`, etc.).
2. `creditSuccessfulDeposit()` only `UPDATE`s a row `WHERE status='pending'
   RETURNING *` - the first caller wins, every later caller gets `rowCount=0` and a
   no-op.

## Environment variables

| Variable | Purpose |
| -------- | ------- |
| `WOLVPAY_API_KEY` | WolvPay server API key (`wlov_live_…`). |
| `WOLVPAY_WEBHOOK_SECRET` | Webhook signing secret (dashboard > Webhooks). Used to verify `x-wolvpay-signature`. |
| `WOLVPAY_BASE_URL` | Optional API base override (defaults to `https://wolvpay.com/api/v1`). |
| `WOLVPAY_ENABLED_COINS` | Comma-separated WolvPay coin identifiers this merchant's wallets can receive (e.g. `btc,eth,erc20_usdc,sol_usdc,erc20_usdt,sol_usdt,trc20_usdt`). Only these appear in the deposit picker and are accepted on deposit; others are hidden and rejected with 400. Omit to offer every coin WolvPay supports. |
| `MIN_DEPOSIT_USD` | Minimum deposit in USD (default 10). |
| `MIN_WITHDRAW_USD` | Minimum withdrawal in USD (default 30). |
| `WITHDRAW_FEE_PERCENT` | Flat fee % taken from each withdrawal (default 10). |

These are read in `lib/wolvpay.js` / `routes/wallet.js` only.

## Webhook configuration (manual step)

1. Register the public URL `https://<your-domain>/api/webhooks/wolvpay` in the WolvPay
   dashboard (use **ngrok** during local development - WolvPay cannot reach
   `localhost`).
2. Set the signing secret to the same value as `WOLVPAY_WEBHOOK_SECRET` - the server
   compares it to the `x-wolvpay-signature` header, so the two must match.
3. The endpoint acknowledges every **verified** event with HTTP 200 - even unknown
   references - so WolvPay stops retrying. A signature mismatch returns **401**; a
   missing signing secret returns **500 misconfigured** until the env is fixed.

> Netlify: the webhook route must be mounted with `express.raw` so the signature is
> verified against the exact bytes (see `server.js`). On a production VPS this is
> already wired up.

## Manual sandbox / live verification

`npm test` covers the pure decision logic with **mocks** - it does not hit the live
WolvPay network (live keys are not available in CI). To verify end-to-end once a
database is connected:

1. Set `WOLVPAY_API_KEY` and `WOLVPAY_WEBHOOK_SECRET` in `.env`, then `npm start`.
2. As an authenticated user, `POST /api/wallet/deposit` with the coin and a USD 10+
   amount. Expect `{ success: true, reference, status: 'pending', invoice_url, ... }`.
3. Confirm `transactions.status='pending'` and `wallet_balance` is **unchanged**.
4. Complete the payment on the hosted page, or POST a signed `PAID` webhook to
   `/api/webhooks/wolvpay`. Expect `200 credited` and the wallet credited **once**.
   A second identical webhook returns `200 ignored` (no double credit).

> Note: to send the webhook to your local dev box, expose the route with a signing
> secret that matches Wolv's dashboard. The ngrok auth token you provided is intended
> for exactly this step.