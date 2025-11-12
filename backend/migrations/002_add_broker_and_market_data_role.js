/**
 * Migration 002: Add broker and market_data_role to instances table
 * - Add broker column (auto-detected from ping endpoint)
 * - Add market_data_role column (None/Primary/Secondary for market data API calls)
 */

export const version = '002';
export const name = 'add_broker_and_market_data_role';

export async function up(db) {
  // Add broker column
  await db.run(`
    ALTER TABLE instances
    ADD COLUMN broker TEXT DEFAULT NULL
  `);

  // Add market_data_role column with CHECK constraint
  // Values: 'none', 'primary', 'secondary'
  await db.run(`
    ALTER TABLE instances
    ADD COLUMN market_data_role TEXT DEFAULT 'none'
      CHECK(market_data_role IN ('none', 'primary', 'secondary'))
  `);

  console.log('  ✅ Added broker and market_data_role columns to instances table');
}

export async function down(db) {
  // SQLite doesn't support DROP COLUMN in all versions
  // We'll need to recreate the table without these columns
  console.log('  ⚠️  SQLite does not support DROP COLUMN');
  console.log('  ⚠️  To rollback, you would need to recreate the instances table');

  throw new Error('Rollback not supported for this migration - SQLite limitation');
}
