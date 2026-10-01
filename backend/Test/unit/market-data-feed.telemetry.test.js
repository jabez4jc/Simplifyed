import assert from 'assert';
import test from 'node:test';
import marketDataFeedService from '../../src/services/market-data-feed.service.js';
import openalgoClient from '../../src/integrations/openalgo/client.js';

test('getCacheStatus marks stale quote cache entries', () => {
  const instanceId = 99999;
  const ttl = marketDataFeedService.QUOTE_TTL_MS;

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
});

test('getCacheStatus surfaces an open instance circuit that has no cache entry', () => {
  // Circuit state lives in the client's instance-health-tracker; getCacheStatus only asks for it.
  const id = 888;
  openalgoClient.recordInstanceFailure(id, new Error('test error'), { isHtml: true });

  const status = marketDataFeedService.getCacheStatus();
  const entry = status.entries.find((e) => String(e.instanceId) === String(id));
  assert.ok(entry, 'should include circuit-only entry');
  assert.equal(entry.circuitOpen, true);
  assert.equal(entry.circuitLastError, 'test error');

  openalgoClient.forceResetInstanceHealth(id);
});

test('the feed has no ping loop of its own; instance health is the client tracker\'s verdict', () => {
  assert.equal(marketDataFeedService._pingInstancesHeartbeat, undefined);
  assert.equal(marketDataFeedService.healthPingIntervalHandle, undefined);

  const id = 889;
  assert.equal(marketDataFeedService._isInstanceUnhealthy(id), false);
  openalgoClient.recordInstanceFailure(id, new Error('down'), { isHtml: true });
  assert.equal(marketDataFeedService._isInstanceUnhealthy(id), true);
  openalgoClient.forceResetInstanceHealth(id);
});
