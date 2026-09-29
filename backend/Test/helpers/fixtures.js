/**
 * Row factories.
 *
 * These INSERT directly rather than going through the service layer on purpose: a test for
 * "editing an instance clears its session target" should not be able to fail because instance
 * CREATION broke. Arrange with SQL, act through the API, assert on SQL - so a failure points at
 * exactly one thing.
 */

import db from '../../src/core/database.js';

let seq = 0;
const uniq = () => `${process.pid}-${(seq += 1)}-${Date.now()}`;

export async function makeInstance(overrides = {}) {
  const n = uniq();
  const row = {
    name: `Instance ${n}`,
    host_url: `http://broker-${n}.test`,
    api_key: `apikey-${n}-abcdef`,
    broker: 'zerodha',
    strategy_tag: 'TEST',
    is_active: 1,
    is_analyzer_mode: 0,
    market_data_role: 'none',
    market_data_enabled: 0,
    supports_multiquotes: 0,
    supports_option_chain: 0,
    use_ws_quotes: 0,
    multiplier: 1,
    order_placement_enabled: 1,
    ...overrides,
  };

  const cols = Object.keys(row);
  const { lastID } = await db.run(
    `INSERT INTO instances (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    cols.map((c) => row[c])
  );
  return db.get('SELECT * FROM instances WHERE id = ?', [lastID]);
}

export async function makeWatchlist(overrides = {}) {
  const n = uniq();
  const row = { name: `Watchlist ${n}`, description: 'fixture', is_active: 1, type: 'standard', ...overrides };
  const cols = Object.keys(row);
  const { lastID } = await db.run(
    `INSERT INTO watchlists (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    cols.map((c) => row[c])
  );
  return db.get('SELECT * FROM watchlists WHERE id = ?', [lastID]);
}

export async function makeWatchlistSymbol(watchlistId, overrides = {}) {
  const row = {
    watchlist_id: watchlistId,
    exchange: 'NSE',
    symbol: 'RELIANCE',
    lot_size: 1,
    qty_type: 'FIXED',
    qty_value: 1,
    product_type: 'MIS',
    order_type: 'MARKET',
    tradable_equity: 1,
    ...overrides,
  };
  const cols = Object.keys(row);
  const { lastID } = await db.run(
    `INSERT INTO watchlist_symbols (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    cols.map((c) => row[c])
  );
  return db.get('SELECT * FROM watchlist_symbols WHERE id = ?', [lastID]);
}

/** Link an instance to a watchlist (the join the order routes fan out over). */
export async function linkInstanceToWatchlist(watchlistId, instanceId, overrides = {}) {
  const cols = await db.all("PRAGMA table_info('watchlist_instances')");
  const names = new Set(cols.map((c) => c.name));
  const row = { watchlist_id: watchlistId, instance_id: instanceId, ...overrides };
  if (names.has('is_active') && row.is_active === undefined) row.is_active = 1;
  const keys = Object.keys(row).filter((k) => names.has(k));
  await db.run(
    `INSERT INTO watchlist_instances (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    keys.map((k) => row[k])
  );
}

export async function makeStrategy(overrides = {}) {
  const n = uniq();
  const cols = await db.all("PRAGMA table_info('strategies')");
  const names = new Set(cols.map((c) => c.name));
  const row = { name: `Strategy ${n}`, ...overrides };
  if (names.has('webhook_slug') && row.webhook_slug === undefined) row.webhook_slug = `slug-${n}`;
  if (names.has('is_active') && row.is_active === undefined) row.is_active = 1;
  const keys = Object.keys(row).filter((k) => names.has(k));
  const { lastID } = await db.run(
    `INSERT INTO strategies (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    keys.map((k) => row[k])
  );
  return db.get('SELECT * FROM strategies WHERE id = ?', [lastID]);
}

/** Seed the instruments cache so symbol/option-chain routes have something to resolve against. */
export async function makeInstrument(overrides = {}) {
  const cols = await db.all("PRAGMA table_info('instruments')");
  const names = new Set(cols.map((c) => c.name));
  const row = {
    symbol: 'RELIANCE',
    exchange: 'NSE',
    brexchange: 'NSE',
    name: 'RELIANCE INDUSTRIES',
    token: String(Math.floor(Math.random() * 1e6)),
    lotsize: 1,
    instrumenttype: 'EQ',
    tick_size: 0.05,
    ...overrides,
  };
  const keys = Object.keys(row).filter((k) => names.has(k));
  const { lastID } = await db.run(
    `INSERT INTO instruments (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    keys.map((k) => row[k])
  );
  return db.get('SELECT * FROM instruments WHERE id = ?', [lastID]);
}

/**
 * Declare which brokers accept MARKET orders.
 *
 * The `brokerage.market_order_support` setting ships as `{}`, meaning NO broker supports market
 * orders, so order.service synthesises a marketable LIMIT from a live quote instead. That is
 * correct behaviour and is worth testing on its own - but a test about order ROUTING should not
 * have to stand up the whole quote-feed stack to place one order.
 */
export async function setMarketOrderSupport(map) {
  await db.run(
    `INSERT INTO application_settings (key, value, description, category, data_type)
     VALUES ('brokerage.market_order_support', ?, 'test override', 'brokerage', 'json')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [JSON.stringify(map)]
  );
}
