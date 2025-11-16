/**
 * Fill Aggregator Service
 * Tracks real-time positions by polling tradebook and orderbook from OpenAlgo instances
 *
 * Responsibilities:
 * - Poll tradebook/orderbook every 2 seconds
 * - Aggregate fills by symbol per instance
 * - Calculate net_qty (buys - sells)
 * - Calculate weighted average entry price
 * - Track best_favorable_price for TSL
 * - Update leg_state table
 * - Detect position changes for risk engine
 *
 * Features:
 * - Per-instance position tracking
 * - Weighted average entry calculation
 * - Fill-by-fill aggregation
 * - Restart-safe (rebuilds from tradebook)
 * - Idempotent updates
 */

import db from '../core/database.js';
import { log } from '../core/logger.js';
import { config } from '../core/config.js';
import openalgoClient from '../integrations/openalgo/client.js';

class FillAggregatorService {
  constructor() {
    this.pollingInterval = null;
    this.isRunning = false;
  }

  /**
   * Start fill aggregation polling
   * @param {number} intervalMs - Polling interval in milliseconds (default: 2000)
   */
  start(intervalMs = 2000) {
    if (this.isRunning) {
      log.warn('Fill aggregator already running');
      return;
    }

    if (!config.features.enableFillAggregator) {
      log.warn('Fill aggregator disabled by feature flag');
      return;
    }

    this.isRunning = true;

    log.info('Starting fill aggregator', { interval_ms: intervalMs });

    // Initial sync
    this.syncAllInstances().catch(err => {
      log.error('Initial fill sync failed', err);
    });

    // Start polling
    this.pollingInterval = setInterval(() => {
      this.syncAllInstances().catch(err => {
        log.error('Fill sync failed', err);
      });
    }, intervalMs);

    log.info('Fill aggregator started', { interval_ms: intervalMs });
  }

  /**
   * Stop fill aggregation polling
   */
  stop() {
    if (!this.isRunning) {
      return;
    }

    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }

