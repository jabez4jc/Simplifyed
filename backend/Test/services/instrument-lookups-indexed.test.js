import assert from 'assert';
import test, { before } from 'node:test';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

import { useTestDb } from '../helpers/db.js';
import db from '../../src/core/database.js';
import { resolveOptionLotSize, resolveOptionsUnderlyingKey } from '../../src/utils/underlying.util.js';

/**
 * Instrument columns are stored upper-case at import, so lookups compare them directly: UPPER(col)
 * defeats the index and scanned all ~136k rows (0.66 s vs 0.01 s). The parameter is upper-cased in JS.
 */

before(async () => {
  await useTestDb('instrument-lookups-indexed');
  await db.run(
    "INSERT INTO instruments (symbol, name, exchange, instrumenttype, underlying_key, expiry, strike, lotsize, tick_size) VALUES ('NIFTY29DEC2622400CE', 'NIFTY', 'NFO', 'CE', 'NIFTY', '2099-12-29', 22400, 75, 0.05)"
  );
});

test('the lookups use the indexes', async () => {
  const plan = async (sql, params) => (await db.all(`EXPLAIN QUERY PLAN ${sql}`, params)).map((r) => r.detail).join(' ');
  assert.match(await plan('SELECT token FROM instruments WHERE exchange = ? AND symbol = ? LIMIT 1', ['NFO', 'X']), /USING INDEX/);
  assert.match(await plan("SELECT 1 FROM instruments WHERE underlying_key = ? AND instrumenttype IN ('CE','PE') LIMIT 1", ['NIFTY']), /USING INDEX/);
});

test('callers may pass any case: the key and symbol are upper-cased before the query', async () => {
  assert.strictEqual(await resolveOptionLotSize('nifty'), 75);
  assert.strictEqual(await resolveOptionsUnderlyingKey({ symbol: 'nifty', exchange: 'nse_index', underlying_symbol: 'nifty' }), 'NIFTY');
});

test('no UPPER() on an instrument column anywhere in src', () => {
  const hits = [];
  const walk = (dir) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.js') && /UPPER\((i\.)?(exchange|symbol|underlying_key|instrumenttype)\)/.test(readFileSync(p, 'utf8'))) hits.push(p);
    }
  };
  walk(new URL('../../src', import.meta.url).pathname);
  assert.deepStrictEqual(hits, []);
});
