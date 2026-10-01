import crypto from 'node:crypto';
import config from '../core/config.js';
import db from '../core/database.js';
import { log } from '../core/logger.js';
import { UnauthorizedError, ValidationError } from '../core/errors.js';
import { timingSafeEqualStr } from '../utils/sanitizers.js';
import watchlistService from './watchlist.service.js';
import watchlistSymbolService from './watchlist-symbol.service.js';
import orderService from './order.service.js';
import instanceService from './instance.service.js';
import marginSizingService from './margin-sizing.service.js';
import futuresRollService from './futures-roll.service.js';
import { withoutExpiredContracts } from '../integrations/openalgo/client.js';

// OpenAlgo v1 order constants (openalgo-docs api-documentation/v1/order-constants.md). The
// exchange list is VALID_EXCHANGES in full; OpenAlgo 400s anything else, and the connected
// broker's capabilities narrow it further downstream.
const ORDER_PARAMS = {
  exchanges: [
    'NSE', 'NFO', 'CDS', 'BSE', 'BFO', 'BCD', 'MCX', 'NCDEX', 'NCO',
    'NSE_INDEX', 'BSE_INDEX', 'MCX_INDEX', 'GLOBAL_INDEX', 'CRYPTO',
  ],
  products: ['CNC', 'MIS', 'NRML'],
  pricetypes: ['MARKET', 'LIMIT', 'SL', 'SL-M'],
  actions: ['BUY', 'SELL'],
};

const DEFAULT_PAYLOAD = {
  pricetype: 'MARKET',
  product: 'MIS',
  price: 0,
  trigger_price: 0,
  disclosed_quantity: 0,
};

const FORM_JSON_FIELDS = ['payload', 'data', 'json', 'message'];

const tryParseJson = (value) => {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

class TradingviewBroadcastService {
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

  assertAuthorized(token) {
    const expected = config.webhooks?.tradingviewBroadcast?.token || '';

    if (!expected) {
      throw new UnauthorizedError('Webhook token is not configured');
    }
    // Constant-time - this token is the sole authentication on an endpoint that places live
    // orders. See timingSafeEqualStr.
    if (!timingSafeEqualStr(token, expected)) {
      throw new UnauthorizedError('Invalid webhook token');
    }
  }

  /**
   * Replace the webhook token with a new random one. It is stored as a sensitive setting, which
   * config.load() reads ahead of WEBHOOK_TOKEN in .env, and takes effect at once - every alert
   * still carrying the old token is refused from this moment.
   */
  async rotateToken() {
    const token = crypto.randomBytes(24).toString('base64url');
    await db.run(
      `INSERT INTO application_settings (key, value, description, category, data_type, is_sensitive)
       VALUES ('webhooks.tradingview.token', ?, 'TradingView webhook token (rotated from Settings)', 'webhooks', 'string', 1)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, is_sensitive = 1, updated_at = CURRENT_TIMESTAMP`,
      [token]
    );
    config.webhooks.tradingviewBroadcast.token = token;
    log.warn('TradingView webhook token rotated - alerts using the old token are now refused');
    return token;
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

    // A priced order without its price went to every broker as a LIMIT at 0.
    if (['LIMIT', 'SL'].includes(normalized.pricetype) && !(normalized.price > 0)) {
      errors.push({ field: 'price', message: `price is required for ${normalized.pricetype} orders` });
    }
    if (['SL', 'SL-M'].includes(normalized.pricetype) && !(normalized.trigger_price > 0)) {
      errors.push({ field: 'trigger_price', message: `trigger_price is required for ${normalized.pricetype} orders` });
    }

    if (errors.length) {
      throw new ValidationError('Invalid TradingView payload', errors);
    }

    return normalized;
  }

  async broadcast(payload, options = {}) {
    const { watchlistId = null, watchlistSlug = null } = options;

    // A TradingView continuous-futures alert (NIFTY1!, CRUDEOIL2!) names a series, not a contract.
    // Brokers only know contracts, so resolve it to the one the series means today.
    let normalizedPayload = payload;
    const contract = await futuresRollService.resolveContinuousSymbol(payload.exchange, payload.symbol);
    if (contract === null) {
      throw new ValidationError(`No live ${payload.exchange} futures contract for ${payload.symbol}`);
    }
    if (contract !== payload.symbol) {
      log.info('[TV Webhook] Continuous symbol resolved', { from: payload.symbol, to: contract });
      normalizedPayload = { ...payload, symbol: contract };
    }
    // Broadcasts post straight to each instance, past the client's own expired-contract refusal.
    withoutExpiredContracts('placesmartorder', normalizedPayload);
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
        let quantity = normalizedPayload.quantity;

        // Sentinel: quantity === 0 on a MARGIN_BASED watchlist symbol means "size from margin"
        // for this specific target instance, instead of a fixed TradingView-supplied quantity.
        if (quantity === 0 && watchlist?.id && target?.instance_id) {
          quantity = await this._resolveMarginBasedWebhookQuantity(normalizedPayload, watchlist, target) ?? quantity;
        }

        // Per-instance multiplier is applied once, inside order.service.placeOrder (same as
        // every other order path) - not here too, which would double it.
        return this._dispatchToTarget(target, { ...normalizedPayload, quantity }, watchlist);
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

  /**
   * Dispatch one target through order.service.placeOrder - the same path and the same
   * watchlist_orders recording every other order source uses. This used to POST
   * placesmartorder straight to OpenAlgo over HTTP, bypassing openalgoClient entirely: no
   * circuit breaker, no rate limit, no ORDER_OUTCOME_UNKNOWN handling (so a timeout re-sent the
   * order instead of checking the broker's book first), no SEBI SL-M->SL conversion, no
   * broker-unit conversion, and no watchlist_orders row, so a broadcast order never showed up in
   * order history or on the chart. placeOrder also prices a MARKET order through
   * limit-price.service when the broker doesn't support MARKET, replacing this service's own
   * second, divergent LTP+buffer pricing.
   */
  async _dispatchToTarget(target, payload, watchlist = null) {
    if (!target.instance_id) {
      return { ok: false, status: null, error: 'Target has no instance configured', attempts: 0, durationMs: null };
    }

    const start = Date.now();
    try {
      const order = await orderService.placeOrder({
        instanceId: target.instance_id,
        watchlistId: watchlist?.id || null,
        exchange: payload.exchange,
        symbol: payload.symbol,
        action: payload.action,
        quantity: payload.quantity,
        position_size: payload.position_size,
        product: payload.product,
        pricetype: payload.pricetype,
        price: payload.price,
        trigger_price: payload.trigger_price,
        source: 'webhook',
        correlation_id: payload.strategy || null,
      });
      const durationMs = Date.now() - start;
      log.info('[TV Webhook] Downstream success', {
        target: target.name,
        order_id: order.order_id,
        status: order.status,
        duration_ms: durationMs,
      });
      return { ok: true, status: 200, attempts: 1, durationMs, data: { orderid: order.order_id, status: order.status } };
    } catch (error) {
      const durationMs = Date.now() - start;
      log.warn('[TV Webhook] Downstream failure', {
        target: target.name,
        error: error.message,
      });
      return { ok: false, status: error.statusCode || null, error: error.message, attempts: 1, durationMs };
    }
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
