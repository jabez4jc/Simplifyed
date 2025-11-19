/**
 * Migration 017: Add WebSocket Role to Instances
 * Allows tagging instances as websocket primary/secondary for streaming data.
 */

export const version = '017';
export const name = 'add_instance_websocket_role';

async function columnExists(db, tableName, columnName) {
  const columns = await db.all(`PRAGMA table_info(${tableName})`);
  return columns.some(col => col.name === columnName);
}

async function addColumn(db, tableName, columnDef) {
  await db.run(columnDef);
}

export async function up(db) {
  console.log('  ℹ️  Adding websocket_role column to instances');

  const exists = await columnExists(db, 'instances', 'websocket_role');
  if (!exists) {
    await db.run(`
      ALTER TABLE instances ADD COLUMN websocket_role TEXT DEFAULT 'none'
        CHECK (websocket_role IN ('none','primary','secondary'))
    `);
  } else {
    console.log('    ⊙ websocket_role already exists');
  }

  console.log('  ✅ Migration 017 completed');
}

export async function down() {
  console.warn('  ⚠️  Rollback for Migration 017 not implemented (requires table rebuild)');
}
