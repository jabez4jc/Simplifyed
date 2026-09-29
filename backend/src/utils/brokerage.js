/**
 * Brokerage helpers
 * Normalizes broker keys and resolves brokerage defaults.
 */

import { parseFloatSafe } from './sanitizers.js';
import { isCryptoBroker } from './broker-type.util.js';

export function normalizeBrokerKey(broker) {
  return String(broker || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

export function buildBrokerageMap(value) {
  const map = {};
  if (!value || typeof value !== 'object') {
    return map;
  }

  Object.entries(value).forEach(([key, rate]) => {
    const normalizedKey = normalizeBrokerKey(key);
    const parsed = parseFloatSafe(rate, null);
    if (normalizedKey && parsed !== null) {
      map[normalizedKey] = parsed;
    }
  });

  return map;
}

export function resolveBrokerageValue(broker, map, defaultValue) {
  const normalizedKey = normalizeBrokerKey(broker);
  if (normalizedKey && map && map[normalizedKey] != null) {
    return map[normalizedKey];
  }
  return defaultValue;
}

export function buildMarketOrderSupportMap(value) {
  let source = value;
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source);
    } catch (error) {
      source = {};
    }
  }

  const map = {};
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return map;
  }

  Object.entries(source).forEach(([key, supported]) => {
    const normalizedKey = normalizeBrokerKey(key);
    if (!normalizedKey) return;
    const normalizedValue = supported === true || supported === 'true' || supported === 1;
    map[normalizedKey] = normalizedValue;
  });

  return map;
}

/**
 * An explicit `brokerage.market_order_support` entry wins. Unlisted crypto brokers default to
 * MARKET (Delta Exchange accepts it; a LIMIT is used only when the caller names a price); unlisted
 * Indian brokers default to no MARKET - and SEBI's limit-only rule applies on top regardless.
 */
export function resolveMarketOrderSupport(broker, map) {
  const normalizedKey = normalizeBrokerKey(broker);
  if (!normalizedKey) return false;
  if (map && typeof map[normalizedKey] === 'boolean') return map[normalizedKey];
  return isCryptoBroker(normalizedKey);
}
