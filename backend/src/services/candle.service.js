/**
 * Candle Service
 *
 * Serves historical OHLCV for the chart, backed by the `candles` cache (migration 060).
 *
 * Read-only with respect to trading: it places no orders and touches no position state. The
 * only broker call it makes is `history`, which already routes through the OpenAlgo client's
 * rate limiter, retry policy, circuit breaker and blackout guard.
 *
 * Instance selection is deliberately asymmetric to the rest of the app. Orders fan out to every
 * associated instance; candles come from exactly ONE. OHLC for a symbol is the same market fact
 * whichever broker reports it, so fanning out would multiply rate-limit cost for identical data.
 */

import db from '../core/database.js';
import { log } from '../core/logger.js';
import { ValidationError } from '../core/errors.js';
import openalgoClient from '../integrations/openalgo/client.js';
import marketDataInstanceService from './market-data-instance.service.js';
import { isCryptoBroker, isCryptoExchange } from '../utils/broker-type.util.js';

/** Seconds per candle, used to decide whether the cached tail is still current. */
const TIMEFRAME_SECONDS = {
  '5s': 5, '10s': 10, '15s': 15, '30s': 30, '45s': 45,
  '1m': 60, '2m': 120, '3m': 180, '5m': 300, '10m': 600,
  '15m': 900, '20m': 1200, '30m': 1800,
  '1h': 3600, '2h': 7200, '4h': 14400,
  D: 86400, W: 604800, M: 2592000,
};

// Never call the broker more than once per key inside this window, however often the browser
// asks. A chart that repaints on every quote tick must not translate into broker traffic.
const MIN_FETCH_INTERVAL_MS = 5000;

class CandleService {
  constructor() {
    this.lastFetchAt = new Map(); // `${exchange}|${symbol}|${timeframe}` -> epoch ms
  }

  isValidTimeframe(timeframe) {
    return Object.prototype.hasOwnProperty.call(TIMEFRAME_SECONDS, timeframe);
  }

  listTimeframes() {
    return Object.keys(TIMEFRAME_SECONDS);
  }

  /**
   * Pick the single instance that will serve candles for this exchange.
   *
   * Exchange-aware because it has to be: a CRYPTO symbol asked of an Indian broker is a
   * guaranteed failure, and vice versa. Within the right broker class it defers to the existing
   * market-data pool, so the chart inherits the same health filtering as quotes.
   */
  async _resolveInstance(exchange) {
    const pool = await marketDataInstanceService.getMarketDataPool();
    if (!pool || pool.length === 0) return null;

    const wantCrypto = isCryptoExchange(exchange);
    const matching = pool.filter((i) => isCryptoBroker(i.broker) === wantCrypto);

    // No deliberate fallback to a mismatched broker - returning Indian candles for a crypto
    // symbol would be worse than returning nothing.
    return matching[0] || null;
  }

  _cacheKey(exchange, symbol, timeframe) {
    return `${exchange}|${symbol}|${timeframe}`;
  }

  async _readCache(exchange, symbol, timeframe, fromTs, toTs) {
    return db.all(
      `SELECT ts, open, high, low, close, volume, oi
         FROM candles
        WHERE exchange = ? AND symbol = ? AND timeframe = ?
          AND ts >= ? AND ts <= ?
        ORDER BY ts ASC`,
      [exchange, symbol, timeframe, fromTs, toTs]
    );
  }

  /**
   * Upsert fetched candles. The most recent candle of a live session is still forming, so its
   * OHLC changes on every tick - ON CONFLICT overwrites rather than ignores, or the chart would
   * freeze the current bar at whatever value it first held.
   */
  async _writeCache(exchange, symbol, timeframe, rows, instanceId) {
    if (!rows.length) return;
    await db.transaction(async () => {
      for (const c of rows) {
        await db.run(
          `INSERT INTO candles
             (exchange, symbol, timeframe, ts, open, high, low, close, volume, oi, source_instance_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(exchange, symbol, timeframe, ts) DO UPDATE SET
             open = excluded.open, high = excluded.high, low = excluded.low,
             close = excluded.close, volume = excluded.volume, oi = excluded.oi,
             source_instance_id = excluded.source_instance_id,
             fetched_at = CURRENT_TIMESTAMP`,
          [
            exchange, symbol, timeframe, c.ts,
            c.open, c.high, c.low, c.close, c.volume, c.oi, instanceId,
          ]
        );
      }
    });
  }

