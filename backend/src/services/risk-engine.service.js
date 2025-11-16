/**
 * Risk Engine Service
 * Monitors positions and triggers risk exits based on TP/SL/TSL conditions
 *
 * Responsibilities:
 * - Monitor active legs with risk enabled
 * - Check TP/SL conditions against current prices
 * - Arm TSL when profit threshold is reached
 * - Trail TSL based on best_favorable_price
 * - Trigger idempotent risk exits
 * - Handle scope-based exits (LEG, TYPE, INDEX)
 * - Respect kill switches and feature flags
 *
 * Features:
 * - Real-time risk monitoring (1s polling)
 * - TSL arming and trailing logic
 * - Breakeven stop management
 * - Per-unit P&L calculations
 * - Scope-aware exit orchestration
 * - Idempotent exit tracking
 * - Emergency kill switches
 */

import { randomUUID } from 'crypto';
import db from '../core/database.js';
import { log } from '../core/logger.js';
import { config } from '../core/config.js';

class RiskEngineService {
  constructor() {
    this.pollingInterval = null;
    this.isRunning = false;
    this.activeRiskTriggers = new Set(); // Track active risk triggers to prevent duplicates
  }

  /**
   * Start risk engine polling
   * @param {number} intervalMs - Polling interval in milliseconds (default: 1000)
   */
  start(intervalMs = 1000) {
    if (this.isRunning) {
      log.warn('Risk engine already running');
      return;
    }

    if (!config.features.enableRiskEngine) {
      log.warn('Risk engine disabled by feature flag');
      return;
    }

    this.isRunning = true;

    log.info('Starting risk engine', { interval_ms: intervalMs });

    // Initial check
    this.checkAllRiskConditions().catch(err => {
      log.error('Initial risk check failed', err);
    });

    // Start polling
    this.pollingInterval = setInterval(() => {
      this.checkAllRiskConditions().catch(err => {
        log.error('Risk check failed', err);
      });
    }, intervalMs);

    log.info('Risk engine started', { interval_ms: intervalMs });
  }

  /**
   * Stop risk engine polling
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
    this.activeRiskTriggers.clear();
    log.info('Risk engine stopped');
  }

  /**
   * Check risk conditions for all active legs
   */
  async checkAllRiskConditions() {
    try {
      // Check kill switch
      if (config.features.killRiskExits) {
        log.warn('Risk exits disabled by kill switch');
        return;
      }

      // Get all active legs with risk enabled
      const activeLegs = await db.all(
        `SELECT * FROM leg_state
         WHERE is_active = 1
         AND risk_enabled = 1
         AND net_qty != 0
         ORDER BY updated_at DESC`
      );

      if (activeLegs.length === 0) {
        return;
      }

      // Check each leg in parallel
      const checkPromises = activeLegs.map(leg =>
        this.checkLegRiskConditions(leg).catch(err => {
          log.error('Failed to check risk for leg', err, {
            leg_id: leg.id,
            symbol: leg.symbol,
          });
          return null;
        })
      );

      await Promise.all(checkPromises);
    } catch (error) {
      log.error('Failed to check all risk conditions', error);
    }
  }

  /**
   * Check risk conditions for a specific leg
   * @param {Object} leg - Leg state record
   */
  async checkLegRiskConditions(leg) {
    try {
      // Validate required data
      if (!leg.current_ltp || leg.current_ltp <= 0) {
        log.debug('No valid current price for leg', {
          leg_id: leg.id,
          symbol: leg.symbol,
        });
        return;
      }

      if (!leg.weighted_avg_entry || leg.weighted_avg_entry <= 0) {
        log.debug('No valid entry price for leg', {
          leg_id: leg.id,
          symbol: leg.symbol,
        });
        return;
      }

      const isLong = leg.net_qty > 0;
      const isShort = leg.net_qty < 0;
      const currentPrice = leg.current_ltp;
      const entry = leg.weighted_avg_entry;

      // Calculate current P&L per unit
      const pnlPerUnit = isLong
        ? currentPrice - entry
        : entry - currentPrice;

      // 1. Check TP condition
      if (leg.tp_price && this._shouldTriggerTP(currentPrice, leg.tp_price, isLong)) {
        await this.triggerRiskExit(leg, 'TP_HIT', currentPrice, leg.tp_price, pnlPerUnit);
        return; // Exit triggered, stop checking other conditions
      }

      // 2. Check SL condition
      if (leg.sl_price && this._shouldTriggerSL(currentPrice, leg.sl_price, isLong)) {
        await this.triggerRiskExit(leg, 'SL_HIT', currentPrice, leg.sl_price, pnlPerUnit);
        return; // Exit triggered, stop checking other conditions
      }

      // 3. Check TSL conditions
      if (leg.tsl_enabled) {
        await this.checkTSLConditions(leg, currentPrice, entry, pnlPerUnit, isLong);
      }
    } catch (error) {
      log.error('Failed to check leg risk conditions', error, {
        leg_id: leg.id,
        symbol: leg.symbol,
      });
      throw error;
    }
  }

