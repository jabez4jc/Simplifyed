/**
 * Position Routes
 * API endpoints for position tracking and P&L
 */

import express from 'express';
import pnlService from '../../services/pnl.service.js';
import instanceService from '../../services/instance.service.js';
import positionsService from '../../services/positions.service.js';
import openalgoClient from '../../integrations/openalgo/client.js';
import { log } from '../../core/logger.js';
import { NotFoundError } from '../../core/errors.js';

const router = express.Router();

/**
 * GET /api/v1/positions/all
 * Get positions from all active instances
 * Query params: onlyOpen=true/false (default: false)
 * NOTE: Must be before /:instanceId routes to avoid capturing "all" as instanceId
 */
router.get('/all', async (req, res, next) => {
  try {
    const onlyOpen = req.query.onlyOpen === 'true';

    const positions = await positionsService.getAllPositions({ onlyOpen });

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

    // Get positionbook from OpenAlgo
    const positions = await openalgoClient.getPositionBook(instance);

    res.json({
      status: 'success',
      data: positions,
      count: positions.length,
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
router.post('/:instanceId/close', async (req, res, next) => {
  try {
    const instanceId = parseInt(req.params.instanceId, 10);
    const instance = await instanceService.getInstanceById(instanceId);

    const strategy = instance.strategy_tag || 'default';

    // Close positions via OpenAlgo
    await openalgoClient.closePosition(instance, strategy);

    res.json({
      status: 'success',
      message: 'Close position request sent',
    });
  } catch (error) {
    next(error);
  }
});

export default router;
