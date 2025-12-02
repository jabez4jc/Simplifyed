import express from 'express';
import instanceHealthService from '../../services/instance-health.service.js';
import { requirePermission } from '../../middleware/auth.js';

const router = express.Router();

// Trigger health checks manually (admin)
router.post('/run', requirePermission('settings.manage'), async (req, res, next) => {
  try {
    await instanceHealthService.runHealthChecks();
    res.json({ status: 'success', message: 'Health checks triggered' });
  } catch (err) {
    next(err);
  }
});

export default router;
