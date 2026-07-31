/**
 * Instruments Refresh Middleware
 * Ensures instruments cache is loaded before app is ready for trading
 * BLOCKS all API requests until first refresh completes on first login of the day
 */

import instrumentsService from '../services/instruments.service.js';
import { log } from '../core/logger.js';
import { isTestMode } from '../core/config.js';

/**
 * Global app readiness state
 * Tracks if instruments cache is loaded and ready for trading
 */
let appReady = false;
let refreshInProgress = false;
let refreshError = null;
let lastRefreshDate = null;
let bypassed = false;

// isTestMode() is imported from core/config.js so there is exactly one definition of
// "authentication is disabled". Test mode means this is not a real deployment, which is the
// only condition under which skipping the instruments check is defensible.

/**
 * Get app ready status.
 * `ready` reports whether the instruments cache has actually been verified - it is never set
 * true as a side effect of a bypass, so /api/v1/ready can still fail when it should.
 */
export function getAppReadyStatus() {
  return {
    ready: appReady,
    refreshInProgress,
    error: refreshError,
    lastRefreshDate,
    ...(bypassed ? { bypassed: true, reason: 'test mode - instruments not verified' } : {}),
  };
}

/**
 * Evaluate readiness once at startup.
 *
 * Whether the instruments cache is usable is a property of the server, not of anyone's request.
 * Readiness was previously only ever computed inside `checkInstrumentsRefresh`, which returns
 * early for unauthenticated traffic - so /api/v1/ready stayed 503 until a human logged in.
 * That is unusable as a probe: a load balancer would never route traffic, so no login could
 * happen, so it would never go green. (The old development bypass hid this by asserting
 * readiness unconditionally.)
 *
 * Only the cheap local check runs here - two SQLite queries. A stale cache deliberately leaves
 * the app not-ready rather than triggering a broker refresh during boot; the first authenticated
 * request performs that blocking refresh, as before.
 */
export async function evaluateStartupReadiness() {
  if (isTestMode()) {
    bypassed = true;
    log.warn('Test mode: instruments check bypassed - app is NOT verified for trading');
    return getAppReadyStatus();
  }

  try {
    const needsRefresh = await instrumentsService.needsRefresh();
    if (!needsRefresh) {
      appReady = true;
      lastRefreshDate = new Date();
      log.info('Instruments cache is current - app ready for trading');
    } else {
      appReady = false;
      log.warn('Instruments cache is stale - app NOT ready; refresh runs on first authenticated request');
    }
  } catch (error) {
    appReady = false;
    refreshError = error.message;
    log.error('Could not evaluate instruments readiness at startup', error);
  }

  return getAppReadyStatus();
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
    // Skip middleware for non-API/static requests so the UI can load
    if (!req.path.startsWith('/api')) {
      return next();
    }

    // Allow health check and ready status endpoints without blocking
    if (req.path === '/api/v1/health' || req.path === '/api/v1/ready') {
      return next();
    }

    // Allow auth endpoints without blocking
    if (req.path.startsWith('/auth/')) {
      return next();
    }

    // Test mode is the only bypass, and it does NOT claim the app is ready.
    //
    // This used to also bypass whenever NODE_ENV was 'development' - and, because NODE_ENV
    // defaults to 'development' when unset, that made a forgotten environment variable enough
    // to disable the check on a real deployment. Worse, the bypass set `appReady = true`, so
    // /api/v1/ready returned 200 while the instruments cache had never been verified. A
    // readiness probe that cannot fail is not a readiness probe.
    //
    // Nothing is saved by skipping: needsRefresh() below is two local SQLite queries, so with a
    // warm cache this middleware is already a no-op. The bypass only ever mattered on the one
    // request per day where the cache is genuinely stale - which is precisely when a trading
    // application must not proceed.
    if (isTestMode()) {
      if (!bypassed) {
        bypassed = true;
        log.warn('Test mode: instruments refresh bypassed - app is NOT verified for trading');
      }
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
