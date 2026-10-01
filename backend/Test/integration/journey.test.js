import assert from 'assert';
import test, { before, after, beforeEach, afterEach } from 'node:test';
import request from 'supertest';

import { useTestDb, truncate } from '../helpers/db.js';
import { buildApp } from '../helpers/app.js';
import { asAdmin, bearer } from '../helpers/auth.js';
import {
  watchBroker, realCredentials, copyRealInstruments, netPosition, waitForNet, nseOpen, CRYPTO, KOTAK,
} from '../helpers/real-broker.js';
import { STATUS } from '../helpers/http.js';
import db from '../../src/core/database.js';
import v1Routes from '../../src/routes/v1/index.js';

/**
 * The whole setup journey through the real /api/v1 router, in the order an operator does it:
 * add an instance, create a watchlist, map the instance, add a symbol (with % exits), place a
 * quick order from it, then build a strategy - create, map, add a leg, execute, check status,
 * exit - and tear it all down. Each step is asserted on the response AND on what was stored or
 * sent to the broker, so a step that "succeeds" without doing its job fails here.
 *
 * On the operator's real brokers in analyzer mode: the crypto account (24x7) for the journey,
 * Jz Kotak for the Indian equity/F&O product rules while NSE is open. Every order is closed after
 * its test, and the test fails if anything stays open.
 */

let app;
let broker;

before(async () => {
  await useTestDb('journey');
  app = buildApp(v1Routes, '/api/v1');
  broker = watchBroker();
});
after(() => broker.restore());
beforeEach(async () => {
  await truncate();
  broker.reset();
});
afterEach(async () => {
  const leftovers = await broker.flattenAll();
  assert.deepStrictEqual(leftovers, [], `left open at the broker:\n${leftovers.join('\n')}`);
});

const call = (method, path, user) => bearer(request(app)[method](path), user);

/** Add a real account through the API, the way the operator does. */
async function addInstance(admin, name) {
  const real = await realCredentials(name);
  const res = await call('post', '/api/v1/instances', admin).send({ name: real.name, host_url: real.host_url, api_key: real.api_key });
  assert.strictEqual(res.status, STATUS.CREATED, JSON.stringify(res.body).slice(0, 300));
  return { real, row: await db.get('SELECT * FROM instances WHERE id = ?', [res.body.data.id]), body: res.body };
}

