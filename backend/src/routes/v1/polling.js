/**
 * Polling Routes
 * API endpoints for polling service control
 */

import express from 'express';
import pollingService from '../../services/polling.service.js';
import { log } from '../../core/logger.js';
import { ValidationError } from '../../core/errors.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import db from '../../core/database.js';

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
router.post('/start', requirePermission('marketdata.pause_resume'), async (req, res, next) => {
  try {
    await pollingService.start();
    if ((req.user?.role || '').toUpperCase() !== 'ADMIN') {
      logAudit(req, 'polling.start', {});
    }

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
router.post('/stop', requirePermission('marketdata.pause_resume'), (req, res) => {
  pollingService.stop();
  if ((req.user?.role || '').toUpperCase() !== 'ADMIN') {
    logAudit(req, 'polling.stop', {});
  }

  res.json({
    status: 'success',
    message: 'Polling service stopped',
  });
});

/**
 * POST /api/v1/polling/market-data/start
 * Start market data polling for watchlist
 */
router.post('/market-data/start', requirePermission('marketdata.pause_resume'), async (req, res, next) => {
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
    if ((req.user?.role || '').toUpperCase() !== 'ADMIN') {
      logAudit(req, 'marketdata.start', { watchlistId: id });
    }

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
router.post('/market-data/stop', requirePermission('marketdata.pause_resume'), (req, res) => {
  pollingService.stopMarketDataPolling();
  if ((req.user?.role || '').toUpperCase() !== 'ADMIN') {
    logAudit(req, 'marketdata.stop', {});
  }

  res.json({
    status: 'success',
    message: 'Market data polling stopped',
  });
});

export default router;
