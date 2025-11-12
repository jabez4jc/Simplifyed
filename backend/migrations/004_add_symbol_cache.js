/**
 * Migration 004: Add Symbol Cache Table
 * Creates table for caching OpenAlgo symbol data with 7-day TTL
 */

export const version = '004';
export const name = 'add_symbol_cache';

export async function up(db) {
  console.log('Running migration 004: Add symbol cache table');

  // Create symbol_cache table
  await db.run(`
    CREATE TABLE IF NOT EXISTS symbol_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exchange TEXT NOT NULL,
      symbol TEXT NOT NULL,
      token TEXT,
      name TEXT,
      instrumenttype TEXT,
      lotsize INTEGER DEFAULT 1,
      tick_size REAL,
      expiry TEXT,
      strike REAL,
      option_type TEXT,
      brsymbol TEXT,
      brexchange TEXT,
      symbol_type TEXT CHECK(symbol_type IN ('EQUITY', 'FUTURES', 'OPTIONS', 'UNKNOWN')),
      cached_at TEXT DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(exchange, symbol)
    )
  `);

  console.log('  ✅ Created symbol_cache table');

  // Create index for fast lookups
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_symbol_cache_lookup
    ON symbol_cache(exchange, symbol)
  `);

  console.log('  ✅ Created lookup index');

  // Create index for cache expiry cleanup
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_symbol_cache_expiry
    ON symbol_cache(cached_at)
  `);

  console.log('  ✅ Created expiry index');

  // Create index for symbol type filtering
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_symbol_cache_type
    ON symbol_cache(symbol_type)
  `);

  console.log('  ✅ Created symbol type index');
}

export async function down(db) {
  console.log('Rolling back migration 004: Drop symbol cache table');

  await db.run('DROP INDEX IF EXISTS idx_symbol_cache_type');
  await db.run('DROP INDEX IF EXISTS idx_symbol_cache_expiry');
  await db.run('DROP INDEX IF EXISTS idx_symbol_cache_lookup');
  await db.run('DROP TABLE IF EXISTS symbol_cache');

  console.log('  ✅ Rolled back symbol cache');
}
