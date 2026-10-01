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
import { isCryptoBroker, isCryptoExchange } from '../utils/broker-type.util.js';
import { isContractExpired } from '../utils/underlying.util.js';
import { ValidationError } from '../core/errors.js';
import marketDataInstanceService from './market-data-instance.service.js';
import watchlistService from './watchlist.service.js';
import openalgoClient from '../integrations/openalgo/client.js';
import config from '../core/config.js';
import { log } from '../core/logger.js';
import db from '../core/database.js';
import { extractAveragePrice, extractLtp } from '../utils/price-extraction.js';
import openalgoWsService from './openalgo-ws.service.js';
import marketCalendarService from './market-calendar.service.js';

const DEFAULT_QUOTE_INTERVAL = 5000;               // 5 seconds for quote refresh (WS primary; REST uses TTL)
const DEFAULT_QUOTE_TTL_IDLE_MS = 15000;
const DEFAULT_QUOTE_TTL_ACTIVE_MS = 10000;
const DEFAULT_POSITION_INTERVAL_IDLE = 30000;      // 30 seconds when no open positions
const DEFAULT_POSITION_INTERVAL_ACTIVE = 8000;     // 8 seconds when positions open
const DEFAULT_TRADEBOOK_INTERVAL_IDLE = 30000;
const DEFAULT_TRADEBOOK_INTERVAL_ACTIVE = 8000;
const DEFAULT_ORDERBOOK_INTERVAL = 30000;
// How often REST re-reads orders while the WebSocket order stream is live - a safety net for a
// push lost in transit, not the refresh path. Shared with polling.service.js.
export const ORDER_STREAM_SWEEP_MS = 3 * 60 * 1000;
const DEFAULT_FUNDS_INTERVAL = 3 * 60 * 1000;      // 3 minutes for funds refresh (sequential)

// TTL configurations
const TTL_DISPLAY = 5000;      // 5s TTL for watchlist display (relaxed)
const TTL_ORDER_CRITICAL = 3000; // 3s TTL for order-critical operations (aligned with default)

const MULTI_QUOTE_COOLDOWN_ACTIVE_MS = 10000;
const MULTI_QUOTE_COOLDOWN_IDLE_MS = 15000;
const MULTI_QUOTE_SYMBOL_LIMIT = 50;
const FEED_STAGGER_MS = 2000;
const WS_SYMBOL_STALE_MS = 10 * 60 * 1000;
const DEFAULT_DEPTH_LEVEL = 5;

/**
 * INT32 overflow markers.
 *
 * Broker feeds relayed through OpenAlgo send 2^31 for numeric fields they have no value for,
 * and prices are scaled by 100, so an unset price arrives as 21474836.48. Observed live on
 * NSE_INDEX NIFTY, whose quote carried open/high/low of 21474836.48 and a volume of exactly
 * 2^31. Passed through, those become a 21-million-rupee candle and a volume baseline that
 * poisons every delta computed from it.
 */
const INT32_SENTINEL = 2 ** 31;
const INT32_SENTINEL_PRICE = INT32_SENTINEL / 100;
const isSentinelValue = (n) => n === INT32_SENTINEL || n === INT32_SENTINEL_PRICE;

const QUOTE_PRICE_FIELDS = ['ltp', 'open', 'high', 'low', 'close', 'prev_close', 'bid', 'ask'];

/**
 * Strip unusable fields from an incoming quote, or return null when nothing is left worth
 * caching. Fields are dropped rather than zeroed: a missing high is honest, a high of 0 is a
 * price that never traded.
 */
export function sanitiseQuote(quote) {
  if (!quote || typeof quote !== 'object') return null;
  const clean = { ...quote };

  for (const field of QUOTE_PRICE_FIELDS) {
    const value = Number(clean[field]);
    if (Number.isFinite(value) && isSentinelValue(value)) delete clean[field];
  }
  const volume = Number(clean.volume);
  if (Number.isFinite(volume) && isSentinelValue(volume)) delete clean.volume;

  // Without a last price there is nothing a quote is good for downstream.
  const ltp = Number(clean.ltp);
  if (!Number.isFinite(ltp) || ltp <= 0) return null;
  return clean;
}

