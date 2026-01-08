/**
 * Settings Service
 * Manages application settings stored in database
 * Supports runtime updates without server restart
 * Emits events on settings change for cache invalidation
 */

import EventEmitter from 'events';
import db from '../core/database.js';
import { log } from '../core/logger.js';
import { ValidationError } from '../core/errors.js';

const ESSENTIAL_SETTINGS = [
  {
    key: 'market_hours.quote_blackout_start',
    value: '02:00',
    description: 'Block quote endpoints (Quotes/MultiQuotes/OptionChain) starting this time (IST).',
    category: 'market_hours',
    dataType: 'string',
  },
  {
    key: 'market_hours.quote_blackout_end',
    value: '08:45',
    description: 'Resume quote endpoints after this time (IST).',
    category: 'market_hours',
    dataType: 'string',
  },
  {
    key: 'market_hours.general_blackout_start',
    value: '03:00',
    description: 'Block other OpenAlgo endpoints starting this time (IST).',
    category: 'market_hours',
    dataType: 'string',
  },
  {
    key: 'market_hours.general_blackout_end',
    value: '08:00',
    description: 'Resume other OpenAlgo endpoints after this time (IST).',
    category: 'market_hours',
    dataType: 'string',
  },
  {
    key: 'instance_health.ping_healthy_interval_ms',
    value: '300000',
    description: 'How often healthy instances are pinged (ms).',
    category: 'instance_health',
    dataType: 'number',
  },
  {
    key: 'instance_health.ping_unhealthy_interval_ms',
    value: '180000',
    description: 'How often unhealthy instances are pinged before pausing (ms).',
    category: 'instance_health',
    dataType: 'number',
  },
  {
    key: 'instance_health.ping_unhealthy_max_attempts',
    value: '5',
    description: 'Stop auto-pinging after this many failures; requires manual refresh.',
    category: 'instance_health',
    dataType: 'number',
  },
  {
    key: 'instance_health.analyzer_check_interval_ms',
    value: '15000',
    description: 'How often analyzer status is refreshed (ms).',
    category: 'instance_health',
    dataType: 'number',
  },
  {
    key: 'market_data_feed.quote_ttl_idle_ms',
    value: '15000',
    description: 'Quote cache TTL when no open positions (ms).',
    category: 'market_data_feed',
    dataType: 'number',
  },
  {
    key: 'market_data_feed.quote_ttl_active_ms',
    value: '10000',
    description: 'Quote cache TTL when open positions exist (ms).',
    category: 'market_data_feed',
    dataType: 'number',
  },
  {
    key: 'market_data_feed.position_interval_idle_ms',
    value: '30000',
    description: 'Positionbook refresh cadence when idle (ms).',
    category: 'market_data_feed',
    dataType: 'number',
  },
  {
    key: 'market_data_feed.position_interval_active_ms',
    value: '8000',
    description: 'Positionbook refresh cadence when positions exist (ms).',
    category: 'market_data_feed',
    dataType: 'number',
  },
  {
    key: 'market_data_feed.tradebook_interval_idle_ms',
    value: '30000',
    description: 'Tradebook refresh cadence when idle (ms).',
    category: 'market_data_feed',
    dataType: 'number',
  },
  {
    key: 'market_data_feed.tradebook_interval_active_ms',
    value: '8000',
    description: 'Tradebook refresh cadence when positions exist (ms).',
    category: 'market_data_feed',
    dataType: 'number',
  },
  {
    key: 'market_data_feed.orderbook_interval_ms',
    value: '30000',
    description: 'Orderbook refresh cadence (ms).',
    category: 'market_data_feed',
    dataType: 'number',
  },
  {
    key: 'market_data_feed.multiquote_cooldown_idle_ms',
    value: '15000',
    description: 'Minimum delay between MultiQuotes calls when idle (ms).',
    category: 'market_data_feed',
    dataType: 'number',
  },
  {
    key: 'market_data_feed.multiquote_cooldown_active_ms',
    value: '10000',
    description: 'Minimum delay between MultiQuotes calls when positions exist (ms).',
    category: 'market_data_feed',
    dataType: 'number',
  },
  {
    key: 'market_data_feed.funds_interval_ms',
    value: '180000',
    description: 'Funds refresh cadence (ms).',
    category: 'market_data_feed',
    dataType: 'number',
  },
  {
    key: 'trading_sessions',
    value: JSON.stringify([
      { label: 'Session 1', start: '09:00', end: '11:30' },
      { label: 'Session 2', start: '12:30', end: '15:10' },
      { label: 'Session 3', start: '15:45', end: '19:00' },
      { label: 'Session 4', start: '20:30', end: '22:45' },
    ]),
    description: 'Session windows in IST used for session P&L baselines and auto cutoffs.',
    category: 'trading',
    dataType: 'json',
  },
];

