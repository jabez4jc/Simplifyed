import assert from 'assert';
import test, { before, beforeEach } from 'node:test';

import { useTestDb } from '../helpers/db.js';
import db from '../../src/core/database.js';
import instrumentsService from '../../src/services/instruments.service.js';
import instanceService from '../../src/services/instance.service.js';

before(() => useTestDb('instruments-replace'));
beforeEach(async () => {
  await db.run('DELETE FROM instruments');
  await db.run('DELETE FROM instruments_refresh_log');
});

const row = (symbol, extra = {}) => ({ symbol, name: symbol, lotsize: '1', instrumenttype: 'EQ', ...extra });
const count = async (sql, ...p) => (await db.get(sql, p)).n;

test('replaceExchange swaps one exchange, normalises expiry to ISO and leaves others alone', async () => {
  await instrumentsService.replaceExchange('CRYPTO', [row('BTCUSDFUT', { instrumenttype: 'PERPFUT' })]);
  await instrumentsService.replaceExchange('NFO', [row('OLDNFO')]);
  await instrumentsService.replaceExchange('NFO', [
    row('NIFTY29DEC26FUT', { instrumenttype: 'FUT', expiry: '29-DEC-26' }),
    row('NIFTY29DEC2625000CE', { instrumenttype: 'CE', strike: '25000', expiry: '29DEC26' }),
    row('BADSTRIKE', { strike: '-1', lotsize: '-1', expiry: '-1' }),
  ]);

  const nfo = await db.all("SELECT symbol, expiry, strike, lotsize FROM instruments WHERE exchange = 'NFO' ORDER BY symbol");
  assert.deepStrictEqual(nfo.map((r) => r.symbol), ['BADSTRIKE', 'NIFTY29DEC2625000CE', 'NIFTY29DEC26FUT']);
  assert.deepStrictEqual(nfo.map((r) => r.expiry), [null, '2026-12-29', '2026-12-29']);
  assert.deepStrictEqual([nfo[0].strike, nfo[0].lotsize], [null, 1]);
  assert.strictEqual(await count("SELECT COUNT(*) n FROM instruments WHERE exchange = 'CRYPTO'"), 1);
});

test('after a rebuild the FTS index has one entry per instrument and search still works', async () => {
  for (let i = 0; i < 3; i++) {
    await instrumentsService.replaceExchange('NSE_INDEX', [row('NIFTY', { instrumenttype: 'INDEX' }), row('BANKNIFTY', { instrumenttype: 'INDEX' })]);
    await instrumentsService._rebuildFts();
  }
  assert.strictEqual(
    await count('SELECT COUNT(*) n FROM instruments_fts_docsize'),
    await count('SELECT COUNT(*) n FROM instruments')
  );
  const found = await instrumentsService.searchInstruments('NIFTY');
  assert.ok(found.some((r) => r.symbol === 'NIFTY'));
});

test('importFromCSV replaces only the exchanges present in the file', async () => {
  await instrumentsService.replaceExchange('CRYPTO', [row('BTCUSDFUT', { instrumenttype: 'PERPFUT' })]);
  await instrumentsService.replaceExchange('NSE', [row('OLDNSE')]);
  const csv = [
    'id,symbol,brsymbol,name,exchange,brexchange,token,expiry,strike,lotsize,instrumenttype,tick_size',
    '1,SBIN,SBIN-EQ,SBIN,NSE,NSE,3045,-1,-1,1,EQ,0.05',
  ].join('\n');
  await instrumentsService.importFromCSV(csv);
  const rows = await db.all('SELECT exchange, symbol FROM instruments ORDER BY exchange');
  assert.deepStrictEqual(rows, [{ exchange: 'CRYPTO', symbol: 'BTCUSDFUT' }, { exchange: 'NSE', symbol: 'SBIN' }]);
});

test('staleness is per segment: a fresh Indian refresh does not hide a missing crypto one', async () => {
  await instrumentsService.replaceExchange('NSE', [row('SBIN')]);
  await instrumentsService.replaceExchange('CRYPTO', [row('BTCUSDFUT', { instrumenttype: 'PERPFUT' })]);
  await db.run("INSERT INTO instruments_refresh_log (exchange, status, instrument_count, refresh_completed_at) VALUES ('INDIAN', 'completed', 1, ?)",
    [new Date().toISOString()]);
  assert.strictEqual(await instrumentsService.needsRefresh('INDIAN'), false);
  assert.strictEqual(await instrumentsService.needsRefresh('CRYPTO'), true);
});

test('refreshSegment does nothing when no active instance serves the segment', async () => {
  const real = instanceService.getAllInstances;
  instanceService.getAllInstances = async () => [{ id: 1, broker: 'fyers', is_active: 1 }];
  try {
    const result = await instrumentsService.refreshSegment('CRYPTO');
    assert.deepStrictEqual([result.skipped, result.reason], [true, 'NO_INSTANCE']);
  } finally {
    instanceService.getAllInstances = real;
  }
});
