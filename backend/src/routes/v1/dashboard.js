/**
 * Dashboard Routes
 */

import express from 'express';
import dashboardService from '../../services/dashboard.service.js';
import { requirePermission } from '../../middleware/auth.js';

const router = express.Router();

/**
 * GET /api/v1/dashboard/metrics
 * Get aggregated dashboard metrics from all instances
 * Returns metrics grouped by Live and Analyzer modes
 */
router.get('/metrics', requirePermission('pages.dashboard.view'), async (req, res, next) => {
  try {
    const refresh = req.query.refresh === 'true';
    const metrics = await dashboardService.getDashboardMetrics({ refresh });

    res.json({
      status: 'success',
      data: metrics,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
