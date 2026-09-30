/**
 * Test database harness.
 *
 * node:test runs each test FILE in its own process, so each file gets its own SQLite copy and
 * can mutate freely without racing any other file. Building the schema from migrations costs
 * ~1s; doing that per file would dominate the suite, so `scripts/prepare-test-db.js` (run by every test script) migrates one template
 * (database/test-template.db) and each file copies it. Copy is ~2ms.
 *
 * db.connect() reads process.env.DATABASE_PATH at CALL time (not import time), so setting it
 * here before the first connect is enough - no import-order games needed.
 */

import { copyFileSync, existsSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import db from '../../src/core/database.js';

const BACKEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const TEMPLATE = join(BACKEND_ROOT, 'database/test-template.db');

/**
 * Reference data seeded by migrations that every test expects to be present. Truncating these
 * would strip the roles/permissions the auth middleware resolves against, so `truncate()` leaves
 * them alone.
 */
const SEEDED_TABLES = new Set([
  'schema_migrations',
  'roles',
  'permissions',
  'role_permissions',
  'application_settings',
]);

let activePath = null;

/**
 * Give this test file its own database and connect to it.
 * Call once, at the top of the file, before anything touches `db`.
 */
export async function useTestDb(label = 'suite') {
  if (!existsSync(TEMPLATE)) {
    throw new Error(
      `Missing ${TEMPLATE}. Run node scripts/prepare-test-db.js (every npm test script does) first.`
    );
  }

  const unique = `${label.replace(/[^a-z0-9]+/gi, '-')}-${process.pid}-${Date.now()}`;
  const abs = join(BACKEND_ROOT, `database/test-run-${unique}.db`);
  copyFileSync(TEMPLATE, abs);

  // database.js resolves DATABASE_PATH relative to the backend root.
  process.env.DATABASE_PATH = `./database/test-run-${unique}.db`;
  activePath = abs;

  await db.connect();

  // WAL leaves -wal/-shm siblings behind; clean all three on exit so the database/ dir doesn't
  // silt up with a file per test run.
  process.on('exit', cleanup);

  return db;
}

function cleanup() {
  if (!activePath) return;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(activePath + suffix, { force: true });
    } catch {
      /* best effort - the process is exiting anyway */
    }
  }
  activePath = null;
}

/**
 * Wipe all application data, keeping the reference rows migrations seeded.
 *
 * Use in a beforeEach when a file's tests would otherwise see each other's rows. Files whose
 * tests are naturally independent can skip it.
 */
export async function truncate() {
  const tables = await db.all(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  );

  await db.run('PRAGMA foreign_keys = OFF');
  for (const { name } of tables) {
    // instruments_fts is a virtual table; its _data/_idx/_docsize/_config shadow tables reject
    // direct DELETE. Clearing the virtual table clears them.
    if (name.startsWith('instruments_fts_')) continue;
    if (SEEDED_TABLES.has(name)) continue;
    await db.run(`DELETE FROM ${name}`);
  }
  await db.run("DELETE FROM sqlite_sequence WHERE name NOT IN ('roles','permissions')").catch(() => {});
  await db.run('PRAGMA foreign_keys = ON');
}
