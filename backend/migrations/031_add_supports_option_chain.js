/**
 * Migration 031 - Add supports_option_chain flag to instances
 * (re-adding in case prior migration was not applied)
 */

export const version = '031';
export const name = 'add_supports_option_chain_v2';

async function columnExists(db, column) {
  // Note: pragma_table_info cannot parameterize table name; table is trusted constant
  const row = await db.get(
    `SELECT name FROM pragma_table_info('instances') WHERE name = ?`,
    [column]
  );
  return !!row;
}

export async function up(db) {
  await db.run('PRAGMA busy_timeout = 5000');

  const exists = await columnExists(db, 'supports_option_chain');
  if (exists) {
    console.log('  ℹ️  supports_option_chain already exists on instances');
    return;
  }

  await db.run(`
    ALTER TABLE instances
    ADD COLUMN supports_option_chain INTEGER DEFAULT 0
  `);

  console.log('  ✅ Added supports_option_chain column to instances');
}

export async function down() {
  console.log('  ⚠️  Down migration not implemented (column drop not supported safely)');
}
