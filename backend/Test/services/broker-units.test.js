import assert from 'assert';
import test, { before, beforeEach } from 'node:test';

import { useTestDb } from '../helpers/db.js';
import db from '../../src/core/database.js';
import brokerUnitsService from '../../src/services/broker-units.service.js';
import instrumentsService from '../../src/services/instruments.service.js';

/**
 * One canonical instruments cache, per-broker lot units at the broker boundary.
 *
 * Observed live on 2026-09-29 via each broker's own OpenAlgo `symbol` endpoint: Kotak counts MCX
 * GOLDM as 100 where the cache and Fyers say 10, GOLD as 1 vs 100, ZINC as 5 vs 5000. A
 * fanned-out quantity must be rescaled per broker on the way out, and that broker's positions
 * scaled back on the way in - otherwise closing a position re-sends broker units that then get
 * scaled a second time.
 */

const KOTAK = { id: 3, name: 'Jz Kotak', broker: 'kotak' };
const FYERS = { id: 6, name: 'Jz Fyers', broker: 'fyers' };
const BROKER_LOTS = {
  kotak: { GOLDM05OCT26FUT: 100, GOLD04DEC26FUT: 1, ZINC30OCT26FUT: 5, CRUDEOIL19OCT26FUT: 100, NIFTY27OCT26FUT: 65 },
  fyers: { GOLDM05OCT26FUT: 10, GOLD04DEC26FUT: 100, ZINC30OCT26FUT: 5000, CRUDEOIL19OCT26FUT: 100, NIFTY27OCT26FUT: 65 },
};

/** A stand-in for openalgoClient that answers only the `symbol` lookup, and counts it. */
function fakeClient() {
  const calls = [];
  return {
    calls,
    async request(instance, endpoint, data) {
      calls.push({ instance: instance.name, endpoint, symbol: data.symbol });
      const lotsize = BROKER_LOTS[instance.broker]?.[data.symbol];
      if (!lotsize) throw new Error(`Symbol '${data.symbol}' not found`);
      return { status: 'success', data: { symbol: data.symbol, lotsize } };
    },
  };
}

async function seed(rows) {
  for (const [exchange, symbol, lotsize, expiry = null] of rows) {
    await db.run(
      'INSERT INTO instruments (symbol, name, exchange, lotsize, expiry, instrumenttype) VALUES (?, ?, ?, ?, ?, ?)',
      [symbol, symbol.replace(/\d.*/, ''), exchange, lotsize, expiry, expiry ? 'FUT' : 'EQ']
    );
  }
}

before(async () => {
  await useTestDb('broker-units');
});

beforeEach(async () => {
  await db.run('DELETE FROM instruments');
  await db.run('DELETE FROM broker_lot_sizes').catch(() => {});
  brokerUnitsService.cache.clear();
  await seed([
    ['MCX', 'GOLDM05OCT26FUT', 10, '05-OCT-26'],
    ['MCX', 'GOLD04DEC26FUT', 100, '04-DEC-26'],
    ['MCX', 'ZINC30OCT26FUT', 5000, '30-OCT-26'],
    ['MCX', 'CRUDEOIL19OCT26FUT', 100, '19-OCT-26'],
    ['NFO', 'NIFTY27OCT26FUT', 65, '27-OCT-26'],
    ['NSE', 'SBIN', 1],
  ]);
});

test('one lot of GOLDM goes to Kotak as 100 and to Fyers as 10', async () => {
  const client = fakeClient();
  const order = { exchange: 'MCX', symbol: 'GOLDM05OCT26FUT', quantity: 10, position_size: 10, pricetype: 'LIMIT' };
  const toKotak = await brokerUnitsService.toBroker(KOTAK, 'placesmartorder', order, client);
  const toFyers = await brokerUnitsService.toBroker(FYERS, 'placesmartorder', order, client);
  assert.strictEqual(toKotak.quantity, 100);
  assert.strictEqual(toKotak.position_size, 100);
  assert.strictEqual(toFyers.quantity, 10);
  assert.strictEqual(order.quantity, 10, 'the caller\'s canonical payload is never mutated');
});

