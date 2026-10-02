import assert from 'assert';
import test, { before, beforeEach, afterEach } from 'node:test';

import { useTestDb, truncate } from '../helpers/db.js';
import db from '../../src/core/database.js';
import { makeInstance, makeWatchlist, makeWatchlistSymbol } from '../helpers/fixtures.js';
import quickOrderService from '../../src/services/quick-order.service.js';
import orderPlacementService from '../../src/services/order-placement.service.js';
import orderService from '../../src/services/order.service.js';
import strategyService from '../../src/services/strategy.service.js';
import instanceService from '../../src/services/instance.service.js';
import instrumentsService from '../../src/services/instruments.service.js';
import limitPriceService from '../../src/services/limit-price.service.js';
import marginSizingService from '../../src/services/margin-sizing.service.js';
import brokerUnitsService from '../../src/services/broker-units.service.js';
import openalgoClient from '../../src/integrations/openalgo/client.js';
import { ValidationError } from '../../src/core/errors.js';

/**
 * P3-7: order and strategy correctness. Nothing here reaches a broker: every outbound call is
 * stubbed and restored.
 */

const stubs = [];
const stub = (obj, name, fn) => { stubs.push([obj, name, obj[name]]); obj[name] = fn; };

before(async () => { await useTestDb('order-correctness'); });
beforeEach(async () => { await truncate(); });
afterEach(() => { while (stubs.length) { const [o, n, f] = stubs.pop(); o[n] = f; } });

test('an Indian exchange always resolves to LIMIT, whatever the broker supports', async () => {
  const delta = { broker: 'deltaexchange' };
  assert.strictEqual(await quickOrderService._resolveOrderTypeForInstance(delta, 'NFO'), 'LIMIT');
  assert.strictEqual(await quickOrderService._resolveOrderTypeForInstance(delta, 'MCX'), 'LIMIT');
  assert.strictEqual(await quickOrderService._resolveOrderTypeForInstance(delta, 'CRYPTO'), 'MARKET');
  assert.strictEqual(await quickOrderService._resolveBroadcastOrderType([delta, delta], 'NFO'), 'LIMIT');
});

test('quantity must be a whole number above zero', () => {
  const base = { symbolId: 1, action: 'BUY', tradeMode: 'FUTURES' };
  assert.throws(() => quickOrderService._validateOrderParams({ ...base, quantity: 1.5 }), ValidationError);
  assert.throws(() => quickOrderService._validateOrderParams({ ...base, quantity: 0 }), ValidationError);
  assert.throws(() => quickOrderService._validateOrderParams({ ...base, quantity: '2' }), ValidationError);
  assert.doesNotThrow(() => quickOrderService._validateOrderParams({ ...base, quantity: 2 }));
});

test('queued placements coalesce only within one origin', () => {
  const instance = { id: 777 };
  orderPlacementService.instanceInFlight.add(instance.id); // keep the queue from draining
  try {
    const p = { symbol: 'NIFTY27OCT26FUT', exchange: 'NFO', product: 'NRML', action: 'BUY', quantity: 65 };
    orderPlacementService._enqueuePlacement(instance, { ...p, strategy: 'A' }, { request_type: 'ENTRY' }).catch(() => {});
    orderPlacementService._enqueuePlacement(instance, { ...p, strategy: 'B' }, { request_type: 'ENTRY' }).catch(() => {});
    orderPlacementService._enqueuePlacement(instance, { ...p, strategy: 'A', quantity: 130 }, { request_type: 'ENTRY' }).catch(() => {});
    const queue = orderPlacementService._getQueue(instance.id);
    assert.strictEqual(queue.length, 2, 'A and B stay separate');
    const a = queue.find((e) => e.payload.strategy === 'A');
    assert.strictEqual(a.coalesced, 1, "A's second request replaced its first");
    assert.strictEqual(a.payload.quantity, 130);
    assert.strictEqual(queue.find((e) => e.payload.strategy === 'B').payload.quantity, 65, "B's payload untouched");
  } finally {
    orderPlacementService.instanceInFlight.delete(instance.id);
    orderPlacementService.instanceQueues.delete(instance.id);
  }
});

