import { copyFileSync, existsSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import sqlite3 from 'sqlite3';

/**
 * The live suites' own database (database/live.db), so they never write to the one the running
 * app has open. Two processes writing one SQLite file is what produced "database is locked" in
 * the middle of a live run.
 *
 * It is a snapshot of database/simplifyed.db taken the first time, and kept: the suites'
 * cleanup reads the symbols past runs ordered from it (source 'live_test'), and that history
 * would be lost if it were rebuilt every run. Each run refreshes what must be current from the
 * real database - the instances (hosts and API keys rotate on login) and the instruments cache
 * (contracts expire) - and nothing flows back.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const REAL = join(ROOT, 'database/simplifyed.db');
const LIVE_REL = './database/live.db';
const LIVE = join(ROOT, LIVE_REL);
const INSTRUMENTS_MARK = `${LIVE}.instruments`;
const INSTRUMENTS_MAX_AGE_MS = 60 * 60 * 1000;

const open = (file) => new Promise((resolve, reject) => {
  const conn = new sqlite3.Database(file, (e) => (e ? reject(e) : resolve(conn)));
});
const exec = (conn, sql) => new Promise((resolve, reject) => conn.exec(sql, (e) => (e ? reject(e) : resolve())));
const all = (conn, sql) => new Promise((resolve, reject) => conn.all(sql, (e, rows) => (e ? reject(e) : resolve(rows))));

/** Point DATABASE_PATH at the live database, creating and refreshing it first. */
export async function useLiveDatabase() {
  // An explicit DATABASE_PATH wins - same override the suites always had.
  if (process.env.DATABASE_PATH) return;

  const conn = await open(LIVE);
  try {
    await exec(conn, 'PRAGMA busy_timeout = 30000');
    const fresh = !existsSync(LIVE) || (await all(conn, "SELECT name FROM sqlite_master WHERE name = 'instances'")).length === 0;
    await exec(conn, `ATTACH DATABASE '${REAL.replace(/'/g, "''")}' AS real`);

    if (fresh) {
      // Every table, schema included, as of now.
      const tables = await all(conn, "SELECT name, sql FROM real.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
      for (const t of tables) await exec(conn, t.sql);
      for (const t of tables) await exec(conn, `INSERT INTO main."${t.name}" SELECT * FROM real."${t.name}"`);
      const rest = await all(conn, "SELECT sql FROM real.sqlite_master WHERE type IN ('index', 'trigger') AND sql IS NOT NULL");
      for (const r of rest) await exec(conn, r.sql).catch(() => {});
    } else {
      const cols = (await all(conn, 'PRAGMA main.table_info(instances)')).map((c) => c.name);
      const real = new Set((await all(conn, 'PRAGMA real.table_info(instances)')).map((c) => c.name));
      const shared = cols.filter((c) => real.has(c) && c !== 'id');
      await exec(conn, `INSERT OR REPLACE INTO main.instances (id, ${shared.join(', ')})
                        SELECT id, ${shared.join(', ')} FROM real.instances`);
    }

    const stale = !existsSync(INSTRUMENTS_MARK) || Date.now() - statSync(INSTRUMENTS_MARK).mtimeMs > INSTRUMENTS_MAX_AGE_MS;
    if (stale && !fresh) {
      const cols = (await all(conn, 'PRAGMA main.table_info(instruments)')).map((c) => c.name).filter((c) => c !== 'id');
      await exec(conn, `BEGIN IMMEDIATE; DELETE FROM main.instruments;
                        INSERT INTO main.instruments (${cols.join(', ')}) SELECT ${cols.join(', ')} FROM real.instruments; COMMIT;`);
    }
    if (stale) {
      writeFileSync(INSTRUMENTS_MARK, '');
      utimesSync(INSTRUMENTS_MARK, new Date(), new Date());
    }
    await exec(conn, 'DETACH DATABASE real');
  } finally {
    await new Promise((resolve) => conn.close(resolve));
  }
  process.env.DATABASE_PATH = LIVE_REL;
}
