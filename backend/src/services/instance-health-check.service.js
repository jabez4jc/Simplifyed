/**
 * Instance Health Check Service
 * Pings an instance's broker connection and manages the ping-cadence/backoff cache used
 * to throttle health checks and require manual refresh after repeated failures.
 * Extracted from instance.service.js - owns healthCache. Named to avoid collision with the
 * existing, unrelated src/services/instance-health.service.js (which exports
 * isGeneralEndpointBlackout for endpoint-blackout-window checks, a different concern).
 * A single ping opportunistically also refreshes/reuses the analyzer-mode cache to avoid a
 * second broker round trip, so this service depends on instance-analyzer.service.js for
 * that cache rather than reaching into it directly.
 */

import db from '../core/database.js';
import { log } from '../core/logger.js';
import config from '../core/config.js';
import openalgoClient from '../integrations/openalgo/client.js';
import instanceService from './instance.service.js';
import instanceAnalyzerService, { DEFAULT_ANALYZER_TTL_MS } from './instance-analyzer.service.js';
import { staggeredInstanceRequest } from '../utils/instance-request-throttle.util.js';

const DEFAULT_PING_HEALTHY_MS = 5 * 60 * 1000;
const DEFAULT_PING_UNHEALTHY_MS = 3 * 60 * 1000;
const DEFAULT_MAX_UNHEALTHY_PINGS = 5;

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
        requiresManualRefresh: false,
      };

      if (!force) {
        if (state.requiresManualRefresh) {
          return instance;
        }
        if (state.nextPingAt && now < state.nextPingAt) {
          return instance;
        }
      }

      let healthStatus = 'unknown';
      let analyzerMode = instance.is_analyzer_mode;
      let analyzerCheckPerformed = false;
      const hasAnalyzerCheckColumn = await instanceService._hasColumn('last_analyzer_check_at');

      try {
        // Test connection
        const pingResponse = await staggeredInstanceRequest(id, () => openalgoClient.ping(instance));
        healthStatus = 'healthy';

        // Update last ping time
        await db.run(
          'UPDATE instances SET last_ping_at = CURRENT_TIMESTAMP WHERE id = ?',
          [id]
        );

        // Get analyzer status at most once per TTL (do not block health on failure)
        let shouldCheckAnalyzer = true;
        if (hasAnalyzerCheckColumn && instance.last_analyzer_check_at) {
          const lastCheck = Date.parse(instance.last_analyzer_check_at);
          const ttl = config.instanceHealth?.analyzerCheckIntervalMs ?? DEFAULT_ANALYZER_TTL_MS;
          if (!Number.isNaN(lastCheck)) {
            shouldCheckAnalyzer = Date.now() - lastCheck >= ttl;
          }
        } else if (!hasAnalyzerCheckColumn) {
          const cachedAnalyzerMode = instanceAnalyzerService.getCachedAnalyzerStatus(id);
          if (cachedAnalyzerMode !== null) {
            analyzerMode = cachedAnalyzerMode;
            shouldCheckAnalyzer = false;
          }
        }

        if (shouldCheckAnalyzer) {
          try {
            const analyzerStatus = await staggeredInstanceRequest(id, () => openalgoClient.getAnalyzerStatus(instance));
            analyzerMode = analyzerStatus.analyze_mode || false;
            analyzerCheckPerformed = true;
            instanceAnalyzerService.setCachedAnalyzerStatus(id, analyzerMode);
          } catch (error) {
            log.warn('Failed to get analyzer status', { id, error: error.message });
            analyzerCheckPerformed = true;
          }
        }
      } catch (error) {
        healthStatus = 'unhealthy';
        log.warn('Health check failed', { id, error: error.message });
      }

      // Update health status in database
      let updateSql = `UPDATE instances SET
          health_status = ?,
          is_analyzer_mode = ?,
          last_health_check = CURRENT_TIMESTAMP`;
      const updateParams = [healthStatus, analyzerMode ? 1 : 0];
      if (hasAnalyzerCheckColumn && analyzerCheckPerformed) {
        updateSql += ', last_analyzer_check_at = CURRENT_TIMESTAMP';
      }
      updateSql += ' WHERE id = ?';
      updateParams.push(id);
      await db.run(updateSql, updateParams);

      const pingHealthyMs = config.instanceHealth?.pingHealthyIntervalMs ?? DEFAULT_PING_HEALTHY_MS;
      const pingUnhealthyMs = config.instanceHealth?.pingUnhealthyIntervalMs ?? DEFAULT_PING_UNHEALTHY_MS;
      const maxUnhealthy = config.instanceHealth?.pingUnhealthyMaxAttempts ?? DEFAULT_MAX_UNHEALTHY_PINGS;

      if (healthStatus === 'healthy') {
        this.healthCache.set(id, {
          nextPingAt: Date.now() + pingHealthyMs,
          unhealthyAttempts: 0,
          requiresManualRefresh: false,
        });
      } else {
        const attempts = (state.unhealthyAttempts || 0) + 1;
        const requiresManualRefresh = attempts >= maxUnhealthy;
        this.healthCache.set(id, {
          nextPingAt: requiresManualRefresh ? null : Date.now() + pingUnhealthyMs,
          unhealthyAttempts: attempts,
          requiresManualRefresh,
        });
      }

      return await instanceService.getInstanceById(id);
    } catch (error) {
      log.error('Failed to update health status', error, { id });
      throw error;
    }
  }

  resetHealthCheckState(id) {
    this.healthCache.delete(id);
  }
}

const instanceHealthCheckService = new InstanceHealthCheckService();
export default instanceHealthCheckService;
export { InstanceHealthCheckService };
