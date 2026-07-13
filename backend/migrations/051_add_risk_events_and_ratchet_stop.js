/**
 * Migration 051: Risk audit trail + ratcheting trailing-stop state
 * - risk_events: audit trail for stop ratchets, target/stop hits, margin sizing decisions, strategy leg exits
 * - trailing_state.stop_price: explicit ratcheted stop level (monotonic, never retreats)
 */

export const version = '051';
export const name = 'add_risk_events_and_ratchet_stop';

export async function up(db) {
  await db.run(`
    CREATE TABLE IF NOT EXISTS risk_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id INTEGER,
      watchlist_id INTEGER,
      symbol_id INTEGER,
      exchange TEXT,
      symbol TEXT,
      event_type TEXT NOT NULL,
      previous_value REAL,
      new_value REAL,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (instance_id) REFERENCES instances (id) ON DELETE SET NULL,
      FOREIGN KEY (watchlist_id) REFERENCES watchlists (id) ON DELETE SET NULL,
      FOREIGN KEY (symbol_id) REFERENCES watchlist_symbols (id) ON DELETE SET NULL
    )
  `);

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_risk_events_instance ON risk_events (instance_id)
  `);
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_risk_events_watchlist ON risk_events (watchlist_id)
  `);
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_risk_events_type ON risk_events (event_type)
  `);
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_risk_events_created_at ON risk_events (created_at)
  `);

  const columns = await db.all('PRAGMA table_info(trailing_state)');
  const hasStopPrice = columns.some((col) => col.name === 'stop_price');
  if (!hasStopPrice) {
    await db.run('ALTER TABLE trailing_state ADD COLUMN stop_price REAL');
  }
}

export async function down(db) {
  await db.run('DROP TABLE IF EXISTS risk_events');
  // SQLite does not support DROP COLUMN pre-3.35 without table rebuild; leave stop_price in place.
}
