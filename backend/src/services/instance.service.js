/**
 * Instance Management Service
 * Handles CRUD operations, health checks, and P&L updates for instances
 */

import db from '../core/database.js';
import { log } from '../core/logger.js';
import openalgoClient from '../integrations/openalgo/client.js';
import {
  NotFoundError,
  ConflictError,
  ValidationError,
} from '../core/errors.js';
import {
  normalizeUrl,
  sanitizeApiKey,
  sanitizeString,
  sanitizeStrategyTag,
  parseFloatSafe,
  parseBooleanSafe,
  parseIntSafe,
} from '../utils/sanitizers.js';
import settingsService from './settings.service.js';
import { toISTDate, toISTISOString } from '../utils/time.js';
import config from '../core/config.js';
import { calculateTradebookPnL, calculateTradebookPnLForAppExits } from '../utils/trade-pnl.js';
import { buildBrokerageMap, resolveBrokerageValue } from '../utils/brokerage.js';

const INSTANCE_REQUEST_DELAY_MS = 300;
// Must be meaningfully longer than the 15s instance poll cadence (polling.service.js), otherwise
// the TTL check never actually hits cache (elapsed time is always >= poll interval) and this
// fires a broker call every single poll cycle instead of being throttled. Analyzer mode is a
// rarely/manually toggled setting, so a longer staleness window is imperceptible to users.
const DEFAULT_ANALYZER_TTL_MS = 60 * 1000;
const DEFAULT_PING_HEALTHY_MS = 5 * 60 * 1000;
const DEFAULT_PING_UNHEALTHY_MS = 3 * 60 * 1000;
const DEFAULT_MAX_UNHEALTHY_PINGS = 5;
const instanceRequestTimestamps = new Map();

async function _staggeredInstanceRequest(instanceId, fn) {
  const last = instanceRequestTimestamps.get(instanceId) || 0;
  const now = Date.now();
  const wait = INSTANCE_REQUEST_DELAY_MS - (now - last);
  if (wait > 0) {
    await new Promise(resolve => setTimeout(resolve, wait));
  }

  try {
    return await fn();
  } finally {
    instanceRequestTimestamps.set(instanceId, Date.now());
  }
}

class InstanceService {
  constructor() {
    this.healthCache = new Map();
    this.analyzerStatusCache = new Map();
    this.instanceColumns = null;
  }

  _getCachedAnalyzerStatus(instanceId) {
    const entry = this.analyzerStatusCache.get(instanceId);
    if (!entry) return null;
    const ttl = config.instanceHealth?.analyzerCheckIntervalMs ?? DEFAULT_ANALYZER_TTL_MS;
    if (Date.now() - entry.checkedAt > ttl) return null;
    return entry.mode;
  }

  _setCachedAnalyzerStatus(instanceId, mode) {
    this.analyzerStatusCache.set(instanceId, { mode: !!mode, checkedAt: Date.now() });
  }

  async _hasColumn(columnName) {
    if (!this.instanceColumns) {
      const rows = await db.all("PRAGMA table_info('instances')");
      this.instanceColumns = new Set(rows.map((r) => r.name));
    }
    return this.instanceColumns.has(columnName);
  }

  /**
   * Get all instances
   * @param {Object} filters - Optional filters (is_active, is_analyzer_mode)
   * @returns {Promise<Array>} - List of instances
   */
  async getAllInstances(filters = {}) {
    try {
      let query = 'SELECT * FROM instances WHERE 1=1';
      const params = [];

      if (filters.is_active !== undefined) {
        query += ' AND is_active = ?';
        params.push(filters.is_active ? 1 : 0);
      }

      if (filters.is_analyzer_mode !== undefined) {
        query += ' AND is_analyzer_mode = ?';
        params.push(filters.is_analyzer_mode ? 1 : 0);
      }

      if (filters.health_status) {
        query += ' AND health_status = ?';
        params.push(filters.health_status);
      }

      query += ' ORDER BY created_at DESC';

      const instances = await db.all(query, params);
      return this._attachTelemetry(instances);
    } catch (error) {
      log.error('Failed to get instances', error);
      throw error;
    }
  }

  /**
   * Get instance by ID
   * @param {number} id - Instance ID
   * @returns {Promise<Object>} - Instance data
   */
  async getInstanceById(id) {
    try {
      const instance = await db.get('SELECT * FROM instances WHERE id = ?', [id]);

      if (!instance) {
        throw new NotFoundError('Instance');
      }

      return this._attachTelemetry([instance])[0];
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      log.error('Failed to get instance', error, { id });
      throw error;
    }
  }

