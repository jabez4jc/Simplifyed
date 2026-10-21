import assert from 'assert';
import test, { before } from 'node:test';

import { useTestDb } from '../helpers/db.js';
import db from '../../src/core/database.js';
import { makeInstance } from '../helpers/fixtures.js';
import { pruneOldRows, WHATSAPP_PER_INSTANCE } from '../../src/services/retention.service.js';

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

test('WhatsApp history keeps the newest 300 messages per instance, for at most 90 days', async () => {
  await db.run('DELETE FROM whatsapp_messages');
  const add = (ids, age = '-1 days', status = 'sent') => db.run(
    "INSERT INTO whatsapp_messages (recipient, instance_ids, body, status, created_at) VALUES ('owner', ?, 'x', ?, datetime('now', ?))",
    [ids, status, age]
  );
  await add(',1,', '-100 days'); // past 90 days
  await add(',2,', '-100 days', 'queued'); // never pruned while queued
  for (let i = 0; i < WHATSAPP_PER_INSTANCE + 5; i += 1) await add(',1,');
  await add(',2,');
  await add(',1,2,'); // newest of 1 and of 2
  await add(null); // admin-only alert

  await pruneOldRows();

  const per = async (id) => (await db.get('SELECT COUNT(*) n FROM whatsapp_messages WHERE instance_ids LIKE ?', [`%,${id},%`])).n;
  assert.strictEqual(await per(1), WHATSAPP_PER_INSTANCE, 'instance 1 trimmed to the cap, the shared newest one included');
  assert.strictEqual(await per(2), 3, 'instance 2: its two plus the queued old one');
  assert.strictEqual(await count('whatsapp_messages'), WHATSAPP_PER_INSTANCE + 3);
  const oldest = await db.get("SELECT COUNT(*) n FROM whatsapp_messages WHERE created_at < datetime('now', '-90 days') AND status != 'queued'");
  assert.strictEqual(oldest.n, 0);
});
