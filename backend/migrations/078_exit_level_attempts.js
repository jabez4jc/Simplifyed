/**
 * Migration 078: exit_levels.attempts + FAILED status (audit P3-7)
 *
 * A level whose exit failed used to be marked TRIGGERED anyway, so the position stayed open and
 * the level never tried again. A failed fire now goes back to ACTIVE with `attempts` counted, and
 * after 3 attempts becomes FAILED (and notifies). SQLite cannot widen a CHECK in place, so the
 * table is rebuilt.
 */

export const version = '078';
export const name = 'exit_level_attempts';

export async function up(db) {
  const cols = (await db.all('PRAGMA table_info(exit_levels)')).map((c) => c.name);
  if (cols.includes('attempts')) return;

  await db.run(`
    CREATE TABLE exit_levels_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      watchlist_id INTEGER NOT NULL,
      symbol_id INTEGER NOT NULL,
      ref_exchange TEXT NOT NULL,
      ref_symbol TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'LEVEL' CHECK(kind IN ('LEVEL', 'TRAIL')),
      side TEXT NOT NULL CHECK(side IN ('BELOW', 'ABOVE')),
      trigger_price REAL NOT NULL CHECK(trigger_price > 0),
      trail_distance REAL,
      best_price REAL,
      coverage TEXT NOT NULL DEFAULT 'ALL' CHECK(coverage IN ('ALL', 'BULLISH', 'BEARISH')),
      size_mode TEXT NOT NULL DEFAULT 'FULL' CHECK(size_mode IN ('FULL', 'PERCENT', 'LOTS')),
      size_value REAL,
      instance_ids TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'TRIGGERING', 'TRIGGERED', 'CANCELLED', 'FAILED')),
      result TEXT,
      user_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      triggered_at DATETIME,
      attempts INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (watchlist_id) REFERENCES watchlists (id) ON DELETE CASCADE,
      FOREIGN KEY (symbol_id) REFERENCES watchlist_symbols (id) ON DELETE CASCADE
    )
  `);
  await db.run(`
    INSERT INTO exit_levels_new (
      id, watchlist_id, symbol_id, ref_exchange, ref_symbol, kind, side, trigger_price, trail_distance,
      best_price, coverage, size_mode, size_value, instance_ids, status, result, user_id,
      created_at, updated_at, triggered_at
    )
    SELECT
      id, watchlist_id, symbol_id, ref_exchange, ref_symbol, kind, side, trigger_price, trail_distance,
      best_price, coverage, size_mode, size_value, instance_ids, status, result, user_id,
      created_at, updated_at, triggered_at
    FROM exit_levels
  `);
  await db.run('DROP TABLE exit_levels');
  await db.run('ALTER TABLE exit_levels_new RENAME TO exit_levels');
  await db.run('CREATE INDEX IF NOT EXISTS idx_exit_levels_active ON exit_levels(status, ref_exchange, ref_symbol)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_exit_levels_symbol ON exit_levels(symbol_id, status)');
}

export async function down() {
  // Nothing to restore: a wider CHECK and an extra column are harmless to older code.
}
