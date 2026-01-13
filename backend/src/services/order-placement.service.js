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

class OrderPlacementService {
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
      const effectivePriceType = payload.pricetype || 'MARKET';

      if (effectivePriceType === 'MARKET') {
        throw new ValidationError('MARKET orders are disabled; LIMIT price is required');
      }

      if (effectivePriceType !== 'MARKET') {
        // For LIMIT, SL, SL-M orders, price validation is required
        orderValidation.validatePrice(payload.price, effectivePriceType);
      }

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

    let response;
    try {
      response = await openalgoClient.placeSmartOrder(instance, payload, {
        skipRateLimit: context?.skipRateLimit === true,
      });
    } catch (error) {
      const statusCode = Number.isFinite(error?.statusCode) ? error.statusCode : null;
      const shouldRecover = statusCode !== null && statusCode >= 500;
      if (shouldRecover) {
        const recovered = await this._recoverOrderFromOrderbook(instance, payload);
        if (recovered) {
          log.warn('[OrderPlacement] Order inferred from orderbook after error', {
            instance_id: instance?.id,
            symbol: payload?.symbol,
            exchange: payload?.exchange,
            action: payload?.action,
            quantity: payload?.quantity,
            order_id: recovered.orderid || recovered.order_id,
          });
          return recovered;
        }
      }
      throw error;
    }

    log.info('[OrderPlacement] placesmartorder response', {
      ...logContext,
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

  async _recoverOrderFromOrderbook(instance, payload) {
    try {
      const orderbook = await openalgoClient.getOrderBook(instance);
      const orders = Array.isArray(orderbook)
        ? orderbook
        : orderbook?.orders || orderbook?.data || [];
      if (!Array.isArray(orders) || orders.length === 0) {
        return null;
      }

      const now = Date.now();
      const targetSymbol = (payload.symbol || '').toUpperCase();
      const targetExchange = (payload.exchange || '').toUpperCase();
      const targetAction = (payload.action || '').toUpperCase();
      const targetQty = Number(payload.quantity);

      const parseTimestamp = (order) => {
        const raw =
          order.timestamp ||
          order.order_timestamp ||
          order.time ||
          order.created_at ||
          order.last_updated;
        if (!raw) return null;
        if (typeof raw === 'number') {
          return raw > 1e12 ? raw : raw * 1000;
        }
        const parsed = Date.parse(raw);
        return Number.isNaN(parsed) ? null : parsed;
      };

      const isRecent = (order) => {
        const ts = parseTimestamp(order);
        if (!ts) return true;
        return now - ts <= 2 * 60 * 1000;
      };

      const matches = orders.filter((order) => {
        const symbol = (order.symbol || order.tradingsymbol || order.trading_symbol || '').toUpperCase();
        const exchange = (order.exchange || order.exch || order.brexchange || '').toUpperCase();
        const action = (order.action || order.side || '').toUpperCase();
        const qty = Number(order.quantity || order.qty || order.order_quantity);

        if (targetSymbol && symbol && symbol !== targetSymbol) return false;
        if (targetExchange && exchange && exchange !== targetExchange) return false;
        if (targetAction && action && action !== targetAction) return false;
        if (Number.isFinite(targetQty) && Number.isFinite(qty) && qty !== targetQty) return false;
        return isRecent(order);
      });

      if (!matches.length) {
        return null;
      }

      const pick = matches.sort((a, b) => {
        const ta = parseTimestamp(a) || 0;
        const tb = parseTimestamp(b) || 0;
        return tb - ta;
      })[0];

      return {
        status: 'success',
        orderid: pick.orderid || pick.order_id || pick.id,
        order_id: pick.orderid || pick.order_id || pick.id,
        message: 'Order inferred from orderbook after OpenAlgo error',
        recovered: true,
      };
    } catch (error) {
      log.warn('[OrderPlacement] Orderbook recovery failed', {
        instance_id: instance?.id,
        error: error.message,
      });
      return null;
    }
  }
}

const orderPlacementService = new OrderPlacementService();
export default orderPlacementService;
