/**
 * Instance Routes
 * API endpoints for instance management
 */

import express from 'express';
import instanceService from '../../services/instance.service.js';
import pollingService from '../../services/polling.service.js';
import instanceAnalyzerService from '../../services/instance-analyzer.service.js';
import instanceConnectionTestService from '../../services/instance-connection-test.service.js';
import marketDataInstanceService from '../../services/market-data-instance.service.js';
import { log } from '../../core/logger.js';
import { ValidationError } from '../../core/errors.js';
import {
  parseBooleanSafe,
  maskApiKey,
  isMaskedApiKey,
  maskInstanceForResponse,
  maskInstancesForResponse,
} from '../../utils/sanitizers.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { rowPayload, upsertByKey } from '../../utils/csv-import.js';
import db from '../../core/database.js';
import multer from 'multer';
import { Parser } from '../../utils/csv.js';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    const isCsv = file.mimetype === 'text/csv' || file.originalname.toLowerCase().endsWith('.csv');
    callback(isCsv ? null : new ValidationError('Only CSV files are allowed'), isCsv);
  },
});

// All instance routes require authentication
router.use(requireAuth);


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
      data: maskInstancesForResponse(instances),
      count: instances.length,
    });
  } catch (error) {
    next(error);
  }
});



/**
 * GET /api/v1/instances/market-data/all
 * The market-data pool (instances with "Use this instance for market data" ticked)
 * NOTE: Must be before /:id route
 */
