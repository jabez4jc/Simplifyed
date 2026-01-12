import { log } from '../core/logger.js';
import marketDataFeedService from './market-data-feed.service.js';
import orderPlacementService from './order-placement.service.js';
import orderService from './order.service.js';
import openalgoClient from '../integrations/openalgo/client.js';
import { extractLtp } from '../utils/price-extraction.js';

const RETRY_DELAY_MS = 5000;
const FINAL_CHECK_DELAY_MS = 5000;
const MAX_SLIPPAGE_PCT = 0.005;

class OrderRetryService {
  constructor() {
    this.pending = new Map();
    this.pendingFinal = new Map();
  }

  scheduleRetry({
    instance,
    payload,
    orderId,
    initialLimitPrice,
    bufferPoints = 0,
    bufferPct = null,
    tickSize = null,
    strategy = null,
    context = {},
    allowPartialRetry = true,
    repeatUntilClosed = null,
    ignoreSlippage = null,
  }) {
    if (!instance?.id || !orderId || !payload) return;
    if ((payload.pricetype || '').toUpperCase() !== 'LIMIT') return;

    const key = `${instance.id}:${orderId}`;
    if (this.pending.has(key)) return;

    const timeoutId = setTimeout(() => {
      this.pending.delete(key);
      this._handleRetry({
        instance,
        payload,
        orderId,
        initialLimitPrice,
        bufferPoints,
        bufferPct,
        tickSize,
        strategy,
        context,
        allowPartialRetry,
        repeatUntilClosed,
        ignoreSlippage,
      }).catch((error) => {
        log.warn('Order retry failed', { order_id: orderId, error: error.message });
      });
    }, RETRY_DELAY_MS);

    this.pending.set(key, timeoutId);
  }

