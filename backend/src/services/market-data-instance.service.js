/**
 * Market Data Instance Service
 * Manages market data instances with round-robin load balancing
 * Uses instances with "use_for_market_data" flag enabled
 */

import db from '../core/database.js';
import log from '../core/logger.js';
import { NotFoundError } from '../core/errors.js';

class MarketDataInstanceService {
  constructor() {
    this.poolIndex = 0;
  }
  /**
   * Get the instance to use for market data API calls with round-robin selection
   * @returns {Promise<Object>} Instance object with id, name, host_url, api_key, etc.
   * @throws {NotFoundError} If no healthy market data instance is available
   */
  async getMarketDataInstance() {
    // Use round-robin from market data pool
    const rr = await this.getRoundRobinInstance();
    if (rr) {
      log.debug('Using pooled market data instance (round robin)', {
        instanceId: rr.id,
        instanceName: rr.name,
      });
      return rr;
    }

    // Fallback: Try legacy primary role
    const primary = await this._getInstanceByRole('primary');
    if (primary && this._isHealthy(primary)) {
      log.debug('Using primary market data instance (legacy fallback)', {
        instanceId: primary.id,
        instanceName: primary.name,
      });
      return primary;
    }

    // Fallback: Try legacy secondary role
    const secondary = await this._getInstanceByRole('secondary');
    if (secondary && this._isHealthy(secondary)) {
      log.debug('Using secondary market data instance (legacy fallback)', {
        instanceId: secondary.id,
        instanceName: secondary.name,
      });
      return secondary;
    }

    // No healthy instance available
    throw new NotFoundError(
      'No healthy market data instance available. Please enable "Use this instance for market data" on at least one active instance.'
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
   * Get all market data instances for status display
   * Includes instances with market_data_enabled flag or legacy primary/secondary roles
   * @returns {Promise<Array>} Array of instances eligible for market data
   */
  async getMarketDataInstances() {
    try {
      const instances = await db.all(
        `SELECT id, name, host_url, api_key, broker, market_data_role, market_data_enabled, health_status, is_active, last_health_check
         FROM instances
         WHERE is_active = 1 AND (market_data_enabled = 1 OR market_data_role IN ('primary','secondary'))
         ORDER BY created_at DESC`
      );
      return instances;
    } catch (error) {
      log.error('Error fetching market data instances', { error: error.message });
      return [];
    }
  }

  /**
   * Get pooled market data instances (healthy only)
   * Note: getMarketDataInstances() already filters by is_active and market_data eligibility
   */
  async getMarketDataPool() {
    const all = await this.getMarketDataInstances();
    // Only filter by health - eligibility already enforced by SQL query
    return all.filter(inst => this._isHealthy(inst));
  }

  /**
   * Get a market data instance using round-robin across the pool
   */
  async getRoundRobinInstance() {
    const pool = await this.getMarketDataPool();
    if (pool.length === 0) return null;
    const inst = pool[this.poolIndex % pool.length];
    this.poolIndex = (this.poolIndex + 1) % pool.length;
    return inst;
  }
}

export default new MarketDataInstanceService();
