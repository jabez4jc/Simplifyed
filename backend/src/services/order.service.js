/**
 * Order Service
 * Handles order placement (using placesmartorder), tracking, and management
 */

import db from '../core/database.js';
import { log } from '../core/logger.js';
import openalgoClient from '../integrations/openalgo/client.js';
import orderPlacementService from './order-placement.service.js';
import { getLivePosition } from '../utils/order-helpers.js';
import orderPayloadFactory from './order-payload.factory.js';
import orderRepository from './order-repository.js';
import telegramService from './telegram.service.js';
import limitPriceService from './limit-price.service.js';
import pnlSnapshotService from './pnl-snapshot.service.js';
import brokerCapabilitiesService from './broker-capabilities.service.js';
import { isDerivativeExchange, isCryptoExchange } from '../utils/broker-type.util.js';
import { toISTISOString } from '../utils/time.js';
import {
  NotFoundError,
  ValidationError,
} from '../core/errors.js';
import { normalizeSymbolKey, normalizeExchange, normalizeProduct } from '../utils/symbol-parsing.util.js';
import {
  sanitizeString,
  sanitizeSymbol,
  sanitizeExchange,
  parseFloatSafe,
  parseIntSafe,
} from '../utils/sanitizers.js';

/** Nearest whole tick; 0 stays 0 (no price / no trigger). Two decimals when the tick is unknown. */
function roundToNearestTick(value, tick) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return n;
  if (!Number.isFinite(tick) || tick <= 0) return Number(n.toFixed(2));
  const decimals = (String(tick).split('.')[1] || '').length;
  return Number((Math.round(n / tick) * tick).toFixed(decimals));
}

class OrderService {
  /**
   * Move a resting order to a new price - the chart's drag of an order line. A LIMIT moves its
   * limit; a stop moves its trigger and keeps its limit the same distance away (an SL-M, which
   * Indian exchanges never receive, is re-converted to SL exactly as at placement).
   */
  async modifyOrder(orderId, { price } = {}) {
    const order = await db.get('SELECT * FROM watchlist_orders WHERE id = ?', [orderId]);
    if (!order) throw new NotFoundError('Order');
    if (!['pending', 'open'].includes(order.status)) {
      throw new ValidationError(`Cannot move an order that is ${order.status}`);
    }
    if (!order.order_id) throw new ValidationError('The broker never acknowledged this order');
    const instance = await db.get('SELECT * FROM instances WHERE id = ?', [order.instance_id]);
    if (!instance) throw new NotFoundError('Instance');

    const tick = await limitPriceService.resolveTickSize(order.exchange, order.symbol);
    const target = roundToNearestTick(parseFloatSafe(price, null), tick);
    if (!(target > 0)) throw new ValidationError('A positive price is required');

    const type = String(order.order_type || '').toUpperCase();
    let payload = {
      strategy: instance.strategy_tag || 'default',
      exchange: order.exchange,
      symbol: order.symbol,
      action: order.side,
      orderid: order.order_id,
      product: order.product_type,
      quantity: String(order.quantity),
      disclosed_quantity: '0',
    };
    if (type === 'LIMIT') {
      payload = { ...payload, pricetype: 'LIMIT', price: target, trigger_price: 0 };
    } else if (type === 'SL') {
      const gap = (Number(order.price) || 0) - (Number(order.trigger_price) || 0);
      payload = { ...payload, pricetype: 'SL', trigger_price: target, price: roundToNearestTick(target + gap, tick) };
    } else if (type === 'SL-M') {
      payload = { ...payload, pricetype: 'SL-M', trigger_price: target, price: 0 };
      if (!isCryptoExchange(order.exchange)) {
        payload = await orderPlacementService._convertStopMarketToStopLimit(payload, { tickSize: tick });
      }
    } else {
      throw new ValidationError('Only limit and stop orders can be moved');
    }

    try {
      await openalgoClient.modifyOrder(instance, payload);
    } catch (error) {
      await this._settleFromBroker(instance, order, error);
    }
    await db.run(
      'UPDATE watchlist_orders SET price = ?, trigger_price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [Number(payload.price) || 0, Number(payload.trigger_price) || 0, orderId]
    );
    log.info('Order moved', { orderId, symbol: order.symbol, type, price: payload.price, trigger: payload.trigger_price });
    return db.get('SELECT * FROM watchlist_orders WHERE id = ?', [orderId]);
  }

