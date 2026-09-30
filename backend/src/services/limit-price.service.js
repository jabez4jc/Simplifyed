/**
 * Limit Price Service
 * Computes limit prices from freshest quotes with side-aware buffers.
 */

import { ValidationError } from '../core/errors.js';
import { extractLtp } from '../utils/price-extraction.js';
import marketDataFeedService from './market-data-feed.service.js';
import config from '../core/config.js';
import settingsService from './settings.service.js';
import { settingDefault } from '../config/settings-registry.js';
import { log } from '../core/logger.js';
import db from '../core/database.js';
import openalgoClient from '../integrations/openalgo/client.js';
import { requiresLimitOrders } from '../utils/broker-type.util.js';


// Second-chance staleness window for a fill-now caller. The strict pass wants a ~2s quote; the
// quote cache itself holds entries for 7-12s, so the usual reason a fill-now order degrades to
// MARKET is a merely-stale cache entry, not an absent feed.
const RELAXED_QUOTE_STALE_MS = 15000;

class LimitPriceService {
  constructor() {
    this.tickCache = new Map(); // EXCHANGE|SYMBOL -> tick size (contract ticks do not change intraday)
  }

  /**
   * The caller's tick if it has one, else the contract's tick from the instruments cache. Orders
   * placed without a watchlist symbol used to have none and were rounded to 2 decimals - off-tick
   * on BANKNIFTY (0.2), CRUDEOIL (1.0) and any buffered price, which the exchange rejects.
   */
  async resolveTickSize(exchange, symbol, given = null) {
    const tick = Number(given);
    if (Number.isFinite(tick) && tick > 0) return tick;
    const key = `${(exchange || '').toUpperCase()}|${(symbol || '').toUpperCase()}`;
    if (this.tickCache.has(key)) return this.tickCache.get(key);
    let found = null;
    try {
      const row = await db.get(
        'SELECT tick_size FROM instruments WHERE exchange = ? AND symbol = ? LIMIT 1',
        [(exchange || '').toUpperCase(), (symbol || '').toUpperCase()]
      );
      const t = Number(row?.tick_size);
      found = Number.isFinite(t) && t > 0 ? t : null;
    } catch (error) {
      log.warn('Tick size lookup failed', { exchange, symbol, error: error.message });
      return null; // not cached - retry next time
    }
    this.tickCache.set(key, found);
    return found;
  }

