/**
 * Quick Order History Service
 * Persistence/CRUD for the quick_orders table (record, list, stats, broker-status sync) plus the
 * order-summary helpers used to build human-friendly success/failure messages. Extracted from
 * quick-order.service.js - pure DB access and formatting, no order-placement logic or shared
 * caches, so it carries no coupling to the rest of that file.
 */

import { log } from '../core/logger.js';
import db from '../core/database.js';
import orderRepository from './order-repository.js';
import marketDataFeedService from './market-data-feed.service.js';
import { NotFoundError } from '../core/errors.js';
import { toISTDate, toISTISOString } from '../utils/time.js';

class QuickOrderHistoryService {
  async recordQuickOrder(orderData) {
    try {
      await orderRepository.insertQuickOrder(orderData);

      log.debug('Quick order recorded in database', {
        order_id: orderData.order_id,
        symbol: orderData.symbol,
      });

    } catch (error) {
      log.error('Failed to record quick order', error);
      // Non-fatal - order was still placed
    }
  }

  buildFailurePayloadSummary(orderParams = {}, symbol = {}) {
    return {
      action: orderParams.action,
      trade_mode: orderParams.tradeMode,
      order_type: orderParams.orderType || 'LIMIT',
      quantity: orderParams.quantity ?? null,
      product: orderParams.product ?? null,
      price: orderParams.price ?? null,
      expiry: orderParams.expiry ?? null,
      options_leg: orderParams.optionsLeg ?? symbol.options_strike_selection ?? null,
      operating_mode: orderParams.operatingMode ?? null,
      strike_policy: orderParams.strikePolicy ?? null,
      step_lots: orderParams.stepLots ?? null,
      trigger_type: orderParams.triggerType ?? null,
    };
  }

  extractErrorCode(error) {
    if (!error) return null;
    return (
      error.code ||
      error.errorCode ||
      error.statusCode ||
      error.name ||
      null
    );
  }

  async recordFailedQuickOrder({ instance, symbol, orderParams, error, attempt = null }) {
    try {
      const errorCode = this.extractErrorCode(error);
      const statusCode = Number.isFinite(error?.statusCode) ? error.statusCode : null;
      const payloadSummary = this.buildFailurePayloadSummary(orderParams, symbol);
      const metadata = {
        payload_summary: payloadSummary,
        instance: {
          id: instance?.id ?? null,
          name: instance?.name ?? null,
        },
        error_code: errorCode,
        status_code: statusCode,
        attempt,
      };

      await this.recordQuickOrder({
        watchlist_id: symbol?.watchlist_id ?? null,
        symbol_id: symbol?.id ?? null,
        instance_id: instance?.id,
        underlying: symbol?.underlying_symbol || symbol?.symbol || 'UNKNOWN',
        symbol: symbol?.symbol || 'UNKNOWN',
        exchange: symbol?.exchange || 'UNKNOWN',
        action: orderParams?.action || 'UNKNOWN',
        trade_mode: orderParams?.tradeMode || 'UNKNOWN',
        options_leg: orderParams?.optionsLeg ?? symbol?.options_strike_selection ?? null,
        quantity: orderParams?.quantity ?? 0,
        product: orderParams?.product ?? null,
        order_type: orderParams?.orderType || 'LIMIT',
        price: orderParams?.price ?? null,
        trigger_price: null,
        resolved_symbol: null,
        strike_price: null,
        option_type: null,
        expiry_date: orderParams?.expiry ?? null,
        status: 'failed',
        order_id: null,
        message: error?.message || 'Order failed',
        error_details: JSON.stringify({
          code: errorCode,
          statusCode,
          message: error?.message || null,
        }),
        metadata,
        user_id: orderParams?.userId ?? null,
        source: orderParams?.source ?? null,
        trigger_type: orderParams?.triggerType ?? null,
        request_id: orderParams?.requestId ?? null,
        correlation_id: orderParams?.correlationId ?? null,
      });
    } catch (recordError) {
      log.warn('Failed to persist failed quick order', {
        instance_id: instance?.id,
        symbol_id: symbol?.id,
        error: recordError?.message,
      });
    }
  }

  /**
   * Map action/button to a human-friendly BUY/SELL side for summaries.
   */
  deriveSideForSummary(action = '') {
    const act = (action || '').toUpperCase();
    const buyActions = new Set([
      'BUY',
      'COVER', // close short -> buy
      'BUY_CE',
      'BUY_PE',
      'INCREASE_CE',
      'INCREASE_PE',
    ]);
    const sellActions = new Set([
      'SELL',
      'SHORT',
      'EXIT', // flatten -> sell from perspective of summary
      'EXIT_ALL',
      'CLOSE_ALL_CE',
      'CLOSE_ALL_PE',
      'REDUCE_CE',
      'REDUCE_PE',
      'SELL_CE',
      'SELL_PE',
    ]);

    if (buyActions.has(act)) return 'BUY';
    if (sellActions.has(act)) return 'SELL';
    return act || 'UNKNOWN';
  }

