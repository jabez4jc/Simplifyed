/**
 * Order Placement Service
 * Centralizes OpenAlgo placesmartorder calls with structured logging/context.
 * Includes validation to prevent invalid orders
 */

import openalgoClient from '../integrations/openalgo/client.js';
import { log } from '../core/logger.js';
import * as orderValidation from '../utils/order-validation.js';
import { ValidationError } from '../core/errors.js';
import orderRetryService from './order-retry.service.js';
import marketDataFeedService from './market-data-feed.service.js';
import { extractLtp } from '../utils/price-extraction.js';
import brokerCapabilitiesService from './broker-capabilities.service.js';
import limitPriceService from './limit-price.service.js';
import { requiresLimitOrders } from '../utils/broker-type.util.js';

// ponytail: fixed 0.5% stop protection band; make it a setting if it needs tuning per segment.
const SLM_PROTECTION_PCT = 0.005;
import { normalizeSymbolKey, normalizeExchange, normalizeProduct } from '../utils/symbol-parsing.util.js';
import { cancelOpenOrdersForSymbol, roundToTick } from '../utils/order-helpers.js';

class OrderPlacementService {
  constructor() {
    this.instanceQueues = new Map(); // instanceId -> queue
    this.instanceInFlight = new Set(); // instanceId
    this.unknownKeySeed = 0;
  }

  /**
   * Place a smart order via OpenAlgo with contextual logging and validation.
   * @param {Object} instance - Instance config (contains api key, etc.)
   * @param {Object} payload - Payload passed directly to OpenAlgo
   * @param {Object} context - Optional metadata for log tracing
   * @returns {Promise<Object>} OpenAlgo response
   */
  async placeSmartOrder(instance, payload, context = {}) {
    // CRITICAL: Validate order parameters before placing order
    try {
      // Exchange-aware: false for every Indian exchange (SEBI limit-only), whatever the broker says.
      const supportsMarketOrders = await brokerCapabilitiesService.supportsMarketOrders(instance?.broker, payload?.exchange);

      // Validate required fields
      orderValidation.validateSymbol(payload.symbol);
      orderValidation.validateExchange(payload.exchange);
      orderValidation.validateAction(payload.action);

      // Validate quantity (basic validation - always required)
      const validatedQty = orderValidation.validateQuantity(
        payload.quantity,
        payload.action
      );

      // Validate price based on order type
      // Default to MARKET if pricetype is undefined (per order-payload.factory.js defaults)
      let effectivePriceType = (payload.pricetype || 'MARKET').toUpperCase();

      // SEBI: Indian brokers take no SL-M from algos. Convert it to a stop-loss LIMIT (SL) that
      // fills like SL-M would, but with a bounded worst price.
      if (effectivePriceType === 'SL-M' && requiresLimitOrders(payload.exchange)) {
        payload = await this._convertStopMarketToStopLimit(payload, context);
        effectivePriceType = 'SL';
      }

      // A LIMIT order is sent as a LIMIT. There is deliberately no LIMIT -> MARKET conversion.
      //
      // There used to be one, gated only on the broker supporting market orders, and it rewrote
      // the order to `pricetype: MARKET, price: '0'`. Its intent was to undo the app's OWN
      // detour: callers that mean "fill now" price a marketable LIMIT off the quote when the
      // broker has no MARKET support. But that detour is only ever taken when market orders are
      // NOT supported (see quick-order.service._resolveOrderTypeForInstance), so the branch
      // could never fire for a synthesised limit - the only orders that reached it were limits
      // the OPERATOR chose, which is precisely the case it must not touch. A chart right-click
      // "Buy Limit @ 64,190.76" was turned into an immediate market fill.
      //
      // order.service.js guards this at its own layer (see its RESTING_TYPES check); this layer
      // was silently undoing that decision one call later. See Test/integration/orders.test.js.

      if (supportsMarketOrders && effectivePriceType === 'MARKET') {
        payload = {
          ...payload,
          price: '0',
        };
      }

      if (!supportsMarketOrders && effectivePriceType === 'MARKET') {
        payload = await this._convertMarketToLimit(payload, { ...context, instance });
        effectivePriceType = (payload.pricetype || 'LIMIT').toUpperCase();
        if (effectivePriceType === 'MARKET' && requiresLimitOrders(payload.exchange)) {
          throw new ValidationError(
            `No price available for ${payload.exchange}:${payload.symbol} - order refused rather than sent as MARKET (SEBI limit-only)`
          );
        }
        if (effectivePriceType === 'MARKET') {
          payload = { ...payload, price: '0' };
        }
      }

      // For LIMIT, SL, SL-M orders, price validation is required
      orderValidation.validatePrice(payload.price, effectivePriceType);

      // Update payload with validated quantity
      payload.quantity = validatedQty;

    } catch (validationError) {
      log.error('[OrderPlacement] Validation failed', {
        instance_id: instance?.id,
        symbol: payload?.symbol,
        exchange: payload?.exchange,
        action: payload?.action,
        quantity: payload?.quantity,
        error: validationError.message
      });
      throw validationError;
    }

    const logContext = {
      instance_id: instance?.id,
      instance_name: instance?.name,
      ...context,
      resolved_symbol: payload?.symbol,
      exchange: payload?.exchange,
      action: payload?.action,
      product: payload?.product,
      quantity: payload?.quantity,
      position_size: payload?.position_size,
    };

    log.info('[OrderPlacement] Dispatching placesmartorder', logContext);

    return this._enqueuePlacement(instance, payload, context);
  }

