/**
 * Instruments Refresh Middleware
 * Ensures instruments cache is loaded before app is ready for trading
 * BLOCKS all API requests until first refresh completes on first login of the day
 */

import instrumentsService from '../services/instruments.service.js';
import { log } from '../core/logger.js';

/**
 * Global app readiness state
 * Tracks if instruments cache is loaded and ready for trading
 */
let appReady = false;
let refreshInProgress = false;
let refreshError = null;
let lastRefreshDate = null;

/**
 * Get app ready status
 * @returns {Object} - Ready status with details
 */
export function getAppReadyStatus() {
  return {
    ready: appReady,
    refreshInProgress,
    error: refreshError,
    lastRefreshDate
  };
}

/**
 * Check if today's refresh is already done
 * @returns {boolean}
 */
function isTodayRefreshDone() {
  if (!lastRefreshDate) return false;

  const today = new Date().toDateString();
  const lastRefresh = new Date(lastRefreshDate).toDateString();

  return today === lastRefresh;
}

/**
 * Middleware to ensure instruments cache is ready
 * BLOCKS requests until initial refresh completes on first login of the day
 *
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Next middleware
 */
export async function checkInstrumentsRefresh(req, res, next) {
  try {
    // Allow health check and ready status endpoints without blocking
    if (req.path === '/api/v1/health' || req.path === '/api/v1/ready') {
      return next();
    }

    // Allow auth endpoints without blocking
    if (req.path.startsWith('/auth/')) {
      return next();
    }

    // Only check for authenticated users making API requests
    // In test mode, req.user is set directly without passport authentication
    const isAuthenticated = req.user || (req.isAuthenticated && req.isAuthenticated());
    if (!isAuthenticated) {
      return next();
    }

    // If app is ready and today's refresh is done, proceed immediately
    if (appReady && isTodayRefreshDone()) {
      return next();
    }

    // If refresh is already in progress, wait for it
    if (refreshInProgress) {
      log.info('Instruments refresh in progress, blocking request', {
        path: req.path,
        user: req.user?.email
      });

      // Return 503 Service Unavailable with retry-after header
      return res.status(503).json({
        status: 'error',
        message: 'Instruments cache is being loaded. Please wait...',
        error: 'SERVICE_UNAVAILABLE',
        retry_after_seconds: 5
      });
    }

    // Check if we need to refresh
    const needsRefresh = await instrumentsService.needsRefresh();

    if (!needsRefresh) {
      // Cache is fresh, mark app as ready
      appReady = true;
      lastRefreshDate = new Date();
      return next();
    }

    // Double-check that refresh isn't already in progress (race condition protection)
    // Another request might have started refresh while we were awaiting needsRefresh()
    if (refreshInProgress) {
      log.info('Instruments refresh started by another request, blocking this request', {
        path: req.path,
        user: req.user?.email
      });

      return res.status(503).json({
        status: 'error',
        message: 'Instruments cache is being loaded. Please wait...',
        error: 'SERVICE_UNAVAILABLE',
        retry_after_seconds: 5
      });
    }

    // Start blocking refresh
    log.info('Starting BLOCKING instruments refresh - app not ready for trading', {
      user: req.user?.email,
      path: req.path
    });

    refreshInProgress = true;
    refreshError = null;

    try {
      // Fetch ALL instruments (no exchange filter)
      const result = await instrumentsService.refreshInstruments(null);

      // Mark app as ready
      appReady = true;
      refreshInProgress = false;
      lastRefreshDate = new Date();
      refreshError = null;

      log.info('Instruments refresh completed - app is now ready for trading', {
        count: result.count,
        duration_ms: result.duration_ms,
        duration_sec: (result.duration_ms / 1000).toFixed(2)
      });

      // Continue with the request
      next();
    } catch (error) {
      // Refresh failed - mark app as not ready
      appReady = false;
      refreshInProgress = false;
      refreshError = error.message;

      log.error('Instruments refresh FAILED - app not ready for trading', error);

      // Return error to user
      return res.status(503).json({
        status: 'error',
        message: 'Failed to load instruments cache. Trading is not available.',
        error: 'INSTRUMENTS_LOAD_FAILED',
        details: error.message,
        retry_after_seconds: 10
      });
    }
  } catch (error) {
    // Don't block request on unexpected errors
    log.error('Instruments refresh middleware error', error);
    next();
  }
}

