/**
 * Migration 060: Candle cache
 *
 * Backs the chart's historical data. Closed candles are immutable, so they are worth storing
 * permanently rather than refetched on every interval switch. Two concrete problems this solves:
 *
 *   Rate limits - `history` goes through the same per-instance limiter as the live trading feed
 *   (rate_limits.rps_per_instance, currently 8). A user scrubbing timeframes would otherwise
 *   compete with position and quote polling for the same budget.
 *
 *   Blackout windows - `history` is not classified as a quote endpoint (client.js only matches
 *   quotes/optionchain/depth), so it falls under the *general* blackout. Without a cache the
 *   chart would simply fail to load overnight; with one it serves the last known candles and
 *   flags them stale.
 *
 * `ts` is a true UTC epoch in seconds, exactly as OpenAlgo returns it - verified against BSE
 * session bounds (first candle of the day = 03:45Z = 09:15 IST). The IST display shift belongs
 * in the presentation layer, never in stored data.
 *
 * Keyed on (exchange, symbol, timeframe, ts) with no instance in the key: OHLC for a given
 * symbol is the same market fact regardless of which broker reported it. `source_instance_id`
 * is retained for provenance only.
 */

export const version = '060';
export const name = 'candles_cache';

export async function up(db) {
  await db.run(`
    CREATE TABLE IF NOT EXISTS candles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exchange TEXT NOT NULL,
      symbol TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      ts INTEGER NOT NULL,
      open REAL,
      high REAL,
      low REAL,
      close REAL,
      volume REAL,
      oi REAL,
      source_instance_id INTEGER,
      fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(exchange, symbol, timeframe, ts)
    )
  `);

  // Every read is "one symbol, one timeframe, a time range" - this index serves it directly.
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_candles_lookup
    ON candles(exchange, symbol, timeframe, ts)
  `);
}

export async function down(db) {
  await db.run('DROP INDEX IF EXISTS idx_candles_lookup');
  await db.run('DROP TABLE IF EXISTS candles');
}
