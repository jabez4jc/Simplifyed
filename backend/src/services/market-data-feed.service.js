/**
 * Market Data Feed Service
 * Centralized polling + cache for OpenAlgo feeds (quotes, positions, orders, funds, etc.)
 * Step 2 of rate-limit mitigation: consolidate traffic so multiple dashboard users don't duplicate calls.
 *
 * Optimizations:
 * - HTTP/2 multiplexing for parallel quote fetches
 * - Consolidated TTLs with configurable freshness
 * - Quote fallback to alternate instances on failure
 * - Parallel batch processing
 */

import EventEmitter from 'events';
import instanceService from './instance.service.js';
import marketDataInstanceService from './market-data-instance.service.js';
import watchlistService from './watchlist.service.js';
import openalgoClient from '../integrations/openalgo/client.js';
import config from '../core/config.js';
import { log } from '../core/logger.js';

const DEFAULT_QUOTE_INTERVAL = 5000;   // 5 seconds (increased from 2s for display)
const DEFAULT_POSITION_INTERVAL = 10000; // 10 seconds
const DEFAULT_FUNDS_INTERVAL = 15000;

// TTL configurations
const TTL_DISPLAY = 5000;      // 5s TTL for watchlist display (relaxed)
const TTL_ORDER_CRITICAL = 2000; // 2s TTL for order-critical operations (aggressive)

class MarketDataFeedService extends EventEmitter {
  constructor() {
    super();
    this.quoteCache = new Map();      // key: instanceId -> { data, fetchedAt }
    this.positionCache = new Map();
    this.fundsCache = new Map();
    this.intervals = [];
    this.isRunning = false;
    this.failureState = new Map(); // key instanceId:feed -> state
    this.failureThreshold = 3;
    this.cooldownMs = 60000; // 1 minute default
    this.cooldownJitterMs = 5000;
    this.lastQuoteRefreshAt = 0;
    this.positionRefreshTimestamps = new Map();
    this.fundsRefreshTimestamps = new Map();

    // Consolidated TTL settings
    // Base quote TTL from config (used for display, defaults to 5s)
    this.QUOTE_TTL_MS = Math.max(config.marketDataFeed.quoteTtlMs || 5000, TTL_DISPLAY);
    // Order-critical TTL (always aggressive, 2s)
    this.QUOTE_TTL_ORDER_MS = TTL_ORDER_CRITICAL;

    this.POSITION_TTL_MS = config.marketDataFeed.positionTtlMs;
    this.FUNDS_TTL_MS = config.marketDataFeed.fundsTtlMs;
    this.ORDERBOOK_TTL_MS = config.marketDataFeed.orderbookTtlMs;
    this.TRADEBOOK_TTL_MS = config.marketDataFeed.tradebookTtlMs;
    this.orderbookCache = new Map();
    this.orderbookRefreshTimestamps = new Map();
    this.tradebookCache = new Map();
    this.tradebookRefreshTimestamps = new Map();

    // Unified symbol quote cache (consolidated from separate SYMBOL_QUOTE_TTL_MS)
    // TTL is now configurable per-call via ttlMs parameter
    this.symbolQuoteCache = new Map(); // key: EXCHANGE|SYMBOL -> { quote, fetchedAt }
  }

  async start(config = {}) {
    if (this.isRunning) return;
    this.isRunning = true;

    const quoteInterval = config.quoteInterval ?? DEFAULT_QUOTE_INTERVAL;
    const positionInterval = config.positionInterval ?? DEFAULT_POSITION_INTERVAL;
    const fundsInterval = config.fundsInterval ?? DEFAULT_FUNDS_INTERVAL;

    await Promise.allSettled([
      this.refreshQuotes({ force: true }),
      this.refreshPositions({ force: true }),
      this.refreshFunds({ force: true }),
    ]);

    this.intervals.push(setInterval(() => this.refreshQuotes(), quoteInterval));
    this.intervals.push(setInterval(() => this.refreshPositions(), positionInterval));
    this.intervals.push(setInterval(() => this.refreshFunds(), fundsInterval));

    log.info('MarketDataFeedService started', { quoteInterval, positionInterval, fundsInterval });
  }

  stop() {
    this.intervals.forEach(clearInterval);
    this.intervals = [];
    this.isRunning = false;
  }

