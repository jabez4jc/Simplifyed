import assert from 'assert';
import test, { before, after, beforeEach } from 'node:test';
import request from 'supertest';

import { useTestDb, truncate } from '../helpers/db.js';
import { buildApp } from '../helpers/app.js';
import { asAdmin, asMonitor, bearer } from '../helpers/auth.js';
import { makeWatchlist, makeInstance, linkInstanceToWatchlist, makeInstrument } from '../helpers/fixtures.js';
import { installFakeOpenAlgo } from '../helpers/fake-openalgo.js';
import { STATUS } from '../helpers/http.js';
import db from '../../src/core/database.js';
import strategyRoutes from '../../src/routes/v1/strategies.js';

/**
 * Every step of a strategy through its real HTTP routes: create on a strategy-type watchlist,
 * read, update, scope instances, add/edit/delete legs (points and percent exits), execute, read
 * status, exit, delete - plus the refusals a user can run into along the way. The broker is the
 * fake from Test/helpers; live execution against real brokers is Test/live.
 */

let app;
let broker;

before(async () => {
  await useTestDb('strategies');
  app = buildApp(strategyRoutes, '/api/v1/strategies');
  broker = installFakeOpenAlgo();
});
after(() => broker.restore());
beforeEach(async () => {
  await truncate();
  broker.reset();
  broker.on('basketorder', (data) => ({
    status: 'success',
    results: (data.orders || []).map((o, i) => ({ symbol: o.symbol, status: 'success', orderid: `BASKET-${i + 1}` })),
  }));
  broker.on('positionbook', { status: 'success', data: [] });
});

const get = (p, u) => bearer(request(app).get(p), u);
const post = (p, u) => bearer(request(app).post(p), u);
const put = (p, u) => bearer(request(app).put(p), u);
const del = (p, u) => bearer(request(app).delete(p), u);

/** A strategy watchlist with two instances, and an MCX future in the instruments cache. */
async function setup() {
  const admin = await asAdmin();
  const wl = await makeWatchlist({ type: 'strategy' });
  const a = await makeInstance({ name: 'Inst A' });
  const b = await makeInstance({ name: 'Inst B' });
  await linkInstanceToWatchlist(wl.id, a.id);
  await linkInstanceToWatchlist(wl.id, b.id);
  await makeInstrument({
    symbol: 'CRUDEOIL19OCT99FUT', exchange: 'MCX', brexchange: 'MCX', name: 'CRUDEOIL', underlying_key: 'CRUDEOIL',
    instrumenttype: 'FUT', lotsize: 100, tick_size: 1, expiry: '19-OCT-99',
  });
  return { admin, wl, a, b };
}

const create = (admin, wl, body = {}) => post('/api/v1/strategies', admin)
  .send({ watchlist_id: wl.id, name: 'Crude trend', underlying: 'CRUDEOIL', exchange: 'MCX', ...body });

test('create: a strategy on a strategy watchlist anchors itself on the nearest live future', async () => {
  const { admin, wl } = await setup();
  const res = await create(admin, wl);
  assert.strictEqual(res.status, STATUS.CREATED, JSON.stringify(res.body));
  assert.strictEqual(res.body.data.name, 'Crude trend');
  const anchor = await db.get('SELECT * FROM watchlist_symbols WHERE watchlist_id = ?', [wl.id]);
  assert.strictEqual(anchor.symbol, 'CRUDEOIL19OCT99FUT', 'anchored on the dated MCX future');
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

  const renamed = await put(`/api/v1/strategies/${s.id}`, admin).send({ name: 'Crude breakout', entry_trigger: 'WEBHOOK' });
  assert.strictEqual(renamed.status, STATUS.OK, JSON.stringify(renamed.body));
  assert.strictEqual(renamed.body.data.name, 'Crude breakout');
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

test('execute -> status -> exit: one LIMIT order per leg per instance, recorded, then closed', async () => {
  const { admin, wl } = await setup();
  const { body: { data: s } } = await create(admin, wl);
  await post(`/api/v1/strategies/${s.id}/legs`, admin).send({ action: 'BUY', qty_type: 'LOTS', qty_value: 1, product_type: 'NRML' });

  const exec = await post(`/api/v1/strategies/${s.id}/execute`, admin).send({});
  assert.strictEqual(exec.status, STATUS.OK, JSON.stringify(exec.body));
  assert.strictEqual(exec.body.data.success, true, JSON.stringify(exec.body.data));
  assert.strictEqual(exec.body.data.instances.length, 2, 'fans out to both watchlist instances');

  const orders = broker.callsTo('basketorder').flatMap((c) => c.data.orders);
  assert.strictEqual(orders.length, 2, 'one leg x two instances');
  for (const o of orders) {
    assert.strictEqual(o.symbol, 'CRUDEOIL19OCT99FUT');
    assert.strictEqual(o.pricetype, 'LIMIT', 'MCX is limit-only (SEBI)');
    assert.strictEqual(Number(o.quantity), 100, 'one lot of 100');
  }

  const status = await get(`/api/v1/strategies/${s.id}/status`, admin);
  assert.strictEqual(status.status, STATUS.OK);
  const ledger = await db.all('SELECT * FROM strategy_leg_executions WHERE strategy_id = ?', [s.id]);
  assert.strictEqual(ledger.length, 2);
  assert.ok(ledger.every((r) => r.entry_status === 'PLACED' && !r.closed_at));

  // The broker now shows the positions, so the exit has something to close.
  broker.on('positionbook', { status: 'success', data: [{ symbol: 'CRUDEOIL19OCT99FUT', exchange: 'MCX', product: 'NRML', quantity: 100, average_price: 6000 }] });
  const exit = await post(`/api/v1/strategies/${s.id}/exit`, admin).send({});
  assert.strictEqual(exit.status, STATUS.OK, JSON.stringify(exit.body));
  assert.strictEqual(exit.body.data.success, true, JSON.stringify(exit.body.data));
  const closed = await db.all('SELECT * FROM strategy_leg_executions WHERE strategy_id = ? AND closed_at IS NOT NULL', [s.id]);
  assert.strictEqual(closed.length, 2, 'both legs recorded as closed');
});

test('execute is refused for a monitor, and a failed leg says why', async () => {
  const { admin, wl } = await setup();
  const { body: { data: s } } = await create(admin, wl);
  await post(`/api/v1/strategies/${s.id}/legs`, admin).send({ action: 'BUY', qty_type: 'LOTS', qty_value: 1, product_type: 'NRML' });
  const monitor = await asMonitor();
  assert.strictEqual((await post(`/api/v1/strategies/${s.id}/execute`, monitor).send({})).status, STATUS.FORBIDDEN);

  broker.on('basketorder', { status: 'error', message: 'MIS orders cannot be placed after square-off time (15:15 IST)' });
  const exec = await post(`/api/v1/strategies/${s.id}/execute`, admin).send({});
  const inst = exec.body.data?.instances?.[0];
  assert.strictEqual(inst?.success, false);
  assert.match(String(inst?.error), /square-off/, 'the broker\'s reason reaches the caller, not "undefined"');
});

test('an expired anchor: listed as expired, and execute is refused with a reason', async () => {
  const { admin, wl } = await setup();
  const { body: { data: s } } = await create(admin, wl);
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
