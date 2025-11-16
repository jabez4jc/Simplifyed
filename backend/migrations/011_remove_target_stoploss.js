/**
 * Migration 011: Remove Target and Stop Loss Features
 * Removes all target/stoploss columns from instances and watchlist_symbols tables
 */

export const version = '011';
export const name = 'remove_target_stoploss';

export async function up(db) {
  // Temporarily disable foreign key constraints for table reconstruction
  await db.run('PRAGMA foreign_keys = OFF');

  // Begin transaction to ensure atomicity
  await db.run('BEGIN TRANSACTION');

  try {
    // SQLite doesn't support DROP COLUMN directly, so we need to recreate tables

    // Clean up any leftover temp tables from failed migrations
    await db.run('DROP TABLE IF EXISTS instances_new');
    await db.run('DROP TABLE IF EXISTS watchlist_symbols_new');
    await db.run('DROP TABLE IF EXISTS user_telegram_config_new');

    // ==========================================
    // 1. Recreate instances table without target columns
    // ==========================================
    await db.run(`
    CREATE TABLE instances_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      host_url TEXT NOT NULL UNIQUE,
      api_key TEXT NOT NULL,
      strategy_tag TEXT,
      broker TEXT,
      market_data_role TEXT CHECK(market_data_role IN ('none', 'primary', 'secondary')) DEFAULT 'none',

      -- Admin designation
      is_primary_admin BOOLEAN DEFAULT 0,
      is_secondary_admin BOOLEAN DEFAULT 0,
      order_placement_enabled BOOLEAN DEFAULT 1,

      -- P&L tracking
      current_balance REAL DEFAULT 0,
      realized_pnl REAL DEFAULT 0,
      unrealized_pnl REAL DEFAULT 0,
      total_pnl REAL DEFAULT 0,

      -- Status
      is_active BOOLEAN DEFAULT 1,
      is_analyzer_mode BOOLEAN DEFAULT 0,
      health_status TEXT DEFAULT 'unknown',
      last_health_check DATETIME,
      last_ping_at DATETIME,

      -- Timestamps
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

    // Copy data from old table (excluding target_profit and target_loss)
    // Map 'disabled' to 'none' for market_data_role consistency
    await db.run(`
      INSERT INTO instances_new (
        id, name, host_url, api_key, strategy_tag, broker, market_data_role,
        is_primary_admin, is_secondary_admin, order_placement_enabled,
        current_balance, realized_pnl, unrealized_pnl, total_pnl,
        is_active, is_analyzer_mode, health_status, last_health_check, last_ping_at,
        created_at, last_updated
      )
      SELECT
        id, name, host_url, api_key, strategy_tag, broker,
        CASE WHEN market_data_role = 'disabled' THEN 'none' ELSE market_data_role END,
        is_primary_admin, is_secondary_admin, order_placement_enabled,
        current_balance, realized_pnl, unrealized_pnl, total_pnl,
        is_active, is_analyzer_mode, health_status, last_health_check, last_ping_at,
        created_at, last_updated
      FROM instances
    `);

    // Drop old table and rename new one
    await db.run('DROP TABLE instances');
    await db.run('ALTER TABLE instances_new RENAME TO instances');

    // Recreate indexes for instances table
    await db.run('CREATE INDEX IF NOT EXISTS idx_instances_is_active ON instances(is_active)');
    await db.run('CREATE INDEX IF NOT EXISTS idx_instances_is_primary_admin ON instances(is_primary_admin)');
    await db.run('CREATE INDEX IF NOT EXISTS idx_instances_is_secondary_admin ON instances(is_secondary_admin)');
    await db.run('CREATE INDEX IF NOT EXISTS idx_instances_health_status ON instances(health_status)');

    // ==========================================
    // 2. Recreate watchlist_symbols table without target/stoploss columns
    // ==========================================
    await db.run(`
      CREATE TABLE watchlist_symbols_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        watchlist_id INTEGER NOT NULL,

        -- Symbol info
        exchange TEXT NOT NULL,
        symbol TEXT NOT NULL,
        token TEXT,
        lot_size INTEGER DEFAULT 1,

        -- Quantity configuration
        qty_type TEXT DEFAULT 'FIXED',
        qty_value INTEGER DEFAULT 1,

        -- Order configuration
        product_type TEXT DEFAULT 'MIS',
        order_type TEXT DEFAULT 'MARKET',

        -- Position limits
        max_position_size INTEGER,
        max_instances INTEGER,

        -- Tradability configuration
        tradable_equity BOOLEAN DEFAULT 1,
        tradable_futures BOOLEAN DEFAULT 0,
        tradable_options BOOLEAN DEFAULT 0,

        -- F&O metadata
        underlying_symbol TEXT,

        -- Options configuration
        options_strike_selection TEXT DEFAULT 'ITM2',
        options_expiry_mode TEXT DEFAULT 'AUTO',
        options_last_expiry_refresh DATETIME,

        -- Trading symbol
        trading_symbol TEXT,

        -- Symbol metadata (from symbol validation/search API)
        symbol_type TEXT,
        expiry TEXT,
        strike REAL,
        option_type TEXT,
        instrumenttype TEXT,
        name TEXT,
        tick_size REAL,
        brsymbol TEXT,
        brexchange TEXT,

        -- Status
        is_enabled BOOLEAN DEFAULT 1,

        -- Timestamps
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

        FOREIGN KEY (watchlist_id) REFERENCES watchlists (id) ON DELETE CASCADE
      )
    `);

    // Copy data from old table (excluding target_type, target_value, sl_type, sl_value, ts_type, ts_value, trailing_activation_type, trailing_activation_value)
    await db.run(`
      INSERT INTO watchlist_symbols_new (
        id, watchlist_id, exchange, symbol, token, lot_size,
        qty_type, qty_value, product_type, order_type,
        max_position_size, max_instances,
        tradable_equity, tradable_futures, tradable_options,
        underlying_symbol,
        options_strike_selection, options_expiry_mode, options_last_expiry_refresh,
        trading_symbol,
        symbol_type, expiry, strike, option_type, instrumenttype, name, tick_size, brsymbol, brexchange,
        is_enabled, created_at, updated_at
      )
      SELECT
        id, watchlist_id, exchange, symbol, token, lot_size,
        qty_type, qty_value, product_type, order_type,
        max_position_size, max_instances,
        tradable_equity, tradable_futures, tradable_options,
        underlying_symbol,
        options_strike_selection, options_expiry_mode, options_last_expiry_refresh,
        trading_symbol,
        symbol_type, expiry, strike, option_type, instrumenttype, name, tick_size, brsymbol, brexchange,
        is_enabled, created_at, updated_at
      FROM watchlist_symbols
    `);

    // Drop old table and rename new one
    await db.run('DROP TABLE watchlist_symbols');
    await db.run('ALTER TABLE watchlist_symbols_new RENAME TO watchlist_symbols');

    // Recreate indexes for watchlist_symbols table
    await db.run('CREATE INDEX IF NOT EXISTS idx_watchlist_symbols_watchlist_id ON watchlist_symbols(watchlist_id)');
    await db.run('CREATE INDEX IF NOT EXISTS idx_watchlist_symbols_exchange_symbol ON watchlist_symbols(exchange, symbol)');
    await db.run('CREATE INDEX IF NOT EXISTS idx_watchlist_symbols_is_enabled ON watchlist_symbols(is_enabled)');

    // ==========================================
    // 3. Recreate user_telegram_config without notify_on_target
    // ==========================================
    await db.run(`
      CREATE TABLE user_telegram_config_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL UNIQUE,

        -- Telegram details
        telegram_chat_id TEXT,
        telegram_username TEXT,
        linking_code TEXT UNIQUE,
        linked_at DATETIME,

        -- Notification preferences
        enabled BOOLEAN DEFAULT 1,
        notify_on_sl BOOLEAN DEFAULT 1,
        notify_on_tsl BOOLEAN DEFAULT 1,
        notify_on_error BOOLEAN DEFAULT 1,
        silent_mode BOOLEAN DEFAULT 0,

        -- Status
        is_active BOOLEAN DEFAULT 1,
        last_message_at DATETIME,

        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      )
    `);

    // Copy data from old table (excluding notify_on_target)
    await db.run(`
      INSERT INTO user_telegram_config_new (
        id, user_id, telegram_chat_id, telegram_username, linking_code, linked_at,
        enabled, notify_on_sl, notify_on_tsl, notify_on_error, silent_mode,
        is_active, last_message_at, created_at, updated_at
      )
      SELECT
        id, user_id, telegram_chat_id, telegram_username, linking_code, linked_at,
        enabled, notify_on_sl, notify_on_tsl, notify_on_error, silent_mode,
        is_active, last_message_at, created_at, updated_at
      FROM user_telegram_config
    `);

    // Drop old table and rename new one
    await db.run('DROP TABLE user_telegram_config');
    await db.run('ALTER TABLE user_telegram_config_new RENAME TO user_telegram_config');

      // Recreate indexes
    await db.run('CREATE INDEX IF NOT EXISTS idx_telegram_config_user ON user_telegram_config(user_id)');

    console.log('  ✅ Removed target/stoploss columns from all tables');

    // Commit transaction
    await db.run('COMMIT');

    // Re-enable foreign key constraints
    await db.run('PRAGMA foreign_keys = ON');
  } catch (error) {
    // Rollback on error
    await db.run('ROLLBACK');
    await db.run('PRAGMA foreign_keys = ON');
    console.error('  ❌ Migration failed, rolling back:', error.message);
    throw error;
  }
}

export async function down(db) {
  // This migration is intentionally destructive and difficult to reverse
  // To rollback, you would need to restore the previous schema with target columns
  // and re-add the columns (data would be lost)

  console.log('  ⚠️  Rollback of target/stoploss removal not implemented (data would be lost)');
  throw new Error('Rollback not supported for this migration - please restore from backup if needed');
}
