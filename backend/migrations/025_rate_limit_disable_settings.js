/**
 * Migration 025 - Add settings to disable rate limits and circuit breaker for testing
 */

export const version = '025';
export const name = 'rate_limit_disable_settings';

export const up = async (db) => {
  const entries = [
    {
      key: 'rate_limits.disabled',
      value: 'false',
      description: 'Disable all rate limiting (for testing only - not recommended for production)',
      data_type: 'boolean',
    },
    {
      key: 'rate_limits.circuit_breaker_disabled',
      value: 'false',
      description: 'Disable circuit breaker for unhealthy instances (for testing only)',
      data_type: 'boolean',
    },
  ];

  for (const entry of entries) {
    await db.run(
      `INSERT OR IGNORE INTO application_settings
        (key, value, description, category, data_type, is_sensitive)
       VALUES (?, ?, ?, 'rate_limits', ?, 0)`,
      [entry.key, entry.value, entry.description, entry.data_type]
    );
  }
};

export const down = async (db) => {
  await db.run(`DELETE FROM application_settings WHERE key = 'rate_limits.disabled'`);
  await db.run(`DELETE FROM application_settings WHERE key = 'rate_limits.circuit_breaker_disabled'`);
};
