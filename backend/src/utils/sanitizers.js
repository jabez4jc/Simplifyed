/**
 * Input Sanitization Utilities
 * Provides functions to sanitize and validate user input
 */

import { createHash, timingSafeEqual } from 'crypto';

// Cloud provider instance-metadata endpoints (AWS/GCP/Azure/DigitalOcean/Alibaba all use the
// same link-local address). A host_url pointed here would let the server's own metadata
// credentials be read back through the funds/connection-test response. Deliberately NOT
// blocking general private/localhost ranges - self-hosting OpenAlgo on the same host or LAN as
// this app is a legitimate, expected deployment pattern for this product.
const BLOCKED_HOSTS = new Set(['169.254.169.254', 'metadata.google.internal', 'fd00:ec2::254']);

/**
 * Normalize and validate URL
 * @param {string} url - Raw URL input
 * @returns {string|null} - Normalized URL or null if invalid
 */
export function normalizeUrl(url) {
  if (typeof url !== 'string' || !url.trim()) {
    return null;
  }

  const trimmed = url.trim();

  try {
    const parsed = new URL(trimmed);

    // Only allow http and https protocols
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return null;
    }

    if (BLOCKED_HOSTS.has(parsed.hostname.toLowerCase())) {
      return null;
    }

    // Remove credentials, hash, and search params
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    parsed.search = '';

    // Remove trailing slash from pathname
    const normalizedPath = parsed.pathname.replace(/\/+$/, '');
    const base = `${parsed.origin}${normalizedPath}`;

    return base || parsed.origin;
  } catch (error) {
    return null;
  }
}

/**
 * Sanitize API key
 * @param {string} apiKey - Raw API key input
 * @returns {string} - Trimmed API key
 */
export function sanitizeApiKey(apiKey) {
  if (typeof apiKey !== 'string') {
    return '';
  }
  return apiKey.trim();
}

/**
 * Mask API key for logging
 * @param {string} apiKey - API key to mask
 * @param {number} visibleChars - Number of characters to show
 * @returns {string} - Masked API key
 */
export function maskApiKey(apiKey, visibleChars = 4) {
  if (!apiKey || typeof apiKey !== 'string') {
    return '';
  }

  const visible = Math.min(visibleChars, apiKey.length);
  const hidden = Math.max(0, apiKey.length - visible);

  return '*'.repeat(hidden) + apiKey.slice(-visible);
}

/**
 * Mask an instance row's api_key before it goes out over the API - never send the raw key to
 * the browser. Callers that need the real key (order placement, health checks, connection
 * tests) read straight from instanceService/db, not from an HTTP response, so this only needs
 * to be applied at the route layer, right before res.json().
 */
export function maskInstanceForResponse(instance) {
  if (!instance || typeof instance !== 'object') return instance;
  return { ...instance, api_key: maskApiKey(instance.api_key) };
}

export function maskInstancesForResponse(instances) {
  if (!Array.isArray(instances)) return instances;
  return instances.map(maskInstanceForResponse);
}

/**
 * True if a value is one of our own maskApiKey() outputs (leading '*') rather than a real key -
 * used on the update path to detect "the edit form just round-tripped the masked placeholder it
 * was shown" so we don't overwrite the real stored key with asterisks.
 */
export function isMaskedApiKey(value) {
  return typeof value === 'string' && value.startsWith('*');
}

/**
 * Compare two secrets without leaking how far they matched.
 *
 * `a !== b` returns as soon as two bytes differ, which times out proportionally to the shared
 * prefix. Both sides are hashed first so timingSafeEqual always gets equal-length buffers - it
 * throws on a length mismatch, and that throw would itself be a length oracle.
 *
 * Used for the TradingView webhook token (sole auth on a live-order endpoint) and the Telegram
 * webhook secret.
 */
export function timingSafeEqualStr(a, b) {
  const digest = (v) => createHash('sha256').update(String(v ?? '')).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * Sanitize string input
 * @param {string} str - Raw string input
 * @returns {string} - Trimmed string
 */
export function sanitizeString(str) {
  if (typeof str !== 'string') {
    return '';
  }
  return str.trim();
}

/**
 * Sanitize and validate email
 * @param {string} email - Raw email input
 * @returns {string|null} - Lowercase email or null if invalid
 */
export function sanitizeEmail(email) {
  if (typeof email !== 'string' || !email.trim()) {
    return null;
  }

  const trimmed = email.trim().toLowerCase();

  // Basic email validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(trimmed)) {
    return null;
  }

  return trimmed;
}

/**
 * Parse and validate integer
 * @param {any} value - Value to parse
 * @param {number} defaultValue - Default value if parsing fails
 * @returns {number} - Parsed integer or default
 */
export function parseIntSafe(value, defaultValue = null) {
  const parsed = parseInt(value, 10);
  return isFinite(parsed) ? parsed : defaultValue;
}

/**
 * Parse and validate float
 * @param {any} value - Value to parse
 * @param {number} defaultValue - Default value if parsing fails
 * @returns {number} - Parsed float or default
 */
export function parseFloatSafe(value, defaultValue = null) {
  const parsed = parseFloat(value);
  return isFinite(parsed) ? parsed : defaultValue;
}

/**
 * Parse and validate boolean
 * @param {any} value - Value to parse
 * @param {boolean} defaultValue - Default value
 * @returns {boolean} - Boolean value
 */
export function parseBooleanSafe(value, defaultValue = false) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const lower = value.toLowerCase().trim();
    if (lower === 'true' || lower === '1' || lower === 'yes') {
      return true;
    }
    if (lower === 'false' || lower === '0' || lower === 'no') {
      return false;
    }
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  return defaultValue;
}

/**
 * Sanitize strategy tag
 * @param {string} tag - Raw strategy tag
 * @returns {string|null} - Sanitized tag or null
 */
export function sanitizeStrategyTag(tag) {
  if (typeof tag !== 'string' || !tag.trim()) {
    return null;
  }

  const trimmed = tag.trim();

  // Only allow alphanumeric, spaces, hyphens, and underscores
  const sanitized = trimmed.replace(/[^a-zA-Z0-9 _-]/g, '');

  return sanitized || null;
}

/**
 * Sanitize symbol (trading symbol)
 * @param {string} symbol - Raw symbol
 * @returns {string|null} - Uppercase symbol or null
 */
export function sanitizeSymbol(symbol) {
  if (typeof symbol !== 'string' || !symbol.trim()) {
    return null;
  }

  const trimmed = symbol.trim().toUpperCase();

  // Only allow alphanumeric characters
  const sanitized = trimmed.replace(/[^A-Z0-9]/g, '');

  return sanitized || null;
}

/**
 * Sanitize exchange code
 * @param {string} exchange - Raw exchange code
 * @returns {string|null} - Uppercase exchange or null
 */
export function sanitizeExchange(exchange) {
  if (typeof exchange !== 'string' || !exchange.trim()) {
    return null;
  }

  const upper = exchange.trim().toUpperCase();
  const validExchanges = ['NSE', 'BSE', 'NFO', 'BFO', 'CDS', 'MCX', 'NSE_INDEX', 'BSE_INDEX', 'CRYPTO'];

  return validExchanges.includes(upper) ? upper : null;
}
