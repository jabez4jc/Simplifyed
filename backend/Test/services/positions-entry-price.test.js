import assert from 'assert';
import test, { mock, afterEach } from 'node:test';
import positionsService from '../../src/services/positions.service.js';
import marketDataFeedService from '../../src/services/market-data-feed.service.js';
import { prepareTradebook } from '../../src/utils/tradebook-utils.js';

/**
 * H8: the chart drew entries/levels from a tradebook average of mixed buys AND sells, the last
 * order price, and other instances' LTP - while auto-exit acts on the broker average price. The
 * two now share one ladder, so the levels on the chart are where auto-exit will fire.
 */

afterEach(() => mock.restoreAll());

const pos = (extra = {}) => ({ symbol: 'SBIN', exchange: 'NSE', product: 'MIS', quantity: 5, ...extra });
const trade = (action, quantity, price, t) => ({
  symbol: 'SBIN', exchange: 'NSE', action, quantity, average_price: price, timestamp: `2026-10-02T09:${t}:00+05:30`,
});

test('the broker average price is the entry (101.5 stays 101.5)', () => {
  mock.method(marketDataFeedService, 'getFallbackEntryPrice', () => null);
  const tradebook = prepareTradebook([trade('BUY', 5, 90, '15')]);
  const r = positionsService._resolveEntryPrice(pos({ average_price: 101.5 }), 1, tradebook);
  assert.deepStrictEqual(r, { price: 101.5, source: 'broker_avg', capturedAt: null });
});

test('without a broker average, the FIFO entry-side tradebook average is used - sells never mix in', () => {
  mock.method(marketDataFeedService, 'getFallbackEntryPrice', () => null);
  // Bought 10 @100, sold 5 @120: 5 long remain, entered at 100 (a mixed average would say 106.7).
  const tradebook = prepareTradebook([trade('BUY', 10, 100, '15'), trade('SELL', 5, 120, '30')]);
  const r = positionsService._resolveEntryPrice(pos(), 1, tradebook);
  assert.strictEqual(r.price, 100);
  assert.strictEqual(r.source, 'tradebook_avg');
});

test('with neither, the entry is null - no median-LTP or last-order guess', () => {
  mock.method(marketDataFeedService, 'getFallbackEntryPrice', () => null);
  const r = positionsService._resolveEntryPrice(pos(), 1, []);
  assert.strictEqual(r.price, null);
});

test('reading positions never forces a tradebook fetch', async () => {
  mock.method(marketDataFeedService, 'getPositionSnapshot', () => ({ data: [pos()] }));
  mock.method(marketDataFeedService, 'getTradebookSnapshotCached', () => null);
  mock.method(marketDataFeedService, 'getFallbackEntryPrice', () => null);
  const forced = mock.method(marketDataFeedService, 'getTradebookSnapshot', async () => { throw new Error('must not fetch'); });
  const res = await positionsService._fetchInstancePositions({ id: 1, name: 'T' }, true, false);
  assert.strictEqual(forced.mock.callCount(), 0);
  assert.strictEqual(res.positions[0].entry_price, null);
});

test('the dead guess helpers are gone', () => {
  for (const name of ['_median', '_buildOrderPriceMap', '_buildTradeAvgMap']) {
    assert.strictEqual(positionsService[name], undefined, name);
  }
});
