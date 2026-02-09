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

export function resolveMarketOrderSupport(broker, map) {
  const normalizedKey = normalizeBrokerKey(broker);
  if (!normalizedKey) return false;
  return !!(map && map[normalizedKey] === true);
}
