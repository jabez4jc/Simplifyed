/**
 * Positions Service
 * Fetches and aggregates positions from all active instances
 */

import db from '../core/database.js';
import log from '../core/logger.js';
import openalgoClient from '../integrations/openalgo/client.js';
import marketDataFeedService from './market-data-feed.service.js';
import { parseFloatSafe, parseIntSafe } from '../utils/sanitizers.js';
import { extractAveragePrice, extractLtp } from '../utils/price-extraction.js';

class PositionsService {
  /**
   * Get positions from all active instances
   * @param {Object} options - Options for filtering
   * @param {boolean} options.onlyOpen - Only return open positions (quantity != 0)
   * @returns {Promise<Object>} - Grouped positions with totals
   */
  async getAllPositions(options = {}) {
    const { onlyOpen = false, refresh = true } = options;

    try {
      // Get all active instances
      const instances = await db.all(
        'SELECT * FROM instances WHERE is_active = 1 ORDER BY name ASC'
      );

      if (instances.length === 0) {
        return {
          instances: [],
          overall_total_pnl: 0,
          overall_open_positions: 0,
          overall_closed_positions: 0,
        };
      }

      // Fetch positions from all instances in parallel
      const positionsPromises = instances.map(instance =>
        this._fetchInstancePositions(instance, onlyOpen, refresh)
      );

      const instancePositions = await Promise.allSettled(positionsPromises);

      // Build response with instance grouping
      const result = {
        instances: [],
        overall_total_pnl: 0,
        overall_open_positions: 0,
        overall_closed_positions: 0,
      };

      instancePositions.forEach((promiseResult, index) => {
        const instance = instances[index];

        if (promiseResult.status === 'fulfilled') {
          const data = promiseResult.value;
          result.instances.push({
            instance_id: instance.id,
            instance_name: instance.name,
            broker: instance.broker,
            health_status: instance.health_status,
            is_analyzer_mode: !!instance.is_analyzer_mode,
            positions: data.positions,
            total_pnl: data.total_pnl,
            open_positions_count: data.open_positions_count,
            closed_positions_count: data.closed_positions_count,
            error: null,
          });

          result.overall_total_pnl += data.total_pnl;
          result.overall_open_positions += data.open_positions_count;
          result.overall_closed_positions += data.closed_positions_count;
        } else {
          // Include failed instances with error message
          result.instances.push({
            instance_id: instance.id,
            instance_name: instance.name,
            broker: instance.broker,
            health_status: instance.health_status,
            is_analyzer_mode: !!instance.is_analyzer_mode,
            positions: [],
            total_pnl: 0,
            open_positions_count: 0,
            closed_positions_count: 0,
            error: promiseResult.reason?.message || 'Failed to fetch positions',
          });

          log.warn('Failed to fetch positions from instance', {
            instance_id: instance.id,
            instance_name: instance.name,
            error: promiseResult.reason?.message,
          });
        }
      });

      // Cross-instance median LTP fallback for missing entry_price per symbol/exchange
      const ltpBySymbol = new Map();
      result.instances.forEach(inst => {
        (inst.positions || []).forEach(pos => {
          const entry = pos.entry_price;
          const ltp = extractLtp(pos);
          const key = this._symbolKey(pos);
          if (entry && entry > 0 && ltp && ltp > 0 && key) {
            if (!ltpBySymbol.has(key)) ltpBySymbol.set(key, []);
            ltpBySymbol.get(key).push(ltp);
          }
        });
      });

      result.instances = result.instances.map(inst => ({
        ...inst,
        positions: (inst.positions || []).map(pos => {
          if (pos.entry_price && pos.entry_price > 0) return pos;
          const key = this._symbolKey(pos);
          const ltps = key ? ltpBySymbol.get(key) : null;
          if (ltps && ltps.length > 0) {
            const medianLtp = this._median(ltps);
            return { ...pos, entry_price: medianLtp, entry_price_source: 'median_ltp' };
          }
          return pos;
        }),
      }));

      return result;
    } catch (error) {
      log.error('Failed to get all positions', error);
      throw error;
    }
  }

  /**
   * Normalize quantity field from position object
   * Different brokers use different field names for quantity
   * @private
   * @param {Object} pos - Position object
   * @returns {number} - Normalized quantity value
   */
  _getPositionQuantity(pos) {
    // Try various field names used by different brokers
    const rawQty = pos.quantity ?? pos.netqty ?? pos.net_quantity ?? pos.netQty ?? pos.net ?? 0;
    return parseIntSafe(rawQty, 0);
  }

  _resolveEntryPrice(pos, instanceId) {
    const direct =
      extractAveragePrice(pos) ??
      pos.avg_price ??
      pos.net_avg_price ??
      pos.average_price ??
      pos.avgPrice;
    if (direct && direct > 0) return { price: direct, source: 'broker_avg', capturedAt: null };

    // Fallback captured at manual order placement
    const fallback = marketDataFeedService.getFallbackEntryPrice(
      instanceId,
      pos.exchange || pos.exch || pos.brexchange,
      pos.symbol || pos.tradingsymbol || pos.trading_symbol
    );
    if (fallback?.price && fallback.price > 0) {
      return {
        price: fallback.price,
        source: fallback.source || 'fallback_cache',
        capturedAt: fallback.capturedAt || null,
      };
    }

    // As a last resort, if LTP exists and qty is zero (flat), return null
    return { price: null, source: null, capturedAt: null };
  }