test('cancelOrder refuses a row that never got a broker order id', async () => {
  const instance = await makeInstance();
  const wl = await makeWatchlist();
  const { lastID } = await db.run(
    `INSERT INTO watchlist_orders (watchlist_id, instance_id, exchange, symbol, side, quantity, order_type, product_type, status)
     VALUES (?, ?, 'NSE', 'X', 'BUY', 1, 'LIMIT', 'MIS', 'pending')`,
    [wl.id, instance.id]
  );
  stub(openalgoClient, 'cancelOrder', async () => { throw new Error('must not be called'); });
  await assert.rejects(() => orderService.cancelOrder(lastID), /no broker order id/);
});

async function legRow({ strategyId, instanceId, symbol, exitOrderId = null }) {
  const leg = await db.run(
    "INSERT INTO strategy_legs (strategy_id, action, product_type) VALUES (?, 'SELL', 'MIS')", [strategyId]
  );
  const { lastID } = await db.run(
    `INSERT INTO strategy_leg_executions
       (strategy_id, strategy_leg_id, instance_id, execution_id, resolved_symbol, resolved_exchange, quantity, product, entry_status, exit_order_id)
     VALUES (?, ?, ?, 'e1', ?, 'NFO', 65, 'MIS', 'PLACED', ?)`,
    [strategyId, leg.lastID, instanceId, symbol, exitOrderId]
  );
  return lastID;
}

test('an opposite fill closes a leg only when it is the leg\'s own exit or carries the strategy tag', async () => {
  const instance = await makeInstance();
  const wl = await makeWatchlist({ type: 'strategy' });
  const s = await db.run(
    "INSERT INTO strategies (watchlist_id, name, underlying, exchange, broker_tag) VALUES (?, 'S', 'NIFTY', 'NFO', 'mytag')", [wl.id]
  );
  const stranger = await legRow({ strategyId: s.lastID, instanceId: instance.id, symbol: 'NIFTYA' });
  const byTag = await legRow({ strategyId: s.lastID, instanceId: instance.id, symbol: 'NIFTYB' });
  const byId = await legRow({ strategyId: s.lastID, instanceId: instance.id, symbol: 'NIFTYC', exitOrderId: 'X9' });
  const fill = (symbol, extra) => ({ order_status: 'complete', symbol, action: 'BUY', filled_quantity: 65, ...extra });

  await strategyService.reconcileOrderUpdate(instance.id, fill('NIFTYA', { orderid: 'Z1', strategy: 'someone-else' }));
  await strategyService.reconcileOrderUpdate(instance.id, fill('NIFTYB', { orderid: 'Z2', strategy: 'mytag' }));
  await strategyService.reconcileOrderUpdate(instance.id, fill('NIFTYC', { orderid: 'X9' }));

  const closed = async (id) => Boolean((await db.get('SELECT closed_at FROM strategy_leg_executions WHERE id = ?', [id])).closed_at);
  assert.strictEqual(await closed(stranger), false, 'a fill from another strategy proves nothing');
  assert.strictEqual(await closed(byTag), true);
  assert.strictEqual(await closed(byId), true);
});