    this.isRunning = false;
    log.info('Fill aggregator stopped');
  }

  /**
   * Sync fills for all active instances
   */
  async syncAllInstances() {
    try {
      // Get all active instances
      const instances = await db.all(
        'SELECT * FROM instances WHERE is_active = 1'
      );

      if (instances.length === 0) {
        return;
      }

      // Sync each instance in parallel (but limit concurrency)
      const syncPromises = instances.map(instance =>
        this.syncInstanceFills(instance.id).catch(err => {
          log.error('Failed to sync fills for instance', err, {
            instance_id: instance.id,
            instance_name: instance.name,
          });
          return null;
        })
      );

      await Promise.all(syncPromises);
    } catch (error) {
      log.error('Failed to sync all instances', error);
    }
  }

  /**
   * Sync fills for a specific instance
   * @param {number} instanceId - Instance ID
   * @returns {Promise<Object>} - Sync summary
   */
  async syncInstanceFills(instanceId) {
    try {
      // Get instance
      const instance = await db.get(
        'SELECT * FROM instances WHERE id = ?',
        [instanceId]
      );

      if (!instance) {
        throw new Error(`Instance ${instanceId} not found`);
      }

      // Skip if analyzer mode
      if (instance.is_analyzer_mode) {
        log.debug('Skipping analyzer mode instance', {
          instance_id: instanceId,
        });
        return { skipped: true, reason: 'analyzer_mode' };
      }

      // Fetch tradebook from OpenAlgo
      const tradebook = await openalgoClient.getTradeBook(instance);

      if (!tradebook || !Array.isArray(tradebook)) {
        log.warn('Invalid tradebook response', {
          instance_id: instanceId,
          response: tradebook,
        });
        return { error: 'invalid_tradebook' };
      }

      // Group trades by symbol
      const tradesBySymbol = this._groupTradesBySymbol(tradebook);

      // Update leg_state for each symbol
      const updatePromises = [];
      for (const [symbolKey, trades] of Object.entries(tradesBySymbol)) {
        const { symbol, exchange } = this._parseSymbolKey(symbolKey);
        updatePromises.push(
          this.updateLegState(instanceId, symbol, exchange, trades)
        );
      }

      await Promise.all(updatePromises);

      log.debug('Fills synced for instance', {
        instance_id: instanceId,
        symbols_count: Object.keys(tradesBySymbol).length,
      });

      return {
        success: true,
        instance_id: instanceId,
        symbols_updated: Object.keys(tradesBySymbol).length,
      };
    } catch (error) {
      log.error('Failed to sync instance fills', error, { instanceId });
      throw error;
    }
  }

  /**
   * Update leg_state for a symbol based on trades
   * @param {number} instanceId - Instance ID
   * @param {string} symbol - Symbol
   * @param {string} exchange - Exchange
   * @param {Array} trades - Array of trades
   */
  async updateLegState(instanceId, symbol, exchange, trades) {
    try {
      // Calculate aggregates from trades
      const aggregates = this._calculateAggregates(trades);

      // Get existing leg_state
      const existing = await db.get(
        'SELECT * FROM leg_state WHERE instance_id = ? AND symbol = ? AND exchange = ?',
        [instanceId, symbol, exchange]
      );

      if (existing) {
        // Update existing leg_state
        await this._updateExistingLegState(existing.id, aggregates);
      } else {
        // Create new leg_state
        await this._createLegState(instanceId, symbol, exchange, aggregates, trades[0]);
      }

      log.debug('Leg state updated', {
        instance_id: instanceId,
        symbol,
        exchange,
        net_qty: aggregates.net_qty,
      });
    } catch (error) {
      log.error('Failed to update leg state', error, {
        instanceId,
        symbol,
        exchange,
      });
      throw error;
    }
  }

  /**
   * Get current leg state for a symbol
   * @param {string} symbol - Symbol
   * @param {string} exchange - Exchange
   * @param {number} instanceId - Instance ID
   * @returns {Promise<Object|null>} - Leg state or null
   */
  async getLegState(symbol, exchange, instanceId) {
    return await db.get(
      'SELECT * FROM leg_state WHERE symbol = ? AND exchange = ? AND instance_id = ?',
      [symbol, exchange, instanceId]
    );
  }

  /**
   * Get all active leg states with risk enabled
   * @returns {Promise<Array>} - Active leg states
   */
  async getActiveLegsWithRisk() {
    return await db.all(
      'SELECT * FROM leg_state WHERE is_active = 1 AND risk_enabled = 1'
    );
  }

  /**
   * Enable risk for a leg
   * @param {number} legStateId - Leg state ID
   * @param {Object} riskConfig - Risk configuration from resolved settings
   */
  async enableRisk(legStateId, riskConfig) {
    try {
      const {
        tp_per_unit,
        sl_per_unit,
        tsl_enabled,
        tsl_trail_by,
        tsl_step,
        tsl_arm_after,
        tsl_breakeven_after,
        scope = 'LEG',
        on_pyramid = 'reanchor',
      } = riskConfig;

      // Get current leg state
      const legState = await db.get(
        'SELECT * FROM leg_state WHERE id = ?',
        [legStateId]
      );

      if (!legState) {
        throw new Error(`Leg state ${legStateId} not found`);
      }

      // Calculate TP/SL prices based on entry and position direction
      const isLong = legState.net_qty > 0;
      const entry = legState.weighted_avg_entry;

      const tp_price = tp_per_unit
        ? isLong
          ? entry + tp_per_unit
          : entry - tp_per_unit
        : null;

      const sl_price = sl_per_unit
        ? isLong
          ? entry - sl_per_unit
          : entry + sl_per_unit
        : null;

      // Update leg_state with risk config
      await db.run(
        `UPDATE leg_state SET
          risk_enabled = 1,
          tp_per_unit = ?,
          sl_per_unit = ?,
          tp_price = ?,
          sl_price = ?,
          tsl_enabled = ?,
          tsl_trail_by = ?,
          tsl_step = ?,
          tsl_arm_after = ?,
          tsl_breakeven_after = ?,
          tsl_armed = 0,
          tsl_current_stop = NULL,
          scope = ?,
          on_pyramid = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
        [
          tp_per_unit,
          sl_per_unit,
          tp_price,
          sl_price,
          tsl_enabled ? 1 : 0,
          tsl_trail_by,
          tsl_step,
          tsl_arm_after,
          tsl_breakeven_after,
          scope,
          on_pyramid,
          legStateId,
        ]
      );

      log.info('Risk enabled for leg', {
        leg_state_id: legStateId,
        symbol: legState.symbol,
        tp_price,
        sl_price,
        tsl_enabled,
      });
    } catch (error) {
      log.error('Failed to enable risk for leg', error, { legStateId });
      throw error;
    }
  }

  /**
   * Disable risk for a leg
   * @param {number} legStateId - Leg state ID
   */
  async disableRisk(legStateId) {
    await db.run(
      `UPDATE leg_state SET
        risk_enabled = 0,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
      [legStateId]
    );

    log.info('Risk disabled for leg', { leg_state_id: legStateId });
  }

  // ==========================================
  // Private Helper Methods
  // ==========================================

  /**
   * Group trades by symbol
   * @private
   */
  _groupTradesBySymbol(trades) {
    const grouped = {};

    for (const trade of trades) {
      const symbol = trade.symbol || trade.tradingsymbol;
      const exchange = trade.exchange;

      if (!symbol || !exchange) {
        log.warn('Trade missing symbol or exchange', { trade });
        continue;
      }

      const key = `${exchange}:${symbol}`;

      if (!grouped[key]) {
        grouped[key] = [];
      }

      grouped[key].push(trade);
    }

    return grouped;
  }

  /**
   * Parse symbol key into symbol and exchange
   * @private
   */
  _parseSymbolKey(key) {
    const [exchange, symbol] = key.split(':');
    return { exchange, symbol };
  }

  /**
   * Calculate aggregates from trades
   * @private
   */
  _calculateAggregates(trades) {
    let total_buy_qty = 0;
    let total_sell_qty = 0;
    let total_buy_value = 0;
    let total_sell_value = 0;

    for (const trade of trades) {
      const qty = parseInt(trade.quantity || trade.fillshares || 0);
      const price = parseFloat(trade.price || trade.averageprice || 0);
      const action = (trade.action || trade.transactiontype || '').toUpperCase();

      if (action === 'BUY') {
        total_buy_qty += qty;
        total_buy_value += qty * price;
      } else if (action === 'SELL') {
        total_sell_qty += qty;
        total_sell_value += qty * price;
      }
    }

    const net_qty = total_buy_qty - total_sell_qty;

    // Calculate weighted average entry
    let weighted_avg_entry = 0;
    if (net_qty > 0) {
      // Long position: use buy prices
      weighted_avg_entry = total_buy_qty > 0 ? total_buy_value / total_buy_qty : 0;
    } else if (net_qty < 0) {
      // Short position: use sell prices
      weighted_avg_entry = total_sell_qty > 0 ? total_sell_value / total_sell_qty : 0;
    }

    return {
      net_qty,
      total_buy_qty,
      total_sell_qty,
      total_buy_value,
      total_sell_value,
      weighted_avg_entry: parseFloat(weighted_avg_entry.toFixed(2)),
    };
  }

  /**
   * Update existing leg_state
   * @private
   */
  async _updateExistingLegState(legStateId, aggregates) {
    await db.run(
      `UPDATE leg_state SET
        net_qty = ?,
        weighted_avg_entry = ?,
        total_buy_qty = ?,
        total_sell_qty = ?,
        total_buy_value = ?,
        total_sell_value = ?,
        last_fill_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
      [
        aggregates.net_qty,
        aggregates.weighted_avg_entry,
        aggregates.total_buy_qty,
        aggregates.total_sell_qty,
        aggregates.total_buy_value,
        aggregates.total_sell_value,
        legStateId,
      ]
    );
  }

  /**
   * Create new leg_state
   * @private
   */
  async _createLegState(instanceId, symbol, exchange, aggregates, sampleTrade) {
    // Extract metadata from first trade
    const token = sampleTrade.token || null;
    const instrument_type = sampleTrade.instrumenttype || sampleTrade.product || null;

    await db.run(
      `INSERT INTO leg_state (
        instance_id, symbol, exchange, token, instrument_type,
        net_qty, weighted_avg_entry,
        total_buy_qty, total_sell_qty,
        total_buy_value, total_sell_value,
        is_active, last_fill_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)`,
      [
        instanceId,
        symbol,
        exchange,
        token,
        instrument_type,
        aggregates.net_qty,
        aggregates.weighted_avg_entry,
        aggregates.total_buy_qty,
        aggregates.total_sell_qty,
        aggregates.total_buy_value,
        aggregates.total_sell_value,
      ]
    );

    log.info('Leg state created', {
      instance_id: instanceId,
      symbol,
      exchange,
      net_qty: aggregates.net_qty,
      entry: aggregates.weighted_avg_entry,
    });
  }
}

// Export singleton instance
export default new FillAggregatorService();
export { FillAggregatorService };