class MarketDataFeedService extends EventEmitter {
  constructor() {
    super();
    this.instrumentTokens = new Map(); // 'EXCH|SYMBOL' -> cached instrument token (or null)
    this.quoteCache = new Map();      // key: instanceId -> { data, fetchedAt }
    this.positionCache = new Map();
    this.fundsCache = new Map();
    this.intervals = [];
    this.isRunning = false;
    this.lastQuoteRefreshAt = 0;
    this.positionRefreshTimestamps = new Map();
    this.fundsRefreshTimestamps = new Map();

    // Consolidated TTL settings
    this.QUOTE_TTL_MS = DEFAULT_QUOTE_TTL_IDLE_MS;
    this.QUOTE_TTL_ORDER_MS = TTL_ORDER_CRITICAL;
    this.FUNDS_TTL_MS = DEFAULT_FUNDS_INTERVAL;
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
    this.orderbookCache = new Map();
    this.orderbookRefreshTimestamps = new Map();
    this.tradebookCache = new Map();
    this.tradebookRefreshTimestamps = new Map();
    this.openOrderInstances = new Set();
    this.hasOpenOrders = false;
    // Fallback entry prices captured at order placement (key: instanceId|exchange|symbol)
    this.entryPriceCache = new Map();

    // Unified symbol quote cache (consolidated from separate SYMBOL_QUOTE_TTL_MS)
    // TTL is now configurable per-call via ttlMs parameter
    this.symbolQuoteCache = new Map(); // key: EXCHANGE|SYMBOL -> { quote, fetchedAt }
    this.multiQuoteTimestamps = new Map();
    this._sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    this.lastGlobalSymbolList = [];
    this.wsRoundRobinCursor = new Map(); // key: EXCHANGE|SYMBOL -> next index
    this.wsQuoteRecency = new Map(); // key: instanceId|EXCHANGE|SYMBOL -> fetchedAt
    this.depthCache = new Map(); // key: EXCHANGE|SYMBOL -> { depth, fetchedAt, instanceId, source }
    this.symbolWsFingerprint = new Map(); // key -> fingerprint
    this.symbolWsLastChangeAt = new Map(); // key -> ts
    this.symbolWsLastUpdateAt = new Map(); // key -> ts
    this.symbolRefreshPausedUntil = new Map(); // key -> ts

    // Track whether there are open positions for dynamic refresh interval
    this.hasOpenPositions = false;
    this.openPositionInstances = new Set();
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

    // Start WS quotes (best-effort; falls back to HTTP polling)
    await this._startWsQuotes();
    openalgoWsService.on('quote', async ({ instanceId, quote }) => {
      try {
        const clean = sanitiseQuote(quote);
        if (!clean) {
          // Nothing usable in the packet. Caching it would serve a fabricated price to the
          // chart, the watchlist and the order preview alike.
          return;
        }
        if (!(await this._frameIsForItsLabel(instanceId, clean))) return;
        const enriched = {
          ...clean,
          _source_instance_id: instanceId,
          _source: 'ws',
        };
        this.setQuoteSnapshot(instanceId, [enriched]);
      } catch (err) {
        log.warn('Failed to cache WS quote', { error: err.message });
      }
    });
    openalgoWsService.on('depth', async ({ instanceId, depth }) => {
      try {
        if (!(await this._frameIsForItsLabel(instanceId, depth))) return;
        const enriched = {
          ...depth,
          _source_instance_id: instanceId,
          _source: 'ws_depth',
        };
        this.setDepthSnapshot(enriched.exchange, enriched.symbol, enriched, {
          instanceId,
          source: 'ws',
        });
      } catch (err) {
        log.warn('Failed to cache WS depth', { error: err.message });
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
    this.multiQuoteTimestamps.clear();
    this.isRunning = false;
  }

  applyConfig(nextConfig = config) {
    const cfg = nextConfig || config;
    const md = cfg.marketDataFeed || {};

    this.quoteIntervalMs = cfg.polling?.marketDataInterval || DEFAULT_QUOTE_INTERVAL;
    this.fundsIntervalMs = md.fundsIntervalMs || DEFAULT_FUNDS_INTERVAL;

    this.quoteTtlIdleMs = md.quoteTtlIdleMs || DEFAULT_QUOTE_TTL_IDLE_MS;
    this.quoteTtlActiveMs = md.quoteTtlActiveMs || Math.min(this.quoteTtlIdleMs, DEFAULT_QUOTE_TTL_ACTIVE_MS);
    this.positionIntervalIdleMs = md.positionIntervalIdleMs || DEFAULT_POSITION_INTERVAL_IDLE;
    this.positionIntervalActiveMs = md.positionIntervalActiveMs || DEFAULT_POSITION_INTERVAL_ACTIVE;
    this.tradebookIntervalIdleMs = md.tradebookIntervalIdleMs || DEFAULT_TRADEBOOK_INTERVAL_IDLE;
    this.tradebookIntervalActiveMs = md.tradebookIntervalActiveMs || DEFAULT_TRADEBOOK_INTERVAL_ACTIVE;
    this.orderbookIntervalMs = md.orderbookIntervalMs || DEFAULT_ORDERBOOK_INTERVAL;

    this.multiQuoteCooldownIdleMs = md.multiquoteCooldownIdleMs || MULTI_QUOTE_COOLDOWN_IDLE_MS;
    this.multiQuoteCooldownActiveMs = md.multiquoteCooldownActiveMs || MULTI_QUOTE_COOLDOWN_ACTIVE_MS;

    this.QUOTE_TTL_MS = Math.max(this.quoteTtlIdleMs, TTL_DISPLAY);
    this.QUOTE_TTL_ORDER_MS = TTL_ORDER_CRITICAL;
    this.FUNDS_TTL_MS = this.fundsIntervalMs;

    if (this.isRunning) {
      this._restartIntervals();
    }
  }

  _restartIntervals() {
    this.intervals.forEach(clearInterval);
    this.intervals = [];

    this.intervals.push(setInterval(() => this.refreshQuotes(), this.quoteIntervalMs));
    this.intervals.push(setInterval(() => this.refreshFunds(), this.fundsIntervalMs));

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
        // Needed so a symbol is only ever round-robined onto a connection whose broker can
        // actually serve its exchange - see the note on syncAll's compatibility filter.
        broker: i.broker,
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

      if (symbolList.length === 0) {
        log.debug('No tracked symbols. Skipping quote refresh.');
        return;
      }

      const { missing } = this.getCachedQuotesForSymbols(symbolList, { orderCritical: false });
      if (openalgoWsService.hasActiveConnections() && missing.length === 0) {
        return;
      }

      const marketDataInstances = (await marketDataInstanceService.getPoolForEndpoint('multiquotes'))
        .filter(inst => !this._isInstanceUnhealthy(inst.id));

      if (marketDataInstances.length === 0) {
        log.debug('No market data instances available. Skipping quote refresh.');
        return;
      }

      const supportPool = marketDataInstances.filter(inst => inst.supports_multiquotes && !inst.disable_multiquotes && inst.multiquotes_ok);
      const regularPool = marketDataInstances.filter(inst => !inst.supports_multiquotes);

      let pendingSymbols = await this._filterSymbolsByMarketOpen(missing);
      if (pendingSymbols.length === 0) {
        return;
      }
      let collectedQuotes = [];

      if (pendingSymbols.length > 0 && supportPool.length > 0) {
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
          const maxRetries = 2;
          let lastError = null;

          // Only this instance's own segment - an Indian broker asked for a crypto option (or
          // Delta for NIFTY) can only reject it, and each rejection counted against the instance.
          const symbolsForInst = pendingSymbols
            .filter((s) => this._tradesExchange(inst, s.exchange))
            .slice(0, MULTI_QUOTE_SYMBOL_LIMIT);
          if (symbolsForInst.length === 0) continue;

          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
              const multiResult = await openalgoClient.getMultiQuotes(inst, symbolsForInst, { returnErrors: true });
              const quotes = multiResult?.quotes || [];
              this.setQuoteSnapshot(inst.id, quotes);
              collectedQuotes = collectedQuotes.concat(quotes);
              const resolvedKeys = new Set(quotes.map((q) => `${(q.exchange || '').toUpperCase()}|${(q.symbol || '').toUpperCase()}`));
              pendingSymbols = pendingSymbols.filter((s) => !resolvedKeys.has(`${(s.exchange || '').toUpperCase()}|${(s.symbol || '').toUpperCase()}`));
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
      if (q?._source_instance_id) {
        const recencyKey = `${q._source_instance_id}|${key}`;
        this.wsQuoteRecency.set(recencyKey, snapshot.fetchedAt);
      }
      if (q?._source === 'ws' || q?._source_instance_id) {
        this._recordWsSymbolUpdate(q.exchange, q.symbol, this._fingerprintQuote(q), snapshot.fetchedAt);
      }
    });
    this.emit('quotes:update', { instanceId, data: snapshot.data });
  }

  setDepthSnapshot(exchange, symbol, depth, options = {}) {
    const key = this._symbolKey(exchange, symbol);
    if (!key) return;
    const snapshot = {
      depth,
      fetchedAt: options.fetchedAt || Date.now(),
      instanceId: options.instanceId || null,
      source: options.source || null,
    };
    this.depthCache.set(key, snapshot);
    if (depth?._source === 'ws_depth' || options.source === 'ws') {
      const fingerprint = this._fingerprintDepth(depth);
      this._recordWsSymbolUpdate(exchange, symbol, fingerprint, snapshot.fetchedAt);
    }
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

  getCachedDepthEntry(exchange, symbol, ttlMs) {
    const key = this._symbolKey(exchange, symbol);
    if (!key) return null;
    const entry = this.depthCache.get(key);
    if (!entry?.fetchedAt) return null;
    if (ttlMs && Date.now() - entry.fetchedAt > ttlMs) return null;
    return entry;
  }

  /**
   * OpenAlgo reports depth in two DIFFERENT shapes depending on transport, and this function is
   * fed both: the WebSocket push uses `depth.buy[]`/`depth.sell[]`, the REST `/depth` endpoint
   * uses `bids[]`/`asks[]` at the top level. Recognising only the WS shape meant every REST
   * fallback (WS depth unavailable or too slow) silently computed bid=null/ask=null even though
   * the broker returned real numbers - degrading limit-price synthesis to plain-quote pricing
   * for no reason. Both shapes are checked so either source works.
   */
  _extractBestBidAskFromDepth(depth) {
    const buy = depth?.depth?.buy || depth?.buy || depth?.data?.buy
      || depth?.bids || depth?.data?.bids || [];
    const sell = depth?.depth?.sell || depth?.sell || depth?.data?.sell
      || depth?.asks || depth?.data?.asks || [];
    const bid = Number(buy?.[0]?.price ?? 0);
    const ask = Number(sell?.[0]?.price ?? 0);
    return {
      bid: Number.isFinite(bid) && bid > 0 ? bid : null,
      ask: Number.isFinite(ask) && ask > 0 ? ask : null,
    };
  }

  async _waitForWsDepth(exchange, symbol, { retries = 5, delayMs = 200, targetInstanceId = null } = {}) {
    if (!exchange || !symbol) return null;
    const key = this._symbolKey(exchange, symbol);
    const startTs = Date.now();
    for (let attempt = 0; attempt < retries; attempt += 1) {
      const entry = this.depthCache.get(key);
      if (entry && entry.fetchedAt && entry.fetchedAt >= startTs) {
        if (targetInstanceId && entry.instanceId !== targetInstanceId) {
          await this._sleep(delayMs);
          continue;
        }
        return { depth: entry.depth, fetchedAt: entry.fetchedAt, attempts: attempt + 1, instanceId: entry.instanceId };
      }
      await this._sleep(delayMs);
    }
    return null;
  }

  async fetchDepthForSymbol(exchange, symbol, options = {}) {
    if (isContractExpired({ exchange, symbol })) return null; // expired - nothing to ask for
    const {
      depthLevel = DEFAULT_DEPTH_LEVEL,
      staleMs = this.QUOTE_TTL_ORDER_MS,
      wsRetries = 5,
      wsRetryDelayMs = 200,
      maxInstances = 3,
      preferInstanceId = null,
    } = options;

    // The calendar gate saves polling calls; it must not decide an order. On the order path
    // (preferInstanceId set) the broker says whether the market is open - a calendar that failed
    // to load would otherwise refuse every Indian order now that MARKET is not a fallback.
    const exchangeOpen = preferInstanceId || await marketCalendarService.isExchangeOpen(exchange);
    if (!exchangeOpen) {
      const cachedClosed = this.getCachedDepthEntry(exchange, symbol, staleMs);
      if (cachedClosed) {
        const { bid, ask } = this._extractBestBidAskFromDepth(cachedClosed.depth);
        return { ...cachedClosed, bid, ask, source: cachedClosed.source || 'cache_closed' };
      }
      return null;
    }

    // Prefer WS depth when available
    if (openalgoWsService.hasActiveConnections()) {
      const connectedIds = openalgoWsService.getConnectedInstanceIds();
      const symbolKey = this._symbolKey(exchange, symbol);
      const orderedIds = this._orderWsInstancesRoundRobin(
        symbolKey,
        this._preferRecentWsInstances(symbolKey, connectedIds)
      );
      const limit = Math.min(maxInstances, orderedIds.length);
      for (let idx = 0; idx < limit; idx += 1) {
        const instanceId = orderedIds[idx];
        const subscribed = openalgoWsService.subscribeDepth(instanceId, { exchange, symbol }, depthLevel);
        if (!subscribed) continue;
        const wsResult = await this._waitForWsDepth(exchange, symbol, {
          retries: wsRetries,
          delayMs: wsRetryDelayMs,
          targetInstanceId: instanceId,
        });
        if (wsResult?.depth) {
          const { bid, ask } = this._extractBestBidAskFromDepth(wsResult.depth);
          if (bid || ask) {
            return {
              depth: wsResult.depth,
              fetchedAt: wsResult.fetchedAt,
              bid,
              ask,
              source: 'ws',
              instanceId,
            };
          }
        }
      }
    }

    const cached = this.getCachedDepthEntry(exchange, symbol, staleMs);
    if (cached) {
      const { bid, ask } = this._extractBestBidAskFromDepth(cached.depth);
      if (bid || ask) {
        return { ...cached, bid, ask, source: cached.source || 'cache' };
      }
    }

    // REST fallback
    try {
      const pool = await this._depthPoolFor(exchange, preferInstanceId);
      if (pool.length === 0) return null;
      for (const inst of pool) {
        try {
          const depth = await openalgoClient.getDepth(inst, exchange, symbol);
          if (!depth) continue;
          const snapshot = { depth, fetchedAt: Date.now(), instanceId: inst.id, source: 'rest' };
          this.depthCache.set(this._symbolKey(exchange, symbol), snapshot);
          const { bid, ask } = this._extractBestBidAskFromDepth(depth);
          return { ...snapshot, bid, ask };
        } catch (err) {
          log.warn('REST depth fetch failed', { instance: inst.name, error: err.message });
        }
      }
    } catch (err) {
      log.warn('Depth REST fallback failed', { error: err.message });
    }

    return null;
  }

  /**
   * Instances to ask for REST depth, in order: the ordering instance first (it holds the broker
   * session and knows its own symbols), then pool members that trade this exchange at all. The
   * pool mixes crypto and Indian brokers, and asking Delta Exchange for NSE:SBIN is a wasted
   * round trip and a 400 on the order path.
   */
  /**
   * Does this instance's broker trade this exchange at all? The market-data pool mixes Delta
   * Exchange with Indian brokers; asking either for the other's symbols is a guaranteed
   * "Symbol not found" per instance per poll (seen live: Maha asked for CRYPTO:BTCUSDFUT).
   */
  /**
   * Is this WebSocket frame really for the contract it is labelled with?
   *
   * Seen live 2026-09-30 on Fyers: frames labelled NSE_INDEX:NIFTY carried the tokens of NIFTY
   * options (40710 = NIFTY06OCT2622700CE) and the October future (48704). The chart folded them
   * into the index's forming candle, which opened at an option premium - the "low of 0" candles.
   * A frame's `token` is the exchange token, and the instruments cache stores the broker token
   * ending in it (40715 -> ...640715), so a frame is dropped when it carries a token and the
   * labelled symbol's cached token does not end with it. Kotak and Delta send no token: unchecked.
   */
  async _frameIsForItsLabel(instanceId, frame) {
    const token = String(frame?.token ?? '').trim();
    if (!token || !frame?.exchange || !frame?.symbol) return true;
    const key = `${frame.exchange}|${frame.symbol}`.toUpperCase();
    let known = this.instrumentTokens.get(key);
    if (known === undefined) {
      const row = await db.get(
        'SELECT token FROM instruments WHERE UPPER(exchange) = ? AND UPPER(symbol) = ? LIMIT 1',
        [String(frame.exchange).toUpperCase(), String(frame.symbol).toUpperCase()]
      ).catch(() => null);
      known = row?.token ? String(row.token) : null;
      this.instrumentTokens.set(key, known);
    }
    if (!known || known.endsWith(token)) return true;
    const warned = (this._mislabelWarned ||= new Set());
    if (!warned.has(`${key}|${token}`)) {
      warned.add(`${key}|${token}`);
      log.warn('Dropped a WebSocket frame labelled with another contract', {
        instanceId, exchange: frame.exchange, symbol: frame.symbol, reason: `frame token ${token}, ${frame.symbol} is ${known}`,
      });
    }
    return false;
  }

  _tradesExchange(instance, exchange) {
    return isCryptoBroker(instance?.broker) === isCryptoExchange(exchange);
  }

  async _depthPoolFor(exchange, preferInstanceId = null) {
    const crypto = isCryptoExchange(exchange);
    const pool = (await marketDataInstanceService.getMarketDataPool())
      .filter((inst) => this._tradesExchange(inst, exchange));
    if (!preferInstanceId) return pool;
    const preferred = pool.find((inst) => inst.id === preferInstanceId)
      || await instanceService.getInstanceById(preferInstanceId).catch(() => null);
    if (!preferred || isCryptoBroker(preferred.broker) !== crypto) return pool;
    return [preferred, ...pool.filter((inst) => inst.id !== preferred.id)];
  }

  _getQuoteTtlMs() {
    return this.hasOpenPositions ? this.quoteTtlActiveMs : this.quoteTtlIdleMs;
  }

  _fingerprintQuote(quote) {
    const ltp = this._extractLtpFromQuote(quote);
    const bid = Number(quote?.bid ?? quote?.best_bid ?? quote?.bestBid ?? quote?.bp ?? 0);
    const ask = Number(quote?.ask ?? quote?.best_ask ?? quote?.bestAsk ?? quote?.ap ?? 0);
    return `${ltp || 0}|${bid || 0}|${ask || 0}`;
  }

  _fingerprintDepth(depth) {
    if (!depth) return '';
    const buy = depth?.depth?.buy || depth?.buy || depth?.data?.buy || [];
    const sell = depth?.depth?.sell || depth?.sell || depth?.data?.sell || [];
    const bestBid = Number(buy?.[0]?.price ?? 0);
    const bestAsk = Number(sell?.[0]?.price ?? 0);
    return `${bestBid || 0}|${bestAsk || 0}`;
  }

  _recordWsSymbolUpdate(exchange, symbol, fingerprint, timestamp = Date.now()) {
    const key = this._symbolKey(exchange, symbol);
    if (!key) return;
    const prev = this.symbolWsFingerprint.get(key);
    if (!prev || prev !== fingerprint) {
      this.symbolWsFingerprint.set(key, fingerprint);
      this.symbolWsLastChangeAt.set(key, timestamp);
      // Clear any pause if data started changing again
      this.symbolRefreshPausedUntil.delete(key);
    }
    this.symbolWsLastUpdateAt.set(key, timestamp);
  }

  async _getNextSessionOpen(exchange, now = new Date()) {
    try {
      return await marketCalendarService.getNextSessionOpen(exchange, now);
    } catch (err) {
      log.warn('Failed to resolve next session open from calendar', {
        exchange,
        error: err.message,
      });
      return null;
    }
  }

  async _applySymbolRefreshPauses(now = Date.now()) {
    for (const [key, lastChangeAt] of this.symbolWsLastChangeAt.entries()) {
      const lastUpdateAt = this.symbolWsLastUpdateAt.get(key);
      if (!lastUpdateAt) continue;
      if (now - lastChangeAt < WS_SYMBOL_STALE_MS) continue;
      if (this.symbolRefreshPausedUntil.has(key)) continue;

      const [exchange] = key.split('|');
      const pauseUntil = await this._getNextSessionOpen(exchange, new Date(now));
      if (pauseUntil) {
        this.symbolRefreshPausedUntil.set(key, pauseUntil);
        log.info('Paused symbol refresh after prolonged WS staleness', {
          symbol: key,
          pauseUntil,
        });
      }
    }
  }

  _filterPausedSymbols(symbols = []) {
    const now = Date.now();
    return symbols.filter((s) => {
      const key = this._symbolKey(s.exchange, s.symbol);
      if (!key) return false;
      const pausedUntil = this.symbolRefreshPausedUntil.get(key);
      if (!pausedUntil) return true;
      if (now >= pausedUntil) {
        this.symbolRefreshPausedUntil.delete(key);
        return true;
      }
      return false;
    });
  }

  async _filterSymbolsByMarketOpen(symbols = []) {
    try {
      return await marketCalendarService.filterOpenSymbols(symbols);
    } catch (err) {
      log.warn('Market calendar filter failed; returning original symbols', { error: err.message });
      return symbols;
    }
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
    // Order-critical lookups skip the calendar gate for the same reason as fetchDepthForSymbol.
    const openMissing = orderCritical ? missing : await this._filterSymbolsByMarketOpen(missing);

    // Return cached if all symbols are fresh
    if (openMissing.length === 0) {
      log.debug('All quotes served from cache', { count: cached.length });
      return cached;
    }

    const pool = await marketDataInstanceService.getMarketDataPool();
    if (pool.length === 0) {
      log.warn('No market data instances available for ad-hoc quotes fetch');
      return cached; // Return what we have from cache
    }

    const supportPool = pool.filter(inst => inst.supports_multiquotes);
    let fetchedQuotes = [];
    let pendingSymbols = [...openMissing];

    if (supportPool.length > 0) {
      const multiResult = await this._fetchViaMultiQuotes(pendingSymbols, supportPool);
      fetchedQuotes = fetchedQuotes.concat(multiResult.quotes);
      pendingSymbols = multiResult.pendingSymbols;
      if (multiResult.sourceInstanceId && multiResult.quotes.length > 0) {
        this.setQuoteSnapshot(multiResult.sourceInstanceId, multiResult.quotes, { fetchedAt: Date.now() });
      }
    }

    // What multiquotes left over goes only to instances of its own segment - the whole pool used to
    // be tried, so an MCX quote was asked of the crypto broker (and failed there).
    const segments = [
      pendingSymbols.filter((s) => isCryptoExchange(s.exchange)),
      pendingSymbols.filter((s) => !isCryptoExchange(s.exchange)),
    ].filter((group) => group.length > 0);
    for (const group of segments) {
      const segPool = pool.filter((inst) => this._tradesExchange(inst, group[0].exchange));
      if (segPool.length === 0) continue;
      if (useFallback && segPool.length > 1) {
        fetchedQuotes = fetchedQuotes.concat(
          await openalgoClient.getQuotesWithFallback(segPool, group, { maxRetries: 2 })
        );
      } else {
        const batchSize = Math.max(3, Math.min(5, Math.ceil(group.length / Math.max(1, segPool.length))));
        const chunks = this._chunkSymbols(group, batchSize);

        const batchPromises = chunks.map(async (chunk, idx) => {
          const inst = segPool[idx % segPool.length];
          try {
            const quotes = await openalgoClient.getQuotes(inst, chunk, { perSymbol: true });
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
        if (!force && !(await marketCalendarService.isInstanceMarketOpen(inst))) continue;
        const madeLiveCall = await this.refreshPositionsForInstance(inst.id, { force });
        // Per-instance jitter to smooth RPS - only needed when a real broker call happened;
        // idle/cached instances just no-op and shouldn't stall the batch loop.
        if (madeLiveCall) {
          await this._sleep(Math.floor(Math.random() * FEED_STAGGER_MS) + FEED_STAGGER_MS);
        }
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

  /**
   * @returns {Promise<boolean>} true if a live broker call was actually made (used by the batch
   *   loop in refreshPositions() to skip the inter-instance jitter sleep for instances that were
   *   idle/cached and made no network call).
   */
  async refreshPositionsForInstance(instanceId, { force = false } = {}) {
    try {
      if (this._isInstanceUnhealthy(instanceId)) {
        log.debug('Skipping positions refresh - instance unhealthy', { instanceId });
        return false;
      }
      // No "known risk only" gate here: it meant a position the server did not open itself
      // (broker terminal, direct OpenAlgo, another process, opened while the server was down)
      // was never fetched - so auto-exit never saw it and its target/stop never fired. The
      // stateful TTL below already paces idle instances (30s) vs ones with open risk (8s).
      const now = Date.now();
      const last = this.positionRefreshTimestamps.get(instanceId) || 0;
      const ttlMs = this._getStatefulTtlMs('positions', instanceId);
      if (!force && now - last < ttlMs) {
        log.debug('Skipping position refresh (TTL)', { instanceId, elapsedMs: now - last, ttlMs });
        return false;
      }
      this.positionRefreshTimestamps.set(instanceId, now);
      const instance = await instanceService.getInstanceById(instanceId);
      const positionBook = await openalgoClient.getPositionBook(instance);
      this._seedFallbackEntriesFromPositionBook(instanceId, positionBook);
      this.setPositionSnapshot(instanceId, positionBook);
      return true;
    } catch (error) {
      log.warn('Failed to refresh positions for instance', { instanceId, error: error.message });
      return true;
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
        const positionBook = await openalgoClient.getPositionBook(instance);
        this.setPositionSnapshot(instanceId, positionBook);
        this.positionRefreshTimestamps.set(instanceId, now);

        return { instanceId, positions: positionBook, success: true, fromCache: false };
      } catch (error) {
        log.warn('Failed to fetch positions for instance', {
          instanceId,
          instanceName: instance.name,
          error: error.message,
        });

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
        if (!force && !(await marketCalendarService.isInstanceMarketOpen(inst))) continue;
        const madeLiveCall = await this.refreshFundsForInstance(inst.id, { force });
        if (madeLiveCall) {
          await this._sleep(Math.floor(Math.random() * FEED_STAGGER_MS) + FEED_STAGGER_MS);
        }
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

  /**
   * @returns {Promise<boolean>} true if a live broker call was actually made (see
   *   refreshPositionsForInstance for why the batch loop needs this).
   */
  async refreshFundsForInstance(instanceId, { force = false } = {}) {
    // Skip if non-critical polling is paused (LTP operations in progress)
    if (!force && this._isNonCriticalPaused()) {
      log.debug('Skipping funds refresh for instance - non-critical polling paused', { instanceId });
      return false;
    }
    if (this._isInstanceUnhealthy(instanceId)) {
      log.debug('Skipping funds refresh - instance unhealthy', { instanceId });
      return false;
    }

    try {
      const now = Date.now();
      const last = this.fundsRefreshTimestamps.get(instanceId) || 0;
      if (!force && now - last < this.FUNDS_TTL_MS) {
        log.debug('Skipping funds refresh (TTL)', { instanceId, elapsedMs: now - last });
        return false;
      }
      this.fundsRefreshTimestamps.set(instanceId, now);
      const instance = await instanceService.getInstanceById(instanceId);
      const funds = await openalgoClient.getFunds(instance);
      this.setFundsSnapshot(instanceId, funds);
      return true;
    } catch (error) {
      log.warn('Failed to refresh funds for instance', { instanceId, error: error.message });
      return true;
    }
  }


  /**
   * Helpers
   */
  async _buildGlobalSymbolList() {
    try {
      await this._applySymbolRefreshPauses();
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

      // Expired contracts no longer exist - polling them only earns a rejection per instance.
      const liveSymbols = symbolList.filter((s) => !isContractExpired(s));
      const openSymbols = await this._filterSymbolsByMarketOpen(liveSymbols);
      return this._filterPausedSymbols(openSymbols);
    } catch (error) {
      log.warn('Failed to build global symbol list', { error: error.message });
      return [];
    }
  }

  async getOrderbookSnapshot(instanceId, { force = false } = {}) {
    const now = Date.now();
    const last = this.orderbookRefreshTimestamps.get(instanceId);
    const cache = this.orderbookCache.get(instanceId);
    let ttlMs = this._getStatefulTtlMs('orderbook', instanceId);
    // While OpenAlgo pushes this instance's order updates, applyOrderUpdate keeps the cached
    // orderbook current, so REST is only the safety sweep, not the refresh.
    if (cache && openalgoWsService.isOrderStreamLive(instanceId)) {
      ttlMs = Math.max(ttlMs, ORDER_STREAM_SWEEP_MS);
    }

    // A forced refresh (the Orders page Refresh button) always reaches the broker.
    if (!force && this._isInstanceUnhealthy(instanceId)) {
      log.debug('Skipping orderbook refresh - instance unhealthy', { instanceId });
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
      this._updateOpenOrderState(instanceId, orderbook);
      return snapshot;
    } catch (error) {
      log.warn('Failed to refresh orderbook for instance', { instanceId, error: error.message });
      return cache || null;
    }
  }

  /**
   * Fold one pushed `order_update` into the cached orderbook: the matching row is updated in
   * place (or added, for an order placed outside this app), and the open-order state that drives
   * polling cadence is recomputed from the result. With no cached orderbook yet there is nothing
   * to patch; the next read fetches one.
   */
  applyOrderUpdate(instanceId, order) {
    const cache = this.orderbookCache.get(instanceId);
    if (!cache || !order?.orderid) return;
    const list = Array.isArray(cache.data) ? cache.data : cache.data?.orders || cache.data?.data;
    if (!Array.isArray(list)) return;
    const { type: _type, user_id: _user, mode: _mode, broker: _broker, ...fields } = order;
    const idx = list.findIndex((row) => String(row.orderid ?? row.order_id) === String(order.orderid));
    if (idx >= 0) list[idx] = { ...list[idx], ...fields };
    else list.push(fields);
    cache.fetchedAt = Date.now();
    this._updateOpenOrderState(instanceId, list);
  }


  async getTradebookSnapshot(instanceId, { force = false } = {}) {
    const now = Date.now();
    const last = this.tradebookRefreshTimestamps.get(instanceId);
    const cache = this.tradebookCache.get(instanceId);
    const ttlMs = this._getStatefulTtlMs('tradebook', instanceId);

    if (ttlMs === Number.POSITIVE_INFINITY) {
      return cache || null;
    }
    if (this._isInstanceUnhealthy(instanceId)) {
      log.debug('Skipping tradebook refresh - instance unhealthy', { instanceId });
      return cache || null;
    }

    if (!force && cache && last && now - last < ttlMs) {
      return cache;
    }
    if (!force && !this._hasActiveRisk(instanceId)) {
      return cache || null;
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


  getTradebookSnapshotCached(instanceId) {
    return this.tradebookCache.get(instanceId) || null;
  }

  /**
   * The client's instance-health-tracker is the one place that decides whether an instance may be
   * called (circuit breaker, fed by every call including the health ping). The feed only asks.
   */
  _isInstanceUnhealthy(instanceId) {
    return !openalgoClient.isInstanceHealthy(instanceId);
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

      const mine = pendingSymbols.filter((sym) => this._tradesExchange(inst, sym.exchange));
      if (mine.length === 0) continue;

      try {
        const { quotes, failed } = await openalgoClient.getMultiQuotes(inst, mine, { returnErrors: true });
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
      }
    }

    return { quotes: collected, pendingSymbols, sourceInstanceId };
  }


  _symbolKey(exchange = '', symbol = '') {
    return `${(exchange || '').toUpperCase()}|${(symbol || '').toUpperCase()}`;
  }

  _dedupeSymbols(symbols = []) {
    const seen = new Set();
    const result = [];
    symbols.forEach((s) => {
      if (isContractExpired(s)) return; // expired - nothing to quote
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
    const requested = new Set(symbols.map((symbol) => this._symbolKey(symbol.exchange, symbol.symbol)));
    this.quoteCache.forEach((snapshot, instanceId) => {
      const data = snapshot?.data || [];
      data.forEach((q) => {
        const ltp = Number(q.ltp ?? q.LastTradedPrice ?? q.last_price ?? q.last);
        if (!ltp || ltp <= 0) return;
        const key = this._symbolKey(q.exchange, q.symbol);
        if (requested.size > 0 && !requested.has(key)) return;
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
    const hasOrdersForInstance = instanceId ? this.openOrderInstances.has(instanceId) : this.hasOpenOrders;
    if (feed === 'positions') {
      const active = hasOpenForInstance || hasOrdersForInstance;
      return active ? this.positionIntervalActiveMs : this.positionIntervalIdleMs;
    }
    if (feed === 'orderbook') {
      // Idle instances refresh at the idle position pace. This used to be "never" (Infinity):
      // the book was only fetched once the feed already knew of open orders - which it can only
      // learn from the book - so the Orders page showed 0 orders on accounts with hundreds.
      return hasOrdersForInstance ? this.orderbookIntervalMs : this.positionIntervalIdleMs;
    }
    if (feed === 'tradebook') {
      const active = hasOpenForInstance || hasOrdersForInstance;
      return active ? this.tradebookIntervalActiveMs : this.tradebookIntervalIdleMs;
    }
    return this.QUOTE_TTL_MS;
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
      this.positionRefreshTimestamps.delete(instanceId);
      if (refresh) {
        // The old book stays until the new one replaces it. Deleting it first left readers an
        // empty answer for as long as the broker took (or for good, with the instance paused):
        // the chart showed an open position vanish the moment an order was placed.
        invalidationPromises.push(this.refreshPositionsForInstance(instanceId, { force: true }));
      } else {
        this.positionCache.delete(instanceId);
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
    // An expired contract no longer exists: fail at once rather than burn retries on it.
    if (isContractExpired({ exchange, symbol })) {
      throw new ValidationError(`${exchange}:${symbol} has expired - it has no LTP`);
    }
    const {
      maxRounds = 2,
      bypassCache = false,
      wsRetries = 5,
      wsRetryDelayMs = 200,
    } = options;

    const exchangeOpen = await marketCalendarService.isExchangeOpen(exchange);
    if (!exchangeOpen) {
      if (!bypassCache) {
        const { cached } = this.getCachedQuotesForSymbols(
          [{ exchange, symbol }],
          { orderCritical: true }
        );
        if (cached.length > 0) {
          const quote = cached[0];
          const ltp = this._extractLtpFromQuote(quote);
          if (ltp && ltp > 0) {
            return { ltp, quote, source: 'cache_closed', attempts: 0 };
          }
        }
      }

      // No live/cached tick available while the market is closed - fall back to the broker's
      // last snapshot (close/prev_close), which quote endpoints typically still serve outside
      // trading hours. This is only ever used as a REFERENCE price for strike/ATM selection when
      // previewing or resolving legs outside market hours - it never sets an actual order price,
      // and a real order attempt is still subject to the broker's own closed-market rejection.
      try {
        const pool = (await marketDataInstanceService.getMarketDataPool())
          .filter((inst) => this._tradesExchange(inst, exchange));
        if (pool.length > 0) {
          const closedResult = await openalgoClient.getLtpWithRetry(pool, exchange, symbol, {
            maxRounds: 1,
            baseDelayMs: 50,
          });
          if (closedResult?.ltp > 0) {
            if (closedResult.quote) {
              const key = this._symbolKey(exchange, symbol);
              this.symbolQuoteCache.set(key, { quote: closedResult.quote, fetchedAt: Date.now() });
            }
            return { ...closedResult, source: 'closed_market_snapshot' };
          }
        }
      } catch (fallbackError) {
        log.debug('Closed-market snapshot fallback also failed', { exchange, symbol, error: fallbackError.message });
      }

      throw new Error(`Market closed for ${exchange}:${symbol}`);
    }

    // Prefer WebSocket quotes when available
    if (openalgoWsService.hasActiveConnections()) {
      const connectedIds = openalgoWsService.getConnectedInstanceIds();
      const symbolKey = this._symbolKey(exchange, symbol);
      const orderedIds = this._orderWsInstancesRoundRobin(
        symbolKey,
        this._preferRecentWsInstances(symbolKey, connectedIds)
      );
      const maxInstances = Math.min(5, orderedIds.length);
      for (let idx = 0; idx < maxInstances; idx += 1) {
        const instanceId = orderedIds[idx];
        const subscribed = openalgoWsService.subscribeSymbol(instanceId, { exchange, symbol });
        if (!subscribed) continue;
        const wsResult = await this._waitForWsQuote(exchange, symbol, {
          retries: wsRetries,
          delayMs: wsRetryDelayMs,
          targetInstanceId: instanceId,
        });
        if (wsResult) {
          const ltp = this._extractLtpFromQuote(wsResult.quote);
          if (ltp && ltp > 0) {
            return {
              ltp,
              quote: wsResult.quote,
              source: 'ws',
              attempts: wsResult.attempts,
              instanceId,
            };
          }
        }
      }

      if (!bypassCache) {
        const cachedWs = this._getWsCachedQuote(exchange, symbol);
        if (cachedWs) {
          const ltp = this._extractLtpFromQuote(cachedWs.quote);
          if (ltp && ltp > 0) {
            return { ltp, quote: cachedWs.quote, source: 'ws_cache', attempts: cachedWs.attempts };
          }
        }
      }
    }

    // Check cache next unless bypassed (use order-critical TTL)
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

    // Get market data pool for retry/failover - only instances whose broker trades this exchange
    const pool = (await marketDataInstanceService.getMarketDataPool())
      .filter((inst) => this._tradesExchange(inst, exchange));
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

  _orderWsInstancesRoundRobin(symbolKey, instanceIds = []) {
    if (!symbolKey || instanceIds.length === 0) return instanceIds;
    const cursor = this.wsRoundRobinCursor.get(symbolKey) || 0;
    const size = instanceIds.length;
    const start = cursor % size;
    const ordered = [
      ...instanceIds.slice(start),
      ...instanceIds.slice(0, start),
    ];
    this.wsRoundRobinCursor.set(symbolKey, (start + 1) % size);
    return ordered;
  }

  _preferRecentWsInstances(symbolKey, instanceIds = []) {
    if (!symbolKey || instanceIds.length === 0) return instanceIds;
    const scored = instanceIds.map((id) => ({
      id,
      ts: this.wsQuoteRecency.get(`${id}|${symbolKey}`) || 0,
    }));
    scored.sort((a, b) => b.ts - a.ts);
    return scored.map((item) => item.id);
  }

  _getWsCachedQuote(exchange, symbol) {
    const key = this._symbolKey(exchange, symbol);
    const entry = this.symbolQuoteCache.get(key);
    if (!entry?.quote?._source_instance_id) return null;
    const ttlMs = this.QUOTE_TTL_ORDER_MS;
    if (entry.fetchedAt && Date.now() - entry.fetchedAt <= ttlMs) {
      return { quote: entry.quote, attempts: 0 };
    }
    return null;
  }

  _ensureWsSymbolSubscription(symbols = []) {
    if (!openalgoWsService.hasActiveConnections()) return;
    const next = this._dedupeSymbols([...(this.lastGlobalSymbolList || []), ...symbols]);
    this.lastGlobalSymbolList = next;
    const preferred = this._buildPreferredInstanceMap(next);
    openalgoWsService.syncAll(next, preferred);
  }

  /**
   * Public entry point for a caller that just resolved one symbol it wants live data for (a
   * chart being opened, a symbol/timeframe switch) and needs it in the broker-side WS
   * subscription set NOW, rather than waiting on the incidental REST-polling side effect that
   * used to be the only path in (see the doc comment on `_ensureWsSymbolSubscription` above -
   * that method already did the right thing, it just had no caller). A no-op when WS has no
   * active connections yet - `refreshQuotes()`'s own periodic sync will pick the symbol up once
   * a connection exists, same as any other symbol.
   */
  ensureSymbolSubscribed(exchange, symbol) {
    if (!exchange || !symbol) return;
    this._ensureWsSymbolSubscription([{ exchange, symbol }]);
  }

  async _waitForWsQuote(exchange, symbol, { retries = 5, delayMs = 200, targetInstanceId = null } = {}) {
    if (!exchange || !symbol) return null;
    const key = this._symbolKey(exchange, symbol);
    const startTs = Date.now();
    for (let attempt = 0; attempt < retries; attempt += 1) {
      const entry = this.symbolQuoteCache.get(key);
      if (entry && entry.fetchedAt && entry.fetchedAt >= startTs) {
        if (targetInstanceId && entry.quote?._source_instance_id !== targetInstanceId) {
          await this._sleep(delayMs);
          continue;
        }
        return { quote: entry.quote, attempts: attempt + 1 };
      }
      await this._sleep(delayMs);
    }
    return null;
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
    const initialInterval = this._hasActiveRisk()
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
        const hadActiveRisk = this._hasActiveRisk();
        this.hasOpenPositions = this._detectOpenPositions();

        // Log interval change if position state changed
        const hasActiveRisk = this._hasActiveRisk();
        if (hadActiveRisk !== hasActiveRisk) {
          const newInterval = hasActiveRisk
            ? DEFAULT_POSITION_INTERVAL_ACTIVE
            : DEFAULT_POSITION_INTERVAL_IDLE;
          log.info('Position refresh interval changed', {
            hasOpenPositions: this.hasOpenPositions,
            hasOpenOrders: this.hasOpenOrders,
            newIntervalMs: newInterval,
            reason: hasActiveRisk
              ? 'Open positions/orders detected - switching to active refresh'
              : 'No open positions/orders - switching to idle refresh',
          });
        }

        // Schedule next refresh with appropriate interval
        const nextInterval = this._hasActiveRisk()
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

  _updateOpenOrderState(instanceId, orders = []) {
    const openStatuses = new Set(['open', 'pending', 'trigger_pending', 'partial']);
    const list = Array.isArray(orders) ? orders : orders?.orders || orders?.data || [];
    const hasOpen = Array.isArray(list) && list.some((order) => {
      const statusRaw = (order.order_status || order.status || '').toString().toLowerCase();
      const status = this._normalizeOrderStatus(statusRaw);
      return openStatuses.has(status);
    });

    if (hasOpen) {
      this.openOrderInstances.add(instanceId);
    } else {
      this.openOrderInstances.delete(instanceId);
    }
    this.hasOpenOrders = this.openOrderInstances.size > 0;
  }

  _normalizeOrderStatus(status) {
    if (['complete', 'completed', 'filled'].includes(status)) return 'complete';
    if (['cancelled', 'canceled'].includes(status)) return 'cancelled';
    if (['rejected'].includes(status)) return 'rejected';
    if (['trigger_pending', 'trigger pending'].includes(status)) return 'trigger_pending';
    if (['partial', 'partially_filled', 'partiallyfilled'].includes(status)) return 'partial';
    if (['open', 'pending'].includes(status)) return status;
    return status || 'unknown';
  }

  _hasActiveRisk(instanceId) {
    if (!instanceId) {
      return this.hasOpenPositions || this.hasOpenOrders;
    }
    return this.openPositionInstances.has(instanceId) || this.openOrderInstances.has(instanceId);
  }

  _circuitState(instanceId) {
    const status = openalgoClient.getInstanceHealthStatus(instanceId);
    const resumeInMs = openalgoClient.getInstanceCooldownRemaining(instanceId);
    return { open: resumeInMs > 0, resumeInMs: resumeInMs || null, lastError: status?.lastError || null };
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
        const circuit = this._circuitState(instanceId);
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

    // Instances whose circuit is open but that have no cache entry are still surfaced
    for (const open of openalgoClient.getOpenCircuits()) {
      if (entries.some((e) => String(e.instanceId) === String(open.instanceId))) continue;
      entries.push({
        instanceId: open.instanceId,
        feed: 'instance',
        count: null,
        fetchedAt: null,
        ageMs: null,
        ttlMs: null,
        stale: null,
        circuitOpen: true,
        circuitResumeInMs: open.resumeInMs,
        circuitLastError: open.lastError,
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