test('GOLD and ZINC - where Kotak is SMALLER - are scaled down, not sent 100x oversize', async () => {
  const client = fakeClient();
  const gold = await brokerUnitsService.toBroker(KOTAK, 'placesmartorder', { exchange: 'MCX', symbol: 'GOLD04DEC26FUT', quantity: 200, position_size: -200 }, client);
  assert.deepStrictEqual([gold.quantity, gold.position_size], [2, -2], '2 lots, short target keeps its sign');
  const zinc = await brokerUnitsService.toBroker(KOTAK, 'placesmartorder', { exchange: 'MCX', symbol: 'ZINC30OCT26FUT', quantity: 5000, position_size: 5000 }, client);
  assert.strictEqual(zinc.quantity, 5);
});

test('every leg of a basket is converted', async () => {
  const client = fakeClient();
  const basket = { orders: [
    { exchange: 'MCX', symbol: 'GOLDM05OCT26FUT', quantity: 20 },
    { exchange: 'NFO', symbol: 'NIFTY27OCT26FUT', quantity: 65 },
  ] };
  const out = await brokerUnitsService.toBroker(KOTAK, 'basketorder', basket, client);
  assert.deepStrictEqual(out.orders.map((o) => o.quantity), [200, 65]);
});

test('a quantity that is not whole lots is refused rather than guessed', async () => {
  await assert.rejects(
    () => brokerUnitsService.toBroker(KOTAK, 'placesmartorder', { exchange: 'MCX', symbol: 'GOLDM05OCT26FUT', quantity: 15 }, fakeClient()),
    /not whole lots of 10/
  );
});

test('positions come back in canonical units, so re-sending one is not scaled twice', async () => {
  const client = fakeClient();
  // Kotak reports one GOLDM lot as 100 and two GOLD lots as 2.
  const response = { status: 'success', data: [
    { exchange: 'MCX', symbol: 'GOLDM05OCT26FUT', quantity: 100 },
    { exchange: 'MCX', symbol: 'GOLD04DEC26FUT', quantity: -2 },
    { exchange: 'NSE', symbol: 'SBIN', quantity: 7 },
  ] };
  await brokerUnitsService.fromBroker(KOTAK, 'positionbook', {}, response, client);
  assert.deepStrictEqual(response.data.map((p) => p.quantity), [10, -200, 7]);

  // Round trip: closing that GOLDM position sends Kotak exactly what it holds.
  const close = await brokerUnitsService.toBroker(KOTAK, 'placesmartorder',
    { exchange: 'MCX', symbol: 'GOLDM05OCT26FUT', quantity: response.data[0].quantity, position_size: 0 }, client);
  assert.strictEqual(close.quantity, 100);
});

test('orderbook, tradebook, orderstatus and openposition are converted too', async () => {
  const client = fakeClient();
  const orderbook = { data: { orders: [{ exchange: 'MCX', symbol: 'GOLDM05OCT26FUT', quantity: 300, filled_quantity: 100 }] } };
  await brokerUnitsService.fromBroker(KOTAK, 'orderbook', {}, orderbook, client);
  assert.deepStrictEqual([orderbook.data.orders[0].quantity, orderbook.data.orders[0].filled_quantity], [30, 10]);

  const status = { data: { exchange: 'MCX', symbol: 'GOLDM05OCT26FUT', quantity: 100 } };
  await brokerUnitsService.fromBroker(KOTAK, 'orderstatus', {}, status, client);
  assert.strictEqual(status.data.quantity, 10);

  const open = { status: 'success', quantity: 200 };
  await brokerUnitsService.fromBroker(KOTAK, 'openposition', { exchange: 'MCX', symbol: 'GOLDM05OCT26FUT' }, open, client);
  assert.strictEqual(open.quantity, 20);
});

test('cash segments and matching lots are never looked up or changed; lookups are cached per day', async () => {
  const client = fakeClient();
  const sbin = await brokerUnitsService.toBroker(KOTAK, 'placesmartorder', { exchange: 'NSE', symbol: 'SBIN', quantity: 7 }, client);
  assert.strictEqual(sbin.quantity, 7);
  const crude = await brokerUnitsService.toBroker(KOTAK, 'placesmartorder', { exchange: 'MCX', symbol: 'CRUDEOIL19OCT26FUT', quantity: 100 }, client);
  assert.strictEqual(crude.quantity, 100);
  await brokerUnitsService.toBroker(KOTAK, 'placesmartorder', { exchange: 'MCX', symbol: 'CRUDEOIL19OCT26FUT', quantity: 200 }, client);
  assert.deepStrictEqual(client.calls.map((c) => c.symbol), ['CRUDEOIL19OCT26FUT'], 'NSE skipped, second CRUDEOIL order served from cache');
});

