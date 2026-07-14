/**
 * Migration 056: Strategy broker tag
 * Adds a user-editable broker-facing label to strategies, replacing the hardcoded
 * `strategy-${id}` string previously sent as the OpenAlgo `strategy` field on basket
 * orders/closes/GTTs and used to seed strategy_leg_executions.execution_id /
 * watchlist_orders.correlation_id. Existing strategies are backfilled to their current
 * implicit value so behavior is unchanged unless a user renames the tag.
 */

export const version = '056';
export const name = 'add_strategy_broker_tag';

export async function up(db) {
  await db.run(`ALTER TABLE strategies ADD COLUMN broker_tag TEXT`);

  await db.run(`UPDATE strategies SET broker_tag = 'strategy-' || id WHERE broker_tag IS NULL`);

  // Partial unique index (NULLs excluded) - safety net against two strategies sharing a tag,
  // which would make the OpenAlgo instance log ambiguous about which app strategy an order
  // belongs to. The service layer does a friendly pre-check before insert/update; this is the
  // last-resort guard against races.
  await db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_strategies_broker_tag
    ON strategies(broker_tag) WHERE broker_tag IS NOT NULL
  `);

  console.log('  ✅ Migration 056 completed');
}

export async function down(db) {
  await db.run('DROP INDEX IF EXISTS idx_strategies_broker_tag');
}