  /**
   * Check and manage TSL conditions
   * @param {Object} leg - Leg state record
   * @param {number} currentPrice - Current market price
   * @param {number} entry - Weighted average entry price
   * @param {number} pnlPerUnit - Current P&L per unit
   * @param {boolean} isLong - True if long position
   */
  async checkTSLConditions(leg, currentPrice, entry, pnlPerUnit, isLong) {
    try {
      // Check if TSL should be armed
      if (!leg.tsl_armed && leg.tsl_arm_after) {
        if (pnlPerUnit >= leg.tsl_arm_after) {
          // Arm TSL and set initial stop
          await this.armTSL(leg, isLong);
          log.info('TSL armed for leg', {
            leg_id: leg.id,
            symbol: leg.symbol,
            pnl_per_unit: pnlPerUnit,
            arm_threshold: leg.tsl_arm_after,
          });
        }
      }

      // If TSL is armed, trail the stop and check for trigger
      if (leg.tsl_armed) {
        // Update trailing stop based on best_favorable_price
        const newStop = await this.updateTrailingStop(leg, isLong);

        // Check if trailing stop is hit
        if (this._shouldTriggerTSL(currentPrice, newStop, isLong)) {
          await this.triggerRiskExit(leg, 'TSL_HIT', currentPrice, newStop, pnlPerUnit);
        }
      }
    } catch (error) {
      log.error('Failed to check TSL conditions', error, {
        leg_id: leg.id,
        symbol: leg.symbol,
      });
      throw error;
    }
  }

  /**
   * Arm TSL and set initial trailing stop
   * @param {Object} leg - Leg state record
   * @param {boolean} isLong - True if long position
   */
  async armTSL(leg, isLong) {
    try {
      const entry = leg.weighted_avg_entry;
      const bestPrice = leg.best_favorable_price || leg.current_ltp;

      // Calculate initial trailing stop
      let initialStop;

      if (isLong) {
        // For long: stop trails below best price
        initialStop = bestPrice - leg.tsl_trail_by;
      } else {
        // For short: stop trails above best price
        initialStop = bestPrice + leg.tsl_trail_by;
      }

      // Apply breakeven after threshold if configured
      if (leg.tsl_breakeven_after) {
        const pnlPerUnit = isLong
          ? bestPrice - entry
          : entry - bestPrice;

        if (pnlPerUnit >= leg.tsl_breakeven_after) {
          // Set stop at breakeven
          initialStop = entry;
        }
      }

      // Update leg_state with armed TSL
      await db.run(
        `UPDATE leg_state SET
          tsl_armed = 1,
          tsl_current_stop = ?,
          last_trail_price = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
        [initialStop, bestPrice, leg.id]
      );

      log.info('TSL armed with initial stop', {
        leg_id: leg.id,
        symbol: leg.symbol,
        initial_stop: initialStop,
        best_price: bestPrice,
        trail_by: leg.tsl_trail_by,
      });
    } catch (error) {
      log.error('Failed to arm TSL', error, {
        leg_id: leg.id,
        symbol: leg.symbol,
      });
      throw error;
    }
  }

  /**
   * Update trailing stop based on best_favorable_price
   * @param {Object} leg - Leg state record
   * @param {boolean} isLong - True if long position
   * @returns {number} - New trailing stop price
   */
  async updateTrailingStop(leg, isLong) {
    try {
      const bestPrice = leg.best_favorable_price || leg.current_ltp;
      const lastTrailPrice = leg.last_trail_price || bestPrice;
      const currentStop = leg.tsl_current_stop;

      // Calculate how much price has moved in our favor
      const priceImprovement = isLong
        ? bestPrice - lastTrailPrice
        : lastTrailPrice - bestPrice;

      // Only trail if price improvement exceeds step size
      if (leg.tsl_step && priceImprovement < leg.tsl_step) {
        // Not enough movement to trail
        return currentStop;
      }

      // Calculate new trailing stop
      let newStop;

      if (isLong) {
        // For long: trail stop up below best price
        newStop = bestPrice - leg.tsl_trail_by;

        // Only move stop up, never down
        if (newStop <= currentStop) {
          return currentStop;
        }
      } else {
        // For short: trail stop down above best price
        newStop = bestPrice + leg.tsl_trail_by;

        // Only move stop down, never up
        if (newStop >= currentStop) {
          return currentStop;
        }
      }

      // Apply breakeven lock if configured
      if (leg.tsl_breakeven_after) {
        const entry = leg.weighted_avg_entry;
        const pnlPerUnit = isLong
          ? bestPrice - entry
          : entry - bestPrice;

        if (pnlPerUnit >= leg.tsl_breakeven_after) {
          // Lock stop at breakeven minimum
          if (isLong && newStop < entry) {
            newStop = entry;
          } else if (!isLong && newStop > entry) {
            newStop = entry;
          }
        }
      }

      // Update trailing stop
      await db.run(
        `UPDATE leg_state SET
          tsl_current_stop = ?,
          last_trail_price = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
        [newStop, bestPrice, leg.id]
      );

      log.debug('Trailing stop updated', {
        leg_id: leg.id,
        symbol: leg.symbol,
        old_stop: currentStop,
        new_stop: newStop,
        best_price: bestPrice,
        price_improvement: priceImprovement,
      });

      return newStop;
    } catch (error) {
      log.error('Failed to update trailing stop', error, {
        leg_id: leg.id,
        symbol: leg.symbol,
      });
      throw error;
    }
  }

