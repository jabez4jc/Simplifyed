/**
 * Migration 000: Initial Schema
 * Full schema for a fresh Simplifyed install (squashed from the former 000-057 migration history).
 */

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
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,

      -- WebSocket / market data feed
      websocket_role TEXT DEFAULT 'none' CHECK (websocket_role IN ('none','primary','secondary')),
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
  await db.run('CREATE INDEX IF NOT EXISTS idx_instances_is_primary_admin ON instances(is_primary_admin)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_instances_is_secondary_admin ON instances(is_secondary_admin)');
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
  await db.run('CREATE INDEX IF NOT EXISTS idx_watchlist_positions_watchlist_id ON watchlist_positions(watchlist_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_watchlist_positions_instance_id ON watchlist_positions(instance_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_watchlist_positions_symbol_id ON watchlist_positions(symbol_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_watchlist_positions_status ON watchlist_positions(status)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_watchlist_positions_is_closed ON watchlist_positions(is_closed)');

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
    CREATE TABLE IF NOT EXISTS order_monitor_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      exchange TEXT NOT NULL,

      -- Trigger details
      trigger_type TEXT NOT NULL,
      entry_price REAL NOT NULL,
      trigger_price REAL NOT NULL,
      target_value REAL NOT NULL,
      exit_quantity INTEGER NOT NULL,

      -- Analyzer mode
      is_analyzer_mode BOOLEAN DEFAULT 0,
      simulated_pnl REAL,

      -- Live mode
      exit_order_id TEXT,
      exit_status TEXT,
      error_message TEXT,

      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (instance_id) REFERENCES instances (id)
    )
  `);
  await db.run('CREATE INDEX IF NOT EXISTS idx_monitor_log_instance ON order_monitor_log(instance_id, created_at)');

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
    CREATE TABLE IF NOT EXISTS analyzer_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      exchange TEXT NOT NULL,
      side TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      price REAL NOT NULL,
      trade_type TEXT NOT NULL,
      pnl REAL,
      simulated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (instance_id) REFERENCES instances (id)
    )
  `);
  await db.run('CREATE INDEX IF NOT EXISTS idx_analyzer_trades_instance ON analyzer_trades(instance_id, simulated_at)');

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
    CREATE TABLE IF NOT EXISTS system_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT,
      details_json TEXT DEFAULT '{}',
      instance_id INTEGER,
      watchlist_id INTEGER,
      is_resolved BOOLEAN DEFAULT 0,
      resolved_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (instance_id) REFERENCES instances (id) ON DELETE CASCADE,
      FOREIGN KEY (watchlist_id) REFERENCES watchlists (id) ON DELETE CASCADE
    )
  `);
  await db.run('CREATE INDEX IF NOT EXISTS idx_system_alerts_type ON system_alerts(type)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_system_alerts_severity ON system_alerts(severity)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_system_alerts_is_resolved ON system_alerts(is_resolved)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_system_alerts_instance_id ON system_alerts(instance_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_system_alerts_created_at ON system_alerts(created_at)');

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
    CREATE TABLE IF NOT EXISTS websocket_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id INTEGER NOT NULL,
      session_type TEXT NOT NULL,
      status TEXT NOT NULL,
      connected_at DATETIME,
      disconnected_at DATETIME,
      last_message_at DATETIME,
      messages_received INTEGER DEFAULT 0,
      error_count INTEGER DEFAULT 0,
      last_error TEXT,
      failover_at DATETIME,
      failover_reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (instance_id) REFERENCES instances (id) ON DELETE CASCADE
    )
  `);
  await db.run('CREATE INDEX IF NOT EXISTS idx_websocket_sessions_instance_id ON websocket_sessions(instance_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_websocket_sessions_session_type ON websocket_sessions(session_type)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_websocket_sessions_status ON websocket_sessions(status)');

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

  await db.run(`
    CREATE TABLE IF NOT EXISTS market_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exchange TEXT NOT NULL,
      symbol TEXT NOT NULL,
      token TEXT,
      ltp REAL,
      open REAL,
      high REAL,
      low REAL,
      close REAL,
      volume INTEGER,
      change REAL,
      change_percent REAL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(exchange, symbol)
    )
  `);
  await db.run('CREATE INDEX IF NOT EXISTS idx_market_data_updated_at ON market_data(updated_at)');

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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(search_query, symbol, exchange)
    )
  `);
  await db.run('CREATE INDEX IF NOT EXISTS idx_symbol_search_cache_query ON symbol_search_cache(search_query)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_symbol_search_cache_symbol ON symbol_search_cache(symbol)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_symbol_search_cache_exchange ON symbol_search_cache(exchange)');

  await db.run(`
    CREATE TABLE IF NOT EXISTS options_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      underlying TEXT NOT NULL,
      expiry TEXT NOT NULL,
      strike REAL NOT NULL,
      option_type TEXT NOT NULL CHECK(option_type IN ('CE', 'PE')),
      exchange TEXT NOT NULL,
      symbol TEXT NOT NULL,
      trading_symbol TEXT NOT NULL,
      lot_size INTEGER DEFAULT 1,
      tick_size REAL,
      instrument_type TEXT,
      token TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(underlying, expiry, strike, option_type, exchange)
    )
  `);
  await db.run('CREATE INDEX IF NOT EXISTS idx_options_cache_lookup ON options_cache(underlying, expiry, option_type, strike)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_options_cache_symbol ON options_cache(exchange, symbol)');

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

  await db.run(`
    CREATE TABLE IF NOT EXISTS market_holidays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exchange TEXT NOT NULL,
      holiday_date DATE NOT NULL,
      holiday_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(exchange, holiday_date)
    )
  `);
  await db.run('CREATE INDEX IF NOT EXISTS idx_holidays_lookup ON market_holidays(exchange, holiday_date)');

  // ==========================================
  // Telegram integration
  // ==========================================
  await db.run(`
    CREATE TABLE IF NOT EXISTS user_telegram_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      telegram_chat_id TEXT,
      telegram_username TEXT,
      linking_code TEXT UNIQUE,
      linked_at DATETIME,
      enabled BOOLEAN DEFAULT 1,
      notify_on_sl BOOLEAN DEFAULT 1,
      notify_on_tsl BOOLEAN DEFAULT 1,
      notify_on_error BOOLEAN DEFAULT 1,
      silent_mode BOOLEAN DEFAULT 0,
      is_active BOOLEAN DEFAULT 1,
      last_message_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )
  `);
  await db.run('CREATE INDEX IF NOT EXISTS idx_telegram_config_user ON user_telegram_config(user_id)');

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

  await db.run(`
    CREATE TABLE IF NOT EXISTS telegram_message_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      chat_id TEXT,
      message_type TEXT NOT NULL,
      message_text TEXT,
      telegram_message_id INTEGER,
      send_status TEXT DEFAULT 'pending',
      error_message TEXT,
      sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id)
    )
  `);
  await db.run('CREATE INDEX IF NOT EXISTS idx_telegram_log_user ON telegram_message_log(user_id, sent_at)');

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
    (16, 'marketdata.pause_resume', 'Pause/resume market data polling'),
    (17, 'rbac.manage_roles', 'Manage roles and permissions'),
    (18, 'rbac.assign_roles', 'Assign roles to users'),
    (19, 'monitor.view', 'View daily P&L snapshots'),
    (20, 'pages.dashboard.view', 'View Dashboard page'),
    (21, 'pages.instances.view', 'View Instances page'),
    (22, 'pages.watchlists.view', 'View Watchlists page'),
    (23, 'pages.orders.view', 'View Orders page'),
    (24, 'pages.trades.view', 'View Trades page'),
    (25, 'pages.positions.view', 'View Positions page'),
    (26, 'pages.daily_pnl.view', 'View Daily P&L snapshots'),
    (27, 'pages.settings.view', 'View Settings page'),
    (28, 'pages.notifications.view', 'View Notifications page'),
    (29, 'pages.notifications.edit', 'Manage Notifications (mark read)'),
    (30, 'pages.audit.view', 'View Audit Logs page'),
    (31, 'pages.api_playground.view', 'View API Playground page')
  `);

  // Admin: everything. Trader: everything except rbac/audit/api-playground.
  // Monitor: read-only pages + basic order/position actions, no settings/watchlist management.
  const adminPerms = Array.from({ length: 31 }, (_, i) => i + 1);
  const traderPerms = [2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29];
  const monitorPerms = [2, 6, 9, 10, 12, 13, 14, 15, 16, 19, 20, 21, 22, 23, 24, 25, 26, 28, 29];

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

