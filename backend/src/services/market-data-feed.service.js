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
import { createHash } from 'crypto';
import instanceService from './instance.service.js';
import marketDataInstanceService from './market-data-instance.service.js';
import watchlistService from './watchlist.service.js';
import openalgoClient from '../integrations/openalgo/client.js';
import config from '../core/config.js';
import { log } from '../core/logger.js';
import db from '../core/database.js';
import { extractAveragePrice, extractLtp } from '../utils/price-extraction.js';
import openalgoWsService from './openalgo-ws.service.js';
import { isGeneralEndpointBlackout, isQuoteEndpointBlackout } from './instance-health.service.js';

const DEFAULT_QUOTE_INTERVAL = 5000;               // 5 seconds for quote refresh (WS primary; REST uses TTL)
const DEFAULT_QUOTE_TTL_IDLE_MS = 15000;
const DEFAULT_QUOTE_TTL_ACTIVE_MS = 10000;
const DEFAULT_POSITION_INTERVAL_IDLE = 30000;      // 30 seconds when no open positions
const DEFAULT_POSITION_INTERVAL_ACTIVE = 8000;     // 8 seconds when positions open
const DEFAULT_TRADEBOOK_INTERVAL_IDLE = 30000;
const DEFAULT_TRADEBOOK_INTERVAL_ACTIVE = 8000;
const DEFAULT_ORDERBOOK_INTERVAL = 30000;
const DEFAULT_FUNDS_INTERVAL = 3 * 60 * 1000;      // 3 minutes for funds refresh (sequential)

// TTL configurations
const TTL_DISPLAY = 5000;      // 5s TTL for watchlist display (relaxed)
const TTL_ORDER_CRITICAL = 3000; // 3s TTL for order-critical operations (aligned with default)

