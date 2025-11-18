/**
 * Order Routes
 * API endpoints for order placement and management
 */

import express from 'express';
import orderService from '../../services/order.service.js';
import marketDataFeedService from '../../services/market-data-feed.service.js';
import instanceService from '../../services/instance.service.js';
import { log } from '../../core/logger.js';
import {
  NotFoundError,
  ValidationError,
} from '../../core/errors.js';

const router = express.Router();

/**
 * GET /api/v1/orders
 * Get orders with filters
 */
router.get('/', async (req, res, next) => {
  try {
    const filters = {};

    if (req.query.instanceId) {
      filters.instanceId = parseInt(req.query.instanceId, 10);
    }

    if (req.query.watchlistId) {
      filters.watchlistId = parseInt(req.query.watchlistId, 10);
    }

    if (req.query.status) {
      filters.status = req.query.status;
    }

    if (req.query.symbol) {
      filters.symbol = req.query.symbol;
    }

    if (req.query.side) {
      filters.side = req.query.side;
    }

    const orders = await orderService.getOrders(filters);

    res.json({
      status: 'success',
      data: orders,
      count: orders.length,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/orders/orderbook
 * Orderbook data grouped by live vs analyzer instances (cached)
 */
router.get('/orderbook', async (req, res, next) => {
  try {
    const statusFilter = req.query.status;

    const instances = await instanceService.getAllInstances({ is_active: true });
    const resultPayload = {
      liveInstances: [],
      analyzerInstances: [],
      statistics: {
        total_buy_orders: 0,
        total_sell_orders: 0,
        total_open_orders: 0,
        total_completed_orders: 0,
        total_cancelled_orders: 0,
        total_rejected_orders: 0,
      },
    };

    const normalizeOrder = (order) => {
      const status = (order.order_status || order.status || 'pending').toLowerCase();
      const side = (order.action || order.side || '').toUpperCase();
      const orderType = order.pricetype || order.order_type || '';
      if (side === 'BUY') resultPayload.statistics.total_buy_orders += 1;
      if (side === 'SELL') resultPayload.statistics.total_sell_orders += 1;
      if (status === 'open' || status === 'pending') {
        resultPayload.statistics.total_open_orders += 1;
      }
      if (status === 'complete') resultPayload.statistics.total_completed_orders += 1;
      if (status === 'cancelled') resultPayload.statistics.total_cancelled_orders += 1;
      if (status === 'rejected') resultPayload.statistics.total_rejected_orders += 1;
      return {
        id: order.orderid || order.order_id || order.id,
        order_id: order.orderid || order.order_id || order.id,
        symbol: order.symbol,
        exchange: order.exchange,
        status,
        action: side,
        price: order.price,
        quantity: order.quantity,
        product: order.product || order.product_type,
        timestamp: order.timestamp,
        order_type: orderType,
        strategy: order.strategy,
        trade_value: order.trade_value,
        metadata: order,
      };
    };

    await Promise.all(instances.map(async (instance) => {
      const snapshot = await marketDataFeedService.getOrderbookSnapshot(instance.id);
      const snapshotData = snapshot?.data || {};
      const normalizedPayload = Array.isArray(snapshotData) ? snapshotData : snapshotData.orders || snapshotData.data || [];

      const normalizedOrders = normalizedPayload
        .map(normalizeOrder)
        .filter(order => {
          if (!statusFilter) {
            return true;
          }
          return order.status === statusFilter.toLowerCase();
        });

      const entry = {
        instance_id: instance.id,
        instance_name: instance.name,
        broker: instance.broker,
        market_data_role: instance.market_data_role,
        is_analyzer_mode: !!instance.is_analyzer_mode,
        orders: normalizedOrders,
        fetchedAt: snapshot?.fetchedAt,
      };

      if (instance.is_analyzer_mode) {
        resultPayload.analyzerInstances.push(entry);
      } else {
        resultPayload.liveInstances.push(entry);
      }
    }));

    res.json({
      status: 'success',
      data: resultPayload,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/orders/:id
 * Get order by ID
 */
router.get('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const order = await orderService.getOrderById(id);

    res.json({
      status: 'success',
      data: order,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/orders
 * Place order (using placesmartorder)
 */
router.post('/', async (req, res, next) => {
  try {
    const order = await orderService.placeOrder(req.body);

    res.status(201).json({
      status: 'success',
      message: 'Order placed successfully',
      data: order,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/orders/batch
 * Place multiple orders
 */
router.post('/batch', async (req, res, next) => {
  try {
    const { orders } = req.body;

    if (!Array.isArray(orders)) {
      throw new ValidationError('orders must be an array');
    }

    const results = await orderService.placeMultipleOrders(orders);

    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    res.status(201).json({
      status: 'success',
      message: `Placed ${successful} orders, ${failed} failed`,
      data: {
        results,
        summary: {
          total: orders.length,
          successful,
          failed,
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/orders/:id/cancel
 * Cancel order
 */
router.post('/:id/cancel', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const order = await orderService.cancelOrder(id);

    res.json({
      status: 'success',
      message: 'Order cancelled successfully',
      data: order,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/orders/cancel-all
 * Cancel all orders for an instance
 */
router.post('/cancel-all', async (req, res, next) => {
  try {
    const { instanceId, strategy } = req.body;

    if (!instanceId) {
      throw new ValidationError('instanceId is required');
    }

    const result = await orderService.cancelAllOrders(
      instanceId,
      strategy || null
    );

    res.json({
      status: 'success',
      message: `Cancelled ${result.cancelled_count} orders`,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/orders/sync/:instanceId
 * Sync order status from OpenAlgo
 */
router.post('/sync/:instanceId', async (req, res, next) => {
  try {
    const instanceId = parseInt(req.params.instanceId, 10);
    const result = await orderService.syncOrderStatus(instanceId);

    res.json({
      status: 'success',
      message: `Synced order status: ${result.updated} updated`,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
