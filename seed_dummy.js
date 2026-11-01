
const { Pool } = require('pg');
const dotenv = require('dotenv');
dotenv.config({ path: 'D:/WEB/gwalla/hyip-crypto/.env' });

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  
  // Count existing transactions
  const countRes = await pool.query('SELECT COUNT(*)::int AS cnt FROM transactions');
  const count = countRes.rows[0].cnt;
  console.log('Existing transactions:', count);
  
  if (count >= 100) {
    console.log('Already have 100+ transactions, skipping.');
    await pool.end();
    return;
  }
  
  const types = ['deposit', 'withdrawal', 'referral_bonus', 'bonus', 'earnings'];
  const methods = ['BTC', 'ETH', 'USDT (TRC20)', 'USDC (ERC20)', 'SOL', 'LTC'];
  const statuses = ['success', 'success', 'success', 'pending', 'failed'];
  
  const rows = [];
  const params = [];
  const needed = 100 - count;
  
  for (let i = 0; i < needed; i++) {
    const type = types[Math.floor(Math.random() * types.length)];
    const method = methods[Math.floor(Math.random() * methods.length)];
    const amount = (Math.random() * 500 + 5).toFixed(2);
    const fee = type === 'withdrawal' ? (amount * 0.1).toFixed(2) : '0';
    const net = type === 'withdrawal' ? (amount - fee).toFixed(2) : amount;
    const status = statuses[Math.floor(Math.random() * statuses.length)];
    const ref = 'dummy-' + i + '-' + Date.now();
    const daysAgo = Math.floor(Math.random() * 30);
    const created = new Date(Date.now() - daysAgo * 86400000).toISOString();
    rows.push(`($${i * 8 + 1}, $${i * 8 + 2}, $${i * 8 + 3}, $${i * 8 + 4}, $${i * 8 + 5}, $${i * 8 + 6}, $${i * 8 + 7}, $${i * 8 + 8})`);
    params.push(type, method, amount, fee, net, status, ref, created);
  }
  
  await pool.query(
    `INSERT INTO transactions (type, method, amount, fee, net_amount, status, reference, created_at) VALUES ${rows.join(',')}`,
    params
  );
  
  console.log('Inserted', needed, 'dummy transactions.');
  await pool.end();
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
