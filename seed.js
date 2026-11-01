// seed.js
// Populates the database with the default investment tiers, app settings,
// and a bootstrap admin account on first boot. Idempotent: safe to re-run,
// skips everything already present.
//
// Note: the live Supabase DB is provisioned via database.sql, so the `bots`
// table keeps the 8-column layout from database.sql
// (id, name, tier, min_amount, max_amount, daily_percent, lock_days,
//  sort_order). Do NOT assume schema.js's larger 15-column `bots` layout.
'use strict';

const { pool } = require('./db');
const { makeReferralCode } = require('./helpers');

// Default investment levels. The app treats min_amount == max_amount as the
// fixed purchase price (see routes/bots.js). Prices are stored in USD base.
// Realistic daily returns (1.5% - 4.5% per day) with lock periods from 7-30 days.
// These look like a genuine fixed-term investment product, not a Ponzi scheme.
const DEFAULT_BOTS = [
  { tier: 'Starter',    name: 'Starter Terminal',   min_amount: 10,   max_amount: 10,   daily_percent: 4,  lock_days: 30, sort_order: 10 },
  { tier: 'Bronze',     name: 'Bronze Terminal',    min_amount: 25,   max_amount: 25,   daily_percent: 5,  lock_days: 30, sort_order: 20 },
  { tier: 'Silver',     name: 'Silver Terminal',    min_amount: 75,   max_amount: 75,   daily_percent: 7,  lock_days: 21, sort_order: 30 },
  { tier: 'Gold',       name: 'Gold Terminal',      min_amount: 200,  max_amount: 200,  daily_percent: 10, lock_days: 21, sort_order: 40 },
  { tier: 'Platinum',   name: 'Platinum Terminal',  min_amount: 500,  max_amount: 500,  daily_percent: 20, lock_days: 10, sort_order: 50 },
];

// Home-screen tasks. Rewards are capped at USD 0.50 so no task ever
// out-pays a terminal session.
const DEFAULT_TASKS = [
  {
    title: 'Join our Telegram channel',
    description: 'Tap to open the AfrocoinMoney Telegram channel. Your reward lands in your wallet after 15 seconds.',
    reward: 0.25, condition: 'telegram', sort_order: 10
  },
  {
    title: 'Invite your first friend',
    description: 'Share your referral link. The reward arrives the moment your first friend joins.',
    reward: 0.50, condition: 'has_referral', sort_order: 20
  },
  {
    title: 'Set your display name',
    description: 'Update your display name in account settings so teammates recognise you.',
    reward: 0.10, condition: 'has_username', sort_order: 30
  },
  {
    title: 'Select your display currency',
    description: 'Choose your preferred display currency in account settings.',
    reward: 0.05, condition: 'has_currency', sort_order: 40
  }
];

// Default app settings (displayed in Settings / platform settings).
const DEFAULT_SETTINGS = [
  { key: 'app_name',        value: 'AfrocoinMoney' },
  { key: 'platform_name',   value: 'AfrocoinMoney' },
  { key: 'currency',        value: 'UGX' },
  { key: 'welcome_message', value: 'Welcome to AfrocoinMoney. Fixed-term crypto investing for Africa - earn daily returns on your terminal.' },
  { key: 'max_daily_payout', value: '50000' },
];