  /**
   * Create new instance
   * @param {Object} data - Instance data
   * @returns {Promise<Object>} - Created instance
   */
  async createInstance(data) {
    try {
      // Validate and sanitize input
      const normalized = this._normalizeInstanceData(data);
      const hasOptionChain = await this._hasColumn('supports_option_chain');
      const hasUseWsQuotes = await this._hasColumn('use_ws_quotes');
      const hasMultiplier = await this._hasColumn('multiplier');

      // Check for duplicate host_url
      const existing = await db.get(
        'SELECT id FROM instances WHERE host_url = ?',
        [normalized.host_url]
      );

      if (existing) {
        throw new ConflictError('Instance with this host URL already exists');
      }

      // Test connection and auto-detect broker
      const connectionTest = await this.testConnection({
        host_url: normalized.host_url,
        api_key: normalized.api_key,
      });

      if (!connectionTest.success) {
        throw new ValidationError(connectionTest.message || 'Failed to connect to OpenAlgo instance');
      }

      // Auto-populate broker from ping response
      normalized.broker = connectionTest.broker;

      // Create instance
      const columns = [
        'name',
        'host_url',
        'api_key',
        'broker',
        'strategy_tag',
        'is_primary_admin',
        'is_secondary_admin',
        'market_data_role',
        'supports_multiquotes',
        'market_data_enabled',
      ];
      const values = [
        normalized.name,
        normalized.host_url,
        normalized.api_key,
        normalized.broker,
        normalized.strategy_tag,
        normalized.is_primary_admin ? 1 : 0,
        normalized.is_secondary_admin ? 1 : 0,
        normalized.market_data_role || 'none',
        normalized.supports_multiquotes ?? 0,
        normalized.market_data_enabled ?? 0,
      ];

      if (hasOptionChain) {
        columns.push('supports_option_chain');
        values.push(normalized.supports_option_chain ?? 0);
      }
      if (hasUseWsQuotes) {
        columns.push('use_ws_quotes');
        values.push(normalized.use_ws_quotes ?? 0);
      }
      if (hasMultiplier) {
        columns.push('multiplier');
        values.push(normalized.multiplier ?? 1);
      }
      if (normalized.session_target_profit !== undefined) {
        columns.push('session_target_profit');
        values.push(normalized.session_target_profit);
      }
      if (normalized.session_max_loss !== undefined) {
        columns.push('session_max_loss');
        values.push(normalized.session_max_loss);
      }

      const placeholders = columns.map(() => '?').join(', ');
      const result = await db.run(
        `INSERT INTO instances (${columns.join(', ')}) VALUES (${placeholders})`,
        values
      );

      const instance = await this.getInstanceById(result.lastID);

      log.info('Instance created', { id: instance.id, name: instance.name, broker: instance.broker });

      return instance;
    } catch (error) {
      if (error instanceof ConflictError || error instanceof ValidationError) {
        throw error;
      }
      log.error('Failed to create instance', error, { data });
      throw error;
    }
  }