router.get('/market-data/all', requirePermission('pages.instances.view'), async (req, res, next) => {
  try {
    const instances = await marketDataInstanceService.getMarketDataInstances();

    res.json({
      status: 'success',
      data: maskInstancesForResponse(instances),
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
      data: maskInstanceForResponse(instance),
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
      data: maskInstanceForResponse(instance),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/v1/instances/:id
 * Update instance
 */
router.put('/:id', requirePermission('instances.edit'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    // The local flag must never change without the broker toggle + Safe-Switch (closes positions).
    if (req.body && ('is_analyzer_mode' in req.body || 'health_status' in req.body)) {
      throw new ValidationError(
        'is_analyzer_mode and health_status cannot be set here; use POST /instances/:id/analyzer/toggle'
      );
    }

    const instance = await instanceService.updateInstance(id, req.body);
    logAudit(req, 'instances.update', { id, body: req.body });

    res.json({
      status: 'success',
      message: 'Instance updated successfully',
      data: maskInstanceForResponse(instance),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/v1/instances/:id[?force=true]
 * Delete instance (refused while it has open positions, unless forced)
 */
router.delete('/:id', requirePermission('instances.delete'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    await instanceService.deleteInstance(id, { force: req.query.force === 'true' });
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

    const result = await instanceConnectionTestService.testConnection({ host_url, api_key });

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
router.post('/test/apikey', requirePermission('instances.edit'), async (req, res, next) => {
  try {
    const { host_url, api_key } = req.body;

    if (!host_url || !api_key) {
      throw new ValidationError('host_url and api_key are required');
    }

    const result = await instanceConnectionTestService.testApiKey({ host_url, api_key });

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

    // Mode-only toggles are allowed for monitors (instances.toggle_mode); anything else needs edit.
    const changesOnlyMode =
      is_active === undefined && multiplier === undefined && is_analyzer_mode !== undefined;
    requirePermission(changesOnlyMode ? 'instances.toggle_mode' : 'instances.edit')(req, res, () => {});

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
          await instanceAnalyzerService.toggleAnalyzerMode(instanceId, analyzerMode);
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
        const successfulIds = instance_ids.filter((id) =>
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
router.post('/:id/refresh', requirePermission('instances.edit'), async (req, res, next) => {
  const startTime = Date.now();
  try {
    const id = parseInt(req.params.id, 10);
    log.info('Manual refresh requested', {
      instance_id: id,
      user_id: req.user?.id || null,
    });
    const instance = await pollingService.refreshInstance(id);
    const durationMs = Date.now() - startTime;
    log.info('Manual refresh completed (route)', {
      instance_id: id,
      duration_ms: durationMs,
    });

    res.json({
      status: 'success',
      message: 'Instance refreshed successfully',
      data: maskInstanceForResponse(instance),
    });
  } catch (error) {
    const durationMs = Date.now() - startTime;
    log.warn('Manual refresh failed (route)', {
      instance_id: Number.isNaN(Number(req.params.id)) ? req.params.id : Number(req.params.id),
      duration_ms: durationMs,
      error: error?.message,
    });
    next(error);
  }
});



/**
 * POST /api/v1/instances/:id/analyzer/toggle
 * Toggle analyzer mode with Safe-Switch workflow
 */
router.post('/:id/analyzer/toggle', requirePermission('instances.toggle_mode'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { mode } = req.body;

    if (typeof mode !== 'boolean') {
      throw new ValidationError('Mode must be a boolean (true for analyzer, false for live)');
    }

    const instance = await instanceAnalyzerService.toggleAnalyzerMode(id, mode);

    res.json({
      status: 'success',
      message: `Analyzer mode ${mode ? 'enabled' : 'disabled'} successfully`,
      data: maskInstanceForResponse(instance),
    });
  } catch (error) {
    next(error);
  }
});


/**
 * GET /api/v1/instances/export/csv
 * Admin-only: Export all instances and settings as CSV
 */
router.get('/export/csv', requirePermission('settings.manage'), async (req, res, next) => {
  try {
    const columns = await db.all("PRAGMA table_info('instances')");
    const colNames = columns.map((c) => c.name);
    const rows = await db.all(`SELECT ${colNames.join(', ')} FROM instances ORDER BY id ASC`);

    // api_key is masked here for the same reason every other instance response masks it: this
    // produces a file that leaves the server - into a downloads folder, an email, a support
    // ticket - carrying live broker credentials in plaintext. Being admin-only bounds who can
    // ask for it, not where it ends up afterwards. The import side below recognises the mask and
    // leaves the stored key untouched, so an export/import round-trip still works; seeding a
    // *new* instance from a CSV means supplying its real key, which is the correct trade.
    const parser = new Parser();
    const csv = parser.stringify([
      colNames,
      ...rows.map((r) => colNames.map((c) => (c === 'api_key' ? maskApiKey(r[c]) : r[c]))),
    ]);

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
router.post('/import/csv', requirePermission('settings.manage'), upload.single('file'), async (req, res, next) => {
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

    let inserted = 0;
    let updated = 0;
    let skippedMissing = 0;
    let rowErrors = 0;

    // One transaction for the whole file; a row that fails (UNIQUE etc.) rolls back only itself.
    await db.transaction(async () => {
      for (const row of records.rows) {
        const payload = rowPayload('instances', records.headers, row);

        // A CSV produced by the export above carries the masked key, never the real one. Writing
        // that back would replace a working credential with a row of asterisks and silently break
        // the instance, so drop it and let the stored value stand.
        if (isMaskedApiKey(payload.api_key)) {
          delete payload.api_key;
        }

        // Guard required fields to avoid NOT NULL/UNIQUE violations
        if (!payload.host_url) {
          skippedMissing += 1;
          continue;
        }
        if (!payload.name) {
          payload.name = payload.host_url;
        }

        try {
          const existing = await db.get('SELECT id FROM instances WHERE host_url = ?', [payload.host_url]);
          if (!existing && !payload.api_key) {
            // Nothing to fall back on - a new instance cannot be created without a real key.
            skippedMissing += 1;
            continue;
          }
          const { action } = await upsertByKey(db, 'instances', ['host_url'], payload, { stampColumn: 'last_updated' });
          if (action === 'inserted') inserted += 1;
          else if (action === 'updated') updated += 1;
        } catch (err) {
          rowErrors += 1;
          log.error('Instance import row failed', { err: err.message, host_url: payload.host_url });
        }
      }
    });

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
