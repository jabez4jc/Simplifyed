/**
 * Migration 003: Add CHECK constraint to market_data_role column
 * For existing installations that ran migration 002 without the constraint
 *
 * SQLite doesn't support adding constraints to existing columns,
 * so we need to recreate the table with the constraint.
 */

export const version = '003';
export const name = 'add_market_data_role_constraint';

export async function up(db) {
  // Check if the constraint already exists
  const tableInfo = await db.get(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='instances'"
  );

  if (tableInfo.sql.includes("CHECK(market_data_role IN ('none', 'primary', 'secondary'))")) {
    console.log('  ⏭️  CHECK constraint already exists, skipping');
    return;
  }

  // SQLite doesn't support ALTER COLUMN, so we need to:
  // 1. Create a new table with the constraint
  // 2. Copy data from the old table
  // 3. Drop the old table
  // 4. Rename the new table

  // Start transaction
  await db.run('BEGIN TRANSACTION');

  try {
    // 1. Create temporary table with CHECK constraint
    await db.run(`
      CREATE TABLE instances_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        host_url TEXT NOT NULL UNIQUE,
        api_key TEXT NOT NULL,
        broker TEXT,
        strategy_tag TEXT,

        -- Admin designation
        is_primary_admin BOOLEAN DEFAULT 0,
        is_secondary_admin BOOLEAN DEFAULT 0,
        order_placement_enabled BOOLEAN DEFAULT 1,

        -- Market data role with CHECK constraint
        market_data_role TEXT DEFAULT 'none' CHECK(market_data_role IN ('none', 'primary', 'secondary')),

        -- Risk management
        target_profit REAL DEFAULT 5000,
        target_loss REAL DEFAULT 2000,

        -- P&L tracking
        current_balance REAL DEFAULT 0,
        realized_pnl REAL DEFAULT 0,
        unrealized_pnl REAL DEFAULT 0,
        total_pnl REAL DEFAULT 0,

        -- Status
        is_active BOOLEAN DEFAULT 1,
        is_analyzer_mode BOOLEAN DEFAULT 0,
        health_status TEXT DEFAULT 'unknown',
        last_health_check DATETIME,
        last_ping_at DATETIME,

        -- Timestamps
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 2. Copy all data from old table to new table
    await db.run(`
      INSERT INTO instances_new
      SELECT * FROM instances
    `);

    // 3. Drop old table
    await db.run('DROP TABLE instances');

    // 4. Rename new table
    await db.run('ALTER TABLE instances_new RENAME TO instances');

    // Commit transaction
    await db.run('COMMIT');

    console.log('  ✅ Added CHECK constraint to market_data_role column');
  } catch (error) {
    // Rollback on error
    await db.run('ROLLBACK');
    throw error;
  }
}

export async function down(db) {
  // To rollback, we would need to recreate the table without the constraint
  // This is complex and rarely needed in practice
  console.log('  ⚠️  Rollback not supported - would require table recreation');
  throw new Error('Migration rollback not supported for this migration');
}
