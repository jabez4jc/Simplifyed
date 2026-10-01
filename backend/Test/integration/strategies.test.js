import assert from 'assert';
import test, { before, after, beforeEach, afterEach } from 'node:test';
import request from 'supertest';

import { useTestDb, truncate } from '../helpers/db.js';
import { buildApp } from '../helpers/app.js';
import { asAdmin, asMonitor, bearer } from '../helpers/auth.js';
import { makeWatchlist, makeInstance, linkInstanceToWatchlist } from '../helpers/fixtures.js';
import {
  watchBroker, realInstance, realCredentials, copyRealInstruments, netPosition, waitForNet, mcxOpen, CRYPTO, KOTAK, FYERS,
} from '../helpers/real-broker.js';
import { STATUS } from '../helpers/http.js';
import db from '../../src/core/database.js';
import strategyRoutes from '../../src/routes/v1/strategies.js';
import quickOrderService from '../../src/services/quick-order.service.js';
import openalgoClient from '../../src/integrations/openalgo/client.js';

/**
 * Every step of a strategy through its real HTTP routes: create on a strategy-type watchlist,
 * read, update, scope instances, add/edit/delete legs (points and percent exits), execute, read
 * status, exit, delete - plus the refusals a user can run into along the way.
 *
 * On the operator's real brokers, in analyzer mode: BTC on Jabez Crypto (24x7) for every step,
 * and an MCX fan-out across Jz Kotak and Jz Fyers while MCX is open. Every order is closed after
 * its test, and the test fails if anything stays open.
 */

let app;
let broker;

