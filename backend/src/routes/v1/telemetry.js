/**
 * Telemetry Routes
 * Exposes lightweight monitoring data for rate limits and cache freshness
 */

import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import openalgoClient from '../../integrations/openalgo/client.js';
import marketDataFeedService from '../../services/market-data-feed.service.js';
import openalgoWsService from '../../services/openalgo-ws.service.js';

const router = express.Router();
router.use(requireAuth);

/**
 * GET /api/v1/telemetry/rate-limits
 * Returns per-instance rate counters plus health state (cooldowns/manual refresh)
 */
router.get('/rate-limits', (req, res) => {
  const metrics = openalgoClient.getInstanceMetrics();
   const budgets = openalgoClient.getRateBudgets();
   const budgetByKey = new Map(budgets.map((b) => [b.key, b]));
  const data = metrics.map((entry) => {
    const health = entry.id ? openalgoClient.getInstanceHealthStatus(entry.id) : null;
    return {
      ...entry,
      budget: budgetByKey.get(entry.key) || null,
      health,
    };
  });

  res.json({
    status: 'success',
    data,
  });
});

/**
 * GET /api/v1/telemetry/cache-status
 * Returns cache freshness and circuit state for quotes/positions/funds/orderbook/tradebook
 */
router.get('/cache-status', (req, res) => {
  const status = marketDataFeedService.getCacheStatus();
  res.json({
    status: 'success',
    data: status,
  });
});

/**
 * GET /api/v1/telemetry/ws-subscriptions
 * Lists current WebSocket quote subscriptions per instance
 */
router.get('/ws-subscriptions', (req, res) => {
  const subs = openalgoWsService.getSubscriptions();
  res.json({
    status: 'success',
    data: subs,
  });
});

export default router;
