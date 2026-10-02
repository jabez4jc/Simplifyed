/**
 * OpenAlgo API Client
 * HTTP client with HTTP/2 multiplexing and exponential backoff retry logic
 */

import { Agent, ProxyAgent } from 'undici';
import { EventEmitter } from 'events';
import { log } from '../../core/logger.js';
import { OpenAlgoError, ValidationError } from '../../core/errors.js';
import { requiresLimitOrders } from '../../utils/broker-type.util.js';
import brokerUnitsService from '../../services/broker-units.service.js';
import { contractExpiry, isContractExpired, parseExpiry } from '../../utils/underlying.util.js';

const EXPIRY_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/**
 * OpenAlgo's /optionchain matches `expiry_date` only as DDMMMYY ("30SEP26"). Verified live on
 * 30 Sep 2026: "2026-09-30" and "30-SEP-26" both answer "No strikes found", for every expiry - so
 * order-side resolution, which passed ISO dates, silently fell back to the local cache.
 */
export function toBrokerExpiry(expiry) {
  const raw = String(expiry || '').trim().toUpperCase();
  if (/^\d{2}[A-Z]{3}\d{2}$/.test(raw)) return raw;
  const d = parseExpiry(raw);
  if (!d) return raw;
  return `${String(d.getUTCDate()).padStart(2, '0')}${EXPIRY_MONTHS[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(-2)}`;
}
import config from '../../core/config.js';
import { maskApiKey } from '../../utils/sanitizers.js';
import settingsService from '../../services/settings.service.js';

import instanceHealthTrackerService, { isUnreachableError } from './instance-health-tracker.service.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Endpoints that count against the per-instance order rate (_throttle). Kept separate from the
// retry logic's `isOrderPlacement` (placeorder/placesmartorder only), which must not change.
const ORDER_RATE_ENDPOINTS = new Set(['placeorder', 'placesmartorder', 'basketorder', 'modifyorder']);

// Explicit endpoint -> token-bucket kind. Order endpoints have no bucket: _throttle is the one
// order limiter. Anything unlisted is 'background'.
const ENDPOINT_BUCKET_KIND = {
  positionbook: 'critical',
  funds: 'critical',
  tradebook: 'critical',
  orderbook: 'critical',
  quotes: 'rest_quotes',
  multiquotes: 'rest_quotes',
};

/**
 * OpenAlgo HTTP Client with HTTP/2 multiplexing support
 */
/**
 * Broker order timestamps arrive as IST wall-clock with no zone ('2026-09-29 10:52:02', seen on
 * Kotak, Fyers and Delta). new Date() would read that in the SERVER's zone - right on an IST
 * machine, 5.5h off on a UTC one - so it is pinned to +05:30. Zoned/ISO values pass through.
 */
export function parseBrokerTimestamp(value) {
  const raw = String(value || '').trim();
  if (!raw) return 0;
  const bare = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(raw);
  const ms = new Date(bare ? `${raw.replace(' ', 'T')}+05:30` : raw).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * A broker's error message as text. Some rejections carry an object (field validation errors,
 * e.g. {"quantity": ["..."]}); interpolated as-is that became "OpenAlgo: [object Object]" and
 * hid the reason entirely.
 */
function brokerMessage(message) {
  if (message === undefined || message === null || message === '') return '';
  return typeof message === 'string' ? message : JSON.stringify(message);
}

const FAST_READ_ENDPOINTS = new Set(['quotes', 'multiquotes', 'depth', 'symbol']);

// Calls about ONE contract: refused outright for an expired one. multiquotes is filtered instead.
const SINGLE_CONTRACT_ENDPOINTS = new Set([
  'placeorder', 'placesmartorder', 'splitorder', 'modifyorder', 'quotes', 'depth', 'symbol', 'openposition',
]);

/**
 * An expired contract no longer exists at any broker: asking about it only earns a "Symbol not
 * found" rejection (per instance, per poll) and ordering it cannot succeed. Refuse single-contract
 * calls, and drop expired symbols from multiquotes and basket orders.
 */
