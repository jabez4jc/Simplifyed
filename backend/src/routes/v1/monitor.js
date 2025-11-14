/**
 * Monitor Routes
 * Handle order monitoring status and history
 */

import express from 'express';
import db from '../../core/database.js';
import orderMonitorService from '../../services/order-monitor.service.js';

const router = express.Router();

/**
 * GET /api/v1/monitor/status
 * Get monitoring service status
 */
router.get('/status', async (req, res) => {
  try {
    const status = orderMonitorService.getStatus();

    // Get count of analyzer instances being monitored
    const analyzerInstances = await db.all(`
      SELECT COUNT(*) as count
      FROM instances
      WHERE is_active = 1 AND is_analyzer_mode = 1
    `);

    res.json({
      status: 'success',
      data: {
        ...status,
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

/**
 * GET /api/v1/monitor/history
 * Get trigger history
 */
router.get('/history', async (req, res) => {
  try {
    const { limit = 50, offset = 0, instance_id } = req.query;

    let sql = `
      SELECT
        oml.*,
        i.name as instance_name,
        i.broker
      FROM order_monitor_log oml
      JOIN instances i ON i.id = oml.instance_id
      WHERE 1=1
    `;
    const params = [];

    if (instance_id) {
      sql += ' AND oml.instance_id = ?';
      params.push(instance_id);
    }

    sql += ' ORDER BY oml.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const logs = await db.all(sql, params);

    // Get total count
    let countSql = 'SELECT COUNT(*) as total FROM order_monitor_log WHERE 1=1';
    const countParams = [];
    if (instance_id) {
      countSql += ' AND instance_id = ?';
      countParams.push(instance_id);
    }

    const countResult = await db.get(countSql, countParams);

    res.json({
      status: 'success',
      data: {
        logs,
        total: countResult.total,
        limit: parseInt(limit),
        offset: parseInt(offset),
      },
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message,
    });
  }
});

/**
 * GET /api/v1/monitor/analyzer-trades
 * Get analyzer mode trades history
 */
router.get('/analyzer-trades', async (req, res) => {
  try {
    const { limit = 50, offset = 0, instance_id } = req.query;

    let sql = `
      SELECT
        at.*,
        i.name as instance_name,
        i.broker
      FROM analyzer_trades at
      JOIN instances i ON i.id = at.instance_id
      WHERE 1=1
    `;
    const params = [];

    if (instance_id) {
      sql += ' AND at.instance_id = ?';
      params.push(instance_id);
    }

    sql += ' ORDER BY at.simulated_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const trades = await db.all(sql, params);

    // Get total count and P&L summary
    let countSql = 'SELECT COUNT(*) as total, SUM(pnl) as total_pnl FROM analyzer_trades WHERE 1=1';
    const countParams = [];
    if (instance_id) {
      countSql += ' AND instance_id = ?';
      countParams.push(instance_id);
    }

    const summary = await db.get(countSql, countParams);

    res.json({
      status: 'success',
      data: {
        trades,
        total: summary.total,
        total_pnl: summary.total_pnl || 0,
        limit: parseInt(limit),
        offset: parseInt(offset),
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
