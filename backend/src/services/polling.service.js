/**
 * Polling Service
 * Orchestrates periodic updates for instances, P&L, market data, and health checks
 */

import { log } from '../core/logger.js';
import { config } from '../core/config.js';
import instanceService from './instance.service.js';
import orderService from './order.service.js';
import openalgoClient from '../integrations/openalgo/client.js';
import marketDataFeedService from './market-data-feed.service.js';
import { ExternalAPIError } from '../core/errors.js';
import { isGeneralEndpointBlackout } from './instance-health.service.js';

class PollingService {
  constructor() {
    this.instancePollInterval = null;
    this.marketDataPollInterval = null;
    this.healthCheckInterval = null;
    this.isPolling = false;
    this.isMarketDataPolling = false;
    this.watchlistPageActive = false;
    this.activeWatchlistId = null;
    this.instanceIntervalMs = config.polling.instanceInterval;
    this.healthCheckIntervalMs = config.polling.healthCheckInterval || 60000;
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
      this.instanceIntervalMs
    );

    // Start health check polling (interval respects per-instance ping schedule)
    this.healthCheckInterval = setInterval(
      () => this.pollHealthChecks(),
      this.healthCheckIntervalMs
    );

    // Initial poll
    await this.pollAllInstances();
    await this.pollHealthChecks();

    log.info('Polling service started', {
      instance_interval: this.instanceIntervalMs,
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
      if (isGeneralEndpointBlackout()) {
        return;
      }
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

      // Update analyzer status (15s cadence)
      await instanceService.refreshAnalyzerStatus(instanceId);

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
   * This also resets the circuit breaker health state, allowing
   * instances that were marked as requiring manual refresh to be retried
   * @param {number} instanceId - Instance ID
   * @returns {Promise<Object>} - Updated instance data
   */
  async refreshInstance(instanceId) {
    try {
      // Get previous health state for logging
      const previousHealthState = openalgoClient.getInstanceHealthStatus(instanceId);

      // Force reset instance health in circuit breaker
      // This clears any requiresManualRefresh flag and allows retries
      openalgoClient.forceResetInstanceHealth(instanceId);
      openalgoClient.forceClearBackoff(instanceId);
      marketDataFeedService.resetInstanceHealth(instanceId);
      instanceService.resetHealthCheckState(instanceId);

      log.info('Manual refresh triggered', {
        instance_id: instanceId,
        previousHealthState: previousHealthState ? {
          requiresManualRefresh: previousHealthState.requiresManualRefresh,
          dnsRetryCount: previousHealthState.dnsRetryCount,
          isDnsError: previousHealthState.isDnsError,
          isHtmlError: previousHealthState.isHtmlError,
          lastError: previousHealthState.lastError,
        } : null,
      });

      const startTime = Date.now();

      // Update P&L
      await instanceService.updatePnLData(instanceId);

      // Update health status
      await instanceService.updateHealthStatus(instanceId, { force: true });

      // Sync order status
      await orderService.syncOrderStatus(instanceId);

      // Get updated instance
      const updated = await instanceService.getInstanceById(instanceId);

      const duration = Date.now() - startTime;

      log.info('Manual refresh completed', {
        instance_id: instanceId,
        duration_ms: duration,
        health_status: updated.health_status,
      });

      return updated;
    } catch (error) {
      log.error('Failed to refresh instance', error, { instance_id: instanceId });
      const message = `Refresh failed for instance ${instanceId}: ${error.message || 'OpenAlgo call failed. Verify host URL and API key.'}`;
      const details = {
        instance_id: instanceId,
        endpoint: error?.endpoint,
        status_code: error?.statusCode,
        is_html_response: !!error?.isHtmlResponse,
        is_dns_error: !!error?.isDnsError,
      };
      const statusCode = error?.statusCode || 502;
      throw new ExternalAPIError('OpenAlgo', message, statusCode, details);
    }
  }

  /**
   * Poll health checks for all instances
   * This runs every 5 minutes
   */
  async pollHealthChecks() {
    try {
      if (isGeneralEndpointBlackout()) {
        return;
      }
      const startTime = Date.now();

      // Only active instances need health checks - an intentionally disabled instance isn't
      // in use, so pinging it wastes shared broker-request concurrency (and, if its host is
      // stale/unreachable, ties up retries) for no benefit. Re-activating an instance triggers
      // its own on-demand refresh.
      const instances = await instanceService.getAllInstances({ is_active: true });

      if (instances.length === 0) {
        log.debug('No active instances for health check');
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
        instance: this.instanceIntervalMs,
        marketData: config.polling.marketDataInterval,
        healthCheck: this.healthCheckIntervalMs,
      },
    };
  }

  applyConfig(nextConfig = config) {
    this.instanceIntervalMs = nextConfig.polling.instanceInterval;
    this.healthCheckIntervalMs = nextConfig.polling.healthCheckInterval || 60000;

    if (!this.isPolling) {
      return;
    }

    if (this.instancePollInterval) {
      clearInterval(this.instancePollInterval);
    }
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    this.instancePollInterval = setInterval(
      () => this.pollAllInstances(),
      this.instanceIntervalMs
    );
    this.healthCheckInterval = setInterval(
      () => this.pollHealthChecks(),
      this.healthCheckIntervalMs
    );
  }
}

// Export singleton instance
export default new PollingService();
export { PollingService };
