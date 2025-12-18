import config from '../core/config.js';
import { log } from '../core/logger.js';
import { UnauthorizedError, ValidationError } from '../core/errors.js';
import { ORDER_PARAMS } from '../integrations/openalgo/endpoints.js';
import { maskApiKey, normalizeUrl } from '../utils/sanitizers.js';
import watchlistService from './watchlist.service.js';

const DEFAULT_PAYLOAD = {
  pricetype: 'MARKET',
  product: 'MIS',
  price: 0,
  trigger_price: 0,
  disclosed_quantity: 0,
};

const FORM_JSON_FIELDS = ['payload', 'data', 'json', 'message'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tryParseJson = (value) => {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

class TokenBucket {
  constructor(rate, burst = rate) {
    this.rate = rate;
    this.capacity = burst;
    this.tokens = burst;
    this.lastRefill = Date.now();
  }

  _refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.rate);
    this.lastRefill = now;
  }

  async consume() {
    this._refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    const needed = 1 - this.tokens;
    const waitMs = (needed / this.rate) * 1000;
    await sleep(waitMs);
    this._refill();
    this.tokens = Math.max(0, this.tokens - 1);
  }
}

class TradingviewBroadcastService {
  constructor() {
    this.timeoutMs = Number(config.webhooks?.tradingviewBroadcast?.timeoutMs || 3000);
    this.retries = Number(config.webhooks?.tradingviewBroadcast?.retries ?? 2);
    this.retryDelayMs = Number(config.webhooks?.tradingviewBroadcast?.retryDelayMs ?? 250);
    this.defaultRps = Number(config.webhooks?.tradingviewBroadcast?.defaultRps || 0);
    this.sourceTargets = config.webhooks?.tradingviewBroadcast?.targets || [];
    this.targets = this._normalizeTargets(this.sourceTargets);
    this.tokenBuckets = new Map();
  }

  _normalizeTargets(rawTargets = []) {
    const normalized = [];
    rawTargets.forEach((target) => {
      const url = normalizeUrl(target?.url || target?.host_url || '');
      const apikey = typeof target?.apikey === 'string' ? target.apikey.trim() : '';

      if (!url || !apikey) {
        log.warn('[TV Webhook] Skipping invalid target (missing url/apikey)');
        return;
      }

      const name = (target?.name || url).toString();
      let baseUrl = url.replace(/\/+$/, '');
      baseUrl = baseUrl.replace(/\/api\/v1$/, '').replace(/\/api$/, '');
      const rpsCandidate = Number(
        target?.rps ?? target?.rate ?? target?.tokensPerSecond ?? target?.throttle ?? this.defaultRps
      );
      const rateLimit = Number.isFinite(rpsCandidate) && rpsCandidate > 0 ? rpsCandidate : null;

      normalized.push({
        key: name,
        name,
        url: baseUrl,
        endpoint: `${baseUrl}/api/v1/placesmartorder`,
        apikey,
        rateLimit,
      });
    });

    if (!normalized.length) {
      log.warn('[TV Webhook] No OpenAlgo targets configured for broadcast');
    } else {
      log.info('[TV Webhook] Broadcast targets loaded', {
        count: normalized.length,
        targets: normalized.map((t) => t.name),
      });
    }

    return normalized;
  }

  _ensureTargetsFresh() {
    const latest = config.webhooks?.tradingviewBroadcast?.targets || [];
    if (latest !== this.sourceTargets) {
      this.sourceTargets = latest;
      this.targets = this._normalizeTargets(latest);
    }
  }

  async _resolveTargets({ watchlistId = null, watchlistSlug = null } = {}) {
    if (watchlistId || watchlistSlug) {
      const { targets, watchlist } = await watchlistService.getBroadcastTargets({
        watchlistId,
        watchlistSlug,
      });
      return { targets, watchlist };
    }

    this._ensureTargetsFresh();
    return { targets: this.targets, watchlist: null };
  }

  _getBucket(targetKey, rateLimit) {
    if (!rateLimit) return null;
    if (!this.tokenBuckets.has(targetKey)) {
      this.tokenBuckets.set(targetKey, new TokenBucket(rateLimit, rateLimit));
    }
    return this.tokenBuckets.get(targetKey);
  }

  assertAuthorized(token) {
    // Fallback to env in case config load missed the value
    const expected =
      config.webhooks?.tradingviewBroadcast?.token ||
      process.env.WEBHOOK_TOKEN ||
      '';

    if (!expected) {
      throw new UnauthorizedError('Webhook token is not configured');
    }
    if (token !== expected) {
      throw new UnauthorizedError('Invalid webhook token');
    }
  }

