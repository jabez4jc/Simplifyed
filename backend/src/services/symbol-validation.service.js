/**
 * Symbol Validation Service
 * Validates and classifies OpenAlgo symbols (instruments table first, broker as the fallback)
 */

import openalgoClient from '../integrations/openalgo/client.js';
import instanceService from './instance.service.js';
import marketDataInstanceService from './market-data-instance.service.js';
import instrumentsService from './instruments.service.js';
import { log } from '../core/logger.js';
import { ValidationError } from '../core/errors.js';

/**
 * Symbol classification types
 */
const SymbolType = {
  INDEX: 'INDEX',
  EQUITY: 'EQUITY',
  FUTURES: 'FUTURES',
  OPTIONS: 'OPTIONS',
  UNKNOWN: 'UNKNOWN',
};

class SymbolValidationService {
  /**
   * Search symbols: the instruments table first, the OpenAlgo /search endpoint when it has nothing
   *
   * @param {string} query - Search query
   * @param {number} [instanceId] - Optional instance ID to use
   * @returns {Promise<Array>} - Enriched symbol results with classification
   */
  async searchSymbols(query, instanceId = null, filters = {}) {
    if (!query || query.trim().length < 2) {
      throw new ValidationError('Search query must be at least 2 characters');
    }

    // Try internal instruments cache first
    try {
      const instrumentResults = await instrumentsService.searchInstruments(query, { limit: 50, ...filters });
      if (instrumentResults.length > 0) {
        log.debug('Symbol search resolved via instruments cache', {
          query,
          results: instrumentResults.length,
        });
        return instrumentResults.map((instrument) => this._transformInstrument(instrument, true));
      }
    } catch (error) {
      log.warn('Instrument cache search failed, falling back to OpenAlgo search', {
        query,
        error: error.message,
      });
    }

    // Fallback to OpenAlgo search
    const instance = await this._getMarketDataInstance(instanceId);

    log.debug('Searching symbols via OpenAlgo', { query, instance_id: instance.id });

    const results = await openalgoClient.searchSymbols(instance, query);

    const enrichedResults = results.map((symbol) => {
      const classification = this.classifySymbol(symbol);
      return {
        ...symbol,
        symbol_type: classification,
        tradingsymbol: symbol.symbol || symbol.tradingsymbol,
        exchange: symbol.exchange,
        token: symbol.token,
        instrumenttype: symbol.instrumenttype,
        lotsize: symbol.lotsize || symbol.lot_size || 1,
        expiry: symbol.expiry || null,
        strike: symbol.strike || null,
      };
    });

    log.info('Symbol search complete via OpenAlgo', {
      query,
      results: enrichedResults.length,
    });

    return enrichedResults;
  }

  /**
   * Validate and get symbol details using OpenAlgo /symbol endpoint
   *
   * @param {string} symbol - Trading symbol
   * @param {string} exchange - Exchange code
   * @param {number} [instanceId] - Optional instance ID to use
   * @returns {Promise<Object>} - Validated symbol with classification
   */
  async validateSymbol(symbol, exchange, instanceId = null) {
    if (!symbol || !exchange) {
      throw new ValidationError('Symbol and exchange are required');
    }

    // Try instruments cache first
    const instrument = await instrumentsService.getInstrument(symbol, exchange);
    if (instrument) {
      log.debug('Symbol validated via instruments cache', { symbol, exchange });
      return this._transformInstrument(instrument, true);
    }

    // Get market data instance
    const instance = await this._getMarketDataInstance(instanceId);

    log.debug('Validating symbol via OpenAlgo', {
      symbol,
      exchange,
      instance_id: instance.id
    });

    // Fetch symbol details from OpenAlgo
    const symbolData = await openalgoClient.getSymbol(
      instance,
      symbol,
      exchange
    );

    if (!symbolData) {
      throw new ValidationError(`Symbol ${symbol} not found on ${exchange}`);
    }

    // Classify symbol
    const classification = this.classifySymbol(symbolData);

    const validated = {
      symbol: symbolData.symbol || symbolData.tradingsymbol || symbol,
      exchange: symbolData.exchange || exchange,
      token: symbolData.token,
      name: symbolData.name || symbolData.company_name || null,
      instrumenttype: symbolData.instrumenttype,
      lotsize: symbolData.lotsize || symbolData.lot_size || 1,
      tick_size: symbolData.tick_size || symbolData.ticksize || null,
      expiry: symbolData.expiry || null,
      strike: symbolData.strike || null,
      option_type: symbolData.option_type || symbolData.optiontype || null,
      brsymbol: symbolData.brsymbol || null,
      brexchange: symbolData.brexchange || null,
      symbol_type: classification,
      from_cache: false,
    };

    log.info('Symbol validated', {
      symbol: validated.symbol,
      exchange: validated.exchange,
      type: classification
    });

    return validated;
  }

