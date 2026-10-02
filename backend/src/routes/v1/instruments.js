/**
 * Instruments Routes
 * API endpoints for broker instruments cache management
 */

import express from 'express';
import multer from 'multer';
import instrumentsService, { SUPPORTED_EXCHANGES } from '../../services/instruments.service.js';
import { log } from '../../core/logger.js';
import { ValidationError } from '../../core/errors.js';
import { toISTISOString } from '../../utils/time.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';

const router = express.Router();
router.use(requireAuth);

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
 * Track active fetch-from-instance operations to prevent concurrent fetches
 * Key: instanceId, Value: { status, startedAt, exchanges, currentExchange, completedExchanges, totalInstruments }
 */
const activeFetches = new Map();




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
 * POST /api/v1/instruments/upload
 * Upload CSV file to import instruments
 */
router.post('/upload', requirePermission('settings.instruments.refresh'), upload.single('file'), async (req, res, next) => {
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
router.post('/fetch-from-instance', requirePermission('settings.instruments.refresh'), async (req, res, next) => {
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
      startedAt: toISTISOString(),
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

export default router;
