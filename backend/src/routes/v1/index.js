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
import telegramRoutes from './telegram.js';
import monitorRoutes from './monitor.js';

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
router.use('/telegram', telegramRoutes);
router.use('/monitor', monitorRoutes);

// Health check endpoint
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
  });
});

export default router;