  /**
   * Pick the best symbol/exchange to display in the summary.
   * Priority:
   * 1) first success with resolved_symbol
   * 2) first success with symbol
   * 3) any result with resolved_symbol
   * 4) any result with symbol
   * 5) fallback to watchlist symbol/exchange
   */
  pickSummaryInstrument(results, fallbackSymbol, fallbackExchange) {
    const pick = (arr, key) => {
      const hit = arr.find(r => r && r[key]);
      return hit ? hit[key] : null;
    };

    const successes = results.filter(r => r && r.success);
    const any = results || [];

    const symResolvedSuccess = pick(successes, 'resolved_symbol');
    const symSuccess = pick(successes, 'symbol');
    const symResolvedAny = pick(any, 'resolved_symbol');
    const symAny = pick(any, 'symbol');

    const exchResolvedSuccess = pick(successes, 'exchange');
    const exchSuccess = pick(successes, 'exchange');
    const exchResolvedAny = pick(any, 'exchange');
    const exchAny = pick(any, 'exchange');

    return {
      summarySymbol: symResolvedSuccess || symSuccess || symResolvedAny || symAny || fallbackSymbol,
      summaryExchange: exchResolvedSuccess || exchSuccess || exchResolvedAny || exchAny || fallbackExchange,
    };
  }

  /**
   * Get quick orders with filters
   * @param {Object} filters - Query filters
   * @param {number} filters.instanceId - Filter by instance ID
   * @param {string} filters.symbol - Filter by symbol
   * @param {string} filters.tradeMode - Filter by trade mode
   * @param {string} filters.action - Filter by action
   * @param {number} filters.limit - Limit results
   * @param {number} filters.offset - Offset for pagination
   * @returns {Promise<Array<Object>>} Quick orders
   */
  async getQuickOrders(filters = {}) {
    try {
      let query = 'SELECT * FROM quick_orders WHERE 1=1';
      const params = [];

      if (filters.instanceId) {
        query += ' AND instance_id = ?';
        params.push(filters.instanceId);
      }

      if (filters.symbol) {
        query += ' AND underlying = ?';
        params.push(filters.symbol);
      }

      if (filters.tradeMode) {
        query += ' AND trade_mode = ?';
        params.push(filters.tradeMode);
      }

      if (filters.action) {
        query += ' AND action = ?';
        params.push(filters.action);
      }

      if (filters.exchange) {
        query += ' AND exchange = ?';
        params.push(filters.exchange);
      }

      query += ' ORDER BY created_at DESC';

      if (filters.limit) {
        query += ' LIMIT ?';
        params.push(filters.limit);
      }

      if (filters.offset) {
        query += ' OFFSET ?';
        params.push(filters.offset);
      }

      const orders = await db.all(query, params);

      log.debug('Retrieved quick orders', {
        count: orders.length,
        filters,
      });

      return orders;
    } catch (error) {
      log.error('Failed to get quick orders', error);
      throw error;
    }
  }

