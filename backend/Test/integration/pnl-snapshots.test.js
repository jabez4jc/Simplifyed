import assert from 'assert';
import test, { before, beforeEach } from 'node:test';
import request from 'supertest';

import { useTestDb, truncate } from '../helpers/db.js';
import { buildApp } from '../helpers/app.js';
import { asAdmin, withPermissionsExcept, bearer } from '../helpers/auth.js';
import { makeInstance } from '../helpers/fixtures.js';
import { STATUS } from '../helpers/http.js';
import db from '../../src/core/database.js';
import pnlSnapshotRoutes from '../../src/routes/v1/pnl-snapshots.js';

let app;

before(async () => {
  await useTestDb('pnl-snapshots');
  app = buildApp(pnlSnapshotRoutes, '/api/v1/pnl-snapshots');
});
beforeEach(() => truncate());

const exportCsv = (query, user) => bearer(request(app).get(`/api/v1/pnl-snapshots/export${query}`), user);

const snapshot = (instanceId, date, totalPnl) => db.run(
  'INSERT INTO daily_instance_pnl_snapshots (instance_id, snapshot_date, total_pnl, buy_trades) VALUES (?, ?, ?, 2)',
  [instanceId, date, totalPnl]
);

test('P&L export is a CSV of the requested date range, with names quoted safely', async () => {
  const admin = await asAdmin();
  const inst = await makeInstance({ name: 'Desk, "North"' });
  await snapshot(inst.id, '2026-10-01', 1250.5);
  await snapshot(inst.id, '2026-10-02', -300);
  await snapshot(inst.id, '2026-09-30', 999); // outside the range

  const res = await exportCsv('?start=2026-10-01&end=2026-10-02', admin);
  assert.strictEqual(res.status, STATUS.OK, res.text);
  assert.match(res.headers['content-type'], /text\/csv/);
  assert.match(res.headers['content-disposition'], /daily-pnl-snapshots-2026-10-01-to-2026-10-02\.csv/);

  const lines = res.text.split('\n');
  assert.strictEqual(lines[0].split(',')[0], 'date');
  assert.strictEqual(lines.length, 3, 'header + the two in-range days');
  assert.ok(lines[1].startsWith(`2026-10-02,${inst.id},"Desk, ""North""",`), lines[1]);
  assert.ok(lines[1].includes(',-300,'), lines[1]);
  assert.ok(lines[2].includes(',1250.5,'), lines[2]);
  assert.ok(!res.text.includes(',999,'), 'a day outside the range must not be exported');
});

test('P&L export refuses a malformed date and a caller without the page permission', async () => {
  const admin = await asAdmin();
  assert.strictEqual((await exportCsv('?start=2026-10-1&end=2026-10-02', admin)).status, STATUS.VALIDATION);
  assert.strictEqual((await exportCsv('?end=2026-10-02', admin)).status, STATUS.VALIDATION);

  const noPage = await withPermissionsExcept(['pages.daily_pnl.view']);
  assert.strictEqual((await exportCsv('?start=2026-10-01&end=2026-10-02', noPage)).status, STATUS.FORBIDDEN);
});
