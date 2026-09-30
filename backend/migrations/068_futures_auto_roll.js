/**
 * Migration 068: futures auto-roll
 *
 * Indian exchanges list no perpetual futures, so a watchlist row for a dated contract went stale
 * at expiry. `auto_roll` makes the row follow a series instead of one contract:
 *   0  off - the row stays on its contract and is disabled when it expires (the old behaviour)
 *   1  nearest live contract   (TradingView's NIFTY1!)
 *   2  the contract after that (TradingView's NIFTY2!)
 * See services/futures-roll.service.js.
 */

export const version = '068';
export const name = 'futures_auto_roll';

export async function up(db) {
  const existing = (await db.all('PRAGMA table_info(watchlist_symbols)')).map((c) => c.name);
  if (!existing.includes('auto_roll')) {
    await db.run(
      'ALTER TABLE watchlist_symbols ADD COLUMN auto_roll INTEGER NOT NULL DEFAULT 0 CHECK(auto_roll IN (0, 1, 2))'
    );
  }
}

export async function down(db) {
  await db.run('ALTER TABLE watchlist_symbols DROP COLUMN auto_roll').catch(() => {});
}