  /**
   * A plain resting order at the caller's own price (placeorder). No position target, no
   * coalescing with other orders for the symbol, no retry chase - it must stay where it was put.
   * SEBI still applies: an SL-M for an Indian exchange goes out as SL, and the client refuses any
   * MARKET there.
   */
  async placeRestingOrder(instance, payload, context = {}) {
    orderValidation.validateSymbol(payload.symbol);
    orderValidation.validateExchange(payload.exchange);
    orderValidation.validateAction(payload.action);
    const quantity = orderValidation.validateQuantity(payload.quantity, payload.action);
    let order = { ...payload, quantity };
    delete order.position_size;
    let type = String(order.pricetype || '').toUpperCase();
    if (type === 'SL-M' && requiresLimitOrders(order.exchange)) {
      order = await this._convertStopMarketToStopLimit(order, context);
      type = 'SL';
    }
    orderValidation.validatePrice(order.price, type);
    log.info('[OrderPlacement] Dispatching resting placeorder', {
      instance_id: instance?.id, symbol: order.symbol, exchange: order.exchange,
      action: order.action, quantity: order.quantity, pricetype: type, price: order.price,
      trigger_price: order.trigger_price, ...context,
    });
    return openalgoClient.placeOrder(instance, order);
  }

  _enqueuePlacement(instance, payload, context = {}) {
    if (!instance?.id) {
      return Promise.reject(new ValidationError('Instance is required for order placement'));
    }

    const instanceId = instance.id;
    const queue = this._getQueue(instanceId);
    const symbolKey = this._symbolKey(payload)
      || `__unknown__:${Date.now()}:${++this.unknownKeySeed}`;

    // A queued request is replaced by a later one for the same symbol ONLY when both come from the
    // same origin (same strategy tag, request type and source): two different callers must never
    // have one's payload silently swapped for the other's. Different origins queue separately.
    const origin = this._originKey(payload, context);

    return new Promise((resolve, reject) => {
      const existing = queue.find(
        (entry) => entry.symbolKey === symbolKey && entry.origin === origin && !entry.started
      );
      if (existing) {
        existing.payload = payload;
        existing.context = context;
        existing.resolvers.push({ resolve, reject });
        existing.coalesced = (existing.coalesced || 0) + 1;
        log.info('[OrderPlacement] Coalesced placement request', {
          instance_id: instanceId,
          symbol: payload?.symbol,
          exchange: payload?.exchange,
          coalesced_count: existing.coalesced,
        });
        return;
      }

      queue.push({
        instance,
        payload,
        context,
        symbolKey,
        origin,
        started: false,
        resolvers: [{ resolve, reject }],
        coalesced: 0,
      });

      this._drainQueue(instanceId).catch(() => {});
    });
  }