  async _handleRetry({
    instance,
    payload,
    orderId,
    initialLimitPrice,
    bufferPoints,
    bufferPct,
    tickSize,
    strategy,
    context,
    allowPartialRetry,
    repeatUntilClosed,
    ignoreSlippage,
  }) {
    const snapshot = await marketDataFeedService.getOrderbookSnapshot(instance.id, { force: true });
    const raw = snapshot?.data || [];
    const orders = Array.isArray(raw) ? raw : raw.orders || raw.data || [];
    const order = orders.find((o) => {
      const id = o.orderid || o.order_id || o.id;
      return id && String(id) === String(orderId);
    });

    if (!order) {
      if (repeatUntilClosed && payload) {
        const positionMatch = await this._positionMatchesTarget(instance, payload);
        if (positionMatch) {
          log.info('Retry skipped - target position reached', {
            instance_id: instance.id,
            order_id: orderId,
            target_position: payload.position_size,
          });
          return;
        }
        log.info('Order not found; retrying to reach target position', {
          instance_id: instance.id,
          order_id: orderId,
        });
      } else {
        log.info('Retry skipped - order not found in orderbook', {
          instance_id: instance.id,
          order_id: orderId,
        });
        return;
      }
    }

    let normalizedStatus = 'unknown';
    let retryQuantity = null;
    let resolvedRepeat = repeatUntilClosed;
    let resolvedIgnore = ignoreSlippage;
    if (resolvedRepeat === null || resolvedIgnore === null) {
      const inferred = await this._inferRetryPolicy(instance, payload);
      if (resolvedRepeat === null) {
        resolvedRepeat = inferred.repeatUntilClosed;
      }
      if (resolvedIgnore === null) {
        resolvedIgnore = inferred.ignoreSlippage;
      }
    }

    const targetPosition = this._parseNumber(payload?.position_size);
    const currentPosition = targetPosition === null
      ? null
      : await this._getLivePosition(instance, payload);
    const pendingQty = this._sumOpenOrders(orders, payload);
    const remainingNeeded = targetPosition === null || currentPosition === null
      ? null
      : this._remainingForTarget(payload?.action, currentPosition, targetPosition);
    const remainingAfterPending = remainingNeeded === null
      ? null
      : Math.max(remainingNeeded - pendingQty, 0);

    if (remainingAfterPending !== null && remainingAfterPending <= 0) {
      await this._cancelOpenOrdersForSymbol(instance, orders, payload, strategy);
      log.info('Retry skipped - target position already satisfied', {
        instance_id: instance.id,
        order_id: orderId,
        target_position: targetPosition,
        current_position: currentPosition,
        pending_qty: pendingQty,
      });
      return;
    }
    if (order) {
      const statusRaw = (order.order_status || order.status || '').toString().toLowerCase();
      normalizedStatus = this._normalizeStatus(statusRaw);
      if (['complete', 'filled'].includes(normalizedStatus)) {
        log.info('Retry skipped - order already filled', {
          instance_id: instance.id,
          order_id: orderId,
        });
        return;
      }

      const filledQty = this._extractFilledQty(order);
      if (filledQty > 0) {
        const orderQty = this._extractOrderQty(order, payload);
        const remainingQty = Math.max(orderQty - filledQty, 0);
      if (!allowPartialRetry || remainingQty <= 0) {
        log.info('Retry skipped - partial fill detected', {
          instance_id: instance.id,
          order_id: orderId,
          filled_qty: filledQty,
        });
        return;
      }
      retryQuantity = remainingQty;
      log.info('Retrying remaining quantity after partial fill', {
        instance_id: instance.id,
        order_id: orderId,
        filled_qty: filledQty,
        remaining_qty: remainingQty,
      });
    }

      if (!['open', 'pending', 'trigger_pending', 'partial'].includes(normalizedStatus)) {
        log.info('Retry skipped - order not open', {
          instance_id: instance.id,
          order_id: orderId,
          status: normalizedStatus,
        });
        return;
      }
      if (normalizedStatus === 'partial') {
        await this._cancelOpenOrdersForSymbol(instance, orders, payload, strategy);
      }
    }

    const exchange = payload.exchange;
    const symbol = payload.symbol;
    const side = payload.action;

    const ltpResult = await marketDataFeedService.fetchLtpForSymbol(exchange, symbol, {
      orderCritical: true,
    });
    const ltp = ltpResult?.ltp || extractLtp(ltpResult?.quote);
    if (!ltp || ltp <= 0) {
      await this._cancelAll(instance.id, strategy);
      log.warn('Retry cancelled - no LTP available', {
        instance_id: instance.id,
        order_id: orderId,
      });
      return;
    }

    const initialPrice = Number(initialLimitPrice || payload.price || 0);
    if (!Number.isFinite(initialPrice) || initialPrice <= 0) {
      await this._cancelAll(instance.id, strategy);
      log.warn('Retry cancelled - invalid initial limit price', {
        instance_id: instance.id,
        order_id: orderId,
      });
      return;
    }

    if (!resolvedIgnore) {
      const slippage = Math.abs(initialPrice - ltp) / ltp;
      if (slippage > MAX_SLIPPAGE_PCT) {
        await this._cancelAll(instance.id, strategy);
        log.warn('Retry cancelled - slippage threshold exceeded', {
          instance_id: instance.id,
          order_id: orderId,
          slippage_pct: slippage,
        });
        return;
      }
    }

    await this._cancelAll(instance.id, strategy);

    const retryPrice = this._applyBufferAndTick({
      ltp,
      side,
      bufferPoints,
      bufferPct,
      tickSize,
    });

    const retryPayload = {
      ...payload,
      pricetype: 'LIMIT',
      price: retryPrice,
    };
    const cappedQty = remainingAfterPending !== null
      ? remainingAfterPending
      : null;
    const finalQty = retryQuantity !== null
      ? (cappedQty !== null ? Math.min(retryQuantity, cappedQty) : retryQuantity)
      : cappedQty;
    if (finalQty !== null) {
      if (finalQty <= 0) {
        await this._cancelOpenOrdersForSymbol(instance, orders, payload, strategy);
        log.info('Retry skipped - no remaining quantity to place', {
          instance_id: instance.id,
          order_id: orderId,
        });
        return;
      }
      retryPayload.quantity = finalQty;
    }

    log.info('Retrying limit order with updated price', {
      instance_id: instance.id,
      order_id: orderId,
      retry_price: retryPrice,
    });

    const retryResult = await orderPlacementService.placeSmartOrder(instance, retryPayload, {
      ...context,
      request_type: 'RETRY_ORDER',
      skipRetry: true,
    });

    const retryOrderId = retryResult?.orderid || retryResult?.order_id;
    this._scheduleFinalCheck({
      instance,
      orderId: retryOrderId || orderId,
      strategy,
      context,
      payload,
      initialLimitPrice: retryPayload.price,
      bufferPoints,
      bufferPct,
      tickSize,
      allowPartialRetry,
      repeatUntilClosed: resolvedRepeat,
      ignoreSlippage: resolvedIgnore,
    });
  }

