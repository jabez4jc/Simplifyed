import assert from 'assert';
import test, { before, after, beforeEach } from 'node:test';
import request from 'supertest';

import { useTestDb, truncate } from '../helpers/db.js';
import { buildApp } from '../helpers/app.js';
import { asAdmin, asTrader, asMonitor, withPermissions, withPermissionsExcept, bearer } from '../helpers/auth.js';
import { makeWatchlist, makeWatchlistSymbol, linkInstanceToWatchlist } from '../helpers/fixtures.js';
import { watchBroker, realInstance, CRYPTO } from '../helpers/real-broker.js';
import { STATUS } from '../helpers/http.js';
import db from '../../src/core/database.js';
import watchlistRoutes from '../../src/routes/v1/watchlists.js';

let app;
let broker;

before(async () => {
  await useTestDb('watchlists');
  app = buildApp(watchlistRoutes, '/api/v1/watchlists');
  broker = watchBroker();
});
after(() => broker.restore());
beforeEach(async () => {
  await truncate();
  broker.reset();
});

const get = (p, u) => bearer(request(app).get(p), u);
const post = (p, u) => bearer(request(app).post(p), u);
const put = (p, u) => bearer(request(app).put(p), u);
const del = (p, u) => bearer(request(app).delete(p), u);

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

test('no watchlist route answers an unauthenticated caller', async () => {
  const wl = await makeWatchlist();
  const sym = await makeWatchlistSymbol(wl.id);

  const routes = [
    ['get', '/api/v1/watchlists'],
    ['get', `/api/v1/watchlists/${wl.id}`],
    ['get', `/api/v1/watchlists/${wl.id}/symbols`],
    ['get', '/api/v1/watchlists/export/csv'],
    ['post', '/api/v1/watchlists'],
    ['post', `/api/v1/watchlists/${wl.id}/symbols`],
    ['post', `/api/v1/watchlists/${wl.id}/instances`],
    ['post', '/api/v1/watchlists/import/csv'],
    ['put', `/api/v1/watchlists/${wl.id}`],
    ['put', `/api/v1/watchlists/${wl.id}/symbols/${sym.id}`],
    ['delete', `/api/v1/watchlists/${wl.id}`],
    ['delete', `/api/v1/watchlists/${wl.id}/symbols/${sym.id}`],
    ['delete', `/api/v1/watchlists/${wl.id}/instances/1`],
  ];

  for (const [method, path] of routes) {
    const res = await request(app)[method](path);
    assert.strictEqual(res.status, STATUS.UNAUTHORIZED, `${method.toUpperCase()} ${path} -> ${res.status}`);
  }
});

test('a refused watchlist edit is reported as forbidden, not as a conflict', async () => {
  // A 403 means "you may not"; a 409 means "someone else changed it, try again". The UI and any
  // API client branch on that difference - api-client.js retries some statuses and not others -
  // so answering a permission failure with 409 tells the caller to do the wrong thing.
  const wl = await makeWatchlist();
  const almost = await withPermissionsExcept(['watchlists.manage', 'watchlists.status']);

  const res = await put(`/api/v1/watchlists/${wl.id}`, almost).send({ name: 'Renamed' });
  assert.strictEqual(res.status, STATUS.FORBIDDEN, `permission denial must be 403, got ${res.status}`);
});

test('watchlists.status alone permits only the activate/deactivate toggle', async () => {
  const wl = await makeWatchlist({ is_active: 1 });
  const statusOnly = await withPermissions(['pages.watchlists.view', 'watchlists.status']);

  const toggle = await put(`/api/v1/watchlists/${wl.id}`, statusOnly).send({ is_active: false });
  assert.strictEqual(toggle.status, STATUS.OK, JSON.stringify(toggle.body));

  const rename = await put(`/api/v1/watchlists/${wl.id}`, statusOnly).send({ name: 'Hijacked' });
  assert.strictEqual(rename.status, STATUS.FORBIDDEN);

  const row = await db.get('SELECT name, is_active FROM watchlists WHERE id = ?', [wl.id]);
  assert.strictEqual(row.name, wl.name);
  assert.strictEqual(Number(row.is_active), 0);
});

