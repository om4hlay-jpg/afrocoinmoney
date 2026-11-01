# afrocoinmoney - Ubuntu VPS Deployment Guide

This guide takes you from a fresh Ubuntu server to a running, secure afrocoinmoney
application with its own PostgreSQL database. PM2 keeps the app running and Nginx acts
as a reverse proxy.

## 1. Prepare the server

```bash
sudo apt update
sudo apt upgrade -y
```

## 2. Install Node.js (18 or newer)

```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs
node -v
```

## 3. Install PostgreSQL and create the database

```bash
sudo apt install -y postgresql postgresql-contrib
sudo systemctl enable postgresql
sudo systemctl start postgresql
```

```bash
sudo -u postgres psql -c "CREATE USER afrocoinmoney WITH PASSWORD 'a-strong-password';"
sudo -u postgres psql -c "CREATE DATABASE afrocoinmoney OWNER afrocoinmoney;"
```

> The app **creates its own tables on boot** (`lib/schema.js`) and seeds the 9
> investment levels + tasks (`seed.js`), so no manual SQL is required.

## 4. Get the application onto the server

```bash
sudo mkdir -p /opt/afrocoinmoney
cd /opt/afrocoinmoney
```

Upload the project files (`package.json`, `server.js`, `db.js`, `helpers.js`, `routes`,
`lib`, `public`, `seed.js`, `.env`) into `/opt/afrocoinmoney`.

```bash
npm install
```

Start once to confirm it boots:

```bash
npm start
```

You should see `afrocoinmoney running on port 3000`. Stop it with `Ctrl+C`.

> The app connects to the local PostgreSQL database configured in `.env`.

## 5. Keep it running with PM2

```bash
sudo npm install -g pm2
cd /opt/afrocoinmoney
pm2 start server.js --name afrocoinmoney
pm2 save
pm2 startup
```

Useful commands: `pm2 status`, `pm2 logs afrocoinmoney`, `pm2 restart afrocoinmoney`.

## 6. Nginx reverse proxy + HTTPS

Create `/etc/nginx/sites-available/afrocoinmoney`:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection keep-alive;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/afrocoinmoney /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

Add HTTPS with certbot:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

Open the firewall (`sudo ufw allow 'OpenSSH'`, `sudo ufw allow 'Nginx Full'`,
`sudo ufw enable`). Visit `https://your-domain.com` - you should see the login page.

## 7. Scaling to 1000+ concurrent users

- Keep the PostgreSQL pool `max` reasonable (20 is fine; raise with RAM).
- Run several PM2 instances: `pm2 start server.js -i max --name afrocoinmoney`.
- All database queries use parameterized statements (SQL-injection safe) and the
  server sets CSP + nosniff headers.

## 8. Crypto payments (WolvPay)

Wallets are funded through **WolvPay crypto invoices** (BTC / LTC / USDT and more) -
no mobile money. A deposit is `pending` and the wallet is only credited after WolvPay
confirms `PAID` via webhook (see `payments.md`).

### Environment variables

```
WOLVPAY_API_KEY=wlov_live_...        # server key from WolvPay
WOLVPAY_WEBHOOK_SECRET=              # signing secret; must match the dashboard webhook
MIN_DEPOSIT_USD=10
MIN_WITHDRAW_USD=30
WITHDRAW_FEE_PERCENT=10
```

### Register the webhook

In the WolvPay dashboard register the public URL:

```
https://your-domain.com/api/webhooks/wolvpay
```

using the same signing secret as `WOLVPAY_WEBHOOK_SECRET`. The server mounts an
`express.raw` body parser for `/api/webhooks` and verifies the `x-wolvpay-signature`
header against the raw body before crediting any wallet. Verified events return 200
(200 `credited` / `ignored` - no double credit); a signature mismatch returns 401.

## 9. Daily earnings worker

Bot earnings settle lazily when users open the app, but to guarantee every active
level is paid daily (and to scale) run the earnings worker as a second PM2 process:

```bash
pm2 start lib/cron.js --name afrocoinmoney-cron
pm2 save
```

The worker polls all active levels every 15 minutes (`CRON_INTERVAL_MS` to override).
Each tick is idempotent, so it simply "catches up" any days the web server missed.

## 10. Final checks

- `pm2 status` shows both processes `online`.
- `pm2 logs afrocoinmoney` shows `Database connected.` and `afrocoinmoney running...`.
- Run the test suite: `npm test`.