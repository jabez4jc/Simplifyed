/**
 * Instance PnL / Session Accounting Service
 * Refreshes funds/positions/tradebook for an instance, computes realized P&L and
 * session-baseline/cutoff state, and persists both the live totals and a daily snapshot.
 * Extracted from instance.service.js - touches no cache fields of its own (all state is
 * read from/written to the DB instance row). Depends on the core instance.service.js
 * singleton for getInstanceById, on instance-analyzer.service.js for the safe-switch
 * toggle triggered by session-cutoff detection, and on instance-session.util.js for the
 * session/time helpers.
 */

import db from '../core/database.js';
import { log } from '../core/logger.js';
import settingsService from './settings.service.js';
import instanceService from './instance.service.js';
import { notify } from './notify.service.js';
import instanceAnalyzerService from './instance-analyzer.service.js';
import { calculateTradebookPnLForAppExits, computeSessionPnl } from '../utils/trade-pnl.js';
import { buildBrokerageMap, resolveBrokerageValue } from '../utils/brokerage.js';
import { nowInIST, formatDateIST, computeSessionState } from '../utils/instance-session.util.js';
import { settingDefault } from '../config/settings-registry.js';

class InstancePnlService {
  async _getAppOrderIdsForDate(instanceId, dateKey) {
    if (!instanceId || !dateKey) return new Set();
    const rows = await db.all(
      `
        SELECT order_id, broker_order_id
        FROM watchlist_orders
        WHERE instance_id = ?
          AND DATE(placed_at, '+5 hours', '+30 minutes') = ?
        UNION ALL
        SELECT order_id, broker_order_id
        FROM quick_orders
        WHERE instance_id = ?
          AND DATE(created_at, '+5 hours', '+30 minutes') = ?
      `,
      [instanceId, dateKey, instanceId, dateKey]
    );

    const ids = new Set();
    rows.forEach((row) => {
      const orderId = row.order_id ? String(row.order_id).trim() : null;
      const brokerOrderId = row.broker_order_id ? String(row.broker_order_id).trim() : null;
      if (orderId) ids.add(orderId);
      if (brokerOrderId) ids.add(brokerOrderId);
    });

    return ids;
  }

  async _upsertDailyPnlSnapshot(instanceId, snapshotDate, payload) {
    const {
      total_pnl = 0,
      buy_trades = 0,
      sell_trades = 0,
      buy_value = 0,
      sell_value = 0,
    } = payload || {};

    // One statement (no select-then-insert race). An existing row is only overwritten by a
    // snapshot that is not a regression: a 0 P&L never replaces a non-zero one (a failed or empty
    // read), and trade counts/values only grow within a day.
    await db.run(
      `INSERT INTO daily_instance_pnl_snapshots
        (instance_id, snapshot_date, total_pnl, buy_trades, sell_trades, buy_value, sell_value)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(instance_id, snapshot_date) DO UPDATE SET
         total_pnl = excluded.total_pnl,
         buy_trades = excluded.buy_trades,
         sell_trades = excluded.sell_trades,
         buy_value = excluded.buy_value,
         sell_value = excluded.sell_value,
         updated_at = CURRENT_TIMESTAMP
       WHERE NOT (excluded.total_pnl = 0 AND total_pnl != 0)
         AND excluded.buy_trades >= buy_trades
         AND excluded.sell_trades >= sell_trades
         AND excluded.buy_value >= buy_value
         AND excluded.sell_value >= sell_value`,
      [instanceId, snapshotDate, total_pnl, buy_trades, sell_trades, buy_value, sell_value]
    );
  }

