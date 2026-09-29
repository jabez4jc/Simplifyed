import assert from 'assert';
import test, { before, after, beforeEach } from 'node:test';
import request from 'supertest';

import { useTestDb, truncate } from '../helpers/db.js';
import { buildApp } from '../helpers/app.js';
import { asAdmin, bearer } from '../helpers/auth.js';
import { makeInstrument } from '../helpers/fixtures.js';
import { installFakeOpenAlgo } from '../helpers/fake-openalgo.js';
import { STATUS } from '../helpers/http.js';
import db from '../../src/core/database.js';
import v1Routes from '../../src/routes/v1/index.js';

/**
 * The whole setup journey through the real /api/v1 router, in the order an operator does it:
 * add an instance, create a watchlist, map the instance, add a symbol (with % exits), place a
 * quick order from it, then build a strategy - create, map, add a leg, execute, check status,
 * exit - and tear it all down. Each step is asserted on the response AND on what was stored or
 * sent to the (fake) broker, so a step that "succeeds" without doing its job fails here.
 */

let app;
let broker;

before(async () => {
  await useTestDb('journey');
  app = buildApp(v1Routes, '/api/v1');
  broker = installFakeOpenAlgo();
});
after(() => broker.restore());
beforeEach(async () => {
  await truncate();
  broker.reset();
  broker.on('basketorder', (data) => ({
    status: 'success',
    results: (data.orders || []).map((o, i) => ({ symbol: o.symbol, status: 'success', orderid: `B-${i + 1}` })),
  }));
});

const call = (method, path, user) => bearer(request(app)[method](path), user);

