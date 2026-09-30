import assert from 'assert';
import test, { before, after, beforeEach, afterEach } from 'node:test';
import request from 'supertest';

import { useTestDb, truncate } from '../helpers/db.js';
import { buildApp } from '../helpers/app.js';
import { asAdmin, bearer } from '../helpers/auth.js';
import { watchBroker, realInstance, copyRealInstruments, netPosition, waitForNet, CRYPTO } from '../helpers/real-broker.js';
import { makeWatchlist, linkInstanceToWatchlist } from '../helpers/fixtures.js';
import db from '../../src/core/database.js';
import v1Routes from '../../src/routes/v1/index.js';

/**
 * Option orders on both sides, through both routes the screens use, on the real Jabez Crypto
 * analyzer account (BTC options trade 24x7):
 *   - POST /quickorders - the watchlist's option buttons and the chart's CE/PE tickets;
 *   - POST /orders      - the chart's limit/stop tickets and its option-contract panes.
 * The product chosen on screen must be the product the broker receives. The chart used to send
 * none on the quick-order path, so every chart option order went as MIS.
 */

let app;
let broker;
let admin;
let inst;
let symbolId;
let watchlistId;

before(async () => {
  await useTestDb('options-orders');
  app = buildApp(v1Routes, '/api/v1');
  broker = watchBroker();
});
after(() => broker.restore());

beforeEach(async () => {
  await truncate();
  broker.reset();
  await copyRealInstruments("exchange = 'CRYPTO' AND (symbol = 'BTCUSDFUT' OR (symbol LIKE 'BTC%' AND instrumenttype IN ('CE', 'PE', 'OPTIDX', 'OPTFUT')))");
  admin = await asAdmin();
  inst = await realInstance(CRYPTO);
  const wl = await makeWatchlist({ name: 'Options both sides' });
  watchlistId = wl.id;
  await linkInstanceToWatchlist(wl.id, inst.id);
  const res = await bearer(request(app).post(`/api/v1/watchlists/${wl.id}/symbols`), admin).send({
    exchange: 'CRYPTO', symbol: 'BTCUSDFUT', symbol_type: 'FUTURES', lot_size: 1, underlying_symbol: 'BTC',
    tradable_futures: true, tradable_options: true, qty_type: 'LOTS', qty_value: 1,
  });
  assert.ok(res.status < 300, JSON.stringify(res.body).slice(0, 300));
  symbolId = res.body.data.id;
});

afterEach(async () => {
  const leftovers = await broker.flattenAll();
  assert.deepStrictEqual(leftovers, [], `left open at the broker:\n${leftovers.join('\n')}`);
});

const quick = (body) => bearer(request(app).post('/api/v1/quickorders'), admin)
  .send({ symbolId, tradeMode: 'OPTIONS', optionsLeg: 'ATM', quantity: 1, ...body });

for (const type of ['CE', 'PE']) {
  test(`${type}: BUY with NRML reaches the broker as NRML on the ${type} side, and CLOSE flattens it`, async () => {
    const buy = await quick({ action: `BUY_${type}`, product: 'NRML' });
    assert.ok(buy.status < 300 && buy.body.data?.summary?.failed === 0, JSON.stringify(buy.body).slice(0, 500));

    const [sent] = broker.callsTo('placesmartorder').map((c) => c.data);
    assert.ok(sent, 'the order reached the broker');
    assert.ok(sent.symbol.endsWith(type), `${sent.symbol} is not a ${type}`);
    assert.strictEqual(sent.product, 'NRML', 'the product chosen is the product sent');
    assert.strictEqual(sent.action, 'BUY');
    assert.strictEqual(await waitForNet(inst, sent.symbol, 1), 1, 'the broker holds the option');

    broker.reset();
    const close = await quick({ action: `CLOSE_ALL_${type}`, product: 'MIS' });
    assert.ok(close.status < 300 && close.body.data?.summary?.failed === 0, JSON.stringify(close.body).slice(0, 500));
    const [closing] = broker.callsTo('placesmartorder').map((c) => c.data);
    assert.strictEqual(closing.product, 'NRML', 'a close trades in the held position\'s product, not the button');
    assert.strictEqual(await waitForNet(inst, sent.symbol, 0), 0, 'closed');
  });
}

test('CNC on an option becomes NRML on both routes - F&O has no delivery product', async () => {
  const buy = await quick({ action: 'BUY_CE', product: 'CNC' });
  assert.ok(buy.status < 300 && buy.body.data?.summary?.failed === 0, JSON.stringify(buy.body).slice(0, 500));
  const [sent] = broker.callsTo('placesmartorder').map((c) => c.data);
  assert.strictEqual(sent.product, 'NRML');
  assert.strictEqual(await waitForNet(inst, sent.symbol, 1), 1);

  // The chart's option-contract pane: /orders with the contract itself, no position_size - the
  // server works out this instance's own target from its own position.
  broker.reset();
  const held = await netPosition(inst, sent.symbol);
  const more = await bearer(request(app).post('/api/v1/orders'), admin).send({
    instanceId: inst.id, watchlistId, exchange: 'CRYPTO', symbol: sent.symbol,
    action: 'BUY', quantity: 1, product: 'CNC', pricetype: 'MARKET', trigger_type: 'CHART',
  });
  assert.ok(more.status < 300, JSON.stringify(more.body).slice(0, 500));
  const [viaOrders] = broker.callsTo('placesmartorder').map((c) => c.data);
  assert.strictEqual(viaOrders.product, 'NRML');
  assert.strictEqual(Number(viaOrders.position_size), held + 1, 'target = this instance\'s own position + 1');
  assert.strictEqual(await waitForNet(inst, sent.symbol, held + 1), held + 1);
});
