/**
 * Daily P&L Snapshot Routes
 */

import express from 'express';
import { requirePermission } from '../../middleware/auth.js';
import { ValidationError } from '../../core/errors.js';
import pnlSnapshotService from '../../services/pnl-snapshot.service.js';

const router = express.Router();

router.use(requirePermission('monitor.view'));

function parseDate(value, label) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new ValidationError(`${label} must be in YYYY-MM-DD format`);
  }
  return text;
}

function buildCsv(rows) {
  const headers = [
    'date',
    'instance_id',
    'instance_name',
    'broker',
    'total_pnl',
    'buy_trades',
    'sell_trades',
    'buy_value',
    'sell_value',
    'updated_at',
  ];
  const lines = [headers.join(',')];
  rows.forEach((row) => {
    const values = [
      row.snapshot_date,
      row.instance_id,
      row.instance_name,
      row.broker || '',
      row.total_pnl,
      row.buy_trades,
      row.sell_trades,
      row.buy_value,
      row.sell_value,
      row.updated_at,
    ].map((value) => {
      const str = String(value ?? '');
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    });
    lines.push(values.join(','));
  });
  return lines.join('\n');
}

/**
 * GET /api/v1/pnl-snapshots?start=YYYY-MM-DD&end=YYYY-MM-DD
 */
router.get('/', async (req, res, next) => {
  try {
    const startDate = parseDate(req.query.start, 'start');
    const endDate = parseDate(req.query.end, 'end');
    const rows = await pnlSnapshotService.listSnapshots(startDate, endDate);
    res.json({ status: 'success', data: rows });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/pnl-snapshots/export?start=YYYY-MM-DD&end=YYYY-MM-DD
 */
router.get('/export', async (req, res, next) => {
  try {
    const startDate = parseDate(req.query.start, 'start');
    const endDate = parseDate(req.query.end, 'end');
    const rows = await pnlSnapshotService.listSnapshots(startDate, endDate);
    const csv = buildCsv(rows);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="daily-pnl-snapshots-${startDate}-to-${endDate}.csv"`);
    res.send(csv);
  } catch (error) {
    next(error);
  }
});

export default router;