test('instance -> watchlist -> mapping -> symbol -> quick order -> strategy lifecycle -> teardown', async () => {
  const admin = await asAdmin();
  await makeInstrument({
    symbol: 'CRUDEOIL19OCT99FUT', exchange: 'MCX', brexchange: 'MCX', name: 'CRUDEOIL', underlying_key: 'CRUDEOIL',
    instrumenttype: 'FUT', lotsize: 100, tick_size: 1, expiry: '19-OCT-99',
  });

  // 1. Add an instance - the broker is detected from its ping.
  const inst = await call('post', '/api/v1/instances', admin)
    .send({ name: 'Journey broker', host_url: 'http://journey-broker.test', api_key: 'journey-key-123456' });
  assert.strictEqual(inst.status, STATUS.CREATED, JSON.stringify(inst.body));
  const instanceId = inst.body.data.id;
  assert.strictEqual(inst.body.data.broker, 'zerodha');
  assert.notStrictEqual(inst.body.data.api_key, 'journey-key-123456', 'the api key is never echoed back in full');

  // 2. Create a watchlist.
  const wl = await call('post', '/api/v1/watchlists', admin).send({ name: 'Journey commodities' });
  assert.strictEqual(wl.status, STATUS.CREATED, JSON.stringify(wl.body));
  const watchlistId = wl.body.data.id;

  // 3. Map the instance to it.
  const map = await call('post', `/api/v1/watchlists/${watchlistId}/instances`, admin).send({ instanceId });
  assert.ok(map.status < 300, JSON.stringify(map.body));
  const linked = await db.all('SELECT instance_id FROM watchlist_instances WHERE watchlist_id = ?', [watchlistId]);
  assert.deepStrictEqual(linked.map((r) => r.instance_id), [instanceId]);

  // 4. Add a symbol, with futures exits in PERCENT; then switch them to POINTS.
  const sym = await call('post', `/api/v1/watchlists/${watchlistId}/symbols`, admin).send({
    exchange: 'MCX', symbol: 'CRUDEOIL19OCT99FUT', symbol_type: 'FUTURES', lot_size: 100, tick_size: 1, expiry: '19-OCT-99',
    underlying_symbol: 'CRUDEOIL', tradable_futures: true, qty_type: 'LOTS', qty_value: 1, product_type: 'NRML',
    exit_unit_futures: 'PERCENT', target_points_futures: 1.5, stoploss_points_futures: 0.75,
  });
  assert.strictEqual(sym.status, STATUS.CREATED, JSON.stringify(sym.body));
  const symbolId = sym.body.data.id;
  assert.strictEqual(sym.body.data.exit_unit_futures, 'PERCENT');
  assert.strictEqual(sym.body.data.target_points_futures, 1.5);

  const edit = await call('put', `/api/v1/watchlists/${watchlistId}/symbols/${symbolId}`, admin)
    .send({ exit_unit_futures: 'POINTS', target_points_futures: 40 });
  assert.strictEqual(edit.status, STATUS.OK, JSON.stringify(edit.body));
  const stored = await db.get('SELECT exit_unit_futures, target_points_futures, stoploss_points_futures FROM watchlist_symbols WHERE id = ?', [symbolId]);
  assert.deepStrictEqual({ ...stored }, { exit_unit_futures: 'POINTS', target_points_futures: 40, stoploss_points_futures: 0.75 },
    'a partial edit changes only what it names');

  const listed = await call('get', `/api/v1/watchlists/${watchlistId}/symbols`, admin);
  assert.strictEqual(listed.body.data[0].is_expired, false);

  // 5. Quick order from the watchlist row: one lot, LIMIT (MCX is limit-only), to the mapped instance.
  const qo = await call('post', '/api/v1/quickorders', admin).send({ symbolId, action: 'BUY', tradeMode: 'FUTURES', quantity: 1, product: 'NRML' });
  assert.ok(qo.status < 300, JSON.stringify(qo.body));
  const [placed] = broker.callsTo('placesmartorder').map((c) => c.data);
  assert.ok(placed, 'the quick order reached the broker');
  assert.strictEqual(placed.symbol, 'CRUDEOIL19OCT99FUT');
  assert.strictEqual(placed.pricetype, 'LIMIT');
  assert.strictEqual(Number(placed.quantity), 100);

  // 6. Strategy: its own strategy-type watchlist, mapped, one futures leg with % exits.
  const sw = await call('post', '/api/v1/watchlists', admin).send({ name: 'Journey strategies', type: 'strategy' });
  assert.strictEqual(sw.status, STATUS.CREATED, JSON.stringify(sw.body));
  await call('post', `/api/v1/watchlists/${sw.body.data.id}/instances`, admin).send({ instanceId });
  const st = await call('post', '/api/v1/strategies', admin)
    .send({ watchlist_id: sw.body.data.id, name: 'Crude journey', underlying: 'CRUDEOIL', exchange: 'MCX' });
  assert.strictEqual(st.status, STATUS.CREATED, JSON.stringify(st.body));
  const strategyId = st.body.data.id;
  const leg = await call('post', `/api/v1/strategies/${strategyId}/legs`, admin)
    .send({ action: 'SELL', qty_type: 'LOTS', qty_value: 1, product_type: 'NRML', exit_unit: 'PERCENT', target_points: 2, stoploss_points: 1 });
  assert.ok(leg.status < 300, JSON.stringify(leg.body));

  const exec = await call('post', `/api/v1/strategies/${strategyId}/execute`, admin).send({});
  assert.strictEqual(exec.body.data?.success, true, JSON.stringify(exec.body));
  const basket = broker.callsTo('basketorder').flatMap((c) => c.data.orders);
  assert.deepStrictEqual(basket.map((o) => [o.symbol, o.action, o.pricetype]), [['CRUDEOIL19OCT99FUT', 'SELL', 'LIMIT']]);
  // The leg's % exits are carried to the auto-exit row it creates.
  const exitRow = await db.get("SELECT exit_unit_futures, target_points_futures FROM watchlist_symbols WHERE watchlist_id = ? AND symbol = 'CRUDEOIL19OCT99FUT'", [sw.body.data.id]);
  assert.deepStrictEqual({ ...exitRow }, { exit_unit_futures: 'PERCENT', target_points_futures: 2 });

  const status = await call('get', `/api/v1/strategies/${strategyId}/status`, admin);
  assert.strictEqual(status.status, STATUS.OK);

  broker.on('positionbook', { status: 'success', data: [{ symbol: 'CRUDEOIL19OCT99FUT', exchange: 'MCX', product: 'NRML', quantity: -100, average_price: 6000 }] });
  const exit = await call('post', `/api/v1/strategies/${strategyId}/exit`, admin).send({});
  assert.strictEqual(exit.body.data?.success, true, JSON.stringify(exit.body));

  // 7. Teardown in reverse: unmap, delete strategy, watchlists, instance.
  assert.ok((await call('delete', `/api/v1/watchlists/${watchlistId}/instances/${instanceId}`, admin)).status < 300);
  assert.strictEqual((await call('delete', `/api/v1/strategies/${strategyId}`, admin)).status, STATUS.OK);
  assert.strictEqual((await call('delete', `/api/v1/watchlists/${sw.body.data.id}`, admin)).status, STATUS.OK);
  assert.strictEqual((await call('delete', `/api/v1/watchlists/${watchlistId}`, admin)).status, STATUS.OK);
  assert.strictEqual((await call('delete', `/api/v1/instances/${instanceId}`, admin)).status, STATUS.OK);
  assert.strictEqual((await db.get('SELECT COUNT(*) AS n FROM watchlist_symbols')).n, 0, 'no orphaned symbol rows');
});

