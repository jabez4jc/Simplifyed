/**
 * Add quote_snapshots table for warm restarts and cache hydration
 */

export const version = '034';
export const name = 'add_quote_snapshots';

export async function up(db) {
  await db.run(`
    CREATE TABLE IF NOT EXISTS quote_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id INTEGER NOT NULL UNIQUE,
      payload TEXT,
      hash TEXT,
      fetched_at INTEGER,
      exchange_count INTEGER,
      symbol_count INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

export async function down(db) {
  await db.run('DROP TABLE IF EXISTS quote_snapshots');
}