test('when the broker cannot be asked, the last saved lot size is used', async () => {
  await brokerUnitsService.toBroker(KOTAK, 'placesmartorder', { exchange: 'MCX', symbol: 'GOLDM05OCT26FUT', quantity: 10 }, fakeClient());
  brokerUnitsService.cache.clear();
  const down = { async request() { throw new Error('Request timeout after 15000ms'); } };
  const out = await brokerUnitsService.toBroker(KOTAK, 'placesmartorder', { exchange: 'MCX', symbol: 'GOLDM05OCT26FUT', quantity: 10 }, down);
  assert.strictEqual(out.quantity, 100, 'a slow Kotak must not silently fall back to 10');
});

test('a contract not in the cache - e.g. expired and purged - is never converted or looked up', async () => {
  const client = fakeClient();
  const out = await brokerUnitsService.toBroker(KOTAK, 'placesmartorder', { exchange: 'MCX', symbol: 'GOLDM05SEP26FUT', quantity: 10 }, client);
  assert.strictEqual(out.quantity, 10);
  assert.strictEqual(client.calls.length, 0);
});

test('expired contracts are purged from the cache: Indian at end of day, crypto at 5:30 PM IST', async () => {
  await seed([
    ['NFO', 'NIFTY22SEP26FUT', 65, '22-SEP-26'], // expired last week
    ['NFO', 'NIFTY29SEP26FUT', 65, '29-SEP-26'], // expires today - valid all day
    ['CRYPTO', 'BTC29SEP2683000CE', 1, '29-SEP-26'], // crypto: lapses at 17:30 IST today
    ['CRYPTO', 'BTC30SEP2683000CE', 1, '30-SEP-26'],
    ['CRYPTO', 'BTCUSDFUT', 1], // perpetual - no expiry, never purged
  ]);
  const alive = async () => (await db.all('SELECT symbol FROM instruments ORDER BY symbol')).map((r) => r.symbol);

  await instrumentsService.purgeExpired(new Date('2026-09-29T11:00:00+05:30'));
  let symbols = await alive();
  assert.ok(!symbols.includes('NIFTY22SEP26FUT'), 'last week\'s expiry is gone');
  assert.ok(symbols.includes('NIFTY29SEP26FUT') && symbols.includes('BTC29SEP2683000CE'), 'today\'s expiries still trade');

  await instrumentsService.purgeExpired(new Date('2026-09-29T17:50:00+05:30'));
  symbols = await alive();
  assert.ok(!symbols.includes('BTC29SEP2683000CE'), 'crypto lapsed at 17:30 (+15 min sync buffer)');
  assert.ok(symbols.includes('NIFTY29SEP26FUT'), 'NFO settles at end of day');
  assert.ok(symbols.includes('BTCUSDFUT') && symbols.includes('BTC30SEP2683000CE') && symbols.includes('SBIN'));

  await instrumentsService.purgeExpired(new Date('2026-09-30T00:05:00+05:30'));
  assert.ok(!(await alive()).includes('NIFTY29SEP26FUT'), 'gone the next day');
});

test('a strategy anchor rolls onto the live contract once it is added beside the expired one', async () => {
  const { default: watchlistSymbolService } = await import('../../src/services/watchlist-symbol.service.js');
  const wl = await db.run("INSERT INTO watchlists (name, is_active) VALUES ('Anchor roll', 1)");
  const add = (symbol, expiry) => db.run(
    "INSERT INTO watchlist_symbols (watchlist_id, exchange, symbol, underlying_symbol, expiry, symbol_type) VALUES (?, 'MCX', ?, 'NATGASMINI', ?, 'FUTURES')",
    [wl.lastID, symbol, expiry]
  );
  await add('NATGASMINI28JUL26FUT', '28-JUL-26');
  let anchor = await watchlistSymbolService.findAnchorByWatchlist(wl.lastID, 'MCX', 'NATGASMINI');
  assert.strictEqual(anchor.symbol, 'NATGASMINI28JUL26FUT', 'only the expired row exists - returned so the caller can explain');

  await add('NATGASMINI27OCT26FUT', '27-OCT-26');
  anchor = await watchlistSymbolService.findAnchorByWatchlist(wl.lastID, 'MCX', 'NATGASMINI');
  assert.strictEqual(anchor.symbol, 'NATGASMINI27OCT26FUT', 'the live contract wins');
});
