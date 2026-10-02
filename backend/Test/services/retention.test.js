import assert from 'assert';
import test, { before } from 'node:test';

import { useTestDb } from '../helpers/db.js';
import db from '../../src/core/database.js';
import { makeInstance } from '../helpers/fixtures.js';
import { pruneOldRows } from '../../src/services/retention.service.js';

before(async () => {
  await useTestDb('retention');
});

const count = async (table) => (await db.get(`SELECT COUNT(*) AS n FROM ${table}`)).n;

test('prune deletes rows past each table window and keeps newer ones', async () => {
  await db.run('DELETE FROM risk_events');
  await db.run('DELETE FROM notifications');
  await db.run('DELETE FROM candles');
  for (const age of ['-1 days', '-40 days']) {
    await db.run("INSERT INTO risk_events (event_type, created_at) VALUES ('X', datetime('now', ?))", [age]);
    await db.run(
      "INSERT INTO candles (exchange, symbol, timeframe, ts, fetched_at) VALUES ('NSE', 'A', '1m', ?, datetime('now', ?))",
      [Math.abs(parseInt(age, 10)), age]
    );
  }
  // Notifications: only read ones expire.
  await db.run("INSERT INTO notifications (title, read, created_at) VALUES ('old read', 1, datetime('now', '-40 days'))");
  await db.run("INSERT INTO notifications (title, read, created_at) VALUES ('old unread', 0, datetime('now', '-40 days'))");

  await pruneOldRows();

  assert.strictEqual(await count('risk_events'), 1);
  assert.strictEqual(await count('candles'), 1);
  const left = await db.all('SELECT title FROM notifications');
  assert.deepStrictEqual(left.map((r) => r.title), ['old unread']);
});

test('quick_orders and watchlist_orders keep 90 days', async () => {
  const { id } = await makeInstance();
  for (const age of ['-60 days', '-100 days']) {
    await db.run(
      `INSERT INTO quick_orders (instance_id, underlying, symbol, exchange, action, trade_mode, quantity, product, order_type, created_at)
       VALUES (?, 'U', 'S', 'NSE', 'BUY', 'EQUITY', 1, 'MIS', 'LIMIT', datetime('now', ?))`,
      [id, age]
    );
    await db.run(
      `INSERT INTO watchlist_orders (instance_id, exchange, symbol, side, quantity, order_type, product_type, placed_at)
       VALUES (?, 'NSE', 'S', 'BUY', 1, 'LIMIT', 'MIS', datetime('now', ?))`,
      [id, age]
    );
  }
  await pruneOldRows();
  assert.strictEqual(await count('quick_orders'), 1);
  assert.strictEqual(await count('watchlist_orders'), 1);
});
