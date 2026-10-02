import assert from 'assert';
import test, { before } from 'node:test';

import { useTestDb } from '../helpers/db.js';
import db from '../../src/core/database.js';
import { notify } from '../../src/services/notify.service.js';

before(() => useTestDb('notify'));

test('notify writes one notification row with the meta folded into the body', async () => {
  await notify('Kill switch', 'Executed', { severity: 'error', instances: 3, skipped: null });
  const rows = await db.all("SELECT title, body, severity FROM notifications WHERE title = 'Kill switch'");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, 'Executed | instances=3');
  assert.equal(rows[0].severity, 'error');
});

test('warn logs no longer create notifications (LOG_NOTIFICATIONS is gone)', async () => {
  const { log } = await import('../../src/core/logger.js');
  const before = (await db.get('SELECT COUNT(*) n FROM notifications')).n;
  log.warn('some warning', { a: 1 });
  log.error('some error', new Error('x'));
  assert.equal((await db.get('SELECT COUNT(*) n FROM notifications')).n, before);
});
