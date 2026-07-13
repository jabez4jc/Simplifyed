import express from 'express';
import riskEventsService from '../../services/risk-events.service.js';
import { ValidationError } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';

const router = express.Router();

router.get('/', requirePermission('pages.audit.view'), async (req, res, next) => {
  try {
    const instanceId = req.query.instanceId ? parseInt(req.query.instanceId, 10) : null;
    const watchlistId = req.query.watchlistId ? parseInt(req.query.watchlistId, 10) : null;
    const symbolId = req.query.symbolId ? parseInt(req.query.symbolId, 10) : null;
    const from = req.query.from ? String(req.query.from) : null;
    const to = req.query.to ? String(req.query.to) : null;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 200;

    if (Number.isNaN(limit) || limit < 1 || limit > 1000) {
      throw new ValidationError('limit must be between 1 and 1000');
    }

    const rows = await riskEventsService.list({ instanceId, watchlistId, symbolId, from, to, limit });

    res.json({
      status: 'success',
      data: rows,
      count: rows.length,
      limit,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
