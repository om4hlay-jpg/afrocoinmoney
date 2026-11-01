# afrocoinmoney - Testing & Netlify Test Deploy

This guide has two parts:
1. How to run and test afrocoinmoney on your own computer.
2. How to push out a quick test deployment on Netlify.

## Part 1 - Run and test locally

### 1. Install Node.js
Make sure Node.js version 18 or newer is installed. Check with `node -v`. Install
dependencies with `npm install`.

### 2. Connect a PostgreSQL / Supabase database
afrocoinmoney needs a PostgreSQL database (Supabase is recommended). Follow
`database.md` - the app **creates every table automatically on boot** (`lib/schema.js`)
and seeds the levels + tasks (`seed.js`). You only need a `DATABASE_URL` in `.env`.

### 3. Set up the environment file
Copy the example file to `.env`:

```
copy .env.example .env
```

Then edit `.env` and set `DATABASE_URL`, `JWT_SECRET`, `WOLVPAY_API_KEY` and
`WOLVPAY_WEBHOOK_SECRET` to your values.

### 4. Run the app

```
npm start
```

For live-reload development (auto-restart on every save, so you can watch changes):

```
npm run dev
```

Open `http://localhost:3000` in your browser.

### 5. What to test
- Register with a phone number or e-mail and pick your display currency, then log in.
  Every new account receives a USD 2 welcome bonus. If a referral code (`?ref=`) was
  used, the referrer is linked.
- Choose your currency at signup, then confirm every price/balance/transaction
  displays in it. Change it in Account Settings and confirm it applies everywhere.
- Fund your wallet with **crypto only** (WolvPay invoice). A deposit is `pending`
  and the wallet is credited only after WolvPay confirms `PAID` webhook
  (`/api/webhooks/wolvpay`). Verify the wallet does NOT credit before the webhook.
- Buy a level and confirm it becomes your active level, the per-second earnings
  ticker runs, and real earnings settle daily (open the app or let `lib/cron.js`
  run).
- Confirm the home screen shows your wallet, stats, tasks (green border when ready)
  and the live transaction ticker (deposits are always level prices; withdrawals up
  to USD 180,000; shuffled per fetch).
- Try withdrawing less than USD 30 - you should only then see the "minimum USD 30"
  message. Request USD 100 and confirm 10% fee → USD 90 net is stored.
- On the Team page, copy your random referral code, make a second account with it,
  and confirm the referrer shows up with commission eligibility.
- On the Profile page, change your name, change your password, change your currency,
  and view transaction history.

## Part 2 - Netlify test deployment

The afrocoinmoney app is a Node.js server, so on Netlify we wrap the API in a Netlify
Function. The static frontend (`public`) is served as-is.

### 1. Create the Netlify function

Create `netlify/functions/api.js`:

```js
const express = require('express');
const serverless = require('serverless-http');
const path = require('path');

const app = express();
// Webhooks need the raw body for signature verification.
app.use('/api/webhooks', express.raw({ type: 'application/json', limit: '1mb' }));
app.use('/api/webhooks', require('../../webhooksRouter'));
app.use(express.json());
app.use('/api/auth', require('../../routes/auth'));
app.use('/api/wallet', require('../../routes/wallet'));
app.use('/api/bots', require('../../routes/bots'));
app.use('/api/team', require('../../routes/team'));
app.use('/api/tasks', require('../../routes/tasks'));
app.use('/api/home', require('../../routes/home'));
app.use('/api/stats', require('../../routes/stats'));
app.use('/api/settings', require('../../routes/settings'));

exports.handler = serverless(app);
```

### 2. Install the helper package

```
npm install serverless-http
```

### 3. Add a Netlify config
Create `netlify.toml`:

```toml
[build]
  publish = "public"
  functions = "netlify/functions"

[[redirects]]
  from = "/api/*"
  to = "/.netlify/functions/api/:splat"
  status = 200

[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```

### 4. Add a database for Netlify
Netlify functions are short-lived, so use a managed PostgreSQL (Supabase). Put its
connection string in the Netlify environment variables under Site settings:
- `DATABASE_URL` = your hosted PostgreSQL connection string (pooled port 6543)
- `JWT_SECRET` = a long random string
- `WOLVPAY_API_KEY` / `WOLVPAY_WEBHOOK_SECRET` = your crypto-payment keys

### 5. Connect and deploy
1. Push your project to a GitHub repository.
2. On Netlify, choose "Add new site" → "Import an existing project".
3. Select your repository. Build command: leave empty. Publish directory: `public`.
4. Add the environment variables listed above.
5. Click "Deploy site". Netlify gives you a live URL such as
   `https://your-site.netlify.app`.

> Netlify functions are short-lived and process fewer requests - they are great for a
> quick test preview. For production (1000+ concurrent African users) follow
> `deploy.md` to run the Node server + PostgreSQL on an Ubuntu VPS.

## Environment variables summary
| Variable | Purpose |
| -------- | ------- |
| `PORT` | Local server port (default 3000) |
| `DATABASE_URL` | Supabase / PostgreSQL connection string |
| `DATABASE_SSL` | `true` for Supabase |
| `JWT_SECRET` | Secret used to sign login tokens |
| `WOLVPAY_API_KEY` | WolvPay server key (`wlov_live_…`) |
| `WOLVPAY_WEBHOOK_SECRET` | WolvPay webhook signing secret |
| `MIN_DEPOSIT_USD` | Minimum deposit (default 10) |
| `MIN_WITHDRAW_USD` | Minimum withdrawal (default 30) |
| `WITHDRAW_FEE_PERCENT` | Flat withdrawal fee % (default 10) |

## Wallet testing (crypto only)

Deposits use WolvPay crypto invoices. A deposit returns
`{ success, status:'pending', reference }` and the wallet is credited **only after**
WolvPay confirms `PAID` via the signed webhook (`/api/webhooks/wolvpay`) or an
authenticated invoice-status poll - never from the client. To run the full funded flow
you need a WolvPay key and a **public webhook URL** (expose localhost through ngrok;
see `payments.md`).