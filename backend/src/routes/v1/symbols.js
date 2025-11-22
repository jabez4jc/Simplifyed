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
