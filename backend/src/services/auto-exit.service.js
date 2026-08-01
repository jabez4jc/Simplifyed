/**
 * Auto Exit Service
 * Watches positions (internal or external) and triggers exit orders when configured thresholds are met.
 */

import { log } from '../core/logger.js';
import config from '../core/config.js';
import instanceService from './instance.service.js';
import watchlistService from './watchlist.service.js';
import marketDataFeedService from './market-data-feed.service.js';
import quickOrderService from './quick-order.service.js';
import riskControlsService from './risk-controls.service.js';
import riskEventsService from './risk-events.service.js';
import { extractLtp, extractAveragePrice } from '../utils/price-extraction.js';
import { normalizeTradebookEntry } from '../utils/tradebook-utils.js';
import { isGeneralEndpointBlackout } from './instance-health.service.js';
import { normalizeSymbolKey, normalizeExchange } from '../utils/symbol-parsing.util.js';

const TRADE_MODE_MAP = {
  direct: 'EQUITY',
  futures: 'FUTURES',
  options: 'OPTIONS',
};

class AutoExitService {
  constructor() {
    this.isRunning = false;
    this.intervalId = null;
    this.isCycleRunning = false;
    this.pendingExits = new Map();
    this.exitConfirmations = new Map();
    this.lastBlackoutLogAt = 0;
    const autoExitCfg = config.autoExit || {};
    this.monitorIntervalMs = autoExitCfg.monitorIntervalMs || 5000;
    this.provisionalEntryGraceMs = autoExitCfg.provisionalEntryGraceMs ?? 20000;
    this.pendingExitCooldownMs = autoExitCfg.pendingExitCooldownMs ?? 30000;
    const baseWindow = autoExitCfg.confirmationWindowMs && autoExitCfg.confirmationWindowMs > 0
      ? autoExitCfg.confirmationWindowMs
      : Math.max(1500, this.monitorIntervalMs * 1.2);
    // Minimum dwell window before honouring an exit trigger (guards against single-tick spikes)
    this.confirmationWindowMs = baseWindow;
  }

  async start() {
    if (this.isRunning) {
      log.warn('AutoExitService already running');
      return;
    }

    this.isRunning = true;
    await riskControlsService.hydrateFromDb();
    await this.monitorAllPositions();
    this.intervalId = setInterval(
      () => this.monitorAllPositions(),
      this.monitorIntervalMs
    );

    log.info('AutoExitService started', { interval_ms: this.monitorIntervalMs });
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    this.isCycleRunning = false;
    this.pendingExits.clear();
    this.exitConfirmations.clear();
    riskControlsService.reset();
    log.info('AutoExitService stopped');
  }

  async monitorAllPositions() {
    if (this.isCycleRunning) {
      log.debug('Skipping auto-exit cycle (previous still running)');
      return;
    }

    if (isGeneralEndpointBlackout()) {
      this._logBlackoutSkip();
      return;
    }

    this.isCycleRunning = true;
    try {
      const configLookup = await this._buildAutoExitLookup();
      if (configLookup.size === 0) {
        log.debug('No auto-exit configurations found');
        return;
      }

      const instances = await instanceService.getAllInstances({ is_active: true });
      for (const instance of instances) {
        await this._monitorInstance(instance, configLookup);
      }
    } catch (error) {
      log.error('Auto-exit monitoring failed', error);
    } finally {
      this.isCycleRunning = false;
    }
  }

  async _monitorInstance(instance, configLookup) {
    const snapshot = marketDataFeedService.getPositionSnapshot(instance.id);
    const positions = Array.isArray(snapshot?.data) ? snapshot.data : [];
    if (!positions.length) return;

    const tradebookSnapshot = await marketDataFeedService.getTradebookSnapshot(instance.id);
    const normalizedTradebook = this._prepareTradebookSnapshot(tradebookSnapshot?.data);

    for (const position of positions) {
      await this._evaluatePosition(instance, position, configLookup, normalizedTradebook);
    }
  }

  _logBlackoutSkip() {
    const now = Date.now();
    if (now - this.lastBlackoutLogAt < 5 * 60 * 1000) {
      return;
    }
    this.lastBlackoutLogAt = now;
    log.info('Auto-exit paused during market blackout window');
  }

