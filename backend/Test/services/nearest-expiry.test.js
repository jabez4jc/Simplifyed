import assert from 'assert';
import test, { before, beforeEach } from 'node:test';

import { useTestDb } from '../helpers/db.js';
import db from '../../src/core/database.js';
import expiryManagementService from '../../src/services/expiry-management.service.js';
import marketDataInstanceService from '../../src/services/market-data-instance.service.js';

/**
 * "Nearest expiry" is what a chart option order with Expiry = Nearest, a strategy leg with no
 * expiry and every close-all trade. On 30 Sep 2026 it resolved NIFTY to 29-DEC: it read
 * expiry_calendar, filled once in July and never refreshed, while the chart showed the 06-OCT
 * weekly - and the order traded December. It now reads the instruments cache, which is
 * refreshed daily and purged of expired contracts.
 */

const iso = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

before(async () => {
  await useTestDb('nearest-expiry');
});

beforeEach(async () => {
  await db.run('DELETE FROM instruments');
  await db.run('DELETE FROM expiry_calendar');
  await db.run('DELETE FROM instances');
  const rows = [
    ['NIFTYWEEKLYCE', 'CE', iso(6)],
    ['NIFTYWEEKLYPE', 'PE', iso(6)],
    ['NIFTYMONTHLYCE', 'CE', iso(27)],
    ['NIFTYMONTHFUT', 'FUT', iso(27)],
    ['NIFTYEXPIREDPE', 'PE', iso(-1)],
  ];
  for (const [symbol, type, expiry] of rows) {
    await db.run(
      `INSERT INTO instruments (symbol, name, exchange, expiry, strike, lotsize, instrumenttype, underlying_key)
       VALUES (?, 'NIFTY', 'NFO', ?, ?, 65, ?, 'NIFTY')`,
      [symbol, expiry, type === 'FUT' ? -1 : 22800, type]
    );
  }
  // The stale calendar that caused the December trade: its only future date is months away.
  await db.run(
    "INSERT INTO expiry_calendar (underlying, exchange, expiry_date, is_active) VALUES ('NIFTY', 'NFO', ?, 1)",
    [iso(90)]
  );
});

test('options resolve to the nearest weekly, not a stale calendar entry months out', async () => {
  assert.strictEqual(await expiryManagementService.getNearestExpiry('NIFTY', 'NFO', null), iso(6));
});

test('the index exchange a watchlist row carries resolves the same as its derivatives exchange', async () => {
  assert.strictEqual(await expiryManagementService.getNearestExpiry('NIFTY', 'NSE_INDEX', null), iso(6));
});

test('futures resolve to the futures expiry, not the nearer weekly option', async () => {
  assert.strictEqual(
    await expiryManagementService.getNearestExpiry('NIFTY', 'NFO', null, { kind: 'FUTURES' }),
    iso(27)
  );
});

test('nothing live is an error, never a guess', async () => {
  await db.run('DELETE FROM instruments');
  await assert.rejects(expiryManagementService.getNearestExpiry('NIFTY', 'NFO', null), /No live options expiry/);
});

test('the market-data pool offers only instances that trade the asked segment', async () => {
  const add = (name, broker) => db.run(
    `INSERT INTO instances (name, host_url, api_key, broker, is_active, market_data_enabled, health_status)
     VALUES (?, ?, 'k', ?, 1, 1, 'healthy')`,
    [name, `http://${name}.test`, broker]
  );
  await add('kotak', 'kotak');
  await add('delta', 'deltaexchange');

  const names = async (exchange) => (await marketDataInstanceService.getMarketDataPool(exchange)).map((i) => i.name);
  assert.deepStrictEqual(await names('NFO'), ['kotak'], 'NIFTY options are never resolved on the crypto broker');
  assert.deepStrictEqual(await names('CRYPTO'), ['delta']);
  assert.deepStrictEqual((await names(null)).sort(), ['delta', 'kotak'], 'no exchange keeps the whole pool');
  for (let i = 0; i < 4; i += 1) {
    assert.strictEqual((await marketDataInstanceService.getRoundRobinInstance('MCX')).name, 'kotak');
  }
});
