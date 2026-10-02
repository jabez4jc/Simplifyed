import { log } from '../core/logger.js';
import marketDataFeedService from './market-data-feed.service.js';
import orderPlacementService from './order-placement.service.js';
import openalgoClient from '../integrations/openalgo/client.js';
import { getLivePosition, cancelOpenOrdersForSymbol, applyBufferAndTick, normalizeOrderStatus } from '../utils/order-helpers.js';
import openalgoWsService from './openalgo-ws.service.js';
import { extractLtp } from '../utils/price-extraction.js';
import { normalizeSymbolKey, normalizeExchange, normalizeProduct } from '../utils/symbol-parsing.util.js';

const RETRY_DELAY_MS = 5000;
const FINAL_CHECK_DELAY_MS = 5000;
const MAX_SLIPPAGE_PCT = 0.005;
// Hard cap on cancel-and-replace cycles: bounds worst-case duplicate exposure to at most
// (1 original + MAX_RETRY_ATTEMPTS) orders even if a race condition slips past the order-status
// check below, instead of the retry<->final-check ping-pong repeating indefinitely.
const MAX_RETRY_ATTEMPTS = 1;

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
    attempt = 0,
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
        attempt,
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
    attempt = 0,
  }) {
    // Hard cap: never place more than (1 original + MAX_RETRY_ATTEMPTS) orders for the same
    // intended trade, regardless of how the position/orderbook checks below resolve.
    if (attempt >= MAX_RETRY_ATTEMPTS) {
      log.info('Retry skipped - max retry attempts reached', {
        instance_id: instance.id, order_id: orderId, attempt,
      });
      return;
    }

    const snapshot = await marketDataFeedService.getOrderbookSnapshot(instance.id, { force: true });
    const raw = snapshot?.data || [];
    const orders = Array.isArray(raw) ? raw : raw.orders || raw.data || [];
    const order = orders.find((o) => {
      const id = o.orderid || o.order_id || o.id;
      return id && String(id) === String(orderId);
    });

    if (!order) {
      // An order missing from the open-orders list almost always means it reached a terminal
      // state (filled, rejected, or cancelled) - NOT that it silently vanished and still needs
      // placing. Confirm via the order's own status before ever placing a replacement: inferring
      // "not yet filled" from a live position-book snapshot is unreliable (broker-side position
      // updates can lag a fill by more than this retry's poll interval), and treating that lag as
      // "still needs placing" is exactly what caused duplicate full-quantity orders here before.
      // Mirrors AlgoMirror's principle: an uncertain/timeout outcome is never auto-retried,
      // because retrying an order that actually went through risks a duplicate fill.
      const confirmedStatus = await this._confirmOrderStatus(instance, orderId, strategy);
      if (confirmedStatus === 'filled') {
        log.info('Retry skipped - order status confirms already filled', {
          instance_id: instance.id, order_id: orderId,
        });
        return;
      }
      if (confirmedStatus === 'uncertain') {
        log.warn('Retry skipped - could not confirm order status, avoiding possible duplicate', {
          instance_id: instance.id, order_id: orderId,
        });
        return;
      }
      // confirmedStatus === 'rejected' (or 'cancelled') from here on - genuinely safe to retry.

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
      : await getLivePosition(instance, payload);
    const pendingQty = this._sumOpenOrders(orders, payload);
    const remainingNeeded = targetPosition === null || currentPosition === null
      ? null
      : this._remainingForTarget(payload?.action, currentPosition, targetPosition);
    const remainingAfterPending = remainingNeeded === null
      ? null
      : Math.max(remainingNeeded - pendingQty, 0);
    const remainingForRetry = remainingNeeded;

    if (remainingAfterPending !== null && remainingAfterPending <= 0) {
      await cancelOpenOrdersForSymbol(instance, orders, payload, strategy);
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
      normalizedStatus = normalizeOrderStatus(statusRaw);
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
        await cancelOpenOrdersForSymbol(instance, orders, payload, strategy);
      }
    }

    const exchange = payload.exchange;
    const symbol = payload.symbol;
    const side = payload.action;

    const ltpResult = await marketDataFeedService.fetchLtpForSymbol(exchange, symbol, {
      orderCritical: true,
      forOrder: true,
    });
    const ltp = ltpResult?.ltp || extractLtp(ltpResult?.quote, { forOrder: true });
    if (!ltp || ltp <= 0) {
      await cancelOpenOrdersForSymbol(instance, orders, payload, strategy);
      log.warn('Retry cancelled - no LTP available', {
        instance_id: instance.id,
        order_id: orderId,
      });
      if (resolvedRepeat) {
        this._scheduleFinalCheck({
          instance,
          orderId,
          strategy,
          context,
          payload,
          initialLimitPrice: initialLimitPrice || payload.price,
          bufferPoints,
          bufferPct,
          tickSize,
          allowPartialRetry,
          repeatUntilClosed: resolvedRepeat,
          ignoreSlippage: resolvedIgnore,
        });
      }
      return;
    }

    const initialPrice = Number(initialLimitPrice || payload.price || 0);
    if (!Number.isFinite(initialPrice) || initialPrice <= 0) {
      await cancelOpenOrdersForSymbol(instance, orders, payload, strategy);
      log.warn('Retry cancelled - invalid initial limit price', {
        instance_id: instance.id,
        order_id: orderId,
      });
      if (resolvedRepeat) {
        this._scheduleFinalCheck({
          instance,
          orderId,
          strategy,
          context,
          payload,
          initialLimitPrice: initialLimitPrice || payload.price,
          bufferPoints,
          bufferPct,
          tickSize,
          allowPartialRetry,
          repeatUntilClosed: resolvedRepeat,
          ignoreSlippage: resolvedIgnore,
        });
      }
      return;
    }

    if (!resolvedIgnore) {
      const slippage = Math.abs(initialPrice - ltp) / ltp;
      if (slippage > MAX_SLIPPAGE_PCT) {
        await cancelOpenOrdersForSymbol(instance, orders, payload, strategy);
        log.warn('Retry cancelled - slippage threshold exceeded', {
          instance_id: instance.id,
          order_id: orderId,
          slippage_pct: slippage,
        });
        if (resolvedRepeat) {
          this._scheduleFinalCheck({
            instance,
            orderId,
            strategy,
            context,
            payload,
            initialLimitPrice: initialLimitPrice || payload.price,
            bufferPoints,
            bufferPct,
            tickSize,
            allowPartialRetry,
            repeatUntilClosed: resolvedRepeat,
            ignoreSlippage: resolvedIgnore,
          });
        }
        return;
      }
    }

    await cancelOpenOrdersForSymbol(instance, orders, payload, strategy);

    let depthBasePrice = null;
    let depthPriceSource = null;
    try {
      const depthResult = await marketDataFeedService.fetchDepthForSymbol(exchange, symbol);
      const depthBid = this._parseNumber(depthResult?.bid);
      const depthAsk = this._parseNumber(depthResult?.ask);
      if ((side || '').toUpperCase() === 'BUY' && Number.isFinite(depthAsk) && depthAsk > 0) {
        depthBasePrice = depthAsk;
        depthPriceSource = 'depth_ask';
      } else if ((side || '').toUpperCase() === 'SELL' && Number.isFinite(depthBid) && depthBid > 0) {
        depthBasePrice = depthBid;
        depthPriceSource = 'depth_bid';
      }
    } catch (error) {
      log.warn('Retry depth fetch failed; falling back to LTP', {
        instance_id: instance.id,
        order_id: orderId,
        error: error.message,
      });
    }

    const retryPrice = applyBufferAndTick({
      ltp,
      basePrice: depthBasePrice,
      side,
      bufferPoints,
      bufferPct,
      tickSize,
    });
    const retryPriceSource = depthPriceSource || 'ltp';

    const retryPayload = {
      ...payload,
      pricetype: 'LIMIT',
      price: retryPrice,
    };
    const cappedQty = remainingForRetry !== null
      ? remainingForRetry
      : null;
    const finalQty = retryQuantity !== null
      ? (cappedQty !== null ? Math.min(retryQuantity, cappedQty) : retryQuantity)
      : cappedQty;
    if (finalQty !== null) {
      if (finalQty <= 0) {
        await cancelOpenOrdersForSymbol(instance, orders, payload, strategy);
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
      retry_price_source: retryPriceSource,
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
      attempt: attempt + 1,
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
    attempt = 0,
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
        attempt,
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
    attempt = 0,
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
          attempt,
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
    const normalizedStatus = normalizeOrderStatus(statusRaw);
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
        attempt,
      });
      return;
    }

    await cancelOpenOrdersForSymbol(instance, orders, payload, strategy);
    log.info('Final check cancelled open/pending orders for symbol', {
      instance_id: instance.id,
      order_id: orderId,
      status: normalizedStatus,
    });
  }

  /**
   * Authoritative check for a specific order_id, used only when the order has already dropped
   * out of the open-orders list (so "still open" isn't an option). Returns 'filled' (definite -
   * do not retry), 'rejected' (definite - safe to place a replacement), or 'uncertain' (API
   * failure or an unrecognized/ambiguous status - do not retry, since retrying an order that
   * actually filled would duplicate it).
   */
  async _confirmOrderStatus(instance, orderId, strategy) {
    // Fast path: the OpenAlgo order-update WebSocket may already have told us (or tell us within
    // a couple seconds) whether this order filled or was rejected. Skips a REST call that can
    // itself time out or fail - exactly the failure mode that produces 'uncertain' below - and on
    // a cache hit (the common case, since this runs after the order already dropped out of the
    // open-orders list) it's instant. A non-definitive pushed status (open/partial/etc) falls
    // through to the REST check same as if nothing had arrived - this can only ever answer faster
    // or the same as before, never worse.
    try {
      const pushed = await openalgoWsService.waitForOrderUpdate(orderId, 1500);
      if (pushed) {
        const pushedNormalized = normalizeOrderStatus((pushed.order_status || '').toString().toLowerCase());
        if (pushedNormalized === 'complete') return 'filled';
        if (pushedNormalized === 'rejected' || pushedNormalized === 'cancelled') return 'rejected';
      }
    } catch (error) {
      log.warn('WS order-update fast path failed, falling back to REST', { instance_id: instance?.id, order_id: orderId, error: error.message });
    }

    try {
      const response = await openalgoClient.getOrderStatus(instance, {
        orderid: orderId,
        strategy: strategy || undefined,
      });
      const statusRaw = (response?.order_status || response?.status || '').toString().toLowerCase();
      const normalized = normalizeOrderStatus(statusRaw);
      if (normalized === 'complete') return 'filled';
      if (normalized === 'rejected' || normalized === 'cancelled') return 'rejected';
      return 'uncertain';
    } catch (error) {
      log.warn('Order status confirmation failed', { instance_id: instance?.id, order_id: orderId, error: error.message });
      return 'uncertain';
    }
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
    const targetSymbol = normalizeSymbolKey(payload.symbol);
    const targetExchange = normalizeExchange(payload.exchange);
    const targetSide = (payload.action || '').toUpperCase();
    const targetProduct = normalizeProduct(payload.product);
    const openStatuses = new Set(['open', 'pending', 'trigger_pending', 'partial']);

    let total = 0;
    for (const order of orders) {
      const symbol = normalizeSymbolKey(
        order.symbol || order.tradingsymbol || order.trading_symbol
      );
      const exchange = normalizeExchange(order.exchange || order.exch || order.brexchange);
      const product = normalizeProduct(order.product || order.producttype);
      if (symbol !== targetSymbol || exchange !== targetExchange) {
        continue;
      }
      if (targetProduct && product && product !== targetProduct) {
        continue;
      }
      const statusRaw = (order.order_status || order.status || '').toString().toLowerCase();
      const status = normalizeOrderStatus(statusRaw);
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

  async _inferRetryPolicy(instance, payload) {
    const targetPosition = this._parseNumber(payload?.position_size);
    if (targetPosition === null) {
      return { repeatUntilClosed: false, ignoreSlippage: false };
    }

    const currentPosition = await getLivePosition(instance, payload);
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
    const currentPosition = await getLivePosition(instance, payload);
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




  _parseNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const num = typeof value === 'string' ? parseFloat(value) : value;
    return Number.isFinite(num) ? num : null;
  }


}

const orderRetryService = new OrderRetryService();
export default orderRetryService;
