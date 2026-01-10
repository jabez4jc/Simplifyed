/**
 * Position Routes
 * API endpoints for position tracking and P&L
 */

import express from 'express';
import pnlService from '../../services/pnl.service.js';
import instanceService from '../../services/instance.service.js';
import positionsService from '../../services/positions.service.js';
import openalgoClient from '../../integrations/openalgo/client.js';
import marketDataFeedService from '../../services/market-data-feed.service.js';
import { log } from '../../core/logger.js';
import { NotFoundError, ValidationError } from '../../core/errors.js';
import quickOrderService from '../../services/quick-order.service.js';
import pnlSnapshotService from '../../services/pnl-snapshot.service.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import db from '../../core/database.js';
import telegramService from '../../services/telegram.service.js';

const router = express.Router();
router.use(requireAuth);

function logAudit(req, action, metadata = {}) {
  if (!req.user) return;
  db.run(
    `INSERT INTO audit_logs (user_id, action, metadata) VALUES (?, ?, ?)`,
    [req.user.id, action, JSON.stringify(metadata)]
  ).catch(() => {});
}

/**
 * GET /api/v1/positions/all
 * Get positions from all active instances
 * Query params: onlyOpen=true/false (default: false)
 * NOTE: Must be before /:instanceId routes to avoid capturing "all" as instanceId
 */
router.get('/all', async (req, res, next) => {
  try {
    const onlyOpen = req.query.onlyOpen === 'true';
    const refresh = req.query.refresh !== 'false';

    const positions = await positionsService.getAllPositions({ onlyOpen, refresh });

    res.json({
      status: 'success',
      data: positions,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/positions/aggregate/pnl
 * Get aggregated P&L across all active instances
 * NOTE: Must be before /:instanceId routes to avoid capturing "aggregate" as instanceId
 */
router.get('/aggregate/pnl', async (req, res, next) => {
  try {
    const instances = await instanceService.getAllInstances({
      is_active: true,
    });

    const aggregatedPnL = await pnlService.getAggregatedPnL(instances);

    res.json({
      status: 'success',
      data: aggregatedPnL,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/positions/:instanceId
 * Get positions for an instance
 */
router.get('/:instanceId', async (req, res, next) => {
  try {
    const instanceId = parseInt(req.params.instanceId, 10);
    const instance = await instanceService.getInstanceById(instanceId);

    const cache = marketDataFeedService.getPositionSnapshot(instanceId);
    if (cache?.data) {
      return res.json({
        status: 'success',
        data: cache.data,
        count: cache.data.length,
        cachedAt: cache.fetchedAt,
        source: 'cache',
      });
    }

    // Get positionbook from OpenAlgo (fallback) and seed cache
    const positions = await openalgoClient.getPositionBook(instance);
    marketDataFeedService.setPositionSnapshot(instanceId, positions);

    res.json({
      status: 'success',
      data: positions,
      count: positions.length,
      source: 'live',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/positions/:instanceId/pnl
 * Get P&L breakdown for an instance
 */
router.get('/:instanceId/pnl', async (req, res, next) => {
  try {
    const instanceId = parseInt(req.params.instanceId, 10);
    const instance = await instanceService.getInstanceById(instanceId);

    const pnl = await pnlService.getInstancePnL(instance);

    res.json({
      status: 'success',
      data: pnl,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/positions/:instanceId/close
 * Close all positions for an instance
 */
router.post('/:instanceId/close', requirePermission('positions.close_all'), async (req, res, next) => {
  try {
    const instanceId = parseInt(req.params.instanceId, 10);
    const instance = await instanceService.getInstanceById(instanceId);

    const strategy = instance.strategy_tag || 'default';

    // Close positions via OpenAlgo
    await openalgoClient.closePosition(instance, strategy);

    if ((req.user?.role || '').toUpperCase() !== 'ADMIN') {
      logAudit(req, 'positions.close_all', { instanceId });
    }

    if (!instance.is_analyzer_mode) {
      pnlSnapshotService.incrementSignalCounts(instance.id, { manual_sell_signals: 1 }).catch(() => {});
    }

    // Telegram summary for close-all on a single instance
    telegramService.sendOrderSummary({
      title: 'ORDER SUMMARY',
      trigger_type: 'Manual',
      button_label: 'CLOSE_ALL',
      trade_mode: 'DIRECT',
      side: 'SELL',
      symbol: 'ALL',
      exchange: '-',
      product: instance.default_product || 'MIS',
      order_type: 'MARKET',
      quantity: null,
      instances: [instance.name].filter(Boolean),
      success_count: 1,
      failure_count: 0,
    }).catch(err => log.warn('telegram_summary_notify_failed', { error: err.message }));

    res.json({
      status: 'success',
      message: 'Close position request sent',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/positions/:instanceId/close/position
 * Close a single symbol on an instance
 * Body: { symbol, exchange, tradeMode, product }
 */
router.post('/:instanceId/close/position', requirePermission('positions.close'), async (req, res, next) => {
  try {
    const instanceId = parseInt(req.params.instanceId, 10);
    const instance = await instanceService.getInstanceById(instanceId);

    const { symbol, exchange, tradeMode, product } = req.body;
    if (!symbol || !exchange || !tradeMode) {
      throw new ValidationError('symbol, exchange, and tradeMode are required');
    }

    const normalizedTradeMode = String(tradeMode).toUpperCase();
    const normalizedProduct = (product || 'MIS').toUpperCase();

    const result = await quickOrderService.closePosition(instance, {
      symbol,
      exchange,
    }, {
      tradeMode: normalizedTradeMode,
      product: normalizedProduct,
    });

    if ((req.user?.role || '').toUpperCase() !== 'ADMIN') {
      logAudit(req, 'positions.close_single', { instanceId, symbol, exchange });
    }

    if (!instance.is_analyzer_mode) {
      pnlSnapshotService.incrementSignalCounts(instance.id, { manual_sell_signals: 1 }).catch(() => {});
    }

    // Telegram summary for single-position close
    const successDetails = Array.isArray(result?.details) ? result.details.filter(d => d.success) : [];
    const totalQty = successDetails.reduce((sum, d) => sum + (d.quantity || d.closed_quantity || 0), 0);
    const firstSuccess = successDetails[0] || {};
    const summarySymbol = firstSuccess.symbol || symbol;
    const summaryExchange = firstSuccess.exchange || exchange;

    telegramService.sendOrderSummary({
      title: 'ORDER SUMMARY',
      trigger_type: 'Manual',
      button_label: 'CLOSE_POSITION',
      trade_mode: normalizedTradeMode,
      side: 'SELL',
      symbol: summarySymbol,
      exchange: summaryExchange,
      product: normalizedProduct,
      order_type: 'MARKET',
      quantity: totalQty || null,
      instances: [instance.name].filter(Boolean),
      success_count: successDetails.length,
      failure_count: (result?.details?.length || 0) - successDetails.length,
    }).catch(err => log.warn('telegram_summary_notify_failed', { error: err.message }));

    res.json({
      status: 'success',
      message: 'Close request submitted',
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
