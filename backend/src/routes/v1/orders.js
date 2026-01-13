/**
 * Order Routes
 * API endpoints for order placement and management
 */

import express from 'express';
import orderService from '../../services/order.service.js';
import idempotencyService from '../../services/idempotency.service.js';
import marketDataFeedService from '../../services/market-data-feed.service.js';
import instanceService from '../../services/instance.service.js';
import { log } from '../../core/logger.js';
import {
  NotFoundError,
  ValidationError,
} from '../../core/errors.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import db from '../../core/database.js';

const router = express.Router();
router.use(requireAuth);

function logAudit(req, action, metadata = {}) {
  if (!req.user) return;
  req.auditLogged = true;
  db.run(
    `INSERT INTO audit_logs (user_id, action, metadata) VALUES (?, ?, ?)`,
    [req.user.id, action, JSON.stringify(metadata)]
  ).catch(() => {});
}

/**
 * GET /api/v1/orders
 * Get orders with filters
 */
router.get('/', requirePermission('pages.orders.view'), async (req, res, next) => {
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
router.get('/orderbook', requirePermission('pages.orders.view'), async (req, res, next) => {
  try {
    const statusFilter = req.query.status;
    const force = req.query.refresh === 'true';

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
      const snapshot = await marketDataFeedService.getOrderbookSnapshot(instance.id, { force });
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
router.get('/:id', requirePermission('pages.orders.view'), async (req, res, next) => {
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
router.post('/', requirePermission('orders.place'), async (req, res, next) => {
  try {
    const requestId = req.body?.request_id;
    if (requestId !== undefined && (!requestId || typeof requestId !== 'string')) {
      throw new ValidationError('request_id must be a non-empty string');
    }

    if (requestId) {
      const { hit, record, mismatch } = await idempotencyService.getOrCreate({
        requestId,
        source: 'manual_order',
        payload: req.body,
      });
      if (mismatch) {
        return res.status(409).json({
          status: 'error',
          message: 'Request ID reuse with different payload',
        });
      }
      if (hit && record?.response_json) {
        const cached = JSON.parse(record.response_json);
        res.set('X-Idempotency-Hit', 'true');
        const statusCode = record.status_code || (record.status === 'success' ? 201 : 409);
        return res.status(statusCode).json(cached);
      }
      if (hit) {
        return res.status(409).json({
          status: 'error',
          message: 'Request is already in progress',
        });
      }
    }

    const order = await orderService.placeOrder({
      ...req.body,
      user_id: req.user?.id || null,
      source: 'manual',
      trigger_type: req.body?.trigger_type || 'Manual',
      correlation_id: req.correlationId || null,
      request_id: requestId || null,
    });

    const responsePayload = {
      status: 'success',
      message: 'Order placed successfully',
      data: order,
    };

    if (requestId) {
      await idempotencyService.complete({
        requestId,
        source: 'manual_order',
        response: responsePayload,
        status: 'success',
        statusCode: 201,
      });
    }

    res.status(201).json(responsePayload);
  } catch (error) {
    const requestId = req.body?.request_id;
    if (requestId) {
      await idempotencyService.complete({
        requestId,
        source: 'manual_order',
        response: {
          status: 'error',
          message: error.message,
        },
        status: 'failed',
        statusCode: error.statusCode || 500,
      });
    }
    next(error);
  }
});

/**
 * POST /api/v1/orders/batch
 * Place multiple orders
 */
router.post('/batch', requirePermission('orders.place'), async (req, res, next) => {
  try {
    const { orders, request_id: requestId } = req.body;

    if (requestId !== undefined && (!requestId || typeof requestId !== 'string')) {
      throw new ValidationError('request_id must be a non-empty string');
    }

    if (!Array.isArray(orders)) {
      throw new ValidationError('orders must be an array');
    }

    if (requestId) {
      const { hit, record, mismatch } = await idempotencyService.getOrCreate({
        requestId,
        source: 'manual_batch',
        payload: req.body,
      });
      if (mismatch) {
        return res.status(409).json({
          status: 'error',
          message: 'Request ID reuse with different payload',
        });
      }
      if (hit && record?.response_json) {
        const cached = JSON.parse(record.response_json);
        res.set('X-Idempotency-Hit', 'true');
        const statusCode = record.status_code || (record.status === 'success' ? 201 : 409);
        return res.status(statusCode).json(cached);
      }
      if (hit) {
        return res.status(409).json({
          status: 'error',
          message: 'Request is already in progress',
        });
      }
    }

    const enrichedOrders = orders.map((order, index) => ({
      ...order,
      user_id: req.user?.id || null,
      source: 'manual_batch',
      trigger_type: req.body?.trigger_type || 'Manual',
      correlation_id: req.correlationId || null,
      request_id: requestId ? `${requestId}:${index + 1}` : null,
    }));

    const results = await orderService.placeMultipleOrders(enrichedOrders);

    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    const responsePayload = {
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
    };

    if (requestId) {
      await idempotencyService.complete({
        requestId,
        source: 'manual_batch',
        response: responsePayload,
        status: 'success',
        statusCode: 201,
      });
    }

    res.status(201).json(responsePayload);
  } catch (error) {
    const requestId = req.body?.request_id;
    if (requestId) {
      await idempotencyService.complete({
        requestId,
        source: 'manual_batch',
        response: {
          status: 'error',
          message: error.message,
        },
        status: 'failed',
        statusCode: error.statusCode || 500,
      });
    }
    next(error);
  }
});

/**
 * POST /api/v1/orders/:id/cancel
 * Cancel order
 */
router.post('/:id/cancel', requirePermission('orders.cancel'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const order = await orderService.cancelOrder(id);
    logAudit(req, 'order.cancel', { orderId: id });

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
router.post('/cancel-all', requirePermission('orders.cancel_all'), async (req, res, next) => {
  try {
    const { instanceId, strategy } = req.body;

    if (!instanceId) {
      throw new ValidationError('instanceId is required');
    }

    const result = await orderService.cancelAllOrders(
      instanceId,
      strategy || null
    );

    if ((req.user?.role || '').toUpperCase() !== 'ADMIN') {
      logAudit(req, 'order.cancel_all', { instanceId, strategy: strategy || null, cancelled: result.cancelled_count });
    }

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