test('a partial symbol update changes only what it names - disabling a row keeps its contract settings', async () => {
  // strategy exits call updateSymbol(id, { is_enabled: 0 }); that used to reset lot size, product,
  // contract type and tradable flags, and any API edit re-enabled a disabled row.
  const admin = await asAdmin();
  const wl = await call('post', '/api/v1/watchlists', admin).send({ name: 'Partial' });
  const sym = await call('post', `/api/v1/watchlists/${wl.body.data.id}/symbols`, admin).send({
    exchange: 'NFO', symbol: 'NIFTY27OCT99FUT', symbol_type: 'FUTURES', lot_size: 65, product_type: 'NRML',
    tradable_futures: true, tradable_options: true, stoploss_points_futures: 20,
  });
  const id = sym.body.data.id;
  const { default: watchlistSymbolService } = await import('../../src/services/watchlist-symbol.service.js');
  await watchlistSymbolService.updateSymbol(id, { is_enabled: 0 });
  const row = await db.get('SELECT * FROM watchlist_symbols WHERE id = ?', [id]);
  assert.deepStrictEqual(
    [row.is_enabled, row.lot_size, row.product_type, row.symbol_type, row.tradable_futures, row.tradable_options, row.stoploss_points_futures],
    [0, 65, 'NRML', 'FUTURES', 1, 1, 20]
  );
  await call('put', `/api/v1/watchlists/${wl.body.data.id}/symbols/${id}`, admin).send({ target_points_futures: 30 });
  const after = await db.get('SELECT is_enabled, stoploss_points_futures, target_points_futures FROM watchlist_symbols WHERE id = ?', [id]);
  assert.deepStrictEqual({ ...after }, { is_enabled: 0, stoploss_points_futures: 20, target_points_futures: 30 }, 'an edit does not re-enable or clear anything');
});

