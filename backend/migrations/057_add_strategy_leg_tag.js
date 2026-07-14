/**
 * Migration 057: Strategy leg tag
 * Adds a user-editable, free-text label to strategy_legs so a specific leg can be addressed
 * externally (TradingView webhook alerts) or in the UI without needing the internal numeric
 * leg id. Unique per-strategy (not globally, unlike strategies.broker_tag) - two different
 * strategies may legitimately both want a leg called "put_leg".
 */

export const version = '057';
export const name = 'add_strategy_leg_tag';

export async function up(db) {
  await db.run(`ALTER TABLE strategy_legs ADD COLUMN leg_tag TEXT`);

  await db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_strategy_legs_tag
    ON strategy_legs(strategy_id, leg_tag) WHERE leg_tag IS NOT NULL
  `);

  console.log('  ✅ Migration 057 completed');
}

export async function down(db) {
  await db.run('DROP INDEX IF EXISTS idx_strategy_legs_tag');
}
