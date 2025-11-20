/**
 * Order Repository
 * Data access helpers for watchlist_orders and quick_orders.
 */

import db from '../core/database.js';
import { log } from '../core/logger.js';

class OrderRepository {
  async insertWatchlistOrder(params) {
    const {
      watchlistId,
      instanceId,
      symbolId,
      exchange,
      symbol,
      side,
      quantity,
      orderType,
      productType,
      price,
      trigger_price,
      status = 'pending',
      orderId = null,
      message = null,
      metadata = null,
    } = params;

    const result = await db.run(
      `INSERT INTO watchlist_orders (
        watchlist_id, instance_id, symbol_id,
        exchange, symbol, side, quantity,
        order_type, product_type, price, trigger_price,
        status, order_id, message, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        watchlistId || null,
        instanceId,
        symbolId || null,
        exchange,
        symbol,
        side,
        quantity,
        orderType,
        productType,
        price,
        trigger_price,
        status,
        orderId,
        message,
        metadata ? JSON.stringify(metadata) : null,
      ]
    );

    log.debug('Watchlist order persisted', { id: result.lastID, orderId, symbol });
    return result.lastID;
  }

  async insertQuickOrder(params) {
    const result = await db.run(
      `INSERT INTO quick_orders (
        watchlist_id, symbol_id, instance_id, underlying, symbol, exchange,
        action, trade_mode, options_leg, quantity, product, order_type,
        price, trigger_price, resolved_symbol, strike_price, option_type,
        expiry_date, status, order_id, message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        params.watchlist_id,
        params.symbol_id,
        params.instance_id,
        params.underlying,
        params.symbol,
        params.exchange,
        params.action,
        params.trade_mode,
        params.options_leg || null,
        params.quantity,
        params.product,
        params.order_type,
        params.price || null,
        params.trigger_price || null,
        params.resolved_symbol || null,
        params.strike_price || null,
        params.option_type || null,
        params.expiry_date || null,
        params.status,
        params.order_id,
        params.message,
      ]
    );

    log.debug('Quick order persisted', { id: result.lastID, order_id: params.order_id });
    return result.lastID;
  }
}

const orderRepository = new OrderRepository();
export default orderRepository;