  /**
   * Quotes (per market-data instance)
   */
  async refreshQuotes({ force = false } = {}) {
    const now = Date.now();
    if (!force && now - this.lastQuoteRefreshAt < this.QUOTE_TTL_MS) {
      log.debug('Skipping quote refresh - TTL not expired', {
        lastRefreshMs: now - this.lastQuoteRefreshAt,
        ttl: this.QUOTE_TTL_MS,
      });
      return;
    }
    this.lastQuoteRefreshAt = now;

    try {
      const marketDataInstances = await marketDataInstanceService.getMarketDataPool();
      const symbolList = await this._buildGlobalSymbolList();

      if (symbolList.length === 0 || marketDataInstances.length === 0) {
        log.debug('No tracked symbols or no market data instances. Skipping quote refresh.');
        return;
      }

      const poolSize = Math.max(1, marketDataInstances.length);
      const chunkSize = Math.max(3, Math.min(5, Math.ceil(symbolList.length / poolSize)));
      const chunks = this._chunkSymbols(symbolList, chunkSize);
      const assignments = new Map(); // inst.id -> symbols[]
      chunks.forEach((chunk, idx) => {
        const inst = marketDataInstances[idx % marketDataInstances.length];
        if (!assignments.has(inst.id)) assignments.set(inst.id, []);
        assignments.get(inst.id).push(...chunk);
      });

      await Promise.all(Array.from(assignments.entries()).map(async ([instId, symbols]) => {
        const inst = marketDataInstances.find(i => i.id === instId);
        if (!inst) return;
        const circuitKey = this._getCircuitKey(inst.id, 'quotes');
        if (this._shouldSkipPolling(circuitKey)) {
          return;
        }
        try {
          const snapshot = await openalgoClient.getQuotes(inst, symbols);
          this.setQuoteSnapshot(inst.id, snapshot);
          log.debug('Quotes refreshed', { instance: inst.name, count: snapshot.length, symbols: symbols.length });
          this._resetFailureState(circuitKey);
        } catch (error) {
          log.warn('Failed to refresh quotes for instance', {
            instance: inst.name,
            error: error.message,
          });
          this._recordFailure(circuitKey, error);
        }
      }));
    } catch (error) {
      log.warn('Failed to refresh quotes', { error: error.message });
    }
  }

  getQuoteSnapshot(instanceId) {
    return this.quoteCache.get(instanceId);
  }

  setQuoteSnapshot(instanceId, quotes, options = {}) {
    let dataArray;
    if (Array.isArray(quotes)) {
      dataArray = quotes;
    } else if (quotes && Array.isArray(quotes.data)) {
      dataArray = quotes.data;
    } else {
      dataArray = [];
    }

    const snapshot = {
      data: dataArray,
      fetchedAt: options.fetchedAt || Date.now(),
    };

    if (options.source) {
      snapshot.source = options.source;
    }

    this.quoteCache.set(instanceId, snapshot);
    // Update symbol-level cache
    dataArray.forEach((q) => {
      if (!q?.symbol) return;
      const key = this._symbolKey(q.exchange, q.symbol);
      this.symbolQuoteCache.set(key, { quote: q, fetchedAt: snapshot.fetchedAt });
    });
    this.emit('quotes:update', { instanceId, data: snapshot.data });
  }

  /**
   * Retrieve cached quotes for symbols if fresh, and return missing symbols
   * @param {Array} symbols - Array of {exchange, symbol}
   * @param {Object} options - Options
   * @param {number} options.ttlMs - Custom TTL in milliseconds (default: QUOTE_TTL_MS for display)
   * @param {boolean} options.orderCritical - Use aggressive TTL for order-critical operations
   * @returns {{ cached: Array, missing: Array }}
   */
  getCachedQuotesForSymbols(symbols = [], options = {}) {
    // Support legacy signature: getCachedQuotesForSymbols(symbols, ttlMs)
    const opts = typeof options === 'number' ? { ttlMs: options } : options;
    const { orderCritical = false } = opts;

    // Determine TTL: orderCritical uses aggressive TTL, otherwise use custom or display TTL
    const ttlMs = opts.ttlMs ?? (orderCritical ? this.QUOTE_TTL_ORDER_MS : this.QUOTE_TTL_MS);

    const now = Date.now();
    const cached = [];
    const missing = [];
    symbols.forEach((s) => {
      const key = this._symbolKey(s.exchange, s.symbol);
      const entry = this.symbolQuoteCache.get(key);
      if (entry && entry.fetchedAt && now - entry.fetchedAt <= ttlMs) {
        cached.push(entry.quote);
      } else {
        missing.push(s);
      }
    });
    return { cached, missing };
  }

