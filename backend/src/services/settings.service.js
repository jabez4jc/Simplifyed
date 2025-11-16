/**
 * Settings Service
 * Manages 6-tier settings hierarchy and configuration precedence
 *
 * Precedence Order (last wins):
 * 1. Global defaults
 * 2. Index profiles
 * 3. Watchlist overrides
 * 4. User defaults
 * 5. Symbol overrides
 * 6. Per-click runtime overrides
 *
 * Features:
 * - Hierarchical settings merge
 * - Audit trail for all changes
 * - In-memory caching (30s TTL)
 * - Conservative defaults
 */

import db from '../core/database.js';
import { log } from '../core/logger.js';
import {
  NotFoundError,
  ValidationError,
  ConflictError,
} from '../core/errors.js';
import {
  sanitizeString,
  parseFloatSafe,
  parseIntSafe,
  parseBooleanSafe,
} from '../utils/sanitizers.js';

class SettingsService {
  constructor() {
    // In-memory cache for effective settings (30s TTL)
    this.cache = new Map();
    this.cacheTTL = 30000; // 30 seconds
  }

  /**
   * Get effective settings by merging all hierarchy levels
   * Precedence: Global → Index → Watchlist → User → Symbol → Runtime
   *
   * @param {Object} context - Context for settings resolution
   * @param {number} context.userId - User ID
   * @param {number} context.watchlistId - Watchlist ID (optional)
   * @param {string} context.indexName - Index name (optional, e.g., 'NIFTY')
   * @param {string} context.symbol - Symbol (optional, for direct symbols)
   * @param {string} context.exchange - Exchange (optional, for direct symbols)
   * @param {Object} context.runtimeOverrides - Per-click overrides (optional)
   * @returns {Promise<Object>} - Merged effective settings
   */
  async getEffectiveSettings(context) {
    const {
      userId,
      watchlistId,
      indexName,
      symbol,
      exchange,
      runtimeOverrides = {},
    } = context;

    try {
      // Check cache first (cache key based on context)
      const cacheKey = this._getCacheKey(context);
      const cached = this._getFromCache(cacheKey);
      if (cached && !runtimeOverrides || Object.keys(runtimeOverrides).length === 0) {
        log.debug('Settings cache hit', { cacheKey });
        return cached;
      }

      // Build settings by merging hierarchy
      let settings = {};

      // 1. Global defaults (base layer)
      const globalDefaults = await this._getGlobalDefaults();
      settings = { ...settings, ...this._removeNulls(globalDefaults) };

      // 2. Index profile (if indexName provided)
      if (indexName) {
        const indexProfile = await this._getIndexProfile(indexName);
        if (indexProfile) {
          settings = { ...settings, ...this._removeNulls(indexProfile) };
        }
      }

      // 3. Watchlist overrides (if watchlistId provided)
      if (watchlistId) {
        const watchlistOverride = await this._getWatchlistOverrides(
          watchlistId,
          indexName
        );
        if (watchlistOverride) {
          settings = { ...settings, ...this._removeNulls(watchlistOverride) };
        }
      }

      // 4. User defaults (if userId provided)
      if (userId) {
        const userDefaults = await this._getUserDefaults(userId);
        if (userDefaults) {
          settings = { ...settings, ...this._removeNulls(userDefaults) };
        }
      }

      // 5. Symbol overrides (if symbol provided)
      if (symbol && exchange) {
        const symbolOverride = await this._getSymbolOverrides(symbol, exchange);
        if (symbolOverride) {
          settings = { ...settings, ...this._removeNulls(symbolOverride) };
        }
      }

      // 6. Runtime overrides (highest priority)
      settings = { ...settings, ...this._removeNulls(runtimeOverrides) };

      // Cache the result (without runtime overrides)
      if (!runtimeOverrides || Object.keys(runtimeOverrides).length === 0) {
        this._setCache(cacheKey, settings);
      }

      log.info('Effective settings resolved', {
        userId,
        watchlistId,
        indexName,
        symbol,
        hasRuntimeOverrides: Object.keys(runtimeOverrides).length > 0,
      });

      return settings;
    } catch (error) {
      log.error('Failed to get effective settings', error, context);
      throw error;
    }
  }

