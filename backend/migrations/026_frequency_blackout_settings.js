/**
 * Migration 026 - Add frequency + blackout settings
 */

export const version = '026';
export const name = 'frequency_blackout_settings';

export const up = async (db) => {
  await db.run(`
    INSERT OR IGNORE INTO application_settings (key, value, description, category, data_type)
    VALUES
      ('market_hours.quote_blackout_start', '02:00', 'Quote endpoint blackout start time (IST)', 'market_hours', 'string'),
      ('market_hours.quote_blackout_end', '08:45', 'Quote endpoint blackout end time (IST)', 'market_hours', 'string'),
      ('market_hours.general_blackout_start', '03:00', 'General endpoint blackout start time (IST)', 'market_hours', 'string'),
      ('market_hours.general_blackout_end', '08:00', 'General endpoint blackout end time (IST)', 'market_hours', 'string'),

      ('instance_health.ping_healthy_interval_ms', '300000', 'Ping cadence for healthy instances (ms)', 'instance_health', 'number'),
      ('instance_health.ping_unhealthy_interval_ms', '180000', 'Ping cadence for unhealthy instances (ms)', 'instance_health', 'number'),
      ('instance_health.ping_unhealthy_max_attempts', '5', 'Max unhealthy ping attempts before manual refresh is required', 'instance_health', 'number'),
      ('instance_health.analyzer_check_interval_ms', '15000', 'Analyzer status refresh interval (ms)', 'instance_health', 'number'),

      ('market_data_feed.quote_ttl_idle_ms', '15000', 'Quote cache TTL when idle (ms)', 'market_data_feed', 'number'),
      ('market_data_feed.quote_ttl_active_ms', '10000', 'Quote cache TTL when open positions exist (ms)', 'market_data_feed', 'number'),
      ('market_data_feed.position_interval_idle_ms', '30000', 'Positionbook refresh interval when idle (ms)', 'market_data_feed', 'number'),
      ('market_data_feed.position_interval_active_ms', '8000', 'Positionbook refresh interval when positions exist (ms)', 'market_data_feed', 'number'),
      ('market_data_feed.tradebook_interval_idle_ms', '30000', 'Tradebook refresh interval when idle (ms)', 'market_data_feed', 'number'),
      ('market_data_feed.tradebook_interval_active_ms', '8000', 'Tradebook refresh interval when positions exist (ms)', 'market_data_feed', 'number'),
      ('market_data_feed.orderbook_interval_ms', '30000', 'Orderbook refresh interval (ms)', 'market_data_feed', 'number'),
      ('market_data_feed.multiquote_cooldown_idle_ms', '15000', 'MultiQuotes cooldown when idle (ms)', 'market_data_feed', 'number'),
      ('market_data_feed.multiquote_cooldown_active_ms', '10000', 'MultiQuotes cooldown when positions exist (ms)', 'market_data_feed', 'number'),
      ('market_data_feed.funds_interval_ms', '180000', 'Funds refresh interval (ms)', 'market_data_feed', 'number')
  `);
};

export const down = async (db) => {
  await db.run(`
    DELETE FROM application_settings
    WHERE key IN (
      'market_hours.quote_blackout_start',
      'market_hours.quote_blackout_end',
      'market_hours.general_blackout_start',
      'market_hours.general_blackout_end',
      'instance_health.ping_healthy_interval_ms',
      'instance_health.ping_unhealthy_interval_ms',
      'instance_health.ping_unhealthy_max_attempts',
      'instance_health.analyzer_check_interval_ms',
      'market_data_feed.quote_ttl_idle_ms',
      'market_data_feed.quote_ttl_active_ms',
      'market_data_feed.position_interval_idle_ms',
      'market_data_feed.position_interval_active_ms',
      'market_data_feed.tradebook_interval_idle_ms',
      'market_data_feed.tradebook_interval_active_ms',
      'market_data_feed.orderbook_interval_ms',
      'market_data_feed.multiquote_cooldown_idle_ms',
      'market_data_feed.multiquote_cooldown_active_ms',
      'market_data_feed.funds_interval_ms'
    )
  `);
};
