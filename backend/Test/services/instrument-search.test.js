import assert from 'assert';
import test, { before } from 'node:test';

import { useTestDb } from '../helpers/db.js';
import db from '../../src/core/database.js';
import symbolValidationService from '../../src/services/symbol-validation.service.js';

/**
 * The Add Symbol search. Seen live: typing BTCUSD found nothing (the FTS prefix star sat inside
 * the quotes, so only whole tokens matched), SBIN listed its futures before the stock, and every
 * search silently fell back to the broker because the exchange was passed where a filters object
 * belonged.
 */

const ROWS = [
  ['SBIN', 'SBIN', 'NSE', 'EQ', null],
  ['SBIN29DEC26FUT', 'SBIN', 'NFO', 'FUT', '29-DEC-26'],
  ['SBIN29DEC26800CE', 'SBIN', 'NFO', 'CE', '29-DEC-26'],
  ['NIFTY', 'NIFTY', 'NSE_INDEX', 'INDEX', null],
  ['NIFTY100', 'NIFTY100', 'NSE_INDEX', 'INDEX', null],
  ['NIFTY29DEC26FUT', 'NIFTY', 'NFO', 'FUT', '29-DEC-26'],
  ['NIFTY28JUL26FUT', 'NIFTY', 'NFO', 'FUT', '28-JUL-26'], // expired
  ['BTCUSDFUT', 'BTCUSDFUT', 'CRYPTO', 'PERPFUT', null],
];

before(async () => {
  await useTestDb('instrument-search');
  for (const [symbol, name, exchange, type, expiry] of ROWS) {
    await db.run(
      'INSERT INTO instruments (symbol, name, exchange, instrumenttype, expiry, lotsize, tick_size) VALUES (?, ?, ?, ?, ?, 1, 0.05)',
      [symbol, name, exchange, type, expiry]
    );
  }
  // instruments_fts is external-content and rebuilt after a bulk load, not kept by triggers.
  await db.run("INSERT INTO instruments_fts(instruments_fts) VALUES('rebuild')");
});

const search = async (q, exchange) => (await symbolValidationService.searchSymbols(q, null, { exchange })).map((r) => r.symbol);

test('a partial symbol finds the contract - BTCUSD finds the perpetual', async () => {
  assert.deepStrictEqual(await search('BTCUSD'), ['BTCUSDFUT']);
});

test('the stock comes before its futures and options', async () => {
  assert.deepStrictEqual(await search('SBIN'), ['SBIN', 'SBIN29DEC26FUT', 'SBIN29DEC26800CE']);
});

test('an index\'s own futures come before other indices sharing the prefix, and expired ones are gone', async () => {
  assert.deepStrictEqual(await search('NIFTY'), ['NIFTY', 'NIFTY29DEC26FUT', 'NIFTY100']);
});

test('the exchange filter narrows the search', async () => {
  assert.deepStrictEqual(await search('SBIN', 'NFO'), ['SBIN29DEC26FUT', 'SBIN29DEC26800CE']);
});
