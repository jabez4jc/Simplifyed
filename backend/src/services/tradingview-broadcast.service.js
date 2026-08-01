import config from '../core/config.js';
import { log } from '../core/logger.js';
import { UnauthorizedError, ValidationError } from '../core/errors.js';
import { ORDER_PARAMS } from '../integrations/openalgo/endpoints.js';
import { maskApiKey, parseIntSafe, timingSafeEqualStr } from '../utils/sanitizers.js';
import { extractLtp } from '../utils/price-extraction.js';
import watchlistService from './watchlist.service.js';
import watchlistSymbolService from './watchlist-symbol.service.js';
import marketDataFeedService from './market-data-feed.service.js';
import instrumentsService from './instruments.service.js';
import pnlSnapshotService from './pnl-snapshot.service.js';
import orderRetryService from './order-retry.service.js';
import instanceService from './instance.service.js';
import brokerCapabilitiesService from './broker-capabilities.service.js';
import marginSizingService from './margin-sizing.service.js';

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
    this.tokenBuckets = new Map();
  }

  async _resolveTargets({ watchlistId = null, watchlistSlug = null } = {}) {
    if (watchlistId || watchlistSlug) {
      const { targets, watchlist } = await watchlistService.getBroadcastTargets({
        watchlistId,
        watchlistSlug,
      });
      return { targets, watchlist };
    }

    throw new ValidationError('Broadcast watchlist id or slug is required');
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
    // Constant-time - this token is the sole authentication on an endpoint that places live
    // orders. See timingSafeEqualStr.
    if (!timingSafeEqualStr(token, expected)) {
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
      throw new ValidationError('No broadcast targets configured for this watchlist');
    }

    log.info('[TV Webhook] Broadcasting signal', {
      strategy: normalizedPayload.strategy,
      action: normalizedPayload.action,
      exchange: normalizedPayload.exchange,
      symbol: normalizedPayload.symbol,
      quantity: normalizedPayload.quantity,
      position_size: normalizedPayload.position_size,
      targets: targets.length,
      watchlist: watchlist ? watchlist.id : null,
    });

    const results = await Promise.allSettled(
      targets.map(async (target) => {
        const rawMultiplier = parseIntSafe(target.multiplier, 1);
        const instanceMultiplier = Math.min(Math.max(rawMultiplier, 1), 999);
        const payloadToSend = await this._ensureLimitPricing(normalizedPayload, watchlist, target);
        let quantity = payloadToSend.quantity * instanceMultiplier;

        // Sentinel: quantity === 0 on a MARGIN_BASED watchlist symbol means "size from margin"
        // for this specific target instance, instead of a fixed TradingView-supplied quantity.
        if (payloadToSend.quantity === 0 && watchlist?.id && target?.instance_id) {
          quantity = await this._resolveMarginBasedWebhookQuantity(payloadToSend, watchlist, target) ?? quantity;
        }

        const targetPayload = {
          ...payloadToSend,
          quantity,
          position_size: payloadToSend.position_size * instanceMultiplier,
        };
        return this._dispatchToTarget(target, targetPayload, instanceMultiplier, watchlist);
      })
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

    const actionSide = normalizedPayload.action === 'BUY' ? 'BUY' : 'SELL';
    const signalCounts = actionSide === 'BUY'
      ? { webhook_buy_signals: 1 }
      : { webhook_sell_signals: 1 };
    const countUpdates = summary
      .map((result, idx) => {
        if (!result.ok) return null;
        const target = targets[idx];
        if (!target?.instance_id || target.is_analyzer_mode) return null;
        return pnlSnapshotService.incrementSignalCounts(target.instance_id, signalCounts);
      })
      .filter(Boolean);
    if (countUpdates.length) {
      Promise.allSettled(countUpdates).catch(() => {});
    }

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

  async _ensureLimitPricing(payload, watchlist = null, target = null) {
    if (!payload || payload.pricetype !== 'MARKET') {
      return payload;
    }

    let broker = target?.broker || null;
    if (!broker && target?.instance_id) {
      try {
        const instance = await instanceService.getInstanceById(target.instance_id);
        broker = instance?.broker || null;
      } catch {
        broker = null;
      }
    }

    const supportsMarketOrders = await brokerCapabilitiesService.supportsMarketOrders(broker);
    if (supportsMarketOrders) {
      return {
        ...payload,
        price: 0,
      };
    }

    const exchange = payload.exchange;
    const symbol = payload.symbol;
    const action = payload.action;
    const bufferPct = this._resolveBufferPct(payload.strategy, watchlist);
    const ltpResult = await marketDataFeedService.fetchLtpForSymbol(exchange, symbol, {
      orderCritical: true,
    });
    const ltp = ltpResult?.ltp || extractLtp(ltpResult?.quote);

    if (!ltp || ltp <= 0) {
      throw new ValidationError(`Unable to resolve LTP for ${exchange}:${symbol}`);
    }

    const buffer = ltp * (bufferPct / 100);
    const side = this._isBuyAction(action) ? 'BUY' : 'SELL';
    const rawPrice = side === 'BUY' ? ltp + buffer : ltp - buffer;
    if (!Number.isFinite(rawPrice) || rawPrice <= 0) {
      throw new ValidationError(`Invalid LIMIT price for ${exchange}:${symbol}`);
    }

    const tickSize = await this._resolveTickSize(exchange, symbol);
    const price = this._roundToTick(rawPrice, tickSize, side);

    return {
      ...payload,
      pricetype: 'LIMIT',
      price,
    };
  }

  _resolveBufferPct(strategy, watchlist) {
    const watchlistPct = watchlist?.limit_buffer_pct;
    if (Number.isFinite(watchlistPct) && watchlistPct >= 0) {
      return watchlistPct;
    }

    const map = config.webhooks?.tradingviewBroadcast?.bufferPctByStrategy || {};
    if (strategy && map && Object.prototype.hasOwnProperty.call(map, strategy)) {
      const pct = parseFloat(map[strategy]);
      if (Number.isFinite(pct) && pct >= 0) {
        return pct;
      }
    }

    const fallback = config.webhooks?.tradingviewBroadcast?.bufferPctDefault;
    if (Number.isFinite(fallback) && fallback >= 0) {
      return fallback;
    }
    return 0.5;
  }

  _isBuyAction(action) {
    const normalized = (action || '').toUpperCase();
    return ['BUY', 'COVER'].includes(normalized);
  }

  async _resolveTickSize(exchange, symbol) {
    try {
      const instrument = await instrumentsService.getInstrument(symbol, exchange);
      const tick = instrument?.tick_size || instrument?.tickSize;
      return Number.isFinite(tick) && tick > 0 ? tick : null;
    } catch {
      return null;
    }
  }

  _roundToTick(price, tickSize, side) {
    const tick = typeof tickSize === 'string' ? parseFloat(tickSize) : tickSize;
    if (!Number.isFinite(tick) || tick <= 0) {
      return Number(price.toFixed(2));
    }

    const ticks = price / tick;
    const roundedTicks = side === 'BUY'
      ? Math.ceil(ticks - 1e-9)
      : Math.floor(ticks + 1e-9);
    const rounded = roundedTicks * tick;
    return Number(rounded.toFixed(this._countDecimals(tick)));
  }

  _countDecimals(value) {
    const text = value.toString();
    const idx = text.indexOf('.');
    return idx === -1 ? 0 : Math.min(6, text.length - idx - 1);
  }

  async _dispatchToTarget(target, payload, instanceMultiplier = 1, watchlist = null) {
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
        instance_multiplier: instanceMultiplier,
        status: response.status,
        duration_ms: response.durationMs,
      });

      await this._scheduleRetryForTarget({
        target,
        payload,
        response,
        watchlist,
      });
    } else {
      log.warn('[TV Webhook] Downstream failure', {
        target: target.name,
        instance_multiplier: instanceMultiplier,
        status: response.status,
        error: response.error,
        attempts: response.attempts,
        apikey: maskApiKey(target.apikey),
      });
    }

    return response;
  }

  async _resolveMarginBasedWebhookQuantity(payload, watchlist, target) {
    try {
      const symbolRow = await watchlistSymbolService.findSymbolByWatchlist(
        watchlist.id,
        payload.exchange,
        payload.symbol
      );
      if (!symbolRow || symbolRow.qty_type !== 'MARGIN_BASED') {
        return null;
      }

      const instance = await instanceService.getInstanceById(target.instance_id);
      if (!instance) {
        return null;
      }

      const { quantity } = await marginSizingService.computeLotQuantity({
        instance,
        symbolConfig: symbolRow,
        orderContext: {
          exchange: payload.exchange,
          symbol: payload.symbol,
          action: payload.action,
          product: payload.product,
          orderType: payload.pricetype,
        },
        watchlistId: watchlist.id,
      });
      return quantity > 0 ? quantity : null;
    } catch (error) {
      log.warn('[TV Webhook] Margin-based quantity resolution failed, falling back to payload quantity', {
        target: target.name,
        error: error.message,
      });
      return null;
    }
  }

  async _scheduleRetryForTarget({ target, payload, response, watchlist }) {
    if (!response?.ok || !response?.data) return;
    if ((payload.pricetype || '').toUpperCase() !== 'LIMIT') return;
    if (!target?.instance_id) return;

    const orderId = response.data?.orderid || response.data?.order_id;
    if (!orderId) return;

    let instance;
    try {
      instance = await instanceService.getInstanceById(target.instance_id);
    } catch (error) {
      log.warn('[TV Webhook] Retry scheduling skipped - instance missing', {
        instance_id: target.instance_id,
        error: error.message,
      });
      return;
    }

    let bufferPoints = null;
    let bufferPct = Number.isFinite(watchlist?.limit_buffer_pct)
      ? watchlist.limit_buffer_pct
      : null;
    let tickSize = null;
    if (watchlist?.id) {
      const symbolRow = await watchlistSymbolService.findSymbolByWatchlist(
        watchlist.id,
        payload.exchange,
        payload.symbol
      );
      if (symbolRow) {
        bufferPoints = Number.isFinite(symbolRow.limit_buffer_points)
          ? symbolRow.limit_buffer_points
          : null;
        if (Number.isFinite(bufferPoints)) {
          bufferPct = null;
        }
        tickSize = Number.isFinite(symbolRow.tick_size) ? symbolRow.tick_size : null;
      }
    }

    if (!Number.isFinite(tickSize) || tickSize <= 0) {
      tickSize = await this._resolveTickSize(payload.exchange, payload.symbol);
    }

    orderRetryService.scheduleRetry({
      instance,
      payload,
      orderId,
      initialLimitPrice: payload.price,
      bufferPoints: Number.isFinite(bufferPoints) ? bufferPoints : 0,
      bufferPct,
      tickSize,
      strategy: payload.strategy || null,
      context: {
        request_type: 'TRADINGVIEW',
      },
    });
  }

  async _postWithRetries(target, body) {
    let attempt = 0;
    let lastError = null;

    while (attempt <= this.retries) {
      attempt += 1;
      const start = Date.now();

      try {
        const { ok, status, data } = await this._postJson(target.endpoint, body);
        const durationMs = Date.now() - start;

        if (ok) {
          return { ok: true, status, attempts: attempt, durationMs, data };
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
      const text = await res.text().catch(() => '');
      const data = text ? tryParseJson(text) : null;
      return { status, ok, data };
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
