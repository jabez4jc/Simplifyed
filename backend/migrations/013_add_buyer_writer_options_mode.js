/**
 * Migration 013: Add Buyer/Writer Options Mode
 * Implements Options Mode Implementation Guide v1.4
 *
 * Adds:
 * - Operating mode (Buyer/Writer) for options trading
 * - Strike policy (FLOAT_OFS/ANCHOR_OFS) for ATM drift handling
 * - Step lots configuration for quantity increments
 * - Writer guard to prevent net-long positions when covering shorts
 * - Anchored strike tracking for ANCHOR_OFS policy
 * - Options state tracking for multi-strike position aggregation
 */

export const version = '013';
export const name = 'add_buyer_writer_options_mode';

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
  console.log('  ℹ️  Adding buyer/writer options mode configuration');

  // Operating mode: BUYER (go long premium) or WRITER (go short premium)
  await addColumnIfNotExists(
    db,
    'watchlist_symbols',
    'operating_mode',
    "TEXT DEFAULT 'BUYER' CHECK(operating_mode IN ('BUYER', 'WRITER'))"
  );

  // Strike policy: FLOAT_OFS (multiple strikes as ATM moves) or ANCHOR_OFS (pin strike)
  await addColumnIfNotExists(
    db,
    'watchlist_symbols',
    'strike_policy',
    "TEXT DEFAULT 'FLOAT_OFS' CHECK(strike_policy IN ('FLOAT_OFS', 'ANCHOR_OFS'))"
  );

  // Step lots: contracts per click (for options, multiplied by lotsize to get Qstep)
  await addColumnIfNotExists(
    db,
    'watchlist_symbols',
    'step_lots',
    'INTEGER DEFAULT 1'
  );

  // Writer guard: prevent net-long positions when covering shorts
  // If enabled, INCREASE_* actions clamp target position at 0
  await addColumnIfNotExists(
    db,
    'watchlist_symbols',
    'writer_guard_enabled',
    'BOOLEAN DEFAULT 1'
  );

  // Anchored strikes for ANCHOR_OFS policy
  // Stores the strike price pinned on first add action
  // Null means no strike anchored yet
  await addColumnIfNotExists(
    db,
    'watchlist_symbols',
    'anchored_ce_strike',
    'INTEGER'
  );

  await addColumnIfNotExists(
    db,
    'watchlist_symbols',
    'anchored_pe_strike',
    'INTEGER'
  );

  // Expiry for anchored strikes (ensures strike-expiry pairing)
  await addColumnIfNotExists(
    db,
    'watchlist_symbols',
    'anchored_expiry',
    'TEXT'
  );

  console.log('  ✅ Updated watchlist_symbols table with buyer/writer fields');

  // ==========================================
  // Create watchlist_options_state table
  // ==========================================
  // Tracks aggregated positions for FLOAT_OFS mode
  // Allows position queries across multiple strikes for a TYPE (CE/PE)
  await db.run(`
    CREATE TABLE IF NOT EXISTS watchlist_options_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      -- References
      watchlist_id INTEGER NOT NULL,
      symbol_id INTEGER NOT NULL,
      instance_id INTEGER NOT NULL,

      -- Option identification
      underlying TEXT NOT NULL,
      expiry TEXT NOT NULL,
      option_type TEXT NOT NULL CHECK(option_type IN ('CE', 'PE')),
      strike INTEGER,

      -- Position data
      net_qty INTEGER NOT NULL DEFAULT 0,
      avg_price REAL,
      realized_pnl REAL DEFAULT 0,
      unrealized_pnl REAL DEFAULT 0,

      -- Product type
      product TEXT DEFAULT 'MIS',

      -- Timestamps
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      -- Foreign keys
      FOREIGN KEY (watchlist_id) REFERENCES watchlists(id) ON DELETE CASCADE,
      FOREIGN KEY (symbol_id) REFERENCES watchlist_symbols(id) ON DELETE CASCADE,
      FOREIGN KEY (instance_id) REFERENCES instances(id) ON DELETE CASCADE,

      -- Unique constraint: one entry per instance/underlying/expiry/type/strike
      UNIQUE(instance_id, underlying, expiry, option_type, strike)
    )
  `);

  // Create indexes for fast lookups
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_options_state_instance
    ON watchlist_options_state(instance_id, watchlist_id)
  `);

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_options_state_type_aggregation
    ON watchlist_options_state(instance_id, underlying, expiry, option_type)
  `);

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_options_state_symbol
    ON watchlist_options_state(symbol_id, option_type, expiry)
  `);

  console.log('  ✅ Created watchlist_options_state table with indexes');

  // ==========================================
  // Add default settings for options trading
  // ==========================================
  // Insert default settings into application_settings table
  // These provide global defaults that can be overridden per watchlist/symbol

  // Check if application_settings table exists (from migration 012)
  const tables = await db.all(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='application_settings'"
  );

  if (tables.length > 0) {
    // Add default options trading settings
    await db.run(`
      INSERT OR IGNORE INTO application_settings (key, value, description, category, data_type)
      VALUES
      ('options.default_operating_mode', 'BUYER', 'Default operating mode for options trading (BUYER/WRITER)', 'options', 'string'),
      ('options.default_strike_policy', 'FLOAT_OFS', 'Default strike policy (FLOAT_OFS/ANCHOR_OFS)', 'options', 'string'),
      ('options.default_step_lots', '1', 'Default step lots per click for options', 'options', 'number'),
      ('options.writer_guard_enabled', 'true', 'Enable writer guard to prevent net-long positions', 'options', 'boolean'),
      ('options.allow_multi_strike', 'true', 'Allow multiple strikes in FLOAT_OFS mode', 'options', 'boolean')
    `);

    console.log('  ✅ Added 5 default options trading settings');
  } else {
    console.log('  ⚠️  application_settings table not found, skipping default settings');
  }

  console.log('  ✅ Migration 013 completed successfully');
}

export async function down(db) {
  // Drop the options state table
  await db.run('DROP TABLE IF EXISTS watchlist_options_state');
  console.log('  ✅ Dropped watchlist_options_state table');

  // Remove settings if they exist
  const tables = await db.all(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='application_settings'"
  );

  if (tables.length > 0) {
    await db.run(`
      DELETE FROM application_settings
      WHERE key IN (
        'options.default_operating_mode',
        'options.default_strike_policy',
        'options.default_step_lots',
        'options.writer_guard_enabled',
        'options.allow_multi_strike'
      )
    `);
    console.log('  ✅ Removed options trading settings');
  }

  // Note: SQLite doesn't support DROP COLUMN easily
  // Columns added to watchlist_symbols will remain but be unused
  console.log('  ⚠️  Warning: SQLite does not support DROP COLUMN');
  console.log('  ⚠️  Added columns to watchlist_symbols will remain (unused)');
  console.log('  ✅ Rollback completed');
}
