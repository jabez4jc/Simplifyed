import assert from 'assert';
import test, { before, after, beforeEach } from 'node:test';
import request from 'supertest';

import { useTestDb, truncate } from '../helpers/db.js';
import { buildApp } from '../helpers/app.js';
import { asAdmin, asMonitor, withPermissionsExcept, bearer } from '../helpers/auth.js';
import { watchBroker, realInstance, KOTAK } from '../helpers/real-broker.js';
import { STATUS } from '../helpers/http.js';
import db from '../../src/core/database.js';
import openalgoClient from '../../src/integrations/openalgo/client.js';
import v1Routes from '../../src/routes/v1/index.js';

/**
 * The global kill switch, on the real Jz Kotak analyzer account. The kill switch closes EVERY
 * open position, so the run that exercises it only goes ahead when that account is flat - a test
 * must never close something it did not open.
 */

let app;
let broker;

before(async () => {
  await useTestDb('kill-switch');
  app = buildApp(v1Routes, '/api/v1');
  broker = watchBroker();
});

after(() => broker.restore());

beforeEach(async () => {
  await truncate();
  broker.reset();
});

const fire = (user, body = { confirm: 'KILL' }) => bearer(request(app).post('/api/v1/kill-switch'), user).send(body);

test('the kill switch is gated on killswitch.execute, and every built-in role holds it', async () => {
  const without = await withPermissionsExcept(['killswitch.execute']);
  assert.strictEqual((await fire(without)).status, STATUS.FORBIDDEN);

  const roles = await db.all(
    `SELECT r.name FROM roles r JOIN role_permissions rp ON rp.role_id = r.id
     JOIN permissions p ON p.id = rp.permission_id WHERE p.key = 'killswitch.execute' ORDER BY r.id`
  );
  assert.deepStrictEqual(roles.map((r) => r.name), ['Admin', 'Trader', 'Monitor']);
  assert.strictEqual(broker.calls.length, 0);
});

test('without an explicit confirm it refuses and touches no broker', async () => {
  await realInstance(KOTAK);
  const res = await fire(await asMonitor(), {});
  assert.strictEqual(res.status, STATUS.VALIDATION);
  assert.strictEqual(broker.calls.length, 0);
});

test('it cancels orders, checks the book and parks every instance in analyzer mode', async (t) => {
  const inst = await realInstance(KOTAK, { session_cutoff_reason: 'SESSION_MAX_LOSS' });
  const open = (await openalgoClient.getPositionBook(inst)).filter((p) => Number(p.quantity ?? p.netqty ?? 0) !== 0);
  if (open.length) return t.skip(`${KOTAK} holds ${open.length} position(s) this test did not open`);
  broker.reset();

  const res = await fire(await asAdmin());
  assert.strictEqual(res.status, 200, JSON.stringify(res.body).slice(0, 400));

  const [row] = res.body.data.instances;
  assert.strictEqual(row.name, KOTAK);
  assert.strictEqual(row.success, true);
  assert.strictEqual(row.switched, true);
  assert.deepStrictEqual(row.stillOpen, []);

  assert.strictEqual(broker.countOf('cancelallorder'), 1, 'pending orders are cancelled first');
  assert.ok(broker.countOf('positionbook') >= 2, 'the book is read, then read back to confirm it is flat');
  assert.strictEqual(broker.countOf('closeposition'), 0, 'never the MARKET square-off');
  assert.strictEqual(broker.countOf('analyzer/toggle'), 0, 'already in analyzer mode - nothing to switch at the broker');

  const saved = await db.get('SELECT is_analyzer_mode, session_cutoff_reason FROM instances WHERE id = ?', [inst.id]);
  assert.strictEqual(saved.is_analyzer_mode, 1);
  // Not SESSION_MAX_LOSS any more, so the new-session auto-revert cannot put it back to live.
  assert.strictEqual(saved.session_cutoff_reason, 'KILL_SWITCH');
});

test('Close All on one instance goes through the LIMIT close path, never closeposition', async (t) => {
  const inst = await realInstance(KOTAK);
  const open = (await openalgoClient.getPositionBook(inst)).filter((p) => Number(p.quantity ?? p.netqty ?? 0) !== 0);
  if (open.length) return t.skip(`${KOTAK} holds ${open.length} position(s) this test did not open`);
  broker.reset();

  const res = await bearer(request(app).post(`/api/v1/positions/${inst.id}/close`), await asAdmin()).send({});
  assert.strictEqual(res.status, 200, JSON.stringify(res.body).slice(0, 400));
  assert.deepStrictEqual(res.body.data.stillOpen, []);
  assert.strictEqual(broker.countOf('closeposition'), 0, 'the MARKET square-off is never used');
  assert.ok(broker.countOf('positionbook') >= 2, 'the book is read, then read back');
});
