/**
 * Symbol Routes
 * API endpoints for symbol search and market data
 */

import express from 'express';
import instanceService from '../../services/instance.service.js';
import symbolValidationService from '../../services/symbol-validation.service.js';
import instrumentsService from '../../services/instruments.service.js';
import openalgoClient from '../../integrations/openalgo/client.js';
import { ValidationError } from '../../core/errors.js';
import { sanitizeString } from '../../utils/sanitizers.js';
import { upcomingExpiries, parseExpiry } from '../../utils/underlying.util.js';
import { isCryptoExchange } from '../../utils/broker-type.util.js';
import marketDataFeedService from '../../services/market-data-feed.service.js';
import optionGreeksService from '../../services/option-greeks.service.js';
import { requireAuth } from '../../middleware/auth.js';
import { isContractExpired } from '../../utils/underlying.util.js';

const router = express.Router();
router.use(requireAuth);

/**
 * GET /api/v1/symbols/search
 * Search for symbols - instruments table first, falls back to the OpenAlgo API
 */
router.get('/search', async (req, res, next) => {
  try {
    const { query, instanceId, exchange, instrumenttype } = req.query;

    if (!query) {
      throw new ValidationError('query parameter is required');
    }
    const requestedExchange = exchange ? sanitizeString(exchange).toUpperCase() : null;
    const requestedType = instrumenttype ? sanitizeString(instrumenttype).toUpperCase() : null;

    // Instruments table first, OpenAlgo search only when it has nothing (see the service).
    const found = await symbolValidationService.searchSymbols(
      query,
      instanceId ? parseInt(instanceId, 10) : null,
      { exchange: requestedExchange, instrumenttype: requestedType }
    );
    const results = found.filter((instrument) => {
      const resultExchange = String(instrument.exchange || instrument.exch || '').toUpperCase();
      const resultType = String(instrument.instrumenttype || instrument.instrument_type || '').toUpperCase();
      return (!requestedExchange || resultExchange === requestedExchange)
        && (!requestedType || resultType === requestedType);
    });

    res.json({
      status: 'success',
      data: results,
      count: results.length,
      source: results.length && !results[0].from_cache ? 'api' : 'cache'
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

    // Whoever asks for a contract (the chart's option panes and future) gets it on the WS stream
    // from here on, so the client can stop polling it; a no-op until a connection exists.
    for (const s of symbols) marketDataFeedService.ensureSymbolSubscribed(s?.exchange, s?.symbol);

    const ttlMs = 2000;
    const { cached, missing } = marketDataFeedService.getCachedQuotesForSymbols(symbols, { ttlMs });
    let liveQuotes = [];

    if (missing.length > 0) {
      if (instanceId) {
        const instance = await instanceService.getInstanceById(parseInt(instanceId, 10));
        // Ask the named instance only for live symbols its broker trades; anything else goes
        // through the feed, which routes per segment (and skips expired contracts).
        const mine = missing.filter((s) => marketDataFeedService._tradesExchange(instance, s.exchange) && !isContractExpired(s));
        const others = missing.filter((s) => !mine.includes(s));
        const quoteResult = mine.length
          ? await openalgoClient.getQuotes(instance, mine, { returnErrors: true })
          : { quotes: [], failed: [] };
        const quotes = Array.isArray(quoteResult?.quotes) ? quoteResult.quotes : [];
        const failed = [
          ...(Array.isArray(quoteResult?.failed) ? quoteResult.failed : []),
          ...others,
        ];
        if (quotes.length > 0) {
          marketDataFeedService.setQuoteSnapshot(instance.id, quotes);
          liveQuotes = liveQuotes.concat(quotes);
        }
        if (failed.length > 0) {
          const fallbackSymbols = failed.map((f) => ({ exchange: f.exchange, symbol: f.symbol }));
          const fallbackQuotes = await marketDataFeedService.fetchQuotesForSymbols(fallbackSymbols);
          if (fallbackQuotes.length > 0) {
            liveQuotes = liveQuotes.concat(fallbackQuotes);
          }
        }
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
      const fetched = await openalgoClient.getExpiry(instance, symbol.toUpperCase(), normalizedExchange);
      expiries = upcomingExpiries(fetched, new Date(), { crypto: isCryptoExchange(normalizedExchange) })
        .map((e) => parseExpiry(e).toISOString().slice(0, 10));
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
 * GET /api/v1/symbols/greeks?symbol=&exchange=&instanceId=&underlyingSymbol=&underlyingExchange=
 */
router.get('/greeks', async (req, res, next) => {
  try {
    const { symbol, exchange, instanceId, underlyingSymbol, underlyingExchange } = req.query;
    if (!instanceId) {
      throw new ValidationError('instanceId query param is required');
    }
    const data = await optionGreeksService.getGreeks(parseInt(instanceId, 10), {
      symbol, exchange, underlyingSymbol, underlyingExchange,
    });
    res.json({ status: 'success', data });
  } catch (error) {
    next(error);
  }
});


export default router;
