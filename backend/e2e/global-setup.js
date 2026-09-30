/**
 * Builds the world the e2e run happens in, before Playwright starts the app.
 *
 * The app under test gets its OWN database (database/e2e.db, from the migration template) so the
 * specs can create and delete watchlists, strategies and users freely - but the brokers are REAL:
 * the operator's instances (Jz Kotak, Jz Fyers, Jabez Crypto), copied with their API
 * keys from database/simplifyed.db, all in analyzer mode. The instruments cache is copied too, so
 * symbols resolve exactly as they do in production. Nothing in database/simplifyed.db is written.
 */

import { copyFileSync, existsSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const BACKEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = join(BACKEND_ROOT, 'database/test-template.db');
const REAL_DB = join(BACKEND_ROOT, 'database/simplifyed.db');
const E2E_DB_REL = './database/e2e.db';
const E2E_DB = join(BACKEND_ROOT, E2E_DB_REL);

export const ADMIN = { email: 'e2e-admin@example.test', password: 'e2e-admin-password' };
// Workflow tests use these three only; Maha and Ana are reserved for the live ORDER tests.
export const INSTANCES = ['Jz Kotak', 'Jz Fyers', 'Jabez Crypto'];

export default async function globalSetup() {
  if (!existsSync(TEMPLATE)) {
    const built = spawnSync(process.execPath, ['scripts/prepare-test-db.js'], {
      cwd: BACKEND_ROOT,
      stdio: 'inherit',
    });
    if (built.status !== 0) throw new Error('Could not build the migration template database');
  }

  for (const suffix of ['', '-wal', '-shm']) rmSync(E2E_DB + suffix, { force: true });
  copyFileSync(TEMPLATE, E2E_DB);

  process.env.DATABASE_PATH = E2E_DB_REL;
  const { default: db } = await import('../src/core/database.js');
  const { hashPassword } = await import('../src/middleware/auth.js');
  await db.connect();

  const hash = await hashPassword(ADMIN.password);
  const user = await db.run(
    'INSERT INTO users (email, is_admin, password_hash) VALUES (?, 1, ?)',
    [ADMIN.email, hash]
  );
  await db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?, 1)', [user.lastID]);

  // The real instances and the real instruments cache, read-only from the operator's database.
  await db.run(`ATTACH DATABASE ? AS real`, [REAL_DB]);
  const cols = (await db.all('PRAGMA table_info(instances)')).map((c) => c.name).filter((c) => c !== 'id');
  const realCols = new Set((await db.all('PRAGMA real.table_info(instances)')).map((c) => c.name));
  const shared = cols.filter((c) => realCols.has(c));
  await db.run(
    `INSERT INTO instances (${shared.join(', ')}) SELECT ${shared.join(', ')} FROM real.instances
     WHERE name IN (${INSTANCES.map(() => '?').join(', ')})`,
    INSTANCES
  );
  // Every instance used here must be in analyzer mode at its broker; the specs re-check before
  // each order. Health starts clean - the app re-probes on boot.
  await db.run("UPDATE instances SET health_status = 'healthy', is_active = 1");
  const copied = await db.all('SELECT name FROM instances');
  if (copied.length !== INSTANCES.length) {
    throw new Error(`Expected ${INSTANCES.length} real instances, found: ${copied.map((r) => r.name).join(', ')}`);
  }

  const instCols = (await db.all('PRAGMA table_info(instruments)')).map((c) => c.name).filter((c) => c !== 'id');
  await db.run(`INSERT INTO instruments (${instCols.join(', ')}) SELECT ${instCols.join(', ')} FROM real.instruments`);
  await db.run(
    `INSERT INTO instruments_refresh_log (exchange, instrument_count, refresh_started_at, refresh_completed_at, status)
     SELECT NULL, COUNT(*), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'completed' FROM instruments`
  );
  // A token rotated from Settings lives here, ahead of WEBHOOK_TOKEN in .env - carry it over.
  await db.run(
    `INSERT OR REPLACE INTO application_settings (key, value, description, category, data_type, is_sensitive)
     SELECT key, value, description, category, data_type, is_sensitive FROM real.application_settings
     WHERE key = 'webhooks.tradingview.token'`
  );
  await db.run('DETACH DATABASE real');
  await db.close();

  writeFileSync(join(BACKEND_ROOT, 'e2e/.runtime.json'), JSON.stringify({ instances: INSTANCES }));
}

// Run directly by the Playwright webServer command, before the server starts.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  globalSetup().then(() => process.exit(0), (error) => {
    console.error(error);
    process.exit(1);
  });
}
