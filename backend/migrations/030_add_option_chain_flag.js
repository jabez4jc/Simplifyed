/**
 * Migration 030 - Add supports_option_chain flag to instances
 */

export const version = '030';
export const name = 'add_option_chain_flag';

async function columnExists(db, table, column) {
  const row = await db.get(
    `SELECT name FROM pragma_table_info('instances') WHERE name = ?`,
    [column]
  );
  return !!row;
}

export async function up(db) {
  // Avoid lockups if app is running
  await db.run('PRAGMA busy_timeout = 5000');

  const exists = await columnExists(db, 'instances', 'supports_option_chain');
  if (exists) {
    console.log('  ℹ️  supports_option_chain column already exists on instances');
    return;
  }

  await db.run(`
    ALTER TABLE instances
    ADD COLUMN supports_option_chain INTEGER DEFAULT 0
  `);

  console.log('  ✅ Added supports_option_chain column to instances');
}

export async function down(db) {
  console.log('  ⚠️  Down migration not supported for supports_option_chain (SQLite does not drop columns safely)');
}
