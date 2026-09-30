/**
 * Migration 000: Initial Schema
 * Full schema for a fresh Simplifyed install (squashed from the former 000-057 migration history).
 */

import { ESSENTIAL_SETTINGS } from '../src/config/settings-registry.js';

export const version = '000';
export const name = 'initial_schema';

export async function up(db) {
  // ==========================================
  // Users / RBAC
  // ==========================================
  await db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      is_admin BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      password_hash TEXT
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id INTEGER NOT NULL,
      permission_id INTEGER NOT NULL,
      PRIMARY KEY (role_id, permission_id),
      FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE,
      FOREIGN KEY (permission_id) REFERENCES permissions (id) ON DELETE CASCADE
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS user_roles (
      user_id INTEGER NOT NULL UNIQUE,
      role_id INTEGER NOT NULL,
      assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      assigned_by INTEGER,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
      FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE,
      FOREIGN KEY (assigned_by) REFERENCES users (id) ON DELETE SET NULL
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
    )
  `);

  await db.run('CREATE INDEX IF NOT EXISTS idx_users_is_admin ON users(is_admin)');

  // ==========================================
  // Instances (OpenAlgo brokers)
  // ==========================================
  await db.run(`
    CREATE TABLE IF NOT EXISTS instances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      host_url TEXT NOT NULL UNIQUE,
      api_key TEXT NOT NULL,
      strategy_tag TEXT,
      broker TEXT,
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
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,

      -- WebSocket / market data feed
      websocket_url TEXT,
      market_data_enabled INTEGER DEFAULT 0,
      supports_multiquotes INTEGER DEFAULT 0,
      supports_option_chain INTEGER DEFAULT 0,
      use_ws_quotes INTEGER DEFAULT 0,

      -- Session risk controls
      session_target_profit REAL DEFAULT NULL,
      session_max_loss REAL DEFAULT NULL,
      session_baseline_total_pnl REAL DEFAULT NULL,
      session_baseline_at TEXT DEFAULT NULL,
      session_pnl REAL DEFAULT NULL,
      last_live_total_pnl REAL DEFAULT NULL,
      last_live_total_pnl_at TEXT DEFAULT NULL,
      session_cutoff_reason TEXT DEFAULT NULL,
      session_cutoff_at TEXT DEFAULT NULL,
      session_max_loss_hits INTEGER DEFAULT 0,
      session_max_loss_hits_date TEXT,

      -- Endpoint health checks
      quotes_ok INTEGER DEFAULT 0,
      quotes_checked_at TEXT,
      quotes_failure_reason TEXT,
      multiquotes_ok INTEGER DEFAULT 0,
      multiquotes_checked_at TEXT,
      multiquotes_failure_reason TEXT,
      optionchain_ok INTEGER DEFAULT 0,
      optionchain_checked_at TEXT,
      optionchain_failure_reason TEXT,
      disable_quotes INTEGER DEFAULT 0,
      disable_multiquotes INTEGER DEFAULT 0,
      disable_optionchain INTEGER DEFAULT 0,
      last_analyzer_check_at TEXT,

      -- Lot multiplier
      multiplier INTEGER DEFAULT 1 CHECK (multiplier >= 1 AND multiplier <= 999)
    )
  `);

  await db.run('CREATE INDEX IF NOT EXISTS idx_instances_is_active ON instances(is_active)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_instances_health_status ON instances(health_status)');

  // ==========================================
  // Watchlists
  // ==========================================
  await db.run(`
    CREATE TABLE IF NOT EXISTS watchlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      is_active BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      type TEXT DEFAULT 'standard',
      is_broadcast BOOLEAN DEFAULT 0,
      webhook_slug TEXT,
      alert_received_count INTEGER DEFAULT 0,
      alert_success_count INTEGER DEFAULT 0,
      limit_buffer_pct REAL
    )
  `);
  await db.run('CREATE INDEX IF NOT EXISTS idx_watchlists_is_active ON watchlists(is_active)');
  await db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_watchlists_webhook_slug
    ON watchlists(webhook_slug) WHERE webhook_slug IS NOT NULL
  `);

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

      -- Trading symbol / metadata (from symbol validation/search API)
      trading_symbol TEXT,
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

      -- Buyer/Writer options mode
      operating_mode TEXT DEFAULT 'BUYER' CHECK(operating_mode IN ('BUYER', 'WRITER')),
      strike_policy TEXT DEFAULT 'FLOAT_OFS' CHECK(strike_policy IN ('FLOAT_OFS', 'ANCHOR_OFS')),
      step_lots INTEGER DEFAULT 1,
      writer_guard_enabled BOOLEAN DEFAULT 1,
      anchored_ce_strike INTEGER,
      anchored_pe_strike INTEGER,
      anchored_expiry TEXT,

      -- Target / stoploss / trailing (per instrument type)
      target_points_direct REAL,
      stoploss_points_direct REAL,
      trailing_stoploss_points_direct REAL,
      trailing_activation_points_direct REAL,
      target_points_futures REAL,
      stoploss_points_futures REAL,
      trailing_stoploss_points_futures REAL,
      trailing_activation_points_futures REAL,
      target_points_options REAL,
      stoploss_points_options REAL,
      trailing_stoploss_points_options REAL,
      trailing_activation_points_options REAL,
      limit_buffer_points REAL DEFAULT 0,

      -- Margin-based sizing
      margin_sizing_enabled BOOLEAN DEFAULT 0,
      margin_utilization_pct REAL,
      max_margin_per_trade REAL,

      exit_mechanism TEXT DEFAULT 'POLLING',

      FOREIGN KEY (watchlist_id) REFERENCES watchlists (id) ON DELETE CASCADE
    )
  `);
  await db.run('CREATE INDEX IF NOT EXISTS idx_watchlist_symbols_watchlist_id ON watchlist_symbols(watchlist_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_watchlist_symbols_exchange_symbol ON watchlist_symbols(exchange, symbol)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_watchlist_symbols_is_enabled ON watchlist_symbols(is_enabled)');

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
  await db.run('CREATE INDEX IF NOT EXISTS idx_watchlist_instances_watchlist_id ON watchlist_instances(watchlist_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_watchlist_instances_instance_id ON watchlist_instances(instance_id)');

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

      -- Provenance
      user_id INTEGER,
      source TEXT,
      trigger_type TEXT,
      request_id TEXT,
      correlation_id TEXT,

      -- Timestamps
      placed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (watchlist_id) REFERENCES watchlists (id) ON DELETE CASCADE,
      FOREIGN KEY (instance_id) REFERENCES instances (id) ON DELETE CASCADE,
      FOREIGN KEY (symbol_id) REFERENCES watchlist_symbols (id) ON DELETE SET NULL
    )
  `);
  await db.run('CREATE INDEX IF NOT EXISTS idx_watchlist_orders_watchlist_id ON watchlist_orders(watchlist_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_watchlist_orders_instance_id ON watchlist_orders(instance_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_watchlist_orders_symbol_id ON watchlist_orders(symbol_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_watchlist_orders_status ON watchlist_orders(status)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_watchlist_orders_order_id ON watchlist_orders(order_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_watchlist_orders_placed_at ON watchlist_orders(placed_at)');

  await db.run(`
    CREATE TABLE IF NOT EXISTS watchlist_options_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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

      product TEXT DEFAULT 'MIS',

      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (watchlist_id) REFERENCES watchlists(id) ON DELETE CASCADE,
      FOREIGN KEY (symbol_id) REFERENCES watchlist_symbols(id) ON DELETE CASCADE,
      FOREIGN KEY (instance_id) REFERENCES instances(id) ON DELETE CASCADE,
      UNIQUE(instance_id, underlying, expiry, option_type, strike)
    )
  `);
  await db.run('CREATE INDEX IF NOT EXISTS idx_options_state_instance ON watchlist_options_state(instance_id, watchlist_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_options_state_type_aggregation ON watchlist_options_state(instance_id, underlying, expiry, option_type)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_options_state_symbol ON watchlist_options_state(symbol_id, option_type, expiry)');

  // ==========================================
  // Strategies (multi-leg webhook strategies)
  // ==========================================
  await db.run(`
    CREATE TABLE IF NOT EXISTS strategies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      watchlist_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      underlying TEXT NOT NULL,
      exchange TEXT NOT NULL,
      is_active BOOLEAN DEFAULT 1,
      entry_trigger TEXT NOT NULL DEFAULT 'MANUAL',
      webhook_slug TEXT UNIQUE,
      broker_tag TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (watchlist_id) REFERENCES watchlists (id) ON DELETE CASCADE
    )
  `);
  await db.run('CREATE INDEX IF NOT EXISTS idx_strategies_watchlist ON strategies (watchlist_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_strategies_webhook_slug ON strategies (webhook_slug)');
  await db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_strategies_broker_tag
    ON strategies(broker_tag) WHERE broker_tag IS NOT NULL
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS strategy_legs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_id INTEGER NOT NULL,
      leg_order INTEGER NOT NULL DEFAULT 0,
      option_type TEXT,
      action TEXT NOT NULL,
      strike_policy TEXT DEFAULT 'FLOAT_OFS',
      strike_offset TEXT,
      qty_type TEXT NOT NULL DEFAULT 'LOTS',
      qty_value REAL,
      product_type TEXT NOT NULL DEFAULT 'MIS',
      target_points REAL,
      stoploss_points REAL,
      trailing_stoploss_points REAL,
      trailing_activation_points REAL,
      exit_mechanism TEXT DEFAULT 'POLLING',
      leg_tag TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (strategy_id) REFERENCES strategies (id) ON DELETE CASCADE
    )
  `);
  await db.run('CREATE INDEX IF NOT EXISTS idx_strategy_legs_strategy ON strategy_legs (strategy_id)');
  await db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_strategy_legs_tag
    ON strategy_legs(strategy_id, leg_tag) WHERE leg_tag IS NOT NULL
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS strategy_leg_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_id INTEGER NOT NULL,
      strategy_leg_id INTEGER NOT NULL,
      instance_id INTEGER NOT NULL,
      execution_id TEXT NOT NULL,
      resolved_symbol TEXT NOT NULL,
      resolved_exchange TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      product TEXT NOT NULL,
      entry_order_id TEXT,
      entry_status TEXT NOT NULL DEFAULT 'PENDING',
      entry_price REAL,
      exit_order_id TEXT,
      exit_status TEXT,
      exit_price REAL,
      exit_mechanism TEXT NOT NULL DEFAULT 'POLLING',
      opened_at DATETIME,
      closed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (strategy_id) REFERENCES strategies (id) ON DELETE CASCADE,
      FOREIGN KEY (strategy_leg_id) REFERENCES strategy_legs (id) ON DELETE CASCADE,
      FOREIGN KEY (instance_id) REFERENCES instances (id) ON DELETE CASCADE
    )
  `);
  await db.run('CREATE INDEX IF NOT EXISTS idx_strategy_leg_executions_strategy_instance ON strategy_leg_executions (strategy_id, instance_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_strategy_leg_executions_open ON strategy_leg_executions (strategy_id, closed_at)');

  await db.run(`
    CREATE TABLE IF NOT EXISTS gtt_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id INTEGER NOT NULL,
      watchlist_id INTEGER,
      symbol_id INTEGER,
      strategy_leg_id INTEGER,
      trigger_id TEXT NOT NULL,
      exchange TEXT NOT NULL,
      symbol TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (instance_id) REFERENCES instances (id) ON DELETE CASCADE,
      FOREIGN KEY (watchlist_id) REFERENCES watchlists (id) ON DELETE SET NULL,
      FOREIGN KEY (symbol_id) REFERENCES watchlist_symbols (id) ON DELETE SET NULL,
      FOREIGN KEY (strategy_leg_id) REFERENCES strategy_legs (id) ON DELETE SET NULL
    )
  `);
  await db.run('CREATE INDEX IF NOT EXISTS idx_gtt_orders_instance ON gtt_orders (instance_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_gtt_orders_trigger_id ON gtt_orders (trigger_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_gtt_orders_status ON gtt_orders (status)');

  // ==========================================
  // Risk / monitoring
  // ==========================================
  await db.run(`
    CREATE TABLE IF NOT EXISTS risk_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id INTEGER,
      watchlist_id INTEGER,
      symbol_id INTEGER,
      exchange TEXT,
      symbol TEXT,
      event_type TEXT NOT NULL,
      previous_value REAL,
      new_value REAL,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (instance_id) REFERENCES instances (id) ON DELETE SET NULL,
      FOREIGN KEY (watchlist_id) REFERENCES watchlists (id) ON DELETE SET NULL,
      FOREIGN KEY (symbol_id) REFERENCES watchlist_symbols (id) ON DELETE SET NULL
    )
  `);
  await db.run('CREATE INDEX IF NOT EXISTS idx_risk_events_instance ON risk_events (instance_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_risk_events_watchlist ON risk_events (watchlist_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_risk_events_type ON risk_events (event_type)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_risk_events_created_at ON risk_events (created_at)');

  await db.run(`
    CREATE TABLE IF NOT EXISTS trailing_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id INTEGER NOT NULL,
      exchange TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      highest REAL,
      lowest REAL,
      activated INTEGER DEFAULT 0,
      last_seen_ts INTEGER,
      entry_price REAL,
      entry_source TEXT,
      stop_price REAL,
      updated_at INTEGER DEFAULT (strftime('%s','now') * 1000),
      UNIQUE(instance_id, exchange, symbol, side)
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS daily_instance_pnl_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id INTEGER NOT NULL,
      snapshot_date TEXT NOT NULL,
      total_pnl REAL NOT NULL DEFAULT 0,
      buy_trades INTEGER NOT NULL DEFAULT 0,
      sell_trades INTEGER NOT NULL DEFAULT 0,
      buy_value REAL NOT NULL DEFAULT 0,
      sell_value REAL NOT NULL DEFAULT 0,
      webhook_buy_signals INTEGER NOT NULL DEFAULT 0,
      webhook_sell_signals INTEGER NOT NULL DEFAULT 0,
      manual_buy_signals INTEGER NOT NULL DEFAULT 0,
      manual_sell_signals INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(instance_id, snapshot_date),
      FOREIGN KEY (instance_id) REFERENCES instances (id) ON DELETE CASCADE
    )
  `);
  await db.run('CREATE INDEX IF NOT EXISTS idx_daily_pnl_snapshots_date ON daily_instance_pnl_snapshots (snapshot_date)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_daily_pnl_snapshots_instance_date ON daily_instance_pnl_snapshots (instance_id, snapshot_date)');

  await db.run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT,
      severity TEXT DEFAULT 'info',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      read INTEGER DEFAULT 0
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS quote_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id INTEGER NOT NULL UNIQUE,
      payload TEXT,
      hash TEXT,
      fetched_at INTEGER,
      exchange_count INTEGER,
      symbol_count INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL,
      source TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      response_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      status_code INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME,
      UNIQUE(request_id, source)
    )
  `);
  await db.run('CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at ON idempotency_keys(created_at)');

  // ==========================================
  // Quick orders / GTT-adjacent tables
  // ==========================================
  await db.run(`
    CREATE TABLE IF NOT EXISTS quick_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      watchlist_id INTEGER,
      symbol_id INTEGER,
      instance_id INTEGER NOT NULL,

      underlying TEXT NOT NULL,
      symbol TEXT NOT NULL,
      exchange TEXT NOT NULL,
      action TEXT NOT NULL,
      trade_mode TEXT NOT NULL CHECK(trade_mode IN ('EQUITY', 'FUTURES', 'OPTIONS')),
      options_leg TEXT,

      quantity INTEGER NOT NULL,
      product TEXT NOT NULL,
      order_type TEXT NOT NULL,
      price REAL,
      trigger_price REAL,

      resolved_symbol TEXT,
      strike_price REAL,
      option_type TEXT,
      expiry_date TEXT,

      status TEXT NOT NULL DEFAULT 'pending',
      order_id TEXT,
      broker_order_id TEXT,
      message TEXT,
      error_details TEXT,

      reason TEXT DEFAULT 'watchlist_quick_action',
      metadata TEXT,

      -- Provenance / sync
      user_id INTEGER,
      source TEXT,
      trigger_type TEXT,
      request_id TEXT,
      correlation_id TEXT,
      broker_status TEXT,
      last_sync_at DATETIME,

      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (watchlist_id) REFERENCES watchlists (id) ON DELETE SET NULL,
      FOREIGN KEY (symbol_id) REFERENCES watchlist_symbols (id) ON DELETE SET NULL,
      FOREIGN KEY (instance_id) REFERENCES instances (id) ON DELETE CASCADE
    )
  `);
  await db.run('CREATE INDEX IF NOT EXISTS idx_quick_orders_instance ON quick_orders(instance_id, status, created_at)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_quick_orders_symbol ON quick_orders(symbol_id, trade_mode, created_at)');

  // ==========================================
  // Instruments / symbol cache
  // ==========================================
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
      brexchange TEXT,
      underlying_key TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(exchange, symbol, expiry, strike)
    )
  `);
  await db.run('CREATE INDEX IF NOT EXISTS idx_instruments_exchange_symbol ON instruments(exchange, symbol)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_instruments_token ON instruments(token)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_instruments_type ON instruments(instrumenttype)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_instruments_expiry ON instruments(symbol, expiry) WHERE expiry IS NOT NULL');
  await db.run('CREATE INDEX IF NOT EXISTS idx_instruments_options ON instruments(symbol, expiry, strike) WHERE strike IS NOT NULL');
  await db.run('CREATE INDEX IF NOT EXISTS idx_instruments_underlying_key ON instruments(underlying_key)');

  // Full-text search over instruments (fts5 auto-creates its own shadow tables)
  await db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS instruments_fts USING fts5(
      symbol,
      name,
      exchange,
      instrumenttype,
      content=instruments,
      content_rowid=id
    )
  `);
  await db.run(`
    CREATE TRIGGER IF NOT EXISTS instruments_fts_insert AFTER INSERT ON instruments BEGIN
      INSERT INTO instruments_fts(rowid, symbol, name, exchange, instrumenttype)
      VALUES (new.id, new.symbol, new.name, new.exchange, new.instrumenttype);
    END
  `);
  await db.run(`
    CREATE TRIGGER IF NOT EXISTS instruments_fts_update AFTER UPDATE ON instruments BEGIN
      UPDATE instruments_fts
      SET symbol = new.symbol, name = new.name, exchange = new.exchange, instrumenttype = new.instrumenttype
      WHERE rowid = new.id;
    END
  `);
  await db.run(`
    CREATE TRIGGER IF NOT EXISTS instruments_fts_delete AFTER DELETE ON instruments BEGIN
      DELETE FROM instruments_fts WHERE rowid = old.id;
    END
  `);

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
  await db.run('CREATE INDEX IF NOT EXISTS idx_refresh_log_exchange ON instruments_refresh_log(exchange, refresh_completed_at DESC)');

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
      symbol_type TEXT CHECK(symbol_type IN ('EQUITY', 'FUTURES', 'OPTIONS', 'INDEX', 'UNKNOWN')),
      cached_at TEXT DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(exchange, symbol)
    )
  `);
  await db.run('CREATE INDEX IF NOT EXISTS idx_symbol_cache_lookup ON symbol_cache(exchange, symbol)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_symbol_cache_expiry ON symbol_cache(cached_at)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_symbol_cache_type ON symbol_cache(symbol_type)');

  await db.run(`
    CREATE TABLE IF NOT EXISTS expiry_calendar (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      underlying TEXT NOT NULL,
      exchange TEXT NOT NULL,
      expiry_date TEXT NOT NULL,
      is_weekly BOOLEAN DEFAULT 0,
      is_monthly BOOLEAN DEFAULT 0,
      is_quarterly BOOLEAN DEFAULT 0,
      day_of_week TEXT,
      is_active BOOLEAN DEFAULT 1,
      fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(underlying, exchange, expiry_date)
    )
  `);
  await db.run('CREATE INDEX IF NOT EXISTS idx_expiry_calendar_lookup ON expiry_calendar(underlying, exchange, is_active, expiry_date)');

  // ==========================================
  // Telegram integration
  // ==========================================

  await db.run(`
    CREATE TABLE IF NOT EXISTS telegram_subscribers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      chat_id TEXT NOT NULL UNIQUE,
      username TEXT,
      linking_code TEXT,
      linked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_active BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ==========================================
  // Application settings (key/value config store)
  // ==========================================
  await db.run(`
    CREATE TABLE IF NOT EXISTS application_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL,
      description TEXT,
      category TEXT NOT NULL,
      data_type TEXT NOT NULL CHECK(data_type IN ('string', 'number', 'boolean', 'json')),
      is_sensitive BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.run('CREATE INDEX IF NOT EXISTS idx_application_settings_key ON application_settings(key)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_application_settings_category ON application_settings(category)');

  // ==========================================
  // Seed data
  // ==========================================
  await seedRbac(db);
  await seedApplicationSettings(db);

  console.log('  ✅ Created full schema + seed data for a fresh install');
}

