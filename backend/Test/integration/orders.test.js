import assert from 'assert';
import test, { before, after, beforeEach, afterEach } from 'node:test';
import request from 'supertest';

import { useTestDb, truncate } from '../helpers/db.js';
import { buildApp } from '../helpers/app.js';
import { asAdmin, asMonitor, withPermissions, withPermissionsExcept, bearer } from '../helpers/auth.js';
import { makeInstance } from '../helpers/fixtures.js';
import { watchBroker, realInstance, realCredentials, CRYPTO, KOTAK, nseOpen } from '../helpers/real-broker.js';
import { STATUS } from '../helpers/http.js';
import orderRoutes from '../../src/routes/v1/orders.js';

let app;
let broker;

before(async () => {
  await useTestDb('orders');
  app = buildApp(orderRoutes, '/api/v1/orders');
  broker = watchBroker();
});
after(() => broker.restore());
beforeEach(async () => {
  await truncate();
  broker.reset();
});
// Orders here are real (analyzer-mode) orders: close each test's before the next one starts.
afterEach(async () => {
  const leftovers = await broker.flattenAll();
  assert.deepStrictEqual(leftovers, [], `left open at the broker:\n${leftovers.join('\n')}`);
});

const get = (p, u) => bearer(request(app).get(p), u);
const post = (p, u) => bearer(request(app).post(p), u);

/**
 * A well-formed order - the baseline each test perturbs one field of. Validation tests use it
 * against a fixture instance whose broker is unreachable (nothing may be sent anyway); tests that
 * send use btc() on the real crypto account, which trades 24x7.
 */
const orderFor = (instance, overrides = {}) => ({
  instanceId: instance.id,
  exchange: 'NSE',
  symbol: 'RELIANCE',
  action: 'BUY',
  quantity: 10,
  position_size: 10,
  product: 'MIS',
  pricetype: 'MARKET',
  ...overrides,
});

const btc = (instance, overrides = {}) => orderFor(instance, {
  exchange: 'CRYPTO', symbol: 'BTCUSDFUT', quantity: 1, position_size: 1, product: 'NRML', ...overrides,
});

// ---------------------------------------------------------------------------
// Access control - the gate in front of real money
// ---------------------------------------------------------------------------

test('no order route answers an unauthenticated caller', async () => {
  const routes = [
    ['get', '/api/v1/orders'],
    ['get', '/api/v1/orders/orderbook'],
    ['post', '/api/v1/orders'],
    ['post', '/api/v1/orders/1/cancel'],
    ['post', '/api/v1/orders/cancel-all'],
  ];
  for (const [method, path] of routes) {
    const res = await request(app)[method](path);
    assert.strictEqual(res.status, STATUS.UNAUTHORIZED, `${method.toUpperCase()} ${path} -> ${res.status}`);
  }
});

test('placing an order requires orders.place and nothing else will do', async () => {
  const inst = await makeInstance();
  const almost = await withPermissionsExcept(['orders.place']);

  const denied = await post('/api/v1/orders', almost).send(orderFor(inst));
  assert.strictEqual(denied.status, STATUS.FORBIDDEN);
  assert.strictEqual(broker.countOf('placesmartorder'), 0, 'a refused request must never reach the broker');
});

test('cancel and cancel-all are separately gated', async () => {
  const canCancelOne = await withPermissions(['pages.orders.view', 'orders.cancel']);
  const res = await post('/api/v1/orders/cancel-all', canCancelOne).send({ instanceId: 1 });
  assert.strictEqual(res.status, STATUS.FORBIDDEN, 'cancelling one order does not imply cancelling every order');
});

test('a monitor cannot place an order', async () => {
  const inst = await makeInstance();
  const monitor = await asMonitor();
  const res = await post('/api/v1/orders', monitor).send(orderFor(inst));
  assert.strictEqual(res.status, STATUS.FORBIDDEN);
  assert.strictEqual(broker.countOf('placesmartorder'), 0);
});

// ---------------------------------------------------------------------------
// Input validation - every one of these reaching the broker is a real trade
// ---------------------------------------------------------------------------

test('an order missing any required field is refused before it reaches the broker', async () => {
  const admin = await asAdmin();
  const inst = await makeInstance();

  const bad = [
    ['no symbol', { symbol: undefined }],
    ['no exchange', { exchange: undefined }],
    ['no action', { action: undefined }],
    ['no quantity', { quantity: undefined }],
    ['no position_size', { position_size: undefined }],
  ];

  for (const [label, patch] of bad) {
    const payload = orderFor(inst, patch);
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete payload[k];

    const res = await post('/api/v1/orders', admin).send(payload);
    assert.strictEqual(res.status, STATUS.VALIDATION, `${label} -> ${res.status}`);
  }

  assert.strictEqual(broker.countOf('placesmartorder'), 0, 'not one malformed order may be sent');
});

