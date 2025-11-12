/**
 * Watchlist Routes
 * API endpoints for watchlist and symbol management
 */

import express from 'express';
import watchlistService from '../../services/watchlist.service.js';
import { log } from '../../core/logger.js';
import {
  NotFoundError,
  ConflictError,
  ValidationError,
} from '../../core/errors.js';

const router = express.Router();

/**
 * GET /api/v1/watchlists
 * Get all watchlists
 */
router.get('/', async (req, res, next) => {
  try {
    const filters = {};

    if (req.query.is_active !== undefined) {
      filters.is_active = req.query.is_active === 'true';
    }

    const watchlists = await watchlistService.getAllWatchlists(filters);

    res.json({
      status: 'success',
      data: watchlists,
      count: watchlists.length,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/watchlists/:id
 * Get watchlist by ID with symbols and instances
 */
router.get('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const watchlist = await watchlistService.getWatchlistById(id);

    res.json({
      status: 'success',
      data: watchlist,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/watchlists
 * Create new watchlist
 */
router.post('/', async (req, res, next) => {
  try {
    const watchlist = await watchlistService.createWatchlist(req.body);

    res.status(201).json({
      status: 'success',
      message: 'Watchlist created successfully',
      data: watchlist,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/v1/watchlists/:id
 * Update watchlist
 */
router.put('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const watchlist = await watchlistService.updateWatchlist(id, req.body);

    res.json({
      status: 'success',
      message: 'Watchlist updated successfully',
      data: watchlist,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/v1/watchlists/:id
 * Delete watchlist
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    await watchlistService.deleteWatchlist(id);

    res.json({
      status: 'success',
      message: 'Watchlist deleted successfully',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/watchlists/:id/clone
 * Clone watchlist
 */
router.post('/:id/clone', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { name } = req.body;

    if (!name) {
      throw new ValidationError('Name is required for cloned watchlist');
    }

    const cloned = await watchlistService.cloneWatchlist(id, name);

    res.status(201).json({
      status: 'success',
      message: 'Watchlist cloned successfully',
      data: cloned,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/watchlists/:id/symbols
 * Get watchlist symbols with latest quotes
 */
router.get('/:id/symbols', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const symbols = await watchlistService.getSymbolsWithQuotes(id);

    res.json({
      status: 'success',
      data: symbols,
      count: symbols.length,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/watchlists/:id/symbols
 * Add symbol to watchlist
 */
router.post('/:id/symbols', async (req, res, next) => {
  try {
    const watchlistId = parseInt(req.params.id, 10);
    const symbol = await watchlistService.addSymbol(watchlistId, req.body);

    res.status(201).json({
      status: 'success',
      message: 'Symbol added successfully',
      data: symbol,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/v1/watchlists/:id/symbols/:symbolId
 * Update symbol in watchlist
 */
router.put('/:id/symbols/:symbolId', async (req, res, next) => {
  try {
    const symbolId = parseInt(req.params.symbolId, 10);
    const symbol = await watchlistService.updateSymbol(symbolId, req.body);

    res.json({
      status: 'success',
      message: 'Symbol updated successfully',
      data: symbol,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/v1/watchlists/:id/symbols/:symbolId
 * Remove symbol from watchlist
 */
router.delete('/:id/symbols/:symbolId', async (req, res, next) => {
  try {
    const symbolId = parseInt(req.params.symbolId, 10);
    await watchlistService.removeSymbol(symbolId);

    res.json({
      status: 'success',
      message: 'Symbol removed successfully',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/watchlists/:id/instances
 * Assign instance to watchlist
 */
router.post('/:id/instances', async (req, res, next) => {
  try {
    const watchlistId = parseInt(req.params.id, 10);
    const { instanceId } = req.body;

    if (!instanceId) {
      throw new ValidationError('instanceId is required');
    }

    const assignment = await watchlistService.assignInstance(
      watchlistId,
      instanceId
    );

    res.status(201).json({
      status: 'success',
      message: 'Instance assigned successfully',
      data: assignment,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/v1/watchlists/:id/instances/:instanceId
 * Unassign instance from watchlist
 */
router.delete('/:id/instances/:instanceId', async (req, res, next) => {
  try {
    const watchlistId = parseInt(req.params.id, 10);
    const instanceId = parseInt(req.params.instanceId, 10);

    await watchlistService.unassignInstance(watchlistId, instanceId);

    res.json({
      status: 'success',
      message: 'Instance unassigned successfully',
    });
  } catch (error) {
    next(error);
  }
});

export default router;
