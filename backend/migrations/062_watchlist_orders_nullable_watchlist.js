/**
 * Migration 062: allow an order that belongs to no watchlist
 *
 * `watchlist_orders.watchlist_id` was NOT NULL, but every layer above it treats the watchlist as
 * optional: POST /api/v1/orders accepts a body with no watchlistId, order.service.placeOrder
 * destructures it as optional, and order-repository.insertWatchlistOrder deliberately writes
 * `watchlistId || null`. Manual API orders and chart right-click orders have no watchlist at all.
 *
 * The result was the worst possible ordering of events: the order was validated, sent, and
 * ACCEPTED BY THE BROKER, and only then did the INSERT hit the NOT NULL constraint. The caller
 * got a 500 "Database error occurred", no row was written, and the trade was live and unrecorded
 * - so nothing in the app knew the position existed, and an operator seeing an error could
 * reasonably place it again.
 *
 * The FOREIGN KEY is kept: a watchlist_id that IS present must still reference a real watchlist,
 * and NULL never violates a foreign key.
 *
 * SQLite cannot drop a NOT NULL in place, so this is the standard 12-step table rebuild. Indexes
 * are recreated because dropping the table drops them with it.
 */

export const version = '062';
export const name = 'watchlist_orders_nullable_watchlist';

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_watchlist_orders_watchlist_id ON watchlist_orders(watchlist_id)',
  'CREATE INDEX IF NOT EXISTS idx_watchlist_orders_instance_id ON watchlist_orders(instance_id)',
  'CREATE INDEX IF NOT EXISTS idx_watchlist_orders_symbol_id ON watchlist_orders(symbol_id)',
  'CREATE INDEX IF NOT EXISTS idx_watchlist_orders_status ON watchlist_orders(status)',
  'CREATE INDEX IF NOT EXISTS idx_watchlist_orders_order_id ON watchlist_orders(order_id)',
  'CREATE INDEX IF NOT EXISTS idx_watchlist_orders_placed_at ON watchlist_orders(placed_at)',
];

const COLUMNS = `
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      watchlist_id INTEGER,
      instance_id INTEGER NOT NULL,
      symbol_id INTEGER,

      exchange TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      order_type TEXT NOT NULL,
      product_type TEXT NOT NULL,
      price REAL,
      trigger_price REAL,

      status TEXT NOT NULL DEFAULT 'pending',
      order_id TEXT,
      broker_order_id TEXT,
      message TEXT,
      metadata TEXT,

      user_id INTEGER,
      source TEXT,
      trigger_type TEXT,
      request_id TEXT,
      correlation_id TEXT,

      placed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (watchlist_id) REFERENCES watchlists (id) ON DELETE CASCADE,
      FOREIGN KEY (instance_id) REFERENCES instances (id) ON DELETE CASCADE,
      FOREIGN KEY (symbol_id) REFERENCES watchlist_symbols (id) ON DELETE SET NULL
`;

const COPIED = [
  'id', 'watchlist_id', 'instance_id', 'symbol_id',
  'exchange', 'symbol', 'side', 'quantity', 'order_type', 'product_type', 'price', 'trigger_price',
  'status', 'order_id', 'broker_order_id', 'message', 'metadata',
  'user_id', 'source', 'trigger_type', 'request_id', 'correlation_id',
  'placed_at', 'updated_at',
].join(', ');

async function rebuild(db, columnsSql) {
  // foreign_keys must be off for the rename, or the child tables' references follow the old
  // table out. It is a per-connection pragma, so it is restored before returning.
  await db.run('PRAGMA foreign_keys = OFF');
  try {
    await db.run(`CREATE TABLE watchlist_orders_new (${columnsSql})`);
    await db.run(`INSERT INTO watchlist_orders_new (${COPIED}) SELECT ${COPIED} FROM watchlist_orders`);
    await db.run('DROP TABLE watchlist_orders');
    await db.run('ALTER TABLE watchlist_orders_new RENAME TO watchlist_orders');
    for (const sql of INDEXES) {
      await db.run(sql);
    }
  } finally {
    await db.run('PRAGMA foreign_keys = ON');
  }
}

export async function up(db) {
  const columns = await db.all("PRAGMA table_info('watchlist_orders')");
  const watchlistId = columns.find((c) => c.name === 'watchlist_id');
  if (!watchlistId || !watchlistId.notnull) return; // already nullable

  await rebuild(db, COLUMNS);
}

export async function down(db) {
  // Restoring NOT NULL means the rows this migration made possible cannot be represented. Drop
  // exactly those - orders with no watchlist - rather than failing the rollback outright.
  await db.run('DELETE FROM watchlist_orders WHERE watchlist_id IS NULL');
  await rebuild(db, COLUMNS.replace('watchlist_id INTEGER,', 'watchlist_id INTEGER NOT NULL,'));
}
