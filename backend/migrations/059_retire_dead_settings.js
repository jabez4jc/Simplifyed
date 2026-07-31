/**
 * Migration 059: Retire settings that cannot be changed at runtime
 *
 * The application_settings table had accumulated rows that a Settings screen would happily
 * present as editable, but where a change was at best a no-op and at worst a live security
 * hole. Each removal below falls back to the environment variable or hardcoded default the
 * code already used, so behaviour is unchanged except where noted.
 *
 * Security-relevant:
 *   session.secret        Shipped as the literal 'CHANGE_THIS_IN_PRODUCTION' and loaded over
 *                         the required SESSION_SECRET env var - but only *after* express-session
 *                         had already signed cookies with the env value at module load. The WS
 *                         gateway's cookie check (server.js validateWsSessionFromRequest) then
 *                         verified against the database value and rejected every connection, so
 *                         live streaming has been silently falling back to REST polling.
 *   test_mode.enabled     Read into config.testMode.enabled, which optionalAuth treats as a
 *   test_mode.user_email  process-wide switch to a hardcoded admin identity. A settings row
 *                         must never be able to turn off authentication; ENABLE_TEST_MODE stays
 *                         available as an environment variable.
 *   oauth.google.*        No Google sign-in route exists any more (local email/password is the
 *                         only method). The rows were dead, and client_secret held a real
 *                         credential in plaintext.
 *
 * Applied only at startup, so editing them did nothing until a restart:
 *   server.port, server.node_env, database.path, cors.origin, cors.credentials,
 *   logging.level, logging.file, session.max_age_ms
 *
 * Note cors.credentials was doubly dead: server.js passes a hardcoded `credentials: true`.
 * logging.* was doubly dead too: winston reads process.env.LOG_LEVEL directly at import.
 * session.max_age_ms was never read at all - the cookie maxAge is hardcoded in auth.js.
 *
 * Superseded fallbacks - the code reads `X_idle_ms || X_ttl_ms || DEFAULT`, and the idle/active
 * rows are always populated, so these were unreachable:
 *   market_data_feed.quote_ttl_ms, position_ttl_ms, funds_ttl_ms, orderbook_ttl_ms,
 *   market_data_feed.tradebook_ttl_ms
 *
 * Never wired up - the app has no rate-limiting middleware and no such dependency:
 *   rate_limit.window_ms, rate_limit.max_requests   (note: the *plural* rate_limits.* category
 *                                                    is real and is kept)
 *
 * Deliberately KEPT despite being hidden from the UI: rate_limits.disabled and
 * rate_limits.circuit_breaker_disabled. They disable protections against flooding a live
 * broker, so they are excluded from the editable registry rather than deleted - a developer can
 * still set them directly during an incident.
 */

export const version = '059';
export const name = 'retire_dead_settings';

const RETIRED = [
  'session.secret',
  'session.max_age_ms',
  'test_mode.enabled',
  'test_mode.user_email',
  'oauth.google.client_id',
  'oauth.google.client_secret',
  'oauth.google.callback_url',
  'server.port',
  'server.node_env',
  'database.path',
  'cors.origin',
  'cors.credentials',
  'logging.level',
  'logging.file',
  'rate_limit.window_ms',
  'rate_limit.max_requests',
  'market_data_feed.quote_ttl_ms',
  'market_data_feed.position_ttl_ms',
  'market_data_feed.funds_ttl_ms',
  'market_data_feed.orderbook_ttl_ms',
  'market_data_feed.tradebook_ttl_ms',
];

export async function up(db) {
  const placeholders = RETIRED.map(() => '?').join(',');
  await db.run(`DELETE FROM application_settings WHERE key IN (${placeholders})`, RETIRED);
}

export async function down(db) {
  // Restores the rows as empty/neutral values rather than their previous contents - the point of
  // the migration is that those contents were wrong or unsafe. Anything genuinely needed is read
  // from the environment, so an empty row here is inert.
  const placeholders = RETIRED.map(() => '?').join(',');
  const existing = await db.all(
    `SELECT key FROM application_settings WHERE key IN (${placeholders})`,
    RETIRED
  );
  const present = new Set(existing.map((r) => r.key));
  for (const key of RETIRED) {
    if (present.has(key)) continue;
    await db.run(
      `INSERT INTO application_settings (key, value, description, category, data_type)
       VALUES (?, '', 'Restored by migration 059 rollback; not runtime-editable.', ?, 'string')`,
      [key, key.split('.')[0]]
    );
  }
}
