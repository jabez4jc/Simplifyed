/**
 * Margin Sizing Service
 * Computes an order quantity from available account margin instead of a fixed qty_value,
 * mirroring AlgoMirror's dynamic lot-sizing / margin-utilization-grade concept.
 */

import { log } from '../core/logger.js';
import marketDataFeedService from './market-data-feed.service.js';
import openalgoClient from '../integrations/openalgo/client.js';
import riskEventsService from './risk-events.service.js';

const DEFAULT_UTILIZATION_PCT = 0.4; // Conservative default if not configured

class MarginSizingService {
  /**
   * @param {Object} params
   * @param {Object} params.instance - target broker instance
   * @param {Object} params.symbolConfig - watchlist_symbols row (margin_utilization_pct, max_margin_per_trade, lot_size)
   * @param {Object} params.orderContext - { exchange, symbol, action, product, orderType, price }
   * @param {number} [params.watchlistId]
   * @returns {Promise<{quantity: number, lots: number, perLotMargin: number, availableForTrade: number}>}
   */
  async computeLotQuantity({ instance, symbolConfig, orderContext, watchlistId = null }) {
    if (!instance || !symbolConfig || !orderContext) {
      throw new Error('computeLotQuantity requires instance, symbolConfig and orderContext');
    }

    const lotSize = Number(symbolConfig.lot_size) > 0 ? Number(symbolConfig.lot_size) : 1;
    const utilizationPct = symbolConfig.margin_utilization_pct > 0
      ? Number(symbolConfig.margin_utilization_pct)
      : DEFAULT_UTILIZATION_PCT;
    const maxMarginPerTrade = symbolConfig.max_margin_per_trade > 0
      ? Number(symbolConfig.max_margin_per_trade)
      : Infinity;

    const fundsSnapshot = marketDataFeedService.getFundsSnapshot(instance.id);
    const availableCash = Number(fundsSnapshot?.data?.availablecash);
    if (!fundsSnapshot || !Number.isFinite(availableCash) || availableCash <= 0) {
      throw new Error('No available margin data for instance; cannot compute margin-based quantity');
    }

    const perLotMargin = await this._resolvePerLotMargin(instance, orderContext, lotSize);
    if (!Number.isFinite(perLotMargin) || perLotMargin <= 0) {
      throw new Error('Unable to resolve per-lot margin requirement');
    }

    const availableForTrade = Math.min(availableCash * utilizationPct, maxMarginPerTrade);
    const lots = Math.floor(availableForTrade / perLotMargin);
    const quantity = Math.max(lots, 0) * lotSize;

    if (quantity <= 0) {
      log.warn('Margin-based sizing resolved to zero quantity', {
        instanceId: instance.id,
        symbol: orderContext.symbol,
        availableCash,
        utilizationPct,
        perLotMargin,
      });
    }

    await riskEventsService.record({
      instanceId: instance.id,
      watchlistId,
      symbolId: symbolConfig.id,
      exchange: orderContext.exchange,
      symbol: orderContext.symbol,
      eventType: 'MARGIN_SIZE_COMPUTED',
      newValue: quantity,
      metadata: {
        availableCash,
        utilizationPct,
        maxMarginPerTrade: Number.isFinite(maxMarginPerTrade) ? maxMarginPerTrade : null,
        perLotMargin,
        lotSize,
        lots,
        availableForTrade,
      },
    });

    return { quantity, lots, perLotMargin, availableForTrade };
  }

  async _resolvePerLotMargin(instance, orderContext, lotSize) {
    const positions = [
      {
        exchange: orderContext.exchange,
        symbol: orderContext.symbol,
        action: orderContext.action || 'BUY',
        quantity: lotSize,
        product: orderContext.product || 'MIS',
        pricetype: orderContext.orderType || 'MARKET',
        price: orderContext.price || 0,
      },
    ];

    const marginResponse = await openalgoClient.calculateMargin(instance, positions);
    const perLotMargin = Number(
      marginResponse?.margin ?? marginResponse?.required_margin ?? marginResponse?.total_margin
    );
    return perLotMargin;
  }
}

const marginSizingService = new MarginSizingService();
export default marginSizingService;
