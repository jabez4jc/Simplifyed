import assert from 'assert';
import test, { before, beforeEach } from 'node:test';
import request from 'supertest';

import { useTestDb } from '../helpers/db.js';
import { buildApp } from '../helpers/app.js';
import { asAdmin, asTrader, asMonitor, withPermissions, withPermissionsExcept, bearer } from '../helpers/auth.js';
import { STATUS } from '../helpers/http.js';
import db from '../../src/core/database.js';
import { config } from '../../src/core/config.js';
import openalgoClient from '../../src/integrations/openalgo/client.js';
import settingsRoutes from '../../src/routes/v1/settings.js';
import { isEditable, SETTINGS_FIELDS } from '../../src/config/settings-registry.js';

/**
 * Settings are the app's control surface: order costs, trading hours, poll intervals, broker rate
 * limits. A bad value here does not throw - it quietly changes how the app talks to a live
 * broker. So the tests care most about what CANNOT be set.
 *
 * Writes go through PUT /api/v1/settings - the one the Settings screen uses. It applies every
 * valid key and reports each rejected one in data.errors, so a refusal is "listed in errors and
 * not written", not a 4xx.
 */

let app;
let baseline;

// Pick a real editable numeric setting off the registry rather than hard-coding a key name -
// the registry is the allowlist, and a key that is not in it is not writable by design.
const NUMERIC_KEY = [...SETTINGS_FIELDS.entries()]
  .find(([, f]) => f.min >= 1 && f.max !== undefined)[0];
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

/** Save one key the way the Settings screen does. */
const save = (user, key, value) => put('/api/v1/settings', user).send({ [key]: value });
const rejected = (res, key) => (res.body?.data?.errors || []).some((e) => e.key === key);

const valueOf = async (key) => (await db.get('SELECT value FROM application_settings WHERE key = ?', [key]))?.value;

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

test('no settings route answers an anonymous caller', async () => {
  const routes = [
    ['get', '/api/v1/settings'],
    ['get', '/api/v1/settings/schema'],
    ['put', '/api/v1/settings'],
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
    (await save(reader, NUMERIC_KEY, IN_RANGE)).status,
    STATUS.FORBIDDEN,
    'viewing the settings page must not confer the ability to change trading behaviour'
  );
});

test('a user with every permission except settings.manage still cannot write', async () => {
  const almost = await withPermissionsExcept(['settings.manage']);
  assert.strictEqual((await save(almost, NUMERIC_KEY, IN_RANGE)).status, STATUS.FORBIDDEN);
});

test('a monitor cannot see or change settings at all', async () => {
  const monitor = await asMonitor();
  assert.strictEqual((await get('/api/v1/settings', monitor)).status, STATUS.FORBIDDEN);
  assert.strictEqual((await save(monitor, NUMERIC_KEY, IN_RANGE)).status, STATUS.FORBIDDEN);
});

