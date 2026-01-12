/**
 * Migration 047: Idempotency status code
 * - Adds status_code column for replaying original response code
 */

export const version = '047';
export const name = 'add_idempotency_status_code';

async function columnExists(db, table, column) {
  const rows = await db.all(`PRAGMA table_info(${table})`);
  return rows.some((r) => r.name === column);
}

export async function up(db) {
  const hasColumn = await columnExists(db, 'idempotency_keys', 'status_code');
  if (!hasColumn) {
    await db.run('ALTER TABLE idempotency_keys ADD COLUMN status_code INTEGER');
  }
}

export async function down(_db) {
  // SQLite does not support DROP COLUMN; no-op
}