  /**
   * Update instance
   * @param {number} id - Instance ID
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object>} - Updated instance
   */
  async updateInstance(id, updates) {
    try {
      // Load existing instance (throws if not found)
      const existing = await this.getInstanceById(id);
      const hasOptionChain = await this._hasColumn('supports_option_chain');
      const hasMultiplier = await this._hasColumn('multiplier');

      // Normalize updates
      const normalized = this._normalizeInstanceData(updates, true);

      // If host URL or API key changed, re-test connection and auto-detect broker
      const shouldRetestConnection =
        normalized.host_url !== undefined ||
        normalized.api_key !== undefined;

      if (shouldRetestConnection) {
        const connectionPayload = {
          host_url: normalized.host_url || existing.host_url,
          api_key: normalized.api_key || existing.api_key,
        };

        const connectionTest = await this.testConnection(connectionPayload);

        if (!connectionTest.success) {
          // Allow saving even if the instance is currently unreachable or the API key is invalid.
          // We log the warning but proceed so users can fix credentials/offline instances.
          log.warn('Instance update proceeding despite failed connection test', {
            id,
            message: connectionTest.message,
          });
        } else if (connectionTest.broker && normalized.broker === undefined) {
          // Auto-populate broker only if caller didn't explicitly override it
          normalized.broker = connectionTest.broker;
        }
      }

      // Build update query
      const fields = [];
      const values = [];

      for (const [key, value] of Object.entries(normalized)) {
        if (key === 'supports_option_chain' && !hasOptionChain) {
          continue;
        }
        if (key === 'use_ws_quotes' && !(await this._hasColumn('use_ws_quotes'))) {
          continue;
        }
        if (key === 'multiplier' && !hasMultiplier) {
          continue;
        }
        fields.push(`${key} = ?`);
        values.push(value);
      }

      if (fields.length === 0) {
        throw new ValidationError('No valid fields to update');
      }

      fields.push('last_updated = CURRENT_TIMESTAMP');
      values.push(id);

      await db.run(
        `UPDATE instances SET ${fields.join(', ')} WHERE id = ?`,
        values
      );

      const instance = await this.getInstanceById(id);

      log.info('Instance updated', { id, updates: Object.keys(normalized) });

      return instance;
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof ValidationError) {
        throw error;
      }
      log.error('Failed to update instance', error, { id, updates });
      throw error;
    }
  }

  /**
   * Delete instance
   * @param {number} id - Instance ID
   */
  async deleteInstance(id) {
    try {
      // Check if instance exists
      await this.getInstanceById(id);

      // Delete instance using transaction for atomicity
      await db.run('BEGIN TRANSACTION');

      try {
        // 1. Remove instance from all watchlists (watchlist_instances)
        await db.run('DELETE FROM watchlist_instances WHERE instance_id = ?', [id]);
        log.info('Removed instance from watchlists', { instance_id: id });

        // 2. Delete any orders for this instance (watchlist_orders)
        await db.run('DELETE FROM watchlist_orders WHERE instance_id = ?', [id]);
        log.info('Deleted orders for instance', { instance_id: id });

        // 3. Delete any positions for this instance (watchlist_positions)
        await db.run('DELETE FROM watchlist_positions WHERE instance_id = ?', [id]);
        log.info('Deleted positions for instance', { instance_id: id });

        // 4. Delete options state tracking
        await this._safeDeleteByInstanceId('watchlist_options_state', id);

        // 5. Delete quick order history
        await this._safeDeleteByInstanceId('quick_orders', id);

        // 6. Delete any order monitoring records (legacy + analyzer logs)
        await this._safeDeleteByInstanceId('order_monitoring', id);
        await this._safeDeleteByInstanceId('order_monitor_log', id);
        await this._safeDeleteByInstanceId('analyzer_trades', id);

        // 8. Finally, delete the instance itself
        await db.run('DELETE FROM instances WHERE id = ?', [id]);

        await db.run('COMMIT');
        log.info('Instance deleted successfully', { id });
      } catch (error) {
        await db.run('ROLLBACK');
        throw error;
      }
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      log.error('Failed to delete instance', error, { id });
      throw error;
    }
  }

  /**
   * Bulk update instances
   * @param {number[]} instanceIds - Array of instance IDs
   * @param {Object} updates - Fields to update (is_active, is_analyzer_mode)
   * @returns {Promise<Object>} - Result with count of updated instances
   */
  async bulkUpdateInstances(instanceIds, updates) {
    try {
      if (!instanceIds || instanceIds.length === 0) {
        throw new ValidationError('No instance IDs provided');
      }

      // Build SET clause dynamically
      const setClauses = [];
      const params = [];

      if (updates.is_active !== undefined) {
        setClauses.push('is_active = ?');
        params.push(updates.is_active ? 1 : 0);
      }

      if (updates.is_analyzer_mode !== undefined) {
        setClauses.push('is_analyzer_mode = ?');
        params.push(updates.is_analyzer_mode ? 1 : 0);
      }

      if (updates.multiplier !== undefined) {
        if (!(await this._hasColumn('multiplier'))) {
          throw new ValidationError('Multiplier is not supported in this database');
        }
        const multiplier = parseIntSafe(updates.multiplier, null);
        if (multiplier === null || multiplier < 1 || multiplier > 999) {
          throw new ValidationError('Multiplier must be an integer between 1 and 999');
        }
        setClauses.push('multiplier = ?');
        params.push(multiplier);
      }

      if (setClauses.length === 0) {
        throw new ValidationError('No fields to update');
      }

      // Add last_updated timestamp
      setClauses.push('last_updated = CURRENT_TIMESTAMP');

      // Create placeholders for WHERE IN clause
      const placeholders = instanceIds.map(() => '?').join(',');
      params.push(...instanceIds);

      const sql = `
        UPDATE instances
        SET ${setClauses.join(', ')}
        WHERE id IN (${placeholders})
      `;

      const result = await db.run(sql, params);

      log.info('Bulk updated instances', {
        instanceIds,
        updates,
        updated: result.changes,
      });

      return {
        updated: result.changes,
        requested: instanceIds.length,
      };
    } catch (error) {
      log.error('Failed to bulk update instances', error, { instanceIds, updates });
      throw error;
    }
  }

  /**
   * Update instance health status
   * @param {number} id - Instance ID
   * @returns {Promise<Object>} - Updated instance with health info
   */
  async updateHealthStatus(id, { force = false } = {}) {
    try {
      const instance = await this.getInstanceById(id);
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
      const hasAnalyzerCheckColumn = await this._hasColumn('last_analyzer_check_at');

      try {
        // Test connection
        const pingResponse = await _staggeredInstanceRequest(id, () => openalgoClient.ping(instance));
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
          const cachedAnalyzerMode = this._getCachedAnalyzerStatus(id);
          if (cachedAnalyzerMode !== null) {
            analyzerMode = cachedAnalyzerMode;
            shouldCheckAnalyzer = false;
          }
        }

        if (shouldCheckAnalyzer) {
          try {
            const analyzerStatus = await _staggeredInstanceRequest(id, () => openalgoClient.getAnalyzerStatus(instance));
            analyzerMode = analyzerStatus.analyze_mode || false;
            analyzerCheckPerformed = true;
            this._setCachedAnalyzerStatus(id, analyzerMode);
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

      return await this.getInstanceById(id);
    } catch (error) {
      log.error('Failed to update health status', error, { id });
      throw error;
    }
  }

  resetHealthCheckState(id) {
    this.healthCache.delete(id);
  }

  /**
   * Update instance P&L data
   * @param {number} id - Instance ID
   * @returns {Promise<Object>} - Updated instance with P&L
   */
  async updatePnLData(id) {
    try {
      const instance = await this.getInstanceById(id);

      try {
        const marketDataFeedService = (await import('./market-data-feed.service.js')).default;
        await marketDataFeedService.refreshFundsForInstance(id, { force: false });
        await marketDataFeedService.refreshPositionsForInstance(id, { force: false });
        const tradeSnap = await marketDataFeedService.getTradebookSnapshot(id, { force: false });

        const funds = marketDataFeedService.getFundsSnapshot(id)?.data || {};
        const tradebook = tradeSnap?.data || [];

        // Calculate P&L using tradebook values minus charges
        const currentBalance = parseFloat(funds.availablecash || 0);
        const brokerageSetting = await settingsService.getSetting('brokerage.by_broker').catch(() => null);
        const defaultBrokerageSetting = await settingsService.getSetting('brokerage.default').catch(() => null);
        const brokerageMap = buildBrokerageMap(brokerageSetting?.value);
        const defaultBrokerage = Number.isFinite(defaultBrokerageSetting?.value)
          ? defaultBrokerageSetting.value
          : 20;
        const brokerageValue = resolveBrokerageValue(instance.broker, brokerageMap, defaultBrokerage);
        const tradePnl = calculateTradebookPnL(Array.isArray(tradebook) ? tradebook : [], {
          brokerageValue,
        });
        const totalPnl = Number(tradePnl.net_pnl.toFixed(2));
        const buyTrades = tradePnl.buy_count || 0;
        const sellTrades = tradePnl.sell_count || 0;
        const buyValue = tradePnl.buy_value || 0;
        const sellValue = tradePnl.sell_value || 0;
        const realizedPnl = 0;
        const unrealizedPnl = 0;

        // Session-aware tracking (IST)
        const istNow = this._nowInIST();
        const todayIst = this._formatDateIST(istNow);
        const sessionState = await this._computeSessionState(instance, totalPnl, istNow);
        const {
          currentSession,
          sessionKey,
          sessionLabel,
          sessionBaseline,
          sessionBaselineAt,
          sessionPnl,
          maxLossHits,
          hitsKey,
          cutoffReason,
          lastLiveTotalPnl,
          lastLiveTotalPnlAt,
          isLiveMode,
        } = sessionState;

        // Auto-revert to live at start of a new session if prior cutoff was max-loss (not limit reached)
        if (
          instance.is_analyzer_mode &&
          currentSession &&
          instance.session_cutoff_reason &&
          instance.session_cutoff_reason.startsWith('SESSION_MAX_LOSS') &&
          cutoffReason === null &&
          hitsKey !== sessionKey // new session window
        ) {
          try {
            await this.toggleAnalyzerMode(id, false);
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
            max_loss_hits: maxLossHits,
          });
          // fire-and-forget safe toggle; errors logged but do not throw to keep polling running
          try {
            await this.toggleAnalyzerMode(id, true);
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
            session_max_loss_hits = ?,
            session_max_loss_hits_date = ?,
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
            maxLossHits,
            sessionKey || hitsKey || null,
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

        return await this.getInstanceById(id);
      } catch (error) {
        log.error('Failed to fetch P&L data from OpenAlgo', error, { id });
        throw error;
      }
    } catch (error) {
      log.error('Failed to update P&L data', error, { id });
      throw error;
    }
  }

  /**
   * Refresh analyzer mode status on a fixed cadence
   * @param {number} id - Instance ID
   * @param {Object} options
   * @param {boolean} options.force - Bypass TTL checks
   */
  async refreshAnalyzerStatus(id, { force = false } = {}) {
    const instance = await this.getInstanceById(id);
    const hasAnalyzerCheckColumn = await this._hasColumn('last_analyzer_check_at');

    if (!force) {
      if (hasAnalyzerCheckColumn && instance.last_analyzer_check_at) {
        const lastCheck = Date.parse(instance.last_analyzer_check_at);
        const ttl = config.instanceHealth?.analyzerCheckIntervalMs ?? DEFAULT_ANALYZER_TTL_MS;
        if (!Number.isNaN(lastCheck) && Date.now() - lastCheck < ttl) {
          return instance;
        }
      } else if (!hasAnalyzerCheckColumn) {
        const cachedAnalyzerMode = this._getCachedAnalyzerStatus(id);
        if (cachedAnalyzerMode !== null) {
          return instance;
        }
      }
    }

    try {
      const analyzerStatus = await _staggeredInstanceRequest(id, () => openalgoClient.getAnalyzerStatus(instance));
      const analyzerMode = analyzerStatus.analyze_mode || false;
      this._setCachedAnalyzerStatus(id, analyzerMode);

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

    return await this.getInstanceById(id);
  }

  /**
   * Toggle analyzer mode
   * @param {number} id - Instance ID
   * @param {boolean} mode - true for analyze, false for live
   * @returns {Promise<Object>} - Updated instance
   */
  async toggleAnalyzerMode(id, mode) {
    try {
      const instance = await this.getInstanceById(id);

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
      this._setCachedAnalyzerStatus(id, mode);

      // Update database
      const hasAnalyzerCheckColumn = await this._hasColumn('last_analyzer_check_at');
      let sql = 'UPDATE instances SET is_analyzer_mode = ?, last_updated = CURRENT_TIMESTAMP';
      const params = [mode ? 1 : 0];

      if (!mode) {
        const istNow = this._nowInIST();
        const todayIst = this._formatDateIST(istNow);
        const sessions = await this._getTradingSessions();
        const currentSession = this._findCurrentSession(istNow, sessions);
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

      return await this.getInstanceById(id);
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      log.error('Failed to toggle analyzer mode', error, { id, mode });
      throw error;
    }
  }

  /**
   * Test connection to OpenAlgo instance (using ping endpoint)
   * @param {Object} credentials - { host_url, api_key }
   * @returns {Promise<Object>} - { success, broker, message }
   */
  async testConnection(credentials) {
    try {
      const { host_url, api_key } = credentials;

      if (!host_url || !api_key) {
        return {
          success: false,
          message: 'Host URL and API key are required',
        };
      }

      // Create temporary instance object for testing
      const tempInstance = {
        host_url: normalizeUrl(host_url),
        api_key: sanitizeApiKey(api_key),
      };

      // Call ping endpoint to test connection and get broker name
      // Note: ping() already returns response.data, not the full response
      const pingData = await openalgoClient.ping(tempInstance);

      log.debug('Ping response received', {
        host_url: tempInstance.host_url,
        pingData,
      });

      // Check for broker in the response (pingData is already response.data)
      if (pingData && pingData.broker) {
        log.info('Connection test successful', {
          host_url: tempInstance.host_url,
          broker: pingData.broker,
        });

        return {
          success: true,
          broker: pingData.broker,
          message: pingData.message || 'Connection successful',
        };
      }

      // Log the full response to help debug
      log.warn('Broker information not found in ping response', {
        host_url: tempInstance.host_url,
        pingData,
      });

      return {
        success: false,
        message: 'Ping successful but broker information not found in response',
      };
    } catch (error) {
      log.warn('Connection test failed', { error: error.message });
      return {
        success: false,
        message: error.message || 'Failed to connect to OpenAlgo instance',
      };
    }
  }

  /**
   * Test API key validity (using funds endpoint)
   * @param {Object} credentials - { host_url, api_key }
   * @returns {Promise<Object>} - { success, message, funds }
   */
  async testApiKey(credentials) {
    try {
      const { host_url, api_key } = credentials;

      if (!host_url || !api_key) {
        return {
          success: false,
          message: 'Host URL and API key are required',
        };
      }

      // Create temporary instance object for testing
      const tempInstance = {
        host_url: normalizeUrl(host_url),
        api_key: sanitizeApiKey(api_key),
      };

      // Call funds endpoint to validate API key
      // Note: getFunds() already returns response.data, not the full response
      const fundsData = await openalgoClient.getFunds(tempInstance);

      log.debug('Funds response received', {
        host_url: tempInstance.host_url,
        fundsData,
      });

      if (fundsData) {
        log.info('API key test successful', {
          host_url: tempInstance.host_url,
        });

        return {
          success: true,
          message: 'API key is valid',
          funds: fundsData,
        };
      }

      return {
        success: false,
        message: 'Invalid API key or funds data not available',
      };
    } catch (error) {
      log.warn('API key test failed', { error: error.message });
      return {
        success: false,
        message: error.message || 'Invalid API key',
      };
    }
  }

  /**
   * Get admin instances
   * @returns {Promise<Object>} - { primary, secondary }
   */
  async getAdminInstances() {
    try {
      const primary = await db.get(
        'SELECT * FROM instances WHERE is_primary_admin = 1 AND is_active = 1 LIMIT 1'
      );

      const secondary = await db.get(
        'SELECT * FROM instances WHERE is_secondary_admin = 1 AND is_active = 1 LIMIT 1'
      );

      return { primary, secondary };
    } catch (error) {
      log.error('Failed to get admin instances', error);
      throw error;
    }
  }

  /**
   * Get instances designated for market data (primary or secondary role)
   * @returns {Promise<Array>} - List of instances with market data role
   */
  async getMarketDataInstances() {
    try {
      const instances = await db.all(
        `SELECT * FROM instances
         WHERE market_data_role IN ('primary', 'secondary')
         AND is_active = 1
         ORDER BY
           CASE market_data_role
             WHEN 'primary' THEN 1
             WHEN 'secondary' THEN 2
           END`
      );

      return instances;
    } catch (error) {
      log.error('Failed to get market data instances', error);
      throw error;
    }
  }

  _nowInIST() {
    return toISTDate();
  }

  _formatDateIST(date) {
    const year = date.getFullYear();
    const month = `${date.getMonth() + 1}`.padStart(2, '0');
    const day = `${date.getDate()}`.padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  async _computeSessionState(instance, totalPnl, now, { overrideAnalyzerMode = null } = {}) {
    const istNow = now || this._nowInIST();
    const todayIst = this._formatDateIST(istNow);
    const sessions = await this._getTradingSessions();
    const currentSession = this._findCurrentSession(istNow, sessions);

    let sessionBaseline = instance.session_baseline_total_pnl;
    let sessionBaselineAt = instance.session_baseline_at;
    let sessionPnl = instance.session_pnl;
    let cutoffReason = null;

    const sessionLabel = currentSession?.label || null;
    const sessionKey = currentSession ? `${todayIst}|${sessionLabel}` : null;

    let maxLossHits = parseIntSafe(instance.session_max_loss_hits, 0);
    const hitsKey = instance.session_max_loss_hits_date;
    if (currentSession && hitsKey !== sessionKey) {
      maxLossHits = 0;
    }

    const analyzerMode = overrideAnalyzerMode === null ? !!instance.is_analyzer_mode : !!overrideAnalyzerMode;
    const isLiveMode = !analyzerMode;

    let lastLiveTotalPnl = instance.last_live_total_pnl;
    let lastLiveTotalPnlAt = instance.last_live_total_pnl_at;
    if (isLiveMode) {
      lastLiveTotalPnl = totalPnl;
      lastLiveTotalPnlAt = toISTISOString();
    }

    const target = parseFloatSafe(instance.session_target_profit, null);
    const maxLoss = parseFloatSafe(instance.session_max_loss, null);
    const rawMultiplier = parseFloatSafe(instance.multiplier, 1);
    const multiplier = rawMultiplier > 0 ? rawMultiplier : 1;
    const effectiveTarget = target !== null ? target * multiplier : null;
    const effectiveMaxLoss = maxLoss !== null ? Math.abs(maxLoss) * multiplier : null;

    if (isLiveMode && currentSession) {
      if (sessionBaselineAt !== sessionKey || sessionBaseline === null || sessionBaseline === undefined) {
        sessionBaseline = totalPnl;
        sessionBaselineAt = sessionKey;
        sessionPnl = 0;
      } else {
        sessionPnl = totalPnl - sessionBaseline;
      }

      if (effectiveTarget !== null && sessionPnl >= effectiveTarget) {
        cutoffReason = 'SESSION_TARGET_PROFIT_REACHED';
      } else if (effectiveMaxLoss !== null && sessionPnl <= -effectiveMaxLoss) {
        maxLossHits += 1;
        const limitReached = maxLossHits >= 3;
        cutoffReason = limitReached
          ? 'SESSION_MAX_LOSS_LIMIT_REACHED'
          : 'SESSION_MAX_LOSS_BREACHED';
      }
    }

    return {
      currentSession,
      sessionKey,
      sessionLabel,
      sessionBaseline,
      sessionBaselineAt,
      sessionPnl,
      maxLossHits,
      hitsKey,
      cutoffReason,
      effectiveTarget,
      effectiveMaxLoss,
      lastLiveTotalPnl,
      lastLiveTotalPnlAt,
      isLiveMode,
    };
  }

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

  _parseHmToMinutes(hm = '') {
    const [h, m] = hm.split(':').map((v) => parseInt(v, 10));
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    return h * 60 + m;
  }

  async _upsertDailyPnlSnapshot(instanceId, snapshotDate, payload) {
    const {
      total_pnl = 0,
      buy_trades = 0,
      sell_trades = 0,
      buy_value = 0,
      sell_value = 0,
    } = payload || {};

    const existing = await db.get(
      `SELECT id, total_pnl, buy_trades, sell_trades, buy_value, sell_value
       FROM daily_instance_pnl_snapshots
       WHERE instance_id = ? AND snapshot_date = ?`,
      [instanceId, snapshotDate]
    );

    if (existing) {
      if (total_pnl === 0 && existing.total_pnl !== 0) {
        return;
      }
      if (
        buy_trades < existing.buy_trades ||
        sell_trades < existing.sell_trades ||
        buy_value < existing.buy_value ||
        sell_value < existing.sell_value
      ) {
        return;
      }

      await db.run(
        `UPDATE daily_instance_pnl_snapshots
         SET total_pnl = ?,
             buy_trades = ?,
             sell_trades = ?,
             buy_value = ?,
             sell_value = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [total_pnl, buy_trades, sell_trades, buy_value, sell_value, existing.id]
      );
      return;
    }

    await db.run(
      `INSERT INTO daily_instance_pnl_snapshots
        (instance_id, snapshot_date, total_pnl, buy_trades, sell_trades, buy_value, sell_value)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [instanceId, snapshotDate, total_pnl, buy_trades, sell_trades, buy_value, sell_value]
    );
  }

  _findCurrentSession(date, sessions = []) {
    const minutes = date.getHours() * 60 + date.getMinutes();
    return sessions.find((s) => {
      const start = this._parseHmToMinutes(s.start);
      const end = this._parseHmToMinutes(s.end);
      if (start === null || end === null) return false;
      return minutes >= start && minutes < end;
    });
  }

  async _getTradingSessions() {
    const fallback = [
      { label: 'Session 1', start: '09:00', end: '11:30' },
      { label: 'Session 2', start: '12:30', end: '15:10' },
      { label: 'Session 3', start: '15:45', end: '19:00' },
      { label: 'Session 4', start: '20:30', end: '22:45' },
    ];

    try {
      const setting = await settingsService.getSetting('trading_sessions');
      const raw = setting?.value ?? setting?.rawValue;
      if (Array.isArray(raw)) {
        return raw;
      }
      if (typeof raw === 'string') {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed;
        }
      }
    } catch (error) {
      log.warn('Falling back to default trading sessions', { error: error.message });
    }
    return fallback;
  }

  /**
   * Normalize and validate instance data
   * @private
   */
  _normalizeInstanceData(data, isUpdate = false) {
    const normalized = {};
    const errors = [];

    // Name
    if (data.name !== undefined) {
      const name = sanitizeString(data.name);
      if (!name && !isUpdate) {
        errors.push({ field: 'name', message: 'Name is required' });
      } else if (name) {
        normalized.name = name;
      }
    }

    // Host URL
    if (data.host_url !== undefined) {
      const hostUrl = normalizeUrl(data.host_url);
      if (!hostUrl && !isUpdate) {
        errors.push({ field: 'host_url', message: 'Valid host URL is required' });
      } else if (hostUrl) {
        normalized.host_url = hostUrl;
      }
    }

    // API Key
    if (data.api_key !== undefined) {
      const apiKey = sanitizeApiKey(data.api_key);
      if (!apiKey && !isUpdate) {
        errors.push({ field: 'api_key', message: 'API key is required' });
      } else if (apiKey) {
        normalized.api_key = apiKey;
      }
    }

    // Strategy Tag
    if (data.strategy_tag !== undefined) {
      normalized.strategy_tag = sanitizeStrategyTag(data.strategy_tag);
    }

    // Instance multiplier
    if (data.multiplier !== undefined) {
      const multiplier = parseIntSafe(data.multiplier, null);
      if (multiplier === null || multiplier < 1 || multiplier > 999) {
        errors.push({ field: 'multiplier', message: 'Multiplier must be an integer between 1 and 999' });
      } else {
        normalized.multiplier = multiplier;
      }
    } else if (!isUpdate) {
      normalized.multiplier = 1;
    }

    // Session-level risk controls
    if (data.session_target_profit !== undefined) {
      const val = parseFloat(data.session_target_profit);
      if (!Number.isNaN(val)) {
        normalized.session_target_profit = val;
      }
    }

    if (data.session_max_loss !== undefined) {
      const val = parseFloat(data.session_max_loss);
      if (!Number.isNaN(val)) {
        normalized.session_max_loss = val;
      }
    }

    // Broker (auto-detected, but can be overridden)
    if (data.broker !== undefined) {
      normalized.broker = sanitizeString(data.broker);
    }

    // Market data role
    if (data.market_data_role !== undefined) {
      const validRoles = ['none', 'primary', 'secondary'];
      const role = String(data.market_data_role).toLowerCase();
      if (validRoles.includes(role)) {
        normalized.market_data_role = role;
      }
    }

    // Market data enabled (new flag)
    if (data.market_data_enabled !== undefined) {
      normalized.market_data_enabled = parseBooleanSafe(data.market_data_enabled, false) ? 1 : 0;
    }

    // MultiQuotes support flag
    if (data.supports_multiquotes !== undefined) {
      normalized.supports_multiquotes = parseBooleanSafe(data.supports_multiquotes, false) ? 1 : 0;
    }

    // Broker WebSocket quotes opt-in
    if (data.use_ws_quotes !== undefined) {
      normalized.use_ws_quotes = parseBooleanSafe(data.use_ws_quotes, false) ? 1 : 0;
    } else if (!isUpdate) {
      normalized.use_ws_quotes = 1;
    }

    // Option chain API support flag
    if (data.supports_option_chain !== undefined) {
      normalized.supports_option_chain = parseBooleanSafe(data.supports_option_chain, false) ? 1 : 0;
    }

    // Admin flags
    if (data.is_primary_admin !== undefined) {
      normalized.is_primary_admin = parseBooleanSafe(data.is_primary_admin, false);
    }

    if (data.is_secondary_admin !== undefined) {
      normalized.is_secondary_admin = parseBooleanSafe(data.is_secondary_admin, false);
    }

    // Status flags
    if (data.is_active !== undefined) {
      normalized.is_active = parseBooleanSafe(data.is_active, true);
    }

    if (data.is_analyzer_mode !== undefined) {
      normalized.is_analyzer_mode = parseBooleanSafe(data.is_analyzer_mode, false);
    }

    if (data.order_placement_enabled !== undefined) {
      normalized.order_placement_enabled = parseBooleanSafe(data.order_placement_enabled, true);
    }

    if (errors.length > 0) {
      throw new ValidationError('Instance validation failed', errors);
    }

    return normalized;
  }

  _attachTelemetry(instances = []) {
    const metricsList = openalgoClient.getInstanceMetrics();
    const byId = new Map();
    const byKey = new Map();
    metricsList.forEach((m) => {
      if (m.id !== undefined && m.id !== null) {
        byId.set(String(m.id), m);
      }
      if (m.key) {
        byKey.set(String(m.key), m);
      }
      if (m.host_url) {
        byKey.set(m.host_url, m);
      }
    });

    return instances.map((inst) => {
      const metric = byId.get(String(inst.id)) || byKey.get(inst.host_url) || byKey.get(inst.name);
      return {
        ...inst,
        limit_metrics: metric || null,
      };
    });
  }

  async getWebsocketCapableInstanceIds() {
    try {
      const rows = await db.all(`
        SELECT id FROM instances
        WHERE is_active = 1
          AND use_ws_quotes = 1
      `);
      return rows.map((r) => r.id);
    } catch (err) {
      log.warn('Failed to resolve websocket-capable instances', { error: err.message });
      return [];
    }
  }

  async _safeDeleteByInstanceId(tableName, instanceId) {
    try {
      await db.run(`DELETE FROM ${tableName} WHERE instance_id = ?`, [instanceId]);
      log.info(`Deleted ${tableName} rows for instance`, { instance_id: instanceId });
    } catch (error) {
      if (error.message && error.message.includes('no such table')) {
        log.warn(`Skipping cleanup for missing table ${tableName}`, { instance_id: instanceId });
        return;
      }
      throw error;
    }
  }
}

// Export singleton instance
export default new InstanceService();
export { InstanceService };
