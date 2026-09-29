/**
 * Migration 063: per-broker lot sizes
 *
 * The instruments cache holds one canonical copy of every contract. Lot size is the one field
 * that is a broker's own unit rather than a property of the contract: Kotak reports MCX GOLDM as
 * 100 (grams) where Fyers reports 10 (price units of 10g), GOLD as 1 vs 100, and ALUMINIUM/LEAD/
 * ZINC as 5 vs 5000. A fanned-out order in canonical units must be rescaled per broker, and the
 * broker's positions scaled back.
 *
 * This table remembers each broker's lot size per contract (checked via that broker's own
 * OpenAlgo `symbol` endpoint), so a restart or a slow broker does not leave the order path
 * without it. Rows are only needed where a broker was checked; a missing row means "not yet
 * checked", never "same as canonical".
 */

export const version = '063';
export const name = 'broker_lot_sizes';

export async function up(db) {
  await db.run(`
    CREATE TABLE IF NOT EXISTS broker_lot_sizes (
      broker TEXT NOT NULL,
      exchange TEXT NOT NULL,
      symbol TEXT NOT NULL,
      broker_lotsize REAL NOT NULL,
      canonical_lotsize REAL NOT NULL,
      checked_at TEXT NOT NULL,
      PRIMARY KEY (broker, exchange, symbol)
    )
  `);
}

export async function down(db) {
  await db.run('DROP TABLE IF EXISTS broker_lot_sizes');
}
