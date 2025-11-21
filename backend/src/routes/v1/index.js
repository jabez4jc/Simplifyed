/**
 * API v1 Routes
 * Main router aggregating all v1 API endpoints
 */

import express from 'express';
import instanceRoutes from './instances.js';
import watchlistRoutes from './watchlists.js';
import orderRoutes from './orders.js';
import positionRoutes from './positions.js';
import symbolRoutes from './symbols.js';
import instrumentsRoutes from './instruments.js';
import pollingRoutes from './polling.js';
import quickOrderRoutes from './quickorders.js';
import dashboardRoutes from './dashboard.js';
import monitorRoutes from './monitor.js';
import settingsRoutes from './settings.js';
import optionChainRoutes from './option-chain.js';
import tradeRoutes from './trades.js';
import { getAppReadyStatus } from '../../middleware/instruments-refresh.middleware.js';

const router = express.Router();

// Mount route modules
router.use('/instances', instanceRoutes);
router.use('/watchlists', watchlistRoutes);
router.use('/orders', orderRoutes);
router.use('/positions', positionRoutes);
router.use('/symbols', symbolRoutes);
router.use('/instruments', instrumentsRoutes);
router.use('/polling', pollingRoutes);
router.use('/quickorders', quickOrderRoutes);
router.use('/dashboard', dashboardRoutes);
// Telegram routes disabled temporarily
router.use('/monitor', monitorRoutes);
router.use('/settings', settingsRoutes);
router.use('/option-chain', optionChainRoutes);
router.use('/trades', tradeRoutes);

// Health check endpoint
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
  });
});

// Ready check endpoint - shows if app is ready for trading
// Returns 200 OK when ready, 503 Service Unavailable when not ready
// Useful for infrastructure readiness probes (Kubernetes, load balancers, etc.)
router.get('/ready', (req, res) => {
  const status = getAppReadyStatus();

  // Return 503 if not ready (for infrastructure readiness probes)
  const httpStatus = status.ready ? 200 : 503;

  res.status(httpStatus).json({
    status: status.ready ? 'ready' : 'not_ready',
    ready: status.ready,
    refreshInProgress: status.refreshInProgress,
    error: status.error,
    lastRefreshDate: status.lastRefreshDate,
    timestamp: new Date().toISOString(),
    message: status.ready
      ? 'App is ready for trading'
      : status.refreshInProgress
        ? 'Instruments cache is being loaded...'
        : 'Instruments cache not loaded yet'
  });
});

export default router;