test('equity keeps MIS or CNC, F&O keeps MIS or NRML, and an EXIT closes each position in its own product', async () => {
  const admin = await asAdmin();
  const inst = await call('post', '/api/v1/instances', admin).send({ name: 'Equity broker', host_url: 'http://equity-broker.test', api_key: 'equity-key-123456' });
  const wl = await call('post', '/api/v1/watchlists', admin).send({ name: 'Equity' });
  await call('post', `/api/v1/watchlists/${wl.body.data.id}/instances`, admin).send({ instanceId: inst.body.data.id });
  const sbin = await call('post', `/api/v1/watchlists/${wl.body.data.id}/symbols`, admin)
    .send({ exchange: 'NSE', symbol: 'SBIN', symbol_type: 'EQUITY', lot_size: 1, tradable_equity: true, qty_type: 'FIXED', qty_value: 1 });
  const fut = await call('post', `/api/v1/watchlists/${wl.body.data.id}/symbols`, admin)
    .send({ exchange: 'NFO', symbol: 'NIFTY27OCT99FUT', symbol_type: 'FUTURES', lot_size: 65, tradable_futures: true });

  const sentProducts = () => broker.callsTo('placesmartorder').map((c) => c.data.product);
  for (const product of ['MIS', 'CNC']) {
    broker.reset();
    const entry = await call('post', '/api/v1/quickorders', admin).send({ symbolId: sbin.body.data.id, action: 'BUY', tradeMode: 'EQUITY', quantity: 1, product });
    assert.ok(entry.status < 300 && entry.body.data?.success, JSON.stringify(entry.body));
    assert.deepStrictEqual(sentProducts(), [product], `a ${product} equity entry must reach the broker as ${product}`);

    broker.reset();
    broker.on('positionbook', { status: 'success', data: [{ symbol: 'SBIN', exchange: 'NSE', product, quantity: 1, average_price: 800 }] });
    const exit = await call('post', '/api/v1/quickorders', admin).send({ symbolId: sbin.body.data.id, action: 'EXIT', tradeMode: 'EQUITY', quantity: 1, product });
    assert.ok(exit.status < 300 && exit.body.data?.success, JSON.stringify(exit.body));
    assert.ok(sentProducts().length > 0 && sentProducts().every((p) => p === product), `the ${product} exit went out as ${sentProducts()}`);
    broker.on('positionbook', { status: 'success', data: [] });
  }

  // F&O keeps MIS or NRML as chosen; CNC (delivery) does not exist for derivatives -> NRML.
  for (const [chosen, expected] of [['MIS', 'MIS'], ['NRML', 'NRML'], ['CNC', 'NRML']]) {
    broker.reset();
    broker.on('positionbook', { status: 'success', data: [] });
    const futOrder = await call('post', '/api/v1/quickorders', admin).send({ symbolId: fut.body.data.id, action: 'BUY', tradeMode: 'FUTURES', quantity: 1, product: chosen });
    assert.ok(futOrder.status < 300 && futOrder.body.data?.success, JSON.stringify(futOrder.body));
    assert.deepStrictEqual(sentProducts(), [expected], `F&O chosen as ${chosen} must go as ${expected}`);
  }

  // An EXIT closes the symbol in whatever product it is held - an MIS future is closed as MIS
  // even when the exit request says NRML (it used to find "no open positions" and leave it).
  broker.reset();
  broker.on('positionbook', { status: 'success', data: [{ symbol: 'NIFTY27OCT99FUT', exchange: 'NFO', product: 'MIS', quantity: 65, average_price: 25000 }] });
  const exit = await call('post', '/api/v1/quickorders', admin).send({ symbolId: fut.body.data.id, action: 'EXIT', tradeMode: 'FUTURES', quantity: 1, product: 'NRML' });
  assert.ok(exit.status < 300 && exit.body.data?.success, JSON.stringify(exit.body).slice(0, 400));
  assert.ok(sentProducts().length > 0 && sentProducts().every((p) => p === 'MIS'), `the MIS position must be closed as MIS, sent ${sentProducts()}`);
});

test('an exit the broker rejects is reported as FAILED, never as "Closed 0 position(s)" success', async () => {
  const admin = await asAdmin();
  const inst = await call('post', '/api/v1/instances', admin).send({ name: 'Reject broker', host_url: 'http://reject-broker.test', api_key: 'reject-key-123456' });
  const wl = await call('post', '/api/v1/watchlists', admin).send({ name: 'Reject' });
  await call('post', `/api/v1/watchlists/${wl.body.data.id}/instances`, admin).send({ instanceId: inst.body.data.id });
  const sbin = await call('post', `/api/v1/watchlists/${wl.body.data.id}/symbols`, admin)
    .send({ exchange: 'NSE', symbol: 'SBIN', symbol_type: 'EQUITY', lot_size: 1, tradable_equity: true });
  broker.on('positionbook', { status: 'success', data: [{ symbol: 'SBIN', exchange: 'NSE', product: 'CNC', quantity: 5, average_price: 800 }] });
  broker.fail('placesmartorder', 'RMS: exit rejected', 400);

  const res = await call('post', '/api/v1/quickorders', admin).send({ symbolId: sbin.body.data.id, action: 'EXIT', tradeMode: 'EQUITY', quantity: 1, product: 'CNC' });
  const result = res.body.data?.results?.[0];
  assert.strictEqual(result?.success, false, `a rejected exit must not report success: ${JSON.stringify(res.body).slice(0, 400)}`);
  assert.match(String(result?.error), /exit rejected/, 'and it says why');
});
