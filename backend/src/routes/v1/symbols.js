/**
 * Symbol Routes
 * API endpoints for symbol search and market data
 */

import express from 'express';
import instanceService from '../../services/instance.service.js';
import symbolValidationService from '../../services/symbol-validation.service.js';
import instrumentsService from '../../services/instruments.service.js';
import openalgoClient from '../../integrations/openalgo/client.js';
import db from '../../core/database.js';
import { log } from '../../core/logger.js';
import { ValidationError } from '../../core/errors.js';
import { sanitizeString } from '../../utils/sanitizers.js';

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
      const cachedResults = await instrumentsService.searchInstruments(
        query,
        {
          exchange: exchange ? sanitizeString(exchange).toUpperCase() : null,
          instrumenttype: instrumenttype ? sanitizeString(instrumenttype).toUpperCase() : null,
          limit: 50
        }
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

    // Validate symbol using OpenAlgo /symbol endpoint
    const validated = await symbolValidationService.validateSymbol(
      symbol,
      exchange,
      instanceId ? parseInt(instanceId, 10) : null
    );

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
 * Body: { symbols: [{exchange, symbol}], instanceId }
 */
router.post('/quotes', async (req, res, next) => {
  try {
    const { symbols, instanceId } = req.body;

    if (!symbols || !Array.isArray(symbols)) {
      throw new ValidationError('symbols array is required');
    }

    if (!instanceId) {
      throw new ValidationError('instanceId parameter is required');
    }

    const instance = await instanceService.getInstanceById(
      parseInt(instanceId, 10)
    );

    // Get quotes from OpenAlgo
    const quotes = await openalgoClient.getQuotes(instance, symbols);

    res.json({
      status: 'success',
      data: quotes,
      count: quotes.length,
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
    const { symbol, exchange, instanceId } = req.query;

    if (!symbol) {
      throw new ValidationError('symbol parameter is required');
    }

    if (!instanceId) {
      throw new ValidationError('instanceId parameter is required');
    }

    const instance = await instanceService.getInstanceById(
      parseInt(instanceId, 10)
    );

    // Get expiry dates from OpenAlgo
    const expiries = await openalgoClient.getExpiry(
      instance,
      symbol,
      exchange || 'NFO'
    );

    res.json({
      status: 'success',
      data: expiries,
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
    const { symbol, expiry, exchange, instanceId } = req.query;

    if (!symbol) {
      throw new ValidationError('symbol parameter is required');
    }

    if (!expiry) {
      throw new ValidationError('expiry parameter is required');
    }

    if (!instanceId) {
      throw new ValidationError('instanceId parameter is required');
    }

    const instance = await instanceService.getInstanceById(
      parseInt(instanceId, 10)
    );

    // Get option chain from OpenAlgo
    const optionChain = await openalgoClient.getOptionChain(
      instance,
      symbol,
      expiry,
      exchange || 'NFO'
    );

    res.json({
      status: 'success',
      data: optionChain,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
