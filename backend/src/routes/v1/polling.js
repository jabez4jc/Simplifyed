/**
 * Polling Routes
 * API endpoints for polling service control
 */

import express from 'express';
import pollingService from '../../services/polling.service.js';
import { log } from '../../core/logger.js';
import { ValidationError } from '../../core/errors.js';

const router = express.Router();

/**
 * GET /api/v1/polling/status
 * Get polling service status
 */
router.get('/status', (req, res) => {
  const status = pollingService.getStatus();

  res.json({
    status: 'success',
    data: status,
  });
});

/**
 * POST /api/v1/polling/start
 * Start polling service
 */
router.post('/start', async (req, res, next) => {
  try {
    await pollingService.start();

    res.json({
      status: 'success',
      message: 'Polling service started',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/polling/stop
 * Stop polling service
 */
router.post('/stop', (req, res) => {
  pollingService.stop();

  res.json({
    status: 'success',
    message: 'Polling service stopped',
  });
});

/**
 * POST /api/v1/polling/market-data/start
 * Start market data polling for watchlist
 */
router.post('/market-data/start', async (req, res, next) => {
  try {
    const { watchlistId } = req.body;

    if (!watchlistId) {
      throw new ValidationError('watchlistId is required');
    }

    const id = parseInt(watchlistId, 10);
    if (isNaN(id) || id <= 0) {
      throw new ValidationError('watchlistId must be a positive integer');
    }

    await pollingService.startMarketDataPolling(id);

    res.json({
      status: 'success',
      message: 'Market data polling started',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/polling/market-data/stop
 * Stop market data polling
 */
router.post('/market-data/stop', (req, res) => {
  pollingService.stopMarketDataPolling();

  res.json({
    status: 'success',
    message: 'Market data polling stopped',
  });
});

export default router;
