import assert from 'assert';
import test, { before, after, beforeEach } from 'node:test';
import request from 'supertest';

import { useTestDb, truncate } from '../helpers/db.js';
import { buildApp } from '../helpers/app.js';
import { asAdmin, asTrader, asMonitor, asRoleless, withPermissions, withPermissionsExcept, bearer } from '../helpers/auth.js';
import { makeInstance } from '../helpers/fixtures.js';
import { installFakeOpenAlgo } from '../helpers/fake-openalgo.js';
import { STATUS } from '../helpers/http.js';
import db from '../../src/core/database.js';
import instanceRoutes from '../../src/routes/v1/instances.js';

let app;
let broker;

before(async () => {
  await useTestDb('instances');
  app = buildApp(instanceRoutes, '/api/v1/instances');
  broker = installFakeOpenAlgo();
});

after(() => broker.restore());

beforeEach(async () => {
  await truncate();
  broker.reset();
});

const get = (path, user) => bearer(request(app).get(path), user);
const post = (path, user) => bearer(request(app).post(path), user);
const put = (path, user) => bearer(request(app).put(path), user);
const del = (path, user) => bearer(request(app).delete(path), user);

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

test('every instance route refuses an unauthenticated caller', async () => {
  const inst = await makeInstance();

  const unauthenticated = [
    ['get', '/api/v1/instances'],
    ['get', `/api/v1/instances/${inst.id}`],
    ['get', '/api/v1/instances/admin/instances'],
    ['get', '/api/v1/instances/market-data/instance'],
    ['get', '/api/v1/instances/market-data/all'],
    ['get', `/api/v1/instances/${inst.id}/circuit-breaker`],
    ['get', '/api/v1/instances/export/csv'],
    ['post', '/api/v1/instances'],
    ['post', '/api/v1/instances/test/connection'],
    ['post', '/api/v1/instances/test/apikey'],
    ['post', '/api/v1/instances/bulk-update'],
    ['post', `/api/v1/instances/${inst.id}/refresh`],
    ['post', `/api/v1/instances/${inst.id}/health`],
    ['post', `/api/v1/instances/${inst.id}/pnl`],
    ['post', `/api/v1/instances/${inst.id}/analyzer/toggle`],
    ['put', `/api/v1/instances/${inst.id}`],
    ['delete', `/api/v1/instances/${inst.id}`],
  ];

  for (const [method, path] of unauthenticated) {
    const res = await request(app)[method](path);
    assert.strictEqual(res.status, 401, `${method.toUpperCase()} ${path} should be 401, got ${res.status}`);
  }
});

test('a user with no role assigned is held at the door, not let through with zero permissions', async () => {
  const pending = await asRoleless();
  const res = await get('/api/v1/instances', pending);
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.code, 'ACCESS_PENDING');
});

test('editing is gated on instances.edit specifically', async () => {
  const inst = await makeInstance();
  const almost = await withPermissionsExcept(['instances.edit']);

  const denied = await put(`/api/v1/instances/${inst.id}`, almost).send({ name: 'Renamed' });
  assert.strictEqual(denied.status, 403, 'a user holding every permission except instances.edit must be refused');

  const allowed = await withPermissions(['pages.instances.view', 'instances.edit']);
  const ok = await put(`/api/v1/instances/${inst.id}`, allowed).send({ name: 'Renamed' });
  assert.strictEqual(ok.status, 200);
});

test('a monitor may flip analyzer mode but may not edit anything else', async () => {
  const inst = await makeInstance();
  const monitor = await asMonitor();

  const modeOnly = await put(`/api/v1/instances/${inst.id}`, monitor).send({ is_analyzer_mode: true });
  assert.strictEqual(modeOnly.status, 200, 'instances.toggle_mode covers a mode-only update');

  const broader = await put(`/api/v1/instances/${inst.id}`, monitor).send({ is_analyzer_mode: true, name: 'Hijacked' });
  assert.strictEqual(broader.status, 403, 'smuggling a second field past the mode-only path must fail');

  const row = await db.get('SELECT name FROM instances WHERE id = ?', [inst.id]);
  assert.strictEqual(row.name, inst.name, 'the refused update must not have partially applied');
});

