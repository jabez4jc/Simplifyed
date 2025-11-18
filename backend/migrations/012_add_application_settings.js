/**
 * Migration 012: Add Application Settings Table
 * Stores all configurable settings in database for runtime updates
 */

export const version = '012';
export const name = 'add_application_settings';

export async function up(db) {
  await db.run(`
    CREATE TABLE application_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL,
      description TEXT,
      category TEXT NOT NULL,
      data_type TEXT NOT NULL CHECK(data_type IN ('string', 'number', 'boolean', 'json')),
      is_sensitive BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create indexes for faster lookups
  await db.run('CREATE INDEX idx_application_settings_key ON application_settings(key)');
  await db.run('CREATE INDEX idx_application_settings_category ON application_settings(category)');

  // Insert default settings
  await db.run(`
    INSERT INTO application_settings (key, value, description, category, data_type) VALUES
    -- Server Configuration
    ('server.port', '3000', 'Server port number', 'server', 'number'),
    ('server.node_env', 'development', 'Environment (development/production/test)', 'server', 'string'),

    -- Polling Configuration
    ('polling.instance_interval_ms', '15000', 'Interval for instance P&L polling in milliseconds', 'polling', 'number'),
    ('polling.market_data_interval_ms', '5000', 'Interval for market data polling in milliseconds', 'polling', 'number'),
    ('polling.health_check_interval_ms', '300000', 'Interval for health checks in milliseconds', 'polling', 'number'),

    -- OpenAlgo Configuration
    ('openalgo.request_timeout_ms', '15000', 'OpenAlgo API request timeout in milliseconds', 'openalgo', 'number'),
    ('openalgo.critical.max_retries', '5', 'Max retries for critical operations', 'openalgo', 'number'),
    ('openalgo.critical.retry_delay_ms', '1000', 'Retry delay for critical operations in milliseconds', 'openalgo', 'number'),
    ('openalgo.non_critical.max_retries', '3', 'Max retries for non-critical operations', 'openalgo', 'number'),
    ('openalgo.non_critical.retry_delay_ms', '1000', 'Retry delay for non-critical operations in milliseconds', 'openalgo', 'number'),

    -- Database Configuration
    ('database.path', './database/simplifyed.db', 'SQLite database file path', 'database', 'string'),

    -- Session Configuration
    ('session.secret', 'CHANGE_THIS_IN_PRODUCTION', 'Session encryption secret', 'session', 'string'),
    ('session.max_age_ms', '604800000', 'Session max age in milliseconds (7 days)', 'session', 'number'),

    -- CORS Configuration
    ('cors.origin', 'http://localhost:3000', 'CORS allowed origin', 'cors', 'string'),
    ('cors.credentials', 'true', 'Allow credentials in CORS', 'cors', 'boolean'),

    -- Logging Configuration
    ('logging.level', 'info', 'Log level (error/warn/info/debug)', 'logging', 'string'),
    ('logging.file', './logs/app.log', 'Log file path', 'logging', 'string'),

    -- Rate Limiting
    ('rate_limit.window_ms', '60000', 'Rate limit window in milliseconds', 'rate_limit', 'number'),
    ('rate_limit.max_requests', '100', 'Maximum requests per window', 'rate_limit', 'number'),

    -- Google OAuth (optional)
    ('oauth.google.client_id', '', 'Google OAuth client ID', 'oauth', 'string'),
    ('oauth.google.client_secret', '', 'Google OAuth client secret', 'oauth', 'string'),
    ('oauth.google.callback_url', 'http://localhost:3000/auth/google/callback', 'OAuth callback URL', 'oauth', 'string'),

    -- Test Mode
    ('test_mode.enabled', 'false', 'Enable test mode (skip OAuth)', 'test', 'boolean'),
    ('test_mode.user_email', 'test@simplifyed.in', 'Test user email', 'test', 'string'),

    -- Proxy Configuration
    ('proxy.url', '', 'Proxy URL for OpenAlgo requests', 'proxy', 'string'),
    ('proxy.tls_reject_unauthorized', 'true', 'TLS certificate verification for proxy', 'proxy', 'boolean')
  `);

  console.log('  ✅ Created application_settings table with default values');
  console.log('  ✅ Inserted 26 default settings across 9 categories');
}

export async function down(db) {
  await db.run('DROP TABLE IF EXISTS application_settings');
  console.log('  ✅ Dropped application_settings table');
}
