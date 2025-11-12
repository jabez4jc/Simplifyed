/**
 * Migration 007: Add Tradability and Options Configuration
 * Adds fields to support:
 * - Symbol tradability (equity, futures, options)
 * - F&O eligibility metadata
 * - Options configuration (ITM/ATM/OTM, expiry auto-refresh)
 */

export const version = '007';
export const name = 'add_tradability_and_options_config';

/**
 * Helper function to check if column exists
 */
async function columnExists(db, tableName, columnName) {
  const columns = await db.all(`PRAGMA table_info(${tableName})`);
  return columns.some(col => col.name === columnName);
}

/**
 * Helper function to add column if it doesn't exist
 */
async function addColumnIfNotExists(db, tableName, columnName, columnDef) {
  const exists = await columnExists(db, tableName, columnName);
  if (!exists) {
    await db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`);
    console.log(`    ✓ Added ${columnName}`);
  } else {
    console.log(`    ⊙ ${columnName} already exists (skipping)`);
  }
}

export async function up(db) {
  // ==========================================
  // Update watchlist_symbols table
  // ==========================================
  console.log('  ℹ️  Adding tradability and options configuration fields');

  // Add tradability flags
  await addColumnIfNotExists(db, 'watchlist_symbols', 'tradable_equity', 'BOOLEAN DEFAULT 1');
  await addColumnIfNotExists(db, 'watchlist_symbols', 'tradable_futures', 'BOOLEAN DEFAULT 0');
  await addColumnIfNotExists(db, 'watchlist_symbols', 'tradable_options', 'BOOLEAN DEFAULT 0');

  // Add F&O metadata
  await addColumnIfNotExists(db, 'watchlist_symbols', 'underlying_symbol', 'TEXT');

  // Add options configuration
  await addColumnIfNotExists(db, 'watchlist_symbols', 'options_strike_selection', "TEXT DEFAULT 'ITM2'");
  await addColumnIfNotExists(db, 'watchlist_symbols', 'options_expiry_mode', "TEXT DEFAULT 'AUTO'");
  await addColumnIfNotExists(db, 'watchlist_symbols', 'options_last_expiry_refresh', 'DATETIME');

  // Add trading symbol
  await addColumnIfNotExists(db, 'watchlist_symbols', 'trading_symbol', 'TEXT');

  console.log('  ✅ Updated watchlist_symbols table');

  // ==========================================
  // Create options_cache table for strike data
  // ==========================================
  await db.run(`
    CREATE TABLE IF NOT EXISTS options_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      underlying TEXT NOT NULL,
      expiry TEXT NOT NULL,
      strike REAL NOT NULL,
      option_type TEXT NOT NULL CHECK(option_type IN ('CE', 'PE')),

      -- Symbol details
      exchange TEXT NOT NULL,
      symbol TEXT NOT NULL,
      trading_symbol TEXT NOT NULL,
      lot_size INTEGER DEFAULT 1,
      tick_size REAL,

      -- Metadata
      instrument_type TEXT,
      token TEXT,

      -- Cache info
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      UNIQUE(underlying, expiry, strike, option_type, exchange)
    )
  `);

  // Create indexes for fast lookups
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_options_cache_lookup
    ON options_cache(underlying, expiry, option_type, strike)
  `);

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_options_cache_symbol
    ON options_cache(exchange, symbol)
  `);

  console.log('  ✅ Created options_cache table with indexes');

  // ==========================================
  // Create expiry_calendar table
  // ==========================================
  await db.run(`
    CREATE TABLE IF NOT EXISTS expiry_calendar (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      underlying TEXT NOT NULL,
      exchange TEXT NOT NULL,
      expiry_date TEXT NOT NULL,

      -- Expiry metadata
      is_weekly BOOLEAN DEFAULT 0,
      is_monthly BOOLEAN DEFAULT 0,
      is_quarterly BOOLEAN DEFAULT 0,
      day_of_week TEXT,

      -- Status
      is_active BOOLEAN DEFAULT 1,

      -- Cache info
      fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      UNIQUE(underlying, exchange, expiry_date)
    )
  `);

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_expiry_calendar_lookup
    ON expiry_calendar(underlying, exchange, is_active, expiry_date)
  `);

  console.log('  ✅ Created expiry_calendar table with indexes');

  // ==========================================
  // Create quick_orders table for audit trail
  // ==========================================
  await db.run(`
    CREATE TABLE IF NOT EXISTS quick_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      watchlist_id INTEGER,
      symbol_id INTEGER,
      instance_id INTEGER NOT NULL,

      -- Order details
      underlying TEXT NOT NULL,
      symbol TEXT NOT NULL,
      exchange TEXT NOT NULL,
      action TEXT NOT NULL,
      trade_mode TEXT NOT NULL CHECK(trade_mode IN ('EQUITY', 'FUTURES', 'OPTIONS')),
      options_leg TEXT,

      -- Execution details
      quantity INTEGER NOT NULL,
      product TEXT NOT NULL,
      order_type TEXT NOT NULL,
      price REAL,
      trigger_price REAL,

      -- Options-specific
      resolved_symbol TEXT,
      strike_price REAL,
      option_type TEXT,
      expiry_date TEXT,

      -- Status
      status TEXT NOT NULL DEFAULT 'pending',
      order_id TEXT,
      broker_order_id TEXT,
      message TEXT,
      error_details TEXT,

      -- Metadata
      reason TEXT DEFAULT 'watchlist_quick_action',
      metadata TEXT,

      -- Timestamps
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (watchlist_id) REFERENCES watchlists (id) ON DELETE SET NULL,
      FOREIGN KEY (symbol_id) REFERENCES watchlist_symbols (id) ON DELETE SET NULL,
      FOREIGN KEY (instance_id) REFERENCES instances (id) ON DELETE CASCADE
    )
  `);

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_quick_orders_instance
    ON quick_orders(instance_id, status, created_at)
  `);

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_quick_orders_symbol
    ON quick_orders(symbol_id, trade_mode, created_at)
  `);

  console.log('  ✅ Created quick_orders table with indexes');
}

export async function down(db) {
  // Drop new tables
  await db.run('DROP TABLE IF EXISTS quick_orders');
  await db.run('DROP TABLE IF EXISTS expiry_calendar');
  await db.run('DROP TABLE IF EXISTS options_cache');

  // Note: SQLite doesn't support DROP COLUMN easily
  // In production, you would create a new table without these columns
  // and migrate data, but for development, we'll leave them
  console.log('  ⚠️  Warning: SQLite does not support DROP COLUMN');
  console.log('  ✅ Dropped new tables (column removal requires manual migration)');
}