  /**
   * Update instance P&L data
   * @param {number} id - Instance ID
   * @returns {Promise<Object>} - Updated instance with P&L
   */
  async updatePnLData(id) {
    try {
      const instance = await instanceService.getInstanceById(id);

      try {
        const marketDataFeedService = (await import('./market-data-feed.service.js')).default;
        await marketDataFeedService.refreshFundsForInstance(id, { force: false });
        await marketDataFeedService.refreshPositionsForInstance(id, { force: false });
        const tradeSnap = await marketDataFeedService.getTradebookSnapshot(id, { force: false });

        const funds = marketDataFeedService.getFundsSnapshot(id)?.data || {};
        const tradebook = tradeSnap?.data || [];
        const positionSnapshot = marketDataFeedService.getPositionSnapshot(id);
        const positions = Array.isArray(positionSnapshot?.data) ? positionSnapshot.data : [];

        // Session P&L is the broker's own per-position MTM (realized + unrealized) minus today's
        // charges - NOT a tradebook buy/sell-value reconstruction. That reconstruction priced an
        // untouched open BUY as its full notional loss (tripping SESSION_MAX_LOSS and closing
        // every position) and an open SHORT as a notional profit big enough to trip
        // SESSION_TARGET. See computeSessionPnl.
        const currentBalance = parseFloat(funds.availablecash || 0);
        const brokerageSetting = await settingsService.getSetting('brokerage.by_broker').catch(() => null);
        const defaultBrokerageSetting = await settingsService.getSetting('brokerage.default').catch(() => null);
        const brokerageMap = buildBrokerageMap(brokerageSetting?.value);
        const defaultBrokerage = Number.isFinite(defaultBrokerageSetting?.value)
          ? defaultBrokerageSetting.value
          : Number(settingDefault('brokerage.default'));
        const brokerageValue = resolveBrokerageValue(instance.broker, brokerageMap, defaultBrokerage);
        const pnlBreakdown = computeSessionPnl(positions, Array.isArray(tradebook) ? tradebook : [], brokerageValue);
        const totalPnl = pnlBreakdown.total_pnl;
        const realizedPnl = pnlBreakdown.realized_pnl;
        const unrealizedPnl = pnlBreakdown.unrealized_pnl;

        // Session-aware tracking (IST)
        const istNow = nowInIST();
        const todayIst = formatDateIST(istNow);
        const sessionState = await computeSessionState(instance, totalPnl, istNow);
        const {
          currentSession,
          sessionKey,
          sessionLabel,
          sessionBaseline,
          sessionBaselineAt,
          sessionPnl,
          cutoffReason,
          lastLiveTotalPnl,
          lastLiveTotalPnlAt,
          isLiveMode,
        } = sessionState;

        // Auto-revert to live at the start of a new session if the prior cutoff was the max loss.
        // The baseline is only (re)set while live, so a different baseline key means the cutoff
        // happened in an earlier session.
        if (
          instance.is_analyzer_mode &&
          currentSession &&
          instance.session_cutoff_reason === 'SESSION_MAX_LOSS_BREACHED' &&
          cutoffReason === null &&
          instance.session_baseline_at !== sessionKey // new session window
        ) {
          try {
            await instanceAnalyzerService.toggleAnalyzerMode(id, false);
            log.info('Auto-switching back to live for new session after prior max-loss cutoff', { id });
          } catch (toggleErr) {
            log.warn('Failed to auto-switch to live for new session', { id, error: toggleErr.message });
          }
        }

        if (isLiveMode && currentSession && cutoffReason) {
          log.warn('Session cutoff triggered; switching to analyzer mode', {
            id,
            session: sessionLabel,
            session_pnl: sessionPnl,
            reason: cutoffReason,
          });
          await notify('Session cutoff', `Instance ${id} switched to analyzer: ${cutoffReason}`, { severity: 'error', session: sessionLabel, session_pnl: sessionPnl });
          // fire-and-forget safe toggle; errors logged but do not throw to keep polling running
          try {
            await instanceAnalyzerService.toggleAnalyzerMode(id, true);
          } catch (toggleError) {
            log.error('Failed to toggle analyzer after cutoff', {
              id,
              error: toggleError.message,
            });
          }
        }

        const appOrderIds = await this._getAppOrderIdsForDate(instance.id, todayIst);
        const snapshotPnl = calculateTradebookPnLForAppExits(
          Array.isArray(tradebook) ? tradebook : [],
          {
            brokerageValue,
            appOrderIds,
            strategyTag: instance.strategy_tag || 'default',
          }
        );

        if (!instance.is_analyzer_mode && Array.isArray(tradebook) && tradebook.length > 0) {
          await this._upsertDailyPnlSnapshot(instance.id, todayIst, {
            total_pnl: Number(snapshotPnl.net_pnl.toFixed(2)),
            buy_trades: snapshotPnl.buy_count || 0,
            sell_trades: snapshotPnl.sell_count || 0,
            buy_value: snapshotPnl.buy_value || 0,
            sell_value: snapshotPnl.sell_value || 0,
          });
        }

        // Update database
        await db.run(
          `UPDATE instances SET
            current_balance = ?,
            realized_pnl = ?,
            unrealized_pnl = ?,
            total_pnl = ?,
            session_baseline_total_pnl = ?,
            session_baseline_at = ?,
            session_pnl = ?,
            last_live_total_pnl = ?,
            last_live_total_pnl_at = ?,
            session_cutoff_reason = COALESCE(?, session_cutoff_reason),
            session_cutoff_at = CASE
              WHEN ? IS NOT NULL THEN CURRENT_TIMESTAMP
              ELSE session_cutoff_at
            END,
            last_updated = CURRENT_TIMESTAMP
          WHERE id = ?`,
          [
            currentBalance,
            realizedPnl,
            unrealizedPnl,
            totalPnl,
            sessionBaseline,
            sessionBaselineAt,
            sessionPnl,
            lastLiveTotalPnl,
            lastLiveTotalPnlAt,
            cutoffReason,
            cutoffReason,
            id,
          ]
        );

        log.info('P&L updated', {
          id,
          balance: currentBalance,
          realized: realizedPnl,
          unrealized: unrealizedPnl,
          total: totalPnl,
          session_pnl: sessionPnl,
        });

        return await instanceService.getInstanceById(id);
      } catch (error) {
        log.error('Failed to fetch P&L data from OpenAlgo', error, { id });
        throw error;
      }
    } catch (error) {
      log.error('Failed to update P&L data', error, { id });
      throw error;
    }
  }
}

const instancePnlService = new InstancePnlService();
export default instancePnlService;
