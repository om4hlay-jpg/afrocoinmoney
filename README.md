# afrocoinmoney

Crypto investment platform for Africa. No crypto knowledge needed - pick a terminal, earn daily, withdraw in crypto.

## Tech Stack

- Node.js 18+ / Express
- PostgreSQL (local or hosted)
- Vanilla JS frontend (no build step)
- WolvPay crypto payment processor

## Quick Start (VPS)

```bash
# 1. Install Node.js 18+ and PostgreSQL

# 2. Create database
sudo -u postgres psql -c "CREATE USER afrocoinmoney WITH PASSWORD 'your-password';"
sudo -u postgres psql -c "CREATE DATABASE afrocoinmoney OWNER afrocoinmoney;"

# 3. Configure
cp .env.example .env
# Edit .env - set DATABASE_URL, JWT_SECRET, ADMIN_PASSWORD, WolvPay keys

# 4. Install + run
npm install
npm start

# 5. Keep running with PM2
pm2 start server.js --name afrocoinmoney
pm2 save
pm2 startup
```

The app auto-creates all tables and seeds investment levels on first boot.

## VPS Deployment

See `deploy.md` for the full Ubuntu VPS setup guide (Nginx, HTTPS, PM2, PostgreSQL).

## Project Structure

```
server.js          Express app entry point
db.js              PostgreSQL connection pool
helpers.js        Business logic (earnings, fees, referrals)
routes/            API route handlers
lib/               Core modules (schema, cron, wolvpay, currency, rates)
public/            Static frontend (HTML/CSS/JS)
test/              Unit + integration tests
```

## Environment Variables

See `.env.example` for all configuration options.

## Testing

```bash
npm test
```

## License

Proprietary - afrocoinmoney
