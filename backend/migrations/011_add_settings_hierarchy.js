/**
 * Migration 011: Settings Hierarchy Tables
 * Creates tables for 6-tier settings precedence system
 *
 * Tables created:
 * - global_defaults (singleton)
 * - index_profiles (per index: NIFTY, BANKNIFTY, etc.)
 * - watchlist_overrides (per watchlist, optional per index)
 * - user_defaults (per user)
 * - symbol_overrides (per direct symbol/future)
 * - config_audit (append-only audit log)
 *
 * Precedence: Global → Index → Watchlist → User → Symbol → Per-Click
 */

export const version = '011';
export const name = 'add_settings_hierarchy';

export async function up(db) {
  // ==========================================
  // 1. Global Defaults (Singleton Table)
  // ==========================================
  await db.run(`
    CREATE TABLE IF NOT EXISTS global_defaults (
      id INTEGER PRIMARY KEY CHECK (id = 1),

      -- Quote refresh
      ltp_refresh_seconds INTEGER DEFAULT 5,

      -- Default strike policy
      default_strike_policy TEXT DEFAULT 'FLOAT_OFS' CHECK (default_strike_policy IN ('FLOAT_OFS', 'ANCHOR_OFS')),

      -- Default step sizes
      default_step_lots INTEGER DEFAULT 1,
      default_step_contracts INTEGER DEFAULT 1,

      -- Risk per-unit (nullable = no default risk)
      tp_per_unit REAL,
      sl_per_unit REAL,

      -- Trailing stop loss
      tsl_enabled BOOLEAN DEFAULT 0,
      tsl_trail_by REAL,
      tsl_step REAL,
      tsl_arm_after REAL,
      tsl_breakeven_after REAL,

      -- Trading flags
      disallow_auto_reverse BOOLEAN DEFAULT 0,

      -- Timestamps
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log('  ✅ Created global_defaults table');

  // ==========================================
  // 2. Index Profiles (Per Index Configuration)
  // ==========================================
  await db.run(`
    CREATE TABLE IF NOT EXISTS index_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      -- Index identification
      index_name TEXT NOT NULL UNIQUE,
      exchange_segment TEXT NOT NULL,

      -- Index-specific settings
      strike_step INTEGER,
      risk_anchor_mode TEXT DEFAULT 'GLOBAL' CHECK (risk_anchor_mode IN ('GLOBAL', 'PER_INSTANCE')),

      -- UI defaults
      default_offset TEXT DEFAULT 'ATM',
      default_product TEXT DEFAULT 'MIS' CHECK (default_product IN ('MIS', 'NRML', 'CNC')),

      -- Risk overrides (nullable = inherit from global)
      tp_per_unit REAL,
      sl_per_unit REAL,
      tsl_enabled BOOLEAN,
      tsl_trail_by REAL,
      tsl_step REAL,
      tsl_arm_after REAL,
      tsl_breakeven_after REAL,

      -- Trading overrides
      step_lots INTEGER,
      disallow_auto_reverse BOOLEAN,

      -- Timestamps
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log('  ✅ Created index_profiles table');

  // ==========================================
  // 3. Watchlist Overrides
  // ==========================================
  await db.run(`
    CREATE TABLE IF NOT EXISTS watchlist_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      watchlist_id INTEGER NOT NULL,
      index_name TEXT,

      -- Optional overrides (nullable = inherit)
      strike_policy TEXT CHECK (strike_policy IN ('FLOAT_OFS', 'ANCHOR_OFS') OR strike_policy IS NULL),
      step_lots INTEGER,
      step_contracts INTEGER,

      -- Risk overrides
      tp_per_unit REAL,
      sl_per_unit REAL,
      tsl_enabled BOOLEAN,
      tsl_trail_by REAL,
      tsl_step REAL,
      tsl_arm_after REAL,
      tsl_breakeven_after REAL,

      -- Trading overrides
      disallow_auto_reverse BOOLEAN,

      -- Timestamps
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (watchlist_id) REFERENCES watchlists(id) ON DELETE CASCADE,
      UNIQUE(watchlist_id, index_name)
    )
  `);

  console.log('  ✅ Created watchlist_overrides table');

  // ==========================================
  // 4. User Defaults
  // ==========================================
  await db.run(`
    CREATE TABLE IF NOT EXISTS user_defaults (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      user_id INTEGER NOT NULL UNIQUE,

      -- Optional overrides (nullable = inherit)
      strike_policy TEXT CHECK (strike_policy IN ('FLOAT_OFS', 'ANCHOR_OFS') OR strike_policy IS NULL),
      step_lots INTEGER,
      step_contracts INTEGER,

      -- Risk overrides
      tp_per_unit REAL,
      sl_per_unit REAL,
      tsl_enabled BOOLEAN,
      tsl_trail_by REAL,
      tsl_step REAL,
      tsl_arm_after REAL,
      tsl_breakeven_after REAL,

      -- Trading overrides
      disallow_auto_reverse BOOLEAN,

      -- Timestamps
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  console.log('  ✅ Created user_defaults table');

  // ==========================================
  // 5. Symbol Overrides (For Direct Symbols/Futures)
  // ==========================================
  await db.run(`
    CREATE TABLE IF NOT EXISTS symbol_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      symbol TEXT NOT NULL,
      exchange TEXT NOT NULL,

      -- Optional overrides (nullable = inherit)
      step_contracts INTEGER,

      -- Risk overrides
      tp_per_unit REAL,
      sl_per_unit REAL,
      tsl_enabled BOOLEAN,
      tsl_trail_by REAL,
      tsl_step REAL,
      tsl_arm_after REAL,
      tsl_breakeven_after REAL,

      -- Trading overrides
      disallow_auto_reverse BOOLEAN,

      -- Timestamps
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      UNIQUE(symbol, exchange)
    )
  `);

  console.log('  ✅ Created symbol_overrides table');

  // ==========================================
  // 6. Config Audit Log
  // ==========================================
  await db.run(`
    CREATE TABLE IF NOT EXISTS config_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      -- Scope of change
      scope TEXT NOT NULL CHECK (scope IN ('GLOBAL', 'INDEX', 'WATCHLIST', 'USER', 'SYMBOL')),
      scope_key TEXT,

      -- Change details
      changed_json TEXT NOT NULL,

      -- Who and when
      changed_by INTEGER,
      changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (changed_by) REFERENCES users(id)
    )
  `);

  console.log('  ✅ Created config_audit table');

  // ==========================================
  // Create Indexes for Performance
  // ==========================================
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_watchlist_overrides_watchlist_id
    ON watchlist_overrides(watchlist_id)
  `);

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_config_audit_scope
    ON config_audit(scope, scope_key)
  `);

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_config_audit_changed_at
    ON config_audit(changed_at DESC)
  `);

  console.log('  ✅ Created indexes for settings tables');
}

export async function down(db) {
  // Drop indexes first
  await db.run('DROP INDEX IF EXISTS idx_config_audit_changed_at');
  await db.run('DROP INDEX IF EXISTS idx_config_audit_scope');
  await db.run('DROP INDEX IF EXISTS idx_watchlist_overrides_watchlist_id');

  // Drop tables in reverse order (respecting foreign keys)
  await db.run('DROP TABLE IF EXISTS config_audit');
  await db.run('DROP TABLE IF EXISTS symbol_overrides');
  await db.run('DROP TABLE IF EXISTS user_defaults');
  await db.run('DROP TABLE IF EXISTS watchlist_overrides');
  await db.run('DROP TABLE IF EXISTS index_profiles');
  await db.run('DROP TABLE IF EXISTS global_defaults');

  console.log('  ✅ Dropped all settings hierarchy tables');
}