  async _evaluatePosition(instance, position, configLookup, tradebook = []) {
    const positionQty = this._getPositionQuantity(position);
    const rawSymbol = position.symbol || position.tradingsymbol || position.trading_symbol;
    const rawExchange = position.exchange || position.exch || position.brexchange;
    const positionSymbol = this._normalizeSymbol(rawSymbol);
    const positionExchange = this._normalizeExchange(rawExchange);

    if (!positionSymbol || !positionExchange) {
      return;
    }

    const key = this._getTrackingKey(instance.id, positionSymbol, positionExchange);

    if (positionQty === 0) {
      this.pendingExits.delete(key);
      this.exitConfirmations.delete(key);
      riskControlsService.clearTrailingState(key);
      marketDataFeedService.clearFallbackEntryPrice(instance.id, positionExchange, positionSymbol);
      return;
    }

    if (this._isPendingExit(key)) {
      return;
    }

    const configEntry = this._findConfig(positionSymbol, positionExchange, configLookup);
    if (!configEntry) {
      return;
    }

    // Use shared utility for price extraction
    let currentPriceSource = 'position_ltp';
    const { price: resolvedCurrentPrice, source: resolvedCurrentSource } =
      await this._resolveCurrentPrice(
        position,
        rawExchange,
        rawSymbol,
        instance?.id
      );
    const currentPrice = resolvedCurrentPrice;
    currentPriceSource = resolvedCurrentSource || currentPriceSource;
    const side = positionQty > 0 ? 'LONG' : 'SHORT';
    let entryPriceSource = null;
    let entryFallbackMeta = null;
    let entryPrice = extractAveragePrice(position);
    if (entryPrice) {
      entryPriceSource = 'position_avg';
    }
    if (!entryPrice) {
      entryPrice = this._resolveEntryPriceFromTrades(
        tradebook,
        positionSymbol,
        positionExchange,
        side,
        Math.abs(positionQty),
        instance?.name || instance?.broker || 'unknown'
      );
      if (entryPrice) {
        entryPriceSource = 'tradebook';
      }
    }

    // Fallback: cached entry price captured at manual order placement
    if (!entryPrice) {
      const cachedEntry = marketDataFeedService.getFallbackEntryPrice(instance.id, positionExchange, positionSymbol);
      if (cachedEntry?.price) {
        entryPrice = cachedEntry.price;
        entryPriceSource = `fallback_cache:${cachedEntry.source || 'unknown'}`;
        entryFallbackMeta = cachedEntry;
      }
    }

    // Cross-instance fallback: median LTP from instances with valid entry prices
    if (!entryPrice) {
      entryPrice = await this._resolveCrossInstanceMedianLtp(positionSymbol, positionExchange);
      if (entryPrice) {
        entryPriceSource = 'cross_instance_median_ltp';
      }
    }

    // Guard: avoid using provisional fallback entry before tradebook/avg arrives (prevents instant exits)
    if (
      entryPrice &&
      entryPriceSource?.startsWith('fallback_cache') &&
      !entryFallbackMeta?.confirmed &&
      entryFallbackMeta?.capturedAt &&
      Date.now() - entryFallbackMeta.capturedAt < this.provisionalEntryGraceMs
    ) {
      log.info('Auto-exit deferring: provisional fallback entry price', {
        instance_id: instance.id,
        symbol: positionSymbol,
        exchange: positionExchange,
        entry_price: entryPrice,
        captured_at: entryFallbackMeta.capturedAt,
        age_ms: Date.now() - entryFallbackMeta.capturedAt,
        grace_ms: this.provisionalEntryGraceMs,
      });
      return;
    }

    if (!currentPrice || !entryPrice) {
      log.error('Auto-exit skipped: unable to resolve price data', {
        instance_id: instance.id,
        symbol: positionSymbol,
        exchange: positionExchange,
        entry_source: entryPriceSource,
        ltp_source: currentPriceSource,
      });
      // User notification could be hooked here if frontend channel is available
      return;
    }

    const evaluation = await riskControlsService.evaluateExit({
      key,
      side,
      currentPrice,
      entryPrice,
      configEntry,
      symbol: positionSymbol,
      instanceId: instance.id,
      watchlistId: configEntry.watchlist_id,
      symbolId: configEntry.id,
      exchange: positionExchange,
    });
    if (!evaluation) {
      return;
    }

    const { reason: exitReason, mode } = evaluation;
    if (exitReason) {
      const confirmed = this._confirmExit(
        key,
        exitReason,
        {
          currentPrice,
          entryPrice,
          side,
          entryPriceSource,
          currentPriceSource,
        }
      );
      if (!confirmed) {
        return;
      }

      log.info('Auto-exit evaluation met threshold', {
        instance_id: instance.id,
        symbol: positionSymbol,
        exchange: positionExchange,
        side,
        reason: exitReason,
        entry_price: entryPrice,
        current_price: currentPrice,
        entry_source: entryPriceSource,
        ltp_source: currentPriceSource,
      });
      const exitSuccess = await this._executeAutoExit(instance, position, mode, exitReason);
      if (exitSuccess) {
        this.pendingExits.set(key, Date.now());
        this.exitConfirmations.delete(key);
        riskEventsService.record({
          instanceId: instance.id,
          watchlistId: configEntry.watchlist_id,
          symbolId: configEntry.id,
          exchange: positionExchange,
          symbol: positionSymbol,
          eventType: exitReason === 'TARGET_MET' ? 'TARGET_HIT' : 'STOP_HIT',
          metadata: { reason: exitReason, entryPrice, currentPrice, side },
        }).catch(() => {});
      } else {
        // Allow immediate retry on next tick if broker rejected/failed
        this.exitConfirmations.delete(key);
      }
      return;
    }

    // No trigger this cycle - clear sticky confirmation to avoid holding stale triggers
    this.exitConfirmations.delete(key);
  }

