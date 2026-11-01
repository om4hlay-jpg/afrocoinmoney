// Database connection pool for PostgreSQL.
// All queries in the app use parameterized queries (prepared statements)
// to protect against SQL injection attacks.
require('dotenv').config();

const { Pool } = require('pg');

// Build the connection, allowing SSL for managed databases (e.g. Supabase).
const connectionConfig = {
  connectionString: process.env.DATABASE_URL,
  // Give the first connection plenty of time so a cold start does not
  // crash the app.
  connectionTimeoutMillis: 60000,
  // Keep idle connections around longer so routes do not re-pay the cold
  // start on every request after a short pause.
  idleTimeoutMillis: 60000,
  // pg 8 defaults keepAlive to true; stay explicit so the pooler does not
  // kill idle sockets while the server is running.
  keepAlive: true,
  max: 20
};

// Enable SSL when DATABASE_SSL=true (required by most cloud hosts).
if (process.env.DATABASE_SSL === 'true') {
  connectionConfig.ssl = { rejectUnauthorized: false };
}

const pool = new Pool(connectionConfig);

module.exports = { pool }