export function withoutExpiredContracts(endpoint, data) {
  const refuse = (row) => {
    throw new ValidationError(`${row.exchange}:${row.symbol} has expired (${contractExpiry(row)}) - it no longer exists at the broker`);
  };
  if (SINGLE_CONTRACT_ENDPOINTS.has(endpoint)) {
    if (data?.symbol && isContractExpired(data)) refuse(data);
    return data;
  }
  if (endpoint === 'basketorder' && Array.isArray(data?.orders)) {
    const expired = data.orders.find((o) => isContractExpired(o));
    if (expired) refuse(expired); // never send part of a basket
    return data;
  }
  if (endpoint === 'multiquotes' && Array.isArray(data?.symbols)) {
    const live = data.symbols.filter((s) => !isContractExpired(s));
    if (live.length === 0) throw new ValidationError('Every requested symbol has expired');
    return live.length === data.symbols.length ? data : { ...data, symbols: live };
  }
  return data;
}
const FAST_READ_TIMEOUT_MS = 5000;

/** Endpoints that send orders, and where their order rows live in the payload. */
const ORDER_ENDPOINTS = {
  placeorder: (d) => [d],
  placesmartorder: (d) => [d],
  splitorder: (d) => [d],
  modifyorder: (d) => [d],
  basketorder: (d) => (Array.isArray(d?.orders) ? d.orders : []),
  placegttorder: (d) => [d], // its trigger legs fire as MARKET orders when pricetype says so
};

/**
 * Last line of SEBI's limit-only rule for Indian exchanges: whatever priced the order upstream,
 * a MARKET or SL-M order for NSE/BSE/NFO/BFO/MCX/CDS never leaves this process. Crypto is exempt.
 */
export function assertLimitOnlyCompliance(endpoint, data) {
  // OpenAlgo's closeposition squares off everything at MARKET and takes no price. Close through
  // quickOrderService.closeAllPositions instead, which sends LIMIT orders.
  if (endpoint === 'closeposition') {
    throw new ValidationError('Refusing closeposition - it squares off at MARKET; SEBI requires LIMIT orders');
  }
  const rows = ORDER_ENDPOINTS[endpoint]?.(data) || [];
  for (const row of rows) {
    const pricetype = String(row?.pricetype || '').toUpperCase();
    if ((pricetype === 'MARKET' || pricetype === 'SL-M') && requiresLimitOrders(row?.exchange)) {
      throw new ValidationError(
        `Refusing ${pricetype} order for ${row?.exchange || 'unknown exchange'}:${row?.symbol || '?'} - `
        + 'SEBI requires LIMIT orders on Indian exchanges and no limit price could be set'
      );
    }
  }
}

class OpenAlgoClient extends EventEmitter {
  constructor() {
    super();
    // Retry counts are fixed (core/config.js). The timeout is a Setting, so it is read live -
    // see the timeout getter below.
    this.criticalRetries = config.openalgo.critical.maxRetries;
    this.criticalRetryDelay = config.openalgo.critical.retryDelay;
    this.nonCriticalRetries = config.openalgo.nonCritical.maxRetries;
    this.nonCriticalRetryDelay = config.openalgo.nonCritical.retryDelay;

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
    this.currentTasks = new Map(); // instKey -> in-flight count, so one hung broker can't starve the rest
    // Fixed ceilings. Only the smart-order rate is a Setting (_loadRateLimitSettings).
    this.maxConcurrentTasks = 10;
    this.rpsLimitPerInstance = 5;
    this.rpmLimitPerInstance = 300;
    this.ordersPerSecondLimit = 10;
    // OpenAlgo caps /placesmartorder at 2 req/sec, a stricter limit than plain /placeorder's
    // 10/sec. Every order this app places goes through placesmartorder (see order-placement
    // .service.js - it always reconciles against the open position), so applying the lenient
    // limit there let a burst - closing several positions, a fast quick-order fan-out, a retry
    // storm - send smart-orders up to 5x the rate the broker actually accepts.
    this.smartOrdersPerSecondLimit = 2;
    // Endpoint-specific token buckets (per instance)
    this.endpointBuckets = new Map(); // key: instKey -> { orders, critical, background, rest_quotes }
    this.instanceMeta = new Map();

    // Rate limit settings cache - loaded once at startup, refreshed on settings change
    this.limitsCache = {
      loadedAt: 0,
      ttl: 10 * 60 * 1000,  // 10 minutes (increased from 1 minute)
      initialized: false,
      initPromise: null,    // Promise-based lock for concurrent init calls
      reloadPromise: null,  // Promise-based lock for concurrent reload calls
    };

    // Instance health/circuit-breaker tracking lives in instance-health-tracker.service.js.
  }

