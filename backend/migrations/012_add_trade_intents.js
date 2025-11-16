/**
 * Migration 012: Trade Intents Table
 * Creates table for tracking trade intentions with resolved config snapshots
 *
 * Purpose:
 * - Audit trail for all trade decisions
 * - Snapshot of effective config at time of trade
 * - Supports idempotency via intent_id
 * - Links orders to their originating intent
 */

export const version = '012';
export const name = 'add_trade_intents';

export async function up(db) {
  // ==========================================
  // Trade Intents Table
  // ==========================================
  await db.run(`
    CREATE TABLE IF NOT EXISTS trade_intents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      -- Unique intent identifier (UUID)
      intent_id TEXT NOT NULL UNIQUE,

      -- User and watchlist context
      user_id INTEGER NOT NULL,
      watchlist_id INTEGER,

      -- Trade parameters
      trade_mode TEXT NOT NULL CHECK (trade_mode IN ('OPTIONS', 'FUTURES', 'DIRECT')),
      index_name TEXT,
      symbol TEXT NOT NULL,
      exchange TEXT NOT NULL,

      -- Options-specific fields
      mode TEXT CHECK (mode IN ('Buyer', 'Writer') OR mode IS NULL),
      expiry TEXT,
      strike_price REAL,
      strike_policy TEXT CHECK (strike_policy IN ('FLOAT_OFS', 'ANCHOR_OFS') OR strike_policy IS NULL),
      offset TEXT,
      option_type TEXT CHECK (option_type IN ('CE', 'PE') OR option_type IS NULL),

      -- Action details
      action TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      step_lots INTEGER,
      step_contracts INTEGER,
      lotsize INTEGER,

      -- Position tracking
      target_position INTEGER NOT NULL,
      current_position INTEGER DEFAULT 0,
      delta INTEGER NOT NULL,

      -- Resolved configuration snapshot (JSON)
      resolved_config_json TEXT NOT NULL,

      -- Status
      status TEXT DEFAULT 'created' CHECK (status IN ('created', 'executing', 'completed', 'failed', 'cancelled')),
      execution_summary TEXT,

      -- Timestamps
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (watchlist_id) REFERENCES watchlists(id) ON DELETE SET NULL
    )
  `);

  console.log('  ✅ Created trade_intents table');

  // ==========================================
  // Create Indexes for Performance
  // ==========================================
  // Note: intent_id already has UNIQUE constraint, so no additional index needed

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_trade_intents_user_id
    ON trade_intents(user_id)
  `);

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_trade_intents_watchlist_id
    ON trade_intents(watchlist_id)
  `);

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_trade_intents_created_at
    ON trade_intents(created_at DESC)
  `);

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_trade_intents_status
    ON trade_intents(status)
  `);

  console.log('  ✅ Created indexes for trade_intents table');

  // ==========================================
  // Add intent_id to watchlist_orders for tracking
  // ==========================================
  // Check if column already exists (SQLite doesn't support DROP COLUMN, so it may persist after rollback)
  const columns = await db.all(`PRAGMA table_info(watchlist_orders)`);
  const hasIntentId = columns.some(col => col.name === 'intent_id');

  if (!hasIntentId) {
    await db.run(`
      ALTER TABLE watchlist_orders ADD COLUMN intent_id TEXT
    `);
    console.log('  ✅ Added intent_id column to watchlist_orders');
  } else {
    console.log('  ⏭️  intent_id column already exists, skipping');
  }

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_watchlist_orders_intent_id
    ON watchlist_orders(intent_id)
  `);
}

export async function down(db) {
  // Drop indexes first
  await db.run('DROP INDEX IF EXISTS idx_watchlist_orders_intent_id');
  await db.run('DROP INDEX IF EXISTS idx_trade_intents_status');
  await db.run('DROP INDEX IF EXISTS idx_trade_intents_created_at');
  await db.run('DROP INDEX IF EXISTS idx_trade_intents_watchlist_id');
  await db.run('DROP INDEX IF EXISTS idx_trade_intents_user_id');
  // Note: idx_trade_intents_intent_id was removed (redundant with UNIQUE constraint)

  // Drop the trade_intents table
  await db.run('DROP TABLE IF EXISTS trade_intents');

  // Note: We cannot drop the intent_id column from watchlist_orders in SQLite
  // SQLite does not support ALTER TABLE DROP COLUMN
  // The column will remain but will be unused if migration is rolled back
  console.log('  ⚠️  Note: intent_id column in watchlist_orders cannot be removed (SQLite limitation)');

  console.log('  ✅ Dropped trade_intents table');
}
