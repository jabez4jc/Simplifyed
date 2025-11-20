/**
 * Migration 018: Add websocket_url to instances
 */

export const version = '018';
export const name = 'add_instance_websocket_url';

async function columnExists(db, tableName, columnName) {
  const columns = await db.all(`PRAGMA table_info(${tableName})`);
  return columns.some(col => col.name === columnName);
}

export async function up(db) {
  const exists = await columnExists(db, 'instances', 'websocket_url');
  if (!exists) {
    await db.run(`
      ALTER TABLE instances ADD COLUMN websocket_url TEXT
    `);
  }
}

export async function down() {
  console.warn('Rollbacks for migration 018 not implemented (manual table rebuild required)');
}
