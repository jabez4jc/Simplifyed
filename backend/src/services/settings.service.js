/**
 * Settings Service
 * Manages application settings stored in database
 * Supports runtime updates without server restart
 */

import db from '../core/database.js';
import { log } from '../core/logger.js';
import { ValidationError } from '../core/errors.js';

class SettingsService {
  /**
   * Get all settings grouped by category
   * @returns {Promise<Object>} - Settings grouped by category
   */
  async getAllSettings() {
    try {
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
      'polling.health_check_interval_ms': '300000',
      'openalgo.request_timeout_ms': '15000',
      'openalgo.critical.max_retries': '5',
      'openalgo.critical.retry_delay_ms': '1000',
      'openalgo.non_critical.max_retries': '3',
      'openalgo.non_critical.retry_delay_ms': '1000',
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
