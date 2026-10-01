/**
 * Migration 072: Drop the ANCHOR_OFS leftovers (audit H9)
 *
 * ANCHOR_OFS was advertised but never implemented: the anchored_* columns were written and never
 * read, and strategy_legs.strike_policy was stored and never used. Strike resolution is always
 * "float with ATM".
 *
 * watchlist_symbols.strike_policy is left in place on purpose: it carries a column CHECK
 * constraint, which makes SQLite refuse DROP COLUMN, and rebuilding that wide, FK-referenced table
 * is not worth it for one unused column. Nothing reads or writes it.
 */

export const version = '072';
export const name = 'drop_anchor_columns';

async function dropColumns(db, table, columns) {
  const existing = (await db.all(`PRAGMA table_info(${table})`)).map((c) => c.name);
  for (const col of columns) {
    if (existing.includes(col)) await db.run(`ALTER TABLE ${table} DROP COLUMN ${col}`);
  }
}

export async function up(db) {
  await dropColumns(db, 'watchlist_symbols', ['anchored_ce_strike', 'anchored_pe_strike', 'anchored_expiry']);
  await dropColumns(db, 'strategy_legs', ['strike_policy']);
}

export async function down() {
  // Nothing to restore: no code reads these columns any more.
}
