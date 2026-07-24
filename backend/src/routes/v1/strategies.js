/**
 * Strategy Routes
 * API endpoints for multi-leg strategy CRUD and manual execution.
 */

import express from 'express';
import strategyService from '../../services/strategy.service.js';
import { ValidationError } from '../../core/errors.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';

const router = express.Router();
router.use(requireAuth);

// GET /api/v1/strategies?watchlist_id=1
router.get('/', requirePermission('pages.watchlists.view'), async (req, res, next) => {
  try {
    const watchlistId = parseInt(req.query.watchlist_id, 10);
    if (!watchlistId) {
      throw new ValidationError('watchlist_id query param is required');
    }
    const strategies = await strategyService.listStrategies(watchlistId);
    res.json({ status: 'success', data: strategies, count: strategies.length });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/strategies/:id
router.get('/:id', requirePermission('pages.watchlists.view'), async (req, res, next) => {
  try {
    const strategy = await strategyService.getStrategyWithLegs(req.params.id);
    res.json({ status: 'success', data: strategy });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/strategies
router.post('/', requirePermission('watchlists.manage'), async (req, res, next) => {
  try {
    const strategy = await strategyService.createStrategy(req.body);
    res.status(201).json({ status: 'success', data: strategy });
  } catch (error) {
    next(error);
  }
});

// PUT /api/v1/strategies/:id
router.put('/:id', requirePermission('watchlists.manage'), async (req, res, next) => {
  try {
    const strategy = await strategyService.updateStrategy(req.params.id, req.body);
    res.json({ status: 'success', data: strategy });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/v1/strategies/:id
router.delete('/:id', requirePermission('watchlists.manage'), async (req, res, next) => {
  try {
    await strategyService.deleteStrategy(req.params.id);
    res.json({ status: 'success', message: 'Strategy deleted' });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/strategies/:id/instances - the strategy's own explicit instance assignment (empty
// means it has none set and falls back to the container watchlist's instances at execute time).
router.get('/:id/instances', requirePermission('pages.watchlists.view'), async (req, res, next) => {
  try {
    const instances = await strategyService.getStrategyInstances(req.params.id);
    res.json({ status: 'success', data: instances });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/strategies/:id/instances
router.post('/:id/instances', requirePermission('watchlists.instances.manage'), async (req, res, next) => {
  try {
    const { instanceId } = req.body;
    if (!instanceId) {
      throw new ValidationError('instanceId is required');
    }
    const assignment = await strategyService.assignStrategyInstance(req.params.id, instanceId);
    res.status(201).json({ status: 'success', message: 'Instance assigned successfully', data: assignment });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/v1/strategies/:id/instances/:instanceId
router.delete('/:id/instances/:instanceId', requirePermission('watchlists.instances.manage'), async (req, res, next) => {
  try {
    await strategyService.unassignStrategyInstance(req.params.id, req.params.instanceId);
    res.json({ status: 'success', message: 'Instance unassigned successfully' });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/strategies/:id/legs
router.post('/:id/legs', requirePermission('watchlists.symbols.manage'), async (req, res, next) => {
  try {
    const leg = await strategyService.addLeg(req.params.id, req.body);
    res.status(201).json({ status: 'success', data: leg });
  } catch (error) {
    next(error);
  }
});

// PUT /api/v1/strategies/legs/:legId
router.put('/legs/:legId', requirePermission('watchlists.symbols.manage'), async (req, res, next) => {
  try {
    const leg = await strategyService.updateLeg(req.params.legId, req.body);
    res.json({ status: 'success', data: leg });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/v1/strategies/legs/:legId
router.delete('/legs/:legId', requirePermission('watchlists.symbols.manage'), async (req, res, next) => {
  try {
    await strategyService.deleteLeg(req.params.legId);
    res.json({ status: 'success', message: 'Leg deleted' });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/strategies/legs/:legId/preview?instanceId= - resolve a leg's exact symbol without
// placing an order (used by the UI to fetch Greeks for an option leg on demand).
router.get('/legs/:legId/preview', requirePermission('pages.watchlists.view'), async (req, res, next) => {
  try {
    const instanceId = parseInt(req.query.instanceId, 10);
    if (!instanceId) {
      throw new ValidationError('instanceId query param is required');
    }
    const preview = await strategyService.previewLeg(req.params.legId, instanceId);
    res.json({ status: 'success', data: preview });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/strategies/:id/execute
// instanceId is optional - when omitted, targets the strategy's own assigned instances (see
// GET/POST/DELETE :id/instances), or every active, order-enabled instance on the container
// watchlist if the strategy has never had its own assignment set. Pass instanceId to override
// and target just one instance.
// legId is optional - when omitted, every leg is entered; pass it to enter just that leg.
router.post('/:id/execute', requirePermission('orders.place'), async (req, res, next) => {
  try {
    const { instanceId, legId, allowScaleIn } = req.body;
    const result = await strategyService.executeStrategy(req.params.id, {
      instanceId: instanceId ? parseInt(instanceId, 10) : null,
      legId: legId ? parseInt(legId, 10) : null,
      allowScaleIn: allowScaleIn === true,
      userId: req.user?.id || null,
      source: 'strategy_manual',
    });
    res.json({ status: 'success', data: result });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/strategies/:id/exit
// Closes every still-open leg (per the strategy_leg_executions ledger executeStrategy writes to)
// - same optional instanceId override / strategy-then-watchlist-fallback default as /execute.
// legId is optional - when omitted, every open leg is closed; pass it to close just that leg.
router.post('/:id/exit', requirePermission('orders.place'), async (req, res, next) => {
  try {
    const { instanceId, legId } = req.body;
    const result = await strategyService.exitStrategy(req.params.id, {
      instanceId: instanceId ? parseInt(instanceId, 10) : null,
      legId: legId ? parseInt(legId, 10) : null,
      userId: req.user?.id || null,
      source: 'strategy_manual',
    });
    res.json({ status: 'success', data: result });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/strategies/:id/status - live execution status (resolved legs + open/closed state +
// current P&L where available) across every instance the strategy has fired on.
router.get('/:id/status', requirePermission('pages.watchlists.view'), async (req, res, next) => {
  try {
    const status = await strategyService.getExecutionStatus(req.params.id);
    res.json({ status: 'success', data: status });
  } catch (error) {
    next(error);
  }
});

export default router;
