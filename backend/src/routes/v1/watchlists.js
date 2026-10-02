/**
 * Watchlist Routes
 * API endpoints for watchlist and symbol management
 */

import express from 'express';
import watchlistService from '../../services/watchlist.service.js';
import {
  ValidationError,
  ForbiddenError,
} from '../../core/errors.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { rowPayload, upsertByKey } from '../../utils/csv-import.js';
import multer from 'multer';
import { Parser } from '../../utils/csv.js';
import db from '../../core/database.js';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    const isCsv = file.mimetype === 'text/csv' || file.originalname.toLowerCase().endsWith('.csv');
    callback(isCsv ? null : new ValidationError('Only CSV files are allowed'), isCsv);
  },
});

router.use(requireAuth);

function hasPermission(req, key) {
  return Array.isArray(req.user?.permissions) && req.user.permissions.includes(key);
}


/**
 * GET /api/v1/watchlists
 * Get all watchlists
 */
router.get('/', requirePermission('pages.watchlists.view'), async (req, res, next) => {
  try {
    const filters = {};

    if (req.query.is_active !== undefined) {
      filters.is_active = req.query.is_active === 'true';
    }

    const watchlists = await watchlistService.getAllWatchlists(filters);

    res.json({
      status: 'success',
      data: watchlists,
      count: watchlists.length,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/watchlists/:id
 * Get watchlist by ID with symbols and instances
 */
router.get('/:id', requirePermission('pages.watchlists.view'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const watchlist = await watchlistService.getWatchlistById(id);

    res.json({
      status: 'success',
      data: watchlist,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/watchlists
 * Create new watchlist
 */
router.post('/', requirePermission('watchlists.manage'), async (req, res, next) => {
  try {
    const watchlist = await watchlistService.createWatchlist(req.body);

    res.status(201).json({
      status: 'success',
      message: 'Watchlist created successfully',
      data: watchlist,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/v1/watchlists/:id
 * Update watchlist
 */
router.put('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const keys = Object.keys(req.body || {});
    const statusOnly = keys.length === 1 && keys[0] === 'is_active';

    // ForbiddenError (403), not ConflictError (409). A permission failure and a "someone else
    // changed this, retry" are different instructions to the caller, and api-client.js branches
    // on the status: 409 invites a retry that can only fail again, and the UI shows a conflict
    // message for what is actually a missing permission.
    if (statusOnly) {
      if (!hasPermission(req, 'watchlists.status')) {
        throw new ForbiddenError('Insufficient permissions');
      }
    } else if (!hasPermission(req, 'watchlists.manage')) {
      throw new ForbiddenError('Insufficient permissions');
    }

    const watchlist = await watchlistService.updateWatchlist(id, req.body);

    res.json({
      status: 'success',
      message: 'Watchlist updated successfully',
      data: watchlist,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/v1/watchlists/:id
 * Delete watchlist
 */
router.delete('/:id', requirePermission('watchlists.manage'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    await watchlistService.deleteWatchlist(id);

    res.json({
      status: 'success',
      message: 'Watchlist deleted successfully',
    });
  } catch (error) {
    next(error);
  }
});


/**
 * GET /api/v1/watchlists/:id/symbols
 * Get watchlist symbols (with an is_expired flag)
 */
router.get('/:id/symbols', requirePermission('pages.watchlists.view'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const symbols = await watchlistService.getSymbols(id);

    res.json({
      status: 'success',
      data: symbols,
      count: symbols.length,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/watchlists/:id/symbols
 * Add symbol to watchlist
 */
router.post('/:id/symbols', requirePermission('watchlists.symbols.manage'), async (req, res, next) => {
  try {
    const watchlistId = parseInt(req.params.id, 10);
    const symbol = await watchlistService.addSymbol(watchlistId, req.body);

    res.status(201).json({
      status: 'success',
      message: 'Symbol added successfully',
      data: symbol,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/v1/watchlists/:id/symbols/:symbolId
 * Update symbol in watchlist
 */
router.put('/:id/symbols/:symbolId', requirePermission('watchlists.symbols.manage'), async (req, res, next) => {
  try {
    const watchlistId = parseInt(req.params.id, 10);
    const symbolId = parseInt(req.params.symbolId, 10);
    const symbol = await watchlistService.updateSymbol(symbolId, req.body, watchlistId);

    res.json({
      status: 'success',
      message: 'Symbol updated successfully',
      data: symbol,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/v1/watchlists/:id/symbols/:symbolId
 * Remove symbol from watchlist
 */
router.delete('/:id/symbols/:symbolId', requirePermission('watchlists.symbols.manage'), async (req, res, next) => {
  try {
    const watchlistId = parseInt(req.params.id, 10);
    const symbolId = parseInt(req.params.symbolId, 10);
    await watchlistService.removeSymbol(symbolId, watchlistId);

    res.json({
      status: 'success',
      message: 'Symbol removed successfully',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/watchlists/:id/instances
 * Assign instance to watchlist
 */
router.post('/:id/instances', requirePermission('watchlists.instances.manage'), async (req, res, next) => {
  try {
    const watchlistId = parseInt(req.params.id, 10);
    const { instanceId } = req.body;

    if (!instanceId) {
      throw new ValidationError('instanceId is required');
    }

    const assignment = await watchlistService.assignInstance(
      watchlistId,
      instanceId
    );

    res.status(201).json({
      status: 'success',
      message: 'Instance assigned successfully',
      data: assignment,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/v1/watchlists/:id/instances/:instanceId
 * Unassign instance from watchlist
 */
router.delete('/:id/instances/:instanceId', requirePermission('watchlists.instances.manage'), async (req, res, next) => {
  try {
    const watchlistId = parseInt(req.params.id, 10);
    const instanceId = parseInt(req.params.instanceId, 10);

    await watchlistService.unassignInstance(watchlistId, instanceId);

    res.json({
      status: 'success',
      message: 'Instance unassigned successfully',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Admin: export watchlists + symbols + instance mappings to CSV text bundle
 */
router.get('/export/csv', requirePermission('settings.manage'), async (_req, res, next) => {
  try {
    const parser = new Parser();

    const wlCols = (await db.all("PRAGMA table_info('watchlists')")).map((c) => c.name);
    const watchlists = await db.all(`SELECT ${wlCols.join(', ')} FROM watchlists ORDER BY id ASC`);
    const wlCsv = parser.stringify([wlCols, ...watchlists.map((r) => wlCols.map((c) => r[c]))]);

    const symCols = (await db.all("PRAGMA table_info('watchlist_symbols')")).map((c) => c.name);
    const symbols = await db.all(`SELECT ${symCols.join(', ')} FROM watchlist_symbols ORDER BY id ASC`);
    const symCsv = parser.stringify([symCols, ...symbols.map((r) => symCols.map((c) => r[c]))]);

    const mapCols = (await db.all("PRAGMA table_info('watchlist_instances')")).map((c) => c.name);
    const mappings = await db.all(`SELECT ${mapCols.join(', ')} FROM watchlist_instances ORDER BY id ASC`);
    const mapCsv = parser.stringify([mapCols, ...mappings.map((r) => mapCols.map((c) => r[c]))]);

    const payload = [
      '# WATCHLISTS',
      wlCsv,
      '# WATCHLIST_SYMBOLS',
      symCsv,
      '# WATCHLIST_INSTANCES',
      mapCsv,
    ].join('\n');

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', 'attachment; filename="watchlists-export.txt"');
    res.send(payload);
  } catch (error) {
    next(error);
  }
});

/**
 * Admin: import watchlists + symbols + mappings from CSV text bundle
 */
router.post('/import/csv', requirePermission('settings.manage'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file || !req.file.buffer) {
      throw new ValidationError('CSV text file is required');
    }
    const text = req.file.buffer.toString('utf-8');
    const sections = text.split(/^# /m).map((s) => s.trim()).filter(Boolean);
    const parser = new Parser();

    const inserted = { watchlists: 0, symbols: 0, mappings: 0 };
    const updated = { watchlists: 0, symbols: 0, mappings: 0 };
    const errors = [];
    const count = (bucket, action) => {
      if (action === 'inserted') inserted[bucket] += 1;
      else if (action === 'updated') updated[bucket] += 1;
    };

    const instances = await db.all('SELECT id FROM instances');
    const validInstanceIds = new Set(instances.map((i) => i.id));
    const watchlistIdMap = new Map(); // id in the file -> id here
    const sectionRows = (section, name) => parser.parse(section.replace(new RegExp(`^${name}\\s*`), '').trim());
    // The file's own watchlist id for a row, mapped to the watchlist it landed on.
    const mappedWatchlist = (parsed, row, payload) => {
      const idx = parsed.headers.indexOf('watchlist_id');
      return idx >= 0 && row[idx] ? watchlistIdMap.get(String(row[idx])) : payload.watchlist_id;
    };

    // One transaction for the whole file; a row that fails (UNIQUE etc.) rolls back only itself.
    await db.transaction(async () => {
      for (const section of sections) {
        if (section.startsWith('WATCHLISTS')) {
          const parsed = sectionRows(section, 'WATCHLISTS');
          const idIdx = parsed.headers.indexOf('id');
          for (const row of parsed.rows) {
            const payload = rowPayload('watchlists', parsed.headers, row);
            if (!payload.name) continue;
            try {
              const { action, id } = await upsertByKey(db, 'watchlists', ['name'], payload);
              count('watchlists', action);
              if (idIdx >= 0 && row[idIdx] && id) watchlistIdMap.set(String(row[idIdx]), id);
            } catch (err) {
              errors.push({ section: 'watchlists', name: payload.name, error: err.message });
            }
          }
        } else if (section.startsWith('WATCHLIST_SYMBOLS')) {
          const parsed = sectionRows(section, 'WATCHLIST_SYMBOLS');
          for (const row of parsed.rows) {
            const payload = rowPayload('watchlist_symbols', parsed.headers, row);
            payload.watchlist_id = mappedWatchlist(parsed, row, payload);
            if (!payload.watchlist_id || !payload.symbol || !payload.exchange) continue;
            try {
              const { action } = await upsertByKey(db, 'watchlist_symbols', ['watchlist_id', 'symbol', 'exchange'], payload);
              count('symbols', action);
            } catch (err) {
              errors.push({ section: 'watchlist_symbols', watchlist_id: payload.watchlist_id, symbol: payload.symbol, exchange: payload.exchange, error: err.message });
            }
          }
        } else if (section.startsWith('WATCHLIST_INSTANCES')) {
          const parsed = sectionRows(section, 'WATCHLIST_INSTANCES');
          for (const row of parsed.rows) {
            const payload = rowPayload('watchlist_instances', parsed.headers, row);
            payload.watchlist_id = mappedWatchlist(parsed, row, payload);
            // Skip an instance that does not exist here, to avoid FK failures
            if (!payload.watchlist_id || !validInstanceIds.has(payload.instance_id)) continue;
            try {
              const { action } = await upsertByKey(db, 'watchlist_instances', ['watchlist_id', 'instance_id'], payload);
              count('mappings', action);
            } catch (err) {
              errors.push({ section: 'watchlist_instances', watchlist_id: payload.watchlist_id, instance_id: payload.instance_id, error: err.message });
            }
          }
        }
      }
    });

    res.json({
      status: 'success',
      message: 'Watchlists import completed',
      data: { inserted, updated, errors },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
