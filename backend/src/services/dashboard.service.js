/**
 * Dashboard Service
 * Aggregates key metrics from all instances for dashboard display
 */

import db from '../core/database.js';
import { log } from '../core/logger.js';
import openalgoClient from '../integrations/openalgo/client.js';
import { parseFloatSafe } from '../utils/sanitizers.js';

class DashboardService {
  /**
   * Get aggregated dashboard metrics from all instances
   * Groups instances by analyzer_mode (Live vs Analyzer)
   * @returns {Promise<Object>} - Dashboard metrics grouped by mode
   */
  async getDashboardMetrics() {
    try {
      // Get all active instances
      const instances = await db.all(
        'SELECT * FROM instances WHERE is_active = 1 ORDER BY name ASC'
      );

      if (instances.length === 0) {
        return {
          live: this._getEmptyMetrics(),
          analyzer: this._getEmptyMetrics(),
        };
      }

      // Fetch funds from all instances in parallel
      const fundsPromises = instances.map(instance =>
        this._fetchInstanceFunds(instance)
      );

      const instanceFunds = await Promise.allSettled(fundsPromises);

      // Separate Live and Analyzer instances
      const liveMetrics = this._getEmptyMetrics();
      const analyzerMetrics = this._getEmptyMetrics();

      instanceFunds.forEach((promiseResult, index) => {
        const instance = instances[index];

        if (promiseResult.status === 'fulfilled') {
          const funds = promiseResult.value;
          const instanceData = {
            instance_id: instance.id,
            instance_name: instance.name,
            broker: instance.broker,
            health_status: instance.health_status,
            available_balance: funds.available_balance,
            realized_pnl: funds.realized_pnl,
            unrealized_pnl: funds.unrealized_pnl,
            total_pnl: funds.total_pnl,
            error: null,
          };

          // Group by is_analyzer_mode
          if (instance.is_analyzer_mode) {
            analyzerMetrics.instances.push(instanceData);
            analyzerMetrics.total_available_balance += funds.available_balance;
            analyzerMetrics.total_realized_pnl += funds.realized_pnl;
            analyzerMetrics.total_unrealized_pnl += funds.unrealized_pnl;
            analyzerMetrics.total_pnl += funds.total_pnl;
          } else {
            liveMetrics.instances.push(instanceData);
            liveMetrics.total_available_balance += funds.available_balance;
            liveMetrics.total_realized_pnl += funds.realized_pnl;
            liveMetrics.total_unrealized_pnl += funds.unrealized_pnl;
            liveMetrics.total_pnl += funds.total_pnl;
          }
        } else {
          // Include failed instances with error message
          const instanceData = {
            instance_id: instance.id,
            instance_name: instance.name,
            broker: instance.broker,
            health_status: instance.health_status,
            available_balance: 0,
            realized_pnl: 0,
            unrealized_pnl: 0,
            total_pnl: 0,
            error: promiseResult.reason?.message || 'Failed to fetch funds',
          };

          if (instance.is_analyzer_mode) {
            analyzerMetrics.instances.push(instanceData);
          } else {
            liveMetrics.instances.push(instanceData);
          }
        }
      });

      return {
        live: liveMetrics,
        analyzer: analyzerMetrics,
      };
    } catch (error) {
      log.error('Failed to get dashboard metrics', error);
      throw error;
    }
  }

  /**
   * Fetch funds from a single instance
   * @private
   * @param {Object} instance - Instance configuration
   * @returns {Promise<Object>} - Funds data
   */
  async _fetchInstanceFunds(instance) {
    try {
      log.debug('Fetching funds from instance', {
        instance_id: instance.id,
        instance_name: instance.name,
      });

      // Call OpenAlgo Funds endpoint
      const funds = await openalgoClient.getFunds(instance);

      // Parse funds fields - different brokers may use different field names
      const availableBalance =
        funds.availablecash != null
          ? parseFloatSafe(funds.availablecash, 0)
          : parseFloatSafe(funds.available_cash, 0) ||
            parseFloatSafe(funds.availableBalance, 0) ||
            0;

      const realizedPnL =
        funds.m2mrealized != null
          ? parseFloatSafe(funds.m2mrealized, 0)
          : parseFloatSafe(funds.m2m_realized, 0) ||
            parseFloatSafe(funds.realizedPnL, 0) ||
            parseFloatSafe(funds.realized_pnl, 0) ||
            0;

      const unrealizedPnL =
        funds.m2munrealized != null
          ? parseFloatSafe(funds.m2munrealized, 0)
          : parseFloatSafe(funds.m2m_unrealized, 0) ||
            parseFloatSafe(funds.unrealizedPnL, 0) ||
            parseFloatSafe(funds.unrealized_pnl, 0) ||
            0;

      const totalPnL = realizedPnL + unrealizedPnL;

      log.debug('Fetched funds from instance', {
        instance_id: instance.id,
        instance_name: instance.name,
        available_balance: availableBalance,
        realized_pnl: realizedPnL,
        unrealized_pnl: unrealizedPnL,
        total_pnl: totalPnL,
      });

      return {
        available_balance: availableBalance,
        realized_pnl: realizedPnL,
        unrealized_pnl: unrealizedPnL,
        total_pnl: totalPnL,
      };
    } catch (error) {
      log.error('Failed to fetch funds from instance', error, {
        instance_id: instance.id,
        instance_name: instance.name,
      });
      throw error;
    }
  }

  /**
   * Get empty metrics structure
   * @private
   * @returns {Object} - Empty metrics
   */
  _getEmptyMetrics() {
    return {
      instances: [],
      total_available_balance: 0,
      total_realized_pnl: 0,
      total_unrealized_pnl: 0,
      total_pnl: 0,
    };
  }
}

export default new DashboardService();
