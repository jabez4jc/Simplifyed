import assert from 'assert';
import test, { afterEach } from 'node:test';
import tradingviewBroadcastService from '../../src/services/tradingview-broadcast.service.js';
import watchlistService from '../../src/services/watchlist.service.js';
import orderService from '../../src/services/order.service.js';

/**
 * C4: the broadcast webhook used to POST placesmartorder straight to OpenAlgo over its own
 * fetch/retry loop, bypassing openalgoClient (no circuit breaker, no rate limit, no
 * ORDER_OUTCOME_UNKNOWN handling - a timeout re-sent the order instead of checking the broker's
 * book first - no SEBI SL-M->SL conversion, no broker-unit conversion, and no watchlist_orders
 * row). It now dispatches through order.service.placeOrder exactly once per target, with no
 * retry loop of its own.
 */

const original = {
  getBroadcastTargets: watchlistService.getBroadcastTargets,
  placeOrder: orderService.placeOrder,
};

afterEach(() => {
  watchlistService.getBroadcastTargets = original.getBroadcastTargets;
  orderService.placeOrder = original.placeOrder;
});

function stubOneTarget() {
  watchlistService.getBroadcastTargets = async () => ({
    watchlist: { id: 7, name: 'Broadcast WL', webhook_slug: 'slug-1' },
    targets: [{ name: 'Jz Fyers', instance_id: 6 }],
  });
}

test('a broadcast alert calls order.service.placeOrder exactly once per target, and never retries', async () => {
  stubOneTarget();
  let calls = 0;
  orderService.placeOrder = async (params) => {
    calls += 1;
    assert.strictEqual(params.instanceId, 6);
    assert.strictEqual(params.source, 'webhook');
    assert.strictEqual(params.symbol, 'BTCUSDFUT');
    return { order_id: 'OA1', status: 'pending' };
  };

  const result = await tradingviewBroadcastService.broadcast({
    strategy: 'tv-strategy',
    exchange: 'CRYPTO',
    symbol: 'BTCUSDFUT',
    action: 'BUY',
    quantity: 1,
    position_size: 1,
    pricetype: 'MARKET',
    price: 0,
    trigger_price: 0,
    product: 'MIS',
  }, { watchlistId: 7 });

  assert.strictEqual(calls, 1, 'exactly one dispatch per target, no retry loop of its own');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.okCount, 1);
});

test('a target that fails is reported, not silently retried or swallowed', async () => {
  stubOneTarget();
  let calls = 0;
  orderService.placeOrder = async () => {
    calls += 1;
    const err = new Error('Insufficient funds');
    err.statusCode = 400;
    throw err;
  };

  const result = await tradingviewBroadcastService.broadcast({
    strategy: 'tv-strategy',
    exchange: 'CRYPTO',
    symbol: 'BTCUSDFUT',
    action: 'BUY',
    quantity: 1,
    position_size: 1,
    pricetype: 'MARKET',
    price: 0,
    trigger_price: 0,
    product: 'MIS',
  }, { watchlistId: 7 });

  assert.strictEqual(calls, 1, 'a failed dispatch must not be retried internally');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.results[0].error, 'Insufficient funds');
});
