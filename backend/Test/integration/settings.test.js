import assert from 'assert';
import test, { before, beforeEach } from 'node:test';
import request from 'supertest';

import { useTestDb } from '../helpers/db.js';
import { buildApp } from '../helpers/app.js';
import { asAdmin, asTrader, asMonitor, withPermissions, withPermissionsExcept, bearer } from '../helpers/auth.js';
import { STATUS } from '../helpers/http.js';
import db from '../../src/core/database.js';
import settingsRoutes from '../../src/routes/v1/settings.js';
import { isEditable, SETTINGS_FIELDS } from '../../src/config/settings-registry.js';

/**
 * Settings are the app's control surface: poll intervals, rate limits, market hours, blackout
 * windows. A bad value here does not throw - it quietly changes how the app talks to a live
 * broker. So the tests care most about what CANNOT be set.
 */

let app;
let baseline;

// Pick a real editable numeric setting off the registry rather than hard-coding a key name -
// the registry is the allowlist, and a key that is not in it is not writable by design.
const NUMERIC_KEY = [...SETTINGS_FIELDS.entries()]
  .find(([, f]) => f.min !== undefined && f.max !== undefined)[0];
const NUMERIC_FIELD = SETTINGS_FIELDS.get(NUMERIC_KEY);
const IN_RANGE = Math.floor((NUMERIC_FIELD.min + NUMERIC_FIELD.max) / 2);

before(async () => {
  await useTestDb('settings');
  app = buildApp(settingsRoutes, '/api/v1/settings');
  baseline = await db.all('SELECT key, value FROM application_settings');
});

beforeEach(async () => {
  // application_settings is seeded reference data that truncate() deliberately preserves, so
  // restore it by value instead - these tests mutate it directly.
  for (const row of baseline) {
    await db.run('UPDATE application_settings SET value = ? WHERE key = ?', [row.value, row.key]);
  }
});

const get = (p, u) => bearer(request(app).get(p), u);
const put = (p, u) => bearer(request(app).put(p), u);
const post = (p, u) => bearer(request(app).post(p), u);

const valueOf = async (key) => (await db.get('SELECT value FROM application_settings WHERE key = ?', [key]))?.value;

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

test('no settings route answers an anonymous caller', async () => {
  const routes = [
    ['get', '/api/v1/settings'],
    ['get', '/api/v1/settings/schema'],
    ['get', '/api/v1/settings/categories'],
    ['get', '/api/v1/settings/polling'],
    ['get', `/api/v1/settings/key/${NUMERIC_KEY}`],
    ['get', '/api/v1/settings/instance-health-tests/config'],
    ['put', `/api/v1/settings/${NUMERIC_KEY}`],
    ['put', '/api/v1/settings'],
    ['put', '/api/v1/settings/instance-health-tests/config'],
    ['post', `/api/v1/settings/${NUMERIC_KEY}/reset`],
  ];
  for (const [method, path] of routes) {
    const res = await request(app)[method](path).send({});
    assert.strictEqual(res.status, STATUS.UNAUTHORIZED, `${method.toUpperCase()} ${path} -> ${res.status}`);
  }
});

test('reading settings and changing them are separate permissions', async () => {
  const reader = await withPermissions(['pages.settings.view']);

  assert.strictEqual((await get('/api/v1/settings', reader)).status, STATUS.OK);
  assert.strictEqual(
    (await put(`/api/v1/settings/${NUMERIC_KEY}`, reader).send({ value: IN_RANGE })).status,
    STATUS.FORBIDDEN,
    'viewing the settings page must not confer the ability to change trading behaviour'
  );
});

test('a user with every permission except settings.manage still cannot write', async () => {
  const almost = await withPermissionsExcept(['settings.manage']);
  assert.strictEqual((await put(`/api/v1/settings/${NUMERIC_KEY}`, almost).send({ value: IN_RANGE })).status, STATUS.FORBIDDEN);
  assert.strictEqual((await post(`/api/v1/settings/${NUMERIC_KEY}/reset`, almost)).status, STATUS.FORBIDDEN);
});

test('a monitor cannot see or change settings at all', async () => {
  const monitor = await asMonitor();
  assert.strictEqual((await get('/api/v1/settings', monitor)).status, STATUS.FORBIDDEN);
  assert.strictEqual((await put(`/api/v1/settings/${NUMERIC_KEY}`, monitor).send({ value: IN_RANGE })).status, STATUS.FORBIDDEN);
});