  /**
   * Place order using placesmartorder (position-aware)
   * @param {Object} params - Order parameters
   * @returns {Promise<Object>} - Placed order record
   */
  async placeOrder(params) {
    const {
      instanceId,
      watchlistId,
      symbolId,
      exchange,
      symbol,
      action, // 'BUY' or 'SELL'
      quantity,
      product = 'MIS',
      pricetype = 'MARKET',
      price = 0,
      trigger_price = 0,
      user_id = null,
      source = null,
      trigger_type = null,
      request_id = null,
      correlation_id = null,
    } = params;

    let finalOrderType = pricetype;
    let finalOrderPrice = price;

    try {
      // Validate instance
      const instance = await db.get('SELECT * FROM instances WHERE id = ?', [
        instanceId,
      ]);

      if (!instance) {
        throw new NotFoundError('Instance');
      }

      // Check if instance is active
      if (!instance.is_active) {
        throw new ValidationError('Instance is not active');
      }

      // Allow analyzer mode instances to place orders

      // No target position given (the chart sends none): work it out from THIS instance's own
      // position below. A target computed by the caller from positions summed across instances
      // over-sized every instance that held less than the total.
      const ownTarget = params.position_size === undefined || params.position_size === null
        || params.position_size === '';

      // Validate required fields
      const normalized = this._normalizeOrderData(ownTarget ? { ...params, position_size: 0 } : params);
      const instanceMultiplier = Math.min(
        Math.max(parseIntSafe(instance.multiplier, 1), 1),
        999
      );
      if (instanceMultiplier !== 1) {
        normalized.quantity = normalized.quantity * instanceMultiplier;
        normalized.position_size = normalized.position_size * instanceMultiplier;
      }
      // A resting order (a price the operator chose) is a plain order, not a position target -
      // see the dispatch below - so it needs no position read.
      const resting = ['LIMIT', 'SL', 'SL-M'].includes(normalized.pricetype)
        && (normalized.price > 0 || normalized.trigger_price > 0);
      // Read once; the repeat-to-target check further down reuses it instead of a second positionbook call.
      let liveHeld;
      if (ownTarget && !resting) {
        const held = await getLivePosition(instance, normalized);
        liveHeld = held;
        if (held === null) {
          throw new ValidationError(`Could not read ${instance.name}'s position for ${normalized.symbol} - order not sent`);
        }
        normalized.position_size = normalized.action === 'BUY'
          ? held + normalized.quantity
          : held - normalized.quantity;
      }

      let bufferPoints = parseFloatSafe(params.limit_buffer_points, null);
      let tickSize = null;
      if (symbolId) {
        const symbolRow = await db.get(
          'SELECT tick_size, limit_buffer_points FROM watchlist_symbols WHERE id = ?',
          [symbolId]
        );
        if (symbolRow) {
          if (bufferPoints === null || bufferPoints === undefined) {
            bufferPoints = parseFloatSafe(symbolRow.limit_buffer_points, 0);
          }
          tickSize = symbolRow.tick_size;
        }
      }

      if (!Number.isFinite(bufferPoints)) {
        bufferPoints = 0;
      }

      // A caller-specified resting order is honoured EXACTLY as given.
      //
      // Everything below this branch exists to pick a price type on the caller's behalf: use
      // MARKET where the broker supports it, otherwise synthesise a marketable LIMIT from the
      // live quote plus a buffer. That is right for "fill this now" callers (quick orders,
      // auto-exit, retries), which is all this route ever had.
      //
      // It is catastrophic for a caller that chose a price. Without this guard a chart
      // right-click of "Buy Limit @ 64,190.76" arrived here and was rewritten to
      // pricetype: MARKET, price: 0 - executing immediately at whatever the market was, instead
      // of resting where the operator put it. Silently turning a resting order into an
      // immediate fill is the worst possible failure mode for an order router.
      const RESTING_TYPES = ['LIMIT', 'SL', 'SL-M'];
      const callerChosePrice = RESTING_TYPES.includes(normalized.pricetype)
        && (normalized.price > 0 || normalized.trigger_price > 0);

      const supportsMarketOrders = callerChosePrice
        ? null // not consulted - the caller's price type stands
        : await brokerCapabilitiesService.supportsMarketOrders(instance.broker, normalized.exchange);

      if (callerChosePrice) {
        // The price is the operator's; only its tick is ours. A click on the chart lands
        // between ticks (64,190.76), and the exchange rejects an off-tick price.
        const tick = await limitPriceService.resolveTickSize(normalized.exchange, normalized.symbol, tickSize);
        normalized.price = roundToNearestTick(normalized.price, tick);
        normalized.trigger_price = roundToNearestTick(normalized.trigger_price, tick);
        log.info('Honouring caller-specified resting order', {
          symbol: normalized.symbol,
          pricetype: normalized.pricetype,
        });
      } else if (supportsMarketOrders) {
        normalized.pricetype = 'MARKET';
        normalized.price = 0;
      } else {
        // Fill-now caller: price a marketable LIMIT off the quote. With no price, Indian
        // exchanges refuse (SEBI limit-only); crypto may go MARKET. See resolveMarketablePricing.
        const pricing = await limitPriceService.resolveMarketablePricing({
          instanceId,
          exchange: normalized.exchange,
          symbol: normalized.symbol,
          side: normalized.action,
          bufferPoints,
          tickSize,
        });

        normalized.pricetype = pricing.pricetype;
        normalized.price = pricing.price;
      }

      finalOrderType = normalized.pricetype;
      finalOrderPrice = normalized.price;

      const currentPosition = callerChosePrice ? null : (liveHeld !== undefined ? liveHeld : await getLivePosition(instance, normalized));
      // A resting order at a price the operator chose must REST. The retry service exists to
      // chase fill-now LIMIT orders: it cancels an unfilled one and re-places it nearer the
      // market, which turned a chart "Buy Limit @ X" below the market into a fill at market (or
      // a cancellation) within seconds.
      const repeatUntilClosed = !callerChosePrice && this._shouldRepeatToTarget(
        currentPosition,
        normalized.position_size
      );

      // Build order data for OpenAlgo
      const orderData = orderPayloadFactory.buildEquityOrder({
        strategy: instance.strategy_tag || 'default',
        exchange: normalized.exchange,
        symbol: normalized.symbol,
        action: normalized.action,
        quantity: normalized.quantity,
        position_size: normalized.position_size,
        product: normalized.product,
        pricetype: normalized.pricetype,
        price: normalized.price,
        trigger_price: normalized.trigger_price,
      });

      // Place order via OpenAlgo
      log.info('Placing order', {
        instance_id: instanceId,
        symbol: normalized.symbol,
        action: normalized.action,
        quantity: normalized.quantity,
      });

      // A price the operator chose goes out as a plain resting order (placeorder). As a smart
      // order it was a position target: OpenAlgo's analyzer filled a buy limit placed at half the
      // market on the spot, the placement queue could merge two limits on one symbol into one,
      // and the retry service chased or cancelled it. placeorder rests where it was put.
      const response = callerChosePrice
        ? await orderPlacementService.placeRestingOrder(instance, orderData, { request_type: 'MANUAL_ORDER', correlation_id, tickSize })
        : await orderPlacementService.placeSmartOrder(instance, orderData, {
        request_type: 'MANUAL_ORDER',
        base_symbol: normalized.symbol,
        trade_mode: 'DIRECT',
        exchange: normalized.exchange,
        correlation_id,
        limitBufferPoints: bufferPoints,
        tickSize,
        strategy: orderData.strategy,
        repeatUntilClosed,
        ignoreSlippage: repeatUntilClosed,
        skipRetry: callerChosePrice,
      });

      // Extract order ID from response
      const orderId = response.orderid || response.order_id || null;

      // Save order to database via repository
      const insertedId = await orderRepository.insertWatchlistOrder({
        watchlistId,
        instanceId,
        symbolId,
        exchange: normalized.exchange,
        symbol: normalized.symbol,
        side: normalized.action,
        quantity: normalized.quantity,
        orderType: finalOrderType,
        productType: normalized.product,
        price: finalOrderPrice,
        trigger_price: normalized.trigger_price,
        status: 'pending',
        orderId,
        message: response.message || 'Order placed',
        metadata: response,
        user_id,
        source,
        trigger_type,
        request_id,
        correlation_id,
      });

      const order = await db.get(
        'SELECT * FROM watchlist_orders WHERE id = ?',
        [insertedId]
      );

      log.info('Order placed successfully', {
        id: order.id,
        order_id: orderId,
        symbol: normalized.symbol,
      });

      // A limit through the market fills on the spot, and a broker that pushes no order update
      // (Delta's analyzer) leaves the row "pending" until the 3-minute sweep - a phantom working
      // order on the chart. One look shortly after placement settles the common case.
      if (callerChosePrice) {
        setTimeout(() => this.syncOrderStatus(instanceId).catch(() => {}), 2000).unref?.();
      }

      if (!instance.is_analyzer_mode) {
        const isWebhook = source === 'webhook';
        const signalCounts = normalized.action === 'BUY'
          ? (isWebhook ? { webhook_buy_signals: 1 } : { manual_buy_signals: 1 })
          : (isWebhook ? { webhook_sell_signals: 1 } : { manual_sell_signals: 1 });
        pnlSnapshotService.incrementSignalCounts(instance.id, signalCounts).catch(() => {});
      }

      // Fire-and-forget Telegram notification for manual/direct orders
      telegramService
        .sendOrderNotification(order, {
          type: 'ORDER',
          instance_name: instance.name,
        })
        .catch((err) => log.warn('telegram_notify_failed', { error: err.message }));

      return order;
    } catch (error) {
      log.error('Failed to place order', error, { params });

      // Save failed order to database
      try {
        await db.run(
          `INSERT INTO watchlist_orders (
            watchlist_id, instance_id, symbol_id,
            exchange, symbol, side, quantity,
            order_type, product_type, price, trigger_price,
            status, message,
            user_id, source, trigger_type, request_id, correlation_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            watchlistId || null,
            instanceId,
            symbolId || null,
            exchange,
            symbol,
            action,
            quantity,
          finalOrderType ?? pricetype,
          product,
          finalOrderPrice ?? price,
            trigger_price,
            'failed',
            error.message,
            user_id,
            source,
            trigger_type,
            request_id,
            correlation_id,
          ]
        );
      } catch (dbError) {
        log.error('Failed to save failed order', dbError);
      }

      throw error;
    }
  }

  _shouldRepeatToTarget(currentPosition, targetPosition) {
    if (!Number.isFinite(currentPosition) || !Number.isFinite(targetPosition)) {
      return false;
    }
    if (currentPosition === 0) return false;
    if (targetPosition === 0) return true;
    if (Math.sign(currentPosition) !== Math.sign(targetPosition)) return true;
    return Math.abs(targetPosition) < Math.abs(currentPosition);
  }

  _normalizeSymbol(symbol) {
    return normalizeSymbolKey(symbol);
  }

  _normalizeExchange(exchange) {
    return normalizeExchange(exchange);
  }

  _normalizeProduct(product) {
    return normalizeProduct(product);
  }

  /**
   * Cancel order
   * @param {number} orderId - Order ID from database
   * @returns {Promise<Object>} - Updated order
   */
  async cancelOrder(orderId) {
    try {
      // Get order from database
      const order = await db.get(
        'SELECT * FROM watchlist_orders WHERE id = ?',
        [orderId]
      );

      if (!order) {
        throw new NotFoundError('Order');
      }

      // Check if order can be cancelled
      if (['complete', 'cancelled', 'rejected'].includes(order.status)) {
        throw new ValidationError(
          `Cannot cancel order with status: ${order.status}`
        );
      }

      // Get instance
      const instance = await db.get('SELECT * FROM instances WHERE id = ?', [
        order.instance_id,
      ]);

      if (!instance) {
        throw new NotFoundError('Instance');
      }

      // Cancel via OpenAlgo
      log.info('Cancelling order', {
        order_id: order.id,
        broker_order_id: order.order_id,
      });

      try {
        await openalgoClient.cancelOrder(
          instance,
          order.order_id,
          instance.strategy_tag || 'default'
        );
      } catch (error) {
        await this._settleFromBroker(instance, order, error);
      }

      // Update order status
      await db.run(
        `UPDATE watchlist_orders
         SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [orderId]
      );

      const updatedOrder = await db.get(
        'SELECT * FROM watchlist_orders WHERE id = ?',
        [orderId]
      );

      log.info('Order cancelled', { order_id: orderId });

      return updatedOrder;
    } catch (error) {
      if (
        error instanceof NotFoundError ||
        error instanceof ValidationError
      ) {
        throw error;
      }
      log.error('Failed to cancel order', error, { orderId });
      throw error;
    }
  }

  /**
   * Cancel all orders for an instance
   * @param {number} instanceId - Instance ID
   * @param {string} strategy - Strategy tag (optional)
   * @returns {Promise<Object>} - Result summary
   */
  async cancelAllOrders(instanceId, strategy = null) {
    try {
      // Get instance
      const instance = await db.get('SELECT * FROM instances WHERE id = ?', [
        instanceId,
      ]);

      if (!instance) {
        throw new NotFoundError('Instance');
      }

      // Get pending orders
      const pendingOrders = await db.all(
        `SELECT * FROM watchlist_orders
         WHERE instance_id = ? AND status IN ('pending', 'open')`,
        [instanceId]
      );

      // Cancel via OpenAlgo
      const strategyTag = strategy || instance.strategy_tag || 'default';

      log.info('Cancelling all orders', {
        instance_id: instanceId,
        strategy: strategyTag,
        count: pendingOrders.length,
      });

      await openalgoClient.cancelAllOrders(instance, strategyTag);

      // Do not blanket-mark every local row cancelled: the broker only guarantees it accepted
      // the account-wide cancel, not that every one of these specific orders was still open to
      // cancel (one may have filled a moment earlier). Read the actual outcome back from the
      // orderbook, the same reconciliation the regular poller runs.
      setTimeout(() => this.syncOrderStatus(instanceId).catch(() => {}), 2000).unref?.();

      log.info('All orders cancelled', {
        instance_id: instanceId,
        count: pendingOrders.length,
      });

      return {
        cancelled_count: pendingOrders.length,
        orders: pendingOrders.map(o => o.id),
      };
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      log.error('Failed to cancel all orders', error, { instanceId, strategy });
      throw error;
    }
  }

  async cancelPendingOrdersForSymbol(instanceId, symbol) {
    if (!symbol) {
      return { cancelled: 0, total: 0 };
    }

    // Only rows the broker knows about. A local row can sit 'pending' without a broker order id
    // (e.g. a response that carried none); cancelling it sent orderid:null, which the broker
    // rejects ("Field may not be null") on every EXIT.
    const pending = await db.all(
      `SELECT id FROM watchlist_orders
       WHERE instance_id = ? AND symbol = ? AND status IN ('pending', 'open')
         AND order_id IS NOT NULL AND order_id != ''`,
      [instanceId, symbol]
    );

    let cancelledCount = 0;
    for (const order of pending) {
      try {
        await this.cancelOrder(order.id);
        cancelledCount += 1;
      } catch (cancelError) {
        log.warn('Failed to cancel pending symbol order', {
          instance_id: instanceId,
          symbol,
          order_id: order.id,
          error: cancelError.message,
        });
      }
    }

    return { cancelled: cancelledCount, total: pending.length };
  }

  /**
   * Get orders with filters
   * @param {Object} filters - Filter options
   * @returns {Promise<Array>} - List of orders
   */
  async getOrders(filters = {}) {
    try {
      let query = `
        SELECT
          wo.*,
          i.name as instance_name,
          i.broker as instance_broker,
          i.is_analyzer_mode as instance_analyzer,
          w.name as watchlist_name
        FROM watchlist_orders wo
        JOIN instances i ON wo.instance_id = i.id
        LEFT JOIN watchlists w ON wo.watchlist_id = w.id
        WHERE 1=1
      `;
      const params = [];

      if (filters.instanceId) {
        query += ' AND wo.instance_id = ?';
        params.push(filters.instanceId);
      }

      if (filters.watchlistId) {
        query += ' AND wo.watchlist_id = ?';
        params.push(filters.watchlistId);
      }

      if (filters.status) {
        // Comma-separated means any of them: the chart asks for "open,pending" - a stop waiting
        // for its trigger, and any order not yet synced from the broker, is 'pending'.
        const statuses = String(filters.status).split(',').map((v) => v.trim()).filter(Boolean);
        query += ` AND wo.status IN (${statuses.map(() => '?').join(', ')})`;
        params.push(...statuses);
      }

      if (filters.symbol) {
        query += ' AND wo.symbol = ?';
        params.push(filters.symbol);
      }

      if (filters.side) {
        query += ' AND wo.side = ?';
        params.push(filters.side);
      }

      query += ' ORDER BY wo.placed_at DESC LIMIT 1000';

      const orders = await db.all(query, params);
      return orders;
    } catch (error) {
      log.error('Failed to get orders', error, { filters });
      throw error;
    }
  }

  /**
   * Update order status from OpenAlgo orderbook
   * @param {number} instanceId - Instance ID
   * @returns {Promise<Object>} - Update summary
   */
  async syncOrderStatus(instanceId) {
    // Declared outside the try so the catch below can still read it. It was previously a
    // `const` inside the try block, which is block-scoped - so the catch's `instance?.name`
    // threw ReferenceError instead of logging, replacing every real failure here with a
    // misleading "instance is not defined" and discarding the original error.
    let instance = null;
    try {
      // Get instance
      instance = await db.get('SELECT * FROM instances WHERE id = ?', [
        instanceId,
      ]);

      if (!instance) {
        throw new NotFoundError('Instance');
      }

      // Get pending orders from database first (cheap local query) - only hit the broker's
      // orderbook endpoint if there's actually something to reconcile. Avoids an unconditional
      // broker call every poll cycle for instances with no open orders.
      const pendingOrders = await db.all(
        `SELECT * FROM watchlist_orders
         WHERE instance_id = ? AND status IN ('pending', 'open')`,
        [instanceId]
      );

      if (!pendingOrders.length) {
        return { checked: 0, updated: 0, skipped: 'no_pending_orders' };
      }

      // Get orderbook from OpenAlgo
      const orderbook = await openalgoClient.getOrderBook(instance);

      let updatedCount = 0;
      const todayIst = toISTISOString().slice(0, 10);

      // Update order statuses
      for (const dbOrder of pendingOrders) {
        // Find matching order in orderbook
        const brokerOrder = orderbook.find(
          o => o.orderid === dbOrder.order_id || o.order_id === dbOrder.order_id
        );

        if (brokerOrder) {
          const status = this._mapOrderStatus(
            brokerOrder.status || brokerOrder.order_status
          );

          if (status !== dbOrder.status) {
            // Only over a row still working: the book was read after the rows were, so a cancel
            // or a fill recorded in between is newer than it. Unguarded, a book fetched a moment
            // before a cancel landed wrote 'open' over 'cancelled', and the cancelled order came
            // back on the chart as a line that could be neither moved nor cancelled.
            await db.run(
              `UPDATE watchlist_orders
               SET status = ?, broker_order_id = ?, metadata = ?, updated_at = CURRENT_TIMESTAMP
               WHERE id = ? AND status IN ('pending', 'open')`,
              [
                status,
                brokerOrder.orderid || brokerOrder.order_id,
                JSON.stringify(brokerOrder),
                dbOrder.id,
              ]
            );
            updatedCount++;
          }
        } else if (dbOrder.order_id && !isCryptoExchange(dbOrder.exchange)
          && toISTISOString(new Date(`${String(dbOrder.placed_at).replace(' ', 'T')}Z`)).slice(0, 10) < todayIst) {
          // An Indian exchange order is a DAY order, and a broker's book lists today's session
          // only. One from an earlier session that the book no longer has lapsed at the close;
          // left 'open' it stayed on the chart as a line no modify could ever reach (seen on a
          // BANKNIFTY future placed at 21:16 the night before).
          await db.run(
            `UPDATE watchlist_orders
             SET status = 'cancelled', message = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status IN ('pending', 'open')`,
            ['Expired: a day order from an earlier session, no longer in the broker book', dbOrder.id]
          );
          updatedCount++;
        }
      }

      log.info('Order status synced', {
        instance_id: instanceId,
        instance_name: instance?.name,
        updated_count: updatedCount,
      });

      return {
        checked: pendingOrders.length,
        updated: updatedCount,
      };
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      log.error('Failed to sync order status', error, { instance_id: instanceId, instance_name: instance?.name });
      throw error;
    }
  }

  /**
   * Apply one pushed `order_update` (OpenAlgo WebSocket, see openalgo-ws.service.js) to the
   * stored order it refers to - the push-driven counterpart of syncOrderStatus, without the
   * orderbook round trip. Only pending/open rows move, so a late or duplicate event can never
   * reopen an order that has already reached a final status.
   * @returns {Promise<boolean>} whether a row changed
   */
  async applyOrderUpdate(instanceId, order) {
    const orderId = order?.orderid;
    if (!orderId) return false;
    const status = this._mapOrderStatus(order.order_status);
    const result = await db.run(
      `UPDATE watchlist_orders
       SET status = ?, broker_order_id = ?, metadata = ?, updated_at = CURRENT_TIMESTAMP
       WHERE instance_id = ? AND (order_id = ? OR broker_order_id = ?)
         AND status IN ('pending', 'open') AND status != ?`,
      [status, orderId, JSON.stringify(order), instanceId, orderId, orderId, status]
    );
    return (result?.changes || 0) > 0;
  }

  /**
   * A cancel or a move the broker refused: when the broker already holds the order in a final
   * state (filled, cancelled elsewhere, rejected), record that state and say so, so the order
   * stops showing as working. Otherwise the broker's own error stands. Always throws.
   * @private
   */
  async _settleFromBroker(instance, order, error) {
    let row = null;
    try {
      const book = await openalgoClient.getOrderBook(instance, { ignoreCircuit: true });
      row = book.find((o) => String(o.orderid ?? o.order_id) === String(order.order_id)) || null;
    } catch (_) { /* the book is unreadable too: the original error is all there is to report */ }
    const status = row ? this._mapOrderStatus(row.order_status || row.status) : null;
    if (!['complete', 'cancelled', 'rejected'].includes(status)) throw error;
    await db.run(
      `UPDATE watchlist_orders SET status = ?, metadata = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status IN ('pending', 'open')`,
      [status, JSON.stringify(row), order.id]
    );
    log.warn('Order was already final at the broker', { orderId: order.id, symbol: order.symbol, status });
    throw new ValidationError(`The order is already ${status === 'complete' ? 'filled' : status} at the broker`);
  }

  /**
   * Map broker order status to internal status
   * @private
   */
  _mapOrderStatus(brokerStatus) {
    const statusMap = {
      open: 'open',
      pending: 'pending',
      complete: 'complete',
      cancelled: 'cancelled',
      rejected: 'rejected',
      // An expired order is as final as a cancelled one; mapped to 'pending' it would sit
      // "pending" forever and be polled forever.
      expired: 'cancelled',
      'trigger pending': 'pending',
      'partially filled': 'open',
    };

    const normalized = (brokerStatus || '').toLowerCase();
    return statusMap[normalized] || 'pending';
  }

  /**
   * Normalize and validate order data
   * @private
   */
  _normalizeOrderData(data) {
    const normalized = {};
    const errors = [];

    // Exchange
    const exchange = sanitizeExchange(data.exchange);
    if (!exchange) {
      errors.push({ field: 'exchange', message: 'Valid exchange is required' });
    } else {
      // Reject INDEX symbols (NSE_INDEX, BSE_INDEX) - they cannot be traded directly
      if (exchange === 'NSE_INDEX' || exchange === 'BSE_INDEX') {
        errors.push({
          field: 'exchange',
          message: 'Index symbols cannot be traded directly. Please trade index derivatives (Futures/Options) instead.',
        });
      }
      normalized.exchange = exchange;
    }

    // Symbol
    const symbol = sanitizeSymbol(data.symbol);
    if (!symbol) {
      errors.push({ field: 'symbol', message: 'Symbol is required' });
    } else {
      normalized.symbol = symbol;
    }

    // Action
    const action = sanitizeString(data.action).toUpperCase();
    if (!['BUY', 'SELL'].includes(action)) {
      errors.push({ field: 'action', message: 'Action must be BUY or SELL' });
    } else {
      normalized.action = action;
    }

    // Quantity
    const quantity = parseIntSafe(data.quantity, null);
    if (quantity === null || quantity <= 0) {
      errors.push({ field: 'quantity', message: 'Quantity must be positive' });
    } else {
      normalized.quantity = quantity;
    }

    // Position size: the SIGNED net position desired after this order, as placesmartorder
    // defines it - negative means net short. The previous `< 0` rejection was inconsistent with
    // the rest of the app: quick-order.service computes signed targets via _computeTarget()
    // (SELL_CE returns `current - Qstep`, i.e. negative) and passes them straight to the same
    // broker endpoint, and order-payload.factory forwards the value unchanged. Rejecting
    // negatives here made it impossible to open a short through this route at all.
    const positionSize = parseIntSafe(data.position_size, null);
    if (positionSize === null) {
      errors.push({
        field: 'position_size',
        message: 'Position size is required for placesmartorder (signed: negative = net short)',
      });
    } else {
      normalized.position_size = positionSize;
    }

    // Product. F&O takes MIS or NRML; CNC is delivery, which F&O does not have, so it becomes
    // NRML - the same rule quick-order applies (_resolveProductForOrder), so the chart and the
    // watchlist send the same product for the same choice.
    const product = sanitizeString(data.product || 'MIS').toUpperCase();
    if (!['MIS', 'CNC', 'NRML'].includes(product)) {
      errors.push({ field: 'product', message: 'Invalid product type' });
    } else {
      const fno = isDerivativeExchange(normalized.exchange) || isCryptoExchange(normalized.exchange); // Delta: futures/options only
      normalized.product = product === 'CNC' && fno ? 'NRML' : product;
    }

    // Price type
    const pricetype = sanitizeString(data.pricetype || 'MARKET').toUpperCase();
    if (!['MARKET', 'LIMIT', 'SL', 'SL-M'].includes(pricetype)) {
      errors.push({ field: 'pricetype', message: 'Invalid price type' });
    } else {
      normalized.pricetype = pricetype;
    }

    // Price
    const price = parseFloatSafe(data.price, 0);
    if (price < 0) {
      errors.push({ field: 'price', message: 'Price cannot be negative' });
    } else {
      normalized.price = price;
    }

    // Trigger price
    const triggerPrice = parseFloatSafe(data.trigger_price, 0);
    if (triggerPrice < 0) {
      errors.push({
        field: 'trigger_price',
        message: 'Trigger price cannot be negative',
      });
    } else {
      normalized.trigger_price = triggerPrice;
    }

    if (errors.length > 0) {
      throw new ValidationError('Order validation failed', errors);
    }

    return normalized;
  }
}

// Export singleton instance
export default new OrderService();
