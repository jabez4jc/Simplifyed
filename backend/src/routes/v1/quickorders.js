/**
 * Quick Order Routes
 * API endpoints for quick order placement from watchlist rows
 */

import express from 'express';
import quickOrderService from '../../services/quick-order.service.js';
import { log } from '../../core/logger.js';
import { ValidationError } from '../../core/errors.js';

const router = express.Router();

/**
 * POST /api/v1/quickorders
 * Place a quick order from watchlist row
 *
 * Request body:
 * {
 *   "symbolId": 123 (required - watchlist symbol database ID),
 *   "action": "BUY" | "SELL" | "EXIT" | "BUY_CE" | "SELL_CE" | "BUY_PE" | "SELL_PE" | "EXIT_ALL" | "REDUCE_CE" | "REDUCE_PE" | "INCREASE_CE" | "INCREASE_PE" | "CLOSE_ALL_CE" | "CLOSE_ALL_PE",
 *   "tradeMode": "EQUITY" | "FUTURES" | "OPTIONS",
 *   "optionsLeg": "ITM3" | "ITM2" | "ITM1" | "ATM" | "OTM1" | "OTM2" | "OTM3" (required for OPTIONS actions),
 *   "quantity": 1,
 *   "expiry": "2025-11-18" (optional - for FUTURES/OPTIONS, uses nearest if not provided),
 *   "instanceId": 1 (optional - if not provided, broadcasts to all assigned instances),
 *   "product": "MIS" | "CNC" | "NRML" (optional, defaults to MIS),
 *   "strategy": "quickorder" (optional),
 *   "operatingMode": "BUYER" | "WRITER" (optional - for OPTIONS mode),
 *   "strikePolicy": "FLOAT_OFS" | "ANCHOR_OFS" (optional - for OPTIONS mode),
 *   "stepLots": 1 (optional - for OPTIONS mode)
 * }
 */
