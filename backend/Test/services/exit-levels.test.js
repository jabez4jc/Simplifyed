import assert from 'assert';
import test, { before, beforeEach, afterEach } from 'node:test';

import { useTestDb } from '../helpers/db.js';
import db from '../../src/core/database.js';
import exitLevels from '../../src/services/exit-levels.service.js';
import exitLossCaps, { unrealizedPnl } from '../../src/services/exit-loss-caps.service.js';
import marketDataFeedService from '../../src/services/market-data-feed.service.js';
import marketCalendarService from '../../src/services/market-calendar.service.js';
import quickOrderService from '../../src/services/quick-order.service.js';
import {
  positionDirection, roleFor, exitQuantity, trail, hasCrossed,
} from '../../src/utils/exit-levels.util.js';

/**
 * Exit levels on the underlying: a price on the NIFTY chart exits NIFTY positions - the future
 * and the options, every expiry, on every account - by direction. The feed, the calendar and the
 * order path are stubbed: nothing here reaches a broker.
 */

const iso = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
let row;
let acctA;
let acctB;
const feed = { ltp: 22800, fresh: true, books: new Map(), open: true };
const sent = [];

const stubs = [];
const stub = (obj, name, fn) => { stubs.push([obj, name, obj[name]]); obj[name] = fn; };

