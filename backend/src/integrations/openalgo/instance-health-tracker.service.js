/**
 * OpenAlgo Instance Health Tracker Service
 * Per-instance circuit-breaker/cooldown tracking (DNS/HTML errors get immediate cooldown
 * with a manual-refresh escalation; other errors get exponential-backoff auto-recovery).
 * Extracted from client.js.
 */

import { log } from '../../core/logger.js';
import { toISTISOString } from '../../utils/time.js';

/**
 * Longest an unreachable instance is left alone before the next probe. This replaces the old
 * fixed IST "blackout" clock windows: an OpenAlgo server that is down overnight (the daily broker
 * re-login) is probed at a growing interval, and is back in use within this long of recovering,
 * whatever time it recovers at.
 */
export const MAX_UNREACHABLE_BACKOFF_MS = 10 * 60 * 1000;

/** `baseMs` doubled per consecutive failure (1st failure = baseMs), capped. */
export function backoffMs(attempt, baseMs, capMs = MAX_UNREACHABLE_BACKOFF_MS) {
  return Math.min(baseMs * 2 ** Math.max(0, attempt - 1), capMs);
}

/**
 * Whether an error means "the instance could not be reached", as opposed to OpenAlgo answering
 * with a real error (a 400 for a bad symbol, a 404 for an unknown order). Only the former should
 * open the circuit - one bad symbol must not take a healthy instance offline.
 */
export function isUnreachableError(error) {
  if (!error) return false;
  if (error.isHtmlResponse || error.isDnsError) return true;
  if ([502, 503, 504].includes(error.statusCode)) return true;
  const msg = String(error.message || '');
  return /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|getaddrinfo|fetch failed|timed? ?out|aborted|socket hang up|Invalid JSON response/i.test(msg);
}

class InstanceHealthTrackerService {
  constructor() {
    // Instance health tracking for circuit breaker pattern
    // Tracks instances that return HTML/error responses and puts them in cooldown
    // DNS/HTML errors: Immediate cooldown, max 3 retries (6 mins), then require manual refresh
    // Non-critical errors (5xx, rate-limit): Standard cooldown with exponential backoff, auto-recovers
    this.instanceHealth = new Map(); // key: instanceId -> { failures, cooldownUntil, lastError, isHtml, isDnsError, dnsRetryCount, cooldownCount, requiresManualRefresh }
    this.instanceHealthConfig = {
      failureThreshold: 3,             // consecutive failures before cooldown (non-DNS/HTML errors)
      cooldownMs: 60 * 1000,           // first cooldown for repeated failures, doubling after
      dnsCooldownMs: 60 * 1000,        // first cooldown for a DNS failure, doubling after
      htmlCooldownMs: 60 * 1000,       // first cooldown for an HTML error page, doubling after
      maxCooldownMs: MAX_UNREACHABLE_BACKOFF_MS,
      maxDnsRetries: 0,                // kept for the circuit-breaker API response shape; unused
    };
  }

  /**
   * Check if an instance is healthy (not in cooldown or requiring manual refresh)
   * @param {number|string} instanceId - Instance ID
   * @returns {boolean} - True if healthy, false if in cooldown or requires manual refresh
   */
  isInstanceHealthy(instanceId) {
    const health = this.instanceHealth.get(instanceId);
    if (!health?.cooldownUntil) return true;
    // Once the cooldown lapses the circuit is half-open: the next request is the probe. Its
    // success clears this state (resetInstanceHealth); its failure opens a longer cooldown,
    // since cooldownCount is kept until then.
    return Date.now() >= health.cooldownUntil;
  }

  /**
   * Check if instance requires manual refresh
   * @param {number|string} instanceId - Instance ID
   * @returns {boolean} - True if instance requires manual refresh
   */
  instanceRequiresManualRefresh(instanceId) {
    const health = this.instanceHealth.get(instanceId);
    return health?.requiresManualRefresh === true;
  }

  /**
   * Get instance health status for display
   * @param {number|string} instanceId - Instance ID
   * @returns {Object|null} - Health status or null if healthy
   */
  getInstanceHealthStatus(instanceId) {
    const health = this.instanceHealth.get(instanceId);
    if (!health) return null;

    const now = Date.now();
    const cooldownRemaining = health.cooldownUntil ? Math.max(0, health.cooldownUntil - now) : 0;

    return {
      isHealthy: this.isInstanceHealthy(instanceId),
      requiresManualRefresh: health.requiresManualRefresh || false,
      dnsRetryCount: health.dnsRetryCount || 0,
      maxDnsRetries: this.instanceHealthConfig.maxDnsRetries,
      cooldownRemaining,
      cooldownUntil: health.cooldownUntil,
      lastError: health.lastError,
      isDnsError: health.isDnsError || false,
      isHtmlError: health.isHtml || false,
    };
  }