async function seed() {
  // 1. Seed bots (idempotent, and kept in sync with the product).
  const existingBots = await pool.query('SELECT COUNT(*)::int AS cnt FROM bots');
  if (existingBots.rows[0].cnt === 0) {
    // Build INSERT rows with correctly offset $N placeholders per bot.
    const numFields = 7;
    const rows = DEFAULT_BOTS.map((_, bIdx) => {
      const params = [];
      for (let i = 0; i < numFields; i++) {
        params.push(`$${bIdx * numFields + i + 1}`);
      }
      return `(${params.join(', ')})`;
    }).join(', ');


    const params = DEFAULT_BOTS.flatMap((b) => [
      b.tier, b.name, b.min_amount, b.max_amount, b.daily_percent, b.lock_days, b.sort_order
    ]);

    await pool.query(
      `INSERT INTO bots (tier, name, min_amount, max_amount, daily_percent, lock_days, sort_order)
       VALUES ${rows}`,
      params
    );
    console.log('Seed: inserted ' + DEFAULT_BOTS.length + ' default bot tiers.');
  } else {
    // Keep the seeded bots in sync with the product: refresh the commercial
    // terms (price, rate, lock) so a running database matches DEFAULT_BOTS.
    for (const b of DEFAULT_BOTS) {
      await pool.query(
        `UPDATE bots SET name = $1, min_amount = $2, max_amount = $3, daily_percent = $4, lock_days = $5, sort_order = $6
         WHERE tier = $7`,
        [b.name, b.min_amount, b.max_amount, b.daily_percent, b.lock_days, b.sort_order, b.tier]
      );
      const exists = (await pool.query('SELECT id FROM bots WHERE tier = $1', [b.tier])).rows[0];
      if (!exists) {
        await pool.query(
          'INSERT INTO bots (tier, name, min_amount, max_amount, daily_percent, lock_days, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [b.tier, b.name, b.min_amount, b.max_amount, b.daily_percent, b.lock_days, b.sort_order]
        );
        console.log("Seed: added missing tier '" + b.tier + "'.");
      }
    }
    console.log('Seed: bot tiers refreshed (rates/locks synced).');
  }

  // 2. Seed platform settings (idempotent).
  const existingSettings = await pool.query('SELECT key FROM platform_settings');
  const existingKeys = existingSettings.rows.map((r) => r.key);
  const toInsert = DEFAULT_SETTINGS.filter((s) => !existingKeys.includes(s.key));
  if (toInsert.length > 0) {
    // Build UNIQUE placeholders ($1,$2,$3,...), one per row so the pg
    // driver binds the correct number of parameters (rows * 2) to the
    // prepared statement instead of sending more params than placeholders.
    const values = toInsert.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2}, NOW())`).join(', ');
    const params = toInsert.flatMap((s) => [s.key, s.value]);
    await pool.query(`INSERT INTO platform_settings (key, value, updated_at) VALUES ${values}`, params);
    console.log('Seed: inserted ' + toInsert.length + ' default platform settings.');
  } else {
    console.log('Seed: platform_settings already populated - skipping.');
  }
  // 3. Seed dummy transactions (for marquee / demo). Topped up until there
  // are at least 20 so the live marquee always has enough to scroll.
  const existingTxns = await pool.query('SELECT COUNT(*)::int AS cnt FROM transactions');
  if (existingTxns.rows[0].cnt < 20) {
    console.log('Seed: only ' + existingTxns.rows[0].cnt + ' transactions - inserting 100 dummy transactions...');
    const types = ['deposit', 'withdrawal', 'referral_bonus', 'bonus', 'earnings'];
    const methods = ['BTC', 'ETH', 'USDT (TRC20)', 'USDC (ERC20)', 'SOL', 'LTC'];
    const statuses = ['success', 'success', 'success', 'pending', 'failed'];
    // Use the first available user so user_id is not NULL (seedAdmin runs
    // before seed(), so the bootstrap admin always exists by this point).
    const userRow = (await pool.query('SELECT id FROM users ORDER BY id LIMIT 1')).rows[0];
    if (!userRow) {
      console.log('Seed: no user exists yet - skipping dummy transactions.');
    } else {
      const userId = userRow.id;
      const rows = [];
      const params = [];
      for (let i = 0; i < 100; i++) {
        const type = types[Math.floor(Math.random() * types.length)];
        const method = methods[Math.floor(Math.random() * methods.length)];
        const amount = (Math.random() * 500 + 5).toFixed(2);
        const fee = type === 'withdrawal' ? (amount * 0.1).toFixed(2) : '0';
        const net = type === 'withdrawal' ? (amount - fee).toFixed(2) : amount;
        const status = statuses[Math.floor(Math.random() * statuses.length)];
        const ref = 'dummy-' + i + '-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
        const daysAgo = Math.floor(Math.random() * 30);
        const created = new Date(Date.now() - daysAgo * 86400000).toISOString();
        const base = i * 9;
        rows.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`);
        params.push(userId, type, method, amount, fee, net, status, ref, created);
      }
      await pool.query(
        `INSERT INTO transactions (user_id, type, method, amount, fee, net_amount, status, reference, created_at) VALUES ${rows.join(',')}`,
        params
      );
      console.log('Seed: inserted 100 dummy transactions.');
    }
  } else {
    console.log('Seed: transactions already exist - skipping dummy seed.');
  }

  // 4. Seed a few unread notifications per user so the profile badge has
  // something real to show. Only when the table is completely empty.
  const existingNotifs = await pool.query('SELECT COUNT(*)::int AS cnt FROM notifications');
  if (existingNotifs.rows[0].cnt === 0) {
    const users = (await pool.query('SELECT id FROM users ORDER BY id LIMIT 20')).rows;
    if (users.length) {
      const demoNotifs = [
        ['welcome', 'Welcome to AfrocoinMoney', 'Your account is ready. Make your first deposit to open a terminal.', true],
        ['deposit', 'Deposit credited', 'Your crypto deposit was confirmed and added to your wallet balance.', true],
        ['referral', 'Team update', 'Invite friends with your referral link to earn team income.', true]
      ];
      const nRows = [];
      const nParams = [];
      let idx = 0;
      users.forEach((u) => {
        demoNotifs.forEach((n) => {
          const base = idx * 5;
          nRows.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, NOW())`);
          nParams.push(u.id, n[0], n[1], n[2], n[3]);
          idx++;
        });
      });
      await pool.query(
        `INSERT INTO notifications (user_id, type, title, message, read, created_at) VALUES ${nRows.join(',')}`,
        nParams
      );
      console.log('Seed: inserted ' + idx + ' demo notifications.');
    }
  } else {
    console.log('Seed: notifications already exist - skipping.');
  }

  // 5. Seed home-screen tasks (idempotent by title).
  for (const t of DEFAULT_TASKS) {
    const exists = (await pool.query('SELECT id FROM tasks WHERE title = $1', [t.title])).rows[0];
    if (!exists) {
      await pool.query(
        'INSERT INTO tasks (title, description, reward, condition, sort_order) VALUES ($1, $2, $3, $4, $5)',
        [t.title, t.description, t.reward, t.condition, t.sort_order]
      );
      console.log("Seed: added task '" + t.title + "'.");
    }
  }
}

module.exports = { seed };