  _scheduleFinalCheck({
    instance,
    orderId,
    strategy = null,
    context = {},
    payload = null,
    initialLimitPrice = null,
    bufferPoints = 0,
    bufferPct = null,
    tickSize = null,
    allowPartialRetry = true,
    repeatUntilClosed = false,
    ignoreSlippage = false,
  }) {
    if (!instance?.id || !orderId) return;
    const key = `${instance.id}:${orderId}:final`;
    if (this.pendingFinal.has(key)) return;

    const timeoutId = setTimeout(() => {
      this.pendingFinal.delete(key);
      this._handleFinalCheck({
        instance,
        orderId,
        strategy,
        context,
        payload,
        initialLimitPrice,
        bufferPoints,
        bufferPct,
        tickSize,
        allowPartialRetry,
        repeatUntilClosed,
        ignoreSlippage,
      }).catch((error) => {
        log.warn('Final retry check failed', { order_id: orderId, error: error.message });
      });
    }, FINAL_CHECK_DELAY_MS);

    this.pendingFinal.set(key, timeoutId);
  }

  async _handleFinalCheck({
    instance,
    orderId,
    strategy,
    context,
    payload,
    initialLimitPrice,
    bufferPoints,
    bufferPct,
    tickSize,
    allowPartialRetry,
    repeatUntilClosed,
    ignoreSlippage,
  }) {
    const snapshot = await marketDataFeedService.getOrderbookSnapshot(instance.id, { force: true });
    const raw = snapshot?.data || [];
    const orders = Array.isArray(raw) ? raw : raw.orders || raw.data || [];
    const order = orders.find((o) => {
      const id = o.orderid || o.order_id || o.id;
      return id && String(id) === String(orderId);
    });

    if (!order) {
      if (repeatUntilClosed && payload) {
        const positionMatch = await this._positionMatchesTarget(instance, payload);
        if (positionMatch) {
          log.info('Final check skipped - target position reached', {
            instance_id: instance.id,
            order_id: orderId,
            target_position: payload.position_size,
          });
          return;
        }
        log.info('Final check retrying - order not found', {
          instance_id: instance.id,
          order_id: orderId,
        });
        await this._handleRetry({
          instance,
          payload,
          orderId,
          initialLimitPrice: initialLimitPrice || payload.price,
          bufferPoints,
          bufferPct,
          tickSize,
          strategy,
          context,
          allowPartialRetry,
          repeatUntilClosed,
          ignoreSlippage,
        });
        return;
      }
      log.info('Final check skipped - order not found in orderbook', {
        instance_id: instance.id,
        order_id: orderId,
      });
      return;
    }

    const statusRaw = (order.order_status || order.status || '').toString().toLowerCase();
    const normalizedStatus = this._normalizeStatus(statusRaw);
    if (['complete', 'filled'].includes(normalizedStatus)) {
      log.info('Final check skipped - order already filled', {
        instance_id: instance.id,
        order_id: orderId,
      });
      return;
    }

    if (repeatUntilClosed && payload) {
      const positionMatch = await this._positionMatchesTarget(instance, payload);
      if (positionMatch) {
        log.info('Final check skipped - target position reached', {
          instance_id: instance.id,
          order_id: orderId,
          target_position: payload.position_size,
        });
        return;
      }
      log.info('Final check retrying until closed', {
        instance_id: instance.id,
        order_id: orderId,
        status: normalizedStatus,
      });
      await this._handleRetry({
        instance,
        payload,
        orderId,
        initialLimitPrice: initialLimitPrice || payload.price,
        bufferPoints,
        bufferPct,
        tickSize,
        strategy,
        context,
        allowPartialRetry,
        repeatUntilClosed,
        ignoreSlippage,
      });
      return;
    }

    await this._cancelAll(instance.id, strategy);
    log.info('Final check cancelled open/pending orders', {
      instance_id: instance.id,
      order_id: orderId,
      status: normalizedStatus,
    });
  }

