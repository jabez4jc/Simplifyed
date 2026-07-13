/**
 * GTT Routes
 * API endpoints for listing/cancelling broker-side GTT (Good-Till-Triggered) orders.
 * Placement happens internally (strategy.service.js / watchlist exit-config), not via a
 * direct "place" route, since a GTT exit is always derived from an existing position's
 * entry price + target/stoploss config rather than freely specified by a client.
 */

import express from 'express';
import gttService from '../../services/gtt.service.js';
import { ValidationError } from '../../core/errors.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';

const router = express.Router();
router.use(requireAuth);

// GET /api/v1/gtt?instanceId=
router.get('/', requirePermission('orders.place'), async (req, res, next) => {
  try {
    const instanceId = parseInt(req.query.instanceId, 10);
    if (!instanceId) {
      throw new ValidationError('instanceId query param is required');
    }
    const gtts = await gttService.listActiveGtts(instanceId);
    res.json({ status: 'success', data: gtts, count: gtts.length });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/v1/gtt/:triggerId?instanceId=
router.delete('/:triggerId', requirePermission('orders.cancel'), async (req, res, next) => {
  try {
    const instanceId = parseInt(req.query.instanceId, 10);
    if (!instanceId) {
      throw new ValidationError('instanceId query param is required');
    }
    const result = await gttService.cancelGtt(instanceId, req.params.triggerId);
    res.json({ status: 'success', data: result });
  } catch (error) {
    next(error);
  }
});

export default router;