  /**
   * Fetch quotes for a set of symbols using pooled market data instances
   * Uses parallel batch processing with fallback to alternate instances on failure
   * @param {Array} symbols - Array of {exchange, symbol}
   * @param {Object} options - Options
   * @param {number} options.ttlMs - Custom TTL for cache check before fetching
   * @param {boolean} options.orderCritical - Use aggressive TTL for order-critical operations
   * @param {boolean} options.useFallback - Retry failed quotes on alternate instances (default: true)
   * @returns {Promise<Array>} - Array of quotes
   */
  async fetchQuotesForSymbols(symbols = [], options = {}) {
    const { ttlMs, orderCritical = false, useFallback = true } = options;

    const unique = this._dedupeSymbols(symbols);
    if (unique.length === 0) return [];

    // Check cache first with appropriate TTL
    const { cached, missing } = this.getCachedQuotesForSymbols(unique, { ttlMs, orderCritical });

    // Return cached if all symbols are fresh
    if (missing.length === 0) {
      log.debug('All quotes served from cache', { count: cached.length });
      return cached;
    }

    const pool = await marketDataInstanceService.getMarketDataPool();
    if (pool.length === 0) {
      log.warn('No market data instances available for ad-hoc quotes fetch');
      return cached; // Return what we have from cache
    }

    let fetchedQuotes = [];

    if (useFallback && pool.length > 1) {
      // Use new fallback method for multi-instance pools
      fetchedQuotes = await openalgoClient.getQuotesWithFallback(pool, missing, { maxRetries: 2 });
    } else {
      // Single instance or fallback disabled: use parallel batch processing
      const batchSize = Math.max(3, Math.min(5, Math.ceil(missing.length / Math.max(1, pool.length))));
      const chunks = this._chunkSymbols(missing, batchSize);

      // PARALLEL batch processing (not sequential!)
      const batchPromises = chunks.map(async (chunk, idx) => {
        const inst = pool[idx % pool.length];
        try {
          const quotes = await openalgoClient.getQuotes(inst, chunk);
          return { success: true, quotes: Array.isArray(quotes) ? quotes : [], inst };
        } catch (error) {
          log.warn('Batch quote fetch failed', { instance: inst.name, error: error.message });
          return { success: false, quotes: [], inst };
        }
      });

      const batchResults = await Promise.all(batchPromises);

      // Collect all successful quotes
      for (const result of batchResults) {
        if (result.success && result.quotes.length > 0) {
          this.setQuoteSnapshot(result.inst.id, result.quotes, { fetchedAt: Date.now() });
          fetchedQuotes = fetchedQuotes.concat(result.quotes);
        }
      }
    }

    // Update symbol cache with fetched quotes
    if (fetchedQuotes.length > 0) {
      const now = Date.now();
      fetchedQuotes.forEach((q) => {
        if (q?.symbol) {
          const key = this._symbolKey(q.exchange, q.symbol);
          this.symbolQuoteCache.set(key, { quote: q, fetchedAt: now });
        }
      });
    }

    // Combine cached and fetched
    const allQuotes = [...cached, ...fetchedQuotes];

    log.debug('Quote fetch completed', {
      requested: unique.length,
      fromCache: cached.length,
      fetched: fetchedQuotes.length,
      total: allQuotes.length,
    });

    return allQuotes;
  }

  /**
   * Positions (per trading instance)
   */
  async refreshPositions({ force = false } = {}) {
    try {
      const instances = await instanceService.getAllInstances({ is_active: true });
      await Promise.all(instances.map(inst => this.refreshPositionsForInstance(inst.id, { force })));
    } catch (error) {
      log.warn('refreshPositions failed to load instances', { error: error.message });
    }
  }

  getPositionSnapshot(instanceId) {
    return this.positionCache.get(instanceId);
  }

  setPositionSnapshot(instanceId, positions) {
    this.positionCache.set(instanceId, { data: positions, fetchedAt: Date.now() });
    this.emit('positions:update', { instanceId, data: positions });
  }

