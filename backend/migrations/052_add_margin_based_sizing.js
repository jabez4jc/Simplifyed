/**
 * Migration 052: Margin-Based Dynamic Lot Sizing
 * Adds config columns to watchlist_symbols so a symbol's qty_type can be 'MARGIN_BASED',
 * sizing quantity off available account margin instead of a fixed qty_value.
 */

export const version = '052';
export const name = 'add_margin_based_sizing';

async function columnExists(db, tableName, columnName) {
  const columns = await db.all(`PRAGMA table_info(${tableName})`);
  return columns.some((column) => column.name === columnName);
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
  console.log('  ℹ️  Adding margin-based sizing columns to watchlist_symbols');

  const columns = [
    { name: 'margin_sizing_enabled', def: 'BOOLEAN DEFAULT 0' },
    { name: 'margin_utilization_pct', def: 'REAL' },
    { name: 'max_margin_per_trade', def: 'REAL' },
  ];

  for (const column of columns) {
    await addColumnIfMissing(db, 'watchlist_symbols', column.name, column.def);
  }

  console.log('  ✅ Migration 052 completed');
}

export async function down() {
  console.warn('  ⚠️  Rollback for Migration 052 is not implemented (manual table rebuild required)');
}
