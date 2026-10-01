import assert from 'assert';
import test, { before } from 'node:test';

import { useTestDb } from '../helpers/db.js';
import db from '../../src/core/database.js';

before(() => useTestDb('anchor-removal'));

test('ANCHOR_OFS leftovers are gone from the schema (H9)', async () => {
  const wsCols = (await db.all('PRAGMA table_info(watchlist_symbols)')).map((c) => c.name);
  for (const c of ['anchored_ce_strike', 'anchored_pe_strike', 'anchored_expiry']) {
    assert.ok(!wsCols.includes(c), `watchlist_symbols.${c} should be dropped`);
  }
  const legCols = (await db.all('PRAGMA table_info(strategy_legs)')).map((c) => c.name);
  assert.ok(!legCols.includes('strike_policy'));
});
