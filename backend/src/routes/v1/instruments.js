/**
 * Instruments Routes
 * API endpoints for broker instruments cache management
 */

import express from 'express';
import instrumentsService from '../../services/instruments.service.js';
import { log } from '../../core/logger.js';
import { ValidationError } from '../../core/errors.js';
import { sanitizeString } from '../../utils/sanitizers.js';

const router = express.Router();

/**
 * GET /api/v1/instruments/search
 * Fast search using cached instruments (SQLite FTS5)
 */
router.get('/search', async (req, res, next) => {
  try {
    const { query, exchange, instrumenttype, limit } = req.query;

    if (!query) {
      throw new ValidationError('query parameter is required');
    }

    // Search cached instruments
    const results = await instrumentsService.searchInstruments(
      sanitizeString(query),
      {
        exchange: exchange ? sanitizeString(exchange).toUpperCase() : null,
        instrumenttype: instrumenttype ? sanitizeString(instrumenttype).toUpperCase() : null,
        limit: limit ? parseInt(limit, 10) : 50
      }
    );

    res.json({
      status: 'success',
      data: results,
      count: results.length,
      source: 'cache'
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/instruments/option-chain
 * Build option chain from cached instruments
 */
router.get('/option-chain', async (req, res, next) => {
  try {
    const { symbol, expiry, exchange } = req.query;

    if (!symbol) {
      throw new ValidationError('symbol parameter is required');
    }

    if (!expiry) {
      throw new ValidationError('expiry parameter is required');
    }

    const optionChain = await instrumentsService.buildOptionChain(
      sanitizeString(symbol).toUpperCase(),
      sanitizeString(expiry),
      exchange ? sanitizeString(exchange).toUpperCase() : 'NFO'
    );

    res.json({
      status: 'success',
      data: optionChain
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/instruments/expiries
 * Get available expiry dates for a symbol
 */
router.get('/expiries', async (req, res, next) => {
  try {
    const { symbol, exchange } = req.query;

    if (!symbol) {
      throw new ValidationError('symbol parameter is required');
    }

    const expiries = await instrumentsService.getExpiries(
      sanitizeString(symbol).toUpperCase(),
      exchange ? sanitizeString(exchange).toUpperCase() : 'NFO'
    );

    res.json({
      status: 'success',
      data: expiries,
      count: expiries.length
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/instruments/stats
 * Get instruments cache statistics
 */
router.get('/stats', async (req, res, next) => {
  try {
    const stats = await instrumentsService.getStatistics();

    res.json({
      status: 'success',
      data: stats
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/instruments/needs-refresh
 * Check if instruments cache needs refresh
 */
router.get('/needs-refresh', async (req, res, next) => {
  try {
    const { exchange } = req.query;

    const needsRefresh = await instrumentsService.needsRefresh(
      exchange ? sanitizeString(exchange).toUpperCase() : null
    );

    res.json({
      status: 'success',
      data: {
        needs_refresh: needsRefresh,
        exchange: exchange || 'ALL'
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/instruments/refresh
 * Manually trigger instruments refresh
 */
router.post('/refresh', async (req, res, next) => {
  try {
    const { exchange, instanceId } = req.body;

    log.info('Manual instruments refresh triggered', {
      exchange: exchange || 'ALL',
      instanceId,
      user: req.user?.email
    });

    // Start refresh (can be long-running, so we return immediately)
    const refreshPromise = instrumentsService.refreshInstruments(
      exchange ? sanitizeString(exchange).toUpperCase() : null,
      instanceId ? parseInt(instanceId, 10) : null
    );

    // For smaller exchanges, wait for completion (up to 30 seconds)
    // For large refreshes, return immediately with 202 Accepted
    const timeout = new Promise((resolve) =>
      setTimeout(() => resolve({ timeout: true }), 30000)
    );

    const result = await Promise.race([refreshPromise, timeout]);

    if (result.timeout) {
      // Refresh is still running in background
      res.status(202).json({
        status: 'accepted',
        message: 'Instruments refresh is running in background',
        exchange: exchange || 'ALL'
      });
    } else {
      // Refresh completed within timeout
      res.json({
        status: 'success',
        message: 'Instruments refreshed successfully',
        data: result
      });
    }
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/instruments/:exchange/:symbol
 * Get specific instrument by exchange and symbol
 */
router.get('/:exchange/:symbol', async (req, res, next) => {
  try {
    const { exchange, symbol } = req.params;

    const instrument = await instrumentsService.getInstrument(
      sanitizeString(symbol).toUpperCase(),
      sanitizeString(exchange).toUpperCase()
    );

    if (!instrument) {
      res.status(404).json({
        status: 'error',
        message: 'Instrument not found',
        data: null
      });
      return;
    }

    res.json({
      status: 'success',
      data: instrument
    });
  } catch (error) {
    next(error);
  }
});

export default router;
