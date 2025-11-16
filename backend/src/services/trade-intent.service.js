/**
 * Trade Intent Service
 * Manages trade intents for idempotent order placement
 *
 * Responsibilities:
 * - Create trade intents with unique intent_id (UUID)
 * - Track intent execution status
 * - Link intents to resulting orders
 * - Resolve effective settings for intent
 * - Handle idempotency (same intent_id returns same result)
 * - Support risk-based intents and manual intents
 *
 * Features:
 * - UUID-based intent IDs for idempotency
 * - Intent status tracking (pending, executing, completed, failed)
 * - Effective settings resolution via settings service
 * - Links to watchlist_orders for audit trail
 * - Retry-safe (re-executing same intent_id is safe)
 */

import { randomUUID } from 'crypto';
import db from '../core/database.js';
import { log } from '../core/logger.js';
import settingsService from './settings.service.js';

class TradeIntentService {
  /**
   * Create a new trade intent
   * @param {Object} params - Intent parameters
   * @param {string} params.intentId - Optional intent ID (generates UUID if not provided)
   * @param {number} params.userId - User ID
   * @param {number} params.instanceId - Instance ID
   * @param {number} params.watchlistId - Watchlist ID
   * @param {string} params.symbol - Symbol (may be template like "NIFTY_ATM_CE")
   * @param {string} params.exchange - Exchange
   * @param {string} params.action - BUY or SELL
   * @param {number} params.targetQty - Target position quantity
   * @param {string} params.intentType - MANUAL, RISK_EXIT, AUTO_REBALANCE
   * @param {Object} params.context - Additional context (index, expiry, etc.)
   * @returns {Promise<Object>} - Created intent record
   */
  async createIntent(params) {
    try {
      const {
        intentId = randomUUID(),
        userId,
        instanceId,
        watchlistId,
        symbol,
        exchange,
        action,
        targetQty,
        intentType = 'MANUAL',
        context = {},
      } = params;

      // Check if intent already exists (idempotency)
      const existingIntent = await this.getIntentById(intentId);
      if (existingIntent) {
        log.info('Intent already exists, returning existing intent', {
          intent_id: intentId,
          status: existingIntent.status,
        });
        return existingIntent;
      }

      // Resolve effective settings for this intent
      const effectiveSettings = await settingsService.getEffectiveSettings({
        userId,
        watchlistId,
        indexName: context.indexName,
        symbol: context.resolvedSymbol || symbol,
        exchange,
      });

      // Create intent record
      const result = await db.run(
        `INSERT INTO trade_intents (
          intent_id,
          user_id,
          instance_id,
          watchlist_id,
          symbol,
          exchange,
          action,
          target_qty,
          intent_type,
          context_json,
          settings_snapshot_json,
          status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        [
          intentId,
          userId,
          instanceId,
          watchlistId,
          symbol,
          exchange,
          action,
          targetQty,
          intentType,
          JSON.stringify(context),
          JSON.stringify(effectiveSettings),
        ]
      );

      log.info('Trade intent created', {
        intent_id: intentId,
        symbol,
        action,
        target_qty: targetQty,
        intent_type: intentType,
      });

      // Return created intent
      return await this.getIntentById(intentId);
    } catch (error) {
      log.error('Failed to create trade intent', error, params);
      throw error;
    }
  }

  /**
   * Get intent by ID
   * @param {string} intentId - Intent ID (UUID)
   * @returns {Promise<Object|null>} - Intent record or null
   */
  async getIntentById(intentId) {
    const intent = await db.get(
      'SELECT * FROM trade_intents WHERE intent_id = ?',
      [intentId]
    );

    if (!intent) {
      return null;
    }

    // Parse JSON fields
    return this._parseIntent(intent);
  }

  /**
   * Update intent status
   * @param {string} intentId - Intent ID
   * @param {string} status - New status (executing, completed, failed)
   * @param {Object} metadata - Additional metadata (error, result, etc.)
   */
  async updateIntentStatus(intentId, status, metadata = {}) {
    try {
      await db.run(
        `UPDATE trade_intents
         SET status = ?,
             updated_at = CURRENT_TIMESTAMP,
             ${status === 'completed' ? 'completed_at = CURRENT_TIMESTAMP,' : ''}
             ${status === 'failed' ? 'failed_at = CURRENT_TIMESTAMP,' : ''}
             result_json = ?
         WHERE intent_id = ?`,
        [status, JSON.stringify(metadata), intentId]
      );

      log.info('Intent status updated', {
        intent_id: intentId,
        status,
      });
    } catch (error) {
      log.error('Failed to update intent status', error, {
        intent_id: intentId,
        status,
      });
      throw error;
    }
  }

  /**
   * Link intent to watchlist order
   * @param {string} intentId - Intent ID
   * @param {number} orderId - Watchlist order ID
   */
  async linkIntentToOrder(intentId, orderId) {
    try {
      // Update watchlist_orders with intent_id
      await db.run(
        'UPDATE watchlist_orders SET intent_id = ? WHERE id = ?',
        [intentId, orderId]
      );

      log.debug('Intent linked to order', {
        intent_id: intentId,
        order_id: orderId,
      });
    } catch (error) {
      log.error('Failed to link intent to order', error, {
        intent_id: intentId,
        order_id: orderId,
      });
      throw error;
    }
  }

  /**
   * Get all orders for an intent
   * @param {string} intentId - Intent ID
   * @returns {Promise<Array>} - Array of watchlist_orders
   */
  async getOrdersForIntent(intentId) {
    return await db.all(
      'SELECT * FROM watchlist_orders WHERE intent_id = ? ORDER BY created_at ASC',
      [intentId]
    );
  }

  /**
   * Get pending intents
   * @param {number} instanceId - Optional instance ID filter
   * @returns {Promise<Array>} - Array of pending intents
   */
  async getPendingIntents(instanceId = null) {
    let query = "SELECT * FROM trade_intents WHERE status = 'pending'";
    const params = [];

    if (instanceId) {
      query += ' AND instance_id = ?';
      params.push(instanceId);
    }

    query += ' ORDER BY created_at ASC';

    const intents = await db.all(query, params);
    return intents.map(intent => this._parseIntent(intent));
  }

  /**
   * Get failed intents for retry
   * @param {number} maxAge - Maximum age in seconds (default: 3600)
   * @returns {Promise<Array>} - Array of failed intents
   */
  async getFailedIntents(maxAge = 3600) {
    const intents = await db.all(
      `SELECT * FROM trade_intents
       WHERE status = 'failed'
       AND failed_at > datetime('now', '-' || ? || ' seconds')
       ORDER BY failed_at DESC`,
      [maxAge]
    );

    return intents.map(intent => this._parseIntent(intent));
  }

  /**
   * Get intent execution summary
   * @param {string} intentId - Intent ID
   * @returns {Promise<Object>} - Execution summary
   */
  async getIntentSummary(intentId) {
    const intent = await this.getIntentById(intentId);
    if (!intent) {
      return null;
    }

    const orders = await this.getOrdersForIntent(intentId);

    return {
      intent,
      orders,
      order_count: orders.length,
      total_qty: orders.reduce((sum, o) => sum + (o.quantity || 0), 0),
      successful_orders: orders.filter(o => o.status === 'COMPLETE').length,
      failed_orders: orders.filter(o => o.status === 'REJECTED').length,
    };
  }

  /**
   * Clean up old completed intents
   * @param {number} olderThanDays - Delete intents older than N days (default: 30)
   * @returns {Promise<number>} - Number of deleted intents
   */
  async cleanupOldIntents(olderThanDays = 30) {
    try {
      const result = await db.run(
        `DELETE FROM trade_intents
         WHERE status = 'completed'
         AND completed_at < datetime('now', '-' || ? || ' days')`,
        [olderThanDays]
      );

      log.info('Cleaned up old trade intents', {
        deleted_count: result.changes,
        older_than_days: olderThanDays,
      });

      return result.changes;
    } catch (error) {
      log.error('Failed to cleanup old intents', error);
      throw error;
    }
  }

  /**
   * Retry a failed intent
   * @param {string} intentId - Intent ID to retry
   * @returns {Promise<Object>} - Updated intent
   */
  async retryIntent(intentId) {
    try {
      const intent = await this.getIntentById(intentId);
      if (!intent) {
        throw new Error(`Intent ${intentId} not found`);
      }

      if (intent.status !== 'failed') {
        throw new Error(`Intent ${intentId} is not in failed state (status: ${intent.status})`);
      }

      // Reset to pending for retry
      await db.run(
        `UPDATE trade_intents
         SET status = 'pending',
             failed_at = NULL,
             result_json = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE intent_id = ?`,
        [intentId]
      );

      log.info('Intent reset for retry', { intent_id: intentId });

      return await this.getIntentById(intentId);
    } catch (error) {
      log.error('Failed to retry intent', error, { intent_id: intentId });
      throw error;
    }
  }

  // ==========================================
  // Private Helper Methods
  // ==========================================

  /**
   * Parse intent record (convert JSON fields to objects)
   * @private
   */
  _parseIntent(intent) {
    if (!intent) {
      return null;
    }

    return {
      ...intent,
      context: intent.context_json ? JSON.parse(intent.context_json) : {},
      settings_snapshot: intent.settings_snapshot_json
        ? JSON.parse(intent.settings_snapshot_json)
        : {},
      result: intent.result_json ? JSON.parse(intent.result_json) : null,
    };
  }
}

// Export singleton instance
export default new TradeIntentService();
export { TradeIntentService };
