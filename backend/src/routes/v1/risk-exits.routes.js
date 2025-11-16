/**
 * Risk Exits Routes
 * API endpoints for monitoring and managing risk exits
 */

import express from 'express';
import db from '../../core/database.js';
import riskEngineService from '../../services/risk-engine.service.js';
import riskExitExecutorService from '../../services/risk-exit-executor.service.js';
import { log } from '../../core/logger.js';
import { NotFoundError } from '../../core/errors.js';

const router = express.Router();

/**
 * GET /api/v1/risk-exits
 * Get risk exits with optional filters
 */
router.get('/', async (req, res, next) => {
  try {
    const { status, instanceId, limit = 100 } = req.query;

    let query = `
      SELECT
        re.*,
        ls.symbol,
        ls.exchange,
        ls.index_name,
        ls.option_type,
        ls.strike_price,
        i.name as instance_name
      FROM risk_exits re
      JOIN leg_state ls ON re.leg_state_id = ls.id
      JOIN instances i ON ls.instance_id = i.id
      WHERE 1=1
    `;

    const params = [];

    if (status) {
      query += ' AND re.status = ?';
      params.push(status);
    }

    if (instanceId) {
      query += ' AND ls.instance_id = ?';
      params.push(parseInt(instanceId, 10));
    }

    query += ' ORDER BY re.triggered_at DESC LIMIT ?';
    params.push(parseInt(limit, 10));

    const exits = await db.all(query, params);

    // Parse JSON fields
    const parsedExits = exits.map(exit => ({
      ...exit,
      exit_orders: exit.exit_orders_json ? JSON.parse(exit.exit_orders_json) : null,
      execution_summary: exit.execution_summary ? JSON.parse(exit.execution_summary) : null,
    }));

    res.json({
      status: 'success',
      data: parsedExits,
      count: parsedExits.length,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/risk-exits/:riskTriggerId
 * Get risk exit by trigger ID
 */
router.get('/:riskTriggerId', async (req, res, next) => {
  try {
    const { riskTriggerId } = req.params;

    const exit = await db.get(
      `SELECT
        re.*,
        ls.symbol,
        ls.exchange,
        ls.index_name,
        ls.option_type,
        ls.strike_price,
        ls.net_qty,
        ls.weighted_avg_entry,
        i.name as instance_name
      FROM risk_exits re
      JOIN leg_state ls ON re.leg_state_id = ls.id
      JOIN instances i ON ls.instance_id = i.id
      WHERE re.risk_trigger_id = ?`,
      [riskTriggerId]
    );

    if (!exit) {
      throw new NotFoundError('Risk exit not found');
    }

    // Parse JSON fields
    exit.exit_orders = exit.exit_orders_json ? JSON.parse(exit.exit_orders_json) : null;
    exit.execution_summary = exit.execution_summary ? JSON.parse(exit.execution_summary) : null;

    res.json({
      status: 'success',
      data: exit,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/risk-exits/stats
 * Get risk exit statistics
 */
router.get('/stats/summary', async (req, res, next) => {
  try {
    const { instanceId, days = 7 } = req.query;

    let query = `
      SELECT
        COUNT(*) as total_exits,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'executing' THEN 1 ELSE 0 END) as executing,
        SUM(CASE WHEN trigger_type = 'TP_HIT' THEN 1 ELSE 0 END) as tp_exits,
        SUM(CASE WHEN trigger_type = 'SL_HIT' THEN 1 ELSE 0 END) as sl_exits,
        SUM(CASE WHEN trigger_type = 'TSL_HIT' THEN 1 ELSE 0 END) as tsl_exits,
        SUM(total_pnl) as total_pnl,
        AVG(total_pnl) as avg_pnl
      FROM risk_exits re
      JOIN leg_state ls ON re.leg_state_id = ls.id
      WHERE re.triggered_at > datetime('now', '-' || ? || ' days')
    `;

    const params = [parseInt(days, 10)];

    if (instanceId) {
      query += ' AND ls.instance_id = ?';
      params.push(parseInt(instanceId, 10));
    }

    const stats = await db.get(query, params);

    // Get executor service stats
    const executorStats = await riskExitExecutorService.getExecutionStats();

    res.json({
      status: 'success',
      data: {
        ...stats,
        executor: executorStats,
        period_days: parseInt(days, 10),
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/risk-exits/pending
 * Get all pending risk exits
 */
router.get('/pending/list', async (req, res, next) => {
  try {
    const pending = await riskEngineService.getPendingRiskExits();

    res.json({
      status: 'success',
      data: pending,
      count: pending.length,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
