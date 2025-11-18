/**
 * Polling Service
 * Orchestrates periodic updates for instances, P&L, market data, and health checks
 */

import { log } from '../core/logger.js';
import { config } from '../core/config.js';
import db from '../core/database.js';
import instanceService from './instance.service.js';
import pnlService from './pnl.service.js';
import orderService from './order.service.js';
import openalgoClient from '../integrations/openalgo/client.js';
import marketDataFeedService from './market-data-feed.service.js';
import { parseFloatSafe } from '../utils/sanitizers.js';

class PollingService {
  constructor() {
    this.instancePollInterval = null;
    this.marketDataPollInterval = null;
    this.healthCheckInterval = null;
    this.isPolling = false;
    this.isMarketDataPolling = false;
    this.watchlistPageActive = false;
    this.activeWatchlistId = null;
  }

  /**
   * Start all polling services
   */
  async start() {
    if (this.isPolling) {
      log.warn('Polling service already running');
      return;
    }

    this.isPolling = true;

    // Start instance polling (every 15 seconds)
    this.instancePollInterval = setInterval(
      () => this.pollAllInstances(),
      config.polling.instanceInterval
    );

    // Start health check polling (every 5 minutes)
    this.healthCheckInterval = setInterval(
      () => this.pollHealthChecks(),
      5 * 60 * 1000 // 5 minutes
    );

    // Initial poll
    await this.pollAllInstances();
    await this.pollHealthChecks();

    log.info('Polling service started', {
      instance_interval: config.polling.instanceInterval,
      market_data_interval: config.polling.marketDataInterval,
    });
  }

  /**
   * Stop all polling services
   */
  stop() {
    if (this.instancePollInterval) {
      clearInterval(this.instancePollInterval);
      this.instancePollInterval = null;
    }

    if (this.marketDataPollInterval) {
      clearInterval(this.marketDataPollInterval);
      this.marketDataPollInterval = null;
    }

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    this.isPolling = false;
    this.isMarketDataPolling = false;

    log.info('Polling service stopped');
  }

  /**
   * Poll all active instances for P&L and order updates
   * This runs every 15 seconds
   */
  async pollAllInstances() {
    try {
      const startTime = Date.now();

      // Get all active instances
      const instances = await instanceService.getAllInstances({
        is_active: true,
      });

      if (instances.length === 0) {
        log.debug('No active instances to poll');
        return;
      }

      log.debug('Polling instances', { count: instances.length });

      // Poll each instance in parallel
      const results = await Promise.allSettled(
        instances.map(instance => this.pollInstance(instance.id))
      );

      // Count successes and failures
      const successful = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;

      const duration = Date.now() - startTime;

      log.info('Instance polling completed', {
        total: instances.length,
        successful,
        failed,
        duration_ms: duration,
      });
    } catch (error) {
      log.error('Failed to poll instances', error);
    }
  }

  /**
   * Poll single instance for P&L and order updates
   * @param {number} instanceId - Instance ID
   * @returns {Promise<Object>} - Updated instance data
   */
  async pollInstance(instanceId) {
    try {
      const instance = await instanceService.getInstanceById(instanceId);

      // Skip if inactive
      if (!instance.is_active) {
        return { skipped: true, reason: 'inactive' };
      }

      // Skip unhealthy instances during regular polling to prevent log spam
      // Health checks run separately every 5 minutes (see healthCheckInterval)
      if (instance.health_status === 'unhealthy') {
        return { skipped: true, reason: 'unhealthy' };
      }

      // Update P&L
      await instanceService.updatePnLData(instanceId);

      // Sync order status
      await orderService.syncOrderStatus(instanceId);

      // Get updated instance
      const updated = await instanceService.getInstanceById(instanceId);

      return updated;
    } catch (error) {
      log.error('Failed to poll instance', error, { instance_id: instanceId });
      throw error;
    }
  }

