import assert from 'assert';
import test, { before } from 'node:test';

import { useTestDb } from '../helpers/db.js';
import db from '../../src/core/database.js';
import quickOrderService from '../../src/services/quick-order.service.js';

/**
 * The chart's CALL/PUT buttons name the contract on screen, and every instance trades exactly
 * that one - REDUCE/CLOSE act on it alone. The name comes from the browser, so the server checks
 * it is a live option of THIS row's underlying and of the type the action trades.
 */

const iso = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const NIFTY_ROW = { id: 1, symbol: 'NIFTY', exchange: 'NSE_INDEX', underlying_symbol: 'NIFTY', symbol_type: 'INDEX' };

before(async () => {
  await useTestDb('named-contract');
  await db.run('DELETE FROM instruments');
  const rows = [
    ['NFO', 'NIFTYLIVE22700CE', 'CE', 22700, iso(6), 'NIFTY'],
    ['NFO', 'NIFTYLIVE22700PE', 'PE', 22700, iso(6), 'NIFTY'],
    ['NFO', 'NIFTYGONE22700CE', 'CE', 22700, iso(-2), 'NIFTY'],
    ['NFO', 'BANKNIFTYLIVE51500CE', 'CE', 51500, iso(6), 'BANKNIFTY'],
    ['NFO', 'NIFTYLIVEFUT', 'FUT', -1, iso(27), 'NIFTY'],
  ];
  for (const [exchange, symbol, type, strike, expiry, key] of rows) {
    await db.run(
      `INSERT INTO instruments (exchange, symbol, instrumenttype, strike, expiry, underlying_key, lotsize, tick_size, token)
       VALUES (?, ?, ?, ?, ?, ?, 65, 0.05, ?)`,
      [exchange, symbol, type, strike, expiry, key, `tok-${symbol}`]
    );
  }
});

const check = (symbol, action = 'BUY_CE', tradeMode = 'OPTIONS') =>
  quickOrderService._validateOptionContract(NIFTY_ROW, { exchange: 'NFO', symbol }, action, tradeMode);

test('a live option of the row\'s own underlying, of the action\'s type, is accepted', async () => {
  const row = await check('NIFTYLIVE22700CE', 'BUY_CE');
  assert.strictEqual(row.symbol, 'NIFTYLIVE22700CE');
  assert.strictEqual((await check('NIFTYLIVE22700PE', 'REDUCE_PE')).symbol, 'NIFTYLIVE22700PE');
});

test('anything else is refused before an order is built', async () => {
  await assert.rejects(check('NIFTYLIVE22700PE', 'BUY_CE'), /trades CE/);
  await assert.rejects(check('BANKNIFTYLIVE51500CE', 'BUY_CE'), /not an option on NIFTY/);
  await assert.rejects(check('NIFTYGONE22700CE', 'BUY_CE'), /expired/);
  await assert.rejects(check('NIFTYLIVEFUT', 'BUY_CE'), /not a known option contract/);
  await assert.rejects(check('NIFTYLIVE22700CE', 'BUY', 'FUTURES'), /only accepted for OPTIONS/);
});

test('a named contract is traded as-is - no strike is resolved', async () => {
  const contractRow = await check('NIFTYLIVE22700CE', 'BUY_CE');
  const res = await quickOrderService._resolveOptionSymbolForInstance(null, NIFTY_ROW, { action: 'BUY_CE', contractRow });
  assert.strictEqual(res.optionSymbol.symbol, 'NIFTYLIVE22700CE');
  assert.strictEqual(res.optionSymbol.lot_size, 65);
  assert.strictEqual(res.expiry, iso(6));
});