  async _drainQueue(instanceId) {
    if (this.instanceInFlight.has(instanceId)) return;
    const queue = this._getQueue(instanceId);
    const entry = queue.shift();
    if (!entry) return;

    this.instanceInFlight.add(instanceId);
    entry.started = true;

    try {
      if (entry.context?.cancelOpenOrdersBeforePlacement === true) {
        await this._cancelOpenOrdersForSymbol(entry.instance, entry.payload, entry.context);
      }
      const response = await this._performPlacement(entry.instance, entry.payload, entry.context);
      entry.resolvers.forEach(({ resolve }) => resolve(response));
    } catch (error) {
      entry.resolvers.forEach(({ reject }) => reject(error));
    } finally {
      this.instanceInFlight.delete(instanceId);
      if (queue.length > 0) {
        setTimeout(() => this._drainQueue(instanceId), 0);
      }
    }
  }

  async _performPlacement(instance, payload, context = {}) {
    // No order-book guessing on error: the client's _awaitOrderInBook already resolves an unknown
    // outcome before it throws, so whatever propagates from here is final.
    const response = await openalgoClient.placeSmartOrder(instance, payload);

    log.info('[OrderPlacement] placesmartorder response', {
      instance_id: instance?.id,
      instance_name: instance?.name,
      resolved_symbol: payload?.symbol,
      exchange: payload?.exchange,
      action: payload?.action,
      product: payload?.product,
      quantity: payload?.quantity,
      position_size: payload?.position_size,
      order_id: response?.orderid || response?.order_id,
      status: response?.status,
      message: response?.message,
    });

    const orderId = response?.orderid || response?.order_id;
    const shouldScheduleRetry = !context?.skipRetry && orderId;
    const effectivePriceType = (payload.pricetype || 'MARKET').toUpperCase();
    if (shouldScheduleRetry && effectivePriceType === 'LIMIT') {
      orderRetryService.scheduleRetry({
        instance,
        payload,
        orderId,
        initialLimitPrice: payload.price,
        bufferPoints: context.limitBufferPoints ?? 0,
        bufferPct: context.limitBufferPct ?? null,
        tickSize: context.tickSize ?? null,
        strategy: payload.strategy || context.strategy || null,
        context,
        allowPartialRetry: context.allowPartialRetry ?? true,
        repeatUntilClosed: Object.prototype.hasOwnProperty.call(context, 'repeatUntilClosed')
          ? context.repeatUntilClosed
          : null,
        ignoreSlippage: Object.prototype.hasOwnProperty.call(context, 'ignoreSlippage')
          ? context.ignoreSlippage
          : null,
      });
    }

    return response;
  }

  _getQueue(instanceId) {
    if (!this.instanceQueues.has(instanceId)) {
      this.instanceQueues.set(instanceId, []);
    }
    return this.instanceQueues.get(instanceId);
  }

  async _cancelOpenOrdersForSymbol(instance, payload, context = {}) {
    if (!instance?.id || !payload?.symbol || !payload?.exchange) return;

    let snapshot;
    try {
      snapshot = await marketDataFeedService.getOrderbookSnapshot(instance.id, { force: true });
    } catch (error) {
      log.warn('[OrderPlacement] Orderbook fetch failed before cancel', {
        instance_id: instance.id,
        error: error.message,
      });
      return;
    }

    const raw = snapshot?.data || [];
    const orders = Array.isArray(raw) ? raw : raw.orders || raw.data || [];
    await cancelOpenOrdersForSymbol(instance, orders, payload, payload.strategy || context.strategy);
  }

