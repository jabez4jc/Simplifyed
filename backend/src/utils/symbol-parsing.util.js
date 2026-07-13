/**
 * Symbol Parsing Utilities
 * Pure functions for deriving/normalizing underlying names, exchanges, expiries, and option/
 * futures symbol components. Extracted from quick-order.service.js - none of these hold any
 * `this` state, so they're plain exported functions rather than a class/singleton.
 *
 * IMPORTANT (MCX): _getUnderlyingQuoteSymbol's MCX branch is load-bearing for the app's MCX
 * options workaround - for MCX, the watchlist symbol row IS the tradable/quotable contract
 * itself (there is no separate underlying/index quote), so it deliberately returns the raw
 * contract symbol rather than an abstract underlying name. Do not "fix" this to match the
 * non-MCX fallback branch.
 */

import derivativeResolutionService, {
  NSE_INDEX_UNDERLYINGS,
  BSE_INDEX_UNDERLYINGS,
} from '../services/derivative-resolution.service.js';
import { log } from '../core/logger.js';
import { ValidationError } from '../core/errors.js';

/**
 * Map cash market exchange to derivative exchange
 */
export function getUnderlyingQuoteExchange(symbol = {}) {
  const exchange = (symbol.exchange || '').toUpperCase();
  const instrumentType = (symbol.instrumenttype || symbol.symbol_type || '').toUpperCase();
  const brexchange = (symbol.brexchange || '').toUpperCase();
  const underlying = derivativeResolutionService.getDerivativeUnderlying(symbol);

  if (BSE_INDEX_UNDERLYINGS.has(underlying)) {
    return 'BSE_INDEX';
  }
  if (NSE_INDEX_UNDERLYINGS.has(underlying)) {
    return 'NSE_INDEX';
  }

  if (exchange === 'BSE_INDEX' || brexchange === 'BSE_INDEX') {
    return 'BSE_INDEX';
  }
  if (exchange === 'NSE_INDEX' || brexchange === 'NSE_INDEX') {
    return 'NSE_INDEX';
  }

  if (instrumentType === 'INDEX') {
    return brexchange && brexchange.startsWith('BSE') ? 'BSE_INDEX' : 'NSE_INDEX';
  }

  if (symbol.exchange?.toUpperCase().includes('MCX') || brexchange === 'MCX' || instrumentType === 'COMMODITY') {
    return 'MCX';
  }

  if (exchange === 'BFO') return 'BSE';
  if (exchange === 'NFO') return 'NSE';

  return exchange || brexchange || 'NSE';
}

export function getUnderlyingQuoteSymbol(symbol = {}) {
  const exchange = (symbol.exchange || '').toUpperCase();
  if (exchange === 'MCX') {
    return (symbol.symbol || symbol.trading_symbol || '').toUpperCase();
  }

  return (symbol.underlying_symbol || symbol.symbol || symbol.name || '').toUpperCase();
}

export function getUnderlyingForClosing(symbol = {}) {
  return derivativeResolutionService.getUnderlyingForClosing(symbol);
}

/**
 * Parse futures symbol to extract underlying and expiry
 * Format: SYMBOL + DDMMMYY + FUT (e.g., NATGASMINI24NOV25FUT)
 */
export function parseFuturesSymbol(symbolStr) {
  if (!symbolStr) {
    return { underlying: null, expiry: null };
  }

  const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

  // Normalize: uppercase, remove exchange prefix
  let normalized = symbolStr.toUpperCase();
  if (normalized.includes(':')) {
    normalized = normalized.split(':').pop();
  }

  // Match: UNDERLYING + DDMMMYY + FUT
  const match = normalized.match(/^([A-Z][A-Z0-9\-]*)(\d{2})([A-Z]{3})(\d{2})FUT$/);
  if (!match) {
    return { underlying: null, expiry: null };
  }

  const [, underlying, day, monthStr, year] = match;

  const monthIndex = MONTH_NAMES.indexOf(monthStr);
  if (monthIndex === -1) {
    return { underlying: null, expiry: null };
  }

  // 2-digit year assumed to be 2000-2099
  const expiry = `20${year}-${String(monthIndex + 1).padStart(2, '0')}-${day}`;

  return { underlying, expiry };
}

export function getFuturesUnderlying(symbol = {}) {
  const parsed = parseFuturesSymbol(symbol.symbol || symbol.trading_symbol || symbol.name);
  return parsed.underlying || derivativeResolutionService.getDerivativeUnderlying(symbol);
}

export function getSymbolExpiryVariants(symbol = {}) {
  const variants = new Set();
  const direct = symbol.expiry;
  if (direct) {
    derivativeResolutionService.expandExpiryFormats(direct)
      .forEach((value) => variants.add(value));
  }
  const parsed = parseFuturesSymbol(symbol.symbol || symbol.trading_symbol || symbol.name);
  if (parsed.expiry) {
    derivativeResolutionService.expandExpiryFormats(parsed.expiry)
      .forEach((value) => variants.add(value));
  }
  return variants;
}

