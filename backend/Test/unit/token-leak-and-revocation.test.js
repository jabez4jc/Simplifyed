import assert from 'assert';
import test, { before } from 'node:test';

import { useTestDb, truncate } from '../helpers/db.js';
import db from '../../src/core/database.js';
import { redactUrl } from '../../src/core/logger.js';
import { sanitizeValue } from '../../src/middleware/audit-logger.js';
import { signLocalToken, resolveTokenUser } from '../../src/middleware/auth.js';
import rbacService from '../../src/services/rbac.service.js';
import watchlistService from '../../src/services/watchlist.service.js';

before(async () => {
  await useTestDb('token-leak');
  await truncate();
});

test('the webhook token never reaches a log line or the audit table, as ?token= or ?t=', () => {
  assert.strictEqual(
    redactUrl('/webhook/tradingview/broadcast/x?t=SECRET&instanceId=2&token=SECRET2'),
    '/webhook/tradingview/broadcast/x?t=[redacted]&instanceId=2&token=[redacted]'
  );
  assert.strictEqual(redactUrl('/api/v1/orders?status=open'), '/api/v1/orders?status=open');
  assert.deepStrictEqual(sanitizeValue({ t: 'SECRET', token: 'SECRET', at: 'x' }), { t: '[redacted]', token: '[redacted]', at: 'x' });
});

test('a login token stops working when its user is deleted or their password is reset', async () => {
  const { id } = await rbacService.createUser('revoked@example.com', 'password-1', 'Monitor', null);
  const token = signLocalToken({ id, email: 'revoked@example.com' });
  assert.strictEqual((await resolveTokenUser(token))?.id, id, 'valid before the reset');
  assert.strictEqual((await resolveTokenUser(token)).password_changed_at, undefined, 'internal column not exposed');

  // The token's iat is whole seconds; step past it so the reset is strictly later.
  await new Promise((r) => setTimeout(r, 1100));
  await rbacService.resetPassword(id, 'password-2');
  assert.strictEqual(await resolveTokenUser(token), null, 'a token from before the reset is refused');
  const fresh = signLocalToken({ id, email: 'revoked@example.com' });
  assert.strictEqual((await resolveTokenUser(fresh))?.id, id, 'a token issued after it works');

  await rbacService.deleteUser(id);
  assert.strictEqual(await resolveTokenUser(fresh), null, 'a deleted user is refused');
});

test('Monitor cannot manage watchlists or settings after migration 081', async () => {
  const rows = await db.all(
    `SELECT p.key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
     WHERE r.name = 'Monitor'`
  );
  const keys = rows.map((r) => r.key);
  for (const k of ['watchlists.instances.manage', 'watchlists.status', 'settings.instruments.refresh', 'orders.place']) {
    assert.ok(!keys.includes(k), `Monitor must not hold ${k}`);
  }
  assert.ok(keys.includes('killswitch.execute'), 'the emergency stop stays');
});

test('a watchlist slug cannot take the strategy namespace', async () => {
  await assert.rejects(
    watchlistService.createWatchlist({ name: 'clash', webhook_slug: 'strat-abc123' }),
    /validation failed/i
  );
});