  /**
   * Update global defaults
   * @param {Object} updates - Fields to update
   * @param {number} userId - User making the change
   * @returns {Promise<Object>} - Updated global defaults
   */
  async updateGlobalDefaults(updates, userId) {
    try {
      const normalized = this._normalizeSettings(updates);

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

      fields.push('updated_at = CURRENT_TIMESTAMP');
      values.push(1); // Global defaults always has id = 1

      await db.run(
        `UPDATE global_defaults SET ${fields.join(', ')} WHERE id = ?`,
        values
      );

      // Log to audit trail
      await this._logConfigChange('GLOBAL', null, normalized, userId);

      // Clear cache
      this._clearCache();

      const result = await this._getGlobalDefaults();

      log.info('Global defaults updated', {
        updates: Object.keys(normalized),
        userId,
      });

      return result;
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      log.error('Failed to update global defaults', error, { updates, userId });
      throw error;
    }
  }

  /**
   * Update or create index profile
   * @param {string} indexName - Index name (e.g., 'NIFTY')
   * @param {Object} updates - Fields to update
   * @param {number} userId - User making the change
   * @returns {Promise<Object>} - Updated/created index profile
   */
  async updateIndexProfile(indexName, updates, userId) {
    try {
      const normalized = this._normalizeSettings(updates);

      // Check if profile exists
      const existing = await db.get(
        'SELECT * FROM index_profiles WHERE index_name = ?',
        [indexName]
      );

      if (existing) {
        // Update existing
        const fields = [];
        const values = [];

        for (const [key, value] of Object.entries(normalized)) {
          fields.push(`${key} = ?`);
          values.push(value);
        }

        if (fields.length === 0) {
          throw new ValidationError('No valid fields to update');
        }

        fields.push('updated_at = CURRENT_TIMESTAMP');
        values.push(indexName);

        await db.run(
          `UPDATE index_profiles SET ${fields.join(', ')} WHERE index_name = ?`,
          values
        );
      } else {
        // Create new
        if (!updates.exchange_segment) {
          throw new ValidationError('exchange_segment is required for new index profile');
        }

        await db.run(
          `INSERT INTO index_profiles (
            index_name, exchange_segment, strike_step, risk_anchor_mode,
            default_offset, default_product, tp_per_unit, sl_per_unit,
            tsl_enabled, tsl_trail_by, tsl_step, tsl_arm_after,
            tsl_breakeven_after, step_lots, disallow_auto_reverse
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            indexName,
            updates.exchange_segment,
            normalized.strike_step || null,
            normalized.risk_anchor_mode || 'GLOBAL',
            normalized.default_offset || 'ATM',
            normalized.default_product || 'MIS',
            normalized.tp_per_unit || null,
            normalized.sl_per_unit || null,
            normalized.tsl_enabled !== undefined ? (normalized.tsl_enabled ? 1 : 0) : null,
            normalized.tsl_trail_by || null,
            normalized.tsl_step || null,
            normalized.tsl_arm_after || null,
            normalized.tsl_breakeven_after || null,
            normalized.step_lots || null,
            normalized.disallow_auto_reverse !== undefined
              ? (normalized.disallow_auto_reverse ? 1 : 0)
              : null,
          ]
        );
      }

      // Log to audit trail
      await this._logConfigChange('INDEX', indexName, normalized, userId);

      // Clear cache
      this._clearCache();

      const result = await this._getIndexProfile(indexName);

      log.info('Index profile updated', {
        indexName,
        updates: Object.keys(normalized),
        userId,
      });

      return result;
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      log.error('Failed to update index profile', error, { indexName, updates, userId });
      throw error;
    }
  }

  /**
   * Update or create watchlist overrides
   * @param {number} watchlistId - Watchlist ID
   * @param {string} indexName - Index name (optional, can be null for all)
   * @param {Object} updates - Fields to update
   * @param {number} userId - User making the change
   * @returns {Promise<Object>} - Updated/created override
   */
  async updateWatchlistOverrides(watchlistId, indexName, updates, userId) {
    try {
      const normalized = this._normalizeSettings(updates);

      // Check if override exists
      const existing = await db.get(
        `SELECT * FROM watchlist_overrides
         WHERE watchlist_id = ? AND (index_name = ? OR (index_name IS NULL AND ? IS NULL))`,
        [watchlistId, indexName, indexName]
      );

      if (existing) {
        // Update existing
        const fields = [];
        const values = [];

        for (const [key, value] of Object.entries(normalized)) {
          fields.push(`${key} = ?`);
          values.push(value);
        }

        if (fields.length === 0) {
          throw new ValidationError('No valid fields to update');
        }

        fields.push('updated_at = CURRENT_TIMESTAMP');
        values.push(existing.id);

        await db.run(
          `UPDATE watchlist_overrides SET ${fields.join(', ')} WHERE id = ?`,
          values
        );
      } else {
        // Create new
        await db.run(
          `INSERT INTO watchlist_overrides (
            watchlist_id, index_name, strike_policy, step_lots, step_contracts,
            tp_per_unit, sl_per_unit, tsl_enabled, tsl_trail_by, tsl_step,
            tsl_arm_after, tsl_breakeven_after, disallow_auto_reverse
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            watchlistId,
            indexName || null,
            normalized.strike_policy || null,
            normalized.step_lots || null,
            normalized.step_contracts || null,
            normalized.tp_per_unit || null,
            normalized.sl_per_unit || null,
            normalized.tsl_enabled !== undefined ? (normalized.tsl_enabled ? 1 : 0) : null,
            normalized.tsl_trail_by || null,
            normalized.tsl_step || null,
            normalized.tsl_arm_after || null,
            normalized.tsl_breakeven_after || null,
            normalized.disallow_auto_reverse !== undefined
              ? (normalized.disallow_auto_reverse ? 1 : 0)
              : null,
          ]
        );
      }

      // Log to audit trail
      await this._logConfigChange(
        'WATCHLIST',
        `${watchlistId}${indexName ? `:${indexName}` : ''}`,
        normalized,
        userId
      );

      // Clear cache
      this._clearCache();

      const result = await this._getWatchlistOverrides(watchlistId, indexName);

      log.info('Watchlist overrides updated', {
        watchlistId,
        indexName,
        updates: Object.keys(normalized),
        userId,
      });

      return result;
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      log.error('Failed to update watchlist overrides', error, {
        watchlistId,
        indexName,
        updates,
        userId,
      });
      throw error;
    }
  }