before(async () => {
  await useTestDb('strategies');
  app = buildApp(strategyRoutes, '/api/v1/strategies');
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

const get = (p, u) => bearer(request(app).get(p), u);
const post = (p, u) => bearer(request(app).post(p), u);
const put = (p, u) => bearer(request(app).put(p), u);
const del = (p, u) => bearer(request(app).delete(p), u);

/** A strategy watchlist on the real crypto account, with the real BTC contracts cached. */
async function setup() {
  const admin = await asAdmin();
  const wl = await makeWatchlist({ type: 'strategy' });
  const a = await realInstance(CRYPTO);
  await linkInstanceToWatchlist(wl.id, a.id);
  await copyRealInstruments("exchange = 'CRYPTO' AND symbol = 'BTCUSDFUT'");
  return { admin, wl, a };
}

const create = (admin, wl, body = {}) => post('/api/v1/strategies', admin)
  .send({ watchlist_id: wl.id, name: 'BTC trend', underlying: 'BTC', exchange: 'CRYPTO', ...body });

test('create: a strategy on a strategy watchlist anchors itself on the nearest live future', async () => {
  const { admin, wl } = await setup();
  const res = await create(admin, wl);
  assert.strictEqual(res.status, STATUS.CREATED, JSON.stringify(res.body));
  assert.strictEqual(res.body.data.name, 'BTC trend');
  const anchor = await db.get('SELECT * FROM watchlist_symbols WHERE watchlist_id = ?', [wl.id]);
  assert.strictEqual(anchor.symbol, 'BTCUSDFUT', 'anchored on the BTC perpetual');
  assert.strictEqual(res.body.data.broker_tag, `strategy-${res.body.data.id}`, 'a default broker tag is assigned');
});

test('create: refused on a standard watchlist, without a name, and for a monitor', async () => {
  const { admin, wl } = await setup();
  const standard = await makeWatchlist({ type: 'standard' });
  assert.strictEqual((await create(admin, standard)).status, STATUS.VALIDATION);
  assert.strictEqual((await create(admin, wl, { name: '' })).status, STATUS.VALIDATION);
  const monitor = await asMonitor();
  assert.strictEqual((await create(monitor, wl)).status, STATUS.FORBIDDEN);
});

test('read and update: list, fetch with legs, rename, switch to a webhook trigger (gets a slug)', async () => {
  const { admin, wl } = await setup();
  const { body: { data: s } } = await create(admin, wl);

  const list = await get(`/api/v1/strategies?watchlist_id=${wl.id}`, admin);
  assert.strictEqual(list.status, STATUS.OK);
  assert.strictEqual(list.body.count, 1);
  assert.strictEqual(list.body.data[0].anchor_expired, false, 'a live anchor is not flagged expired');

  const renamed = await put(`/api/v1/strategies/${s.id}`, admin).send({ name: 'BTC breakout', entry_trigger: 'WEBHOOK' });
  assert.strictEqual(renamed.status, STATUS.OK, JSON.stringify(renamed.body));
  assert.strictEqual(renamed.body.data.name, 'BTC breakout');
  assert.ok(renamed.body.data.webhook_slug, 'a webhook strategy has a slug');

  const one = await get(`/api/v1/strategies/${s.id}`, admin);
  assert.strictEqual(one.status, STATUS.OK);
  assert.ok(Array.isArray(one.body.data.legs));
});

test('instances: scope a strategy to one instance, list it, then unscope', async () => {
  const { admin, wl, a } = await setup();
  const { body: { data: s } } = await create(admin, wl);
  assert.strictEqual((await post(`/api/v1/strategies/${s.id}/instances`, admin).send({ instanceId: a.id })).status < 300, true);
  const scoped = await get(`/api/v1/strategies/${s.id}/instances`, admin);
  assert.deepStrictEqual(scoped.body.data.map((i) => i.id ?? i.instance_id), [a.id]);
  assert.ok((await del(`/api/v1/strategies/${s.id}/instances/${a.id}`, admin)).status < 300);
  assert.strictEqual((await get(`/api/v1/strategies/${s.id}/instances`, admin)).body.data.length, 0);
});

test('legs: add, edit (points -> percent exits), refuse a duplicate leg tag, delete', async () => {
  const { admin, wl } = await setup();
  const { body: { data: s } } = await create(admin, wl);

  const leg = await post(`/api/v1/strategies/${s.id}/legs`, admin).send({
    action: 'BUY', qty_type: 'LOTS', qty_value: 1, product_type: 'NRML', target_points: 30, stoploss_points: 15, leg_tag: 'long',
  });
  assert.strictEqual(leg.status < 300, true, JSON.stringify(leg.body));
  assert.strictEqual(leg.body.data.exit_unit, 'POINTS', 'points unless told otherwise');

  const edited = await put(`/api/v1/strategies/legs/${leg.body.data.id}`, admin).send({ exit_unit: 'PERCENT', target_points: 1.5, stoploss_points: 0.75 });
  assert.strictEqual(edited.status, STATUS.OK, JSON.stringify(edited.body));
  assert.strictEqual(edited.body.data.exit_unit, 'PERCENT');
  assert.strictEqual(edited.body.data.target_points, 1.5);
  assert.strictEqual(edited.body.data.leg_tag, 'long', 'an edit keeps fields it did not touch');

  const dup = await post(`/api/v1/strategies/${s.id}/legs`, admin).send({ action: 'SELL', qty_type: 'LOTS', qty_value: 1, leg_tag: 'long' });
  assert.strictEqual(dup.status, STATUS.VALIDATION, 'leg tags are unique within a strategy');

  assert.strictEqual((await del(`/api/v1/strategies/legs/${leg.body.data.id}`, admin)).status, STATUS.OK);
  assert.strictEqual((await get(`/api/v1/strategies/${s.id}`, admin)).body.data.legs.length, 0);
});

test('execute -> status -> exit: the leg is placed at the broker, recorded, then closed', async () => {
  const { admin, wl, a } = await setup();
  const { body: { data: s } } = await create(admin, wl);
  await post(`/api/v1/strategies/${s.id}/legs`, admin).send({ action: 'BUY', qty_type: 'LOTS', qty_value: 1, product_type: 'NRML' });
  const before = await netPosition(a, 'BTCUSDFUT');

  const exec = await post(`/api/v1/strategies/${s.id}/execute`, admin).send({});
  assert.strictEqual(exec.status, STATUS.OK, JSON.stringify(exec.body));
  assert.strictEqual(exec.body.data.success, true, JSON.stringify(exec.body.data));

  const orders = broker.callsTo('basketorder').flatMap((c) => c.data.orders);
  assert.strictEqual(orders.length, 1, 'one leg x one instance');
  assert.strictEqual(orders[0].symbol, 'BTCUSDFUT');
  assert.strictEqual(Number(orders[0].quantity), 1, 'one lot');
  // Crypto goes MARKET; a LIMIT off the last quote rested unfilled whenever BTC moved past it.
  assert.strictEqual(orders[0].pricetype, 'MARKET');

  const status = await get(`/api/v1/strategies/${s.id}/status`, admin);
  assert.strictEqual(status.status, STATUS.OK);
  const ledger = await db.all('SELECT * FROM strategy_leg_executions WHERE strategy_id = ?', [s.id]);
  assert.strictEqual(ledger.length, 1);
  assert.ok(ledger.every((r) => r.entry_status === 'PLACED' && !r.closed_at));
  assert.strictEqual(await waitForNet(a, 'BTCUSDFUT', before + 1), before + 1, 'the broker holds the position');

  const exit = await post(`/api/v1/strategies/${s.id}/exit`, admin).send({});
  assert.strictEqual(exit.status, STATUS.OK, JSON.stringify(exit.body));
  assert.strictEqual(exit.body.data.success, true, JSON.stringify(exit.body.data));
  const closed = await db.all('SELECT * FROM strategy_leg_executions WHERE strategy_id = ? AND closed_at IS NOT NULL', [s.id]);
  assert.strictEqual(closed.length, 1, 'the leg is recorded as closed');
  assert.strictEqual(await waitForNet(a, 'BTCUSDFUT', before), before, 'and the broker agrees');
});

test('MCX: one LIMIT order per leg per instance, in each broker\'s lot units', { skip: !mcxOpen() && 'MCX is closed' }, async () => {
  const admin = await asAdmin();
  const wl = await makeWatchlist({ type: 'strategy' });
  const instances = [await realInstance(KOTAK), await realInstance(FYERS)];
  for (const i of instances) await linkInstanceToWatchlist(wl.id, i.id);
  await copyRealInstruments("exchange = 'MCX' AND name = 'CRUDEOIL' AND instrumenttype = 'FUT'");
  const { body: { data: s } } = await post('/api/v1/strategies', admin)
    .send({ watchlist_id: wl.id, name: 'Crude trend', underlying: 'CRUDEOIL', exchange: 'MCX' });
  await post(`/api/v1/strategies/${s.id}/legs`, admin).send({ action: 'BUY', qty_type: 'LOTS', qty_value: 1, product_type: 'NRML' });

  const exec = await post(`/api/v1/strategies/${s.id}/execute`, admin).send({});
  assert.strictEqual(exec.body.data?.success, true, JSON.stringify(exec.body).slice(0, 600));
  const orders = broker.callsTo('basketorder').flatMap((c) => c.data.orders);
  assert.strictEqual(orders.length, 2, 'one leg x two instances');
  for (const o of orders) {
    assert.match(o.symbol, /^CRUDEOIL\d{2}[A-Z]{3}\d{2}FUT$/);
    assert.strictEqual(o.pricetype, 'LIMIT', 'MCX is limit-only (SEBI)');
  }

  const exit = await post(`/api/v1/strategies/${s.id}/exit`, admin).send({});
  assert.strictEqual(exit.body.data?.success, true, JSON.stringify(exit.body).slice(0, 600));
});

test('execute is refused for a monitor, and a failed leg says why', async () => {
  const { admin, wl } = await setup();
  const { body: { data: s } } = await create(admin, wl);
  await post(`/api/v1/strategies/${s.id}/legs`, admin).send({ action: 'BUY', qty_type: 'LOTS', qty_value: 1, product_type: 'NRML' });
  const monitor = await asMonitor();
  assert.strictEqual((await post(`/api/v1/strategies/${s.id}/execute`, monitor).send({})).status, STATUS.FORBIDDEN);

  // Scope the strategy to an account whose key the real broker refuses: a genuine failure.
  const real = await realCredentials(CRYPTO);
  const refused = await makeInstance({ host_url: `${real.host_url}/`, api_key: 'not-a-valid-openalgo-key', broker: real.broker });
  await post(`/api/v1/strategies/${s.id}/instances`, admin).send({ instanceId: refused.id });
  const exec = await post(`/api/v1/strategies/${s.id}/execute`, admin).send({});
  const inst = exec.body.data?.instances?.[0];
  assert.strictEqual(inst?.success, false, JSON.stringify(exec.body).slice(0, 600));
  assert.match(String(inst?.error), /api ?key/i, 'the broker\'s reason reaches the caller, not "undefined"');
});

test('an expired anchor: listed as expired, and execute is refused with a reason', async () => {
  const { admin, wl } = await setup();
  await copyRealInstruments("exchange = 'MCX' AND name = 'CRUDEOIL' AND instrumenttype = 'FUT'");
  const { body: { data: s } } = await create(admin, wl, { underlying: 'CRUDEOIL', exchange: 'MCX' });
  const seeded = await db.get('SELECT auto_roll FROM watchlist_symbols WHERE watchlist_id = ?', [wl.id]);
  assert.strictEqual(seeded.auto_roll, 1, 'an MCX anchor follows the nearest contract, so the next expiry purge rolls it');
  // Until that purge runs, an anchor left on an expired contract is refused, never traded.
  await db.run("UPDATE watchlist_symbols SET symbol = 'CRUDEOIL19AUG26FUT', expiry = '19-AUG-26' WHERE watchlist_id = ?", [wl.id]);
  const list = await get(`/api/v1/strategies?watchlist_id=${wl.id}`, admin);
  assert.strictEqual(list.body.data[0].anchor_expired, true);
  await post(`/api/v1/strategies/${s.id}/legs`, admin).send({ action: 'BUY', qty_type: 'LOTS', qty_value: 1 });
  const exec = await post(`/api/v1/strategies/${s.id}/execute`, admin).send({});
  assert.strictEqual(exec.status, STATUS.VALIDATION);
  assert.match(exec.body.message, /expired/);
  assert.strictEqual(broker.countOf('basketorder'), 0, 'nothing reaches the broker');
});

test('delete: the strategy and its legs are gone; a second delete is a 404', async () => {
  const { admin, wl } = await setup();
  const { body: { data: s } } = await create(admin, wl);
  await post(`/api/v1/strategies/${s.id}/legs`, admin).send({ action: 'BUY', qty_type: 'LOTS', qty_value: 1 });
  assert.strictEqual((await del(`/api/v1/strategies/${s.id}`, admin)).status, STATUS.OK);
  assert.strictEqual((await db.get('SELECT COUNT(*) AS n FROM strategy_legs WHERE strategy_id = ?', [s.id])).n, 0);
  assert.strictEqual((await del(`/api/v1/strategies/${s.id}`, admin)).status, STATUS.NOT_FOUND);
});

// ---------------------------------------------------------------------------
// The execution ledger against what the broker actually holds
// ---------------------------------------------------------------------------

/** A one-leg BUY 1 lot BTC strategy on the real crypto account. */
async function oneLegStrategy() {
  const { admin, wl, a } = await setup();
  const { body: { data: s } } = await create(admin, wl);
  await post(`/api/v1/strategies/${s.id}/legs`, admin).send({ action: 'BUY', qty_type: 'LOTS', qty_value: 1, product_type: 'NRML' });
  return { admin, s, a };
}
const execute = (admin, s, body = {}) => post(`/api/v1/strategies/${s.id}/execute`, admin).send(body);
const exitAll = (admin, s, body = {}) => post(`/api/v1/strategies/${s.id}/exit`, admin).send(body);
const settle = (s) => db.run( // older than the 60s window in which a just-placed leg is trusted as open
  "UPDATE strategy_leg_executions SET opened_at = ? WHERE strategy_id = ?", [new Date(Date.now() - 120000).toISOString(), s.id]);

test('re-entry: a leg still held is skipped; one closed outside the strategy is entered again', async () => {
  const { admin, s, a } = await oneLegStrategy();
  const before = await netPosition(a, 'BTCUSDFUT');
  assert.strictEqual((await execute(admin, s)).body.data.success, true);
  assert.strictEqual(await waitForNet(a, 'BTCUSDFUT', before + 1), before + 1);

  await settle(s);
  const held = await execute(admin, s);
  assert.ok(held.body.data.instances[0].legs.every((l) => l.skipped), 'still held at the broker - skipped');
  assert.strictEqual(broker.countOf('basketorder'), 1);

  // Closed outside the strategy (auto-exit, Positions page) while no order push was heard: the
  // ledger still says open. It used to block every later entry.
  await quickOrderService.closePosition(a, { symbol: 'BTCUSDFUT', exchange: 'CRYPTO' }, { tradeMode: 'EQUITY' });
  assert.strictEqual(await waitForNet(a, 'BTCUSDFUT', before), before);
  const again = await execute(admin, s);
  assert.strictEqual(again.body.data.success, true, JSON.stringify(again.body.data));
  assert.strictEqual(broker.countOf('basketorder'), 2, 'the leg is entered again');
  assert.strictEqual(await waitForNet(a, 'BTCUSDFUT', before + 1), before + 1);
  const rows = await db.all('SELECT closed_at FROM strategy_leg_executions WHERE strategy_id = ? ORDER BY id', [s.id]);
  assert.ok(rows[0].closed_at && !rows[1].closed_at, 'the stale row is reconciled closed; the new one is open');

  assert.strictEqual((await exitAll(admin, s)).body.data.success, true);
  assert.strictEqual(await waitForNet(a, 'BTCUSDFUT', before), before);
});

test('exit: only the strategy\'s own quantity is closed when the contract is also held outside it', async () => {
  const { admin, s, a } = await oneLegStrategy();
  const before = await netPosition(a, 'BTCUSDFUT');
  assert.strictEqual((await execute(admin, s)).body.data.success, true);
  assert.strictEqual(await waitForNet(a, 'BTCUSDFUT', before + 1), before + 1);
  const { product } = await db.get('SELECT product FROM strategy_leg_executions WHERE strategy_id = ?', [s.id]);

  // A manual lot in the same contract and product.
  await openalgoClient.placeSmartOrder(a, {
    strategy: 'manual', symbol: 'BTCUSDFUT', exchange: 'CRYPTO', action: 'BUY', quantity: 1,
    position_size: before + 2, product, pricetype: 'MARKET', price: 0,
  });
  assert.strictEqual(await waitForNet(a, 'BTCUSDFUT', before + 2), before + 2);

  const exit = await exitAll(admin, s);
  assert.strictEqual(exit.body.data.success, true, JSON.stringify(exit.body.data));
  assert.strictEqual(await waitForNet(a, 'BTCUSDFUT', before + 1), before + 1, 'the manual lot stays open');
});

test('exit: a leg is still closed after its instance is switched to order placement off', async () => {
  const { admin, s, a } = await oneLegStrategy();
  const before = await netPosition(a, 'BTCUSDFUT');
  assert.strictEqual((await execute(admin, s)).body.data.success, true);
  assert.strictEqual(await waitForNet(a, 'BTCUSDFUT', before + 1), before + 1);

  await db.run('UPDATE instances SET order_placement_enabled = 0 WHERE id = ?', [a.id]);
  const exit = await exitAll(admin, s);
  assert.strictEqual(exit.status, STATUS.OK, JSON.stringify(exit.body));
  assert.deepStrictEqual(exit.body.data.instances.map((i) => [i.instanceId, i.success]), [[a.id, true]]);
  assert.strictEqual(await waitForNet(a, 'BTCUSDFUT', before), before, 'exit follows the ledger, not the current scope');
});

test('execute: an instanceId outside the strategy\'s targets is refused; a rename to blank is refused', async () => {
  const { admin, s } = await oneLegStrategy();
  const stranger = await makeInstance({ name: 'Not a target' });
  const res = await execute(admin, s, { instanceId: stranger.id });
  assert.strictEqual(res.status, STATUS.VALIDATION, JSON.stringify(res.body));
  assert.strictEqual(broker.countOf('basketorder'), 0);
  assert.strictEqual((await put(`/api/v1/strategies/${s.id}`, admin).send({ name: '  ' })).status, STATUS.VALIDATION);
});
