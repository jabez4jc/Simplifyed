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
    this.trailingState = new Map();
    this.monitorIntervalMs = config.autoExit?.monitorIntervalMs || 5000;
  }

  async start() {
    if (this.isRunning) {
      log.warn('AutoExitService already running');
      return;
    }

    this.isRunning = true;
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
    this.trailingState.clear();
    log.info('AutoExitService stopped');
  }

  async monitorAllPositions() {
    if (this.isCycleRunning) {
      log.debug('Skipping auto-exit cycle (previous still running)');
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
    const positions = snapshot?.data || [];
    if (!positions.length) {
      return;
    }

    for (const position of positions) {
      await this._evaluatePosition(instance, position, configLookup);
    }
  }

  async _evaluatePosition(instance, position, configLookup) {
    const positionQty = this._getPositionQuantity(position);
    const positionSymbol = this._normalizeSymbol(position.symbol || position.tradingsymbol || position.trading_symbol);
    const positionExchange = this._normalizeExchange(position.exchange || position.exch || position.brexchange);

    if (!positionSymbol || !positionExchange) {
      return;
    }

    const key = this._getTrackingKey(instance.id, positionSymbol, positionExchange);

    if (positionQty === 0) {
      this.pendingExits.delete(key);
      this.trailingState.delete(key);
      return;
    }

    if (this._isPendingExit(key)) {
      return;
    }

    const configEntry = this._findConfig(positionSymbol, positionExchange, configLookup);
    if (!configEntry) {
      return;
    }

    const websocketPrice = this._getWebsocketQuote(instance.id, position.symbol || position.tradingsymbol || position.trading_symbol, positionExchange);
    const fallbackPrice = this._extractPrice(position, ['ltp', 'ltp_value', 'last_price', 'lastprice', 'price']);
    const entryPrice = this._extractPrice(position, ['average_price', 'avg_price', 'avgprice', 'open_price']);
    const currentPrice = websocketPrice ?? fallbackPrice;
    if ((!currentPrice && websocketPrice === null) || !entryPrice) {
      return;
    }

    const mode = this._determineMode(configEntry, positionSymbol);
    const thresholds = this._getThresholds(configEntry, mode);
    if (!thresholds) {
      return;
    }

    const side = positionQty > 0 ? 'LONG' : 'SHORT';
    const direction = side === 'LONG' ? 1 : -1;
    const targetPrice = thresholds.targetPoints
      ? entryPrice + direction * thresholds.targetPoints
      : null;
    const stopPrice = thresholds.stoplossPoints
      ? entryPrice - direction * thresholds.stoplossPoints
      : null;

    const trailingHit = this._evaluateTrailing(
      key,
      side,
      currentPrice,
      entryPrice,
      thresholds.trailingPoints,
      thresholds.trailingActivationPoints
    );
    const targetHit = targetPrice && (
      (side === 'LONG' && currentPrice >= targetPrice) ||
      (side === 'SHORT' && currentPrice <= targetPrice)
    );
    const stopHit = stopPrice && (
      (side === 'LONG' && currentPrice <= stopPrice) ||
      (side === 'SHORT' && currentPrice >= stopPrice)
    );

    let exitReason = null;
    if (targetHit) exitReason = 'TARGET_MET';
    else if (stopHit) exitReason = 'STOPLOSS_HIT';
    else if (trailingHit) exitReason = 'TSL_HIT';

    if (exitReason) {
      await this._executeAutoExit(instance, position, mode, exitReason);
      this.pendingExits.set(key, Date.now());
      return;
    }
  }

  async _executeAutoExit(instance, position, mode, reason = 'AUTO_EXIT') {
    const positionSymbol = position.symbol || position.tradingsymbol || position.trading_symbol;
    const positionExchange = position.exchange || position.exch || position.brexchange;
    const quantity = Math.abs(this._getPositionQuantity(position));
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
    } catch (error) {
      log.warn('Auto-exit close failed', {
        instance_id: instance.id,
        symbol: positionSymbol,
        exchange: positionExchange,
        trade_mode: tradeMode,
        error: error.message,
      });
    }
  }

  _evaluateTrailing(key, side, currentPrice, entryPrice, trailingPoints, activationPoints) {
    if (!trailingPoints) return false;
    if (!entryPrice || entryPrice <= 0) return false;

    const profit = side === 'LONG'
      ? currentPrice - entryPrice
      : entryPrice - currentPrice;

    const state = this.trailingState.get(key) || {
      highest: currentPrice,
      lowest: currentPrice,
      activated: !activationPoints,
    };
    state.highest = Math.max(state.highest, currentPrice);
    state.lowest = Math.min(state.lowest, currentPrice);

    if (activationPoints && !state.activated) {
      if (profit >= activationPoints) {
        state.activated = true;
      } else {
        this.trailingState.set(key, state);
        return false;
      }
    }

    if (!state.activated) {
      this.trailingState.set(key, state);
      return false;
    }

    if (side === 'LONG') {
      const trigger = state.highest - trailingPoints;
      this.trailingState.set(key, state);
      return currentPrice <= trigger;
    }

    const trigger = state.lowest + trailingPoints;
    this.trailingState.set(key, state);
    return currentPrice >= trigger;
  }

  _getThresholds(entry, mode) {
    const normalizeValue = (value) => (typeof value === 'number' && value > 0 ? value : null);
    const targetPoints = normalizeValue(entry[`target_points_${mode}`]);
    const stoplossPoints = normalizeValue(entry[`stoploss_points_${mode}`]);
    const trailingPoints = normalizeValue(entry[`trailing_stoploss_points_${mode}`]);
    const trailingActivationPoints = normalizeValue(entry[`trailing_activation_points_${mode}`]) ?? 0;
    if (!targetPoints && !stoplossPoints && !trailingPoints) {
      return null;
    }
    return { targetPoints, stoplossPoints, trailingPoints, trailingActivationPoints };
  }

  _determineMode(entry, symbol) {
    const normalizedSymbol = symbol.toUpperCase();
    if (normalizedSymbol.includes('CE') || normalizedSymbol.includes('PE')) {
      return 'options';
    }
    if (normalizedSymbol.includes('FUT')) {
      return 'futures';
    }
    const type = (entry.symbol_type || '').toUpperCase();
    if (type === 'OPTIONS') {
      return 'options';
    }
    if (type === 'FUTURES' || type === 'INDEX') {
      return 'futures';
    }
    return 'direct';
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

  _getWebsocketQuote(instanceId, symbol, exchange) {
    const snapshot = marketDataFeedService.getQuoteSnapshot(instanceId);
    if (!snapshot?.data || snapshot.source !== 'websocket') {
      return null;
    }

    const targetKey = this._symbolKey(exchange, symbol);
    if (!targetKey) {
      return null;
    }

    for (const item of snapshot.data) {
      if (this._symbolKey(item.exchange, item.symbol) !== targetKey) {
        continue;
      }
      const price = parseFloat(item.ltp);
      if (!Number.isNaN(price) && price > 0) {
        return price;
      }
    }

    return null;
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
    if (Date.now() - timestamp > 30 * 1000) {
      this.pendingExits.delete(key);
      return false;
    }
    return true;
  }

  _getPositionQuantity(position) {
    const qty = position.quantity ?? position.netqty ?? position.netQty ?? position.net ?? position.pos ?? 0;
    return parseFloat(qty) || 0;
  }

  _extractPrice(position, keys) {
    for (const key of keys) {
      const value = position[key];
      if (typeof value === 'number' && value > 0) {
        return value;
      }
      if (typeof value === 'string' && value.trim()) {
        const parsed = parseFloat(value);
        if (!Number.isNaN(parsed)) {
          return parsed;
        }
      }
    }
    return null;
  }

  _normalizeSymbol(symbol) {
    if (!symbol) return null;
    return symbol.replace(/\s+/g, '').toUpperCase();
  }

  _normalizeExchange(exchange) {
    if (!exchange) return null;
    return exchange.replace(/\s+/g, '').toUpperCase();
  }
}

const autoExitService = new AutoExitService();
export default autoExitService;
