/**
 * API v1 Routes
 * Main router aggregating all v1 API endpoints
 */

import express from 'express';
import authRoutes from './auth.js';
import instanceRoutes from './instances.js';
import watchlistRoutes from './watchlists.js';
import strategyRoutes from './strategies.js';
import gttRoutes from './gtt.js';
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
import rbacRoutes from './rbac.js';
import notificationRoutes from './notifications.js';
import auditRoutes from './audit.js';
import riskEventsRoutes from './risk-events.js';
import healthCheckRoutes from './health-check.js';
import telegramRoutes from './telegram.js';
import telemetryRoutes from './telemetry.js';
import snapshotRoutes from './snapshots.js';
import pnlSnapshotsRoutes from './pnl-snapshots.js';
import historyRoutes from './history.js';
import { getAppReadyStatus } from '../../middleware/instruments-refresh.middleware.js';
import { toISTISOString } from '../../utils/time.js';
import { config } from '../../core/config.js';
import { requirePermission } from '../../middleware/auth.js';

const router = express.Router();

// Mount route modules
router.use('/auth', authRoutes);
router.use('/instances', instanceRoutes);
router.use('/watchlists', watchlistRoutes);
router.use('/strategies', strategyRoutes);
router.use('/gtt', gttRoutes);
router.use('/orders', orderRoutes);
router.use('/positions', positionRoutes);
router.use('/symbols', symbolRoutes);
router.use('/instruments', instrumentsRoutes);
router.use('/polling', pollingRoutes);
router.use('/quickorders', quickOrderRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/telegram', telegramRoutes);
router.use('/monitor', monitorRoutes);
router.use('/settings', settingsRoutes);
router.use('/option-chain', optionChainRoutes);
router.use('/trades', tradeRoutes);
router.use('/rbac', rbacRoutes);
router.use('/notifications', notificationRoutes);
router.use('/audit', auditRoutes);
router.use('/risk-events', riskEventsRoutes);
router.use('/health-check', healthCheckRoutes);
router.use('/telemetry', telemetryRoutes);
router.use('/snapshots', snapshotRoutes);
router.use('/pnl-snapshots', pnlSnapshotsRoutes);
router.use('/history', historyRoutes);

// Public config for frontend - intentionally unauthenticated since none of these values are
// sensitive (contrast with the webhook token below, which lives behind GET /webhook-config
// specifically because it's a live-trading credential). Anyone on the network can call this
// with no login at all, so never add anything sensitive here.
router.get('/public-config', (req, res) => {
  res.json({
    status: 'success',
    data: {
      wsGatewayEnabled: config.wsGateway?.enabled || false,
      wsGatewayPath: config.wsGateway?.path || '/stream',
      marketData: {
        positionsPollIdleMs: config.marketDataFeed?.positionIntervalIdleMs || 30000,
        positionsPollActiveMs: config.marketDataFeed?.positionIntervalActiveMs || 8000,
        ltpCacheIdleMs: config.marketDataFeed?.quoteTtlIdleMs || 15000,
        ltpCacheActiveMs: config.marketDataFeed?.quoteTtlActiveMs || 10000,
      },
    },
  });
});

// Webhook token is a live-trading credential (it's the sole auth check on
// /webhook/tradingview/broadcast) - keep it behind settings.manage, not the public-config route.
router.get('/webhook-config', requirePermission('settings.manage'), (req, res) => {
  res.json({
    status: 'success',
    data: {
      webhookToken: config.webhooks?.tradingviewBroadcast?.token || null,
    },
  });
});

// Health check endpoint
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: toISTISOString(),
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
    timestamp: toISTISOString(),
    message: status.ready
      ? 'App is ready for trading'
      : status.refreshInProgress
        ? 'Instruments cache is being loaded...'
        : 'Instruments cache not loaded yet'
  });
});

export default router;