  parseRequestBody(req) {
    if (!req) return null;

    if (req.is && req.is('application/json') && req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      return req.body;
    }

    if (typeof req.body === 'string' && req.body.trim()) {
      const parsed = tryParseJson(req.body.trim());
      if (parsed) return parsed;
    }

    if (req.is && req.is('application/x-www-form-urlencoded') && req.body) {
      const field = FORM_JSON_FIELDS.find((k) => req.body[k] !== undefined);
      if (field) {
        const parsed = tryParseJson(req.body[field]);
        if (parsed) return parsed;
      }
      return req.body;
    }

    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
      return req.body;
    }

    return null;
  }

  normalizePayload(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new ValidationError('Request body must be a JSON object');
    }

    const errors = [];
    const normalized = { ...DEFAULT_PAYLOAD };

    const strategy = this._requireString(data.strategy, 'strategy', errors);
    const exchange = this._validateExchange(data.exchange, errors);
    const symbol = this._requireString(data.symbol, 'symbol', errors, true);
    const action = this._validateAction(data.action, errors);
    const positionSize = this._parseInteger(data.position_size, 'position_size', { required: true, allowNegative: true }, errors);
    const quantity = this._parseInteger(data.quantity, 'quantity', { required: true, min: 0 }, errors);

    normalized.strategy = strategy;
    normalized.exchange = exchange;
    normalized.symbol = symbol;
    normalized.action = action;
    normalized.position_size = positionSize;
    normalized.quantity = quantity;

    normalized.product = this._validateEnum(
      data.product ?? DEFAULT_PAYLOAD.product,
      ORDER_PARAMS.products,
      'product',
      errors
    );

    normalized.pricetype = this._validateEnum(
      data.pricetype ?? DEFAULT_PAYLOAD.pricetype,
      ORDER_PARAMS.pricetypes,
      'pricetype',
      errors
    );

    normalized.price = this._parseNumber(data.price, 'price', { min: 0 }, errors, DEFAULT_PAYLOAD.price);
    normalized.trigger_price = this._parseNumber(
      data.trigger_price,
      'trigger_price',
      { min: 0 },
      errors,
      DEFAULT_PAYLOAD.trigger_price
    );
    normalized.disclosed_quantity = this._parseInteger(
      data.disclosed_quantity,
      'disclosed_quantity',
      { min: 0 },
      errors,
      DEFAULT_PAYLOAD.disclosed_quantity
    );

    if (errors.length) {
      throw new ValidationError('Invalid TradingView payload', errors);
    }

    return normalized;
  }

  async broadcast(normalizedPayload, options = {}) {
    const { watchlistId = null, watchlistSlug = null } = options;
    const { targets, watchlist } = await this._resolveTargets({ watchlistId, watchlistSlug });

    if (!targets.length) {
      throw new ValidationError('No downstream OpenAlgo targets configured');
    }

    log.info('[TV Webhook] Broadcasting signal', {
      strategy: normalizedPayload.strategy,
      action: normalizedPayload.action,
      exchange: normalizedPayload.exchange,
      symbol: normalizedPayload.symbol,
      targets: targets.length,
      watchlist: watchlist ? watchlist.id : null,
    });

    const results = await Promise.allSettled(
      targets.map((target) => this._dispatchToTarget(target, normalizedPayload))
    );

    const summary = results.map((result, idx) => {
      const target = targets[idx];
      if (result.status === 'fulfilled') {
        return { target: target.name, ok: result.value.ok, status: result.value.status, error: result.value.error, attempts: result.value.attempts, duration_ms: result.value.durationMs };
      }
      return {
        target: target.name,
        ok: false,
        status: null,
        error: result.reason?.message || 'Unknown error',
      };
    });

    const okCount = summary.filter((s) => s.ok).length;
    const message = okCount
      ? `Broadcast delivered to ${okCount}/${summary.length} target(s)`
      : 'All downstream requests failed';

    // Record counters for broadcast watchlists
    if (watchlist?.id) {
      try {
        await watchlistService.recordBroadcast(watchlist.id, {
          received: 1,
          success: okCount > 0 ? 1 : 0,
        });
      } catch (err) {
        log.warn('[TV Webhook] Failed to record broadcast counters', { error: err?.message, watchlistId: watchlist.id });
      }
    }

    return {
      ok: okCount > 0,
      okCount,
      total: summary.length,
      message,
      results: summary,
      watchlist: watchlist
        ? {
            id: watchlist.id,
            name: watchlist.name,
            webhook_slug: watchlist.webhook_slug,
            webhook_url: watchlist.webhook_url,
          }
        : null,
    };
  }

  async _dispatchToTarget(target, payload) {
    const rateLimit = target.rateLimit ?? (this.defaultRps > 0 ? this.defaultRps : null);
    const bucket = this._getBucket(target.key, rateLimit);
    if (bucket) {
      await bucket.consume();
    }

    const body = JSON.stringify({
      ...payload,
      apikey: target.apikey,
    });

    const response = await this._postWithRetries(target, body);

    if (response.ok) {
      log.info('[TV Webhook] Downstream success', {
        target: target.name,
        status: response.status,
        duration_ms: response.durationMs,
      });
    } else {
      log.warn('[TV Webhook] Downstream failure', {
        target: target.name,
        status: response.status,
        error: response.error,
        attempts: response.attempts,
        apikey: maskApiKey(target.apikey),
      });
    }

    return response;
  }

  async _postWithRetries(target, body) {
    let attempt = 0;
    let lastError = null;

    while (attempt <= this.retries) {
      attempt += 1;
      const start = Date.now();

      try {
        const { ok, status } = await this._postJson(target.endpoint, body);
        const durationMs = Date.now() - start;

        if (ok) {
          return { ok: true, status, attempts: attempt, durationMs };
        }

        if (status >= 400 && status < 500) {
          return {
            ok: false,
            status,
            error: `HTTP ${status}`,
            attempts: attempt,
            durationMs,
          };
        }

        lastError = new Error(`HTTP ${status}`);
      } catch (err) {
        lastError = err.name === 'AbortError' ? new Error('Request timed out') : err;
      }

      if (attempt > this.retries) {
        break;
      }

      await sleep(this._retryDelay());
    }

    return {
      ok: false,
      status: null,
      error: lastError?.message || 'Request failed',
      attempts: attempt,
      durationMs: null,
    };
  }

  async _postJson(url, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
      // Consume quietly to free resources
      const { status, ok } = res;
      await res.text().catch(() => {});
      return { status, ok };
    } finally {
      clearTimeout(timer);
    }
  }

  _retryDelay() {
    const base = this.retryDelayMs || 200;
    const jitter = Math.floor(Math.random() * base);
    return base + jitter;
  }

  _requireString(value, field, errors, uppercase = false) {
    if (typeof value !== 'string' || !value.trim()) {
      errors.push({ field, message: `${field} is required` });
      return '';
    }
    const cleaned = value.trim();
    return uppercase ? cleaned.toUpperCase() : cleaned;
  }

  _validateAction(value, errors) {
    const action = this._requireString(value, 'action', errors, true);
    if (action && !ORDER_PARAMS.actions.includes(action)) {
      errors.push({
        field: 'action',
        message: `action must be one of: ${ORDER_PARAMS.actions.join(', ')}`,
      });
    }
    return action;
  }

  _validateExchange(value, errors) {
    const exchange = this._requireString(value, 'exchange', errors, true);
    if (exchange && !ORDER_PARAMS.exchanges.includes(exchange)) {
      errors.push({
        field: 'exchange',
        message: `exchange must be one of: ${ORDER_PARAMS.exchanges.join(', ')}`,
      });
    }
    return exchange;
  }

  _validateEnum(value, allowed, field, errors) {
    const str = typeof value === 'string' ? value.trim().toUpperCase() : '';
    if (!allowed.includes(str)) {
      errors.push({
        field,
        message: `${field} must be one of: ${allowed.join(', ')}`,
      });
    }
    return str;
  }

  _parseInteger(value, field, options = {}, errors = [], defaultValue = null) {
    const { required = false, allowNegative = false, min = null } = options;
    if (value === undefined || value === null || value === '') {
      if (required) errors.push({ field, message: `${field} is required` });
      return defaultValue;
    }
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
      errors.push({ field, message: `${field} must be an integer` });
      return defaultValue;
    }
    if (!allowNegative && parsed < 0) {
      errors.push({ field, message: `${field} cannot be negative` });
    }
    if (min !== null && parsed < min) {
      errors.push({ field, message: `${field} must be >= ${min}` });
    }
    return parsed;
  }

  _parseNumber(value, field, options = {}, errors = [], defaultValue = 0) {
    const { min = null } = options;
    if (value === undefined || value === null || value === '') {
      return defaultValue;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      errors.push({ field, message: `${field} must be a number` });
      return defaultValue;
    }
    if (min !== null && parsed < min) {
      errors.push({ field, message: `${field} must be >= ${min}` });
    }
    return parsed;
  }
}

export default new TradingviewBroadcastService();
