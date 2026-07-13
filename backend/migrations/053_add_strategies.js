/**
 * Migration 053: Strategy Builder
 * - strategies: a named multi-leg strategy scoped to a watchlist (for instance targeting/dispatch reuse)
 * - strategy_legs: individual legs (one instrument + action + sizing + exit config each)
 *
 * Execution reuses the existing options/derivative resolution services and quickOrderService
 * (see strategy.service.js) rather than introducing a parallel order-placement path.
 */

export const version = '053';
export const name = 'add_strategies';

export async function up(db) {
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (watchlist_id) REFERENCES watchlists (id) ON DELETE CASCADE
    )
  `);

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_strategies_watchlist ON strategies (watchlist_id)
  `);
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_strategies_webhook_slug ON strategies (webhook_slug)
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (strategy_id) REFERENCES strategies (id) ON DELETE CASCADE
    )
  `);

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_strategy_legs_strategy ON strategy_legs (strategy_id)
  `);
}

export async function down(db) {
  await db.run('DROP TABLE IF EXISTS strategy_legs');
  await db.run('DROP TABLE IF EXISTS strategies');
}
