/**
 * Migration 005: Add INDEX Symbol Type
 * Adds INDEX to allowed symbol types for index symbols (NSE_INDEX, BSE_INDEX)
 */

export const version = '005';
export const name = 'add_index_symbol_type';

export async function up(db) {
  console.log('Running migration 005: Add INDEX symbol type');

  // SQLite doesn't support ALTER TABLE MODIFY COLUMN with CHECK constraints
  // So we need to recreate the table with the new constraint

  // Start transaction to prevent data loss if any step fails
  await db.run('BEGIN TRANSACTION');

  try {
    // Step 1: Create new table with updated CHECK constraint
    await db.run(`
      CREATE TABLE symbol_cache_new (
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
        symbol_type TEXT CHECK(symbol_type IN ('EQUITY', 'FUTURES', 'OPTIONS', 'INDEX', 'UNKNOWN')),
        cached_at TEXT DEFAULT CURRENT_TIMESTAMP,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(exchange, symbol)
      )
    `);

    console.log('  ✅ Created new symbol_cache table with INDEX type');

    // Step 2: Copy data from old table to new table
    await db.run(`
      INSERT INTO symbol_cache_new
      SELECT * FROM symbol_cache
    `);

    console.log('  ✅ Copied existing data');

    // Step 3: Drop old table
    await db.run('DROP TABLE symbol_cache');

    console.log('  ✅ Dropped old table');

    // Step 4: Rename new table to original name
    await db.run('ALTER TABLE symbol_cache_new RENAME TO symbol_cache');

    console.log('  ✅ Renamed new table');

    // Step 5: Recreate indexes
    await db.run(`
      CREATE INDEX IF NOT EXISTS idx_symbol_cache_lookup
      ON symbol_cache(exchange, symbol)
    `);

    await db.run(`
      CREATE INDEX IF NOT EXISTS idx_symbol_cache_expiry
      ON symbol_cache(cached_at)
    `);

    await db.run(`
      CREATE INDEX IF NOT EXISTS idx_symbol_cache_type
      ON symbol_cache(symbol_type)
    `);

    console.log('  ✅ Recreated indexes');

    // Commit transaction
    await db.run('COMMIT');
  } catch (error) {
    // Rollback on error to prevent data loss
    await db.run('ROLLBACK');
    console.error('  ❌ Migration failed, rolled back changes');
    throw error;
  }
}

export async function down(db) {
  console.log('Rolling back migration 005: Remove INDEX symbol type');

  // Start transaction to prevent data loss if any step fails
  await db.run('BEGIN TRANSACTION');

  try {
    // Recreate table without INDEX type
    await db.run(`
      CREATE TABLE symbol_cache_new (
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

    // Update INDEX types to UNKNOWN before copying
    await db.run(`
      INSERT INTO symbol_cache_new
      SELECT
        id, exchange, symbol, token, name, instrumenttype, lotsize, tick_size,
        expiry, strike, option_type, brsymbol, brexchange,
        CASE WHEN symbol_type = 'INDEX' THEN 'UNKNOWN' ELSE symbol_type END as symbol_type,
        cached_at, created_at
      FROM symbol_cache
    `);

    await db.run('DROP TABLE symbol_cache');
    await db.run('ALTER TABLE symbol_cache_new RENAME TO symbol_cache');

    // Recreate indexes
    await db.run(`
      CREATE INDEX IF NOT EXISTS idx_symbol_cache_lookup
      ON symbol_cache(exchange, symbol)
    `);

    await db.run(`
      CREATE INDEX IF NOT EXISTS idx_symbol_cache_expiry
      ON symbol_cache(cached_at)
    `);

    await db.run(`
      CREATE INDEX IF NOT EXISTS idx_symbol_cache_type
      ON symbol_cache(symbol_type)
    `);

    console.log('  ✅ Rolled back INDEX symbol type');

    // Commit transaction
    await db.run('COMMIT');
  } catch (error) {
    // Rollback on error to prevent data loss
    await db.run('ROLLBACK');
    console.error('  ❌ Rollback failed, reverted changes');
    throw error;
  }
}