  /**
   * Trigger a risk exit for a leg
   * @param {Object} leg - Leg state record
   * @param {string} triggerType - Type of trigger (TP_HIT, SL_HIT, TSL_HIT, MANUAL)
   * @param {number} triggerPrice - Price at which trigger occurred
   * @param {number} targetPrice - Target price (TP/SL/TSL)
   * @param {number} pnlPerUnit - P&L per unit at trigger
   */
  async triggerRiskExit(leg, triggerType, triggerPrice, targetPrice, pnlPerUnit) {
    try {
      // Check kill switch before triggering
      if (config.features.killRiskExits) {
        log.warn('Risk exit blocked by kill switch', {
          leg_id: leg.id,
          symbol: leg.symbol,
          trigger_type: triggerType,
        });
        return;
      }

      // Generate unique risk trigger ID for idempotency
      const riskTriggerId = randomUUID();

      // Check if this trigger is already active
      if (this.activeRiskTriggers.has(`${leg.id}_${triggerType}`)) {
        log.debug('Risk exit already in progress for leg', {
          leg_id: leg.id,
          trigger_type: triggerType,
        });
        return;
      }

      // Mark trigger as active
      this.activeRiskTriggers.add(`${leg.id}_${triggerType}`);

      try {
        // Calculate total P&L
        const totalPnl = pnlPerUnit * Math.abs(leg.net_qty);

        // Create risk_exits record for idempotent tracking
        await db.run(
          `INSERT INTO risk_exits (
            risk_trigger_id,
            leg_state_id,
            trigger_type,
            trigger_price,
            target_price,
            qty_at_trigger,
            entry_at_trigger,
            pnl_per_unit,
            total_pnl,
            status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
          [
            riskTriggerId,
            leg.id,
            triggerType,
            triggerPrice,
            targetPrice,
            leg.net_qty,
            leg.weighted_avg_entry,
            pnlPerUnit,
            totalPnl,
          ]
        );

        log.info('Risk exit triggered', {
          risk_trigger_id: riskTriggerId,
          leg_id: leg.id,
          symbol: leg.symbol,
          trigger_type: triggerType,
          trigger_price: triggerPrice,
          target_price: targetPrice,
          qty: leg.net_qty,
          pnl_per_unit: pnlPerUnit,
          total_pnl: totalPnl,
          scope: leg.scope,
        });

        // Disable risk for this leg to prevent re-triggering
        await db.run(
          `UPDATE leg_state SET
            risk_enabled = 0,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
          [leg.id]
        );

        // Handle scope-based exits
        await this.executeRiskExit(leg, riskTriggerId, triggerType);
      } finally {
        // Remove from active triggers
        this.activeRiskTriggers.delete(`${leg.id}_${triggerType}`);
      }
    } catch (error) {
      log.error('Failed to trigger risk exit', error, {
        leg_id: leg.id,
        symbol: leg.symbol,
        trigger_type: triggerType,
      });
      throw error;
    }
  }

