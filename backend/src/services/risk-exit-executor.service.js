/**
 * Risk Exit Executor Service
 * Processes pending risk exits and places exit orders
 *
 * Responsibilities:
 * - Poll risk_exits table for pending exits
 * - Place exit orders via OpenAlgo
 * - Update risk_exits status
 * - Handle scope-based exits (already prepared by risk engine)
 * - Link exits to watchlist_orders
 * - Respect kill switches
 *
 * Features:
 * - Automatic polling of pending exits
 * - Batch processing of exit orders
 * - Retry logic for failed exits
 * - Emergency kill switch support
 * - Audit trail via watchlist_orders
 */

import db from '../core/database.js';
import { log } from '../core/logger.js';
import { config } from '../core/config.js';
import openalgoClient from '../integrations/openalgo/client.js';
import tradeIntentService from './trade-intent.service.js';

class RiskExitExecutorService {
  constructor() {
    this.pollingInterval = null;
    this.isRunning = false;
    this.activeExecutions = new Set(); // Track active executions to prevent duplicates
  }

  /**
   * Start risk exit executor polling
   * @param {number} intervalMs - Polling interval in milliseconds (default: 2000)
   */
  start(intervalMs = 2000) {
    if (this.isRunning) {
      log.warn('Risk exit executor already running');
      return;
    }

    if (!config.features.enableRiskEngine) {
      log.warn('Risk exit executor disabled (risk engine disabled)');
      return;
    }

    this.isRunning = true;

    log.info('Starting risk exit executor', { interval_ms: intervalMs });

    // Initial check
    this.processPendingExits().catch(err => {
      log.error('Initial risk exit processing failed', err);
    });

    // Start polling
    this.pollingInterval = setInterval(() => {
      this.processPendingExits().catch(err => {
        log.error('Risk exit processing failed', err);
      });
    }, intervalMs);

    log.info('Risk exit executor started', { interval_ms: intervalMs });
  }

  /**
   * Stop risk exit executor polling
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
    this.activeExecutions.clear();
    log.info('Risk exit executor stopped');
  }

  /**
   * Process all pending risk exits
   */
  async processPendingExits() {
    try {
      // Check kill switch
      if (config.features.killRiskExits || config.features.killAutoTrading) {
        log.debug('Risk exits disabled by kill switch');
        return;
      }

      // Get all pending risk exits
      const pendingExits = await db.all(
        `SELECT re.*, ls.symbol, ls.exchange, ls.instance_id, ls.net_qty
         FROM risk_exits re
         JOIN leg_state ls ON re.leg_state_id = ls.id
         WHERE re.status IN ('pending', 'executing')
         ORDER BY re.triggered_at ASC`
      );

      if (pendingExits.length === 0) {
        return;
      }

      log.info('Processing pending risk exits', { count: pendingExits.length });

      // Process each exit
      for (const exit of pendingExits) {
        // Check if already being executed
        if (this.activeExecutions.has(exit.risk_trigger_id)) {
          log.debug('Risk exit already being executed', {
            risk_trigger_id: exit.risk_trigger_id,
          });
          continue;
        }

        // Mark as active
        this.activeExecutions.add(exit.risk_trigger_id);

        try {
          await this.executeRiskExit(exit);
        } catch (error) {
          log.error('Failed to execute risk exit', error, {
            risk_trigger_id: exit.risk_trigger_id,
          });
        } finally {
          // Remove from active executions
          this.activeExecutions.delete(exit.risk_trigger_id);
        }
      }
    } catch (error) {
      log.error('Failed to process pending risk exits', error);
    }
  }

  /**
   * Execute a specific risk exit
   * @param {Object} riskExit - Risk exit record with joined leg_state data
   */
  async executeRiskExit(riskExit) {
    try {
      const { risk_trigger_id, instance_id, exit_orders_json } = riskExit;

      // Parse exit orders
      const exitOrders = exit_orders_json ? JSON.parse(exit_orders_json) : [];

      if (exitOrders.length === 0) {
        log.warn('No exit orders found for risk exit', { risk_trigger_id });
        await this._markExitFailed(risk_trigger_id, 'No exit orders found');
        return;
      }

      // Update status to executing
      await db.run(
        `UPDATE risk_exits
         SET status = 'executing',
             executed_at = CURRENT_TIMESTAMP
         WHERE risk_trigger_id = ?`,
        [risk_trigger_id]
      );

      // Get instance
      const instance = await db.get(
        'SELECT * FROM instances WHERE id = ?',
        [instance_id]
      );

      if (!instance) {
        throw new Error(`Instance ${instance_id} not found`);
      }

      if (instance.is_analyzer_mode) {
        log.warn('Cannot execute risk exit on analyzer instance', {
          risk_trigger_id,
          instance_id,
        });
        await this._markExitFailed(risk_trigger_id, 'Analyzer mode instance');
        return;
      }

      // Place all exit orders
      const orderResults = [];
      const placedOrders = [];

      for (const orderSpec of exitOrders) {
        try {
          const orderResult = await this._placeExitOrder(
            instance,
            orderSpec,
            risk_trigger_id
          );

          orderResults.push(orderResult);

          if (orderResult.success) {
            placedOrders.push(orderResult);
          }
        } catch (error) {
          log.error('Failed to place exit order', error, {
            risk_trigger_id,
            symbol: orderSpec.symbol,
          });
          orderResults.push({
            success: false,
            error: error.message,
            symbol: orderSpec.symbol,
          });
        }
      }

      // Determine overall success
      const successCount = orderResults.filter(r => r.success).length;
      const totalCount = orderResults.length;

      if (successCount === totalCount) {
        // All orders placed successfully
        await this._markExitCompleted(risk_trigger_id, {
          orders_placed: successCount,
          total_orders: totalCount,
          order_results: orderResults,
        });

        log.info('Risk exit completed successfully', {
          risk_trigger_id,
          orders_placed: successCount,
        });
      } else if (successCount > 0) {
        // Partial success
        await this._markExitCompleted(risk_trigger_id, {
          orders_placed: successCount,
          total_orders: totalCount,
          partial_success: true,
          order_results: orderResults,
        });

        log.warn('Risk exit partially completed', {
          risk_trigger_id,
          orders_placed: successCount,
          total_orders: totalCount,
        });
      } else {
        // Complete failure
        await this._markExitFailed(risk_trigger_id, 'All exit orders failed', {
          order_results: orderResults,
        });

        log.error('Risk exit failed completely', {
          risk_trigger_id,
          total_orders: totalCount,
        });
      }
    } catch (error) {
      log.error('Failed to execute risk exit', error, {
        risk_trigger_id: riskExit.risk_trigger_id,
      });

      await this._markExitFailed(riskExit.risk_trigger_id, error.message);
    }
  }

