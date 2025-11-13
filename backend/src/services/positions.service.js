/**
 * Positions Service
 * Fetches and aggregates positions from all active instances
 */

import db from '../core/database.js';
import log from '../core/logger.js';
import openalgoClient from '../integrations/openalgo/client.js';
import { parseFloatSafe, parseIntSafe } from '../utils/sanitizers.js';

class PositionsService {
  /**
   * Get positions from all active instances
   * @param {Object} options - Options for filtering
   * @param {boolean} options.onlyOpen - Only return open positions (quantity != 0)
   * @returns {Promise<Object>} - Grouped positions with totals
   */
  async getAllPositions(options = {}) {
    const { onlyOpen = false } = options;

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
        this._fetchInstancePositions(instance, onlyOpen)
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

  /**
   * Fetch positions from a single instance
   * @private
   * @param {Object} instance - Instance configuration
   * @param {boolean} onlyOpen - Only return open positions
   * @returns {Promise<Object>} - Positions data with totals
   */
  async _fetchInstancePositions(instance, onlyOpen = false) {
    try {
      log.debug('Fetching positions from instance', {
        instance_id: instance.id,
        instance_name: instance.name,
      });

      // Call OpenAlgo PositionBook endpoint
      const positions = await openalgoClient.getPositionBook(instance);

      if (!Array.isArray(positions)) {
        throw new Error('Invalid positionbook response');
      }

      // Filter positions if onlyOpen is true
      let filteredPositions = positions;
      if (onlyOpen) {
        filteredPositions = positions.filter(pos => {
          const qty = this._getPositionQuantity(pos);
          return qty !== 0;
        });
      }

      // Calculate totals
      const openPositions = positions.filter(pos => this._getPositionQuantity(pos) !== 0);
      const closedPositions = positions.filter(pos => this._getPositionQuantity(pos) === 0);

      // Calculate total P&L from positions
      // Some brokers return pnl field, some return mtm, some return realized_pnl + unrealized_pnl
      const totalPnL = positions.reduce((sum, pos) => {
        const pnl =
          parseFloatSafe(pos.pnl, 0) ||
          parseFloatSafe(pos.mtm, 0) ||
          parseFloatSafe(pos.realized_pnl, 0) + parseFloatSafe(pos.unrealized_pnl, 0);
        return sum + pnl;
      }, 0);

      log.debug('Fetched positions from instance', {
        instance_id: instance.id,
        instance_name: instance.name,
        total_positions: positions.length,
        open_positions: openPositions.length,
        closed_positions: closedPositions.length,
        total_pnl: totalPnL,
      });

      return {
        positions: filteredPositions,
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
