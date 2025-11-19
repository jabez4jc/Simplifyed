/**
 * Migration 016: Add Trailing Activation Thresholds
 * Stores the profit/breakeven point at which trailing should begin for each trading mode.
 */

export const version = '016';
export const name = 'add_watchlist_symbol_trailing_activation';

async function columnExists(db, tableName, columnName) {
  const columns = await db.all(`PRAGMA table_info(${tableName})`);
  return columns.some(col => col.name === columnName);
}

async function addColumn(db, tableName, columnName, columnDef) {
  const exists = await columnExists(db, tableName, columnName);
  if (exists) {
    console.log(`    ⊙ ${columnName} already exists (skipping)`);
    return;
  }

  await db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`);
  console.log(`    ✓ Added ${columnName}`);
}

export async function up(db) {
  console.log('  ℹ️  Adding trailing activation fields to watchlist_symbols');

  const columns = [
    { name: 'trailing_activation_points_direct', def: 'REAL' },
    { name: 'trailing_activation_points_futures', def: 'REAL' },
    { name: 'trailing_activation_points_options', def: 'REAL' },
  ];

  for (const column of columns) {
    await addColumn(db, 'watchlist_symbols', column.name, column.def);
  }

  console.log('  ✅ Migration 016 completed');
}

export async function down() {
  console.warn('  ⚠️  Rollback for Migration 016 is not implemented (requires table rebuild)');
}
