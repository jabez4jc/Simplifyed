/**
 * Order Placement Service
 * Centralizes OpenAlgo placesmartorder calls with structured logging/context.
 * Includes validation to prevent invalid orders
 */

import openalgoClient from '../integrations/openalgo/client.js';
import { log } from '../core/logger.js';
import * as orderValidation from '../utils/order-validation.js';
import { ValidationError } from '../core/errors.js';
import orderRetryService from './order-retry.service.js';
import marketDataFeedService from './market-data-feed.service.js';
import { extractLtp } from '../utils/price-extraction.js';

class OrderPlacementService {
  constructor() {
    this.instanceQueues = new Map(); // instanceId -> queue
    this.instanceInFlight = new Set(); // instanceId
    this.instanceRateLimiters = new Map(); // instanceId -> TokenBucket
    this.unknownKeySeed = 0;
  }

  /**
   * Place a smart order via OpenAlgo with contextual logging and validation.
   * @param {Object} instance - Instance config (contains api key, etc.)
   * @param {Object} payload - Payload passed directly to OpenAlgo
   * @param {Object} context - Optional metadata for log tracing
   * @returns {Promise<Object>} OpenAlgo response
   */
  async placeSmartOrder(instance, payload, context = {}) {
    // CRITICAL: Validate order parameters before placing order
    try {
      // Validate required fields
      orderValidation.validateSymbol(payload.symbol);
      orderValidation.validateExchange(payload.exchange);
      orderValidation.validateAction(payload.action);

      // Validate quantity (basic validation - always required)
      const validatedQty = orderValidation.validateQuantity(
        payload.quantity,
        payload.action
      );

      // Validate price based on order type
      // Default to MARKET if pricetype is undefined (per order-payload.factory.js defaults)
      let effectivePriceType = payload.pricetype || 'MARKET';
      if (effectivePriceType === 'MARKET') {
        payload = await this._convertMarketToLimit(payload, context);
        effectivePriceType = payload.pricetype || 'LIMIT';
      }

      // For LIMIT, SL, SL-M orders, price validation is required
      orderValidation.validatePrice(payload.price, effectivePriceType);

      // Update payload with validated quantity
      payload.quantity = validatedQty;

    } catch (validationError) {
      log.error('[OrderPlacement] Validation failed', {
        instance_id: instance?.id,
        symbol: payload?.symbol,
        exchange: payload?.exchange,
        action: payload?.action,
        quantity: payload?.quantity,
        error: validationError.message
      });
      throw validationError;
    }

    const logContext = {
      instance_id: instance?.id,
      instance_name: instance?.name,
      ...context,
      resolved_symbol: payload?.symbol,
      exchange: payload?.exchange,
      action: payload?.action,
      product: payload?.product,
      quantity: payload?.quantity,
      position_size: payload?.position_size,
    };

    log.info('[OrderPlacement] Dispatching placesmartorder', logContext);

    return this._enqueuePlacement(instance, payload, context);
  }

  _enqueuePlacement(instance, payload, context = {}) {
    if (!instance?.id) {
      return Promise.reject(new ValidationError('Instance is required for order placement'));
    }

    const instanceId = instance.id;
    const queue = this._getQueue(instanceId);
    const symbolKey = this._symbolKey(payload)
      || `__unknown__:${Date.now()}:${++this.unknownKeySeed}`;

    return new Promise((resolve, reject) => {
      const existing = queue.find((entry) => entry.symbolKey === symbolKey && !entry.started);
      if (existing) {
        existing.payload = payload;
        existing.context = context;
        existing.resolvers.push({ resolve, reject });
        existing.coalesced = (existing.coalesced || 0) + 1;
        log.info('[OrderPlacement] Coalesced placement request', {
          instance_id: instanceId,
          symbol: payload?.symbol,
          exchange: payload?.exchange,
          coalesced_count: existing.coalesced,
        });
        return;
      }

      queue.push({
        instance,
        payload,
        context,
        symbolKey,
        started: false,
        resolvers: [{ resolve, reject }],
        coalesced: 0,
      });

      this._drainQueue(instanceId).catch(() => {});
    });
  }

