/**
 * OpenAlgo API Client
 * HTTP client with HTTP/2 multiplexing and exponential backoff retry logic
 */

import { Agent, ProxyAgent } from 'undici';
import { EventEmitter } from 'events';
import { log } from '../../core/logger.js';
import { OpenAlgoError } from '../../core/errors.js';
import config from '../../core/config.js';
import { toISTISOString } from '../../utils/time.js';
import { maskApiKey } from '../../utils/sanitizers.js';
import settingsService from '../../services/settings.service.js';
import { isGeneralEndpointBlackout, isQuoteEndpointBlackout } from '../../services/instance-health.service.js';
import instanceHealthTrackerService from './instance-health-tracker.service.js';
import resolutionCacheService from './resolution-cache.service.js';
import { isCryptoBroker } from '../../utils/broker-type.util.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ERROR_LIMITS = {
  max404PerDay: 20,              // Max 404 errors per instance per reset interval
  maxInvalidApiPerDay: 10,       // Max invalid API key errors per reset interval
  backoffMs: 5 * 60 * 1000,      // 5 minutes backoff when limits exceeded
  resetIntervalMs: 30 * 60 * 1000, // Reset counters every 30 minutes
};

/**
 * OpenAlgo HTTP Client with HTTP/2 multiplexing support
 */
class OpenAlgoClient extends EventEmitter {
  constructor() {
    super();
    this.timeout = config.openalgo.requestTimeout;
    // Store both critical and non-critical retry configs
    this.criticalRetries = config.openalgo.critical.maxRetries;
    this.criticalRetryDelay = config.openalgo.critical.retryDelay;
    this.nonCriticalRetries = config.openalgo.nonCritical.maxRetries;
    this.nonCriticalRetryDelay = config.openalgo.nonCritical.retryDelay;
    this.instanceTimeoutOverrides = this._loadInstanceTimeoutOverrides();
    this.fastSnapshotMode = process.env.OPENALGO_FAST_SNAPSHOT_MODE !== 'false';

    // Per-symbol quote failure cooldown: a symbol that's invalid/unlisted on a given instance
    // (e.g. bad or expired contract) fails every time it's requested, and since a failed quote
    // never populates the caller's cache, every subsequent "missing symbol" check re-triggers a
    // live fetch - without this, that produces an unbounded retry flood against the broker.
    this._quoteFailureCache = new Map(); // key: `${instanceId}|${exchange}|${symbol}` -> { count, lastFailAt }
    this.QUOTE_FAILURE_THRESHOLD = 3;
    this.QUOTE_FAILURE_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

    // Default dispatcher with HTTP/2 support and connection reuse
    // Conservative timeouts to avoid ECONNRESET from stale connections
    this.dispatcher = new Agent({
      keepAliveTimeout: 30000,       // 30 seconds keep-alive (reduced from 2 min)
      keepAliveMaxTimeout: 60000,    // 1 minute max (reduced from 5 min)
      pipelining: 10,                // Enable HTTP pipelining for multiplexing
      connections: 20,               // Conservative connection pool (reduced from 50)
      allowH2: true,                 // Enable HTTP/2 when available
    });

    // Create undici ProxyAgent that uses environment proxy if configured
    const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY ||
                     process.env.http_proxy || process.env.HTTP_PROXY;

    // Parse TLS verification setting (defaults to true for security)
    const rejectUnauthorized = process.env.PROXY_TLS_REJECT_UNAUTHORIZED !== 'false';

    if (proxyUrl) {
      try {
        // Parse URL to safely extract host info without credentials
        const proxyUrlObj = new URL(proxyUrl);
        log.info('Using proxy for OpenAlgo requests', {
          proxy: `${proxyUrlObj.protocol}//${proxyUrlObj.host}`,
          tlsVerification: rejectUnauthorized
        });

        if (!rejectUnauthorized) {
          log.warn('TLS certificate verification is DISABLED for proxy connections. Use only in development!');
        }

        this.dispatcher = new ProxyAgent({
          uri: proxyUrl,
          requestTls: {
            rejectUnauthorized,
          },
        });
      } catch (error) {
        log.error('Invalid proxy URL, proceeding without proxy', { error: error.message });
        // Keep default dispatcher if proxy configuration fails
      }
    } else {
      log.info('No proxy configured for OpenAlgo requests (HTTP/2 multiplexing enabled)');
    }

    // Rate-limit state
    this.instanceRate = new Map(); // key -> { rps:[], rpm:[], orders:[] }
    this.globalRpm = [];
    this.globalOrders = [];
    this.currentTasks = 0;
    this.maxConcurrentTasks = 10;
    this.rpsLimitPerInstance = 5;
    this.rpmLimitPerInstance = 300;
    this.rpmLimitGlobal = Number.POSITIVE_INFINITY; // optional global cap (disabled)
    this.ordersPerSecondLimit = 10;
    // OpenAlgo caps /placesmartorder at 2 req/sec, a stricter limit than plain /placeorder's
    // 10/sec. Every order this app places goes through placesmartorder (see order-placement
    // .service.js - it always reconciles against the open position), so applying the lenient
    // limit there let a burst - closing several positions, a fast quick-order fan-out, a retry
    // storm - send smart-orders up to 5x the rate the broker actually accepts.
    this.smartOrdersPerSecondLimit = 2;
    // Endpoint-specific token buckets (per instance)
    this.endpointBuckets = new Map(); // key: instKey -> { orders, critical, background, rest_quotes }
    this.errorCounters = new Map(); // instKey -> { day, count404, countInvalid, backoffUntil }
    this.instanceMeta = new Map();

    // Rate limit settings cache - loaded once at startup, refreshed on settings change
    this.limitsCache = {
      loadedAt: 0,
      ttl: 10 * 60 * 1000,  // 10 minutes (increased from 1 minute)
      initialized: false,
      initPromise: null,    // Promise-based lock for concurrent init calls
      reloadPromise: null,  // Promise-based lock for concurrent reload calls
    };

    // Symbol resolution cache and lot-size cache moved to resolution-cache.service.js
    // (fully self-contained, zero coupling to anything else in this file).
    // Instance health/circuit-breaker tracking moved to instance-health-tracker.service.js
    // (the "circuit breaker disabled" override below is the one piece of state that couldn't
    // move with it - see the wrapper methods further down for why).
  }

  // Delegated to instance-health-tracker.service.js - names/signatures kept identical so every
  // existing internal and external call site keeps working unmodified. circuitBreakerDisabled
  // (set in _loadRateLimitSettings below, which stayed in this file) is passed explicitly rather
  // than read from shared state, so the tracker service stays fully self-contained.
  isInstanceHealthy(instanceId) {
    return instanceHealthTrackerService.isInstanceHealthy(instanceId, this.circuitBreakerDisabled);
  }

  instanceRequiresManualRefresh(instanceId) {
    return instanceHealthTrackerService.instanceRequiresManualRefresh(instanceId);
  }

  getInstanceHealthStatus(instanceId) {
    return instanceHealthTrackerService.getInstanceHealthStatus(instanceId, this.circuitBreakerDisabled);
  }

  getInstanceCooldownRemaining(instanceId) {
    return instanceHealthTrackerService.getInstanceCooldownRemaining(instanceId);
  }

  recordInstanceFailure(instanceId, error, options = {}) {
    return instanceHealthTrackerService.recordInstanceFailure(instanceId, error, options);
  }

  resetInstanceHealth(instanceId) {
    return instanceHealthTrackerService.resetInstanceHealth(instanceId);
  }

  forceResetInstanceHealth(instanceId) {
    return instanceHealthTrackerService.forceResetInstanceHealth(instanceId);
  }

  /**
   * Force clear error counters/backoff state for an instance
   * Used after credentials are fixed so polling can resume immediately.
   * @param {number|string} instanceId - Instance ID
   */
  forceClearBackoff(instanceId) {
    if (this.errorCounters.has(instanceId)) {
      this.errorCounters.delete(instanceId);
      log.info('Instance backoff cleared manually', { instanceId });
    }
  }

  /**
   * Initialize rate limit settings from database (called once at startup)
   * Uses promise-based locking to prevent race conditions from concurrent calls
   * @returns {Promise<void>}
   */
  async initializeRateLimits() {
    // Already initialized - return immediately
    if (this.limitsCache.initialized) return;

    // If initialization is in progress, wait for it to complete
    if (this.limitsCache.initPromise) {
      return this.limitsCache.initPromise;
    }

    // Start initialization with promise-based lock
    this.limitsCache.initPromise = (async () => {
      try {
        await this._loadRateLimitSettings();
        this.limitsCache.initialized = true;
        log.info('Rate limit settings initialized', {
          rpsPerInstance: this.rpsLimitPerInstance,
          rpmPerInstance: this.rpmLimitPerInstance,
          ordersPerSecond: this.ordersPerSecondLimit,
          smartOrdersPerSecond: this.smartOrdersPerSecondLimit,
          maxConcurrentTasks: this.maxConcurrentTasks,
        });
      } catch (error) {
        log.warn('Failed to initialize rate limit settings, using defaults', { error: error.message });
      } finally {
        // Clear the promise after completion (success or failure)
        this.limitsCache.initPromise = null;
      }
    })();

    return this.limitsCache.initPromise;
  }

  /**
   * Reload rate limit settings (called on settings change event)
   * Uses promise-based locking to prevent concurrent reloads from multiple settings changes
   * @returns {Promise<void>}
   */
  async reloadRateLimits() {
    // If reload is already in progress, wait for it to complete
    if (this.limitsCache.reloadPromise) {
      return this.limitsCache.reloadPromise;
    }

    // Start reload with promise-based lock
    this.limitsCache.reloadPromise = (async () => {
      try {
        await this._loadRateLimitSettings();
        log.info('Rate limit settings reloaded', {
          rpsPerInstance: this.rpsLimitPerInstance,
          rpmPerInstance: this.rpmLimitPerInstance,
          ordersPerSecond: this.ordersPerSecondLimit,
          smartOrdersPerSecond: this.smartOrdersPerSecondLimit,
          maxConcurrentTasks: this.maxConcurrentTasks,
        });
        this.emit('rateLimitsReloaded');
      } catch (error) {
        log.warn('Failed to reload rate limit settings', { error: error.message });
      } finally {
        // Clear the promise after completion
        this.limitsCache.reloadPromise = null;
      }
    })();

    return this.limitsCache.reloadPromise;
  }

  /**
   * Load rate limit settings from database
   * @private
   */
  async _loadRateLimitSettings() {
    const settings = await settingsService.getSettingsByCategory('rate_limits');
    const getNum = (key, fallback) => {
      const entry = settings[key];
      const raw = entry ? (entry.pendingValue ?? entry.value ?? entry.rawValue) : undefined;
      const val = parseFloat(raw);
      return Number.isNaN(val) ? fallback : val;
    };
    const getBool = (key, fallback) => {
      const entry = settings[key];
      const raw = entry ? (entry.pendingValue ?? entry.value ?? entry.rawValue) : undefined;
      if (raw === undefined || raw === null) return fallback;
      return raw === true || raw === 'true' || raw === '1';
    };

    this.rpsLimitPerInstance = getNum('rate_limits.rps_per_instance', this.rpsLimitPerInstance);
    this.rpmLimitPerInstance = getNum('rate_limits.rpm_per_instance', this.rpmLimitPerInstance);
    this.rpmLimitGlobal = Number.POSITIVE_INFINITY; // keep global cap disabled
    this.ordersPerSecondLimit = getNum('rate_limits.orders_per_second', this.ordersPerSecondLimit);
    this.smartOrdersPerSecondLimit = getNum('rate_limits.smart_orders_per_second', this.smartOrdersPerSecondLimit);
    this.maxConcurrentTasks = getNum('rate_limits.max_concurrent_tasks', this.maxConcurrentTasks);

    // Testing/debug settings
    this.rateLimitsDisabled = getBool('rate_limits.disabled', false);
    this.circuitBreakerDisabled = getBool('rate_limits.circuit_breaker_disabled', false);

    this.limitsCache.loadedAt = Date.now();

    if (this.rateLimitsDisabled) {
      log.warn('Rate limits are DISABLED - all requests will bypass throttling');
    }
    if (this.circuitBreakerDisabled) {
      log.warn('Circuit breaker is DISABLED - unhealthy instances will still be used');
    }
  }

