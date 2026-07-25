/**
 * Dashboard Service
 * Aggregates key metrics from all instances for dashboard display
 */

import db from '../core/database.js';
import { log } from '../core/logger.js';
import marketDataFeedService from './market-data-feed.service.js';
import { parseFloatSafe, parseIntSafe } from '../utils/sanitizers.js';
import { calculateTradebookPnL, calculateTradeChargesOpenAlgo } from '../utils/trade-pnl.js';
import { normalizeTradebookEntry } from '../utils/tradebook-utils.js';
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
      const hasTradebook = Array.isArray(tradebook) && tradebook.length > 0;

      // P&L: sum the broker's own per-position pnl directly instead of reconstructing it from
      // the tradebook. Reconstruction only ever sees whatever window the tradebook snapshot
      // covers (today's trades), which is wrong for multi-day carried (NRML) positions - the
      // position cache's pnl field is the broker's own authoritative number regardless of when
      // the position was actually opened. A position at qty=0 still carries its P&L for the day
      // (the broker keeps a zeroed-out row rather than dropping it) - that's realized; a position
      // still open is unrealized. Same field-name fallbacks used everywhere else in this codebase
      // (positions.service.js, strategy.service.js's getExecutionStatus, etc).
      //
      // IMPORTANT: the broker's pnl field is pure MTM - confirmed against real data (a closed
      // 280CE leg: short @5.90, covered @2.60, 1250 qty -> exactly 4125.00, zero deduction) - no
      // brokerage/exchange fee/STT/GST subtracted. Charges don't need FIFO/position matching the
      // way P&L does (every trade incurs its own cost the moment it executes, whether it opens or
      // closes a position), so they're summed straight from today's tradebook and netted against
      // the realized side - unrealized stays gross MTM since a still-open position's eventual
      // exit cost isn't known yet (same convention most trading platforms use).
      const positionSnapshot = marketDataFeedService.getPositionSnapshot(instance.id);
      const positions = Array.isArray(positionSnapshot?.data) ? positionSnapshot.data : null;

      let realizedPnL = 0;
      let unrealizedPnL = 0;
      let totalPnL;
      if (positions) {
        for (const position of positions) {
          const qty = parseFloatSafe(
            position.quantity ?? position.netqty ?? position.net_quantity ?? position.netQty ?? position.net,
            0
          );
          const pnl = parseFloatSafe(
            position.pnl ?? position.unrealised_pnl ?? position.unrealisedPnl ?? position.mtm,
            0
          );
          if (qty === 0) {
            realizedPnL += pnl;
          } else {
            unrealizedPnL += pnl;
          }
        }

        if (hasTradebook) {
          const brokerageValue = resolveBrokerageValue(
            instance.broker,
            brokerageConfig?.brokerageMap || {},
            brokerageConfig?.defaultBrokerage ?? 20
          );
          let chargesTotal = 0;
          for (const trade of tradebook) {
            const normalized = normalizeTradebookEntry(trade);
            const side = (normalized.action || '').toUpperCase();
            const tradeValue = Math.abs(parseFloatSafe(normalized.trade_value, 0));
            if ((side !== 'BUY' && side !== 'SELL') || !tradeValue) continue;
            chargesTotal += calculateTradeChargesOpenAlgo(tradeValue, {
              exchange: normalized.exchange,
              symbol: normalized.symbol,
              side,
              brokerage: brokerageValue,
            }).total_cost;
          }
          realizedPnL = Number((realizedPnL - chargesTotal).toFixed(2));
        }

        totalPnL = Number((realizedPnL + unrealizedPnL).toFixed(2));
      } else {
        // Position cache never warmed for this instance (e.g. just added, or feed unhealthy) -
        // fall back to the last value persisted on the instance row rather than showing 0.
        totalPnL = parseFloatSafe(instance.total_pnl, 0);
      }

      // Trade counts/turnover are activity stats ("how many trades today"), not P&L - the
      // same-day tradebook window is correct for these, no FIFO matching needed.
      const tradeStats = hasTradebook ? calculateTradebookPnL(tradebook) : null;
      const totalTradeValue = hasTradebook
        ? tradeStats.buy_value + tradeStats.sell_value
        : parseFloatSafe(instance.total_trade_value, 0);
      const totalBuyTrades = hasTradebook
        ? tradeStats.buy_count
        : parseIntSafe(instance.total_buy_trades, 0);
      const totalSellTrades = hasTradebook
        ? tradeStats.sell_count
        : parseIntSafe(instance.total_sell_trades, 0);

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
        await marketDataFeedService.refreshPositionsForInstance(instance.id, { force: true });
      })
    );
  }
}

export default new DashboardService();
