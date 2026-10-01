import { test } from 'node:test';
import assert from 'node:assert';
import sqlite3 from 'sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A second process holding the write lock for a moment used to fail the first write at once. */
test('a write waits for another connection\'s lock instead of failing with SQLITE_BUSY', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'busy-')), 'busy.db');
  process.env.DATABASE_PATH = file;
  const { default: db } = await import('../../src/core/database.js');
  await db.connect();
  await db.run('CREATE TABLE t (n INTEGER)');

  const other = new sqlite3.Database(file);
  const exec = (sql) => new Promise((res, rej) => other.exec(sql, (e) => (e ? rej(e) : res())));
  await exec('BEGIN IMMEDIATE; INSERT INTO t VALUES (1);');
  setTimeout(() => exec('COMMIT').catch(() => {}), 1200);

  const started = Date.now();
  await db.run('INSERT INTO t VALUES (2)');
  assert.ok(Date.now() - started >= 1000, 'it waited for the lock');
  assert.strictEqual((await db.all('SELECT n FROM t')).length, 2);

  const mode = await db.get('PRAGMA journal_mode');
  assert.strictEqual(mode.journal_mode, 'wal');
  other.close();
  await db.close();
});