test('symbol management is gated on watchlists.symbols.manage', async () => {
  const wl = await makeWatchlist();
  const sym = await makeWatchlistSymbol(wl.id);
  const almost = await withPermissionsExcept(['watchlists.symbols.manage']);

  assert.strictEqual((await post(`/api/v1/watchlists/${wl.id}/symbols`, almost).send({ exchange: 'NSE', symbol: 'TCS' })).status, STATUS.FORBIDDEN);
  assert.strictEqual((await put(`/api/v1/watchlists/${wl.id}/symbols/${sym.id}`, almost).send({ qty_value: 9 })).status, STATUS.FORBIDDEN);
  assert.strictEqual((await del(`/api/v1/watchlists/${wl.id}/symbols/${sym.id}`, almost)).status, STATUS.FORBIDDEN);
});

test('instance assignment is gated on watchlists.instances.manage', async () => {
  const wl = await makeWatchlist();
  const inst = await realInstance(CRYPTO);
  const almost = await withPermissionsExcept(['watchlists.instances.manage']);

  assert.strictEqual((await post(`/api/v1/watchlists/${wl.id}/instances`, almost).send({ instanceId: inst.id })).status, STATUS.FORBIDDEN);
  assert.strictEqual((await del(`/api/v1/watchlists/${wl.id}/instances/${inst.id}`, almost)).status, STATUS.FORBIDDEN);
});

test('CSV export and import stay admin-only', async () => {
  const trader = await asTrader();
  assert.strictEqual((await get('/api/v1/watchlists/export/csv', trader)).status, STATUS.FORBIDDEN);
  assert.strictEqual((await post('/api/v1/watchlists/import/csv', trader)).status, STATUS.FORBIDDEN);
});

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

test('creating a watchlist persists it', async () => {
  const admin = await asAdmin();
  const res = await post('/api/v1/watchlists', admin).send({ name: 'Momentum', description: 'breakouts' });

  assert.strictEqual(res.status, STATUS.CREATED, JSON.stringify(res.body));
  const row = await db.get('SELECT * FROM watchlists WHERE name = ?', ['Momentum']);
  assert.ok(row);
  assert.strictEqual(row.description, 'breakouts');
  // Seen live: every dashboard-created watchlist was inactive, and an inactive one is never quoted.
  assert.strictEqual(row.is_active, 1, 'a new watchlist must be active');
});

test('creating a watchlist with no name is refused', async () => {
  const admin = await asAdmin();
  const res = await post('/api/v1/watchlists', admin).send({ description: 'nameless' });
  assert.ok(res.status >= 400 && res.status < 500, `expected a client error, got ${res.status}`);
});

test('renaming a watchlist persists, and an unknown id is a 404', async () => {
  const admin = await asAdmin();
  const wl = await makeWatchlist({ name: 'Before' });

  assert.strictEqual((await put(`/api/v1/watchlists/${wl.id}`, admin).send({ name: 'After' })).status, STATUS.OK);
  assert.strictEqual((await db.get('SELECT name FROM watchlists WHERE id = ?', [wl.id])).name, 'After');

  assert.strictEqual((await put('/api/v1/watchlists/999999', admin).send({ name: 'Ghost' })).status, STATUS.NOT_FOUND);
});

test('deleting a watchlist takes its symbols with it', async () => {
  // watchlist_symbols has a FOREIGN KEY ... ON DELETE CASCADE, but foreign_keys is a per-
  // connection PRAGMA. If it is ever off, the rows survive as orphans that the symbol endpoints
  // will happily keep serving.
  const admin = await asAdmin();
  const wl = await makeWatchlist();
  await makeWatchlistSymbol(wl.id, { symbol: 'TCS' });
  await makeWatchlistSymbol(wl.id, { symbol: 'INFY' });

  assert.strictEqual((await del(`/api/v1/watchlists/${wl.id}`, admin)).status, STATUS.OK);

  const orphans = await db.all('SELECT id FROM watchlist_symbols WHERE watchlist_id = ?', [wl.id]);
  assert.strictEqual(orphans.length, 0, 'symbols must not outlive their watchlist');
});



// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------

test('adding a symbol stores it against the right watchlist', async () => {
  const admin = await asAdmin();
  const wl = await makeWatchlist();

  const res = await post(`/api/v1/watchlists/${wl.id}/symbols`, admin)
    .send({ exchange: 'NSE', symbol: 'TCS', qty_type: 'FIXED', qty_value: 25, product_type: 'MIS' });

  assert.strictEqual(res.status, STATUS.CREATED, JSON.stringify(res.body));
  const row = await db.get('SELECT * FROM watchlist_symbols WHERE watchlist_id = ? AND symbol = ?', [wl.id, 'TCS']);
  assert.ok(row);
  assert.strictEqual(row.qty_value, 25);
});

test('a symbol update applies and is readable back', async () => {
  const admin = await asAdmin();
  const wl = await makeWatchlist();
  const sym = await makeWatchlistSymbol(wl.id, { qty_value: 1 });

  const res = await put(`/api/v1/watchlists/${wl.id}/symbols/${sym.id}`, admin).send({ qty_value: 50 });
  assert.strictEqual(res.status, STATUS.OK, JSON.stringify(res.body));

  assert.strictEqual((await db.get('SELECT qty_value FROM watchlist_symbols WHERE id = ?', [sym.id])).qty_value, 50);
});

test('a symbol cannot be edited or deleted through a watchlist it does not belong to', async () => {
  // The handlers key off :symbolId alone and never check it against :id. Editing watchlist A
  // then reaches into watchlist B - and since these rows carry quantity and product type, that
  // is a live trading parameter being changed under a different watchlist's name.
  const admin = await asAdmin();
  const mine = await makeWatchlist({ name: 'Mine' });
  const theirs = await makeWatchlist({ name: 'Theirs' });
  const foreign = await makeWatchlistSymbol(theirs.id, { symbol: 'INFY', qty_value: 1 });

  const edited = await put(`/api/v1/watchlists/${mine.id}/symbols/${foreign.id}`, admin).send({ qty_value: 999 });
  assert.strictEqual(edited.status, STATUS.NOT_FOUND, 'a symbol outside this watchlist must not be addressable through it');

  const after = await db.get('SELECT qty_value FROM watchlist_symbols WHERE id = ?', [foreign.id]);
  assert.strictEqual(after.qty_value, 1, "the other watchlist's symbol must be untouched");

  const deleted = await del(`/api/v1/watchlists/${mine.id}/symbols/${foreign.id}`, admin);
  assert.strictEqual(deleted.status, STATUS.NOT_FOUND);
  assert.ok(await db.get('SELECT id FROM watchlist_symbols WHERE id = ?', [foreign.id]), 'it must still exist');
});

test('removing a symbol removes exactly that symbol', async () => {
  const admin = await asAdmin();
  const wl = await makeWatchlist();
  const keep = await makeWatchlistSymbol(wl.id, { symbol: 'TCS' });
  const drop = await makeWatchlistSymbol(wl.id, { symbol: 'INFY' });

  assert.strictEqual((await del(`/api/v1/watchlists/${wl.id}/symbols/${drop.id}`, admin)).status, STATUS.OK);

  const left = await db.all('SELECT id FROM watchlist_symbols WHERE watchlist_id = ?', [wl.id]);
  assert.deepStrictEqual(left.map((r) => r.id), [keep.id]);
});

test('listing symbols of an unknown watchlist does not 500', async () => {
  const admin = await asAdmin();
  const res = await get('/api/v1/watchlists/999999/symbols', admin);
  assert.ok(res.status < 500, `got ${res.status}`);
});

// ---------------------------------------------------------------------------
// Instance assignment
// ---------------------------------------------------------------------------

