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
import {
  isEditable, validateValue, SETTINGS_GROUPS, SETTINGS_FIELDS, ESSENTIAL_SETTINGS, settingDefault,
} from '../config/settings-registry.js';


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
      await db.run(
        `
          INSERT INTO application_settings (key, value, description, category, data_type)
          VALUES (?, ?, ?, ?, ?)
        `,
        [setting.key, setting.value, setting.description, setting.category, setting.dataType]
      );
    }
  }
  /** A row's stored value, unmasked and unparsed. Server-side only - never send it to a client. */
  async getRawValue(key) {
    const row = await db.get('SELECT value FROM application_settings WHERE key = ?', [key]);
    return row?.value || null;
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
        // rawValue is masked in step with value: masking one while shipping the other defeats the mask.
        value: row.is_sensitive ? this.maskValue(row.value) : parsedValue,
        rawValue: row.is_sensitive ? this.maskValue(row.value) : row.value,
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
      // The registry is the allowlist, and it is enforced HERE rather than in the UI. Before
      // this check the only filtering was a hardcoded list in settings-core.js, so any caller
      // holding `settings.manage` could PUT keys the UI never showed - including
      // `test_mode.enabled`, which switches optionalAuth into a hardcoded-admin bypass for the
      // entire process, and `rate_limits.disabled`, which removes the guard that keeps a live
      // broker from being flooded.
      if (!isEditable(key)) {
        throw new ValidationError(
          `Setting '${key}' is not editable at runtime. It is either applied only at startup, `
          + 'a secret that must come from the environment, or a debug flag.'
        );
      }

      const rangeError = validateValue(key, value);
      if (rangeError) {
        throw new ValidationError(rangeError);
      }

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

      // Goes through db.transaction() rather than raw BEGIN/COMMIT so it joins the serialization
      // queue in core/database.js. Issuing BEGIN directly on the shared connection let this
      // batch interleave with another transaction already in flight (see the note there).
      await db.transaction(async () => {
        for (const [key, value] of Object.entries(settings)) {
          try {
            const updated = await this.updateSetting(key, value);
            results[key] = updated;
          } catch (error) {
            // Collected, not thrown: one rejected key shouldn't roll back the valid ones in
            // the same save. The caller gets both lists back.
            errors.push({ key, error: error.message });
          }
        }
      });

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

  /** Default for a setting key, from ESSENTIAL_SETTINGS ('' when it is not a setting). */
  getDefaultValue(key) {
    return settingDefault(key) ?? '';
  }

  /**
   * The registry, hydrated with each field's current value, ready for the UI to render.
   *
   * Returning presentation *and* data together is deliberate: the Settings screen used to keep
   * its own hardcoded copy of which keys to show, which drifted from reality (it listed
   * `polling.health_check_interval_ms`, which does not exist, while hiding
   * `polling.market_data_interval_ms`, which does). One list, served from the same place that
   * enforces writes, cannot drift.
   *
   * Fields whose row is missing from application_settings are dropped with a warning rather
   * than rendered as empty inputs that fail on save.
   */
  async getSchema() {
    // Registry keys only: an unfiltered read would also load the webhook token.
    const keys = [...SETTINGS_FIELDS.keys()];
    const rows = await db.all(
      `SELECT key, value, data_type FROM application_settings WHERE key IN (${keys.map(() => '?').join(', ')})`,
      keys
    );
    const byKey = new Map(rows.map((r) => [r.key, r]));

    const hydrate = (field) => {
      const row = byKey.get(field.key);
      if (!row) return null;
      let value = row.value;
      if (row.data_type === 'number') value = Number(row.value);
      else if (row.data_type === 'boolean') value = row.value === 'true';
      else if (row.data_type === 'json') {
        try { value = JSON.parse(row.value); } catch { value = null; }
      }
      return { ...field, value, dataType: row.data_type, default: this.getDefaultValue(field.key) };
    };

    const missing = [];
    const groups = SETTINGS_GROUPS.map((group) => ({
      ...group,
      sections: group.sections
        .map((section) => ({
          ...section,
          fields: section.fields
            .map((f) => {
              const h = hydrate(f);
              if (!h) missing.push(f.key);
              return h;
            })
            .filter(Boolean),
        }))
        .filter((s) => s.fields.length > 0),
    })).filter((g) => g.sections.length > 0);

    if (missing.length) {
      log.warn('Settings in registry with no database row', { count: missing.length });
    }

    return { groups, editableCount: SETTINGS_FIELDS.size - missing.length };
  }
}

export default new SettingsService();
