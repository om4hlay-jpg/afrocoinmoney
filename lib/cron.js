// Background earnings worker for afrocoinmoney.
//
// Bots earn a daily percentage for their owner. On the web server this is
// credited lazily (when the owner opens the app, via processDailyEarnings in
// routes/home.js, bots.js, auth.js). To honour the "users earn cash daily
// after buying a bot" feature reliably - and to keep up with 1000+ users - a
// separate worker process runs the same idempotent pass on a schedule. It
// only credits days that have actually come due, so an hourly tick simply
// "catches up" any day the web server may have missed.
//
// Run it with:  npm run worker   (or `node lib/cron.js`)
// In production, run it under PM2 (see deploy.md, section 13).
require('dotenv').config();
const { pool } = require('../db');
const { processDailyEarnings } = require('../helpers');

// Concurrency is capped so the worker never opens more simultaneous DB
// clients than the pool allows (default pool max is 20 in db.js).
const DEFAULT_CONCURRENCY = 5;

// Fall back to the default concurrency for anything non-numeric or <= 0.
function clampConcurrency(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CONCURRENCY;
  return Math.floor(n);
}

// Resolve optional injected dependencies (used by tests). Falls back to the
// real pool and the real processDailyEarnings.
function resolveDeps(deps) {
  deps = deps || {};
  return {
    processFn: deps.processDailyEarnings || processDailyEarnings,
    dbPool: deps.pool || pool
  };
}

// Credit due daily earnings for every user that currently owns an active bot.
// Returns { processed, errors }. Safe to run on any interval.
async function runDailyEarningsCycle(concurrency, deps) {
  const { processFn, dbPool } = resolveDeps(deps);
  const n = clampConcurrency(concurrency || DEFAULT_CONCURRENCY);

  const rows = (await dbPool.query(
    "SELECT DISTINCT ub.user_id FROM user_bots ub WHERE ub.status = 'active'"
  )).rows;
  const ids = rows.map(r => Number(r.user_id));

  let i = 0;
  let errors = 0;
  async function worker() {
    while (i < ids.length) {
      const idx = i++;
      try {
        await processFn(ids[idx]);
      } catch (e) {
        errors++;
        // One user's earnings failure must not stop the whole cycle.
        console.error('Cron earnings error for user ' + ids[idx] + ':', e && e.message ? e.message : e);
      }
    }
  }

  // Never spawn more workers than there are users.
  const count = Math.min(n, Math.max(ids.length, 1));
  const workers = Array.from({ length: count }, () => worker());
  await Promise.all(workers);

  return { processed: ids.length, errors };
}

// Schedule the earnings pass on an interval. Override the cadence with
// CRON_INTERVAL_MS (default: 15 minutes). The first pass runs immediately.
function start() {
  const intervalMs = Number(process.env.CRON_INTERVAL_MS || 1000 * 60 * 15);

  runDailyEarningsCycle().catch(e =>
    console.error('Cron initial run failed:', e && e.message ? e.message : e)
  );

  const handle = setInterval(() => {
    runDailyEarningsCycle().catch(e =>
      console.error('Cron tick failed:', e && e.message ? e.message : e)
    );
  }, intervalMs);

  // Graceful shutdown so PM2 / nodemon can stop the worker cleanly.
  function stop() {
    clearInterval(handle);
    try { pool.end(); } catch (_) { /* ignore */ }
  }
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  return handle;
}

module.exports = {
  runDailyEarningsCycle,
  start,
  clampConcurrency,
  DEFAULT_CONCURRENCY
};

// When executed directly (`npm run worker`), start the worker after a quick
// DB reachability check so the process exits cleanly if the DB is down.
if (require.main === module) {
  (async () => {
    try {
      await pool.query('SELECT 1');
      console.log('Database connected.');
    } catch (err) {
      console.error('Cron worker cannot start: database not reachable:', err.message);
      process.exit(1);
    }
    start();
    // The worker also owns the daily FX refresh so rates stay current even on
    // deployments where the web process restarts more often than the feed does.
    const rates = require('./rates');
    rates.refreshRates().catch((e) => console.error('[rates] initial refresh failed:', e.message));
    setInterval(() => {
      rates.refreshRates().catch((e) => console.error('[rates] scheduled refresh failed:', e.message));
    }, 24 * 60 * 60 * 1000).unref();
    const intervalMs = Number(process.env.CRON_INTERVAL_MS || 1000 * 60 * 15);
    console.log('afrocoinmoney cron worker started. Interval ' + (intervalMs / 1000) + 's.');
  })();
}