test('bulk-update enforces the same permission split as a single edit', async () => {
  const inst = await makeInstance();
  const monitor = await asMonitor();

  const modeOnly = await post('/api/v1/instances/bulk-update', monitor)
    .send({ instance_ids: [inst.id], is_analyzer_mode: true });
  assert.strictEqual(modeOnly.status, 200);

  const activeChange = await post('/api/v1/instances/bulk-update', monitor)
    .send({ instance_ids: [inst.id], is_active: false });
  assert.strictEqual(activeChange.status, 403, 'is_active is an edit, not a mode toggle');

  const row = await db.get('SELECT is_active FROM instances WHERE id = ?', [inst.id]);
  assert.strictEqual(Number(row.is_active), 1);
});

test('CSV export and import are admin-only, not merely edit-permitted', async () => {
  const trader = await asTrader();
  assert.strictEqual((await get('/api/v1/instances/export/csv', trader)).status, 403);
  assert.strictEqual((await post('/api/v1/instances/import/csv', trader)).status, 403);
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

test('api keys are masked on every read path', async () => {
  const admin = await asAdmin();
  const inst = await makeInstance({ api_key: 'super-secret-key-123456' });

  const list = await get('/api/v1/instances', admin);
  assert.strictEqual(list.status, 200);
  assert.ok(!JSON.stringify(list.body).includes('super-secret-key-123456'), 'list leaked the api key');

  const single = await get(`/api/v1/instances/${inst.id}`, admin);
  assert.ok(!JSON.stringify(single.body).includes('super-secret-key-123456'), 'get-by-id leaked the api key');
  assert.match(single.body.data.api_key, /\*/, 'a masked key should still be shown, so the form has something to render');
});

test('filters actually filter', async () => {
  const admin = await asAdmin();
  await makeInstance({ is_active: 1, is_analyzer_mode: 0 });
  await makeInstance({ is_active: 0, is_analyzer_mode: 1 });

  const active = await get('/api/v1/instances?is_active=true', admin);
  assert.strictEqual(active.body.count, 1);
  assert.strictEqual(Number(active.body.data[0].is_active), 1);

  const analyzer = await get('/api/v1/instances?is_analyzer_mode=true', admin);
  assert.strictEqual(analyzer.body.count, 1);
  assert.strictEqual(Number(analyzer.body.data[0].is_analyzer_mode), 1);
});

test('an unknown id is a 404, and a non-numeric id is not a 500', async () => {
  const admin = await asAdmin();

  assert.strictEqual((await get('/api/v1/instances/999999', admin)).status, 404);

  const garbage = await get('/api/v1/instances/not-a-number', admin);
  assert.ok(garbage.status < 500, `a junk id should be a client error, got ${garbage.status}`);
});

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

test('creating an instance stores it and auto-detects the broker from ping', async () => {
  const admin = await asAdmin();
  broker.on('ping', { status: 'success', data: { broker: 'fyers' } });

  const res = await post('/api/v1/instances', admin).send({
    name: 'New Instance',
    host_url: 'http://new-instance.test',
    api_key: 'a-real-api-key-value',
  });

  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  assert.strictEqual(res.body.data.broker, 'fyers');

  const row = await db.get('SELECT * FROM instances WHERE host_url = ?', ['http://new-instance.test']);
  assert.ok(row, 'the row must actually exist');
  assert.strictEqual(row.api_key, 'a-real-api-key-value', 'the real key is stored, only the response is masked');
});

test('a duplicate host url is rejected as a conflict, not a 500', async () => {
  const admin = await asAdmin();
  const existing = await makeInstance();

  const res = await post('/api/v1/instances', admin).send({
    name: 'Duplicate',
    host_url: existing.host_url,
    api_key: 'another-key',
  });

  assert.strictEqual(res.status, 409);
});

test('an unreachable broker blocks creation rather than storing a dead instance', async () => {
  const admin = await asAdmin();
  broker.fail('ping', 'connect ECONNREFUSED');

  const res = await post('/api/v1/instances', admin).send({
    name: 'Dead',
    host_url: 'http://dead.test',
    api_key: 'some-key',
  });

  assert.strictEqual(res.status, STATUS.VALIDATION);
  const row = await db.get('SELECT id FROM instances WHERE host_url = ?', ['http://dead.test']);
  assert.ok(!row, 'nothing should have been persisted');
});

test('creating without required fields is a validation error naming the fields', async () => {
  const admin = await asAdmin();
  const res = await post('/api/v1/instances', admin).send({ name: 'No URL' });

  assert.strictEqual(res.status, STATUS.VALIDATION);
  assert.ok(res.body.errors?.length || res.body.details?.length || res.body.message, 'the client needs to know what was wrong');
});

// ---------------------------------------------------------------------------
// Editing - the reported problem area
// ---------------------------------------------------------------------------

test('a plain rename persists', async () => {
  const admin = await asAdmin();
  const inst = await makeInstance({ name: 'Before' });

  const res = await put(`/api/v1/instances/${inst.id}`, admin).send({ name: 'After' });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));

  const row = await db.get('SELECT name FROM instances WHERE id = ?', [inst.id]);
  assert.strictEqual(row.name, 'After');
});

