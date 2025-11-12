/**
 * Migration 006: Add Symbol Metadata to watchlist_symbols
 * Adds fields for displaying complete symbol information (type, expiry, strike, etc.)
 */

export const version = '006';
export const name = 'add_symbol_metadata';

export async function up(db) {
  console.log('Running migration 006: Add symbol metadata to watchlist_symbols');

  // Start transaction
  await db.run('BEGIN TRANSACTION');

  try {
    // Add new columns to watchlist_symbols table
    await db.run(`ALTER TABLE watchlist_symbols ADD COLUMN symbol_type TEXT CHECK(symbol_type IN ('EQUITY', 'FUTURES', 'OPTIONS', 'INDEX', 'UNKNOWN'))`);
    await db.run(`ALTER TABLE watchlist_symbols ADD COLUMN expiry TEXT`);
    await db.run(`ALTER TABLE watchlist_symbols ADD COLUMN strike REAL`);
    await db.run(`ALTER TABLE watchlist_symbols ADD COLUMN option_type TEXT CHECK(option_type IN ('CE', 'PE', NULL))`);
    await db.run(`ALTER TABLE watchlist_symbols ADD COLUMN instrumenttype TEXT`);
    await db.run(`ALTER TABLE watchlist_symbols ADD COLUMN name TEXT`);
    await db.run(`ALTER TABLE watchlist_symbols ADD COLUMN tick_size REAL`);
    await db.run(`ALTER TABLE watchlist_symbols ADD COLUMN brsymbol TEXT`);
    await db.run(`ALTER TABLE watchlist_symbols ADD COLUMN brexchange TEXT`);

    // Update lot_size for existing rows (will be properly set when symbols are re-added)
    // Note: Existing symbols will show lot_size=1 until they are re-added/refreshed

    console.log('  ✅ Added symbol metadata columns');

    // Commit transaction
    await db.run('COMMIT');
  } catch (error) {
    // Rollback on error
    await db.run('ROLLBACK');
    console.error('  ❌ Migration failed, rolled back changes');
    throw error;
  }
}

export async function down(db) {
  console.log('Rolling back migration 006: Remove symbol metadata');

  // SQLite doesn't support DROP COLUMN directly
  // Would need to recreate table without these columns
  console.log('  ⚠️  SQLite does not support DROP COLUMN');
  console.log('  ⚠️  To fully rollback, recreate watchlist_symbols table without metadata columns');

  throw new Error('Rollback not supported - would require table recreation');
}
