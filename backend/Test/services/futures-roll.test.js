import assert from 'assert';
import test, { before, beforeEach } from 'node:test';

import { useTestDb } from '../helpers/db.js';
import db from '../../src/core/database.js';
import futuresRollService, { pickContract, parseContinuousSymbol } from '../../src/services/futures-roll.service.js';
import instrumentsService from '../../src/services/instruments.service.js';
import watchlistSymbolService from '../../src/services/watchlist-symbol.service.js';
import quickOrderService from '../../src/services/quick-order.service.js';
import marketDataFeedService from '../../src/services/market-data-feed.service.js';
import { up as anchorAutoRollUp } from '../../migrations/069_strategy_anchor_auto_roll.js';

/**
 * Auto-roll watchlist futures. Indian exchanges have no perpetuals, so an auto-roll row follows a
 * series (1 = nearest, 2 = next) and is rewritten onto the next contract when its own expires.
 * The clock is fixed at 20 Oct 2026, 11:30 IST: the October contract expired yesterday.
 */

const NOW = new Date('2026-10-20T06:00:00Z');
let watchlistId;

// DD-MMM-YY text sorts by day of month (04-DEC < 19-NOV < 19-OCT) - the order must come from the date.
const CRUDE = [
  ['CRUDEOIL18DEC26FUT', '18-DEC-26', 100],
  ['CRUDEOIL19OCT26FUT', '19-OCT-26', 100],
  ['CRUDEOIL19NOV26FUT', '19-NOV-26', 100],
  ['CRUDEOIL19JAN27FUT', '19-JAN-27', 100],
];

async function seedFutures(exchange, key, rows) {
  for (const [symbol, expiry, lotsize] of rows) {
    await db.run(
      `INSERT INTO instruments (symbol, brsymbol, name, exchange, token, expiry, lotsize, instrumenttype, tick_size, underlying_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'FUT', 1, ?)`,
      [symbol, symbol, key, exchange, `tok-${symbol}`, expiry, lotsize, key]
    );
  }
}

