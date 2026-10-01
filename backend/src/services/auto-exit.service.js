/**
 * Auto Exit Service
 * Watches positions (internal or external) and triggers exit orders when configured thresholds are met.
 */

import { log } from '../core/logger.js';
import db from '../core/database.js';
import instanceService from './instance.service.js';
import watchlistService from './watchlist.service.js';
import marketDataFeedService from './market-data-feed.service.js';
import quickOrderService from './quick-order.service.js';
import riskControlsService from './risk-controls.service.js';
import riskEventsService from './risk-events.service.js';
import { extractLtp, extractAveragePrice } from '../utils/price-extraction.js';
import { normalizeTradebookEntry } from '../utils/tradebook-utils.js';
import marketCalendarService from './market-calendar.service.js';
import { isCryptoExchange } from '../utils/broker-type.util.js';
import { normalizeSymbolKey, normalizeExchange } from '../utils/symbol-parsing.util.js';
import exitLevelsService from './exit-levels.service.js';
import exitLossCapsService from './exit-loss-caps.service.js';

const MONITOR_INTERVAL_MS = 5000;
const PROVISIONAL_ENTRY_GRACE_MS = 20000;
const PENDING_EXIT_COOLDOWN_MS = 30000;
// A WS quote this young beats the positionbook LTP, which is 8-30s stale.
const FRESH_WS_QUOTE_MS = 5000;

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
    this.monitorIntervalMs = MONITOR_INTERVAL_MS;
    this.provisionalEntryGraceMs = PROVISIONAL_ENTRY_GRACE_MS;
    this.pendingExitCooldownMs = PENDING_EXIT_COOLDOWN_MS;
    this.warnedKeys = new Set(); // log a given skip reason once per position, not every cycle
    // Minimum dwell window before honouring an exit trigger (guards against single-tick spikes)
    this.confirmationWindowMs = Math.max(1500, this.monitorIntervalMs * 1.2);
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

    this.isCycleRunning = true;
    try {
      // Levels on the underlying and the rupee max-loss run every cycle, whether or not any
      // watchlist row has points-based exits configured (the early return below).
      await exitLevelsService.evaluate();
      await exitLossCapsService.evaluate();

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

  async _evaluatePosition(instance, position, configLookup, tradebook = []) {
    const positionQty = this._getPositionQuantity(position);
    const rawSymbol = position.symbol || position.tradingsymbol || position.trading_symbol;
    const rawExchange = position.exchange || position.exch || position.brexchange;
    const positionSymbol = this._normalizeSymbol(rawSymbol);
    const positionExchange = this._normalizeExchange(rawExchange);

    if (!positionSymbol || !positionExchange) {
      return;
    }

    // One tracking entry per PRODUCT row. The broker keeps a closed row (quantity 0) for the day
    // beside a live one in another product (MIS closed, NRML open). Keyed by symbol alone, the
    // zero row cleared the live row's confirmation every cycle, so a hit target/stop was never
    // confirmed and the exit never fired - and trailing stops were wiped the same way.
    const positionProduct = String(position.product || position.product_type || position.producttype || '').toUpperCase();
    const key = this._getTrackingKey(instance.id, positionSymbol, positionExchange, positionProduct);
    // The trail is keyed by side as well: a reversal must start a fresh one. This key also
    // persists - the colon-separated tracking key never did, so a restart reset every trail.
    const trailKey = (s) => riskControlsService.trailingKey(instance.id, positionExchange, positionSymbol, s, positionProduct);

    if (positionQty === 0) {
      this.pendingExits.delete(key);
      this.exitConfirmations.delete(key);
      riskControlsService.clearTrailingState(trailKey('LONG'));
      riskControlsService.clearTrailingState(trailKey('SHORT'));
      marketDataFeedService.clearFallbackEntryPrice(instance.id, positionExchange, positionSymbol);
      this.warnedKeys.delete(key);
      return;
    }

    // Evaluate only while this position's own exchange is trading: an exit sent to a closed
    // exchange is rejected at best, and the prices it would be judged on are stale. This used to
    // be approximated by a fixed 03:00-08:00 IST pause, which left crypto (24/7) unprotected in
    // that window and Indian positions evaluated at every other closed hour. The calendar
    // answers null when it cannot be read - then evaluate anyway: a calendar outage must not
    // switch every Indian stop-loss off. Only a definite "closed" skips.
    if (!isCryptoExchange(positionExchange) && (await marketCalendarService.isExchangeOpen(positionExchange)) === false) {
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
        Math.abs(positionQty)
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
      // No broker average price and no tradebook entry (or no price): skip, never guess. Once per
      // position - this runs every cycle.
      if (!this.warnedKeys.has(key)) {
        this.warnedKeys.add(key);
        log.warn('Auto-exit skipped: unable to resolve price data', {
          instance_id: instance.id,
          symbol: positionSymbol,
          exchange: positionExchange,
          entry_source: entryPriceSource,
          ltp_source: currentPriceSource,
        });
      }
      return;
    }
    this.warnedKeys.delete(key);

    riskControlsService.clearTrailingState(trailKey(side === 'LONG' ? 'SHORT' : 'LONG'));
    const evaluation = await riskControlsService.evaluateExit({
      key: trailKey(side),
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
      const exitSuccess = await this._executeAutoExit(instance, position, mode, exitReason, configEntry);
      if (exitSuccess) {
        this.pendingExits.set(key, Date.now());
        this.exitConfirmations.delete(key);
        riskEventsService.record({
          instanceId: instance.id,
          watchlistId: configEntry.watchlist_id,
          symbolId: configEntry.id,
          exchange: positionExchange,
          symbol: positionSymbol,
          eventType: { TARGET_MET: 'TARGET_HIT', TSL_HIT: 'TRAIL_HIT' }[exitReason] || 'STOP_HIT',
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

  async _executeAutoExit(instance, position, mode, reason = 'AUTO_EXIT', configEntry = null) {
    const positionSymbol = position.symbol || position.tradingsymbol || position.trading_symbol;
    const positionExchange = position.exchange || position.exch || position.brexchange;
    const tradeMode = TRADE_MODE_MAP[mode] || 'FUTURES';
    const product = position.product || position.product_type || position.producttype || 'MIS';

    try {
      // A strategy leg's stop acts on what THE STRATEGY holds, never the whole symbol (another
      // leg, strategy or a manual position may share the contract).
      const owned = await this._strategyOwnedQty(instance.id, positionExchange, positionSymbol, product, configEntry?.watchlist_id);
      const held = this._getPositionQuantity(position);
      if (owned !== null && (owned === 0 || Math.sign(owned) !== Math.sign(held))) {
        const k = `owned:${instance.id}:${positionExchange}:${positionSymbol}:${product}`;
        if (!this.warnedKeys.has(k)) {
          this.warnedKeys.add(k);
          log.warn('Auto-exit skipped: the strategy ledger holds none of this position', {
            instance_id: instance.id, symbol: positionSymbol, exchange: positionExchange, product,
          });
        }
        return false;
      }
      if (owned !== null && Math.abs(owned) < Math.abs(held)) {
        await quickOrderService.exitPartOfPosition(
          instance,
          { symbol: positionSymbol, exchange: positionExchange, product, quantity: held },
          Math.abs(owned),
          { strategy: reason }
        );
      } else {
        await quickOrderService.closePosition(
          instance,
          { symbol: positionSymbol, exchange: positionExchange },
          { tradeMode, product, onlyProduct: true, strategy: reason }
        );
      }
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

  /**
   * Signed quantity the strategies owning this config row's watchlist still hold open in the
   * ledger for this contract/product, or null when the row does not belong to a strategy.
   */
  async _strategyOwnedQty(instanceId, exchange, symbol, product, watchlistId) {
    if (!watchlistId) return null;
    const strategies = await db.all('SELECT id FROM strategies WHERE watchlist_id = ?', [watchlistId]);
    if (!strategies.length) return null;
    const rows = await db.all(
      `SELECT sle.resolved_symbol, sle.resolved_exchange, sle.product, sle.quantity, sl.action
       FROM strategy_leg_executions sle
       JOIN strategy_legs sl ON sl.id = sle.strategy_leg_id
       WHERE sle.instance_id = ? AND sle.entry_status = 'PLACED' AND sle.closed_at IS NULL
         AND sle.strategy_id IN (${strategies.map(() => '?').join(',')})`,
      [instanceId, ...strategies.map((r) => r.id)]
    );
    const sym = this._normalizeSymbol(symbol);
    const exch = this._normalizeExchange(exchange);
    const prod = String(product || '').toUpperCase();
    return rows
      .filter((r) => this._normalizeSymbol(r.resolved_symbol) === sym
        && this._normalizeExchange(r.resolved_exchange) === exch
        && String(r.product || '').toUpperCase() === prod)
      .reduce((total, r) => total + (String(r.action).toUpperCase() === 'SELL' ? -1 : 1) * (Number(r.quantity) || 0), 0);
  }

  _confirmExit(key, reason, context = {}) {
    const now = Date.now();
    const record = this.exitConfirmations.get(key);
    const baseWindow = this.confirmationWindowMs;

    // Fallback-derived entries need a longer dwell to avoid premature exits on bad seeds
    const cautiousEntry = (context.entryPriceSource || '').startsWith('fallback_cache');
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

  _resolveEntryPriceFromTrades(trades, symbol, exchange, side, positionQuantity) {
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

    // Layer 1: FIFO average of the still-open entry-side trades (a 0 price is never real).
    let totalQuantity = 0;
    let totalCost = 0;
    for (const openEntry of openTrades) {
      const remaining = openEntry.remaining ?? 0;
      const price = openEntry.average_price;
      if (remaining <= 0 || !(price > 0)) continue;
      totalQuantity += remaining;
      totalCost += remaining * price;
    }
    if (totalQuantity > 0) {
      return totalCost / totalQuantity;
    }

    // Layer 2: last valid entry-side trade price
    const lastValid = [...openTrades].reverse().find((t) => t.average_price > 0);
    if (lastValid) return lastValid.average_price;

    return null;
  }

  async _resolveCurrentPrice(position, rawExchange, rawSymbol, instanceId) {
    // Freshest first: a young WS quote beats the positionbook LTP (8-30s old).
    const { cached: wsFresh } = marketDataFeedService.getCachedQuoteEntriesForSymbols(
      [{ exchange: rawExchange, symbol: rawSymbol }],
      { ttlMs: FRESH_WS_QUOTE_MS }
    );
    const wsPrice = wsFresh?.length ? extractLtp(wsFresh[0].quote) : null;
    if (wsPrice && wsPrice > 0) {
      return { price: wsPrice, source: 'ws_quote' };
    }

    let currentPrice = extractLtp(position);
    if (currentPrice && currentPrice > 0) {
      return { price: currentPrice, source: 'position_ltp' };
    }

    // Try cached quotes (order-critical TTL)
    const { cached } = marketDataFeedService.getCachedQuotesForSymbols(
      [{ exchange: rawExchange, symbol: rawSymbol }],
      { orderCritical: true }
    );
    if (cached?.length) {
      currentPrice = extractLtp(cached[0]);
      if (currentPrice && currentPrice > 0) {
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

  _findConfig(symbol, exchange, lookup) {
    const normalizedSymbol = this._normalizeSymbol(symbol);
    const normalizedExchange = this._normalizeExchange(exchange);
    const directKey = `${normalizedExchange}:${normalizedSymbol}`;

    if (lookup.has(directKey)) {
      return lookup.get(directKey)?.[0] || null;
    }

    // By underlying, only a row that has an exit for THIS position's mode: the first prefix
    // match used to win, so a strategy's options-only leg row shadowed the watchlist row that
    // carried the futures stop, and the stop never ran.
    for (const rows of lookup.values()) {
      for (const row of rows) {
        const normalizedUnderlying = this._normalizeSymbol(row.underlying_symbol || row.symbol);
        if (normalizedUnderlying && normalizedSymbol.startsWith(normalizedUnderlying)
          && riskControlsService._getThresholds(row, riskControlsService._determineMode(row, normalizedSymbol), 1)) {
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

  _getTrackingKey(instanceId, symbol, exchange, product = '') {
    return `${instanceId}:${exchange}:${symbol}:${product}`;
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
