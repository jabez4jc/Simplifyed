/**
 * Instance Validation Utility
 * Pure input normalization/validation for instance create/update payloads.
 * Extracted from instance.service.js - holds no state, so a plain exported function
 * rather than a class/singleton (mirrors symbol-parsing.util.js).
 */

import { ValidationError } from '../core/errors.js';
import {
  normalizeUrl,
  sanitizeApiKey,
  sanitizeString,
  sanitizeStrategyTag,
  parseBooleanSafe,
  parseIntSafe,
} from './sanitizers.js';

/**
 * Normalize and validate instance data
 * @param {Object} data - Raw instance payload
 * @param {boolean} isUpdate - Whether this is a partial update (relaxes required-field checks)
 */
export function normalizeInstanceData(data, isUpdate = false) {
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
