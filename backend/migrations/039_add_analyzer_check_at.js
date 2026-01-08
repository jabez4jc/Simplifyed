/**
 * Migration 039 - Add last_analyzer_check_at to instances
 */

export const version = '039';
export const name = 'add_analyzer_check_at';

async function columnExists(db, column) {
  const row = await db.get(
    `SELECT name FROM pragma_table_info('instances') WHERE name = ?`,
    [column]
  );
  return !!row;
}

export async function up(db) {
  await db.run('PRAGMA busy_timeout = 5000');

  const exists = await columnExists(db, 'last_analyzer_check_at');
  if (exists) {
    console.log('  ℹ️  last_analyzer_check_at already exists on instances');
    return;
  }

  await db.run(`
    ALTER TABLE instances
    ADD COLUMN last_analyzer_check_at TEXT
  `);

  console.log('  ✅ Added last_analyzer_check_at column to instances');
}

export async function down() {
  console.log('  ⚠️  Down migration not implemented (column drop not supported safely)');
}
