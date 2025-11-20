/**
 * Market Data Instance Service
 * Manages primary/secondary instance failover for market data API calls
 */

import db from '../core/database.js';
import log from '../core/logger.js';
import { NotFoundError } from '../core/errors.js';

class MarketDataInstanceService {
  /**
   * Get the instance to use for market data API calls with failover logic
   * @returns {Promise<Object>} Instance object with id, name, host_url, api_key, etc.
   * @throws {NotFoundError} If no healthy primary or secondary instance is available
   */
  async getMarketDataInstance() {
    // Try primary first
    const primary = await this._getInstanceByRole('primary');
    if (primary && this._isHealthy(primary)) {
      log.debug('Using primary market data instance', {
        instanceId: primary.id,
        instanceName: primary.name,
      });
      return primary;
    }

    if (primary) {
      log.warn('Primary market data instance is unhealthy, failing over to secondary', {
        instanceId: primary.id,
        instanceName: primary.name,
        healthStatus: primary.health_status,
      });
    } else {
      log.warn('No primary market data instance configured, trying secondary');
    }

    // Fall back to secondary
    const secondary = await this._getInstanceByRole('secondary');
    if (secondary && this._isHealthy(secondary)) {
      log.debug('Using secondary market data instance', {
        instanceId: secondary.id,
        instanceName: secondary.name,
      });
      return secondary;
    }

    if (secondary) {
      log.error('Secondary market data instance is also unhealthy', {
        instanceId: secondary.id,
        instanceName: secondary.name,
        healthStatus: secondary.health_status,
      });
    } else {
      log.error('No secondary market data instance configured');
    }

    // No healthy instance available
    throw new NotFoundError(
      'No healthy market data instance available. Please ensure primary or secondary instance is configured and healthy.'
    );
  }

  /**
   * Get instance by market_data_role
   * @private
   * @param {string} role - 'primary' or 'secondary'
   * @returns {Promise<Object|null>} Instance object or null if not found
   */
  async _getInstanceByRole(role) {
    try {
      const instance = await db.get(
        `SELECT * FROM instances
         WHERE market_data_role = ? AND is_active = 1
         LIMIT 1`,
        [role]
      );
      return instance || null;
    } catch (error) {
      log.error(`Error fetching ${role} market data instance`, { error: error.message });
      return null;
    }
  }

  /**
   * Check if instance is healthy
   * @private
   * @param {Object} instance - Instance object
   * @returns {boolean} True if healthy
   */
  _isHealthy(instance) {
    return instance.health_status === 'healthy';
  }

  /**
   * Get all market data instances (primary and secondary) for status display
   * @returns {Promise<Array>} Array of instances with market_data_role
   */
  async getMarketDataInstances() {
    try {
      const instances = await db.all(
        `SELECT id, name, host_url, api_key, broker, market_data_role, health_status, is_active, last_health_check
         FROM instances
         WHERE market_data_role IN ('primary', 'secondary')
         ORDER BY
           CASE market_data_role
             WHEN 'primary' THEN 1
             WHEN 'secondary' THEN 2
           END`
      );
      return instances;
    } catch (error) {
      log.error('Error fetching market data instances', { error: error.message });
      return [];
    }
  }
}

export default new MarketDataInstanceService();
