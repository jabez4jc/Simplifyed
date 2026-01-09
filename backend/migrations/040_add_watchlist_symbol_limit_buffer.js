/**
 * Migration 040: Add per-symbol limit buffer points
 */

export const version = '040';
export const name = 'add_watchlist_symbol_limit_buffer';

async function columnExists(db, tableName, columnName) {
  const columns = await db.all(`PRAGMA table_info(${tableName})`);
  return columns.some((col) => col.name === columnName);
}

export async function up(db) {
  console.log('  ℹ️  Adding limit buffer points to watchlist_symbols');

  const exists = await columnExists(db, 'watchlist_symbols', 'limit_buffer_points');
  if (!exists) {
    await db.run('ALTER TABLE watchlist_symbols ADD COLUMN limit_buffer_points REAL DEFAULT 0');
    console.log('    ✓ Added limit_buffer_points');
  } else {
    console.log('    ⊙ limit_buffer_points already exists (skipping)');
  }

  console.log('  ✅ Migration 040 completed');
}

export async function down() {
  console.warn('  ⚠️  Rollback for Migration 040 is not implemented (requires table rebuild)');
}
