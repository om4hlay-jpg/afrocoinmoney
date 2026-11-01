// lib/schema.js
// Idempotent schema bootstrap. Runs on every startup BEFORE seeding so a brand
// new (empty) PostgreSQL database is provisioned automatically.
'use strict';

const { pool } = require('../db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS platform_settings (
      key VARCHAR(60) PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE,
      phone VARCHAR(50) UNIQUE,
      password_hash TEXT NOT NULL,
      name VARCHAR(100),
      display_name VARCHAR(100),
      currency VARCHAR(8) NOT NULL DEFAULT 'UGX',
      country VARCHAR(60),
      referral_code VARCHAR(30) UNIQUE NOT NULL,
      referred_by BIGINT REFERENCES users(id),
      wallet_balance NUMERIC(15,2) NOT NULL DEFAULT 0,
      total_deposited NUMERIC(15,2) NOT NULL DEFAULT 0,
      total_withdrawn NUMERIC(15,2) NOT NULL DEFAULT 0,
      bot_income NUMERIC(15,2) NOT NULL DEFAULT 0,
      team_income NUMERIC(15,2) NOT NULL DEFAULT 0,
      -- Unclaimed referral earnings. They move to wallet_balance only when the
      -- member claims them and the balance reaches the minimum.
      referral_pending NUMERIC(15,2) NOT NULL DEFAULT 0,
      pending_earnings NUMERIC(15,2) NOT NULL DEFAULT 0,
      welcome_bonus_claimed BOOLEAN NOT NULL DEFAULT FALSE,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at TIMESTAMPTZ
  )`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(100)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS country VARCHAR(60)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS currency VARCHAR(8) NOT NULL DEFAULT 'UGX'`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_until TIMESTAMPTZ`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_pending NUMERIC(15,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS note VARCHAR(200)`,
  `ALTER TABLE referral_bonuses ADD COLUMN IF NOT EXISTS confirmed BOOLEAN NOT NULL DEFAULT FALSE`,
  // E-mail verification was removed: these columns are no longer read or written.
  `ALTER TABLE users DROP COLUMN IF EXISTS email_verified`,
  `ALTER TABLE users DROP COLUMN IF EXISTS email_verify_token`,
  `CREATE TABLE IF NOT EXISTS bots (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      tier VARCHAR(50) NOT NULL,
      min_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
      max_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
      daily_percent NUMERIC(5,2) NOT NULL,
      lock_days INT NOT NULL,
      sort_order INT NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS user_bots (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      bot_id BIGINT NOT NULL REFERENCES bots(id),
      amount NUMERIC(15,2) NOT NULL,
      started_at DATE NOT NULL,
      ends_at DATE NOT NULL,
      next_earning_date DATE,
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `ALTER TABLE user_bots ADD COLUMN IF NOT EXISTS started_at_ts TIMESTAMPTZ`,
  `UPDATE user_bots SET started_at_ts = started_at::timestamptz WHERE started_at_ts IS NULL`,
  `CREATE TABLE IF NOT EXISTS daily_earnings (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      bot_id BIGINT NOT NULL REFERENCES bots(id),
      amount NUMERIC(15,2) NOT NULL,
      earned_on DATE NOT NULL,
      UNIQUE (user_id, bot_id, earned_on)
  )`,
  `CREATE TABLE IF NOT EXISTS transactions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type VARCHAR(30) NOT NULL,
      method VARCHAR(20) NOT NULL,
      amount NUMERIC(15,2) NOT NULL,
      fee NUMERIC(15,2) NOT NULL DEFAULT 0,
      net_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      reference VARCHAR(50) UNIQUE NOT NULL,
      account TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS fee NUMERIC(15,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS net_amount NUMERIC(15,2) NOT NULL DEFAULT 0`,
  // A timed task (e.g. telegram join) gets a row the moment it is STARTED;
  // the reward is only paid once `claimed` flips to TRUE.
  `ALTER TABLE user_tasks ADD COLUMN IF NOT EXISTS claimed BOOLEAN NOT NULL DEFAULT FALSE`,
  `CREATE TABLE IF NOT EXISTS referral_bonuses (
      id BIGSERIAL PRIMARY KEY,
      referrer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      referral_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount NUMERIC(15,2) NOT NULL,
      -- FALSE until the referral makes their first deposit ("confirmed").
      confirmed BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS tasks (
      id BIGSERIAL PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      description TEXT,
      reward NUMERIC(15,2) NOT NULL,
      condition VARCHAR(30) NOT NULL DEFAULT 'claim',
      sort_order INT NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS user_tasks (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, task_id)
  )`,
  `CREATE TABLE IF NOT EXISTS notifications (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type VARCHAR(30) NOT NULL,
      title VARCHAR(200) NOT NULL,
      message TEXT,
      read BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS price_history (
      id BIGSERIAL PRIMARY KEY,
      currency VARCHAR(8) NOT NULL,
      price NUMERIC(15,2) NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by)`,
  `CREATE INDEX IF NOT EXISTS idx_user_bots_user ON user_bots(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_daily_earnings_user ON daily_earnings(user_id, earned_on)`,
  `CREATE INDEX IF NOT EXISTS idx_user_tasks_user ON user_tasks(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_price_history_currency ON price_history(currency, recorded_at DESC)`,
  `CREATE TABLE IF NOT EXISTS withdrawal_addresses (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      coin VARCHAR(30) NOT NULL,
      address TEXT NOT NULL,
      label VARCHAR(60),
      is_default BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, address)
    )`,
  `CREATE INDEX IF NOT EXISTS idx_withdrawal_addresses_user ON withdrawal_addresses(user_id)`,
  `CREATE TABLE IF NOT EXISTS system_logs (
      id BIGSERIAL PRIMARY KEY,
      level VARCHAR(16) NOT NULL DEFAULT 'info',
      source VARCHAR(60) NOT NULL,
      message TEXT NOT NULL,
      context JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  `CREATE INDEX IF NOT EXISTS idx_system_logs_created ON system_logs(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_system_logs_source ON system_logs(source)`,
  `CREATE TABLE IF NOT EXISTS platform_fees (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source VARCHAR(30) NOT NULL DEFAULT 'terminal_rental',
      amount NUMERIC(15,2) NOT NULL,
      reference VARCHAR(60),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  `CREATE INDEX IF NOT EXISTS idx_platform_fees_created ON platform_fees(created_at DESC)`
];

async function ensureSchema() {
  // Phase 1: create all tables first (so ALTER TABLE can target them).
  for (const sql of STATEMENTS) {
    if (sql.trim().startsWith('CREATE TABLE')) {
      await pool.query(sql);
    }
  }
  // Phase 2: run ALTER TABLE statements.
  for (const sql of STATEMENTS) {
    if (sql.trim().startsWith('ALTER TABLE')) {
      await pool.query(sql);
    }
  }
  // Phase 3: run UPDATE statements.
  for (const sql of STATEMENTS) {
    if (sql.trim().startsWith('UPDATE')) {
      await pool.query(sql);
    }
  }
}

module.exports = { ensureSchema };