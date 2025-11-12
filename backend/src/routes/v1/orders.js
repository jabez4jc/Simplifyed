/**
 * Order Routes
 * API endpoints for order placement and management
 */

import express from 'express';
import orderService from '../../services/order.service.js';
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
