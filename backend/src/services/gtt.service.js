/**
 * GTT (Good-Till-Triggered) Service
 * Thin wrapper over the broker-side GTT API - an opt-in alternative to AutoExitService's
 * polling-based target/stoploss for CNC/NRML positions (GTT does not support MIS product).
 */

import db from '../core/database.js';
import { log } from '../core/logger.js';
import { ValidationError } from '../core/errors.js';
import openalgoClient from '../integrations/openalgo/client.js';

const GTT_UNSUPPORTED_PRODUCTS = ['MIS'];

class GttService {
  /**
   * Place a broker-side OCO GTT (stoploss + target legs) for a position.
   * @param {Object} instance
   * @param {Object} params - { strategy, exchange, symbol, action, product, quantity,
   *   entryPrice, stoplossPoints, targetPoints, watchlistId, symbolId, strategyLegId }
   */
  async placeExitGtt(instance, params) {
    const { product } = params;
    if (GTT_UNSUPPORTED_PRODUCTS.includes(String(product || '').toUpperCase())) {
      throw new ValidationError('GTT does not support MIS product - use polling-based exits for MIS positions');
    }
    if (!params.stoplossPoints && !params.targetPoints) {
      throw new ValidationError('At least one of stoplossPoints/targetPoints is required for a GTT exit');
    }

    const direction = params.action === 'BUY' ? 1 : -1;
    const stoplossPrice = params.stoplossPoints
      ? params.entryPrice - direction * params.stoplossPoints
      : null;
    const targetPrice = params.targetPoints
      ? params.entryPrice + direction * params.targetPoints
      : null;

    const isOco = stoplossPrice != null && targetPrice != null;
    const exitAction = params.action === 'BUY' ? 'SELL' : 'BUY';

    const payload = {
      strategy: params.strategy || 'gtt-exit',
      trigger_type: isOco ? 'OCO' : 'SINGLE',
      exchange: params.exchange,
      symbol: params.symbol,
      action: exitAction,
      product,
      quantity: params.quantity,
      pricetype: 'MARKET',
      price: 0,
    };

    if (isOco) {
      payload.triggerprice_sl = stoplossPrice;
      payload.triggerprice_tg = targetPrice;
      payload.stoploss = null;
      payload.target = null;
    } else {
      const triggerPrice = stoplossPrice ?? targetPrice;
      payload.triggerprice_sl = stoplossPrice ?? 0;
      payload.triggerprice_tg = targetPrice ?? 0;
    }

    const response = await openalgoClient.placeGttOrder(instance, payload);
    if (response?.status !== 'success' || !response?.trigger_id) {
      throw new Error(response?.message || 'GTT placement failed');
    }

    await db.run(
      `INSERT INTO gtt_orders
        (instance_id, watchlist_id, symbol_id, strategy_leg_id, trigger_id, exchange, symbol, trigger_type, status, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      [
        instance.id,
        params.watchlistId || null,
        params.symbolId || null,
        params.strategyLegId || null,
        response.trigger_id,
        params.exchange,
        params.symbol,
        isOco ? 'OCO' : 'SINGLE',
        JSON.stringify({ stoplossPrice, targetPrice, entryPrice: params.entryPrice }),
      ]
    );

    log.info('GTT exit placed', {
      instanceId: instance.id, symbol: params.symbol, triggerId: response.trigger_id, triggerType: isOco ? 'OCO' : 'SINGLE',
    });

    return { triggerId: response.trigger_id, stoplossPrice, targetPrice };
  }

  async listActiveGtts(instanceId) {
    const instance = await this._getInstance(instanceId);
    const brokerGtts = await openalgoClient.getGttOrderBook(instance);
    return Array.isArray(brokerGtts) ? brokerGtts : [];
  }

  async cancelGtt(instanceId, triggerId) {
    const instance = await this._getInstance(instanceId);
    const response = await openalgoClient.cancelGttOrder(instance, {
      strategy: 'gtt-exit',
      trigger_id: triggerId,
    });
    if (response?.status !== 'success') {
      throw new Error(response?.message || 'GTT cancellation failed');
    }
    await db.run(`UPDATE gtt_orders SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE trigger_id = ?`, [triggerId]);
    return response;
  }

  async _getInstance(instanceId) {
    const instance = await db.get('SELECT * FROM instances WHERE id = ?', [instanceId]);
    if (!instance) {
      throw new ValidationError('Instance not found');
    }
    return instance;
  }
}

const gttService = new GttService();
export default gttService;
