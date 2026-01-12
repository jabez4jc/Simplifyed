import express from 'express';
import db from '../../core/database.js';
import { ValidationError } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';

const router = express.Router();

router.get('/', requirePermission('pages.audit.view'), async (req, res, next) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 100;
    const offset = req.query.offset ? parseInt(req.query.offset, 10) : 0;
    const action = req.query.action ? String(req.query.action) : null;
    const userId = req.query.userId ? parseInt(req.query.userId, 10) : null;
    const since = req.query.since ? String(req.query.since) : null;

    if (Number.isNaN(limit) || limit < 1 || limit > 500) {
      throw new ValidationError('limit must be between 1 and 500');
    }
    if (Number.isNaN(offset) || offset < 0) {
      throw new ValidationError('offset must be >= 0');
    }
    if (userId !== null && Number.isNaN(userId)) {
      throw new ValidationError('userId must be a valid integer');
    }

    let query = `
      SELECT a.*, u.email as user_email
      FROM audit_logs a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE 1=1
    `;
    const params = [];

    if (action) {
      query += ' AND a.action = ?';
      params.push(action);
    }
    if (userId !== null) {
      query += ' AND a.user_id = ?';
      params.push(userId);
    }
    if (since) {
      query += ' AND a.created_at >= ?';
      params.push(since);
    }

    query += ' ORDER BY a.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = await db.all(query, params);

    res.json({
      status: 'success',
      data: rows,
      count: rows.length,
      limit,
      offset,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