  async _cancelAll(instanceId, strategy) {
    try {
      await orderService.cancelAllOrders(instanceId, strategy);
    } catch (error) {
      log.warn('Failed to cancel all orders before retry', {
        instance_id: instanceId,
        error: error.message,
      });
    }
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

  _extractFilledQty(order) {
    const candidates = [
      order.filled_quantity,
      order.filledqty,
      order.filled_qty,
      order.filled,
      order.traded_qty,
      order.traded_quantity,
    ];
    for (const value of candidates) {
      const num = typeof value === 'string' ? parseFloat(value) : value;
      if (Number.isFinite(num) && num > 0) {
        return num;
      }
    }
    return 0;
  }

  _extractOrderQty(order, payload) {
    const candidates = [
      order.quantity,
      order.qty,
      order.order_quantity,
      order.order_qty,
      order.total_quantity,
    ];
    for (const value of candidates) {
      const num = typeof value === 'string' ? parseFloat(value) : value;
      if (Number.isFinite(num) && num > 0) {
        return num;
      }
    }
    const fallback = payload?.quantity;
    const num = typeof fallback === 'string' ? parseFloat(fallback) : fallback;
    return Number.isFinite(num) && num > 0 ? num : 0;
  }

  _remainingForTarget(action, currentPosition, targetPosition) {
    if (!Number.isFinite(currentPosition) || !Number.isFinite(targetPosition)) return null;
    const delta = targetPosition - currentPosition;
    const side = (action || '').toUpperCase();
    if (side === 'BUY' || side === 'COVER') {
      return Math.max(delta, 0);
    }
    if (side === 'SELL' || side === 'SHORT') {
      return Math.max(-delta, 0);
    }
    return Math.max(Math.abs(delta), 0);
  }

  _sumOpenOrders(orders, payload) {
    if (!Array.isArray(orders) || !payload?.symbol || !payload?.exchange) return 0;
    const targetSymbol = this._normalizeSymbol(payload.symbol);
    const targetExchange = this._normalizeExchange(payload.exchange);
    const targetSide = (payload.action || '').toUpperCase();
    const targetProduct = this._normalizeProduct(payload.product);
    const openStatuses = new Set(['open', 'pending', 'trigger_pending', 'partial']);

    let total = 0;
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
      const side = (order.action || order.side || order.transaction_type || '').toString().toUpperCase();
      if (targetSide && side && side !== targetSide) {
        continue;
      }
      const qty = this._extractOrderQty(order, payload);
      total += qty;
    }
    return total;
  }

  async _cancelOpenOrdersForSymbol(instance, orders, payload, strategy) {
    if (!instance?.id || !Array.isArray(orders)) return;
    if (!payload?.symbol || !payload?.exchange) return;

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

    const strategyTag = strategy || payload.strategy || 'default';
    for (const orderId of toCancel) {
      try {
        await openalgoClient.cancelOrder(instance, orderId, strategyTag);
      } catch (error) {
        log.warn('Failed to cancel open order', {
          instance_id: instance.id,
          order_id: orderId,
          error: error.message,
        });
      }
    }
  }