async function seedRbac(db) {
  await db.run(`
    INSERT OR IGNORE INTO roles (id, name, description) VALUES
    (1, 'Admin', 'Full access'),
    (2, 'Trader', 'Trading access without settings'),
    (3, 'Monitor', 'Read + limited actions')
  `);

  await db.run(`
    INSERT OR IGNORE INTO permissions (id, key, description) VALUES
    (1, 'settings.manage', 'Manage all application settings'),
    (2, 'settings.instruments.refresh', 'Refresh instruments cache'),
    (3, 'instances.add', 'Add instances'),
    (4, 'instances.edit', 'Edit instances'),
    (5, 'instances.delete', 'Delete instances'),
    (6, 'instances.toggle_mode', 'Toggle live/analyzer mode'),
    (7, 'watchlists.manage', 'Create/update/delete watchlists'),
    (8, 'watchlists.symbols.manage', 'Add/update/delete watchlist symbols'),
    (9, 'watchlists.instances.manage', 'Assign/unassign instances to watchlists'),
    (10, 'watchlists.status', 'Activate/deactivate watchlists'),
    (11, 'orders.place', 'Place/modify orders from watchlist'),
    (12, 'orders.cancel', 'Cancel individual orders'),
    (13, 'orders.cancel_all', 'Cancel all open/pending orders'),
    (14, 'positions.close', 'Close individual positions'),
    (15, 'positions.close_all', 'Close all open positions'),
    (16, 'killswitch.execute', 'Kill switch: close everything and switch all instances to analyzer'),
    (17, 'rbac.manage_roles', 'Manage roles and permissions'),
    (18, 'rbac.assign_roles', 'Assign roles to users'),
    (20, 'pages.dashboard.view', 'View Dashboard page'),
    (21, 'pages.instances.view', 'View Instances page'),
    (22, 'pages.watchlists.view', 'View Watchlists page'),
    (23, 'pages.orders.view', 'View Orders page'),
    (24, 'pages.trades.view', 'View Trades page'),
    (25, 'pages.positions.view', 'View Positions page'),
    (26, 'pages.daily_pnl.view', 'View Daily P&L snapshots'),
    (27, 'pages.settings.view', 'View Settings page'),
    (28, 'pages.notifications.view', 'View Notifications page'),
    (29, 'pages.notifications.edit', 'Manage Notifications (mark read)')
  `);

  // Admin: everything. Trader: everything except rbac.
  // Monitor: read-only pages + basic order/position actions, no settings/watchlist management.
  // (ids 19, 30 and 31 were monitor.view / pages.audit.view / pages.api_playground.view, retired.)
  const adminPerms = Array.from({ length: 29 }, (_, i) => i + 1).filter((id) => id !== 19);
  const traderPerms = [2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29];
  const monitorPerms = [2, 6, 9, 10, 12, 13, 14, 15, 16, 20, 21, 22, 23, 24, 25, 26, 28, 29];

  const grants = [
    ...adminPerms.map((p) => [1, p]),
    ...traderPerms.map((p) => [2, p]),
    ...monitorPerms.map((p) => [3, p]),
  ];

  for (const [roleId, permissionId] of grants) {
    await db.run('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [
      roleId,
      permissionId,
    ]);
  }
}