  /**
   * Update or create user defaults
   * @param {number} userId - User ID
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object>} - Updated/created user defaults
   */
  async updateUserDefaults(userId, updates) {
    try {
      const normalized = this._normalizeSettings(updates);

      // Check if user defaults exist
      const existing = await db.get(
        'SELECT * FROM user_defaults WHERE user_id = ?',
        [userId]
      );

      if (existing) {
        // Update existing
        const fields = [];
        const values = [];

        for (const [key, value] of Object.entries(normalized)) {
          fields.push(`${key} = ?`);
          values.push(value);
        }

        if (fields.length === 0) {
          throw new ValidationError('No valid fields to update');
        }

        fields.push('updated_at = CURRENT_TIMESTAMP');
        values.push(userId);

        await db.run(
          `UPDATE user_defaults SET ${fields.join(', ')} WHERE user_id = ?`,
          values
        );
      } else {
        // Create new
        await db.run(
          `INSERT INTO user_defaults (
            user_id, strike_policy, step_lots, step_contracts,
            tp_per_unit, sl_per_unit, tsl_enabled, tsl_trail_by, tsl_step,
            tsl_arm_after, tsl_breakeven_after, disallow_auto_reverse
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            userId,
            normalized.strike_policy || null,
            normalized.step_lots || null,
            normalized.step_contracts || null,
            normalized.tp_per_unit || null,
            normalized.sl_per_unit || null,
            normalized.tsl_enabled !== undefined ? (normalized.tsl_enabled ? 1 : 0) : null,
            normalized.tsl_trail_by || null,
            normalized.tsl_step || null,
            normalized.tsl_arm_after || null,
            normalized.tsl_breakeven_after || null,
            normalized.disallow_auto_reverse !== undefined
              ? (normalized.disallow_auto_reverse ? 1 : 0)
              : null,
          ]
        );
      }

      // Log to audit trail
      await this._logConfigChange('USER', userId.toString(), normalized, userId);

      // Clear cache
      this._clearCache();

      const result = await this._getUserDefaults(userId);

      log.info('User defaults updated', {
        userId,
        updates: Object.keys(normalized),
      });

      return result;
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      log.error('Failed to update user defaults', error, { userId, updates });
      throw error;
    }
  }

  /**
   * Update or create symbol overrides
   * @param {string} symbol - Symbol
   * @param {string} exchange - Exchange
   * @param {Object} updates - Fields to update
   * @param {number} userId - User making the change
   * @returns {Promise<Object>} - Updated/created symbol override
   */
  async updateSymbolOverrides(symbol, exchange, updates, userId) {
    try {
      const normalized = this._normalizeSettings(updates);

      // Check if symbol override exists
      const existing = await db.get(
        'SELECT * FROM symbol_overrides WHERE symbol = ? AND exchange = ?',
        [symbol, exchange]
      );

      if (existing) {
        // Update existing
        const fields = [];
        const values = [];

        for (const [key, value] of Object.entries(normalized)) {
          fields.push(`${key} = ?`);
          values.push(value);
        }

        if (fields.length === 0) {
          throw new ValidationError('No valid fields to update');
        }

        fields.push('updated_at = CURRENT_TIMESTAMP');
        values.push(existing.id);

        await db.run(
          `UPDATE symbol_overrides SET ${fields.join(', ')} WHERE id = ?`,
          values
        );
      } else {
        // Create new
        await db.run(
          `INSERT INTO symbol_overrides (
            symbol, exchange, step_contracts, tp_per_unit, sl_per_unit,
            tsl_enabled, tsl_trail_by, tsl_step, tsl_arm_after,
            tsl_breakeven_after, disallow_auto_reverse
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            symbol,
            exchange,
            normalized.step_contracts || null,
            normalized.tp_per_unit || null,
            normalized.sl_per_unit || null,
            normalized.tsl_enabled !== undefined ? (normalized.tsl_enabled ? 1 : 0) : null,
            normalized.tsl_trail_by || null,
            normalized.tsl_step || null,
            normalized.tsl_arm_after || null,
            normalized.tsl_breakeven_after || null,
            normalized.disallow_auto_reverse !== undefined
              ? (normalized.disallow_auto_reverse ? 1 : 0)
              : null,
          ]
        );
      }

      // Log to audit trail
      await this._logConfigChange(
        'SYMBOL',
        `${exchange}:${symbol}`,
        normalized,
        userId
      );

      // Clear cache
      this._clearCache();

      const result = await this._getSymbolOverrides(symbol, exchange);

      log.info('Symbol overrides updated', {
        symbol,
        exchange,
        updates: Object.keys(normalized),
        userId,
      });

      return result;
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      log.error('Failed to update symbol overrides', error, {
        symbol,
        exchange,
        updates,
        userId,
      });
      throw error;
    }
  }

