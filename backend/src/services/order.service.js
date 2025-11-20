/**
 * Order Service
 * Handles order placement (using placesmartorder), tracking, and management
 */

import db from '../core/database.js';
import { log } from '../core/logger.js';
import openalgoClient from '../integrations/openalgo/client.js';
import orderPlacementService from './order-placement.service.js';
import orderPayloadFactory from './order-payload.factory.js';
import orderRepository from './order-repository.js';
import {
  NotFoundError,
  ValidationError,
  OpenAlgoError,
} from '../core/errors.js';
import {
  sanitizeString,
  sanitizeSymbol,
  sanitizeExchange,
  parseFloatSafe,
  parseIntSafe,
} from '../utils/sanitizers.js';

class OrderService {
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
      position_size, // Required for placesmartorder
    } = params;

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

      // Check if instance is in analyzer mode
      if (instance.is_analyzer_mode) {
        throw new ValidationError('Instance is in analyzer mode');
      }

      // Validate required fields
      const normalized = this._normalizeOrderData(params);

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

      const response = await orderPlacementService.placeSmartOrder(instance, orderData, {
        request_type: 'MANUAL_ORDER',
        base_symbol: normalized.symbol,
        trade_mode: 'DIRECT',
        exchange: normalized.exchange,
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
        orderType: normalized.pricetype,
        productType: normalized.product,
        price: normalized.price,
        trigger_price: normalized.trigger_price,
        status: 'pending',
        orderId,
        message: response.message || 'Order placed',
        metadata: response,
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
            status, message
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            watchlistId || null,
            instanceId,
            symbolId || null,
            exchange,
            symbol,
            action,
            quantity,
            pricetype,
            product,
            price,
            trigger_price,
            'failed',
            error.message,
          ]
        );
      } catch (dbError) {
        log.error('Failed to save failed order', dbError);
      }

      throw error;
    }
  }

  /**
   * Place multiple orders (basket order)
   * @param {Array} orders - Array of order parameters
   * @returns {Promise<Array>} - Array of order results
   */
  async placeMultipleOrders(orders) {
    const results = [];

    for (const orderParams of orders) {
      try {
        const order = await this.placeOrder(orderParams);
        results.push({ success: true, order });
      } catch (error) {
        results.push({
          success: false,
          error: error.message,
          params: orderParams,
        });
      }
    }

    return results;
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

      await openalgoClient.cancelOrder(
        instance,
        order.order_id,
        instance.strategy_tag || 'default'
      );

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

      // Update all pending orders
      await db.run(
        `UPDATE watchlist_orders
         SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
         WHERE instance_id = ? AND status IN ('pending', 'open')`,
        [instanceId]
      );

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

  /**
   * Get order by ID
   * @param {number} orderId - Order ID
   * @returns {Promise<Object>} - Order details
   */
  async getOrderById(orderId) {
    try {
      const order = await db.get(
        `SELECT
          wo.*,
          i.name as instance_name,
          i.host_url as instance_host,
          w.name as watchlist_name
         FROM watchlist_orders wo
         JOIN instances i ON wo.instance_id = i.id
         LEFT JOIN watchlists w ON wo.watchlist_id = w.id
         WHERE wo.id = ?`,
        [orderId]
      );

      if (!order) {
        throw new NotFoundError('Order');
      }

      return order;
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      log.error('Failed to get order', error, { orderId });
      throw error;
    }
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
        query += ' AND wo.status = ?';
        params.push(filters.status);
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
    try {
      // Get instance
      const instance = await db.get('SELECT * FROM instances WHERE id = ?', [
        instanceId,
      ]);

      if (!instance) {
        throw new NotFoundError('Instance');
      }

      // Get orderbook from OpenAlgo
      const orderbook = await openalgoClient.getOrderBook(instance);

      // Get pending orders from database
      const pendingOrders = await db.all(
        `SELECT * FROM watchlist_orders
         WHERE instance_id = ? AND status IN ('pending', 'open')`,
        [instanceId]
      );

      let updatedCount = 0;

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
            await db.run(
              `UPDATE watchlist_orders
               SET status = ?, broker_order_id = ?, metadata = ?, updated_at = CURRENT_TIMESTAMP
               WHERE id = ?`,
              [
                status,
                brokerOrder.orderid || brokerOrder.order_id,
                JSON.stringify(brokerOrder),
                dbOrder.id,
              ]
            );
            updatedCount++;
          }
        }
      }

      log.info('Order status synced', {
        instance_id: instanceId,
        updated_count: updatedCount,
      });

      return {
        checked: pendingOrders.length,
        updated: updatedCount,
      };
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      log.error('Failed to sync order status', error, { instanceId });
      throw error;
    }
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

    // Position size (required for placesmartorder)
    const positionSize = parseIntSafe(data.position_size, null);
    if (positionSize === null || positionSize < 0) {
      errors.push({
        field: 'position_size',
        message: 'Position size is required for placesmartorder',
      });
    } else {
      normalized.position_size = positionSize;
    }

    // Product
    const product = sanitizeString(data.product || 'MIS').toUpperCase();
    if (!['MIS', 'CNC', 'NRML'].includes(product)) {
      errors.push({ field: 'product', message: 'Invalid product type' });
    } else {
      normalized.product = product;
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
export { OrderService };