  async _drainQueue(instanceId) {
    if (this.instanceInFlight.has(instanceId)) return;
    const queue = this._getQueue(instanceId);
    const entry = queue.shift();
    if (!entry) return;

    this.instanceInFlight.add(instanceId);
    entry.started = true;

    try {
      await this._applyRateLimit(instanceId);
      if (entry.context?.cancelOpenOrdersBeforePlacement === true) {
        await this._cancelOpenOrdersForSymbol(entry.instance, entry.payload, entry.context);
      }
      const response = await this._performPlacement(entry.instance, entry.payload, entry.context);
      entry.resolvers.forEach(({ resolve }) => resolve(response));
    } catch (error) {
      entry.resolvers.forEach(({ reject }) => reject(error));
    } finally {
      this.instanceInFlight.delete(instanceId);
      if (queue.length > 0) {
        setTimeout(() => this._drainQueue(instanceId), 0);
      }
    }
  }

  async _performPlacement(instance, payload, context = {}) {
    let response;
    try {
      response = await openalgoClient.placeSmartOrder(instance, payload, {
        skipRateLimit: context?.skipRateLimit === true,
      });
    } catch (error) {
      const statusCode = Number.isFinite(error?.statusCode) ? error.statusCode : null;
      const shouldRecover = statusCode !== null && statusCode >= 500;
      if (shouldRecover) {
        const recovered = await this._recoverOrderFromOrderbook(instance, payload);
        if (recovered) {
          log.warn('[OrderPlacement] Order inferred from orderbook after error', {
            instance_id: instance?.id,
            symbol: payload?.symbol,
            exchange: payload?.exchange,
            action: payload?.action,
            quantity: payload?.quantity,
            order_id: recovered.orderid || recovered.order_id,
          });
          return recovered;
        }
      }
      throw error;
    }

    log.info('[OrderPlacement] placesmartorder response', {
      instance_id: instance?.id,
      instance_name: instance?.name,
      resolved_symbol: payload?.symbol,
      exchange: payload?.exchange,
      action: payload?.action,
      product: payload?.product,
      quantity: payload?.quantity,
      position_size: payload?.position_size,
      order_id: response?.orderid || response?.order_id,
      status: response?.status,
      message: response?.message,
    });

    const orderId = response?.orderid || response?.order_id;
    const shouldScheduleRetry = !context?.skipRetry && orderId;
    const effectivePriceType = (payload.pricetype || 'MARKET').toUpperCase();
    if (shouldScheduleRetry && effectivePriceType === 'LIMIT') {
      orderRetryService.scheduleRetry({
        instance,
        payload,
        orderId,
        initialLimitPrice: payload.price,
        bufferPoints: context.limitBufferPoints ?? 0,
        bufferPct: context.limitBufferPct ?? null,
        tickSize: context.tickSize ?? null,
        strategy: payload.strategy || context.strategy || null,
        context,
        allowPartialRetry: context.allowPartialRetry ?? true,
        repeatUntilClosed: Object.prototype.hasOwnProperty.call(context, 'repeatUntilClosed')
          ? context.repeatUntilClosed
          : null,
        ignoreSlippage: Object.prototype.hasOwnProperty.call(context, 'ignoreSlippage')
          ? context.ignoreSlippage
          : null,
      });
    }

    return response;
  }