  /**
   * Get config audit log
   * @param {Object} filters - Filter options
   * @returns {Promise<Array>} - Audit log entries
   */
  async getConfigAudit(filters = {}) {
    try {
      let query = `
        SELECT
          ca.*,
          u.email as changed_by_email
        FROM config_audit ca
        LEFT JOIN users u ON ca.changed_by = u.id
        WHERE 1=1
      `;
      const params = [];

      if (filters.scope) {
        query += ' AND ca.scope = ?';
        params.push(filters.scope);
      }

      if (filters.scopeKey) {
        query += ' AND ca.scope_key = ?';
        params.push(filters.scopeKey);
      }

      if (filters.userId) {
        query += ' AND ca.changed_by = ?';
        params.push(filters.userId);
      }

      query += ' ORDER BY ca.changed_at DESC LIMIT 100';

      const audit = await db.all(query, params);

      // Parse JSON fields
      const parsed = audit.map(entry => ({
        ...entry,
        changed_json: JSON.parse(entry.changed_json),
      }));

      return parsed;
    } catch (error) {
      log.error('Failed to get config audit', error, filters);
      throw error;
    }
  }

  // ==========================================
  // Private Helper Methods
  // ==========================================

  async _getGlobalDefaults() {
    const defaults = await db.get('SELECT * FROM global_defaults WHERE id = 1');
    if (!defaults) {
      throw new NotFoundError('Global defaults not initialized');
    }
    return this._convertBooleans(defaults);
  }