  /** Settings > Broker Connection, read on every call so a change applies at once. */
  get timeout() {
    return config.openalgo.requestTimeout;
  }

  // Delegated to instance-health-tracker.service.js - names/signatures kept identical so every
  // existing internal and external call site keeps working unmodified.
  isInstanceHealthy(instanceId) {
    return instanceHealthTrackerService.isInstanceHealthy(instanceId);
  }

  getInstanceHealthStatus(instanceId) {
    return instanceHealthTrackerService.getInstanceHealthStatus(instanceId);
  }

  getInstanceCooldownRemaining(instanceId) {
    return instanceHealthTrackerService.getInstanceCooldownRemaining(instanceId);
  }

  getOpenCircuits() {
    return instanceHealthTrackerService.getOpenCircuits();
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
    const smart = Number(await settingsService.getRawValue('rate_limits.smart_orders_per_second'));
    if (Number.isFinite(smart) && smart > 0) this.smartOrdersPerSecondLimit = smart;
    this.limitsCache.loadedAt = Date.now();
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
  /**
   * Every broker call. Two boundary rules wrap the transport in _request:
   *  - SEBI limit-only compliance on order endpoints (assertLimitOnlyCompliance).
   *  - Broker quantity units: order quantities go out in the broker's own lot units and
   *    position/order/trade quantities come back in canonical units (broker-units.service.js).
   *    `data` stays canonical inside _request, so its retry/duplicate checks compare like with
   *    like; only the wire payload is converted.
   */
  async request(instance, endpoint, data = {}, method = 'POST', options = {}) {
    assertLimitOnlyCompliance(endpoint, data);
    data = withoutExpiredContracts(endpoint, data);
    const wireData = await brokerUnitsService.toBroker(instance, endpoint, data, this);
    const response = await this._request(instance, endpoint, data, method, { ...options, wireData });
    return brokerUnitsService.fromBroker(instance, endpoint, data, response, this);
  }

  async _request(instance, endpoint, data = {}, method = 'POST', options = {}) {
    // Circuit breaker in place of the old fixed IST blackout windows: calls are paused only while
    // this instance is actually unreachable (instance-health-tracker.service.js), and resume on
    // their own once a probe after the cooldown succeeds. Critical calls (orders) always go
    // through - a user action should never be refused on the strength of an earlier failure.
    if (!options?.isCritical && !options?.ignoreCircuit && instance?.id != null && !this.isInstanceHealthy(instance.id)) {
      const resumeIn = Math.ceil(instanceHealthTrackerService.getInstanceCooldownRemaining(instance.id) / 1000);
      const err = new OpenAlgoError(
        `Instance ${instance.name || instance.id} is unreachable - calls paused, next probe in ${resumeIn}s`,
        endpoint
      );
      err.code = 'INSTANCE_UNREACHABLE';
      err.statusCode = 503;
      throw err;
    }
    const { host_url, api_key } = instance;
    const { isCritical = false } = options;
    // Order endpoints always go through the per-instance order throttle. skipRateLimit is honoured
    // for market-data reads only (quotes/multiquotes/optionchain), which must not queue behind it.
    const isRateOrder = ORDER_RATE_ENDPOINTS.has(endpoint);
    const skipRateLimit = options.skipRateLimit === true && !isRateOrder;

    if (!host_url || !api_key) {
      throw new OpenAlgoError('Instance host_url and api_key are required', endpoint);
    }

    const url = `${host_url}/api/v1/${endpoint}`;
    const wire = options.wireData || data;
    const payload = { ...wire, apikey: api_key };
    const maskedPayload = { ...wire, apikey: maskApiKey(api_key) };
    const instKey = this._instanceKey(instance);
    // Market-data reads get a short timeout: a broker stall (seen on Kotak: 15s hangs, while a
    // 20-call burst peaks at ~2.7s) should cost seconds, not stall order pricing - which now
    // falls through to other sources. Orders and books keep the full timeout.
    const timeoutOverride = FAST_READ_ENDPOINTS.has(endpoint)
      ? Math.min(this.timeout, FAST_READ_TIMEOUT_MS)
      : null;
    this._persistMeta(instKey, instance);

    // Select retry configuration based on operation type
    const maxRetries = isCritical ? this.criticalRetries : this.nonCriticalRetries;
    const baseRetryDelay = isCritical ? this.criticalRetryDelay : this.nonCriticalRetryDelay;

    // Check if this is an order placement endpoint
    const isOrderPlacement = ['placeorder', 'placesmartorder'].includes(endpoint);

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
    const requestStartedAt = Date.now();
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        attemptsUsed = attempt + 1;
        const startTime = Date.now();
        if (!skipRateLimit) {
          await this._ensureLimits();
          await this._throttle(instance, endpoint);
        }
        const response = skipRateLimit
          ? await this._makeRequest(url, method, payload, timeoutOverride)
          : await this._executeWithConcurrency(instance, endpoint, method, url, payload, isRateOrder, timeoutOverride);
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

        if (instance.id != null) this.resetInstanceHealth(instance.id);
        // A retried order that comes back "success" without an order id: the first attempt timed
        // out but DID reach the broker, so the retry found the target position already met and
        // placed nothing. The order exists - recover its id from the order book rather than
        // record it without one.
        if (isOrderPlacement && attempt > 0 && response?.status === 'success' && !response.orderid && !response.order_id) {
          const recovered = await this._findOrderIdFromOrderBook(instance, data).catch(() => null);
          log.warn(recovered ? 'Order id recovered from the order book after a timed-out attempt' : 'Order placed by a timed-out attempt - order id not found in the order book', {
            endpoint, symbol: data.symbol, exchange: data.exchange, instance_name: instance.name, order_id: recovered,
          });
          if (recovered) return { ...response, orderid: recovered };
        }
        return response;
      } catch (error) {
        lastError = error;

        // An unreachable instance: open/extend its circuit. A background call gives up at once
        // rather than retrying a host that is down - those retries, multiplied across every
        // poller, were the error flood the blackout windows used to paper over.
        if (isUnreachableError(error)) {
          if (instance.id != null) {
            this.recordInstanceFailure(instance.id, error, {
              isHtml: !!error.isHtmlResponse,
              isDnsError: !!error.isDnsError,
            });
          }
          if (!isCritical) throw error;
        }

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
        // OpenAlgo's limiter answers 429 with a bare "2 per 1 second", which no message test
        // caught - so rate limits were treated as final and orders were dropped.
        const isTransientRejection = error.statusCode === 429
          || /rate limit|too many requests|try again|per \d+ (second|minute)/i.test(error.message || '');
        // No status code = a network failure, which stays retryable as before.
        const isDeterministicRejection = !isTransientRejection
          && Number.isFinite(error.statusCode) && error.statusCode < 500;

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

        // For order placement requests, check if order was actually placed before retrying.
        // An order whose outcome is unknown (timeout, network or 5xx) must never be re-sent blind.
        // Observed live on Fyers: an exit timed out after it had filled, the position book still
        // lagged, so the position-targeted retry saw the position open and SOLD AGAIN - a short
        // where there should have been flat. Look for the order in the book first; only retry if
        // it never appears. A 429 is a definite "not placed" and retries straight away.
        // A basket is never re-sent at all: any of its legs may have landed, and a re-send would
        // duplicate every one that did. Each leg's outcome is read from the book instead.
        if (endpoint === 'basketorder' && error.statusCode !== 429) {
          return this._basketOutcomeFromBook(instance, data, requestStartedAt, error);
        }
        if (isOrderPlacement && attempt < maxRetries && error.statusCode !== 429) {
          const landed = await this._awaitOrderInBook(instance, data, requestStartedAt);
          if (landed) {
            log.warn('Order landed despite the error - confirmed from the order book, not re-sent', {
              endpoint, symbol: data.symbol, exchange: data.exchange, instance_name: instance.name,
              order_id: landed, error: error.message,
            });
            return { status: 'success', orderid: landed, message: 'Order placed (confirmed from the order book after an error)' };
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
    await this._waitForConcurrencySlot(instKey, endpoint);

    try {
      // The bucket wait can throw (429 after 100 retries). It must run inside this try so the
      // finally below always releases the slot acquired above - previously the throw happened
      // between acquiring the slot and entering any try/finally, so it leaked forever and, after
      // maxConcurrentTasks leaks, every call through the limiter spun in its while loop forever.
      await this._waitForRateBucket(instKey, endpoint);

      // Record timestamps for rate tracking
      const now = Date.now();
      const state = this._getRateState(instKey);
      state.rps.push(now);
      state.rpm.push(now);
      this.globalRpm.push(now);
      if (isOrderPlacement) {
        state.orders.push(now);
      }

      return await this._makeRequest(url, method, payload, timeoutOverride);
    } finally {
      this._releaseConcurrencySlot(instKey);
    }
  }

  async _waitForConcurrencySlot(instKey, endpoint) {
    const delay = 50;
    let waited = 0;
    let logged = false;
    while ((this.currentTasks.get(instKey) || 0) >= this.maxConcurrentTasks) {
      // Log once per wait (not once per 50ms poll iteration) to avoid flooding the log when
      // this instance's concurrency pool is briefly saturated - a common, often benign occurrence.
      if (!logged) {
        log.warn('Throttling due to concurrent task limit', {
          endpoint,
          instKey,
          currentTasks: this.currentTasks.get(instKey) || 0,
        });
        logged = true;
      }
      await sleep(delay);
      waited += delay;
      if (waited % 2000 === 0) {
        log.warn('Still throttled by concurrent task limit', {
          endpoint, instKey, currentTasks: this.currentTasks.get(instKey) || 0, waitedMs: waited,
        });
      }
    }
    this.currentTasks.set(instKey, (this.currentTasks.get(instKey) || 0) + 1);
  }

  _releaseConcurrencySlot(instKey) {
    this.currentTasks.set(instKey, Math.max(0, (this.currentTasks.get(instKey) || 0) - 1));
  }

  async _waitForRateBucket(instKey, endpoint) {
    const bucketKind = this._bucketKindForEndpoint(endpoint);
    if (!bucketKind) return;
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

  _bucketKindForEndpoint(endpoint) {
    const ep = (endpoint || '').toLowerCase();
    if (ORDER_RATE_ENDPOINTS.has(ep)) return null; // _throttle is the order limiter
    return ENDPOINT_BUCKET_KIND[ep] || 'background';
  }

  _getRateState(instKey) {
    if (!this.instanceRate.has(instKey)) {
      this.instanceRate.set(instKey, { rps: [], rpm: [], orders: [] });
    }
    return this.instanceRate.get(instKey);
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

  async _throttle(instance, endpoint) {
    const instKey = this._instanceKey(instance);
    const isOrderPlacement = ORDER_RATE_ENDPOINTS.has((endpoint || '').toLowerCase());
    const state = this._getRateState(instKey);
    let waitedOnce = false;

    // The order limit is PER INSTANCE (the broker caps per API key): one instance's burst must not
    // hold back another's. placesmartorder uses the Setting (default 2/s), other order endpoints 10/s.
    const ordersLimit = (endpoint || '').toLowerCase() === 'placesmartorder'
      ? this.smartOrdersPerSecondLimit
      : this.ordersPerSecondLimit;

    for (;;) {
      const now = Date.now();
      this._prune(state.rps, 1000, now);
      this._prune(state.rpm, 60000, now);
      this._prune(state.orders, 1000, now);
      this._prune(this.globalRpm, 60000, now);

      const instRps = state.rps.length;
      const instRpm = state.rpm.length;
      const globalRpm = this.globalRpm.length;
      const instOrders = state.orders.length;

      const rpsOver = instRps >= this.rpsLimitPerInstance;
      const rpmOver = instRpm >= this.rpmLimitPerInstance;
      const ordersOver = isOrderPlacement && instOrders >= ordersLimit;

      if (!rpsOver && !rpmOver && !ordersOver) {
        return;
      }

      const nextExpiry = Math.min(
        rpsOver && state.rps[0] ? state.rps[0] + 1000 - now : Infinity,
        rpmOver && state.rpm[0] ? state.rpm[0] + 60000 - now : Infinity,
        ordersOver && state.orders[0] ? state.orders[0] + 1000 - now : Infinity,
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
          ordersLimit,
          waitFor,
        });
        waitedOnce = true;
      }

      await sleep(waitFor);
    }
  }

  getInstanceMetrics() {
    const metrics = [];
    for (const [instKey, rate] of this.instanceRate.entries()) {
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
          maxConcurrent: this.maxConcurrentTasks,
        },
        usage: {
          rpsUsed: rate.rps.length,
          rpmUsed: rate.rpm.length,
          ordersUsed: rate.orders.length,
          currentConcurrent: this.currentTasks.get(instKey) || 0,
        },
        remaining: {
          rps: Math.max(0, rpsLimit - rate.rps.length),
          rpm: Math.max(0, rpmLimit - rate.rpm.length),
          orders: Math.max(0, ordersLimit - rate.orders.length),
          concurrentSlots: Math.max(0, this.maxConcurrentTasks - (this.currentTasks.get(instKey) || 0)),
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
          brokerMessage(responseData.message) || `HTTP ${response.status}: ${response.statusText}`,
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
          brokerMessage(responseData.message) || 'OpenAlgo API returned error status',
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

  // ==========================================
  // Order APIs
  // ==========================================

  /**
   * Get order book
   * @param {Object} instance - Instance configuration
   * @returns {Promise<Object>} - { orders, statistics }
   */
  async getOrderBook(instance, options = {}) {
    const response = await this.request(instance, 'orderbook', {}, 'POST', options);
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

  /** A plain order (placeorder) - used for resting orders at the caller's own price. */
  async placeOrder(instance, orderData) {
    const response = await this.request(instance, 'placeorder', orderData, 'POST', { isCritical: true });
    return {
      orderid: response.orderid || response.data?.orderid,
      status: response.status,
      message: response.message,
    };
  }

  /** Change a resting order's price/trigger (OpenAlgo modifyorder). */
  async modifyOrder(instance, orderData) {
    const response = await this.request(instance, 'modifyorder', orderData, 'POST', { isCritical: true });
    return response.data || response;
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
   * @param {boolean} options.perSymbol - Skip the /multiquotes batch and hit /quotes per symbol
   *   (capability probes of /quotes itself, and fallbacks that already tried /multiquotes)
   * @returns {Promise<Object>} - { quotes: [], failed: [] }
   */
  async getQuotes(instance, symbols, options = {}) {
    const { returnErrors = false, perSymbol = false } = options;

    // One /multiquotes request instead of N /quotes requests wherever the instance supports it;
    // only the symbols it could not answer go on to the per-symbol path below.
    if (!perSymbol && symbols.length > 1 && instance?.supports_multiquotes) {
      try {
        const multi = await this.getMultiQuotes(instance, symbols, { returnErrors: true });
        let { quotes, failed } = multi;
        if (failed.length) {
          const retry = await this.getQuotes(
            instance,
            failed.map(({ symbol, exchange }) => ({ symbol, exchange })),
            { ...options, perSymbol: true, returnErrors: true }
          );
          quotes = [...quotes, ...retry.quotes];
          failed = retry.failed;
        }
        return returnErrors ? { quotes, failed } : quotes;
      } catch (error) {
        log.warn('multiquotes failed, falling back to per-symbol quotes', {
          instance: instance?.name, count: symbols.length, error: error.message,
        });
      }
    }
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
        .filter((entry) => entry.symbol && entry.exchange && !isContractExpired(entry))
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
    if (isContractExpired({ exchange, symbol })) {
      throw new ValidationError(`${exchange}:${symbol} has expired - it has no LTP`);
    }
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
          const firstAvailableInstance = instances[0];

          if (firstAvailableInstance) {
            // Only force on the first round
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
            { skipRateLimit: true, ignoreCircuit: true } // order-critical; this helper does its own health filtering
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
      'POST'
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
      'POST'
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
          signal: AbortSignal.timeout(config.openalgo.instrumentsTimeout)
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
  async getExpiry(instance, symbol, exchange = 'NFO', instrumenttype = 'options') {
    const response = await this.request(instance, 'expiry', {
      symbol,
      exchange,
      instrumenttype,
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
   * @param {number} options.greeksRate - When set, asks OpenAlgo to attach IV/delta/gamma/theta/
   *   vega to every leg (`with_greeks`), computed server-side by opengreeks' Black-76 core from
   *   the quotes the chain already fetched. Annualised percentage, e.g. 6.75.
   * @returns {Promise<Object>} - Option chain data
   */
  async getOptionChain(instance, symbol, expiry, exchange = 'NFO', options = {}) {
    const { skipBackoff = false, strikeCount = null, greeksRate = null } = options;
    const payload = {
      underlying: symbol,
      exchange,
    };
    if (expiry) {
      payload.expiry_date = toBrokerExpiry(expiry);
    }
    if (strikeCount) {
      payload.strike_count = strikeCount;
    }
    if (greeksRate !== null) {
      payload.with_greeks = true;
      payload.interest_rate = greeksRate;
    }

    const response = await this.request(instance, 'optionchain', payload, 'POST', {
      skipRateLimit: skipBackoff,
      ignoreCircuit: skipBackoff,
    });
    return response.data || response;
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

  // ==========================================
  // Order outcome recovery
  // ==========================================

  /**
   * Poll the order book for an order matching `orderData` placed since `since`. Returns its id,
   * or null if none shows up within the checks (it was then most likely never placed).
   */
  async _awaitOrderInBook(instance, orderData, since, { checks = 3, delayMs = 1500 } = {}) {
    let looked = false;
    let lastError = null;
    for (let i = 0; i < checks; i += 1) {
      if (i) await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        const id = await this._findOrderIdFromOrderBook(instance, orderData, { since, rethrow: true });
        looked = true;
        if (id) return id;
      } catch (error) {
        lastError = error;
      }
    }
    if (looked) return null; // the book was read and the order is not in it - safe to retry
    // The book could not be read at all, so whether the order landed is UNKNOWN. Re-sending
    // would risk a duplicate (seen live on Kotak: a stalled exit had filled, the book timed out,
    // the retry sold again and left a short). Refuse, and say what to check.
    const err = new OpenAlgoError(
      `Order outcome unknown for ${orderData.exchange}:${orderData.symbol} on ${instance.name} - the request failed and the order book could not be read (${lastError?.message}). It may have been placed: check the order book before retrying.`,
      'placesmartorder',
      504
    );
    err.code = 'ORDER_OUTCOME_UNKNOWN';
    throw err;
  }

  /**
   * The outcome of a basket whose request failed (timeout, network, 5xx), leg by leg from the
   * order book, in placeBasketOrder's response shape. Throws ORDER_OUTCOME_UNKNOWN when the book
   * cannot be read - never re-sends.
   */
  async _basketOutcomeFromBook(instance, data, since, error) {
    const results = [];
    for (const order of data?.orders || []) {
      const orderid = await this._awaitOrderInBook(instance, order, since);
      results.push(orderid
        ? { symbol: order.symbol, status: 'success', orderid }
        : { symbol: order.symbol, status: 'error', message: `Not placed - the basket request failed (${error.message})` });
    }
    const placed = results.filter((r) => r.status === 'success').length;
    log.warn('Basket request failed - leg outcomes read from the order book, nothing re-sent', {
      instance_name: instance.name, legs: results.length, placed, error: error.message,
    });
    return { status: placed ? 'success' : 'error', results, message: `Basket request failed (${error.message}); ${placed} of ${results.length} leg(s) found in the order book` };
  }

  async _findOrderIdFromOrderBook(instance, orderData, { since = null, rethrow = false } = {}) {
    try {
      const orderBookResponse = await this.getOrderBook(instance, { ignoreCircuit: true });
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
      // With `since`, only orders from this request count (2s allowance for second-granular
      // broker timestamps) - an identical order a minute earlier must not be mistaken for it.
      const earliestAllowedTime = since ? since - 2000 : now - timeWindowMs;

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
        const orderTime = parseBrokerTimestamp(order.timestamp);
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
        const timeA = parseBrokerTimestamp(a.timestamp);
        const timeB = parseBrokerTimestamp(b.timestamp);
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
      if (rethrow) throw error;
      return null;
    }
  }

}

// Export singleton instance
export default new OpenAlgoClient();
export { OpenAlgoClient };
