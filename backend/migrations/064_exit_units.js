/**
 * Migration 064: targets and stop-losses in points OR percent
 *
 * Auto-exit thresholds were points only. Each trade mode (direct / futures / options) on a
 * watchlist symbol, and each strategy leg, now carries a unit for its target, stop-loss, trailing
 * stop and trailing activation: 'POINTS' (the default - existing settings keep their meaning) or
 * 'PERCENT' (of the position's entry price, converted to points when the exit is evaluated).
 */

export const version = '064';
export const name = 'exit_units';

const COLUMNS = [
  ['watchlist_symbols', 'exit_unit_direct'],
  ['watchlist_symbols', 'exit_unit_futures'],
  ['watchlist_symbols', 'exit_unit_options'],
  ['strategy_legs', 'exit_unit'],
];

export async function up(db) {
  for (const [table, column] of COLUMNS) {
    const existing = (await db.all(`PRAGMA table_info(${table})`)).map((c) => c.name);
    if (!existing.includes(column)) {
      await db.run(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT NOT NULL DEFAULT 'POINTS'`);
    }
  }
}

export async function down(db) {
  for (const [table, column] of COLUMNS) {
    await db.run(`ALTER TABLE ${table} DROP COLUMN ${column}`).catch(() => {});
  }
}
