import assert from 'assert';
import test from 'node:test';
import { useTestDb } from '../helpers/db.js';
import { makeInstance } from '../helpers/fixtures.js';
import db from '../../src/core/database.js';
import openalgoWsService from '../../src/services/openalgo-ws.service.js';
import marketDataFeedService, { ORDER_STREAM_SWEEP_MS } from '../../src/services/market-data-feed.service.js';
import orderService from '../../src/services/order.service.js';
import pollingService from '../../src/services/polling.service.js';
import openalgoClient from '../../src/integrations/openalgo/client.js';

/**
 * Order status is push-first (OpenAlgo WebSocket order stream) with REST polling as the fallback.
 * See wireOrderStream in polling.service.js.
 */

await useTestDb('order-stream');

async function makeOrder(instanceId, orderId, status = 'open') {
  const { lastID } = await db.run(
    `INSERT INTO watchlist_orders (instance_id, exchange, symbol, side, quantity, order_type, product_type, status, order_id)
     VALUES (?, 'NSE', 'SBIN', 'BUY', 10, 'LIMIT', 'MIS', ?, ?)`,
    [instanceId, status, orderId]
  );
  return lastID;
}
const statusOf = async (id) => (await db.get('SELECT status FROM watchlist_orders WHERE id = ?', [id])).status;
const push = (instanceId, order) => openalgoWsService.emit('order_update', { instanceId, order: { type: 'order_update', ...order } });
const settle = () => new Promise((r) => setTimeout(r, 50));

test('a pushed fill updates the stored order and the cached orderbook, with no REST call', async (t) => {
  const rest = t.mock.method(openalgoClient, 'getOrderBook', async () => []);
  const inst = await makeInstance();
  const rowId = await makeOrder(inst.id, 'OID-1');
  marketDataFeedService.orderbookCache.set(inst.id, {
    data: [{ orderid: 'OID-1', symbol: 'SBIN', exchange: 'NSE', order_status: 'open', quantity: '10' }],
    fetchedAt: 0,
  });
  marketDataFeedService._updateOpenOrderState(inst.id, marketDataFeedService.orderbookCache.get(inst.id).data);
  assert.ok(marketDataFeedService.openOrderInstances.has(inst.id));

  push(inst.id, { orderid: 'OID-1', order_status: 'complete', filled_quantity: 10, average_price: 801.5 });
  await settle();

  assert.strictEqual(await statusOf(rowId), 'complete');
  const cached = marketDataFeedService.orderbookCache.get(inst.id).data[0];
  assert.strictEqual(cached.order_status, 'complete');
  assert.strictEqual(cached.average_price, 801.5);
  assert.strictEqual(cached.type, undefined, 'envelope fields stay out of the orderbook row');
  assert.ok(!marketDataFeedService.openOrderInstances.has(inst.id), 'no open orders left, so polling cadence relaxes');
  assert.strictEqual(rest.mock.callCount(), 0);
});

test('an order placed elsewhere is added to the cached orderbook; "trigger pending" counts as open', async () => {
  const inst = await makeInstance();
  marketDataFeedService.orderbookCache.set(inst.id, { data: [], fetchedAt: 0 });
  push(inst.id, { orderid: 'EXT-1', symbol: 'INFY', exchange: 'NSE', order_status: 'trigger pending' });
  await settle();
  assert.strictEqual(marketDataFeedService.orderbookCache.get(inst.id).data.length, 1);
  assert.ok(marketDataFeedService.openOrderInstances.has(inst.id));
});

test('a late or duplicate push never reopens a final order; expired is final', async () => {
  const inst = await makeInstance();
  const done = await makeOrder(inst.id, 'OID-2', 'complete');
  assert.strictEqual(await orderService.applyOrderUpdate(inst.id, { orderid: 'OID-2', order_status: 'open' }), false);
  assert.strictEqual(await statusOf(done), 'complete');

  const expiring = await makeOrder(inst.id, 'OID-3', 'open');
  assert.strictEqual(await orderService.applyOrderUpdate(inst.id, { orderid: 'OID-3', order_status: 'expired' }), true);
  assert.strictEqual(await statusOf(expiring), 'cancelled');
});

