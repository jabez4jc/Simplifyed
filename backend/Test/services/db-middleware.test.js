import assert from 'assert';
import http from 'http';
import express from 'express';
import test, { before, beforeEach, afterEach } from 'node:test';

import { useTestDb, truncate } from '../helpers/db.js';
import db from '../../src/core/database.js';
import { makeInstance, makeWatchlist, makeWatchlistSymbol } from '../helpers/fixtures.js';
import { pendingMigrations } from '../../src/core/migration-check.js';
import idempotencyService from '../../src/services/idempotency.service.js';
import pnlSnapshotService from '../../src/services/pnl-snapshot.service.js';
import instancePnlService from '../../src/services/instance-pnl.service.js';
import rbacService from '../../src/services/rbac.service.js';
import watchlistService from '../../src/services/watchlist.service.js';
import authRoutes from '../../src/routes/v1/auth.js';
import instanceRoutes from '../../src/routes/v1/instances.js';
import notificationRoutes from '../../src/routes/v1/notifications.js';
import { optionalAuth, signLocalToken, isValidNewPassword, invalidateUserCache } from '../../src/middleware/auth.js';
import { rowPayload, upsertByKey } from '../../src/utils/csv-import.js';

/** P3-8: database and middleware. No broker is reached. */

before(async () => { await useTestDb('db-middleware'); });
beforeEach(async () => { await truncate(); invalidateUserCache(); });

