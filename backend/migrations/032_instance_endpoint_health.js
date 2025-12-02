import db from '../src/core/database.js';

export async function up(db) {
  await db.run('ALTER TABLE instances ADD COLUMN quotes_ok INTEGER DEFAULT 0');
  await db.run('ALTER TABLE instances ADD COLUMN quotes_checked_at TEXT');
  await db.run('ALTER TABLE instances ADD COLUMN quotes_failure_reason TEXT');
  await db.run('ALTER TABLE instances ADD COLUMN multiquotes_ok INTEGER DEFAULT 0');
  await db.run('ALTER TABLE instances ADD COLUMN multiquotes_checked_at TEXT');
  await db.run('ALTER TABLE instances ADD COLUMN multiquotes_failure_reason TEXT');
  await db.run('ALTER TABLE instances ADD COLUMN optionchain_ok INTEGER DEFAULT 0');
  await db.run('ALTER TABLE instances ADD COLUMN optionchain_checked_at TEXT');
  await db.run('ALTER TABLE instances ADD COLUMN optionchain_failure_reason TEXT');
  await db.run('ALTER TABLE instances ADD COLUMN disable_quotes INTEGER DEFAULT 0');
  await db.run('ALTER TABLE instances ADD COLUMN disable_multiquotes INTEGER DEFAULT 0');
  await db.run('ALTER TABLE instances ADD COLUMN disable_optionchain INTEGER DEFAULT 0');
}

export async function down() {
  // SQLite does not support DROP COLUMN easily; no-op downgrade
  return;
}
export const version = '032';
export const name = 'instance_endpoint_health';
