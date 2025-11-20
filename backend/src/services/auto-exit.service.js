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
      riskControlsService.clearTrailingState(key);
      return;
    }

    if (this._isPendingExit(key)) {
      return;
    }

    const configEntry = this._findConfig(positionSymbol, positionExchange, configLookup);
    if (!configEntry) {
      return;
    }

    const fallbackPrice = this._extractPrice(position, ['ltp', 'ltp_value', 'last_price', 'lastprice', 'price']);
    const entryPrice = this._extractPrice(position, ['average_price', 'avg_price', 'avgprice', 'open_price']);
    const currentPrice = fallbackPrice;
    if (!currentPrice || !entryPrice) {
      return;
    }

    const side = positionQty > 0 ? 'LONG' : 'SHORT';
    const evaluation = riskControlsService.evaluateExit({
      key,
      side,
      currentPrice,
      entryPrice,
      configEntry,
      symbol: positionSymbol,
    });
    if (!evaluation) {
      return;
    }

    const { reason: exitReason, mode } = evaluation;
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
