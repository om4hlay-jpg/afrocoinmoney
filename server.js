// afrocoinmoney web application server.
// Serves the REST API and the static frontend files.
require('dotenv').config();

const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const { pool } = require('./db');
const currencyLib = require('./lib/currency');
const rates = require('./lib/rates');
const { makeReferralCode } = require('./helpers');
const logger = require('./lib/logger');


// Bootstrap the database schema BEFORE seeding so a brand-new database
// (e.g. on the VPS or on first local run) is provisioned automatically.
const { ensureSchema } = require('./lib/schema');
const app = express();

app.set('trust proxy', true);
app.disable('x-powered-by');

// Baseline security headers for the whole app.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// Record every API request in system_logs so the admin console has a live
// audit trail of who hit what and when. Fire-and-forget: a slow DB must never
// stall the request path. Only API routes are logged - static assets are not.
app.use('/api', (req, res, next) => {
  const start = Date.now();
  const originalJson = res.json.bind(res);
  res.json = function (body) {
    const ms = Date.now() - start;
    const ok = res.statusCode < 400;
    const user = req.user && req.user.id ? 'user#' + req.user.id : 'anon';
    logger.info('http', (ok ? 'OK' : 'FAIL') + ' ' + req.method + ' ' + req.originalUrl + ' (' + ms + 'ms)', {
      user: user,
      status: res.statusCode,
      ip: req.ip,
      body: body && typeof body === 'object' ? JSON.stringify(body).slice(0, 200) : undefined
    });
    return originalJson(body);
  };
  next();
});

// The admin console (/admin) is built with the TailAdmin Tailwind template, whose
// stylesheet and runtime come from the public Tailwind CDN. Serving that from a
// CDN is normal for TailAdmin, so the admin pages get a CSP that permits it
// (cdn.tailwindcss.com) while the member-facing app stays locked to 'self'.
app.use('/admin', (req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com; " +
    "style-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com data:; " +
    "img-src 'self' data: https:; " +
    "connect-src 'self'"
  );
  next();
});

// Member-facing app: fully self-hosted, no third-party origins. Only sets the
// header when a more specific middleware (e.g. /admin above) has not already
// chosen a policy - setHeader would otherwise clobber it.
app.use((req, res, next) => {
  if (!res.getHeader('Content-Security-Policy')) {
    res.setHeader(
      'Content-Security-Policy',
      // worker-src 'self' lets the service worker register; manifest-src lets the
      // browser read /manifest.json for the install prompt.
      "default-src 'self'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "script-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; " +
      "connect-src 'self'; " +
      "worker-src 'self'; " +
      "manifest-src 'self'"
    );
  }
  next();
});

app.use(cors());
// WolvPay webhooks must be verified against the raw request body.
app.use('/api/webhooks', express.raw({ type: 'application/json', limit: '1mb' }));
app.use('/api/webhooks', require('./routes/webhooks'));
app.use(express.json({ limit: '100kb' }));

// API routes.
app.use('/api/auth', require('./routes/auth'));
app.use('/api/wallet', require('./routes/wallet'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/marquee', require('./routes/wallet'));
app.use('/api/bots', require('./routes/bots'));
app.use('/api/team', require('./routes/team'));
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api/home', require('./routes/home'));
app.use('/api/stats', require('./routes/stats'));
app.use('/api/settings', require('./routes/settings'));
// System administrator API (every route re-checks is_admin in the database).
app.use('/api/admin', require('./routes/admin'));

// Public currency catalogue (signup picker + settings).
app.get('/api/currencies', (req, res) => res.json({ currencies: currencyLib.listCurrencies() }));

// Live FX rate feed (source + freshness) for the home/settings screens.
app.get('/api/rates', async (req, res) => {
  try {
    const r = await rates.getRates();
    return res.json({
      source: r.source,
      stale: !!r.stale,
      updated_at: r.stale ? null : new Date().toISOString(),
      rates: currencyLib.listCurrencies().map((c) => ({ code: c.code, rate: c.rate }))
    });
  } catch (err) {
    console.error('Rates endpoint error:', err.message);
    return res.json({ source: 'static', stale: true, updated_at: null, rates: rates.staticRates() });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// --- Progressive Web App ----------------------------------------------------
// The service worker must be served from the root to control the whole origin,
// and must never be cached: a stale sw.js means members get stuck on old code
// with no way to update. Same for the manifest, so a redeploy shows up.
app.get('/sw.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Service-Worker-Allowed', '/');
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

app.get('/manifest.json', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('application/manifest+json');
  res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
});

app.use(express.static(path.join(__dirname, 'public')));
// Admin console (TailAdmin Tailwind dashboard). Served before the SPA catch-all
// so /admin and its assets always resolve to the dashboard.
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  logger.error('express', 'Server error: ' + (err && err.stack ? err.stack : String(err)), { url: req.originalUrl, method: req.method });
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

const PORT = process.env.PORT || 3000;

// Retry the initial database check with a short backoff so a cold start
// is absorbed rather than killing the server.
async function seedAdmin() {
  try {
    logger.info('server', 'Seeding default administrator account.');
    const existing = (await pool.query('SELECT id FROM users WHERE is_admin = TRUE LIMIT 1')).rows[0];
    if (existing) return;
    // Default credentials: admin / admin. The operator can change them in the
    // admin console (/api/admin/me/password) before putting the platform live.
    const email = process.env.ADMIN_EMAIL || 'admin@afrocoinmoney.com';
    const password = process.env.ADMIN_PASSWORD || 'admin';
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (email, phone, password_hash, currency, country, display_name, referral_code, is_admin) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [email, null, hash, 'USD', 'Uganda', 'Administrator', makeReferralCode(), true]
    );
    console.log('Admin seed: created the initial administrator account (' + email + '). Change the password in the admin console before going live.');
  } catch (err) {
    console.error('Admin seed error:', err.message);
  }
}

async function waitForDatabase(attempts = 20, delayMs = 3000) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query('SELECT 1');
      return true;
    } catch (err) {
      console.error('Database connect attempt ' + i + '/' + attempts + ' failed:', err.message);
      if (i === attempts) return false;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}

async function start() {
  const connected = await waitForDatabase();
  if (!connected) {
    console.error('Unable to start server (database not reachable after retries).');
    process.exit(1);
  }
  try {
    console.log('Database connected.');
    // Bootstrap the database schema before seeding so a fresh database
    // (e.g. new local run or on the VPS) is provisioned automatically.
    await ensureSchema();
    // The bootstrap admin must exist BEFORE seed() so the dummy demo
    // transactions have a valid user_id to point at.
    await seedAdmin();
    const { seed } = require('./seed');
    await seed();
    // Pull live FX rates so prices are current before the first page render.
    // Non-blocking and non-fatal: a dead feed just means static rates are used.
    rates.refreshRates().catch((e) => console.error('[rates] initial refresh failed:', e.message));
    // Keep the database connection alive while the app is idle.
    setInterval(() => {
      pool.query('SELECT 1').catch(() => {});
    }, 5 * 60 * 1000).unref();
    // Refresh FX rates on a daily cycle (the free feed updates once a day).
    // lib/rates.js also self-throttles, so this is simply the daily nudge.
    setInterval(() => {
      rates.refreshRates().catch((e) => console.error('[rates] scheduled refresh failed:', e.message));
    }, 24 * 60 * 60 * 1000).unref();
    app.listen(PORT, () => {
      console.log('afrocoinmoney running on port ' + PORT);
    });
  } catch (err) {
    console.error('Unable to start server:', err.message);
    process.exit(1);
  }
}

start();