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
import { parseFloatSafe } from '../utils/sanitizers.js';
import { cleanupSessionChecks } from '../middleware/instruments-refresh.middleware.js';

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

      // Skip if inactive or unhealthy
      if (!instance.is_active) {
        return { skipped: true, reason: 'inactive' };
      }

      // Update P&L
      await instanceService.updatePnLData(instanceId);

      // Sync order status
      await orderService.syncOrderStatus(instanceId);

      // Get updated instance
      const updated = await instanceService.getInstanceById(instanceId);

      // Check if targets are hit
      const targetCheck = pnlService.checkTargets(
        updated,
        parseFloatSafe(updated.total_pnl, 0)
      );

      if (targetCheck.hitTarget) {
        log.warn('Instance hit target', {
          instance_id: instanceId,
          target_type: targetCheck.targetType,
          target: targetCheck.target,
          current: targetCheck.current,
        });

        // TODO: Trigger alert or auto-switch to analyzer mode
        // This can be implemented in a separate alert service
      }

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

      // Cleanup old session refresh checks
      cleanupSessionChecks();
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
    this.marketDataPollInterval = setInterval(
      () => this.pollMarketData(watchlistId),
      config.polling.marketDataInterval
    );

    // Initial poll
    await this.pollMarketData(watchlistId);

    log.info('Market data polling started', {
      watchlist_id: watchlistId,
      interval: config.polling.marketDataInterval,
    });
  }

  /**
   * Stop market data polling
   */
  stopMarketDataPolling() {
    if (this.marketDataPollInterval) {
      clearInterval(this.marketDataPollInterval);
      this.marketDataPollInterval = null;
    }

    this.watchlistPageActive = false;
    this.activeWatchlistId = null;
    this.isMarketDataPolling = false;

    log.info('Market data polling stopped');
  }

  /**
   * Poll market data for watchlist symbols
   * @param {number} watchlistId - Watchlist ID
   */
  async pollMarketData(watchlistId) {
    try {
      const startTime = Date.now();

      // Get watchlist symbols
      const symbols = await db.all(
        'SELECT * FROM watchlist_symbols WHERE watchlist_id = ? AND is_enabled = 1',
        [watchlistId]
      );

      if (symbols.length === 0) {
        log.debug('No symbols in watchlist', { watchlist_id: watchlistId });
        return;
      }

      // Get market data instances (primary or secondary role only)
      // Try primary first, fallback to secondary
      const marketDataInstances = await instanceService.getMarketDataInstances();

      if (marketDataInstances.length === 0) {
        log.debug('No market data instances available (primary or secondary)', {
          watchlist_id: watchlistId,
        });
        return;
      }

      // Use the first available market data instance (ordered by priority: primary > secondary)
      const instance = marketDataInstances[0];

      log.debug('Using market data instance', {
        watchlist_id: watchlistId,
        instance_id: instance.id,
        instance_name: instance.name,
        market_data_role: instance.market_data_role,
      });

      // Group symbols by exchange for batch quote requests
      const symbolsByExchange = {};
      for (const symbol of symbols) {
        if (!symbolsByExchange[symbol.exchange]) {
          symbolsByExchange[symbol.exchange] = [];
        }
        symbolsByExchange[symbol.exchange].push(symbol.symbol);
      }

      // Fetch quotes for each exchange
      for (const [exchange, exchangeSymbols] of Object.entries(
        symbolsByExchange
      )) {
        try {
          // Prepare symbols array for getQuotes API
          const symbolsArray = exchangeSymbols.map(symbol => ({
            exchange,
            symbol
          }));

          const quotes = await openalgoClient.getQuotes(instance, symbolsArray);

          // Update market_data table
          for (const quote of quotes) {
            const symbol = quote.symbol || quote.tradingsymbol;
            const ltp = parseFloatSafe(quote.ltp || quote.last_price, 0);
            const open = parseFloatSafe(quote.open, 0);
            const high = parseFloatSafe(quote.high, 0);
            const low = parseFloatSafe(quote.low, 0);
            const close = parseFloatSafe(quote.close || quote.prev_close, 0);
            const volume = parseFloatSafe(quote.volume, 0);

            // Calculate change percent
            let changePercent = 0;
            if (close > 0 && ltp > 0) {
              changePercent = ((ltp - close) / close) * 100;
            }

            // Upsert into market_data
            await db.run(
              `INSERT INTO market_data (
                exchange, symbol, ltp, open, high, low, close, volume, change_percent
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(exchange, symbol) DO UPDATE SET
                ltp = excluded.ltp,
                open = excluded.open,
                high = excluded.high,
                low = excluded.low,
                close = excluded.close,
                volume = excluded.volume,
                change_percent = excluded.change_percent,
                updated_at = CURRENT_TIMESTAMP`,
              [exchange, symbol, ltp, open, high, low, close, volume, changePercent]
            );
          }
        } catch (error) {
          log.error('Failed to fetch quotes for exchange', error, {
            exchange,
            symbols: exchangeSymbols.length,
          });
        }
      }

      const duration = Date.now() - startTime;

      log.debug('Market data polling completed', {
        watchlist_id: watchlistId,
        symbols: symbols.length,
        duration_ms: duration,
      });
    } catch (error) {
      log.error('Failed to poll market data', error, { watchlist_id: watchlistId });
    }
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
