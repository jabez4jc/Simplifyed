/**
 * Builds the world the e2e run happens in, before Playwright starts the app.
 *
 * Everything here is disposable: a database built from the migration template, one admin whose
 * password the specs know, and instances pointed at the fake broker. Nothing touches the
 * developer's real database (database/simplifyed.db) - the app under test is started with
 * DATABASE_PATH set to the e2e copy in playwright.config.js.
 */

import { copyFileSync, existsSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { startFakeBroker } from './fake-broker.js';

const BACKEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = join(BACKEND_ROOT, 'database/test-template.db');
const E2E_DB_REL = './database/e2e.db';
const E2E_DB = join(BACKEND_ROOT, E2E_DB_REL);

export const ADMIN = { email: 'e2e-admin@example.test', password: 'e2e-admin-password' };

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

  const broker = await startFakeBroker();
  const brokerUrl = `http://127.0.0.1:${broker.port}`;

  // Seed through the app's own modules so rows match what the app expects, rather than
  // hand-writing SQL that can drift from the schema.
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

  await db.run(
    `INSERT INTO instances (name, host_url, api_key, broker, strategy_tag, is_active, multiplier,
                            market_data_role, market_data_enabled, session_target_profit)
     VALUES (?, ?, ?, 'zerodha', 'E2E', 1, 1, 'primary', 1, 5000)`,
    ['E2E Primary', brokerUrl, 'e2e-api-key-abcdef123456']
  );
  await db.run(
    `INSERT INTO instances (name, host_url, api_key, broker, strategy_tag, is_active, multiplier)
     VALUES (?, ?, ?, 'zerodha', 'E2E2', 1, 1)`,
    ['E2E Secondary', `${brokerUrl}/second`, 'e2e-api-key-second-98765']
  );

  // Seed the instruments cache.
  //
  // The app gates almost every route behind "are instruments loaded" (see
  // middleware/instruments-refresh.middleware.js) and, with an empty cache, tries to refresh it
  // from a live broker and answers 503 to everything until that succeeds. That gate is correct -
  // trading against an unknown symbol table is worse than being down - but it means an e2e run
  // has to satisfy the same precondition a production deployment does, rather than switch the
  // check off and test an app configured differently from the real one.
  const instruments = [
    ['RELIANCE', 'NSE', 'RELIANCE INDUSTRIES LTD', '2885', 1, 'EQ', 0.05],
    ['TCS', 'NSE', 'TATA CONSULTANCY SERVICES', '11536', 1, 'EQ', 0.05],
    ['INFY', 'NSE', 'INFOSYS LTD', '1594', 1, 'EQ', 0.05],
    ['SBIN', 'NSE', 'STATE BANK OF INDIA', '3045', 1, 'EQ', 0.05],
    ['NIFTY', 'NSE_INDEX', 'NIFTY 50', '26000', 1, 'INDEX', 0.05],
  ];
  for (const [symbol, exchange, name, token, lotsize, instrumenttype, tick] of instruments) {
    await db.run(
      `INSERT INTO instruments (symbol, brsymbol, name, exchange, brexchange, token, lotsize, instrumenttype, tick_size)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [symbol, symbol, name, exchange, exchange, token, lotsize, instrumenttype, tick]
    );
  }
  await db.run(
    `INSERT INTO instruments_refresh_log (exchange, instrument_count, refresh_started_at, refresh_completed_at, status)
     VALUES (NULL, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'completed')`,
    [instruments.length]
  );

  const watchlist = await db.run(
    "INSERT INTO watchlists (name, description, is_active, type) VALUES ('E2E Watchlist', 'seeded', 1, 'standard')"
  );
  await db.run(
    `INSERT INTO watchlist_symbols (watchlist_id, exchange, symbol, qty_type, qty_value, product_type, order_type, tradable_equity)
     VALUES (?, 'NSE', 'RELIANCE', 'FIXED', 1, 'MIS', 'MARKET', 1)`,
    [watchlist.lastID]
  );

  await db.close();

  // Hand the broker handle to teardown, and the port to any spec that wants to inspect traffic.
  writeFileSync(join(BACKEND_ROOT, 'e2e/.runtime.json'), JSON.stringify({ brokerUrl, brokerPort: broker.port }));

  globalThis.__E2E_BROKER__ = broker;
  return async () => {
    broker.server.close();
  };
}
