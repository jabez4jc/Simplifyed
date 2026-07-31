/**
 * Quick Order Routes
 * API endpoints for quick order placement from watchlist rows
 */

import express from 'express';
import quickOrderService from '../../services/quick-order.service.js';
import idempotencyService from '../../services/idempotency.service.js';
import marginSizingService from '../../services/margin-sizing.service.js';
import instanceService from '../../services/instance.service.js';
import { log } from '../../core/logger.js';
import { ValidationError } from '../../core/errors.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import riskControlsService from '../../services/risk-controls.service.js';
import { resolveOptionsUnderlyingKey, resolveOptionLotSize } from '../../utils/underlying.util.js';
import db from '../../core/database.js';

const OPTIONS_ACTION_SIDE = {
  BUY_CE: 'BUY', SELL_CE: 'SELL', BUY_PE: 'BUY', SELL_PE: 'SELL',
  INCREASE_CE: 'BUY', INCREASE_PE: 'BUY', REDUCE_CE: 'SELL', REDUCE_PE: 'SELL',
};

/**
 * Resolve quantity for a MARGIN_BASED watchlist symbol via margin-sizing.service.js.
 * Requires an explicit single instanceId — margin-based sizing is instance-specific
 * (each broker account has its own available margin), so broadcast-to-all is not supported here.
 */
async function resolveMarginBasedQuantity({ symbolId, instanceId, action }) {
  const symbolConfig = await db.get('SELECT * FROM watchlist_symbols WHERE id = ?', [symbolId]);
  if (!symbolConfig) {
    throw new ValidationError('Symbol not found');
  }
  if (symbolConfig.qty_type !== 'MARGIN_BASED') {
    return null;
  }
  if (!instanceId) {
    throw new ValidationError('instanceId is required for MARGIN_BASED quantity sizing (cannot broadcast to all instances)');
  }

  const instance = await instanceService.getInstanceById(instanceId);
  if (!instance) {
    throw new ValidationError('Instance not found');
  }

  const { quantity } = await marginSizingService.computeLotQuantity({
    instance,
    symbolConfig,
    orderContext: {
      exchange: symbolConfig.exchange,
      symbol: symbolConfig.symbol,
      action: OPTIONS_ACTION_SIDE[action] || action,
      product: symbolConfig.product_type,
      orderType: symbolConfig.order_type,
    },
    watchlistId: symbolConfig.watchlist_id,
  });

  if (!quantity || quantity <= 0) {
    throw new ValidationError('Insufficient margin to size an order for this symbol');
  }

  return quantity;
}


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
/**
 * GET /api/v1/quickorders/targets?symbolId=123
 *
 * Answers "if I place this order, where does it actually go?" WITHOUT placing anything.
 *
 * Exists for the chart's confirmation dialog. On this app a single click fans out to every
 * instance assigned to the symbol's watchlist, so the operator has to be told the blast radius
 * before committing, not after - including which targets are live and which are analyzer.
 *
 * Deliberately calls quickOrderService._getTargetInstances, the same resolver the execution
 * path uses, rather than re-implementing the query. A preview that can drift from the real
 * target set is worse than no preview: it would state a blast radius confidently and be wrong.
 */
