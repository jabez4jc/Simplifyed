/**
 * Migration 058: Strategy Instances
 * Per-strategy instance assignment, mirroring watchlist_instances. Execute/Exit resolve a
 * strategy's own explicit rows here when present; when a strategy has none, they fall back to
 * the container watchlist's instances (existing behavior, unchanged for strategies that never
 * set an explicit assignment).
 */

export const version = '058';
export const name = 'strategy_instances';

export async function up(db) {
  await db.run(`
    CREATE TABLE IF NOT EXISTS strategy_instances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_id INTEGER NOT NULL,
      instance_id INTEGER NOT NULL,
      assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (strategy_id) REFERENCES strategies (id) ON DELETE CASCADE,
      FOREIGN KEY (instance_id) REFERENCES instances (id) ON DELETE CASCADE,
      UNIQUE(strategy_id, instance_id)
    )
  `);
  await db.run('CREATE INDEX IF NOT EXISTS idx_strategy_instances_strategy_id ON strategy_instances(strategy_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_strategy_instances_instance_id ON strategy_instances(instance_id)');
}

export async function down(db) {
  await db.run('DROP TABLE IF EXISTS strategy_instances');
}
