/**
 * Monitor Routes
 * Handle order monitoring status and history
 */

import express from 'express';
import db from '../../core/database.js';
import autoExitService from '../../services/auto-exit.service.js';
import { requireAuth } from '../../middleware/auth.js';

const router = express.Router();
router.use(requireAuth);

/**
 * GET /api/v1/monitor/status
 * Get monitoring service status
 */
router.get('/status', async (req, res) => {
  try {
    // The real monitor is auto-exit (targets, stop-losses, trailing stops). This used to report
    // a retired stub that always said "inactive", telling the operator nothing watched their exits.
    const status = {
      is_monitoring: Boolean(autoExitService.isRunning),
      interval_ms: autoExitService.monitorIntervalMs || null,
    };

    const eligibleInstances = await db.all(`
      SELECT COUNT(*) as count
      FROM instances
      WHERE is_active = 1
    `);
    const analyzerInstances = await db.all(`
      SELECT COUNT(*) as count
      FROM instances
      WHERE is_active = 1 AND is_analyzer_mode = 1
    `);

    res.json({
      status: 'success',
      data: {
        ...status,
        eligible_instances_count: eligibleInstances[0]?.count || 0,
        analyzer_instances_count: analyzerInstances[0]?.count || 0,
      },
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message,
    });
  }
});



export default router;