class SettingsService extends EventEmitter {
  constructor() {
    super();
  }

  async ensureEssentialSettings() {
    const keys = ESSENTIAL_SETTINGS.map((setting) => setting.key);
    if (keys.length === 0) return;

    const placeholders = keys.map(() => '?').join(', ');
    const rows = await db.all(
      `SELECT key, description, category, data_type FROM application_settings WHERE key IN (${placeholders})`,
      keys
    );
    const existing = new Map(rows.map((row) => [row.key, row]));
    const missing = ESSENTIAL_SETTINGS.filter((setting) => !existing.has(setting.key));

    for (const setting of ESSENTIAL_SETTINGS) {
      const row = existing.get(setting.key);
      if (!row) continue;
      const needsUpdate =
        row.description !== setting.description ||
        row.category !== setting.category ||
        row.data_type !== setting.dataType;
      if (!needsUpdate) continue;
      await db.run(
        `
          UPDATE application_settings
          SET description = ?, category = ?, data_type = ?
          WHERE key = ?
        `,
        [setting.description, setting.category, setting.dataType, setting.key]
      );
    }

    if (missing.length === 0) return;

    for (const setting of missing) {
      const defaultValue = this.getDefaultValue(setting.key);
      const value = defaultValue !== '' ? defaultValue : setting.value;
      await db.run(
        `
          INSERT INTO application_settings (key, value, description, category, data_type)
          VALUES (?, ?, ?, ?, ?)
        `,
        [setting.key, value, setting.description, setting.category, setting.dataType]
      );
    }
  }
  /**
   * Get all settings grouped by category
   * @returns {Promise<Object>} - Settings grouped by category
   */
  async getAllSettings() {
    try {
      await this.ensureEssentialSettings();
      const rows = await db.all(`
        SELECT key, value, description, category, data_type, is_sensitive
        FROM application_settings
        ORDER BY category, key
      `);

      // Group by category
      const settings = {};
      rows.forEach(row => {
        if (!settings[row.category]) {
          settings[row.category] = {};
        }

        // Convert value based on data type
        let parsedValue = row.value;
        switch (row.data_type) {
          case 'number':
            parsedValue = parseFloat(row.value);
            break;
          case 'boolean':
            parsedValue = row.value === 'true';
            break;
          case 'json':
            try {
              parsedValue = JSON.parse(row.value);
            } catch (e) {
              log.warn('Failed to parse JSON setting', { key: row.key, value: row.value });
            }
            break;
        }

        settings[row.category][row.key] = {
          value: row.is_sensitive ? this.maskValue(row.value) : parsedValue,
          rawValue: row.value,
          description: row.description,
          dataType: row.data_type,
          isSensitive: !!row.is_sensitive,
        };
      });

      return settings;
    } catch (error) {
      log.error('Failed to get all settings', error);
      throw error;
    }
  }

  /**
   * Get settings by category
   * @param {string} category - Category name
   * @returns {Promise<Object>} - Settings in the category
   */
  async getSettingsByCategory(category) {
    try {
      await this.ensureEssentialSettings();
      const rows = await db.all(`
        SELECT key, value, description, category, data_type, is_sensitive
        FROM application_settings
        WHERE category = ?
        ORDER BY key
      `, [category]);

      const settings = {};
      rows.forEach(row => {
        let parsedValue = row.value;
        switch (row.data_type) {
          case 'number':
            parsedValue = parseFloat(row.value);
            break;
          case 'boolean':
            parsedValue = row.value === 'true';
            break;
          case 'json':
            try {
              parsedValue = JSON.parse(row.value);
            } catch (e) {
              log.warn('Failed to parse JSON setting', { key: row.key, value: row.value });
            }
            break;
        }

        settings[row.key] = {
          value: row.is_sensitive ? this.maskValue(row.value) : parsedValue,
          rawValue: row.value,
          description: row.description,
          dataType: row.data_type,
          isSensitive: !!row.is_sensitive,
        };
      });

      return settings;
    } catch (error) {
      log.error('Failed to get settings by category', error, { category });
      throw error;
    }
  }

