/**
 * Migration 071: Drop watchlists.limit_buffer_pct
 *
 * This column existed only to feed tradingview-broadcast.service's own MARKET-to-LIMIT pricing
 * (_ensureLimitPricing), which bypassed openalgoClient entirely - no circuit breaker, no rate
 * limit, no SEBI SL-M->SL conversion, no broker-unit conversion, and no watchlist_orders row (see
 * audit C4). Broadcast dispatch now goes through order.service.placeOrder like every other order
 * path, which prices a marketable LIMIT via limit-price.service instead.
 */

export const version = '071';
export const name = 'drop_watchlist_limit_buffer_pct';

export async function up(db) {
  const existing = (await db.all('PRAGMA table_info(watchlists)')).map((c) => c.name);
  if (existing.includes('limit_buffer_pct')) {
    await db.run('ALTER TABLE watchlists DROP COLUMN limit_buffer_pct');
  }
}

export async function down() {
  // Nothing to restore: no code reads this column any more.
}
