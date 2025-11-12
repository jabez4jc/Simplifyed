/**
 * Input Sanitization Utilities
 * Provides functions to sanitize and validate user input
 */

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
  const validExchanges = ['NSE', 'BSE', 'NFO', 'BFO', 'CDS', 'MCX', 'NSE_INDEX', 'BSE_INDEX'];

  return validExchanges.includes(upper) ? upper : null;
}