async function addRow(fields) {
  const row = { watchlist_id: watchlistId, exchange: 'MCX', symbol_type: 'FUTURES', instrumenttype: 'FUT', lot_size: 100, is_enabled: 1, ...fields };
  const cols = Object.keys(row);
  const { lastID } = await db.run(
    `INSERT INTO watchlist_symbols (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    cols.map((c) => row[c])
  );
  return db.get('SELECT * FROM watchlist_symbols WHERE id = ?', [lastID]);
}

before(async () => {
  await useTestDb('futures-roll');
});

beforeEach(async () => {
  await db.run('DELETE FROM strategy_instances');
  await db.run('DELETE FROM strategies');
  await db.run('DELETE FROM watchlist_instances');
  await db.run('DELETE FROM instances');
  await db.run('DELETE FROM watchlist_symbols');
  await db.run('DELETE FROM watchlists');
  await db.run('DELETE FROM instruments');
  await seedFutures('MCX', 'CRUDEOIL', CRUDE);
  ({ lastID: watchlistId } = await db.run("INSERT INTO watchlists (name) VALUES ('Roll test')"));
  futuresRollService._isHeld = async () => false;
});

test('continuous symbols name a series, anything else is left alone', () => {
  assert.deepStrictEqual(parseContinuousSymbol('NIFTY1!'), { underlying: 'NIFTY', series: 1 });
  assert.deepStrictEqual(parseContinuousSymbol('crudeoil2!'), { underlying: 'CRUDEOIL', series: 2 });
  assert.strictEqual(parseContinuousSymbol('NIFTY3!'), null);
  assert.strictEqual(parseContinuousSymbol('NIFTY27OCT26FUT'), null);
});

test('live futures come back nearest first by date, expired ones dropped', async () => {
  const list = await futuresRollService.listFutures('MCX', 'CRUDEOIL', NOW);
  assert.deepStrictEqual(list.map((r) => r.symbol), ['CRUDEOIL19NOV26FUT', 'CRUDEOIL18DEC26FUT', 'CRUDEOIL19JAN27FUT']);
});

test('series 1 is the nearest contract, series 2 the one after; early roll skips the front month', async () => {
  const list = await futuresRollService.listFutures('MCX', 'CRUDEOIL', NOW);
  assert.strictEqual(pickContract(list, 1, NOW).contract.symbol, 'CRUDEOIL19NOV26FUT');
  assert.strictEqual(pickContract(list, 2, NOW).contract.symbol, 'CRUDEOIL18DEC26FUT');

  // 19 Nov is 30 days away: inside a 30-day window, outside a 29-day one.
  assert.deepStrictEqual(
    [pickContract(list, 1, NOW, 30).contract.symbol, pickContract(list, 1, NOW, 30).early],
    ['CRUDEOIL18DEC26FUT', true]
  );
  assert.strictEqual(pickContract(list, 1, NOW, 29).contract.symbol, 'CRUDEOIL19NOV26FUT');
  assert.strictEqual(pickContract([], 1, NOW).contract, null);
});

test('the expiry purge rolls auto-roll rows and still disables fixed ones', async () => {
  const rolling = await addRow({ symbol: 'CRUDEOIL19OCT26FUT', expiry: '19-OCT-26', underlying_symbol: 'CRUDEOIL', auto_roll: 1 });
  const next = await addRow({ symbol: 'CRUDEOIL19OCT26FUT', expiry: '19-OCT-26', underlying_symbol: 'CRUDEOIL 19 Oct 26 FUT', auto_roll: 2 });
  const fixed = await addRow({ symbol: 'CRUDEOIL19OCT26FUT', expiry: '19-OCT-26', underlying_symbol: 'CRUDEOIL', auto_roll: 0 });
  // Different watchlists, so the duplicate guard does not interfere.
  await db.run("INSERT INTO watchlists (name) VALUES ('b'), ('c')");
  const [b, c] = (await db.all("SELECT id FROM watchlists WHERE name IN ('b','c') ORDER BY id")).map((r) => r.id);
  await db.run('UPDATE watchlist_symbols SET watchlist_id = ? WHERE id = ?', [b, next.id]);
  await db.run('UPDATE watchlist_symbols SET watchlist_id = ? WHERE id = ?', [c, fixed.id]);

  await instrumentsService.purgeExpired(NOW);

  const after = async (id) => db.get('SELECT * FROM watchlist_symbols WHERE id = ?', [id]);
  const r1 = await after(rolling.id);
  assert.strictEqual(r1.symbol, 'CRUDEOIL19NOV26FUT');
  assert.strictEqual(r1.expiry, '19-NOV-26');
  assert.strictEqual(r1.token, 'tok-CRUDEOIL19NOV26FUT');
  assert.strictEqual(r1.is_enabled, 1);
  const r2 = await after(next.id);
  assert.strictEqual(r2.symbol, 'CRUDEOIL18DEC26FUT', 'a messy underlying_symbol is normalized');
  assert.strictEqual(r2.underlying_symbol, 'CRUDEOIL');
  const r3 = await after(fixed.id);
  assert.strictEqual(r3.symbol, 'CRUDEOIL19OCT26FUT');
  assert.strictEqual(r3.is_enabled, 0);
});

test('a roll never moves a row off a live contract that is still held', async () => {
  const row = await addRow({ symbol: 'CRUDEOIL19NOV26FUT', expiry: '19-NOV-26', underlying_symbol: 'CRUDEOIL', auto_roll: 1 });

  futuresRollService._isHeld = async () => true;
  assert.strictEqual((await futuresRollService.rollRow(row, { now: NOW, earlyDays: 30 })).status, 'position-open');

  futuresRollService._isHeld = async () => { throw new Error('order book timeout'); };
  assert.strictEqual((await futuresRollService.rollRow(row, { now: NOW, earlyDays: 30 })).status, 'position-open',
    'an unreadable position book is not flat');

  futuresRollService._isHeld = async () => false;
  const result = await futuresRollService.rollRow(row, { now: NOW, earlyDays: 30 });
  assert.deepStrictEqual([result.status, result.to], ['rolled', 'CRUDEOIL18DEC26FUT']);
});

test('a roll onto a contract that is already its own row is refused', async () => {
  const row = await addRow({ symbol: 'CRUDEOIL19OCT26FUT', expiry: '19-OCT-26', underlying_symbol: 'CRUDEOIL', auto_roll: 1 });
  await addRow({ symbol: 'CRUDEOIL19NOV26FUT', expiry: '19-NOV-26', underlying_symbol: 'CRUDEOIL' });
  assert.strictEqual((await futuresRollService.rollRow(row, { now: NOW, earlyDays: 0 })).status, 'duplicate');
});

test('adding a symbol with "next expiry" moves it to the next contract straight away', async () => {
  // Real clock here, so seed contracts that are live today whatever the date.
  const soon = new Date(Date.now() + 10 * 86400000);
  const later = new Date(Date.now() + 40 * 86400000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  await seedFutures('NFO', 'NIFTY', [['NIFTYSOONFUT', fmt(soon), 65], ['NIFTYLATERFUT', fmt(later), 75]]);

  const saved = await watchlistSymbolService.addSymbol(watchlistId, {
    exchange: 'NFO', symbol: 'NIFTYSOONFUT', symbol_type: 'FUTURES', instrumenttype: 'FUT',
    underlying_symbol: 'NIFTY', lot_size: 65, auto_roll: 2,
  });
  assert.strictEqual(saved.symbol, 'NIFTYLATERFUT');
  assert.strictEqual(saved.lot_size, 75, 'lot size follows the new contract');
  assert.strictEqual(saved.auto_roll, 2);
});

test('auto-roll is refused outside dated-futures exchanges and for unknown series', async () => {
  await assert.rejects(
    watchlistSymbolService.addSymbol(watchlistId, { exchange: 'NSE', symbol: 'RELIANCE', auto_roll: 1 }),
    /Auto-roll is for/
  );
  await assert.rejects(
    watchlistSymbolService.addSymbol(watchlistId, { exchange: 'MCX', symbol: 'CRUDEOIL19NOV26FUT', auto_roll: 3 }),
    /auto_roll must be/
  );
});

test('a webhook continuous symbol resolves to the contract it means today', async () => {
  assert.strictEqual(await futuresRollService.resolveContinuousSymbol('MCX', 'CRUDEOIL1!', NOW), 'CRUDEOIL19NOV26FUT');
  assert.strictEqual(await futuresRollService.resolveContinuousSymbol('MCX', 'CRUDEOIL2!', NOW), 'CRUDEOIL18DEC26FUT');
  assert.strictEqual(await futuresRollService.resolveContinuousSymbol('MCX', 'GOLD1!', NOW), null);
  assert.strictEqual(await futuresRollService.resolveContinuousSymbol('MCX', 'CRUDEOIL19NOV26FUT', NOW), 'CRUDEOIL19NOV26FUT');
});

test('existing strategy anchors switch to auto-roll, and nothing else in their watchlist does', async () => {
  const anchor = await addRow({ symbol: 'CRUDEOIL19OCT26FUT', expiry: '19-OCT-26', underlying_symbol: 'CRUDEOIL', auto_roll: 0 });
  const legExit = await addRow({ symbol: 'CRUDEOIL19OCT266000CE', symbol_type: 'OPTIONS', instrumenttype: 'CE', underlying_symbol: null, auto_roll: 0 });
  const index = await addRow({ exchange: 'NSE_INDEX', symbol: 'NIFTY', symbol_type: 'INDEX', instrumenttype: 'INDEX', auto_roll: 0 });
  await db.run(
    "INSERT INTO strategies (watchlist_id, name, underlying, exchange) VALUES (?, 'Crude', 'CRUDEOIL', 'MCX'), (?, 'Nifty', 'NIFTY', 'NSE_INDEX')",
    [watchlistId, watchlistId]
  );

  await anchorAutoRollUp(db);

  const flag = async (id) => (await db.get('SELECT auto_roll FROM watchlist_symbols WHERE id = ?', [id])).auto_roll;
  assert.strictEqual(await flag(anchor.id), 1, 'the MCX anchor follows the nearest contract');
  assert.strictEqual(await flag(legExit.id), 0, 'option leg-exit rows are left alone');
  assert.strictEqual(await flag(index.id), 0, 'an index anchor has nothing to roll');

  // The purge then moves the expired anchor onto the live contract and re-enables it.
  await instrumentsService.purgeExpired(NOW);
  const rolled = await db.get('SELECT symbol, is_enabled FROM watchlist_symbols WHERE id = ?', [anchor.id]);
  assert.deepStrictEqual([rolled.symbol, rolled.is_enabled], ['CRUDEOIL19NOV26FUT', 1]);
});

test('the position check covers instances assigned directly to a strategy', async () => {
  delete futuresRollService._isHeld; // the real check, with the broker calls stubbed
  const row = await addRow({ symbol: 'CRUDEOIL19NOV26FUT', expiry: '19-NOV-26', underlying_symbol: 'CRUDEOIL', auto_roll: 1 });
  const { lastID: instanceId } = await db.run(
    "INSERT INTO instances (name, host_url, api_key, broker, is_active) VALUES ('Kotak', 'http://k.test', 'k', 'kotak', 1)"
  );
  const { lastID: strategyId } = await db.run(
    "INSERT INTO strategies (watchlist_id, name, underlying, exchange) VALUES (?, 'Crude', 'CRUDEOIL', 'MCX')", [watchlistId]
  );
  await db.run('INSERT INTO strategy_instances (strategy_id, instance_id) VALUES (?, ?)', [strategyId, instanceId]);

  const realPositions = quickOrderService._getOpenPositionsForSymbol;
  const asked = [];
  quickOrderService._getOpenPositionsForSymbol = async (instance, symbol) => {
    asked.push([instance.id, symbol]);
    return [{ symbol, quantity: 100 }];
  };
  try {
    const result = await futuresRollService.rollRow(row, { now: NOW, earlyDays: 30 });
    assert.strictEqual(result.status, 'position-open');
    assert.deepStrictEqual(asked, [[instanceId, 'CRUDEOIL19NOV26FUT']]);
  } finally {
    quickOrderService._getOpenPositionsForSymbol = realPositions;
  }
  assert.ok(marketDataFeedService._tradesExchange({ broker: 'kotak' }, 'MCX'), 'the Indian broker is asked about MCX');
});
