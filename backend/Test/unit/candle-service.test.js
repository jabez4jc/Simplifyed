import assert from 'assert';
import test from 'node:test';
import candleService, { TIMEFRAME_SECONDS } from '../../src/services/candle.service.js';

/**
 * Pure logic only - no broker calls. The parts that decide whether we hit a live broker at all,
 * and how raw history rows become candles, are the parts worth pinning.
 */

test('timeframes are validated against a known set', () => {
  for (const tf of ['1m', '5m', '15m', '1h', 'D']) {
    assert.ok(candleService.isValidTimeframe(tf), `${tf} should be valid`);
  }
  for (const tf of ['7x', '', null, undefined, '5', 'minute']) {
    assert.ok(!candleService.isValidTimeframe(tf), `${JSON.stringify(tf)} should be rejected`);
  }
});

test('getCandles rejects bad input before touching a broker', async () => {
  await assert.rejects(
    () => candleService.getCandles({ exchange: 'NSE', symbol: 'SBIN', timeframe: 'nope' }),
    /timeframe must be one of/
  );
  await assert.rejects(
    () => candleService.getCandles({ symbol: 'SBIN', timeframe: '5m' }),
    /exchange and symbol are required/
  );
  await assert.rejects(
    () => candleService.getCandles({
      exchange: 'NSE', symbol: 'SBIN', timeframe: '5m', from: 2000, to: 1000,
    }),
    /from must be earlier than to/
  );
});

test('history rows normalize to candles, tolerating field aliases', () => {
  const rows = candleService._normalize([
    { timestamp: 1784519100, open: 1, high: 3, low: 0.5, close: 2, volume: 100, oi: 5 },
    // Some brokers abbreviate; both shapes must land the same way.
    { t: 1784519400, o: 2, h: 4, l: 1.5, c: 3, v: 200 },
  ]);
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows[0], {
    ts: 1784519100, open: 1, high: 3, low: 0.5, close: 2, volume: 100, oi: 5,
  });
  assert.strictEqual(rows[1].close, 3);
  assert.strictEqual(rows[1].oi, 0, 'missing oi defaults to 0, not NaN');
});

test('normalize drops unusable rows and sorts ascending', () => {
  const rows = candleService._normalize([
    { timestamp: 300, open: 1, close: 1 },
    { timestamp: 'garbage', open: 1 },
    { open: 1, close: 1 },
    null,
    { timestamp: 100, open: 1, close: 1 },
  ]);
  assert.strictEqual(rows.length, 2, 'rows without a usable timestamp are dropped');
  assert.deepStrictEqual(rows.map((r) => r.ts), [100, 300], 'must be time-ascending for the chart');
});

test('normalize handles a non-array response', () => {
  assert.deepStrictEqual(candleService._normalize(null), []);
  assert.deepStrictEqual(candleService._normalize({ error: 'nope' }), []);
});

test('tail staleness decides whether a broker call is needed', () => {
  const now = Math.floor(Date.now() / 1000);

  assert.ok(candleService._tailIsStale([], '5m', now), 'empty cache is always stale');

  // Newest candle is younger than one bar - nothing new can exist yet.
  const fresh = [{ ts: now - 60 }];
  assert.ok(!candleService._tailIsStale(fresh, '5m', now), 'within one bar => not stale');

  // A full bar has elapsed, so a new candle should be available.
  const old = [{ ts: now - 400 }];
  assert.ok(candleService._tailIsStale(old, '5m', now), 'past one bar => stale');

  // Same gap, coarser timeframe: still inside one bar, so still fresh.
  assert.ok(!candleService._tailIsStale(old, '1h', now), 'gap must be judged against bar size');
});

test('every timeframe has a positive, ordered bar size', () => {
  const entries = Object.entries(TIMEFRAME_SECONDS);
  assert.ok(entries.length > 0);
  for (const [tf, secs] of entries) {
    assert.ok(Number.isFinite(secs) && secs > 0, `${tf} needs a positive duration`);
  }
  assert.ok(TIMEFRAME_SECONDS['1m'] < TIMEFRAME_SECONDS['5m']);
  assert.ok(TIMEFRAME_SECONDS['1h'] < TIMEFRAME_SECONDS.D);
});
