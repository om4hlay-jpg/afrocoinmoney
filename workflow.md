# afrocoinmoney - App Workflow

> Strictly-cryptocurrency HYIP for African markets. Members never need to understand
> crypto - the platform handles everything, they just fund a wallet and pick a level.

## 1. Sign up & currency choice

1. The member opens **register.html** and picks the **display currency** they want to
   work in (UGX, KES, ZAR, GHS, NGN, RWF, TZS, ZMW, ZWD, USD, EUR, GBP, AUD, CAD, CHF,
   CNY, JPY, KRW, PHP, SGD, THB, VND, MYR, IDR, HKD, INR, BRL, MXN, COP, PEN, CLP, ARS,
   UYU, PYG, NIO, BOB, GTQ, CRC, HNL, PAB, LRD). The currency is stored on the account
   and is used for every price, reward and balance display.
2. They register with a phone number **or** e-mail. A **random referral code** is
   generated automatically; if they arrived via `?ref=CODE`, the referrer is linked.
3. Every new account is credited a small **welcome bonus** (USD 2).
4. Currency is shown everywhere through `lib/currency.js` conversions (USD is the base
   storage unit) and can be changed at any time in **Account Settings**.

## 2. Funding the wallet (crypto only - WolvPay)

1. Profile → **Deposit**: pick a coin (BTC / LTC / USDT / … from WolvPay's list) and an
   amount. **Minimum deposit: USD 10**.
2. `POST /api/wallet/deposit` creates a signed **WolvPay crypto invoice**
   (`lib/wolvpay.js#createInvoice`). The transaction row is `pending`; the wallet is
   **not** credited yet.
3. The member pays on WolvPay's hosted page with the coin directly (no mobile money).
4. WolvPay's signed webhook (`/api/webhooks/wolvpay`) credits the wallet **once**
   (`creditSuccessfulDeposit`, idempotent). The front-end also polls the invoice status
   as a fallback.
5. A verified successful deposit also credits the referrer's **5% team commission**
   on a referral's first deposit.

## 3. Choosing an investment level

1. The **Levels** page lists the 9 fixed-price levels (Level 1 USD 20 → GODFATHER
   USD 5,000) with their daily rate and lock period. All prices are stored in USD and
   shown in the member's currency.
2. The member selects a level and confirms the purchase with exactly its price
   (`POST /api/bots/purchase`).
3. The wallet is debited, and a `user_bots` row becomes their **active** level
   (**one active level per member**). Earnings start ticking from the exact purchase
   timestamp (`started_at_ts`).

## 4. Earning daily

1. **Realtime ticker**: the home screen shows a per-second earnings counter computed
   from `started_at_ts` × `daily_percent` / 86400000 - the longer the level has run,
   the more it shows, in real time.
2. **Settlement**: daily earnings are settled by `processDailyEarnings()` any time the
   member loads the app or buys/withdraws; the background worker (`lib/cron.js`)
   guarantees every active level is paid every day even if nobody logs in.
3. When the **lock period** ends the level is marked completed; the member can then
   buy a new (higher) level with their earnings.

## 5. Tasks (instant rewards)

1. The home screen lists small tasks (join Telegram, complete profile, first deposit,
   first level, first referral). Rewards are **USD 0.01 - 0.30**.
2. Incomplete tasks show their green reward ("+$0.30"); completed-and-ready tasks get a
   **green border**. Claims are verified server-side (`POST /api/tasks/:id/claim`) and
   credit the wallet instantly.

## 6. Referrals & team

1. The **Team** page shows the member's random referral link/code, team size, valid
   referrals and their commission rate (5%, doubling to **10%** after 100 valid
   referrals - an invited member counts once they make a deposit).
2. Every verified first deposit by a referral triggers the commission payout.

## 7. Withdrawing

1. Profile → **Withdraw**: pick a coin and a crypto wallet address. **Minimum
   withdrawal: USD 30** (only mentioned at validation).
2. The wallet is debited immediately (gross), and a **10% fee** is applied
   automatically - requesting USD 100 processes USD 90 (`fee` + `net_amount` stored).
3. The request sits as `pending` and the treasury pays the `net_amount` to the address.

## 8. Administration & monitoring

1. Any admin opens the database to mark a manual payout `success` (or refund + `failed`
   on a bounced payout - which restores the gross to the wallet).
2. The dashboard `/api/stats` + live feed keep the home screen's **social proof**
   counters and transaction ticker running (deposit figures are always level prices;
   withdrawals display up to USD 180,000; entries are reshuffled per fetch).

## 9. Where the money rules live

| Rule | Value | Enforced in |
| --- | --- | --- |
| Min deposit | USD 10 | `routes/wallet.js` |
| Min withdrawal | USD 30 | `routes/wallet.js` |
| Withdrawal fee | 10% flat | `helpers.js#computeWithdrawFee` |
| Welcome bonus | USD 2 | `routes/auth.js` |
| Task rewards | USD 0.01 - 0.30 | `seed.js` + `routes/tasks.js` |

## 10. Bot / worker notes

- `lib/schema.js` bootstraps the schema on every boot against any empty Supabase DB.
- `seed.js` seeds the 9 levels and the tasks, and migrates legacy UGX data once.
- `lib/cron.js` runs the daily-earnings worker (default every 15 minutes, idempotent).