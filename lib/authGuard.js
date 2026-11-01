// lib/authGuard.js
// Bot prevention + brute-force protection for the auth endpoints.
// Zero dependencies - in-memory state, designed for a single-process Node
// server (PM2 fork mode, see deploy.md). Behind Nginx, app.set('trust proxy')
// makes req.ip resolve to the real client address.
//
// Layers:
//   1. Per-IP sliding-window rate limit  - every POST /auth/login|register hit
//   2. Per-account lockout              - 5 consecutive failed passwords -> lock
//   3. Proof-of-work challenge (login)  - bots must burn CPU per attempt
//   4. Honeypot field (login)           - silent-reject filled traps
//
// All knobs are env-tunable; see .env.example.
'use strict';

const crypto = require('crypto');

function intEnv(name, dflt) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

const CFG = {
  IP_WINDOW_MS: intEnv('GUARD_IP_WINDOW_MS', 10 * 60 * 1000),
  IP_MAX_ATTEMPTS: intEnv('GUARD_IP_MAX_ATTEMPTS', 25),
  MAX_FAILS: intEnv('GUARD_MAX_FAILS', 5),
  LOCK_MS: intEnv('GUARD_LOCK_MS', 15 * 60 * 1000),
  FAIL_RESET_MS: intEnv('GUARD_FAIL_RESET_MS', 15 * 60 * 1000),
  CHALLENGE_TTL_MS: intEnv('GUARD_CHALLENGE_TTL_MS', 120 * 1000),
  POW_BITS: Math.min(intEnv('GUARD_POW_BITS', 16), 24)
};

// --- State -----------------------------------------------------------------
const ipHits = new Map();      // ip        -> { count, windowStart }
const idFails = new Map();     // idKey     -> { count, lastFailAt, lockUntil }
const challenges = new Map();  // cid       -> { prefix, zeros, expiresAt, used }

// Periodic sweep so maps cannot grow unbounded on a long-lived VPS.
const SWEEP_MS = 5 * 60 * 1000;
const sweepTimer = setInterval(sweep, SWEEP_MS);
if (sweepTimer.unref) sweepTimer.unref();

function sweep() {
  const now = Date.now();
  for (const [k, v] of ipHits) if (now > v.windowStart + CFG.IP_WINDOW_MS) ipHits.delete(k);
  for (const [k, v] of idFails) {
    if (now > v.lastFailAt + CFG.FAIL_RESET_MS && now > v.lockUntil) idFails.delete(k);
  }
  for (const [k, v] of challenges) if (v.used || now > v.expiresAt) challenges.delete(k);
}

// --- 1. Per-IP sliding window ----------------------------------------------
// Counts every attempt (even malformed ones) - bots do not differentiate.
function ipAllowed(ip) {
  const now = Date.now();
  let rec = ipHits.get(ip);
  if (!rec || now - rec.windowStart >= CFG.IP_WINDOW_MS) {
    rec = { count: 0, windowStart: now };
    ipHits.set(ip, rec);
  }
  rec.count += 1;
  if (rec.count > CFG.IP_MAX_ATTEMPTS) {
    const retryAfter = Math.ceil((rec.windowStart + CFG.IP_WINDOW_MS - now) / 1000);
    return { ok: false, retryAfter: Math.max(retryAfter, 1) };
  }
  return { ok: true, remaining: CFG.IP_MAX_ATTEMPTS - rec.count };
}

// --- 2. Per-account lockout -------------------------------------------------
function idKey(identifier) {
  return String(identifier || '').trim().toLowerCase().replace(/\s+/g, '');
}

function lockState(identifier) {
  const rec = idFails.get(idKey(identifier));
  if (!rec) return { locked: false };
  const now = Date.now();
  if (rec.lockUntil > now) {
    return { locked: true, retryAfter: Math.ceil((rec.lockUntil - now) / 1000) };
  }
  return { locked: false, fails: rec.count };
}

function recordFailure(identifier) {
  const key = idKey(identifier);
  const now = Date.now();
  let rec = idFails.get(key);
  // Consecutive failures older than FAIL_RESET_MS start counting from zero.
  if (!rec || now - rec.lastFailAt > CFG.FAIL_RESET_MS) {
    rec = { count: 0, lastFailAt: now, lockUntil: 0 };
  }
  rec.count += 1;
  rec.lastFailAt = now;
  if (rec.count >= CFG.MAX_FAILS) {
    rec.lockUntil = now + CFG.LOCK_MS;
  }
  idFails.set(key, rec);
  return rec;
}

function recordSuccess(identifier) {
  idFails.delete(idKey(identifier));
}

// --- 3. Proof-of-work --------------------------------------------------------
// Client must find nonce with sha256(prefix:nonce) starting with `zeros`.
// 16 bits averages ~65k hashes (~30-80 ms in a browser) - invisible to humans,
// expensive at bot-farm scale.
function issueChallenge(now) {
  now = now || Date.now();
  // Bound memory: drop oldest when more than 10k outstanding.
  if (challenges.size > 10000) {
    const oldest = challenges.keys().next().value;
    challenges.delete(oldest);
  }
  const cid = crypto.randomBytes(12).toString('hex');
  const prefix = crypto.randomBytes(16).toString('hex');
  const zeros = '0'.repeat(CFG.POW_BITS >> 2); // hex zeros
  challenges.set(cid, { prefix, zeros, expiresAt: now + CFG.CHALLENGE_TTL_MS, used: false });
  return { challenge_id: cid, prefix: prefix, difficulty: zeros, ttl_seconds: CFG.CHALLENGE_TTL_MS / 1000 };
}

function verifyChallenge(challengeId, nonce, now) {
  now = now || Date.now();
  if (!challengeId || nonce === undefined || nonce === null) return false;
  const ch = challenges.get(String(challengeId));
  if (!ch || ch.used || now > ch.expiresAt) return false;
  ch.used = true; // single-use, consumed even on wrong nonce
  try {
    const digest = crypto.createHash('sha256').update(ch.prefix + ':' + String(nonce)).digest('hex');
    return digest.startsWith(ch.zeros);
  } catch (e) {
    return false;
  }
}

// --- Test hooks / ops ---------------------------------------------------------
function resetAll() {
  ipHits.clear();
  idFails.clear();
  challenges.clear();
}

module.exports = {
  CFG,
  ipAllowed,
  lockState,
  recordFailure,
  recordSuccess,
  issueChallenge,
  verifyChallenge,
  resetAll
};
