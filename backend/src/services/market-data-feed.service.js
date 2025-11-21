/**
 * Market Data Feed Service
 * Centralized polling + cache for OpenAlgo feeds (quotes, positions, orders, funds, etc.)
 * Step 2 of rate-limit mitigation: consolidate traffic so multiple dashboard users don't duplicate calls.
 */

import EventEmitter from 'events';
import instanceService from './instance.service.js';
import marketDataInstanceService from './market-data-instance.service.js';
import watchlistService from './watchlist.service.js';
import openalgoClient from '../integrations/openalgo/client.js';
import config from '../core/config.js';
import { log } from '../core/logger.js';

const DEFAULT_QUOTE_INTERVAL = 2000;   // 2 seconds
const DEFAULT_POSITION_INTERVAL = 10000; // 10 seconds
const DEFAULT_FUNDS_INTERVAL = 15000;

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
    this.QUOTE_TTL_MS = config.marketDataFeed.quoteTtlMs;
    this.POSITION_TTL_MS = config.marketDataFeed.positionTtlMs;
    this.FUNDS_TTL_MS = config.marketDataFeed.fundsTtlMs;
    this.ORDERBOOK_TTL_MS = config.marketDataFeed.orderbookTtlMs;
    this.TRADEBOOK_TTL_MS = config.marketDataFeed.tradebookTtlMs;
    this.orderbookCache = new Map();
    this.orderbookRefreshTimestamps = new Map();
    this.tradebookCache = new Map();
    this.tradebookRefreshTimestamps = new Map();
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

      const chunks = this._chunkSymbols(symbolList, symbolList.length > 5 ? 5 : symbolList.length);
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
    this.emit('quotes:update', { instanceId, data: snapshot.data });
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
}

const marketDataFeedService = new MarketDataFeedService();
export default marketDataFeedService;
