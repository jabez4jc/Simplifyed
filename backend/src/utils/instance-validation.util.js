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
 *
 * `isUpdate` relaxes REQUIREDNESS - a partial update need not carry every field. It does not
 * relax VALIDITY. A field the caller actually sent, with a value that cannot be stored, is an
 * error in both modes.
 *
 * This distinction used to be missing: on update, anything that failed to parse was dropped from
 * the result instead of raising, so the UPDATE ran without it and the API answered 200 "Instance
 * updated successfully". An operator who mistyped a host URL, or blanked a name, was told the
 * edit had been saved when nothing had changed - the failure mode you cannot detect by looking
 * at the screen. See Test/integration/instances.test.js.
 */
export function normalizeInstanceData(data, isUpdate = false) {
  const normalized = {};
  const errors = [];

  // Sent-but-empty means "clear this" for a nullable column, and is an error for a required one.
  const isBlank = (v) => v === null || v === '' || (typeof v === 'string' && !v.trim());

  // Name
  if (data.name !== undefined) {
    const name = sanitizeString(data.name);
    if (!name) {
      errors.push({ field: 'name', message: 'Name is required' });
    } else {
      normalized.name = name;
    }
  }

  // Host URL
  if (data.host_url !== undefined) {
    const hostUrl = normalizeUrl(data.host_url);
    if (!hostUrl) {
      errors.push({ field: 'host_url', message: 'Valid host URL is required' });
    } else {
      normalized.host_url = hostUrl;
    }
  }

  // API Key
  if (data.api_key !== undefined) {
    const apiKey = sanitizeApiKey(data.api_key);
    if (!apiKey) {
      errors.push({ field: 'api_key', message: 'API key is required' });
    } else {
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

  // Session-level risk controls.
  //
  // Both columns are nullable and both are safety limits, so an emptied box has to mean "no
  // limit" and reach the database as NULL. Dropping the field instead left the OLD figure in
  // force while the form showed it as cleared - an instance that keeps cutting off at a target
  // the operator believes they removed.
  for (const field of ['session_target_profit', 'session_max_loss']) {
    if (data[field] === undefined) continue;
    if (isBlank(data[field])) {
      normalized[field] = null;
      continue;
    }
    const val = parseFloat(data[field]);
    if (Number.isNaN(val)) {
      errors.push({ field, message: `${field} must be a number, or empty to clear it` });
    } else {
      normalized[field] = val;
    }
  }

  // Broker (auto-detected, but can be overridden)
  if (data.broker !== undefined) {
    normalized.broker = sanitizeString(data.broker);
  }

  // "Use this instance for market data"
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