test('quantity must be a positive whole number', async () => {
  const admin = await asAdmin();
  const inst = await makeInstance();

  for (const quantity of [0, -5, 'abc', null]) {
    const res = await post('/api/v1/orders', admin).send(orderFor(inst, { quantity }));
    assert.strictEqual(res.status, STATUS.VALIDATION, `quantity ${JSON.stringify(quantity)} -> ${res.status}`);
  }
  assert.strictEqual(broker.countOf('placesmartorder'), 0);
});

test('action must be BUY or SELL, and is not guessed from anything else', async () => {
  const admin = await asAdmin();
  const inst = await makeInstance();

  for (const action of ['LONG', 'b', '', 'BUYSELL']) {
    const res = await post('/api/v1/orders', admin).send(orderFor(inst, { action }));
    assert.strictEqual(res.status, STATUS.VALIDATION, `action '${action}' -> ${res.status}`);
  }
  assert.strictEqual(broker.countOf('placesmartorder'), 0);
});

test('an index symbol cannot be traded directly', async () => {
  const admin = await asAdmin();
  const inst = await makeInstance();

  for (const exchange of ['NSE_INDEX', 'BSE_INDEX']) {
    const res = await post('/api/v1/orders', admin).send(orderFor(inst, { exchange, symbol: 'NIFTY' }));
    assert.strictEqual(res.status, STATUS.VALIDATION, `${exchange} must be refused`);
  }
  assert.strictEqual(broker.countOf('placesmartorder'), 0);
});

test('a short position is expressible - position_size is signed', async () => {
  const admin = await asAdmin();
  const inst = await realInstance(CRYPTO);

  const res = await post('/api/v1/orders', admin)
    .send(btc(inst, { action: 'SELL', position_size: -1 }));

  assert.strictEqual(res.status, STATUS.CREATED, JSON.stringify(res.body));
  assert.strictEqual(broker.countOf('placesmartorder'), 1);
});

// ---------------------------------------------------------------------------
// Instance gating
// ---------------------------------------------------------------------------

test('an unknown instance is a 404 and sends nothing', async () => {
  const admin = await asAdmin();
  const res = await post('/api/v1/orders', admin).send(orderFor({ id: 999999 }));
  assert.strictEqual(res.status, STATUS.NOT_FOUND);
  assert.strictEqual(broker.countOf('placesmartorder'), 0);
});

test('an inactive instance does not receive orders', async () => {
  const admin = await asAdmin();
  const inst = await makeInstance({ is_active: 0 });

  const res = await post('/api/v1/orders', admin).send(orderFor(inst));
  assert.strictEqual(res.status, STATUS.VALIDATION);
  assert.strictEqual(broker.countOf('placesmartorder'), 0, 'a deactivated instance is deactivated for orders too');
});

// ---------------------------------------------------------------------------
// The order that is actually sent
// ---------------------------------------------------------------------------

test('a placed order reaches the broker with the fields it was given', async () => {
  const admin = await asAdmin();
  const inst = await realInstance(CRYPTO);

  const res = await post('/api/v1/orders', admin).send(btc(inst, { quantity: 2, position_size: 2 }));
  assert.strictEqual(res.status, STATUS.CREATED, JSON.stringify(res.body));

  const [sent] = broker.callsTo('placesmartorder');
  assert.ok(sent, 'the order must actually have been sent');
  assert.strictEqual(sent.data.symbol, 'BTCUSDFUT');
  assert.strictEqual(sent.data.exchange, 'CRYPTO');
  assert.strictEqual(sent.data.action, 'BUY');
  assert.strictEqual(Number(sent.data.quantity), 2);
});

test('the instance multiplier scales quantity and position size together', async () => {
  // Scaling one without the other tells placesmartorder to reach a target that does not match
  // the quantity sent - the broker reconciles against position_size, so a mismatch silently
  // trades a different size than intended.
  const admin = await asAdmin();
  const inst = await realInstance(CRYPTO, { multiplier: 3 });

  await post('/api/v1/orders', admin).send(btc(inst, { quantity: 1, position_size: 1 }));

  const [sent] = broker.callsTo('placesmartorder');
  assert.strictEqual(Number(sent.data.quantity), 3);
  assert.strictEqual(Number(sent.data.position_size), 3);
});