test('a trader can view settings but not rewrite them', async () => {
  const trader = await asTrader();
  assert.strictEqual((await get('/api/v1/settings', trader)).status, STATUS.OK);
  assert.strictEqual((await save(trader, NUMERIC_KEY, IN_RANGE)).status, STATUS.FORBIDDEN);
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

test('the settings list and the schema the screen renders from both answer', async () => {
  const admin = await asAdmin();

  const all = await get('/api/v1/settings', admin);
  assert.strictEqual(all.status, STATUS.OK);
  assert.ok(all.body.data, 'settings must come back');

  const schema = await get('/api/v1/settings/schema', admin);
  assert.strictEqual(schema.status, STATUS.OK);
});

test('no settings response exposes a sensitive value in the clear', async () => {
  // e.g. a TradingView webhook token rotated from Access Control
  const admin = await asAdmin();
  await db.run(
    `INSERT INTO application_settings (key, value, description, category, data_type, is_sensitive)
     VALUES ('test.secret_credential', 'super-secret-value-9999', 'test', 'server', 'string', 1)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, is_sensitive = 1`
  );

  for (const path of ['/api/v1/settings', '/api/v1/settings/schema']) {
    const res = await get(path, admin);
    assert.ok(
      !JSON.stringify(res.body).includes('super-secret-value-9999'),
      `${path} exposed a setting flagged is_sensitive`
    );
  }

  await db.run(`DELETE FROM application_settings WHERE key = 'test.secret_credential'`);
});

// ---------------------------------------------------------------------------
// Writing - the part that matters
// ---------------------------------------------------------------------------

test('an editable setting can be changed and reads back changed', async () => {
  const admin = await asAdmin();

  const res = await save(admin, NUMERIC_KEY, IN_RANGE);
  assert.strictEqual(res.status, STATUS.OK, JSON.stringify(res.body));
  assert.ok(!rejected(res, NUMERIC_KEY), JSON.stringify(res.body));
  assert.strictEqual(String(await valueOf(NUMERIC_KEY)), String(IN_RANGE));
});

test('a setting that is not runtime-editable cannot be written through the API', async () => {
  // The registry is the allowlist. Anything outside it - auth switches, env-derived values,
  // safety limits - must be unreachable from a request, whoever is asking.
  const admin = await asAdmin();

  const forbidden = ['auth.enable_test_mode', 'server.port', 'rate_limits.disabled', 'webhooks.tradingview.token'];
  for (const key of forbidden) {
    if (isEditable(key)) continue; // if the registry does expose it, that is a deliberate choice
    const before = await valueOf(key);
    const res = await save(admin, key, 'true');

    assert.ok(rejected(res, key), `${key} must not be writable: ${JSON.stringify(res.body)}`);
    assert.strictEqual(await valueOf(key), before, `${key} was modified despite being non-editable`);
  }
});

test('a value outside the declared bounds is refused, so a typo cannot hammer a broker', async () => {
  const admin = await asAdmin();
  const before = await valueOf(NUMERIC_KEY);

  for (const value of [NUMERIC_FIELD.min - 1, -5, NUMERIC_FIELD.max + 1]) {
    const res = await save(admin, NUMERIC_KEY, value);
    assert.ok(rejected(res, NUMERIC_KEY), `${NUMERIC_KEY}=${value} was accepted`);
  }

  assert.strictEqual(await valueOf(NUMERIC_KEY), before, 'a rejected value must not be written');
});

test('a value of the wrong type is refused rather than coerced to nonsense', async () => {
  const admin = await asAdmin();
  const before = await valueOf(NUMERIC_KEY);

  for (const value of ['not-a-number', {}, [], true, null]) {
    const res = await save(admin, NUMERIC_KEY, value);
    assert.ok(res.status < 500, `${JSON.stringify(value)} crashed with ${res.status}`);
    assert.ok(rejected(res, NUMERIC_KEY), `${JSON.stringify(value)} was accepted`);
  }

  assert.strictEqual(await valueOf(NUMERIC_KEY), before);
});

test('writing a key that does not exist creates nothing', async () => {
  const admin = await asAdmin();
  const res = await save(admin, 'completely.made.up.key', 1);
  assert.ok(rejected(res, 'completely.made.up.key'));

  const row = await db.get('SELECT key FROM application_settings WHERE key = ?', ['completely.made.up.key']);
  assert.ok(!row, 'a bad key must not create a new setting row');
});

test('a trading session time must be a real 24-hour time', async () => {
  const admin = await asAdmin();
  const before = await valueOf('trading_sessions');

  for (const start of ['25:00', '9:5', 'morning', '09:60', '']) {
    const res = await save(admin, 'trading_sessions', [{ label: 'Session 1', start, end: '11:30' }]);
    assert.ok(rejected(res, 'trading_sessions'), `start '${start}' was accepted`);
  }
  assert.strictEqual(await valueOf('trading_sessions'), before);

  const ok = await save(admin, 'trading_sessions', [{ label: 'Session 1', start: '09:15', end: '11:30' }]);
  assert.ok(!rejected(ok, 'trading_sessions'), JSON.stringify(ok.body));
});

test('a save applies every valid key and reports only the invalid one', async () => {
  const admin = await asAdmin();
  const res = await put('/api/v1/settings', admin).send({ [NUMERIC_KEY]: IN_RANGE, 'completely.made.up.key': 1 });

  assert.strictEqual(res.status, STATUS.OK, JSON.stringify(res.body));
  assert.deepStrictEqual(res.body.data.errors.map((e) => e.key), ['completely.made.up.key']);
  assert.strictEqual(String(await valueOf(NUMERIC_KEY)), String(IN_RANGE), 'the valid key was applied');
});

test('a save with a hostile body does not crash', async () => {
  const admin = await asAdmin();
  for (const body of [{}, { settings: null }, { settings: 'nope' }, [], { '': '' }]) {
    const res = await put('/api/v1/settings', admin).send(body);
    assert.ok(res.status < 500, `${JSON.stringify(body)} -> ${res.status}`);
  }
});

test('the spread limit is editable, stored as a fraction, and refuses 0 and more than 100%', async () => {
  const admin = await asAdmin();
  const key = 'market_data_feed.max_order_spread_pct';
  assert.strictEqual((await save(admin, key, 0.02)).status, STATUS.OK); // 2% on screen
  assert.strictEqual(Number(await valueOf(key)), 0.02);
  for (const bad of [0, 1.5]) {
    const res = await save(admin, key, bad);
    assert.ok(res.body.data?.errors?.length, `${bad} must be refused: ${JSON.stringify(res.body)}`);
  }
  assert.strictEqual(Number(await valueOf(key)), 0.02, 'a refused value leaves the setting alone');
});

test('the broker timeout on screen is the one the broker client uses', async () => {
  // Before 2026-09-30 the client copied the timeout from .env at import, so the Settings value
  // was shown but never used.
  const admin = await asAdmin();
  const res = await save(admin, 'openalgo.request_timeout_ms', 21000);
  assert.strictEqual(res.status, STATUS.OK, JSON.stringify(res.body));
  await config.loadFromDatabase(); // what the settings:changed handler in server.js runs
  assert.strictEqual(openalgoClient.timeout, 21000);
});
