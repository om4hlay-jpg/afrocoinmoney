// Admin-only authentication middleware.
// Every admin request is re-checked against the database (not the JWT), so
// revoking someone's admin rights takes effect on their very next request
// rather than whenever their token happens to expire.
const jwt = require('jsonwebtoken');
const { pool } = require('../db');

async function adminRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'You must be logged in.' });

  let id;
  try {
    id = jwt.verify(token, process.env.JWT_SECRET).id;
  } catch (err) {
    return res.status(401).json({ error: 'Your session has expired. Please log in again.' });
  }

  try {
    const row = (await pool.query(
      'SELECT id, is_admin, deleted_at FROM users WHERE id = $1',
      [id]
    )).rows[0];
    if (!row || row.deleted_at) return res.status(401).json({ error: 'Account not found.' });
    if (!row.is_admin) return res.status(403).json({ error: 'Administrator access required.' });
    req.user = { id: row.id };
    return next();
  } catch (err) {
    console.error('Admin auth error:', err);
    return res.status(500).json({ error: 'Could not verify administrator access.' });
  }
}

module.exports = { adminRequired };
