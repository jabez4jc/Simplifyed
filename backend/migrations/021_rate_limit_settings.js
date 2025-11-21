/**
 * Migration 021 - Seed rate limit settings
 */

export const version = '021';
export const name = 'rate_limit_settings';

export const up = async (db) => {
  const entries = [
    {
      key: 'rate_limits.rps_per_instance',
      value: '5',
      description: 'Max requests per second per instance',
      data_type: 'number',
    },
    {
      key: 'rate_limits.rpm_global',
      value: '300',
      description: 'Max requests per minute across all instances',
      data_type: 'number',
    },
    {
      key: 'rate_limits.orders_per_second',
      value: '10',
      description: 'Max order placement requests per second (per instance/global)',
      data_type: 'number',
    },
    {
      key: 'rate_limits.max_concurrent_tasks',
      value: '10',
      description: 'Max concurrent OpenAlgo HTTP calls',
      data_type: 'number',
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

export const down = async () => {
  console.warn('Down migration 021 not implemented (settings rows are non-destructive)');
};
