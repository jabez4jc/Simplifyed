/**
 * Instance Management Service (core)
 * Owns CRUD operations and schema feature-detection for instance records. Health-check
 * pinging, analyzer-mode switching, connection testing, and P&L/session accounting were
 * split out to their own services (instance-health-check.service.js,
 * instance-analyzer.service.js, instance-connection-test.service.js,
 * instance-pnl.service.js) - this file keeps thin delegating wrapper methods with
 * identical signatures for all of them, so this remains the single singleton every other
 * file imports and the public API is unchanged.
 *
 * The three extracted services that read instances/schema state import this file's
 * singleton back (for getInstanceById/_hasColumn), so the wrapper methods below use
 * dynamic import() rather than a static import to avoid a circular static-import cycle -
 * same technique already used for market-data-feed.service.js in updatePnLData/below.
 */

import db from '../core/database.js';
import { log } from '../core/logger.js';
import openalgoClient from '../integrations/openalgo/client.js';
import {
  NotFoundError,
  ConflictError,
  ValidationError,
} from '../core/errors.js';
import instanceConnectionTestService from './instance-connection-test.service.js';
import { normalizeInstanceData } from '../utils/instance-validation.util.js';
import { nowInIST, computeSessionState } from '../utils/instance-session.util.js';
import { parseIntSafe } from '../utils/sanitizers.js';

class InstanceService {
  constructor() {
    this.instanceColumns = null;
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
      const normalized = normalizeInstanceData(data);
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
      const normalized = normalizeInstanceData(updates, true);

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
   * Update instance health status - delegates to instance-health-check.service.js
   */
  async updateHealthStatus(id, opts = {}) {
    const instanceHealthCheckService = (await import('./instance-health-check.service.js')).default;
    return instanceHealthCheckService.updateHealthStatus(id, opts);
  }

  /**
   * Delegates to instance-health-check.service.js
   */
  async resetHealthCheckState(id) {
    const instanceHealthCheckService = (await import('./instance-health-check.service.js')).default;
    return instanceHealthCheckService.resetHealthCheckState(id);
  }

  /**
   * Delegates to instance-pnl.service.js
   */
  async updatePnLData(id) {
    const instancePnlService = (await import('./instance-pnl.service.js')).default;
    return instancePnlService.updatePnLData(id);
  }

  /**
   * Delegates to instance-analyzer.service.js
   */
  async refreshAnalyzerStatus(id, opts = {}) {
    const instanceAnalyzerService = (await import('./instance-analyzer.service.js')).default;
    return instanceAnalyzerService.refreshAnalyzerStatus(id, opts);
  }

  /**
   * Delegates to instance-analyzer.service.js
   */
  async toggleAnalyzerMode(id, mode) {
    const instanceAnalyzerService = (await import('./instance-analyzer.service.js')).default;
    return instanceAnalyzerService.toggleAnalyzerMode(id, mode);
  }

  /**
   * Test connection to OpenAlgo instance - delegates to instance-connection-test.service.js
   * @param {Object} credentials - { host_url, api_key }
   * @returns {Promise<Object>} - { success, broker, message }
   */
  async testConnection(credentials) {
    return instanceConnectionTestService.testConnection(credentials);
  }

  /**
   * Test API key validity - delegates to instance-connection-test.service.js
   * @param {Object} credentials - { host_url, api_key }
   * @returns {Promise<Object>} - { success, message, funds }
   */
  async testApiKey(credentials) {
    return instanceConnectionTestService.testApiKey(credentials);
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
    return nowInIST();
  }

  async _computeSessionState(instance, totalPnl, now, opts = {}) {
    return computeSessionState(instance, totalPnl, now, opts);
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