export function expiryMatchesSymbol(expiry, symbol = {}) {
  const selected = derivativeResolutionService.expandExpiryFormats(expiry);
  if (!selected.length) {
    return false;
  }
  const symbolVariants = getSymbolExpiryVariants(symbol);
  return selected.some((value) => symbolVariants.has(value));
}

/**
 * Construct option symbol from components (OpenAlgo format)
 * Format: UNDERLYING + DDMMMYY + STRIKE + CE/PE
 * Example: NIFTY + 18NOV25 + 26000 + CE -> NIFTY18NOV2526000CE
 * @see https://docs.openalgo.in/symbol-format
 */
export function constructOptionSymbol(underlying, expiry, optionType, strike) {
  // Parse expiry YYYY-MM-DD
  const date = new Date(expiry);
  const day = String(date.getDate()).padStart(2, '0');
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const month = months[date.getMonth()];
  const year = String(date.getFullYear()).slice(-2);  // Use 2-digit year (OpenAlgo format)

  // Construct symbol: NIFTY18NOV2526000CE (OpenAlgo format: SYMBOL + DATE + STRIKE + TYPE)
  return `${underlying}${day}${month}${year}${strike}${optionType}`;
}

/**
 * Parse option symbol string to extract components
 * Example: "NIFTY05DEC25C22450" -> { underlying: "NIFTY", expiry: "2025-12-05", type: "CE", strike: 22450 }
 */
export function parseOptionSymbol(symbol) {
  if (!symbol) {
    return {
      underlying: null,
      expiry: null,
      type: null,
      strike: null,
    };
  }

  // Normalize symbol: uppercase, drop exchange prefixes (e.g., NFO:, MCX:)
  let normalized = symbol.toUpperCase();
  if (normalized.includes(':')) {
    normalized = normalized.split(':').pop();
  }

  // Expected format: UNDERLYING + DDMMMYY + STRIKE + CE/PE
  const match = normalized.match(/^([A-Z]+)(\d{2}[A-Z]{3}\d{2})(\d+)([CP]E?)$/);
  if (!match) {
    log.warn('Failed to parse option symbol', { symbol });
    return {
      underlying: null,
      expiry: null,
      type: null,
      strike: null,
    };
  }

  const [, underlying, dateStr, strikeStr, rawType] = match;

  const monthMap = {
    JAN: '01', FEB: '02', MAR: '03', APR: '04',
    MAY: '05', JUN: '06', JUL: '07', AUG: '08',
    SEP: '09', OCT: '10', NOV: '11', DEC: '12',
  };

  const day = dateStr.substring(0, 2);
  const monthAbbr = dateStr.substring(2, 5);
  const year = '20' + dateStr.substring(5, 7);
  const month = monthMap[monthAbbr] || '01';
  const expiry = `${year}-${month}-${day}`;

  const type = rawType.startsWith('C') ? 'CE' : 'PE';

  return {
    underlying,
    expiry,
    type,
    strike: parseInt(strikeStr, 10),
  };
}

export function normalizeSymbolKey(symbol) {
  if (!symbol) return null;
  return String(symbol)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

export function normalizeExchange(exchange) {
  if (!exchange) return null;
  return String(exchange).trim().toUpperCase();
}

export function normalizeProduct(product) {
  if (!product) return null;
  return String(product).trim().toUpperCase();
}

/**
 * Normalize expiry input to YYYY-MM-DD
 */
export function normalizeExpiryInput(expiry) {
  if (!expiry) return null;
  const trimmed = String(expiry).trim().toUpperCase();

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  if (/^\d{2}-[A-Z]{3}-\d{2}$/.test(trimmed)) {
    const [day, monthStr, year] = trimmed.split('-');
    const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
                        'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const monthIndex = monthNames.indexOf(monthStr);
    if (monthIndex === -1) {
      throw new ValidationError(`Unknown expiry month: ${monthStr}`);
    }
    const paddedMonth = String(monthIndex + 1).padStart(2, '0');
    return `20${year}-${paddedMonth}-${day}`;
  }

  return trimmed;
}

/**
 * Determine option type (CE/PE) based on action keyword
 */
export function getOptionTypeFromAction(action = '') {
  const ceActions = new Set([
    'BUY_CE', 'SELL_CE',
    'REDUCE_CE', 'INCREASE_CE',
    'CLOSE_ALL_CE',
  ]);

  const peActions = new Set([
    'BUY_PE', 'SELL_PE',
    'REDUCE_PE', 'INCREASE_PE',
    'CLOSE_ALL_PE',
  ]);

  if (ceActions.has(action)) return 'CE';
  if (peActions.has(action)) return 'PE';

  // EXIT_ALL should not rely on option type, default to CE for compatibility
  return 'CE';
}