const MULTI_QUOTE_COOLDOWN_ACTIVE_MS = 10000;
const MULTI_QUOTE_COOLDOWN_IDLE_MS = 15000;
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
    this.QUOTE_TTL_MS = DEFAULT_QUOTE_TTL_IDLE_MS;
    this.QUOTE_TTL_ORDER_MS = TTL_ORDER_CRITICAL;
    this.POSITION_TTL_MS = DEFAULT_POSITION_INTERVAL_IDLE;
    this.FUNDS_TTL_MS = DEFAULT_FUNDS_INTERVAL;
    this.ORDERBOOK_TTL_MS = DEFAULT_ORDERBOOK_INTERVAL;
    this.TRADEBOOK_TTL_MS = DEFAULT_TRADEBOOK_INTERVAL_IDLE;
    this.quoteTtlIdleMs = DEFAULT_QUOTE_TTL_IDLE_MS;
    this.quoteTtlActiveMs = DEFAULT_QUOTE_TTL_ACTIVE_MS;
    this.positionIntervalIdleMs = DEFAULT_POSITION_INTERVAL_IDLE;
    this.positionIntervalActiveMs = DEFAULT_POSITION_INTERVAL_ACTIVE;
    this.tradebookIntervalIdleMs = DEFAULT_TRADEBOOK_INTERVAL_IDLE;
    this.tradebookIntervalActiveMs = DEFAULT_TRADEBOOK_INTERVAL_ACTIVE;
    this.orderbookIntervalMs = DEFAULT_ORDERBOOK_INTERVAL;
    this.fundsIntervalMs = DEFAULT_FUNDS_INTERVAL;
    this.quoteIntervalMs = DEFAULT_QUOTE_INTERVAL;
    this.multiQuoteCooldownIdleMs = MULTI_QUOTE_COOLDOWN_IDLE_MS;
    this.multiQuoteCooldownActiveMs = MULTI_QUOTE_COOLDOWN_ACTIVE_MS;
    this.healthPingHealthyMs = config.instanceHealth?.pingHealthyIntervalMs || 5 * 60 * 1000;
    this.healthPingUnhealthyMs = config.instanceHealth?.pingUnhealthyIntervalMs || 3 * 60 * 1000;
    this.healthPingUnhealthyMaxAttempts = config.instanceHealth?.pingUnhealthyMaxAttempts || 5;
    this.orderbookCache = new Map();
    this.orderbookRefreshTimestamps = new Map();
    this.tradebookCache = new Map();
    this.tradebookRefreshTimestamps = new Map();
    // Fallback entry prices captured at order placement (key: instanceId|exchange|symbol)
    this.entryPriceCache = new Map();
    // Track last persisted quote hashes to avoid noisy writes
    this.quoteSnapshotHashes = new Map();
    this.quoteSnapshotTableMissing = false;

    // Unified symbol quote cache (consolidated from separate SYMBOL_QUOTE_TTL_MS)
    // TTL is now configurable per-call via ttlMs parameter
    this.symbolQuoteCache = new Map(); // key: EXCHANGE|SYMBOL -> { quote, fetchedAt }
    this.multiQuoteTimestamps = new Map();
    this._sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    this.lastGlobalSymbolList = [];

    // Track whether there are open positions for dynamic refresh interval
    this.hasOpenPositions = false;
    this.openPositionInstances = new Set();
    this.instanceHealth = new Map(); // id -> { healthy: boolean, lastPing: number, nextPing: number, notified: boolean }
    this.healthPingIntervalHandle = null;
    this.positionIntervalHandle = null;
  }

  async start(options = {}) {
    if (this.isRunning) return;
    this.isRunning = true;

    this.applyConfig(options.configOverride || config);
    if (options.quoteInterval) {
      this.quoteIntervalMs = options.quoteInterval;
    }
    if (options.fundsInterval) {
      this.fundsIntervalMs = options.fundsInterval;
    }

    // Warm in-memory cache from persisted snapshots before live refreshes
    await this._hydrateQuoteSnapshotsFromDb();

    // Start WS quotes (best-effort; falls back to HTTP polling)
    await this._startWsQuotes();
    openalgoWsService.on('quote', ({ instanceId, quote }) => {
      try {
        this.setQuoteSnapshot(instanceId, [quote]);
      } catch (err) {
        log.warn('Failed to cache WS quote', { error: err.message });
      }
    });

    // Fire-and-forget warmup to avoid blocking startup
    setTimeout(() => this.refreshQuotes({ force: true }).catch(() => {}), 0);
    setTimeout(() => this.refreshPositions({ force: true }).catch(() => {}), FEED_STAGGER_MS);
    setTimeout(() => this.refreshFunds({ force: true }).catch(() => {}), FEED_STAGGER_MS * 2);

    // Quotes interval
    this.intervals.push(setInterval(() => this.refreshQuotes(), this.quoteIntervalMs));
    // Position refresh uses dynamic interval based on open positions
    this._startDynamicPositionRefresh(FEED_STAGGER_MS);
    // Funds interval (already slow)
    this.intervals.push(setInterval(() => this.refreshFunds(), this.fundsIntervalMs));
    // Health pings (5m healthy, 3m unhealthy with retry cap)
    this.healthPingIntervalHandle = setInterval(() => this._pingInstancesHeartbeat(), 30000);

    log.info('MarketDataFeedService started', {
      quoteInterval: this.quoteIntervalMs,
      positionIntervalIdle: this.positionIntervalIdleMs,
      positionIntervalActive: this.positionIntervalActiveMs,
      fundsInterval: this.fundsIntervalMs,
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
    if (this.healthPingIntervalHandle) {
      clearInterval(this.healthPingIntervalHandle);
      this.healthPingIntervalHandle = null;
    }
    this.multiQuoteTimestamps.clear();
    this.isRunning = false;
  }

  applyConfig(nextConfig = config) {
    const cfg = nextConfig || config;
    const md = cfg.marketDataFeed || {};

    this.quoteIntervalMs = cfg.polling?.marketDataInterval || DEFAULT_QUOTE_INTERVAL;
    this.fundsIntervalMs = md.fundsIntervalMs || md.fundsTtlMs || DEFAULT_FUNDS_INTERVAL;

    this.quoteTtlIdleMs = md.quoteTtlIdleMs || md.quoteTtlMs || DEFAULT_QUOTE_TTL_IDLE_MS;
    this.quoteTtlActiveMs = md.quoteTtlActiveMs || Math.min(this.quoteTtlIdleMs, DEFAULT_QUOTE_TTL_ACTIVE_MS);
    this.positionIntervalIdleMs = md.positionIntervalIdleMs || md.positionTtlMs || DEFAULT_POSITION_INTERVAL_IDLE;
    this.positionIntervalActiveMs = md.positionIntervalActiveMs || DEFAULT_POSITION_INTERVAL_ACTIVE;
    this.tradebookIntervalIdleMs = md.tradebookIntervalIdleMs || md.tradebookTtlMs || DEFAULT_TRADEBOOK_INTERVAL_IDLE;
    this.tradebookIntervalActiveMs = md.tradebookIntervalActiveMs || DEFAULT_TRADEBOOK_INTERVAL_ACTIVE;
    this.orderbookIntervalMs = md.orderbookIntervalMs || md.orderbookTtlMs || DEFAULT_ORDERBOOK_INTERVAL;

    this.multiQuoteCooldownIdleMs = md.multiquoteCooldownIdleMs || MULTI_QUOTE_COOLDOWN_IDLE_MS;
    this.multiQuoteCooldownActiveMs = md.multiquoteCooldownActiveMs || MULTI_QUOTE_COOLDOWN_ACTIVE_MS;

    this.healthPingHealthyMs = cfg.instanceHealth?.pingHealthyIntervalMs || 5 * 60 * 1000;
    this.healthPingUnhealthyMs = cfg.instanceHealth?.pingUnhealthyIntervalMs || 3 * 60 * 1000;
    this.healthPingUnhealthyMaxAttempts = cfg.instanceHealth?.pingUnhealthyMaxAttempts || 5;

    this.QUOTE_TTL_MS = Math.max(this.quoteTtlIdleMs, TTL_DISPLAY);
    this.QUOTE_TTL_ORDER_MS = TTL_ORDER_CRITICAL;
    this.POSITION_TTL_MS = this.positionIntervalIdleMs;
    this.FUNDS_TTL_MS = this.fundsIntervalMs;
    this.ORDERBOOK_TTL_MS = this.orderbookIntervalMs;
    this.TRADEBOOK_TTL_MS = this.tradebookIntervalIdleMs;

    if (this.isRunning) {
      this._restartIntervals();
    }
  }

  _restartIntervals() {
    this.intervals.forEach(clearInterval);
    this.intervals = [];

    this.intervals.push(setInterval(() => this.refreshQuotes(), this.quoteIntervalMs));
    this.intervals.push(setInterval(() => this.refreshFunds(), this.fundsIntervalMs));

    if (this.healthPingIntervalHandle) {
      clearInterval(this.healthPingIntervalHandle);
      this.healthPingIntervalHandle = null;
    }
    this.healthPingIntervalHandle = setInterval(() => this._pingInstancesHeartbeat(), 30000);

    this._startDynamicPositionRefresh(0);
  }

  async _startWsQuotes() {
    try {
      const instances = await instanceService.getAllInstances({ is_active: true });
      const wsInstances = instances.filter((i) => i.use_ws_quotes);
      if (wsInstances.length === 0) return;
      openalgoWsService.start(wsInstances.map((i) => ({
        id: i.id,
        name: i.name,
        host_url: i.host_url,
        api_key: i.api_key,
        websocket_url: i.websocket_url,
      })));
      // Prime subscriptions immediately with current symbols
      const symbols = await this._buildGlobalSymbolList();
      this.lastGlobalSymbolList = this._dedupeSymbols(symbols);
      openalgoWsService.syncAll(this.lastGlobalSymbolList);
      log.info('OpenAlgo WS quotes started', { instances: wsInstances.length });
    } catch (err) {
      log.warn('OpenAlgo WS quotes init failed', { error: err.message });
    }
  }

  _syncWsSubscriptions() {
    try {
      const symbolList = this._dedupeSymbols(this.lastGlobalSymbolList || []);
      const preferred = this._buildPreferredInstanceMap(symbolList);
      openalgoWsService.syncAll(symbolList, preferred);
    } catch (err) {
      // non-blocking
    }
  }

  /**
   * Quotes (per market-data instance)
   */
  async refreshQuotes({ force = false } = {}) {
    if (isQuoteEndpointBlackout()) {
      return;
    }
    const now = Date.now();
    const targetInterval = this._getQuoteTtlMs();
    if (!force && now - this.lastQuoteRefreshAt < targetInterval) {
      log.debug('Skipping quote refresh - TTL not expired', {
        lastRefreshMs: now - this.lastQuoteRefreshAt,
        ttl: targetInterval,
      });
      return;
    }
    this.lastQuoteRefreshAt = now;

    try {
      const symbolList = this._dedupeSymbols(await this._buildGlobalSymbolList());
      this.lastGlobalSymbolList = symbolList;
      // Sync WS subscriptions (if enabled)
      this._syncWsSubscriptions();

      if (openalgoWsService.hasActiveConnections()) {
        return;
      }

      const marketDataInstances = (await marketDataInstanceService.getPoolForEndpoint('multiquotes'))
        .filter(inst => !this._isInstanceUnhealthy(inst.id));

      if (symbolList.length === 0 || marketDataInstances.length === 0) {
        log.debug('No tracked symbols or no market data instances. Skipping quote refresh.');
        return;
      }

      const supportPool = marketDataInstances.filter(inst => inst.supports_multiquotes && !inst.disable_multiquotes && inst.multiquotes_ok);
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

      // Fallback to multiquotes only; no single-quote fanout for multiple symbols
      if (pendingSymbols.length > 0) {
        const poolForFallback = supportPool.length > 0 ? supportPool.concat(regularPool) : marketDataInstances;
        for (const inst of poolForFallback) {
          if (this._isInstanceUnhealthy(inst.id)) continue;
          const circuitKey = this._getCircuitKey(inst.id, 'quotes');
          if (this._shouldSkipPolling(circuitKey)) {
            continue;
          }
          const maxRetries = 2;
          let lastError = null;

          const symbolsForInst = pendingSymbols.slice(0, MULTI_QUOTE_SYMBOL_LIMIT);
          if (symbolsForInst.length === 0) break;

          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
              const multiResult = await openalgoClient.getMultiQuotes(inst, symbolsForInst, { returnErrors: true });
              const quotes = multiResult?.quotes || [];
              this.setQuoteSnapshot(inst.id, quotes);
              collectedQuotes = collectedQuotes.concat(quotes);
              const resolvedKeys = new Set(quotes.map((q) => `${(q.exchange || '').toUpperCase()}|${(q.symbol || '').toUpperCase()}`));
              pendingSymbols = pendingSymbols.filter((s) => !resolvedKeys.has(`${(s.exchange || '').toUpperCase()}|${(s.symbol || '').toUpperCase()}`));
              this._resetFailureState(circuitKey);
              break;
            } catch (error) {
              lastError = error;
              if (attempt < maxRetries) {
                const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
                await new Promise(resolve => setTimeout(resolve, delay));
              }
            }
          }

          if (lastError) {
            log.warn('Failed multiquotes fallback', { instance: inst.name, error: lastError?.message });
            this._recordFailure(circuitKey, lastError);
          }

          await this._sleep(Math.floor(Math.random() * FEED_STAGGER_MS) + FEED_STAGGER_MS);
          if (pendingSymbols.length === 0) break;
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
    // Persist snapshot asynchronously for warm restarts
    this._persistQuoteSnapshot(instanceId, snapshot.data, snapshot.fetchedAt);
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

    // Determine TTL: orderCritical uses aggressive TTL, otherwise use custom or stateful TTL
    const ttlMs = opts.ttlMs ?? (orderCritical ? this.QUOTE_TTL_ORDER_MS : this._getQuoteTtlMs());

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
   * Retrieve cached quotes with timestamps for symbols if fresh, and return missing symbols
   * @param {Array} symbols - Array of {exchange, symbol}
   * @param {Object} options - Options
   * @param {number} options.ttlMs - Custom TTL in milliseconds (default: QUOTE_TTL_MS for display)
   * @param {boolean} options.orderCritical - Use aggressive TTL for order-critical operations
   * @returns {{ cached: Array<{quote: Object, fetchedAt: number}>, missing: Array }}
   */
  getCachedQuoteEntriesForSymbols(symbols = [], options = {}) {
    const opts = typeof options === 'number' ? { ttlMs: options } : options;
    const { orderCritical = false } = opts;
    const ttlMs = opts.ttlMs ?? (orderCritical ? this.QUOTE_TTL_ORDER_MS : this._getQuoteTtlMs());

    const now = Date.now();
    const cached = [];
    const missing = [];
    symbols.forEach((s) => {
      const key = this._symbolKey(s.exchange, s.symbol);
      const entry = this.symbolQuoteCache.get(key);
      if (entry && entry.fetchedAt && now - entry.fetchedAt <= ttlMs) {
        cached.push({ quote: entry.quote, fetchedAt: entry.fetchedAt });
      } else {
        missing.push(s);
      }
    });
    return { cached, missing };
  }

  _getQuoteTtlMs() {
    return this.hasOpenPositions ? this.quoteTtlActiveMs : this.quoteTtlIdleMs;
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

    if (isQuoteEndpointBlackout()) {
      const { cached } = this.getCachedQuotesForSymbols(unique, { ttlMs, orderCritical });
      return cached;
    }

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
    this._updateOpenPositionState(instanceId, positions);
  }

  async refreshPositionsForInstance(instanceId, { force = false } = {}) {
    try {
      if (isGeneralEndpointBlackout()) {
        return;
      }
      if (this._isInstanceUnhealthy(instanceId)) {
        log.warn('Skipping positions refresh - instance unhealthy', { instanceId });
        return;
      }
      const circuitKey = this._getCircuitKey(instanceId, 'positions');
      if (this._shouldSkipPolling(circuitKey)) {
        return;
      }
      const now = Date.now();
      const last = this.positionRefreshTimestamps.get(instanceId) || 0;
      const ttlMs = this._getStatefulTtlMs('positions', instanceId);
      if (!force && now - last < ttlMs) {
        log.debug('Skipping position refresh (TTL)', { instanceId, elapsedMs: now - last, ttlMs });
        return;
      }
      this.positionRefreshTimestamps.set(instanceId, now);
      const instance = await instanceService.getInstanceById(instanceId);
      const positionBook = await openalgoClient.getPositionBook(instance);
      this._seedFallbackEntriesFromPositionBook(instanceId, positionBook);
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
    this.openPositionInstances.delete(instanceId);
    this.hasOpenPositions = this.openPositionInstances.size > 0;
    if (refresh) {
      await this.refreshPositionsForInstance(instanceId, { force: true });
    }
  }

  // Fallback entry price helpers
  setFallbackEntryPrice(instanceId, exchange, symbol, price, source = 'unknown', meta = {}) {
    if (!instanceId || !exchange || !symbol || !price || price <= 0) return;
    const key = `${instanceId}|${exchange.toUpperCase()}|${symbol.toUpperCase()}`;
    this.entryPriceCache.set(key, { price, source, capturedAt: Date.now(), ...meta });
  }

  getFallbackEntryPrice(instanceId, exchange, symbol) {
    if (!instanceId || !exchange || !symbol) return null;
    const key = `${instanceId}|${exchange.toUpperCase()}|${symbol.toUpperCase()}`;
    return this.entryPriceCache.get(key) || null;
  }

  clearFallbackEntryPrice(instanceId, exchange, symbol) {
    if (!instanceId || !exchange || !symbol) return;
    const key = `${instanceId}|${exchange.toUpperCase()}|${symbol.toUpperCase()}`;
    this.entryPriceCache.delete(key);
  }

  /**
   * Populate fallback entry prices for new/external positions when broker does not return avg price
   * or returns dummy values (e.g., 0, 100). Uses best-effort LTP from position data or quote cache.
   */
  _seedFallbackEntriesFromPositionBook(instanceId, positionBook = []) {
    if (!Array.isArray(positionBook) || positionBook.length === 0) return;

    positionBook.forEach((pos) => {
      const qty =
        pos.quantity ??
        pos.netqty ??
        pos.net_quantity ??
        pos.netQty ??
        pos.net ??
        0;
      if (!qty || Number(qty) === 0) return;

      const exchange = pos.exchange || pos.exch || pos.brexchange;
      const symbol = pos.symbol || pos.tradingsymbol || pos.trading_symbol;
      if (!exchange || !symbol) return;

      const currentEntry = extractAveragePrice(pos);
      const fallbackExisting = this.getFallbackEntryPrice(instanceId, exchange, symbol);
      if (currentEntry && !this._isDummyEntryPrice(currentEntry)) {
        // Do not override valid broker-provided entry
        return;
      }
      if (fallbackExisting?.price && fallbackExisting.price > 0) {
        // Already seeded; keep existing
        return;
      }

      // Resolve LTP from position or cached quotes
      let ltp = extractLtp(pos);
      if (!ltp || ltp <= 0) {
        const { cached } = this.getCachedQuotesForSymbols(
          [{ exchange, symbol }],
          { orderCritical: true }
        );
        if (cached?.length) {
          ltp = extractLtp(cached[0]);
        }
      }
      if (!ltp || ltp <= 0) return;

      this.setFallbackEntryPrice(
        instanceId,
        exchange,
        symbol,
        ltp,
        'positionbook_fallback',
        { confirmed: true }
      );
    });
  }

  _isDummyEntryPrice(value) {
    const num = Number(value);
    if (!isFinite(num)) return true;
    if (num <= 0) return true;
    // Common dummy placeholders observed
    const dummySet = new Set([100, 1, 0.01]);
    return dummySet.has(num);
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
        const ttlMs = this._getStatefulTtlMs('positions', instanceId);
        if (cached && now - last < ttlMs) {
          return { instanceId, positions: cached.data, success: true, fromCache: true };
        }
      }

      // Fetch live
      try {
        if (isGeneralEndpointBlackout()) {
          const cached = this.positionCache.get(instanceId);
          if (cached?.data) {
            return { instanceId, positions: cached.data, success: true, fromCache: true, skipped: true };
          }
          return { instanceId, positions: [], success: false, fromCache: false, skipped: true, error: 'Blackout window' };
        }
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
    if (isGeneralEndpointBlackout()) {
      return;
    }
    if (this._isInstanceUnhealthy(instanceId)) {
      log.warn('Skipping funds refresh - instance unhealthy', { instanceId });
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
      // Include explicit trading_symbol if provided (e.g., resolved options/futures)
      trackedSymbols.forEach((symbol) => {
        if (symbol.trading_symbol && symbol.trading_symbol !== symbol.symbol) {
          symbolList.push({
            exchange: symbol.exchange,
            symbol: symbol.trading_symbol,
          });
        }
      });

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
    const ttlMs = this._getStatefulTtlMs('orderbook', instanceId);

    if (ttlMs === Number.POSITIVE_INFINITY) {
      return cache || null;
    }
    if (isGeneralEndpointBlackout()) {
      return cache || null;
    }
    if (this._isInstanceUnhealthy(instanceId)) {
      log.warn('Skipping orderbook refresh - instance unhealthy', { instanceId });
      return cache || null;
    }

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
    const ttlMs = this._getStatefulTtlMs('tradebook', instanceId);

    if (ttlMs === Number.POSITIVE_INFINITY) {
      return cache || null;
    }
    if (isGeneralEndpointBlackout()) {
      return cache || null;
    }
    if (this._isInstanceUnhealthy(instanceId)) {
      log.warn('Skipping tradebook refresh - instance unhealthy', { instanceId });
      return cache || null;
    }

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

  _isInstanceUnhealthy(instanceId) {
    const state = this.instanceHealth.get(instanceId);
    return state?.healthy === false || state?.requiresManualRefresh === true;
  }

  async _pingInstancesHeartbeat() {
    try {
      if (isGeneralEndpointBlackout()) {
        return;
      }
      const instances = await instanceService.getAllInstances({ is_active: true });
      const now = Date.now();
      for (const inst of instances) {
        const state = this.instanceHealth.get(inst.id) || {
          healthy: true,
          lastPing: 0,
          nextPing: 0,
          notified: false,
          unhealthyAttempts: 0,
          requiresManualRefresh: false,
        };
        if (state.requiresManualRefresh) {
          this.instanceHealth.set(inst.id, state);
          continue;
        }
        if (state.healthy === false && state.unhealthyAttempts >= this.healthPingUnhealthyMaxAttempts) {
          this.instanceHealth.set(inst.id, { ...state, requiresManualRefresh: true });
          continue;
        }
        const interval = state.healthy !== false ? this.healthPingHealthyMs : this.healthPingUnhealthyMs;
        if (now >= state.nextPing || now - state.lastPing >= interval) {
          await this._maybePingInstance(inst);
        }
      }
    } catch (error) {
      log.warn('Health ping heartbeat failed', { error: error.message });
    }
  }

  async _maybePingInstance(instance) {
    const id = instance.id;
    const state = this.instanceHealth.get(id) || { healthy: true, lastPing: 0, nextPing: 0, notified: false };
    try {
      await openalgoClient.ping(instance);
      this._markInstanceHealthy(id);
    } catch (error) {
      this._markInstanceUnhealthy(id, error?.message);
    }
  }

  _markInstanceHealthy(instanceId) {
    this.instanceHealth.set(instanceId, {
      healthy: true,
      lastPing: Date.now(),
      nextPing: Date.now() + this.healthPingHealthyMs,
      notified: false,
      unhealthyAttempts: 0,
      requiresManualRefresh: false,
    });
  }

  async _markInstanceUnhealthy(instanceId, reason = null) {
    const prev = this.instanceHealth.get(instanceId) || {};
    const attempts = (prev.unhealthyAttempts || 0) + 1;
    const requiresManualRefresh = attempts >= this.healthPingUnhealthyMaxAttempts;
    this.instanceHealth.set(instanceId, {
      healthy: false,
      lastPing: Date.now(),
      nextPing: requiresManualRefresh ? null : Date.now() + this.healthPingUnhealthyMs,
      notified: prev.notified || false,
      unhealthyAttempts: attempts,
      requiresManualRefresh,
    });

    if (this.openPositionInstances.has(instanceId) && !prev.notified) {
      try {
        await db.run(
          `INSERT INTO notifications (title, body, severity) VALUES (?, ?, ?)`,
          ['Instance unhealthy', `Instance ${instanceId} became unhealthy while positions are open.`, 'error']
        );
        this.instanceHealth.set(instanceId, {
          healthy: false,
          lastPing: Date.now(),
          nextPing: requiresManualRefresh ? null : Date.now() + this.healthPingUnhealthyMs,
          notified: true,
          unhealthyAttempts: attempts,
          requiresManualRefresh,
        });
      } catch (err) {
        log.warn('Failed to notify unhealthy instance', { instanceId, error: err.message });
      }
    }
  }

  resetInstanceHealth(instanceId) {
    this.instanceHealth.delete(instanceId);
  }

  getCircuitState(instanceId, feed) {
    const key = this._getCircuitKey(instanceId, feed);
    const state = this.failureState.get(key);
    if (!state || !state.cooldownUntil) {
      return { open: false, resumeInMs: null, lastError: null };
    }

    const remaining = state.cooldownUntil - Date.now();
    return {
      open: remaining > 0,
      resumeInMs: remaining > 0 ? remaining : null,
      lastError: state.lastErrorMessage || null,
    };
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

      const cooldown = this.hasOpenPositions ? this.multiQuoteCooldownActiveMs : this.multiQuoteCooldownIdleMs;
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

    const supportsMulti = Boolean(instance.supports_multiquotes);
    const now = Date.now();

    if (normalizedSymbols.length > 1) {
      if (!supportsMulti) {
        log.warn('Skipping multi-symbol quote fetch on instance without multiquotes support', { instance_id: instance.id });
        return [];
      }
      const cooldown = this.hasOpenPositions ? this.multiQuoteCooldownActiveMs : this.multiQuoteCooldownIdleMs;
      const lastMultiAt = this.multiQuoteTimestamps.get(instance.id) || 0;
      if (now - lastMultiAt < cooldown) {
        log.debug('Skipping MultiQuotes fetch due to cooldown', {
          instance_id: instance.id,
          elapsedMs: now - lastMultiAt,
          cooldownMs: cooldown,
        });
        return [];
      }
      const multiQuotes = await openalgoClient.getMultiQuotes(instance, normalizedSymbols);
      this.multiQuoteTimestamps.set(instance.id, now);
      return multiQuotes;
    }

    // Single-symbol fetch; allowed path for order placement usage
    if (supportsMulti) {
      try {
        const mq = await openalgoClient.getMultiQuotes(instance, normalizedSymbols);
        this.multiQuoteTimestamps.set(instance.id, now);
        return mq;
      } catch (error) {
        log.warn('Single-symbol multiquote failed, falling back to quote', { instance_id: instance.id, error: error.message });
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

  /**
   * Prefer instances that recently provided a non-zero LTP for a symbol.
   */
  _buildPreferredInstanceMap(symbols = []) {
    const preferred = new Map(); // key -> instanceId
    const now = Date.now();
    this.quoteCache.forEach((snapshot, instanceId) => {
      const data = snapshot?.data || [];
      data.forEach((q) => {
        const ltp = Number(q.ltp ?? q.LastTradedPrice ?? q.last_price ?? q.last);
        if (!ltp || ltp <= 0) return;
        const key = this._symbolKey(q.exchange, q.symbol);
        // prefer freshest
        if (!preferred.has(key) || (snapshot.fetchedAt && snapshot.fetchedAt >= (preferred.get(`${key}_ts`) || 0))) {
          preferred.set(key, instanceId);
          if (snapshot.fetchedAt) {
            preferred.set(`${key}_ts`, snapshot.fetchedAt);
          }
        }
      });
    });

    // Clean timestamp helper keys before return
    const clean = new Map();
    preferred.forEach((val, key) => {
      if (key.endsWith('_ts')) return;
      clean.set(key, val);
    });
    return clean;
  }

  _getStatefulTtlMs(feed, instanceId = null) {
    const hasOpenForInstance = instanceId ? this.openPositionInstances.has(instanceId) : this.hasOpenPositions;
    if (feed === 'positions') {
      return hasOpenForInstance ? this.positionIntervalActiveMs : this.positionIntervalIdleMs;
    }
    if (feed === 'orderbook') {
      return this.orderbookIntervalMs;
    }
    if (feed === 'tradebook') {
      return hasOpenForInstance ? this.tradebookIntervalActiveMs : this.tradebookIntervalIdleMs;
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

    if (isQuoteEndpointBlackout()) {
      throw new Error('Market closed for quotes (02:00-08:45 IST)');
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
   * - 8 seconds when positions are open
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

  _updateOpenPositionState(instanceId, positions = []) {
    const hasOpen = Array.isArray(positions) && positions.some((p) => this._getPositionNetQuantity(p) !== 0);
    if (hasOpen) {
      this.openPositionInstances.add(instanceId);
    } else {
      this.openPositionInstances.delete(instanceId);
    }
    this.hasOpenPositions = this.openPositionInstances.size > 0;
  }

  _hashPayload(payload) {
    return createHash('sha256').update(payload || '').digest('hex');
  }

  async _persistQuoteSnapshot(instanceId, quotes = [], fetchedAt = Date.now()) {
    try {
      if (this.quoteSnapshotTableMissing) {
        return;
      }

      const payload = JSON.stringify(quotes || []);
      const hash = this._hashPayload(payload);
      const last = this.quoteSnapshotHashes.get(instanceId);
      if (last && last.hash === hash && last.fetchedAt === fetchedAt) {
        return;
      }

      const exchangeCount = new Set(
        (quotes || []).map((q) => (q.exchange || q.exch || '').toUpperCase()).filter(Boolean)
      ).size;
      const symbolCount = Array.isArray(quotes) ? quotes.length : 0;

      await db.run(
        `
          INSERT INTO quote_snapshots (
            instance_id, payload, hash, fetched_at, exchange_count, symbol_count, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(instance_id) DO UPDATE SET
            payload=excluded.payload,
            hash=excluded.hash,
            fetched_at=excluded.fetched_at,
            exchange_count=excluded.exchange_count,
            symbol_count=excluded.symbol_count,
            updated_at=CURRENT_TIMESTAMP
        `,
        [instanceId, payload, hash, fetchedAt, exchangeCount, symbolCount]
      );

      this.quoteSnapshotHashes.set(instanceId, { hash, fetchedAt });
    } catch (error) {
      if ((error?.message || '').includes('quote_snapshots')) {
        this.quoteSnapshotTableMissing = true;
      }
      log.warn('Failed to persist quote snapshot', { instanceId, error: error.message });
    }
  }

  async _hydrateQuoteSnapshotsFromDb() {
    try {
      if (this.quoteSnapshotTableMissing) {
        return;
      }
      const rows = await db.all('SELECT instance_id, payload, fetched_at FROM quote_snapshots');
      if (!rows?.length) {
        return;
      }

      for (const row of rows) {
        if (!row?.payload) continue;
        try {
          const parsed = JSON.parse(row.payload);
          const data = Array.isArray(parsed) ? parsed : parsed?.data || [];
          const fetchedAt = row.fetched_at ? Number(row.fetched_at) : Date.now();
          this.setQuoteSnapshot(row.instance_id, data, { fetchedAt, source: 'l2' });
          this.quoteSnapshotHashes.set(row.instance_id, {
            hash: this._hashPayload(row.payload),
            fetchedAt,
          });
        } catch (error) {
          log.warn('Failed to parse quote snapshot payload', {
            instance_id: row.instance_id,
            error: error.message,
          });
        }
      }

      log.info('Quote snapshots hydrated from database', { count: rows.length });
    } catch (error) {
      if ((error?.message || '').includes('quote_snapshots')) {
        this.quoteSnapshotTableMissing = true;
      }
      log.warn('Failed to hydrate quote snapshots', { error: error.message });
    }
  }

  /**
   * Lightweight cache telemetry for monitoring endpoints
   * Returns freshness and circuit state per feed/instance without mutating state
   */
  getCacheStatus() {
    const now = Date.now();
    const feeds = [
      { name: 'quotes', cache: this.quoteCache, ttlMs: this._getQuoteTtlMs() },
      { name: 'positions', cache: this.positionCache, ttlMs: this._getStatefulTtlMs('positions') },
      { name: 'funds', cache: this.fundsCache, ttlMs: this.FUNDS_TTL_MS },
      { name: 'orderbook', cache: this.orderbookCache, ttlMs: this._getStatefulTtlMs('orderbook') },
      { name: 'tradebook', cache: this.tradebookCache, ttlMs: this._getStatefulTtlMs('tradebook') },
    ];

    const entries = [];

    for (const { name, cache, ttlMs } of feeds) {
      for (const [instanceId, snapshot] of cache.entries()) {
        const fetchedAt = snapshot?.fetchedAt || null;
        const ageMs = fetchedAt ? now - fetchedAt : null;
        const circuit = this.getCircuitState(instanceId, name);
        entries.push({
          instanceId,
          feed: name,
          count: Array.isArray(snapshot?.data) ? snapshot.data.length : null,
          fetchedAt,
          ageMs,
          ttlMs,
          stale: ageMs !== null && ttlMs ? ageMs > ttlMs : null,
          circuitOpen: circuit.open,
          circuitResumeInMs: circuit.resumeInMs,
          circuitLastError: circuit.lastError || null,
        });
      }
    }

    // Ensure circuits without cache entries are still surfaced
    for (const [key, state] of this.failureState.entries()) {
      const [instanceId, feed] = key.split(':');
      const alreadyRecorded = entries.some(
        (e) => String(e.instanceId) === instanceId && e.feed === feed
      );
      if (alreadyRecorded) continue;
      const resumeInMs = state.cooldownUntil ? Math.max(0, state.cooldownUntil - now) : null;
      entries.push({
        instanceId: Number.isNaN(Number(instanceId)) ? instanceId : Number(instanceId),
        feed,
        count: null,
        fetchedAt: null,
        ageMs: null,
        ttlMs: null,
        stale: null,
        circuitOpen: resumeInMs !== null,
        circuitResumeInMs: resumeInMs,
        circuitLastError: state.lastErrorMessage || null,
      });
    }

    return {
      generatedAt: now,
      entries,
    };
  }
}

const marketDataFeedService = new MarketDataFeedService();
export default marketDataFeedService;