before(async () => {
  await useTestDb('exit-levels');
  await db.run('DELETE FROM instruments');
  const inst = [
    ['NFO', 'NIFTYW22800CE', 'CE', 22800, iso(6), 'NIFTY', 65],
    ['NFO', 'NIFTYW22800PE', 'PE', 22800, iso(6), 'NIFTY', 65],
    ['NFO', 'NIFTYM23000CE', 'CE', 23000, iso(27), 'NIFTY', 65],
    ['NFO', 'NIFTYMFUT', 'FUT', -1, iso(27), 'NIFTY', 65],
    ['NFO', 'BANKNIFTYW51500CE', 'CE', 51500, iso(6), 'BANKNIFTY', 30],
  ];
  for (const [exchange, symbol, type, strike, expiry, key, lot] of inst) {
    await db.run('INSERT INTO instruments (exchange, symbol, instrumenttype, strike, expiry, underlying_key, lotsize) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [exchange, symbol, type, strike, expiry, key, lot]);
  }
});

beforeEach(async () => {
  for (const t of ['exit_levels', 'exit_loss_caps', 'watchlist_instances', 'watchlist_symbols', 'watchlists', 'instances']) {
    await db.run(`DELETE FROM ${t}`);
  }
  const { lastID: wl } = await db.run("INSERT INTO watchlists (name) VALUES ('Levels')");
  acctA = (await db.run("INSERT INTO instances (name, host_url, api_key, broker, is_active, is_analyzer_mode) VALUES ('Acct A', 'http://a.test', 'k', 'kotak', 1, 1)")).lastID;
  acctB = (await db.run("INSERT INTO instances (name, host_url, api_key, broker, is_active, is_analyzer_mode) VALUES ('Acct B', 'http://b.test', 'k', 'fyers', 1, 0)")).lastID;
  for (const id of [acctA, acctB]) await db.run('INSERT INTO watchlist_instances (watchlist_id, instance_id) VALUES (?, ?)', [wl, id]);
  const { lastID } = await db.run(
    "INSERT INTO watchlist_symbols (watchlist_id, exchange, symbol, symbol_type, underlying_symbol, lot_size) VALUES (?, 'NSE_INDEX', 'NIFTY', 'INDEX', 'NIFTY', 1)", [wl]
  );
  row = await db.get('SELECT * FROM watchlist_symbols WHERE id = ?', [lastID]);

  Object.assign(feed, { ltp: 22800, fresh: true, open: true });
  feed.books = new Map([
    [acctA, [
      { exchange: 'NFO', symbol: 'NIFTYW22800CE', quantity: 130, product: 'NRML', pnl: 0 },   // bullish
      { exchange: 'NFO', symbol: 'NIFTYM23000CE', quantity: -65, product: 'NRML', pnl: 0 },   // bearish (short CE)
      { exchange: 'NFO', symbol: 'BANKNIFTYW51500CE', quantity: 30, product: 'NRML', pnl: 0 }, // not NIFTY
    ]],
    [acctB, [
      { exchange: 'NFO', symbol: 'NIFTYMFUT', quantity: 65, product: 'NRML', pnl: 0 },       // bullish future
      { exchange: 'NFO', symbol: 'NIFTYW22800PE', quantity: 195, product: 'MIS', pnl: 0 },   // bearish
    ]],
  ]);
  sent.length = 0;
  exitLevels.openCache.clear();
  exitLevels.crossSince.clear();

  stub(marketDataFeedService, 'getCachedQuoteEntriesForSymbols', () => (
    feed.fresh ? { cached: [{ quote: { ltp: feed.ltp }, fetchedAt: Date.now() }], missing: [] } : { cached: [], missing: [{}] }
  ));
  stub(marketDataFeedService, 'fetchLtpForSymbol', async () => (feed.fresh ? { ltp: feed.ltp } : null));
  stub(marketDataFeedService, 'ensureSymbolSubscribed', () => {});
  stub(marketDataFeedService, 'getPositionSnapshot', (id) => ({ data: feed.books.get(id) || [] }));
  stub(marketDataFeedService, 'fetchPositionsForInstances', async (instances) => new Map(
    instances.map((i) => [i.id, { success: true, fromCache: false, positions: feed.books.get(i.id) || [] }])
  ));
  stub(marketCalendarService, 'isExchangeOpen', async () => feed.open);
  stub(quickOrderService, 'closePosition', async (inst, sym) => { sent.push({ kind: 'close', inst: inst.name, symbol: sym.symbol }); });
  stub(quickOrderService, 'exitPartOfPosition', async (inst, pos, qty) => { sent.push({ kind: 'part', inst: inst.name, symbol: pos.symbol, qty }); });
});

afterEach(() => {
  while (stubs.length) { const [o, n, f] = stubs.pop(); o[n] = f; }
});

/** Two evaluation passes, the second after the confirmation window. */
async function evaluateConfirmed() {
  await exitLevels.evaluate();
  for (const [k, v] of exitLevels.crossSince) exitLevels.crossSince.set(k, v - 5000);
  await exitLevels.evaluate();
}

test('the rules: direction, role, rounding, trailing, crossing', () => {
  assert.strictEqual(positionDirection('CE', 65), 'BULLISH');
  assert.strictEqual(positionDirection('CE', -65), 'BEARISH');
  assert.strictEqual(positionDirection('PE', 65), 'BEARISH');
  assert.strictEqual(positionDirection('PE', -65), 'BULLISH');
  assert.strictEqual(positionDirection('FUT', -65), 'BEARISH');
  assert.strictEqual(roleFor('BELOW', 'BULLISH'), 'STOP');
  assert.strictEqual(roleFor('BELOW', 'BEARISH'), 'TARGET');
  assert.strictEqual(roleFor('ABOVE', 'BULLISH'), 'TARGET');
  assert.strictEqual(exitQuantity(195, 65, 'PERCENT', 50), 65, '50% of 3 lots rounds down to 1 lot');
  assert.strictEqual(exitQuantity(65, 65, 'PERCENT', 10), 65, 'at least one lot while one is held');
  assert.strictEqual(exitQuantity(-130, 65, 'LOTS', 5), 130, 'capped at the position');
  assert.strictEqual(exitQuantity(130, 65, 'FULL'), 130);
  assert.deepStrictEqual(trail({ side: 'BELOW', best: 100, trigger: 90, distance: 10 }, 120), { best: 120, trigger: 110 });
  assert.deepStrictEqual(trail({ side: 'BELOW', best: 120, trigger: 110, distance: 10 }, 105), { best: 120, trigger: 110 }, 'never moves back');
  assert.strictEqual(hasCrossed('BELOW', 22700, 22700), true);
  assert.strictEqual(hasCrossed('ABOVE', 22900, 22899), false);
});

test('a level below the price describes itself from the positions it covers', async () => {
  const level = await exitLevels.create({ symbolId: row.id, price: 22700 });
  assert.strictEqual(level.side, 'BELOW');
  assert.strictEqual(level.bullish, 2, 'long CE on A, long future on B');
  assert.strictEqual(level.bearish, 2, 'short CE on A, long PE on B');
  assert.match(level.label, /SL for 2 bullish · target for 2 bearish · 2 accounts · full/);
});

test('crossing fires once after the confirmation window, exits exactly the NIFTY book, and cancels the opposite level', async () => {
  const below = await exitLevels.create({ symbolId: row.id, price: 22700 });
  const above = await exitLevels.create({ symbolId: row.id, price: 22950 });

  feed.ltp = 22690;
  await exitLevels.evaluate();
  assert.strictEqual(sent.length, 0, 'one pass across the level is not yet a trigger');

  await evaluateConfirmed();
  assert.deepStrictEqual(sent.map((s) => `${s.inst}:${s.symbol}`).sort(), [
    'Acct A:NIFTYM23000CE', 'Acct A:NIFTYW22800CE', 'Acct B:NIFTYMFUT', 'Acct B:NIFTYW22800PE',
  ], 'every NIFTY position, never BANKNIFTY');
  assert.strictEqual((await db.get('SELECT status FROM exit_levels WHERE id = ?', [below.id])).status, 'TRIGGERED');
  assert.strictEqual((await db.get('SELECT status FROM exit_levels WHERE id = ?', [above.id])).status, 'CANCELLED');

  sent.length = 0;
  await evaluateConfirmed();
  assert.strictEqual(sent.length, 0, 'it fires once');
});

test('coverage narrows a level to one direction; partial sizes round down to lots', async () => {
  await exitLevels.create({ symbolId: row.id, price: 22700, coverage: 'BEARISH', sizeMode: 'PERCENT', sizeValue: 50 });
  feed.ltp = 22650;
  await evaluateConfirmed();
  assert.deepStrictEqual(sent, [
    // 1 lot short CE: 50% floors to the 1-lot minimum, which is the whole position - a close
    { kind: 'close', inst: 'Acct A', symbol: 'NIFTYM23000CE' },
    // 3 lots of PE: 50% floors to 1 lot - a partial exit, the rest stays open
    { kind: 'part', inst: 'Acct B', symbol: 'NIFTYW22800PE', qty: 65 },
  ]);
});

test('a stale price or a closed market never triggers', async () => {
  await exitLevels.create({ symbolId: row.id, price: 22700 });
  feed.ltp = 22600;
  feed.fresh = false;
  await evaluateConfirmed();
  feed.fresh = true;
  feed.open = false;
  exitLevels.openCache.clear();
  await evaluateConfirmed();
  assert.strictEqual(sent.length, 0);
  assert.strictEqual((await db.get('SELECT status FROM exit_levels')).status, 'ACTIVE');
});

test('a trailing stop follows the best price and fires on the pullback', async () => {
  await exitLevels.create({ symbolId: row.id, price: 22750, trailing: true }); // 50 below 22800
  feed.ltp = 22900;
  await exitLevels.evaluate();
  assert.strictEqual((await db.get('SELECT trigger_price FROM exit_levels')).trigger_price, 22850);
  feed.ltp = 22840;
  await evaluateConfirmed();
  assert.ok(sent.length > 0, 'fired at the trailed level');
  assert.ok(sent.every((s) => ['NIFTYW22800CE', 'NIFTYMFUT'].includes(s.symbol)), 'a trailing stop below protects bullish positions only');
});

test('a level cannot be dragged across the market', async () => {
  const level = await exitLevels.create({ symbolId: row.id, price: 22700 });
  await assert.rejects(exitLevels.move(level.id, 22850), /must stay below/);
  assert.strictEqual((await exitLevels.move(level.id, 22720)).trigger_price, 22720);
});

test("the rupee max-loss closes one account's position once its loss reaches the cap", async () => {
  await exitLossCaps.createCap({ symbolId: row.id, exchange: 'NFO', symbol: 'NIFTYW22800PE', maxLoss: 1000 });
  feed.books.get(acctB)[1].pnl = -1200;
  await exitLossCaps.evaluate();
  for (const [k, v] of exitLossCaps.crossSince) exitLossCaps.crossSince.set(k, v - 5000);
  await exitLossCaps.evaluate();
  assert.deepStrictEqual(sent, [{ kind: 'close', inst: 'Acct B', symbol: 'NIFTYW22800PE' }]);
  await exitLossCaps.evaluate();
  assert.strictEqual(sent.length, 1, 'no second attempt within the cooldown');
  await assert.rejects(
    exitLossCaps.createCap({ symbolId: row.id, exchange: 'NFO', symbol: 'BANKNIFTYW51500CE', maxLoss: 500 }),
    /not on NIFTY/
  );
});

test('max-loss reads unrealized P&L only', () => {
  assert.strictEqual(unrealizedPnl({ pnl: -300 }), -300);
  assert.strictEqual(unrealizedPnl({ pnl: -300, realized_pnl: 500 }), -800, 'total minus realized');
  assert.strictEqual(unrealizedPnl({ pnl: -300, realised_pnl: 500, unrealised_pnl: -800 }), -800, 'explicit field wins');
  assert.strictEqual(unrealizedPnl({ mtm: -50 }), -50);
  assert.strictEqual(unrealizedPnl({}), 0);
});