  async _executeAutoExit(instance, position, mode, reason = 'AUTO_EXIT') {
    const positionSymbol = position.symbol || position.tradingsymbol || position.trading_symbol;
    const positionExchange = position.exchange || position.exch || position.brexchange;
    const tradeMode = TRADE_MODE_MAP[mode] || 'FUTURES';
    const product = position.product || position.product_type || 'MIS';

    try {
      await quickOrderService.closePosition(
        instance,
        { symbol: positionSymbol, exchange: positionExchange },
        { tradeMode, product, strategy: reason }
      );
      log.info('Auto-exit triggered', {
        instance_id: instance.id,
        symbol: positionSymbol,
        exchange: positionExchange,
        trade_mode: tradeMode,
        strategy: reason,
      });
      return true;
    } catch (error) {
      log.warn('Auto-exit close failed', {
        instance_id: instance.id,
        symbol: positionSymbol,
        exchange: positionExchange,
        trade_mode: tradeMode,
        error: error.message,
      });
      return false;
    }
  }

  _confirmExit(key, reason, context = {}) {
    const now = Date.now();
    const record = this.exitConfirmations.get(key);
    const baseWindow = this.confirmationWindowMs;

    // Fallback-derived entries need a longer dwell to avoid premature exits on bad seeds
    const cautiousEntry =
      (context.entryPriceSource || '').startsWith('fallback_cache') ||
      context.entryPriceSource === 'cross_instance_median_ltp';
    const requiredWindow = cautiousEntry ? baseWindow * 2 : baseWindow;

    if (!record || record.reason !== reason) {
      this.exitConfirmations.set(key, {
        reason,
        firstDetectedAt: now,
        lastPrice: context.currentPrice,
        entryPriceSource: context.entryPriceSource,
        ltpSource: context.currentPriceSource,
      });
      log.debug('Auto-exit awaiting confirmation', {
        key,
        reason,
        cautious_entry: cautiousEntry,
        required_ms: requiredWindow,
      });
      return false;
    }

    const age = now - record.firstDetectedAt;
    if (age < requiredWindow) {
      record.lastPrice = context.currentPrice;
      this.exitConfirmations.set(key, record);
      return false;
    }

    return true;
  }

  _prepareTradebookSnapshot(trades = []) {
    if (!Array.isArray(trades) || trades.length === 0) {
      return [];
    }

    return trades
      .map(normalizeTradebookEntry)
      .filter(trade =>
        trade.symbol &&
        trade.exchange &&
        trade.quantity > 0 &&
        (trade.action === 'BUY' || trade.action === 'SELL')
      );
  }