  async resolveLimitPrice({
    exchange,
    symbol,
    side,
    bufferPoints = 0,
    tickSize = null,
    quoteStaleMs = null,
    bypassSpreadCheck = false,
    forceLtp = false,
    instanceId = null,
  }) {
    const normalizedSide = (side || '').toUpperCase();
    if (!['BUY', 'SELL'].includes(normalizedSide)) {
      throw new ValidationError('Limit price side must be BUY or SELL');
    }

    const normalizedExchange = (exchange || '').toUpperCase();
    const normalizedSymbol = (symbol || '').toUpperCase();
    if (!normalizedExchange || !normalizedSymbol) {
      throw new ValidationError('Exchange and symbol are required for limit price');
    }

    const staleMs =
      quoteStaleMs ??
      config.marketDataFeed?.orderQuoteStaleMs ??
      2000;
    // Settings > Orders & Costs. The registry default applies only if the row is missing.
    let maxSpreadPct = Number(settingDefault('market_data_feed.max_order_spread_pct'));
    try {
      const setting = await settingsService.getSetting('market_data_feed.max_order_spread_pct');
      const parsed = parseFloat(setting?.rawValue ?? setting?.value);
      if (Number.isFinite(parsed)) {
        maxSpreadPct = parsed;
      }
    } catch {
      // Row missing - keep the default.
    }

    let depthBid = null;
    let depthAsk = null;
    let depthAgeMs = null;

    if (!forceLtp) {
      const depthResult = await marketDataFeedService.fetchDepthForSymbol(
        normalizedExchange,
        normalizedSymbol,
        { staleMs, preferInstanceId: instanceId }
      );
      if (depthResult) {
        depthBid = this._parsePrice(depthResult.bid);
        depthAsk = this._parsePrice(depthResult.ask);
        depthAgeMs = depthResult.fetchedAt ? Date.now() - depthResult.fetchedAt : null;
      }
    }

    const depthReady = depthBid && depthAsk;
    let quote = null;
    let fetchedAt = null;
    if (!depthReady) {
      const quoteResult = await this._getFreshQuote(
        normalizedExchange,
        normalizedSymbol,
        staleMs,
        instanceId
      );
      quote = quoteResult.quote;
      fetchedAt = quoteResult.fetchedAt;
    }

    const ageMs = fetchedAt ? Date.now() - fetchedAt : depthAgeMs;
    if (ageMs !== null && ageMs > staleMs) {
      throw new ValidationError(`Quote is stale for ${normalizedExchange}:${normalizedSymbol}`);
    }

    const bid = depthBid ?? this._parsePrice(quote?.bid ?? quote?.best_bid ?? quote?.bestBid ?? quote?.bp);
    const ask = depthAsk ?? this._parsePrice(quote?.ask ?? quote?.best_ask ?? quote?.bestAsk ?? quote?.ap);
    const ltp = quote ? extractLtp(quote) : null;

    let basePrice = null;
    let priceSource = null;
    let spreadPct = null;

    if (ltp && ltp > 0) {
      basePrice = ltp;
      priceSource = 'ltp';
    } else if (!forceLtp && bid && ask) {
      const spread = ask - bid;
      const mid = (ask + bid) / 2;
      if (mid > 0) {
        spreadPct = spread / mid;
      }
      if (!bypassSpreadCheck && spreadPct !== null && spreadPct > maxSpreadPct) {
        throw new ValidationError(`Bid/ask spread too wide for ${normalizedExchange}:${normalizedSymbol}`);
      }
      basePrice = normalizedSide === 'BUY' ? ask : bid;
      priceSource = normalizedSide === 'BUY' ? 'ask' : 'bid';
    } else {
      if (!ltp || ltp <= 0) {
        throw new ValidationError(`No usable price for ${normalizedExchange}:${normalizedSymbol}`);
      }
      basePrice = ltp;
      priceSource = forceLtp ? 'ltp_forced' : 'ltp';
    }

    const bufferValue = this._parseBuffer(bufferPoints);
    if (ltp && ltp > 0 && basePrice !== ltp && bufferValue > 0) {
      const deviation = Math.abs(basePrice - ltp);
      if (deviation > bufferValue) {
        basePrice = ltp;
        priceSource = 'ltp_clamped';
      }
    }
    let price =
      normalizedSide === 'BUY'
        ? basePrice + bufferValue
        : basePrice - bufferValue;

    if (!Number.isFinite(price) || price <= 0) {
      throw new ValidationError(`Computed limit price invalid for ${normalizedExchange}:${normalizedSymbol}`);
    }

    price = this._roundToTick(
      price,
      await this.resolveTickSize(normalizedExchange, normalizedSymbol, tickSize),
      normalizedSide
    );

    return {
      price,
      source: priceSource,
      quoteAgeMs: ageMs,
      spreadPct,
    };
  }

  async _getFreshQuote(exchange, symbol, staleMs, instanceId = null) {
    const target = [{ exchange, symbol }];
    const { cached } = marketDataFeedService.getCachedQuoteEntriesForSymbols(target, {
      ttlMs: staleMs,
      orderCritical: true,
    });

    if (cached.length > 0) {
      return { quote: cached[0].quote, fetchedAt: cached[0].fetchedAt };
    }

    const quotes = await marketDataFeedService.fetchQuotesForSymbols(target, {
      ttlMs: staleMs,
      orderCritical: true,
      useFallback: true,
    });
    let quote = Array.isArray(quotes) ? quotes[0] : null;
    // Last rung: the ordering instance's own quote. The feed asks only the market-data pool, so
    // an exit priced on the last trade (forceLtp skips depth) had no price whenever the pool
    // could not quote - and an Indian exit with no price is refused, never sent as MARKET.
    if (!quote && instanceId) {
      const instance = await db.get('SELECT * FROM instances WHERE id = ?', [instanceId]).catch(() => null);
      if (instance) {
        quote = await openalgoClient.getQuote(instance, symbol, exchange, { ignoreCircuit: true }).catch(() => null);
        if (!(extractLtp(quote) > 0)) quote = null;
      }
    }
    if (!quote) {
      throw new ValidationError(`No quote available for ${exchange}:${symbol}`);
    }
    return { quote, fetchedAt: Date.now() };
  }

