import assert from 'assert';
import test from 'node:test';

import openalgoWsService, { depthSubscriptionFrames, orderUpdateKey } from '../../src/services/openalgo-ws.service.js';
import wsGatewayService from '../../src/services/ws-gateway.service.js';

const inst = (id, extra = {}) => ({ id, host_url: `http://h${id}`, api_key: `k${id}`, websocket_url: null, ...extra });

test('reconcile closes deactivated and re-keyed connections and starts the rest', () => {
  const closed = [];
  const fake = (i) => ({ instance: i, close: () => closed.push(i.id) });
  const savedConns = openalgoWsService.connections;
  const savedStart = openalgoWsService.start;
  let started = null;
  openalgoWsService.connections = new Map([[1, fake(inst(1))], [2, fake(inst(2))], [3, fake(inst(3))]]);
  openalgoWsService.start = (list) => { started = list; };
  try {
    openalgoWsService.reconcile([inst(1), inst(2, { api_key: 'new' }), inst(4)]);
    assert.deepStrictEqual(closed.sort(), [2, 3], 'the re-keyed (2) and the removed (3) are closed');
    assert.deepStrictEqual([...openalgoWsService.connections.keys()], [1]);
    assert.deepStrictEqual(started.map((i) => i.id), [1, 2, 4], 'start opens the missing ones (2 again, and the new 4)');
  } finally {
    openalgoWsService.connections = savedConns;
    openalgoWsService.start = savedStart;
  }
});

test('depth that is no longer wanted is unsubscribed', () => {
  const frames = depthSubscriptionFrames(new Map([['NSE|SBIN', 5], ['NSE|TCS', 5]]), new Map([['NSE|TCS', { exchange: 'NSE', symbol: 'TCS', depth_level: 5 }]]));
  assert.deepStrictEqual(frames, [{ action: 'unsubscribe', symbols: [{ exchange: 'NSE', symbol: 'SBIN', mode: 'Depth' }] }]);
});

test('the same order id on two instances is not a duplicate update', () => {
  const o = { orderid: 'A1', order_status: 'complete', filled_quantity: 1 };
  assert.notStrictEqual(orderUpdateKey(o, 1), orderUpdateKey(o, 2));
  const svc = openalgoWsService;
  svc.orderUpdateSeen.clear();
  assert.strictEqual(svc._isDuplicateOrderUpdate(o, 1), false);
  assert.strictEqual(svc._isDuplicateOrderUpdate(o, 2), false);
  assert.strictEqual(svc._isDuplicateOrderUpdate(o, 1), true);
  svc.orderUpdateSeen.clear();
});

test('the browser gets the latest quote per symbol once per flush, not every tick', async () => {
  const sent = [];
  const client = { readyState: 1, OPEN: 1, meta: { topics: new Set() }, send: (m) => sent.push(JSON.parse(m)) };
  wsGatewayService.wss = { clients: new Set([client]) };
  try {
    for (const ltp of [100, 101, 102]) wsGatewayService._queueQuotes({ instanceId: 5, data: [{ exchange: 'NSE', symbol: 'SBIN', ltp }] });
    wsGatewayService._queueQuotes({ instanceId: 5, data: [{ exchange: 'NSE', symbol: 'TCS', ltp: 7 }] });
    assert.strictEqual(sent.length, 0, 'nothing is sent per tick');
    await new Promise((r) => setTimeout(r, 400));
  } finally {
    wsGatewayService.wss = null;
  }
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].topic, 'quotes:update');
  assert.strictEqual(sent[0].payload.instanceId, 5);
  assert.deepStrictEqual(sent[0].payload.data.map((q) => [q.symbol, q.ltp]), [['SBIN', 102], ['TCS', 7]]);
});