  /**
   * Get a single setting by key
   * @param {string} key - Setting key
   * @returns {Promise<Object>} - Setting object
   */
  async getSetting(key) {
    try {
      const row = await db.get(`
        SELECT key, value, description, category, data_type, is_sensitive
        FROM application_settings
        WHERE key = ?
      `, [key]);

      if (!row) {
        throw new ValidationError(`Setting '${key}' not found`);
      }

      let parsedValue = row.value;
      switch (row.data_type) {
        case 'number':
          parsedValue = parseFloat(row.value);
          break;
        case 'boolean':
          parsedValue = row.value === 'true';
          break;
        case 'json':
          try {
            parsedValue = JSON.parse(row.value);
          } catch (e) {
            log.warn('Failed to parse JSON setting', { key: row.key, value: row.value });
          }
          break;
      }

      return {
        key: row.key,
        value: row.is_sensitive ? this.maskValue(row.value) : parsedValue,
        rawValue: row.value,
        description: row.description,
        category: row.category,
        dataType: row.data_type,
        isSensitive: !!row.is_sensitive,
      };
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      log.error('Failed to get setting', error, { key });
      throw error;
    }
  }

  /**
   * Update a setting value
   * @param {string} key - Setting key
   * @param {*} value - New value
   * @returns {Promise<Object>} - Updated setting
   */
  async updateSetting(key, value) {
    try {
      // Get current setting to validate
      const current = await this.getSetting(key);

      // Convert value to string based on data type
      let stringValue;
      switch (current.dataType) {
        case 'number':
          if (typeof value !== 'number') {
            throw new ValidationError(`Setting '${key}' expects a number`);
          }
          stringValue = value.toString();
          break;
        case 'boolean':
          if (typeof value !== 'boolean') {
            throw new ValidationError(`Setting '${key}' expects a boolean`);
          }
          stringValue = value.toString();
          break;
        case 'json':
          if (typeof value === 'string') {
            // Try to parse JSON string
            try {
              JSON.parse(value);
              stringValue = value;
            } catch (e) {
              throw new ValidationError(`Setting '${key}' expects valid JSON`);
            }
          } else {
            stringValue = JSON.stringify(value);
          }
          break;
        default:
          stringValue = String(value);
      }

      // Update in database
      await db.run(`
        UPDATE application_settings
        SET value = ?, updated_at = CURRENT_TIMESTAMP
        WHERE key = ?
      `, [stringValue, key]);

      log.info('Setting updated', { key, value: current.isSensitive ? '[MASKED]' : stringValue });

      // Emit settings changed event for cache invalidation
      // Mask sensitive values to prevent accidental exposure in event handlers/logs
      this.emit('settings:changed', {
        key,
        category: current.category,
        oldValue: current.isSensitive ? this.maskValue(String(current.rawValue)) : current.value,
        newValue: current.isSensitive ? this.maskValue(String(value)) : value,
        isSensitive: current.isSensitive,
      });

      // Return updated setting
      return await this.getSetting(key);
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      log.error('Failed to update setting', error, { key, value });
      throw error;
    }
  }

  /**
   * Update multiple settings
   * @param {Object} settings - Object with key-value pairs
   * @returns {Promise<Object>} - Updated settings
   */
  async updateSettings(settings) {
    try {
      const results = {};
      const errors = [];

      // Use transaction for batch update
      await db.run('BEGIN TRANSACTION');

      try {
        for (const [key, value] of Object.entries(settings)) {
          try {
            const updated = await this.updateSetting(key, value);
            results[key] = updated;
          } catch (error) {
            errors.push({ key, error: error.message });
          }
        }

        await db.run('COMMIT');
      } catch (error) {
        await db.run('ROLLBACK');
        throw error;
      }

      if (errors.length > 0) {
        log.warn('Some settings failed to update', { errorCount: errors.length });
      }

      log.info('Batch settings update completed', {
        total: Object.keys(settings).length,
        successful: Object.keys(results).length,
        failed: errors.length
      });

      return { updated: results, errors };
    } catch (error) {
      log.error('Failed to update settings', error);
      throw error;
    }
  }

  /**
   * Get all categories
   * @returns {Promise<Array>} - List of categories with counts
   */
  async getCategories() {
    try {
      await this.ensureEssentialSettings();
      const rows = await db.all(`
        SELECT category, COUNT(*) as count
        FROM application_settings
        GROUP BY category
        ORDER BY category
      `);

      return rows;
    } catch (error) {
      log.error('Failed to get categories', error);
      throw error;
    }
  }

