import assert from 'assert';
import test, { before, beforeEach } from 'node:test';

import { useTestDb, truncate } from '../helpers/db.js';
import riskControls from '../../src/services/risk-controls.service.js';
import { normalizeExitUnit, toExitPoints } from '../../src/services/strategy.service.js';

/**
 * Targets and stop-losses in POINTS or PERCENT (of the entry price), per trade mode (migration
 * 064). A percentage is converted to points when the exit is evaluated: a 2% target on an option
 * bought at 150 is 3 points. Every case is checked on both sides of the threshold and for both
 * LONG and SHORT, because a threshold on the wrong side closes a winner or lets a loss run.
 */

before(async () => { await useTestDb('exit-units'); });
beforeEach(async () => { await truncate(); riskControls.reset(); });

let n = 0;
const evaluate = (configEntry, side, entryPrice, currentPrice, symbol = 'NIFTY27OCT2625000CE') =>
  riskControls.evaluateExit({
    key: riskControls._key(1, 'NFO', `${symbol}-${n += 1}`, side),
    side, entryPrice, currentPrice, configEntry, symbol, instanceId: 1, exchange: 'NFO',
  });

const options = (unit, values) => ({ symbol_type: 'OPTIONS', exit_unit_options: unit, ...values });
const futures = (unit, values) => ({ symbol_type: 'FUTURES', exit_unit_futures: unit, ...values });

test('POINTS (the default) is unchanged: 10-point target, 5-point stop on a long option at 150', async () => {
  const cfg = options(undefined, { target_points_options: 10, stoploss_points_options: 5 });
  assert.strictEqual((await evaluate(cfg, 'LONG', 150, 159.95)).reason, null);
  assert.strictEqual((await evaluate(cfg, 'LONG', 150, 160)).reason, 'TARGET_MET');
  assert.strictEqual((await evaluate(cfg, 'LONG', 150, 145.05)).reason, null);
  assert.strictEqual((await evaluate(cfg, 'LONG', 150, 145)).reason, 'STOPLOSS_HIT');
});

test('PERCENT on a long option: 2% target and 1% stop of an entry at 150 are 3 and 1.5 points', async () => {
  const cfg = options('PERCENT', { target_points_options: 2, stoploss_points_options: 1 });
  assert.strictEqual((await evaluate(cfg, 'LONG', 150, 152.95)).reason, null, 'just short of +3');
  assert.strictEqual((await evaluate(cfg, 'LONG', 150, 153)).reason, 'TARGET_MET');
  assert.strictEqual((await evaluate(cfg, 'LONG', 150, 148.55)).reason, null, 'just short of -1.5');
  assert.strictEqual((await evaluate(cfg, 'LONG', 150, 148.5)).reason, 'STOPLOSS_HIT');
});

test('PERCENT on a short (written) option: target below entry, stop above', async () => {
  const cfg = options('PERCENT', { target_points_options: 20, stoploss_points_options: 10 });
  // Sold at 200: target 20% = 40 points -> 160; stop 10% = 20 points -> 220.
  assert.strictEqual((await evaluate(cfg, 'SHORT', 200, 160)).reason, 'TARGET_MET');
  assert.strictEqual((await evaluate(cfg, 'SHORT', 200, 161)).reason, null);
  assert.strictEqual((await evaluate(cfg, 'SHORT', 200, 220)).reason, 'STOPLOSS_HIT');
  assert.strictEqual((await evaluate(cfg, 'SHORT', 200, 219)).reason, null);
});