test('saving the edit form back unchanged does not destroy the stored api key', async () => {
  // The form renders the MASKED key and posts it straight back. If that mask reaches the UPDATE,
  // a working credential is replaced by a row of asterisks and the instance silently stops
  // trading - the worst possible failure mode for an edit screen.
  const admin = await asAdmin();
  const inst = await makeInstance({ api_key: 'the-real-key-abcdef' });

  const shown = await get(`/api/v1/instances/${inst.id}`, admin);
  const maskedKey = shown.body.data.api_key;

  const res = await put(`/api/v1/instances/${inst.id}`, admin).send({
    name: 'Renamed',
    host_url: inst.host_url,
    api_key: maskedKey,
  });
  assert.strictEqual(res.status, 200);

  const row = await db.get('SELECT api_key, name FROM instances WHERE id = ?', [inst.id]);
  assert.strictEqual(row.api_key, 'the-real-key-abcdef', 'the masked value must never be written back');
  assert.strictEqual(row.name, 'Renamed', 'the rest of the edit still has to apply');
});

test('a genuinely new api key does replace the old one', async () => {
  const admin = await asAdmin();
  const inst = await makeInstance({ api_key: 'old-key-value' });

  await put(`/api/v1/instances/${inst.id}`, admin).send({ api_key: 'brand-new-key-value' });

  const row = await db.get('SELECT api_key FROM instances WHERE id = ?', [inst.id]);
  assert.strictEqual(row.api_key, 'brand-new-key-value');
});

test('an edit that sets a session target profit stores it', async () => {
  const admin = await asAdmin();
  const inst = await makeInstance();

  await put(`/api/v1/instances/${inst.id}`, admin).send({ session_target_profit: 5000 });

  const row = await db.get('SELECT session_target_profit FROM instances WHERE id = ?', [inst.id]);
  assert.strictEqual(row.session_target_profit, 5000);
});

test('clearing a session target profit actually clears it', async () => {
  // The edit form posts every field it renders. Emptying the "target profit" box sends '', and
  // an operator who empties that box means "no target" - the instance must stop cutting off at
  // the old figure. Dropping the field instead leaves the old target silently in force.
  const admin = await asAdmin();
  const inst = await makeInstance({ session_target_profit: 5000, session_max_loss: -2000 });

  const res = await put(`/api/v1/instances/${inst.id}`, admin).send({
    session_target_profit: '',
    session_max_loss: '',
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));

  const row = await db.get('SELECT session_target_profit, session_max_loss FROM instances WHERE id = ?', [inst.id]);
  assert.strictEqual(row.session_target_profit, null, 'an emptied target must be cleared, not left at the old value');
  assert.strictEqual(row.session_max_loss, null, 'an emptied max loss must be cleared, not left at the old value');
});

