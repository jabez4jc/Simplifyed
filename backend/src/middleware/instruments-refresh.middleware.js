/**
 * Instruments readiness (report only)
 *
 * Whether the instruments cache is usable is reported here for /api/v1/ready. Nothing in this
 * module refreshes or blocks: instruments are refreshed by instruments.service's boot catch-up and
 * its crons, never inside an HTTP request (the old gate held a request open for up to 120 s).
 */

import instrumentsService from '../services/instruments.service.js';
import { log } from '../core/logger.js';
import { isTestMode } from '../core/config.js';

/**
 * `ready` reports whether the instruments cache has actually been verified - it is never set
 * true as a side effect of a bypass, so /api/v1/ready can still fail when it should.
 */
export async function getAppReadyStatus() {
  if (isTestMode()) {
    return { ready: false, refreshInProgress: false, bypassed: true, reason: 'test mode - instruments not verified' };
  }
  try {
    return { ready: !(await instrumentsService.needsRefresh()), refreshInProgress: instrumentsService.isRefreshing() };
  } catch (error) {
    log.error('Could not evaluate instruments readiness', error);
    return { ready: false, refreshInProgress: instrumentsService.isRefreshing() };
  }
}
