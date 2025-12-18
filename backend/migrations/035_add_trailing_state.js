/**
 * Add trailing_state table to persist trailing stop/entry state per instance/symbol
 */

export const version = '035';
export const name = 'add_trailing_state';

export async function up(db) {
  await db.run(`
    CREATE TABLE IF NOT EXISTS trailing_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id INTEGER NOT NULL,
      exchange TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      highest REAL,
      lowest REAL,
      activated INTEGER DEFAULT 0,
      last_seen_ts INTEGER,
      entry_price REAL,
      entry_source TEXT,
      updated_at INTEGER DEFAULT (strftime('%s','now') * 1000),
      UNIQUE(instance_id, exchange, symbol, side)
    )
  `);
}

export async function down(db) {
  await db.run('DROP TABLE IF EXISTS trailing_state');
}