  _resolveEntryPriceFromTrades(trades, symbol, exchange, side, positionQuantity, brokerName = 'unknown') {
    if (!Array.isArray(trades) || trades.length === 0) {
      return null;
    }
    const normalizedSymbol = this._normalizeSymbol(symbol);
    const normalizedExchange = this._normalizeExchange(exchange);
    const targetQuantity = Math.abs(positionQuantity);
    if (!normalizedSymbol || !normalizedExchange || targetQuantity <= 0) {
      return null;
    }

    const relevantTrades = trades.filter(trade =>
      this._normalizeSymbol(trade.symbol) === normalizedSymbol &&
      this._normalizeExchange(trade.exchange) === normalizedExchange
    );
    if (!relevantTrades.length) {
      return null;
    }

    const sortedTrades = [...relevantTrades].sort(
      (a, b) => (a.timestamp_epoch ?? 0) - (b.timestamp_epoch ?? 0)
    );
    const openAction = side === 'LONG' ? 'BUY' : 'SELL';
    const closeAction = side === 'LONG' ? 'SELL' : 'BUY';

    const openTrades = sortedTrades
      .filter(entry => entry.action === openAction)
      .map(entry => ({ ...entry, remaining: entry.quantity }));

    const closeTrades = sortedTrades.filter(entry => entry.action === closeAction);

    let closeIndex = 0;
    for (const closeTrade of closeTrades) {
      let remainingClose = closeTrade.quantity;
      while (remainingClose > 0 && closeIndex < openTrades.length) {
        const openEntry = openTrades[closeIndex];
        if (openEntry.remaining <= 0) {
          closeIndex += 1;
          continue;
        }
        const deduction = Math.min(openEntry.remaining, remainingClose);
        openEntry.remaining -= deduction;
        remainingClose -= deduction;
        if (openEntry.remaining <= 0) {
          closeIndex += 1;
        }
      }
      if (remainingClose > 0) {
        break;
      }
    }

    // Layered fallback for entry price resolution
    const dummyMap = {
      'BROKER A': new Set([0, 100]),
      'BROKER B': new Set([0]),
      'BROKER C': new Set([]),
    };
    const brokerKey = (brokerName || '').toUpperCase();
    const dummyValues = dummyMap[brokerKey] || dummyMap['BROKER A'];

    // Layer 1: Enhanced FIFO ignoring dummy prices
    let totalQuantity = 0;
    let totalCost = 0;
    for (const openEntry of openTrades) {
      const remaining = openEntry.remaining ?? 0;
      if (remaining <= 0) continue;
      const price = openEntry.average_price;
      if (!price || dummyValues.has(price)) {
        continue;
      }
      totalQuantity += remaining;
      totalCost += remaining * price;
    }
    if (totalQuantity > 0) {
      const fifoPrice = totalCost / totalQuantity;
      log.info('metrics.entry_price_fallback', {
        broker: brokerKey || 'UNKNOWN',
        layer: 'FIFO',
        price: fifoPrice,
        trades_considered: relevantTrades.length,
      });
      return fifoPrice;
    }

    const validPrices = relevantTrades
      .map(t => t.average_price)
      .filter(p => p && !dummyValues.has(p))
      .sort((a, b) => a - b);

    // Layer 2: Median of valid prices
    if (validPrices.length > 0) {
      const mid = Math.floor(validPrices.length / 2);
      const median = validPrices.length % 2 === 0
        ? (validPrices[mid - 1] + validPrices[mid]) / 2
        : validPrices[mid];
      log.info('metrics.entry_price_fallback', {
        broker: brokerKey || 'UNKNOWN',
        layer: 'MEDIAN',
        price: median,
        trades_considered: relevantTrades.length,
      });
      return median;
    }

    // Layer 3: Last valid trade price
    const lastValid = [...relevantTrades].reverse().find(t => t.average_price && !dummyValues.has(t.average_price));
    if (lastValid?.average_price) {
      log.info('metrics.entry_price_fallback', {
        broker: brokerKey || 'UNKNOWN',
        layer: 'LAST',
        price: lastValid.average_price,
        trades_considered: relevantTrades.length,
      });
      return lastValid.average_price;
    }

    log.error('Entry price resolution failed - invalid broker data', {
      broker: brokerKey || 'UNKNOWN',
      symbol: normalizedSymbol,
      exchange: normalizedExchange,
    });
    return null;
  }

  async _resolveCurrentPrice(position, rawExchange, rawSymbol, instanceId) {
    let currentPrice = extractLtp(position);
    if (currentPrice && currentPrice > 0) {
      return { price: currentPrice, source: 'position_ltp' };
    }

    // Try cached quotes first (order-critical TTL)
    const { cached } = marketDataFeedService.getCachedQuotesForSymbols(
      [{ exchange: rawExchange, symbol: rawSymbol }],
      { orderCritical: true }
    );
    if (cached?.length) {
      currentPrice = extractLtp(cached[0]);
      if (currentPrice && currentPrice > 0) {
        log.debug('Auto-exit using cached quote LTP fallback', {
          instance_id: instanceId,
          exchange: rawExchange,
          symbol: rawSymbol,
        });
        return { price: currentPrice, source: 'cached_quote' };
      }
    }

    // Force fetch LTP as last resort to avoid stuck tracking
    try {
      const ltpResult = await marketDataFeedService.fetchLtpForSymbol(
        rawExchange,
        rawSymbol,
        { maxRounds: 2 }
      );
      if (ltpResult?.ltp && ltpResult.ltp > 0) {
        log.debug('Auto-exit using live LTP fallback', {
          instance_id: instanceId,
          exchange: rawExchange,
          symbol: rawSymbol,
        });
        return { price: ltpResult.ltp, source: `live_fetch:${ltpResult.source || 'pool'}` };
      }
    } catch (err) {
      log.debug('Auto-exit LTP fallback failed', {
        instance_id: instanceId,
        exchange: rawExchange,
        symbol: rawSymbol,
        error: err.message,
      });
    }

    return { price: null, source: null };
  }

