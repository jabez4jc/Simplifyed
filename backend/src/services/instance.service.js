/**
 * Instance Management Service (core)
 * Owns CRUD operations and schema feature-detection for instance records. Health-check
 * pinging, analyzer-mode switching, connection testing and P&L/session accounting live in
 * instance-health-check.service.js, instance-analyzer.service.js,
 * instance-connection-test.service.js and instance-pnl.service.js - import those directly.
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
import { parseIntSafe, isMaskedApiKey } from '../utils/sanitizers.js';

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
      const normalized = normalizeInstanceData(data);
      // Check for duplicate host_url
      const existing = await db.get(
        'SELECT id FROM instances WHERE host_url = ?',
        [normalized.host_url]
      );

      if (existing) {
        throw new ConflictError('Instance with this host URL already exists');
      }

      // Test connection and auto-detect broker
      const connectionTest = await instanceConnectionTestService.testConnection({
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
        'supports_multiquotes',
        'market_data_enabled',
        'supports_option_chain',
        'use_ws_quotes',
        'multiplier',
      ];
      const values = [
        normalized.name,
        normalized.host_url,
        normalized.api_key,
        normalized.broker,
        normalized.strategy_tag,
        normalized.supports_multiquotes ?? 0,
        normalized.market_data_enabled ?? 0,
        normalized.supports_option_chain ?? 0,
        normalized.use_ws_quotes ?? 0,
        normalized.multiplier ?? 1,
      ];
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
      // Creation just pinged the broker successfully, so mark it healthy now. A new row starts
      // 'unknown', and only 'healthy' instances serve market data - it sat out of the pool (no
      // quotes, no chart history) until the next scheduled check, minutes away.
      let created = instance;
      try {
        created = (await (await import('./instance-health-check.service.js')).default.updateHealthStatus(instance.id, { force: true })) || instance;
      } catch (error) {
        log.warn('Initial health check after create failed', { id: instance.id, error: error.message });
      }

      return created;
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
      // The edit form is shown the masked api_key (see maskInstanceForResponse) and round-trips
      // it back unchanged when the user edits an unrelated field - drop it so we don't overwrite
      // the real stored key with asterisks. A genuine new key never starts with '*'.
      if (isMaskedApiKey(updates.api_key)) {
        updates = { ...updates };
        delete updates.api_key;
      }

      // Normalize updates
      const normalized = normalizeInstanceData(updates, true);

      // Re-test the connection only when the credentials ACTUALLY changed.
      //
      // The edit form posts every field it renders, so host_url is present on every save whether
      // or not it was touched. Testing on mere presence meant renaming an instance, or clearing
      // a session target, blocked on a live broker round-trip - and on an instance that is down
      // (the exact reason someone opens this form) that is a request that sits on the network
      // timeout before it can save anything.
      const shouldRetestConnection =
        (normalized.host_url !== undefined && normalized.host_url !== existing.host_url) ||
        (normalized.api_key !== undefined && normalized.api_key !== existing.api_key);

      if (shouldRetestConnection) {
        const connectionPayload = {
          host_url: normalized.host_url || existing.host_url,
          api_key: normalized.api_key || existing.api_key,
        };

        const connectionTest = await instanceConnectionTestService.testConnection(connectionPayload);

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

        // 3. Delete quick order history
        await db.run('DELETE FROM quick_orders WHERE instance_id = ?', [id]);

        // 4. Finally, delete the instance itself
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
   * @param {Object} updates - Fields to update (is_active, multiplier)
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

      if (updates.multiplier !== undefined) {
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


}

// Export singleton instance
export default new InstanceService();
