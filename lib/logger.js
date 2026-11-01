// lib/logger.js
// Structured server-side logger that mirrors every line into the
// platform_settings-backed `system_logs` table so the admin console can show
// a live audit trail of what the platform is doing.
//
// Levels: debug, info, warn, error. The console only shows warn+ by default.
// Writes are fire-and-forget: a logging failure must never break a request.
'use strict';

const { pool } = require('../db');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();

function shouldLog(level) {
  return (LEVELS[level] || 1) >= (LEVELS[MIN_LEVEL] || 1);
}

// Fire-and-forget insert into system_logs. Bounded to a single statement so a
// slow DB never stalls the request path.
function writeLog(level, source, message, context) {
  if (!shouldLog(level)) return;
  let ctx = null;
  if (context !== undefined) {
    try {
      ctx = typeof context === 'string' ? context : JSON.stringify(context);
    } catch (e) { ctx = String(context); }
  }
  // Truncate the message so a runaway log line cannot blow up the column.
  const safeMsg = String(message || '').slice(0, 2000);
  pool.query(
    'INSERT INTO system_logs (level, source, message, context) VALUES ($1, $2, $3, $4)',
    [level, String(source || 'app').slice(0, 60), safeMsg, ctx]
  ).catch(() => { /* logging must never break the request */ });
}

const logger = {
  debug: (src, msg, ctx) => writeLog('debug', src, msg, ctx),
  info:  (src, msg, ctx) => writeLog('info', src, msg, ctx),
  warn:  (src, msg, ctx) => writeLog('warn', src, msg, ctx),
  error: (src, msg, ctx) => writeLog('error', src, msg, ctx),
  LEVELS: LEVELS
};

// Capture uncaught exceptions and unhandled promise rejections so they land in
// the console instead of vanishing into the PM2 log.
process.on('uncaughtException', (err) => {
  console.error('[logger] uncaughtException:', err);
  logger.error('process', 'Uncaught exception: ' + (err && err.stack ? err.stack : String(err)));
});
process.on('unhandledRejection', (reason) => {
  console.error('[logger] unhandledRejection:', reason);
  logger.error('process', 'Unhandled rejection: ' + (reason && reason.stack ? reason.stack : String(reason)));
});

module.exports = logger;