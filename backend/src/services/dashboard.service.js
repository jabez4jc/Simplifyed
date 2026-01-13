/**
 * Dashboard Service
 * Aggregates key metrics from all instances for dashboard display
 */

import db from '../core/database.js';
import { log } from '../core/logger.js';
import marketDataFeedService from './market-data-feed.service.js';
import { parseFloatSafe, parseIntSafe } from '../utils/sanitizers.js';
import { calculateTradebookPnLClosedOnly } from '../utils/trade-pnl.js';
import settingsService from './settings.service.js';
import { buildBrokerageMap, resolveBrokerageValue } from '../utils/brokerage.js';

class DashboardService {
  /**
   * Get aggregated dashboard metrics from all instances
   * Groups instances by analyzer_mode (Live vs Analyzer)
   * @returns {Promise<Object>} - Dashboard metrics grouped by mode
   */
  async getDashboardMetrics({ refresh = false } = {}) {
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

      if (refresh) {
        await this._refreshInstanceSnapshots(instances);
      }

      const brokerageConfig = await this._getBrokerageConfig();

      // Fetch cached metrics from all instances in parallel
      const instanceFunds = await Promise.allSettled(
        instances.map(instance => this._fetchInstanceFunds(instance, brokerageConfig))
      );

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
            total_trade_value: funds.total_trade_value,
            total_buy_trades: funds.total_buy_trades,
            total_sell_trades: funds.total_sell_trades,
            error: null,
          };

          // Group by is_analyzer_mode
          if (instance.is_analyzer_mode) {
            analyzerMetrics.instances.push(instanceData);
            analyzerMetrics.total_available_balance += funds.available_balance;
            analyzerMetrics.total_realized_pnl += funds.realized_pnl;
            analyzerMetrics.total_unrealized_pnl += funds.unrealized_pnl;
            analyzerMetrics.total_pnl += funds.total_pnl;
            analyzerMetrics.total_trade_value += funds.total_trade_value;
            analyzerMetrics.total_buy_trades += funds.total_buy_trades;
            analyzerMetrics.total_sell_trades += funds.total_sell_trades;
          } else {
            liveMetrics.instances.push(instanceData);
            liveMetrics.total_available_balance += funds.available_balance;
            liveMetrics.total_realized_pnl += funds.realized_pnl;
            liveMetrics.total_unrealized_pnl += funds.unrealized_pnl;
            liveMetrics.total_pnl += funds.total_pnl;
            liveMetrics.total_trade_value += funds.total_trade_value;
            liveMetrics.total_buy_trades += funds.total_buy_trades;
            liveMetrics.total_sell_trades += funds.total_sell_trades;
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
            total_trade_value: 0,
            total_buy_trades: 0,
            total_sell_trades: 0,
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
  async _fetchInstanceFunds(instance, brokerageConfig) {
    try {
      log.debug('Fetching funds from instance', {
        instance_id: instance.id,
        instance_name: instance.name,
      });

      const cache = marketDataFeedService.getFundsSnapshot(instance.id);
      const fundsResponse = cache?.data;

      // Parse funds fields - different brokers may use different field names
      const availableBalance =
        fundsResponse
          ? (fundsResponse.availablecash != null
              ? parseFloatSafe(fundsResponse.availablecash, 0)
              : parseFloatSafe(fundsResponse.available_cash, 0) ||
                parseFloatSafe(fundsResponse.availableBalance, 0) ||
                0)
          : parseFloatSafe(instance.current_balance, 0);

      const tradeSnap = marketDataFeedService.getTradebookSnapshotCached(instance.id);
      const tradebook = tradeSnap?.data || [];
      const brokerageValue = resolveBrokerageValue(
        instance.broker,
        brokerageConfig?.brokerageMap || {},
        brokerageConfig?.defaultBrokerage ?? 20
      );
      const tradePnl = calculateTradebookPnLClosedOnly(Array.isArray(tradebook) ? tradebook : [], {
        brokerageValue,
      });
      const hasTradebook = Array.isArray(tradebook) && tradebook.length > 0;
      const totalPnL = hasTradebook
        ? Number(tradePnl.net_pnl.toFixed(2))
        : parseFloatSafe(instance.total_pnl, 0);
      const totalTradeValue = hasTradebook
        ? tradePnl.buy_value + tradePnl.sell_value
        : parseFloatSafe(instance.total_trade_value, 0);
      const totalBuyTrades = hasTradebook
        ? tradePnl.buy_count
        : parseIntSafe(instance.total_buy_trades, 0);
      const totalSellTrades = hasTradebook
        ? tradePnl.sell_count
        : parseIntSafe(instance.total_sell_trades, 0);
      const realizedPnL = 0;
      const unrealizedPnL = 0;

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
        total_trade_value: totalTradeValue,
        total_buy_trades: totalBuyTrades,
        total_sell_trades: totalSellTrades,
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
      total_trade_value: 0,
      total_buy_trades: 0,
      total_sell_trades: 0,
    };
  }

  async _getBrokerageConfig() {
    try {
      const [byBroker, defaultBrokerage] = await Promise.all([
        settingsService.getSetting('brokerage.by_broker').catch(() => null),
        settingsService.getSetting('brokerage.default').catch(() => null),
      ]);

      return {
        brokerageMap: buildBrokerageMap(byBroker?.value),
        defaultBrokerage: Number.isFinite(defaultBrokerage?.value) ? defaultBrokerage.value : 20,
      };
    } catch (error) {
      log.warn('Failed to load brokerage config, falling back to defaults', { error: error.message });
      return {
        brokerageMap: {},
        defaultBrokerage: 20,
      };
    }
  }

  async _refreshInstanceSnapshots(instances) {
    await Promise.allSettled(
      instances.map(async (instance) => {
        await marketDataFeedService.refreshFundsForInstance(instance.id, { force: true });
        await marketDataFeedService.getTradebookSnapshot(instance.id, { force: true });
      })
    );
  }
}

export default new DashboardService();
