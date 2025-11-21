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

export default router;
