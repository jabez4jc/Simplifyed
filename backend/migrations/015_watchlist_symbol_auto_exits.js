/**
 * Migration 015: Add Auto-Exit Configuration
 * Adds per-mode target/stoploss/trailing-point columns to watchlist symbols so
 * traders can persist automatic exit thresholds for Direct, Futures, and Options modes.
 */

export const version = '015';
export const name = 'add_watchlist_symbol_auto_exits';

async function columnExists(db, tableName, columnName) {
  const columns = await db.all(`PRAGMA table_info(${tableName})`);
  return columns.some(column => column.name === columnName);
}

async function addColumnIfMissing(db, tableName, columnName, columnDef) {
  const exists = await columnExists(db, tableName, columnName);
  if (exists) {
    console.log(`    ⊙ ${columnName} already exists (skipping)`);
    return;
  }

  await db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`);
  console.log(`    ✓ Added ${columnName}`);
}

export async function up(db) {
  console.log('  ℹ️  Adding auto-exit configuration columns to watchlist_symbols');

  const columns = [
    { name: 'target_points_direct', def: 'REAL' },
    { name: 'stoploss_points_direct', def: 'REAL' },
    { name: 'trailing_stoploss_points_direct', def: 'REAL' },
    { name: 'target_points_futures', def: 'REAL' },
    { name: 'stoploss_points_futures', def: 'REAL' },
    { name: 'trailing_stoploss_points_futures', def: 'REAL' },
    { name: 'target_points_options', def: 'REAL' },
    { name: 'stoploss_points_options', def: 'REAL' },
    { name: 'trailing_stoploss_points_options', def: 'REAL' },
  ];

  for (const column of columns) {
    await addColumnIfMissing(db, 'watchlist_symbols', column.name, column.def);
  }

  console.log('  ✅ Migration 015 completed');
}

export async function down() {
  console.warn('  ⚠️  Rollback for Migration 015 is not implemented (manual table rebuild required)');
}