  async _getIndexProfile(indexName) {
    const profile = await db.get(
      'SELECT * FROM index_profiles WHERE index_name = ?',
      [indexName]
    );
    return profile ? this._convertBooleans(profile) : null;
  }

  async _getWatchlistOverrides(watchlistId, indexName = null) {
    const override = await db.get(
      `SELECT * FROM watchlist_overrides
       WHERE watchlist_id = ? AND (index_name = ? OR (index_name IS NULL AND ? IS NULL))`,
      [watchlistId, indexName, indexName]
    );
    return override ? this._convertBooleans(override) : null;
  }

  async _getUserDefaults(userId) {
    const defaults = await db.get(
      'SELECT * FROM user_defaults WHERE user_id = ?',
      [userId]
    );
    return defaults ? this._convertBooleans(defaults) : null;
  }

  async _getSymbolOverrides(symbol, exchange) {
    const override = await db.get(
      'SELECT * FROM symbol_overrides WHERE symbol = ? AND exchange = ?',
      [symbol, exchange]
    );
    return override ? this._convertBooleans(override) : null;
  }

  async _logConfigChange(scope, scopeKey, changes, userId) {
    await db.run(
      `INSERT INTO config_audit (scope, scope_key, changed_json, changed_by)
       VALUES (?, ?, ?, ?)`,
      [scope, scopeKey, JSON.stringify(changes), userId]
    );
  }

