/**
 * Order Placement Service
 * Centralizes OpenAlgo placesmartorder calls with structured logging/context.
 */

import openalgoClient from '../integrations/openalgo/client.js';
import { log } from '../core/logger.js';

class OrderPlacementService {
  /**
   * Place a smart order via OpenAlgo with contextual logging.
   * @param {Object} instance - Instance config (contains api key, etc.)
   * @param {Object} payload - Payload passed directly to OpenAlgo
   * @param {Object} context - Optional metadata for log tracing
   * @returns {Promise<Object>} OpenAlgo response
   */
  async placeSmartOrder(instance, payload, context = {}) {
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
