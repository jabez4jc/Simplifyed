/**
 * Migration 024 - Remove unused settings keys
 */

export const version = '024';
export const name = 'prune_unused_settings';

const ALLOWED_KEYS = [
  'server.port',
  'server.node_env',
  'database.path',
  'session.secret',
  'session.max_age_ms',
  'oauth.google.client_id',
  'oauth.google.client_secret',
  'oauth.google.callback_url',
  'cors.origin',
  'cors.credentials',
  'test_mode.enabled',
  'test_mode.user_email',
  'polling.instance_interval_ms',
  'polling.market_data_interval_ms',
  'market_data_feed.quote_ttl_ms',
  'market_data_feed.position_ttl_ms',
  'market_data_feed.funds_ttl_ms',
  'market_data_feed.orderbook_ttl_ms',
  'market_data_feed.tradebook_ttl_ms',
  'auto_exit.monitor_interval_ms',
  'openalgo.request_timeout_ms',
  'openalgo.critical.max_retries',
  'openalgo.critical.retry_delay_ms',
  'openalgo.non_critical.max_retries',
  'openalgo.non_critical.retry_delay_ms',
  'logging.level',
  'logging.file',
  'rate_limit.window_ms',
  'rate_limit.max_requests',
  'trading_sessions',
  'rate_limits.rps_per_instance',
  'rate_limits.rpm_per_instance',
  'rate_limits.orders_per_second',
  'rate_limits.max_concurrent_tasks',
];

export const up = async (db) => {
  const placeholders = ALLOWED_KEYS.map(() => '?').join(',');
  await db.run(
    `DELETE FROM application_settings WHERE key NOT IN (${placeholders})`,
    ALLOWED_KEYS
  );
};

export const down = async () => {
  console.warn('Down migration 024 not implemented (pruned settings are removed permanently)');
};
