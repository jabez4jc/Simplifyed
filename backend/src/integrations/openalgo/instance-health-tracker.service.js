/**
 * OpenAlgo Instance Health Tracker Service
 * Per-instance circuit-breaker/cooldown tracking (DNS/HTML errors get immediate cooldown
 * with a manual-refresh escalation; other errors get exponential-backoff auto-recovery).
 * Extracted from client.js. The 'circuit breaker disabled' global override lives on
 * client.js (set from rate-limit settings, which stayed in client.js due to deeper coupling
 * with the concurrency engine) so isInstanceHealthy/getInstanceHealthStatus take it as an
 * explicit parameter rather than reading it directly - keeps this service fully self-
 * contained instead of reaching into another module's state.
 * NOTE: forceClearBackoff intentionally stayed in client.js - despite living physically
 * next to this cluster in the original file, it only ever touched errorCounters (rate-
 * limiter state), never instanceHealth, so it isn't actually part of this cluster.
 */

import { log } from '../../core/logger.js';
import { toISTISOString } from '../../utils/time.js';

class InstanceHealthTrackerService {
  constructor() {
    // Instance health tracking for circuit breaker pattern
    // Tracks instances that return HTML/error responses and puts them in cooldown
    // DNS/HTML errors: Immediate cooldown, max 3 retries (6 mins), then require manual refresh
    // Non-critical errors (5xx, rate-limit): Standard cooldown with exponential backoff, auto-recovers
    this.instanceHealth = new Map(); // key: instanceId -> { failures, cooldownUntil, lastError, isHtml, isDnsError, dnsRetryCount, cooldownCount, requiresManualRefresh }
    this.instanceHealthConfig = {
      failureThreshold: 3,             // 3 consecutive failures before cooldown (for non-critical errors only)
      cooldownMs: 5 * 60 * 1000,       // 5 minutes cooldown for non-critical repeated failures
      dnsCooldownMs: 2 * 60 * 1000,    // 2 minutes cooldown for DNS/HTML errors
      htmlCooldownMs: 2 * 60 * 1000,   // 2 minutes cooldown for HTML responses
      maxCooldownMs: 30 * 60 * 1000,   // 30 minutes max cooldown (with exponential backoff for non-critical)
      maxDnsRetries: 3,                // Max 3 retries for DNS/HTML errors before requiring manual refresh (6 mins total)
    };
  }

  /**
   * Check if an instance is healthy (not in cooldown or requiring manual refresh)
   * @param {number|string} instanceId - Instance ID
   * @returns {boolean} - True if healthy, false if in cooldown or requires manual refresh
   */
  isInstanceHealthy(instanceId, circuitBreakerDisabled = false) {
    // If circuit breaker is disabled, always return healthy
    if (circuitBreakerDisabled) {
      return true;
    }

    const health = this.instanceHealth.get(instanceId);
    if (!health) return true;

    // Instance requires manual refresh (DNS/HTML errors only) - don't auto-recover
    if (health.requiresManualRefresh) {
      return false;
    }

    const now = Date.now();
    if (health.cooldownUntil && now < health.cooldownUntil) {
      return false;
    }

    // Cooldown expired - check if this was a DNS/HTML error that needs retry tracking
    const hasCriticalError = health.isDnsError || health.isHtml;
    if (hasCriticalError && health.dnsRetryCount >= this.instanceHealthConfig.maxDnsRetries) {
      // Mark as requiring manual refresh for DNS/HTML errors only
      health.requiresManualRefresh = true;
      health.cooldownUntil = null; // No more auto-cooldowns
      this.instanceHealth.set(instanceId, health);

      log.warn('Instance requires manual refresh - max DNS/HTML retries reached', {
        instanceId,
        dnsRetryCount: health.dnsRetryCount,
        isDnsError: health.isDnsError,
        isHtmlError: health.isHtml,
        lastError: health.lastError,
      });
      return false;
    }

    // For non-critical errors, auto-recover when cooldown expires
    if (!hasCriticalError && health.cooldownUntil && now >= health.cooldownUntil) {
      // Cooldown expired for non-critical error, clear health state
      this.instanceHealth.delete(instanceId);
      log.debug('Instance health auto-recovered after cooldown', { instanceId });
      return true;
    }

    // Cooldown expired and retries remaining, allow next attempt
    return true;
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
  getInstanceHealthStatus(instanceId, circuitBreakerDisabled = false) {
    const health = this.instanceHealth.get(instanceId);
    if (!health) return null;

    const now = Date.now();
    const cooldownRemaining = health.cooldownUntil ? Math.max(0, health.cooldownUntil - now) : 0;

    return {
      isHealthy: this.isInstanceHealthy(instanceId, circuitBreakerDisabled),
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
    const { failureThreshold, cooldownMs, htmlCooldownMs, dnsCooldownMs, maxCooldownMs, maxDnsRetries } = this.instanceHealthConfig;

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

    // For critical errors (DNS/HTML), immediately enter cooldown with retry tracking
    if (isCriticalError) {
      // Mark the error type (sticky - once set, stays set until manual refresh)
      health.isHtml = isHtml || health.isHtml;
      health.isDnsError = isDnsError || health.isDnsError;
      health.dnsRetryCount += 1;

      // Check if max retries reached
      if (health.dnsRetryCount >= maxDnsRetries) {
        health.requiresManualRefresh = true;
        health.cooldownUntil = null; // No more automatic retries

        log.error('Instance marked unhealthy - requires manual refresh', {
          instanceId,
          dnsRetryCount: health.dnsRetryCount,
          reason: isDnsError ? 'dns_error' : 'html_response',
          lastError: health.lastError,
          message: 'Instance will not be retried until user performs manual refresh',
        });
      } else {
        // Enter 2-minute cooldown for next retry
        const baseCooldown = isDnsError ? dnsCooldownMs : htmlCooldownMs;
        health.cooldownUntil = now + baseCooldown;

        log.warn('Instance entered cooldown - will retry (DNS/HTML error)', {
          instanceId,
          cooldownMs: baseCooldown,
          dnsRetryCount: health.dnsRetryCount,
          maxDnsRetries,
          retriesRemaining: maxDnsRetries - health.dnsRetryCount,
          reason: isDnsError ? 'dns_error' : 'html_response',
          lastError: health.lastError,
          resumeAt: toISTISOString(health.cooldownUntil),
        });
      }

      health.failures = 0; // Reset failure counter after entering cooldown
    } else if (health.failures >= failureThreshold) {
      // For non-critical repeated failures, use exponential backoff cooldown
      // These auto-recover - do NOT set requiresManualRefresh

      // Calculate cooldown with exponential backoff
      const backoffExponent = Math.min(health.cooldownCount, 3); // Cap at 8x multiplier
      const backoffMultiplier = Math.pow(2, backoffExponent);
      const calculatedCooldown = Math.min(cooldownMs * backoffMultiplier, maxCooldownMs);

      health.cooldownUntil = now + calculatedCooldown;
      health.cooldownCount += 1;
      health.failures = 0;

      log.warn('Instance entered cooldown due to repeated failures (auto-recovers)', {
        instanceId,
        cooldownMs: calculatedCooldown,
        cooldownCount: health.cooldownCount,
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
