/**
 * Instruments Refresh Middleware
 * Checks if instruments cache needs refresh on user activity
 * Triggers background refresh if needed (daily refresh strategy)
 */

import instrumentsService from '../services/instruments.service.js';
import { log } from '../core/logger.js';

/**
 * Track last refresh check per session to avoid redundant checks
 * Key: sessionId, Value: timestamp of last check
 */
const sessionRefreshChecks = new Map();

/**
 * Minimum interval between refresh checks (5 minutes)
 * Prevents hammering the refresh check on every request
 */
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Middleware to check and trigger instruments refresh
 * Runs asynchronously in background to avoid blocking requests
 *
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Next middleware
 */
export async function checkInstrumentsRefresh(req, res, next) {
  try {
    // Only check for authenticated users
    if (!req.isAuthenticated || !req.isAuthenticated()) {
      return next();
    }

    // Get session ID
    const sessionId = req.sessionID || req.session?.id;
    if (!sessionId) {
      return next();
    }

    // Check if we've already checked recently for this session
    const lastCheck = sessionRefreshChecks.get(sessionId);
    if (lastCheck && (Date.now() - lastCheck) < CHECK_INTERVAL_MS) {
      return next();
    }

    // Update last check timestamp
    sessionRefreshChecks.set(sessionId, Date.now());

    // Check and refresh in background (don't block request)
    setImmediate(async () => {
      try {
        const needsRefresh = await instrumentsService.needsRefresh();

        if (needsRefresh) {
          log.info('Instruments cache needs refresh, starting background refresh', {
            session_id: sessionId,
            user: req.user?.email
          });

          // Trigger refresh in background (don't await)
          instrumentsService.refreshInstruments()
            .then(result => {
              log.info('Background instruments refresh completed', {
                count: result.count,
                duration_ms: result.duration_ms
              });
            })
            .catch(error => {
              log.error('Background instruments refresh failed', error);
            });
        }
      } catch (error) {
        log.error('Failed to check instruments refresh', error);
      }
    });

    // Continue without waiting for refresh check
    next();
  } catch (error) {
    // Don't block request on error
    log.error('Instruments refresh middleware error', error);
    next();
  }
}

/**
 * Cleanup old session entries (call periodically from polling service)
 * Removes entries older than 1 hour
 */
export function cleanupSessionChecks() {
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  let removed = 0;

  for (const [sessionId, timestamp] of sessionRefreshChecks.entries()) {
    if (timestamp < oneHourAgo) {
      sessionRefreshChecks.delete(sessionId);
      removed++;
    }
  }

  if (removed > 0) {
    log.debug('Cleaned up old session refresh checks', { removed });
  }
}