  async refreshPositionsForInstance(instanceId, { force = false } = {}) {
    try {
      const circuitKey = this._getCircuitKey(instanceId, 'positions');
      if (this._shouldSkipPolling(circuitKey)) {
        return;
      }
      const now = Date.now();
      const last = this.positionRefreshTimestamps.get(instanceId) || 0;
      if (!force && now - last < this.POSITION_TTL_MS) {
        log.debug('Skipping position refresh (TTL)', { instanceId, elapsedMs: now - last });
        return;
      }
      this.positionRefreshTimestamps.set(instanceId, now);
      const instance = await instanceService.getInstanceById(instanceId);
      const positionBook = await openalgoClient.getPositionBook(instance);
      this.setPositionSnapshot(instanceId, positionBook);
      this._resetFailureState(circuitKey);
    } catch (error) {
      log.warn('Failed to refresh positions for instance', { instanceId, error: error.message });
      const circuitKey = this._getCircuitKey(instanceId, 'positions');
      this._recordFailure(circuitKey, error);
    }
  }

  async invalidatePositions(instanceId, { refresh = false } = {}) {
    this.positionCache.delete(instanceId);
    if (refresh) {
      await this.refreshPositionsForInstance(instanceId, { force: true });
    }
  }

  /**
   * Fetch positions for multiple instances in PARALLEL
   * Used for multi-instance order broadcasting to reduce latency
   * @param {Array} instances - Array of instance objects
   * @param {Object} options - Options
   * @param {boolean} options.forceLive - Force live fetch (bypass cache)
   * @returns {Promise<Map>} - Map of instanceId -> positions array
   */
  async fetchPositionsForInstances(instances, { forceLive = false } = {}) {
    const now = Date.now();
    const results = new Map();

    // Parallel fetch for all instances
    const fetchPromises = instances.map(async (instance) => {
      const instanceId = instance.id;

      // Check cache first unless forceLive
      if (!forceLive) {
        const cached = this.positionCache.get(instanceId);
        const last = this.positionRefreshTimestamps.get(instanceId) || 0;
        if (cached && now - last < this.POSITION_TTL_MS) {
          return { instanceId, positions: cached.data, fromCache: true };
        }
      }

      // Fetch live
      try {
        const circuitKey = this._getCircuitKey(instanceId, 'positions');
        if (this._shouldSkipPolling(circuitKey)) {
          const cached = this.positionCache.get(instanceId);
          return { instanceId, positions: cached?.data || [], fromCache: true, skipped: true };
        }

        const positionBook = await openalgoClient.getPositionBook(instance);
        this.setPositionSnapshot(instanceId, positionBook);
        this.positionRefreshTimestamps.set(instanceId, now);
        this._resetFailureState(circuitKey);

        return { instanceId, positions: positionBook, fromCache: false };
      } catch (error) {
        log.warn('Failed to fetch positions for instance', {
          instanceId,
          instanceName: instance.name,
          error: error.message,
        });
        const circuitKey = this._getCircuitKey(instanceId, 'positions');
        this._recordFailure(circuitKey, error);

        // Return cached data on failure
        const cached = this.positionCache.get(instanceId);
        return { instanceId, positions: cached?.data || [], fromCache: true, error: error.message };
      }
    });

    const fetchResults = await Promise.all(fetchPromises);

    // Convert to Map
    let fromCacheCount = 0;
    let liveCount = 0;
    for (const result of fetchResults) {
      results.set(result.instanceId, result.positions);
      if (result.fromCache) fromCacheCount++;
      else liveCount++;
    }

    log.debug('Parallel position fetch completed', {
      instanceCount: instances.length,
      fromCache: fromCacheCount,
      live: liveCount,
    });

    return results;
  }

  /**
   * Get cached position for a specific symbol across instances
   * Useful for close/exit operations that can use cached data
   * @param {number} instanceId - Instance ID
   * @param {string} symbol - Symbol to find
   * @param {string} exchange - Exchange
   * @returns {Object|null} - Position object or null
   */
  getCachedPositionForSymbol(instanceId, symbol, exchange) {
    const cached = this.positionCache.get(instanceId);
    if (!cached || !cached.data) return null;

    const normalizedSymbol = (symbol || '').toUpperCase();
    const normalizedExchange = (exchange || '').toUpperCase();

    return cached.data.find(pos => {
      const posSymbol = ((pos.symbol || pos.trading_symbol || pos.tradingsymbol) || '').toUpperCase();
      const posExchange = ((pos.exchange || pos.exch) || '').toUpperCase();

      return posSymbol === normalizedSymbol &&
             (!normalizedExchange || posExchange === normalizedExchange);
    }) || null;
  }

  /**
   * Funds / balances (per trading instance)
   */
  async refreshFunds({ force = false } = {}) {
    try {
      const instances = await instanceService.getAllInstances({ is_active: true });
      await Promise.all(instances.map(inst => this.refreshFundsForInstance(inst.id, { force })));
    } catch (error) {
      log.warn('refreshFunds failed to load instances', { error: error.message });
    }
  }

