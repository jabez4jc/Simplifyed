/**
 * Instance Analyzer Mode Service
 * Tracks and toggles an instance's OpenAlgo "analyzer" (sandbox) vs. live mode, including
 * the safe-switch workflow (close positions/cancel orders before switching to analyzer)
 * and session-reset bookkeeping on switch-back-to-live.
 * Extracted from instance.service.js. Depends on the instance.service.js singleton for
 * getInstanceById, and on instance-session.util.js for the session/time helpers
 * needed to reset session-baseline fields when switching to live.
 */

import db from '../core/database.js';
import { log } from '../core/logger.js';
import config from '../core/config.js';
import openalgoClient from '../integrations/openalgo/client.js';
import { ValidationError } from '../core/errors.js';
import instanceService from './instance.service.js';
import quickOrderService from './quick-order.service.js';
import { staggeredInstanceRequest } from '../utils/instance-request-throttle.util.js';
import {
  nowInIST,
  formatDateIST,
  getTradingSessions,
  findCurrentSession,
} from '../utils/instance-session.util.js';

// Must be meaningfully longer than the 15s instance poll cadence (polling.service.js), otherwise
// the TTL check never actually hits cache (elapsed time is always >= poll interval) and this
// fires a broker call every single poll cycle instead of being throttled. Analyzer mode is a
// rarely/manually toggled setting, so a longer staleness window is imperceptible to users.
const DEFAULT_ANALYZER_TTL_MS = 60 * 1000;

class InstanceAnalyzerService {
  /**
   * Refresh analyzer mode status on a fixed cadence
   * @param {number} id - Instance ID
   * @param {Object} options
   * @param {boolean} options.force - Bypass TTL checks
   */
  async refreshAnalyzerStatus(id, { force = false } = {}) {
    const instance = await instanceService.getInstanceById(id);

    if (!force) {
      if (instance.last_analyzer_check_at) {
        const lastCheck = Date.parse(instance.last_analyzer_check_at);
        const ttl = config.instanceHealth?.analyzerCheckIntervalMs ?? DEFAULT_ANALYZER_TTL_MS;
        if (!Number.isNaN(lastCheck) && Date.now() - lastCheck < ttl) {
          return instance;
        }
      }
    }

    try {
      const analyzerStatus = await staggeredInstanceRequest(id, () => openalgoClient.getAnalyzerStatus(instance));
      const analyzerMode = analyzerStatus.analyze_mode || false;

      await db.run(
        'UPDATE instances SET is_analyzer_mode = ?, last_analyzer_check_at = CURRENT_TIMESTAMP WHERE id = ?',
        [analyzerMode ? 1 : 0, id]
      );
    } catch (error) {
      log.warn('Failed to refresh analyzer status', { id, error: error.message });
    }

    return await instanceService.getInstanceById(id);
  }

  /**
   * Toggle analyzer mode
   * @param {number} id - Instance ID
   * @param {boolean} mode - true for analyze, false for live
   * @returns {Promise<Object>} - Updated instance
   */
  async toggleAnalyzerMode(id, mode) {
    try {
      const instance = await instanceService.getInstanceById(id);

      // If switching to analyzer mode, close positions and cancel orders first
      if (mode === true) {
        log.info('Safe-Switch: Starting Live → Analyzer workflow', { id });

        // Cancel first, so nothing fills after the book is flattened. Then close every position
        // with LIMIT orders (SEBI) - never OpenAlgo's closeposition, which squares off at MARKET.
        try {
          await openalgoClient.cancelAllOrders(instance, instance.strategy_tag || 'default');
        } catch (error) {
          log.warn('Safe-Switch: cancelling orders failed', { id, error: error.message });
        }
        const { stillOpen, errors } = await quickOrderService.closeAllPositions(instance, { strategy: 'SAFE_SWITCH' });
        if (stillOpen.length > 0) {
          log.error('Safe-Switch: Cannot switch - positions still open', { id, open_positions: stillOpen.length });
          throw new ValidationError(
            `Cannot switch to analyzer mode: still open - ${stillOpen.join(', ')}`
            + (errors.length ? ` (${errors.join('; ')})` : '')
          );
        }

        log.info('Safe-Switch: All positions closed', { id });
      }

      // Toggle analyzer mode
      await openalgoClient.toggleAnalyzer(instance, mode);

      // Update database
      let sql = 'UPDATE instances SET is_analyzer_mode = ?, last_updated = CURRENT_TIMESTAMP';
      const params = [mode ? 1 : 0];

      if (!mode) {
        const istNow = nowInIST();
        const todayIst = formatDateIST(istNow);
        const sessions = await getTradingSessions();
        const currentSession = findCurrentSession(istNow, sessions);
        const sessionLabel = currentSession?.label || null;
        const sessionKey = currentSession ? `${todayIst}|${sessionLabel}` : null;
        const baseline = Number.isFinite(instance.total_pnl) ? instance.total_pnl : 0;

        sql += `,
          session_baseline_total_pnl = ?,
          session_baseline_at = ?,
          session_pnl = ?,
          session_cutoff_reason = NULL,
          session_cutoff_at = NULL`;
        params.push(baseline, sessionKey, 0);
      }

      sql += ', last_analyzer_check_at = CURRENT_TIMESTAMP';
      sql += ' WHERE id = ?';
      params.push(id);
      await db.run(sql, params);

      log.info('Analyzer mode toggled', { id, mode });

      return await instanceService.getInstanceById(id);
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      log.error('Failed to toggle analyzer mode', error, { id, mode });
      throw error;
    }
  }
}

const instanceAnalyzerService = new InstanceAnalyzerService();
export default instanceAnalyzerService;
export { DEFAULT_ANALYZER_TTL_MS };