test('a caller-specified LIMIT price is sent as a LIMIT, never rewritten to MARKET', async () => {
  // Rewriting a resting order into an immediate fill is the worst failure an order router has:
  // the operator placed an order to rest at a price and got filled at whatever the market was.
  const admin = await asAdmin();
  const inst = await realInstance(CRYPTO);
  const price = 10000.5; // far below the market, so it rests and is cancelled after the test

  await post('/api/v1/orders', admin)
    .send(btc(inst, { pricetype: 'LIMIT', price }));

  // A resting order is a plain placeorder - as a smart order the analyzer filled it on the spot.
  const [sent] = broker.callsTo('placeorder');
  assert.strictEqual(broker.countOf('placesmartorder'), 0);
  assert.strictEqual(sent.data.pricetype, 'LIMIT', 'the caller chose LIMIT and it must stay LIMIT');
  assert.strictEqual(Number(sent.data.price), price, 'the chosen price must survive intact');
});

test('a stop order keeps its trigger price', async () => {
  const admin = await asAdmin();
  const inst = await realInstance(CRYPTO);

  await post('/api/v1/orders', admin)
    .send(btc(inst, { pricetype: 'SL', price: 10000, trigger_price: 10005 }));

  const [sent] = broker.callsTo('placeorder');
  assert.strictEqual(sent.data.pricetype, 'SL');
  assert.strictEqual(Number(sent.data.trigger_price), 10005);
});

// ---------------------------------------------------------------------------
// Broker failure
// ---------------------------------------------------------------------------

test("a broker rejection is reported as an upstream failure, not as this app's own error", async () => {
  const admin = await asAdmin();
  const inst = await realInstance(CRYPTO);

  // A contract the broker does not list: a genuine rejection.
  const res = await post('/api/v1/orders', admin).send(btc(inst, { symbol: 'NOSUCHCONTRACTFUT' }));

  assert.notStrictEqual(res.status, STATUS.CREATED, 'a rejected order must not be reported as placed');
  assert.ok(res.status >= 400 && res.status !== STATUS.UNAUTHORIZED, `got ${res.status}`);
  assert.ok(res.body.message, 'the operator needs to see why it was rejected');
});

test("a broker's own 401 does not surface as this app's 401", async () => {
  // api-client.js treats any 401 as a dead session and wipes the stored token, so passing an
  // upstream auth failure through logs the operator out of the dashboard mid-trade.
  const admin = await asAdmin();
  const real = await realCredentials(CRYPTO);
  const inst = await makeInstance({ host_url: real.host_url, api_key: 'not-a-valid-openalgo-key', broker: real.broker });

  const res = await post('/api/v1/orders', admin).send(btc(inst));
  assert.ok(res.status >= 400, `a refused key cannot place an order, got ${res.status}`);
  assert.notStrictEqual(res.status, STATUS.UNAUTHORIZED, 'an upstream 401 must not be echoed as ours');
});

// ---------------------------------------------------------------------------
// Idempotency - the guard against a double-click becoming two live trades
// ---------------------------------------------------------------------------

test('replaying a request_id returns the first answer without sending a second order', async () => {
  const admin = await asAdmin();
  const inst = await realInstance(CRYPTO);
  const payload = btc(inst, { request_id: 'req-double-click-1' });

  const first = await post('/api/v1/orders', admin).send(payload);
  assert.strictEqual(first.status, STATUS.CREATED, JSON.stringify(first.body));

  const replay = await post('/api/v1/orders', admin).send(payload);
  assert.strictEqual(replay.headers['x-idempotency-hit'], 'true', 'the replay must be recognised');
  assert.strictEqual(broker.countOf('placesmartorder'), 1, 'a repeated request must not place a second trade');
});

test('reusing a request_id with a different order is refused outright', async () => {
  const admin = await asAdmin();
  const inst = await realInstance(CRYPTO);

  await post('/api/v1/orders', admin).send(btc(inst, { request_id: 'req-reuse-1' }));
  const conflicting = await post('/api/v1/orders', admin)
    .send(btc(inst, { request_id: 'req-reuse-1', quantity: 500, position_size: 500 }));

  assert.strictEqual(conflicting.status, STATUS.CONFLICT);
  assert.strictEqual(broker.countOf('placesmartorder'), 1, 'the second, different order must not be sent');
});

test('an empty request_id is rejected rather than treated as absent', async () => {
  const admin = await asAdmin();
  const inst = await makeInstance();

  for (const request_id of ['', 0, false, 123]) {
    const res = await post('/api/v1/orders', admin).send(orderFor(inst, { request_id }));
    assert.strictEqual(res.status, STATUS.VALIDATION, `request_id ${JSON.stringify(request_id)} -> ${res.status}`);
  }
});