test('deleting a strategy removes the anchor and leg-exit rows it seeded, but not ones another strategy uses', async () => {
  const instance = await makeInstance();
  const wl = await makeWatchlist({ type: 'strategy' });
  const mk = async (name) => (await db.run(
    "INSERT INTO strategies (watchlist_id, name, underlying, exchange) VALUES (?, ?, 'NIFTY', 'NFO')", [wl.id, name]
  )).lastID;
  const one = await mk('one');
  const two = await mk('two');
  await makeWatchlistSymbol(wl.id, { exchange: 'NFO', symbol: 'NIFTY27OCT26FUT', underlying_symbol: 'NIFTY', symbol_type: 'FUTURES' });
  await makeWatchlistSymbol(wl.id, { exchange: 'NFO', symbol: 'NIFTYLEGONE', symbol_type: 'OPTIONS' });
  await makeWatchlistSymbol(wl.id, { exchange: 'NFO', symbol: 'NIFTYSHARED', symbol_type: 'OPTIONS' });
  await legRow({ strategyId: one, instanceId: instance.id, symbol: 'NIFTYLEGONE' });
  await legRow({ strategyId: one, instanceId: instance.id, symbol: 'NIFTYSHARED' });
  await legRow({ strategyId: two, instanceId: instance.id, symbol: 'NIFTYSHARED' });
  const left = async () => (await db.all('SELECT symbol FROM watchlist_symbols WHERE watchlist_id = ? ORDER BY symbol', [wl.id])).map((r) => r.symbol);

  await strategyService.deleteStrategy(one);
  assert.deepStrictEqual(await left(), ['NIFTY27OCT26FUT', 'NIFTYSHARED'], 'own leg row gone; anchor and shared row stay');
  await strategyService.deleteStrategy(two);
  assert.deepStrictEqual(await left(), [], 'last strategy takes the anchor and the shared row with it');
});

test('MARGIN_BASED sizing asks for margin on the leg contract, not the underlying index', async () => {
  const seen = {};
  stub(marginSizingService, 'computeLotQuantity', async (args) => { seen.args = args; return { quantity: 130 }; });
  const qty = await strategyService._resolveLegQuantity({
    leg: { qty_type: 'MARGIN_BASED', qty_value: 0.5, action: 'SELL', product_type: 'MIS' },
    anchorSymbol: { lot_size: 65 },
    instance: { id: 1 },
    strategy: { exchange: 'NSE_INDEX', underlying: 'NIFTY', watchlist_id: 1 },
    contract: { symbol: 'NIFTY27OCT2622400CE', exchange: 'NFO', product: 'NRML' },
  });
  assert.strictEqual(qty, 130);
  assert.deepStrictEqual(
    [seen.args.orderContext.exchange, seen.args.orderContext.symbol, seen.args.orderContext.product],
    ['NFO', 'NIFTY27OCT2622400CE', 'NRML']
  );
  assert.strictEqual(seen.args.symbolConfig.lot_size, 65);
});

test('a close prices off the tick of the contract being closed', async () => {
  const instance = await makeInstance();
  const ticks = [];
  stub(instrumentsService, 'getInstrument', async () => ({ tick_size: 0.05 }));
  stub(quickOrderService, '_getOpenPositionsForSymbol', async () => [
    { symbol: 'NIFTY27OCT2622400CE', exchange: 'NFO', product: 'NRML', quantity: 65 },
  ]);
  stub(quickOrderService, '_resolveOrderTypeForInstance', async () => 'LIMIT');
  stub(limitPriceService, 'resolveMarketablePricing', async (a) => { ticks.push(a.tickSize); return { pricetype: 'LIMIT', price: 100 }; });
  stub(orderPlacementService, 'placeSmartOrder', async (_i, _p, ctx) => { ticks.push(ctx.tickSize); return { orderid: 'o1' }; });
  stub(quickOrderService, '_recordQuickOrder', async () => {});
  await quickOrderService.closePosition(
    instance,
    { symbol: 'NIFTY27OCT2622400CE', exchange: 'NFO', tick_size: 1 }, // the watchlist row says 1
    { tradeMode: 'EQUITY', product: 'NRML' }
  ).catch(() => {});
  assert.deepStrictEqual(ticks.slice(0, 2), [0.05, 0.05]);
});

