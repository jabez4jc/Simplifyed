/**
 * Migration 070: exit levels on the underlying, and a rupee max-loss per position
 *
 * exit_levels - a price on the CHARTED instrument (an index, a future, an equity, an MCX future)
 * that, once crossed, exits positions on that underlying: the underlying itself (equity, futures of
 * every expiry) and its options (every expiry). Which positions is worked out when it triggers,
 * from each position's direction (see services/exit-levels.service.js):
 *   side      BELOW | ABOVE  - where the level sat against the price when it was placed; it
 *                              triggers when the price reaches it from that side's opposite
 *   coverage  ALL | BULLISH | BEARISH
 *   kind      LEVEL | TRAIL  - a trailing stop moves with the best price since it was set
 *   size_mode FULL | PERCENT | LOTS (size_value), rounded down to whole lots
 *   instance_ids  JSON array, or NULL for every account on the watchlist
 *
 * exit_loss_caps - an optional backstop: exit one account's position in a contract once its loss
 * reaches max_loss rupees. Standing until removed.
 */

export const version = '070';
export const name = 'exit_levels';

export async function up(db) {
  await db.run(`
    CREATE TABLE IF NOT EXISTS exit_levels (
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
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'TRIGGERING', 'TRIGGERED', 'CANCELLED')),
      result TEXT,
      user_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      triggered_at DATETIME,
      FOREIGN KEY (watchlist_id) REFERENCES watchlists (id) ON DELETE CASCADE,
      FOREIGN KEY (symbol_id) REFERENCES watchlist_symbols (id) ON DELETE CASCADE
    )
  `);
  await db.run('CREATE INDEX IF NOT EXISTS idx_exit_levels_active ON exit_levels(status, ref_exchange, ref_symbol)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_exit_levels_symbol ON exit_levels(symbol_id, status)');

  await db.run(`
    CREATE TABLE IF NOT EXISTS exit_loss_caps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      watchlist_id INTEGER NOT NULL,
      exchange TEXT NOT NULL,
      symbol TEXT NOT NULL,
      max_loss REAL NOT NULL CHECK(max_loss > 0),
      instance_ids TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'CANCELLED')),
      result TEXT,
      user_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (watchlist_id) REFERENCES watchlists (id) ON DELETE CASCADE
    )
  `);
  await db.run('CREATE INDEX IF NOT EXISTS idx_exit_loss_caps_active ON exit_loss_caps(status, exchange, symbol)');
}

export async function down(db) {
  await db.run('DROP TABLE IF EXISTS exit_loss_caps');
  await db.run('DROP TABLE IF EXISTS exit_levels');
}