  /**
   * Manually refresh a specific instance (bypasses cron)
   * @param {number} instanceId - Instance ID
   * @returns {Promise<Object>} - Updated instance data
   */
  async refreshInstance(instanceId) {
    try {
      log.info('Manual refresh triggered', { instance_id: instanceId });

      const startTime = Date.now();

      // Update P&L
      await instanceService.updatePnLData(instanceId);

      // Update health status
      await instanceService.updateHealthStatus(instanceId);

      // Sync order status
      await orderService.syncOrderStatus(instanceId);

      // Get updated instance
      const updated = await instanceService.getInstanceById(instanceId);

      const duration = Date.now() - startTime;

      log.info('Manual refresh completed', {
        instance_id: instanceId,
        duration_ms: duration,
      });

      return updated;
    } catch (error) {
      log.error('Failed to refresh instance', error, { instance_id: instanceId });
      throw error;
    }
  }

  /**
   * Poll health checks for all instances
   * This runs every 5 minutes
   */
  async pollHealthChecks() {
    try {
      const startTime = Date.now();

      // Get all instances (including inactive)
      const instances = await instanceService.getAllInstances();

      if (instances.length === 0) {
        log.debug('No instances for health check');
        return;
      }

      log.debug('Polling health checks', { count: instances.length });

      // Check health for each instance in parallel
      const results = await Promise.allSettled(
        instances.map(instance =>
          instanceService.updateHealthStatus(instance.id)
        )
      );

      // Count results
      const healthy = results.filter(
        r => r.status === 'fulfilled' && r.value.health_status === 'healthy'
      ).length;

      const unhealthy = results.filter(
        r => r.status === 'fulfilled' && r.value.health_status === 'unhealthy'
      ).length;

      const failed = results.filter(r => r.status === 'rejected').length;

      const duration = Date.now() - startTime;

      log.info('Health check completed', {
        total: instances.length,
        healthy,
        unhealthy,
        failed,
        duration_ms: duration,
      });
    } catch (error) {
      log.error('Failed to poll health checks', error);
    }
  }

  /**
   * Start market data polling for watchlist
   * Only polls when watchlist page is active
   * @param {number} watchlistId - Watchlist ID
   */
  async startMarketDataPolling(watchlistId) {
    if (this.isMarketDataPolling && this.activeWatchlistId === watchlistId) {
      log.debug('Market data polling already active for watchlist', {
        watchlist_id: watchlistId,
      });
      return;
    }

    // Stop existing polling if different watchlist
    if (this.isMarketDataPolling && this.activeWatchlistId !== watchlistId) {
      this.stopMarketDataPolling();
    }

    this.watchlistPageActive = true;
    this.activeWatchlistId = watchlistId;
    this.isMarketDataPolling = true;

    // Start polling interval
    log.info('Market data polling disabled (handled by marketDataFeedService)', {
      watchlist_id: watchlistId,
    });
  }

  /**
   * Stop market data polling
   */
  stopMarketDataPolling() {
    this.watchlistPageActive = false;
    this.activeWatchlistId = null;
    this.isMarketDataPolling = false;

    log.info('Market data polling stopped');
  }

  /**
   * Poll market data for watchlist symbols
   * @param {number} watchlistId - Watchlist ID
   */
  async pollMarketData() {
    log.warn('pollMarketData is handled by marketDataFeedService; this method is deprecated.');
  }

  /**
   * Get polling status
   * @returns {Object} - Polling status
   */
  getStatus() {
    return {
      isPolling: this.isPolling,
      isMarketDataPolling: this.isMarketDataPolling,
      activeWatchlistId: this.activeWatchlistId,
      intervals: {
        instance: config.polling.instanceInterval,
        marketData: config.polling.marketDataInterval,
        healthCheck: 5 * 60 * 1000,
      },
    };
  }
}

// Export singleton instance
export default new PollingService();
export { PollingService };
