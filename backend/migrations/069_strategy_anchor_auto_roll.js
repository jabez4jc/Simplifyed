/**
 * Migration 069: strategy anchors auto-roll
 *
 * A strategy resolves its legs off an "anchor" row: its underlying's contract. On MCX that is
 * always a dated future (there is no bare commodity symbol), so every MCX strategy stopped working
 * at its anchor's expiry ("Strategy anchor ... expired - roll it to a live contract"), and a
 * strategy watchlist's rows cannot be edited from the UI to fix it. New anchors are created with
 * auto_roll = 1 (strategy.service.js); this switches the existing ones over. The next expiry purge
 * (startup, 17:50, 00:05 IST) then moves each onto the nearest live contract.
 *
 * The anchor is picked as watchlistSymbolService.findAnchorByWatchlist picks it - live row first,
 * else the oldest - so exactly one row per strategy changes, never its option leg-exit rows.
 */

import { isContractExpired } from '../src/utils/underlying.util.js';

export const version = '069';
export const name = 'strategy_anchor_auto_roll';

const ROLLABLE = ['NFO', 'BFO', 'MCX', 'CDS'];

export async function up(db) {
  const strategies = await db.all('SELECT id, watchlist_id, exchange, underlying FROM strategies');
  for (const s of strategies) {
    if (!ROLLABLE.includes(String(s.exchange || '').toUpperCase())) continue;
    const rows = await db.all(
      `SELECT * FROM watchlist_symbols
        WHERE watchlist_id = ? AND exchange = ? AND (underlying_symbol = ? OR symbol = ?)
        ORDER BY id`,
      [s.watchlist_id, s.exchange, s.underlying, s.underlying]
    );
    const anchor = rows.find((r) => !isContractExpired(r)) || rows[0];
    const isFuture = anchor && (anchor.symbol_type === 'FUTURES' || anchor.instrumenttype === 'FUT');
    if (isFuture && !anchor.auto_roll) {
      await db.run('UPDATE watchlist_symbols SET auto_roll = 1 WHERE id = ?', [anchor.id]);
    }
  }
}

export async function down() {
  // Nothing to undo safely: the anchors may already have rolled onto live contracts.
}
