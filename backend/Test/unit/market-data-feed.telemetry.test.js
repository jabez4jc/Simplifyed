import assert from 'assert';
import test from 'node:test';
import marketDataFeedService from '../../src/services/market-data-feed.service.js';

test('getCacheStatus marks stale quote cache entries', () => {
  const instanceId = 99999;
  const ttl = marketDataFeedService.QUOTE_TTL_MS;
  const previousFlag = marketDataFeedService.quoteSnapshotTableMissing;
  marketDataFeedService.quoteSnapshotTableMissing = true; // avoid DB writes during test

  marketDataFeedService.setQuoteSnapshot(
    instanceId,
    [{ exchange: 'NSE', symbol: 'TEST', ltp: 1 }],
    { fetchedAt: Date.now() - ttl - 1000 }
  );

  const status = marketDataFeedService.getCacheStatus();
  const entry = status.entries.find((e) => e.instanceId === instanceId && e.feed === 'quotes');
  assert.ok(entry, 'should include quote entry');
  assert.equal(entry.stale, true);

  // cleanup
  marketDataFeedService.quoteCache.delete(instanceId);
  marketDataFeedService.quoteSnapshotTableMissing = previousFlag;
});

test('getCacheStatus surfaces circuit-only state', () => {
  const key = '888:quotes';
  marketDataFeedService.failureState.set(key, {
    cooldownUntil: Date.now() + 1000,
    lastErrorMessage: 'test error',
    failures: 1,
  });

  const status = marketDataFeedService.getCacheStatus();
  const entry = status.entries.find((e) => String(e.instanceId) === '888' && e.feed === 'quotes');
  assert.ok(entry, 'should include circuit-only entry');
  assert.equal(entry.circuitOpen, true);

  // cleanup
  marketDataFeedService.failureState.delete(key);
});
