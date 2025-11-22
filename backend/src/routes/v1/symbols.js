/**
 * Symbol Routes
 * API endpoints for symbol search and market data
 */

import express from 'express';
import instanceService from '../../services/instance.service.js';
import symbolValidationService from '../../services/symbol-validation.service.js';
import instrumentsService from '../../services/instruments.service.js';
import expiryManagementService from '../../services/expiry-management.service.js';
import openalgoClient from '../../integrations/openalgo/client.js';
import optionChainService from '../../services/option-chain.service.js';
import derivativeResolutionService from '../../services/derivative-resolution.service.js';
import db from '../../core/database.js';
import { log } from '../../core/logger.js';
import { ValidationError } from '../../core/errors.js';
import { sanitizeString } from '../../utils/sanitizers.js';
import marketDataFeedService from '../../services/market-data-feed.service.js';
import symbolResolutionService from '../../services/symbol-resolution.service.js';

const router = express.Router();

/**
 * GET /api/v1/symbols/search
 * Search for symbols - uses cached instruments if available, falls back to OpenAlgo API
 */
router.get('/search', async (req, res, next) => {
  try {
    const { query, instanceId, exchange, instrumenttype } = req.query;

    if (!query) {
      throw new ValidationError('query parameter is required');
    }

    // Try cached instruments first (fast path)
    try {
      const cachedResults = await symbolResolutionService.searchSymbols(
        query,
        exchange ? sanitizeString(exchange).toUpperCase() : null
      );

      if (cachedResults && cachedResults.length > 0) {
        // Classify each result
        const enrichedResults = cachedResults.map(instrument => ({
          ...instrument,
          symbol_type: symbolValidationService.classifySymbol(instrument),
          tradingsymbol: instrument.symbol,
          source: 'cache'
        }));

        log.debug('Symbol search using cache', {
          query,
          results: enrichedResults.length
        });

        return res.json({
          status: 'success',
          data: enrichedResults,
          count: enrichedResults.length,
          source: 'cache'
        });
      }
    } catch (cacheError) {
      log.warn('Cache search failed, falling back to API', cacheError, { query });
    }

    // Fallback to OpenAlgo API (slower path)
    log.debug('Symbol search using OpenAlgo API', { query });
    const results = await symbolValidationService.searchSymbols(
      query,
      instanceId ? parseInt(instanceId, 10) : null
    );

    res.json({
      status: 'success',
      data: results,
      count: results.length,
      source: 'api'
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/symbols/validate
 * Validate and get detailed symbol information
 */
router.post('/validate', async (req, res, next) => {
  try {
    const { symbol, exchange, instanceId } = req.body;

    if (!symbol || !exchange) {
      throw new ValidationError('symbol and exchange are required');
    }

    // Validate symbol using resolver + fallback to OpenAlgo
    const resolved = await symbolResolutionService.validateSymbol(symbol, exchange);
    let validated = resolved.instrument
      ? { ...resolved.instrument, from_cache: true }
      : null;

    if (!validated) {
      validated = await symbolValidationService.validateSymbol(
        symbol,
        exchange,
        instanceId ? parseInt(instanceId, 10) : null
      );
    }

    res.json({
      status: 'success',
      data: validated,
      message: validated.from_cache
        ? 'Symbol retrieved from cache'
        : 'Symbol validated via OpenAlgo',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/symbols/quotes
 * Get quotes for multiple symbols
 * Body: { symbols: [{exchange, symbol}], instanceId? }
 */
router.post('/quotes', async (req, res, next) => {
  try {
    const { symbols, instanceId } = req.body || {};

    if (!symbols || !Array.isArray(symbols)) {
      throw new ValidationError('symbols array is required');
    }

    const ttlMs = 2000;
    const { cached, missing } = marketDataFeedService.getCachedQuotesForSymbols(symbols, ttlMs);
    let liveQuotes = [];

    if (missing.length > 0) {
      if (instanceId) {
        const instance = await instanceService.getInstanceById(parseInt(instanceId, 10));
        const quotes = await openalgoClient.getQuotes(instance, missing);
        marketDataFeedService.setQuoteSnapshot(instance.id, quotes);
        liveQuotes = quotes;
      } else {
        liveQuotes = await marketDataFeedService.fetchQuotesForSymbols(missing);
      }
    }

    res.json({
      status: 'success',
      data: [...cached, ...liveQuotes],
      count: cached.length + liveQuotes.length,
      source: missing.length > 0 ? 'mixed' : 'cache',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/symbols/market-data/:exchange/:symbol
 * Get cached market data for a symbol
 */
router.get('/market-data/:exchange/:symbol', async (req, res, next) => {
  try {
    const { exchange, symbol } = req.params;

    const data = await db.get(
      'SELECT * FROM market_data WHERE exchange = ? AND symbol = ?',
      [exchange.toUpperCase(), symbol.toUpperCase()]
    );

    if (!data) {
      res.json({
        status: 'success',
        data: null,
        message: 'No cached data available',
      });
      return;
    }

    res.json({
      status: 'success',
      data,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/symbols/expiry
 * Get expiry dates for options
 */
router.get('/expiry', async (req, res, next) => {
  try {
    const { symbol, exchange, instanceId, instrumenttype, matchField } = req.query;

    if (!symbol) {
      throw new ValidationError('symbol parameter is required');
    }

    const normalizedExchange = (exchange || 'NFO').toUpperCase();
    const instrumentTypes = instrumenttype
      ? instrumenttype
          .split(',')
          .map(type => sanitizeString(type).toUpperCase())
          .filter(Boolean)
      : [];
    const normalizedMatchField = matchField === 'name' ? 'name' : 'symbol';

    let expiries = await instrumentsService.getExpiries(
      symbol.toUpperCase(),
      normalizedExchange,
      { instrumentTypes, matchField: normalizedMatchField }
    );

    if (expiries.length === 0) {
      if (!instanceId) {
        throw new ValidationError('No cached expiries available. Provide instanceId to fetch from broker.');
      }
      const instance = await instanceService.getInstanceById(parseInt(instanceId, 10));
      const fetched = await expiryManagementService.fetchExpiries(
        symbol.toUpperCase(),
        normalizedExchange,
        instance
      );
      expiries = fetched.map(row => row.expiry_date);
    }

    res.json({
      status: 'success',
      data: expiries,
      source: 'instruments',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/symbols/option-chain
 * Get option chain for a symbol
 */
router.get('/option-chain', async (req, res, next) => {
  try {
    const { symbol, expiry, exchange, type, include_quotes, strike_window } = req.query;

    if (!symbol) {
      throw new ValidationError('symbol parameter is required');
    }

    if (!expiry) {
      throw new ValidationError('expiry parameter is required');
    }

    const normalizedSymbol = sanitizeString(symbol).toUpperCase();
    const normalizedExpiry = sanitizeString(expiry);
    const normalizedType = type ? sanitizeString(type).toLowerCase() : null;
    const includeQuotes = include_quotes === 'true' || include_quotes === true;
    const window = strike_window ? parseInt(strike_window, 10) : null;

    if (window && (Number.isNaN(window) || window < 0)) {
      throw new ValidationError('strike_window must be a positive integer');
    }

    const optionChain = await optionChainService.getOptionChain(
      normalizedSymbol,
      normalizedExpiry,
      normalizedType,
      includeQuotes,
      window
    );

    res.json({
      status: 'success',
      data: optionChain,
      source: 'instruments',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/symbols/utils
 * Symbol utility functions - consolidates frontend/backend logic
 * Body: { operation: string, params: object }
 * Operations:
 *   - getDerivativeExchange: { exchange }
 *   - extractUnderlying: { symbol }
 *   - formatExpiry: { expiry } (YYYY-MM-DD -> DD-MMM-YY)
 *   - normalizeExpiry: { expiry } (DD-MMM-YY -> YYYY-MM-DD)
 *   - batch: { operations: [{operation, params}] }
 */
router.post('/utils', async (req, res, next) => {
  try {
    const { operation, params = {}, operations } = req.body || {};

    // Handle batch operations
    if (operation === 'batch' && Array.isArray(operations)) {
      const results = operations.map(op => {
        try {
          return { success: true, result: executeSymbolOperation(op.operation, op.params || {}) };
        } catch (error) {
          return { success: false, error: error.message };
        }
      });
      return res.json({ status: 'success', data: results });
    }

    if (!operation) {
      throw new ValidationError('operation is required');
    }

    const result = executeSymbolOperation(operation, params);
    res.json({ status: 'success', data: result });
  } catch (error) {
    next(error);
  }
});

/**
 * Execute a symbol utility operation
 */
function executeSymbolOperation(operation, params) {
  switch (operation) {
    case 'getDerivativeExchange': {
      const { exchange } = params;
      return { exchange: derivativeResolutionService.getDerivativeExchange(exchange) };
    }

    case 'extractUnderlying': {
      const { symbol, exchange, symbol_type } = params;
      return {
        underlying: derivativeResolutionService.getDerivativeUnderlying({
          symbol,
          exchange,
          symbol_type,
        }),
      };
    }

    case 'formatExpiry': {
      // Convert YYYY-MM-DD to DD-MMM-YY (OpenAlgo format)
      const { expiry } = params;
      return { expiry: derivativeResolutionService.convertExpiryToOpenAlgoFormat(expiry) };
    }

    case 'normalizeExpiry': {
      // Convert DD-MMM-YY to YYYY-MM-DD (ISO format)
      const { expiry } = params;
      return { expiry: normalizeExpiryToISO(expiry) };
    }

    case 'classifySymbol': {
      const { symbol, exchange, instrumenttype } = params;
      return {
        symbol_type: symbolValidationService.classifySymbol({
          symbol,
          exchange,
          instrumenttype,
        }),
      };
    }

    case 'buildOptionSymbol': {
      // Build option symbol in OpenAlgo format: SYMBOL + DDMMMYY + STRIKE + CE/PE
      // Example: NIFTY + 2025-11-28 + 24000 + CE → NIFTY28NOV2524000CE
      const { underlying, expiry, strike, optionType } = params;
      if (!underlying || !expiry || !strike || !optionType) {
        throw new ValidationError('underlying, expiry, strike, and optionType are required');
      }
      return { symbol: buildOptionSymbol(underlying, expiry, strike, optionType) };
    }

    case 'buildFuturesSymbol': {
      // Build futures symbol in OpenAlgo format: SYMBOL + DDMMMYY + FUT
      // Example: NIFTY + 2025-11-28 → NIFTY28NOV25FUT
      const { underlying, expiry } = params;
      if (!underlying || !expiry) {
        throw new ValidationError('underlying and expiry are required');
      }
      return { symbol: buildFuturesSymbol(underlying, expiry) };
    }

    case 'parseOptionSymbol': {
      // Parse option symbol to extract components
      // Example: NIFTY28NOV2524000CE → { underlying, expiry, strike, optionType }
      const { symbol } = params;
      if (!symbol) {
        throw new ValidationError('symbol is required');
      }
      return parseOptionSymbol(symbol);
    }

    case 'parseFuturesSymbol': {
      // Parse futures symbol to extract components
      // Example: NIFTY28NOV25FUT → { underlying, expiry }
      const { symbol } = params;
      if (!symbol) {
        throw new ValidationError('symbol is required');
      }
      return parseFuturesSymbol(symbol);
    }

    default:
      throw new ValidationError(`Unknown operation: ${operation}`);
  }
}

/**
 * Convert DD-MMM-YY to YYYY-MM-DD
 */
function normalizeExpiryToISO(expiry) {
  if (!expiry) return null;

  // Already in YYYY-MM-DD format
  if (/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
    return expiry;
  }

  // Convert DD-MMM-YY to YYYY-MM-DD
  if (/^\d{2}-[A-Z]{3}-\d{2}$/i.test(expiry)) {
    const [day, monthStr, year] = expiry.split('-');
    const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
      'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const month = monthNames.indexOf(monthStr.toUpperCase());

    if (month === -1) {
      return expiry; // Return as-is if invalid
    }

    const fullYear = `20${year}`;
    const paddedMonth = String(month + 1).padStart(2, '0');
    return `${fullYear}-${paddedMonth}-${day}`;
  }

  return expiry;
}

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/**
 * Build option symbol in OpenAlgo format
 * Format: SYMBOL + DDMMMYY + STRIKE + CE/PE
 * @see https://docs.openalgo.in/symbol-format
 * @param {string} underlying - Underlying symbol (e.g., NIFTY)
 * @param {string} expiry - Expiry date (YYYY-MM-DD or DD-MMM-YY)
 * @param {number|string} strike - Strike price
 * @param {string} optionType - CE or PE
 * @returns {string} Option symbol (e.g., NIFTY28NOV2524000CE)
 */
function buildOptionSymbol(underlying, expiry, strike, optionType) {
  // Normalize expiry to get date parts
  let day, month, year;

  if (/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
    // YYYY-MM-DD format
    const date = new Date(expiry);
    day = String(date.getDate()).padStart(2, '0');
    month = MONTH_NAMES[date.getMonth()];
    year = String(date.getFullYear()).slice(-2);
  } else if (/^\d{2}-[A-Z]{3}-\d{2}$/i.test(expiry)) {
    // DD-MMM-YY format
    [day, month, year] = expiry.split('-');
    month = month.toUpperCase();
  } else {
    throw new ValidationError(`Invalid expiry format: ${expiry}`);
  }

  // Normalize option type
  const type = optionType.toUpperCase();
  if (!['CE', 'PE'].includes(type)) {
    throw new ValidationError(`Invalid option type: ${optionType}`);
  }

  // Build symbol: NIFTY28NOV2524000CE
  return `${underlying.toUpperCase()}${day}${month}${year}${strike}${type}`;
}

/**
 * Build futures symbol in OpenAlgo format
 * Format: SYMBOL + DDMMMYY + FUT
 * @see https://docs.openalgo.in/symbol-format
 * @param {string} underlying - Underlying symbol (e.g., NIFTY)
 * @param {string} expiry - Expiry date (YYYY-MM-DD or DD-MMM-YY)
 * @returns {string} Futures symbol (e.g., NIFTY28NOV25FUT)
 */
function buildFuturesSymbol(underlying, expiry) {
  // Normalize expiry to get date parts
  let day, month, year;

  if (/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
    // YYYY-MM-DD format
    const date = new Date(expiry);
    day = String(date.getDate()).padStart(2, '0');
    month = MONTH_NAMES[date.getMonth()];
    year = String(date.getFullYear()).slice(-2);
  } else if (/^\d{2}-[A-Z]{3}-\d{2}$/i.test(expiry)) {
    // DD-MMM-YY format
    [day, month, year] = expiry.split('-');
    month = month.toUpperCase();
  } else {
    throw new ValidationError(`Invalid expiry format: ${expiry}`);
  }

  // Build symbol: NIFTY28NOV25FUT
  return `${underlying.toUpperCase()}${day}${month}${year}FUT`;
}

/**
 * Parse option symbol to extract components
 * Format: SYMBOL + DDMMMYY + STRIKE + CE/PE
 * @param {string} symbol - Option symbol (e.g., NIFTY28NOV2524000CE)
 * @returns {Object} Parsed components { underlying, expiry, strike, optionType }
 */
function parseOptionSymbol(symbol) {
  if (!symbol) {
    return { underlying: null, expiry: null, strike: null, optionType: null };
  }

  // Normalize: uppercase, remove exchange prefix
  let normalized = symbol.toUpperCase();
  if (normalized.includes(':')) {
    normalized = normalized.split(':').pop();
  }

  // Match: UNDERLYING + DDMMMYY + STRIKE + CE/PE
  const match = normalized.match(/^([A-Z]+)(\d{2})([A-Z]{3})(\d{2})(\d+(?:\.\d+)?)(CE|PE)$/);
  if (!match) {
    return { underlying: null, expiry: null, strike: null, optionType: null, error: 'Invalid format' };
  }

  const [, underlying, day, monthStr, year, strikeStr, optionType] = match;

  const monthIndex = MONTH_NAMES.indexOf(monthStr);
  if (monthIndex === -1) {
    return { underlying: null, expiry: null, strike: null, optionType: null, error: 'Invalid month' };
  }

  const expiry = `20${year}-${String(monthIndex + 1).padStart(2, '0')}-${day}`;
  const strike = parseFloat(strikeStr);

  return { underlying, expiry, strike, optionType };
}

/**
 * Parse futures symbol to extract components
 * Format: SYMBOL + DDMMMYY + FUT
 * @param {string} symbol - Futures symbol (e.g., NIFTY28NOV25FUT)
 * @returns {Object} Parsed components { underlying, expiry }
 */
function parseFuturesSymbol(symbol) {
  if (!symbol) {
    return { underlying: null, expiry: null };
  }

  // Normalize: uppercase, remove exchange prefix
  let normalized = symbol.toUpperCase();
  if (normalized.includes(':')) {
    normalized = normalized.split(':').pop();
  }

  // Match: UNDERLYING + DDMMMYY + FUT
  const match = normalized.match(/^([A-Z]+)(\d{2})([A-Z]{3})(\d{2})FUT$/);
  if (!match) {
    return { underlying: null, expiry: null, error: 'Invalid format' };
  }

  const [, underlying, day, monthStr, year] = match;

  const monthIndex = MONTH_NAMES.indexOf(monthStr);
  if (monthIndex === -1) {
    return { underlying: null, expiry: null, error: 'Invalid month' };
  }

  const expiry = `20${year}-${String(monthIndex + 1).padStart(2, '0')}-${day}`;

  return { underlying, expiry };
}

/**
 * POST /api/v1/symbols/quotes/subscribe
 * Subscribe to quotes for multiple symbol sources
 * Consolidates watchlist, positions, and ad-hoc symbols into a single request
 * Body: {
 *   watchlistSymbols: [{exchange, symbol}],
 *   positionSymbols: [{exchange, symbol}],
 *   additionalSymbols: [{exchange, symbol}],
 *   orderCritical: boolean
 * }
 */
router.post('/quotes/subscribe', async (req, res, next) => {
  try {
    const {
      watchlistSymbols = [],
      positionSymbols = [],
      additionalSymbols = [],
      orderCritical = false,
    } = req.body || {};

    // Consolidate all symbol sources into unique list
    const allSymbols = [
      ...watchlistSymbols,
      ...positionSymbols,
      ...additionalSymbols,
    ];

    if (allSymbols.length === 0) {
      return res.json({
        status: 'success',
        data: [],
        count: 0,
        sources: { watchlist: 0, positions: 0, additional: 0 },
      });
    }

    // Fetch quotes with deduplication (handled by fetchQuotesForSymbols)
    const quotes = await marketDataFeedService.fetchQuotesForSymbols(allSymbols, {
      orderCritical,
      useFallback: true,
    });

    // Create lookup map for response
    const quoteMap = new Map();
    quotes.forEach(q => {
      if (q?.symbol && q?.exchange) {
        quoteMap.set(`${q.exchange}|${q.symbol}`, q);
      }
    });

    // Tag quotes by source for debugging
    const taggedQuotes = quotes.map(q => ({
      ...q,
      sources: {
        watchlist: watchlistSymbols.some(s => s.symbol === q.symbol && s.exchange === q.exchange),
        positions: positionSymbols.some(s => s.symbol === q.symbol && s.exchange === q.exchange),
        additional: additionalSymbols.some(s => s.symbol === q.symbol && s.exchange === q.exchange),
      },
    }));

    log.debug('Consolidated quote subscription', {
      watchlistCount: watchlistSymbols.length,
      positionsCount: positionSymbols.length,
      additionalCount: additionalSymbols.length,
      uniqueCount: quotes.length,
      orderCritical,
    });

    res.json({
      status: 'success',
      data: taggedQuotes,
      count: taggedQuotes.length,
      sources: {
        watchlist: watchlistSymbols.length,
        positions: positionSymbols.length,
        additional: additionalSymbols.length,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
