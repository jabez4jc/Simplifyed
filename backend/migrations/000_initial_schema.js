/**
 * Migration 000: Initial Schema
 * Creates all core tables for Simplifyed Admin
 */

export const version = '000';
export const name = 'initial_schema';

export async function up(db) {
  // ==========================================
  // Users Table
  // ==========================================
  await db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      is_admin BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ==========================================
  // Instances Table
  // ==========================================
  await db.run(`
    CREATE TABLE IF NOT EXISTS instances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      host_url TEXT NOT NULL UNIQUE,
      api_key TEXT NOT NULL,
      strategy_tag TEXT,

      -- Admin designation
      is_primary_admin BOOLEAN DEFAULT 0,
      is_secondary_admin BOOLEAN DEFAULT 0,
      order_placement_enabled BOOLEAN DEFAULT 1,

      -- Risk management
      target_profit REAL DEFAULT 5000,
      target_loss REAL DEFAULT 2000,

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

  // ==========================================
  // Watchlists Table
  // ==========================================
  await db.run(`
    CREATE TABLE IF NOT EXISTS watchlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      is_active BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ==========================================
  // Watchlist Symbols Table
  // ==========================================
  await db.run(`
    CREATE TABLE IF NOT EXISTS watchlist_symbols (
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

      -- Target configuration
      target_type TEXT DEFAULT 'NONE',
      target_value REAL,

      -- Stop loss configuration
      sl_type TEXT DEFAULT 'NONE',
      sl_value REAL,

      -- Trailing stop loss
      ts_type TEXT DEFAULT 'NONE',
      ts_value REAL,
      trailing_activation_type TEXT DEFAULT 'IMMEDIATE',
      trailing_activation_value REAL,

      -- Position limits
      max_position_size INTEGER,
      max_instances INTEGER,

      -- Status
      is_enabled BOOLEAN DEFAULT 1,

      -- Timestamps
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (watchlist_id) REFERENCES watchlists (id) ON DELETE CASCADE
    )
  `);

  // ==========================================
  // Watchlist Instances Junction Table
  // ==========================================
  await db.run(`
    CREATE TABLE IF NOT EXISTS watchlist_instances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      watchlist_id INTEGER NOT NULL,
      instance_id INTEGER NOT NULL,
      assigned_by TEXT,
      assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (watchlist_id) REFERENCES watchlists (id) ON DELETE CASCADE,
      FOREIGN KEY (instance_id) REFERENCES instances (id) ON DELETE CASCADE,
      UNIQUE(watchlist_id, instance_id)
    )
  `);

  // ==========================================
  // Watchlist Orders Table
  // ==========================================
  await db.run(`
    CREATE TABLE IF NOT EXISTS watchlist_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      watchlist_id INTEGER NOT NULL,
      instance_id INTEGER NOT NULL,
      symbol_id INTEGER,

      -- Order details
      exchange TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      order_type TEXT NOT NULL,
      product_type TEXT NOT NULL,
      price REAL,
      trigger_price REAL,

      -- Status tracking
      status TEXT NOT NULL DEFAULT 'pending',
      order_id TEXT,
      broker_order_id TEXT,
      message TEXT,
      metadata TEXT,

      -- Timestamps
      placed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (watchlist_id) REFERENCES watchlists (id) ON DELETE CASCADE,
      FOREIGN KEY (instance_id) REFERENCES instances (id) ON DELETE CASCADE,
      FOREIGN KEY (symbol_id) REFERENCES watchlist_symbols (id) ON DELETE SET NULL
    )
  `);

  // ==========================================
  // Watchlist Positions Table
  // ==========================================
  await db.run(`
    CREATE TABLE IF NOT EXISTS watchlist_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      watchlist_id INTEGER NOT NULL,
      instance_id INTEGER NOT NULL,
      symbol_id INTEGER,

      -- Position details
      exchange TEXT NOT NULL,
      symbol TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      average_price REAL NOT NULL,
      current_price REAL,

      -- P&L
      realized_pnl REAL DEFAULT 0,
      unrealized_pnl REAL DEFAULT 0,

      -- Status
      status TEXT DEFAULT 'OPEN',
      is_closed BOOLEAN DEFAULT 0,

      -- Timestamps
      entered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      exited_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (watchlist_id) REFERENCES watchlists (id) ON DELETE CASCADE,
      FOREIGN KEY (instance_id) REFERENCES instances (id) ON DELETE CASCADE,
      FOREIGN KEY (symbol_id) REFERENCES watchlist_symbols (id) ON DELETE SET NULL
    )
  `);

  // ==========================================
  // Market Data Table (for quotes caching)
  // ==========================================
  await db.run(`
    CREATE TABLE IF NOT EXISTS market_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exchange TEXT NOT NULL,
      symbol TEXT NOT NULL,
      token TEXT,

      -- Price data
      ltp REAL,
      open REAL,
      high REAL,
      low REAL,
      close REAL,
      volume INTEGER,

      -- Change
      change REAL,
      change_percent REAL,

      -- Timestamps
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      UNIQUE(exchange, symbol)
    )
  `);

  // ==========================================
  // System Alerts Table
  // ==========================================
  await db.run(`
    CREATE TABLE IF NOT EXISTS system_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT,
      details_json TEXT DEFAULT '{}',

      -- References
      instance_id INTEGER,
      watchlist_id INTEGER,

      -- Status
      is_resolved BOOLEAN DEFAULT 0,
      resolved_at DATETIME,

      -- Timestamps
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (instance_id) REFERENCES instances (id) ON DELETE CASCADE,
      FOREIGN KEY (watchlist_id) REFERENCES watchlists (id) ON DELETE CASCADE
    )
  `);

  // ==========================================
  // Symbol Search Cache Table
  // ==========================================
  await db.run(`
    CREATE TABLE IF NOT EXISTS symbol_search_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      search_query TEXT NOT NULL,
      symbol TEXT NOT NULL,
      tradingsymbol TEXT NOT NULL,
      exchange TEXT NOT NULL,
      exchange_segment TEXT,
      instrument_type TEXT,
      lot_size INTEGER,
      tick_size REAL,
      name TEXT,
      isin TEXT,
      asset_class TEXT DEFAULT 'EQUITY',

      -- Timestamps
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      UNIQUE(search_query, symbol, exchange)
    )
  `);

  // ==========================================
  // WebSocket Sessions Table
  // ==========================================
  await db.run(`
    CREATE TABLE IF NOT EXISTS websocket_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id INTEGER NOT NULL,
      session_type TEXT NOT NULL,

      -- Connection status
      status TEXT NOT NULL,
      connected_at DATETIME,
      disconnected_at DATETIME,

      -- Statistics
      last_message_at DATETIME,
      messages_received INTEGER DEFAULT 0,
      error_count INTEGER DEFAULT 0,
      last_error TEXT,

      -- Failover
      failover_at DATETIME,
      failover_reason TEXT,

      -- Timestamps
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (instance_id) REFERENCES instances (id) ON DELETE CASCADE
    )
  `);

  console.log('  ✅ Created all core tables');
}

export async function down(db) {
  // Drop tables in reverse order (respecting foreign keys)
  await db.run('DROP TABLE IF EXISTS websocket_sessions');
  await db.run('DROP TABLE IF EXISTS symbol_search_cache');
  await db.run('DROP TABLE IF EXISTS system_alerts');
  await db.run('DROP TABLE IF EXISTS market_data');
  await db.run('DROP TABLE IF EXISTS watchlist_positions');
  await db.run('DROP TABLE IF EXISTS watchlist_orders');
  await db.run('DROP TABLE IF EXISTS watchlist_instances');
  await db.run('DROP TABLE IF EXISTS watchlist_symbols');
  await db.run('DROP TABLE IF EXISTS watchlists');
  await db.run('DROP TABLE IF EXISTS instances');
  await db.run('DROP TABLE IF EXISTS users');

  console.log('  ✅ Dropped all core tables');
}
