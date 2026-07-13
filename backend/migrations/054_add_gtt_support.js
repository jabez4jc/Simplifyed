/**
 * Migration 054: GTT (Good-Till-Triggered) support
 * Adds an opt-in per-leg/per-symbol exit mechanism ('POLLING' default, unchanged behavior, or
 * 'GTT' for broker-side conditional orders) plus a tracking table for placed GTT triggers.
 * GTT's product only supports CNC/NRML (not MIS), so this is additive - it does not replace
 * AutoExitService, which still handles MIS positions and remains the default for everyone.
 */

export const version = '054';
export const name = 'add_gtt_support';

async function columnExists(db, tableName, columnName) {
  const columns = await db.all(`PRAGMA table_info(${tableName})`);
  return columns.some((column) => column.name === columnName);
}

async function addColumnIfMissing(db, tableName, columnName, columnDef) {
  const exists = await columnExists(db, tableName, columnName);
  if (exists) {
    console.log(`    ⊙ ${columnName} already exists on ${tableName} (skipping)`);
    return;
  }
  await db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`);
  console.log(`    ✓ Added ${tableName}.${columnName}`);
}

export async function up(db) {
  await addColumnIfMissing(db, 'strategy_legs', 'exit_mechanism', "TEXT DEFAULT 'POLLING'");
  await addColumnIfMissing(db, 'watchlist_symbols', 'exit_mechanism', "TEXT DEFAULT 'POLLING'");

  await db.run(`
    CREATE TABLE IF NOT EXISTS gtt_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id INTEGER NOT NULL,
      watchlist_id INTEGER,
      symbol_id INTEGER,
      strategy_leg_id INTEGER,
      trigger_id TEXT NOT NULL,
      exchange TEXT NOT NULL,
      symbol TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (instance_id) REFERENCES instances (id) ON DELETE CASCADE,
      FOREIGN KEY (watchlist_id) REFERENCES watchlists (id) ON DELETE SET NULL,
      FOREIGN KEY (symbol_id) REFERENCES watchlist_symbols (id) ON DELETE SET NULL,
      FOREIGN KEY (strategy_leg_id) REFERENCES strategy_legs (id) ON DELETE SET NULL
    )
  `);

  await db.run(`CREATE INDEX IF NOT EXISTS idx_gtt_orders_instance ON gtt_orders (instance_id)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_gtt_orders_trigger_id ON gtt_orders (trigger_id)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_gtt_orders_status ON gtt_orders (status)`);

  console.log('  ✅ Migration 054 completed');
}

export async function down(db) {
  await db.run('DROP TABLE IF EXISTS gtt_orders');
  console.warn('  ⚠️  exit_mechanism columns are not dropped (manual table rebuild required)');
}