test('instance -> watchlist -> mapping -> symbol -> quick order -> strategy lifecycle -> teardown', async () => {
  const admin = await asAdmin();
  await copyRealInstruments("exchange = 'CRYPTO' AND symbol = 'BTCUSDFUT'");

  // 1. Add an instance - the broker is detected from its real ping.
  const { real, row: account, body } = await addInstance(admin, CRYPTO);
  const instanceId = account.id;
  assert.strictEqual(body.data.broker, real.broker);
  assert.ok(!JSON.stringify(body).includes(real.api_key), 'the api key is never echoed back in full');

  // 2. Create a watchlist.
  const wl = await call('post', '/api/v1/watchlists', admin).send({ name: 'Journey crypto' });
  assert.strictEqual(wl.status, STATUS.CREATED, JSON.stringify(wl.body));
  const watchlistId = wl.body.data.id;

  // 3. Map the instance to it.
  const map = await call('post', `/api/v1/watchlists/${watchlistId}/instances`, admin).send({ instanceId });
  assert.ok(map.status < 300, JSON.stringify(map.body));
  const linked = await db.all('SELECT instance_id FROM watchlist_instances WHERE watchlist_id = ?', [watchlistId]);
  assert.deepStrictEqual(linked.map((r) => r.instance_id), [instanceId]);

  // 4. Add a symbol, with futures exits in PERCENT; then switch them to POINTS.
  const sym = await call('post', `/api/v1/watchlists/${watchlistId}/symbols`, admin).send({
    exchange: 'CRYPTO', symbol: 'BTCUSDFUT', symbol_type: 'FUTURES', lot_size: 1,
    underlying_symbol: 'BTC', tradable_futures: true, qty_type: 'LOTS', qty_value: 1, product_type: 'NRML',
    exit_unit_futures: 'PERCENT', target_points_futures: 40, stoploss_points_futures: 30,
  });
  assert.strictEqual(sym.status, STATUS.CREATED, JSON.stringify(sym.body));
  const symbolId = sym.body.data.id;
  assert.strictEqual(sym.body.data.exit_unit_futures, 'PERCENT');
  assert.strictEqual(sym.body.data.target_points_futures, 40);

  const edit = await call('put', `/api/v1/watchlists/${watchlistId}/symbols/${symbolId}`, admin)
    .send({ exit_unit_futures: 'POINTS', target_points_futures: 30000 });
  assert.strictEqual(edit.status, STATUS.OK, JSON.stringify(edit.body));
  const stored = await db.get('SELECT exit_unit_futures, target_points_futures, stoploss_points_futures FROM watchlist_symbols WHERE id = ?', [symbolId]);
  assert.deepStrictEqual({ ...stored }, { exit_unit_futures: 'POINTS', target_points_futures: 30000, stoploss_points_futures: 30 },
    'a partial edit changes only what it names');

  const listed = await call('get', `/api/v1/watchlists/${watchlistId}/symbols`, admin);
  assert.strictEqual(listed.body.data[0].is_expired, false);

  // 5. Quick order from the watchlist row: one lot to the mapped instance, then EXIT.
  const before = await netPosition(account, 'BTCUSDFUT');
  const qo = await call('post', '/api/v1/quickorders', admin).send({ symbolId, action: 'BUY', tradeMode: 'FUTURES', quantity: 1, product: 'NRML' });
  assert.ok(qo.status < 300 && qo.body.data?.summary?.failed === 0, JSON.stringify(qo.body).slice(0, 400));
  const [placed] = broker.callsTo('placesmartorder').map((c) => c.data);
  assert.ok(placed, 'the quick order reached the broker');
  assert.strictEqual(placed.symbol, 'BTCUSDFUT');
  assert.strictEqual(placed.pricetype, 'MARKET', 'crypto takes MARKET unless a price is given');
  assert.strictEqual(Number(placed.quantity), 1);
  assert.strictEqual(await waitForNet(account, 'BTCUSDFUT', before + 1), before + 1, 'the broker holds it');

  const qx = await call('post', '/api/v1/quickorders', admin).send({ symbolId, action: 'EXIT', tradeMode: 'FUTURES', quantity: 1, product: 'NRML' });
  assert.ok(qx.status < 300 && qx.body.data?.summary?.failed === 0, JSON.stringify(qx.body).slice(0, 400));
  assert.strictEqual(await waitForNet(account, 'BTCUSDFUT', 0), 0, 'EXIT flattened it');

  // 6. Strategy: its own strategy-type watchlist, mapped, one futures leg with % exits.
  const sw = await call('post', '/api/v1/watchlists', admin).send({ name: 'Journey strategies', type: 'strategy' });
  assert.strictEqual(sw.status, STATUS.CREATED, JSON.stringify(sw.body));
  await call('post', `/api/v1/watchlists/${sw.body.data.id}/instances`, admin).send({ instanceId });
  const st = await call('post', '/api/v1/strategies', admin)
    .send({ watchlist_id: sw.body.data.id, name: 'BTC journey', underlying: 'BTC', exchange: 'CRYPTO' });
  assert.strictEqual(st.status, STATUS.CREATED, JSON.stringify(st.body));
  const strategyId = st.body.data.id;
  const leg = await call('post', `/api/v1/strategies/${strategyId}/legs`, admin)
    .send({ action: 'SELL', qty_type: 'LOTS', qty_value: 1, product_type: 'NRML', exit_unit: 'PERCENT', target_points: 40, stoploss_points: 30 });
  assert.ok(leg.status < 300, JSON.stringify(leg.body));

  const exec = await call('post', `/api/v1/strategies/${strategyId}/execute`, admin).send({});
  assert.strictEqual(exec.body.data?.success, true, JSON.stringify(exec.body));
  const basket = broker.callsTo('basketorder').flatMap((c) => c.data.orders);
  assert.deepStrictEqual(basket.map((o) => [o.symbol, o.action]), [['BTCUSDFUT', 'SELL']]);
  // The leg's % exits are carried to the auto-exit row it creates.
  const exitRow = await db.get("SELECT exit_unit_futures, target_points_futures FROM watchlist_symbols WHERE watchlist_id = ? AND symbol = 'BTCUSDFUT'", [sw.body.data.id]);
  assert.deepStrictEqual({ ...exitRow }, { exit_unit_futures: 'PERCENT', target_points_futures: 40 });
  assert.strictEqual(await waitForNet(account, 'BTCUSDFUT', -1), -1, 'the broker holds the short');

  const status = await call('get', `/api/v1/strategies/${strategyId}/status`, admin);
  assert.strictEqual(status.status, STATUS.OK);

  const exit = await call('post', `/api/v1/strategies/${strategyId}/exit`, admin).send({});
  assert.strictEqual(exit.body.data?.success, true, JSON.stringify(exit.body));
  assert.strictEqual(await waitForNet(account, 'BTCUSDFUT', 0), 0, 'the strategy exit flattened it');

  // 7. Teardown in reverse: unmap, delete strategy, watchlists, instance.
  assert.ok((await call('delete', `/api/v1/watchlists/${watchlistId}/instances/${instanceId}`, admin)).status < 300);
  assert.strictEqual((await call('delete', `/api/v1/strategies/${strategyId}`, admin)).status, STATUS.OK);
  assert.strictEqual((await call('delete', `/api/v1/watchlists/${sw.body.data.id}`, admin)).status, STATUS.OK);
  assert.strictEqual((await call('delete', `/api/v1/watchlists/${watchlistId}`, admin)).status, STATUS.OK);
  assert.strictEqual((await db.get('SELECT COUNT(*) AS n FROM watchlist_symbols')).n, 0, 'no orphaned symbol rows');
  // Everything was flat already; the instance is deleted last, after the check above.
  assert.deepStrictEqual(await broker.flattenAll(), []);
  broker.reset();
  assert.strictEqual((await call('delete', `/api/v1/instances/${instanceId}`, admin)).status, STATUS.OK);
});

