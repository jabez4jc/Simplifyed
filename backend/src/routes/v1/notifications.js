import express from 'express';
import db from '../../core/database.js';
import { requireAuth } from '../../middleware/auth.js';

const router = express.Router();

router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const rows = await db.all(
      `SELECT id, title, body, severity, created_at, read
       FROM notifications
       ORDER BY created_at DESC
       LIMIT 100`
    );
    res.json({ status: 'success', data: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/read', async (req, res, next) => {
  try {
    const { id } = req.params;
    await db.run(`UPDATE notifications SET read = 1 WHERE id = ?`, [id]);
    res.json({ status: 'success' });
  } catch (err) {
    next(err);
  }
});

export default router;
