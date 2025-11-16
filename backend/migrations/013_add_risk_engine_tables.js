/**
 * Migration 013: Risk Engine Tables
 * Creates tables for server-side risk management
 *
 * Tables created:
 * - leg_state: Per-leg position tracking and risk state
 * - risk_exits: Idempotent risk exit tracking
 *
 * Purpose:
 * - Track real-time position state per leg per instance
 * - Maintain weighted average entry prices
 * - Track best favorable prices for TSL
 * - Store TP/SL/TSL state per leg
 * - Ensure idempotent risk exits
 */

export const version = '013';
export const name = 'add_risk_engine_tables';

export async function up(db) {
  // ==========================================
  // 1. Leg State Table (Position & Risk Tracking)
  // ==========================================
  await db.run(`
    CREATE TABLE IF NOT EXISTS leg_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      -- Symbol identification
      symbol TEXT NOT NULL,
      exchange TEXT NOT NULL,
      token TEXT,

      -- Classification
      index_name TEXT,
      expiry TEXT,
      option_type TEXT CHECK (option_type IN ('CE', 'PE') OR option_type IS NULL),
      strike_price REAL,
      instrument_type TEXT,

      -- Instance association
      instance_id INTEGER NOT NULL,

      -- Position tracking
      net_qty INTEGER DEFAULT 0,
      weighted_avg_entry REAL,
      total_buy_qty INTEGER DEFAULT 0,
      total_sell_qty INTEGER DEFAULT 0,
      total_buy_value REAL DEFAULT 0,
      total_sell_value REAL DEFAULT 0,

      -- Price tracking for TSL
      best_favorable_price REAL,
      last_trail_price REAL,
      current_ltp REAL,

      -- Risk configuration (from resolved intent config)
      risk_enabled BOOLEAN DEFAULT 0,
      tp_per_unit REAL,
      sl_per_unit REAL,

      -- Calculated TP/SL prices
      tp_price REAL,
      sl_price REAL,

      -- TSL state
      tsl_enabled BOOLEAN DEFAULT 0,
      tsl_trail_by REAL,
      tsl_step REAL,
      tsl_arm_after REAL,
      tsl_breakeven_after REAL,
      tsl_armed BOOLEAN DEFAULT 0,
      tsl_current_stop REAL,

      -- Scope for risk exits
      scope TEXT DEFAULT 'LEG' CHECK (scope IN ('LEG', 'TYPE', 'INDEX')),

      -- Pyramiding mode
      on_pyramid TEXT DEFAULT 'reanchor' CHECK (on_pyramid IN ('reanchor', 'scale', 'ignore')),

      -- Status
      is_active BOOLEAN DEFAULT 1,
      last_fill_at DATETIME,

      -- Timestamps
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (instance_id) REFERENCES instances(id) ON DELETE CASCADE,
      UNIQUE(symbol, exchange, instance_id)
    )
  `);

  console.log('  ✅ Created leg_state table');

  // ==========================================
  // 2. Risk Exits Table (Idempotent Exit Tracking)
  // ==========================================
  await db.run(`
    CREATE TABLE IF NOT EXISTS risk_exits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      -- Unique risk trigger identifier (UUID)
      risk_trigger_id TEXT NOT NULL UNIQUE,

      -- Associated leg
      leg_state_id INTEGER NOT NULL,

      -- Trigger details
      trigger_type TEXT NOT NULL CHECK (trigger_type IN ('TP_HIT', 'SL_HIT', 'TSL_HIT', 'MANUAL')),
      trigger_price REAL NOT NULL,
      target_price REAL,

      -- Position details at trigger
      qty_at_trigger INTEGER NOT NULL,
      entry_at_trigger REAL NOT NULL,
      pnl_per_unit REAL NOT NULL,
      total_pnl REAL NOT NULL,

      -- Execution details
      status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'executing', 'completed', 'failed')),
      exit_orders_json TEXT,
      execution_summary TEXT,

      -- Timestamps
      triggered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      executed_at DATETIME,
      completed_at DATETIME,

      FOREIGN KEY (leg_state_id) REFERENCES leg_state(id) ON DELETE CASCADE
    )
  `);

  console.log('  ✅ Created risk_exits table');

  // ==========================================
  // Create Indexes for Performance
  // ==========================================

  // leg_state indexes
  // Note: UNIQUE(symbol, exchange, instance_id) already creates an index, so idx_leg_state_symbol_exchange_instance is redundant

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_leg_state_instance_id
    ON leg_state(instance_id)
  `);

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_leg_state_risk_enabled
    ON leg_state(risk_enabled, is_active)
  `);

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_leg_state_index_expiry
    ON leg_state(index_name, expiry)
  `);

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_leg_state_updated_at
    ON leg_state(updated_at DESC)
  `);

  // risk_exits indexes
  // Note: risk_trigger_id has UNIQUE constraint, so no additional index needed

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_risk_exits_leg_state_id
    ON risk_exits(leg_state_id)
  `);

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_risk_exits_status
    ON risk_exits(status)
  `);

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_risk_exits_triggered_at
    ON risk_exits(triggered_at DESC)
  `);

  console.log('  ✅ Created indexes for risk engine tables');
}

export async function down(db) {
  // Drop indexes first
  await db.run('DROP INDEX IF EXISTS idx_risk_exits_triggered_at');
  await db.run('DROP INDEX IF EXISTS idx_risk_exits_status');
  await db.run('DROP INDEX IF EXISTS idx_risk_exits_leg_state_id');
  // Note: idx_risk_exits_risk_trigger_id was removed (redundant with UNIQUE constraint)
  await db.run('DROP INDEX IF EXISTS idx_leg_state_updated_at');
  await db.run('DROP INDEX IF EXISTS idx_leg_state_index_expiry');
  await db.run('DROP INDEX IF EXISTS idx_leg_state_risk_enabled');
  await db.run('DROP INDEX IF EXISTS idx_leg_state_instance_id');
  // Note: idx_leg_state_symbol_exchange_instance was removed (redundant with UNIQUE constraint)

  // Drop tables in reverse order (respecting foreign keys)
  await db.run('DROP TABLE IF EXISTS risk_exits');
  await db.run('DROP TABLE IF EXISTS leg_state');

  console.log('  ✅ Dropped all risk engine tables');
}
