/**
 * Migration 049: Quick order sync fields
 * - Adds broker_status and last_sync_at to quick_orders
 */

export const version = '049';
export const name = 'add_quick_order_sync_fields';

async function columnExists(db, table, column) {
  const rows = await db.all(`PRAGMA table_info(${table})`);
  return rows.some((r) => r.name === column);
}

export async function up(db) {
  if (!(await columnExists(db, 'quick_orders', 'broker_status'))) {
    await db.run('ALTER TABLE quick_orders ADD COLUMN broker_status TEXT');
  }
  if (!(await columnExists(db, 'quick_orders', 'last_sync_at'))) {
    await db.run('ALTER TABLE quick_orders ADD COLUMN last_sync_at DATETIME');
  }
}

export async function down(_db) {
  // SQLite cannot drop columns; no-op
}
