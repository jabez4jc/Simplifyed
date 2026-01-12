/**
 * Instance Routes
 * API endpoints for instance management
 */

import express from 'express';
import instanceService from '../../services/instance.service.js';
import pollingService from '../../services/polling.service.js';
import marketDataInstanceService from '../../services/market-data-instance.service.js';
import openalgoClient from '../../integrations/openalgo/client.js';
import { log } from '../../core/logger.js';
import {
  NotFoundError,
  ConflictError,
  ValidationError,
  ForbiddenError,
} from '../../core/errors.js';
import { parseBooleanSafe } from '../../utils/sanitizers.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import db from '../../core/database.js';
import multer from 'multer';
import { Parser } from '../../utils/csv.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// All instance routes require authentication
router.use(requireAuth);

function hasPermission(req, key) {
  return Array.isArray(req.user?.permissions) && req.user.permissions.includes(key);
}

function logAudit(req, action, metadata = {}) {
  if (!req.user) return;
  req.auditLogged = true;
  db.run(
    `INSERT INTO audit_logs (user_id, action, metadata) VALUES (?, ?, ?)`,
    [req.user.id, action, JSON.stringify(metadata)]
  ).catch(() => {});
}

/**
 * GET /api/v1/instances
 * Get all instances with optional filters
 */