  getFundsSnapshot(instanceId) {
    return this.fundsCache.get(instanceId);
  }

  setFundsSnapshot(instanceId, funds) {
    this.fundsCache.set(instanceId, { data: funds, fetchedAt: Date.now() });
    this.emit('funds:update', { instanceId, data: funds });
  }

  async refreshFundsForInstance(instanceId, { force = false } = {}) {
    try {
      const circuitKey = this._getCircuitKey(instanceId, 'funds');
      if (this._shouldSkipPolling(circuitKey)) {
        return;
      }
      const now = Date.now();
      const last = this.fundsRefreshTimestamps.get(instanceId) || 0;
      if (!force && now - last < this.FUNDS_TTL_MS) {
        log.debug('Skipping funds refresh (TTL)', { instanceId, elapsedMs: now - last });
        return;
      }
      this.fundsRefreshTimestamps.set(instanceId, now);
      const instance = await instanceService.getInstanceById(instanceId);
      const funds = await openalgoClient.getFunds(instance);
      this.setFundsSnapshot(instanceId, funds);
      this._resetFailureState(circuitKey);
    } catch (error) {
      log.warn('Failed to refresh funds for instance', { instanceId, error: error.message });
      const circuitKey = this._getCircuitKey(instanceId, 'funds');
      this._recordFailure(circuitKey, error);
    }
  }

  async invalidateFunds(instanceId, { refresh = false } = {}) {
    this.fundsCache.delete(instanceId);
    if (refresh) {
      await this.refreshFundsForInstance(instanceId);
    }
  }

  /**
   * Helpers
   */
  async _buildGlobalSymbolList() {
    try {
      let trackedSymbols = await watchlistService.getTrackedSymbols({
        onlyActiveWatchlists: true,
        onlyEnabledSymbols: true,
        requireAssignedInstances: true,
      });

      // Fallback: include unassigned symbols if nothing is currently assigned
      if (trackedSymbols.length === 0) {
        trackedSymbols = await watchlistService.getTrackedSymbols({
          onlyActiveWatchlists: true,
          onlyEnabledSymbols: true,
          requireAssignedInstances: false,
        });
      }

      if (trackedSymbols.length === 0) {
        return [];
      }

      const symbolList = trackedSymbols.map(symbol => ({
        exchange: symbol.exchange,
        symbol: symbol.symbol,
      }));

      return symbolList;
    } catch (error) {
      log.warn('Failed to build global symbol list', { error: error.message });
      return [];
    }
  }

  async getOrderbookSnapshot(instanceId, { force = false } = {}) {
    const now = Date.now();
    const last = this.orderbookRefreshTimestamps.get(instanceId);
    const cache = this.orderbookCache.get(instanceId);

    if (!force && cache && last && now - last < this.ORDERBOOK_TTL_MS) {
      return cache;
    }

    try {
      const instance = await instanceService.getInstanceById(instanceId);
      const orderbook = await openalgoClient.getOrderBook(instance);
      const snapshot = { data: orderbook, fetchedAt: Date.now() };
      this.orderbookCache.set(instanceId, snapshot);
      this.orderbookRefreshTimestamps.set(instanceId, now);
      return snapshot;
    } catch (error) {
      log.warn('Failed to refresh orderbook for instance', { instanceId, error: error.message });
      return cache || null;
    }
  }

  invalidateOrderbook(instanceId) {
    this.orderbookCache.delete(instanceId);
  }

  async getTradebookSnapshot(instanceId, { force = false } = {}) {
    const now = Date.now();
    const last = this.tradebookRefreshTimestamps.get(instanceId);
    const cache = this.tradebookCache.get(instanceId);

    if (!force && cache && last && now - last < this.TRADEBOOK_TTL_MS) {
      return cache;
    }

    try {
      const instance = await instanceService.getInstanceById(instanceId);
      const tradebook = await openalgoClient.getTradeBook(instance);
      const normalized = Array.isArray(tradebook) ? tradebook : tradebook?.data || [];
      const snapshot = { data: normalized, fetchedAt: Date.now() };
      this.tradebookCache.set(instanceId, snapshot);
      this.tradebookRefreshTimestamps.set(instanceId, now);
      return snapshot;
    } catch (error) {
      log.warn('Failed to refresh tradebook for instance', { instanceId, error: error.message });
      return cache || null;
    }
  }

  invalidateTradebook(instanceId) {
    this.tradebookCache.delete(instanceId);
  }