  async _recoverOrderFromOrderbook(instance, payload) {
    try {
      const orderbook = await openalgoClient.getOrderBook(instance);
      const orders = Array.isArray(orderbook)
        ? orderbook
        : orderbook?.orders || orderbook?.data || [];
      if (!Array.isArray(orders) || orders.length === 0) {
        return null;
      }

      const now = Date.now();
      const targetSymbol = (payload.symbol || '').toUpperCase();
      const targetExchange = (payload.exchange || '').toUpperCase();
      const targetAction = (payload.action || '').toUpperCase();
      const targetQty = Number(payload.quantity);

      const parseTimestamp = (order) => {
        const raw =
          order.timestamp ||
          order.order_timestamp ||
          order.time ||
          order.created_at ||
          order.last_updated;
        if (!raw) return null;
        if (typeof raw === 'number') {
          return raw > 1e12 ? raw : raw * 1000;
        }
        const parsed = Date.parse(raw);
        return Number.isNaN(parsed) ? null : parsed;
      };

      const isRecent = (order) => {
        const ts = parseTimestamp(order);
        if (!ts) return true;
        return now - ts <= 2 * 60 * 1000;
      };

      const matches = orders.filter((order) => {
        const symbol = (order.symbol || order.tradingsymbol || order.trading_symbol || '').toUpperCase();
        const exchange = (order.exchange || order.exch || order.brexchange || '').toUpperCase();
        const action = (order.action || order.side || '').toUpperCase();
        const qty = Number(order.quantity || order.qty || order.order_quantity);

        if (targetSymbol && symbol && symbol !== targetSymbol) return false;
        if (targetExchange && exchange && exchange !== targetExchange) return false;
        if (targetAction && action && action !== targetAction) return false;
        if (Number.isFinite(targetQty) && Number.isFinite(qty) && qty !== targetQty) return false;
        return isRecent(order);
      });

      if (!matches.length) {
        return null;
      }

      const pick = matches.sort((a, b) => {
        const ta = parseTimestamp(a) || 0;
        const tb = parseTimestamp(b) || 0;
        return tb - ta;
      })[0];

      return {
        status: 'success',
        orderid: pick.orderid || pick.order_id || pick.id,
        order_id: pick.orderid || pick.order_id || pick.id,
        message: 'Order inferred from orderbook after OpenAlgo error',
        recovered: true,
      };
    } catch (error) {
      log.warn('[OrderPlacement] Orderbook recovery failed', {
        instance_id: instance?.id,
        error: error.message,
      });
      return null;
    }
  }

  _getQueue(instanceId) {
    if (!this.instanceQueues.has(instanceId)) {
      this.instanceQueues.set(instanceId, []);
    }
    return this.instanceQueues.get(instanceId);
  }

  _getRateLimiter(instanceId) {
    if (!this.instanceRateLimiters.has(instanceId)) {
      this.instanceRateLimiters.set(instanceId, new TokenBucket(2, 2));
    }
    return this.instanceRateLimiters.get(instanceId);
  }

  async _applyRateLimit(instanceId) {
    const limiter = this._getRateLimiter(instanceId);
    await limiter.consume();
  }

  async _cancelOpenOrdersForSymbol(instance, payload, context = {}) {
    if (!instance?.id || !payload?.symbol || !payload?.exchange) return;

    let snapshot;
    try {
      snapshot = await marketDataFeedService.getOrderbookSnapshot(instance.id, { force: true });
    } catch (error) {
      log.warn('[OrderPlacement] Orderbook fetch failed before cancel', {
        instance_id: instance.id,
        error: error.message,
      });
      return;
    }

    const raw = snapshot?.data || [];
    const orders = Array.isArray(raw) ? raw : raw.orders || raw.data || [];
    if (!Array.isArray(orders) || orders.length === 0) return;

    const targetSymbol = this._normalizeSymbol(payload.symbol);
    const targetExchange = this._normalizeExchange(payload.exchange);
    const targetProduct = this._normalizeProduct(payload.product);
    const openStatuses = new Set(['open', 'pending', 'trigger_pending', 'partial']);

    const toCancel = [];
    for (const order of orders) {
      const symbol = this._normalizeSymbol(
        order.symbol || order.tradingsymbol || order.trading_symbol
      );
      const exchange = this._normalizeExchange(order.exchange || order.exch || order.brexchange);
      const product = this._normalizeProduct(order.product || order.producttype);
      if (symbol !== targetSymbol || exchange !== targetExchange) {
        continue;
      }
      if (targetProduct && product && product !== targetProduct) {
        continue;
      }
      const statusRaw = (order.order_status || order.status || '').toString().toLowerCase();
      const status = this._normalizeStatus(statusRaw);
      if (!openStatuses.has(status)) {
        continue;
      }
      const id = order.orderid || order.order_id || order.id;
      if (id) {
        toCancel.push(id);
      }
    }

    if (!toCancel.length) return;

    const strategyTag = payload.strategy || context.strategy || 'default';
    for (const orderId of toCancel) {
      try {
        await openalgoClient.cancelOrder(instance, orderId, strategyTag);
      } catch (error) {
        log.warn('[OrderPlacement] Failed to cancel open order', {
          instance_id: instance.id,
          order_id: orderId,
          error: error.message,
        });
      }
    }

    log.info('[OrderPlacement] Cancelled open orders before placement', {
      instance_id: instance.id,
      symbol: payload.symbol,
      exchange: payload.exchange,
      count: toCancel.length,
    });
  }