  /**
   * SL-M -> SL for Indian exchanges. Limit = trigger -/+ the caller's buffer, else a protection
   * band of SLM_PROTECTION_PCT of the trigger, rounded AWAY from the trigger to the tick so the
   * stop still fills through a fast move. SELL stops (long exits) sit below, BUY stops above.
   */
  async _convertStopMarketToStopLimit(payload, context = {}) {
    const trigger = Number(payload?.trigger_price);
    const side = (payload?.action || '').toUpperCase();
    if (!Number.isFinite(trigger) || trigger <= 0) {
      throw new ValidationError(`SL-M order for ${payload?.exchange}:${payload?.symbol} has no trigger price`);
    }
    if (!['BUY', 'SELL'].includes(side)) {
      throw new ValidationError(`Invalid action for SL-M conversion: ${payload?.action}`);
    }
    const given = Number(context?.limitBufferPoints);
    const buffer = Number.isFinite(given) && given > 0 ? given : trigger * SLM_PROTECTION_PCT;
    const tickSize = context?.tickSize ?? await limitPriceService.resolveTickSize(payload.exchange, payload.symbol);
    const raw = side === 'BUY' ? trigger + buffer : trigger - buffer;
    const price = roundToTick(raw > 0 ? raw : trigger, tickSize, side);
    log.info('[OrderPlacement] SL-M converted to SL (SEBI)', {
      exchange: payload.exchange, symbol: payload.symbol, action: side, trigger, price,
    });
    return { ...payload, pricetype: 'SL', price };
  }

  async _convertMarketToLimit(payload, context = {}) {
    const exchange = payload?.exchange;
    const symbol = payload?.symbol;
    const side = (payload?.action || '').toUpperCase();
    if (!exchange || !symbol) {
      throw new ValidationError('Exchange and symbol are required to convert MARKET orders');
    }
    if (!['BUY', 'SELL'].includes(side)) {
      throw new ValidationError(`Invalid action for MARKET conversion: ${payload?.action}`);
    }

    // Pricing the limit ourselves is an optimisation over OpenAlgo's own MARKET -> LIMIT
    // conversion, which uses a wider buffer. With no LTP from the feed or the ordering instance,
    // the payload comes back as MARKET: placeSmartOrder refuses it for Indian exchanges (SEBI
    // limit-only) and only crypto goes through unconverted.
    let ltpResult = null;
    try {
      ltpResult = await marketDataFeedService.fetchLtpForSymbol(exchange, symbol, {
        orderCritical: true,
        forOrder: true,
      });
    } catch (quoteError) {
      log.warn('[OrderPlacement] Feed LTP lookup failed', {
        exchange, symbol, action: side, error: quoteError.message,
      });
    }

    const ltp = ltpResult?.ltp || extractLtp(ltpResult?.quote, { forOrder: true })
      || await limitPriceService.instanceLtp(context?.instance, exchange, symbol);
    if (!ltp || ltp <= 0) {
      log.warn('[OrderPlacement] No LTP - sending MARKET unconverted', {
        exchange, symbol, action: side,
      });
      return payload;
    }

    let bufferPoints = Number(context?.limitBufferPoints);
    if (!Number.isFinite(bufferPoints) || bufferPoints <= 0) {
      const bufferPct = Number(context?.limitBufferPct);
      bufferPoints = Number.isFinite(bufferPct) && bufferPct > 0
        ? ltp * (bufferPct / 100)
        : 0;
    }

    let price = side === 'BUY' ? ltp + bufferPoints : ltp - bufferPoints;
    if (!Number.isFinite(price) || price <= 0) {
      price = ltp;
    }

    const tickSize = context?.tickSize ?? await limitPriceService.resolveTickSize(exchange, symbol);
    price = roundToTick(price, tickSize, side);

    log.info('[OrderPlacement] MARKET converted to LIMIT', {
      exchange,
      symbol,
      action: side,
      ltp,
      bufferPoints,
      price,
    });

    return {
      ...payload,
      pricetype: 'LIMIT',
      price,
    };
  }

  _originKey(payload, context) {
    return `${context?.source ?? ''}|${context?.request_type ?? ''}|${payload?.strategy ?? ''}`;
  }

  _symbolKey(payload) {
    const exchange = normalizeExchange(payload?.exchange);
    const symbol = normalizeSymbolKey(payload?.symbol);
    const product = normalizeProduct(payload?.product);
    if (!exchange || !symbol) return null;
    return product ? `${exchange}|${symbol}|${product}` : `${exchange}|${symbol}`;
  }
}

const orderPlacementService = new OrderPlacementService();
export default orderPlacementService;