  async _resolveCrossInstanceMedianLtp(symbol, exchange) {
    try {
      const instances = await instanceService.getAllInstances({ is_active: true });
      const ltps = [];
      for (const inst of instances) {
        const snapshot = marketDataFeedService.getPositionSnapshot(inst.id);
        const positions = Array.isArray(snapshot?.data) ? snapshot.data : [];
        if (!positions.length) continue;
        const match = positions.find(p =>
          this._normalizeSymbol(p.symbol || p.tradingsymbol || p.trading_symbol) === this._normalizeSymbol(symbol) &&
          this._normalizeExchange(p.exchange || p.exch || p.brexchange) === this._normalizeExchange(exchange)
        );
        if (!match) continue;

        const avgPrice = extractAveragePrice(match);
        const cachedEntry = marketDataFeedService.getFallbackEntryPrice(inst.id, exchange, symbol);
        const hasValidEntry = (avgPrice && avgPrice > 0) || (cachedEntry?.price && cachedEntry.price > 0);
        if (!hasValidEntry) continue;

        const ltp = extractLtp(match);
        if (ltp && ltp > 0) {
          ltps.push(ltp);
        }
      }

      if (ltps.length === 0) return null;
      const sorted = ltps.sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    } catch (err) {
      return null;
    }
  }

  _findConfig(symbol, exchange, lookup) {
    const normalizedSymbol = this._normalizeSymbol(symbol);
    const normalizedExchange = this._normalizeExchange(exchange);
    const directKey = `${normalizedExchange}:${normalizedSymbol}`;

    if (lookup.has(directKey)) {
      return lookup.get(directKey)?.[0] || null;
    }

    for (const rows of lookup.values()) {
      for (const row of rows) {
        const normalizedUnderlying = this._normalizeSymbol(row.underlying_symbol || row.symbol);
        if (normalizedUnderlying && normalizedSymbol.startsWith(normalizedUnderlying)) {
          return row;
        }
      }
    }

    return null;
  }

  _buildAutoExitLookup() {
    return watchlistService.getSymbolsWithAutoExitConfig()
      .then(rows => {
        const lookup = new Map();
        rows.forEach(row => {
          const keys = this._symbolKeys(row);
          keys.forEach(k => {
            if (!k) return;
            if (!lookup.has(k)) {
              lookup.set(k, []);
            }
            lookup.get(k).push(row);
          });
        });
        return lookup;
      })
      .catch(error => {
        log.error('Unable to build auto-exit lookup', error);
        return new Map();
      });
  }

  _symbolKeys(row) {
    const keys = [];
    const primary = this._symbolKey(row.exchange, row.symbol);
    if (primary) keys.push(primary);
    const underlying = this._symbolKey(row.exchange, row.underlying_symbol);
    if (underlying && underlying !== primary) {
      keys.push(underlying);
    }
    return keys;
  }

  _symbolKey(exchange, symbol) {
    if (!exchange || !symbol) return null;
    const normalizedExchange = exchange.replace(/\s+/g, '').toUpperCase();
    const normalizedSymbol = symbol.replace(/\s+/g, '').toUpperCase();
    return `${normalizedExchange}:${normalizedSymbol}`;
  }

  _getTrackingKey(instanceId, symbol, exchange) {
    return `${instanceId}:${exchange}:${symbol}`;
  }

  _isPendingExit(key) {
    const timestamp = this.pendingExits.get(key);
    if (!timestamp) return false;
    if (Date.now() - timestamp > this.pendingExitCooldownMs) {
      this.pendingExits.delete(key);
      return false;
    }
    return true;
  }

  _getPositionQuantity(position) {
    const qty = position.quantity ?? position.netqty ?? position.netQty ?? position.net ?? position.pos ?? 0;
    return parseFloat(qty) || 0;
  }

  _normalizeSymbol(symbol) {
    return normalizeSymbolKey(symbol);
  }

  _normalizeExchange(exchange) {
    return normalizeExchange(exchange);
  }
}


const autoExitService = new AutoExitService();
export default autoExitService;