router.post('/', async (req, res, next) => {
  try {
    const {
      symbolId,
      action,
      tradeMode,
      optionsLeg,
      quantity,
      instanceId,
      product,
      strategy,
      expiry,
      operatingMode,
      strikePolicy,
      stepLots,
    } = req.body;

    // Validate required fields
    if (!symbolId) {
      throw new ValidationError('symbolId is required');
    }

    const parsedSymbolId = parseInt(symbolId, 10);
    if (isNaN(parsedSymbolId) || parsedSymbolId <= 0) {
      throw new ValidationError('symbolId must be a positive integer');
    }

    if (!action) {
      throw new ValidationError('action is required');
    }

    const validActions = [
      'BUY',
      'SELL',
      'EXIT',
      'BUY_CE',
      'SELL_CE',
      'BUY_PE',
      'SELL_PE',
      'EXIT_ALL',
      'REDUCE_CE',
      'REDUCE_PE',
      'INCREASE_CE',
      'INCREASE_PE',
      'CLOSE_ALL_CE',
      'CLOSE_ALL_PE'
    ];
    if (!validActions.includes(action)) {
      throw new ValidationError(
        `action must be one of: ${validActions.join(', ')}`
      );
    }

    if (!tradeMode) {
      throw new ValidationError('tradeMode is required');
    }

    const validTradeModes = ['EQUITY', 'FUTURES', 'OPTIONS'];
    if (!validTradeModes.includes(tradeMode)) {
      throw new ValidationError(
        `tradeMode must be one of: ${validTradeModes.join(', ')}`
      );
    }

    if (tradeMode === 'OPTIONS' && ['BUY_CE', 'SELL_CE', 'BUY_PE', 'SELL_PE', 'REDUCE_CE', 'REDUCE_PE', 'INCREASE_CE', 'INCREASE_PE', 'CLOSE_ALL_CE', 'CLOSE_ALL_PE'].includes(action) && !optionsLeg) {
      throw new ValidationError('optionsLeg is required for OPTIONS trade mode');
    }

    if (quantity !== undefined && quantity !== null) {
      const parsedQuantity = parseInt(quantity, 10);
      if (isNaN(parsedQuantity) || parsedQuantity <= 0) {
        throw new ValidationError('quantity must be a positive integer');
      }
    }

    if (instanceId !== undefined && instanceId !== null) {
      const parsedInstanceId = parseInt(instanceId, 10);
      if (isNaN(parsedInstanceId) || parsedInstanceId <= 0) {
        throw new ValidationError('instanceId must be a positive integer');
      }
    }

    log.info('Placing quick order', {
      symbolId: parsedSymbolId,
      action,
      tradeMode,
      optionsLeg,
      quantity,
      instanceId,
      expiry,
      operatingMode,
      strikePolicy,
      stepLots,
    });

    // Place quick order
    const result = await quickOrderService.placeQuickOrder({
      symbolId: parsedSymbolId,
      action,
      tradeMode,
      optionsLeg,
      quantity: quantity ? parseInt(quantity, 10) : undefined,
      instanceId: instanceId ? parseInt(instanceId, 10) : undefined,
      product: product || 'MIS',
      strategy: strategy || 'quickorder',
      expiry: expiry || null,
      operatingMode: operatingMode || 'BUYER',
      strikePolicy: strikePolicy || 'FLOAT_OFS',
      stepLots: stepLots ? parseInt(stepLots, 10) : undefined,
    });

    // Determine overall success
    const totalOrders = result.results.length;
    const successfulOrders = result.results.filter(r => r.success).length;
    const failedOrders = totalOrders - successfulOrders;

    res.status(201).json({
      status: 'success',
      message: `Quick order placed: ${successfulOrders} successful, ${failedOrders} failed`,
      data: {
        ...result,
        summary: {
          total: totalOrders,
          successful: successfulOrders,
          failed: failedOrders,
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/quickorders/options/preview
 * Resolve the CE/PE symbols + quotes for the current options configuration
 */
router.get('/options/preview', async (req, res, next) => {
  try {
    const { symbolId, expiry, optionsLeg } = req.query;

    const parsedSymbolId = parseInt(symbolId, 10);
    if (!symbolId || Number.isNaN(parsedSymbolId) || parsedSymbolId <= 0) {
      throw new ValidationError('symbolId must be a positive integer');
    }

    const preview = await quickOrderService.getOptionsPreview({
      symbolId: parsedSymbolId,
      expiry: expiry || null,
      optionsLeg: optionsLeg || null,
    });

    res.json({
      status: 'success',
      data: preview,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/quickorders/futures/preview
 * Resolve the futures contract + quote for the current futures configuration
 */
router.get('/futures/preview', async (req, res, next) => {
  try {
    const { symbolId, expiry } = req.query;

    const parsedSymbolId = parseInt(symbolId, 10);
    if (!symbolId || Number.isNaN(parsedSymbolId) || parsedSymbolId <= 0) {
      throw new ValidationError('symbolId must be a positive integer');
    }

    const preview = await quickOrderService.getFuturesPreview({
      symbolId: parsedSymbolId,
      expiry: expiry || null,
    });

    res.json({
      status: 'success',
      data: preview,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/quickorders
 * Get quick order history with filters
 *
 * Query parameters:
 * - instanceId: Filter by instance ID
 * - symbol: Filter by underlying symbol
 * - tradeMode: Filter by trade mode (EQUITY, FUTURES, OPTIONS)
 * - action: Filter by action (BUY, SELL, etc.)
 * - limit: Limit number of results (default: 100)
 * - offset: Offset for pagination (default: 0)
 */
router.get('/', async (req, res, next) => {
  try {
    const filters = {};

    if (req.query.instanceId) {
      filters.instanceId = parseInt(req.query.instanceId, 10);
      if (isNaN(filters.instanceId)) {
        throw new ValidationError('instanceId must be a valid integer');
      }
    }

    if (req.query.symbol) {
      filters.symbol = req.query.symbol;
    }

    if (req.query.tradeMode) {
      filters.tradeMode = req.query.tradeMode;
    }

    if (req.query.action) {
      filters.action = req.query.action;
    }

    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 100;
    const offset = req.query.offset ? parseInt(req.query.offset, 10) : 0;

    if (isNaN(limit) || limit <= 0 || limit > 1000) {
      throw new ValidationError('limit must be between 1 and 1000');
    }

    if (isNaN(offset) || offset < 0) {
      throw new ValidationError('offset must be a non-negative integer');
    }

    filters.limit = limit;
    filters.offset = offset;

    const orders = await quickOrderService.getQuickOrders(filters);

    res.json({
      status: 'success',
      data: orders,
      count: orders.length,
      pagination: {
        limit,
        offset,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/quickorders/:id
 * Get a specific quick order by ID
 */
router.get('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);

    if (isNaN(id) || id <= 0) {
      throw new ValidationError('id must be a positive integer');
    }

    const order = await quickOrderService.getQuickOrderById(id);

    res.json({
      status: 'success',
      data: order,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/quickorders/symbol/:symbol
 * Get quick orders for a specific symbol
 *
 * Query parameters:
 * - exchange: Filter by exchange (optional)
 * - tradeMode: Filter by trade mode (optional)
 * - limit: Limit number of results (default: 50)
 */
router.get('/symbol/:symbol', async (req, res, next) => {
  try {
    const { symbol } = req.params;

    if (!symbol) {
      throw new ValidationError('symbol is required');
    }

    const filters = {
      symbol,
    };

    if (req.query.exchange) {
      filters.exchange = req.query.exchange;
    }

    if (req.query.tradeMode) {
      filters.tradeMode = req.query.tradeMode;
    }

    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
    if (isNaN(limit) || limit <= 0 || limit > 1000) {
      throw new ValidationError('limit must be between 1 and 1000');
    }

    filters.limit = limit;
    filters.offset = 0;

    const orders = await quickOrderService.getQuickOrders(filters);

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
 * GET /api/v1/quickorders/stats/summary
 * Get summary statistics for quick orders
 *
 * Query parameters:
 * - instanceId: Filter by instance ID (optional)
 * - symbol: Filter by symbol (optional)
 * - days: Number of days to include (default: 7)
 */
router.get('/stats/summary', async (req, res, next) => {
  try {
    const filters = {};

    if (req.query.instanceId) {
      filters.instanceId = parseInt(req.query.instanceId, 10);
      if (isNaN(filters.instanceId)) {
        throw new ValidationError('instanceId must be a valid integer');
      }
    }

    if (req.query.symbol) {
      filters.symbol = req.query.symbol;
    }

    const days = req.query.days ? parseInt(req.query.days, 10) : 7;
    if (isNaN(days) || days <= 0 || days > 365) {
      throw new ValidationError('days must be between 1 and 365');
    }

    filters.days = days;

    const stats = await quickOrderService.getQuickOrderStats(filters);

    res.json({
      status: 'success',
      data: stats,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