test('Close All waits for LIMIT exits to fill before it says a position is still open', async () => {
  const instance = { id: 5 };
  let reads = 0;
  stub(openalgoClient, 'getPositionBook', async () => {
    reads += 1;
    return reads <= 3 ? [{ symbol: 'GOLDM', exchange: 'MCX', quantity: 1 }] : []; // flat on the 4th read
  });
  stub(quickOrderService, 'closePosition', async () => ({ closed_count: 1 }));
  const res = await quickOrderService.closeAllPositions(instance, { settleMs: 50, pollMs: 5 });
  assert.deepStrictEqual(res.stillOpen, []);
  assert.ok(reads >= 4);

  stub(openalgoClient, 'getPositionBook', async () => [{ symbol: 'GOLDM', exchange: 'MCX', quantity: 1 }]);
  const stuck = await quickOrderService.closeAllPositions(instance, { settleMs: 20, pollMs: 5 });
  assert.strictEqual(stuck.stillOpen.length, 1, 'still open after the grace window is reported');
});

test('GTT and margin payloads are converted to the broker lot like orders; a missing units table fails loudly', async () => {
  await db.run('DELETE FROM instruments');
  await db.run(
    "INSERT INTO instruments (symbol, name, exchange, lotsize, expiry, instrumenttype) VALUES ('GOLDM05OCT26FUT', 'GOLDM', 'MCX', 10, '2026-10-05', 'FUT')"
  );
  brokerUnitsService.cache.clear();
  const kotak = { id: 3, name: 'Kotak', broker: 'kotak' };
  const client = { async request() { return { status: 'success', data: { lotsize: 100 } }; } };

  const gtt = await brokerUnitsService.toBroker(kotak, 'placegttorder', { symbol: 'GOLDM05OCT26FUT', exchange: 'MCX', quantity: 10 }, client);
  assert.strictEqual(gtt.quantity, 100);
  const original = { positions: [{ symbol: 'GOLDM05OCT26FUT', exchange: 'MCX', quantity: 10 }] };
  const margin = await brokerUnitsService.toBroker(kotak, 'margin', original, client);
  assert.strictEqual(margin.positions[0].quantity, 100);
  assert.strictEqual(original.positions[0].quantity, 10, 'the caller\'s payload is not mutated');

  brokerUnitsService.cache.clear();
  brokerUnitsService.tableCheck = null;
  await db.run('ALTER TABLE broker_lot_sizes RENAME TO broker_lot_sizes_off');
  try {
    await assert.rejects(
      () => brokerUnitsService.toBroker(kotak, 'placeorder', { symbol: 'GOLDM05OCT26FUT', exchange: 'MCX', quantity: 10 }, client),
      /broker_lot_sizes table missing/
    );
  } finally {
    await db.run('ALTER TABLE broker_lot_sizes_off RENAME TO broker_lot_sizes');
    brokerUnitsService.tableCheck = null;
  }
});

test('deleteInstance refuses open positions unless forced, clears trailing_state, and uses a real transaction', async () => {
  const inst = await makeInstance();
  await db.run(
    "INSERT INTO trailing_state (instance_id, exchange, symbol, side) VALUES (?, 'NFO', 'X', 'LONG')", [inst.id]
  );
  stub(openalgoClient, 'getPositionBook', async () => [{ symbol: 'X', exchange: 'NFO', quantity: 65 }]);
  await assert.rejects(() => instanceService.deleteInstance(inst.id), /open position/);
  assert.ok(await db.get('SELECT id FROM instances WHERE id = ?', [inst.id]), 'still there');

  stub(openalgoClient, 'getPositionBook', async () => { throw new Error('broker down'); });
  await assert.rejects(() => instanceService.deleteInstance(inst.id), /Cannot confirm/);

  await instanceService.deleteInstance(inst.id, { force: true });
  assert.ok(!(await db.get('SELECT id FROM instances WHERE id = ?', [inst.id])));
  assert.strictEqual((await db.get('SELECT COUNT(*) AS n FROM trailing_state WHERE instance_id = ?', [inst.id])).n, 0);

  const flat = await makeInstance();
  stub(openalgoClient, 'getPositionBook', async () => []);
  await instanceService.deleteInstance(flat.id);
  assert.ok(!(await db.get('SELECT id FROM instances WHERE id = ?', [flat.id])));
});
