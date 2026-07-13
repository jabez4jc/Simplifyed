/**
 * Quick Order Quotes Service
 * LTP/quote fetching and caching for quick-order flows: underlying LTP with instance failover,
 * option-chain-derived quote maps (with their own short-TTL cache), and quote-snapshot merging/
 * lookup helpers. Extracted from quick-order.service.js - owns its own cache (optionChainQuoteCache)
 * that no other cluster in that file touched.
 */

import { log } from '../core/logger.js';
import marketDataFeedService from './market-data-feed.service.js';
import marketDataInstanceService from './market-data-instance.service.js';
import openalgoClient from '../integrations/openalgo/client.js';
import { ValidationError } from '../core/errors.js';
import { parseFloatSafe, parseIntSafe } from '../utils/sanitizers.js';
import { normalizeSymbolKey, normalizeExchange } from '../utils/symbol-parsing.util.js';

class QuickOrderQuotesService {
  constructor() {
    this.optionChainQuoteCache = new Map(); // key: inst|exch|underlying|expiry -> { map, fetchedAt }
    this.optionChainQuoteTtlMs = 20000; // retain option chain quotes for 20s to avoid blanks
  }

  /**
   * Get underlying LTP using primary/secondary market data instances with failover
   * Uses the designated primary or secondary instance for market data, not the order instance
   */
  async getUnderlyingLTPWithFallback(instance, underlying, exchange) {
    try {
      // Get the designated market data instance (primary with failover to secondary)
      const marketDataInstance = await marketDataInstanceService.getMarketDataInstance();

      log.debug('Using market data instance for LTP', {
        order_instance_id: instance.id,
        order_instance_name: instance.name,
        market_data_instance_id: marketDataInstance.id,
        market_data_instance_name: marketDataInstance.name,
        market_data_role: marketDataInstance.market_data_role,
        underlying,
        exchange,
      });

      // Fetch LTP from the market data instance
      const ltp = await this.getUnderlyingLTP(marketDataInstance, underlying, exchange);

      log.debug('Successfully fetched LTP from market data instance', {
        market_data_instance: marketDataInstance.name,
        market_data_role: marketDataInstance.market_data_role,
        underlying,
        ltp,
      });

      return ltp;
    } catch (error) {
      log.error('Failed to get LTP from market data instances', {
        order_instance_id: instance.id,
        order_instance_name: instance.name,
        underlying,
        exchange,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get underlying LTP with aggressive retry logic
   * LTP is critical for order placement and derivatives resolution
   */
  async getUnderlyingLTP(instance, underlying, exchange) {
    try {
      log.debug('Fetching LTP for underlying', {
        instance_id: instance.id,
        instance_name: instance.name,
        underlying,
        exchange,
      });

      const result = await marketDataFeedService.fetchLtpForSymbol(exchange, underlying, {
        maxRounds: 2,
      });

      if (result?.ltp && result.ltp > 0) {
        log.debug('LTP fetched successfully', {
          instance_id: instance.id,
          underlying,
          ltp: result.ltp,
          source: result.source,
          attempts: result.attempts,
        });
        return result.ltp;
      }

      throw new Error('No LTP returned');
    } catch (error) {
      log.error('Failed to get underlying LTP after retries', error, {
        instance_id: instance.id,
        instance_name: instance.name,
        underlying,
        exchange,
      });
      throw new ValidationError(`Unable to get LTP for ${underlying}: ${error.message}`);
    }
  }

  mergeQuoteMaps(primary, secondary) {
    const merged = new Map();
    if (secondary) {
      secondary.forEach((value, key) => merged.set(key, value));
    }
    if (primary) {
      primary.forEach((value, key) => {
        const existing = merged.get(key);
        const hasExistingLtp = existing && this.extractLtpFromQuote(existing) !== null;
        const hasNewLtp = this.extractLtpFromQuote(value) !== null;

        // Prefer the option chain quote when it has an LTP; otherwise keep the richer entry
        if (!existing || (hasNewLtp || !hasExistingLtp)) {
          merged.set(key, value);
        }
      });
    }
    return merged;
  }

  hasAllQuotes(map, keys = [], requirePrice = false) {
    if (!keys || keys.length === 0) return true;
    if (!map || typeof map.get !== 'function') return false;
    return keys.every((k) => {
      const q = map.get(k);
      if (!q) return false;
      if (!requirePrice) return true;
      return this.extractLtpFromQuote(q) !== null;
    });
  }

  async getOptionChainQuotesMap({
    instance,
    underlying,
    expiry,
    exchange,
    minStrikeCount = 5,
  }) {
    if (!instance || !instance.supports_option_chain) {
      return null;
    }

    const cacheKey = `${instance.id || 'INSTANCE'}|${(exchange || '').toUpperCase()}|${(underlying || '').toUpperCase()}|${expiry || ''}`;
    const cached = this.optionChainQuoteCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.fetchedAt <= this.optionChainQuoteTtlMs) {
      return cached.map;
    }

    try {
      const strikeCount = Math.max(parseIntSafe(minStrikeCount) || 0, 5);
      const chain = await openalgoClient.getOptionChain(
        instance,
        underlying,
        expiry,
        exchange,
        { strikeCount, skipBackoff: true }
      );

      const quotes = this.extractQuotesFromOptionChain(chain, exchange);
      const map = this.quotesArrayToMap(quotes, now);
      this.optionChainQuoteCache.set(cacheKey, { map, fetchedAt: now });
      return map;
    } catch (error) {
      log.warn('Option chain quote fetch failed; falling back to multiquotes', {
        instance_id: instance?.id,
        underlying,
        expiry,
        exchange,
        error: error?.message,
      });
      if (cached) {
        return cached.map;
      }
      return null;
    }
  }

  extractQuotesFromOptionChain(chainData, exchange) {
    const rows = Array.isArray(chainData?.chain) ? chainData.chain : [];
    const quotes = [];

    for (const row of rows) {
      const strike = parseFloatSafe(row.strike, null);
      const ce = row.ce || row.CE;
      const pe = row.pe || row.PE;

      if (ce && ce.symbol) {
        quotes.push({
          exchange,
          symbol: ce.symbol || ce.trading_symbol || ce.tradingsymbol,
          strike,
          option_type: 'CE',
          ltp: this.extractLtpFromQuote(ce),
          changePercent: this.extractChangePercentFromQuote(ce),
        });
      }

      if (pe && pe.symbol) {
        quotes.push({
          exchange,
          symbol: pe.symbol || pe.trading_symbol || pe.tradingsymbol,
          strike,
          option_type: 'PE',
          ltp: this.extractLtpFromQuote(pe),
          changePercent: this.extractChangePercentFromQuote(pe),
        });
      }
    }

    return quotes;
  }

  quotesArrayToMap(quotes = [], fetchedAt = Date.now()) {
    const map = new Map();
    for (const quote of quotes) {
      const key = this.buildQuoteMatchKey(quote.exchange, quote.symbol);
      if (!key) continue;
      map.set(key, { ...quote, fetchedAt });
    }
    return map;
  }

  async getQuotesFromCache(instance, requests = []) {
    if (!Array.isArray(requests) || requests.length === 0) {
      return new Map();
    }

    const results = new Map();
    const missing = [];
    const snapshot = marketDataFeedService.getQuoteSnapshot(instance.id);

    for (const request of requests) {
      const key = this.buildQuoteMatchKey(request.exchange, request.symbol);
      if (!key) continue;

      const cachedQuote = this.findQuoteInSnapshot(snapshot, request.exchange, request.symbol);
      if (cachedQuote) {
        const withTimestamp = snapshot?.fetchedAt
          ? { ...cachedQuote, fetchedAt: snapshot.fetchedAt }
          : cachedQuote;
        results.set(key, withTimestamp);
      } else {
        missing.push({
          exchange: request.exchange,
          symbol: request.symbol,
        });
      }
    }

    if (missing.length > 0) {
      const liveQuotes = await openalgoClient.getQuotes(instance, missing);
      if (Array.isArray(liveQuotes)) {
        const fetchedAt = Date.now();
        const merged = Array.isArray(snapshot?.data) ? [...snapshot.data] : [];
        for (const quote of liveQuotes) {
          const key = this.buildQuoteMatchKey(
            quote.exchange || quote.exch,
            quote.symbol || quote.trading_symbol || quote.tradingsymbol
          );
          if (key) {
            const enriched = { ...quote, fetchedAt };
            results.set(key, enriched);
            merged.push(enriched);
          }
        }
        // Update cache so resolved futures/options become part of global polling
        marketDataFeedService.setQuoteSnapshot(instance.id, merged, { fetchedAt });
      }
    }

    return results;
  }

  async getQuotesPreferWs(requests = []) {
    if (!Array.isArray(requests) || requests.length === 0) {
      return new Map();
    }

    const results = new Map();
    const now = Date.now();

    await Promise.all(requests.map(async (request) => {
      try {
        const res = await marketDataFeedService.fetchLtpForSymbol(
          request.exchange,
          request.symbol,
          { maxRounds: 1 }
        );
        if (!res) return;
        const quote = res.quote || {
          exchange: request.exchange,
          symbol: request.symbol,
          ltp: res.ltp,
        };
        if (!quote._source && res.source) {
          quote._source = res.source;
        }
        const key = this.buildQuoteMatchKey(
          quote.exchange || quote.exch || request.exchange,
          quote.symbol || quote.trading_symbol || quote.tradingsymbol || request.symbol
        );
        if (key) {
          const fetchedAt = quote.fetchedAt || now;
          results.set(key, { ...quote, fetchedAt });
        }
      } catch (_) {
        // best effort; fallback handled by callers
      }
    }));

    return results;
  }

  findQuoteInSnapshot(snapshot, exchange, symbol) {
    if (!snapshot?.data || snapshot.data.length === 0) {
      return null;
    }

    const targetKey = this.buildQuoteMatchKey(exchange, symbol);
    if (!targetKey) {
      return null;
    }

    for (const quote of snapshot.data) {
      const candidateKey = this.buildQuoteMatchKey(
        quote.exchange || quote.exch,
        quote.symbol || quote.trading_symbol || quote.tradingsymbol
      );

      if (candidateKey && candidateKey === targetKey) {
        return quote;
      }
    }

    return null;
  }

  buildQuoteMatchKey(exchange, symbol) {
    const normalizedSymbol = normalizeSymbolKey(symbol);
    if (!normalizedSymbol) {
      return null;
    }

    const normalizedExchange = normalizeExchange(exchange) || 'DEFAULT';
    return `${normalizedExchange}::${normalizedSymbol}`;
  }

  extractLtpFromQuote(quote) {
    if (!quote) return null;
    const candidates = [
      quote.ltp,
      quote.LTP,
      quote.last_price,
      quote.lastPrice,
      quote.last_traded_price,
      quote.lastTradedPrice,
      quote.close,
    ];

    for (const value of candidates) {
      const parsed = parseFloatSafe(value, null);
      if (parsed !== null && !Number.isNaN(parsed) && parsed !== 0) {
        return parsed;
      }
    }

    return null;
  }

  extractChangePercentFromQuote(quote) {
    if (!quote) return null;
    const candidates = [
      quote.percent_change,
      quote.pchange,
      quote.change_percent,
      quote.change,
    ];

    for (const value of candidates) {
      const parsed = parseFloatSafe(value, null);
      if (parsed !== null && !Number.isNaN(parsed)) {
        return parsed;
      }
    }

    return null;
  }
}

const quickOrderQuotesService = new QuickOrderQuotesService();
export default quickOrderQuotesService;
export { QuickOrderQuotesService };
