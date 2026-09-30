/**
 * Migration 067: Kill switch permission, and tuning values that are no longer settings
 *
 * The top-bar Pause button is gone (a trading app must never stop watching its positions), and
 * its permission becomes the one for the global kill switch. Every role that could pause keeps
 * the right to hit the kill switch.
 *
 * Settings > Advanced is gone. Its values were read from up to four places (this table, .env,
 * a hardcoded fallback and a defaults list) and the screen did not always show the value in use.
 * Two stay as settings (openalgo.request_timeout_ms, rate_limits.smart_orders_per_second); the
 * rest are now fixed values in core/config.js, so their rows are deleted. So are the two hidden
 * debug switches that turned off rate limiting and the circuit breaker.
 */

export const version = '067';
export const name = 'kill_switch_and_fixed_tuning';

const RETIRED = [
  'polling.instance_interval_ms',
  'polling.market_data_interval_ms',
  'market_data_feed.quote_ttl_idle_ms',
  'market_data_feed.quote_ttl_active_ms',
  'market_data_feed.multiquote_cooldown_idle_ms',
  'market_data_feed.multiquote_cooldown_active_ms',
  'market_data_feed.position_interval_idle_ms',
  'market_data_feed.position_interval_active_ms',
  'market_data_feed.tradebook_interval_idle_ms',
  'market_data_feed.tradebook_interval_active_ms',
  'market_data_feed.orderbook_interval_ms',
  'market_data_feed.funds_interval_ms',
  'rate_limits.rps_per_instance',
  'rate_limits.rpm_per_instance',
  'rate_limits.orders_per_second',
  'rate_limits.max_concurrent_tasks',
  'rate_limits.disabled',
  'rate_limits.circuit_breaker_disabled',
  'openalgo.critical.max_retries',
  'openalgo.critical.retry_delay_ms',
  'openalgo.non_critical.max_retries',
  'openalgo.non_critical.retry_delay_ms',
  'instance_health.ping_healthy_interval_ms',
  'instance_health.ping_unhealthy_interval_ms',
  'instance_health.analyzer_check_interval_ms',
  'settings.cache_duration_ms',
];

export async function up(db) {
  await db.run(
    `UPDATE permissions SET key = 'killswitch.execute',
       description = 'Kill switch: close everything and switch all instances to analyzer'
     WHERE key = 'marketdata.pause_resume'`
  );
  await db.run(`DELETE FROM application_settings WHERE key IN (${RETIRED.map(() => '?').join(',')})`, RETIRED);
}

export async function down() {
  // Nothing reads the retired rows; the permission rename is harmless to keep.
}
