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
import { extractLtp } from '../utils/price-extraction.js';

const DEFAULT_QUOTE_INTERVAL = 5000;               // 5 seconds for quote refresh
const DEFAULT_POSITION_INTERVAL_IDLE = 15000;      // 15 seconds when no open positions
const DEFAULT_POSITION_INTERVAL_ACTIVE = 10000;    // 10 seconds when positions open (for SL/target tracking)
const DEFAULT_FUNDS_INTERVAL = 5 * 60 * 1000;      // 5 minutes for funds refresh

// TTL configurations
const TTL_DISPLAY = 5000;      // 5s TTL for watchlist display (relaxed)
const TTL_ORDER_CRITICAL = 3000; // 3s TTL for order-critical operations (aligned with default)

const MULTI_QUOTE_COOLDOWN_ACTIVE_MS = 3000;
const MULTI_QUOTE_COOLDOWN_IDLE_MS = 10000;
const MULTI_QUOTE_SYMBOL_LIMIT = 50;
const FEED_STAGGER_MS = 2000;

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

    this.POSITION_TTL_MS = config.marketDataFeed.positionTtlMs || DEFAULT_POSITION_INTERVAL_IDLE;
    this.FUNDS_TTL_MS = config.marketDataFeed.fundsTtlMs || DEFAULT_FUNDS_INTERVAL;
    this.ORDERBOOK_TTL_MS = config.marketDataFeed.orderbookTtlMs || DEFAULT_POSITION_INTERVAL_IDLE;
    this.TRADEBOOK_TTL_MS = config.marketDataFeed.tradebookTtlMs || DEFAULT_POSITION_INTERVAL_IDLE;
    this.orderbookCache = new Map();
    this.orderbookRefreshTimestamps = new Map();
    this.tradebookCache = new Map();
    this.tradebookRefreshTimestamps = new Map();

    // Unified symbol quote cache (consolidated from separate SYMBOL_QUOTE_TTL_MS)
    // TTL is now configurable per-call via ttlMs parameter
    this.symbolQuoteCache = new Map(); // key: EXCHANGE|SYMBOL -> { quote, fetchedAt }
    this.multiQuoteTimestamps = new Map();
    this._sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // Track whether there are open positions for dynamic refresh interval
    this.hasOpenPositions = false;
    this.positionIntervalHandle = null;
  }

  async start(config = {}) {
    if (this.isRunning) return;
    this.isRunning = true;

    const quoteInterval = config.quoteInterval ?? DEFAULT_QUOTE_INTERVAL;
    const fundsInterval = config.fundsInterval ?? DEFAULT_FUNDS_INTERVAL;

    // Fire-and-forget warmup to avoid blocking startup
    setTimeout(() => this.refreshQuotes({ force: true }).catch(() => {}), 0);
    setTimeout(() => this.refreshPositions({ force: true }).catch(() => {}), FEED_STAGGER_MS);
    setTimeout(() => this.refreshFunds({ force: true }).catch(() => {}), FEED_STAGGER_MS * 2);

    // Quotes interval
    this.intervals.push(setInterval(() => this.refreshQuotes(), quoteInterval));
    // Position refresh uses dynamic interval based on open positions
    this._startDynamicPositionRefresh(FEED_STAGGER_MS);
    // Funds interval (already slow)
    this.intervals.push(setInterval(() => this.refreshFunds(), fundsInterval));

    log.info('MarketDataFeedService started', {
      quoteInterval,
      positionIntervalIdle: DEFAULT_POSITION_INTERVAL_IDLE,
      positionIntervalActive: DEFAULT_POSITION_INTERVAL_ACTIVE,
      fundsInterval,
    });
  }

  stop() {
    this.intervals.forEach(clearInterval);
    this.intervals = [];
    // Clear dynamic position refresh interval
    if (this.positionIntervalHandle) {
      clearInterval(this.positionIntervalHandle);
      this.positionIntervalHandle = null;
    }
    this.multiQuoteTimestamps.clear();
    this.isRunning = false;
  }

  /**
   * Quotes (per market-data instance)
   */
  async refreshQuotes({ force = false } = {}) {
    const now = Date.now();
    const targetInterval = this.hasOpenPositions ? 3000 : 10000;
    if (!force && now - this.lastQuoteRefreshAt < targetInterval) {
      log.debug('Skipping quote refresh - TTL not expired', {
        lastRefreshMs: now - this.lastQuoteRefreshAt,
        ttl: targetInterval,
      });
      return;
    }
    this.lastQuoteRefreshAt = now;

    try {
      const marketDataInstances = await marketDataInstanceService.getMarketDataPool();
      const symbolList = this._dedupeSymbols(await this._buildGlobalSymbolList());

      if (symbolList.length === 0 || marketDataInstances.length === 0) {
        log.debug('No tracked symbols or no market data instances. Skipping quote refresh.');
        return;
      }

      const supportPool = marketDataInstances.filter(inst => inst.supports_multiquotes);
      const regularPool = marketDataInstances.filter(inst => !inst.supports_multiquotes);

      let pendingSymbols = [...symbolList];
      let collectedQuotes = [];

      if (supportPool.length > 0) {
        const multiResult = await this._fetchViaMultiQuotes(pendingSymbols, supportPool);
        collectedQuotes = collectedQuotes.concat(multiResult.quotes);
        pendingSymbols = multiResult.pendingSymbols;
        if (multiResult.sourceInstanceId && multiResult.quotes.length > 0) {
          this.setQuoteSnapshot(multiResult.sourceInstanceId, multiResult.quotes);
        }
      }

      // Fallback to individual quote calls only if no usable multi-quotes were returned or there are still pending symbols
      if (pendingSymbols.length > 0) {
        const poolForFallback = supportPool.length > 0 ? supportPool.concat(regularPool) : marketDataInstances;
        const assignments = new Map();
        const poolSize = Math.max(1, poolForFallback.length);
        const chunkSize = Math.max(3, Math.min(5, Math.ceil(pendingSymbols.length / poolSize)));
        const chunks = this._chunkSymbols(pendingSymbols, chunkSize);
        chunks.forEach((chunk, idx) => {
          const inst = poolForFallback[idx % poolForFallback.length];
          if (!assignments.has(inst.id)) assignments.set(inst.id, []);
          assignments.get(inst.id).push(...chunk);
        });

        // Sequential per-instance execution with jitter to smooth RPS
        const entries = Array.from(assignments.entries());
        for (const [instId, symbols] of entries) {
          const inst = poolForFallback.find(i => i.id === instId);
          if (!inst) continue;
          const circuitKey = this._getCircuitKey(inst.id, 'quotes');
          if (this._shouldSkipPolling(circuitKey)) {
            continue;
          }

          const maxRetries = 2;
          let lastError = null;

          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
              const snapshot = await openalgoClient.getQuotes(inst, symbols);
              this.setQuoteSnapshot(inst.id, snapshot);
              collectedQuotes = collectedQuotes.concat(snapshot || []);
              log.debug('Quotes refreshed (fallback)', {
                instance: inst.name,
                count: Array.isArray(snapshot) ? snapshot.length : 0,
                symbols: symbols.length,
                attempt: attempt + 1,
              });
              this._resetFailureState(circuitKey);
              break;
            } catch (error) {
              lastError = error;
              if (attempt < maxRetries) {
                const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
                log.debug('Quote refresh failed, retrying', {
                  instance: inst.name,
                  attempt: attempt + 1,
                  maxRetries: maxRetries + 1,
                  retryInMs: delay,
                  error: error.message,
                });
                await new Promise(resolve => setTimeout(resolve, delay));
              }
            }
          }

          if (lastError) {
            log.warn('Failed to refresh quotes after retries', {
              instance: inst.name,
              attempts: maxRetries + 1,
              error: lastError?.message,
            });
            this._recordFailure(circuitKey, lastError);
          }

          // Per-instance jitter to smooth outbound RPS
          await this._sleep(Math.floor(Math.random() * FEED_STAGGER_MS) + FEED_STAGGER_MS);
        }
      }

      // Update symbol-level cache if we have any quotes collected in this refresh cycle
      if (collectedQuotes.length > 0) {
        const ts = Date.now();
        collectedQuotes.forEach((q) => {
          if (!q?.symbol) return;
          const key = this._symbolKey(q.exchange, q.symbol);
          this.symbolQuoteCache.set(key, { quote: q, fetchedAt: ts });
        });
      }
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

    const supportPool = pool.filter(inst => inst.supports_multiquotes);
    const regularPool = pool.filter(inst => !inst.supports_multiquotes);

    let fetchedQuotes = [];
    let pendingSymbols = [...missing];

    if (supportPool.length > 0) {
      const multiResult = await this._fetchViaMultiQuotes(pendingSymbols, supportPool);
      fetchedQuotes = fetchedQuotes.concat(multiResult.quotes);
      pendingSymbols = multiResult.pendingSymbols;
      if (multiResult.sourceInstanceId && multiResult.quotes.length > 0) {
        this.setQuoteSnapshot(multiResult.sourceInstanceId, multiResult.quotes, { fetchedAt: Date.now() });
      }
    }

    if (pendingSymbols.length > 0) {
      if (useFallback && pool.length > 1) {
        fetchedQuotes = fetchedQuotes.concat(
          await openalgoClient.getQuotesWithFallback(pool, pendingSymbols, { maxRetries: 2 })
        );
      } else {
        const batchSize = Math.max(3, Math.min(5, Math.ceil(pendingSymbols.length / Math.max(1, pool.length))));
        const chunks = this._chunkSymbols(pendingSymbols, batchSize);

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
        for (const result of batchResults) {
          if (result.success && result.quotes.length > 0) {
            this.setQuoteSnapshot(result.inst.id, result.quotes, { fetchedAt: Date.now() });
            fetchedQuotes = fetchedQuotes.concat(result.quotes);
          }
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
      for (const inst of instances) {
        await this.refreshPositionsForInstance(inst.id, { force });
        // Per-instance jitter to smooth RPS
        await this._sleep(Math.floor(Math.random() * FEED_STAGGER_MS) + FEED_STAGGER_MS);
      }
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
      const ttlMs = this._getStatefulTtlMs('positions');
      if (!force && now - last < ttlMs) {
        log.debug('Skipping position refresh (TTL)', { instanceId, elapsedMs: now - last, ttlMs });
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
   * @returns {Promise<Map>} - Map of instanceId -> { positions, success, error?, fromCache }
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
          return { instanceId, positions: cached.data, success: true, fromCache: true };
        }
      }

      // Fetch live
      try {
        const circuitKey = this._getCircuitKey(instanceId, 'positions');
        if (this._shouldSkipPolling(circuitKey)) {
          const cached = this.positionCache.get(instanceId);
          // Only return success if we have valid cached data
          if (cached?.data) {
            return { instanceId, positions: cached.data, success: true, fromCache: true, skipped: true };
          }
          // No cache available and circuit is open - this is a failure
          return { instanceId, positions: [], success: false, fromCache: false, skipped: true, error: 'Circuit breaker open, no cached data' };
        }

        const positionBook = await openalgoClient.getPositionBook(instance);
        this.setPositionSnapshot(instanceId, positionBook);
        this.positionRefreshTimestamps.set(instanceId, now);
        this._resetFailureState(circuitKey);

        return { instanceId, positions: positionBook, success: true, fromCache: false };
      } catch (error) {
        log.warn('Failed to fetch positions for instance', {
          instanceId,
          instanceName: instance.name,
          error: error.message,
        });
        const circuitKey = this._getCircuitKey(instanceId, 'positions');
        this._recordFailure(circuitKey, error);

        // Return cached data on failure if available, otherwise mark as failed
        const cached = this.positionCache.get(instanceId);
        if (cached?.data) {
          return { instanceId, positions: cached.data, success: true, fromCache: true, error: error.message };
        }
        // No cache - this is a critical failure, positions are unknown
        return { instanceId, positions: [], success: false, fromCache: false, error: error.message };
      }
    });

    const fetchResults = await Promise.all(fetchPromises);

    // Convert to Map with full result objects (not just positions)
    let fromCacheCount = 0;
    let liveCount = 0;
    let failedCount = 0;
    for (const result of fetchResults) {
      results.set(result.instanceId, {
        positions: result.positions,
        success: result.success,
        fromCache: result.fromCache,
        error: result.error,
      });
      if (!result.success) failedCount++;
      else if (result.fromCache) fromCacheCount++;
      else liveCount++;
    }

    log.debug('Parallel position fetch completed', {
      instanceCount: instances.length,
      fromCache: fromCacheCount,
      live: liveCount,
      failed: failedCount,
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
   * Non-critical: Can be paused during order-critical LTP operations
   */
  async refreshFunds({ force = false } = {}) {
    // Skip if non-critical polling is paused (LTP operations in progress)
    if (!force && this._isNonCriticalPaused()) {
      log.debug('Skipping funds refresh - non-critical polling paused for LTP priority');
      return;
    }

    try {
      const instances = await instanceService.getAllInstances({ is_active: true });
      for (const inst of instances) {
        await this.refreshFundsForInstance(inst.id, { force });
        await this._sleep(Math.floor(Math.random() * FEED_STAGGER_MS) + FEED_STAGGER_MS);
      }
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
    // Skip if non-critical polling is paused (LTP operations in progress)
    if (!force && this._isNonCriticalPaused()) {
      log.debug('Skipping funds refresh for instance - non-critical polling paused', { instanceId });
      return;
    }

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

      // Add open position symbols so live P&L views also get covered
      this.positionCache.forEach((snapshot) => {
        const positions = snapshot?.data || [];
        positions.forEach((p) => {
          const symbol = (p.symbol || p.tradingsymbol || p.trading_symbol || '').trim();
          const exchange = (p.exchange || p.exch || p.brexchange || '').trim();
          if (symbol && exchange) {
            symbolList.push({ exchange, symbol });
          }
        });
      });

      // Add recently requested symbols from the quote cache (covers resolved option/future symbols)
      const now = Date.now();
      this.symbolQuoteCache.forEach((entry, key) => {
        if (!entry?.quote || !entry.fetchedAt) return;
        if (now - entry.fetchedAt > this.QUOTE_TTL_MS) return; // ignore stale cache
        const [exchange, symbol] = key.split('|');
        if (exchange && symbol) {
          symbolList.push({ exchange, symbol });
        }
      });

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
    const ttlMs = this._getStatefulTtlMs('orderbook');

    if (!force && cache && last && now - last < ttlMs) {
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
    const ttlMs = this._getStatefulTtlMs('tradebook');

    if (!force && cache && last && now - last < ttlMs) {
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

  async _fetchViaMultiQuotes(symbols = [], instances = []) {
    if (!Array.isArray(symbols) || symbols.length === 0 || !Array.isArray(instances) || instances.length === 0) {
      return { quotes: [], pendingSymbols: symbols || [], sourceInstanceId: null };
    }

    // Normalize symbols to strings to satisfy broker APIs that are strict about input types
    let pendingSymbols = symbols
      .map((s) => ({
        exchange: `${s.exchange || ''}`,
        symbol: `${s.symbol || ''}`,
      }))
      .filter((s) => s.exchange && s.symbol);

    const collected = [];
    let sourceInstanceId = null;
    const now = Date.now();

    for (const inst of instances) {
      const circuitKey = this._getCircuitKey(inst.id, 'quotes');
      if (this._shouldSkipPolling(circuitKey)) {
        continue;
      }

      const cooldown = this.hasOpenPositions ? MULTI_QUOTE_COOLDOWN_ACTIVE_MS : MULTI_QUOTE_COOLDOWN_IDLE_MS;
      const lastMultiAt = this.multiQuoteTimestamps.get(inst.id) || 0;
      if (now - lastMultiAt < cooldown) {
        log.debug('Skipping MultiQuotes due to cooldown', {
          instance_id: inst.id,
          elapsedMs: now - lastMultiAt,
          cooldownMs: cooldown,
        });
        continue;
      }

      try {
        const { quotes, failed } = await openalgoClient.getMultiQuotes(inst, pendingSymbols, { returnErrors: true });
        const validQuotes = [];
        const invalidSymbols = new Set(failed.map(f => `${(f.exchange || '').toUpperCase()}|${(f.symbol || '').toUpperCase()}`));

        quotes.forEach((q) => {
          const ltp = extractLtp(q);
          const key = `${(q.exchange || '').toUpperCase()}|${(q.symbol || '').toUpperCase()}`;
          if (ltp && ltp > 0) {
            validQuotes.push(q);
            collected.push(q);
            invalidSymbols.delete(key);
          } else {
            invalidSymbols.add(key);
          }
        });

        const resolvedKeys = new Set(validQuotes.map(q => `${(q.exchange || '').toUpperCase()}|${(q.symbol || '').toUpperCase()}`));
        pendingSymbols = pendingSymbols.filter((s) => {
          const key = `${(s.exchange || '').toUpperCase()}|${(s.symbol || '').toUpperCase()}`;
          return invalidSymbols.has(key) || !resolvedKeys.has(key);
        });

        if (validQuotes.length > 0 && sourceInstanceId === null) {
          sourceInstanceId = inst.id;
        }

        this._resetFailureState(circuitKey);
        this.multiQuoteTimestamps.set(inst.id, Date.now());

        if (pendingSymbols.length === 0) {
          break;
        }
      } catch (error) {
        log.warn('MultiQuotes fetch failed on instance', {
          instance_id: inst.id,
          instance_name: inst.name,
          error: error.message,
        });
        this._recordFailure(circuitKey, error);
      }
    }

    return { quotes: collected, pendingSymbols, sourceInstanceId };
  }

  async _fetchQuotesForInstance(instance, symbols = []) {
    if (!Array.isArray(symbols) || symbols.length === 0) {
      return [];
    }

    const normalizedSymbols = symbols
      .map((s) => ({
        exchange: `${s.exchange || ''}`,
        symbol: `${s.symbol || ''}`,
      }))
      .filter((s) => s.exchange && s.symbol);

    if (normalizedSymbols.length === 0) {
      return [];
    }

    const now = Date.now();
    const supportsMulti = Boolean(instance.supports_multiquotes);

    if (supportsMulti && normalizedSymbols.length <= MULTI_QUOTE_SYMBOL_LIMIT) {
      const cooldown = this.hasOpenPositions ? MULTI_QUOTE_COOLDOWN_ACTIVE_MS : MULTI_QUOTE_COOLDOWN_IDLE_MS;
      const lastMultiAt = this.multiQuoteTimestamps.get(instance.id) || 0;
      if (now - lastMultiAt >= cooldown) {
        try {
          const multiQuotes = await openalgoClient.getMultiQuotes(instance, normalizedSymbols);
          this.multiQuoteTimestamps.set(instance.id, now);
          return multiQuotes;
        } catch (error) {
          log.warn('MultiQuotes fetch failed, falling back to single-symbol quotes', {
            instance_id: instance.id,
            error: error.message,
          });
        }
      } else {
        log.debug('Skipping MultiQuotes fetch due to cooldown', {
          instance_id: instance.id,
          elapsedMs: now - lastMultiAt,
          cooldownMs: cooldown,
        });
      }
    }

    return openalgoClient.getQuotes(instance, normalizedSymbols);
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

  _getStatefulTtlMs(feed) {
    const activeTtl = 10000; // 10s when open positions exist
    const idleTtl = 15000;   // 15s when no open positions

    if (feed === 'positions' || feed === 'orderbook' || feed === 'tradebook') {
      return this.hasOpenPositions ? activeTtl : idleTtl;
    }

    return this.QUOTE_TTL_MS;
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

  /**
   * Fetch LTP for a single symbol with aggressive retry
   * Critical for order placement and derivatives resolution
   * This method bypasses normal TTL and uses dedicated retry logic
   * @param {string} exchange - Exchange code
   * @param {string} symbol - Trading symbol
   * @param {Object} options - Options
   * @param {number} options.maxRounds - Number of retry rounds across all instances (default: 2)
   *                                     Each round tries all healthy instances before moving to next round
   * @param {boolean} options.bypassCache - Skip cache check entirely (default: false)
   * @returns {Promise<Object>} - { ltp, quote, source, attempts }
   */
  async fetchLtpForSymbol(exchange, symbol, options = {}) {
    const { maxRounds = 2, bypassCache = false } = options;

    // Check cache first unless bypassed (use order-critical TTL)
    if (!bypassCache) {
      const { cached } = this.getCachedQuotesForSymbols(
        [{ exchange, symbol }],
        { orderCritical: true }
      );

      if (cached.length > 0) {
        const quote = cached[0];
        const ltp = this._extractLtpFromQuote(quote);
        if (ltp && ltp > 0) {
          log.debug('LTP served from cache', { exchange, symbol, ltp });
          return { ltp, quote, source: 'cache', attempts: 0 };
        }
      }
    }

    // Get market data pool for retry/failover
    const pool = await marketDataInstanceService.getMarketDataPool();
    if (pool.length === 0) {
      throw new Error('No market data instances available for LTP fetch');
    }

    // Pause non-critical polling during LTP fetch to prioritize bandwidth
    this.pauseNonCriticalPolling(3000);

    // Use getLtpWithRetry for aggressive retry with exponential backoff
    // Strategy: Try different instances first, then do another round if needed
    const result = await openalgoClient.getLtpWithRetry(pool, exchange, symbol, {
      maxRounds: Math.max(1, maxRounds), // Ensure at least 1 round
      baseDelayMs: 50,
    });

    // Update caches
    if (result.quote) {
      const key = this._symbolKey(exchange, symbol);
      this.symbolQuoteCache.set(key, { quote: result.quote, fetchedAt: Date.now() });
    }

    return result;
  }

  /**
   * Extract LTP from quote (helper method)
   * @private
   */
  _extractLtpFromQuote(quote) {
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
      const parsed = parseFloat(value);
      if (!isNaN(parsed) && parsed > 0) {
        return parsed;
      }
    }

    return null;
  }

  /**
   * Pause non-critical polling (Funds, Ping) temporarily
   * Use during order-critical operations to prioritize LTP
   * @param {number} durationMs - Duration to pause in milliseconds (default: 5000)
   */
  pauseNonCriticalPolling(durationMs = 5000) {
    this._nonCriticalPausedUntil = Date.now() + durationMs;
    log.debug('Non-critical polling paused', { resumeInMs: durationMs });
  }

  /**
   * Check if non-critical polling should be skipped
   * @private
   */
  _isNonCriticalPaused() {
    if (!this._nonCriticalPausedUntil) return false;
    if (Date.now() >= this._nonCriticalPausedUntil) {
      this._nonCriticalPausedUntil = null;
      return false;
    }
    return true;
  }

  /**
   * Start dynamic position refresh with adaptive intervals
   * - 30 seconds when no open positions (idle)
   * - 5 seconds when positions are open (for SL/target tracking)
   * @private
   */
  _startDynamicPositionRefresh(initialDelayMs = 0) {
    // Initial interval based on current state
    const initialInterval = this.hasOpenPositions
      ? DEFAULT_POSITION_INTERVAL_ACTIVE
      : DEFAULT_POSITION_INTERVAL_IDLE;

    this._schedulePositionRefresh(initialInterval + initialDelayMs);
  }

  /**
   * Schedule next position refresh and detect open positions
   * @private
   * @param {number} intervalMs - Interval until next refresh
   */
  _schedulePositionRefresh(intervalMs) {
    // Clear existing interval if any
    if (this.positionIntervalHandle) {
      clearTimeout(this.positionIntervalHandle);
      this.positionIntervalHandle = null;
    }

    // Schedule next refresh
    this.positionIntervalHandle = setTimeout(async () => {
      if (!this.isRunning) return;

      try {
        // Refresh positions
        await this.refreshPositions({ force: false });

        // Detect open positions across all instances
        const hadOpenPositions = this.hasOpenPositions;
        this.hasOpenPositions = this._detectOpenPositions();

        // Log interval change if position state changed
        if (hadOpenPositions !== this.hasOpenPositions) {
          const newInterval = this.hasOpenPositions
            ? DEFAULT_POSITION_INTERVAL_ACTIVE
            : DEFAULT_POSITION_INTERVAL_IDLE;
          log.info('Position refresh interval changed', {
            hasOpenPositions: this.hasOpenPositions,
            newIntervalMs: newInterval,
            reason: this.hasOpenPositions
              ? 'Open positions detected - switching to active refresh for SL/target tracking'
              : 'No open positions - switching to idle refresh',
          });
        }

        // Schedule next refresh with appropriate interval
        const nextInterval = this.hasOpenPositions
          ? DEFAULT_POSITION_INTERVAL_ACTIVE
          : DEFAULT_POSITION_INTERVAL_IDLE;
        this._schedulePositionRefresh(nextInterval);
      } catch (error) {
        log.warn('Dynamic position refresh failed', { error: error.message });
        // On error, retry with idle interval
        this._schedulePositionRefresh(DEFAULT_POSITION_INTERVAL_IDLE);
      }
    }, intervalMs);
  }

  /**
   * Detect if there are any open positions across all cached instances
   * An open position has non-zero quantity
   * @private
   * @returns {boolean} - True if any open positions exist
   */
  _detectOpenPositions() {
    for (const [instanceId, snapshot] of this.positionCache.entries()) {
      if (!snapshot?.data || !Array.isArray(snapshot.data)) continue;

      for (const position of snapshot.data) {
        // Check for open position (non-zero net quantity)
        const netQty = this._getPositionNetQuantity(position);
        if (netQty !== 0) {
          log.debug('Open position detected', {
            instanceId,
            symbol: position.symbol || position.trading_symbol || position.tradingsymbol,
            netQty,
          });
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Extract net quantity from position object
   * Handles different broker response formats
   * @private
   * @param {Object} position - Position object
   * @returns {number} - Net quantity (0 if no position)
   */
  _getPositionNetQuantity(position) {
    if (!position) return 0;

    // Try various field names used by different brokers
    const candidates = [
      position.netqty,
      position.net_qty,
      position.netQty,
      position.quantity,
      position.qty,
      position.buyqty - position.sellqty,
      position.buy_qty - position.sell_qty,
    ];

    for (const value of candidates) {
      const parsed = parseInt(value, 10);
      if (!isNaN(parsed)) {
        return parsed;
      }
    }

    return 0;
  }
}

const marketDataFeedService = new MarketDataFeedService();
export default marketDataFeedService;
