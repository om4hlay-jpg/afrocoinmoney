// Unit tests for the daily-earnings cron worker (lib/cron.js).
// Run with: node test/cron.test.js
'use strict';
const assert = require('assert');
const { runDailyEarningsCycle, clampConcurrency, DEFAULT_CONCURRENCY } = require('../lib/cron');

let pass = 0;
let fail = 0;
// Async test helper (same shape as payments.test.js).
async function ok(name, fn) {
  try {
    await fn();
    pass++;
    console.log('PASS - ' + name);
  } catch (e) {
    fail++;
    console.error('FAIL - ' + name + ': ' + (e && e.message ? e.message : e));
  }
}

// A fake pool whose query() always resolves with the given rows.
function mockPool(rows) {
  return {
    query: async () => ({ rows: rows.slice() }),
    end: async () => {}
  };
}

(async () => {
  await ok('processes every active user', async () => {
    const called = [];
    const result = await runDailyEarningsCycle(2, {
      pool: mockPool([{ user_id: 1 }, { user_id: 2 }, { user_id: 3 }]),
      processDailyEarnings: async (id) => { called.push(id); }
    });
    assert.strictEqual(result.processed, 3);
    assert.strictEqual(result.errors, 0);
    assert.deepStrictEqual(called.sort((a, b) => a - b), [1, 2, 3]);
  });

  await ok('a failing user does not stop the cycle', async () => {
    const called = [];
    const result = await runDailyEarningsCycle(1, {
      pool: mockPool([{ user_id: 10 }, { user_id: 20 }, { user_id: 30 }]),
      processDailyEarnings: async (id) => {
        called.push(id);
        if (id === 20) throw new Error('boom');
      }
    });
    assert.strictEqual(result.processed, 3);
    assert.strictEqual(result.errors, 1);
    assert.deepStrictEqual(called.sort((a, b) => a - b), [10, 20, 30]);
  });

  await ok('respects a concurrency limit of 1', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const result = await runDailyEarningsCycle(1, {
      pool: mockPool([{ user_id: 1 }, { user_id: 2 }, { user_id: 3 }, { user_id: 4 }]),
      processDailyEarnings: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(r => setTimeout(r, 5));
        inFlight--;
      }
    });
    assert.strictEqual(result.processed, 4);
    assert.ok(maxInFlight <= 1, 'never more than 1 concurrent with concurrency=1, saw ' + maxInFlight);
  });

  await ok('clampConcurrency falls back to the default for junk input', async () => {
    assert.strictEqual(clampConcurrency(undefined), DEFAULT_CONCURRENCY);
    assert.strictEqual(clampConcurrency(0), DEFAULT_CONCURRENCY);
    assert.strictEqual(clampConcurrency(-2), DEFAULT_CONCURRENCY);
    assert.strictEqual(clampConcurrency('abc'), DEFAULT_CONCURRENCY);
    assert.strictEqual(clampConcurrency(7), 7);
  });

  // Summary + exit run only after every awaited test above has settled.
  console.log('\n' + pass + ' passed, ' + fail + ' failed.');
  process.exit(fail ? 1 : 0);
})();