test('an invalid host url is rejected instead of being silently ignored', async () => {
  // Silently dropping it is worse than either alternative: the UI reports "Instance updated
  // successfully" and the operator believes they have repointed the instance when they have not.
  const admin = await asAdmin();
  const inst = await makeInstance({ host_url: 'http://original.test' });

  const res = await put(`/api/v1/instances/${inst.id}`, admin)
    .send({ host_url: 'not a url at all', strategy_tag: 'STILL-VALID' });

  assert.strictEqual(res.status, STATUS.VALIDATION, 'a rejected value must be reported, not swallowed');
  const row = await db.get('SELECT host_url FROM instances WHERE id = ?', [inst.id]);
  assert.strictEqual(row.host_url, 'http://original.test');
});

test('an empty name is rejected rather than silently keeping the old one', async () => {
  const admin = await asAdmin();
  const inst = await makeInstance({ name: 'Original' });

  const res = await put(`/api/v1/instances/${inst.id}`, admin).send({ name: '', strategy_tag: 'KEEP' });
  assert.strictEqual(res.status, STATUS.VALIDATION, 'an empty name must be reported, not quietly discarded');
});

test('editing an instance whose broker is offline still saves', async () => {
  // Credentials get edited precisely BECAUSE the instance is broken. If the save depends on the
  // broker answering, the one case the screen exists for is the one case it cannot handle.
  const admin = await asAdmin();
  const inst = await makeInstance();
  broker.fail('ping', 'connect ETIMEDOUT');

  const res = await put(`/api/v1/instances/${inst.id}`, admin).send({
    host_url: 'http://relocated.test',
    api_key: 'new-key-for-moved-host',
  });

  assert.strictEqual(res.status, 200, 'an offline broker must not block a credential fix');
  const row = await db.get('SELECT host_url, api_key FROM instances WHERE id = ?', [inst.id]);
  assert.strictEqual(row.host_url, 'http://relocated.test');
  assert.strictEqual(row.api_key, 'new-key-for-moved-host');
});

test('an edit that touches no broker-facing field does not ping the broker at all', async () => {
  // Every save currently re-pings because the form always posts host_url. On a slow or dead
  // broker that turns "rename an instance" into a request that blocks on a network timeout.
  const admin = await asAdmin();
  const inst = await makeInstance();
  broker.reset();

  await put(`/api/v1/instances/${inst.id}`, admin).send({ name: 'Just A Rename' });

  assert.strictEqual(broker.countOf('ping'), 0, 'renaming an instance should not require the broker to be up');
});

test('re-posting the same host_url unchanged is not treated as a credential change', async () => {
  const admin = await asAdmin();
  const inst = await makeInstance();
  broker.reset();

  await put(`/api/v1/instances/${inst.id}`, admin).send({ name: 'Renamed', host_url: inst.host_url });

  assert.strictEqual(broker.countOf('ping'), 0, 'an unchanged host url is not a reconnection');
});

test('an update with no usable fields is a 400, not a silent success', async () => {
  const admin = await asAdmin();
  const inst = await makeInstance();

  const res = await put(`/api/v1/instances/${inst.id}`, admin).send({});
  assert.strictEqual(res.status, STATUS.VALIDATION);
});

test('updating a non-existent instance is a 404', async () => {
  const admin = await asAdmin();
  const res = await put('/api/v1/instances/999999', admin).send({ name: 'Ghost' });
  assert.strictEqual(res.status, 404);
});

test('boolean flags round-trip as booleans, in both directions', async () => {
  const admin = await asAdmin();
  const inst = await makeInstance({ market_data_enabled: 0, supports_option_chain: 0, order_placement_enabled: 1 });

  await put(`/api/v1/instances/${inst.id}`, admin).send({
    market_data_enabled: true,
    supports_option_chain: true,
    order_placement_enabled: false,
  });

  let row = await db.get('SELECT * FROM instances WHERE id = ?', [inst.id]);
  assert.strictEqual(Number(row.market_data_enabled), 1);
  assert.strictEqual(Number(row.supports_option_chain), 1);
  assert.strictEqual(Number(row.order_placement_enabled), 0, 'unchecking a box must turn the flag OFF');

  // Turning them back off is the direction that breaks when a falsy value is treated as "absent".
  await put(`/api/v1/instances/${inst.id}`, admin).send({
    market_data_enabled: false,
    supports_option_chain: false,
    order_placement_enabled: true,
  });

  row = await db.get('SELECT * FROM instances WHERE id = ?', [inst.id]);
  assert.strictEqual(Number(row.market_data_enabled), 0);
  assert.strictEqual(Number(row.supports_option_chain), 0);
  assert.strictEqual(Number(row.order_placement_enabled), 1);
});

