/**
 * Instance Analyzer Mode Service
 * Tracks and toggles an instance's OpenAlgo "analyzer" (sandbox) vs. live mode, including
 * the safe-switch workflow (close positions/cancel orders before switching to analyzer)
 * and session-reset bookkeeping on switch-back-to-live.
 * Extracted from instance.service.js - owns analyzerStatusCache. Depends on the core
 * instance.service.js singleton for getInstanceById/_hasColumn (CRUD + schema feature
 * detection stay there), and on instance-session.util.js for the session/time helpers
 * needed to reset session-baseline fields when switching to live.
 */

import db from '../core/database.js';
import { log } from '../core/logger.js';
import config from '../core/config.js';
import openalgoClient from '../integrations/openalgo/client.js';
import { ValidationError } from '../core/errors.js';
import instanceService from './instance.service.js';
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
  constructor() {
    this.analyzerStatusCache = new Map();
  }

  getCachedAnalyzerStatus(instanceId) {
    const entry = this.analyzerStatusCache.get(instanceId);
    if (!entry) return null;
    const ttl = config.instanceHealth?.analyzerCheckIntervalMs ?? DEFAULT_ANALYZER_TTL_MS;
    if (Date.now() - entry.checkedAt > ttl) return null;
    return entry.mode;
  }

  setCachedAnalyzerStatus(instanceId, mode) {
    this.analyzerStatusCache.set(instanceId, { mode: !!mode, checkedAt: Date.now() });
  }

  /**
   * Refresh analyzer mode status on a fixed cadence
   * @param {number} id - Instance ID
   * @param {Object} options
   * @param {boolean} options.force - Bypass TTL checks
   */
  async refreshAnalyzerStatus(id, { force = false } = {}) {
    const instance = await instanceService.getInstanceById(id);
    const hasAnalyzerCheckColumn = await instanceService._hasColumn('last_analyzer_check_at');

    if (!force) {
      if (hasAnalyzerCheckColumn && instance.last_analyzer_check_at) {
        const lastCheck = Date.parse(instance.last_analyzer_check_at);
        const ttl = config.instanceHealth?.analyzerCheckIntervalMs ?? DEFAULT_ANALYZER_TTL_MS;
        if (!Number.isNaN(lastCheck) && Date.now() - lastCheck < ttl) {
          return instance;
        }
      } else if (!hasAnalyzerCheckColumn) {
        const cachedAnalyzerMode = this.getCachedAnalyzerStatus(id);
        if (cachedAnalyzerMode !== null) {
          return instance;
        }
      }
    }

    try {
      const analyzerStatus = await staggeredInstanceRequest(id, () => openalgoClient.getAnalyzerStatus(instance));
      const analyzerMode = analyzerStatus.analyze_mode || false;
      this.setCachedAnalyzerStatus(id, analyzerMode);

      let sql = 'UPDATE instances SET is_analyzer_mode = ?';
      const params = [analyzerMode ? 1 : 0];
      if (hasAnalyzerCheckColumn) {
        sql += ', last_analyzer_check_at = CURRENT_TIMESTAMP';
      }
      sql += ' WHERE id = ?';
      params.push(id);
      await db.run(sql, params);
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

        // Execute closure steps, but always verify afterward even if cancellation fails
        let closureError = null;
        try {
          // Step 1: Close all positions
          if (instance.strategy_tag) {
            await openalgoClient.closePosition(instance, instance.strategy_tag);
          }

          // Step 2: Cancel all orders
          if (instance.strategy_tag) {
            await openalgoClient.cancelAllOrders(instance, instance.strategy_tag);
          }
        } catch (error) {
          // Capture error but continue to verification
          closureError = error;
          log.warn('Safe-Switch: Error during closure workflow', {
            id,
            error: error.message,
          });
        }

        // Step 3: Verify no open positions (always executes)
        const positions = await openalgoClient.getPositionBook(instance);
        const openPositions = positions.filter(
          (pos) => parseFloat(pos.quantity || pos.netqty || 0) !== 0
        );

        if (openPositions.length > 0) {
          log.error('Safe-Switch: Cannot switch - positions still open', {
            id,
            open_positions: openPositions.length,
          });
          throw new ValidationError(
            `Cannot switch to analyzer mode: ${openPositions.length} positions still open`
          );
        }

        // If closure had an error but positions are somehow closed, log warning
        if (closureError) {
          log.warn('Safe-Switch: Verification passed despite closure error', {
            id,
            original_error: closureError.message,
          });
        }

        log.info('Safe-Switch: All positions closed', { id });
      }

      // Toggle analyzer mode
      await openalgoClient.toggleAnalyzer(instance, mode);
      this.setCachedAnalyzerStatus(id, mode);

      // Update database
      const hasAnalyzerCheckColumn = await instanceService._hasColumn('last_analyzer_check_at');
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
          session_cutoff_at = NULL,
          session_max_loss_hits = 0,
          session_max_loss_hits_date = ?`;
        params.push(baseline, sessionKey, 0, sessionKey);
      }

      if (hasAnalyzerCheckColumn) {
        sql += ', last_analyzer_check_at = CURRENT_TIMESTAMP';
      }
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
export { InstanceAnalyzerService, DEFAULT_ANALYZER_TTL_MS };
