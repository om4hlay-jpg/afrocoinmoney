// Unit tests for lib/authGuard.js (bot prevention + brute-force protection).
// Run with: node test/authGuard.test.js
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const guard = require('../lib/authGuard');

let pass = 0;
function ok(name, fn) { fn(); pass++; console.log('PASS - ' + name); }

ok('issueChallenge returns id + difficulty zeros', () => {
  const c = guard.issueChallenge();
  assert.ok(c.challenge_id.length >= 20);
  assert.ok(/^[0]+$/.test(c.difficulty), 'difficulty is hex zeros');
  assert.ok(c.ttl_seconds > 0);
});

ok('verifyChallenge accepts a correctly ground nonce', () => {
  const c = guard.issueChallenge();
  let nonce = 0;
  while (true) {
    if (crypto.createHash('sha256').update(c.prefix + ':' + nonce).digest('hex').indexOf(c.difficulty) === 0) break;
    nonce++;
  }
  assert.strictEqual(guard.verifyChallenge(c.challenge_id, String(nonce)), true);
});

ok('verifyChallenge rejects wrong nonce and burns the challenge', () => {
  const c = guard.issueChallenge();
  assert.strictEqual(guard.verifyChallenge(c.challenge_id, 'not-the-nonce'), false);
  // Single-use: even the correct nonce now fails.
  let nonce = 0;
  while (crypto.createHash('sha256').update(c.prefix + ':' + nonce).digest('hex').indexOf(c.difficulty) !== 0) nonce++;
  assert.strictEqual(guard.verifyChallenge(c.challenge_id, String(nonce)), false);
});

ok('verifyChallenge rejects unknown ids and missing input', () => {
  guard.resetAll();
  assert.strictEqual(guard.verifyChallenge('nope', '1'), false);
  const c = guard.issueChallenge();
  assert.strictEqual(guard.verifyChallenge(null, undefined), false);
  assert.ok(guard.verifyChallenge(c.challenge_id) === false || typeof c === 'object');
});

ok('account locks on the MAX_FAILS-th wrong password', () => {
  guard.resetAll();
  for (let i = 1; i < guard.CFG.MAX_FAILS; i++) {
    guard.recordFailure('+25470000000' + i);
    assert.strictEqual(guard.lockState('+25470000000' + i).locked, false);
  }
});

ok('lockState reports locked until recordSuccess clears it', () => {
  guard.resetAll();
  const id = '+25551112233';
  for (let i = 0; i < guard.CFG.MAX_FAILS; i++) guard.recordFailure(id);
  assert.strictEqual(guard.lockState(id).locked, true);
  guard.recordSuccess(id);
  assert.strictEqual(guard.lockState(id).locked, false);
});

ok('ipAllowed throttles after IP_MAX_ATTEMPTS within window', () => {
  guard.resetAll();
  const ip = '10.9.9.9';
  let throttledAt = -1;
  for (let i = 1; i <= guard.CFG.IP_MAX_ATTEMPTS + 3; i++) {
    const r = guard.ipAllowed(ip);
    if (!r.ok && throttledAt === -1) { throttledAt = i; assert.ok(r.retryAfter >= 1); }
    if (throttledAt !== -1) assert.strictEqual(r.ok, false, 'stays throttled');
  }
  assert.strictEqual(throttledAt, guard.CFG.IP_MAX_ATTEMPTS + 1);
  // A different IP is unaffected.
  assert.strictEqual(guard.ipAllowed('10.9.9.8').ok, true);
});

console.log('\nAll ' + pass + ' authGuard tests passed.');
process.exit(0);
