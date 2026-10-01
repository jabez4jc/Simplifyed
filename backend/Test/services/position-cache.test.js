import { test } from 'node:test';
import assert from 'node:assert';
import marketDataFeedService from '../../src/services/market-data-feed.service.js';

const book = [{ symbol: 'NIFTY06OCT2622550CE', quantity: 1170 }];

test('a position book stays readable while the refresh after an order is in flight', async () => {
  const feed = marketDataFeedService;
  feed.positionCache.set(77, { data: book, fetchedAt: Date.now() });
  const original = feed.refreshPositionsForInstance;
  let release;
  feed.refreshPositionsForInstance = () => new Promise((resolve) => { release = resolve; });
  try {
    const refreshing = feed.invalidateInstanceCaches(77, { refresh: true, feeds: ['positions'] });
    assert.deepStrictEqual(feed.getPositionSnapshot(77)?.data, book, 'the chart reads the old book, not nothing');
    release(true);
    await refreshing;
  } finally {
    feed.refreshPositionsForInstance = original;
  }
});

test('without a refresh the book is dropped, as before', async () => {
  marketDataFeedService.positionCache.set(78, { data: book, fetchedAt: Date.now() });
  await marketDataFeedService.invalidateInstanceCaches(78, { refresh: false, feeds: ['positions'] });
  assert.strictEqual(marketDataFeedService.getPositionSnapshot(78), undefined);
});
