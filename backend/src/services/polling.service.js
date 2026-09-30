/**
 * Polling Service
 * Orchestrates periodic updates for instances, P&L, market data, and health checks
 */

import { log } from '../core/logger.js';
import { config } from '../core/config.js';
import instanceService from './instance.service.js';
import orderService from './order.service.js';
import openalgoClient from '../integrations/openalgo/client.js';
import marketDataFeedService, { ORDER_STREAM_SWEEP_MS } from './market-data-feed.service.js';
import openalgoWsService from './openalgo-ws.service.js';
import marketCalendarService from './market-calendar.service.js';
import brokerUnitsService from './broker-units.service.js';
import { ExternalAPIError } from '../core/errors.js';

/**
 * Order status is push-first (OpenAlgo WebSocket `order_update`, api-documentation/v1/
 * websockets.md) with REST as the fallback:
 *
 *  - Each pushed update is applied to the stored order and the cached orderbook at once.
 *  - While an instance's order stream is live (subscribe_orders acknowledged), the regular
 *    REST orderbook sync is skipped, except for a sweep every ORDER_STREAM_SWEEP_MS in case a
 *    push was lost in transit.
 *  - When the stream comes up (startup or after a reconnect) one REST sync runs straight away,
 *    for whatever changed while it was down. While it is down, the regular sync runs as it
 *    always did.
 */
function wireOrderStream(pollingService) {
  openalgoWsService.on('order_update', async ({ instanceId, order }) => {
    try {
      // Pushed updates skip openalgoClient.request, so convert broker lot units here too.
      const instance = await instanceService.getInstanceById(instanceId);
      await brokerUnitsService.fromBrokerRow(instance, order, openalgoClient);
      marketDataFeedService.applyOrderUpdate(instanceId, order);
      await orderService.applyOrderUpdate(instanceId, order);
    } catch (error) {
      log.warn('Failed to apply pushed order update', { instanceId, orderid: order?.orderid, error: error.message });
    }
  });
  openalgoWsService.on('order_stream', ({ instanceId, live }) => {
    log.info(live ? 'Order updates now by push; REST order polling is the fallback' : 'Order push stream down; REST order polling resumes', { instanceId });
    if (live) pollingService.syncOrdersNow(instanceId);
  });
}

class PollingService {
  constructor() {
    this.instancePollInterval = null;
    this.healthCheckInterval = null;
    this.isPolling = false;
    this.instanceIntervalMs = config.polling.instanceInterval;
    this.healthCheckIntervalMs = config.polling.healthCheckInterval;
    this.lastOrderSyncAt = new Map(); // instanceId -> ms, for the sweep while the stream is live
    wireOrderStream(this);
  }

  /** One REST order sync now (the catch-up when a push stream comes up). */
  async syncOrdersNow(instanceId) {
    try {
      await orderService.syncOrderStatus(instanceId);
      this.lastOrderSyncAt.set(instanceId, Date.now());
    } catch (error) {
      log.warn('Order catch-up sync failed', { instanceId, error: error.message });
    }
  }

  /** REST order sync on this poll tick: always without a live push stream, else only the sweep. */
  _orderSyncDue(instanceId) {
    if (!openalgoWsService.isOrderStreamLive(instanceId)) return true;
    return Date.now() - (this.lastOrderSyncAt.get(instanceId) || 0) >= ORDER_STREAM_SWEEP_MS;
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

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    this.isPolling = false;

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

      // Nothing moves after hours; manual refresh (refreshInstance) is not gated
      if (!(await marketCalendarService.isInstanceMarketOpen(instance))) {
        return { skipped: true, reason: 'market_closed' };
      }

      // Update analyzer status (15s cadence)
      await instanceService.refreshAnalyzerStatus(instanceId);

      // Update P&L
      await instanceService.updatePnLData(instanceId);

      // Sync order status - REST only when no live push stream covers it (see wireOrderStream)
      if (this._orderSyncDue(instanceId)) {
        await orderService.syncOrderStatus(instanceId);
        this.lastOrderSyncAt.set(instanceId, Date.now());
      }

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
}

// Export singleton instance
export default new PollingService();
