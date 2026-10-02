import assert from 'assert';
import test from 'node:test';

import feed from '../../src/services/market-data-feed.service.js';
import instanceService from '../../src/services/instance.service.js';
import marketCalendarService from '../../src/services/market-calendar.service.js';
import marketDataInstanceService from '../../src/services/market-data-instance.service.js';
import openalgoClient from '../../src/integrations/openalgo/client.js';
import config from '../../src/core/config.js';

/** Replace methods on a singleton for one test, and put them back afterwards. */
const stub = (obj, patch) => {
  const saved = Object.fromEntries(Object.keys(patch).map((k) => [k, obj[k]]));
  Object.assign(obj, patch);
  return () => Object.assign(obj, saved);
};

test('positions refresh every instance in parallel, not one after another with a sleep', async () => {
  const started = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const restore = [
    stub(instanceService, { getAllInstances: async () => [{ id: 1 }, { id: 2 }, { id: 3 }] }),
    stub(marketCalendarService, { isInstanceMarketOpen: async () => true }),
    stub(feed, { refreshPositionsForInstance: async (id) => { started.push(id); await gate; return true; } }),
  ];
  try {
    const run = feed.refreshPositions({ force: false });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(started, [1, 2, 3], 'all three started before any finished');
    release();
    await run;
  } finally {
    restore.forEach((r) => r());
  }
});

test('a refresh already running is joined, not started twice', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const restore = [
    stub(instanceService, { getAllInstances: async () => { calls += 1; await gate; return []; } }),
  ];
  try {
    const a = feed.refreshFunds({ force: true });
    const b = feed.refreshFunds({ force: true });
    assert.strictEqual(a, b, 'the second caller gets the first run');
    release();
    await a;
    assert.strictEqual(calls, 1);
    await feed.refreshFunds({ force: true });
    assert.strictEqual(calls, 2, 'a later call runs again once the first finished');
  } finally {
    restore.forEach((r) => r());
  }
});

test('the quote fallback asks only the multiquote pool', async () => {
  const asked = [];
  const multi = { id: 1, name: 'multi', broker: 'kotak', supports_multiquotes: 1, multiquotes_ok: 1 };
  const plain = { id: 2, name: 'plain', broker: 'kotak', supports_multiquotes: 0 };
  const restoreFeed = stub(feed, {
    _buildGlobalSymbolList: async () => [{ exchange: 'NSE', symbol: 'SBIN' }],
    _filterSymbolsByMarketOpen: async (s) => s,
    _fetchViaMultiQuotes: async (pendingSymbols) => ({ quotes: [], pendingSymbols, sourceInstanceId: null }),
    _isInstanceUnhealthy: () => false,
    _tradesExchange: () => true,
  });
  const restore = [
    restoreFeed,
    stub(marketDataInstanceService, { getPoolForEndpoint: async () => [multi, plain] }),
    stub(openalgoClient, { getMultiQuotes: async (inst) => { asked.push(inst.id); return { quotes: [] }; } }),
  ];
  const lastRefresh = feed.lastQuoteRefreshAt;
  try {
    await feed.refreshQuotes({ force: true });
    assert.ok(asked.length > 0 && asked.every((id) => id === 1), `asked instances: ${asked}`);
  } finally {
    restore.forEach((r) => r());
    feed.lastQuoteRefreshAt = lastRefresh;
  }
});

test('intervals come from config alone', () => {
  feed.applyConfig();
  assert.strictEqual(feed.positionIntervalActiveMs, config.marketDataFeed.positionIntervalActiveMs);
  assert.strictEqual(feed.positionIntervalIdleMs, config.marketDataFeed.positionIntervalIdleMs);
  assert.strictEqual(feed.quoteIntervalMs, config.polling.marketDataInterval);
});