  /**
   * Classify symbol based on OpenAlgo instrumenttype and metadata
   *
   * Deterministic classification rule:
   * 0. If exchange is NSE_INDEX or BSE_INDEX → Index (cannot be traded directly, only derivatives)
   * 1. If instrumenttype is EQ → Equity
   * 2. Else if instrumenttype starts with OPT OR (expiry non-empty AND strike > 0 AND symbol ends with CE/PE) → Options
   * 3. Else if instrumenttype starts with FUT OR (expiry non-empty AND strike ≤ 0 or missing) → Futures
   *
   * Note: Index symbols serve as underlyings for F&O contracts. The 'name' field links derivatives to their underlying.
   *
   * @param {Object} symbol - Symbol object with instrumenttype, expiry, strike, etc.
   * @returns {string} - SymbolType constant
   */
  classifySymbol(symbol) {
    const instrumenttype = (symbol.instrumenttype || '').toUpperCase();
    const symbolName = (symbol.symbol || symbol.tradingsymbol || '').toUpperCase();
    const exchange = (symbol.exchange || '').toUpperCase();
    const expiry = symbol.expiry;
    const strike = parseFloat(symbol.strike) || 0;

    // Rule 0: Index (NSE_INDEX or BSE_INDEX exchanges)
    // Index symbols cannot be traded directly but serve as underlyings for F&O
    if (exchange === 'NSE_INDEX' || exchange === 'BSE_INDEX') {
      return SymbolType.INDEX;
    }

    // Rule 1: Equity
    if (instrumenttype === 'EQ' || instrumenttype === 'EQUITY') {
      return SymbolType.EQUITY;
    }

    // Rule 2: Options
    if (
      instrumenttype.startsWith('OPT') ||
      (expiry &&
       strike > 0 &&
       (symbolName.endsWith('CE') || symbolName.endsWith('PE')))
    ) {
      return SymbolType.OPTIONS;
    }

    // Rule 3: Futures
    if (
      instrumenttype.startsWith('FUT') ||
      (expiry && strike <= 0) ||
      symbolName.endsWith('FUT')
    ) {
      return SymbolType.FUTURES;
    }

    // Fallback: check exchange for F&O hints
    if (exchange === 'NFO' || exchange === 'BFO') {
      // F&O exchanges, but couldn't determine specific type
      if (symbolName.endsWith('CE') || symbolName.endsWith('PE')) {
        return SymbolType.OPTIONS;
      }
      if (symbolName.endsWith('FUT') || expiry) {
        return SymbolType.FUTURES;
      }
    }

    log.warn('Unable to classify symbol, marking as UNKNOWN', {
      symbol: symbolName,
      instrumenttype,
      expiry,
      strike
    });

    return SymbolType.UNKNOWN;
  }

  _transformInstrument(instrument, fromCache = false) {
    const classification = this.classifySymbol(instrument);
    const symbol = instrument.symbol || instrument.tradingsymbol || '';
    return {
      symbol,
      exchange: instrument.exchange,
      token: instrument.token,
      name: instrument.name || instrument.description || null,
      instrumenttype: instrument.instrumenttype,
      lotsize: instrument.lotsize || instrument.lot_size || instrument.lotSize || 1,
      tick_size: instrument.tick_size || instrument.tickSize || null,
      expiry: instrument.expiry || null,
      strike: instrument.strike || null,
      option_type: instrument.option_type || instrument.optionType || null,
      brsymbol: instrument.brsymbol || null,
      brexchange: instrument.brexchange || null,
      symbol_type: classification,
      from_cache: fromCache,
    };
  }

  /**
   * The instance to validate against: the one asked for, else the market-data pool, else any
   * healthy active instance.
   * @private
   */
  async _getMarketDataInstance(instanceId) {
    if (instanceId) {
      return await instanceService.getInstanceById(instanceId);
    }

    const pooled = await marketDataInstanceService.getRoundRobinInstance();
    if (pooled) return pooled;

    // Fallback to any healthy active instance
    const instances = await instanceService.getAllInstances({
      is_active: true
    });

    const healthyInstances = instances.filter(
      (inst) => inst.health_status === 'healthy'
    );

    if (healthyInstances.length === 0) {
      throw new ValidationError(
        'No healthy instances available for symbol validation'
      );
    }

    return healthyInstances[0];
  }
}

export default new SymbolValidationService();