router.get('/targets', requirePermission('orders.place'), async (req, res, next) => {
  try {
    const { symbolId, instanceId } = req.query;
    const parsedSymbolId = parseInt(symbolId, 10);
    if (!Number.isInteger(parsedSymbolId) || parsedSymbolId <= 0) {
      throw new ValidationError('symbolId must be a positive integer');
    }

    const symbol = await db.get(
      `SELECT ws.id, ws.symbol, ws.exchange, ws.watchlist_id, ws.lot_size, ws.qty_type,
              ws.qty_value, ws.product_type, ws.symbol_type, ws.underlying_symbol,
              ws.tradable_equity, ws.tradable_futures, ws.tradable_options,
              w.name AS watchlist_name
         FROM watchlist_symbols ws
         JOIN watchlists w ON w.id = ws.watchlist_id
        WHERE ws.id = ?`,
      [parsedSymbolId]
    );
    if (!symbol) {
      throw new ValidationError(`Symbol ${parsedSymbolId} not found`);
    }

    let instances = [];
    let unavailable = null;
    try {
      instances = await quickOrderService._getTargetInstances(instanceId || null, symbol.watchlist_id);
    } catch (error) {
      // No active order-enabled instance assigned. Reported as data, not as a 500 - the dialog
      // needs to say "nothing would be sent" rather than fail opaquely.
      unavailable = error.message;
    }

    res.json({
      status: 'success',
      data: {
        symbol: {
          id: symbol.id,
          symbol: symbol.symbol,
          exchange: symbol.exchange,
          watchlistId: symbol.watchlist_id,
          watchlistName: symbol.watchlist_name,
          // Instrument class, resolved by the SAME function auto-exit uses, so the chart never
          // guesses. Drives whether the order is sized in units (equity) or lots (F&O):
          // 'direct' => equity => quantity is units; 'futures'/'options' => quantity is lots.
          mode: riskControlsService._determineMode(symbol, symbol.symbol),
          // Lot size of the OPTION contracts on this underlying, read from the instruments
          // master rather than the watchlist row. An INDEX row carries lot_size 1 - correct,
          // an index cannot be traded - but an option on it trades in the derivative's lots:
          // NIFTY 65, BANKNIFTY 30, SENSEX 20, FINNIFTY 60, NIFTYNXT 25.
          // Resolved via underlying_key, never a symbol LIKE: 'NIFTY%' also matches
          // NIFTYNXT50 (lot 25) and would report the wrong size for NIFTY.
          optionLotSize: await resolveOptionLotSize(await resolveOptionsUnderlyingKey(symbol)),
          lotSize: symbol.lot_size,
          qtyType: symbol.qty_type,
          qtyValue: symbol.qty_value,
          productType: symbol.product_type,
          tradableEquity: !!symbol.tradable_equity,
          tradableFutures: !!symbol.tradable_futures,
          tradableOptions: !!symbol.tradable_options,
        },
        instances: instances.map((i) => ({
          id: i.id,
          name: i.name,
          broker: i.broker,
          isAnalyzer: !!i.is_analyzer_mode,
          // Per-instance lot scaling, applied by BOTH order paths. This is the app's existing
          // "lots per instance" mechanism, and it is invisible unless surfaced: an instance on
          // multiplier 5 receives five times the lots the operator typed.
          multiplier: Math.min(Math.max(parseInt(i.multiplier, 10) || 1, 1), 999),
        })),
        liveCount: instances.filter((i) => !i.is_analyzer_mode).length,
        analyzerCount: instances.filter((i) => i.is_analyzer_mode).length,
        unavailable,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post('/', requirePermission('orders.place'), async (req, res, next) => {
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
      request_id: requestId,
      trigger_type: triggerType,
      correlation_id: correlationId,
    } = req.body;

    if (requestId !== undefined && (!requestId || typeof requestId !== 'string')) {
      throw new ValidationError('request_id must be a non-empty string');
    }

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
      // Direct/Futures
      'BUY', 'SELL', 'SHORT', 'COVER', 'EXIT',
      // Options
      'BUY_CE', 'SELL_CE', 'BUY_PE', 'SELL_PE', 'EXIT_ALL',
      'REDUCE_CE', 'REDUCE_PE', 'INCREASE_CE', 'INCREASE_PE', 'CLOSE_ALL_CE', 'CLOSE_ALL_PE'
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

    if (tradeMode === 'OPTIONS' && ['BUY', 'SELL', 'SHORT', 'COVER'].includes(action)) {
      throw new ValidationError(`action ${action} is not valid for OPTIONS trade mode`);
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

    // MARGIN_BASED symbols may omit quantity and have it computed from available margin
    let resolvedQuantity = quantity ? parseInt(quantity, 10) : undefined;
    const parsedInstanceId = instanceId ? parseInt(instanceId, 10) : undefined;
    if (!resolvedQuantity) {
      resolvedQuantity = await resolveMarginBasedQuantity({
        symbolId: parsedSymbolId,
        instanceId: parsedInstanceId,
        action,
      }) || undefined;
    }

    log.info('Placing quick order', {
      symbolId: parsedSymbolId,
      action,
      tradeMode,
      optionsLeg,
      quantity: resolvedQuantity,
      instanceId,
      expiry,
      operatingMode,
      strikePolicy,
      stepLots,
    });

    // Place quick order
    const normalizedPayload = {
      symbolId: parsedSymbolId,
      action,
      tradeMode,
      optionsLeg,
      quantity: resolvedQuantity,
      instanceId: parsedInstanceId,
      product: product || 'MIS',
      strategy: strategy || 'quickorder',
      expiry: expiry || null,
      operatingMode: operatingMode || 'BUYER',
      strikePolicy: strikePolicy || 'FLOAT_OFS',
      stepLots: stepLots ? parseInt(stepLots, 10) : undefined,
      triggerType: triggerType || 'Manual',
      correlationId: correlationId || req.correlationId || null,
      requestId,
      userId: req.user?.id || null,
      source: 'quickorder',
    };

    if (requestId) {
      const { hit, record, mismatch } = await idempotencyService.getOrCreate({
        requestId,
        source: 'quickorder',
        payload: normalizedPayload,
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

    const result = await quickOrderService.placeQuickOrder(normalizedPayload);

    // Determine overall success
    const totalOrders = result.results.length;
    const successfulOrders = result.results.filter(r => r.success).length;
    const uncertainOrders = result.results.filter(r => r.uncertain).length;
    const failedOrders = totalOrders - successfulOrders - uncertainOrders;

    logAudit(req, 'quickorder.place', { symbolId: parsedSymbolId, action, tradeMode });

    const responsePayload = {
      status: 'success',
      message: `Quick order placed: ${successfulOrders} successful, ${failedOrders} failed${uncertainOrders ? `, ${uncertainOrders} unknown` : ''}`,
      data: {
        ...result,
        summary: {
          total: totalOrders,
          successful: successfulOrders,
          failed: failedOrders,
          uncertain: uncertainOrders,
        },
      },
    };

    if (requestId) {
      await idempotencyService.complete({
        requestId,
        source: 'quickorder',
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
        source: 'quickorder',
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
 * GET /api/v1/quickorders/options/preview
 * Resolve the CE/PE symbols + quotes for the current options configuration
 */
router.get('/options/preview', requirePermission('pages.watchlists.view'), async (req, res, next) => {
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
router.get('/futures/preview', requirePermission('pages.watchlists.view'), async (req, res, next) => {
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
router.get('/', requirePermission('pages.orders.view'), async (req, res, next) => {
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
router.get('/:id', requirePermission('pages.orders.view'), async (req, res, next) => {
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
router.get('/symbol/:symbol', requirePermission('pages.orders.view'), async (req, res, next) => {
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
router.get('/stats/summary', requirePermission('pages.orders.view'), async (req, res, next) => {
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

/**
 * POST /api/v1/quickorders/sync/:instanceId
 * Sync quick order status with broker orderbook
 */
router.post('/sync/:instanceId', requirePermission('orders.place'), async (req, res, next) => {
  try {
    const instanceId = parseInt(req.params.instanceId, 10);
    if (Number.isNaN(instanceId) || instanceId <= 0) {
      throw new ValidationError('instanceId must be a positive integer');
    }
    const days = req.query.days ? parseInt(req.query.days, 10) : 7;
    if (Number.isNaN(days) || days <= 0 || days > 90) {
      throw new ValidationError('days must be between 1 and 90');
    }

    const result = await quickOrderService.syncQuickOrdersForInstance(instanceId, { days });

    logAudit(req, 'quickorders.sync', { instanceId, days });

    res.json({
      status: 'success',
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