test('a partial symbol update changes only what it names - disabling a row keeps its contract settings', async () => {
  // strategy exits call updateSymbol(id, { is_enabled: 0 }); that used to reset lot size, product,
  // contract type and tradable flags, and any API edit re-enabled a disabled row.
  // Storage only - no order is sent.
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

test('equity keeps MIS or CNC, F&O keeps MIS or NRML, and an EXIT closes each position in its own product', { skip: !nseOpen() && 'NSE is closed' }, async () => {
  const admin = await asAdmin();
  await copyRealInstruments("exchange = 'NSE' AND symbol = 'SBIN'");
  await copyRealInstruments("exchange = 'NFO' AND name = 'NIFTY' AND instrumenttype = 'FUT'");
  const { row: account } = await addInstance(admin, KOTAK);
  const wl = await call('post', '/api/v1/watchlists', admin).send({ name: 'Equity' });
  await call('post', `/api/v1/watchlists/${wl.body.data.id}/instances`, admin).send({ instanceId: account.id });
  const sbin = await call('post', `/api/v1/watchlists/${wl.body.data.id}/symbols`, admin)
    .send({ exchange: 'NSE', symbol: 'SBIN', symbol_type: 'EQUITY', lot_size: 1, tradable_equity: true, qty_type: 'FIXED', qty_value: 1 });
  const nifty = await db.get("SELECT symbol, lotsize, expiry FROM instruments WHERE exchange = 'NFO' AND name = 'NIFTY' AND instrumenttype = 'FUT' ORDER BY expiry LIMIT 1");
  const fut = await call('post', `/api/v1/watchlists/${wl.body.data.id}/symbols`, admin)
    .send({ exchange: 'NFO', symbol: nifty.symbol, symbol_type: 'FUTURES', lot_size: nifty.lotsize, expiry: nifty.expiry, tradable_futures: true });

  const sent = () => broker.callsTo('placesmartorder').map((c) => c.data.product);
  for (const product of ['MIS', 'CNC']) {
    broker.reset();
    const entry = await call('post', '/api/v1/quickorders', admin).send({ symbolId: sbin.body.data.id, action: 'BUY', tradeMode: 'EQUITY', quantity: 1, product });
    assert.ok(entry.status < 300 && entry.body.data?.success, JSON.stringify(entry.body).slice(0, 400));
    assert.deepStrictEqual(sent(), [product], `a ${product} equity entry must reach the broker as ${product}`);
    assert.ok(await waitForNet(account, 'SBIN', 1) === 1, 'the broker holds it');

    broker.reset();
    const exit = await call('post', '/api/v1/quickorders', admin).send({ symbolId: sbin.body.data.id, action: 'EXIT', tradeMode: 'EQUITY', quantity: 1, product });
    assert.ok(exit.status < 300 && exit.body.data?.success, JSON.stringify(exit.body).slice(0, 400));
    assert.ok(sent().length > 0 && sent().every((p) => p === product), `the ${product} exit went out as ${sent()}`);
    assert.strictEqual(await waitForNet(account, 'SBIN', 0), 0);
  }

  // F&O keeps MIS or NRML as chosen; CNC (delivery) does not exist for derivatives -> NRML.
  const held = new Set();
  for (const [chosen, expected] of [['MIS', 'MIS'], ['NRML', 'NRML'], ['CNC', 'NRML']]) {
    broker.reset();
    const futOrder = await call('post', '/api/v1/quickorders', admin).send({ symbolId: fut.body.data.id, action: 'BUY', tradeMode: 'FUTURES', quantity: 1, product: chosen });
    assert.ok(futOrder.status < 300 && futOrder.body.data?.success, JSON.stringify(futOrder.body).slice(0, 400));
    assert.deepStrictEqual(sent(), [expected], `F&O chosen as ${chosen} must go as ${expected}`);
    held.add(expected);
  }

  // An EXIT closes the symbol in whatever product each part is held - the MIS lot is closed as
  // MIS even though the exit request says NRML (it used to find "no open positions" and leave it).
  broker.reset();
  const exit = await call('post', '/api/v1/quickorders', admin).send({ symbolId: fut.body.data.id, action: 'EXIT', tradeMode: 'FUTURES', quantity: 1, product: 'NRML' });
  assert.ok(exit.status < 300 && exit.body.data?.success, JSON.stringify(exit.body).slice(0, 400));
  assert.deepStrictEqual(new Set(sent()), held, `each product held must be closed in that product, sent ${sent()}`);
  assert.strictEqual(await waitForNet(account, nifty.symbol, 0), 0);
});

test('an exit that cannot reach the positions is reported as FAILED, never as "Closed 0 position(s)" success', async () => {
  const admin = await asAdmin();
  await copyRealInstruments("exchange = 'CRYPTO' AND symbol = 'BTCUSDFUT'");
  // A key the real broker refuses: it cannot read the book, so it cannot know the position is flat.
  const real = await realCredentials(CRYPTO);
  const inst = await call('post', '/api/v1/instances', admin).send({ name: 'Refused key', host_url: real.host_url, api_key: 'not-a-valid-openalgo-key' });
  const instanceId = inst.body.data?.id
    ?? (await db.run('INSERT INTO instances (name, host_url, api_key, broker, is_active) VALUES (?, ?, ?, ?, 1)',
      ['Refused key', real.host_url, 'not-a-valid-openalgo-key', real.broker])).lastID;
  const wl = await call('post', '/api/v1/watchlists', admin).send({ name: 'Reject' });
  await call('post', `/api/v1/watchlists/${wl.body.data.id}/instances`, admin).send({ instanceId });
  const btc = await call('post', `/api/v1/watchlists/${wl.body.data.id}/symbols`, admin)
    .send({ exchange: 'CRYPTO', symbol: 'BTCUSDFUT', symbol_type: 'FUTURES', lot_size: 1, tradable_futures: true });

  const res = await call('post', '/api/v1/quickorders', admin).send({ symbolId: btc.body.data.id, action: 'EXIT', tradeMode: 'FUTURES', quantity: 1, product: 'NRML' });
  const result = res.body.data?.results?.[0];
  assert.strictEqual(result?.success, false, `an exit that could not run must not report success: ${JSON.stringify(res.body).slice(0, 400)}`);
  assert.ok(result?.error, 'and it says why');
});

test('a quick order naming an instance not mapped to the symbol\'s watchlist is refused and sends nothing', async () => {
  const admin = await asAdmin();
  await copyRealInstruments("exchange = 'CRYPTO' AND symbol = 'BTCUSDFUT'");
  const { row } = await addInstance(admin, CRYPTO);
  const wl = await call('post', '/api/v1/watchlists', admin).send({ name: 'Unmapped' });
  const btc = await call('post', `/api/v1/watchlists/${wl.body.data.id}/symbols`, admin)
    .send({ exchange: 'CRYPTO', symbol: 'BTCUSDFUT', symbol_type: 'FUTURES', lot_size: 1, tradable_futures: true });

  const res = await call('post', '/api/v1/quickorders', admin)
    .send({ symbolId: btc.body.data.id, action: 'BUY', tradeMode: 'FUTURES', quantity: 1, product: 'NRML', instanceId: row.id });
  assert.strictEqual(res.status, STATUS.VALIDATION, JSON.stringify(res.body).slice(0, 300));
  assert.match(res.body.message, /not mapped/);
  assert.strictEqual(broker.orders().length, 0);
});
