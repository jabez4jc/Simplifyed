/**
 * Migration 001: Add Database Indexes
 * Adds indexes for common queries and foreign keys
 */

export const version = '001';
export const name = 'add_database_indexes';

export async function up(db) {
  // Instances indexes
  // Note: host_url has UNIQUE constraint, so implicit index already exists
  await db.run('CREATE INDEX IF NOT EXISTS idx_instances_is_active ON instances(is_active)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_instances_is_primary_admin ON instances(is_primary_admin)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_instances_is_secondary_admin ON instances(is_secondary_admin)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_instances_health_status ON instances(health_status)');

  // Watchlists indexes
  await db.run('CREATE INDEX IF NOT EXISTS idx_watchlists_is_active ON watchlists(is_active)');

  // Watchlist symbols indexes
  await db.run('CREATE INDEX IF NOT EXISTS idx_watchlist_symbols_watchlist_id ON watchlist_symbols(watchlist_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_watchlist_symbols_exchange_symbol ON watchlist_symbols(exchange, symbol)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_watchlist_symbols_is_enabled ON watchlist_symbols(is_enabled)');

  // Watchlist instances indexes
  // Note: UNIQUE(watchlist_id, instance_id) provides implicit composite index
  await db.run('CREATE INDEX IF NOT EXISTS idx_watchlist_instances_watchlist_id ON watchlist_instances(watchlist_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_watchlist_instances_instance_id ON watchlist_instances(instance_id)');

  // Watchlist orders indexes
  await db.run('CREATE INDEX IF NOT EXISTS idx_watchlist_orders_watchlist_id ON watchlist_orders(watchlist_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_watchlist_orders_instance_id ON watchlist_orders(instance_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_watchlist_orders_symbol_id ON watchlist_orders(symbol_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_watchlist_orders_status ON watchlist_orders(status)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_watchlist_orders_order_id ON watchlist_orders(order_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_watchlist_orders_placed_at ON watchlist_orders(placed_at)');

  // Watchlist positions indexes
  await db.run('CREATE INDEX IF NOT EXISTS idx_watchlist_positions_watchlist_id ON watchlist_positions(watchlist_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_watchlist_positions_instance_id ON watchlist_positions(instance_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_watchlist_positions_symbol_id ON watchlist_positions(symbol_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_watchlist_positions_status ON watchlist_positions(status)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_watchlist_positions_is_closed ON watchlist_positions(is_closed)');

  // Market data indexes
  // Note: UNIQUE(exchange, symbol) provides implicit composite index
  await db.run('CREATE INDEX IF NOT EXISTS idx_market_data_updated_at ON market_data(updated_at)');

  // System alerts indexes
  await db.run('CREATE INDEX IF NOT EXISTS idx_system_alerts_type ON system_alerts(type)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_system_alerts_severity ON system_alerts(severity)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_system_alerts_is_resolved ON system_alerts(is_resolved)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_system_alerts_instance_id ON system_alerts(instance_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_system_alerts_created_at ON system_alerts(created_at)');

  // Symbol search cache indexes
  // Note: UNIQUE(search_query, symbol, exchange) provides implicit composite index
  await db.run('CREATE INDEX IF NOT EXISTS idx_symbol_search_cache_query ON symbol_search_cache(search_query)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_symbol_search_cache_symbol ON symbol_search_cache(symbol)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_symbol_search_cache_exchange ON symbol_search_cache(exchange)');

  // WebSocket sessions indexes
  await db.run('CREATE INDEX IF NOT EXISTS idx_websocket_sessions_instance_id ON websocket_sessions(instance_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_websocket_sessions_session_type ON websocket_sessions(session_type)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_websocket_sessions_status ON websocket_sessions(status)');

  // Users indexes
  // Note: email has UNIQUE constraint, so implicit index already exists
  await db.run('CREATE INDEX IF NOT EXISTS idx_users_is_admin ON users(is_admin)');

  console.log('  ✅ Created all database indexes (redundant indexes removed)');
}

export async function down(db) {
  // Drop all indexes (excluding those created implicitly by UNIQUE constraints)
  const indexes = [
    // Instances
    'idx_instances_is_active',
    'idx_instances_is_primary_admin',
    'idx_instances_is_secondary_admin',
    'idx_instances_health_status',

    // Watchlists
    'idx_watchlists_is_active',

    // Watchlist symbols
    'idx_watchlist_symbols_watchlist_id',
    'idx_watchlist_symbols_exchange_symbol',
    'idx_watchlist_symbols_is_enabled',

    // Watchlist instances
    'idx_watchlist_instances_watchlist_id',
    'idx_watchlist_instances_instance_id',

    // Watchlist orders
    'idx_watchlist_orders_watchlist_id',
    'idx_watchlist_orders_instance_id',
    'idx_watchlist_orders_symbol_id',
    'idx_watchlist_orders_status',
    'idx_watchlist_orders_order_id',
    'idx_watchlist_orders_placed_at',

    // Watchlist positions
    'idx_watchlist_positions_watchlist_id',
    'idx_watchlist_positions_instance_id',
    'idx_watchlist_positions_symbol_id',
    'idx_watchlist_positions_status',
    'idx_watchlist_positions_is_closed',

    // Market data
    'idx_market_data_updated_at',

    // System alerts
    'idx_system_alerts_type',
    'idx_system_alerts_severity',
    'idx_system_alerts_is_resolved',
    'idx_system_alerts_instance_id',
    'idx_system_alerts_created_at',

    // Symbol search cache
    'idx_symbol_search_cache_query',
    'idx_symbol_search_cache_symbol',
    'idx_symbol_search_cache_exchange',

    // WebSocket sessions
    'idx_websocket_sessions_instance_id',
    'idx_websocket_sessions_session_type',
    'idx_websocket_sessions_status',

    // Users
    'idx_users_is_admin',
  ];

  for (const index of indexes) {
    await db.run(`DROP INDEX IF EXISTS ${index}`);
  }

  console.log('  ✅ Dropped all database indexes');
}
