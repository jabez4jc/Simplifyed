import assert from 'assert';
import test from 'node:test';
import { sanitiseQuote } from '../../src/services/market-data-feed.service.js';

/**
 * Broker feeds relayed through OpenAlgo send INT32 overflow markers for fields they have no
 * value for. Prices are scaled by 100, so an unset price arrives as 2^31/100 = 21474836.48.
 *
 * This was seen live: NSE_INDEX NIFTY arrived with open/high/low of 21474836.48 and a volume of
 * exactly 2^31. Cached and charted, it drew a 21-million-rupee candle; used as the cumulative
 * volume baseline it made every subsequent delta meaningless.
 */
const SENTINEL = 2 ** 31;
const SENTINEL_PRICE = SENTINEL / 100;

test('the exact NIFTY packet that broke the chart is stripped of its sentinels', () => {
  const clean = sanitiseQuote({
    ltp: 25665.6, ltt: 1768496464563, volume: SENTINEL,
    open: SENTINEL_PRICE, high: SENTINEL_PRICE, low: SENTINEL_PRICE,
    close: 25732.3, symbol: 'NIFTY', exchange: 'NSE_INDEX',
  });
  assert.ok(clean, 'a usable last price means the quote is still worth keeping');
  assert.strictEqual(clean.ltp, 25665.6);
  assert.strictEqual(clean.close, 25732.3);
  // Dropped, not zeroed: a missing high is honest, a high of 0 is a price that never traded.
  for (const field of ['open', 'high', 'low', 'volume']) {
    assert.ok(!(field in clean), `${field} must be dropped, got ${clean[field]}`);
  }
});

test('a quote with no usable last price is discarded outright', () => {
  assert.strictEqual(sanitiseQuote({ open: 100, high: 101 }), null);
  assert.strictEqual(sanitiseQuote({ ltp: 0 }), null);
  assert.strictEqual(sanitiseQuote({ ltp: -5 }), null);
  assert.strictEqual(sanitiseQuote({ ltp: SENTINEL_PRICE }), null, 'a sentinel LTP is not a price');
  assert.strictEqual(sanitiseQuote(null), null);
  assert.strictEqual(sanitiseQuote('nope'), null);
});

test('ordinary quotes pass through untouched', () => {
  const good = { ltp: 276.8, open: 275, high: 277.2, low: 274.9, close: 276.5, volume: 41000, symbol: 'X' };
  assert.deepStrictEqual(sanitiseQuote(good), good);
});

test('a zero volume is kept - it is a real reading, unlike the sentinel', () => {
  const clean = sanitiseQuote({ ltp: 100, volume: 0 });
  assert.strictEqual(clean.volume, 0);
});