  /** Normalize OpenAlgo's history rows. Anything without a usable timestamp is dropped. */
  _normalize(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((r) => {
        // A null or non-object element would otherwise throw on property access and take the
        // whole request down - one malformed row must not lose an entire chart.
        if (!r || typeof r !== 'object') return null;
        const ts = Number(r.timestamp ?? r.time ?? r.t);
        if (!Number.isFinite(ts)) return null;
        return {
          ts: Math.floor(ts),
          open: Number(r.open ?? r.o) || null,
          high: Number(r.high ?? r.h) || null,
          low: Number(r.low ?? r.l) || null,
          close: Number(r.close ?? r.c) || null,
          volume: Number(r.volume ?? r.v) || 0,
          oi: Number(r.oi) || 0,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.ts - b.ts);
  }

  /** True when the cached tail is old enough that a new candle should exist by now. */
  _tailIsStale(rows, timeframe, toTs) {
    if (!rows.length) return true;
    const step = TIMEFRAME_SECONDS[timeframe] || 60;
    const newest = rows[rows.length - 1].ts;
    const horizon = Math.min(toTs, Math.floor(Date.now() / 1000));
    return horizon - newest >= step;
  }

  /**
   * Fetch candles for a range, preferring cache.
   *
   * Returns `{ candles, source, stale, instanceId }`. `stale: true` means the broker could not
   * be reached (blackout, unhealthy instance, no pool) and the caller is looking at cache only -
   * surfaced so the UI can say so rather than implying the data is live.
   */
  async getCandles({ exchange, symbol, timeframe, from, to }) {
    if (!exchange || !symbol) throw new ValidationError('exchange and symbol are required');
    if (!this.isValidTimeframe(timeframe)) {
      throw new ValidationError(
        `timeframe must be one of: ${this.listTimeframes().join(', ')}`
      );
    }

    const toTs = Number(to) || Math.floor(Date.now() / 1000);
    const fromTs = Number(from) || toTs - 5 * 86400;
    if (fromTs >= toTs) throw new ValidationError('from must be earlier than to');

    const ex = String(exchange).toUpperCase();
    const sym = String(symbol).toUpperCase();

    let cached = await this._readCache(ex, sym, timeframe, fromTs, toTs);

    const key = this._cacheKey(ex, sym, timeframe);
    const lastFetch = this.lastFetchAt.get(key) || 0;
    const cooling = Date.now() - lastFetch < MIN_FETCH_INTERVAL_MS;

    if (!this._tailIsStale(cached, timeframe, toTs) || cooling) {
      return { candles: cached, source: 'cache', stale: false, instanceId: null };
    }

    const instance = await this._resolveInstance(ex);
    if (!instance) {
      log.warn('No market-data instance can serve candles for this exchange', { exchange: ex });
      return { candles: cached, source: 'cache', stale: true, instanceId: null };
    }

    this.lastFetchAt.set(key, Date.now());

    try {
      const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
      const raw = await openalgoClient.getHistory(instance, sym, ex, timeframe, iso(fromTs), iso(toTs));
      const fresh = this._normalize(raw);

      if (fresh.length) {
        await this._writeCache(ex, sym, timeframe, fresh, instance.id);
        cached = await this._readCache(ex, sym, timeframe, fromTs, toTs);
      }

      return { candles: cached, source: 'broker', stale: false, instanceId: instance.id };
    } catch (error) {
      // Blackout, unhealthy instance or an unsupported symbol. Cached candles are still the
      // best answer available, so serve them and mark the response stale rather than 500.
      log.warn('Candle fetch failed, serving cache', {
        exchange: ex, symbol: sym, error: error.message,
      });
      return { candles: cached, source: 'cache', stale: true, instanceId: instance.id };
    }
  }

  /**
   * Timeframes the serving broker actually supports, intersected with the ones we can bucket.
   * Falls back to the full local list when the broker cannot be asked.
   */
  async getSupportedTimeframes(exchange) {
    const instance = await this._resolveInstance(exchange);
    if (!instance) return { timeframes: this.listTimeframes(), source: 'default' };

    try {
      const data = await openalgoClient.getIntervals(instance);
      const flat = Object.values(data || {}).flat().filter((tf) => this.isValidTimeframe(tf));
      return flat.length
        ? { timeframes: flat, source: 'broker' }
        : { timeframes: this.listTimeframes(), source: 'default' };
    } catch (error) {
      log.warn('Interval lookup failed, using defaults', { error: error.message });
      return { timeframes: this.listTimeframes(), source: 'default' };
    }
  }
}

export default new CandleService();
export { TIMEFRAME_SECONDS };
