/**
 * Migration 055: Strategy leg execution ledger
 * Adds a durable, per-leg, per-instance record of what a strategy execution actually placed
 * (resolved symbol/exchange/quantity/order id) and later closed. Today that data only exists
 * transiently in executeStrategy's response and loosely inside watchlist_orders/risk_events
 * metadata JSON - neither is indexed or FK-joinable back to a strategy. This table is the
 * source of truth exitStrategy reads to know what's still open, and the status view joins
 * against live position/quote caches to show.
 */

export const version = '055';
export const name = 'add_strategy_leg_executions';

export async function up(db) {
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

  await db.run(`CREATE INDEX IF NOT EXISTS idx_strategy_leg_executions_strategy_instance ON strategy_leg_executions (strategy_id, instance_id)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_strategy_leg_executions_open ON strategy_leg_executions (strategy_id, closed_at)`);

  console.log('  ✅ Migration 055 completed');
}

export async function down(db) {
  await db.run('DROP TABLE IF EXISTS strategy_leg_executions');
}