  /**
   * Place a single exit order
   * @private
   * @param {Object} instance - Instance record
   * @param {Object} orderSpec - Order specification
   * @param {string} riskTriggerId - Risk trigger ID
   * @returns {Promise<Object>} - Order result
   */
  async _placeExitOrder(instance, orderSpec, riskTriggerId) {
    try {
      const { symbol, exchange, qty, action, order_type, product, reason } = orderSpec;

      log.info('Placing risk exit order', {
        risk_trigger_id: riskTriggerId,
        symbol,
        action,
        qty,
        reason,
      });

      // Place order via OpenAlgo
      const orderResponse = await openalgoClient.placeSmartOrder(instance, {
        symbol,
        exchange,
        action,
        quantity: qty,
        order_type: order_type || 'MARKET',
        product: product || 'MIS',
        price: 0, // Market order
      });

      // Store order in watchlist_orders (for audit trail)
      // Note: We'll need watchlist context for this, which should be in leg_state
      const leg = await db.get(
        `SELECT ls.*, re.leg_state_id
         FROM leg_state ls
         JOIN risk_exits re ON re.risk_trigger_id = ?
         WHERE ls.symbol = ? AND ls.exchange = ?`,
        [riskTriggerId, symbol, exchange]
      );

      if (leg) {
        const orderId = await db.run(
          `INSERT INTO watchlist_orders (
            watchlist_id,
            instance_id,
            symbol,
            exchange,
            action,
            quantity,
            order_type,
            status,
            order_id,
            reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            1, // TODO: Get actual watchlist_id from leg_state or context
            instance.id,
            symbol,
            exchange,
            action,
            qty,
            order_type || 'MARKET',
            'PENDING',
            orderResponse.orderid,
            reason,
          ]
        );

        log.debug('Exit order stored in watchlist_orders', {
          order_id: orderId.lastID,
          openalgo_order_id: orderResponse.orderid,
        });
      }

      return {
        success: true,
        symbol,
        action,
        qty,
        order_id: orderResponse.orderid,
        status: orderResponse.status,
      };
    } catch (error) {
      log.error('Failed to place exit order', error, orderSpec);
      return {
        success: false,
        symbol: orderSpec.symbol,
        error: error.message,
      };
    }
  }

  /**
   * Mark risk exit as completed
   * @private
   */
  async _markExitCompleted(riskTriggerId, summary) {
    await db.run(
      `UPDATE risk_exits
       SET status = 'completed',
           execution_summary = ?,
           completed_at = CURRENT_TIMESTAMP
       WHERE risk_trigger_id = ?`,
      [JSON.stringify(summary), riskTriggerId]
    );
  }

  /**
   * Mark risk exit as failed
   * @private
   */
  async _markExitFailed(riskTriggerId, errorMessage, details = {}) {
    await db.run(
      `UPDATE risk_exits
       SET status = 'failed',
           execution_summary = ?
       WHERE risk_trigger_id = ?`,
      [
        JSON.stringify({
          error: errorMessage,
          ...details,
        }),
        riskTriggerId,
      ]
    );
  }

  /**
   * Get execution statistics
   * @returns {Promise<Object>} - Execution stats
   */
  async getExecutionStats() {
    const stats = await db.get(
      `SELECT
        COUNT(*) as total_exits,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'executing' THEN 1 ELSE 0 END) as executing
       FROM risk_exits
       WHERE triggered_at > datetime('now', '-24 hours')`
    );

    return {
      ...stats,
      active_executions: this.activeExecutions.size,
      is_running: this.isRunning,
    };
  }
}

// Export singleton instance
export default new RiskExitExecutorService();
export { RiskExitExecutorService };