  _median(values = []) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  _symbolKey(pos) {
    const exchange = (pos.exchange || pos.exch || pos.brexchange || '').replace(/\s+/g, '').toUpperCase();
    const symbol = (pos.symbol || pos.tradingsymbol || pos.trading_symbol || '').replace(/\s+/g, '').toUpperCase();
    if (!exchange || !symbol) return null;
    return `${exchange}|${symbol}`;
  }

  _resolveLtp(pos) {
    const direct = extractLtp(pos);
    if (direct && direct > 0) return direct;

    const exchange = pos.exchange || pos.exch || pos.brexchange;
    const symbol = pos.symbol || pos.tradingsymbol || pos.trading_symbol;
    if (!exchange || !symbol) return null;

    // Use cached quotes with aggressive TTL suitable for order/tracking views
    const { cached } = marketDataFeedService.getCachedQuotesForSymbols(
      [{ exchange, symbol }],
      { orderCritical: true }
    );
    if (cached?.length) {
      const ltp = extractLtp(cached[0]);
      if (ltp && ltp > 0) return ltp;
    }

    return null;
  }

  /**
   * Fetch positions from a single instance
   * @private
   * @param {Object} instance - Instance configuration
   * @param {boolean} onlyOpen - Only return open positions
   * @returns {Promise<Object>} - Positions data with totals
   */
  async _fetchInstancePositions(instance, onlyOpen = false, refresh = true) {
    try {
      log.debug('Fetching positions from instance', {
        instance_id: instance.id,
        instance_name: instance.name,
      });

      const cache = marketDataFeedService.getPositionSnapshot(instance.id);
      if (!cache && !refresh) {
        return {
          positions: [],
          total_pnl: 0,
          open_positions_count: 0,
          closed_positions_count: 0,
        };
      }

      const positionBook = cache?.data || await openalgoClient.getPositionBook(instance);
      if (!cache && refresh) {
        marketDataFeedService.setPositionSnapshot(instance.id, positionBook);
      }

      if (!Array.isArray(positionBook)) {
        throw new Error('Invalid positionbook response');
      }

      // Filter positions if onlyOpen is true
      let filteredPositions = positionBook;
      if (onlyOpen) {
        filteredPositions = positionBook.filter(pos => {
          const qty = this._getPositionQuantity(pos);
          return qty !== 0;
        });
      }

      // Enrich positions with derived entry price (including fallback) and resolved LTP
      const enrichedPositions = filteredPositions.map(pos => {
        const { price: entryPrice, source: entryPriceSource, capturedAt: entryCapturedAt } =
          this._resolveEntryPrice(pos, instance.id);
        const ltpResolved = this._resolveLtp(pos);
        const qty = this._getPositionQuantity(pos);
        const derivedPnl =
          entryPrice && ltpResolved && qty
            ? (ltpResolved - entryPrice) * qty
            : null;
        return {
          ...pos,
          entry_price: entryPrice,
          entry_price_source: entryPriceSource,
          entry_price_captured_at: entryCapturedAt,
          ltp_resolved: ltpResolved,
          pnl_derived: derivedPnl,
        };
      });

      // Calculate totals
      const openPositions = positionBook.filter(pos => this._getPositionQuantity(pos) !== 0);
      const closedPositions = positionBook.filter(pos => this._getPositionQuantity(pos) === 0);

      // Calculate total P&L from positions
      // Some brokers return pnl field, some return mtm, some return realized_pnl + unrealized_pnl
      // Use explicit null/undefined checks to preserve zero values (0 is a valid P&L)
      const totalPnL = positionBook.reduce((sum, pos) => {
        const pnl =
          pos.pnl != null ? parseFloatSafe(pos.pnl, 0) :
          pos.mtm != null ? parseFloatSafe(pos.mtm, 0) :
          parseFloatSafe(pos.realized_pnl, 0) + parseFloatSafe(pos.unrealized_pnl, 0);
        return sum + pnl;
      }, 0);

      log.debug('Fetched positions from instance', {
        instance_id: instance.id,
        instance_name: instance.name,
        total_positions: filteredPositions.length,
        open_positions: openPositions.length,
        closed_positions: closedPositions.length,
        total_pnl: totalPnL,
      });

      return {
        positions: enrichedPositions,
        total_pnl: totalPnL,
        open_positions_count: openPositions.length,
        closed_positions_count: closedPositions.length,
      };
    } catch (error) {
      log.error('Failed to fetch positions from instance', error, {
        instance_id: instance.id,
        instance_name: instance.name,
      });
      throw error;
    }
  }

  /**
   * Get positions for a specific instance
   * @param {number} instanceId - Instance ID
   * @param {Object} options - Options for filtering
   * @returns {Promise<Object>} - Positions data
   */
  async getInstancePositions(instanceId, options = {}) {
    try {
      const instance = await db.get('SELECT * FROM instances WHERE id = ?', [instanceId]);

      if (!instance) {
        throw new Error(`Instance ${instanceId} not found`);
      }

      if (!instance.is_active) {
        throw new Error(`Instance ${instanceId} is not active`);
      }

      const data = await this._fetchInstancePositions(instance, options.onlyOpen);

      return {
        instance_id: instance.id,
        instance_name: instance.name,
        broker: instance.broker,
        health_status: instance.health_status,
        ...data,
      };
    } catch (error) {
      log.error('Failed to get instance positions', error, { instanceId });
      throw error;
    }
  }
}

export default new PositionsService();
