/**
 * Migration 045: add manual/webhook signal counts to daily snapshots
 */

export const version = '045';
export const name = 'add_daily_pnl_signal_counts';

export async function up(db) {
  await db.run(`
    ALTER TABLE daily_instance_pnl_snapshots
    ADD COLUMN webhook_buy_signals INTEGER NOT NULL DEFAULT 0
  `);
  await db.run(`
    ALTER TABLE daily_instance_pnl_snapshots
    ADD COLUMN webhook_sell_signals INTEGER NOT NULL DEFAULT 0
  `);
  await db.run(`
    ALTER TABLE daily_instance_pnl_snapshots
    ADD COLUMN manual_buy_signals INTEGER NOT NULL DEFAULT 0
  `);
  await db.run(`
    ALTER TABLE daily_instance_pnl_snapshots
    ADD COLUMN manual_sell_signals INTEGER NOT NULL DEFAULT 0
  `);
}

export async function down(db) {
  console.warn('Rollback for migration 045 is not implemented (SQLite column removal requires table rebuild).');
}
