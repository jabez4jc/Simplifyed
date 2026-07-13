/**
 * Market Data Circuit Breaker Service
 * Per-key (instanceId:feed) failure tracking with a cooldown "circuit" that opens after repeated
 * failures, so a broker/feed that's actively erroring doesn't get hammered every poll tick.
 * Extracted from market-data-feed.service.js - this piece is genuinely self-contained (its own
 * Map, no reads of position/order/lifecycle state), unlike the instance-health-ping subsystem
 * (_pingInstancesHeartbeat/_markInstanceHealthy/etc.) which stays in market-data-feed.service.js
 * because it's coupled to that file's start/stop/applyConfig lifecycle and open-position
 * notification state - splitting that too would need a lifecycle restructure, not a clean cut.
 */

import { log } from '../core/logger.js';

class MarketDataCircuitBreakerService {
  constructor() {
    this.failureState = new Map(); // key instanceId:feed -> state
    this.failureThreshold = 3;
    this.cooldownMs = 60000; // 1 minute default
    this.cooldownJitterMs = 5000;
  }

  getCircuitKey(instanceId, feed) {
    return `${instanceId}:${feed}`;
  }

  getCircuitState(instanceId, feed) {
    const key = this.getCircuitKey(instanceId, feed);
    const state = this.failureState.get(key);
    if (!state || !state.cooldownUntil) {
      return { open: false, resumeInMs: null, lastError: null };
    }

    const remaining = state.cooldownUntil - Date.now();
    return {
      open: remaining > 0,
      resumeInMs: remaining > 0 ? remaining : null,
      lastError: state.lastErrorMessage || null,
    };
  }

  shouldSkipPolling(key) {
    const state = this.failureState.get(key);
    if (!state) return false;
    if (state.cooldownUntil && state.cooldownUntil > Date.now()) {
      if (!state.notified) {
        log.warn('Skipping feed refresh due to upstream cooldown', {
          key,
          resumeInMs: state.cooldownUntil - Date.now(),
          lastError: state.lastErrorMessage,
        });
        state.notified = true;
      }
      return true;
    }
    return false;
  }

  recordFailure(key, error) {
    const state = this.failureState.get(key) || {
      failures: 0,
      cooldownUntil: null,
      lastErrorMessage: null,
      notified: false,
    };

    state.failures += 1;
    state.lastErrorMessage = error?.message;
    state.notified = false;

    const isHtml = error?.isHtmlResponse;

    if (state.failures >= this.failureThreshold || isHtml) {
      const jitter = Math.floor(Math.random() * this.cooldownJitterMs);
      state.cooldownUntil = Date.now() + this.cooldownMs + jitter;
      state.failures = 0;
      log.warn('Opened circuit breaker for feed polling', {
        key,
        cooldownMs: this.cooldownMs + jitter,
        reason: isHtml ? 'html_response' : 'excess_failures',
        error: error?.message,
      });
    }

    this.failureState.set(key, state);
  }

  resetFailureState(key) {
    if (this.failureState.has(key)) {
      this.failureState.delete(key);
    }
  }
}

const marketDataCircuitBreakerService = new MarketDataCircuitBreakerService();
export default marketDataCircuitBreakerService;
export { MarketDataCircuitBreakerService };