test('multiplier accepts its documented range and rejects what falls outside it', async () => {
  const admin = await asAdmin();
  const inst = await makeInstance();

  assert.strictEqual((await put(`/api/v1/instances/${inst.id}`, admin).send({ multiplier: 5 })).status, 200);
  assert.strictEqual((await put(`/api/v1/instances/${inst.id}`, admin).send({ multiplier: 0 })).status, STATUS.VALIDATION);
  assert.strictEqual((await put(`/api/v1/instances/${inst.id}`, admin).send({ multiplier: 1000 })).status, STATUS.VALIDATION);

  const row = await db.get('SELECT multiplier FROM instances WHERE id = ?', [inst.id]);
  assert.strictEqual(row.multiplier, 5, 'the rejected values must not have overwritten the accepted one');
});

// ---------------------------------------------------------------------------
// Deleting
// ---------------------------------------------------------------------------

test('deleting removes the row', async () => {
  const admin = await asAdmin();
  const inst = await makeInstance();

  assert.strictEqual((await del(`/api/v1/instances/${inst.id}`, admin)).status, STATUS.OK);
  assert.ok(!(await db.get('SELECT id FROM instances WHERE id = ?', [inst.id])), 'the row must be gone');
});

test('deleting something that is already gone is a 404, not a 500', async () => {
  const admin = await asAdmin();
  assert.strictEqual((await del('/api/v1/instances/999999', admin)).status, 404);
});

// ---------------------------------------------------------------------------
// Analyzer mode
// ---------------------------------------------------------------------------

test('the analyzer toggle requires a boolean and reports the broker outcome', async () => {
  const admin = await asAdmin();
  const inst = await makeInstance();

  const bad = await post(`/api/v1/instances/${inst.id}/analyzer/toggle`, admin).send({ mode: 'yes' });
  assert.strictEqual(bad.status, STATUS.VALIDATION, 'a string must not be coerced into a live/analyzer decision');

  broker.on('analyzer/toggle', { status: 'success', data: { mode: 'analyze', analyze_mode: true } });
  broker.on('analyzer', { status: 'success', data: { mode: 'analyze', analyze_mode: true } });
  const ok = await post(`/api/v1/instances/${inst.id}/analyzer/toggle`, admin).send({ mode: true });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));

  const row = await db.get('SELECT is_analyzer_mode FROM instances WHERE id = ?', [inst.id]);
  assert.strictEqual(Number(row.is_analyzer_mode), 1);
});

test('a broker that refuses the mode switch does not leave the app claiming it succeeded', async () => {
  // The whole point of the safe-switch workflow: believing we are in analyzer mode while the
  // broker is still live means the next order is a real one.
  const admin = await asAdmin();
  const inst = await makeInstance({ is_analyzer_mode: 0 });
  broker.fail('analyzer/toggle', 'analyzer unsupported by this broker');

  const res = await post(`/api/v1/instances/${inst.id}/analyzer/toggle`, admin).send({ mode: true });

  const row = await db.get('SELECT is_analyzer_mode FROM instances WHERE id = ?', [inst.id]);
  if (res.status === 200) {
    assert.fail('a refused broker toggle must not be reported as success');
  }
  assert.strictEqual(Number(row.is_analyzer_mode), 0, 'local state must not drift ahead of the broker');
});

// ---------------------------------------------------------------------------
// Connection testing
// ---------------------------------------------------------------------------