  /**
   * Reset setting to default value
   * @param {string} key - Setting key
   * @returns {Promise<Object>} - Reset setting
   */
  async resetSetting(key) {
    try {
      // Get default value from .env.example or current implementation
      const defaultValue = this.getDefaultValue(key);

      await db.run(`
        UPDATE application_settings
        SET value = ?, updated_at = CURRENT_TIMESTAMP
        WHERE key = ?
      `, [defaultValue, key]);

      log.info('Setting reset to default', { key, value: defaultValue });

      return await this.getSetting(key);
    } catch (error) {
      log.error('Failed to reset setting', error, { key });
      throw error;
    }
  }

  /**
   * Mask sensitive values (show only first 4 and last 4 characters)
   * @param {string} value - Value to mask
   * @returns {string} - Masked value
   */
  maskValue(value) {
    if (!value || typeof value !== 'string' || value.length < 8) {
      return '****';
    }
    return `${value.substring(0, 4)}${'*'.repeat(value.length - 8)}${value.substring(value.length - 4)}`;
  }

  /**
   * Get default value for a setting key
   * This references the original .env defaults
   * @param {string} key - Setting key
   * @returns {string} - Default value
   */
  getDefaultValue(key) {
    const defaults = {
      'server.port': '3000',
      'server.node_env': 'development',
      'polling.instance_interval_ms': '15000',
      'polling.market_data_interval_ms': '5000',
      'polling.health_check_interval_ms': '60000',
      'instance_health.ping_healthy_interval_ms': '300000',
      'instance_health.ping_unhealthy_interval_ms': '180000',
      'instance_health.ping_unhealthy_max_attempts': '5',
      'instance_health.analyzer_check_interval_ms': '15000',
      'openalgo.request_timeout_ms': '15000',
      'openalgo.critical.max_retries': '5',
      'openalgo.critical.retry_delay_ms': '1000',
      'openalgo.non_critical.max_retries': '3',
      'openalgo.non_critical.retry_delay_ms': '1000',
      'market_hours.quote_blackout_start': '02:00',
      'market_hours.quote_blackout_end': '08:45',
      'market_hours.general_blackout_start': '03:00',
      'market_hours.general_blackout_end': '08:00',
      'market_data_feed.quote_ttl_idle_ms': '15000',
      'market_data_feed.quote_ttl_active_ms': '10000',
      'market_data_feed.position_interval_idle_ms': '30000',
      'market_data_feed.position_interval_active_ms': '8000',
      'market_data_feed.tradebook_interval_idle_ms': '30000',
      'market_data_feed.tradebook_interval_active_ms': '8000',
      'market_data_feed.orderbook_interval_ms': '30000',
      'market_data_feed.multiquote_cooldown_idle_ms': '15000',
      'market_data_feed.multiquote_cooldown_active_ms': '10000',
      'market_data_feed.funds_interval_ms': '180000',
      'trading_sessions': JSON.stringify([
        { label: 'Session 1', start: '09:00', end: '11:30' },
        { label: 'Session 2', start: '12:30', end: '15:10' },
        { label: 'Session 3', start: '15:45', end: '19:00' },
        { label: 'Session 4', start: '20:30', end: '22:45' },
      ]),
      'database.path': './database/simplifyed.db',
      'session.secret': 'CHANGE_THIS_IN_PRODUCTION',
      'session.max_age_ms': '604800000',
      'cors.origin': 'http://localhost:3000',
      'cors.credentials': 'true',
      'logging.level': 'info',
      'logging.file': './logs/app.log',
      'rate_limit.window_ms': '60000',
      'rate_limit.max_requests': '100',
      'oauth.google.client_id': '',
      'oauth.google.client_secret': '',
      'oauth.google.callback_url': 'http://localhost:3000/auth/google/callback',
      'test_mode.enabled': 'false',
      'test_mode.user_email': 'test@simplifyed.in',
      'proxy.url': '',
      'proxy.tls_reject_unauthorized': 'true',
      // Options trading defaults (Buyer/Writer mode)
      'options.default_operating_mode': 'BUYER',
      'options.default_strike_policy': 'FLOAT_OFS',
      'options.default_step_lots': '1',
      'options.writer_guard_enabled': 'true',
      'options.allow_multi_strike': 'true',
    };

    return defaults[key] || '';
  }
}

export default new SettingsService();
