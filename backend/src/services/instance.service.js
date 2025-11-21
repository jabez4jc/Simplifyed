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
} from '../utils/sanitizers.js';
import settingsService from './settings.service.js';

class InstanceService {
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
      const result = await db.run(
        `INSERT INTO instances (
          name, host_url, api_key, broker, strategy_tag,
          is_primary_admin, is_secondary_admin,
          market_data_role
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          normalized.name,
          normalized.host_url,
          normalized.api_key,
          normalized.broker,
          normalized.strategy_tag,
          normalized.is_primary_admin ? 1 : 0,
          normalized.is_secondary_admin ? 1 : 0,
          normalized.market_data_role || 'none',
        ]
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
  async updateHealthStatus(id) {
    try {
      const instance = await this.getInstanceById(id);

      let healthStatus = 'unknown';
      let analyzerMode = instance.is_analyzer_mode;

      try {
        // Test connection
        const pingResponse = await openalgoClient.ping(instance);
        healthStatus = 'healthy';

        // Update last ping time
        await db.run(
          'UPDATE instances SET last_ping_at = CURRENT_TIMESTAMP WHERE id = ?',
          [id]
        );

        // Get analyzer status
        try {
          const analyzerStatus = await openalgoClient.getAnalyzerStatus(instance);
          analyzerMode = analyzerStatus.analyze_mode || false;
        } catch (error) {
          log.warn('Failed to get analyzer status', { id, error: error.message });
        }
      } catch (error) {
        healthStatus = 'unhealthy';
        log.warn('Health check failed', { id, error: error.message });
      }

      // Update health status in database
      await db.run(
        `UPDATE instances SET
          health_status = ?,
          is_analyzer_mode = ?,
          last_health_check = CURRENT_TIMESTAMP
        WHERE id = ?`,
        [healthStatus, analyzerMode ? 1 : 0, id]
      );

      return await this.getInstanceById(id);
    } catch (error) {
      log.error('Failed to update health status', error, { id });
      throw error;
    }
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
        // Fetch data from OpenAlgo
        const [funds, tradebook, positionbook] = await Promise.all([
          openalgoClient.getFunds(instance),
          openalgoClient.getTradeBook(instance),
          openalgoClient.getPositionBook(instance),
        ]);

        // Calculate P&L
        const currentBalance = parseFloat(funds.availablecash || 0);

        // Get realized P&L from funds endpoint (m2mrealized or realized_pnl)
        // OpenAlgo's tradebook doesn't expose per-trade P&L, so we rely on the funds endpoint
        const realizedPnl = parseFloat(
          funds.m2mrealized ||
          funds.realized_pnl ||
          funds.realizedpnl ||
          0
        );

        // Calculate unrealized P&L from positionbook
        let unrealizedPnl = 0;
        if (Array.isArray(positionbook)) {
          unrealizedPnl = positionbook.reduce((sum, position) => {
            const pnl = parseFloat(position.pnl || position.unrealized_pnl || 0);
            return sum + pnl;
          }, 0);
        }

        const totalPnl = realizedPnl + unrealizedPnl;

        // Session-aware tracking (IST)
        const istNow = this._nowInIST();
        const todayIst = this._formatDateIST(istNow);
        const sessions = await this._getTradingSessions();
        const currentSession = this._findCurrentSession(istNow, sessions);

        let sessionBaseline = instance.session_baseline_total_pnl;
        let sessionBaselineAt = instance.session_baseline_at;
        let sessionPnl = instance.session_pnl;
        let lastLiveTotalPnl = instance.last_live_total_pnl;
        let lastLiveTotalPnlAt = instance.last_live_total_pnl_at;
        let cutoffReason = null;

        if (!instance.is_analyzer_mode) {
          lastLiveTotalPnl = totalPnl;
          lastLiveTotalPnlAt = new Date().toISOString();
        }

        if (!instance.is_analyzer_mode && currentSession) {
          const sessionLabel = currentSession.label || 'Session';
          const sessionKey = `${todayIst}|${sessionLabel}`;

          if (sessionBaselineAt !== sessionKey || sessionBaseline === null || sessionBaseline === undefined) {
            sessionBaseline = totalPnl;
            sessionBaselineAt = sessionKey;
            sessionPnl = 0;
          } else {
            sessionPnl = totalPnl - sessionBaseline;
          }

          const target = parseFloatSafe(instance.session_target_profit, null);
          const maxLoss = parseFloatSafe(instance.session_max_loss, null);

          if (target !== null && sessionPnl >= target) {
            cutoffReason = 'SESSION_TARGET_PROFIT_REACHED';
          } else if (maxLoss !== null && sessionPnl <= -Math.abs(maxLoss)) {
            cutoffReason = 'SESSION_MAX_LOSS_BREACHED';
          }

          if (cutoffReason) {
            log.warn('Session cutoff triggered; switching to analyzer mode', {
              id,
              session: sessionLabel,
              session_pnl: sessionPnl,
              reason: cutoffReason,
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

      // Update database
      await db.run(
        'UPDATE instances SET is_analyzer_mode = ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?',
        [mode ? 1 : 0, id]
      );

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
    const istString = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
    return new Date(istString);
  }

  _formatDateIST(date) {
    const year = date.getFullYear();
    const month = `${date.getMonth() + 1}`.padStart(2, '0');
    const day = `${date.getDate()}`.padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  _parseHmToMinutes(hm = '') {
    const [h, m] = hm.split(':').map((v) => parseInt(v, 10));
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    return h * 60 + m;
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
