/**
 * Leg State Routes
 * API endpoints for querying position state (leg_state table)
 */

import express from 'express';
import db from '../../core/database.js';
import { log } from '../../core/logger.js';

const router = express.Router();

/**
 * GET /api/v1/leg-state
 * Get leg state (positions) with optional filters
 *
 * Query parameters:
 * - instanceId: Filter by instance ID (required for most queries)
 * - symbol: Filter by symbol
 * - exchange: Filter by exchange
 * - riskEnabled: Filter by risk_enabled status (true/false)
 */
router.get('/', async (req, res, next) => {
  try {
    const { instanceId, symbol, exchange, riskEnabled } = req.query;

    let query = `
      SELECT
        ls.*,
        i.name as instance_name
      FROM leg_state ls
      JOIN instances i ON ls.instance_id = i.id
      WHERE 1=1
    `;

    const params = [];

    if (instanceId) {
      query += ' AND ls.instance_id = ?';
      params.push(parseInt(instanceId, 10));
    }

    if (symbol) {
      query += ' AND ls.symbol = ?';
      params.push(symbol);
    }

    if (exchange) {
      query += ' AND ls.exchange = ?';
      params.push(exchange);
    }

    if (riskEnabled !== undefined) {
      query += ' AND ls.risk_enabled = ?';
      params.push(riskEnabled === 'true' ? 1 : 0);
    }

    query += ' ORDER BY ls.updated_at DESC';

    const legs = await db.all(query, params);

    res.json({
      status: 'success',
      data: legs,
      count: legs.length,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/leg-state/:id
 * Get specific leg state by ID
 */
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    const leg = await db.get(
      `SELECT
        ls.*,
        i.name as instance_name
      FROM leg_state ls
      JOIN instances i ON ls.instance_id = i.id
      WHERE ls.id = ?`,
      [parseInt(id, 10)]
    );

    if (!leg) {
      return res.status(404).json({
        status: 'error',
        message: 'Leg state not found',
      });
    }

    res.json({
      status: 'success',
      data: leg,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