  async _inferRetryPolicy(instance, payload) {
    const targetPosition = this._parseNumber(payload?.position_size);
    if (targetPosition === null) {
      return { repeatUntilClosed: false, ignoreSlippage: false };
    }

    const currentPosition = await this._getLivePosition(instance, payload);
    if (currentPosition === null) {
      return { repeatUntilClosed: false, ignoreSlippage: false };
    }

    const reduceExit = this._isReducingPosition(currentPosition, targetPosition);
    return {
      repeatUntilClosed: reduceExit,
      ignoreSlippage: reduceExit,
    };
  }

  async _positionMatchesTarget(instance, payload) {
    const targetPosition = this._parseNumber(payload?.position_size);
    if (targetPosition === null) return false;
    const currentPosition = await this._getLivePosition(instance, payload);
    if (currentPosition === null) return false;
    return currentPosition === targetPosition;
  }

  _isReducingPosition(currentPosition, targetPosition) {
    if (!Number.isFinite(currentPosition) || !Number.isFinite(targetPosition)) return false;
    if (currentPosition === 0) return false;
    if (targetPosition === 0) return true;
    if (Math.sign(currentPosition) !== Math.sign(targetPosition)) return true;
    return Math.abs(targetPosition) < Math.abs(currentPosition);
  }

  async _getLivePosition(instance, payload) {
    if (!instance?.id || !payload?.symbol || !payload?.exchange) return null;
    let positions = [];
    try {
      positions = await openalgoClient.getPositionBook(instance);
    } catch (error) {
      log.warn('Live positionbook fetch failed', {
        instance_id: instance.id,
        error: error.message,
      });
      return null;
    }
    if (!Array.isArray(positions) || positions.length === 0) return null;

    const targetSymbol = this._normalizeSymbol(payload.symbol);
    const targetExchange = this._normalizeExchange(payload.exchange);
    const targetProduct = this._normalizeProduct(payload.product);

    for (const position of positions) {
      const symbol = this._normalizeSymbol(
        position.symbol || position.tradingsymbol || position.trading_symbol
      );
      const exchange = this._normalizeExchange(position.exchange || position.exch || position.brexchange);
      const product = this._normalizeProduct(position.product || position.producttype);
      if (symbol !== targetSymbol || exchange !== targetExchange) {
        continue;
      }
      if (targetProduct && product && product !== targetProduct) {
        continue;
      }
      return this._extractPositionQty(position);
    }

    return 0;
  }

  _extractPositionQty(position) {
    const candidates = [
      position.quantity,
      position.netqty,
      position.net_quantity,
      position.net,
      position.netQty,
    ];
    for (const value of candidates) {
      const num = typeof value === 'string' ? parseFloat(value) : value;
      if (Number.isFinite(num)) {
        return num;
      }
    }
    return 0;
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

  _parseNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const num = typeof value === 'string' ? parseFloat(value) : value;
    return Number.isFinite(num) ? num : null;
  }

  _applyBufferAndTick({ ltp, side, bufferPoints, bufferPct, tickSize }) {
    let buffer = Number(bufferPoints) || 0;
    if ((!buffer || buffer <= 0) && Number.isFinite(bufferPct) && bufferPct > 0) {
      buffer = ltp * (bufferPct / 100);
    }
    let price = (side || '').toUpperCase() === 'BUY'
      ? ltp + buffer
      : ltp - buffer;
    if (!Number.isFinite(price) || price <= 0) {
      price = ltp;
    }
    const tick = typeof tickSize === 'string' ? parseFloat(tickSize) : tickSize;
    if (!Number.isFinite(tick) || tick <= 0) {
      return Number(price.toFixed(2));
    }
    const ticks = price / tick;
    const roundedTicks = (side || '').toUpperCase() === 'BUY'
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
}

const orderRetryService = new OrderRetryService();
export default orderRetryService;