  /**
   * Execute risk exit based on scope
   * @param {Object} leg - Leg state record
   * @param {string} riskTriggerId - Risk trigger ID
   * @param {string} triggerType - Type of trigger
   */
  async executeRiskExit(leg, riskTriggerId, triggerType) {
    try {
      const scope = leg.scope || 'LEG';

      // Get legs to exit based on scope
      let legsToExit = [];

      switch (scope) {
        case 'LEG':
          // Exit only this leg
          legsToExit = [leg];
          break;

        case 'TYPE':
          // Exit all legs of same option type (CE or PE) for same index/expiry
          legsToExit = await db.all(
            `SELECT * FROM leg_state
             WHERE instance_id = ?
             AND index_name = ?
             AND expiry = ?
             AND option_type = ?
             AND is_active = 1
             AND net_qty != 0`,
            [leg.instance_id, leg.index_name, leg.expiry, leg.option_type]
          );
          break;

        case 'INDEX':
          // Exit all legs for same index/expiry
          legsToExit = await db.all(
            `SELECT * FROM leg_state
             WHERE instance_id = ?
             AND index_name = ?
             AND expiry = ?
             AND is_active = 1
             AND net_qty != 0`,
            [leg.instance_id, leg.index_name, leg.expiry]
          );
          break;

        default:
          log.error('Invalid scope for risk exit', { scope, leg_id: leg.id });
          legsToExit = [leg];
      }

      if (legsToExit.length === 0) {
        log.warn('No legs to exit for scope', { scope, leg_id: leg.id });
        return;
      }

      log.info('Executing risk exit', {
        risk_trigger_id: riskTriggerId,
        trigger_type: triggerType,
        scope,
        legs_count: legsToExit.length,
      });

      // Build exit orders for all legs in scope
      const exitOrders = legsToExit.map(exitLeg => ({
        symbol: exitLeg.symbol,
        exchange: exitLeg.exchange,
        qty: Math.abs(exitLeg.net_qty),
        action: exitLeg.net_qty > 0 ? 'SELL' : 'BUY', // Close position
        order_type: 'MARKET',
        product: 'MIS',
        reason: `${triggerType}_${scope}`,
      }));

      // Store exit orders in risk_exits record
      await db.run(
        `UPDATE risk_exits SET
          exit_orders_json = ?,
          status = 'executing',
          executed_at = CURRENT_TIMESTAMP
        WHERE risk_trigger_id = ?`,
        [JSON.stringify(exitOrders), riskTriggerId]
      );

      // Note: Actual order placement will be handled by order service
      // This service just identifies the risk condition and creates the intent

      log.info('Risk exit orders prepared', {
        risk_trigger_id: riskTriggerId,
        orders_count: exitOrders.length,
      });
    } catch (error) {
      log.error('Failed to execute risk exit', error, {
        risk_trigger_id: riskTriggerId,
        leg_id: leg.id,
      });

      // Mark risk exit as failed
      await db.run(
        `UPDATE risk_exits SET
          status = 'failed',
          execution_summary = ?
        WHERE risk_trigger_id = ?`,
        [error.message, riskTriggerId]
      );

      throw error;
    }
  }

  /**
   * Get all pending risk exits
   * @returns {Promise<Array>} - Array of pending risk exits
   */
  async getPendingRiskExits() {
    return await db.all(
      `SELECT * FROM risk_exits
       WHERE status = 'pending' OR status = 'executing'
       ORDER BY triggered_at ASC`
    );
  }

  /**
   * Mark risk exit as completed
   * @param {string} riskTriggerId - Risk trigger ID
   * @param {string} summary - Execution summary
   */
  async completeRiskExit(riskTriggerId, summary) {
    await db.run(
      `UPDATE risk_exits SET
        status = 'completed',
        execution_summary = ?,
        completed_at = CURRENT_TIMESTAMP
      WHERE risk_trigger_id = ?`,
      [summary, riskTriggerId]
    );

    log.info('Risk exit completed', {
      risk_trigger_id: riskTriggerId,
      summary,
    });
  }

  // ==========================================
  // Private Helper Methods
  // ==========================================

  /**
   * Check if TP should trigger
   * @private
   */
  _shouldTriggerTP(currentPrice, tpPrice, isLong) {
    if (isLong) {
      // Long: TP triggers when price >= target
      return currentPrice >= tpPrice;
    } else {
      // Short: TP triggers when price <= target
      return currentPrice <= tpPrice;
    }
  }

  /**
   * Check if SL should trigger
   * @private
   */
  _shouldTriggerSL(currentPrice, slPrice, isLong) {
    if (isLong) {
      // Long: SL triggers when price <= stop
      return currentPrice <= slPrice;
    } else {
      // Short: SL triggers when price >= stop
      return currentPrice >= slPrice;
    }
  }

  /**
   * Check if TSL should trigger
   * @private
   */
  _shouldTriggerTSL(currentPrice, tslStop, isLong) {
    if (isLong) {
      // Long: TSL triggers when price <= trailing stop
      return currentPrice <= tslStop;
    } else {
      // Short: TSL triggers when price >= trailing stop
      return currentPrice >= tslStop;
    }
  }
}

// Export singleton instance
export default new RiskEngineService();
export { RiskEngineService };
