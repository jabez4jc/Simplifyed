/**
 * Migration 065: Retire dead settings, permissions and tables
 *
 * The fixed IST blackout windows were replaced by a failure-driven circuit breaker (see
 * integrations/openalgo/instance-health-tracker.service.js): an unreachable instance is paused on
 * its own evidence, not by the clock. Nothing reads these rows any more:
 *
 *   market_hours.quote_blackout_start / _end
 *   market_hours.general_blackout_start / _end
 *   instance_health.ping_unhealthy_max_attempts   ("manual refresh required after N failures" -
 *                                                  the breaker never locks into manual refresh)
 *
 * Three permissions nothing checks: pages.audit.view and pages.api_playground.view (those pages
 * were removed) and monitor.view (never wired to anything).
 *
 * And tables that nothing writes (or, once their read routes went, nothing reads) - all empty in
 * every database we have seen. Fresh installs no longer create them (000_initial_schema).
 */

export const version = '065';
export const name = 'retire_dead_schema';

const RETIRED = [
  'market_hours.quote_blackout_start',
  'market_hours.quote_blackout_end',
  'market_hours.general_blackout_start',
  'market_hours.general_blackout_end',
  'instance_health.ping_unhealthy_max_attempts',
];

const RETIRED_PERMISSIONS = ['pages.audit.view', 'pages.api_playground.view', 'monitor.view'];

const DEAD_TABLES = [
  'analyzer_trades', 'market_data', 'market_holidays', 'options_cache', 'order_monitor_log',
  'symbol_search_cache', 'system_alerts', 'telegram_message_log', 'user_telegram_config',
  'watchlist_positions', 'websocket_sessions',
];

export async function up(db) {
  await db.run(`DELETE FROM application_settings WHERE key IN (${RETIRED.map(() => '?').join(',')})`, RETIRED);
  const perms = RETIRED_PERMISSIONS.map(() => '?').join(',');
  await db.run(`DELETE FROM role_permissions WHERE permission_id IN (SELECT id FROM permissions WHERE key IN (${perms}))`, RETIRED_PERMISSIONS);
  await db.run(`DELETE FROM permissions WHERE key IN (${perms})`, RETIRED_PERMISSIONS);
  for (const table of DEAD_TABLES) await db.run(`DROP TABLE IF EXISTS ${table}`);

}

export async function down() {
  // Nothing to restore: no code reads these keys or tables or checks these permissions.
}
