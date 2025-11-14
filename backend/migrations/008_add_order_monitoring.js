/**
 * Migration 008: Order Monitoring System
 * Creates tables for Telegram integration and order monitoring
 */

export const version = '008';
export const name = 'add_order_monitoring';

export async function up(db) {
  // ==========================================
  // User Telegram Configuration
  // ==========================================
  await db.run(`
    CREATE TABLE IF NOT EXISTS user_telegram_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,

      -- Telegram details
      telegram_chat_id TEXT,
      telegram_username TEXT,
      linking_code TEXT UNIQUE,
      linked_at DATETIME,

      -- Notification preferences
      enabled BOOLEAN DEFAULT 1,
      notify_on_target BOOLEAN DEFAULT 1,
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

  // ==========================================
  // Telegram Message Log
  // ==========================================
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

  // ==========================================
  // Order Monitor Execution Log
  // ==========================================
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

  // ==========================================
  // Analyzer Trades (Simulated Executions)
  // ==========================================
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

  // ==========================================
  // Market Holidays (Manual Entry)
  // ==========================================
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

  // ==========================================
  // Indexes for Performance
  // ==========================================
  await db.run('CREATE INDEX IF NOT EXISTS idx_telegram_config_user ON user_telegram_config(user_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_telegram_log_user ON telegram_message_log(user_id, sent_at)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_monitor_log_instance ON order_monitor_log(instance_id, created_at)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_analyzer_trades_instance ON analyzer_trades(instance_id, simulated_at)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_holidays_lookup ON market_holidays(exchange, holiday_date)');

  console.log('  ✅ Created order monitoring tables');
}

export async function down(db) {
  // Drop indexes
  await db.run('DROP INDEX IF EXISTS idx_holidays_lookup');
  await db.run('DROP INDEX IF EXISTS idx_analyzer_trades_instance');
  await db.run('DROP INDEX IF EXISTS idx_monitor_log_instance');
  await db.run('DROP INDEX IF EXISTS idx_telegram_log_user');
  await db.run('DROP INDEX IF EXISTS idx_telegram_config_user');

  // Drop tables in reverse order
  await db.run('DROP TABLE IF EXISTS market_holidays');
  await db.run('DROP TABLE IF EXISTS analyzer_trades');
  await db.run('DROP TABLE IF EXISTS order_monitor_log');
  await db.run('DROP TABLE IF EXISTS telegram_message_log');
  await db.run('DROP TABLE IF EXISTS user_telegram_config');

  console.log('  ✅ Dropped order monitoring tables');
}
