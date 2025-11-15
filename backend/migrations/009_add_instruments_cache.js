/**
 * Migration 009: Add Instruments Cache
 * Creates tables for caching complete broker instrument list
 * Supports daily refresh and fast local search via SQLite FTS5
 */

export const version = '009';
export const name = 'add_instruments_cache';

export async function up(db) {
  console.log('Running migration 009: Add instruments cache tables');

  // Create instruments table for complete broker instrument list
  await db.run(`
    CREATE TABLE IF NOT EXISTS instruments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      brsymbol TEXT,
      name TEXT,
      exchange TEXT NOT NULL,
      token TEXT,
      expiry TEXT,
      strike REAL,
      lotsize INTEGER DEFAULT 1,
      instrumenttype TEXT,
      tick_size REAL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(exchange, symbol, expiry, strike)
    )
  `);

  console.log('  ✅ Created instruments table');

  // Create instruments_refresh_log to track last refresh per exchange
  await db.run(`
    CREATE TABLE IF NOT EXISTS instruments_refresh_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exchange TEXT,
      instrument_count INTEGER DEFAULT 0,
      refresh_started_at TEXT,
      refresh_completed_at TEXT,
      status TEXT CHECK(status IN ('in_progress', 'completed', 'failed')),
      error_message TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(exchange, created_at)
    )
  `);

  console.log('  ✅ Created instruments_refresh_log table');

  // Index for fast symbol lookups by exchange + symbol
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_instruments_exchange_symbol
    ON instruments(exchange, symbol)
  `);

  console.log('  ✅ Created exchange+symbol index');

  // Index for fast token lookups
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_instruments_token
    ON instruments(token)
  `);

  console.log('  ✅ Created token index');

  // Index for instrumenttype filtering (equity, futures, options)
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_instruments_type
    ON instruments(instrumenttype)
  `);

  console.log('  ✅ Created instrumenttype index');

  // Index for option chain queries (underlying + expiry)
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_instruments_expiry
    ON instruments(symbol, expiry)
    WHERE expiry IS NOT NULL
  `);

  console.log('  ✅ Created expiry index for option chains');

  // Index for options filtering (symbol + expiry + strike)
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_instruments_options
    ON instruments(symbol, expiry, strike)
    WHERE strike IS NOT NULL
  `);

  console.log('  ✅ Created options index');

  // Index for refresh log queries (latest refresh per exchange)
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_refresh_log_exchange
    ON instruments_refresh_log(exchange, refresh_completed_at DESC)
  `);

  console.log('  ✅ Created refresh log index');

  // Full-text search index on symbol and name for fast searching
  // Note: SQLite FTS5 virtual table for full-text search capability
  await db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS instruments_fts
    USING fts5(
      symbol,
      name,
      exchange,
      instrumenttype,
      content=instruments,
      content_rowid=id
    )
  `);

  console.log('  ✅ Created full-text search index');

  // Trigger to keep FTS index in sync with instruments table (INSERT)
  await db.run(`
    CREATE TRIGGER IF NOT EXISTS instruments_fts_insert
    AFTER INSERT ON instruments
    BEGIN
      INSERT INTO instruments_fts(rowid, symbol, name, exchange, instrumenttype)
      VALUES (new.id, new.symbol, new.name, new.exchange, new.instrumenttype);
    END
  `);

  console.log('  ✅ Created FTS insert trigger');

  // Trigger to keep FTS index in sync with instruments table (UPDATE)
  await db.run(`
    CREATE TRIGGER IF NOT EXISTS instruments_fts_update
    AFTER UPDATE ON instruments
    BEGIN
      UPDATE instruments_fts
      SET symbol = new.symbol,
          name = new.name,
          exchange = new.exchange,
          instrumenttype = new.instrumenttype
      WHERE rowid = new.id;
    END
  `);

  console.log('  ✅ Created FTS update trigger');

  // Trigger to keep FTS index in sync with instruments table (DELETE)
  await db.run(`
    CREATE TRIGGER IF NOT EXISTS instruments_fts_delete
    AFTER DELETE ON instruments
    BEGIN
      DELETE FROM instruments_fts WHERE rowid = old.id;
    END
  `);

  console.log('  ✅ Created FTS delete trigger');
}

export async function down(db) {
  console.log('Rolling back migration 009: Drop instruments cache tables');

  // Drop triggers first
  await db.run('DROP TRIGGER IF EXISTS instruments_fts_delete');
  await db.run('DROP TRIGGER IF EXISTS instruments_fts_update');
  await db.run('DROP TRIGGER IF EXISTS instruments_fts_insert');

  // Drop FTS table
  await db.run('DROP TABLE IF EXISTS instruments_fts');

  // Drop indexes
  await db.run('DROP INDEX IF EXISTS idx_refresh_log_exchange');
  await db.run('DROP INDEX IF EXISTS idx_instruments_options');
  await db.run('DROP INDEX IF EXISTS idx_instruments_expiry');
  await db.run('DROP INDEX IF EXISTS idx_instruments_type');
  await db.run('DROP INDEX IF EXISTS idx_instruments_token');
  await db.run('DROP INDEX IF EXISTS idx_instruments_exchange_symbol');

  // Drop tables
  await db.run('DROP TABLE IF EXISTS instruments_refresh_log');
  await db.run('DROP TABLE IF EXISTS instruments');

  console.log('  ✅ Rolled back instruments cache');
}
