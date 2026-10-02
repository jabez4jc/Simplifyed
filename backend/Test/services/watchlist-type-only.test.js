import assert from 'assert';
import test, { before } from 'node:test';

import { useTestDb } from '../helpers/db.js';
import db from '../../src/core/database.js';
import watchlistService from '../../src/services/watchlist.service.js';

before(() => useTestDb('watchlist-type-only'));

test('watchlists.is_broadcast is gone; type is the single source (F4)', async () => {
  const cols = (await db.all('PRAGMA table_info(watchlists)')).map((c) => c.name);
  assert.ok(!cols.includes('is_broadcast'));

  const wl = await watchlistService.createWatchlist({ name: 'F4 broadcast', type: 'broadcast', is_active: true });
  assert.equal(wl.type, 'broadcast');
  assert.equal(watchlistService._isBroadcast(wl), true);
  const std = await watchlistService.createWatchlist({ name: 'F4 standard', is_active: true });
  assert.equal(std.type, 'standard');
  assert.equal(watchlistService._isBroadcast(std), false);
});