  async syncQuickOrdersForInstance(instanceId, { days = 7 } = {}) {
    const parsedDays = Number.isFinite(days) ? days : parseInt(days, 10);
    const windowDays = Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : 7;
    const snapshot = await marketDataFeedService.getOrderbookSnapshot(instanceId, { force: true });
    const payload = snapshot?.data || [];
    const orders = Array.isArray(payload) ? payload : payload.orders || payload.data || [];

    const normalizeStatus = (value) => {
      const normalized = (value || '').toString().toLowerCase();
      if (!normalized) return null;
      if (['open', 'pending'].includes(normalized)) return normalized;
      if (['complete', 'completed', 'filled'].includes(normalized)) return 'complete';
      if (['cancelled', 'canceled'].includes(normalized)) return 'cancelled';
      if (['rejected'].includes(normalized)) return 'rejected';
      return normalized;
    };

    const statusMap = new Map();
    for (const order of orders) {
      const orderId = order?.orderid || order?.order_id || order?.id;
      if (!orderId) continue;
      const rawStatus = order?.order_status || order?.status || order?.orderStatus || null;
      statusMap.set(String(orderId), {
        broker_status: rawStatus ? String(rawStatus) : null,
        status: normalizeStatus(rawStatus),
      });
    }

    const rows = await db.all(
      `SELECT id, order_id, status
       FROM quick_orders
       WHERE instance_id = ?
         AND order_id IS NOT NULL
         AND created_at >= datetime('now', ?)`,
      [instanceId, `-${windowDays} days`]
    );

    let updated = 0;
    for (const row of rows) {
      const entry = statusMap.get(String(row.order_id));
      if (!entry) continue;
      const nextStatus = entry.status || row.status;
      await db.run(
        `UPDATE quick_orders
         SET broker_status = ?, status = ?, last_sync_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [entry.broker_status, nextStatus, row.id]
      );
      updated += 1;
    }

    return {
      instance_id: instanceId,
      total_checked: rows.length,
      updated,
      skipped: rows.length - updated,
      fetched_at: snapshot?.fetchedAt || Date.now(),
    };
  }

  /**
   * Get quick order by ID
   * @param {number} id - Quick order ID
   * @returns {Promise<Object>} Quick order
   */
  async getQuickOrderById(id) {
    try {
      const order = await db.get(
        'SELECT * FROM quick_orders WHERE id = ?',
        [id]
      );

      if (!order) {
        throw new NotFoundError(`Quick order with ID ${id} not found`);
      }

      log.debug('Retrieved quick order', { id });

      return order;
    } catch (error) {
      log.error('Failed to get quick order by ID', error);
      throw error;
    }
  }

  /**
   * Get quick order statistics
   * @param {Object} filters - Query filters
   * @param {number} filters.instanceId - Filter by instance ID
   * @param {string} filters.symbol - Filter by symbol
   * @param {number} filters.days - Number of days to include (default: 7)
   * @returns {Promise<Object>} Statistics
   */
  async getQuickOrderStats(filters = {}) {
    try {
      const days = filters.days || 7;
      const sinceDate = toISTDate();
      sinceDate.setDate(sinceDate.getDate() - days);
      const sinceDateStr = toISTISOString(sinceDate);

      let query = `
        SELECT
          COUNT(*) as total_orders,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful_orders,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as failed_orders,
          COUNT(DISTINCT instance_id) as instances_used,
          COUNT(DISTINCT underlying) as unique_symbols,
          trade_mode,
          COUNT(*) as count
        FROM quick_orders
        WHERE created_at >= ?
      `;
      const params = [sinceDateStr];

      if (filters.instanceId) {
        query += ' AND instance_id = ?';
        params.push(filters.instanceId);
      }

      if (filters.symbol) {
        query += ' AND underlying = ?';
        params.push(filters.symbol);
      }

      query += ' GROUP BY trade_mode';

      const tradeModeCounts = await db.all(query, params);

      // Get overall stats
      let overallQuery = `
        SELECT
          COUNT(*) as total_orders,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful_orders,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as failed_orders,
          COUNT(DISTINCT instance_id) as instances_used,
          COUNT(DISTINCT underlying) as unique_symbols
        FROM quick_orders
        WHERE created_at >= ?
      `;
      const overallParams = [sinceDateStr];

      if (filters.instanceId) {
        overallQuery += ' AND instance_id = ?';
        overallParams.push(filters.instanceId);
      }

      if (filters.symbol) {
        overallQuery += ' AND underlying = ?';
        overallParams.push(filters.symbol);
      }

      const overall = await db.get(overallQuery, overallParams);

      // Get action breakdown
      let actionQuery = `
        SELECT
          action,
          COUNT(*) as count,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as failed
        FROM quick_orders
        WHERE created_at >= ?
      `;
      const actionParams = [sinceDateStr];

      if (filters.instanceId) {
        actionQuery += ' AND instance_id = ?';
        actionParams.push(filters.instanceId);
      }

      if (filters.symbol) {
        actionQuery += ' AND underlying = ?';
        actionParams.push(filters.symbol);
      }

      actionQuery += ' GROUP BY action ORDER BY count DESC';

      const actionBreakdown = await db.all(actionQuery, actionParams);

      const stats = {
        period: {
          days,
          since: sinceDateStr,
        },
        overall: {
          total: overall.total_orders || 0,
          successful: overall.successful_orders || 0,
          failed: overall.failed_orders || 0,
          successRate:
            overall.total_orders > 0
              ? ((overall.successful_orders / overall.total_orders) * 100).toFixed(2)
              : '0.00',
          instancesUsed: overall.instances_used || 0,
          uniqueSymbols: overall.unique_symbols || 0,
        },
        byTradeMode: tradeModeCounts.map(tm => ({
          tradeMode: tm.trade_mode,
          count: tm.count,
        })),
        byAction: actionBreakdown.map(ab => ({
          action: ab.action,
          count: ab.count,
          successful: ab.successful,
          failed: ab.failed,
          successRate: ab.count > 0 ? ((ab.successful / ab.count) * 100).toFixed(2) : '0.00',
        })),
      };

      log.debug('Retrieved quick order stats', { days, filters });

      return stats;
    } catch (error) {
      log.error('Failed to get quick order stats', error);
      throw error;
    }
  }
}

const quickOrderHistoryService = new QuickOrderHistoryService();
export default quickOrderHistoryService;
export { QuickOrderHistoryService };