test('PERCENT on index and MCX futures scales with price: 0.5% of 25,000 is 125 points, of 6,000 is 30', async () => {
  const cfg = futures('PERCENT', { target_points_futures: 0.5, stoploss_points_futures: 0.5 });
  assert.strictEqual((await evaluate(cfg, 'LONG', 25000, 25125, 'NIFTY27OCT26FUT')).reason, 'TARGET_MET');
  assert.strictEqual((await evaluate(cfg, 'LONG', 25000, 25124, 'NIFTY27OCT26FUT')).reason, null);
  assert.strictEqual((await evaluate(cfg, 'SHORT', 6000, 6030, 'CRUDEOIL19OCT26FUT')).reason, 'STOPLOSS_HIT');
  assert.strictEqual((await evaluate(cfg, 'SHORT', 6000, 5970, 'CRUDEOIL19OCT26FUT')).reason, 'TARGET_MET');
});

test('PERCENT trailing stop with activation, on a crypto perpetual long', async () => {
  // Entry 80,000. Activate after +1% (800), trail 0.5% of entry (400) below the high.
  const cfg = futures('PERCENT', { trailing_stoploss_points_futures: 0.5, trailing_activation_points_futures: 1 });
  const key = riskControls._key(26, 'CRYPTO', 'BTCUSDFUT', 'LONG');
  const at = (price) => riskControls.evaluateExit({ key, side: 'LONG', entryPrice: 80000, currentPrice: price, configEntry: cfg, symbol: 'BTCUSDFUT', instanceId: 26, exchange: 'CRYPTO' });
  assert.strictEqual((await at(80500)).reason, null, 'not yet activated');
  assert.strictEqual((await at(80790)).reason, null, 'still below +1%');
  assert.strictEqual((await at(81000)).reason, null, 'activated, new high 81,000');
  assert.strictEqual((await at(80700)).reason, null, 'above 81,000 - 400');
  assert.strictEqual((await at(80600)).reason, 'TSL_HIT', 'trail at 81,000 - 400 = 80,600');
});

test('each mode keeps its own unit: futures in PERCENT does not change options in POINTS', async () => {
  const cfg = {
    symbol_type: 'OPTIONS',
    exit_unit_futures: 'PERCENT', target_points_futures: 1,
    exit_unit_options: 'POINTS', target_points_options: 5,
  };
  assert.strictEqual((await evaluate(cfg, 'LONG', 100, 104.9)).reason, null);
  assert.strictEqual((await evaluate(cfg, 'LONG', 100, 105)).reason, 'TARGET_MET', 'options read as 5 points');
});

test('a PERCENT threshold without an entry price never triggers', async () => {
  const cfg = options('PERCENT', { stoploss_points_options: 1 });
  assert.strictEqual(riskControls._getThresholds(cfg, 'options', null), null);
});

test('strategy legs: the unit is normalised and converted on the fill price (GTT path)', () => {
  assert.strictEqual(normalizeExitUnit('percent'), 'PERCENT');
  assert.strictEqual(normalizeExitUnit(undefined), 'POINTS');
  assert.strictEqual(normalizeExitUnit('bogus'), 'POINTS');
  assert.strictEqual(toExitPoints(2, 'PERCENT', 150), 3);
  assert.strictEqual(toExitPoints(12, 'POINTS', 150), 12);
  assert.strictEqual(toExitPoints(null, 'PERCENT', 150), null);
});

test('a strategy leg in PERCENT writes its unit onto the auto-exit row it creates', async () => {
  const { default: strategyService } = await import('../../src/services/strategy.service.js');
  const { default: db } = await import('../../src/core/database.js');
  const wl = await db.run("INSERT INTO watchlists (name, is_active, type) VALUES ('units', 1, 'strategy')");
  await strategyService._upsertLegExitConfig({
    watchlistId: wl.lastID, exchange: 'NFO', symbol: 'NIFTY27OCT2625000CE', symbolType: 'OPTIONS', underlyingSymbol: 'NIFTY',
    leg: { target_points: 20, stoploss_points: 10, exit_unit: 'PERCENT' },
  });
  const row = await db.get('SELECT * FROM watchlist_symbols WHERE watchlist_id = ? AND symbol = ?', [wl.lastID, 'NIFTY27OCT2625000CE']);
  assert.strictEqual(row.exit_unit_options, 'PERCENT');
  assert.strictEqual(row.target_points_options, 20);
});

