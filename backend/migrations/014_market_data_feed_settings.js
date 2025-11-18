/**
 * Migration 014: Add Market Data Feed TTL settings
 */

export const version = '014';
export const name = 'market_data_feed_settings';

export async function up(db) {
  await db.run(`
    INSERT INTO application_settings (key, value, description, category, data_type) VALUES
    ('market_data_feed.quote_ttl_ms', '2500', 'Market data feed quote cache TTL in milliseconds', 'market_data_feed', 'number'),
    ('market_data_feed.position_ttl_ms', '8000', 'Market data feed position cache TTL in milliseconds', 'market_data_feed', 'number'),
    ('market_data_feed.funds_ttl_ms', '20000', 'Market data feed funds cache TTL in milliseconds', 'market_data_feed', 'number'),
    ('market_data_feed.orderbook_ttl_ms', '5000', 'Market data feed orderbook cache TTL in milliseconds', 'market_data_feed', 'number')
  `);
  console.log('  ✅ Added market data feed TTL settings');
}

export async function down(db) {
  await db.run(`
    DELETE FROM application_settings
    WHERE key IN ('market_data_feed.quote_ttl_ms', 'market_data_feed.position_ttl_ms', 'market_data_feed.funds_ttl_ms')
  `);
  console.log('  ✅ Removed market data feed TTL settings');
}