  /**
   * Get remaining cooldown time for an instance
   * @param {number|string} instanceId - Instance ID
   * @returns {number} - Remaining cooldown in ms, or 0 if healthy
   */
  getInstanceCooldownRemaining(instanceId) {
    const health = this.instanceHealth.get(instanceId);
    if (!health || !health.cooldownUntil) return 0;

    const remaining = health.cooldownUntil - Date.now();
    return remaining > 0 ? remaining : 0;
  }

  /**
   * Record an instance failure and potentially put it in cooldown
   *
   * Two different behaviors based on error type:
   * 1. DNS/HTML errors (critical): Immediate 2-min cooldown, max 3 retries, then require manual refresh
   * 2. Non-critical errors (5xx, rate-limit): 3 failures before cooldown, exponential backoff, auto-recovers
   *
   * @param {number|string} instanceId - Instance ID
   * @param {Error} error - The error that occurred
   * @param {Object} options - Additional options
   * @param {boolean} options.isHtml - Whether the response was HTML (instance likely down)
   * @param {boolean} options.isDnsError - Whether this is a DNS resolution error
   */
  recordInstanceFailure(instanceId, error, options = {}) {
    const { isHtml = false, isDnsError = false } = options;
    const now = Date.now();
    const { failureThreshold, cooldownMs, htmlCooldownMs, dnsCooldownMs, maxCooldownMs } = this.instanceHealthConfig;

    // Check if this is a critical error (DNS or HTML) that requires immediate cooldown
    const isCriticalError = isHtml || isDnsError;

    let health = this.instanceHealth.get(instanceId) || {
      failures: 0,
      cooldownUntil: null,
      lastError: null,
      isHtml: false,
      isDnsError: false,
      dnsRetryCount: 0,           // Only for DNS/HTML errors - triggers manual refresh
      cooldownCount: 0,           // For non-critical errors - exponential backoff
      requiresManualRefresh: false,
    };

    health.failures += 1;
    health.lastError = error?.message || 'Unknown error';
    health.lastFailureAt = now;

    // A DNS failure or an HTML error page (the proxy in front of a stopped server) opens the
    // circuit at once; anything else only after failureThreshold in a row. Either way the
    // cooldown doubles per consecutive opening up to MAX_UNREACHABLE_BACKOFF_MS, and the
    // instance always recovers on its own - there is no manual-refresh lockout.
    health.isHtml = isHtml;
    health.isDnsError = isDnsError;
    const inProbe = health.cooldownUntil !== null && now >= health.cooldownUntil;
    if (isCriticalError || inProbe || health.failures >= failureThreshold) {
      health.cooldownCount += 1;
      const base = isCriticalError ? (isDnsError ? dnsCooldownMs : htmlCooldownMs) : cooldownMs;
      const wait = backoffMs(health.cooldownCount, base, maxCooldownMs);
      health.cooldownUntil = now + wait;
      health.failures = 0;
      // One line per opening, not per short-circuited call - this is what keeps an overnight
      // outage from filling the log.
      log.warn('Instance unreachable - pausing calls to it', {
        instanceId,
        cooldownMs: wait,
        cooldownCount: health.cooldownCount,
        reason: isDnsError ? 'dns_error' : isHtml ? 'html_response' : 'repeated_failures',
        lastError: health.lastError,
        resumeAt: toISTISOString(health.cooldownUntil),
      });
    }

    this.instanceHealth.set(instanceId, health);
  }

  /**
   * Reset instance health after successful request
   * Only resets if instance doesn't require manual refresh
   * @param {number|string} instanceId - Instance ID
   */
  resetInstanceHealth(instanceId) {
    const health = this.instanceHealth.get(instanceId);
    if (!health) return;

    // Don't auto-reset if instance requires manual refresh
    if (health.requiresManualRefresh) {
      log.debug('Instance requires manual refresh - not auto-resetting', { instanceId });
      return;
    }

    this.instanceHealth.delete(instanceId);
    log.debug('Instance health reset after successful request', { instanceId });
  }

  /**
   * Force reset instance health (called on manual refresh by user)
   * This clears all health state including requiresManualRefresh flag
   * @param {number|string} instanceId - Instance ID
   */
  forceResetInstanceHealth(instanceId) {
    const hadHealth = this.instanceHealth.has(instanceId);
    const previousState = this.instanceHealth.get(instanceId);

    this.instanceHealth.delete(instanceId);

    if (hadHealth) {
      log.info('Instance health force reset via manual refresh', {
        instanceId,
        previousState: previousState ? {
          requiresManualRefresh: previousState.requiresManualRefresh,
          dnsRetryCount: previousState.dnsRetryCount,
          cooldownCount: previousState.cooldownCount,
          lastError: previousState.lastError,
          isDnsError: previousState.isDnsError,
          isHtml: previousState.isHtml,
        } : null,
      });
    }
  }
}

const instanceHealthTrackerService = new InstanceHealthTrackerService();
export default instanceHealthTrackerService;
export { InstanceHealthTrackerService };
