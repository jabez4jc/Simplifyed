/**
 * Migration 022 - Set per-instance RPM and remove global RPM limit setting
 */

export const version = '022';
export const name = 'set_per_instance_rpm';

export const up = async (db) => {
  // Insert per-instance RPM setting if missing (default 300)
  await db.run(
    `INSERT OR IGNORE INTO application_settings
      (key, value, description, category, data_type, is_sensitive)
     VALUES (?, ?, ?, 'rate_limits', 'number', 0)`,
    [
      'rate_limits.rpm_per_instance',
      '300',
      'Max requests per minute per instance',
    ]
  );

  // Remove old global RPM setting to avoid UI confusion
  await db.run(
    `DELETE FROM application_settings WHERE key = ?`,
    ['rate_limits.rpm_global']
  );
};

export const down = async (db) => {
  // Restore rpm_global with default 300 and remove rpm_per_instance
  await db.run(
    `DELETE FROM application_settings WHERE key = ?`,
    ['rate_limits.rpm_per_instance']
  );
  await db.run(
    `INSERT OR IGNORE INTO application_settings
      (key, value, description, category, data_type, is_sensitive)
     VALUES (?, ?, ?, 'rate_limits', 'number', 0)`,
    [
      'rate_limits.rpm_global',
      '300',
      'Max requests per minute across all instances',
    ]
  );
};