  /**
   * Last rung before refusing: the ordering instance's own quote. The feed only asks the
   * market-data pool, which can be empty or unhealthy while the instance placing the order is
   * perfectly able to price it.
   */
  async instanceLtp(instance, exchange, symbol) {
    if (!instance?.host_url) return null;
    try {
      const quote = await openalgoClient.getQuote(instance, symbol, exchange, { ignoreCircuit: true });
      const ltp = extractLtp(quote);
      return ltp && ltp > 0 ? ltp : null;
    } catch (error) {
      log.warn('Instance quote failed', { instanceId: instance.id, exchange, symbol, error: error.message });
      return null;
    }
  }

  _parsePrice(value) {
    const parsed = typeof value === 'string' ? parseFloat(value) : value;
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed;
  }

  _parseBuffer(value) {
    const parsed = typeof value === 'string' ? parseFloat(value) : value;
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return parsed;
  }

  _roundToTick(price, tickSize, side) {
    const tick = typeof tickSize === 'string' ? parseFloat(tickSize) : tickSize;
    if (!Number.isFinite(tick) || tick <= 0) {
      return Number(price.toFixed(2));
    }

    const ticks = price / tick;
    const roundedTicks = side === 'BUY'
      ? Math.ceil(ticks - 1e-9)
      : Math.floor(ticks + 1e-9);
    const rounded = roundedTicks * tick;
    const decimals = this._countDecimals(tick);
    return Number(rounded.toFixed(decimals));
  }

  _countDecimals(value) {
    const text = value.toString();
    const idx = text.indexOf('.');
    return idx === -1 ? 0 : Math.min(6, text.length - idx - 1);
  }

  /**
   * Price type + price for a caller that means "fill now" (quick orders, auto-exit, retries,
   * broadcasts) rather than one that chose a resting price.
   *
   * Pricing a marketable LIMIT off the live quote is an OPTIMISATION, not a requirement:
   * OpenAlgo converts MARKET to LIMIT itself at the broker, but with a wider buffer than we aim
   * for, so computing it here gets the tighter fill. When the quote is cold there is nothing to
   * improve on - and a fill-now caller must still place its order.
   *
   * Ladder: depth (preferring the ordering instance) -> fresh quote -> relaxed ~15s LTP. Past
   * that, CRYPTO falls back to MARKET, but every Indian exchange THROWS: SEBI requires LIMIT
   * orders there, so an unpriced order is refused, never sent as MARKET. Auto-exit treats the
   * refusal as a failed close and retries on its next tick.
   *
   * Callers that chose their own price must NOT use this: for them a bad price is an error, and
   * turning it into a market fill is the failure this codebase already fixed once.
   */
  async resolveMarketablePricing(options) {
    try {
      const { price } = await this.resolveLimitPrice(options);
      return { pricetype: 'LIMIT', price };
    } catch (strictError) {
      let failure = strictError;
      // Retry once on a relaxed quote before conceding MARKET. MARKET is the expensive outcome
      // here, not the safe one: the broker/OpenAlgo converts it to a LIMIT with a far wider
      // buffer than this service uses, so the order rests nowhere near the touch. A slightly
      // older LTP prices a better order than that conversion does.
      try {
        const { price } = await this.resolveLimitPrice({
          ...options,
          quoteStaleMs: RELAXED_QUOTE_STALE_MS,
          bypassSpreadCheck: true,
          forceLtp: true,
        });
        log.warn('Limit price from relaxed quote', {
          exchange: options?.exchange,
          symbol: options?.symbol,
          side: options?.side,
          strict_error: strictError.message,
        });
        return { pricetype: 'LIMIT', price };
      } catch (relaxedError) {
        failure = relaxedError;
      }

      // SEBI: Indian exchanges take LIMIT orders only, so with no price there is no order. The
      // caller surfaces the refusal (and auto-exit retries on its next tick) - far better than
      // an unpriced MARKET order. Crypto may still go as MARKET; Delta Exchange accepts it.
      if (requiresLimitOrders(options?.exchange)) {
        log.error('No limit price - order refused (SEBI limit-only)', {
          exchange: options?.exchange,
          symbol: options?.symbol,
          reason: failure.message,
        });
        throw new ValidationError(
          `No price available for ${options?.exchange}:${options?.symbol} - LIMIT order could not be priced (${failure.message})`
        );
      }
      log.warn('Limit price unavailable - falling back to MARKET', {
        exchange: options?.exchange,
        symbol: options?.symbol,
        side: options?.side,
        error: failure.message,
      });
      return { pricetype: 'MARKET', price: 0 };
    }
  }
}

const limitPriceService = new LimitPriceService();
export default limitPriceService;
