/**
 * Watchlist Routes
 * API endpoints for watchlist and symbol management
 */

import express from 'express';
import watchlistService from '../../services/watchlist.service.js';
import { log } from '../../core/logger.js';
import {
  NotFoundError,
  ConflictError,
  ValidationError,
  ForbiddenError,
} from '../../core/errors.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import multer from 'multer';
import { Parser } from '../../utils/csv.js';
import db from '../../core/database.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.use(requireAuth);

function hasPermission(req, key) {
  return Array.isArray(req.user?.permissions) && req.user.permissions.includes(key);
}

function requireAdmin(req, _res, next) {
  if (!req.user?.is_admin) {
    return next(new ForbiddenError('Admin access required'));
  }
  return next();
}

/**
 * GET /api/v1/watchlists
 * Get all watchlists
 */
router.get('/', async (req, res, next) => {
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
router.get('/:id', async (req, res, next) => {
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

    if (statusOnly) {
      if (!hasPermission(req, 'watchlists.status')) {
        throw new ConflictError('Insufficient permissions');
      }
    } else if (!hasPermission(req, 'watchlists.manage')) {
      throw new ConflictError('Insufficient permissions');
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
 * POST /api/v1/watchlists/:id/clone
 * Clone watchlist
 */
router.post('/:id/clone', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { name } = req.body;

    if (!name) {
      throw new ValidationError('Name is required for cloned watchlist');
    }

    const cloned = await watchlistService.cloneWatchlist(id, name);

    res.status(201).json({
      status: 'success',
      message: 'Watchlist cloned successfully',
      data: cloned,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/watchlists/:id/symbols
 * Get watchlist symbols with latest quotes
 */
router.get('/:id/symbols', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const symbols = await watchlistService.getSymbolsWithQuotes(id);

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
    const symbolId = parseInt(req.params.symbolId, 10);
    const symbol = await watchlistService.updateSymbol(symbolId, req.body);

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
    const symbolId = parseInt(req.params.symbolId, 10);
    await watchlistService.removeSymbol(symbolId);

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
router.get('/export/csv', requireAdmin, async (_req, res, next) => {
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
router.post('/import/csv', requireAdmin, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file || !req.file.buffer) {
      throw new ValidationError('CSV text file is required');
    }
    const text = req.file.buffer.toString('utf-8');
    const sections = text.split(/^# /m).map((s) => s.trim()).filter(Boolean);
    const parser = new Parser();

    let inserted = { watchlists: 0, symbols: 0, mappings: 0 };
    let updated = { watchlists: 0, symbols: 0, mappings: 0 };

    const wlCols = (await db.all("PRAGMA table_info('watchlists')")).map((c) => c.name);
    const symCols = (await db.all("PRAGMA table_info('watchlist_symbols')")).map((c) => c.name);
    const mapCols = (await db.all("PRAGMA table_info('watchlist_instances')")).map((c) => c.name);

    const upsertTable = async (table, cols, keySelector, rows) => {
      for (const row of rows) {
        const payload = {};
        cols.forEach((col, idx) => {
          const val = row[idx];
          if (val === undefined || val === null || val === '') return;
          const lowered = String(val).toLowerCase();
          if (lowered === 'true' || lowered === 'false') payload[col] = lowered === 'true' ? 1 : 0;
          else if (!Number.isNaN(Number(val)) && val !== '') payload[col] = Number(val);
          else payload[col] = val;
        });
        const key = keySelector(payload);
        if (!key) continue;

        const whereClause = Object.keys(key).map((k) => `${k} = ?`).join(' AND ');
        const whereParams = Object.values(key);
        const existing = await db.get(`SELECT id FROM ${table} WHERE ${whereClause} LIMIT 1`, whereParams);
        if (existing) {
          const fields = Object.keys(payload).filter((c) => c !== 'id');
          if (!fields.length) continue;
          const setSql = fields.map((f) => `${f} = ?`).join(', ');
          const params = fields.map((f) => payload[f]);
          params.push(existing.id);
          await db.run(`UPDATE ${table} SET ${setSql}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, params);
          updated[table === 'watchlists' ? 'watchlists' : table === 'watchlist_symbols' ? 'symbols' : 'mappings'] += 1;
        } else {
          const fields = Object.keys(payload).filter((c) => c !== 'id');
          const placeholders = fields.map(() => '?').join(', ');
          const params = fields.map((f) => payload[f]);
          await db.run(`INSERT INTO ${table} (${fields.join(', ')}) VALUES (${placeholders})`, params);
          inserted[table === 'watchlists' ? 'watchlists' : table === 'watchlist_symbols' ? 'symbols' : 'mappings'] += 1;
        }
      }
    };

    for (const section of sections) {
      if (section.startsWith('WATCHLISTS')) {
        const csv = section.replace(/^WATCHLISTS\s*/,'');
        const parsed = parser.parse(csv.trim());
        if (parsed.headers?.length) {
          await upsertTable('watchlists', parsed.headers.filter((h) => wlCols.includes(h)), (p) => ({ name: p.name }), parsed.rows);
        }
      } else if (section.startsWith('WATCHLIST_SYMBOLS')) {
        const csv = section.replace(/^WATCHLIST_SYMBOLS\s*/,'');
        const parsed = parser.parse(csv.trim());
        if (parsed.headers?.length) {
          await upsertTable(
            'watchlist_symbols',
            parsed.headers.filter((h) => symCols.includes(h)),
            (p) => ({ watchlist_id: p.watchlist_id, symbol: p.symbol, exchange: p.exchange }),
            parsed.rows
          );
        }
      } else if (section.startsWith('WATCHLIST_INSTANCES')) {
        const csv = section.replace(/^WATCHLIST_INSTANCES\s*/,'');
        const parsed = parser.parse(csv.trim());
        if (parsed.headers?.length) {
          await upsertTable(
            'watchlist_instances',
            parsed.headers.filter((h) => mapCols.includes(h)),
            (p) => ({ watchlist_id: p.watchlist_id, instance_id: p.instance_id }),
            parsed.rows
          );
        }
      }
    }

    res.json({
      status: 'success',
      message: 'Watchlists import completed',
      data: { inserted, updated },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