/** Serve `router` on an ephemeral port; returns { url, close }. */
async function serve(router, { user = null } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (user) req.user = user; next(); });
  app.use('/', router);
  app.use((err, _req, res, _next) => res.status(err.statusCode || err.status || 500).json({ message: err.message }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('pending migrations are detected by version', async () => {
  assert.deepStrictEqual(await pendingMigrations(db), []);
  const row = await db.get("SELECT version, name FROM schema_migrations WHERE version = '078'");
  await db.run("DELETE FROM schema_migrations WHERE version = '078'");
  try {
    assert.deepStrictEqual(await pendingMigrations(db), ['078']);
  } finally {
    await db.run('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', [row.version, row.name]);
  }
});

test('a pending idempotency row left by a crash stops blocking after 5 minutes', async () => {
  const claim = () => idempotencyService.getOrCreate({ requestId: 'r1', source: 'webhook', payload: { a: 1 } });
  assert.strictEqual((await claim()).hit, false, 'first request is new');
  assert.strictEqual((await claim()).hit, true, 'a retry while it is still in flight is a duplicate');

  await db.run("UPDATE idempotency_keys SET created_at = datetime('now', '-10 minutes')");
  assert.strictEqual((await claim()).hit, false, 'the abandoned row is expired and the request accepted again');
  assert.strictEqual((await claim()).hit, true, 'and it is now the live one');

  await idempotencyService.complete({ requestId: 'r1', source: 'webhook', response: { ok: 1 } });
  await db.run("UPDATE idempotency_keys SET created_at = datetime('now', '-10 minutes')");
  assert.strictEqual((await claim()).hit, true, 'a COMPLETED row keeps answering for its TTL');
});

test('signal counts add up under concurrency, in one row', async () => {
  const inst = await makeInstance();
  await Promise.all(Array.from({ length: 6 }, () => pnlSnapshotService.incrementSignalCounts(inst.id, { webhook_buy_signals: 1 }, '2026-10-02')));
  const rows = await db.all('SELECT webhook_buy_signals FROM daily_instance_pnl_snapshots WHERE instance_id = ?', [inst.id]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].webhook_buy_signals, 6);
});

test('daily P&L snapshot upsert never regresses a day', async () => {
  const inst = await makeInstance();
  const read = async () => db.get('SELECT total_pnl, buy_trades FROM daily_instance_pnl_snapshots WHERE instance_id = ?', [inst.id]);
  const put = (p) => instancePnlService._upsertDailyPnlSnapshot(inst.id, '2026-10-02', p);
  await put({ total_pnl: -100, buy_trades: 2, sell_trades: 1, buy_value: 500, sell_value: 400 });
  await put({ total_pnl: 0, buy_trades: 3, sell_trades: 1, buy_value: 600, sell_value: 400 });
  assert.deepStrictEqual({ ...(await read()) }, { total_pnl: -100, buy_trades: 2 }, 'a zero P&L never replaces a real one');
  await put({ total_pnl: -50, buy_trades: 1, sell_trades: 1, buy_value: 500, sell_value: 400 });
  assert.strictEqual((await read()).buy_trades, 2, 'trade counts never go down');
  await put({ total_pnl: -50, buy_trades: 3, sell_trades: 2, buy_value: 700, sell_value: 600 });
  assert.deepStrictEqual({ ...(await read()) }, { total_pnl: -50, buy_trades: 3 });
});

test('two concurrent /register calls create exactly one admin', async () => {
  const srv = await serve(authRoutes);
  try {
    const body = (email) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct-horse-9' }) });
    const [a, b] = await Promise.all([
      fetch(`${srv.url}/register`, body('a@example.com')),
      fetch(`${srv.url}/register`, body('b@example.com')),
    ]);
    assert.deepStrictEqual([a.status, b.status].sort(), [200, 403]);
    assert.strictEqual((await db.get('SELECT COUNT(*) AS n FROM users')).n, 1);
  } finally {
    await srv.close();
  }
});

test('one password rule: 8+ characters, at most 72 bytes', () => {
  assert.strictEqual(isValidNewPassword('short'), false);
  assert.strictEqual(isValidNewPassword('a'.repeat(72)), true);
  assert.strictEqual(isValidNewPassword('a'.repeat(73)), false);
  assert.strictEqual(isValidNewPassword('é'.repeat(37)), false, '74 bytes');
  assert.strictEqual(isValidNewPassword(12345678), false);
});

test('rbac: password rule applies, and the last admin cannot be deleted', async () => {
  const admin = await db.run("INSERT INTO users (email, is_admin, password_hash) VALUES ('root@example.com', 1, 'x')");
  await assert.rejects(() => rbacService.createUser('t@example.com', 'a'.repeat(80), 'Trader', admin.lastID), /password/);
  await assert.rejects(() => rbacService.resetPassword(admin.lastID, 'short'), /password/);

  await assert.rejects(() => rbacService.deleteUser(admin.lastID), /last admin/);
  const trader = await rbacService.createUser('t@example.com', 'long-enough-1', 'Trader', admin.lastID);
  await rbacService.deleteUser(trader.id);
  assert.ok(!(await db.get('SELECT id FROM users WHERE id = ?', [trader.id])));

  const second = await db.run("INSERT INTO users (email, is_admin, password_hash) VALUES ('two@example.com', 1, 'x')");
  await rbacService.deleteUser(admin.lastID); // fine: another admin remains
  assert.ok(await db.get('SELECT id FROM users WHERE id = ?', [second.lastID]));
  await assert.rejects(() => rbacService.deleteUser(second.lastID), /last admin/);
  await assert.rejects(() => rbacService.deleteUser(99999), /not found/i);
});

test('optionalAuth caches the user for 30 s, and an RBAC change invalidates it', async () => {
  const created = await db.run("INSERT INTO users (email, is_admin, password_hash) VALUES ('u@example.com', 0, 'x')");
  const role = await db.get("SELECT id FROM roles WHERE name = 'Trader'");
  await db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', [created.lastID, role.id]);
  const token = signLocalToken({ id: created.lastID, email: 'u@example.com' });
  const who = async () => {
    const req = { headers: { authorization: `Bearer ${token}` } };
    await optionalAuth(req, {}, () => {});
    return req.user;
  };

  const first = await who();
  assert.strictEqual(first.role, 'Trader');
  await db.run("DELETE FROM user_roles WHERE user_id = ?", [created.lastID]); // behind the cache's back
  assert.strictEqual((await who()).role, 'Trader', 'served from the cache');

  await rbacService.assignRole(created.lastID, 'Monitor', null);
  assert.strictEqual((await who()).role, 'Monitor', 'assignRole invalidated it');

  const before = (await who()).permissions.length;
  await rbacService.setRolePermissions('Monitor', []);
  assert.ok(before > 0 && (await who()).permissions.length === 0, 'a role permission change invalidated everyone');
});

test('CSV import: only allowlisted columns are read; upsert is by key', async () => {
  const headers = ['id', 'name', 'host_url', 'api_key', 'is_analyzer_mode', 'health_status', 'current_balance', 'multiplier'];
  const payload = rowPayload('instances', headers, ['9', 'A', 'http://a.test', 'key-1', '1', 'healthy', '5000', '2']);
  assert.deepStrictEqual(payload, { name: 'A', host_url: 'http://a.test', api_key: 'key-1', multiplier: 2 });

  const one = await upsertByKey(db, 'instances', ['host_url'], payload, { stampColumn: 'last_updated' });
  assert.strictEqual(one.action, 'inserted');
  const two = await upsertByKey(db, 'instances', ['host_url'], { ...payload, multiplier: 3 }, { stampColumn: 'last_updated' });
  assert.deepStrictEqual([two.action, two.id], ['updated', one.id]);
  assert.strictEqual((await db.get('SELECT multiplier FROM instances WHERE id = ?', [one.id])).multiplier, 3);
  assert.strictEqual((await upsertByKey(db, 'instances', ['host_url'], { name: 'x' })).action, 'skipped');
});

test('watchlist symbol edits check the watchlist type with a light read', async () => {
  const strategy = await makeWatchlist({ type: 'strategy' });
  const standard = await makeWatchlist();
  const onStrategy = await makeWatchlistSymbol(strategy.id, { symbol: 'AAA' });
  const onStandard = await makeWatchlistSymbol(standard.id, { symbol: 'BBB' });

  const light = await watchlistService._getWatchlistForSymbol(onStandard.id);
  assert.deepStrictEqual(Object.keys(light).sort(), ['id', 'type'], 'no symbols/instances/webhook hydration');
  await assert.rejects(() => watchlistService.removeSymbol(onStrategy.id), /does not support symbols/);
  await watchlistService.removeSymbol(onStandard.id);
  await assert.rejects(() => watchlistService._getWatchlistForSymbol(onStandard.id), /Symbol/);
});

test('manual instance refresh needs the edit permission, not just view', async () => {
  const viewer = await serve(instanceRoutes, { user: { id: 5, role: 'Monitor', permissions: ['pages.instances.view'] } });
  try {
    assert.strictEqual((await fetch(`${viewer.url}/1/refresh`, { method: 'POST' })).status, 403);
  } finally {
    await viewer.close();
  }
});

test('POST /notifications/read-all marks every unread row in one call', async () => {
  for (const title of ['a', 'b', 'c']) await db.run('INSERT INTO notifications (title, read) VALUES (?, 0)', [title]);
  const srv = await serve(notificationRoutes, { user: { id: 5, is_admin: 1, permissions: [] } });
  try {
    const res = await fetch(`${srv.url}/read-all`, { method: 'POST' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).data.updated, 3);
    assert.strictEqual((await db.get('SELECT COUNT(*) AS n FROM notifications WHERE read = 0')).n, 0);
  } finally {
    await srv.close();
  }
  const viewer = await serve(notificationRoutes, { user: { id: 6, role: 'Monitor', permissions: ['pages.notifications.view'] } });
  try {
    assert.strictEqual((await fetch(`${viewer.url}/read-all`, { method: 'POST' })).status, 403);
  } finally {
    await viewer.close();
  }
});
