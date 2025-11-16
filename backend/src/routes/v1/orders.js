/**
 * Order Routes
 * API endpoints for order placement and management
 */

import express from 'express';
import orderService from '../../services/order.service.js';
import tradeIntentService from '../../services/trade-intent.service.js';
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
 * POST /api/v1/orders/enhanced
 * Place order with server-side symbol resolution and delta calculation
 * Supports template symbols (NIFTY_ATM_CE, etc.) and target positions
 */
router.post('/enhanced', async (req, res, next) => {
  try {
    const {
      instanceId,
      watchlistId,
      symbol,
      exchange,
      targetQty,
      intentId,
      context,
    } = req.body;

    // Validate required fields
    if (!instanceId) {
      throw new ValidationError('instanceId is required');
    }

    if (!symbol) {
      throw new ValidationError('symbol is required');
    }

    if (!exchange) {
      throw new ValidationError('exchange is required');
    }

    if (targetQty === undefined || targetQty === null) {
      throw new ValidationError('targetQty is required');
    }

    // Validate types and ranges
    const instanceIdNum = parseInt(instanceId, 10);
    const targetQtyNum = parseInt(targetQty, 10);

    if (!Number.isFinite(instanceIdNum) || instanceIdNum <= 0) {
      throw new ValidationError('instanceId must be a positive integer');
    }

    if (!Number.isFinite(targetQtyNum)) {
      throw new ValidationError('targetQty must be a valid integer');
    }

    const result = await orderService.placeOrderWithIntent({
      userId: req.user?.id || 1, // Use authenticated user or default to test user
      instanceId: instanceIdNum,
      watchlistId: watchlistId ? parseInt(watchlistId, 10) : null,
      symbol,
      exchange,
      targetQty: targetQtyNum,
      intentId,
      context: context || {},
    });

    res.status(201).json({
      status: 'success',
      message: result.delta === 0
        ? 'No order needed (already at target)'
        : 'Order placed successfully',
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/orders/intents
 * Get trade intents with optional filters
 *
 * Query parameters:
 * - status: Filter by status ('pending', 'failed', or omit for all pending)
 * - instanceId: Filter by instance ID
 */
router.get('/intents', async (req, res, next) => {
  try {
    const { status, instanceId } = req.query;

    let intents;
    if (status === 'pending') {
      intents = await tradeIntentService.getPendingIntents(
        instanceId ? parseInt(instanceId, 10) : null
      );
    } else if (status === 'failed') {
      intents = await tradeIntentService.getFailedIntents();
    } else {
      // Default to pending intents
      intents = await tradeIntentService.getPendingIntents(
        instanceId ? parseInt(instanceId, 10) : null
      );
    }

    res.json({
      status: 'success',
      data: intents,
      count: intents.length,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/orders/intents/:intentId
 * Get trade intent by ID with full execution summary
 */
router.get('/intents/:intentId', async (req, res, next) => {
  try {
    const { intentId } = req.params;

    const summary = await tradeIntentService.getIntentSummary(intentId);

    if (!summary) {
      throw new NotFoundError('Trade intent not found');
    }

    res.json({
      status: 'success',
      data: summary,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/orders/intents/:intentId/retry
 * Retry a failed trade intent
 */
router.post('/intents/:intentId/retry', async (req, res, next) => {
  try {
    const { intentId } = req.params;

    const intent = await tradeIntentService.retryIntent(intentId);

    res.json({
      status: 'success',
      message: 'Intent reset for retry',
      data: intent,
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

/**
 * GET /api/v1/orders/:id
 * Get order by ID
 *
 * Note: This route MUST be defined after all specific routes to avoid
 * shadowing routes like /intents, /batch, etc.
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

export default router;
