/**
 * Instance Health Check Service
 * Pings an instance's broker connection and manages the ping-cadence/backoff cache used
 * to throttle health checks, backing off (never giving up) while an instance is unreachable.
 * Extracted from instance.service.js - owns healthCache. Named to avoid collision with the
 * existing, unrelated src/services/instance-health.service.js (scheduled endpoint capability
 * tests, a different concern).
 * A single ping opportunistically also refreshes/reuses the analyzer-mode cache to avoid a
 * second broker round trip, so this service depends on instance-analyzer.service.js for
 * that cache rather than reaching into it directly.
 */

import db from '../core/database.js';
import { log } from '../core/logger.js';
import config from '../core/config.js';
import openalgoClient from '../integrations/openalgo/client.js';
import { backoffMs } from '../integrations/openalgo/instance-health-tracker.service.js';
import instanceService from './instance.service.js';
import { notify } from './notify.service.js';
import marketDataFeedService from './market-data-feed.service.js';
import { DEFAULT_ANALYZER_TTL_MS } from './instance-analyzer.service.js';
import { staggeredInstanceRequest } from '../utils/instance-request-throttle.util.js';
import { isCryptoBroker } from '../utils/broker-type.util.js';

const DEFAULT_PING_HEALTHY_MS = 5 * 60 * 1000;
const DEFAULT_PING_UNHEALTHY_MS = 3 * 60 * 1000;

class InstanceHealthCheckService {
  constructor() {
    this.healthCache = new Map();
  }

  /**
   * Update instance health status
   * @param {number} id - Instance ID
   * @returns {Promise<Object>} - Updated instance with health info
   */
  async updateHealthStatus(id, { force = false } = {}) {
    try {
      const instance = await instanceService.getInstanceById(id);
      const now = Date.now();
      const state = this.healthCache.get(id) || {
        nextPingAt: 0,
        unhealthyAttempts: 0,
      };

      if (!force) {
        if (state.nextPingAt && now < state.nextPingAt) {
          return instance;
        }
      }

      let healthStatus = 'unknown';
      let analyzerMode = instance.is_analyzer_mode;
      let analyzerCheckPerformed = false;

      try {
        // Test connection
        await staggeredInstanceRequest(id, () => openalgoClient.ping(instance));
        await this._checkBrokerSession(instance);
        healthStatus = 'healthy';

        // Update last ping time
        await db.run(
          'UPDATE instances SET last_ping_at = CURRENT_TIMESTAMP WHERE id = ?',
          [id]
        );

        // Get analyzer status at most once per TTL (do not block health on failure)
        let shouldCheckAnalyzer = true;
        if (instance.last_analyzer_check_at) {
          const lastCheck = Date.parse(instance.last_analyzer_check_at);
          const ttl = config.instanceHealth?.analyzerCheckIntervalMs ?? DEFAULT_ANALYZER_TTL_MS;
          if (!Number.isNaN(lastCheck)) {
            shouldCheckAnalyzer = Date.now() - lastCheck >= ttl;
          }
        }

        if (shouldCheckAnalyzer) {
          try {
            const analyzerStatus = await staggeredInstanceRequest(id, () => openalgoClient.getAnalyzerStatus(instance));
            analyzerMode = analyzerStatus.analyze_mode || false;
            analyzerCheckPerformed = true;
          } catch (error) {
            log.warn('Failed to get analyzer status', { instanceId: id, error: error.message });
            analyzerCheckPerformed = true;
          }
        }
      } catch (error) {
        healthStatus = 'unhealthy';
        log.warn('Health check failed', { instanceId: id, error: error.message });
      }

      // Update health status in database
      let updateSql = `UPDATE instances SET
          health_status = ?,
          is_analyzer_mode = ?,
          last_health_check = CURRENT_TIMESTAMP`;
      const updateParams = [healthStatus, analyzerMode ? 1 : 0];
      if (analyzerCheckPerformed) {
        updateSql += ', last_analyzer_check_at = CURRENT_TIMESTAMP';
      }
      updateSql += ' WHERE id = ?';
      updateParams.push(id);
      await db.run(updateSql, updateParams);

      // Tell the operator the moment an instance holding open positions goes dark (this check is
      // the one place that pings, so it is the one place that sees the transition).
      if (healthStatus === 'unhealthy' && instance.health_status !== 'unhealthy' && marketDataFeedService.openPositionInstances.has(id)) {
        await notify('Instance unhealthy', `${instance.name} became unreachable while positions are open.`, { severity: 'error', alert: 'alert_unhealthy_positions', instanceIds: [id] });
      }

      const pingHealthyMs = config.instanceHealth?.pingHealthyIntervalMs ?? DEFAULT_PING_HEALTHY_MS;
      const pingUnhealthyMs = config.instanceHealth?.pingUnhealthyIntervalMs ?? DEFAULT_PING_UNHEALTHY_MS;

      if (healthStatus === 'healthy') {
        this.healthCache.set(id, {
          nextPingAt: Date.now() + pingHealthyMs,
          unhealthyAttempts: 0,
          });
      } else {
        // Pinged again at a growing interval rather than written off after N failures, so an
        // instance that was down (overnight, say) is seen healthy again on its own.
        const attempts = (state.unhealthyAttempts || 0) + 1;
        this.healthCache.set(id, {
          nextPingAt: Date.now() + backoffMs(attempts, pingUnhealthyMs),
          unhealthyAttempts: attempts,
          });
      }

      return await instanceService.getInstanceById(id);
    } catch (error) {
      log.error('Failed to update health status', error, { instanceId: id });
      throw error;
    }
  }

  /**
   * ping only proves OpenAlgo is up and its API key is valid - it never touches the broker. On
   * 2026-10-22 Maha (19) and Ana (20) passed it with an expired Fyers token ("Failed to extract
   * HSM key from access token") and showed healthy while every order was rejected. funds is no
   * better: in analyzer mode it answers from the sandbox. A quote always goes through the broker
   * session, and the sandbox prices its fills from one, so it is the call that has to work.
   * Called raw rather than via getQuote, whose per-symbol failure cooldown would hold an instance
   * unhealthy after its owner logs back in.
   */
  async _checkBrokerSession(instance) {
    // ponytail: crypto (Delta) keys do not expire daily; add a crypto probe symbol if that changes.
    if (isCryptoBroker(instance.broker)) return;
    await staggeredInstanceRequest(instance.id, () =>
      openalgoClient.request(instance, 'quotes', { symbol: 'NIFTY', exchange: 'NSE_INDEX' }));
  }

  resetHealthCheckState(id) {
    this.healthCache.delete(id);
  }
}

const instanceHealthCheckService = new InstanceHealthCheckService();
export default instanceHealthCheckService;
