/**
 * Migration 048: Order provenance fields
 * - Adds provenance columns to watchlist_orders and quick_orders
 */

export const version = '048';
export const name = 'add_order_provenance_fields';

async function columnExists(db, table, column) {
  const rows = await db.all(`PRAGMA table_info(${table})`);
  return rows.some((r) => r.name === column);
}

export async function up(db) {
  const watchlistColumns = [
    { name: 'user_id', type: 'INTEGER' },
    { name: 'source', type: 'TEXT' },
    { name: 'trigger_type', type: 'TEXT' },
    { name: 'request_id', type: 'TEXT' },
    { name: 'correlation_id', type: 'TEXT' },
  ];
  for (const column of watchlistColumns) {
    if (!(await columnExists(db, 'watchlist_orders', column.name))) {
      await db.run(`ALTER TABLE watchlist_orders ADD COLUMN ${column.name} ${column.type}`);
    }
  }

  const quickOrderColumns = [
    { name: 'user_id', type: 'INTEGER' },
    { name: 'source', type: 'TEXT' },
    { name: 'trigger_type', type: 'TEXT' },
    { name: 'request_id', type: 'TEXT' },
    { name: 'correlation_id', type: 'TEXT' },
  ];
  for (const column of quickOrderColumns) {
    if (!(await columnExists(db, 'quick_orders', column.name))) {
      await db.run(`ALTER TABLE quick_orders ADD COLUMN ${column.name} ${column.type}`);
    }
  }
}

export async function down(_db) {
  // SQLite cannot drop columns; no-op
}
