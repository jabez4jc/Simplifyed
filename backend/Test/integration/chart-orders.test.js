import assert from 'assert';
import test, { before, after, beforeEach, afterEach } from 'node:test';
import request from 'supertest';

import { useTestDb, truncate } from '../helpers/db.js';
import { buildApp } from '../helpers/app.js';
import { asAdmin, bearer } from '../helpers/auth.js';
import { watchBroker, realInstance, copyRealInstruments, CRYPTO } from '../helpers/real-broker.js';
import { makeWatchlist } from '../helpers/fixtures.js';
import openalgoClient from '../../src/integrations/openalgo/client.js';
import v1Routes from '../../src/routes/v1/index.js';

/**
 * Trading from the chart itself, on the real Jabez Crypto analyzer account: a resting order at a
 * price the operator picked must rest there (not be chased to the market by the retry service),
 * land on the contract's tick, show on the chart's order lines (status open OR pending), move
 * when its line is dragged, and cancel from the line's x.
 */

let app;
let broker;
let admin;
let inst;
let watchlistId;

before(async () => {
  await useTestDb('chart-orders');
  app = buildApp(v1Routes, '/api/v1');
  broker = watchBroker();
});
after(() => broker.restore());

beforeEach(async () => {
  await truncate();
  broker.reset();
  await copyRealInstruments("exchange = 'CRYPTO' AND symbol = 'BTCUSDFUT'");
  admin = await asAdmin();
  inst = await realInstance(CRYPTO);
  watchlistId = (await makeWatchlist({ name: 'Chart orders' })).id;
});

afterEach(async () => {
  const leftovers = await broker.flattenAll();
  assert.deepStrictEqual(leftovers, [], `left open at the broker:\n${leftovers.join('\n')}`);
});

const call = (method, path) => bearer(request(app)[method](path), admin);

async function brokerOrder(orderId) {
  const book = await openalgoClient.getOrderBook(inst);
  return book.find((o) => String(o.orderid) === String(orderId));
}

test('a chart Buy Limit rests on its tick, shows on the order lines, moves when dragged, and cancels', async () => {
  const quotes = await openalgoClient.getQuotes(inst, [{ exchange: 'CRYPTO', symbol: 'BTCUSDFUT' }]);
  const ltp = Number((Array.isArray(quotes) ? quotes : quotes?.quotes || [])[0]?.ltp);
  assert.ok(ltp > 0, 'a live BTC price to place the order under');

  // Half the market, and between ticks (tick 0.5) - as a click on the chart lands.
  const clicked = Math.floor(ltp * 0.5) + 0.37;
  const placed = await call('post', '/api/v1/orders').send({
    instanceId: inst.id, watchlistId, exchange: 'CRYPTO', symbol: 'BTCUSDFUT',
    action: 'BUY', quantity: 1, product: 'NRML', pricetype: 'LIMIT', price: clicked, trigger_type: 'CHART',
  });
  assert.ok(placed.status < 300, JSON.stringify(placed.body).slice(0, 400));
  const row = placed.body.data;
  try {
    // A plain resting order, never a position-target smart order.
    const [sent] = broker.callsTo('placeorder').map((c) => c.data);
    assert.strictEqual(broker.countOf('placesmartorder'), 0);
    assert.strictEqual(sent.pricetype, 'LIMIT');
    assert.strictEqual(Number(sent.price), Math.round(clicked / 0.5) * 0.5, 'rounded to the 0.5 tick');

    // The order lines ask for open AND pending - a just-placed order is 'pending' until synced.
    const lines = await call('get', '/api/v1/orders?symbol=BTCUSDFUT&status=open,pending');
    assert.ok(lines.body.data.some((o) => o.id === row.id), 'the resting order is on the chart');

    // Resting, not chased: still open at the broker at its own price after the retry window.
    await new Promise((r) => setTimeout(r, 8000));
    const resting = await brokerOrder(row.order_id);
    assert.ok(resting, 'the broker has the order');
    assert.match(String(resting.order_status), /open|pending/i, `resting, not ${resting.order_status}`);
    assert.strictEqual(broker.countOf('cancelorder'), 0, 'nothing cancelled it behind the operator\'s back');

    // Drag the line lower.
    const moveTo = Math.floor(ltp * 0.45) + 0.2;
    const moved = await call('post', `/api/v1/orders/${row.id}/modify`).send({ price: moveTo });
    assert.strictEqual(moved.status, 200, JSON.stringify(moved.body).slice(0, 400));
    const [mod] = broker.callsTo('modifyorder').map((c) => c.data);
    assert.strictEqual(Number(mod.price), Math.round(moveTo / 0.5) * 0.5);
    assert.strictEqual(String(mod.orderid), String(row.order_id));
    assert.strictEqual(Number(moved.body.data.price), Number(mod.price));
  } finally {
    // The line's x.
    const cancel = await call('post', `/api/v1/orders/${row.id}/cancel`);
    assert.strictEqual(cancel.status, 200, JSON.stringify(cancel.body).slice(0, 400));
  }
  const after = await brokerOrder(row.order_id);
  assert.match(String(after?.order_status), /cancel/i, 'cancelled at the broker');
});