test('assigning and unassigning an instance updates the join table', async () => {
  const admin = await asAdmin();
  const wl = await makeWatchlist();
  const inst = await realInstance(CRYPTO);

  const assigned = await post(`/api/v1/watchlists/${wl.id}/instances`, admin).send({ instanceId: inst.id });
  assert.strictEqual(assigned.status, STATUS.CREATED, JSON.stringify(assigned.body));
  assert.ok(await db.get('SELECT * FROM watchlist_instances WHERE watchlist_id = ? AND instance_id = ?', [wl.id, inst.id]));

  assert.strictEqual((await del(`/api/v1/watchlists/${wl.id}/instances/${inst.id}`, admin)).status, STATUS.OK);
  assert.ok(!(await db.get('SELECT * FROM watchlist_instances WHERE watchlist_id = ? AND instance_id = ?', [wl.id, inst.id])));
});

test('assigning with no instanceId is refused', async () => {
  const admin = await asAdmin();
  const wl = await makeWatchlist();
  assert.strictEqual((await post(`/api/v1/watchlists/${wl.id}/instances`, admin).send({})).status, STATUS.VALIDATION);
});

test('assigning the same instance twice does not create a duplicate or a 500', async () => {
  const admin = await asAdmin();
  const wl = await makeWatchlist();
  const inst = await realInstance(CRYPTO);

  await post(`/api/v1/watchlists/${wl.id}/instances`, admin).send({ instanceId: inst.id });
  const again = await post(`/api/v1/watchlists/${wl.id}/instances`, admin).send({ instanceId: inst.id });

  assert.ok(again.status < 500, `a repeat assignment should be handled, got ${again.status}`);
  const rows = await db.all('SELECT id FROM watchlist_instances WHERE watchlist_id = ? AND instance_id = ?', [wl.id, inst.id]);
  assert.strictEqual(rows.length, 1, 'an instance must not be assigned twice - orders would fan out to it twice');
});

test('assigning an instance that does not exist is refused', async () => {
  const admin = await asAdmin();
  const wl = await makeWatchlist();
  const res = await post(`/api/v1/watchlists/${wl.id}/instances`, admin).send({ instanceId: 999999 });
  assert.ok(res.status >= 400 && res.status < 500, `expected a client error, got ${res.status}`);
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

test('the list reports what exists and a single fetch carries its symbols', async () => {
  const admin = await asAdmin();
  const wl = await makeWatchlist({ name: 'Listed' });
  await makeWatchlistSymbol(wl.id, { symbol: 'TCS' });
  const inst = await realInstance(CRYPTO);
  await linkInstanceToWatchlist(wl.id, inst.id);

  const list = await get('/api/v1/watchlists', admin);
  assert.strictEqual(list.status, STATUS.OK);
  assert.ok(list.body.data.some((w) => w.id === wl.id));

  const single = await get(`/api/v1/watchlists/${wl.id}`, admin);
  assert.strictEqual(single.status, STATUS.OK);
  assert.strictEqual(single.body.data.name, 'Listed');
});

test('a watchlist read never leaks an instance api key', async () => {
  const admin = await asAdmin();
  const wl = await makeWatchlist();
  const inst = await realInstance(CRYPTO);
  await linkInstanceToWatchlist(wl.id, inst.id);

  for (const path of ['/api/v1/watchlists', `/api/v1/watchlists/${wl.id}`, `/api/v1/watchlists/${wl.id}/symbols`]) {
    const res = await get(path, admin);
    assert.ok(!JSON.stringify(res.body).includes(inst.api_key), `${path} leaked an api key`);
  }
});

test('an unknown watchlist is a 404', async () => {
  const admin = await asAdmin();
  assert.strictEqual((await get('/api/v1/watchlists/999999', admin)).status, STATUS.NOT_FOUND);
});

test('a monitor can read watchlists but cannot change them', async () => {
  const wl = await makeWatchlist();
  const monitor = await asMonitor();

  assert.strictEqual((await get('/api/v1/watchlists', monitor)).status, STATUS.OK);
  assert.strictEqual((await post('/api/v1/watchlists', monitor).send({ name: 'Nope' })).status, STATUS.FORBIDDEN);
  assert.strictEqual((await del(`/api/v1/watchlists/${wl.id}`, monitor)).status, STATUS.FORBIDDEN);
});