// The defaults live in one place, the settings registry, shared with settings.service.
async function seedApplicationSettings(db) {
  for (const { key, value, description, category, dataType } of ESSENTIAL_SETTINGS) {
    await db.run(
      `INSERT OR IGNORE INTO application_settings (key, value, description, category, data_type) VALUES (?, ?, ?, ?, ?)`,
      [key, value, description, category, dataType]
    );
  }
}

export async function down(db) {
  const tables = [
    'application_settings',
    'telegram_subscribers',
    'expiry_calendar',
    'symbol_cache',
    'instruments_refresh_log',
    'instruments_fts',
    'instruments',
    'quick_orders',
    'notifications',
    'quote_snapshots',
    'idempotency_keys',
    'daily_instance_pnl_snapshots',
    'trailing_state',
    'risk_events',
    'gtt_orders',
    'strategy_leg_executions',
    'strategy_legs',
    'strategies',
    'watchlist_options_state',
    'watchlist_orders',
    'watchlist_instances',
    'watchlist_symbols',
    'watchlists',
    'instances',
    'audit_logs',
    'user_roles',
    'role_permissions',
    'permissions',
    'roles',
    'users',
  ];

  for (const table of tables) {
    await db.run(`DROP TABLE IF EXISTS ${table}`);
  }

  console.log('  ✅ Dropped all tables');
}
