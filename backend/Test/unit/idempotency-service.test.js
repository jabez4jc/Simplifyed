import assert from 'assert';
import test from 'node:test';
import db from '../../src/core/database.js';
import idempotencyService from '../../src/services/idempotency.service.js';

const SOURCE = 'idempotency-service-test';

async function cleanup() {
  await db.run('DELETE FROM idempotency_keys WHERE source = ?', [SOURCE]);
}

// The regression this guards: getOrCreate used to swallow the UNIQUE(request_id, source)
// violation and return hit:false to *both* racing callers, so a retried TradingView alert
// placed the order twice.
test('getOrCreate lets exactly one of several concurrent identical requests through', async () => {
  await db.connect();
  await cleanup();
  try {
    const requestId = `concurrent-${Date.now()}`;
    const payload = { symbol: 'NIFTY', qty: 50 };

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        idempotencyService.getOrCreate({ requestId, source: SOURCE, payload })
      )
    );

    const proceeded = results.filter((r) => !r.hit);
    assert.strictEqual(proceeded.length, 1, 'exactly one caller may proceed to place the order');
    assert.ok(results.every((r) => r.record), 'every caller should get the stored record back');
    assert.ok(results.every((r) => !r.mismatch), 'identical payloads are not a mismatch');
  } finally {
    await cleanup();
  }
});

test('getOrCreate flags a reused request id carrying a different payload', async () => {
  await db.connect();
  await cleanup();
  try {
    const requestId = `mismatch-${Date.now()}`;
    const first = await idempotencyService.getOrCreate({
      requestId,
      source: SOURCE,
      payload: { symbol: 'NIFTY' },
    });
    assert.strictEqual(first.hit, false);

    const second = await idempotencyService.getOrCreate({
      requestId,
      source: SOURCE,
      payload: { symbol: 'BANKNIFTY' },
    });
    assert.strictEqual(second.hit, true);
    assert.strictEqual(second.mismatch, true);
  } finally {
    await cleanup();
  }
});

// expires_at must be written in SQLite's 'YYYY-MM-DD HH:MM:SS' UTC shape. toISOString()'s 'T'
// separator sorts above ' ', which kept same-day keys from ever being collected.
test('cleanupExpired collects a key that expired earlier today', async () => {
  await db.connect();
  await cleanup();
  try {
    const requestId = `expiry-${Date.now()}`;
    await idempotencyService.getOrCreate({ requestId, source: SOURCE, payload: { a: 1 } });

    const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString().replace('T', ' ').slice(0, 19);
    await db.run('UPDATE idempotency_keys SET expires_at = ? WHERE request_id = ? AND source = ?', [
      oneMinuteAgo,
      requestId,
      SOURCE,
    ]);

    await idempotencyService.cleanupExpired();

    const row = await db.get(
      'SELECT id FROM idempotency_keys WHERE request_id = ? AND source = ?',
      [requestId, SOURCE]
    );
    assert.strictEqual(row, null, 'expired key should have been deleted');
  } finally {
    await cleanup();
  }
});

// Overlapping transactions on the shared single connection used to interleave their
// BEGIN/COMMIT, cross-committing each other's partial writes.
test('transaction() serializes overlapping callers', async () => {
  await db.connect();
  let inFlight = 0;
  let maxInFlight = 0;

  await Promise.all(
    Array.from({ length: 4 }, () =>
      db.transaction(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight -= 1;
      })
    )
  );

  assert.strictEqual(maxInFlight, 1, 'only one transaction may be open at a time');
});

test('a failing transaction rolls back without stalling the queue', async () => {
  await db.connect();
  await assert.rejects(
    db.transaction(async () => {
      throw new Error('boom');
    }),
    /boom/
  );

  const result = await db.transaction(async () => 'still works');
  assert.strictEqual(result, 'still works');
});