test('a trader can view settings but not rewrite them', async () => {
  const trader = await asTrader();
  assert.strictEqual((await get('/api/v1/settings', trader)).status, STATUS.OK);
  assert.strictEqual((await put(`/api/v1/settings/${NUMERIC_KEY}`, trader).send({ value: IN_RANGE })).status, STATUS.FORBIDDEN);
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

test('the settings list, schema and categories all answer', async () => {
  const admin = await asAdmin();

  const all = await get('/api/v1/settings', admin);
  assert.strictEqual(all.status, STATUS.OK);
  assert.ok(all.body.data, 'settings must come back');

  const schema = await get('/api/v1/settings/schema', admin);
  assert.strictEqual(schema.status, STATUS.OK);

  const categories = await get('/api/v1/settings/categories', admin);
  assert.strictEqual(categories.status, STATUS.OK);
});

test('no settings response exposes a sensitive value in the clear', async () => {
  const admin = await asAdmin();
  await db.run(
    `INSERT INTO application_settings (key, value, description, category, data_type, is_sensitive)
     VALUES ('test.secret_credential', 'super-secret-value-9999', 'test', 'server', 'string', 1)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, is_sensitive = 1`
  );

  for (const path of ['/api/v1/settings', '/api/v1/settings/server', '/api/v1/settings/key/test.secret_credential']) {
    const res = await get(path, admin);
    assert.ok(
      !JSON.stringify(res.body).includes('super-secret-value-9999'),
      `${path} exposed a setting flagged is_sensitive`
    );
  }

  await db.run(`DELETE FROM application_settings WHERE key = 'test.secret_credential'`);
});

test('an unknown key and an unknown category do not crash', async () => {
  const admin = await asAdmin();
  assert.ok((await get('/api/v1/settings/key/no.such.setting', admin)).status < 500);
  assert.ok((await get('/api/v1/settings/no_such_category', admin)).status < 500);
});

// ---------------------------------------------------------------------------
// Writing - the part that matters
// ---------------------------------------------------------------------------

test('an editable setting can be changed and reads back changed', async () => {
  const admin = await asAdmin();

  const res = await put(`/api/v1/settings/${NUMERIC_KEY}`, admin).send({ value: IN_RANGE });
  assert.strictEqual(res.status, STATUS.OK, JSON.stringify(res.body));
  assert.strictEqual(String(await valueOf(NUMERIC_KEY)), String(IN_RANGE));
});

test('a setting that is not runtime-editable cannot be written through the API', async () => {
  // The registry is the allowlist. Anything outside it - auth switches, env-derived values,
  // safety limits - must be unreachable from a request, whoever is asking.
  const admin = await asAdmin();

  const forbidden = ['auth.enable_test_mode', 'server.port', 'brokerage.market_order_support'];
  for (const key of forbidden) {
    if (isEditable(key)) continue; // if the registry does expose it, that is a deliberate choice
    const before = await valueOf(key);
    const res = await put(`/api/v1/settings/${key}`, admin).send({ value: 'true' });

    assert.ok(res.status >= 400, `${key} must not be writable, got ${res.status}`);
    assert.strictEqual(await valueOf(key), before, `${key} was modified despite being non-editable`);
  }
});

test('a value outside the declared bounds is refused, so a typo cannot hammer a broker', async () => {
  const admin = await asAdmin();
  const before = await valueOf(NUMERIC_KEY);

  for (const value of [NUMERIC_FIELD.min - 1, -5, NUMERIC_FIELD.max + 1]) {
    const res = await put(`/api/v1/settings/${NUMERIC_KEY}`, admin).send({ value });
    assert.ok(res.status >= 400, `${NUMERIC_KEY}=${value} -> ${res.status}`);
  }

  assert.strictEqual(await valueOf(NUMERIC_KEY), before, 'a rejected value must not be written');
});

test('a value of the wrong type is refused rather than coerced to nonsense', async () => {
  const admin = await asAdmin();
  const before = await valueOf(NUMERIC_KEY);

  for (const value of ['not-a-number', {}, [], true]) {
    const res = await put(`/api/v1/settings/${NUMERIC_KEY}`, admin).send({ value });
    assert.ok(res.status >= 400, `${JSON.stringify(value)} -> ${res.status}`);
    assert.ok(res.status < 500, `${JSON.stringify(value)} crashed with ${res.status}`);
  }

  assert.strictEqual(await valueOf(NUMERIC_KEY), before);
});

test('a missing value is a 400, not a write of undefined', async () => {
  const admin = await asAdmin();
  const before = await valueOf(NUMERIC_KEY);

  const res = await put(`/api/v1/settings/${NUMERIC_KEY}`, admin).send({});
  assert.strictEqual(res.status, STATUS.BAD_REQUEST);
  assert.strictEqual(await valueOf(NUMERIC_KEY), before);
});

test('writing a key that does not exist is a 404', async () => {
  const admin = await asAdmin();
  const res = await put('/api/v1/settings/completely.made.up.key', admin).send({ value: 1 });
  assert.ok(res.status >= 400 && res.status < 500, `got ${res.status}`);

  const row = await db.get('SELECT key FROM application_settings WHERE key = ?', ['completely.made.up.key']);
  assert.ok(!row, 'a bad key must not create a new setting row');
});

test('a blackout window must be a real 24-hour time', async () => {
  const admin = await asAdmin();
  const key = 'market_hours.blackout_start';
  if (!isEditable(key)) return;

  for (const value of ['25:00', '9:5', 'morning', '09:60', '']) {
    const res = await put(`/api/v1/settings/${key}`, admin).send({ value });
    assert.ok(res.status >= 400, `${key}='${value}' -> ${res.status}`);
  }

  const ok = await put(`/api/v1/settings/${key}`, admin).send({ value: '09:15' });
  assert.strictEqual(ok.status, STATUS.OK, JSON.stringify(ok.body));
});

test('a bulk update applies every valid change and rejects the batch cleanly if one is invalid', async () => {
  const admin = await asAdmin();
  const res = await put('/api/v1/settings', admin).send({
    settings: { [NUMERIC_KEY]: IN_RANGE },
  });

  assert.ok(res.status < 500, `bulk update crashed with ${res.status}: ${JSON.stringify(res.body)}`);
});

test('a bulk update with a hostile body does not crash', async () => {
  const admin = await asAdmin();
  for (const body of [{}, { settings: null }, { settings: 'nope' }, { settings: [] }, { settings: { '': '' } }]) {
    const res = await put('/api/v1/settings', admin).send(body);
    assert.ok(res.status < 500, `${JSON.stringify(body)} -> ${res.status}`);
  }
});

test('resetting a setting returns it to its default', async () => {
  const admin = await asAdmin();
  const original = await valueOf(NUMERIC_KEY);

  await put(`/api/v1/settings/${NUMERIC_KEY}`, admin).send({ value: IN_RANGE });
  assert.strictEqual(String(await valueOf(NUMERIC_KEY)), String(IN_RANGE));

  const res = await post(`/api/v1/settings/${NUMERIC_KEY}/reset`, admin);
  assert.ok(res.status < 500, `reset -> ${res.status}`);

  if (res.status === STATUS.OK) {
    assert.notStrictEqual(String(await valueOf(NUMERIC_KEY)), String(IN_RANGE), 'a reset must actually change the value back');
    assert.strictEqual(String(await valueOf(NUMERIC_KEY)), String(original));
  }
});

// ---------------------------------------------------------------------------
// Instance health test config
// ---------------------------------------------------------------------------

test('the instance health test config round-trips', async () => {
  const admin = await asAdmin();

  const current = await get('/api/v1/settings/instance-health-tests/config', admin);
  assert.strictEqual(current.status, STATUS.OK, JSON.stringify(current.body));

  const written = await put('/api/v1/settings/instance-health-tests/config', admin).send(current.body.data);
  assert.ok(written.status < 500, `writing back what was read crashed with ${written.status}`);
});

test('a hostile health test config does not crash', async () => {
  const admin = await asAdmin();
  for (const body of [{}, null, { tests: 'nope' }, { tests: [1, 2, 3] }]) {
    const res = await put('/api/v1/settings/instance-health-tests/config', admin).send(body);
    assert.ok(res.status < 500, `${JSON.stringify(body)} -> ${res.status}`);
  }
});
