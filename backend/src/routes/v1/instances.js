/**
 * Instance Routes
 * API endpoints for instance management
 */

import express from 'express';
import instanceService from '../../services/instance.service.js';
import pollingService from '../../services/polling.service.js';
import { log } from '../../core/logger.js';
import {
  NotFoundError,
  ConflictError,
  ValidationError,
} from '../../core/errors.js';

const router = express.Router();

/**
 * GET /api/v1/instances
 * Get all instances with optional filters
 */
router.get('/', async (req, res, next) => {
  try {
    const filters = {};

    if (req.query.is_active !== undefined) {
      filters.is_active = req.query.is_active === 'true';
    }

    if (req.query.is_analyzer_mode !== undefined) {
      filters.is_analyzer_mode = req.query.is_analyzer_mode === 'true';
    }

    if (req.query.health_status) {
      filters.health_status = req.query.health_status;
    }

    const instances = await instanceService.getAllInstances(filters);

    res.json({
      status: 'success',
      data: instances,
      count: instances.length,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/instances/admin/instances
 * Get admin instances (primary and secondary)
 * NOTE: Must be before /:id route to avoid capturing "admin" as id
 */
router.get('/admin/instances', async (req, res, next) => {
  try {
    const adminInstances = await instanceService.getAdminInstances();

    res.json({
      status: 'success',
      data: adminInstances,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/instances/:id
 * Get instance by ID
 */
router.get('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const instance = await instanceService.getInstanceById(id);

    res.json({
      status: 'success',
      data: instance,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/instances
 * Create new instance
 */
router.post('/', async (req, res, next) => {
  try {
    const instance = await instanceService.createInstance(req.body);

    res.status(201).json({
      status: 'success',
      message: 'Instance created successfully',
      data: instance,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/v1/instances/:id
 * Update instance
 */
router.put('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const instance = await instanceService.updateInstance(id, req.body);

    res.json({
      status: 'success',
      message: 'Instance updated successfully',
      data: instance,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/v1/instances/:id
 * Delete instance
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    await instanceService.deleteInstance(id);

    res.json({
      status: 'success',
      message: 'Instance deleted successfully',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/instances/test/connection
 * Test connection to OpenAlgo instance (ping endpoint)
 * NOTE: Must be before /:id routes
 */
router.post('/test/connection', async (req, res, next) => {
  try {
    const { host_url, api_key } = req.body;

    if (!host_url || !api_key) {
      throw new ValidationError('host_url and api_key are required');
    }

    const result = await instanceService.testConnection({ host_url, api_key });

    res.json({
      status: result.success ? 'success' : 'error',
      message: result.message,
      data: result.success ? { broker: result.broker } : null,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/instances/test/apikey
 * Test API key validity (funds endpoint)
 * NOTE: Must be before /:id routes
 */
router.post('/test/apikey', async (req, res, next) => {
  try {
    const { host_url, api_key } = req.body;

    if (!host_url || !api_key) {
      throw new ValidationError('host_url and api_key are required');
    }

    const result = await instanceService.testApiKey({ host_url, api_key });

    res.json({
      status: result.success ? 'success' : 'error',
      message: result.message,
      data: result.success ? { funds: result.funds } : null,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/instances/:id/refresh
 * Manually refresh instance data (bypasses cron)
 */
router.post('/:id/refresh', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const instance = await pollingService.refreshInstance(id);

    res.json({
      status: 'success',
      message: 'Instance refreshed successfully',
      data: instance,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/instances/:id/health
 * Update health status
 */
router.post('/:id/health', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const instance = await instanceService.updateHealthStatus(id);

    res.json({
      status: 'success',
      message: 'Health status updated',
      data: instance,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/instances/:id/pnl
 * Update P&L data
 */
router.post('/:id/pnl', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const instance = await instanceService.updatePnLData(id);

    res.json({
      status: 'success',
      message: 'P&L data updated',
      data: instance,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/instances/:id/analyzer/toggle
 * Toggle analyzer mode with Safe-Switch workflow
 */
router.post('/:id/analyzer/toggle', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { mode } = req.body;

    if (typeof mode !== 'boolean') {
      throw new ValidationError('Mode must be a boolean (true for analyzer, false for live)');
    }

    const instance = await instanceService.toggleAnalyzerMode(id, mode);

    res.json({
      status: 'success',
      message: `Analyzer mode ${mode ? 'enabled' : 'disabled'} successfully`,
      data: instance,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