router.get('/', requirePermission('pages.instances.view'), async (req, res, next) => {
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
router.get('/admin/instances', requirePermission('pages.instances.view'), async (req, res, next) => {
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
 * GET /api/v1/instances/market-data/instance
 * Get the current market data instance (primary with failover to secondary)
 * Used for frontend quote polling
 * NOTE: Must be before /:id route to avoid capturing "market-data" as id
 */
router.get('/market-data/instance', requirePermission('pages.instances.view'), async (req, res, next) => {
  try {
    const instance = await marketDataInstanceService.getMarketDataInstance();

    res.json({
      status: 'success',
      data: instance,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/instances/market-data/all
 * Get all market data instances (primary and secondary) for status display
 * NOTE: Must be before /:id route
 */
router.get('/market-data/all', requirePermission('pages.instances.view'), async (req, res, next) => {
  try {
    const instances = await marketDataInstanceService.getMarketDataInstances();

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
 * GET /api/v1/instances/:id
 * Get instance by ID
 */
router.get('/:id', requirePermission('pages.instances.view'), async (req, res, next) => {
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
router.post('/', requirePermission('instances.add'), async (req, res, next) => {
  try {
    const instance = await instanceService.createInstance(req.body);
    logAudit(req, 'instances.create', { id: instance?.id, name: instance?.name });

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
    // Determine if this is only a mode toggle (allowed for monitors)
    const keys = Object.keys(req.body || {});
    const modeOnly = keys.length === 1 && keys[0] === 'is_analyzer_mode';

    if (modeOnly && !hasPermission(req, 'instances.toggle_mode')) {
      return next(new ForbiddenError('Insufficient permissions'));
    }
    if (!modeOnly && !hasPermission(req, 'instances.edit')) {
      return next(new ForbiddenError('Insufficient permissions'));
    }

    const instance = await instanceService.updateInstance(id, req.body);
    const action = modeOnly ? 'instances.toggle_mode' : 'instances.update';
    logAudit(req, action, { id, body: req.body });

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
router.delete('/:id', requirePermission('instances.delete'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    await instanceService.deleteInstance(id);
    logAudit(req, 'instances.delete', { id });

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
router.post('/test/connection', requirePermission('instances.edit'), async (req, res, next) => {
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
 * POST /api/v1/instances/bulk-update
 * Bulk update instances (set active/inactive or analyzer mode)
 * NOTE: Must be before /:id routes
 */
router.post('/bulk-update', async (req, res, next) => {
  try {
    const { instance_ids, is_active, is_analyzer_mode, multiplier } = req.body;

    if (!instance_ids || !Array.isArray(instance_ids) || instance_ids.length === 0) {
      throw new ValidationError('instance_ids must be a non-empty array');
    }

    // At least one field must be provided
    if (is_active === undefined && is_analyzer_mode === undefined && multiplier === undefined) {
      throw new ValidationError('At least one of is_active, is_analyzer_mode, or multiplier must be provided');
    }

    // If analyzer mode is being changed, use Safe-Switch workflow
    if (is_analyzer_mode !== undefined) {
      const analyzerMode = parseBooleanSafe(is_analyzer_mode, false);

      const results = {
        updated: 0,
        failed: 0,
        errors: [],
      };

      // Process each instance individually through Safe-Switch workflow
      for (const instanceId of instance_ids) {
        try {
          await instanceService.toggleAnalyzerMode(instanceId, analyzerMode);
          results.updated++;
        } catch (error) {
          results.failed++;
          results.errors.push({
            instance_id: instanceId,
            message: error.message,
          });
          log.error('Failed to toggle analyzer mode for instance', {
            instance_id: instanceId,
            error: error.message,
          });
        }
      }

      // Update is_active separately if provided
      if (is_active !== undefined || multiplier !== undefined) {
        const updateData = {
          ...(is_active !== undefined ? { is_active: parseBooleanSafe(is_active, true) } : {}),
          ...(multiplier !== undefined ? { multiplier } : {}),
        };

        // Only update instances that successfully toggled analyzer mode
        const successfulIds = instance_ids.filter((id, index) =>
          !results.errors.find(err => err.instance_id === id)
        );

        if (successfulIds.length > 0) {
          await instanceService.bulkUpdateInstances(successfulIds, updateData);
        }
      }

      const responseMessage = results.failed > 0
        ? `Updated ${results.updated} instance(s), ${results.failed} failed`
        : `Successfully updated ${results.updated} instance(s)`;

      res.json({
        status: results.failed > 0 ? 'partial' : 'success',
        message: responseMessage,
        data: results,
      });
    } else {
      // Only updating non-mode fields - safe to use bulk update
      const updateData = {};
      if (is_active !== undefined) {
        updateData.is_active = parseBooleanSafe(is_active, true);
      }
      if (multiplier !== undefined) {
        updateData.multiplier = multiplier;
      }

      const results = await instanceService.bulkUpdateInstances(instance_ids, updateData);

      res.json({
        status: 'success',
        message: `Successfully updated ${results.updated} instance(s)`,
        data: results,
      });
    }
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
 * GET /api/v1/instances/:id/circuit-breaker
 * Get circuit breaker status for an instance
 * Returns information about whether the instance is in cooldown or requires manual refresh
 */
router.get('/:id/circuit-breaker', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);

    // Get circuit breaker health status
    const circuitBreakerStatus = openalgoClient.getInstanceHealthStatus(id);

    res.json({
      status: 'success',
      data: circuitBreakerStatus || {
        isHealthy: true,
        requiresManualRefresh: false,
        dnsRetryCount: 0,
        maxDnsRetries: openalgoClient.instanceHealthConfig.maxDnsRetries,
        cooldownRemaining: 0,
        cooldownUntil: null,
        lastError: null,
        isDnsError: false,
        isHtmlError: false,
      },
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

// Admin-only middleware
function requireAdmin(req, _res, next) {
  if (!req.user?.is_admin) {
    return next(new ForbiddenError('Admin access required'));
  }
  return next();
}

/**
 * GET /api/v1/instances/export/csv
 * Admin-only: Export all instances and settings as CSV
 */
router.get('/export/csv', requireAdmin, async (req, res, next) => {
  try {
    const columns = await db.all("PRAGMA table_info('instances')");
    const colNames = columns.map((c) => c.name);
    const rows = await db.all(`SELECT ${colNames.join(', ')} FROM instances ORDER BY id ASC`);

    const parser = new Parser();
    const csv = parser.stringify([colNames, ...rows.map((r) => colNames.map((c) => r[c]))]);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="instances-export.csv"');
    res.send(csv);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/instances/import/csv
 * Admin-only: Import instances from CSV (upsert by host_url)
 */
router.post('/import/csv', requireAdmin, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file || !req.file.buffer) {
      throw new ValidationError('CSV file is required');
    }

    const csvText = req.file.buffer.toString('utf-8');
    const parser = new Parser();
    const records = parser.parse(csvText);
    if (!records.headers || !records.rows.length) {
      throw new ValidationError('CSV is empty or invalid');
    }

    const columns = await db.all("PRAGMA table_info('instances')");
    const allowed = new Set(columns.map((c) => c.name));
    const importable = records.headers.filter((h) => allowed.has(h) && h !== 'id' && h !== 'created_at' && h !== 'last_updated');
    const headerIndex = new Map(records.headers.map((h, i) => [h, i]));

    let inserted = 0;
    let updated = 0;
    let skippedMissing = 0;
    let rowErrors = 0;

    for (const row of records.rows) {
      const payload = {};
      importable.forEach((col) => {
        const idx = headerIndex.get(col);
        const val = row[idx];
        if (val === undefined || val === null || val === '') return;
        const lowered = String(val).toLowerCase();
        if (lowered === 'true' || lowered === 'false') {
          payload[col] = lowered === 'true' ? 1 : 0;
        } else if (!Number.isNaN(Number(val)) && val !== '') {
          payload[col] = Number(val);
        } else {
          payload[col] = val;
        }
      });

      // Guard required fields to avoid NOT NULL/UNIQUE violations
      if (!payload.host_url || !payload.api_key) {
        skippedMissing += 1;
        continue;
      }
      if (!payload.name) {
        payload.name = payload.host_url;
      }

      try {
        const existing = await db.get('SELECT id FROM instances WHERE host_url = ?', [payload.host_url]);
        if (existing) {
          const fields = Object.keys(payload);
          const setSql = fields.map((f) => `${f} = ?`).join(', ');
          const params = fields.map((f) => payload[f]);
          params.push(existing.id);
          await db.run(`UPDATE instances SET ${setSql}, last_updated = CURRENT_TIMESTAMP WHERE id = ?`, params);
          updated += 1;
        } else {
          const fields = Object.keys(payload);
          const placeholders = fields.map(() => '?').join(', ');
          const params = fields.map((f) => payload[f]);
          await db.run(
            `INSERT INTO instances (${fields.join(', ')}) VALUES (${placeholders})`,
            params
          );
          inserted += 1;
        }
      } catch (err) {
        rowErrors += 1;
        log.error('Instance import row failed', { err: err.message, host_url: payload.host_url });
      }
    }

    res.json({
      status: 'success',
      message: `Import completed. Inserted ${inserted}, updated ${updated}, skipped ${skippedMissing}, errors ${rowErrors}.`,
      data: { inserted, updated, skippedMissing, rowErrors },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