test('reusing the request_id of a failed order replays that failure instead of trading again', async () => {
  // The safe reading of a failed attempt is "we do not know whether the broker saw it". Replaying
  // the recorded outcome is therefore correct, and re-sending would risk a duplicate live trade.
  // A genuine retry is a NEW request_id, which is what the UI generates per attempt.
  const admin = await asAdmin();
  const inst = await realInstance(CRYPTO);
  const rejected = btc(inst, { request_id: 'req-retry-1', symbol: 'NOSUCHCONTRACTFUT' });

  const failed = await post('/api/v1/orders', admin).send(rejected);
  assert.ok(failed.status >= 400, `the first attempt should fail, got ${failed.status}`);

  const sentBefore = broker.countOf('placesmartorder');
  const replay = await post('/api/v1/orders', admin).send(rejected);
  assert.ok(replay.status >= 400, 'the recorded failure must be replayed, not silently retried');
  assert.strictEqual(broker.countOf('placesmartorder'), sentBefore, 'the same request_id must never be sent twice');

  const fresh = await post('/api/v1/orders', admin).send(btc(inst, { request_id: 'req-retry-2' }));
  assert.strictEqual(fresh.status, STATUS.CREATED, 'a NEW request id is how a retry is expressed');
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

test('the order list and the real orderbook answer and never leak a key', async () => {
  const admin = await asAdmin();
  const inst = await realInstance(CRYPTO);

  const list = await get('/api/v1/orders', admin);
  assert.strictEqual(list.status, STATUS.OK);

  const book = await get('/api/v1/orders/orderbook', admin);
  assert.strictEqual(book.status, STATUS.OK, JSON.stringify(book.body).slice(0, 300));
  assert.ok(!JSON.stringify(book.body).includes(inst.api_key), 'the orderbook leaked an api key');
});

test('one dead instance does not take the whole orderbook down', async () => {
  const admin = await asAdmin();
  await realInstance(CRYPTO);
  await makeInstance(); // its broker is unreachable

  const res = await get('/api/v1/orders/orderbook', admin);
  assert.strictEqual(res.status, STATUS.OK, 'the page must still render for the instances that are up');
});

test('an NSE order with no price anywhere is refused - never sent as MARKET (SEBI limit-only)', async () => {
  // SEBI requires retail algo orders on Indian exchanges to be LIMIT orders. With no quote and
  // no depth from the feed or the instance itself there is no limit price, so there is no order:
  // an unpriced MARKET order is the one outcome that must not happen.
  const admin = await asAdmin();
  // Its broker is unreachable, so there is no quote and no depth from anywhere.
  const inst = await makeInstance({ broker: 'kotak' });

  // A symbol no other test has priced: the feed caches quotes across tests in this file.
  const res = await post('/api/v1/orders', admin).send(orderFor(inst, { symbol: 'NEVERQUOTED' }));

  assert.strictEqual(res.status, STATUS.VALIDATION, JSON.stringify(res.body));
  assert.match(res.body.message, /No price available for NSE:NEVERQUOTED/);
  assert.strictEqual(broker.countOf('placesmartorder'), 0, 'nothing may reach the broker');
});

test('an NSE fill-now order is priced as a LIMIT from the live quote', async () => {
  const admin = await asAdmin();
  const inst = await realInstance(KOTAK);

  const res = await post('/api/v1/orders', admin).send(orderFor(inst, { symbol: 'SBIN', quantity: 1, position_size: 1 }));

  // Priced from Kotak's real quote whether or not NSE is open; the broker only accepts it in hours.
  const [sent] = broker.callsTo('placesmartorder').map((c) => c.data);
  assert.ok(sent, `the order must have been priced and sent: ${JSON.stringify(res.body).slice(0, 300)}`);
  assert.strictEqual(sent.pricetype, 'LIMIT');
  assert.ok(Number(sent.price) > 0, 'a LIMIT must carry its price');
  if (nseOpen()) assert.strictEqual(res.status, STATUS.CREATED, JSON.stringify(res.body));
});

test('a crypto order with no price may still go as MARKET - Delta Exchange accepts it', async () => {
  const admin = await asAdmin();
  const inst = await realInstance(CRYPTO);

  const res = await post('/api/v1/orders', admin).send(btc(inst));

  assert.strictEqual(res.status, STATUS.CREATED, JSON.stringify(res.body));
  const [sent] = broker.callsTo('placesmartorder').map((c) => c.data);
  assert.strictEqual(sent.pricetype, 'MARKET');
  assert.strictEqual(String(sent.price), '0', 'MARKET must carry price 0 for OpenAlgo');
});
