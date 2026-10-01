import assert from 'assert';
import test, { before } from 'node:test';

import { useTestDb } from '../helpers/db.js';
import db from '../../src/core/database.js';
import marketDataFeedService from '../../src/services/market-data-feed.service.js';

before(() => useTestDb('quote-snapshots-gone'));

// H13: a tick only updates the in-memory caches; nothing is written per tick.
test('a quote tick is served from the symbol cache and the quote_snapshots table is gone', async () => {
  const table = await db.get("SELECT name FROM sqlite_master WHERE name = 'quote_snapshots'");
  assert.ok(!table);

  marketDataFeedService.setQuoteSnapshot(7, [{ exchange: 'NSE', symbol: 'SBIN', ltp: 812.5 }]);
  const { cached, missing } = marketDataFeedService.getCachedQuoteEntriesForSymbols(
    [{ exchange: 'NSE', symbol: 'SBIN' }, { exchange: 'NSE', symbol: 'TCS' }],
    { ttlMs: Infinity }
  );
  assert.strictEqual(cached[0].quote.ltp, 812.5);
  assert.deepStrictEqual(missing.map((m) => m.symbol), ['TCS']);
});