  /**
   * Cache a resolved symbol with bounded size
   * Evicts oldest entries when cache exceeds max size
   * @param {string} underlying - Underlying symbol
   * @param {string} exchange - Exchange
   * @param {string} expiry - Expiry date
   * @param {Object} resolved - Resolved symbol data
   */
  cacheResolvedSymbol(underlying, exchange, expiry, resolved) {
    return resolutionCacheService.cacheResolvedSymbol(underlying, exchange, expiry, resolved);
  }

  getCachedResolvedSymbol(underlying, exchange, expiry) {
    return resolutionCacheService.getCachedResolvedSymbol(underlying, exchange, expiry);
  }

  cacheLotSize(exchange, symbol, lotSize) {
    return resolutionCacheService.cacheLotSize(exchange, symbol, lotSize);
  }

  getCachedLotSize(exchange, symbol) {
    return resolutionCacheService.getCachedLotSize(exchange, symbol);
  }

  preloadLotSizes(symbols) {
    return resolutionCacheService.preloadLotSizes(symbols);
  }

  /**
   * Make HTTP request to OpenAlgo API
   * @param {Object} instance - Instance configuration
   * @param {string} endpoint - API endpoint (e.g., 'ping', 'placeorder')
   * @param {Object} data - Request payload (apikey will be added)
   * @param {string} method - HTTP method (default: POST)
   * @param {Object} options - Request options
   * @param {boolean} options.isCritical - Whether this is a critical operation (default: false)
   * @returns {Promise<Object>} - API response
   */
  async request(instance, endpoint, data = {}, method = 'POST', options = {}) {
    const endpointKey = (endpoint || '').toLowerCase();
    const isQuoteEndpoint =
      endpointKey.includes('quotes') ||
      endpointKey.includes('optionchain') ||
      endpointKey.includes('depth');
    // The blackout windows exist to pause calls during Indian market off-hours - crypto
    // brokers trade 24/7 and have no such window, so they're exempt entirely.
    const inBlackout = !isCryptoBroker(instance?.broker)
      && (isQuoteEndpoint ? isQuoteEndpointBlackout() : isGeneralEndpointBlackout());
    if (inBlackout && !options?.skipMarketCheck) {
      const err = new Error(
        isQuoteEndpoint
          ? 'Market closed (Quotes/MultiQuotes/OptionChain/WebSocket calls paused 02:00-08:45 IST)'
          : 'Market closed (OpenAlgo calls paused 03:00-08:00 IST)'
      );
      err.code = 'MARKET_CLOSED';
      throw err;
    }
    const { host_url, api_key } = instance;
    const { isCritical = false, skipRateLimit = false } = options;

    if (!host_url || !api_key) {
      throw new OpenAlgoError('Instance host_url and api_key are required', endpoint);
    }

    const url = `${host_url}/api/v1/${endpoint}`;
    const payload = { ...data, apikey: api_key };
    const maskedPayload = { ...data, apikey: maskApiKey(api_key) };
    const instKey = this._instanceKey(instance);
    const timeoutOverride = this._getInstanceTimeoutMs(instance);
    this._persistMeta(instKey, instance);

    // Select retry configuration based on operation type
    const maxRetries = isCritical ? this.criticalRetries : this.nonCriticalRetries;
    const baseRetryDelay = isCritical ? this.criticalRetryDelay : this.nonCriticalRetryDelay;

    // Check if this is an order placement endpoint
    const isOrderPlacement = ['placeorder', 'placesmartorder'].includes(endpoint);

    // Store initial position for order placement requests
    // Track snapshot success separately from position value to enable dedup for new positions
    // Fast path (default): defer snapshot until a retry is needed to save ~300-500ms on first attempt
    let initialPosition = null;
    let initialPositionFetched = false;
    if (isOrderPlacement && !this.fastSnapshotMode) {
      try {
        initialPosition = await this._getPositionForOrder(instance, data);
        initialPositionFetched = true;
      } catch (error) {
        log.warn('Could not fetch initial position for order retry check', {
          endpoint,
          symbol: data.symbol,
          exchange: data.exchange,
          error: error.message,
        });
      }
    }

    log.debug('OpenAlgo API Request', {
      endpoint,
      url,
      payload: maskedPayload,
      isCritical,
      maxRetries,
      baseRetryDelay,
      instanceId: instance.id,
      instanceName: instance.name,
      exchange: data.exchange,
      symbol: data.symbol || data.underlying,
    });

    // Retry with exponential backoff
    let lastError;
    let attemptsUsed = 0;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        attemptsUsed = attempt + 1;
        const startTime = Date.now();
        if (!skipRateLimit) {
          await this._ensureLimits();
          this._ensureBackoffWindow(instKey, endpoint);
          await this._throttle(instance, endpoint, isOrderPlacement);
        }
        const response = skipRateLimit
          ? await this._makeRequest(url, method, payload, timeoutOverride)
          : await this._executeWithConcurrency(instance, endpoint, method, url, payload, isOrderPlacement, timeoutOverride);
        const duration = Date.now() - startTime;

        log.debug('OpenAlgo API Response', {
          endpoint,
          method,
          url,
          duration_ms: duration,
          instanceId: instance.id,
          instanceName: instance.name,
          success: true,
        });

        // Metrics hook: successful OpenAlgo request - debug-level since this fires on every
        // successful broker call (high volume); failures are still logged at warn/error below.
        log.debug('metrics.openalgo_request', {
          endpoint,
          instance_id: instance.id,
          instance_name: instance.name,
          is_critical: isCritical,
          attempts: attemptsUsed,
          duration_ms: duration,
          timeout_ms: timeoutOverride ?? this.timeout,
        });

        return response;
      } catch (error) {
        lastError = error;
        this._recordError(instKey, error, endpoint);

        // Don't retry on client errors (4xx) - these indicate bad requests.
        //
        // A 2xx carrying `status: "error"` is the same thing wearing different clothes: OpenAlgo
        // answers most rejections ("Invalid symbol", "Insufficient funds", analyzer-mode refusals)
        // with HTTP 200 and an error body, which _makeRequest turns into an OpenAlgoError whose
        // statusCode is 200. That fell below the 4xx test and was retried like a network blip -
        // identical request, identical rejection, two extra broker round-trips and two extra
        // position-check calls per order on the critical path.
        //
        // Rate limiting is the one broker-side rejection that IS worth retrying, since the next
        // attempt sits behind this client's own throttle and a backoff delay.
        const isTransientRejection = /rate limit|too many requests|try again/i.test(error.message || '');
        const isDeterministicRejection =
          (error.statusCode >= 400 && error.statusCode < 500) ||
          (error.statusCode < 400 && !isTransientRejection);

        if (isDeterministicRejection) {
          log.warn('OpenAlgo rejected the request - not retrying', {
            endpoint,
            statusCode: error.statusCode,
            isCritical,
            error: error.message,
            instanceId: instance.id,
            instanceName: instance.name,
          });
          throw error;
        }

        // Log 5xx server errors that will be retried
        if (error.statusCode >= 500) {
          const rawPreview = typeof error.rawBody === 'string' ? error.rawBody.slice(0, 200) : undefined;
          log.warn('OpenAlgo API Server Error (5xx) - will retry', {
            endpoint,
            statusCode: error.statusCode,
            attempt: attempt + 1,
            maxRetries,
            isCritical,
            error: error.message,
            isHtmlResponse: !!error.isHtmlResponse,
            isDnsError: !!error.isDnsError,
            responsePreview: rawPreview,
          });
        }

        // For order placement requests, check if order was actually placed before retrying
        // Snapshot is captured lazily on the first retry to avoid adding latency to attempt 0
        if (isOrderPlacement && attempt < maxRetries) {
          if (!initialPositionFetched) {
            try {
              initialPosition = await this._getPositionForOrder(instance, data);
              initialPositionFetched = true;
            } catch (error) {
              log.warn('Could not fetch initial position for order retry check', {
                endpoint,
                symbol: data.symbol,
                exchange: data.exchange,
                error: error.message,
              });
            }
          }

          if (initialPositionFetched) {
            try {
              const currentPosition = await this._getPositionForOrder(instance, data);

            // Check if position changed (order was likely placed)
            if (this._hasPositionChanged(initialPosition, currentPosition, data)) {
              // Use consistent field access for logging (handle both netqty and net_qty)
              const getNetQty = (pos) => pos?.netqty || pos?.net_qty || 0;

              // Fetch actual order ID from order book
              let actualOrderId = null;
              try {
                actualOrderId = await this._findOrderIdFromOrderBook(instance, data);
              } catch (orderIdError) {
                log.warn('Could not fetch actual order ID from order book', {
                  symbol: data.symbol,
                  error: orderIdError.message,
                });
              }

              // Only deduplicate if we successfully found the actual order ID
              // Otherwise, continue with normal retry logic to avoid breaking downstream workflows
              if (actualOrderId) {
                log.info('Order appears to have been placed despite error - skipping retry', {
                  endpoint,
                  symbol: data.symbol,
                  exchange: data.exchange,
                  initialQty: getNetQty(initialPosition),
                  currentQty: getNetQty(currentPosition),
                  expectedChange: data.quantity || 0,
                  action: data.action,
                  foundOrderId: actualOrderId,
                });

                // Return success response with actual order ID
                return {
                  status: 'success',
                  orderid: actualOrderId,
                  message: 'Order placed successfully (verified via position check)',
                };
              } else {
                // Position changed but couldn't find order ID - log and continue with retry
                log.warn('Position changed but order ID not found in order book - continuing with retry', {
                  endpoint,
                  symbol: data.symbol,
                  exchange: data.exchange,
                  initialQty: getNetQty(initialPosition),
                  currentQty: getNetQty(currentPosition),
                  expectedChange: data.quantity || 0,
                  action: data.action,
                });
              }
            }
          } catch (posCheckError) {
            log.warn('Position check failed during retry, proceeding with retry', {
              endpoint,
              error: posCheckError.message,
            });
          }
        }
        }

        // Log retry attempt
        if (attempt < maxRetries) {
          const delay = baseRetryDelay * Math.pow(2, attempt);
          log.warn('OpenAlgo request failed, retrying', {
            endpoint,
            attempt: attempt + 1,
            maxRetries,
            delay,
            isCritical,
            error: error.message,
          });

          await this._sleep(delay);
        }
      }
    }

    // All retries failed
    log.error('OpenAlgo request failed after retries', lastError, {
      endpoint,
      maxRetries,
      isCritical,
      statusCode: lastError?.statusCode,
      error: lastError?.message,
      isHtmlResponse: !!lastError?.isHtmlResponse,
      isDnsError: !!lastError?.isDnsError,
    });

    throw lastError;
  }

  async _executeWithConcurrency(instance, endpoint, method, url, payload, isOrderPlacement, timeoutOverride = null) {
    const instKey = this._instanceKey(instance);
    await this._waitForConcurrency(instKey, endpoint, isOrderPlacement);

    // Record timestamps for rate tracking
    const now = Date.now();
    const state = this._getRateState(instKey);
    state.rps.push(now);
    state.rpm.push(now);
    this.globalRpm.push(now);
    if (isOrderPlacement) {
      state.orders.push(now);
      this.globalOrders.push(now);
    }

    try {
      return await this._makeRequest(url, method, payload, timeoutOverride);
    } finally {
      this.currentTasks = Math.max(0, this.currentTasks - 1);
    }
  }

  async _waitForConcurrency(instKey, endpoint, isOrderPlacement = false) {
    const delay = 50;
    let waited = 0;
    let logged = false;
    while (this.currentTasks >= this.maxConcurrentTasks) {
      // Log once per wait (not once per 50ms poll iteration) to avoid flooding the log when
      // the global concurrency pool is briefly saturated - a common, often benign occurrence.
      if (!logged) {
        log.warn('Throttling due to concurrent task limit', {
          endpoint,
          instKey,
          currentTasks: this.currentTasks,
        });
        logged = true;
      }
      await sleep(delay);
      waited += delay;
      if (waited % 2000 === 0) {
        log.warn('Still throttled by concurrent task limit', {
          endpoint, instKey, currentTasks: this.currentTasks, waitedMs: waited,
        });
      }
    }
    this.currentTasks += 1;

    // Token bucket by endpoint class
    const bucketKind = this._bucketKindForEndpoint(endpoint, isOrderPlacement);
    if (bucketKind) {
      const bucket = this._getBucket(instKey, bucketKind);
      let retries = 0;
      while (!this._allowBucket(bucket)) {
        await sleep(25);
        retries += 1;
        if (retries > 100) {
          const error = new OpenAlgoError(`Rate bucket throttle for ${bucketKind}`, endpoint);
          error.statusCode = 429;
          throw error;
        }
      }
    }
  }

  _bucketKindForEndpoint(endpoint, isOrderPlacement) {
    const ep = (endpoint || '').toLowerCase();
    if (isOrderPlacement || ep.includes('order')) return 'orders';
    if (ep.includes('position') || ep.includes('fund') || ep.includes('tradebook') || ep.includes('orderbook')) return 'critical';
    if (ep.includes('rest_quotes')) return 'rest_quotes';
    return 'background';
  }

  _getRateState(instKey) {
    if (!this.instanceRate.has(instKey)) {
      this.instanceRate.set(instKey, { rps: [], rpm: [], orders: [] });
    }
    return this.instanceRate.get(instKey);
  }

  _getErrorState(instKey) {
    const now = Date.now();
    if (!this.errorCounters.has(instKey)) {
      this.errorCounters.set(instKey, {
        resetAt: now,
        count404: 0,
        countInvalid: 0,
        backoffUntil: null,
      });
    }
    const state = this.errorCounters.get(instKey);
    // Reset counters every 30 minutes (instead of daily)
    if (now - state.resetAt >= ERROR_LIMITS.resetIntervalMs) {
      state.resetAt = now;
      state.count404 = 0;
      state.countInvalid = 0;
      // Don't reset backoffUntil - let it expire naturally
    }
    return state;
  }

  _persistMeta(instKey, instance) {
    this.instanceMeta.set(instKey, {
      id: instance.id || instance.instance_id,
      host_url: instance.host_url,
      name: instance.name,
    });
  }

  _instanceKey(instance) {
    return instance.id || instance.instance_id || instance.host_url || instance.name || 'unknown';
  }

  _prune(list, windowMs, now) {
    while (list.length && now - list[0] >= windowMs) {
      list.shift();
    }
  }

  _getBucket(instKey, kind) {
    if (!this.endpointBuckets.has(instKey)) {
      this.endpointBuckets.set(instKey, {
        orders: this._makeBucket(this.ordersPerSecondLimit, 1000),
        critical: this._makeBucket(this.rpsLimitPerInstance, 1000),
        background: this._makeBucket(Math.max(1, Math.floor(this.rpsLimitPerInstance / 2)), 1000),
        rest_quotes: this._makeBucket(Math.max(1, Math.floor(this.rpsLimitPerInstance / 4)), 1000),
      });
    }
    const buckets = this.endpointBuckets.get(instKey);
    return buckets[kind];
  }

  _makeBucket(cap, windowMs) {
    return { cap, windowMs, timestamps: [] };
  }

  _allowBucket(bucket) {
    const now = Date.now();
    this._prune(bucket.timestamps, bucket.windowMs, now);
    if (bucket.timestamps.length >= bucket.cap) return false;
    bucket.timestamps.push(now);
    return true;
  }

  _loadInstanceTimeoutOverrides() {
    try {
      const raw = process.env.OPENALGO_INSTANCE_TIMEOUT_MS_MAP;
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      log.warn('Failed to parse OPENALGO_INSTANCE_TIMEOUT_MS_MAP, ignoring', { error: err.message });
      return {};
    }
  }

  _getInstanceTimeoutMs(instance) {
    if (!instance) return null;
    const map = this.instanceTimeoutOverrides || {};
    const byId = map[String(instance.id)];
    if (byId) return byId;
    const byName = instance.name ? map[String(instance.name)] : null;
    return byName || null;
  }

  async _throttle(instance, endpoint, isOrderPlacement) {
    // Skip throttling if rate limits are disabled
    if (this.rateLimitsDisabled) {
      return;
    }

    const instKey = this._instanceKey(instance);
    const state = this._getRateState(instKey);
    let waitedOnce = false;

    // placesmartorder is capped at 2/sec by OpenAlgo, plain placeorder at 10/sec - a single
    // shared limit here was applying the lenient figure to what is, in every call site this app
    // has, exclusively smart-order traffic. Both endpoints still share one sliding window (the
    // broker enforces its cap per API key, not per endpoint-shape), so this only needs to pick
    // the RIGHT threshold for that window rather than tracking the endpoints separately.
    const ordersLimit = (endpoint || '').toLowerCase() === 'placesmartorder'
      ? this.smartOrdersPerSecondLimit
      : this.ordersPerSecondLimit;

    for (;;) {
      const now = Date.now();
      this._prune(state.rps, 1000, now);
      this._prune(state.rpm, 60000, now);
      this._prune(state.orders, 1000, now);
      this._prune(this.globalRpm, 60000, now);
      this._prune(this.globalOrders, 1000, now);

      const instRps = state.rps.length;
      const instRpm = state.rpm.length;
      const globalRpm = this.globalRpm.length;
      const instOrders = state.orders.length;
      const globalOrders = this.globalOrders.length;

      const rpsOver = instRps >= this.rpsLimitPerInstance;
      const rpmOver = instRpm >= this.rpmLimitPerInstance;
      const ordersOver = isOrderPlacement && (instOrders >= ordersLimit || globalOrders >= ordersLimit);

      if (!rpsOver && !rpmOver && !ordersOver) {
        return;
      }

      const nextExpiry = Math.min(
        rpsOver && state.rps[0] ? state.rps[0] + 1000 - now : Infinity,
        rpmOver && state.rpm[0] ? state.rpm[0] + 60000 - now : Infinity,
        ordersOver && state.orders[0] ? state.orders[0] + 1000 - now : Infinity,
        ordersOver && this.globalOrders[0] ? this.globalOrders[0] + 1000 - now : Infinity,
      );
      const waitFor = Math.max(25, isFinite(nextExpiry) ? nextExpiry : 50);

      if (!waitedOnce) {
        log.warn('Rate throttle applied', {
          endpoint,
          instKey,
          instRps,
          instRpm,
          globalRpm,
          instOrders,
          globalOrders,
          ordersLimit,
          waitFor,
        });
        waitedOnce = true;
      }

      await sleep(waitFor);
    }
  }

  _ensureBackoffWindow(instKey, endpoint) {
    // Skip backoff check if circuit breaker is disabled
    if (this.circuitBreakerDisabled) {
      return;
    }

    const errState = this._getErrorState(instKey);
    if (errState.backoffUntil && Date.now() < errState.backoffUntil) {
      const waitMs = errState.backoffUntil - Date.now();
      const message = `Instance ${instKey} is in backoff for ${Math.ceil(waitMs / 1000)}s due to error limits`;
      const error = new OpenAlgoError(message, endpoint);
      error.statusCode = 429;
      throw error;
    }
  }

  _recordError(instKey, error, endpoint) {
    const errState = this._getErrorState(instKey);
    const status = error.statusCode;
    const message = error.message ? error.message.toLowerCase() : '';
    const is404 = status === 404;
    const isInvalid = status === 401 || status === 403 || message.includes('invalid apikey');

    if (!is404 && !isInvalid) {
      return;
    }

    if (is404) {
      errState.count404 += 1;
    }
    if (isInvalid) {
      errState.countInvalid += 1;
    }

    const warnNearLimit =
      errState.count404 >= ERROR_LIMITS.max404PerDay - 2 ||
      errState.countInvalid >= ERROR_LIMITS.maxInvalidApiPerDay - 1;

    if (warnNearLimit) {
      log.warn('Approaching OpenAlgo error thresholds', {
        instKey,
        endpoint,
        count404: errState.count404,
        countInvalid: errState.countInvalid,
      });
    }

    const exceeded =
      errState.count404 >= ERROR_LIMITS.max404PerDay ||
      errState.countInvalid >= ERROR_LIMITS.maxInvalidApiPerDay;

    if (exceeded) {
      errState.backoffUntil = Date.now() + ERROR_LIMITS.backoffMs;
      log.error('Error limits exceeded, entering backoff', {
        instKey,
        endpoint,
        backoffUntil: toISTISOString(errState.backoffUntil),
        count404: errState.count404,
        countInvalid: errState.countInvalid,
      });
    }
  }

  getInstanceMetrics() {
    const metrics = [];
    for (const [instKey, rate] of this.instanceRate.entries()) {
      const err = this._getErrorState(instKey);
      const meta = this.instanceMeta.get(instKey) || {};
      metrics.push({
        key: instKey,
        id: meta.id,
        host_url: meta.host_url,
        name: meta.name,
        rate: {
          rps: rate.rps.length,
          rpm: rate.rpm.length,
          orders: rate.orders.length,
          globalRpm: this.globalRpm.length,
          globalOrders: this.globalOrders.length,
        },
        errors: {
          count404: err.count404,
          countInvalid: err.countInvalid,
          backoffUntil: err.backoffUntil,
        },
      });
    }
    return metrics;
  }

  getRateBudgets() {
    const budgets = [];
    for (const [instKey, rate] of this.instanceRate.entries()) {
      const meta = this.instanceMeta.get(instKey) || {};
      const rpsLimit = this.rpsLimitPerInstance;
      const rpmLimit = this.rpmLimitPerInstance;
      // Every order this app places goes through placesmartorder, so the SMART limit is what
      // actually governs the shared `orders` window in practice, even though a future direct
      // placeorder call would be allowed the more lenient figure. Reporting the plain limit
      // here would tell an operator they have 5x the order throughput they actually do.
      const ordersLimit = this.smartOrdersPerSecondLimit;

      budgets.push({
        key: instKey,
        id: meta.id,
        host_url: meta.host_url,
        name: meta.name,
        limits: {
          rps: rpsLimit,
          rpm: rpmLimit,
          ordersPerSecond: ordersLimit,
          ordersPerSecondPlain: this.ordersPerSecondLimit,
          maxConcurrent: this.maxConcurrentTasks,
        },
        usage: {
          rpsUsed: rate.rps.length,
          rpmUsed: rate.rpm.length,
          ordersUsed: rate.orders.length,
          currentConcurrent: this.currentTasks,
        },
        remaining: {
          rps: Math.max(0, rpsLimit - rate.rps.length),
          rpm: Math.max(0, rpmLimit - rate.rpm.length),
          orders: Math.max(0, ordersLimit - rate.orders.length),
          concurrentSlots: Math.max(0, this.maxConcurrentTasks - this.currentTasks),
        },
      });
    }
    return budgets;
  }

  async _ensureLimits() {
    // Rate limits are now loaded once at startup via initializeRateLimits()
    // and refreshed only on settings change via reloadRateLimits()
    // This removes database queries from the hot path
    if (!this.limitsCache.initialized) {
      await this.initializeRateLimits();
    }
    // Periodic refresh as fallback (every 10 minutes)
    const now = Date.now();
    if (now - this.limitsCache.loadedAt > this.limitsCache.ttl) {
      // Background refresh - don't block the request
      this._loadRateLimitSettings().catch(err => {
        log.warn('Background rate limit refresh failed', { error: err.message });
      });
    }
  }

  /**
   * Make HTTP request with timeout
   * @private
   */
  async _makeRequest(url, method, payload, timeoutOverride = null) {
    const controller = new AbortController();
    const effectiveTimeout = timeoutOverride ?? this.timeout;
    const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);

    try {
      const fetchOptions = {
        method,
        headers: {
          'Content-Type': 'application/json',
        },
        body: method === 'GET' ? undefined : JSON.stringify(payload),
        signal: controller.signal,
      };

      // Use proxy dispatcher if configured
      if (this.dispatcher) {
        fetchOptions.dispatcher = this.dispatcher;
      }

      const response = await fetch(url, fetchOptions);

      clearTimeout(timeoutId);

      // Clone response so we can read it twice if JSON parsing fails
      const responseClone = response.clone();

      // Parse response
      let responseData;
      try {
        responseData = await response.json();
      } catch (error) {
        let responseText;
        try {
          responseText = await responseClone.text();
        } catch (textError) {
          responseText = 'Unable to read response body';
        }

        const contentType = response.headers.get('content-type') || '';
        const trimmed = responseText.trim();
        const looksHtml =
          contentType.includes('text/html') ||
          trimmed.startsWith('<!DOCTYPE html') ||
          trimmed.startsWith('<html');

        const details = {
          status_code: response.status,
          content_type: contentType,
          is_html: looksHtml,
          body_preview: trimmed.substring(0, 200),
        };
        const jsonError = new OpenAlgoError(
          `Invalid JSON response: ${responseText.substring(0, 200)}`,
          url,
          response.status,
          details
        );
        jsonError.statusCode = response.status;

        if (looksHtml) {
          jsonError.isHtmlResponse = true;
          jsonError.rawBody = trimmed.substring(0, 500);
        }

        throw jsonError;
      }

      // Check if request was successful
      if (!response.ok) {
        const details = {
          status_code: response.status,
          response_status: responseData?.status,
          response_message: responseData?.message,
        };
        throw new OpenAlgoError(
          responseData.message || `HTTP ${response.status}: ${response.statusText}`,
          url,
          response.status,
          details
        );
      }

      // Check OpenAlgo response status
      if (responseData.status === 'error') {
        const details = {
          response_status: responseData?.status,
          response_message: responseData?.message,
        };
        throw new OpenAlgoError(
          responseData.message || 'OpenAlgo API returned error status',
          url,
          response.status,
          details
        );
      }

      return responseData;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error.name === 'AbortError') {
        throw new OpenAlgoError(
          `Request timeout after ${effectiveTimeout}ms`,
          url,
          504,
          { timeout_ms: effectiveTimeout }
        );
      }

      if (error instanceof OpenAlgoError) {
        throw error;
      }

      // Check for DNS resolution errors (getaddrinfo ENOTFOUND, etc.)
      const errorMessage = error.message || '';
      const isDnsError = errorMessage.includes('getaddrinfo') ||
                         errorMessage.includes('ENOTFOUND') ||
                         errorMessage.includes('EAI_AGAIN') ||
                         errorMessage.includes('ECONNREFUSED') ||
                         errorMessage.includes('ENETUNREACH') ||
                         errorMessage.includes('EHOSTUNREACH');

      const networkError = new OpenAlgoError(
        `Network error: ${error.message}`,
        url,
        502,
        { network_error: error.message }
      );

      // Mark DNS errors so circuit breaker can handle them appropriately
      if (isDnsError) {
        networkError.isDnsError = true;
      }

      throw networkError;
    }
  }

  /**
   * Sleep for specified milliseconds
   * @private
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ==========================================
  // Account APIs
  // ==========================================

  /**
   * Test connection to OpenAlgo instance
   * @param {Object} instance - Instance configuration
   * @returns {Promise<Object>} - { broker, message }
   */
  async ping(instance) {
    const response = await this.request(instance, 'ping');
    return response.data;
  }

  /**
   * Get analyzer mode status
   * @param {Object} instance - Instance configuration
   * @returns {Promise<Object>} - { mode, analyze_mode, total_logs }
   */
  async getAnalyzerStatus(instance) {
    const response = await this.request(instance, 'analyzer');
    return response.data;
  }

  /**
   * Toggle analyzer mode
   * @param {Object} instance - Instance configuration
   * @param {boolean} mode - true for analyze, false for live
   * @returns {Promise<Object>} - Updated analyzer status
   */
  async toggleAnalyzer(instance, mode) {
    const response = await this.request(instance, 'analyzer/toggle', { mode });
    return response.data;
  }

  /**
   * Get account funds
   * @param {Object} instance - Instance configuration
   * @returns {Promise<Object>} - Fund details
   */
  async getFunds(instance) {
    const response = await this.request(instance, 'funds');
    return response.data;
  }

  /**
   * Get holdings
   * @param {Object} instance - Instance configuration
   * @returns {Promise<Array>} - Holdings list
   */
  async getHoldings(instance) {
    const response = await this.request(instance, 'holdings');
    return response.data?.holdings || [];
  }

  // ==========================================
  // Order APIs
  // ==========================================

  /**
   * Get order book
   * @param {Object} instance - Instance configuration
   * @returns {Promise<Object>} - { orders, statistics }
   */
  async getOrderBook(instance) {
    const response = await this.request(instance, 'orderbook');
    // OpenAlgo returns either a bare array or { orders: [...] } depending on broker and version.
    // Normalize here so callers get one shape. Every caller but one already re-implemented this
    // (order-placement.service.js, market-data-feed.service.js, the order-id lookup below);
    // order.service.syncOrderStatus did not, and its `orderbook.find(...)` threw
    // "orderbook.find is not a function" on every poll, leaving order status unreconciled.
    const data = response.data;
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.orders)) return data.orders;
    if (Array.isArray(data?.data)) return data.data;
    return [];
  }

  /**
   * Place smart order (position-aware)
   * @param {Object} instance - Instance configuration
   * @param {Object} orderData - Order parameters
   * @returns {Promise<Object>} - { orderid }
   */
  async placeSmartOrder(instance, orderData, options = {}) {
    const response = await this.request(instance, 'placesmartorder', orderData, 'POST', {
      isCritical: true,
      ...options,
    });
    return {
      orderid: response.orderid || response.data?.orderid,
      status: response.status,
    };
  }

  /**
   * Cancel order
   * @param {Object} instance - Instance configuration
   * @param {string} orderid - Order ID to cancel
   * @param {string} strategy - Strategy tag
   * @returns {Promise<Object>} - { orderid, status }
   */
  async cancelOrder(instance, orderid, strategy) {
    const response = await this.request(instance, 'cancelorder', {
      orderid,
      strategy,
    }, 'POST', { isCritical: true });
    return {
      orderid: response.orderid || response.data?.orderid,
      status: response.status,
    };
  }

  /**
   * Cancel all orders
   * @param {Object} instance - Instance configuration
   * @param {string} strategy - Strategy tag
   * @returns {Promise<Object>} - { canceled_orders, failed_cancellations }
   */
  async cancelAllOrders(instance, strategy) {
    const response = await this.request(instance, 'cancelallorder', {
      strategy,
    }, 'POST', { isCritical: true });
    return response.data || response;
  }

  // ==========================================
  // Position APIs
  // ==========================================

  /**
   * Get position book
   * @param {Object} instance - Instance configuration
   * @returns {Promise<Array>} - Positions list
   */
  async getPositionBook(instance) {
    const response = await this.request(instance, 'positionbook');
    return response.data || [];
  }

  /**
   * Close all positions
   * @param {Object} instance - Instance configuration
   * @param {string} strategy - Strategy tag
   * @returns {Promise<Object>} - Result
   */
  async closePosition(instance, strategy) {
    const response = await this.request(instance, 'closeposition', {
      strategy,
    }, 'POST', { isCritical: true });
    return response.data || response;
  }

  /**
   * Get open position for specific symbol
   * @param {Object} instance - Instance configuration
   * @param {string} symbol - Trading symbol
   * @param {string} exchange - Exchange code
   * @param {string} product - Product type
   * @param {string} strategy - Strategy tag
   * @returns {Promise<Object>} - { quantity }
   */
  async getOpenPosition(instance, symbol, exchange, product, strategy) {
    const response = await this.request(instance, 'openposition', {
      symbol,
      exchange,
      product,
      strategy,
    });
    return response;
  }

  // ==========================================
  // Trade APIs
  // ==========================================

  /**
   * Get trade book
   * @param {Object} instance - Instance configuration
   * @returns {Promise<Array>} - Trades list
   */
  async getTradeBook(instance) {
    const response = await this.request(instance, 'tradebook');
    return response.data || [];
  }

  // ==========================================
  // Market Data APIs
  // ==========================================

  /**
   * Get quotes for symbols with HTTP/2 multiplexing
   * @param {Object} instance - Instance configuration
   * @param {Array<Object>} symbols - Array of {exchange, symbol}
   * @param {Object} options - Options
   * @param {boolean} options.returnErrors - Return error info for failed quotes (for fallback handling)
   * @returns {Promise<Object>} - { quotes: [], failed: [] }
   */
  async getQuotes(instance, symbols, options = {}) {
    const { returnErrors = false } = options;
    const instanceMeta = {
      instance_id: instance?.id || instance?.instance_id,
      instance_name: instance?.name,
    };

    // OpenAlgo quotes API expects one symbol at a time
    // HTTP/2 multiplexing allows these to share a single TCP connection
    // This dramatically reduces latency compared to sequential requests
    const quotePromises = symbols.map(async ({ exchange, symbol }) => {
      const failureKey = `${instanceMeta.instance_id}|${exchange}|${symbol}`;
      const failureState = this._quoteFailureCache.get(failureKey);
      if (
        failureState &&
        failureState.count >= this.QUOTE_FAILURE_THRESHOLD &&
        Date.now() - failureState.lastFailAt < this.QUOTE_FAILURE_COOLDOWN_MS
      ) {
        return {
          success: false,
          exchange,
          symbol,
          error: 'Skipped: symbol in quote-failure cooldown after repeated errors',
          errorCode: 'COOLDOWN',
          fetchedAt: Date.now(),
        };
      }

      try {
        const response = await this.request(
          instance,
          'quotes',
          { exchange, symbol },
          'POST',
          { skipRateLimit: true }
        );

        if (failureState) {
          this._quoteFailureCache.delete(failureKey);
        }

        // Return quote data with exchange and symbol for matching
        return {
          success: true,
          exchange,
          symbol,
          ...response.data,
          fetchedAt: Date.now(),
        };
      } catch (error) {
        const nextCount = (failureState?.count || 0) + 1;
        this._quoteFailureCache.set(failureKey, { count: nextCount, lastFailAt: Date.now() });
        if (nextCount === this.QUOTE_FAILURE_THRESHOLD) {
          log.warn('Quote fetch entering cooldown after repeated failures', {
            exchange, symbol, count: nextCount, cooldownMs: this.QUOTE_FAILURE_COOLDOWN_MS, ...instanceMeta,
          });
        }
        log.warn('Failed to fetch quote', { exchange, symbol, error: error.message, ...instanceMeta });
        return {
          success: false,
          exchange,
          symbol,
          error: error.message,
          errorCode: error.statusCode || 'UNKNOWN',
          fetchedAt: Date.now(),
        };
      }
    });

    const results = await Promise.all(quotePromises);

    // Separate successful and failed quotes
    const quotes = results.filter(r => r.success).map(r => {
      const { success: _success, ...quote } = r;
      return quote;
    });
    const failed = results.filter(r => !r.success);

    // For backward compatibility, return just quotes array if not requesting errors
    if (!returnErrors) {
      return quotes;
    }

    return { quotes, failed };
  }

  /**
   * Convenience: single quote fetch (wraps getQuotes)
   * @param {Object} instance
   * @param {String} symbol
   * @param {String} exchange
   * @param {Object} options
   * @returns {Promise<Object|{quotes:[],failed:[]}>}
   */
  async getQuote(instance, symbol, exchange, options = {}) {
    const res = await this.getQuotes(instance, [{ symbol, exchange }], options);
    // If returnErrors was requested, bubble up the richer payload
    if (options?.returnErrors) return res;
    return Array.isArray(res) ? res[0] : null;
  }

  /**
   * Fetch quotes for multiple symbols in a single request
   * @param {Object} instance - Instance configuration
   * @param {Array<Object>} symbols - Array of {exchange, symbol}
   * @param {Object} options - Options
   * @param {boolean} options.returnErrors - Return failed symbols
   * @returns {Promise<Array|Object>} - Quotes array or { quotes, failed }
   */
  async getMultiQuotes(instance, symbols = [], options = {}) {
    const { returnErrors = false } = options;
    const payloadSymbols = Array.isArray(symbols)
      ? symbols
        .map((entry) => ({
          symbol: entry?.symbol,
          exchange: entry?.exchange,
        }))
        .filter((entry) => entry.symbol && entry.exchange)
      : [];

    if (payloadSymbols.length === 0) {
      return returnErrors ? { quotes: [], failed: [] } : [];
    }

    const response = await this.request(
      instance,
      'multiquotes',
      { symbols: payloadSymbols },
      'POST',
      { skipRateLimit: true }
    );

    const now = Date.now();
    const results = Array.isArray(response.results) ? response.results : [];
    const quotes = [];
    const failed = [];

    for (const entry of results) {
      const symbol = entry?.symbol;
      const exchange = entry?.exchange;
      const data = entry?.data;
      const hasData = data && typeof data === 'object' && Object.keys(data).length > 0;
      if (symbol && exchange && hasData) {
        quotes.push({
          symbol,
          exchange,
          ...data,
          fetchedAt: now,
        });
      } else {
        failed.push({
          symbol,
          exchange,
          error: entry?.error || 'No quote data',
        });
      }
    }

    if (returnErrors) {
      return { quotes, failed };
    }
    return quotes;
  }

  /**
   * Get quotes with automatic fallback to alternate instances on failure
   * @param {Array<Object>} instances - Pool of instances to try
   * @param {Array<Object>} symbols - Array of {exchange, symbol}
   * @param {Object} options - Options
   * @param {number} options.maxRetries - Max retry attempts per symbol (default: 2)
   * @returns {Promise<Array>} - Quotes list with source instance info
   */
  async getQuotesWithFallback(instances, symbols, options = {}) {
    const { maxRetries = 2 } = options;

    if (!instances || instances.length === 0) {
      log.warn('No instances available for quote fallback');
      return [];
    }

    // First attempt: distribute symbols across instances
    const primaryInstance = instances[0];
    const { quotes, failed } = await this.getQuotes(primaryInstance, symbols, { returnErrors: true });

    // Add source instance info
    quotes.forEach(q => {
      q.sourceInstance = primaryInstance.id;
      q.sourceInstanceName = primaryInstance.name;
    });

    if (failed.length === 0) {
      return quotes;
    }

    // Early exit: No point retrying on same instance if we only have one
    if (instances.length === 1) {
      log.warn('Single instance fallback - no alternate instances available for retry', {
        failedCount: failed.length,
        symbols: failed.map(f => `${f.exchange}:${f.symbol}`),
      });
      return quotes;
    }

    // Retry failed quotes on alternate instances
    // Use separate counters: actualAttempts for real retries, instanceIndex for instance selection
    let pendingSymbols = failed.map(f => ({ exchange: f.exchange, symbol: f.symbol }));
    const finalQuotes = [...quotes];
    // Track tried instances by array index to avoid issues with undefined/duplicate instance.id values
    // Using index ensures uniqueness even if instance.id is undefined or shared across instances
    const triedInstanceIndices = new Set([0]); // Track indices of instances we've tried (primary is index 0)

    let actualAttempts = 0;
    let instanceIndex = 1; // Start from second instance

    while (actualAttempts < maxRetries && pendingSymbols.length > 0) {
      // Check if we've exhausted all instances
      if (triedInstanceIndices.size >= instances.length) {
        log.debug('All instances exhausted for quote fallback', {
          triedCount: triedInstanceIndices.size,
          remainingFailures: pendingSymbols.length,
          actualAttempts,
        });
        break;
      }

      // Get next instance index (wrap around using modulo)
      const currentIndex = instanceIndex % instances.length;
      const retryInstance = instances[currentIndex];
      instanceIndex++;

      // Skip if we've already tried this instance (use array index for reliable tracking)
      if (triedInstanceIndices.has(currentIndex)) {
        continue; // Don't count as an attempt, just move to next instance
      }

      triedInstanceIndices.add(currentIndex);
      actualAttempts++; // Count this as an actual retry attempt

      log.debug('Retrying failed quotes on alternate instance', {
        attempt: actualAttempts,
        instance: retryInstance.name,
        symbolCount: pendingSymbols.length,
      });

      const { quotes: retryQuotes, failed: retryFailed } = await this.getQuotes(
        retryInstance,
        pendingSymbols,
        { returnErrors: true }
      );

      // Add successful retries
      retryQuotes.forEach(q => {
        q.sourceInstance = retryInstance.id;
        q.sourceInstanceName = retryInstance.name;
        q.retryAttempt = actualAttempts;
      });
      finalQuotes.push(...retryQuotes);

      // Update pending list
      pendingSymbols = retryFailed.map(f => ({ exchange: f.exchange, symbol: f.symbol }));
    }

    // Log final failed quotes
    if (pendingSymbols.length > 0) {
      log.warn('Some quotes failed after all retries', {
        failedCount: pendingSymbols.length,
        symbols: pendingSymbols.map(s => `${s.exchange}:${s.symbol}`),
        instancesTried: triedInstanceIndices.size,
      });
    }

    return finalQuotes;
  }

  /**
   * Get LTP (Last Traded Price) with aggressive retry logic
   * Critical for order placement and derivatives resolution
   *
   * Strategy: Try different instances FIRST before retrying same instance
   * This improves reliability when one instance has stale/invalid data
   * ALWAYS makes at least one attempt even if all instances are unhealthy
   *
   * @param {Object|Array} instanceOrPool - Single instance or pool of instances
   * @param {string} exchange - Exchange code
   * @param {string} symbol - Trading symbol
   * @param {Object} options - Options
   * @param {number} options.maxRounds - Max retry rounds across all instances (default: 2)
   * @param {number} options.baseDelayMs - Base delay for exponential backoff (default: 50ms)
   * @returns {Promise<Object>} - { ltp: number, quote: Object, source: string, attempts: number }
   */
  async getLtpWithRetry(instanceOrPool, exchange, symbol, options = {}) {
    const {
      maxRounds = 2,      // Number of complete rounds through all instances
      baseDelayMs = 50,
    } = options;

    const instances = Array.isArray(instanceOrPool) ? instanceOrPool : [instanceOrPool];
    if (instances.length === 0) {
      throw new Error('No instances provided for LTP fetch');
    }

    let lastError = null;
    let totalAttempts = 0;
    let totalSkipped = 0;
    const failedInstances = new Map(); // Track failure count per instance

    // Strategy: Rotate through instances, checking health at each round
    // This respects cooldowns that occur mid-retry
    for (let round = 0; round < maxRounds; round++) {
      // Add delay between rounds (not on first round)
      if (round > 0) {
        const delay = baseDelayMs * Math.pow(2, round - 1);
        log.debug('Waiting before retry round', { round: round + 1, delayMs: delay });
        await this._sleep(delay);
      }

      // Re-check health at start of each round to respect new cooldowns
      const healthyThisRound = instances.filter(i => this.isInstanceHealthy(i.id));
      const skippedThisRound = instances.length - healthyThisRound.length;
      totalSkipped += skippedThisRound;

      // CRITICAL FIX: If all instances are unhealthy, check for manual refresh requirement
      // Don't force attempts on instances that require manual intervention
      let instancesToTry = healthyThisRound;
      if (healthyThisRound.length === 0) {
        if (round === 0) {
          // Find first instance that doesn't require manual refresh
          const firstAvailableInstance = instances.find(inst =>
            !this.instanceRequiresManualRefresh(inst.id)
          );

          if (firstAvailableInstance) {
            // Only force on first round if instance doesn't require manual refresh
            instancesToTry = [firstAvailableInstance];
            log.warn('All instances unhealthy for LTP fetch, forcing attempt on first available instance', {
              exchange,
              symbol,
              round: round + 1,
              totalInstances: instances.length,
              forcedInstance: firstAvailableInstance.name,
            });
          } else {
            // All instances require manual refresh - cannot proceed
            log.error('All instances require manual refresh - cannot fetch LTP', {
              exchange,
              symbol,
              totalInstances: instances.length,
            });
            totalSkipped += instances.length;
            continue;
          }
        } else {
          // On subsequent rounds, skip if all unhealthy (already tried)
          log.debug('All instances still unhealthy, skipping round', {
            round: round + 1,
            totalInstances: instances.length,
          });
          totalSkipped += instances.length;
          continue;
        }
      }

      // Try each healthy instance in this round
      for (let instIndex = 0; instIndex < instancesToTry.length; instIndex++) {
        const instance = instancesToTry[instIndex];
        totalAttempts++;

        try {
          log.debug('Fetching LTP', {
            instance: instance.name,
            exchange,
            symbol,
            round: round + 1,
            instanceIndex: instIndex + 1,
            totalAttempts,
          });

          const response = await this.request(
            instance,
            'quotes',
            { exchange, symbol },
            'POST',
            { skipRateLimit: true } // LTP is critical, skip rate limit
          );

          const quote = response.data || {};
          const ltp = this._extractLtp(quote);

          // Validate LTP - must be a positive number
          if (ltp === null || ltp <= 0) {
            log.warn('Invalid LTP received, trying next instance', {
              instance: instance.name,
              exchange,
              symbol,
              round: round + 1,
              ltp,
              remainingInstances: instances.length - instIndex - 1,
            });
            lastError = new Error(`Invalid LTP value: ${ltp}`);
            failedInstances.set(instance.id, (failedInstances.get(instance.id) || 0) + 1);
            // Record failure but don't immediately put in cooldown for invalid LTP
            // This allows retry on next round
            continue; // Try next instance immediately
          }

          // Success! Reset instance health
          this.resetInstanceHealth(instance.id);

          log.debug('LTP fetched successfully', {
            instance: instance.name,
            exchange,
            symbol,
            ltp,
            totalAttempts,
            round: round + 1,
          });

          return {
            ltp,
            quote: { ...quote, exchange, symbol, fetchedAt: Date.now() },
            source: `${instance.name}`,
            attempts: totalAttempts,
            instanceId: instance.id,
            instanceName: instance.name,
            round: round + 1,
          };
        } catch (error) {
          lastError = error;
          failedInstances.set(instance.id, (failedInstances.get(instance.id) || 0) + 1);

          // Check if this is an HTML response (instance likely down)
          const isHtml = error.isHtmlResponse === true ||
                        (error.message && error.message.includes('Invalid JSON response'));

          // Check if this is a DNS/network connectivity error
          const isDnsError = error.isDnsError === true ||
                            (error.message && (
                              error.message.includes('getaddrinfo') ||
                              error.message.includes('ENOTFOUND') ||
                              error.message.includes('ECONNREFUSED')
                            ));

          // Record failure with circuit breaker
          this.recordInstanceFailure(instance.id, error, { isHtml, isDnsError });

          log.warn('LTP fetch failed, trying next instance', {
            instance: instance.name,
            exchange,
            symbol,
            round: round + 1,
            error: error.message,
            isHtml,
            isDnsError,
            remainingInstances: instances.length - instIndex - 1,
          });
          // Continue to next instance immediately (no delay within same round)
        }
      }

      // Log end of round
      log.debug('Completed LTP fetch round', {
        round: round + 1,
        maxRounds,
        totalAttempts,
        willRetry: round < maxRounds - 1,
      });
    }

    // All retries exhausted
    const errorMessage = `Failed to get valid LTP for ${exchange}:${symbol} after ${totalAttempts} attempts across ${maxRounds} rounds: ${lastError?.message || 'Unknown error'}`;
    log.error('LTP fetch exhausted all retries', {
      exchange,
      symbol,
      totalAttempts,
      totalSkipped,
      rounds: maxRounds,
      totalInstances: instances.length,
      failuresByInstance: Object.fromEntries(failedInstances),
      lastError: lastError?.message,
    });

    throw new Error(errorMessage);
  }

  /**
   * Extract LTP from quote response
   * Falls back to bid/ask or other price fields if LTP is unavailable
   * @private
   */
  _extractLtp(quote) {
    if (!quote) return null;

    // Primary candidates: various LTP field names (most reliable)
    const primaryCandidates = [
      quote.ltp,
      quote.LTP,
      quote.last_price,
      quote.lastPrice,
      quote.last_traded_price,
      quote.lastTradedPrice,
    ];

    for (const value of primaryCandidates) {
      const parsed = parseFloat(value);
      if (!isNaN(parsed) && parsed > 0) {
        return parsed;
      }
    }

    // Fallback 1: use mid-price (bid + ask) / 2 if both are valid and non-zero
    // CRITICAL FIX: Changed from Math.min(bid, ask) to mid-price for accuracy
    const bid = parseFloat(quote.bid);
    const ask = parseFloat(quote.ask);

    if (!isNaN(bid) && bid > 0 && !isNaN(ask) && ask > 0) {
      const fallbackLtp = (bid + ask) / 2;
      log.debug('Using bid/ask mid-price fallback for LTP', {
        bid,
        ask,
        fallbackLtp,
        reason: 'LTP unavailable',
      });
      return fallbackLtp;
    }

    // Fallback 2: use bid or ask alone
    if (!isNaN(bid) && bid > 0) {
      log.debug('Using bid as LTP fallback', { bid, reason: 'LTP and ask unavailable' });
      return bid;
    }
    if (!isNaN(ask) && ask > 0) {
      log.debug('Using ask as LTP fallback', { ask, reason: 'LTP and bid unavailable' });
      return ask;
    }

    // Fallback 3: use close, prev_close, open, high, low (for indices that might not have bid/ask)
    const secondaryCandidates = [
      quote.close,
      quote.prev_close,
      quote.prevClose,
      quote.previous_close,
      quote.open,
      quote.high,
      quote.low,
    ];

    for (const value of secondaryCandidates) {
      const parsed = parseFloat(value);
      if (!isNaN(parsed) && parsed > 0) {
        log.debug('Using secondary price fallback for LTP', {
          value: parsed,
          reason: 'LTP and bid/ask unavailable',
        });
        return parsed;
      }
    }

    return null;
  }

  /**
   * Get market depth
   * @param {Object} instance - Instance configuration
   * @param {string} exchange - Exchange code
   * @param {string} symbol - Trading symbol
   * @returns {Promise<Object>} - Market depth data
   */
  async getDepth(instance, exchange, symbol) {
    const response = await this.request(instance, 'depth', {
      exchange,
      symbol,
    });
    return response.data;
  }

  /**
   * Get market timings for a specific date
   * @param {Object} instance - Instance configuration
   * @param {string} date - YYYY-MM-DD (IST)
   * @returns {Promise<Array>} - Timings array
   */
  async getMarketTimings(instance, date) {
    const response = await this.request(
      instance,
      'market/timings',
      { date },
      'POST',
      { skipMarketCheck: true }
    );
    return response.data || [];
  }

  /**
   * Get market holidays for a year or date
   * @param {Object} instance - Instance configuration
   * @param {string|number} yearOrDate - Year (YYYY) or date (YYYY-MM-DD)
   * @returns {Promise<Array>} - Holidays array
   */
  async getMarketHolidays(instance, yearOrDate) {
    const payload = {};
    if (yearOrDate !== undefined && yearOrDate !== null) {
      const val = String(yearOrDate).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(val)) {
        payload.date = val;
      } else if (/^\d{4}$/.test(val)) {
        payload.year = val;
      } else {
        payload.year = val;
      }
    }

    const response = await this.request(
      instance,
      'market/holidays',
      payload,
      'POST',
      { skipMarketCheck: true }
    );
    return response.data || [];
  }

  /**
   * Search symbols
   * @param {Object} instance - Instance configuration
   * @param {string} query - Search query
   * @returns {Promise<Array>} - Symbol list
   */
  async searchSymbols(instance, query) {
    const response = await this.request(instance, 'search', {
      query,
    });
    return response.data || [];
  }

  /**
   * Get symbol details (point lookup for validation)
   * @param {Object} instance - Instance configuration
   * @param {string} symbol - Trading symbol
   * @param {string} exchange - Exchange code (NSE, NFO, BSE, BFO, etc.)
   * @returns {Promise<Object>} - Symbol metadata with instrumenttype, expiry, strike, lotsize, etc.
   */
  async getSymbol(instance, symbol, exchange) {
    const response = await this.request(instance, 'symbol', {
      symbol,
      exchange,
    });
    return response.data || response;
  }

  /**
   * Get instruments list (all available symbols from broker)
   * This is a browser-accessible GET endpoint with query parameters
   * @param {Object} instance - Instance configuration
   * @param {string} [exchange] - Optional exchange filter (NSE, BSE, NFO, BFO, BCD, CDS, MCX, NSE_INDEX, BSE_INDEX)
   * @returns {Promise<Array>} - Array of instrument objects with symbol, name, exchange, token, lotsize, instrumenttype, etc.
   */
  async getInstruments(instance, exchange = null) {
    const { host_url, api_key } = instance;

    if (!host_url || !api_key) {
      throw new OpenAlgoError('Instance host_url and api_key are required', 'instruments');
    }

    // Build query parameters
    const params = new URLSearchParams({
      apikey: api_key,
      format: 'json'
    });

    if (exchange) {
      params.append('exchange', exchange);
    }

    const url = `${host_url}/api/v1/instruments?${params.toString()}`;

    const maxRetries = this.nonCriticalRetries;
    const baseRetryDelay = this.nonCriticalRetryDelay;
    let startTime;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        startTime = Date.now();

        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
          },
          signal: AbortSignal.timeout(this.timeout)
        });

        const duration = Date.now() - startTime;

        // Handle non-200 responses
        if (!response.ok) {
          const errorText = await response.text();
          log.warn('Instruments API returned non-200 status', {
            endpoint: 'instruments',
            status: response.status,
            statusText: response.statusText,
            exchange: exchange || 'ALL'
          });

          throw new OpenAlgoError(
            `HTTP ${response.status}: ${errorText.substring(0, 200)}`,
            'instruments',
            response.status
          );
        }

        // Parse JSON response
        let data;
        try {
          const text = await response.text();
          // Handle empty or null responses - throw error instead of returning empty array
          if (!text || text.trim() === '' || text.trim() === 'null') {
            throw new OpenAlgoError(
              `Empty or null response from instruments API (status: ${response.status})`,
              'instruments',
              response.status
            );
          }
          data = JSON.parse(text);
        } catch (parseError) {
          throw new OpenAlgoError(
            `Invalid JSON response: ${parseError.message}`,
            'instruments'
          );
        }

        log.info('OpenAlgo API Call', {
          method: 'GET',
          endpoint: 'instruments',
          duration: `${duration}ms`,
          success: true,
          exchange: exchange || 'ALL',
          count: Array.isArray(data) ? data.length : (data.data ? data.data.length : 0)
        });

        // Handle response format - could be direct array or wrapped in {data: [...]}
        if (Array.isArray(data)) {
          return data;
        } else if (data && data.data && Array.isArray(data.data)) {
          return data.data;
        } else if (data === null || data === undefined) {
          throw new OpenAlgoError(
            'Null or undefined instruments response - API may be unavailable',
            'instruments',
            response.status
          );
        } else {
          throw new OpenAlgoError('Unexpected response format: expected array of instruments', 'instruments');
        }

      } catch (error) {
        const duration = Date.now() - startTime;

        // Handle OpenAlgo API errors
        if (error instanceof OpenAlgoError) {
          // Don't retry on 4xx client errors (bad request, auth, etc.)
          if (error.statusCode >= 400 && error.statusCode < 500) {
            log.error('OpenAlgo API Client Error (4xx) - not retrying', error, {
              method: 'GET',
              endpoint: 'instruments',
              duration: `${duration}ms`,
              statusCode: error.statusCode,
              exchange: exchange || 'ALL'
            });
            throw error;
          }

          // Retry on 5xx server errors (transient failures)
          if (error.statusCode >= 500 && attempt < maxRetries) {
            const delay = baseRetryDelay * Math.pow(2, attempt);
            log.warn('OpenAlgo API Server Error (5xx) - retrying', {
              method: 'GET',
              endpoint: 'instruments',
              statusCode: error.statusCode,
              attempt: attempt + 1,
              maxRetries,
              retryDelay: `${delay}ms`,
              error: error.message,
              exchange: exchange || 'ALL'
            });

            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }

          // All retries exhausted or non-retryable error
          log.error('OpenAlgo API Error', error, {
            method: 'GET',
            endpoint: 'instruments',
            duration: `${duration}ms`,
            statusCode: error.statusCode,
            exchange: exchange || 'ALL'
          });
          throw error;
        }

        // Retry on network/timeout errors
        if (attempt < maxRetries) {
          const delay = baseRetryDelay * Math.pow(2, attempt);
          log.warn('Instruments fetch failed, retrying', {
            endpoint: 'instruments',
            attempt: attempt + 1,
            maxRetries,
            retryDelay: `${delay}ms`,
            error: error.message,
            exchange: exchange || 'ALL'
          });

          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        // All retries exhausted
        log.error('Instruments fetch failed after retries', error, {
          method: 'GET',
          endpoint: 'instruments',
          attempts: maxRetries + 1,
          exchange: exchange || 'ALL'
        });

        throw new OpenAlgoError(
          `Failed after ${maxRetries + 1} attempts: ${error.message}`,
          'instruments'
        );
      }
    }
  }

  /**
   * Place split order (splits large order into smaller chunks)
   * @param {Object} instance - Instance configuration
   * @param {Object} orderData - Order parameters with splitsize
   * @returns {Promise<Object>} - { success_orders, failed_orders }
   */
  async placeSplitOrder(instance, orderData) {
    const response = await this.request(instance, 'splitorder', orderData, 'POST', { isCritical: true });
    return response.data || response;
  }

  /**
   * Modify existing order
   * @param {Object} instance - Instance configuration
   * @param {Object} orderData - Modified order parameters
   * @returns {Promise<Object>} - { orderid, status }
   */
  async modifyOrder(instance, orderData) {
    const response = await this.request(instance, 'modifyorder', orderData, 'POST', { isCritical: true });
    return {
      orderid: response.orderid || response.data?.orderid,
      status: response.status,
    };
  }

  // ==========================================
  // Options & Derivatives APIs
  // ==========================================

  /**
   * Get expiry dates for symbol
   * @param {Object} instance - Instance configuration
   * @param {string} symbol - Underlying symbol (e.g., NIFTY, BANKNIFTY)
   * @param {string} exchange - Exchange code (default: NFO)
   * @returns {Promise<Array>} - Array of expiry dates
   */
  async getExpiry(instance, symbol, exchange = 'NFO') {
    const response = await this.request(instance, 'expiry', {
      symbol,
      exchange,
      instrumenttype: 'options',
    });
    return response.expiry_list || response.data || [];
  }

  /**
   * Get option chain
   * @param {Object} instance - Instance configuration
   * @param {string} symbol - Underlying symbol
   * @param {string} expiry - Expiry date
   * @param {string} exchange - Exchange code
   * @param {Object} options - Options
   * @param {boolean} options.skipBackoff - Skip backoff check for critical operations
   * @param {number} options.strikeCount - Number of strikes above/below ATM (optional)
   * @returns {Promise<Object>} - Option chain data
   */
  async getOptionChain(instance, symbol, expiry, exchange = 'NFO', options = {}) {
    const { skipBackoff = false, strikeCount = null } = options;
    const payload = {
      underlying: symbol,
      exchange,
    };
    if (expiry) {
      payload.expiry_date = expiry;
    }
    if (strikeCount) {
      payload.strike_count = strikeCount;
    }

    const response = await this.request(instance, 'optionchain', payload, 'POST', { skipRateLimit: skipBackoff });
    return response.data || response;
  }

  /**
   * Get option chain with fallback to alternate instances
   * Critical for options resolution - tries multiple instances before failing
   * ALWAYS makes at least one attempt even if all instances are unhealthy
   * @param {Array} instances - Pool of instances to try
   * @param {string} symbol - Underlying symbol
   * @param {string} expiry - Expiry date
   * @param {string} exchange - Exchange code
   * @returns {Promise<Object>} - Option chain data
   */
  async getOptionChainWithFallback(instances, symbol, expiry, exchange = 'NFO') {
    if (!instances || instances.length === 0) {
      throw new Error('No instances available for option chain fetch');
    }

    let lastError = null;
    let attemptsMade = 0;

    // Separate healthy and unhealthy instances
    const healthyInstances = instances.filter(i => this.isInstanceHealthy(i.id));

    // CRITICAL: If all instances are unhealthy, force try the first one anyway
    const instancesToTry = healthyInstances.length > 0
      ? healthyInstances
      : [instances[0]]; // Force try first instance if all unhealthy

    if (healthyInstances.length === 0) {
      log.warn('All instances unhealthy for option chain, forcing attempt on first instance', {
        symbol,
        expiry,
        totalInstances: instances.length,
        forcedInstance: instances[0]?.name,
      });
    }

    for (const instance of instancesToTry) {
      attemptsMade++;

      try {
        log.debug('Fetching option chain', {
          instance: instance.name,
          symbol,
          expiry,
          exchange,
        });

        const result = await this.getOptionChain(instance, symbol, expiry, exchange, {
          skipBackoff: true, // Critical operation - bypass backoff
        });

        // Success - reset instance health
        this.resetInstanceHealth(instance.id);

        log.debug('Option chain fetched successfully', {
          instance: instance.name,
          symbol,
          expiry,
        });

        return result;
      } catch (error) {
        lastError = error;

        // Check if this is an HTML response (instance down)
        const isHtml = error.isHtmlResponse === true ||
                      (error.message && error.message.includes('Invalid JSON response'));

        // Check if this is a DNS/network connectivity error
        const isDnsError = error.isDnsError === true ||
                          (error.message && (
                            error.message.includes('getaddrinfo') ||
                            error.message.includes('ENOTFOUND') ||
                            error.message.includes('ECONNREFUSED')
                          ));

        // Record failure with circuit breaker
        this.recordInstanceFailure(instance.id, error, { isHtml, isDnsError });

        log.warn('Option chain fetch failed, trying next instance', {
          instance: instance.name,
          symbol,
          expiry,
          error: error.message,
          isHtml,
          isDnsError,
        });
      }
    }

    // All instances failed - enrich error with context for upstream callers
    const healthyCount = healthyInstances.length;
    const totalCount = instances.length;
    const errorMessage = `Failed to fetch option chain for ${symbol} ${expiry} after ${attemptsMade} attempts (${healthyCount}/${totalCount} healthy): ${lastError?.message || 'Unknown error'}`;

    log.error('Option chain fetch exhausted all instances', {
      symbol,
      expiry,
      exchange,
      attemptsMade,
      totalInstances: totalCount,
      healthyInstances: healthyCount,
      unhealthyInstances: totalCount - healthyCount,
      lastError: lastError?.message,
    });

    // Create enriched error with metadata for upstream handling
    const enrichedError = new Error(errorMessage);
    enrichedError.attemptsMade = attemptsMade;
    enrichedError.totalInstances = totalCount;
    enrichedError.healthyInstances = healthyCount;
    enrichedError.originalError = lastError;

    throw enrichedError;
  }

  // ==========================================
  // Historical Data APIs
  // ==========================================

  /**
   * Get supported intervals for historical data
   * @param {Object} instance - Instance configuration
   * @returns {Promise<Object>} - Supported intervals by timeframe
   */
  async getIntervals(instance) {
    const response = await this.request(instance, 'intervals');
    return response.data;
  }

  /**
   * Get historical data
   * @param {Object} instance - Instance configuration
   * @param {string} symbol - Trading symbol
   * @param {string} exchange - Exchange code
   * @param {string} interval - Time interval
   * @param {string} start_date - Start date (YYYY-MM-DD)
   * @param {string} end_date - End date (YYYY-MM-DD)
   * @returns {Promise<Array>} - Historical OHLCV data
   */
  async getHistory(instance, symbol, exchange, interval, start_date, end_date) {
    const response = await this.request(instance, 'history', {
      symbol,
      exchange,
      interval,
      start_date,
      end_date,
    });
    return response.data || [];
  }

  // ==========================================
  // Margin Calculator APIs
  // ==========================================

  /**
   * Calculate margin requirement
   * @param {Object} instance - Instance configuration
   * @param {Array<Object>} positions - Array of position objects
   * @returns {Promise<Object>} - Margin calculation
   */
  async calculateMargin(instance, positions) {
    const response = await this.request(instance, 'margin', {
      positions,
    });
    return response.data;
  }

  // ==========================================
  // GTT (Good Till Triggered) APIs
  // ==========================================

  /**
   * Place a GTT (broker-side conditional) order
   * @param {Object} instance - Instance configuration
   * @param {Object} params - { strategy, trigger_type ('SINGLE'|'OCO'), exchange, symbol, action,
   *   product ('CNC'|'NRML' - MIS not supported by GTT), quantity, pricetype, price,
   *   triggerprice_sl, triggerprice_tg, stoploss, target }
   * @returns {Promise<Object>} - { status, trigger_id }
   */
  async placeGttOrder(instance, params) {
    const response = await this.request(instance, 'placegttorder', params, 'POST', {
      isCritical: true,
    });
    return response;
  }

  /**
   * List active GTT orders (triggered/cancelled/expired are excluded by the broker)
   * @param {Object} instance - Instance configuration
   * @returns {Promise<Array>} - Active GTT orders
   */
  async getGttOrderBook(instance) {
    const response = await this.request(instance, 'gttorderbook');
    return response.data || [];
  }

  /**
   * Cancel an active GTT order
   * @param {Object} instance - Instance configuration
   * @param {Object} params - { strategy, trigger_id }
   * @returns {Promise<Object>}
   */
  async cancelGttOrder(instance, params) {
    const response = await this.request(instance, 'cancelgttorder', params, 'POST', {
      isCritical: true,
    });
    return response;
  }

  // ==========================================
  // Basket Order API
  // ==========================================

  /**
   * Place multiple orders in a single broker call
   * @param {Object} instance - Instance configuration
   * @param {Object} params - { strategy, orders: [{symbol, exchange, action, quantity,
   *   pricetype, product, price, trigger_price}, ...] }
   * @returns {Promise<Object>} - { status, results: [{symbol, status, orderid, message}, ...] }
   *   Note: top-level status is "success" if AT LEAST ONE order succeeded - callers must check
   *   each entry in `results` individually, partial failure is expected/normal.
   */
  async placeBasketOrder(instance, params) {
    const response = await this.request(instance, 'basketorder', params, 'POST', {
      isCritical: true,
    });
    return response;
  }

  // ==========================================
  // Order Status API
  // ==========================================

  /**
   * Look up a single order's live status (lighter than fetching the whole orderbook when only
   * one specific order needs checking)
   * @param {Object} instance - Instance configuration
   * @param {Object} params - { orderid, strategy? }
   * @returns {Promise<Object>} - order detail (orderid, symbol, exchange, action, quantity,
   *   price, trigger_price, pricetype, product, order_status, average_price, timestamp)
   */
  async getOrderStatus(instance, params) {
    const response = await this.request(instance, 'orderstatus', params);
    return response.data;
  }

  // ==========================================
  // Option Greeks APIs
  // ==========================================

  /**
   * Get Greeks for a single option symbol
   * @param {Object} instance - Instance configuration
   * @param {Object} params - { symbol, exchange (NFO/BFO/CDS/MCX/CRYPTO), interest_rate?,
   *   underlying_symbol?, underlying_exchange?, forward_price?, expiry_time? }
   * @returns {Promise<Object>} - { symbol, exchange, underlying, strike, option_type,
   *   expiry_date, days_to_expiry, spot_price, option_price, implied_volatility,
   *   greeks: {delta, gamma, theta, vega, rho} }
   */
  async getOptionGreeks(instance, params) {
    const response = await this.request(instance, 'optiongreeks', params);
    return response;
  }

  /**
   * Get Greeks for up to 50 option symbols in one call
   * @param {Object} instance - Instance configuration
   * @param {Object} params - { symbols: [{symbol, exchange, underlying_symbol?, underlying_exchange?}, ...],
   *   interest_rate?, expiry_time? }
   * @returns {Promise<Object>} - { status, data: [{status, symbol, exchange, implied_volatility, greeks}, ...], summary }
   */
  async getMultiOptionGreeks(instance, params) {
    const response = await this.request(instance, 'multioptiongreeks', params, 'POST', {
      isCritical: false,
    });
    return response;
  }

  // ==========================================
  // Contract Info APIs
  // ==========================================

  /**
   * Get contract information
   * @param {Object} instance - Instance configuration
   * @param {string} exchange - Exchange code
   * @param {string} symbol - Trading symbol
   * @returns {Promise<Object>} - Contract details
   */
  async getContractInfo(instance, exchange, symbol) {
    const response = await this.request(instance, 'contractinfo', {
      exchange,
      symbol,
    });
    return response.data || response;
  }

  // ==========================================
  // Utility Methods
  // ==========================================

  /**
   * Validate instance connection
   * @param {Object} instance - Instance configuration
   * @returns {Promise<boolean>} - true if connection is valid
   */
  async validateConnection(instance) {
    try {
      await this.ping(instance);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get comprehensive account summary
   * @param {Object} instance - Instance configuration
   * @returns {Promise<Object>} - Complete account data
   */
  async getAccountSummary(instance) {
    try {
      const [funds, holdings, positions, orders, trades] = await Promise.all([
        this.getFunds(instance),
        this.getHoldings(instance),
        this.getPositionBook(instance),
        this.getOrderBook(instance),
        this.getTradeBook(instance),
      ]);

      return {
        funds,
        holdings,
        positions,
        orders,
        trades,
      };
    } catch (error) {
      throw new OpenAlgoError(
        `Failed to fetch account summary: ${error.message}`,
        'account_summary'
      );
    }
  }

  // ==========================================
  // Private Helper Methods for Order Deduplication
  // ==========================================

  /**
   * Get position for order validation
   * Fetches the specific position that would be affected by this order
   * @private
   * @param {Object} instance - Instance configuration
   * @param {Object} orderData - Order data (symbol, exchange, action, quantity)
   * @returns {Promise<Object|null>} - Position object or null if not found
   */
  async _getPositionForOrder(instance, orderData) {
    try {
      const positions = await this.getPositionBook(instance);

      // Find position matching this order's symbol, exchange, and product
      // Product matching is critical because brokers maintain separate positions
      // for different product types (e.g., RELIANCE-MIS vs RELIANCE-CNC)
      const position = positions.find(
        (pos) =>
          pos.symbol === orderData.symbol &&
          pos.exchange === orderData.exchange &&
          pos.product === (orderData.product || 'MIS') // Default to MIS if not specified
      );

      return position || null;
    } catch (error) {
      log.warn('Failed to fetch position for order validation', {
        symbol: orderData.symbol,
        exchange: orderData.exchange,
        product: orderData.product,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Check if position changed based on order execution
   * Compares initial and current positions to detect if order was placed
   * @private
   * @param {Object|null} initialPosition - Position before order attempt
   * @param {Object|null} currentPosition - Position after order attempt
   * @param {Object} orderData - Order data (action, quantity)
   * @returns {boolean} - true if position changed consistent with order execution
   */
  _hasPositionChanged(initialPosition, currentPosition, orderData) {
    // Validate action is strictly BUY or SELL
    if (orderData.action !== 'BUY' && orderData.action !== 'SELL') {
      log.warn('Invalid order action for position deduplication', {
        action: orderData.action,
        symbol: orderData.symbol,
      });
      return false;
    }

    // Validate quantity is a positive integer
    const orderQty = parseInt(orderData.quantity, 10);
    if (isNaN(orderQty) || orderQty <= 0) {
      log.warn('Invalid order quantity for position deduplication', {
        quantity: orderData.quantity,
        symbol: orderData.symbol,
      });
      return false;
    }

    // Handle different position field names (netqty vs net_qty)
    const getNetQty = (pos) => {
      if (!pos) return 0;
      return pos.netqty || pos.net_qty || 0;
    };

    const initialQty = getNetQty(initialPosition);
    const currentQty = getNetQty(currentPosition);

    // Calculate expected change based on action
    let expectedChange = 0;

    if (orderData.action === 'BUY') {
      expectedChange = orderQty;
    } else if (orderData.action === 'SELL') {
      expectedChange = -orderQty;
    }

    // Check if actual change matches expected change
    const actualChange = currentQty - initialQty;

    // Enforce that position movement direction matches expected direction
    if (expectedChange !== 0 && actualChange !== 0) {
      if (Math.sign(actualChange) !== Math.sign(expectedChange)) {
        log.debug('Position changed in opposite direction - not deduplicating', {
          symbol: orderData.symbol,
          exchange: orderData.exchange,
          action: orderData.action,
          expectedChange,
          actualChange,
        });
        return false;
      }
    }

    // Allow for some tolerance in case of partial fills or broker-specific handling
    // Consider position changed if actual change is at least 80% of expected
    const tolerance = 0.8;
    const minExpectedChange = Math.abs(expectedChange) * tolerance;

    const positionChanged = Math.abs(actualChange) >= minExpectedChange;

    // Calculate fill percentage for logging
    const fillPercentage = Math.abs(expectedChange) > 0
      ? (Math.abs(actualChange) / Math.abs(expectedChange)) * 100
      : 0;

    if (positionChanged) {
      // Warn if partial fill is between 50-80% threshold
      if (fillPercentage >= 50 && fillPercentage < 80) {
        log.warn('Partial fill detected near deduplication threshold', {
          symbol: orderData.symbol,
          exchange: orderData.exchange,
          action: orderData.action,
          orderQty,
          actualChange,
          expectedChange,
          fillPercentage: fillPercentage.toFixed(2) + '%',
          message: 'Order may have been partially filled - potential for duplicate on retry',
        });
      }

      log.debug('Position change detected', {
        symbol: orderData.symbol,
        exchange: orderData.exchange,
        action: orderData.action,
        orderQty,
        initialQty,
        currentQty,
        actualChange,
        expectedChange,
        fillPercentage: fillPercentage.toFixed(2) + '%',
      });
    }

    return positionChanged;
  }

  /**
   * Find actual order ID from order book for deduplication
   * Fetches the most recent matching order from order book
   * @private
   * @param {Object} instance - Instance configuration
   * @param {Object} orderData - Order data (symbol, exchange, product, action, quantity)
   * @returns {Promise<string|null>} - Order ID or null if not found
   */
  async _findOrderIdFromOrderBook(instance, orderData) {
    try {
      const orderBookResponse = await this.getOrderBook(instance);
      const orders = orderBookResponse?.orders || orderBookResponse || [];

      if (!Array.isArray(orders) || orders.length === 0) {
        log.warn('Order book empty or invalid for order ID lookup', {
          symbol: orderData.symbol,
        });
        return null;
      }

      // Parse order quantity for validation
      const requestedQty = parseInt(orderData.quantity, 10);
      if (isNaN(requestedQty) || requestedQty <= 0) {
        log.warn('Invalid quantity in order data for order ID lookup', {
          quantity: orderData.quantity,
        });
        return null;
      }

      // Calculate time window (60 seconds) for filtering recent orders only
      const now = Date.now();
      const timeWindowMs = 60 * 1000; // 60 seconds
      const earliestAllowedTime = now - timeWindowMs;

      // Invalid order statuses that should be excluded
      const invalidStatuses = ['CANCELLED', 'REJECTED', 'FAILED', 'cancelled', 'rejected', 'failed'];

      // Filter orders matching this order's characteristics
      // Include quantity validation with tolerance for partial fills (20% variance)
      // Only match orders placed within the last 60 seconds
      // Exclude orders with invalid statuses
      const quantityTolerance = 0.2; // 20% tolerance
      const matchingOrders = orders.filter((order) => {
        const orderQty = parseInt(order.quantity, 10) || 0;
        const qtyDiff = Math.abs(orderQty - requestedQty);
        const qtyWithinTolerance = qtyDiff <= requestedQty * quantityTolerance;

        // Check if order is within time window
        const orderTime = new Date(order.timestamp || 0).getTime();
        const withinTimeWindow = orderTime >= earliestAllowedTime;

        // Check if order status is valid (not cancelled/rejected/failed)
        const orderStatus = (order.order_status || '').toLowerCase();
        const hasValidStatus = !invalidStatuses.some(status => status.toLowerCase() === orderStatus);

        return (
          order.symbol === orderData.symbol &&
          order.exchange === orderData.exchange &&
          order.product === (orderData.product || 'MIS') &&
          order.action === orderData.action &&
          qtyWithinTolerance &&
          withinTimeWindow &&
          hasValidStatus
        );
      });

      if (matchingOrders.length === 0) {
        log.warn('No matching orders found in order book', {
          symbol: orderData.symbol,
          exchange: orderData.exchange,
          action: orderData.action,
          product: orderData.product || 'MIS',
          quantity: requestedQty,
          timeWindowSeconds: 60,
          totalOrdersInBook: orders.length,
        });
        return null;
      }

      // Sort by timestamp descending (most recent first)
      // Handle various timestamp formats
      matchingOrders.sort((a, b) => {
        const timeA = new Date(a.timestamp || 0).getTime();
        const timeB = new Date(b.timestamp || 0).getTime();
        return timeB - timeA; // Descending order
      });

      // Return the most recent order ID
      const mostRecentOrder = matchingOrders[0];

      log.debug('Found matching order ID from order book', {
        orderid: mostRecentOrder.orderid,
        symbol: mostRecentOrder.symbol,
        exchange: mostRecentOrder.exchange,
        action: mostRecentOrder.action,
        quantity: mostRecentOrder.quantity,
        order_status: mostRecentOrder.order_status,
        timestamp: mostRecentOrder.timestamp,
        matchingOrdersCount: matchingOrders.length,
        timeWindowSeconds: 60,
        filtersApplied: ['symbol', 'exchange', 'product', 'action', 'quantity±20%', 'time≤60s', 'validStatus'],
      });

      return mostRecentOrder.orderid || null;
    } catch (error) {
      log.warn('Failed to fetch order ID from order book', {
        symbol: orderData.symbol,
        exchange: orderData.exchange,
        error: error.message,
      });
      return null;
    }
  }

}

// Export singleton instance
export default new OpenAlgoClient();
export { OpenAlgoClient };