  _normalizeSettings(data) {
    const normalized = {};

    // Strike policy
    if (data.strike_policy !== undefined) {
      const policy = sanitizeString(data.strike_policy);
      if (policy && ['FLOAT_OFS', 'ANCHOR_OFS'].includes(policy)) {
        normalized.strike_policy = policy;
      }
    }

    // Step sizes
    if (data.step_lots !== undefined) {
      const stepLots = parseIntSafe(data.step_lots, null);
      if (stepLots !== null && stepLots > 0) {
        normalized.step_lots = stepLots;
      }
    }

    if (data.step_contracts !== undefined) {
      const stepContracts = parseIntSafe(data.step_contracts, null);
      if (stepContracts !== null && stepContracts > 0) {
        normalized.step_contracts = stepContracts;
      }
    }

    // Risk per-unit
    if (data.tp_per_unit !== undefined) {
      const tp = parseFloatSafe(data.tp_per_unit, null);
      if (tp !== null && tp > 0) {
        normalized.tp_per_unit = tp;
      } else if (tp === null) {
        normalized.tp_per_unit = null; // Explicitly set to null
      }
    }

    if (data.sl_per_unit !== undefined) {
      const sl = parseFloatSafe(data.sl_per_unit, null);
      if (sl !== null && sl > 0) {
        normalized.sl_per_unit = sl;
      } else if (sl === null) {
        normalized.sl_per_unit = null;
      }
    }

    // TSL
    if (data.tsl_enabled !== undefined) {
      normalized.tsl_enabled = parseBooleanSafe(data.tsl_enabled, false);
    }

    if (data.tsl_trail_by !== undefined) {
      const trail = parseFloatSafe(data.tsl_trail_by, null);
      if (trail !== null && trail > 0) {
        normalized.tsl_trail_by = trail;
      } else if (trail === null) {
        normalized.tsl_trail_by = null;
      }
    }

    if (data.tsl_step !== undefined) {
      const step = parseFloatSafe(data.tsl_step, null);
      if (step !== null && step > 0) {
        normalized.tsl_step = step;
      } else if (step === null) {
        normalized.tsl_step = null;
      }
    }

    if (data.tsl_arm_after !== undefined) {
      const arm = parseFloatSafe(data.tsl_arm_after, null);
      if (arm !== null && arm >= 0) {
        normalized.tsl_arm_after = arm;
      } else if (arm === null) {
        normalized.tsl_arm_after = null;
      }
    }

    if (data.tsl_breakeven_after !== undefined) {
      const breakeven = parseFloatSafe(data.tsl_breakeven_after, null);
      if (breakeven !== null && breakeven >= 0) {
        normalized.tsl_breakeven_after = breakeven;
      } else if (breakeven === null) {
        normalized.tsl_breakeven_after = null;
      }
    }

    // Trading flags
    if (data.disallow_auto_reverse !== undefined) {
      normalized.disallow_auto_reverse = parseBooleanSafe(
        data.disallow_auto_reverse,
        false
      );
    }

    // Index-specific fields
    if (data.strike_step !== undefined) {
      const strikeStep = parseIntSafe(data.strike_step, null);
      if (strikeStep !== null && strikeStep > 0) {
        normalized.strike_step = strikeStep;
      }
    }

    if (data.risk_anchor_mode !== undefined) {
      const mode = sanitizeString(data.risk_anchor_mode);
      if (mode && ['GLOBAL', 'PER_INSTANCE'].includes(mode)) {
        normalized.risk_anchor_mode = mode;
      }
    }

    if (data.default_offset !== undefined) {
      normalized.default_offset = sanitizeString(data.default_offset);
    }

    if (data.default_product !== undefined) {
      const product = sanitizeString(data.default_product);
      if (product && ['MIS', 'NRML', 'CNC'].includes(product)) {
        normalized.default_product = product;
      }
    }

    if (data.exchange_segment !== undefined) {
      normalized.exchange_segment = sanitizeString(data.exchange_segment);
    }

    return normalized;
  }

  _removeNulls(obj) {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value !== null && value !== undefined) {
        // Skip internal fields
        if (!['id', 'created_at', 'updated_at', 'user_id', 'watchlist_id'].includes(key)) {
          result[key] = value;
        }
      }
    }
    return result;
  }

  _convertBooleans(obj) {
    const converted = { ...obj };
    const booleanFields = [
      'tsl_enabled',
      'disallow_auto_reverse',
    ];

    for (const field of booleanFields) {
      if (converted[field] !== undefined && converted[field] !== null) {
        converted[field] = Boolean(converted[field]);
      }
    }

    return converted;
  }

  _getCacheKey(context) {
    const { userId, watchlistId, indexName, symbol, exchange } = context;
    return `${userId || 'null'}_${watchlistId || 'null'}_${indexName || 'null'}_${symbol || 'null'}_${exchange || 'null'}`;
  }

  _getFromCache(key) {
    const cached = this.cache.get(key);
    if (!cached) return null;

    const { data, timestamp } = cached;
    const age = Date.now() - timestamp;

    if (age > this.cacheTTL) {
      this.cache.delete(key);
      return null;
    }

    return data;
  }

  _setCache(key, data) {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
    });
  }

  _clearCache() {
    this.cache.clear();
    log.debug('Settings cache cleared');
  }
}

// Export singleton instance
export default new SettingsService();
export { SettingsService };