test('the connection test reports success and failure distinguishably', async () => {
  const admin = await asAdmin();

  broker.on('ping', { status: 'success', data: { broker: 'upstox' } });
  const ok = await post('/api/v1/instances/test/connection', admin)
    .send({ host_url: 'http://x.test', api_key: 'k' });
  assert.strictEqual(ok.body.status, 'success');
  assert.strictEqual(ok.body.data.broker, 'upstox');

  broker.fail('ping', 'ECONNREFUSED');
  const bad = await post('/api/v1/instances/test/connection', admin)
    .send({ host_url: 'http://x.test', api_key: 'k' });
  assert.strictEqual(bad.body.status, 'error');
});

test('the connection test requires both credentials', async () => {
  const admin = await asAdmin();
  const res = await post('/api/v1/instances/test/connection', admin).send({ host_url: 'http://x.test' });
  assert.strictEqual(res.status, STATUS.VALIDATION);
});

// ---------------------------------------------------------------------------
// CSV round trip
// ---------------------------------------------------------------------------

test('exported CSV masks credentials, and re-importing it leaves the real keys intact', async () => {
  const admin = await asAdmin();
  const inst = await makeInstance({ api_key: 'live-broker-credential-xyz', name: 'Exported' });

  const exported = await get('/api/v1/instances/export/csv', admin);
  assert.strictEqual(exported.status, 200);
  assert.match(exported.headers['content-type'], /text\/csv/);
  assert.ok(!exported.text.includes('live-broker-credential-xyz'), 'a downloadable file must not carry a live key');

  const reimported = await post('/api/v1/instances/import/csv', admin)
    .attach('file', Buffer.from(exported.text), 'instances.csv');
  assert.strictEqual(reimported.status, 200, JSON.stringify(reimported.body));

  const row = await db.get('SELECT api_key, name FROM instances WHERE id = ?', [inst.id]);
  assert.strictEqual(row.api_key, 'live-broker-credential-xyz', 'the round trip must not overwrite the key with its mask');
  assert.strictEqual(row.name, 'Exported');
});

test('a non-CSV upload is refused', async () => {
  const admin = await asAdmin();
  const res = await post('/api/v1/instances/import/csv', admin)
    .attach('file', Buffer.from('#!/bin/sh\nrm -rf /'), 'payload.sh');
  assert.ok(res.status >= 400, `expected a rejection, got ${res.status}`);
});

test('importing with no file at all is a 400', async () => {
  const admin = await asAdmin();
  assert.strictEqual((await post('/api/v1/instances/import/csv', admin)).status, STATUS.VALIDATION);
});

test('a rename is visible on the very next read, not one refresh later', async () => {
  // The UI saves and then immediately re-lists. If that read can come back with the pre-edit
  // value, the operator sees "Instance updated successfully" over a table still showing the old
  // name - which is indistinguishable, from the outside, from the save not having worked.
  const admin = await asAdmin();
  const inst = await makeInstance({ name: 'Before Rename' });

  const saved = await put(`/api/v1/instances/${inst.id}`, admin).send({ name: 'After Rename' });
  assert.strictEqual(saved.status, STATUS.OK);

  const list = await get('/api/v1/instances', admin);
  const found = list.body.data.find((i) => i.id === inst.id);
  assert.strictEqual(found.name, 'After Rename', 'the list read straight after a save must show the new value');

  const single = await get(`/api/v1/instances/${inst.id}`, admin);
  assert.strictEqual(single.body.data.name, 'After Rename', 'the detail read must show the new value too');
});

test('a mutating response is not cacheable by the browser', async () => {
  // Express stamps an ETag on every res.json and sets no Cache-Control. For an API whose whole
  // job is to reflect state that just changed, a revalidating browser cache is a correctness
  // problem, not an optimisation: the dashboard re-lists immediately after every save.
  const admin = await asAdmin();
  await makeInstance();

  const res = await get('/api/v1/instances', admin);
  const cacheControl = res.headers['cache-control'] || '';

  assert.match(
    cacheControl,
    /no-store|no-cache/,
    `authenticated API responses must forbid caching, got Cache-Control: '${cacheControl || '(none)'}'`
  );
});