test('REST order sync steps back while the push stream is live, keeping only the sweep', (t) => {
  const live = new Set([501]);
  t.mock.method(openalgoWsService, 'isOrderStreamLive', (id) => live.has(id));

  assert.strictEqual(pollingService._orderSyncDue(777), true, 'no live stream: poll as always');

  pollingService.lastOrderSyncAt.set(501, Date.now());
  assert.strictEqual(pollingService._orderSyncDue(501), false, 'live stream, just synced: skip');
  pollingService.lastOrderSyncAt.set(501, Date.now() - ORDER_STREAM_SWEEP_MS);
  assert.strictEqual(pollingService._orderSyncDue(501), true, 'live stream, sweep due: poll once');

  live.delete(501);
  pollingService.lastOrderSyncAt.set(501, Date.now());
  assert.strictEqual(pollingService._orderSyncDue(501), true, 'stream dropped: polling resumes at once');
});

test('the stream counts as live only after subscribe_orders is acknowledged, and a catch-up sync runs when it goes live', async (t) => {
  const inst = await makeInstance({ host_url: '' }); // no URL: the connection never opens a real socket
  const synced = [];
  t.mock.method(pollingService, 'syncOrdersNow', async (id) => { synced.push(id); });
  openalgoWsService.start([inst]);
  const conn = openalgoWsService.connections.get(inst.id);
  conn.connected = true;
  conn._send = () => {};

  conn._onMessage(Buffer.from(JSON.stringify({ type: 'auth', status: 'success' })));
  assert.strictEqual(openalgoWsService.isOrderStreamLive(inst.id), false, 'authenticated is not enough');

  conn._onMessage(Buffer.from(JSON.stringify({ type: 'subscribe_orders', status: 'success' })));
  assert.strictEqual(openalgoWsService.isOrderStreamLive(inst.id), true);
  assert.deepStrictEqual(synced, [inst.id], 'one catch-up sync for whatever changed while it was down');

  openalgoWsService.stop();
  assert.strictEqual(openalgoWsService.isOrderStreamLive(inst.id), false);
});

test('a day order from an earlier session that the broker book no longer lists is closed out; today\'s and crypto are not', async (t) => {
  t.mock.method(openalgoClient, 'getOrderBook', async () => []);
  const inst = await makeInstance();
  const stale = await makeOrder(inst.id, 'OLD-1');
  const fresh = await makeOrder(inst.id, 'NEW-1');
  const crypto = await makeOrder(inst.id, 'GTC-1');
  const unacked = await makeOrder(inst.id, null, 'pending');
  await db.run("UPDATE watchlist_orders SET placed_at = datetime('now', '-1 day') WHERE id IN (?, ?, ?)", [stale, crypto, unacked]);
  await db.run("UPDATE watchlist_orders SET exchange = 'CRYPTO', symbol = 'BTCUSDFUT' WHERE id = ?", [crypto]);

  await orderService.syncOrderStatus(inst.id);

  assert.strictEqual(await statusOf(stale), 'cancelled', 'lapsed at the close of its session');
  assert.strictEqual(await statusOf(fresh), 'open', 'today\'s order missing from a book is not assumed gone');
  assert.strictEqual(await statusOf(crypto), 'open', 'a crypto order can rest across days');
  assert.strictEqual(await statusOf(unacked), 'pending', 'no broker id, nothing to judge it by');
});

test('a book read before a cancel landed does not bring the cancelled order back', async (t) => {
  const inst = await makeInstance();
  const row = await makeOrder(inst.id, 'RACE-1', 'pending');
  // The book is read while the cancel commits: it still lists the order as open.
  t.mock.method(openalgoClient, 'getOrderBook', async () => {
    await db.run("UPDATE watchlist_orders SET status = 'cancelled' WHERE id = ?", [row]);
    return [{ orderid: 'RACE-1', order_status: 'open' }];
  });
  await orderService.syncOrderStatus(inst.id);
  assert.strictEqual(await statusOf(row), 'cancelled');
});

test('a cancel the broker refuses because the order is already final records that state', async (t) => {
  const inst = await makeInstance();
  const done = await makeOrder(inst.id, 'GONE-1');
  const live = await makeOrder(inst.id, 'LIVE-1');
  t.mock.method(openalgoClient, 'cancelOrder', async () => { throw new Error('OpenAlgo: Cannot cancel order in cancelled status'); });
  t.mock.method(openalgoClient, 'getOrderBook', async () => [
    { orderid: 'GONE-1', order_status: 'cancelled' },
    { orderid: 'LIVE-1', order_status: 'open' },
  ]);

  await assert.rejects(orderService.cancelOrder(done), /already cancelled at the broker/);
  assert.strictEqual(await statusOf(done), 'cancelled', 'no longer drawn as working');

  await assert.rejects(orderService.cancelOrder(live), /Cannot cancel order in cancelled status/, 'a working order keeps the broker\'s own error');
  assert.strictEqual(await statusOf(live), 'open');
});
