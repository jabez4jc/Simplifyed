/**
 * Instruments Routes
 * API endpoints for broker instruments cache management
 */

import express from 'express';
import multer from 'multer';
import instrumentsService, { SUPPORTED_EXCHANGES } from '../../services/instruments.service.js';
import { log } from '../../core/logger.js';
import { ValidationError } from '../../core/errors.js';
import { sanitizeString } from '../../utils/sanitizers.js';

const router = express.Router();

// Configure multer for CSV file upload (memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max file size
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new ValidationError('Only CSV files are allowed'));
    }
  }
});

/**
 * Supported instrument types
 */
const SUPPORTED_INSTRUMENT_TYPES = ['EQ', 'FUT', 'CE', 'PE', 'INDEX'];

/**
 * Track active refresh operations to prevent concurrent refreshes
 * Key: exchange (or 'ALL' for global refresh), Value: true
 */
const activeRefreshes = new Map();

/**
 * Track active fetch-from-instance operations to prevent concurrent fetches
 * Key: instanceId, Value: { status, startedAt, exchanges, currentExchange, completedExchanges, totalInstruments }
 */
const activeFetches = new Map();

/**
 * GET /api/v1/instruments/search
 * Fast search using cached instruments (SQLite FTS5)
 */
router.get('/search', async (req, res, next) => {
  try {
    const { query, exchange, instrumenttype, limit } = req.query;

    if (!query) {
      throw new ValidationError('query parameter is required');
    }

    // Validate and clamp limit parameter
    let parsedLimit = 50; // default
    if (limit) {
      parsedLimit = parseInt(limit, 10);
      if (isNaN(parsedLimit) || parsedLimit < 1) {
        throw new ValidationError('limit must be a positive number');
      }
      parsedLimit = Math.min(parsedLimit, 500); // cap at 500
    }

    // Validate exchange parameter
    let validatedExchange = null;
    if (exchange) {
      const upperExchange = sanitizeString(exchange).toUpperCase();
      if (!SUPPORTED_EXCHANGES.includes(upperExchange)) {
        throw new ValidationError(`Invalid exchange. Supported exchanges: ${SUPPORTED_EXCHANGES.join(', ')}`);
      }
      validatedExchange = upperExchange;
    }

    // Validate instrumenttype parameter
    let validatedInstrumentType = null;
    if (instrumenttype) {
      const upperType = sanitizeString(instrumenttype).toUpperCase();
      if (!SUPPORTED_INSTRUMENT_TYPES.includes(upperType)) {
        throw new ValidationError(`Invalid instrument type. Supported types: ${SUPPORTED_INSTRUMENT_TYPES.join(', ')}`);
      }
      validatedInstrumentType = upperType;
    }

    // Search cached instruments
    const results = await instrumentsService.searchInstruments(
      sanitizeString(query),
      {
        exchange: validatedExchange,
        instrumenttype: validatedInstrumentType,
        limit: parsedLimit
      }
    );

    res.json({
      status: 'success',
      data: results,
      count: results.length,
      source: 'cache'
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/instruments/option-chain
 * Build option chain from cached instruments
 */
router.get('/option-chain', async (req, res, next) => {
  try {
    const { symbol, expiry, exchange } = req.query;

    if (!symbol) {
      throw new ValidationError('symbol parameter is required');
    }

    if (!expiry) {
      throw new ValidationError('expiry parameter is required');
    }

    const optionChain = await instrumentsService.buildOptionChain(
      sanitizeString(symbol).toUpperCase(),
      sanitizeString(expiry),
      exchange ? sanitizeString(exchange).toUpperCase() : 'NFO'
    );

    res.json({
      status: 'success',
      data: optionChain
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/instruments/expiries
 * Get available expiry dates for a symbol
 */
router.get('/expiries', async (req, res, next) => {
  try {
    const { symbol, exchange } = req.query;

    if (!symbol) {
      throw new ValidationError('symbol parameter is required');
    }

    const expiries = await instrumentsService.getExpiries(
      sanitizeString(symbol).toUpperCase(),
      exchange ? sanitizeString(exchange).toUpperCase() : 'NFO'
    );

    res.json({
      status: 'success',
      data: expiries,
      count: expiries.length
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/instruments/stats
 * Get instruments cache statistics
 */
router.get('/stats', async (req, res, next) => {
  try {
    const stats = await instrumentsService.getStatistics();

    res.json({
      status: 'success',
      data: stats
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/instruments/needs-refresh
 * Check if instruments cache needs refresh
 */
router.get('/needs-refresh', async (req, res, next) => {
  try {
    const { exchange } = req.query;

    const needsRefresh = await instrumentsService.needsRefresh(
      exchange ? sanitizeString(exchange).toUpperCase() : null
    );

    res.json({
      status: 'success',
      data: {
        needs_refresh: needsRefresh,
        exchange: exchange || 'ALL'
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/instruments/refresh
 * Manually trigger instruments refresh
 */
router.post('/refresh', async (req, res, next) => {
  try {
    const { exchange, instanceId } = req.body;

    const refreshKey = exchange ? sanitizeString(exchange).toUpperCase() : 'ALL';

    // Check if refresh is already in progress for this exchange
    if (activeRefreshes.has(refreshKey)) {
      res.status(409).json({
        status: 'error',
        message: `Refresh is already in progress for ${refreshKey}`,
        exchange: refreshKey
      });
      return;
    }

    log.info('Manual instruments refresh triggered', {
      exchange: refreshKey,
      instanceId,
      user: req.user?.email
    });

    // Mark refresh as active
    activeRefreshes.set(refreshKey, true);

    // Start refresh (can be long-running, so we return immediately)
    const refreshPromise = instrumentsService.refreshInstruments(
      exchange ? sanitizeString(exchange).toUpperCase() : null,
      instanceId ? parseInt(instanceId, 10) : null
    ).finally(() => {
      // Clear active refresh flag when done
      activeRefreshes.delete(refreshKey);
    });

    // For smaller exchanges, wait for completion (up to 30 seconds)
    // For large refreshes, return immediately with 202 Accepted
    const timeout = new Promise((resolve) =>
      setTimeout(() => resolve({ timeout: true }), 30000)
    );

    const result = await Promise.race([refreshPromise, timeout]);

    if (result.timeout) {
      // Refresh is still running in background
      res.status(202).json({
        status: 'accepted',
        message: 'Instruments refresh is running in background',
        exchange: refreshKey
      });
    } else {
      // Refresh completed within timeout
      res.json({
        status: 'success',
        message: 'Instruments refreshed successfully',
        data: result
      });
    }
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/instruments/upload
 * Upload CSV file to import instruments
 */
router.post('/upload', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      throw new ValidationError('No file uploaded');
    }

    log.info('CSV file upload started', {
      filename: req.file.originalname,
      size: req.file.size,
      user: req.user?.email
    });

    // Convert buffer to string
    const csvContent = req.file.buffer.toString('utf-8');

    // Import CSV data
    const result = await instrumentsService.importFromCSV(csvContent);

    res.json({
      status: 'success',
      message: 'CSV imported successfully',
      data: result
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/instruments/fetch-status/:instanceId
 * Get the status of a fetch-from-instance operation
 */
router.get('/fetch-status/:instanceId', (req, res) => {
  const instanceId = parseInt(req.params.instanceId, 10);

  if (isNaN(instanceId) || instanceId < 1) {
    return res.status(400).json({
      status: 'error',
      message: 'Invalid instanceId'
    });
  }

  const fetchStatus = activeFetches.get(instanceId);

  if (!fetchStatus) {
    return res.status(404).json({
      status: 'error',
      message: 'No active fetch found for this instance',
      instanceId
    });
  }

  res.json({
    status: 'success',
    data: fetchStatus
  });
});

/**
 * POST /api/v1/instruments/fetch-from-instance
 * Fetch instruments from a specific OpenAlgo instance (all exchanges)
 */
router.post('/fetch-from-instance', async (req, res, next) => {
  try {
    const { instanceId } = req.body;

    if (!instanceId) {
      throw new ValidationError('instanceId is required');
    }

    // Parse and validate instanceId
    const parsedInstanceId = parseInt(instanceId, 10);
    if (isNaN(parsedInstanceId) || parsedInstanceId < 1) {
      throw new ValidationError('Invalid instanceId');
    }

    // Check if fetch is already in progress for this instance
    if (activeFetches.has(parsedInstanceId)) {
      res.status(409).json({
        status: 'error',
        message: `Fetch is already in progress for instance ${parsedInstanceId}`,
        instanceId: parsedInstanceId
      });
      return;
    }

    log.info('Fetch from instance triggered', {
      instanceId: parsedInstanceId,
      user: req.user?.email
    });

    // Mark fetch as active with status tracking
    const fetchStatus = {
      status: 'starting',
      startedAt: new Date().toISOString(),
      exchanges: SUPPORTED_EXCHANGES,
      currentExchange: null,
      completedExchanges: [],
      totalInstruments: 0,
      instanceId: parsedInstanceId
    };
    activeFetches.set(parsedInstanceId, fetchStatus);

    // Start fetch (can be long-running, so we return immediately)
    const fetchPromise = instrumentsService.fetchFromInstance(parsedInstanceId, (progress) => {
      // Update the activeFetches Map with progress
      const currentStatus = activeFetches.get(parsedInstanceId);
      if (currentStatus) {
        activeFetches.set(parsedInstanceId, {
          ...currentStatus,
          ...progress,
          instanceId: parsedInstanceId
        });
      }
    }).finally(() => {
      // Clear active fetch flag when done
      activeFetches.delete(parsedInstanceId);
    });

    // For all fetches, return immediately with 202 Accepted since it's a long-running operation
    res.status(202).json({
      status: 'accepted',
      message: 'Fetching instruments from instance (all exchanges)',
      instanceId: parsedInstanceId,
      exchanges: SUPPORTED_EXCHANGES
    });

    // Execute fetch in background
    fetchPromise.then(result => {
      log.info('Fetch from instance completed', {
        instanceId: parsedInstanceId,
        result
      });
    }).catch(error => {
      log.error('Fetch from instance failed', error, {
        instanceId: parsedInstanceId
      });
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/instruments/:exchange/:symbol
 * Get specific instrument by exchange and symbol
 */
router.get('/:exchange/:symbol', async (req, res, next) => {
  try {
    const { exchange, symbol } = req.params;

    // Service handles case conversion
    const instrument = await instrumentsService.getInstrument(
      sanitizeString(symbol),
      sanitizeString(exchange)
    );

    if (!instrument) {
      res.status(404).json({
        status: 'error',
        message: 'Instrument not found',
        data: null
      });
      return;
    }

    res.json({
      status: 'success',
      data: instrument
    });
  } catch (error) {
    next(error);
  }
});

export default router;