test('a crypto GTT leg exit that cannot be placed reports it, so the app-managed exit is armed instead', async () => {
  // It used to log a warning and leave the leg with no stop at all.
  const { default: strategyService } = await import('../../src/services/strategy.service.js');
  const { default: openalgoClient } = await import('../../src/integrations/openalgo/client.js');
  const { default: gttService } = await import('../../src/services/gtt.service.js');
  const original = { status: openalgoClient.getOrderStatus, place: gttService.placeExitGtt };
  try {
    const args = {
      strategy: { id: 1, broker_tag: 's' }, leg: { id: 1, action: 'BUY', target_points: 100, stoploss_points: 100, exit_unit: 'POINTS' },
      instance: { id: 1 }, exchange: 'CRYPTO', symbol: 'BTCUSDFUT', quantity: 1, product: 'NRML', orderId: 'X', watchlistId: 1, anchorSymbol: { id: 1 },
    };
    openalgoClient.getOrderStatus = async () => ({ average_price: 100000 });
    gttService.placeExitGtt = async () => { throw new Error('GTT not supported'); };
    assert.strictEqual(await strategyService._placeLegExitGtt(args), false, 'broker refused the GTT');
    assert.strictEqual(await strategyService._placeLegExitGtt({ ...args, orderId: null }), false, 'no order id');
    gttService.placeExitGtt = async () => ({ triggerId: 'T1' });
    assert.strictEqual(await strategyService._placeLegExitGtt(args), true, 'placed');
  } finally {
    openalgoClient.getOrderStatus = original.status;
    gttService.placeExitGtt = original.place;
  }
});

test("GTT exit legs: triggers ordered by price (sl < tg) with each OCO leg's own limit, long and short", async () => {
  // Every OCO was refused - "stoploss: Required for OCO (stoploss leg limit)" - and a short's
  // stop was sent as the lower trigger.
  const { default: gttService } = await import('../../src/services/gtt.service.js');
  const { default: openalgoClient } = await import('../../src/integrations/openalgo/client.js');
  const original = openalgoClient.placeGttOrder;
  const { makeInstance } = await import('../helpers/fixtures.js');
  const inst = await makeInstance();
  const sent = [];
  openalgoClient.placeGttOrder = async (inst, payload) => { sent.push(payload); return { status: 'success', trigger_id: `T${sent.length}` }; };
  try {
    const base = { exchange: 'CRYPTO', symbol: 'BTCUSDFUT', product: 'NRML', quantity: 1, entryPrice: 100000 };
    await gttService.placeExitGtt(inst, { ...base, action: 'BUY', stoplossPoints: 500, targetPoints: 1000 });
    await gttService.placeExitGtt(inst, { ...base, action: 'SELL', stoplossPoints: 500, targetPoints: 1000 });
    await gttService.placeExitGtt(inst, { ...base, action: 'SELL', stoplossPoints: 500 });
    const [long, short, shortStop] = sent;
    assert.deepStrictEqual([long.action, long.triggerprice_sl, long.triggerprice_tg], ['SELL', 99500, 101000]);
    assert.deepStrictEqual([long.stoploss, long.target], [99002.5, 100495], 'a SELL leg limit sits below its trigger');
    assert.deepStrictEqual([short.action, short.triggerprice_sl, short.triggerprice_tg], ['BUY', 99000, 100500], "the short's stop is the upper trigger");
    assert.deepStrictEqual([short.stoploss, short.target], [99495, 101002.5], 'a BUY leg limit sits above its trigger');
    assert.deepStrictEqual([shortStop.trigger_type, shortStop.triggerprice_sl, shortStop.triggerprice_tg], ['SINGLE', 0, 100500]);
  } finally {
    openalgoClient.placeGttOrder = original;
  }
});
