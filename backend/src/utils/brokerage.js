/**
 * Brokerage helpers
 * Normalizes broker keys and resolves brokerage defaults.
 */

import { parseFloatSafe } from './sanitizers.js';

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