  async _convertMarketToLimit(payload, context = {}) {
    const exchange = payload?.exchange;
    const symbol = payload?.symbol;
    const side = (payload?.action || '').toUpperCase();
    if (!exchange || !symbol) {
      throw new ValidationError('Exchange and symbol are required to convert MARKET orders');
    }
    if (!['BUY', 'SELL'].includes(side)) {
      throw new ValidationError(`Invalid action for MARKET conversion: ${payload?.action}`);
    }

    const ltpResult = await marketDataFeedService.fetchLtpForSymbol(exchange, symbol, {
      orderCritical: true,
    });
    const ltp = ltpResult?.ltp || extractLtp(ltpResult?.quote);
    if (!ltp || ltp <= 0) {
      throw new ValidationError(`Unable to resolve LTP for ${exchange}:${symbol}`);
    }

    let bufferPoints = Number(context?.limitBufferPoints);
    if (!Number.isFinite(bufferPoints) || bufferPoints <= 0) {
      const bufferPct = Number(context?.limitBufferPct);
      bufferPoints = Number.isFinite(bufferPct) && bufferPct > 0
        ? ltp * (bufferPct / 100)
        : 0;
    }

    let price = side === 'BUY' ? ltp + bufferPoints : ltp - bufferPoints;
    if (!Number.isFinite(price) || price <= 0) {
      price = ltp;
    }

    price = this._roundToTick(price, context?.tickSize, side);

    log.info('[OrderPlacement] MARKET converted to LIMIT', {
      exchange,
      symbol,
      action: side,
      ltp,
      bufferPoints,
      price,
    });

    return {
      ...payload,
      pricetype: 'LIMIT',
      price,
    };
  }

  _roundToTick(price, tickSize, side) {
    const tick = typeof tickSize === 'string' ? parseFloat(tickSize) : tickSize;
    if (!Number.isFinite(tick) || tick <= 0) {
      return Number(price.toFixed(2));
    }

    const ticks = price / tick;
    const roundedTicks = side === 'BUY'
      ? Math.ceil(ticks - 1e-9)
      : Math.floor(ticks + 1e-9);
    const rounded = roundedTicks * tick;
    const decimals = this._countDecimals(tick);
    return Number(rounded.toFixed(decimals));
  }

  _countDecimals(value) {
    const text = value.toString();
    const idx = text.indexOf('.');
    return idx === -1 ? 0 : Math.min(6, text.length - idx - 1);
  }

  _normalizeSymbol(symbol) {
    if (!symbol) return null;
    return String(symbol).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  _normalizeExchange(exchange) {
    if (!exchange) return null;
    return String(exchange).trim().toUpperCase();
  }

  _normalizeProduct(product) {
    if (!product) return null;
    return String(product).trim().toUpperCase();
  }

  _normalizeStatus(status) {
    if (['complete', 'completed', 'filled'].includes(status)) return 'complete';
    if (['cancelled', 'canceled'].includes(status)) return 'cancelled';
    if (['rejected'].includes(status)) return 'rejected';
    if (['trigger_pending'].includes(status)) return 'trigger_pending';
    if (['partial', 'partially_filled', 'partiallyfilled'].includes(status)) return 'partial';
    if (['open', 'pending'].includes(status)) return status;
    return status || 'unknown';
  }

  _symbolKey(payload) {
    const exchange = this._normalizeExchange(payload?.exchange);
    const symbol = this._normalizeSymbol(payload?.symbol);
    const product = this._normalizeProduct(payload?.product);
    if (!exchange || !symbol) return null;
    return product ? `${exchange}|${symbol}|${product}` : `${exchange}|${symbol}`;
  }
}

class TokenBucket {
  constructor(rate, burst = rate) {
    this.rate = rate;
    this.capacity = burst;
    this.tokens = burst;
    this.lastRefill = Date.now();
  }

  _refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.rate);
    this.lastRefill = now;
  }

  async consume() {
    this._refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    const needed = 1 - this.tokens;
    const waitMs = (needed / this.rate) * 1000;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    this._refill();
    this.tokens = Math.max(0, this.tokens - 1);
  }
}

const orderPlacementService = new OrderPlacementService();
export default orderPlacementService;
