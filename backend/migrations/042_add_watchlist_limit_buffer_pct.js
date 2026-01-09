/**
 * Migration 042: Add per-watchlist TradingView buffer percent
 */

export const version = '042';
export const name = 'add_watchlist_limit_buffer_pct';

async function columnExists(db, tableName, columnName) {
  const columns = await db.all(`PRAGMA table_info(${tableName})`);
  return columns.some((col) => col.name === columnName);
}

export async function up(db) {
  console.log('  ℹ️  Adding limit_buffer_pct to watchlists');
  const exists = await columnExists(db, 'watchlists', 'limit_buffer_pct');
  if (!exists) {
    await db.run('ALTER TABLE watchlists ADD COLUMN limit_buffer_pct REAL');
    console.log('    ✓ Added limit_buffer_pct');
  } else {
    console.log('    ⊙ limit_buffer_pct already exists (skipping)');
  }
  console.log('  ✅ Migration 042 completed');
}

export async function down() {
  console.warn('  ⚠️  Rollback for Migration 042 is not implemented (requires table rebuild)');
}
