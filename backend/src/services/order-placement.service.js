/**
 * Order Placement Service
 * Centralizes OpenAlgo placesmartorder calls with structured logging/context.
 * Includes validation to prevent invalid orders
 */

import openalgoClient from '../integrations/openalgo/client.js';
import { log } from '../core/logger.js';
import * as orderValidation from '../utils/order-validation.js';

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

    const response = await openalgoClient.placeSmartOrder(instance, payload);

    log.info('[OrderPlacement] placesmartorder response', {
      ...logContext,
      order_id: response?.orderid || response?.order_id,
      status: response?.status,
      message: response?.message,
    });

    return response;
  }
}

const orderPlacementService = new OrderPlacementService();
export default orderPlacementService;