async function seedApplicationSettings(db) {
  const defaults = [
    ['server.port', '3000', 'Server port number', 'server', 'number'],
    ['server.node_env', 'development', 'Environment (development/production/test)', 'server', 'string'],
    ['polling.instance_interval_ms', '12000', 'Interval for instance P&L polling in milliseconds', 'polling', 'number'],
    ['polling.market_data_interval_ms', '10000', 'Interval for market data polling in milliseconds', 'polling', 'number'],
    ['openalgo.request_timeout_ms', '15000', 'OpenAlgo API request timeout in milliseconds', 'openalgo', 'number'],
    ['openalgo.critical.max_retries', '5', 'Max retries for critical operations', 'openalgo', 'number'],
    ['openalgo.critical.retry_delay_ms', '1000', 'Retry delay for critical operations in milliseconds', 'openalgo', 'number'],
    ['openalgo.non_critical.max_retries', '3', 'Max retries for non-critical operations', 'openalgo', 'number'],
    ['openalgo.non_critical.retry_delay_ms', '1000', 'Retry delay for non-critical operations in milliseconds', 'openalgo', 'number'],
    ['database.path', './database/simplifyed.db', 'SQLite database file path', 'database', 'string'],
    ['session.secret', 'CHANGE_THIS_IN_PRODUCTION', 'Session encryption secret', 'session', 'string'],
    ['session.max_age_ms', '604800000', 'Session max age in milliseconds (7 days)', 'session', 'number'],
    ['cors.origin', 'http://localhost:3000', 'CORS allowed origin', 'cors', 'string'],
    ['cors.credentials', 'true', 'Allow credentials in CORS', 'cors', 'boolean'],
    ['logging.level', 'info', 'Log level (error/warn/info/debug)', 'logging', 'string'],
    ['logging.file', './logs/app.log', 'Log file path', 'logging', 'string'],
    ['rate_limit.window_ms', '60000', 'Rate limit window in milliseconds', 'rate_limit', 'number'],
    ['rate_limit.max_requests', '100', 'Maximum requests per window', 'rate_limit', 'number'],
    ['oauth.google.client_id', '', 'Google OAuth client ID', 'oauth', 'string'],
    ['oauth.google.client_secret', '', 'Google OAuth client secret', 'oauth', 'string'],
    ['oauth.google.callback_url', 'http://localhost:3000/auth/google/callback', 'OAuth callback URL', 'oauth', 'string'],
    ['test_mode.enabled', 'false', 'Enable test mode (skip OAuth)', 'test', 'boolean'],
    ['test_mode.user_email', 'test@simplifyed.in', 'Test user email', 'test', 'string'],
    ['market_data_feed.quote_ttl_ms', '3000', 'Market data feed quote cache TTL in milliseconds', 'market_data_feed', 'number'],
    ['market_data_feed.position_ttl_ms', '3000', 'Market data feed position cache TTL in milliseconds', 'market_data_feed', 'number'],
    ['market_data_feed.funds_ttl_ms', '20000', 'Market data feed funds cache TTL in milliseconds', 'market_data_feed', 'number'],
    ['trading_sessions', JSON.stringify([
      { label: 'Session 1', start: '09:00', end: '11:30' },
      { label: 'Session 2', start: '12:30', end: '15:10' },
      { label: 'Session 3', start: '15:45', end: '19:00' },
      { label: 'Session 4', start: '20:30', end: '22:45' },
    ]), 'Trading session windows in IST (start/end HH:MM).', 'trading', 'json'],
    ['rate_limits.rps_per_instance', '5', 'Max requests per second per instance', 'rate_limits', 'number'],
    ['rate_limits.orders_per_second', '10', 'Max order placement requests per second (per instance/global)', 'rate_limits', 'number'],
    ['rate_limits.max_concurrent_tasks', '10', 'Max concurrent OpenAlgo HTTP calls', 'rate_limits', 'number'],
    ['rate_limits.rpm_per_instance', '300', 'Max requests per minute per instance', 'rate_limits', 'number'],
    ['rate_limits.disabled', 'false', 'Disable all rate limiting (for testing only - not recommended for production)', 'rate_limits', 'boolean'],
    ['rate_limits.circuit_breaker_disabled', 'false', 'Disable circuit breaker for unhealthy instances (for testing only)', 'rate_limits', 'boolean'],
    ['market_hours.quote_blackout_start', '05:00', 'Quote endpoint blackout start time (IST)', 'market_hours', 'string'],
    ['market_hours.quote_blackout_end', '08:45', 'Quote endpoint blackout end time (IST)', 'market_hours', 'string'],
    ['market_hours.general_blackout_start', '05:00', 'General endpoint blackout start time (IST)', 'market_hours', 'string'],
    ['market_hours.general_blackout_end', '08:45', 'General endpoint blackout end time (IST)', 'market_hours', 'string'],
    ['instance_health.ping_healthy_interval_ms', '300000', 'Ping cadence for healthy instances (ms)', 'instance_health', 'number'],
    ['instance_health.ping_unhealthy_interval_ms', '180000', 'Ping cadence for unhealthy instances (ms)', 'instance_health', 'number'],
    ['instance_health.ping_unhealthy_max_attempts', '5', 'Max unhealthy ping attempts before manual refresh is required', 'instance_health', 'number'],
    ['instance_health.analyzer_check_interval_ms', '15000', 'Analyzer status refresh interval (ms)', 'instance_health', 'number'],
    ['market_data_feed.quote_ttl_idle_ms', '12000', 'Quote cache TTL when idle (ms)', 'market_data_feed', 'number'],
    ['market_data_feed.quote_ttl_active_ms', '7000', 'Quote cache TTL when open positions exist (ms)', 'market_data_feed', 'number'],
    ['market_data_feed.position_interval_idle_ms', '20000', 'Positionbook refresh interval when idle (ms)', 'market_data_feed', 'number'],
    ['market_data_feed.position_interval_active_ms', '8000', 'Positionbook refresh interval when positions exist (ms)', 'market_data_feed', 'number'],
    ['market_data_feed.tradebook_interval_idle_ms', '20000', 'Tradebook refresh interval when idle (ms)', 'market_data_feed', 'number'],
    ['market_data_feed.tradebook_interval_active_ms', '8000', 'Tradebook refresh interval when positions exist (ms)', 'market_data_feed', 'number'],
    ['market_data_feed.orderbook_interval_ms', '20000', 'Orderbook refresh interval (ms)', 'market_data_feed', 'number'],
    ['market_data_feed.multiquote_cooldown_idle_ms', '15000', 'MultiQuotes cooldown when idle (ms)', 'market_data_feed', 'number'],
    ['market_data_feed.multiquote_cooldown_active_ms', '9000', 'MultiQuotes cooldown when positions exist (ms)', 'market_data_feed', 'number'],
    ['market_data_feed.funds_interval_ms', '180000', 'Funds refresh interval (ms)', 'market_data_feed', 'number'],
    ['market_data_feed.max_order_spread_pct', '0.1', 'Max allowed spread pct before an order is blocked', 'market_data_feed', 'number'],
    ['settings.cache_duration_ms', '1000', 'In-memory settings cache duration (ms)', 'system', 'number'],
    ['brokerage.default', '20', 'Default per-order brokerage (INR) when broker is unknown', 'brokerage', 'number'],
    ['brokerage.by_broker', JSON.stringify({
      fivepaisa: 20, fivepaisax: 20, aliceblue: 20, angel: 20, compositedge: 25, dhan: 20,
      dhan_sandbox: 20, firstock: 20, flattrade: 0, fyers: 20, groww: 20, ibulls: 11, iifl: 20,
      indmoney: 20, kotak: 10, paytm: 20, pocketful: 20, shoonya: 5, tradejini: 20, upstox: 20,
      wisdom: 20, zebu: 20, zerodha: 20,
    }), 'Per-order brokerage (INR) by broker', 'brokerage', 'json'],
    ['brokerage.market_order_support', '{}', 'Per-broker market order support overrides', 'brokerage', 'json'],
  ];

  for (const [key, value, description, category, dataType] of defaults) {
    await db.run(
      `INSERT OR IGNORE INTO application_settings (key, value, description, category, data_type) VALUES (?, ?, ?, ?, ?)`,
      [key, value, description, category, dataType]
    );
  }
}

export async function down(db) {
  const tables = [
    'application_settings',
    'telegram_message_log',
    'telegram_subscribers',
    'user_telegram_config',
    'market_holidays',
    'expiry_calendar',
    'options_cache',
    'symbol_search_cache',
    'symbol_cache',
    'instruments_refresh_log',
    'instruments_fts',
    'instruments',
    'market_data',
    'quick_orders',
    'system_alerts',
    'notifications',
    'websocket_sessions',
    'quote_snapshots',
    'idempotency_keys',
    'daily_instance_pnl_snapshots',
    'analyzer_trades',
    'trailing_state',
    'order_monitor_log',
    'risk_events',
    'gtt_orders',
    'strategy_leg_executions',
    'strategy_legs',
    'strategies',
    'watchlist_options_state',
    'watchlist_positions',
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