  _getCircuitKey(instanceId, feed) {
    return `${instanceId}:${feed}`;
  }

  _chunkSymbols(symbols = [], chunkSize = 5) {
    const chunks = [];
    for (let i = 0; i < symbols.length; i += chunkSize) {
      chunks.push(symbols.slice(i, i + chunkSize));
    }
    return chunks;
  }

  _symbolKey(exchange = '', symbol = '') {
    return `${(exchange || '').toUpperCase()}|${(symbol || '').toUpperCase()}`;
  }

  _dedupeSymbols(symbols = []) {
    const seen = new Set();
    const result = [];
    symbols.forEach((s) => {
      const key = this._symbolKey(s.exchange, s.symbol);
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ exchange: s.exchange, symbol: s.symbol });
      }
    });
    return result;
  }

  _shouldSkipPolling(key) {
    const state = this.failureState.get(key);
    if (!state) return false;
    if (state.cooldownUntil && state.cooldownUntil > Date.now()) {
      if (!state.notified) {
        log.warn('Skipping feed refresh due to upstream cooldown', {
          key,
          resumeInMs: state.cooldownUntil - Date.now(),
          lastError: state.lastErrorMessage,
        });
        state.notified = true;
      }
      return true;
    }
    return false;
  }

  _recordFailure(key, error) {
    const state = this.failureState.get(key) || {
      failures: 0,
      cooldownUntil: null,
      lastErrorMessage: null,
      notified: false,
    };

    state.failures += 1;
    state.lastErrorMessage = error?.message;
    state.notified = false;

    const isHtml = error?.isHtmlResponse;

    if (state.failures >= this.failureThreshold || isHtml) {
      const jitter = Math.floor(Math.random() * this.cooldownJitterMs);
      state.cooldownUntil = Date.now() + this.cooldownMs + jitter;
      state.failures = 0;
      log.warn('Opened circuit breaker for feed polling', {
        key,
        cooldownMs: this.cooldownMs + jitter,
        reason: isHtml ? 'html_response' : 'excess_failures',
        error: error?.message,
      });
    }

    this.failureState.set(key, state);
  }

  _resetFailureState(key) {
    if (this.failureState.has(key)) {
      this.failureState.delete(key);
    }
  }

  /**
   * Invalidate all caches for an instance after order placement
   * Ensures consistent cache invalidation across all layers
   * @param {number} instanceId - Instance ID
   * @param {Object} options - Options
   * @param {boolean} options.refresh - Whether to refresh after invalidation
   * @param {Array} options.feeds - Specific feeds to invalidate (default: all)
   */
  async invalidateInstanceCaches(instanceId, options = {}) {
    const { refresh = false, feeds = ['positions', 'funds', 'orderbook', 'tradebook'] } = options;

    log.debug('Invalidating instance caches', { instanceId, feeds, refresh });

    const invalidationPromises = [];

    if (feeds.includes('positions')) {
      this.positionCache.delete(instanceId);
      this.positionRefreshTimestamps.delete(instanceId);
      if (refresh) {
        invalidationPromises.push(this.refreshPositionsForInstance(instanceId, { force: true }));
      }
    }

    if (feeds.includes('funds')) {
      this.fundsCache.delete(instanceId);
      this.fundsRefreshTimestamps.delete(instanceId);
      if (refresh) {
        invalidationPromises.push(this.refreshFundsForInstance(instanceId, { force: true }));
      }
    }

    if (feeds.includes('orderbook')) {
      this.orderbookCache.delete(instanceId);
      this.orderbookRefreshTimestamps.delete(instanceId);
    }

    if (feeds.includes('tradebook')) {
      this.tradebookCache.delete(instanceId);
      this.tradebookRefreshTimestamps.delete(instanceId);
    }

    // Wait for refresh operations if requested
    if (refresh && invalidationPromises.length > 0) {
      await Promise.allSettled(invalidationPromises);
    }

    this.emit('cache:invalidated', { instanceId, feeds });
  }

  /**
   * Invalidate symbol-level quote cache for specific symbols
   * Useful when quote data needs to be refreshed for specific symbols
   * @param {Array} symbols - Array of {exchange, symbol}
   */
  invalidateSymbolQuotes(symbols = []) {
    for (const s of symbols) {
      const key = this._symbolKey(s.exchange, s.symbol);
      this.symbolQuoteCache.delete(key);
    }
  }
}

const marketDataFeedService = new MarketDataFeedService();
export default marketDataFeedService;
