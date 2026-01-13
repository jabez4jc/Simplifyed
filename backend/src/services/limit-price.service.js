/**
 * Limit Price Service
 * Computes limit prices from freshest quotes with side-aware buffers.
 */

import { ValidationError } from '../core/errors.js';
import { extractLtp } from '../utils/price-extraction.js';
import marketDataFeedService from './market-data-feed.service.js';
import config from '../core/config.js';
import settingsService from './settings.service.js';

const DEFAULT_MAX_SPREAD_PCT = 0.005;

class LimitPriceService {
  async resolveLimitPrice({
    exchange,
    symbol,
    side,
    bufferPoints = 0,
    tickSize = null,
    quoteStaleMs = null,
    bypassSpreadCheck = false,
    forceLtp = false,
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
    let maxSpreadPct =
      config.marketDataFeed?.maxOrderSpreadPct ??
      DEFAULT_MAX_SPREAD_PCT;
    try {
      const setting = await settingsService.getSetting('market_data_feed.max_order_spread_pct');
      const parsed = parseFloat(setting?.rawValue ?? setting?.value);
      if (Number.isFinite(parsed)) {
        maxSpreadPct = parsed;
      }
    } catch {
      // Fall back to config/env defaults if setting is missing.
    }

    const { quote, fetchedAt } = await this._getFreshQuote(
      normalizedExchange,
      normalizedSymbol,
      staleMs
    );

    const ageMs = fetchedAt ? Date.now() - fetchedAt : null;
    if (ageMs !== null && ageMs > staleMs) {
      throw new ValidationError(`Quote is stale for ${normalizedExchange}:${normalizedSymbol}`);
    }

    const bid = this._parsePrice(quote?.bid ?? quote?.best_bid ?? quote?.bestBid ?? quote?.bp);
    const ask = this._parsePrice(quote?.ask ?? quote?.best_ask ?? quote?.bestAsk ?? quote?.ap);
    const ltp = extractLtp(quote);

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

    price = this._roundToTick(price, tickSize, normalizedSide);

    return {
      price,
      source: priceSource,
      quoteAgeMs: ageMs,
      spreadPct,
    };
  }

  async _getFreshQuote(exchange, symbol, staleMs) {
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
    const quote = Array.isArray(quotes) ? quotes[0] : null;
    if (!quote) {
      throw new ValidationError(`No quote available for ${exchange}:${symbol}`);
    }
    return { quote, fetchedAt: Date.now() };
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
}

const limitPriceService = new LimitPriceService();
export default limitPriceService;
